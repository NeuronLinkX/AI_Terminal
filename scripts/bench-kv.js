#!/usr/bin/env node
'use strict';
// KV-cache benchmark on the real local models. Writes docs/benchmark-kv.json (README tables are generated from it).
//   node scripts/bench-kv.js mem             # resident memory + speed per KV type (private Ollama servers)
//   node scripts/bench-kv.js ppl             # perplexity per KV type/combination (llama.cpp's llama-perplexity, same GGUF)
//   node scripts/bench-kv.js speed           # prefill / decode speed per KV type (llama-bench, same GGUF)
//   node scripts/bench-kv.js reuse           # prompt-cache reuse: same vs different prompt prefix (prompt_eval_duration)
//   node scripts/bench-kv.js all             # everything
// mem  : for each KV type a private `ollama serve` (OLLAMA_KV_CACHE_TYPE + OLLAMA_FLASH_ATTENTION=1, port 11435) loads the model
//        at each context, generates 3 times, and `/api/ps` gives the resident size. The same numbers are compared with the exact
//        memory model in src/main/kv/model.js (prediction error).
// ppl  : perplexity of the same GGUF file on a mixed Korean/English/code corpus with the K and V cache types varied.
//        Lower is better; the delta against f16/f16 is the quality cost of the KV compression.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync, spawnSync } = require('child_process');
const { parseGeometry, kvGB } = require('../src/main/kv/model');

const OUT = path.join(__dirname, '..', 'docs', 'benchmark-kv.json');
const SHARED = 'http://127.0.0.1:11434';
const PORT = 11435;
const PRIVATE = `http://127.0.0.1:${PORT}`;
const PROMPT = '터미널에서 3000번 포트를 사용하는 프로세스를 확인하는 방법을 세 문장으로 설명해줘.';
const MATRIX = { 'qwen3:8b': [4096, 12288, 32768], 'qwen3:14b': [12288, 16384] };
const TYPES = ['f16', 'q8_0', 'q4_0'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gbDec = (b) => Math.round(b / 1e7) / 100;
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const stamp = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };

const get = async (base, p) => (await fetch(base + p, { signal: AbortSignal.timeout(8000) })).json();
const post = async (base, p, body, ms = 600000) => (await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) })).json();

async function startPrivate(type) {
  const env = { ...process.env, OLLAMA_HOST: `127.0.0.1:${PORT}`, OLLAMA_FLASH_ATTENTION: '1', OLLAMA_KV_CACHE_TYPE: type, OLLAMA_NUM_PARALLEL: '1', OLLAMA_MAX_LOADED_MODELS: '1' };
  const child = spawn('ollama', ['serve'], { env, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    try { await get(PRIVATE, '/api/tags'); return child; } catch { /* starting */ }
  }
  child.kill();
  throw new Error('private ollama did not start');
}
const stop = async (child) => { child.kill('SIGTERM'); await sleep(2500); };

async function unloadAll(base) {
  for (let i = 0; i < 3; i++) {
    const ps = await get(base, '/api/ps');
    if (!ps.models.length) return;
    for (const m of ps.models) await post(base, '/api/generate', { model: m.name, keep_alive: 0 }, 15000).catch(() => {});
    await sleep(2000);
  }
}

async function measure(base, model, ctx, geo, weightsGB, type) {
  await unloadAll(base);
  await sleep(1000);
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    const r = await post(base, '/api/generate', { model, prompt: PROMPT, stream: false, think: false, keep_alive: '5m', options: { num_ctx: ctx, num_predict: 120, temperature: 0 } });
    runs.push({ wall: (Date.now() - t0) / 1000, load: (r.load_duration || 0) / 1e9, tps: r.eval_count / (r.eval_duration / 1e9) });
  }
  const ps = (await get(base, '/api/ps')).models.find((m) => m.name === model);
  const predicted = geo ? Math.round((weightsGB + kvGB(geo, ctx, type)) * 100) / 100 : null;
  const row = { model, ctx, kvType: type, residentGB: ps ? gbDec(ps.size) : null, predictedGB: predicted, tokPerSec: Math.round(median(runs.map((r) => r.tps)) * 10) / 10, coldLoadSec: Math.round(runs[0].load * 10) / 10 };
  console.log(`${model.padEnd(10)} ctx=${String(ctx).padStart(5)} ${type.padEnd(5)} resident=${row.residentGB}GB (model-weights+KV prediction ${predicted}GB)  ${row.tokPerSec} tok/s  load ${row.coldLoadSec}s`);
  return row;
}

