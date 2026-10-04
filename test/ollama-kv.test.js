'use strict';
// The Ollama provider's KV logic against the scripted Ollama server: context right-sizing, memory-driven planning,
// real token accounting. (OLLAMA_HOST is set, so the managed KV engine is off and the shared server is used.)
process.env.OLLAMA_HOST = '127.0.0.1:18701';
process.env.AIT_OLLAMA_BIN = '/nonexistent/ollama'; // a test must never start a real server
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMock } = require('../scripts/mock-ollama');
const { OllamaProvider } = require('../src/main/llm/ollama');
const { Settings } = require('../src/main/settings');

const REQ = { system: 'sys', user: '[사용자 요청]\npwd 명령으로 현재 디렉터리를 알려줘.' };
const setup = async (settingsOver = {}) => {
  const mock = createMock({ port: 18701 });
  await mock.listen();
  const settings = new Settings(fs.mkdtempSync(path.join(os.tmpdir(), 'ait-okv-')));
  for (const [k, v] of Object.entries(settingsOver)) settings.set(k, v);
  const p = new OllamaProvider(settings, null);
  assert.equal((await p.available()).ok, true);
  return { mock, p, settings };
};

test('ollama provider: the context follows the prompt (right-sizing), grows once when needed, and resets on unload', async () => {
  const { mock, p } = await setup({ ctxCompaction: 'auto', contextTokens: 16384 });
  try {
    await p.complete({ ...REQ, needTokens: 3000 });
    assert.equal(mock.state.chats.at(-1).num_ctx, 8192, 'a small prompt does not reserve the full 16K');
    await p.complete({ ...REQ, needTokens: 2500 });
    assert.equal(mock.state.chats.at(-1).num_ctx, 8192);
    await p.complete({ ...REQ, needTokens: 9000 });
    assert.equal(mock.state.chats.at(-1).num_ctx, 12288, 'a bigger prompt grows the context one step (×1.15 headroom)');
    await p.complete({ ...REQ, needTokens: 2000 });
    assert.equal(mock.state.chats.at(-1).num_ctx, 12288, 'high-water mark: no shrink/regrow ping-pong (each change reloads the model)');
    await p.complete({ ...REQ, needTokens: 30000 });
    assert.equal(mock.state.chats.at(-1).num_ctx, 16384, 'never above the user\'s ceiling');
    await p.unload();
    await p.complete({ ...REQ, needTokens: 2000 });
    assert.equal(mock.state.chats.at(-1).num_ctx, 8192, 'a fresh load starts small again');
  } finally { p.dispose(); await mock.close(); }
});

test('ollama provider: compaction off keeps the configured context exactly (previous behaviour)', async () => {
  const { mock, p } = await setup({ ctxCompaction: 'off', contextTokens: 12288 });
  try {
    await p.complete({ ...REQ, needTokens: 1000 });
    assert.equal(mock.state.chats.at(-1).num_ctx, 12288);
  } finally { p.dispose(); await mock.close(); }
});

test('ollama provider: exact KV plan from the model geometry; memory pressure lowers the context and says so once', async () => {
  const { mock, p } = await setup({ ctxCompaction: 'off', contextTokens: 32768 });
  try {
    const notes = [];
    await p.complete({ ...REQ, memory: { availGB: 3, loadedGB: 0 }, onNote: (t) => notes.push(t) });
    const plan = p.lastPlan;
    assert.equal(plan.kvType, 'f16', 'no managed engine here → the server default');
    assert.ok(plan.ctx < 32768, 'a tight Mac does not get a 32K context');
    assert.equal(mock.state.chats.at(-1).num_ctx, plan.ctx);
    assert.ok(notes.some((n) => /컨텍스트를/.test(n)), 'the user is told');
    await p.complete({ ...REQ, memory: { availGB: 3, loadedGB: 0 }, onNote: (t) => notes.push(t) });
    assert.equal(notes.filter((n) => /컨텍스트를/.test(n)).length, 1, 'the notice is not repeated every request');
    const info = await p.kvInfo();
    assert.equal(info.layers, 36);
    assert.ok(Math.abs(info.f16PerToken * 1e9 - 147456) < 1, 'exact bytes per token from the model metadata');
  } finally { p.dispose(); await mock.close(); }
});

test('ollama provider: records the real token accounting of each call (prefilled / generated)', async () => {
  const { mock, p } = await setup({});
  try {
    await p.complete({ ...REQ });
    const u = p.usage;
    assert.ok(u.promptTokens > 0 && u.evalTokens > 0);
    assert.equal(u.kvType, 'f16');
    assert.equal(u.engine, 'shared');
    let streamed = '';
    await p.complete({ ...REQ, onToken: (t) => { streamed = t; } });
    assert.ok(streamed.length > 5);
    assert.ok(p.usage.promptTokens > 0, 'usage is captured from the final streamed chunk too');
  } finally { p.dispose(); await mock.close(); }
});
