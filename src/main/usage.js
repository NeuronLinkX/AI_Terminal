'use strict';
// Token usage for paid / metered APIs (OpenAI and OpenAI-compatible endpoints).
//
// Two sources, deliberately kept apart so the numbers are never mixed up:
//   1. UsageMeter   — what THIS APP sent: the `usage` block every chat-completions response carries (prompt / completion /
//                     cached tokens), recorded per call. Stored as counts only (no prompts, no answers, no keys) in
//                     <userData>/usage/YYYY-MM.jsonl. When a server returns no `usage`, the call is stored as an
//                     estimate and flagged `estimated`.
//   2. fetchOfficial — what the PROVIDER's own accounting says for the whole organization (this app + everything else
//                     using the account), from OpenAI's Usage and Costs APIs. These endpoints need an organization ADMIN
//                     key (platform.openai.com/settings/organization/admin-keys), not a normal API key. Only called when
//                     the user clicks "load"; the admin key is read from the encrypted store and is sent to the
//                     configured official host only.
const fs = require('fs');
const path = require('path');

const DAY = 86400000;
const OFFICIAL_HOST = 'api.openai.com';
const dayKey = (t) => { const d = new Date(t); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const empty = () => ({ calls: 0, input: 0, output: 0, cached: 0, total: 0, estimated: 0 });
const add = (acc, r) => {
  acc.calls += 1;
  acc.input += r.input || 0;
  acc.output += r.output || 0;
  acc.cached += r.cached || 0;
  acc.total += (r.input || 0) + (r.output || 0);
  if (r.estimated) acc.estimated += 1;
  return acc;
};

class UsageMeter {
  constructor(dataDir) {
    this.dir = dataDir ? path.join(dataDir, 'usage') : null;
    this.session = { startedAt: Date.now(), ...empty(), byModel: {} };
    this.listeners = [];
  }
  onChange(fn) { this.listeners.push(fn); }

  /** Record one API call. `u` = { provider, host, model, input, output, cached, estimated } — token counts only. */
  record(u) {
    const r = { ts: new Date().toISOString(), provider: u.provider || 'openai', host: u.host || '', model: u.model || '', input: Math.max(0, Math.round(u.input || 0)), output: Math.max(0, Math.round(u.output || 0)), cached: Math.max(0, Math.round(u.cached || 0)), estimated: !!u.estimated };
    add(this.session, r);
    const m = (this.session.byModel[r.model] = this.session.byModel[r.model] || empty());
    add(m, r);
    if (this.dir) {
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.appendFileSync(path.join(this.dir, `${r.ts.slice(0, 7)}.jsonl`), JSON.stringify(r) + '\n', { mode: 0o600 });
      } catch { /* metering must never break a request */ }
    }
    for (const fn of this.listeners) { try { fn(r); } catch { /* ignore */ } }
    return r;
  }

  _rows(sinceMs) {
    if (!this.dir) return [];
    const rows = [];
    let files = [];
    try { files = fs.readdirSync(this.dir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort(); } catch { return []; }
    const first = new Date(sinceMs).toISOString().slice(0, 7);
    for (const f of files) {
      if (f.slice(0, 7) < first) continue;
      for (const line of fs.readFileSync(path.join(this.dir, f), 'utf8').split('\n')) {
        if (!line) continue;
        try { const r = JSON.parse(line); if (Date.parse(r.ts) >= sinceMs) rows.push(r); } catch { /* skip a torn line */ }
      }
    }
    return rows;
  }

  /** Local totals: this session, today, last 7 days, last 30 days (calendar days, local time) and per model for 30 days. */
  summary(now = Date.now()) {
    const startToday = new Date(new Date(now).setHours(0, 0, 0, 0)).getTime();
    const out = { session: { ...this.session, byModel: Object.fromEntries(Object.entries(this.session.byModel)) }, today: empty(), d7: empty(), d30: empty(), byModel: {}, days: {} };
    for (const r of this._rows(startToday - 29 * DAY)) {
      const t = Date.parse(r.ts);
      add(out.d30, r);
      if (t >= startToday - 6 * DAY) add(out.d7, r);
      if (t >= startToday) add(out.today, r);
      add((out.byModel[r.model] = out.byModel[r.model] || empty()), r);
      add((out.days[dayKey(t)] = out.days[dayKey(t)] || empty()), r);
    }
    return out;
  }
}

/** Pull `usage` out of a chat-completions response (or the final stream chunk) into counts. */
function fromResponse(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const input = Number(usage.prompt_tokens ?? usage.input_tokens);
  const output = Number(usage.completion_tokens ?? usage.output_tokens);
  if (!Number.isFinite(input) && !Number.isFinite(output)) return null;
  const cached = Number((usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) ?? usage.input_tokens_details?.cached_tokens ?? 0) || 0;
  return { input: Number.isFinite(input) ? input : 0, output: Number.isFinite(output) ? output : 0, cached };
}

// ------------------------------------------------------------------ official usage (organization level)
const isOfficial = (baseUrl) => { try { return new URL(baseUrl).host === OFFICIAL_HOST; } catch { return false; } };

/** Where the Usage/Costs endpoints live: the official host, or AIT_OPENAI_USAGE_BASE (tests / compatible gateways). */
function usageBase(baseUrl) {
  if (process.env.AIT_OPENAI_USAGE_BASE) return process.env.AIT_OPENAI_USAGE_BASE.replace(/\/+$/, '');
  return isOfficial(baseUrl) ? `https://${OFFICIAL_HOST}/v1` : null;
}

async function page(url, key, signal) {
  const r = await fetch(url, { headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, signal: signal || AbortSignal.timeout(20000) });
  if (r.status === 401 || r.status === 403) {
    const e = new Error('admin-key');
    e.code = r.status === 401 ? 'unauthorized' : 'forbidden';
    throw e;
  }
  if (!r.ok) { const e = new Error(`http-${r.status}`); e.code = 'http'; e.status = r.status; throw e; }
  return r.json();
}

/** All pages of an organization endpoint (follows `next_page`, at most `maxPages`). Returns the buckets. */
async function allBuckets(base, endpoint, params, key, maxPages = 6) {
  const buckets = [];
  let next = null;
  for (let i = 0; i < maxPages; i++) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) (Array.isArray(v) ? v : [v]).forEach((x) => q.append(Array.isArray(v) ? `${k}[]` : k, String(x)));
    if (next) q.set('page', next);
    const j = await page(`${base}/organization/${endpoint}?${q}`, key);
    buckets.push(...(j.data || []));
    if (!j.has_more || !j.next_page) break;
    next = j.next_page;
  }
  return buckets;
}

