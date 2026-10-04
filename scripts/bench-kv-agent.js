#!/usr/bin/env node
'use strict';
// Does the KV economy cost quality? The same 5 agent tasks (real agent + real PTY shell + real model) under different
// KV configurations. Writes the `agent` section of docs/benchmark-kv.json.
//   node scripts/bench-kv-agent.js [model] [--only=bugfix,feature] [--variants=baseline,default]
// baseline  the behaviour before this work: shared Ollama, f16 KV, legacy prompt trimming, 12K context
// default   the new defaults: auto KV precision (managed engine when it saves memory), depth-aware compaction, right-sized context
// q8        pinned q8_0 KV (the managed engine) + compaction: the memory-saving setting a tight Mac would pick
// tight     q4_0 KV + aggressive compaction (what a memory-starved Mac would run)
const fs = require('fs');
const path = require('path');
const { TASKS, runModel } = require('./bench');

const VARIANTS = {
  baseline: { kvPrecision: 'f16', ctxCompaction: 'off', contextTokens: 12288 },
  default: { kvPrecision: 'auto', ctxCompaction: 'auto', contextTokens: 12288 },
  q8: { kvPrecision: 'q8_0', ctxCompaction: 'auto', contextTokens: 12288 },
  tight: { kvPrecision: 'q4_0', ctxCompaction: 'aggressive', contextTokens: 12288 },
};

(async () => {
  const args = process.argv.slice(2);
  const model = args.find((a) => !a.startsWith('--')) || 'qwen3:8b';
  const only = ((args.find((a) => a.startsWith('--only=')) || '').replace('--only=', '').split(',').filter(Boolean));
  const names = ((args.find((a) => a.startsWith('--variants=')) || '').replace('--variants=', '').split(',').filter(Boolean));
  const run = names.length ? names : Object.keys(VARIANTS);
  const file = path.join(__dirname, '..', 'docs', 'benchmark-kv.json');
  const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  data.agent = data.agent || { rows: [] };
  for (const v of run) {
    console.log(`\n=== ${model} · ${v}: ${JSON.stringify(VARIANTS[v])}`);
    const rows = await runModel(model, only.length ? only : null, { settings: VARIANTS[v] });
    data.agent.rows = data.agent.rows.filter((r) => !(r.variant === v && r.model === model && rows.some((x) => x.task === r.task))).concat(rows.map((r) => ({ ...r, variant: v })));
  }
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  data.agent.measuredAt = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  data.agent.variants = VARIANTS;
  data.agent.tasks = TASKS.map((t) => t.label);
  fs.writeFileSync(file, JSON.stringify(data, null, 1));
  console.log('\n| 설정 | 통과 | 총 시간 | 입력 처리 시간 합계 | 최대 상주 메모리 |\n|---|---|---|---|---|');
  for (const v of run) {
    const r = data.agent.rows.filter((x) => x.variant === v && x.model === model);
    const calls = r.reduce((a, x) => a + x.kv.calls, 0) || 1;
    console.log(`| ${v} | ${r.filter((x) => x.ok).length}/${r.length} | ${r.reduce((a, x) => a + x.secs, 0)}s | ${Math.round(r.reduce((a, x) => a + (x.kv.prefillMs || 0), 0) / 100) / 10}s (${calls}회) | ${Math.max(...r.map((x) => x.kv.peakGB))}GB |`);
  }
  process.exit(0);
})();
