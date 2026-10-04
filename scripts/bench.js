#!/usr/bin/env node
'use strict';
// Model benchmark with the real agent + real PTY shell on throw-away workspaces.
//   node scripts/bench.js qwen3:8b qwen3:14b
// Each task has an objective check (run after the agent finishes), plus wall time and step count.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { PtySession } = require('../src/main/pty-session');
const { LlmManager } = require('../src/main/llm/manager');
const { Agent } = require('../src/main/agent');
const { Settings } = require('../src/main/settings');

const sh = (cmd, cwd) => { try { execFileSync('/bin/sh', ['-c', cmd], { cwd, stdio: 'ignore', timeout: 20000 }); return true; } catch { return false; } };
const W = (dir, files) => { fs.mkdirSync(dir, { recursive: true }); for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); } };

const BASE = {
  'package.json': '{"name":"demo","scripts":{"test":"node test.js"}}\n',
  'src/util.js': 'function add(a, b) { return a + b; }\nmodule.exports = { add };\n',
  'test.js': "const { add } = require('./src/util');\nif (add(2, 3) !== 5) { console.error('FAIL add'); process.exit(1); }\nconsole.log('ok');\n",
  'server.js': "require('http').createServer((q, r) => r.end('hi')).listen(3000);\n",
};

const TASKS = [
  { id: 'explain', label: '구조 설명', req: '현재 프로젝트 구조를 설명해줘.', files: BASE, check: (d, say) => say.length > 60 && /util|server|test/.test(say) },
  { id: 'bugfix', label: '버그 수정(JS)', req: 'npm test가 실패해. 원인을 찾아서 수정해줘.', files: { ...BASE, 'src/util.js': 'function add(a, b) { return a - b; }\nmodule.exports = { add };\n' }, check: (d) => sh('node test.js', d) },
  { id: 'feature', label: '코딩: 기능+테스트 추가', req: 'src/util.js 에 multiply(a, b) 와 divide(a, b) 함수를 추가해줘. divide 에서 b 가 0 이면 Error("divide by zero") 를 던져야 해. 그리고 test.js 에 이 두 함수의 테스트를 추가하고 npm test 가 통과하는지 확인해줘.', files: BASE,
    check: (d) => sh(`node -e "const u=require('./src/util');if(u.multiply(3,4)!==12||u.divide(8,2)!==4)process.exit(1);try{u.divide(1,0);process.exit(1)}catch(e){if(!/divide by zero/.test(e.message))process.exit(1)}"`, d) && sh('grep -q multiply test.js && grep -q divide test.js && node test.js', d) },
  { id: 'python', label: '코딩: 버그 수정(Python)', req: 'test_fizz.py 가 실패해. fizz.py 의 버그를 고쳐서 python3 test_fizz.py 가 통과하게 해줘.',
    files: { 'fizz.py': 'def fizzbuzz(n):\n    if n % 3 == 0:\n        return "Fizz"\n    if n % 5 == 0:\n        return "Buzz"\n    if n % 15 == 0:\n        return "FizzBuzz"\n    return str(n)\n', 'test_fizz.py': 'from fizz import fizzbuzz\nassert fizzbuzz(15) == "FizzBuzz", fizzbuzz(15)\nassert fizzbuzz(9) == "Fizz"\nassert fizzbuzz(10) == "Buzz"\nassert fizzbuzz(7) == "7"\nprint("ok")\n' },
    check: (d) => sh('python3 test_fizz.py', d) },
  { id: 'organize', label: '터미널: 파일 정리', req: '현재 폴더의 .log 파일들을 모두 logs 폴더를 만들어 그 안으로 옮겨줘.', files: { 'a.log': '1', 'b.log': '2', 'keep.txt': 'x', 'c.log': '3' },
    check: (d) => ['a', 'b', 'c'].every((n) => fs.existsSync(path.join(d, 'logs', `${n}.log`)) && !fs.existsSync(path.join(d, `${n}.log`))) && fs.existsSync(path.join(d, 'keep.txt')) },
];

/** Resident size (decimal GB) of every model on the shared and the managed Ollama server (highest value seen = peak). */
async function residentGB(llm) {
  const bases = ['http://127.0.0.1:11434'];
  if (llm.engine && llm.engine.base) bases.push(llm.engine.base);
  let sum = 0;
  for (const b of bases) {
    try { sum += ((await (await fetch(`${b}/api/ps`, { signal: AbortSignal.timeout(900) })).json()).models || []).reduce((a, m) => a + (m.size || 0), 0); } catch { /* server down */ }
  }
  return Math.round(sum / 1e7) / 100;
}

