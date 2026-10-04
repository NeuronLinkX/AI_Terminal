// kvpolicy.hpp — layer-wise KV-cache budget allocation policies (header-only, no llama.cpp dependency).
//
// Given measured attention statistics per layer, decide how many KV entries each layer should keep when the TOTAL budget is
// fixed. Implemented from the literature (see docs/KV_CACHE.md):
//   uniform   every layer keeps the same number of tokens (H2O / SnapKV default)
//   pyramid   arithmetic sequence, more at the bottom than at the top (PyramidKV, Cai et al. 2024)
//   cake      budget ∝ spatial dispersion (entropy) × temporal shift (variability) of the attention (CAKE, Qin et al. ICLR'25)
//   depthkv   budget ∝ measured pruning sensitivity of the layer, with a per-layer floor/ceiling and iterative redistribution
//             of the mass of saturated layers (DepthKV, Dehghanighobadi & Fischer 2026, "metric-guided allocation").
//             The sensitivity here is the attention mass a layer would lose at the uniform budget (training-free proxy);
//             the paper itself uses an InfoNCE representation metric / single-layer ablations.
//   marginal  greedy equal-marginal-gain allocation: optimal for the retained-mass proxy (an upper bound, not a paper method)
//   adakv     within a layer, heads share the layer budget by pooled top-k instead of equal split (Ada-KV, NeurIPS'25)
//
// Quality proxy: the fraction of a layer's attention mass (on the prefix keys, averaged over KV heads) that survives eviction.
// Ada-KV bounds the attention-output error by (2 × lost mass × max‖V‖), so mass retention is the standard, model-agnostic
// proxy. It is NOT task accuracy.
#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <numeric>
#include <queue>
#include <utility>
#include <vector>