/**
 * Official organization usage for the last 30 days, bucketed per day, grouped by model, plus costs.
 * Returns { ok, ranges: {today,d7,d30}, byModel, cost: {today,d7,d30,currency}, fetchedAt } or { ok:false, reason, code }.
 * The key is used only for the Authorization header and never appears in the result or in errors.
 */
async function fetchOfficial({ baseUrl, adminKey, now = Date.now() }) {
  const base = usageBase(baseUrl);
  if (!base) return { ok: false, code: 'not-official', reason: 'official-host-only' };
  if (!adminKey) return { ok: false, code: 'no-admin-key', reason: 'no-admin-key' };
  const sec = (t) => Math.floor(t / 1000);
  const startToday = new Date(new Date(now).setHours(0, 0, 0, 0)).getTime();
  const start = sec(startToday - 29 * DAY);
  try {
    const [usage, costs] = await Promise.all([
      allBuckets(base, 'usage/completions', { start_time: start, bucket_width: '1d', group_by: ['model'], limit: 31 }, adminKey),
      allBuckets(base, 'costs', { start_time: start, bucket_width: '1d', limit: 31 }, adminKey).catch(() => null), // costs are a bonus: usage alone is useful
    ]);
    const mk = () => ({ input: 0, output: 0, cached: 0, requests: 0 });
    const ranges = { today: mk(), d7: mk(), d30: mk() };
    const byModel = {};
    for (const b of usage) {
      for (const r of b.results || []) {
        const into = [ranges.d30];
        if (b.start_time >= sec(startToday - 6 * DAY)) into.push(ranges.d7);
        if (b.start_time >= sec(startToday)) into.push(ranges.today);
        const m = (byModel[r.model || '(합계)'] = byModel[r.model || '(합계)'] || mk());
        for (const t of [...into, m]) {
          t.input += r.input_tokens || 0;
          t.output += r.output_tokens || 0;
          t.cached += r.input_cached_tokens || 0;
          t.requests += r.num_model_requests || 0;
        }
      }
    }
    let cost = null;
    if (costs) {
      cost = { today: 0, d7: 0, d30: 0, currency: 'usd' };
      for (const b of costs) {
        for (const r of b.results || []) {
          const v = Number(r.amount && r.amount.value) || 0;
          if (r.amount && r.amount.currency) cost.currency = r.amount.currency;
          cost.d30 += v;
          if (b.start_time >= sec(startToday - 6 * DAY)) cost.d7 += v;
          if (b.start_time >= sec(startToday)) cost.today += v;
        }
      }
    }
    return { ok: true, ranges, byModel, cost, fetchedAt: new Date(now).toISOString() };
  } catch (e) {
    if (e.code === 'unauthorized' || e.code === 'forbidden') return { ok: false, code: e.code, reason: 'admin-key-rejected' };
    if (e.code === 'http') return { ok: false, code: 'http', reason: `http-${e.status}` };
    return { ok: false, code: 'network', reason: 'network' };
  }
}

module.exports = { UsageMeter, fromResponse, fetchOfficial, isOfficial, usageBase, OFFICIAL_HOST };
