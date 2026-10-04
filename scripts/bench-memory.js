#!/usr/bin/env node
'use strict';
// Memory / speed benchmark for the local models (Ollama), plus the memory footprint of the AI Terminal app itself.
//   node scripts/bench-memory.js                       # default matrix, writes docs/benchmark-memory.json
//   node scripts/bench-memory.js qwen3:8b:4096,8192    # custom  model:ctx,ctx,...
// Method per (model, context): unload everything -> cold load + first generation -> 2 warm generations,
// read the resident size from Ollama (/api/ps) and the system memory (vm_stat) before/after.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const BASE = 'http://127.0.0.1:11434';
const PROMPT = '터미널에서 3000번 포트를 사용하는 프로세스를 확인하는 방법을 세 문장으로 설명해줘.';
const DEFAULT = { 'qwen3:8b': [4096, 8192, 12288, 16384, 24576, 32768], 'qwen3:14b': [8192, 12288, 16384], 'qwen2.5:7b': [12288] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gbDec = (b) => Math.round(b / 1e8) / 10;
const gbBin = (b) => Math.round((b / 1073741824) * 10) / 10;
const localStamp = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

const get = async (p) => (await fetch(BASE + p, { signal: AbortSignal.timeout(5000) })).json();
const post = async (p, body, ms = 600000) => (await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) })).json();

function vm() {
  const out = execFileSync('/usr/bin/vm_stat', { encoding: 'utf8' });
  const page = Number((out.match(/page size of (\d+) bytes/) || [])[1]) || 16384;
  const n = (k) => Number((out.match(new RegExp(`${k}:\\s+(\\d+)`)) || [])[1]) || 0;
  const avail = (n('Pages free') + n('Pages inactive') + n('Pages speculative') + n('Pages purgeable')) * page;
  return { availGB: gbBin(avail), wiredGB: gbBin(n('Pages wired down') * page), compressedGB: gbBin(n('Pages occupied by compressor') * page) };
}

async function unloadAll() {
  for (let i = 0; i < 3; i++) {
    const ps = await get('/api/ps');
    if (!ps.models.length) return;
    for (const m of ps.models) await post('/api/generate', { model: m.name, keep_alive: 0 }, 15000).catch(() => {});
    await sleep(2500);
  }
}

async function measure(model, ctx) {
  await unloadAll();
  await sleep(1500);
  const before = vm();
  const opts = { num_ctx: ctx, num_predict: 120, temperature: 0 };
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    const r = await post('/api/generate', { model, prompt: PROMPT, stream: false, think: false, keep_alive: '5m', options: opts });
    runs.push({ wall: (Date.now() - t0) / 1000, load: (r.load_duration || 0) / 1e9, gen: r.eval_count, tps: r.eval_count / (r.eval_duration / 1e9), promptTok: r.prompt_eval_count });
    if (i === 0) await sleep(800);
  }
  const ps = (await get('/api/ps')).models.find((m) => m.name === model);
  const after = vm();
  const row = {
    model, ctx,
    residentGB: ps ? gbDec(ps.size) : null, // same decimal GB as `ollama ps`
    gpuPct: ps && ps.size ? Math.round((ps.size_vram / ps.size) * 100) : null,
    coldLoadSec: Math.round(runs[0].load * 10) / 10,
    firstWallSec: Math.round(runs[0].wall * 10) / 10,
    tokPerSec: Math.round(median(runs.map((r) => r.tps)) * 10) / 10,
    availBeforeGB: before.availGB, availAfterGB: after.availGB, wiredBeforeGB: before.wiredGB, wiredAfterGB: after.wiredGB,
  };
  console.log(`${model.padEnd(11)} ctx=${String(ctx).padStart(5)}  resident=${row.residentGB}GB  load=${row.coldLoadSec}s  ${row.tokPerSec} tok/s  avail ${before.availGB}→${after.availGB}GB  wired ${before.wiredGB}→${after.wiredGB}GB`);
  return row;
}

/** RSS of the installed app (all Electron processes), idle with one tab. RSS counts shared pages in every process. */
async function appMemory() {
  const bin = '/Applications/AI Terminal.app/Contents/MacOS/AI Terminal';
  if (!fs.existsSync(bin)) return null;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-memprofile-'));
  const child = spawn(bin, [`--user-data-dir=${profile}`], { stdio: 'ignore', env: { ...process.env, AIT_CWD: os.homedir() } });
  await sleep(12000);
  const rss = () => execFileSync('/bin/ps', ['-axo', 'rss=,command='], { encoding: 'utf8' }).split('\n').filter((l) => l.includes('AI Terminal.app/Contents')).reduce((a, l) => a + Number(l.trim().split(/\s+/)[0] || 0), 0) / 1024;
  const idle = Math.round(rss());
  const procs = execFileSync('/bin/ps', ['-axo', 'command='], { encoding: 'utf8' }).split('\n').filter((l) => l.includes('AI Terminal.app/Contents')).length;
  child.kill('SIGTERM');
  await sleep(3000);
  try { execFileSync('/usr/bin/pkill', ['-f', 'AI Terminal.app/Contents/MacOS']); } catch { /* already gone */ }
  return { idleRssMB: idle, processes: procs };
}

(async () => {
  const arg = process.argv[2];
  const matrix = arg ? Object.fromEntries(arg.split(';').map((s) => { const [m, c] = [s.slice(0, s.lastIndexOf(':')), s.slice(s.lastIndexOf(':') + 1)]; return [m, c.split(',').map(Number)]; })) : DEFAULT;
  const env = {
    measuredAt: localStamp(),
    macOS: execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(),
    chip: execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).trim(),
    ramGB: gbBin(os.totalmem()),
    ollama: (execFileSync('ollama', ['--version'], { encoding: 'utf8' }).match(/(\d+\.\d+\.\d+)/) || [])[1] || 'unknown',
    prompt: PROMPT,
    note: 'num_predict=120, temperature=0, think=false; tok/s = median of 3 generations; other apps (browser, messenger, editor) were running',
  };
  console.log('ENV', JSON.stringify(env));
  const rows = [];
  for (const [model, ctxs] of Object.entries(matrix)) for (const ctx of ctxs) rows.push(await measure(model, ctx));
  await unloadAll();
  const app = await appMemory();
  if (app) console.log(`app (idle, 1 tab): ${app.idleRssMB}MB RSS over ${app.processes} processes`);
  const out = path.join(__dirname, '..', 'docs', 'benchmark-memory.json');
  fs.writeFileSync(out, JSON.stringify({ env, rows, app }, null, 1) + '\n');
  console.log('written', out);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
