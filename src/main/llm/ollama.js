'use strict';
// Provider: local Ollama server (http://127.0.0.1:11434). Only models that are already installed are used;
// the app never pulls models.
const { DECISION_SCHEMA, LlmError } = require('./schema');
const { parseGeometry, kvBytesPerToken } = require('../kv/model');
const { plan: planKv } = require('../kv/planner');

const BASE = process.env.OLLAMA_HOST ? (/^https?:/.test(process.env.OLLAMA_HOST) ? process.env.OLLAMA_HOST : `http://${process.env.OLLAMA_HOST}`) : 'http://127.0.0.1:11434';
// default = the lightweight model; bigger ones are opt-in from the model menu
const PREFERRED = ['qwen3:8b', 'qwen3:4b', 'qwen2.5:7b', 'qwen3:14b', 'qwen3', 'qwen2.5', 'llama3.1', 'llama3.2', 'mistral', 'gemma'];
const { spawn } = require('child_process');
const SERVE_WAIT_MS = 12000;

class OllamaProvider {
  constructor(settings, engine) {
    this.settings = settings;
    this.engine = engine || null; // managed engine (KV-cache precision), see kv/engine.js
    this.activeBase = BASE; // server the model currently lives on
    this.geoCache = new Map();
    this.id = 'ollama';
    this.model = process.env.AIT_OLLAMA_MODEL || null;
  }
  get label() {
    return `Ollama · ${this.model || '모델 없음'}`;
  }