async function memBench() {
  const tags = (await get(SHARED, '/api/tags')).models;
  const rows = [];
  for (const [model, ctxs] of Object.entries(MATRIX)) {
    const t = tags.find((m) => m.name === model);
    if (!t) { console.log(`skip ${model}: not installed`); continue; }
    const geo = parseGeometry((await post(SHARED, '/api/show', { model })).model_info);
    const weightsGB = gbDec(t.size);
    // baseline = the user's own Ollama exactly as the app used it before (default flash-attention/KV settings)
    await unloadAll(SHARED);
    for (const ctx of ctxs) rows.push({ ...(await measure(SHARED, model, ctx, geo, weightsGB, 'f16')), kvType: 'f16', engine: 'shared (before)' });
    await unloadAll(SHARED);
    for (const type of TYPES) {
      const child = await startPrivate(type);
      try {
        for (const ctx of ctxs) rows.push({ ...(await measure(PRIVATE, model, ctx, geo, weightsGB, type)), engine: 'managed' });
        await unloadAll(PRIVATE);
      } finally { await stop(child); }
    }
  }
  return rows;
}

// ------------------------------------------------------------------ perplexity
function blobOf(model) {
  const [name, tag] = model.split(':');
  const mf = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.ollama/models/manifests/registry.ollama.ai/library', name, tag || 'latest'), 'utf8'));
  const layer = mf.layers.find((l) => /image\.model$/.test(l.mediaType));
  return path.join(os.homedir(), '.ollama/models/blobs', layer.digest.replace(':', '-'));
}

/** Mixed Korean / English / code corpus from this repository (docs + sources), deterministic order. */
function corpus(file, minChars) {
  const root = path.join(__dirname, '..');
  const files = ['README.md', 'src/main/agent.js', 'src/main/policy.js', 'src/main/main.js', 'src/renderer/core.js', 'src/renderer/panels.js', 'src/main/llm/ollama.js', 'src/main/context.js', 'src/main/text.js', 'scripts/e2e.js', 'scripts/bench.js'];
  let txt = '';
  for (const f of files) { try { txt += fs.readFileSync(path.join(root, f), 'utf8') + '\n\n'; } catch { /* optional */ } }
  if (txt.length < minChars) throw new Error(`corpus too small: ${txt.length} chars`);
  fs.writeFileSync(file, txt);
  return txt.length;
}

