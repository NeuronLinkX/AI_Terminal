#!/usr/bin/env node
'use strict';
// Generates docs/kv-architecture.svg: the code-level architecture of the KV-economy work (modules, classes, functions, IPC,
// external servers). Names are the real ones from src/ — keep them in sync when code moves.   node scripts/gen-kv-architecture.js
//
// The generator also CHECKS the drawing geometry and exits non-zero when something is off:
//   - a text line wider than its box          - an arrow that passes through a box it neither starts nor ends in
//   - a label / number that overlaps a box, a band border, a band title or another label, or sits under an arrow
// (text widths are estimated: Hangul/CJK ≈ 1 em, other non-ASCII ≈ 0.6 em, ASCII ≈ 0.6 em monospace / 0.56 em proportional).
const fs = require('fs');
const path = require('path');

const W = 1500;
const FLOW = '흐름: ① 렌더러가 ai:submit 으로 요청 → main.js → ② Agent.handle 이 한 턴을 시작(Packer 생성) → ③ Packer.render 가 관찰 결과를 예산에 맞게 압축해 프롬프트를 완성 → ④ llm.complete 로 제공자에 전달 → (로컬 모델) ⑤ _rightSize 로 필요한 컨텍스트 결정 → ⑥ /api/show 로 모델 구조를 읽음(parseGeometry) → ⑦ plan() 이 KV 정밀도·컨텍스트를 결정 → ⑧ q8_0/q4_0 이면 engine.ensure 로 앱 전용 서버 시작 → ⑨ 결정된 서버로 /api/chat 요청 → ⑩ 응답의 usage 를 agent 가 이벤트로 올려 상단 칩에 표시.';
const C = { text: '#1f2430', dim: '#5b6475', line: '#5b6475', lab: '#2b3a67' };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/^ +/, (m) => ' '.repeat(m.length));
const out = [];
const add = (s) => out.push(s);
let H = 1290;
const model = { boxes: [], bands: [], arrows: [], labels: [], nums: [], lines: [] };

/** estimated rendered width of a string */
function tw(s, size, mono) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (c >= 0x1100 && (c <= 0x11ff || (c >= 0x2e80 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xffef))) w += size * 1.0;
    else if (c > 0x7f) w += size * (mono ? 0.62 : 0.6);
    else w += size * (mono ? 0.6 : 0.56);
  }
  return w;
}

