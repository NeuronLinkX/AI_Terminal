#!/usr/bin/env node
'use strict';
// Renders the benchmark tables in README.md from docs/benchmark-*.json (no hand-copied numbers).
//   node scripts/bench-report.js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const readme = path.join(root, 'README.md');
const mem = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'benchmark-memory.json'), 'utf8'));
const agent = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'benchmark-agent.json'), 'utf8'));

const K = (n) => `${n / 1024}K`;
const DEFAULT_MODEL = 'qwen3:8b';
const DEFAULT_CTX = 12288;

function memoryTable() {
  const head = '| 모델 | 컨텍스트 | 메모리에 올라온 크기 | 생성 속도 | 처음 불러오는 시간† | 올린 뒤 가용 메모리 (올리기 전) |\n|---|---|---|---|---|---|';
  const rows = mem.rows.map((r) => {
    const name = r.model === DEFAULT_MODEL ? `\`${r.model}\` (기본)` : `\`${r.model}\``;
    const ctx = r.ctx === DEFAULT_CTX ? `${K(r.ctx)} (기본)` : K(r.ctx);
    return `| ${name} | ${ctx} | **${r.residentGB}GB** | ${r.tokPerSec} tok/s | ${r.coldLoadSec}초 | ${r.availAfterGB}GB (${r.availBeforeGB}GB) |`;
  });
  return [head, ...rows].join('\n');
}

function agentTable() {
  const models = [...new Set(agent.rows.map((r) => r.model))];
  const tasks = [...new Set(agent.rows.map((r) => r.task))];
  const cell = (m, t) => {
    const r = agent.rows.find((x) => x.model === m && x.task === t);
    if (!r) return '—';
    const note = r.secs >= 420 ? ' (420초 상한에 도달해 중단)' : /timeout/.test(r.err || '') ? ' (모델 응답 시간 초과)' : '';
    return `${r.ok ? '통과' : '**실패**'} · ${r.secs}초${note}`;
  };
  const head = `| 과제 | ${models.map((m) => `\`${m}\``).join(' | ')} |\n|---|${models.map(() => '---').join('|')}|`;
  const body = tasks.map((t) => `| ${t} | ${models.map((m) => cell(m, t)).join(' | ')} |`);
  const total = `| **합계** | ${models.map((m) => { const rs = agent.rows.filter((r) => r.model === m); return `**${rs.filter((r) => r.ok).length}/${rs.length} 통과 · ${rs.reduce((a, r) => a + r.secs, 0)}초**`; }).join(' | ')} |`;
  return [head, ...body, total].join('\n');
}

// ---- KV cache study (docs/benchmark-kv.json, docs/benchmark-kv-layers.json): optional, rendered when the data exists
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(root, 'docs', f), 'utf8')); } catch { return null; } };
const kv = readJson('benchmark-kv.json');
const layers = readJson('benchmark-kv-layers.json');
const pct = (x) => `${(x * 100).toFixed(1)}%`;

function kvMemTable() {
  if (!kv || !kv.memory) return null;
  const head = '| 모델 | 컨텍스트 | 이전(기본 Ollama, f16) | f16 + flash attention | **q8_0** | **q4_0** | q8_0 절약 | q4_0 절약 | 속도 (tok/s) f16 → q8_0 → q4_0 |\n|---|---|---|---|---|---|---|---|---|';
  const keys = [...new Set(kv.memory.map((r) => `${r.model}|${r.ctx}`))];
  const rows = keys.map((k) => {
    const [model, ctx] = k.split('|');
    const pick = (type, eng) => kv.memory.find((r) => r.model === model && String(r.ctx) === ctx && r.kvType === type && (eng ? r.engine === eng : r.engine === 'managed'));
    const before = pick('f16', 'shared (before)');
    const f16 = pick('f16'), q8 = pick('q8_0'), q4 = pick('q4_0');
    if (!before || !q8 || !q4) return null;
    const save = (r) => `−${(before.residentGB - r.residentGB).toFixed(2)}GB (${Math.round(((before.residentGB - r.residentGB) / before.residentGB) * 100)}%)`;
    const tps = [f16 || before, q8, q4].map((r) => r.tokPerSec).join(' → ');
    return `| \`${model}\` | ${K(Number(ctx))} | ${before.residentGB}GB | ${f16 ? f16.residentGB + 'GB' : '—'} | **${q8.residentGB}GB** | **${q4.residentGB}GB** | ${save(q8)} | ${save(q4)} | ${tps} |`;
  }).filter(Boolean);
  return [head, ...rows].join('\n');
}

