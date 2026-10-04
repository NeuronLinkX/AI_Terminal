#!/usr/bin/env node
'use strict';
// A tiny scripted stand-in for Ollama. It speaks just enough of the HTTP API (tags / ps / chat / generate / pull) for
// the app's agent loop, so CI, visual-regression and e2e runs are deterministic and need no real model or GPU.
//   node scripts/mock-ollama.js [port]        (default 11499)  then run the app with OLLAMA_HOST=127.0.0.1:11499
const http = require('http');

const MODELS = [
  { name: 'mock:8b', size: 5.2e9, details: { parameter_size: '8B' } },
  { name: 'mock:14b', size: 9.3e9, details: { parameter_size: '14B' } },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The scripted "brain": decides the next step from the user's request and the steps already taken. */
function brain(prompt, kind) {
  const req = ((prompt.match(/\[사용자 요청\]\n([\s\S]*?)(?:\n\n\[|$)/) || [])[1] || prompt).trim();
  const steps = (prompt.match(/^\d+\. (run|read_file|edit_file|write_file|search) /gm) || []).length;
  const last = (prompt.match(/^\d+\. .*$/gm) || []).pop() || '';
  const D = (o) => ({ say: '', action: 'done', command: null, path: null, content: null, seconds: null, old_text: null, new_text: null, start_line: null, end_line: null, ...o });
  if (kind === 'plan') {
    return { say: '다음 순서로 진행하겠습니다.', plan: ['현재 상태를 확인한다', '필요한 파일을 읽는다', '수정하고 테스트로 검증한다'] };
  }
  if (kind === 'edit') return { code: '/* 모의 모델이 수정한 코드 */' };
  if (/검색|찾아줘/.test(req)) return steps === 0 ? D({ say: 'add 함수가 정의된 곳을 검색합니다.', action: 'search', content: 'function add' }) : D({ say: 'src/util.js 에 add 함수가 있습니다. (모의 모델 응답)' });
  if (/curl|다운로드/.test(req)) return steps === 0 ? D({ say: '외부 주소에 요청합니다.', action: 'run', command: 'curl -s http://127.0.0.1:9/' }) : D({ say: '요청을 처리했습니다. (모의 모델 응답)' });
  if (/파일을 만들|새 파일/.test(req)) return steps === 0 ? D({ say: 'made_by_mock.txt 를 만듭니다.', action: 'write_file', path: 'made_by_mock.txt', content: 'hello from mock\n' }) : D({ say: '파일을 만들었습니다. (모의 모델 응답)' });
  if (/구조|설명/.test(req)) return steps === 0 ? D({ say: '파일 목록을 확인합니다.', action: 'run', command: 'ls -la' }) : D({ say: '이 프로젝트에는 package.json, src, test.js 등이 있습니다. (모의 모델 응답)' });
  if (/삭제/.test(req)) {
    const f = (req.match(/([\w.-]+\.\w+)/) || [])[1] || 'tmp.txt';
    return steps === 0 ? D({ say: `${f} 파일을 삭제합니다.`, action: 'run', command: `rm ${f}` }) : D({ say: `${f} 삭제 요청을 처리했습니다. (모의 모델 응답)` });
  }
  if (/pwd|디렉터리/.test(req)) return steps === 0 ? D({ say: '현재 디렉터리를 확인합니다.', action: 'run', command: 'pwd' }) : D({ say: '현재 디렉터리를 확인했습니다. (모의 모델 응답)' });
  if (/수정|버그|실패/.test(req)) {
    if (steps === 0) return D({ say: '테스트를 실행합니다.', action: 'run', command: 'node test.js' });
    if (steps === 1) return D({ say: '원인 파일을 읽습니다.', action: 'read_file', path: 'src/util.js' });
    if (steps === 2) return D({ say: '연산자를 고칩니다.', action: 'edit_file', path: 'src/util.js', old_text: 'a - b', new_text: 'a + b' });
    if (steps === 3) return D({ say: '다시 테스트합니다.', action: 'run', command: 'node test.js' });
    return D({ say: '버그를 고치고 테스트가 통과했습니다. (모의 모델 응답)' });
  }
  return D({ say: `모의 모델 응답: ${req.slice(0, 80)}${last ? '' : ''}` });
}

function createMock({ port = 11499, delay = 12 } = {}) {
  const state = { chats: [], loaded: null, models: process.env.MOCK_EMPTY === '1' ? [] : MODELS.map((m) => ({ ...m })), pulls: [] };
  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { /* ignore */ }
    const url = req.url.split('?')[0];

    if (req.method === 'GET' && url === '/api/tags') return json(res, 200, { models: state.models });
    if (req.method === 'POST' && url === '/api/show') {
      return json(res, 200, { details: { family: 'qwen3' }, model_info: { 'general.architecture': 'qwen3', 'qwen3.block_count': 36, 'qwen3.attention.head_count': 32, 'qwen3.attention.head_count_kv': 8, 'qwen3.attention.key_length': 128, 'qwen3.attention.value_length': 128, 'qwen3.embedding_length': 4096, 'qwen3.context_length': 40960 } });
    }
    if (req.method === 'GET' && url === '/api/ps') {
      const m = state.loaded && state.models.find((x) => x.name === state.loaded.name);
      return json(res, 200, { models: m ? [{ name: m.name, size: m.size + (state.loaded.ctx || 8192) * 150000, size_vram: m.size, context_length: state.loaded.ctx }] : [] });
    }
    if (req.method === 'POST' && url === '/api/generate') {
      if (body.keep_alive === 0 || body.keep_alive === '0') { state.loaded = null; return json(res, 200, { done: true }); }
      state.loaded = { name: body.model, ctx: (body.options || {}).num_ctx };
      return json(res, 200, { response: 'ok', done: true, load_duration: 1e9, eval_count: 10, eval_duration: 5e8, prompt_eval_count: 5 });
    }
    if (req.method === 'POST' && url === '/api/pull') {
      const name = body.model || body.name;
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const total = 400 * 1e6;
      res.write(JSON.stringify({ status: 'pulling manifest' }) + '\n');
      for (let i = 1; i <= 8; i++) { await sleep(120); res.write(JSON.stringify({ status: 'pulling abc123', digest: 'sha256:abc123', total, completed: (total * i) / 8 }) + '\n'); }
      res.write(JSON.stringify({ status: 'verifying sha256 digest' }) + '\n');
      res.write(JSON.stringify({ status: 'success' }) + '\n');
      res.end();
      if (!state.models.find((m) => m.name === name)) state.models.push({ name, size: total, details: { parameter_size: '0.4B' } });
      state.pulls.push(name);
      return undefined;
    }
    if (req.method === 'POST' && url === '/api/chat') {
      state.loaded = { name: body.model, ctx: (body.options || {}).num_ctx };
      const props = ((body.format || {}).properties) || {};
      const kind = props.plan ? 'plan' : props.code ? 'edit' : 'decision';
      state.chats.push({ model: body.model, num_ctx: (body.options || {}).num_ctx, stream: !!body.stream, chars: JSON.stringify(body.messages || []).length });
      const userMsg = ((body.messages || []).find((m) => m.role === 'user') || {}).content || '';
      const text = JSON.stringify(brain(userMsg, kind));
      if (!body.stream) return json(res, 200, { model: body.model, message: { role: 'assistant', content: text }, done: true, eval_count: text.length / 3, eval_duration: 1e9, prompt_eval_count: Math.ceil(userMsg.length / 3), prompt_eval_duration: 3e8, load_duration: 1e8 });
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      for (let i = 0; i < text.length; i += 6) { res.write(JSON.stringify({ model: body.model, message: { role: 'assistant', content: text.slice(i, i + 6) }, done: false }) + '\n'); await sleep(delay); }
      res.end(JSON.stringify({ model: body.model, message: { role: 'assistant', content: '' }, done: true, eval_count: text.length / 3, eval_duration: 1e9, prompt_eval_count: Math.ceil(userMsg.length / 3), prompt_eval_duration: 3e8, load_duration: 1e8 }) + '\n');
      return undefined;
    }
    return json(res, 404, { error: 'not found' });
  });
  return { server, state, listen: () => new Promise((r) => server.listen(port, '127.0.0.1', () => r(server))), close: () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(r); }) };
}

if (require.main === module) {
  const port = Number(process.argv[2]) || 11499;
  createMock({ port }).listen().then(() => console.log(`mock ollama on 127.0.0.1:${port}`));
}

module.exports = { createMock, brain };
