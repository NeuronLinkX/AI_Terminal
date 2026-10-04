'use strict';
// Depth-aware context packing — the part of "KV cache pruning" that an application can really do.
//
// Every token in the prompt costs KV memory in EVERY layer of the model, so shrinking the prompt prunes the KV cache
// uniformly. The literature this module borrows from (docs/KV_CACHE.md):
//   DepthKV (2026)   one global budget, split across layers by sensitivity instead of uniformly; a capped proportional
//                    allocation with iterative redistribution; the most sensitive parts are protected.
//                    → here the "layers" are the agent's observations: budget by sensitivity (recency, kind, status).
//   PyramidKV/CAKE   budgets fall with depth / follow attention dispersion → weights decay with the observation's age.
//   SnapKV           the end of the prompt (an "observation window") tells which earlier tokens matter, and neighbours
//                    of selected tokens are kept (pooling) → line scores use the request + latest error as the query
//                    and a ±1-line smoothing.
//   H2O/StreamingLLM heavy hitters + attention sinks → lines recurring in later observations (paths, identifiers) and
//                    the first/last lines (headers, summaries) are favoured.
//   "Complexity Trap" (NeurIPS'25 DL4C) simply masking old observations matches LLM summarisation at half the cost →
//                    no extra model call: pure text selection.
//
// KV-reuse friendly: compaction is LAZY and MONOTONE. Observations stay verbatim (append-only prompt → Ollama reuses the
// cached prefix) until the prompt would exceed its budget; then the allocator demotes the least sensitive ones, once,
// down to a low-water mark so the following steps stay append-only again. A demoted observation never grows back.

const { truncateMiddle } = require('../text');

const FLOOR_CHARS = 160; // smallest body we keep for an observation (header + a few lines)
const LINE_MAX = 240;
const LOW_WATER = 0.75; // after a demotion round the observations use this share of their budget
const CAPS = { run: 3000, read: 6000, search: 3000 }; // verbatim caps per observation (chars)
const CAPS_AGGRESSIVE = { run: 1800, read: 3500, search: 1800 };
const LEGACY_FULL = 3; // 'off': last N observations verbatim, older ones cut to 250/300 chars (previous behaviour)

/** Token estimate calibrated on qwen3's tokenizer (llama-tokenize): hangul ≈ 0.85 token/char, other text ≈ 3.1 chars/token. */
function estimateTokens(text) {
  const s = String(text || '');
  let hangul = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 0xac00 && c <= 0xd7a3) || (c >= 0x3130 && c <= 0x318f) || (c >= 0x4e00 && c <= 0x9fff)) hangul++;
  }
  return Math.ceil(hangul * 0.85 + (s.length - hangul) / 3.1);
}

// ------------------------------------------------------------------ line scoring / selection (SnapKV + H2O + StreamingLLM)
const ERR = /(error|err!|fail(ed|ure)?|exception|traceback|panic|fatal|cannot|can't|not found|no such|denied|refused|timed? ?out|undefined|unexpected|assert|✗|✘|실패|오류|에러|찾을 수 없|거부)/i;
const WARN = /(warn|deprecat|경고)/i;
const LOC = /[\w./~-]+\.\w{1,6}:\d+/;
const SUMMARY = /(\d+\s+(passed|failed|errors?|warnings?|tests?)|\btests?:|\btotal\b|summary|합계|통과|completed|\bdone\b|\bok\b)/i;
const DECOR = /^[\s\-=_*#~.|+]*$/;
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'file', 'files', 'please', 'run', 'show', 'make', 'what', 'how', '해줘', '알려줘', '보여줘', '확인', '파일', '현재', '이거', '이것']);

/** Query terms = the "observation window": words of the user request plus identifiers from the latest failing output. */
function queryTerms(...texts) {
  const out = new Set();
  for (const t of texts) {
    for (const m of String(t || '').matchAll(/[A-Za-z_][A-Za-z0-9_./-]{2,}|[가-힣]{2,}|\d{3,}/g)) {
      const w = m[0].toLowerCase();
      if (!STOP.has(w)) out.add(w);
      if (out.size >= 40) return [...out];
    }
  }
  return [...out];
}