function kvPplTable() {
  if (!kv || !kv.perplexity) return null;
  const rows = kv.perplexity.rows;
  const ctxs = [...new Set(rows.map((r) => r.ctx))];
  const head = `| K 캐시 | V 캐시 | KV 크기(f16 대비) | ${ctxs.map((c) => `PPL @ ${K(c)} (Δ)`).join(' | ')} |\n|---|---|---|${ctxs.map(() => '---').join('|')}|`;
  const size = { f16: 1, q8_0: 34 / 64, q4_0: 18 / 64 };
  const combos = [...new Set(rows.map((r) => `${r.k}/${r.v}`))];
  const body = combos.map((cv) => {
    const [k, v] = cv.split('/');
    const cells = ctxs.map((c) => {
      const r = rows.find((x) => x.ctx === c && x.k === k && x.v === v);
      const base = rows.find((x) => x.ctx === c && x.k === 'f16' && x.v === 'f16');
      if (!r || !base) return '—';
      const d = r.ppl - base.ppl;
      return `${r.ppl.toFixed(3)} (${d >= 0 ? '+' : ''}${d.toFixed(3)})`;
    });
    return `| ${k} | ${v} | ${Math.round(((size[k] + size[v]) / 2) * 100)}% | ${cells.join(' | ')} |`;
  });
  return [head, ...body].join('\n');
}

function kvSpeedTable() {
  if (!kv || !kv.speed) return null;
  const base = kv.speed.find((r) => r.k === 'f16' && r.v === 'f16');
  const rel = (x, b) => (b ? ` (${x >= b ? '+' : '−'}${Math.abs(Math.round(((x - b) / b) * 100))}%)` : '');
  const head = '| K 캐시 | V 캐시 | 입력 처리 pp512 (tok/s) | 입력 처리 pp2048 (tok/s) | 생성 tg64 (tok/s) |\n|---|---|---|---|---|';
  const rows = kv.speed.map((r) => `| ${r.k} | ${r.v} | ${r.pp512}${r !== base ? rel(r.pp512, base.pp512) : ''} | ${r.pp2048}${r !== base ? rel(r.pp2048, base.pp2048) : ''} | ${r.tg64}${r !== base ? rel(r.tg64, base.tg64) : ''} |`);
  return [head, ...rows].join('\n');
}

function kvLayersTable() {
  if (!layers) return null;
  const names = [['uniform', '균등 (H2O·SnapKV 기본)'], ['pyramid', 'PyramidKV 식 (아래층 ↑)'], ['cake', 'CAKE 식 (엔트로피×변동)'], ['depthkv-proportional', 'DepthKV 식 (손실에 비례)'], ['marginal', '한계이득 균등화 (대리지표 최적)'], ['adakv(uniform layers)', 'Ada-KV (균등 층 + 헤드 풀링)'], ['marginal+adakv', '한계이득 + Ada-KV'], ['marginal(oracle)', '(상한) 같은 프롬프트로 보정']];
  const rhos = ['0.05', '0.1', '0.2', '0.4'].filter((r) => layers.eval[r]);
  const head = `| 정책 (총 KV 예산 동일) | ${rhos.map((r) => `평균 ${Math.round(r * 100)}% 유지 시 잃는 어텐션`).join(' | ')} |\n|---|${rhos.map(() => '---').join('|')}|`;
  const body = names.filter(([k]) => layers.eval[rhos[0]][k]).map(([k, label]) => `| ${label} | ${rhos.map((r) => { const v = layers.eval[r][k].meanLoss; const u = layers.eval[r].uniform.meanLoss; return `${pct(v)}${k === 'uniform' ? '' : ` (${v <= u ? '−' : '+'}${Math.abs(((v - u) / u) * 100).toFixed(0)}%)`}`; }).join(' | ')} |`);
  return [head, ...body].join('\n');
}