namespace kvpolicy {

/// One KV head of one layer: cum[b] = share of the prefix attention mass held by its b most-attended keys (cum[0]=0, cum[P]=1).
struct HeadCurve { std::vector<float> cum; };

struct Layer {
  std::vector<HeadCurve> heads;
  double entropy = 0;   // normalised spatial dispersion in [0,1] (1 = attention spread evenly over all keys)
  double variance = 0;  // temporal shift: how much attention to a key varies across the observation window
};

inline int prefix_len(const Layer& l) { return l.heads.empty() ? 0 : (int)l.heads[0].cum.size() - 1; }

/// Mean retained attention mass over the KV heads when every head keeps its own top-B keys.
inline double capture(const Layer& l, int B) {
  if (l.heads.empty()) return 0;
  double s = 0;
  for (const auto& h : l.heads) s += h.cum[std::min<int>(B, (int)h.cum.size() - 1)];
  return s / (double)l.heads.size();
}

/// Ada-KV: the layer budget B·H is pooled over heads (top-(B·H) entries across all heads, each head's weights summing to 1).
inline double capture_pooled(const Layer& l, int B) {
  const int H = (int)l.heads.size();
  if (!H) return 0;
  struct Cur { float v; int h, i; };
  auto cmp = [](const Cur& a, const Cur& b) { return a.v < b.v; };
  std::priority_queue<Cur, std::vector<Cur>, decltype(cmp)> pq(cmp);
  auto val = [&](int h, int i) { return l.heads[h].cum[i + 1] - l.heads[h].cum[i]; };
  for (int h = 0; h < H; ++h) pq.push({val(h, 0), h, 0});
  double mass = 0;
  const int take = std::min<long>((long)B * H, (long)H * prefix_len(l));
  for (int n = 0; n < take; ++n) {
    Cur c = pq.top();
    pq.pop();
    mass += c.v;
    if (c.i + 1 < prefix_len(l)) pq.push({val(c.h, c.i + 1), c.h, c.i + 1});
  }
  return mass / H;
}

inline std::vector<int> uniform(int L, long total, int P) {
  std::vector<int> b(L, (int)std::min<long>(P, total / std::max(1, L)));
  return b;
}

/// Proportional allocation with per-layer floor/ceiling; layers that hit the ceiling release their share to the others
/// (iterated until stable). The sum equals `total` unless the bounds make that impossible.
inline std::vector<int> waterfill(const std::vector<double>& w, long total, int lo, int hi) {
  const int n = (int)w.size();
  std::vector<int> out(n, lo);
  std::vector<char> open(n, 1);
  double remaining = (double)total - (double)lo * n;
  for (int guard = 0; guard <= n; ++guard) {
    double ws = 0;
    for (int i = 0; i < n; ++i) if (open[i]) ws += std::max(w[i], 1e-12);
    bool changed = false;
    for (int i = 0; i < n; ++i) {
      if (!open[i]) continue;
      const double share = remaining * std::max(w[i], 1e-12) / ws;
      if (lo + share >= hi) { out[i] = hi; open[i] = 0; remaining -= (hi - lo); changed = true; }
    }
    if (!changed) break;
  }
  double ws = 0;
  for (int i = 0; i < n; ++i) if (open[i]) ws += std::max(w[i], 1e-12);
  long used = 0;
  for (int i = 0; i < n; ++i) if (open[i]) { out[i] = lo + (int)std::floor(std::max(0.0, remaining) * std::max(w[i], 1e-12) / ws); out[i] = std::min(out[i], hi); }
  for (int i = 0; i < n; ++i) used += out[i];
  // hand the rounding remainder to the heaviest open layers
  std::vector<int> idx(n);
  std::iota(idx.begin(), idx.end(), 0);
  std::sort(idx.begin(), idx.end(), [&](int a, int b) { return w[a] > w[b]; });
  for (int k = 0; used < total && k < 4 * n; ++k) { int i = idx[k % n]; if (out[i] < hi) { ++out[i]; ++used; } }
  return out;
}

/// PyramidKV: arithmetic sequence from (1+alpha)·mean at layer 0 down to (1-alpha)·mean at the last layer.
inline std::vector<int> pyramid(int L, long total, int P, double alpha = 0.8) {
  std::vector<double> w(L);
  for (int l = 0; l < L; ++l) w[l] = 1.0 + alpha * (1.0 - 2.0 * l / std::max(1, L - 1));
  return waterfill(w, total, 1, P);
}

/// CAKE-style preference: spatial dispersion × temporal variability, each min-max normalised across layers.
inline std::vector<int> cake(const std::vector<Layer>& ls, long total, int P) {
  const int L = (int)ls.size();
  auto norm = [&](auto get) {
    double lo = 1e18, hi = -1e18;
    for (auto& l : ls) { lo = std::min(lo, get(l)); hi = std::max(hi, get(l)); }
    std::vector<double> v(L);
    for (int i = 0; i < L; ++i) v[i] = hi > lo ? 0.1 + 0.9 * (get(ls[i]) - lo) / (hi - lo) : 1.0;
    return v;
  };
  auto h = norm([](const Layer& l) { return l.entropy; });
  auto v = norm([](const Layer& l) { return l.variance; });
  std::vector<double> w(L);
  for (int i = 0; i < L; ++i) w[i] = h[i] * v[i];
  return waterfill(w, total, 1, P);
}

/// DepthKV-style metric-guided allocation. `Bref` = the uniform budget the sensitivity is measured at; the floor keeps a
/// layer from being starved (DepthKV caps any layer's pruning ratio at 0.7), the ceiling is the full prefix.
inline std::vector<int> depthkv(const std::vector<Layer>& ls, long total, int P, int Bref, double floor_frac = 0.25) {
  const int L = (int)ls.size();
  std::vector<double> w(L);
  for (int i = 0; i < L; ++i) w[i] = 1.0 - capture(ls[i], Bref); // attention mass lost at the uniform budget = sensitivity
  return waterfill(w, total, std::max(1, (int)(floor_frac * Bref)), P);
}

/// Marginal-utility (greedy) allocation: give the next key to the layer whose attention mass grows the most. Every head curve is
/// concave (sorted descending), so the layer curve is concave and this greedy rule is OPTIMAL for the retained-mass proxy —
/// the allocation that equalises the marginal gain across layers. It shows what a layer-dependent budget can reach at best.
inline std::vector<int> marginal(const std::vector<Layer>& ls, long total, int P, int lo = 1) {
  const int L = (int)ls.size();
  std::vector<int> b(L, lo);
  long used = (long)L * lo;
  auto gain = [&](int l) {
    if (b[l] >= P) return -1.0;
    double g = 0;
    for (const auto& h : ls[l].heads) g += h.cum[b[l] + 1] - h.cum[b[l]];
    return g / std::max<size_t>(1, ls[l].heads.size());
  };
  std::priority_queue<std::pair<double, int>> pq;
  for (int l = 0; l < L; ++l) pq.push({gain(l), l});
  while (used < total && !pq.empty()) {
    auto [g, l] = pq.top();
    pq.pop();
    if (g < 0) continue;
    ++b[l];
    ++used;
    pq.push({gain(l), l});
  }
  return b;
}

struct Score { double mean_loss = 0, worst_loss = 0; };

/// Retained-mass loss of a budget vector on measured layers (1 − captured mass); `pooled` switches to Ada-KV head pooling.
inline Score evaluate(const std::vector<Layer>& ls, const std::vector<int>& b, bool pooled = false) {
  Score s;
  for (size_t i = 0; i < ls.size(); ++i) {
    const double loss = 1.0 - (pooled ? capture_pooled(ls[i], b[i]) : capture(ls[i], b[i]));
    s.mean_loss += loss;
    s.worst_loss = std::max(s.worst_loss, loss);
  }
  s.mean_loss /= std::max<size_t>(1, ls.size());
  return s;
}

}  // namespace kvpolicy
