#!/usr/bin/env node
'use strict';
// Generates docs/kv-algorithms.svg: one card per algorithm — name, one-line description, source papers, and its measured
// benchmark (read from docs/benchmark-kv.json and docs/benchmark-kv-layers.json; "—" while a number has not been measured).
//   node scripts/gen-kv-algorithms.js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(root, 'docs', f), 'utf8')); } catch { return null; } };
const kv = read('benchmark-kv.json') || {};
const layers = read('benchmark-kv-layers.json');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const W = 1100;
const CARD_H = 158;
const GAP = 16;
const TOP = 78;
const out = [];
const add = (s) => out.push(s);
const warn = [];
const tw = (s, size) => { let w = 0; for (const ch of String(s)) { const c = ch.codePointAt(0); w += c >= 0x1100 && (c <= 0x11ff || (c >= 0x2e80 && c <= 0xd7a3)) ? size : size * 0.56; } return w; };
const text = (x, y, s, { size = 12.5, weight = 400, fill = '#1f2430', mono = false, anchor = 'start', maxW } = {}) => {
  if (maxW && tw(s, size) > maxW) warn.push(`text too wide (${Math.round(tw(s, size))} > ${maxW}): ${s}`);
  add(`<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${mono ? ' font-family="Menlo,Monaco,monospace"' : ''}>${esc(s)}</text>`);
};

const f1 = (x) => (x == null ? '—' : (Math.round(x * 10) / 10).toString());
const gb2 = (x) => (x == null ? '—' : `${x.toFixed(2)}GB`);
const pct = (x) => `${(x * 100).toFixed(1)}%`;

// ------------------------------------------------------------------ data
const mem = (kv.memory || []).filter((r) => r.model === 'qwen3:8b' && r.ctx === 32768);
const memOf = (type, eng) => (mem.find((r) => r.kvType === type && (eng ? r.engine === eng : r.engine === 'managed')) || {}).residentGB;
const ppl = (kv.perplexity && kv.perplexity.rows) || [];
const pplOf = (t, ctx) => (ppl.find((r) => r.k === t && r.v === t && r.ctx === ctx) || {}).ppl;
const speed = kv.speed || [];
const speedOf = (t) => (speed.find((r) => r.k === t && r.v === t) || {}).pp2048;
const agent = (kv.agent && kv.agent.rows) || [];
const variant = (v) => {
  const r = agent.filter((x) => x.variant === v);
  if (!r.length) return null;
  const calls = r.reduce((a, x) => a + x.kv.calls, 0);
  return { pass: r.filter((x) => x.ok).length, n: r.length, ms: r.reduce((a, x) => a + (x.kv.prefillMs || 0), 0), calls, peak: Math.max(...r.map((x) => x.kv.peakGB)), raw: r.filter((x) => x.kv.packRaw > 0), secs: r.reduce((a, x) => a + x.secs, 0) };
};
const reuse = kv.reuse || null;

// ------------------------------------------------------------------ cards
/** horizontal bars: rows = [{ label, value, text, color }], scaled to the largest value */
function bars(x, y, rows, { w = 250, rowH = 21, labelW = 196 } = {}) {
  const mx = Math.max(...rows.map((r) => r.value || 0), 1e-9);
  rows.forEach((r, i) => {
    const yy = y + i * rowH;
    text(x, yy + 11, r.label, { size: 11.5, fill: '#1f2430', maxW: labelW - 6 });
    if (r.value == null) { text(x + labelW, yy + 11, '— (측정 중)', { size: 11.5, fill: '#8a92a2' }); return; }
    const bw = Math.max(2, (r.value / mx) * w);
    add(`<rect x="${x + labelW}" y="${yy + 1}" width="${bw.toFixed(1)}" height="12" rx="3" fill="${r.color || '#5b46d6'}"/>`);
    text(x + labelW + bw + 6, yy + 11, r.text, { size: 11.5, fill: '#1f2430', weight: r.bold ? 700 : 400 });
  });
}
function card(i, { title, tag, desc, papers, code, bench, draw }) {
  const y = TOP + i * (CARD_H + GAP);
  add(`<rect x="30" y="${y}" width="${W - 60}" height="${CARD_H}" rx="10" fill="#ffffff" stroke="#cfd4dd"/>`);
  add(`<rect x="30" y="${y}" width="6" height="${CARD_H}" rx="3" fill="${tag}"/>`);
  text(52, y + 26, title, { size: 15, weight: 700, fill: '#1f2430', maxW: 400 });
  desc.forEach((d, k) => text(52, y + 50 + k * 18, d, { size: 12.5, maxW: 420 }));
  text(52, y + 50 + desc.length * 18 + 8, `근거: ${papers}`, { size: 11.5, fill: '#5b6475', maxW: 420 });
  text(52, y + CARD_H - 14, code, { size: 11, mono: true, fill: '#5b6475', maxW: 420 });
  add(`<line x1="490" y1="${y + 14}" x2="490" y2="${y + CARD_H - 14}" stroke="#e1e4ea"/>`);
  text(510, y + 26, `벤치마킹 — ${bench}`, { size: 12, weight: 700, fill: '#136b43', maxW: 540 });
  draw(510, y + 40);
}

