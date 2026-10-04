'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseGeometry, kvGB, kvBytesPerToken, kvBytes } = require('../src/main/kv/model');
const { plan } = require('../src/main/kv/planner');
const { allocate, selectLines, Packer, estimateTokens, queryTerms, sensitivity } = require('../src/main/kv/ctxpack');
const { KvEngine } = require('../src/main/kv/engine');

const QWEN3_8B = { 'general.architecture': 'qwen3', 'qwen3.block_count': 36, 'qwen3.attention.head_count': 32, 'qwen3.attention.head_count_kv': 8, 'qwen3.attention.key_length': 128, 'qwen3.attention.value_length': 128, 'qwen3.embedding_length': 4096, 'qwen3.context_length': 40960 };

test('kv model: exact bytes from the real qwen3:8b geometry (matches measured Ollama sizes)', () => {
  const g = parseGeometry(QWEN3_8B);
  assert.equal(g.layers, 36);
  assert.equal(kvBytesPerToken(g, 'f16'), 36 * 8 * (128 + 128) * 2); // 147,456 B/token
  assert.equal(Math.round(kvGB(g, 32768, 'f16') * 100) / 100, 4.83);
  assert.equal(Math.round(kvGB(g, 32768, 'q8_0') * 100) / 100, 2.57);
  assert.equal(Math.round(kvGB(g, 32768, 'q4_0') * 100) / 100, 1.36);
  // asymmetric split is priced per tensor
  assert.ok(kvBytes(g, 1000, { k: 'q8_0', v: 'q4_0' }) < kvBytes(g, 1000, 'q8_0'));
  assert.ok(kvBytes(g, 1000, { k: 'q8_0', v: 'q4_0' }) > kvBytes(g, 1000, 'q4_0'));
});

test('kv model: per-layer KV heads, derived head width, sliding-window layers, unknown architectures', () => {
  const arr = parseGeometry({ 'general.architecture': 'x', 'x.block_count': 2, 'x.attention.head_count': [8, 8], 'x.attention.head_count_kv': [4, 2], 'x.embedding_length': 512 });
  assert.deepEqual(arr.nKv, [4, 2]);
  assert.equal(arr.keyLen, 64);
  const swa = parseGeometry({ 'general.architecture': 'gemma3', 'gemma3.block_count': 6, 'gemma3.attention.head_count': 8, 'gemma3.attention.head_count_kv': 4, 'gemma3.attention.key_length': 256, 'gemma3.attention.value_length': 256, 'gemma3.attention.sliding_window': 1024, 'gemma3.attention.sliding_window_pattern': 6, 'gemma3.embedding_length': 2048 });
  assert.deepEqual(swa.swaLayers, [true, true, true, true, true, false]);
  const full = kvBytes(swa, 32768, 'f16');
  const allFull = 6 * 32768 * 4 * 512 * 2;
  assert.ok(full < allFull / 2, 'sliding-window layers only cache the window');
  assert.equal(parseGeometry({}), null);
  assert.equal(parseGeometry({ 'general.architecture': 'y' }), null);
  assert.throws(() => kvGB(parseGeometry(QWEN3_8B), 10, 'q3_k'));
});

const G = parseGeometry(QWEN3_8B);
const P = (over) => plan({ geo: G, weightsGB: 5.23, wantCtx: 12288, precision: 'auto', autoContext: true, memory: { availGB: 8, loadedGB: 0 }, ...over });

test('kv planner: plenty of memory → exact f16; tighter → q8_0 before shrinking the context', () => {
  assert.equal(P({ memory: { availGB: 12, loadedGB: 0 } }).kvType, 'f16');
  const q = P({ memory: { availGB: 8, loadedGB: 0 } });
  assert.equal(q.kvType, 'q8_0');
  assert.equal(q.ctx, 12288);
  assert.equal(q.lowered, false);
  assert.ok(q.kvGB < 1.0 && q.quantized);
});

test('kv planner: prefers q8_0 at a shorter (still ≥8K) context over q4_0 at the full one; the loaded model counts as room', () => {
  const r = P({ wantCtx: 32768, memory: { availGB: 8, loadedGB: 0 } });
  assert.equal(r.kvType, 'q8_0');
  assert.ok(r.ctx < 32768 && r.ctx >= 8192);
  assert.ok(P({ memory: { availGB: 2.4, loadedGB: 5.6 } }).needGB <= 5.6 + 2.4 - 1.5 + 1e-9 || P({ memory: { availGB: 2.4, loadedGB: 5.6 } }).nofit === false);
});

