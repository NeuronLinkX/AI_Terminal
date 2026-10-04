'use strict';
// Picks the provider to use (AIT_LLM=codex|ollama|auto), probes availability, fails over on connection errors.
// Providers implement: { id, label, available(), complete({system,user,signal}) } — add new ones here.
const { EventEmitter } = require('events');
const { CodexProvider } = require('./codex');
const { OllamaProvider } = require('./ollama');
const { OpenAIProvider } = require('./openai');
const { LlmError } = require('./schema');
const { KvEngine } = require('../kv/engine');
const fs = require('fs');
const path = require('path');


class LlmManager extends EventEmitter {
  constructor({ dataDir, settings, secrets, meter }) {
    super();
    this.settings = settings;
    // local Ollama first; OpenAI-compatible servers and Codex (token-metered) only when the user chooses them
    this.engine = new KvEngine({ dataDir });
    this.providers = [new OllamaProvider(settings, this.engine), new OpenAIProvider({ settings, secrets, meter }), new CodexProvider({ dataDir })];
    this.preference = (process.env.AIT_LLM || 'auto').toLowerCase();
    this.status = { active: null, providers: [], problem: null };
    this.settingsFile = path.join(dataDir, 'llm-settings.json');
    try {
      const st = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8'));
      if (st.ollamaModel && !process.env.AIT_OLLAMA_MODEL) this.providers[0].preferred = st.ollamaModel;
    } catch {
      /* first run */
    }
  }

  /** User picked a model. Remembered across launches. `providerId` defaults to Ollama. */
  async setModel(name, providerId = 'ollama') {
    if (providerId === 'openai') {
      this.providers[1].setModel(name);
      return this.detect();
    }
    this.providers[0].setModel(name);
    try {
      fs.mkdirSync(path.dirname(this.settingsFile), { recursive: true });
      fs.writeFileSync(this.settingsFile, JSON.stringify({ ollamaModel: name }));
    } catch {
      /* best effort */
    }
    return this.detect();
  }

  ordered() {
    if (this.preference === 'auto') return this.providers;
    const first = this.providers.filter((p) => p.id === this.preference);
    return first.concat(this.providers.filter((p) => p.id !== this.preference));
  }

  setPreference(id) {
    this.preference = id;
    return this.detect();
  }

  async detect() {
    const probes = await Promise.all(this.providers.map(async (p) => ({ p, r: await p.available().catch((e) => ({ ok: false, kind: 'failed', detail: e.message })) })));
    const byId = new Map(probes.map((x) => [x.p.id, x]));
    const list = this.ordered().map((p) => {
      const { r } = byId.get(p.id);
      return { id: p.id, label: p.label, ok: r.ok, detail: r.detail, hint: r.hint, kind: r.kind, models: p.installed || undefined, model: p.model || undefined, remote: p.remote || undefined };
    });
    // auto = built-in local model only; cloud-metered providers are never picked silently
    const active = list.find((x) => x.ok && (this.preference !== 'auto' || x.id === 'ollama')) || null;
    this.status = {
      active: active && { id: active.id, label: active.label },
      providers: list,
      problem: active ? null : { message: '사용 가능한 LLM이 없습니다', hints: list.map((l) => `${l.id}: ${l.detail}${l.hint ? ' → ' + l.hint : ''}`).concat(this.preference === 'auto' && list.some((l) => l.ok) ? ['상단 모델 칩에서 다른 연결 경로(예: Codex)를 직접 선택할 수 있습니다 (토큰 소모 주의).'] : []) },
    };
    this.emit('status', this.status);
    return this.status;
  }

  /** Uses the active provider only (no silent failover to metered providers). */
  async complete(req) {
    if (!this.status.active) await this.detect();
    if (!this.status.active) throw new LlmError('server-down', this.status.problem.message, this.status.problem.hints.join('\n'));
    const p = this.providers.find((x) => x.id === this.status.active.id);
    try {
      const text = await p.complete(req);
      return { text, provider: p, usage: p.usage || null };
    } catch (e) {
      if (e.kind !== 'aborted') this.detect(); // refresh status so the UI shows current recovery hints
      throw e;
    }
  }

  get ollama() {
    return this.providers[0];
  }

  /** Optional "preload the model at startup" (setting). */
  async warmIfEnabled() {
    if (this.settings && this.settings.get('preloadModel') && this.status.active && this.status.active.id === 'ollama') return this.ollama.warm();
    return false;
  }

  /** Unload local models from memory (called when tabs/window close). */
  async unload() {
    const out = await Promise.all(this.providers.map((p) => (p.unload ? p.unload().catch(() => []) : [])));
    return out.flat();
  }

  dispose() {
    this.providers.forEach((p) => p.dispose && p.dispose());
  }
}

module.exports = { LlmManager };
