'use strict';
// Provider: any OpenAI-compatible chat endpoint — LM Studio (http://127.0.0.1:1234/v1), llama.cpp `llama-server`,
// vLLM, or a hosted API. The API key (if any) comes from $OPENAI_API_KEY (OpenAI's own host only) or the encrypted secret
// store (keys.js) and is never logged. Remote (non-local) endpoints are never picked automatically: the user must choose them explicitly.
const { DECISION_SCHEMA, LlmError } = require('./schema');
const { fromResponse } = require('../usage');
const { resolveKey } = require('../keys');
const { estimateTokens } = require('../kv/ctxpack');

const isLocalUrl = (u) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|[^/]*\.local)(:|\/|$)/i.test(u);

class OpenAIProvider {
  /** @param {{settings:object, secrets:object}} deps */
  constructor({ settings, secrets, meter }) {
    this.id = 'openai';
    this.settings = settings;
    this.secrets = secrets;
    this.meter = meter || null; // UsageMeter: counts what this app sent (see usage.js)
    this.model = '';
  }

  /** Token accounting of the last call (same shape the agent reads from every provider). */
  get usage() {
    return this.lastUsage || null;
  }

  _record(resp, system, user, text) {
    const real = fromResponse(resp);
    const u = real || { input: estimateTokens(system) + estimateTokens(user), output: estimateTokens(text), cached: 0 };
    let host = '';
    try { host = new URL(this.baseUrl).host; } catch { /* unset */ }
    this.lastUsage = { provider: 'openai', host, model: this.model, promptTokens: u.input, evalTokens: u.output, cachedTokens: u.cached, estimated: !real, at: Date.now() };
    if (this.meter) this.meter.record({ provider: 'openai', host, model: this.model, input: u.input, output: u.output, cached: u.cached, estimated: !real });
  }

  get baseUrl() {
    return (this.settings.get('openaiBaseUrl') || '').replace(/\/+$/, '');
  }
  get remote() {
    return !!this.baseUrl && !isLocalUrl(this.baseUrl);
  }
  get label() {
    let host = '미설정';
    try { host = new URL(this.baseUrl).host; } catch { /* not configured */ }
    return `OpenAI 호환 · ${this.model || '모델 없음'} (${host})`;
  }

  _headers() {
    const { value: key } = resolveKey('openai', { secrets: this.secrets, baseUrl: this.baseUrl });
    return { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) };
  }

  async available() {
    if (!this.baseUrl) return { ok: false, kind: 'server-down', detail: '주소 미설정', hint: '설정(⌘,) → "OpenAI 호환 서버"에 주소를 입력하세요 (예: LM Studio http://127.0.0.1:1234/v1).' };
    let models;
    try {
      const r = await fetch(`${this.baseUrl}/models`, { headers: this._headers(), signal: AbortSignal.timeout(4000) });
      if (r.status === 401 || r.status === 403) return { ok: false, kind: 'not-authenticated', detail: 'API 키 거부됨', hint: '설정에서 API 키를 다시 저장하세요.' };
      if (!r.ok) {
        // 404 on <address>/models almost always means the address is missing its /v1 (Ollama, LM Studio, llama.cpp all serve the API there)
        const noV1 = r.status === 404 && !/\/v1$/.test(this.baseUrl);
        return { ok: false, kind: 'failed', detail: `서버 응답 ${r.status}`, hint: noV1 ? `주소 끝에 /v1 을 붙여 보세요: ${this.baseUrl}/v1` : '주소(.../v1)와 서버 실행 상태를 확인하세요.' };
      }
      models = ((await r.json()).data || []).map((m) => m.id);
    } catch {
      return { ok: false, kind: 'server-down', detail: '서버에 연결할 수 없음', hint: `${this.baseUrl} 서버가 실행 중인지 확인하세요.` };
    }
    this.installed = models.map((n) => ({ name: n, sizeGB: 0, params: '' }));
    const wanted = this.settings.get('openaiModel');
    this.model = wanted && models.includes(wanted) ? wanted : models[0] || wanted || '';
    if (!this.model) return { ok: false, kind: 'model-missing', detail: '서버에 모델 없음', hint: '서버에서 모델을 불러오세요(LM Studio: Load Model).' };
    return { ok: true, detail: `${models.length}개 모델${this.remote ? ' · 원격 서버(대화 문맥이 외부로 전송됨)' : ' · 로컬 서버'}` };
  }

  setModel(name) {
    this.model = name;
    this.settings.set('openaiModel', name);
  }

  async complete({ system, user, signal, schema, onToken }) {
    if (!this.model) throw new LlmError('model-missing', '사용할 모델이 없습니다');
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (signal) signal.aborted ? ctl.abort() : signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctl.abort('timeout'), 240000);
    const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
    // stream_options.include_usage makes streaming responses end with a usage block (OpenAI, LM Studio, llama-server …);
    // a server that rejects the field gets the same request without it
    const body = (format, withUsage) => JSON.stringify({ model: this.model, messages, temperature: 0.1, max_tokens: 1400, stream: !!onToken, ...(onToken && withUsage ? { stream_options: { include_usage: true } } : {}), response_format: format });
    const jsonSchema = { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: schema || DECISION_SCHEMA } };
    const post = (format, withUsage) => fetch(`${this.baseUrl}/chat/completions`, { method: 'POST', headers: this._headers(), body: body(format, withUsage), signal: ctl.signal });
    try {
      let r = await post(jsonSchema, true);
      if (r.status === 400 || r.status === 422) r = await post({ type: 'json_object' }, true);
      if (r.status === 400 || r.status === 422) r = await post({ type: 'json_object' }, false);
      if (r.status === 401 || r.status === 403) throw new LlmError('not-authenticated', 'API 키가 거부되었습니다', '설정에서 API 키를 다시 저장하세요.');
      if (!r.ok) throw new LlmError('failed', `서버 오류 ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
      if (!onToken) {
        const j = await r.json();
        const text = ((j.choices || [{}])[0].message || {}).content || '';
        this._record(j.usage, system, user, text);
        return text;
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let full = '';
      let finalUsage = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const chunk = JSON.parse(data);
            if (chunk.usage) finalUsage = chunk.usage;
            const delta = (chunk.choices || [{}])[0].delta;
            if (delta && delta.content) {
              full += delta.content;
              try { onToken(full); } catch { /* UI callback must not break the stream */ }
            }
          } catch { /* ignore keep-alive / partial lines */ }
        }
      }
      this._record(finalUsage, system, user, full);
      return full;
    } catch (e) {
      if (e instanceof LlmError) throw e;
      if (signal && signal.aborted) throw new LlmError('aborted', '중단됨');
      if (ctl.signal.aborted) throw new LlmError('timeout', '모델 응답 시간 초과');
      throw new LlmError('server-down', '서버에 연결할 수 없습니다', `${this.baseUrl} 서버 상태를 확인하세요.`);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
}

module.exports = { OpenAIProvider, isLocalUrl };