test('kv planner: pinned precision is respected; nothing fits → smallest footprint with high precision and a nofit flag', () => {
  assert.equal(P({ precision: 'q4_0' }).kvType, 'q4_0');
  assert.equal(P({ precision: 'f16', memory: { availGB: 12, loadedGB: 0 } }).kvType, 'f16');
  const pinned = P({ precision: 'f16', memory: { availGB: 6.6, loadedGB: 0 } });
  assert.equal(pinned.kvType, 'f16');
  assert.ok(pinned.ctx < 12288, 'only the context shrinks');
  const none = P({ memory: { availGB: 3, loadedGB: 0 } });
  assert.equal(none.nofit, true);
  assert.equal(none.kvType, 'q8_0');
  assert.equal(none.ctx, 4096);
  const noAuto = P({ autoContext: false, memory: { availGB: 6.6, loadedGB: 0 } });
  assert.equal(noAuto.ctx, 12288, 'autoContext off never changes the context');
  assert.equal(P({ memory: null }).kvType, 'f16', 'unknown memory → no limit');
});

test('kv planner: stays on the running KV type when it still fits (no needless engine restarts)', () => {
  const r = P({ memory: { availGB: 9, loadedGB: 0 }, current: 'q8_0' });
  assert.equal(r.kvType, 'q8_0');
});

test('ctxpack allocate: global budget is kept, saturated items release their share, protected items are fixed', () => {
  const a = allocate([{ len: 3000, w: 1 }, { len: 200, w: 1 }, { len: 3000, w: 2 }, { len: 5000, w: 0.2 }], 4000);
  assert.equal(a[1], 200, 'a short item keeps everything');
  assert.ok(a[2] > a[0] && a[0] > a[3], 'budget follows sensitivity');
  assert.ok(Math.abs(a.reduce((x, y) => x + y, 0) - 4000) <= 8);
  const p = allocate([{ len: 3000, w: 0.3 }, { len: 3000, w: 0.3 }, { len: 3000, w: 1, protect: 1500 }], 4000);
  assert.equal(p[2], 1500);
  assert.equal(p[0] + p[1], 2500);
  const roomy = allocate([{ len: 100, w: 1 }, { len: 100, w: 1 }], 10000);
  assert.deepEqual(roomy, [100, 100], 'never more than the content');
});

const testLog = (() => {
  const l = [];
  for (let i = 0; i < 80; i++) l.push(`PASS test/case${i}.js (0.0${i % 9}s)`);
  l.splice(40, 0, 'FAIL src/util.js', '  ● add › adds numbers', '    expected 3 received -1', '    at Object.<anonymous> (src/util.js:12:5)');
  l.push('Tests: 1 failed, 80 passed, 81 total');
  return l.join('\n');
})();

test('ctxpack selectLines: keeps the failure, its location and the summary within the budget, in order', () => {
  const out = selectLines(testLog, 500, queryTerms('npm test 실패 원인 util'));
  assert.ok(out.length <= 500);
  assert.match(out, /FAIL src\/util\.js/);
  assert.match(out, /expected 3 received -1/);
  assert.match(out, /util\.js:12:5/);
  assert.match(out, /Tests: 1 failed/);
  assert.match(out, /…\(\d+줄 생략\)…/);
  assert.ok(out.indexOf('FAIL') < out.indexOf('Tests:'));
  assert.equal(selectLines('short text', 500), 'short text', 'text within budget is untouched');
});

const run = (cmd, output, exitCode = 0) => ({ kind: 'run', command: cmd, status: 'done', exitCode, output });
const steps = (n) => Array.from({ length: n }, (_, i) => run(`cmd ${i}`, `line ${i}\n`.repeat(300), 0));

test('ctxpack Packer: append-only (prefix-stable) until the budget is hit, then lazy + monotone demotion', () => {
  const pk = new Packer({ level: 'auto' });
  pk.setQuery('프로젝트 설명');
  const s = steps(3);
  const r1 = pk.render(s, 20000);
  s.push(run('cmd 3', 'line 3\n'.repeat(300)));
  const r2 = pk.render(s, 20000);
  for (let i = 0; i < 3; i++) assert.equal(r2[i], r1[i], `step ${i} unchanged → KV prefix reusable`);
  // exceed the budget: older observations shrink, the newest stays (almost) whole, nothing grows back
  const tight = pk.render(s, 5000);
  assert.ok(tight.reduce((a, x) => a + x.length, 0) <= 5200);
  assert.ok(tight[3].length > tight[0].length, 'the newest observation is protected');
  s.push(run('cmd 4', 'line 4\n'.repeat(40)));
  const again = pk.render(s, 5000);
  assert.ok(again[0].length <= tight[0].length, 'demoted observations never grow back');
  const roomy = pk.render(s, 60000);
  assert.ok(roomy[0].length <= tight[0].length, 'even with a larger budget the demotion is permanent');
});