add(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${TOP + 5 * (CARD_H + GAP)}" font-family="-apple-system,'Apple SD Gothic Neo',Helvetica,Arial,sans-serif">`);
add(`<rect width="${W}" height="${TOP + 5 * (CARD_H + GAP)}" fill="#ffffff"/>`);
text(30, 34, '개선한 알고리즘', { size: 20, weight: 700 });
text(30, 56, 'Apple M4 · 16GB · qwen3:8b (Q4_K_M) · Ollama 0.34 / llama.cpp — 실측값은 docs/benchmark-kv*.json', { size: 12.5, fill: '#5b6475' });

// 1. KV precision planner
card(0, {
  title: '1. KV 정밀도 플래너', tag: '#198754',
  desc: ['메모리 여유와 모델 구조를 보고', 'KV 캐시 정밀도(f16 · q8_0 · q4_0)와 컨텍스트를 고릅니다.'],
  papers: 'KIVI (KV 양자화)', code: 'src/main/kv/planner.js · engine.js',
  bench: 'KV 캐시 메모리 · 품질 (qwen3:8b, 32K 컨텍스트)',
  draw: (x, y) => {
    bars(x, y, [
      { label: '이전 (기본 Ollama, f16)', value: memOf('f16', 'shared (before)'), text: gb2(memOf('f16', 'shared (before)')), color: '#8a92a2' },
      { label: 'q8_0', value: memOf('q8_0'), text: `${gb2(memOf('q8_0'))} · perplexity ${pplOf('q8_0', 2048) ? pplOf('q8_0', 2048).toFixed(3) : '—'}`, color: '#198754', bold: true },
      { label: 'q4_0', value: memOf('q4_0'), text: `${gb2(memOf('q4_0'))} · perplexity ${pplOf('q4_0', 2048) ? pplOf('q4_0', 2048).toFixed(3) : '—'}`, color: '#1e6fd0' },
    ], { w: 150 });
    text(x, y + 76, `perplexity 는 낮을수록 좋음 (f16 ${pplOf('f16', 2048) ? pplOf('f16', 2048).toFixed(3) : '—'}) · 입력 처리 pp2048: f16 ${f1(speedOf('f16'))} → q8_0 ${f1(speedOf('q8_0'))} tok/s`, { size: 11, fill: '#5b6475', maxW: 540 });
  },
});

// 2. sensitivity-based budget allocation
const base = variant('baseline');
const def = variant('default');
const q8 = variant('q8');
const agentRows = (v, label) => ({ label, value: v ? v.ms / 1000 : null, text: v ? `입력 처리 ${(v.ms / 1000).toFixed(1)}s · 통과 ${v.pass}/${v.n} · 최대 ${v.peak}GB` : '', color: label.startsWith('이전') ? '#8a92a2' : '#5b46d6' });
card(1, {
  title: '2. 민감도 기반 프롬프트 예산 배분', tag: '#5b46d6',
  desc: ['한정된 프롬프트 예산을 최근·실패·낡은 내용의', '민감도로 나눠 덜 중요한 오래된 출력부터 줄입니다.'],
  papers: 'DepthKV · PyramidKV', code: 'src/main/kv/ctxpack.js  allocate() · sensitivity()',
  bench: '에이전트 5과제 (실제 에이전트 + 셸 + 모델)',
  draw: (x, y) => bars(x, y, [agentRows(base, '이전 (f16 · 압축 끔)'), agentRows(def, '새 기본값 (자동)'), agentRows(q8, 'q8_0 고정 + 압축')], { w: 110 }),
});

// 3. line selection
const packRatio = (v) => {
  if (!v || !v.raw.length) return null;
  const raw = v.raw.reduce((a, x) => a + x.kv.packRaw, 0);
  const kept = v.raw.reduce((a, x) => a + x.kv.packKept, 0);
  return raw ? { raw, kept } : null;
};
const pr = packRatio(def) || packRatio(q8);
card(2, {
  title: '3. 줄 선택 (selectLines)', tag: '#b26b00',
  desc: ['오류 · 파일:줄 · 요약 · 질문과 관련된 줄을 남기고', '나머지는 "…(N줄 생략)…" 으로 줄입니다. 추가 모델 호출 없음.'],
  papers: 'SnapKV · H2O · StreamingLLM · Complexity Trap', code: 'src/main/kv/ctxpack.js  selectLines() · scoreLines()',
  bench: '관찰 결과(명령 출력·파일) 크기',
  draw: (x, y) => bars(x, y, [
    { label: '원문', value: pr ? pr.raw : null, text: pr ? `${pr.raw.toLocaleString('en-US')}자` : '', color: '#8a92a2' },
    { label: '모델에 전달', value: pr ? pr.kept : null, text: pr ? `${pr.kept.toLocaleString('en-US')}자 (−${Math.round((1 - pr.kept / pr.raw) * 100)}%)` : '', color: '#b26b00', bold: true },
  ], { w: 200 }),
});

// 4. prefix-preserving compaction
card(3, {
  title: '4. 앞부분 유지 압축', tag: '#1e6fd0',
  desc: ['예산을 넘을 때만 한 번 줄이고, 줄인 내용은 다시 늘리지 않습니다.', '그 외에는 새 내용만 덧붙여서 KV 캐시를 재사용합니다.'],
  papers: '(구현 설계 — Ollama 의 프롬프트 캐시 활용)', code: 'src/main/kv/ctxpack.js  Packer.render()',
  bench: reuse ? `입력 처리 시간 (같은 크기 ${reuse.tokens.toLocaleString('en-US')}토큰 프롬프트)` : '입력 처리 시간 (같은 크기 프롬프트)',
  draw: (x, y) => bars(x, y, [
    { label: '첫 호출 (모델 로드 포함)', value: reuse ? reuse.coldMs / 1000 : null, text: reuse ? `${(reuse.coldMs / 1000).toFixed(1)}초` : '', color: '#8a92a2' },
    { label: '앞부분이 다름 (캐시 못 씀)', value: reuse ? reuse.missMs / 1000 : null, text: reuse ? `${(reuse.missMs / 1000).toFixed(1)}초` : '', color: '#b26b00' },
    { label: '앞부분이 같음 (캐시 재사용)', value: reuse ? reuse.reuseMs / 1000 : null, text: reuse ? `${(reuse.reuseMs / 1000).toFixed(2)}초` : '', color: '#198754', bold: true },
  ], { w: 140 }),
});

// 5. layer-wise policies (measurement only)
const ev = layers && layers.eval && layers.eval['0.1'];
const lossRow = (key, label, color, bold) => ({ label, value: ev && ev[key] ? ev[key].meanLoss : null, text: ev && ev[key] ? pct(ev[key].meanLoss) : '', color, bold });
card(4, {
  title: '5. 층별 KV 예산 정책 비교 (측정 전용)', tag: '#8a5200',
  desc: ['같은 총 KV 예산을 층마다 다르게 나누는 정책들을', '실제 모델의 층별 어텐션으로 비교합니다. 앱에는 적용하지 않음.'],
  papers: 'DepthKV · PyramidKV · CAKE · Ada-KV', code: 'native/kvprof.cpp · kvpolicy.hpp',
  bench: '평균 10% 만 남길 때 잃는 어텐션 (낮을수록 좋음)',
  draw: (x, y) => bars(x, y, [
    lossRow('uniform', '균등', '#8a92a2'),
    lossRow('pyramid', 'PyramidKV 방식', '#1e6fd0'),
    lossRow('cake', 'CAKE 방식', '#b26b00'),
    lossRow('depthkv-proportional', 'DepthKV 방식', '#198754', true),
    lossRow('marginal+adakv', '한계이득 + Ada-KV 헤드', '#c8323f'),
  ], { w: 150, rowH: 20 }),
});

add('</svg>');
fs.writeFileSync(path.join(root, 'docs', 'kv-algorithms.svg'), out.join('\n') + '\n');
console.log('docs/kv-algorithms.svg written');
if (warn.length) { console.error(`${warn.length} text overflow(s):`); warn.forEach((w) => console.error('  - ' + w)); process.exit(1); }