function ppl(model, kType, vType, ctx, chunks, file) {
  const args = ['-m', blobOf(model), '-f', file, '-c', String(ctx), '--chunks', String(chunks), '-ngl', '99', '-fa', 'on', '-ctk', kType, '-ctv', vType, '-b', '512'];
  const t0 = Date.now();
  const r = spawnSync('llama-perplexity', args, { encoding: 'utf8', maxBuffer: 1 << 26, timeout: 1800000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/Final estimate: PPL = ([\d.]+) \+\/- ([\d.]+)/);
  if (!m) throw new Error(`perplexity failed (${model} ${kType}/${vType}): ${out.slice(-400)}`);
  const row = { model, ctx, chunks, k: kType, v: vType, ppl: Number(m[1]), pm: Number(m[2]), seconds: Math.round((Date.now() - t0) / 1000) };
  console.log(`${model} ctx=${ctx} K=${kType.padEnd(5)} V=${vType.padEnd(5)} PPL=${row.ppl} ±${row.pm}  (${row.seconds}s)`);
  return row;
}

function pplBench(save) {
  const file = path.join(os.tmpdir(), 'ait-kv-corpus.txt');
  const chars = corpus(file, 120000);
  console.log(`corpus: ${chars} chars`);
  const out = { corpusChars: chars, rows: [], failed: [] };
  // Ollama applies one type to K and V, so the symmetric combinations are what the app can use (the asymmetric K8/V4 option
  // is measured for speed in "speed": on this Metal build it is ~2x slower, so no perplexity run was spent on it).
  const plan = [[2048, 16, ['f16', 'q8_0', 'q4_0']], [8192, 4, ['f16', 'q8_0', 'q4_0']]];
  for (const [ctx, chunks, types] of plan) {
    for (const t of types) {
      try { out.rows.push(ppl('qwen3:8b', t, t, ctx, chunks, file)); } catch (e) { console.log(String(e.message).slice(0, 200)); out.failed.push({ ctx, k: t, v: t }); }
      save(out); // a crash later must not lose what is already measured
    }
  }
  return out;
}

/** Prefill (pp512, pp2048) and decode (tg64) speed per KV type with llama-bench on the same GGUF. */
function speedBench() {
  const rows = [];
  for (const [k, v] of [['f16', 'f16'], ['q8_0', 'q8_0'], ['q4_0', 'q4_0'], ['q8_0', 'q4_0']]) {
    const r = spawnSync('llama-bench', ['-m', blobOf('qwen3:8b'), '-fa', '1', '-ctk', k, '-ctv', v, '-p', '512,2048', '-n', '64', '-ngl', '99', '-r', '3', '-o', 'json'], { encoding: 'utf8', maxBuffer: 1 << 24, timeout: 1200000 });
    let j;
    try { j = JSON.parse(r.stdout.slice(r.stdout.indexOf('['))); } catch { throw new Error(`llama-bench failed for ${k}/${v}: ${(r.stderr || '').slice(-300)}`); }
    const pick = (np, ng) => { const x = j.find((e) => e.n_prompt === np && e.n_gen === ng); return x ? Math.round(x.avg_ts * 10) / 10 : null; };
    const row = { model: 'qwen3:8b', k, v, pp512: pick(512, 0), pp2048: pick(2048, 0), tg64: pick(0, 64) };
    console.log(`speed K=${k} V=${v}: pp512 ${row.pp512} · pp2048 ${row.pp2048} · tg64 ${row.tg64} tok/s`);
    rows.push(row);
  }
  return rows;
}

/**
 * Prompt-cache reuse: the same long prefix twice vs a different prefix. Ollama's `prompt_eval_count` counts the WHOLE prompt even
 * when most of it comes from the cache, so the reuse shows in `prompt_eval_duration`, not in the token count.
 */
async function reuseBench() {
  const model = 'qwen3:8b';
  await unloadAll(SHARED);
  const sys = '당신은 터미널 도우미입니다. '.repeat(150);
  const prefix = `파일 목록: ${'alpha beta gamma delta epsilon zeta eta theta iota kappa\n'.repeat(120)}`;
  const call = async (user) => {
    const r = await post(SHARED, '/api/chat', { model, stream: false, think: false, keep_alive: '5m', options: { num_ctx: 8192, num_predict: 8, temperature: 0 }, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] });
    return { tokens: r.prompt_eval_count, ms: Math.round((r.prompt_eval_duration || 0) / 1e6) };
  };
  const cold = await call(`${prefix}\n질문: 첫 번째`);
  const same = [];
  for (let i = 0; i < 3; i++) same.push(await call(`${prefix}\n질문: ${i + 2}번째 질문입니다`));
  const miss = [];
  for (let i = 0; i < 2; i++) miss.push(await call(`완전히 다른 앞부분 ${i}. ${prefix}\n질문: 확인`));
  const med = (a) => a.map((x) => x.ms).sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const row = { model, tokens: cold.tokens, coldMs: cold.ms, reuseMs: med(same), missMs: med(miss), measuredAt: stamp() };
  console.log(`reuse: ${row.tokens} tokens — first call ${row.coldMs} ms · same prefix ${row.reuseMs} ms · different prefix ${row.missMs} ms`);
  await unloadAll(SHARED);
  return row;
}

(async () => {
  const mode = process.argv[2] || 'all';
  const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  const ver = (() => { try { return execFileSync('ollama', ['--version'], { encoding: 'utf8' }).trim().split(' ').pop(); } catch { return '?'; } })();
  const lcpp = (() => { try { return (execFileSync('llama-perplexity', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '').trim(); } catch (e) { return String((e.stderr || e.stdout || '')).match(/version: [^\n]+/)?.[0] || '?'; } })();
  const data = { ...prev, env: { measuredAt: stamp(), chip: 'Apple M4', ramGB: Math.round(os.totalmem() / 1073741824), ollama: ver, llamaCpp: lcpp, note: 'private ollama servers with OLLAMA_FLASH_ATTENTION=1; tok/s = median of 3 generations (num_predict 120, temperature 0, think off); other apps were running' } };
  if (mode === 'mem' || mode === 'all') data.memory = await memBench();
  const persist = () => { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(data, null, 1)); };
  if (mode === 'ppl' || mode === 'all') data.perplexity = pplBench((o) => { data.perplexity = o; persist(); });
  if (mode === 'speed' || mode === 'all') data.speed = speedBench();
  if (mode === 'reuse' || mode === 'all') data.reuse = await reuseBench();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(data, null, 1));
  console.log('written', OUT);
})().catch((e) => { console.error(e); process.exit(1); });
