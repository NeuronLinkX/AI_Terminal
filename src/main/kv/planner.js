'use strict';
// KV budget planner ("governor"): given the model, the memory the Mac can spare and what the user asked for, pick the
// KV-cache precision and context length that give the best quality that actually fits.
//
// Every candidate (type, ctx) gets a quality-loss cost; the cheapest candidate that fits wins:
//   cost = TYPE_COST[type]  +  CTX_COST × log2(wantCtx / ctx)  (+ an extra penalty per halving below FLOOR_CTX)
// TYPE_COST encodes the measured precision loss (docs/KV_CACHE.md: perplexity delta f16 → q8_0 is ≈ 0, → q4_0 is clearly
// visible); CTX_COST is what remembering fewer tokens costs an agent whose prompt is already compacted (ctxpack.js).
// A pinned precision is respected: only the context may shrink (and only when autoContext allows it).
const { kvGB, legacyKvGB, KV_TYPES } = require('./model');

const CTX_STEPS = [32768, 24576, 16384, 12288, 8192, 4096];
const MIN_CTX = 4096;
const FLOOR_CTX = 8192; // below this an agent loop starts losing task state
const TYPE_COST = { f16: 0, q8_0: 0.6, q4_0: 3.5 };
const CTX_COST = 1.5;
const BELOW_FLOOR_COST = 3;
const STAY_BONUS = 0.5; // switching the engine's KV type reloads the model: mild preference to keep the current one
const F16_HEADROOM_GB = 0.5; // f16 is only worth choosing when it fits comfortably
// extra memory beyond weights + KV: compute buffers, graph, runtime. Measured −0.1 … +0.3 GB on qwen3 (docs/benchmark-kv.json)
const OVERHEAD_GB = 0.3;

/**
 * @param {object} p
 * @param {object|null} p.geo        parseGeometry() result (null → legacy estimate)
 * @param {number} p.weightsGB       model file size (decimal GB)
 * @param {number} p.wantCtx         context the user configured
 * @param {string} p.precision       'auto' | 'f16' | 'q8_0' | 'q4_0'
 * @param {boolean} p.autoContext    allow shrinking the context when nothing fits
 * @param {object|null} p.memory     { availGB, loadedGB } or null when unknown (→ no limit applied)
 * @param {number} [p.reserveGB]     memory kept free for macOS and other apps
 * @param {string|null} [p.current]  KV type the running engine already uses
 */
function plan(p) {
  const { geo, weightsGB, wantCtx, precision = 'auto', autoContext = true, memory, reserveGB = 1.5, current = null } = p;
  const kv = (ctx, t) => (geo ? kvGB(geo, ctx, t) : legacyKvGB(ctx, t));
  const need = (ctx, t) => Math.round((weightsGB + kv(ctx, t) + OVERHEAD_GB) * 100) / 100;
  // what we may use: free memory + what this model already holds (it is reloaded), minus the reserve
  const room = memory ? memory.availGB + (memory.loadedGB || 0) - reserveGB : Infinity;
  const types = precision !== 'auto' && KV_TYPES.includes(precision) ? [precision] : KV_TYPES;
  const ctxs = [wantCtx, ...CTX_STEPS.filter((c) => c < wantCtx)].filter((c) => autoContext || c === wantCtx);

  const cost = (ctx, t) => {
    let c = TYPE_COST[t] + CTX_COST * Math.log2(wantCtx / ctx);
    if (ctx < FLOOR_CTX) c += BELOW_FLOOR_COST * Math.log2(Math.min(wantCtx, FLOOR_CTX) / ctx);
    return c - (t === current ? STAY_BONUS : 0);
  };
  const candidates = [];
  for (const t of types) {
    for (const ctx of ctxs) {
      const n = need(ctx, t);
      const margin = t === 'f16' && precision === 'auto' ? F16_HEADROOM_GB : 0;
      candidates.push({ ctx, kvType: t, needGB: n, fits: n + margin <= room, cost: cost(ctx, t) });
    }
  }
  const ok = candidates.filter((c) => c.fits).sort((a, b) => a.cost - b.cost || b.ctx - a.ctx);
  let pick = ok[0];
  let nofit = false;
  if (!pick) {
    // nothing fits: take the smallest footprint but keep precision high (the shortage is reported to the user)
    nofit = true;
    const t = types.includes('q8_0') ? 'q8_0' : types[types.length - 1];
    const c = autoContext ? Math.min(wantCtx, MIN_CTX) : wantCtx; // autoContext off: the context is never changed
    pick = { ctx: c, kvType: t, needGB: need(c, t) };
  }
  return {
    ctx: pick.ctx,
    kvType: pick.kvType,
    kvGB: Math.round(kv(pick.ctx, pick.kvType) * 100) / 100,
    needGB: pick.needGB,
    roomGB: room === Infinity ? null : Math.round(room * 10) / 10,
    lowered: pick.ctx < wantCtx,
    quantized: pick.kvType !== 'f16',
    nofit,
    reason: precision === 'auto' ? `auto${pick.kvType === 'f16' ? '-f16' : '-' + pick.kvType}${pick.ctx < wantCtx ? '-ctx-lowered' : ''}` : `pinned${pick.ctx < wantCtx ? '-ctx-lowered' : ''}`,
  };
}

module.exports = { plan, OVERHEAD_GB, CTX_STEPS, MIN_CTX, FLOOR_CTX, TYPE_COST };