async function runModel(model, only, opts = {}) {
  process.env.AIT_OLLAMA_MODEL = model;
  process.env.AIT_LLM = 'ollama';
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-bench-data-'));
  const settings = new Settings(dataDir);
  for (const [k, v] of Object.entries(opts.settings || {})) settings.set(k, v);
  const llm = new LlmManager({ dataDir, settings });
  await llm.detect();
  if (!llm.status.active) throw new Error('Ollama not available');
  // warm-up so model load time is not attributed to the first task
  await llm.complete({ system: 'json', user: '{"say":"ok","action":"done"} 형태로 한 줄만' }).catch(() => {});
  const rows = [];
  for (const t of TASKS.filter((x) => !only || only.includes(x.id))) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ait-bench-${t.id}-`));
    W(dir, t.files);
    if (sh('which git', dir)) sh('git init -q . && git add -A', dir);
    const session = new PtySession({ cwd: dir }).start();
    await new Promise((r) => { const i = setInterval(() => session.integrated && (clearInterval(i), r()), 50); });
    const agent = new Agent({ session, llm, dataDir, settings });
    let say = ''; let cmds = 0; let edits = 0; let err = '';
    const kv = { plans: [], calls: 0, prefill: 0, prefillMs: 0, gen: 0, promptEstMax: 0, ctx: 0, kvType: null, kvGB: 0, peakGB: 0, packRaw: 0, packKept: 0 };
    const poll = setInterval(async () => { kv.peakGB = Math.max(kv.peakGB, await residentGB(llm)); }, 2000);
    agent.on('event', (e) => {
      if (e.type === 'say') say = e.text;
      if (e.type === 'command-start') cmds++;
      if (e.type === 'file-write') edits++;
      if (e.type === 'error') err = `${e.kind}: ${e.message}`;
      if (e.type === 'kv-usage') {
        const u = e.usage;
        kv.calls++; kv.prefill += u.promptTokens; kv.prefillMs += u.promptMs || 0; kv.plans.push(`${u.engine}/${u.kvType}/${u.ctx}/${u.promptMs}ms`); kv.gen += u.evalTokens; kv.promptEstMax = Math.max(kv.promptEstMax, u.promptEst || 0);
        kv.ctx = u.ctx; kv.kvType = u.kvType; kv.kvGB = u.kvGB;
        if (u.pack) { kv.packRaw = u.pack.rawChars; kv.packKept = u.pack.packedChars; }
      }
      if (e.type === 'approval') setTimeout(() => agent.answerApproval(e.id, false), 20);
    });
    const t0 = Date.now();
    await Promise.race([agent.handle(t.req), new Promise((r) => setTimeout(() => { agent.abort(); r(); }, 420000))]);
    const secs = (Date.now() - t0) / 1000;
    let ok = false;
    try { ok = !!t.check(dir, say); } catch { ok = false; }
    session.kill();
    clearInterval(poll);
    kv.peakGB = Math.max(kv.peakGB, await residentGB(llm));
    rows.push({ model, task: t.label, ok, secs: Math.round(secs), cmds, edits, err, kv });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${model.padEnd(12)} ${t.label.padEnd(24)} ${String(Math.round(secs)).padStart(4)}s  cmds=${cmds} edits=${edits}${err ? '  ' + err : ''}`);
  }
  llm.dispose();
  return rows;
}

module.exports = { TASKS, runModel, residentGB };
if (require.main === module) (async () => {
  const args = process.argv.slice(2);
  const only = (args.find((a) => a.startsWith('--only=')) || '').replace('--only=', '').split(',').filter(Boolean);
  const models = args.filter((a) => !a.startsWith('--'));
  const all = [];
  for (const m of models) all.push(...(await runModel(m, only.length ? only : null)));
  console.log('\n| 모델 | 통과 | 총 시간 |');
  console.log('|---|---|---|');
  for (const m of models) {
    const r = all.filter((x) => x.model === m);
    console.log(`| ${m} | ${r.filter((x) => x.ok).length}/${r.length} | ${r.reduce((a, b) => a + b.secs, 0)}s |`);
  }
  // merge into docs/benchmark-agent.json (rows of the models/tasks that were just re-run replace the old ones)
  const file = path.join(__dirname, '..', 'docs', 'benchmark-agent.json');
  let saved = { env: {}, rows: [] };
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
  const key = (r) => `${r.model}|${r.task}`;
  const fresh = new Set(all.map(key));
  const rows = saved.rows.filter((r) => !fresh.has(key(r))).concat(all);
  const env = { ...saved.env, lastRun: (() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; })(), note: '1 run per task; model call limit 240s (120s before 2026-10-03), 420s per task' };
  fs.writeFileSync(file, JSON.stringify({ env, rows }, null, 1) + '\n');
  process.exit(0);
})();
