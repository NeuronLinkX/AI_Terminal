#!/usr/bin/env node
'use strict';
// A scripted OpenAI-compatible server for tests: /v1/models, /v1/chat/completions (JSON and SSE streaming, with a real-looking
// `usage` block) and the organization Usage / Costs endpoints (admin key required, paginated). No network, no real key.
//   node scripts/mock-openai.js [port]   (default 11500)
const http = require('http');
const { brain } = require('./mock-ollama');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86400;

function createMock({ port = 11500, adminKey = 'test-admin-key', apiKey = 'test-api-key', noUsage = false, rejectStreamOptions = false, requireKey = false } = {}) {
  const state = { calls: [], org: [] };
  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer /, '');

  // organization usage: 3 daily buckets (today, yesterday, 10 days ago), two models; costs the same shape
  const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return Math.floor(d.getTime() / 1000); };
  const buckets = () => {
    const t = startOfToday();
    return [t, t - DAY, t - 10 * DAY].map((s, i) => ({ s, i }));
  };
  const usageBucket = ({ s, i }) => ({ object: 'bucket', start_time: s, end_time: s + DAY, results: [
    { object: 'organization.usage.completions.result', input_tokens: 1000 * (i + 1), output_tokens: 100 * (i + 1), input_cached_tokens: 10 * i, num_model_requests: 5 + i, model: 'mock-gpt' },
    { object: 'organization.usage.completions.result', input_tokens: 500, output_tokens: 50, input_cached_tokens: 0, num_model_requests: 2, model: 'mock-mini' },
  ] });
  const costBucket = ({ s, i }) => ({ object: 'bucket', start_time: s, end_time: s + DAY, results: [{ object: 'organization.costs.result', amount: { value: 0.5 * (i + 1), currency: 'usd' }, line_item: null, project_id: null }] });

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { /* ignore */ }
    const u = new URL(req.url, 'http://x');
    state.calls.push({ method: req.method, path: u.pathname, auth: bearer(req), stream_options: body.stream_options });

    if (u.pathname.startsWith('/v1/organization/')) {
      if (bearer(req) !== adminKey) return json(res, 401, { error: { message: 'admin key required' } });
      const list = buckets();
      const all = u.pathname.endsWith('/costs') ? list.map(costBucket) : list.map(usageBucket);
      // two pages: first one bucket (today), the rest on page "p2"
      const page = u.searchParams.get('page');
      state.org.push({ path: u.pathname, page, params: [...u.searchParams.keys()] });
      return page === 'p2' ? json(res, 200, { object: 'page', data: all.slice(1), has_more: false, next_page: null }) : json(res, 200, { object: 'page', data: all.slice(0, 1), has_more: true, next_page: 'p2' });
    }
    if (requireKey && bearer(req) !== apiKey) return json(res, 401, { error: { message: 'bad key' } });
    if (req.method === 'GET' && u.pathname === '/v1/models') return json(res, 200, { object: 'list', data: [{ id: 'mock-gpt' }, { id: 'mock-mini' }] });
    if (req.method === 'POST' && u.pathname === '/v1/chat/completions') {
      if (rejectStreamOptions && body.stream_options) return json(res, 400, { error: { message: 'unknown parameter: stream_options' } });
      const user = ((body.messages || []).find((m) => m.role === 'user') || {}).content || '';
      const sys = ((body.messages || []).find((m) => m.role === 'system') || {}).content || '';
      const text = JSON.stringify(brain(user, 'decision'));
      const usage = { prompt_tokens: Math.ceil((sys.length + user.length) / 3), completion_tokens: Math.ceil(text.length / 3), total_tokens: 0, prompt_tokens_details: { cached_tokens: 7 } };
      usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
      if (!body.stream) return json(res, 200, { id: 'x', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], ...(noUsage ? {} : { usage }) });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (let i = 0; i < text.length; i += 8) { res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: text.slice(i, i + 8) } }] })}\n\n`); await sleep(5); }
      res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      if (!noUsage && body.stream_options && body.stream_options.include_usage) res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: body.model, choices: [], usage })}\n\n`);
      res.end('data: [DONE]\n\n');
      state.lastUsage = usage;
      return undefined;
    }
    return json(res, 404, { error: { message: 'not found' } });
  });
  return { server, state, adminKey, apiKey, listen: () => new Promise((r) => server.listen(port, '127.0.0.1', () => r(server))), close: () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(r); }) };
}

if (require.main === module) {
  const port = Number(process.argv[2]) || 11500;
  createMock({ port }).listen().then(() => console.log(`mock openai on 127.0.0.1:${port}`));
}
module.exports = { createMock };