function kvAgentTable() {
  if (!kv || !kv.agent || !kv.agent.rows.length) return null;
  const variants = [...new Set(kv.agent.rows.map((r) => r.variant))];
  const label = { q8: '**q8_0 고정** (앱 전용 엔진 · 압축 · 컨텍스트 맞춤)', baseline: '이전 (f16 · 기존 프롬프트 정리 · 12K)', default: '**새 기본값** (자동 KV · 민감도 기반 압축 · 컨텍스트 맞춤)', tight: '극단 절약 (q4_0 · 강한 압축)' };
  const model = kv.agent.rows[0].model;
  const rows = kv.agent.rows.filter((r) => r.model === model);
  const head = '| 설정 | 통과 | 총 시간 | 입력 처리 시간 합계† (호출 수) | 호출당 평균 처리 시간 | 호출당 입력 토큰(전체) | 사용한 컨텍스트 · KV | 측정된 최대 상주 메모리 |\n|---|---|---|---|---|---|---|---|';
  const body = variants.map((v) => {
    const r = rows.filter((x) => x.variant === v);
    if (!r.length) return null;
    const calls = r.reduce((a, x) => a + x.kv.calls, 0) || 1;
    const ctxs = [...new Set(r.map((x) => `${(x.kv.ctx / 1024) || '?'}K`))].join('/');
    return `| ${label[v] || v} | ${r.filter((x) => x.ok).length}/${r.length} | ${r.reduce((a, x) => a + x.secs, 0)}초 | ${Math.round(r.reduce((a, x) => a + (x.kv.prefillMs || 0), 0) / 100) / 10}초 (${calls}회) | ${(r.reduce((a, x) => a + (x.kv.prefillMs || 0), 0) / calls / 1000).toFixed(2)}초 | ${Math.round(r.reduce((a, x) => a + x.kv.prefill, 0) / calls)} | ${ctxs} · ${r[r.length - 1].kv.kvType} (${Math.max(...r.map((x) => x.kv.kvGB))}GB) | **${Math.max(...r.map((x) => x.kv.peakGB))}GB** |`;
  }).filter(Boolean);
  const per = ['과제별 결과 (통과/실패 · 초)', ''];
  const tasks = [...new Set(rows.map((r) => r.task))];
  const t = `| 과제 | ${variants.map((v) => v).join(' | ')} |\n|---|${variants.map(() => '---').join('|')}|\n` + tasks.map((task) => `| ${task} | ${variants.map((v) => { const r = rows.find((x) => x.variant === v && x.task === task); return r ? `${r.ok ? '통과' : '**실패**'} · ${r.secs}초` : '—'; }).join(' | ')} |`).join('\n');
  return [head, ...body, '', ...per, t].join('\n');
}

let s = fs.readFileSync(readme, 'utf8');
const files = [readme, path.join(root, 'docs', 'KV_CACHE.md')].filter((f) => fs.existsSync(f));
const sources = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));
const render = (name, text, required) => {
  let hit = false;
  for (const [f, src] of sources) {
    const re = new RegExp(`(<!-- bench:${name}:start -->)[\\s\\S]*?(<!-- bench:${name}:end -->)`, 'g');
    if (re.test(src)) { sources.set(f, src.replace(new RegExp(re.source, 'g'), `$1\n${text}\n$2`)); hit = true; }
  }
  if (!hit && required) throw new Error(`marker bench:${name} not found in README.md`);
};
render('memory', memoryTable(), true);
render('agent', agentTable(), true);
for (const [name, text] of [['kvmem', kvMemTable()], ['kvppl', kvPplTable()], ['kvspeed', kvSpeedTable()], ['kvlayers', kvLayersTable()], ['kvagent', kvAgentTable()]]) if (text) render(name, text, false);
for (const [f, src] of sources) fs.writeFileSync(f, src);
console.log('benchmark tables updated from docs/benchmark-*.json in', files.map((f) => path.relative(root, f)).join(', '));