  async _tags() {
    // one retry: a keep-alive socket to a server that was restarted fails once with ECONNRESET
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await fetch(`${BASE}/api/tags`, { signal: AbortSignal.timeout(2500) });
        return (await r.json()).models || [];
      } catch (e) {
        if (attempt >= 1) throw e;
        await new Promise((res) => setTimeout(res, 120));
      }
    }
  }

  /** Start `ollama serve` ourselves when it is installed but not running (stopped again on app quit). */
  async _autostart() {
    if (this.child) return false;
    try {
      this.child = spawn(process.env.AIT_OLLAMA_BIN || 'ollama', ['serve'], { stdio: 'ignore' });
      this.child.on('error', () => (this.child = null));
      this.child.on('exit', () => (this.child = null));
    } catch {
      return false;
    }
    const t0 = Date.now();
    while (Date.now() - t0 < SERVE_WAIT_MS) {
      await new Promise((r) => setTimeout(r, 400));
      if (!this.child) return false;
      try {
        await this._tags();
        return true;
      } catch { /* still starting */ }
    }
    return false;
  }

  dispose() {
    if (this.child) this.child.kill();
    if (this.engine) this.engine.dispose();
  }

  /** Unload `names` from the server at `base` (keep_alive 0). Returns the names that were actually resident. */
  async _unloadAt(base, names) {
    const freed = [];
    try {
      const ps = await (await fetch(`${base}/api/ps`, { signal: AbortSignal.timeout(1500) })).json();
      const loaded = new Set((ps.models || []).map((m) => m.name));
      for (const n of names) {
        if (!loaded.has(n)) continue;
        await fetch(`${base}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: n, keep_alive: 0 }), signal: AbortSignal.timeout(4000) });
        freed.push(n);
      }
    } catch {
      /* server not running: nothing to free */
    }
    return freed;
  }

  /** Free the memory right now (shared server and the managed KV engine). */
  async unload() {
    const names = new Set([...(this.used || []), ...(this.model ? [this.model] : [])]);
    const bases = new Set([BASE]);
    if (this.engine && this.engine.base) bases.add(this.engine.base);
    const freed = (await Promise.all([...bases].map((b) => this._unloadAt(b, names)))).flat();
    this.used = new Set();
    this.ctxHigh = 0;
    return freed;
  }

  setModel(name) {
    this.ctxHigh = 0;
    this.preferred = name;
    this.model = name;
  }

  async available() {
    let tags;
    try {
      tags = await this._tags();
    } catch {
      if (!(await this._autostart())) return { ok: false, kind: 'server-down', detail: 'Ollama 서버 연결 불가', hint: 'Ollama를 설치(https://ollama.com)하거나 터미널에서 `ollama serve` 를 실행한 뒤 "연결 다시 점검"을 누르세요.' };
      try {
        tags = await this._tags();
      } catch {
        return { ok: false, kind: 'server-down', detail: 'Ollama 서버 연결 불가', hint: '터미널에서 `ollama serve` 를 실행하세요.' };
      }
    }
    this.installed = tags.filter((m) => !/embed/i.test(m.name)).map((m) => ({ name: m.name, sizeGB: Math.round((m.size || 0) / 1e8) / 10, params: (m.details && m.details.parameter_size) || '' }));
    const names = this.installed.map((m) => m.name);
    if (!names.length) return { ok: false, kind: 'model-missing', detail: '설치된 모델 없음', hint: '터미널에서 `ollama pull qwen3:8b` 로 모델을 설치하세요 (앱은 모델을 자동 다운로드하지 않습니다).' };
    if (this.preferred && names.includes(this.preferred)) this.model = this.preferred;
    if (!this.model || !names.includes(this.model)) {
      this.model = PREFERRED.map((p) => names.find((n) => n.startsWith(p))).find(Boolean) || names[0];
    }
    return { ok: true, detail: `${names.length}개 모델 설치됨` };
  }

  /** Model geometry (layers, KV heads, head width) from /api/show — needed for the exact KV memory model. Cached per model. */
  async _geometry(name) {
    if (this.geoCache.has(name)) return this.geoCache.get(name);
    let geo = null;
    try {
      const r = await fetch(`${BASE}/api/show`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: name }), signal: AbortSignal.timeout(4000) });
      if (r.ok) geo = parseGeometry((await r.json()).model_info);
    } catch { /* unknown geometry → legacy estimate */ }
    this.geoCache.set(name, geo);
    return geo;
  }

  /**
   * Decide KV precision + context for this request and make sure the right server is running.
   * Returns { base, plan } — plan = { ctx, kvType, kvGB, lowered, quantized, nofit, reason, engine: 'managed'|'shared' }.
   */
  /**
   * Context right-sizing (KV allocation follows need, not the maximum): with prompt compaction on, the context starts at
   * the smallest step that holds the compacted prompt (≥ 8K) and only grows when a prompt needs more (one model reload).
   * The user's "context length" setting is the ceiling. The high-water mark resets when the model is unloaded.
   */
  _rightSize(maxCtx, needTokens) {
    const st = this.settings;
    if (!st || st.get('ctxCompaction') === 'off') return maxCtx;
    const steps = [8192, 12288, 16384, 24576, 32768].filter((c) => c <= maxCtx);
    if (!steps.length) return maxCtx;
    // no prompt yet (warm-up / preload): load at the size the first request will ask for, so it does not reload
    if (!needTokens) return Math.min(maxCtx, Math.max(this.ctxHigh || 0, steps[0]));
    const want = steps.find((c) => c >= needTokens * 1.15) || steps[steps.length - 1];
    this.ctxHigh = Math.max(this.ctxHigh || 0, want);
    return Math.min(maxCtx, this.ctxHigh);
  }

  async _kvPlan(memory, onNote, needTokens) {
    const st = this.settings;
    const wantCtx = this._rightSize(st ? st.get('contextTokens') : 12288, needTokens);
    const precision = st ? st.get('kvPrecision') : 'f16';
    const autoContext = st ? st.get('autoContext') : true;
    const m = (this.installed || []).find((x) => x.name === this.model);
    const geo = await this._geometry(this.model);
    const engineOk = !!(this.engine && this.engine.available);
    let p = planKv({ geo, weightsGB: m ? m.sizeGB : 5.2, wantCtx, precision: engineOk ? precision : 'f16', autoContext, memory, current: this.engine ? this.engine.type : null });
    let base = BASE;
    if (engineOk && p.kvType !== 'f16') {
      try {
        base = await this.engine.ensure(p.kvType);
      } catch (e) {
        p = { ...p, kvType: 'f16', quantized: false, reason: 'engine-failed', engineError: String(e.message || e) };
        if (onNote && !this.noteEngineFail) onNote('KV 캐시 양자화 엔진을 시작하지 못해 기본 Ollama(f16)로 실행합니다.');
        this.noteEngineFail = true;
      }
    }
    // the model must not sit in two servers at once: free it where we are leaving
    if (this.activeBase !== base) {
      await this._unloadAt(this.activeBase, new Set([...(this.used || []), this.model]));
      this.activeBase = base;
    }
    p.engine = base === BASE ? 'shared' : 'managed';
    // tell the user once per change, not on every request
    const key = `${p.kvType}/${p.ctx}`;
    if (onNote && this.notedPlan !== key) {
      if (p.lowered) onNote(`메모리가 부족해 이번 요청은 컨텍스트를 ${p.ctx / 1024}K 로 낮춰 실행합니다 (설정의 "메모리 부족 시 컨텍스트 자동 낮춤"을 끄면 해제)`);
      if (p.quantized && this.notedKv !== p.kvType) onNote(`KV 캐시를 ${p.kvType} 로 압축해 실행합니다 (f16 대비 메모리 ${Math.round((1 - (p.kvType === 'q8_0' ? 0.53125 : 0.28125)) * 100)}% 절약, 설정 › KV 캐시 정밀도에서 변경)`);
    }
    this.notedPlan = key;
    this.notedKv = p.quantized ? p.kvType : null;
    this.lastPlan = p;
    return { base, plan: p };
  }

  /** KV geometry summary of the selected model for the UI's memory estimate (f16 GB per context token, decimal GB). */
  async kvInfo() {
    if (!this.model) return null;
    const geo = await this._geometry(this.model);
    const m = (this.installed || []).find((x) => x.name === this.model);
    return geo ? { model: this.model, layers: geo.layers, f16PerToken: kvBytesPerToken(geo, 'f16') / 1e9, weightsGB: m ? m.sizeGB : null, approx: geo.approx } : { model: this.model, layers: null, f16PerToken: null, weightsGB: m ? m.sizeGB : null };
  }

  /** Last request's real token accounting + KV plan (for the UI and benchmarks). */
  get usage() {
    return this.lastUsage || null;
  }

  /**
   * One structured completion. Optional: `schema` (JSON schema for the answer, default = agent decision),
   * `onToken(textSoFar)` (switches to streaming), `memory` ({availGB, loadedGB}) for the context guard.
   */
  async complete({ system, user, signal, schema, onToken, memory, onNote, needTokens }) {
    if (!this.model) throw new LlmError('model-missing', '사용할 Ollama 모델이 없습니다');
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (signal) signal.aborted ? ctl.abort() : signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctl.abort('timeout'), 240000);
    try {
      const kvp = await this._kvPlan(memory, onNote, needTokens);
      const r = await fetch(`${kvp.base}/api/chat`, {
        method: 'POST',
        signal: ctl.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          stream: !!onToken,
          format: schema || DECISION_SCHEMA,
          think: false,
          keep_alive: this.settings ? (this.settings.get('keepAlive') === '0' ? 0 : this.settings.get('keepAlive')) : '5m',
          options: { temperature: 0.1, num_ctx: kvp.plan.ctx, num_predict: 1400 },
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        if (r.status === 404) throw new LlmError('model-missing', `모델 ${this.model} 이(가) 설치되어 있지 않습니다`, `\`ollama pull ${this.model}\` (사용자가 직접 실행)`);
        throw new LlmError('failed', `Ollama 오류 ${r.status}: ${t.slice(0, 200)}`);
      }
      (this.used = this.used || new Set()).add(this.model);
      if (!onToken) {
        const j = await r.json();
        this._recordUsage(j, kvp);
        return j.message.content;
      }
      // streaming (NDJSON): report the text so far after every chunk
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let full = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let o;
          try { o = JSON.parse(line); } catch { continue; }
          if (o.error) throw new LlmError('failed', `Ollama 오류: ${String(o.error).slice(0, 200)}`);
          if (o.done) this._recordUsage(o, kvp);
          if (o.message && o.message.content) {
            full += o.message.content;
            try { onToken(full); } catch { /* UI callback must never break the stream */ }
          }
        }
      }
      return full;
    } catch (e) {
      if (e instanceof LlmError) throw e;
      if (signal && signal.aborted) throw new LlmError('aborted', '중단됨');
      if (ctl.signal.aborted) throw new LlmError('timeout', '로컬 모델 응답 시간 초과');
      throw new LlmError('server-down', 'Ollama 서버에 연결할 수 없습니다', '터미널에서 `ollama serve` 를 실행하세요.');
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  _recordUsage(o, kvp) {
    this.lastUsage = {
      promptTokens: o.prompt_eval_count || 0, // whole prompt incl. the cached prefix; the reuse shows in promptMs (measured: 0.2 s vs 9 s for 3.3K tokens)
      evalTokens: o.eval_count || 0,
      promptMs: Math.round((o.prompt_eval_duration || 0) / 1e6),
      evalMs: Math.round((o.eval_duration || 0) / 1e6),
      loadMs: Math.round((o.load_duration || 0) / 1e6),
      ctx: kvp.plan.ctx,
      kvType: kvp.plan.kvType,
      kvGB: kvp.plan.kvGB,
      engine: kvp.plan.engine,
      at: Date.now(),
    };
  }

  /** Download a model on the user's explicit request (onboarding). Streams progress to onProgress({status, pct}). */
  async pull(name, onProgress, signal) {
    const r = await fetch(`${BASE}/api/pull`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: name, stream: true }), signal });
    if (!r.ok) throw new LlmError('failed', `다운로드 요청 실패 (${r.status})`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let ok = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        if (o.error) throw new LlmError('failed', String(o.error));
        if (o.status === 'success') ok = true;
        onProgress && onProgress({ status: o.status, total: o.total || 0, completed: o.completed || 0, pct: o.total ? Math.round((o.completed / o.total) * 100) : null });
      }
    }
    if (!ok) throw new LlmError('failed', '다운로드가 완료되지 않았습니다');
    return true;
  }

  /** Warm the model up (load it into memory) without generating anything. */
  async warm() {
    if (!this.model) return false;
    try {
      const { base, plan } = await this._kvPlan(null);
      await fetch(`${base}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: this.model, keep_alive: this.settings ? this.settings.get('keepAlive') : '5m', options: { num_ctx: plan.ctx } }), signal: AbortSignal.timeout(120000) });
      (this.used = this.used || new Set()).add(this.model);
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { OllamaProvider };