/** A module box: bold file title, optional sub-title, monospace lines. */
function box(x, y, w, h, { title, sub, lines = [], fill = '#fff', stroke = '#cfd4dd', tc = C.text, mono = true, lh = 15 }) {
  const b = { x, y, w, h, name: title };
  model.boxes.push(b);
  add(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="7" fill="${fill}" stroke="${stroke}" stroke-width="1.3"/>`);
  add(`<text x="${x + 10}" y="${y + 18}" font-size="13" font-weight="700" fill="${tc}">${esc(title)}</text>`);
  model.lines.push({ box: b, text: title, w: tw(title, 13, false) * 1.06 });
  let ty = y + 18;
  if (sub) { ty += 15; add(`<text x="${x + 10}" y="${ty}" font-size="11" fill="${C.dim}">${esc(sub)}</text>`); model.lines.push({ box: b, text: sub, w: tw(sub, 11, false) }); }
  for (const l of lines) {
    ty += lh;
    add(`<text x="${x + 10}" y="${ty}" font-size="11" ${mono ? 'font-family="Menlo,Monaco,monospace"' : ''} fill="${C.text}">${esc(l)}</text>`);
    model.lines.push({ box: b, text: l, w: tw(l, 11, mono) });
  }
  if (ty + 8 > y + h) model.lines.push({ box: b, text: '(vertical overflow)', w: 0, vertical: true });
}
function band(x, y, w, h, label, fill, stroke) {
  const bd = { x, y, w, h, label, titleBox: { x: x + 10, y: y + 5, w: tw(label, 12.5, false) * 1.1 + 4, h: 17 } };
  model.bands.push(bd);
  add(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="1" ${/연구/.test(label) ? 'stroke-dasharray="6 4"' : ''}/>`);
  add(`<text x="${x + 12}" y="${y + 17}" font-size="12.5" font-weight="700" fill="${stroke}">${esc(label)}</text>`);
}
/** label placed at (lx, ly) = text baseline; anchor 'end' right-aligns it to lx */
function label(text, lx, ly, anchor = 'start') {
  const wd = tw(text, 10.5, false) * 1.08;
  model.labels.push({ x: anchor === 'end' ? lx - wd : lx, y: ly - 10, w: wd, h: 13, text });
  add(`<text x="${lx}" y="${ly}" font-size="10.5" text-anchor="${anchor}" fill="${C.lab}" font-weight="600">${esc(text)}</text>`);
}
function arrow(x1, y1, x2, y2, { dash } = {}) {
  model.arrows.push({ x1, y1, x2, y2 });
  add(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${C.line}" stroke-width="1.5" ${dash ? 'stroke-dasharray="5 4"' : ''} marker-end="url(#arr)"/>`);
}
const num = (x, y, n, { inside } = {}) => {
  model.nums.push({ x: x - 8, y: y - 8, w: 16, h: 16, n, cx: x, cy: y, inside });
  add(`<circle cx="${x}" cy="${y}" r="8" fill="${C.lab}"/><text x="${x}" y="${y + 3.8}" text-anchor="middle" font-size="10.5" font-weight="700" fill="#fff">${n}</text>`);
};

const flowLines = [];
const FLOW_TEXT = FLOW.replace(/([①-⑩]) /g, '$1\u00a0'); // keep each step number together with its phrase when wrapping
{ let line = ''; for (const word of FLOW_TEXT.split(' ')) { const t = line ? `${line} ${word}` : word; if (tw(t, 12.5, false) > 1330 && line) { flowLines.push(line); line = word; } else line = t; } if (line) flowLines.push(line); }
const SHIFT = 22 + flowLines.length * 19; // content (first band at y=66) moves down below the flow paragraph
H = 1290 + SHIFT;
add(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="-apple-system,'Apple SD Gothic Neo',Helvetica,Arial,sans-serif">`);
add(`<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="${C.line}"/></marker></defs>`);
add(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
add(`<text x="24" y="32" font-size="20" font-weight="700" fill="${C.text}">AI Terminal — 코드 레이어 아키텍처 (KV 캐시 절약 · 토큰 사용량 · 키)</text>`);
add(`<text x="24" y="53" font-size="12.5" fill="${C.dim}">박스 = 소스 파일(실제 이름), 모노스페이스 = 클래스·함수·데이터. 번호 ①~⑩ = AI 요청 한 번의 호출 순서. 점선 = 이벤트/표시 경로, 실선 = 호출·HTTP.</text>`);
flowLines.forEach((l, i) => add(`<text x="24" y="${76 + i * 19}" font-size="12.5" fill="${C.text}" >${esc(l)}</text>`));
add(`<g transform="translate(0,${SHIFT})">`);

// ------------------------------------------------------------------ A. renderer
band(20, 66, 1460, 128, 'A. Renderer (sandbox)', '#f6f8fc', '#4a6fa5');
box(40, 88, 430, 96, { lh: 13.5, title: 'src/renderer/core.js', sub: '탭·타임라인·승인·상단 바', lines: ["ait.onAiEvent: case 'kv-usage' → ui.kv = usage", "  case 'token-usage' / 'summary' → 토큰 줄", 'onStats(st): GPU·메모리·모델 칩 + KV 툴팁', 'onUsage(summary) → ui.usage.local → 칩 갱신'] });
box(486, 88, 440, 96, { lh: 13.5, title: 'src/renderer/panels.js', sub: '설정 · 기록 · 서랍', lines: ['renderSettings(): KV 정밀도·프롬프트 압축 seg', 'memEstimate(ctx, kvType) ← kv:info.f16PerToken', 'usageSection(): localTable() · officialTable()', 'keyNote: OPENAI_API_KEY / OPENAI_ADMIN_KEY 출처'] });
box(942, 88, 260, 96, { title: 'src/preload.js', sub: 'contextBridge → window.ait', lines: ['settingsSet · kvInfo · llmDetect', 'usageGet · usageOfficial · secretSet', 'onAiEvent · onUsage · onSysStats'] });
box(1218, 88, 242, 96, { title: 'src/renderer/i18n.js', sub: 'ko / en', lines: ['t(lang, key, vars)', 'translateMain(msg) — 메인 안내문', 'i18n-check.js 로 키 검증'] });

// ------------------------------------------------------------------ B. main
band(20, 214, 1460, 142, 'B. Main 프로세스', '#f7f7f9', '#6b7280');
box(40, 236, 470, 112, { title: 'src/main/main.js', sub: 'ipcMain · 탭별 세션', lines: ['ipc: ai:submit · settings:set · kv:info · usage:*', 'wireSession(tab): new Agent(…).attach({memoryProbe})', 'memoryProbe() → { availGB, loadedGB } (sysmon 캐시)', 'fixPath(): importShellEnv(PATH, OPENAI_*)'] });
box(526, 236, 300, 112, { title: 'src/main/settings.js', sub: 'SCHEMA(검증·영속화)', lines: ["kvPrecision  'auto'|'f16'|'q8_0'|'q4_0'", "ctxCompaction 'auto'|'aggressive'|'off'", 'contextTokens  4K…32K (상한)', 'keepAlive · autoContext · blockNetwork'] });
box(842, 236, 300, 112, { title: 'src/main/sysmon.js', sub: '2초 폴링', lines: ['modelStats(): /api/ps shared+extraBases', 'setExtraBases(() => [engine.base])', 'memStats(): vm_stat · gpuStats(): ioreg', '→ lastStats → memoryProbe'] });
box(1158, 236, 302, 112, { title: 'src/main/keys.js · usage.js', sub: '키 출처 · 토큰 계측', lines: ['resolveKey(name,{baseUrl}): env→Keychain', 'importShellEnv(names): 로그인 셸', 'UsageMeter.record/summary (jsonl)', 'fetchOfficial(): Usage·Costs API'] });

// ------------------------------------------------------------------ C. agent + ctxpack
band(20, 376, 1460, 226, 'C. 에이전트 + 컨텍스트', '#f3f0ff', '#5b46d6');
box(40, 398, 400, 192, { lh: 14.5, title: 'src/main/agent.js', sub: 'class Agent extends EventEmitter', fill: '#fff', stroke: '#c9c1f5', lines: ['handle(userText) → _loop()', '_loop: this.packer = new Packer({level})', '_decide(steps) → _buildPrompt(…):', '  obs = packer.render(steps, 관찰 예산)', '  관찰 예산 = ctx − est(SYSTEM) − est(고정부)', '              − 답변 1400 − 여유 300', '→ llm.complete({system,user,needTokens,memory})', '_ctxTokens(): lastPlan.ctx(로컬) | setting', "emit: 'kv-usage' · 'token-usage' · 'summary'"] });
box(572, 398, 580, 192, { title: 'src/main/kv/ctxpack.js', sub: '3층 프롬프트 압축 — DepthKV · PyramidKV · SnapKV · H2O', fill: '#fff', stroke: '#c9c1f5', lines: ['class Packer { setQuery(req); render(steps, budgetChars) }', '  caps: Map(stepIdx → cap)  ← 한 번 줄이면 그대로 유지', '  while total > budget (≤3회): 예산의 75% 까지 축소', 'sensitivity(steps,i,newest) = (1+age)^-0.8 × 종류 × 상태', '  실패 ×1.8 · 수정된 파일의 read ×0.15 · 대체된 재실행 ×0.3', 'allocate(items{len,w,protect}, total) 상한 + 남는 몫 재분배', 'selectLines(text,budget,terms) ← scoreLines(): 오류+3', '  파일:줄+1.5 요약+1.2 질의어+1.2 앞·뒤 줄, ±1줄 풀링', 'queryTerms() · renderObs() · estimateTokens()'] });
box(1168, 398, 292, 192, { title: '호출 순서 (코드와 대조 검증)', fill: '#fffdf2', stroke: '#e6d58a', mono: false, lh: 14.5, lines: ['① core.js → main.js  ai:submit', '② Agent.handle → _loop: Packer 생성', '③ _buildPrompt → Packer.render → 압축본', '④ llm.complete({needTokens, memory})', '⑤ _kvPlan: _rightSize → 컨텍스트(≥8K)', '⑥ _geometry: /api/show → parseGeometry', '⑦ plan() → {kvType, ctx} (kvGB 계산)', '⑧ q8_0/q4_0 이면 engine.ensure → base', '⑨ POST {base}/api/chat {num_ctx}', '⑩ _recordUsage → usage → kv-usage → 칩'] });

// ------------------------------------------------------------------ D. providers + KV control
band(20, 622, 1460, 282, 'D. LLM 제공자 + KV 제어', '#eefaf3', '#198754');
box(40, 644, 300, 118, { title: 'src/main/llm/manager.js', sub: 'class LlmManager', fill: '#fff', stroke: '#b5dfc8', lines: ['providers = [Ollama, OpenAI, Codex]', 'complete(req) → {text, provider, usage}', 'unload() · detect() · status', 'engine = new KvEngine({dataDir})'] });
box(360, 644, 540, 156, { lh: 14, title: 'src/main/llm/ollama.js', sub: 'class OllamaProvider — 2층 길이 맞춤 · 1층 호출', fill: '#fff', stroke: '#b5dfc8', lines: ['complete({system,user,onToken,memory,needTokens})', '_rightSize(maxCtx, needTokens)  ctxHigh = 최대 사용치', '_geometry(model) ← POST /api/show (캐시)', '_kvPlan(memory,onNote,need): plan() → ensure()', '  p.engine = managed|shared · 노트는 변경 시 1회', 'complete → fetch {base}/api/chat {num_ctx}', '_recordUsage(): prompt_eval_count(전체)·_duration', 'unload(): shared + managed 양쪽 · kvInfo() · warm()'] });
box(920, 644, 250, 86, { lh: 14, title: 'src/main/kv/model.js', sub: '1층 · 정확한 KV 메모리 모델', fill: '#fff', stroke: '#b5dfc8', lines: ['parseGeometry(model_info)', 'kvBytes/kvGB(geo, ctx, type)', 'q8_0=34/32 · q4_0=18/32 B/원소'] });
box(1190, 644, 270, 150, { title: 'src/main/kv/planner.js', sub: '1층 정밀도 — plan() 비용 모델', fill: '#fff', stroke: '#b5dfc8', lines: ['plan({geo, weightsGB, wantCtx,', '      precision, memory, current})', 'cost = TYPE_COST[t] + 1.5·log2(want/c)', '       (+3·log2(8K/c) if c<8K) − 0.5', 'fits: w + KV + 0.3 ≤ avail+loaded−1.5', '→ {ctx, kvType, kvGB, lowered, nofit}'] });
box(40, 782, 300, 112, { title: 'src/main/llm/openai.js', sub: 'class OpenAIProvider', fill: '#fff', stroke: '#b5dfc8', lines: ['complete(): stream_options.include_usage', '  400/422 → stream_options 없이 재시도', '_record(usage) → UsageMeter.record', 'key = resolveKey("openai",{baseUrl})'] });
box(920, 808, 540, 86, { title: 'src/main/kv/engine.js', sub: '1층 정밀도 — class KvEngine · 앱 전용 Ollama 서버', fill: '#fff', stroke: '#b5dfc8', lines: ['ensure(type) → _start(): spawn("ollama", ["serve"], env)', 'env: OLLAMA_KV_CACHE_TYPE=type · FLASH_ATTENTION=1 · NUM_PARALLEL=1', 'kv-engine.json(pid) · _reapStale() · stop()/dispose()'] });

// ------------------------------------------------------------------ E. external
band(20, 924, 1460, 224, 'E. 외부 서버 · 엔진', '#f4f5f7', '#6b7280');
box(40, 948, 300, 62, { title: 'api.openai.com', fill: '#fff', stroke: '#cfd4dd', mono: false, lines: ['/v1/chat/completions (+usage)', '/v1/organization/usage · costs'] });
box(360, 948, 330, 62, { title: 'Ollama — 사용자의 서버 127.0.0.1:11434', fill: '#fff', stroke: '#cfd4dd', mono: false, lines: ['KV f16 (기본) · /api/tags /show /ps /chat /pull'] });
box(710, 948, 330, 62, { title: '앱 전용 ollama serve 127.0.0.1:11435+', fill: '#fff', stroke: '#198754', mono: false, lines: ['q8_0 / q4_0 + flash attention · 모델 저장소 공유'] });
box(360, 1050, 1100, 84, { title: 'llama.cpp llama-server (Ollama 0.34 의 러너) → Metal GPU', sub: '실행 인자(실제 로그): --cache-type-k/-v <type> --flash-attn on -c <num_ctx> -np 1 --context-shift --keep 4', fill: '#fff', stroke: '#cfd4dd', mono: false, lines: ['KV 캐시 = 토큰 셀을 모든 층이 공유: 36층 × 8 KV헤드 × (K 128 + V 128) × num_ctx × 원소바이트(f16 2 · q8_0 1.0625 · q4_0 0.5625)', '앞부분이 같은 프롬프트는 캐시된 KV 를 재사용(prompt_eval_duration 0.2s vs 9.3s) · prompt_eval_count 는 전체 토큰'] });

// ------------------------------------------------------------------ F. research
band(20, 1168, 1460, 106, 'F. 연구·측정 (앱과 별도 도구)', '#fff8e8', '#b26b00');
box(40, 1190, 470, 74, { title: 'native/kvprof.cpp · kvpolicy.hpp (C++)', fill: '#fff', stroke: '#f0d9a8', lines: ['libllama cb_eval: kq_soft_max-<il> → 층·KV헤드 어텐션', 'uniform · pyramid · cake · depthkv · marginal · adakv'] });
box(526, 1190, 470, 74, { title: 'scripts/bench-kv.js · bench-kv-agent.js · kv-profile.js', fill: '#fff', stroke: '#f0d9a8', lines: ['mem(사설 Ollama ×KV) · ppl(llama-perplexity) · speed', '에이전트 5과제 × 변형(baseline/default/q8/tight)'] });
box(1012, 1190, 448, 74, { title: 'docs/benchmark-kv*.json → bench-report.js', fill: '#fff', stroke: '#f0d9a8', lines: ['표 자동 생성 → README.md · docs/KV_CACHE.md', 'test/*.test.js · e2e-features.js · visual.js'] });

// ------------------------------------------------------------------ arrows and labels. Gap centres between bands: A/B 204 · B/C 366 · C/D 612 · D/E 914
arrow(250, 184, 250, 236); num(250, 204, 1); label('ai:submit', 264, 208);
arrow(250, 348, 250, 398); num(250, 366, 2); label('handle()', 264, 370);
arrow(440, 486, 572, 486); num(506, 486, 3); label('render(steps, 예산)', 452, 470);
arrow(572, 508, 440, 508); label('압축된 관찰 텍스트', 454, 526);
arrow(250, 590, 250, 644); num(250, 612, 4); label('complete({needTokens, memory ← memoryProbe()})', 264, 616);
arrow(340, 700, 360, 700); num(350, 686, 5);
arrow(900, 668, 920, 668); num(910, 654, 6);
arrow(900, 744, 1190, 744); num(940, 744, 7); label('plan(...) → {kvType, ctx}', 960, 764);
arrow(900, 786, 920, 828); num(908, 803, 8); label('ensure(kvType)', 872, 822, 'end');
arrow(560, 800, 560, 948); num(560, 826, 9); label('f16 → 사용자의 서버', 574, 850);
arrow(880, 800, 880, 948); num(880, 856, 9); label('q8_0/q4_0 → ⑧ 의 base', 866, 884, 'end');
arrow(1000, 894, 1000, 948); label('spawn', 1008, 918);
arrow(190, 894, 190, 948); label('POST /chat/completions', 198, 918);
arrow(525, 1010, 525, 1050); arrow(875, 1010, 875, 1050);
// events back to the UI (dashed): agent.emit('event') → main.js → ai:event → core.js   (⑩)
arrow(370, 398, 370, 348, { dash: true }); label("agent.emit('event')", 384, 370);
arrow(370, 236, 370, 184, { dash: true }); num(370, 204, 10); label('ai:event', 384, 208);
arrow(480, 236, 480, 184, { dash: true }); label('sys:stats · settings:changed', 494, 208);
arrow(1010, 236, 1010, 184, { dash: true }); label('usage:update', 1024, 208);
add(`</g>`);
add(`</svg>`);

// ------------------------------------------------------------------ geometry checks
const warn = [];
const inter = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const segHitsRect = (s, r, pad = 1.5) => {
  // Liang–Barsky clip against the rect shrunk by `pad`
  const x0 = r.x + pad; const y0 = r.y + pad; const x1 = r.x + r.w - pad; const y1 = r.y + r.h - pad;
  let t0 = 0; let t1 = 1;
  const dx = s.x2 - s.x1; const dy = s.y2 - s.y1;
  for (const [p, q] of [[-dx, s.x1 - x0], [dx, x1 - s.x1], [-dy, s.y1 - y0], [dy, y1 - s.y1]]) {
    if (p === 0) { if (q < 0) return false; } else {
      const t = q / p;
      if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
    }
  }
  return t1 - t0 > 1e-6;
};
for (const l of model.lines) {
  if (l.vertical) warn.push(`vertical overflow in box "${l.box.name}"`);
  else if (l.w > l.box.w - 14) warn.push(`text too wide for "${l.box.name}" (${Math.round(l.w)} > ${l.box.w - 14}): ${l.text.slice(0, 60)}`);
}
for (const a of model.arrows) {
  for (const b of model.boxes) if (segHitsRect(a, b)) warn.push(`arrow (${a.x1},${a.y1})→(${a.x2},${a.y2}) passes through box "${b.name}"`);
  for (const bd of model.bands) if (segHitsRect(a, bd.titleBox, 0)) warn.push(`arrow (${a.x1},${a.y1})→(${a.x2},${a.y2}) crosses the title of band "${bd.label}"`);
}
const borders = [];
for (const bd of model.bands) borders.push({ x: bd.x - 1.5, y: bd.y - 1.5, w: bd.w + 3, h: 3 }, { x: bd.x - 1.5, y: bd.y + bd.h - 1.5, w: bd.w + 3, h: 3 }, { x: bd.x - 1.5, y: bd.y, w: 3, h: bd.h }, { x: bd.x + bd.w - 1.5, y: bd.y, w: 3, h: bd.h });
const items = [...model.labels.map((l) => ({ ...l, kind: 'label' })), ...model.nums.map((n) => ({ ...n, kind: `number ${n.n}`, text: '' }))];
for (const it of items) {
  if (!it.inside) for (const b of model.boxes) if (inter(it, b)) warn.push(`${it.kind} "${it.text}" overlaps box "${b.name}"`);
  for (const r of borders) if (inter(it, r)) warn.push(`${it.kind} "${it.text}" overlaps a band border`);
  for (const bd of model.bands) if (inter(it, bd.titleBox)) warn.push(`${it.kind} "${it.text}" overlaps the band title "${bd.label}"`);
}
for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) if (inter(items[i], items[j])) warn.push(`${items[i].kind} "${items[i].text}" overlaps ${items[j].kind} "${items[j].text}"`);
for (const it of model.labels) for (const a of model.arrows) if (segHitsRect(a, it, 0)) warn.push(`label "${it.text}" is crossed by arrow (${a.x1},${a.y1})→(${a.x2},${a.y2})`);
// a number must sit centred ON its own arrow; any other arrow crossing it is a problem
const distToSeg = (px, py, a) => {
  const dx = a.x2 - a.x1; const dy = a.y2 - a.y1; const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - a.x1) * dx + (py - a.y1) * dy) / l2)) : 0;
  return Math.hypot(px - (a.x1 + t * dx), py - (a.y1 + t * dy));
};
for (const n of model.nums) for (const a of model.arrows) {
  if (segHitsRect(a, n, 0) && distToSeg(n.cx, n.cy, a) > 1.5) warn.push(`number ${n.n} is crossed off-centre by arrow (${a.x1},${a.y1})→(${a.x2},${a.y2})`);
}

fs.writeFileSync(path.join(__dirname, '..', 'docs', 'kv-architecture.svg'), out.filter(Boolean).join('\n') + '\n');
console.log(`docs/kv-architecture.svg written · ${model.boxes.length} boxes, ${model.arrows.length} arrows, ${model.labels.length} labels, ${model.nums.length} numbers`);
if (warn.length) { console.error(`\n${warn.length} layout problem(s):`); for (const w of warn) console.error('  - ' + w); process.exit(1); }
console.log('layout check: no overflow, no arrow through a box, no overlapping label or number');
