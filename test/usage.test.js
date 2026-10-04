'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { UsageMeter, fromResponse, fetchOfficial, isOfficial, usageBase } = require('../src/main/usage');
const { OpenAIProvider } = require('../src/main/llm/openai');
const { Settings } = require('../src/main/settings');
const { createMock } = require('../scripts/mock-openai');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ait-usage-'));

test('usage: fromResponse reads OpenAI and compatible shapes, ignores junk', () => {
  assert.deepEqual(fromResponse({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_tokens_details: { cached_tokens: 3 } }), { input: 10, output: 4, cached: 3 });
  assert.deepEqual(fromResponse({ input_tokens: 7, output_tokens: 2 }), { input: 7, output: 2, cached: 0 });
  assert.equal(fromResponse(null), null);
  assert.equal(fromResponse({}), null);
  assert.equal(fromResponse('x'), null);
});

test('usage meter: counts only (no prompts / keys), session + calendar-day windows, per model, survives restarts', () => {
  const dir = tmp();
  const m = new UsageMeter(dir);
  m.record({ provider: 'openai', host: 'api.openai.com', model: 'gpt-x', input: 1000, output: 200, cached: 50 });
  m.record({ provider: 'openai', host: 'api.openai.com', model: 'gpt-y', input: 10, output: 5, estimated: true });
  const file = fs.readdirSync(path.join(dir, 'usage'))[0];
  const lines = fs.readFileSync(path.join(dir, 'usage', file), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(Object.keys(lines[0]).sort(), ['cached', 'estimated', 'host', 'input', 'model', 'output', 'provider', 'ts'], 'only counts and labels are stored');
  // old rows: 3 days and 40 days ago
  const old = (days, input) => JSON.stringify({ ts: new Date(Date.now() - days * 86400000).toISOString(), provider: 'openai', host: 'h', model: 'gpt-x', input, output: 0, cached: 0, estimated: false });
  fs.appendFileSync(path.join(dir, 'usage', file), old(3, 300) + '\n' + old(40, 9999) + '\n');
  const m2 = new UsageMeter(dir); // a new process: the session starts empty, the history is read from disk
  const s = m2.summary();
  assert.equal(s.session.calls, 0);
  assert.equal(s.today.input, 1010);
  assert.equal(s.d7.input, 1310);
  assert.equal(s.d30.input, 1310, 'the 40-day-old row is outside the 30-day window');
  assert.equal(s.d30.estimated, 1);
  assert.equal(s.byModel['gpt-x'].input, 1300);
  const now = m.summary();
  assert.equal(now.session.input, 1010);
  assert.equal(now.session.total, 1215);
  assert.equal(now.session.byModel['gpt-y'].calls, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('usage meter: a broken disk never breaks a request; listeners are notified', () => {
  const m = new UsageMeter('/nonexistent/readonly/dir');
  let n = 0;
  m.onChange(() => n++);
  assert.doesNotThrow(() => m.record({ model: 'a', input: 1, output: 1 }));
  assert.equal(n, 1);
});

test('usage official: only the official host (or an explicit test base) is queried', () => {
  assert.equal(isOfficial('https://api.openai.com/v1'), true);
  assert.equal(isOfficial('http://127.0.0.1:1234/v1'), false);
  assert.equal(isOfficial('https://api.openai.com.evil.example/v1'), false);
  assert.equal(usageBase('http://127.0.0.1:1234/v1'), null);
  assert.equal(usageBase('https://api.openai.com/v1'), 'https://api.openai.com/v1');
});

test('usage official: pagination, ranges, per-model split and costs from the Usage / Costs API; the key never leaks', async () => {
  const mock = createMock({ port: 18601 });
  await mock.listen();
  process.env.AIT_OPENAI_USAGE_BASE = 'http://127.0.0.1:18601/v1';
  try {
    const r = await fetchOfficial({ baseUrl: 'https://api.openai.com/v1', adminKey: 'test-admin-key' });
    assert.equal(r.ok, true);
    // buckets: today (1000/100 in/out + 500/50), yesterday (2000/200 + 500/50), 10 days ago (3000/300 + 500/50)
    assert.equal(r.ranges.today.input, 1500);
    assert.equal(r.ranges.d7.input, 1500 + 2500);
    assert.equal(r.ranges.d30.input, 1500 + 2500 + 3500);
    assert.equal(r.ranges.d30.requests, 7 + 8 + 9);
    assert.ok(r.byModel['mock-gpt'] && r.byModel['mock-mini']);
    assert.equal(r.byModel['mock-gpt'].input, 6000);
    assert.equal(Math.round(r.cost.d30 * 100) / 100, 3);
    assert.equal(Math.round(r.cost.today * 100) / 100, 0.5);
    assert.equal(r.cost.currency, 'usd');
    assert.ok(mock.state.org.some((o) => o.page === 'p2'), 'the second page was requested');
    assert.ok(mock.state.org.every((o) => o.params.includes('start_time')));
    assert.equal(JSON.stringify(r).includes('test-admin-key'), false);
    // wrong key → rejected without echoing anything
    const bad = await fetchOfficial({ baseUrl: 'https://api.openai.com/v1', adminKey: 'not-an-admin-key' });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'admin-key-rejected');
    assert.equal(JSON.stringify(bad).includes('not-an-admin-key'), false);
    assert.equal((await fetchOfficial({ baseUrl: 'https://api.openai.com/v1', adminKey: '' })).reason, 'no-admin-key');
  } finally {
    delete process.env.AIT_OPENAI_USAGE_BASE;
    await mock.close();
  }
  assert.equal((await fetchOfficial({ baseUrl: 'http://127.0.0.1:1234/v1', adminKey: 'k' })).code, 'not-official');
});

const providerFor = async (mock, meter, settingsOver = {}) => {
  const dir = tmp();
  const settings = new Settings(dir);
  settings.set('openaiBaseUrl', `http://127.0.0.1:${mock.server.address().port}/v1`);
  const p = new OpenAIProvider({ settings, secrets: { get: () => '' }, meter });
  void settingsOver;
  assert.equal((await p.available()).ok, true);
  return p;
};
const REQ = { system: 'system prompt', user: '[사용자 요청]\npwd 명령으로 현재 디렉터리를 알려줘.' };

test('openai provider: records the real usage of a normal and a streamed call (include_usage)', async () => {
  const mock = createMock({ port: 18602 });
  await mock.listen();
  try {
    const meter = new UsageMeter(null);
    const p = await providerFor(mock, meter);
    await p.complete(REQ);
    assert.equal(p.usage.estimated, false);
    assert.equal(meter.session.calls, 1);
    assert.ok(meter.session.input > 0 && meter.session.output > 0);
    assert.equal(meter.session.cached, 7);
    const before = meter.session.input;
    let seen = '';
    await p.complete({ ...REQ, onToken: (t) => { seen = t; } });
    assert.ok(seen.length > 10, 'streamed text arrived');
    assert.equal(meter.session.calls, 2);
    assert.equal(meter.session.input - before, mock.state.lastUsage.prompt_tokens, 'streamed usage block recorded exactly');
    assert.ok(mock.state.calls.some((c) => c.stream_options && c.stream_options.include_usage));
  } finally { await mock.close(); }
});

test('openai provider: servers without usage → flagged estimate; servers rejecting stream_options → retried without it', async () => {
  const mock = createMock({ port: 18603, noUsage: true });
  await mock.listen();
  try {
    const meter = new UsageMeter(null);
    const p = await providerFor(mock, meter);
    await p.complete(REQ);
    assert.equal(p.usage.estimated, true);
    assert.equal(meter.session.estimated, 1);
    assert.ok(meter.session.input > 0);
  } finally { await mock.close(); }
  const strict = createMock({ port: 18604, rejectStreamOptions: true });
  await strict.listen();
  try {
    const meter = new UsageMeter(null);
    const p = await providerFor(strict, meter);
    let seen = '';
    await p.complete({ ...REQ, onToken: (t) => { seen = t; } });
    assert.ok(seen.length > 10, 'the request still worked without stream_options');
    assert.equal(meter.session.calls, 1);
    assert.equal(meter.session.estimated, 1, 'no usage chunk was requested → estimate, never a made-up exact number');
    assert.ok(strict.state.calls.filter((c) => c.path === '/v1/chat/completions').length >= 2, 'a retry happened');
  } finally { await strict.close(); }
});

test('openai provider: an address without /v1 (404 on /models) is told exactly how to fix it; with /v1 it connects', async () => {
  const mock = createMock({ port: 18603 });
  await mock.listen();
  try {
    const port = mock.server.address().port;
    const settings = new Settings(tmp());
    const make = (base) => { settings.set('openaiBaseUrl', base); return new OpenAIProvider({ settings, secrets: { get: () => '' }, meter: new UsageMeter(null) }); };
    // the mock, like Ollama / LM Studio, serves the API under /v1 only
    const bare = await make(`http://127.0.0.1:${port}`).available();
    assert.equal(bare.ok, false);
    assert.equal(bare.detail, '서버 응답 404');
    assert.match(bare.hint, new RegExp(`/v1.*127\\.0\\.0\\.1:${port}/v1`));
    assert.equal((await make(`http://127.0.0.1:${port}/v1`).available()).ok, true);
  } finally { await mock.close(); }
});