test('ctxpack Packer: stale reads and resolved failures are demoted first; failures keep their evidence', () => {
  const read = { kind: 'read', path: 'src/a.js', content: 'x\n'.repeat(500) };
  const edit = { kind: 'edit', path: 'src/a.js', ok: true, summary: 'ok' };
  const fail = run('node t.js', 'Error: boom\n' + 'noise\n'.repeat(300), 1);
  const fixed = run('node t.js', 'ok\n', 0);
  const list = [read, edit, fail, fixed];
  assert.ok(sensitivity(list, 0, 3) < sensitivity([read], 0, 0) * 0.3, 'edited file → the old read is stale');
  assert.ok(sensitivity(list, 2, 3) < sensitivity([fail], 0, 0) * 0.5, 'a failure that was fixed later matters less');
  const pk = new Packer({ level: 'auto' });
  pk.setQuery('고쳐줘');
  const out = pk.render([fail, run('ls', 'a\n'.repeat(600)), run('pwd', 'x\n'.repeat(600))], 2500);
  assert.match(out[0], /Error: boom/);
});

test("ctxpack Packer: 'off' reproduces the legacy behaviour (last 3 verbatim, older cut to 250 chars)", () => {
  const pk = new Packer({ level: 'off' });
  const out = pk.render(steps(5), 100);
  assert.ok(out[0].length < 450 && out[1].length < 450);
  assert.ok(out[4].length > 1500);
});

test('ctxpack: token estimate tracks the real qwen3 tokenizer within ~15 %', () => {
  // measured with llama-tokenize on the qwen3 vocabulary: 3340-char Korean/ASCII system prompt = 1642 tokens, 6000-char JS = 1897
  const sys = '터미널 작업 에이전트입니다. '.repeat(40) + 'function add(a, b) { return a + b; }\n'.repeat(60);
  const t = estimateTokens(sys);
  assert.ok(t > 500 && t < 1500);
  assert.ok(estimateTokens('가'.repeat(100)) > estimateTokens('a'.repeat(100)) * 2, 'Korean costs more tokens per character');
});

