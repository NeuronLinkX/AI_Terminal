'use strict';
// Exact KV-cache memory model. Replaces the old "0.00015 GB per token" rule of thumb with the model's real geometry
// (read from Ollama /api/show → GGUF metadata): layers × KV heads × (key + value width) × bytes per cache element.
//
// Why it matters: the KV cache is allocated up front for the whole context (num_ctx), so its size — not the amount of
// text actually used — decides the resident memory. This model is what the KV planner (planner.js) reasons with.

// llama.cpp cache element sizes in bytes (block formats: bytes per block / elements per block)
const BYTES_PER_ELEM = { f32: 4, f16: 2, bf16: 2, q8_0: 34 / 32, q5_1: 24 / 32, q5_0: 22 / 32, q4_1: 20 / 32, q4_0: 18 / 32 };
// Ollama applies one type to both K and V (OLLAMA_KV_CACHE_TYPE); these are the ones it accepts
const KV_TYPES = ['f16', 'q8_0', 'q4_0'];
// extra sliding-window slack llama.cpp keeps per SWA layer (one micro-batch)
const SWA_SLACK = 512;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Geometry from `model_info` of /api/show. Returns null when the architecture is unknown (callers then fall back to
 * the legacy estimate). Per-layer KV head counts (arrays) are supported; SWA layers are modelled for gemma-style
 * `sliding_window` + `sliding_window_pattern`; anything else exotic (MLA, SSM hybrids) sets `approx`.
 */
function parseGeometry(modelInfo) {
  const mi = modelInfo || {};
  const arch = mi['general.architecture'];
  if (!arch) return null;
  const k = (name) => mi[`${arch}.${name}`];
  const layers = num(k('block_count'));
  const heads = k('attention.head_count');
  const headsKv = k('attention.head_count_kv');
  const embd = num(k('embedding_length'));
  if (!layers) return null;
  const nHead = Array.isArray(heads) ? heads : Array(layers).fill(num(heads) || 0);
  let nKv = Array.isArray(headsKv) ? headsKv.slice(0, layers) : Array(layers).fill(num(headsKv) || num(heads) || 0);
  if (!nKv.length || nKv.some((x) => !x)) return null;
  const dHead = embd && nHead[0] ? Math.floor(embd / nHead[0]) : null;
  const keyLen = num(k('attention.key_length')) || dHead;
  const valLen = num(k('attention.value_length')) || dHead;
  if (!keyLen || !valLen) return null;
  const swa = num(k('attention.sliding_window'));
  const pattern = num(k('attention.sliding_window_pattern'));
  const swaLayers = swa && pattern ? nKv.map((_, i) => (i + 1) % pattern !== 0) : null;
  const exotic = Boolean(k('attention.kv_lora_rank') || k('ssm.state_size') || k('attention.key_length_mla'));
  return {
    arch,
    layers,
    nKv,
    keyLen,
    valLen,
    window: swa || null,
    swaLayers,
    ctxTrain: num(k('context_length')),
    approx: exotic || Boolean(swa && !pattern),
  };
}

const bytesOf = (t) => {
  if (!(t in BYTES_PER_ELEM)) throw new Error(`unknown KV cache type: ${t}`);
  return BYTES_PER_ELEM[t];
};

/** KV bytes for `ctx` tokens. `type` applies to K and V, or pass {k, v} to price an asymmetric split. */
function kvBytes(geo, ctx, type = 'f16') {
  const bk = bytesOf(typeof type === 'string' ? type : type.k);
  const bv = bytesOf(typeof type === 'string' ? type : type.v);
  let total = 0;
  for (let l = 0; l < geo.layers; l++) {
    const tokens = geo.swaLayers && geo.swaLayers[l] ? Math.min(ctx, geo.window + SWA_SLACK) : ctx;
    total += tokens * geo.nKv[l] * (geo.keyLen * bk + geo.valLen * bv);
  }
  return total;
}
const kvBytesPerToken = (geo, type = 'f16') => kvBytes(geo, 1, type); // full-attention rate (SWA layers are capped, so this is an upper bound)
const kvGB = (geo, ctx, type = 'f16') => kvBytes(geo, ctx, type) / 1e9; // decimal GB, same unit as `ollama ps`

/** Legacy rule of thumb (qwen3:8b ≈ 0.00015 GB per token at f16) when the geometry is unknown. */
const legacyKvGB = (ctx, type = 'f16') => ctx * 0.00015 * (bytesOf(type) / 2);

module.exports = { BYTES_PER_ELEM, KV_TYPES, parseGeometry, kvBytes, kvBytesPerToken, kvGB, legacyKvGB };