function scoreLines(lines, terms) {
  const seen = new Map();
  const base = lines.map((raw, i) => {
    const line = raw.trim();
    let s = 0.3;
    if (!line || DECOR.test(line)) return -3;
    if (ERR.test(line)) s += 3;
    else if (WARN.test(line)) s += 1;
    if (LOC.test(line)) s += 1.5;
    if (SUMMARY.test(line)) s += 1.2;
    if (/^(#|==|--|\S.*:$)/.test(line)) s += 0.5;
    if (terms.length) {
      const low = line.toLowerCase();
      let hits = 0;
      for (const t of terms) if (low.includes(t) && ++hits >= 3) break;
      s += 1.2 * hits;
    }
    if (i < 3) s += 1.5; // attention-sink analogue: headers / the command banner
    if (i >= lines.length - 3) s += 1.2; // trailing summary lines
    const exact = line;
    const fuzzy = line.replace(/\d+/g, '#');
    if (seen.has(exact)) s -= 3;
    else if (seen.has(fuzzy)) s -= 1.5;
    seen.set(exact, true);
    seen.set(fuzzy, true);
    return s;
  });
  // SnapKV pooling: neighbours of strong lines keep a share of the score so context around a hit is not cut away
  return base.map((s, i) => Math.max(s, 0.45 * Math.max(base[i - 1] ?? -9, base[i + 1] ?? -9)));
}

const clip = (l) => (l.length > LINE_MAX ? `${l.slice(0, LINE_MAX - 40)} … ${l.slice(-30)}` : l);

/** Keep the most valuable lines of `text` within `budget` chars, in original order, with "…(N줄 생략)" markers. */
function selectLines(text, budget, terms = []) {
  if (text.length <= budget) return text;
  const lines = text.split('\n').map(clip);
  const score = scoreLines(lines, terms);
  const order = lines.map((_, i) => i).sort((a, b) => score[b] / (lines[b].length + 8) - score[a] / (lines[a].length + 8) || a - b);
  const keep = new Set();
  let used = 0;
  for (const i of order) {
    const cost = lines[i].length + 1;
    if (used + cost > budget * 0.92) continue;
    keep.add(i);
    used += cost;
  }
  const render = () => {
    const out = [];
    let gap = 0;
    lines.forEach((l, i) => {
      if (keep.has(i)) {
        if (gap) out.push(`…(${gap}줄 생략)…`);
        gap = 0;
        out.push(l);
      } else gap++;
    });
    if (gap) out.push(`…(${gap}줄 생략)…`);
    return out.join('\n');
  };
  let res = render();
  // markers cost chars too: drop the weakest kept lines until the total fits
  const kept = () => [...keep].sort((a, b) => score[a] / (lines[a].length + 8) - score[b] / (lines[b].length + 8));
  while (res.length > budget && keep.size > 1) {
    keep.delete(kept()[0]);
    res = render();
  }
  return res.length > budget ? res.slice(0, Math.max(0, budget - 12)) + '…(생략)' : res;
}

// ------------------------------------------------------------------ DepthKV-style budget allocation
/**
 * Split `total` chars over items by sensitivity weight, capped at each item's own length (no point reserving more than
 * the content needs) and floored at `min`; the surplus of saturated items is redistributed iteratively among the rest —
 * the same procedure DepthKV uses to respect its per-layer maximum while keeping the global budget fixed.
 * items: [{ len, w, protect }] — a protected item keeps min(len, protect) chars before the rest is shared.
 */
function allocate(items, total, min = FLOOR_CHARS) {
  const out = items.map((it) => (it.protect ? Math.min(it.len, it.protect) : 0));
  let remaining = total - out.reduce((a, b) => a + b, 0);
  let open = items.map((_, i) => i).filter((i) => !items[i].protect);
  for (let guard = 0; guard <= items.length && open.length; guard++) {
    const wsum = open.reduce((a, i) => a + items[i].w, 0) || 1;
    const sat = open.filter((i) => (Math.max(remaining, 0) * items[i].w) / wsum >= items[i].len);
    if (!sat.length) break;
    for (const i of sat) {
      out[i] = items[i].len; // fully satisfied: nothing to prune here, its leftover share flows to the others
      remaining -= items[i].len;
    }
    open = open.filter((i) => !sat.includes(i));
  }
  const wsum = open.reduce((a, i) => a + items[i].w, 0) || 1;
  for (const i of open) out[i] = Math.min(items[i].len, Math.max(min, Math.floor((Math.max(remaining, 0) * items[i].w) / wsum)));
  return out;
}

// ------------------------------------------------------------------ observations
const wrap = (tag, body) => `<untrusted_${tag}>\n${body}\n</untrusted_${tag}>`;
const bodyOf = (s) => (s.kind === 'run' && !s.error ? s.output || '' : s.kind === 'read' && !s.error ? s.content || '' : s.kind === 'search' && !s.error ? s.content || '' : '');

/** One observation as prompt text. `body` is the (already fitted) output/content. */
function renderObs(s, n, body, tag = '') {
  if (s.kind === 'run') {
    if (s.error) return `${n}. run \`${s.command}\` → 실행되지 않음: ${s.error}`;
    const head = `${n}. run \`${s.command}\` → ${s.status === 'done' ? `종료코드 ${s.exitCode}` : s.status === 'running' ? '아직 실행 중(출력이 멈춤/대기). 백그라운드가 아니라면 wait 하거나 종료 여부를 판단하세요' : s.status === 'aborted' ? '사용자가 중단함' : s.status}${tag}`;
    if (!s.output) return `${head}\n(출력 없음)`;
    return `${head}\n${wrap('output', body)}`;
  }
  if (s.kind === 'read') {
    if (s.error) return `${n}. read_file ${s.path} → 실패: ${s.error}`;
    return `${n}. read_file ${s.path}${tag} →\n${wrap('file', body)}`;
  }
  if (s.kind === 'search') {
    if (s.error) return `${n}. search "${s.pattern}" → 실패: ${s.error}`;
    return `${n}. search "${s.pattern}" → ${s.count}건\n${wrap('output', body)}`;
  }
  if (s.kind === 'write') return `${n}. write_file ${s.path} → ${s.error ? '실패: ' + s.error : s.summary}`;
  if (s.kind === 'edit') return `${n}. edit_file ${s.path} → ${s.error ? '실패: ' + s.error : s.summary}`;
  if (s.kind === 'note') return `${n}. [시스템] ${s.text}`;
  if (s.kind === 'wait') return `${n}. wait → ${s.error}`;
  return `${n}. ${JSON.stringify(s).slice(0, 200)}`;
}

/** Sensitivity of observation i (higher = keep more of it): recency × kind × status, from the whole step list. */
function sensitivity(steps, i, newest) {
  const s = steps[i];
  const age = newest - i;
  let w = Math.pow(1 + age, -0.8); // PyramidKV-style decay with depth (age)
  if (s.kind === 'read') {
    w *= 1.3; // code that later edits depend on
    const edited = steps.slice(i + 1).some((x) => (x.kind === 'edit' || x.kind === 'write') && x.path === s.path);
    if (edited) w *= 0.15; // the file changed afterwards: this copy is stale
  } else if (s.kind === 'run') {
    if (s.exitCode && s.status === 'done') {
      w *= 1.8; // failures carry the evidence
      if (steps.slice(i + 1).some((x) => x.kind === 'run' && x.command === s.command && x.exitCode === 0)) w *= 0.25; // resolved
    }
    if (steps.slice(i + 1).some((x) => x.kind === 'run' && x.command === s.command && x.status === 'done')) w *= 0.3; // superseded re-run
  }
  return w;
}

class Packer {
  /** level: 'auto' | 'aggressive' | 'off' */
  constructor({ level = 'auto' } = {}) {
    this.level = level;
    this.caps = new Map(); // step index → current verbatim cap (monotone non-increasing)
    this.stats = { rawChars: 0, packedChars: 0, rounds: 0 };
    this.terms = [];
  }

  /** Set the observation window: the user's request (and later, the newest failure) steer which lines survive. */
  setQuery(userText) {
    this.request = userText || '';
    this.terms = queryTerms(userText);
  }

  _cap(kind) {
    return (this.level === 'aggressive' ? CAPS_AGGRESSIVE : CAPS)[kind] || 1500;
  }

  _fit(steps, i, cap) {
    const body = bodyOf(steps[i]);
    return body.length > cap ? selectLines(body, cap, this.terms) : body;
  }

  /**
   * Render all observations within `budgetChars` (the observation share of the prompt).
   * Returns the formatted strings; `this.stats` reports raw vs packed size for the UI.
   */
  render(steps, budgetChars) {
    const n = steps.length;
    if (this.level === 'off') {
      this.stats = { rawChars: 0, packedChars: 0, rounds: 0 };
      return steps.map((s, i) => {
        const full = i >= n - LEGACY_FULL;
        const body = bodyOf(s);
        const cut = s.kind === 'run' ? (full ? 3000 : 250) : full ? 7000 : 300;
        return renderObs(s, i + 1, truncateMiddle(body, cut));
      });
    }
    // the failure the model is currently fighting steers line selection for every older observation
    const latestFail = [...steps].reverse().find((s) => s.kind === 'run' && s.exitCode && s.output);
    this.terms = queryTerms(this.request, latestFail ? latestFail.output.split('\n').filter((l) => ERR.test(l)).slice(0, 6).join(' ') : '');

    const draw = () => steps.map((s, i) => {
      const cap = this.caps.has(i) ? this.caps.get(i) : this._cap(s.kind);
      const body = this._fit(steps, i, cap);
      const raw = bodyOf(s);
      const edited = s.kind === 'read' && steps.slice(i + 1).some((x) => (x.kind === 'edit' || x.kind === 'write') && x.path === s.path);
      // Only label an observation that was actually cut. A "(이후 수정됨)" label on an intact read made the 8B model think the
      // file still had to be edited, so it repeated the same edit until the failure limit (measured: 0/2 vs 2/2 without it).
      const tag = raw.length > body.length ? (edited ? ' (수정 전 내용 · 일부만 표시)' : ' (일부만 표시)') : '';
      return { text: renderObs(s, i + 1, body, tag), bodyLen: body.length, rawLen: raw.length };
    });
    let rows = draw();
    const total = () => rows.reduce((a, r) => a + r.text.length, 0);
    for (let round = 0; round < 3 && total() > budgetChars; round++) {
      // demote: share what the budget leaves for bodies, by sensitivity, down to the low-water mark
      const headers = rows.reduce((a, r) => a + (r.text.length - r.bodyLen), 0);
      const bodyBudget = Math.max(FLOOR_CHARS * n, Math.floor(budgetChars * LOW_WATER) - headers);
      const items = rows.map((r, i) => ({ len: r.bodyLen, w: sensitivity(steps, i, n - 1), protect: i === n - 1 ? Math.min(r.bodyLen, Math.floor(bodyBudget * 0.45)) : 0 }));
      const target = allocate(items, bodyBudget);
      target.forEach((t, i) => {
        if (items[i].len > FLOOR_CHARS && t < items[i].len * 0.9) this.caps.set(i, Math.min(this.caps.has(i) ? this.caps.get(i) : Infinity, Math.max(FLOOR_CHARS, Math.floor(t / 50) * 50)));
      });
      this.stats.rounds++;
      rows = draw();
    }
    this.stats.rawChars = rows.reduce((a, r) => a + r.rawLen, 0);
    this.stats.packedChars = rows.reduce((a, r) => a + r.bodyLen, 0);
    return rows.map((r) => r.text);
  }
}

module.exports = { Packer, allocate, selectLines, scoreLines, queryTerms, estimateTokens, renderObs, sensitivity, bodyOf, FLOOR_CHARS };