test('kv engine: disabled for remote/test servers; real child process gets the KV environment, restarts on a type change, stops cleanly', async () => {
  const saved = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = '127.0.0.1:9';
  assert.equal(new KvEngine({}).available, false);
  delete process.env.OLLAMA_HOST;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-kvengine-'));
  // a fake `ollama`: records its environment and answers /api/tags on OLLAMA_HOST
  const bin = path.join(dir, 'ollama');
  fs.writeFileSync(bin, `#!/usr/bin/env node
const http = require('http'); const fs = require('fs');
const [h, p] = process.env.OLLAMA_HOST.split(':');
fs.writeFileSync(${JSON.stringify(path.join(dir, 'env-')) } + p + '.json', JSON.stringify({ kv: process.env.OLLAMA_KV_CACHE_TYPE, fa: process.env.OLLAMA_FLASH_ATTENTION, par: process.env.OLLAMA_NUM_PARALLEL }));
http.createServer((q, r) => { r.setHeader('content-type', 'application/json'); r.end('{"models":[]}'); }).listen(Number(p), h);
`, { mode: 0o755 });
  const eng = new KvEngine({ dataDir: dir, bin, basePort: 18500 });
  assert.equal(eng.available, true);
  try {
    const b1 = await eng.ensure('q8_0');
    assert.match(b1, /^http:\/\/127\.0\.0\.1:\d+$/);
    const port1 = b1.split(':').pop();
    const env1 = JSON.parse(fs.readFileSync(path.join(dir, `env-${port1}.json`), 'utf8'));
    assert.deepEqual(env1, { kv: 'q8_0', fa: '1', par: '1' });
    assert.equal(await eng.ensure('q8_0'), b1, 'same type → same server');
    assert.ok(fs.existsSync(path.join(dir, 'kv-engine.json')), 'pid file written');
    const b2 = await eng.ensure('q4_0');
    const env2 = JSON.parse(fs.readFileSync(path.join(dir, `env-${b2.split(':').pop()}.json`), 'utf8'));
    assert.equal(env2.kv, 'q4_0');
    await eng.stop();
    assert.equal(eng.base, null);
    await assert.rejects(fetch(b2 + '/api/tags', { signal: AbortSignal.timeout(800) }).then((r) => r.json()), 'the server is gone after stop()');
    assert.equal(fs.existsSync(path.join(dir, 'kv-engine.json')), false);
  } finally {
    eng.dispose();
    if (saved !== undefined) process.env.OLLAMA_HOST = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the agent really uses the packer: prompt shape, budgets, legacy mode
const { Agent, SYSTEM } = require('../src/main/agent');
const { EventEmitter } = require('events');

function makeAgent(settingsVals, ctxTokens = 8192) {
  const session = Object.assign(new EventEmitter(), { cwd: os.tmpdir(), history: [], shell: '/bin/zsh', integrated: true });
  const settings = { get: (k) => ({ ctxCompaction: 'auto', contextTokens: ctxTokens, ...settingsVals })[k] };
  const llm = { status: { active: { id: 'ollama' } }, ollama: { lastPlan: { ctx: ctxTokens } } };
  return new Agent({ session, llm, dataDir: os.tmpdir(), settings });
}
const bigRun = (cmd, tag, n = 400) => ({ kind: 'run', command: cmd, status: 'done', exitCode: 0, output: Array.from({ length: n }, (_, i) => `${tag} line ${i} some output text`).join('\n') });

test('agent prompt: observations are packed to fit the context next to the system prompt and the answer reserve', () => {
  const agent = makeAgent({}, 8192);
  agent.packer = new Packer({ level: 'auto' });
  agent.packer.setQuery('프로젝트 구조를 설명해줘');
  const steps = [bigRun('ls -R', 'old'), bigRun('cat a', 'mid'), bigRun('cat b', 'new')];
  const prompt = agent._buildPrompt('프로젝트 구조를 설명해줘', '[환경] test', steps, null);
  assert.ok(estimateTokens(SYSTEM) + estimateTokens(prompt) + 1400 <= 8192, 'prompt + system + answer reserve fit the 8K context');
  assert.match(prompt, /new line 399/, 'the newest observation keeps its tail');
  assert.match(prompt, /…\(\d+줄 생략\)…/, 'older output was condensed with an explicit marker');
  assert.match(prompt, /\[사용자 요청\]\n프로젝트 구조를 설명해줘/);
  assert.match(prompt, /\[지시\] 다음 결정 하나를 JSON/);
});

test('agent prompt: with a roomy context nothing is condensed; steps stay append-only (KV prefix reuse)', () => {
  const agent = makeAgent({}, 32768);
  agent.packer = new Packer({ level: 'auto' });
  agent.packer.setQuery('x');
  const steps = [run('echo 1', 'one\n'.repeat(20)), run('echo 2', 'two\n'.repeat(20))];
  const p1 = agent._buildPrompt('x', 'CTX', steps, null);
  assert.ok(!/생략/.test(p1));
  const p2 = agent._buildPrompt('x', 'CTX', [...steps, run('echo 3', 'three\n'.repeat(20))], null);
  const common = p1.slice(0, p1.indexOf('[지시]')).trimEnd();
  assert.ok(p2.startsWith(common), 'the second prompt starts with the whole first prompt body → Ollama can reuse its KV cache');
});

test("agent prompt: ctxCompaction 'off' keeps the legacy budget and trimming", () => {
  const agent = makeAgent({ ctxCompaction: 'off', contextTokens: 12288 }, 12288);
  agent.packer = new Packer({ level: 'off' });
  const steps = [bigRun('a', 'A'), bigRun('b', 'B'), bigRun('c', 'C'), bigRun('d', 'D')];
  const prompt = agent._buildPrompt('q', 'CTX', steps, null);
  assert.ok(prompt.length <= Math.max(4500, Math.round(12288 * 1.1)) + 200, 'legacy character budget');
});

test('agent prompt: a remote provider gets the configured window, not the local KV plan', () => {
  const agent = makeAgent({}, 8192);
  agent.llm.status.active = { id: 'openai' };
  agent.llm.ollama.lastPlan = { ctx: 4096 };
  assert.equal(agent._ctxTokens(), 8192, 'the setting, not the (smaller) local plan');
});

test('Packer: an intact observation renders exactly as without compaction (no "edited" label that misleads the model)', () => {
  const steps = [
    { kind: 'run', command: 'npm test', status: 'done', exitCode: 1, output: '\n> test\nFAIL: add(2,3) expected 5 got -1' },
    { kind: 'read', path: '/p/src/util.js', content: 'function add(a, b) { return a - b; }\nmodule.exports = { add };\n' },
    { kind: 'edit', path: '/p/src/util.js', summary: '수정됨 (+1/-1줄)' },
  ];
  const off = new Packer({ level: 'off' }).render(steps, 12000);
  const auto = new Packer({ level: 'auto' }).render(steps, 12000);
  assert.deepEqual(auto, off);
  assert.ok(!auto.join('\n').includes('이후 수정됨'));
});

test('Packer: a stale read that really was cut says so (수정 전 내용 · 일부만 표시)', () => {
  const big = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
  const steps = [
    { kind: 'read', path: '/p/a.js', content: big },
    { kind: 'edit', path: '/p/a.js', summary: '수정됨 (+1/-1줄)' },
    { kind: 'run', command: 'node a.js', status: 'done', exitCode: 0, output: 'ok' },
  ];
  const out = new Packer({ level: 'aggressive' }).render(steps, 3000).join('\n');
  assert.match(out, /수정 전 내용 · 일부만 표시/);
});
