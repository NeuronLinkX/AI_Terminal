// kvprof — per-layer attention profiler and KV-budget allocation study for a local GGUF model (libllama).
//
//   kvprof --model m.gguf --calib a.txt [--calib b.txt ...] --eval c.txt [--eval d.txt ...] [--ctx 1536] [--window 32] [--out profile.json]
//   kvprof --selftest
//
// What it does (all with the REAL model, no mock):
//   1. runs the last --ctx tokens of each prompt through the model once with flash attention disabled, so the attention softmax of every layer is
//      materialised, and reads the attention of the last `window` positions (SnapKV's "observation window") for every KV head
//      (grouped-query heads of a KV group are averaged, as KV pruning is per KV head);
//   2. turns that into per-layer statistics: sorted attention curves (how much attention mass the top-B keys hold),
//      spatial dispersion (entropy) and temporal shift (variance) — the signals PyramidKV / CAKE / Ada-KV / DepthKV build on;
//   3. calibrates budgets on the --calib prompts for several policies at the same TOTAL budget (kvpolicy.hpp) and measures the
//      attention mass they retain on the held-out --eval prompts, per layer, plus an "oracle" calibrated on the eval prompt.
// Stock llama.cpp / Ollama keep one token set for all layers, so these budgets cannot be applied inside them; the tool
// quantifies how much a layer-dependent KV budget WOULD retain on this model — the case for it, measured.
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

#include "ggml-backend.h"
#include "ggml.h"
#include "kvpolicy.hpp"
#include "llama.h"

using kvpolicy::HeadCurve;
using kvpolicy::Layer;

struct Probe {
  int N = 0, W = 32, P = 0, n_head = 0, n_kv = 0, group = 1, n_layer = 0;
  std::vector<Layer> layers;
  std::vector<float> row;  // scratch for one attention row
  bool verbose = false;
  int seen = 0;
};

static bool cb_eval(struct ggml_tensor* t, bool ask, void* ud) {
  auto* pr = (Probe*)ud;
  if (std::strncmp(t->name, "kq_soft_max", 11) != 0) return ask ? false : true;
  if (ask) return true;
  const char* dash = std::strrchr(t->name, '-');
  const int il = dash ? std::atoi(dash + 1) : -1;
  if (il < 0 || il >= pr->n_layer || t->type != GGML_TYPE_F32) return true;
  const int64_t ne0 = t->ne[0], ne1 = t->ne[1], ne2 = t->ne[2];
  if (ne2 != pr->n_head || ne0 < pr->N || ne1 < pr->N) return true;  // not the prompt-processing graph
  const int P = pr->P, W = pr->W, H = pr->n_kv;
  // per KV head: mean attention over the window queries and the group's query heads, plus variance over the window
  std::vector<std::vector<double>> mean(H, std::vector<double>(P, 0.0)), sq(H, std::vector<double>(P, 0.0));
  pr->row.resize(P);
  for (int h = 0; h < pr->n_head; ++h) {
    const int kv = h / pr->group;
    for (int q = pr->N - W; q < pr->N; ++q) {
      const size_t off = (size_t)(((int64_t)h * ne1 + q) * ne0) * sizeof(float);
      ggml_backend_tensor_get(t, pr->row.data(), off, (size_t)P * sizeof(float));
      for (int k = 0; k < P; ++k) { mean[kv][k] += pr->row[k]; sq[kv][k] += (double)pr->row[k] * pr->row[k]; }
    }
  }
  Layer& L = pr->layers[il];
  L.heads.assign(H, HeadCurve{});
  double ent_sum = 0, var_sum = 0;
  const double denom = (double)W * pr->group;
  for (int kv = 0; kv < H; ++kv) {
    std::vector<double> a(P);
    double tot = 0, var = 0;
    for (int k = 0; k < P; ++k) {
      a[k] = mean[kv][k] / denom;
      tot += a[k];
      const double m = a[k];
      var += std::max(0.0, sq[kv][k] / denom - m * m);
    }
    if (tot <= 0) tot = 1e-12;
    std::vector<double> p(P);
    double ent = 0;
    for (int k = 0; k < P; ++k) { p[k] = a[k] / tot; if (p[k] > 0) ent -= p[k] * std::log(p[k]); }
    ent_sum += ent / std::log((double)P);
    var_sum += std::sqrt(var) / tot;
    std::sort(p.begin(), p.end(), std::greater<double>());
    auto& cum = L.heads[kv].cum;
    cum.assign(P + 1, 0.f);
    double c = 0;
    for (int k = 0; k < P; ++k) { c += p[k]; cum[k + 1] = (float)c; }
  }
  L.entropy = ent_sum / H;
  L.variance = var_sum / H;
  ++pr->seen;
  return true;
}

static std::string read_file(const std::string& path) {
  std::ifstream f(path, std::ios::binary);
  std::stringstream ss;
  ss << f.rdbuf();
  return ss.str();
}

/// Run one prompt (first N tokens of the file) and return the measured layers.
static std::vector<Layer> profile_prompt(llama_model* model, const std::string& text, const Probe& cfg, int ctx_len, bool verbose) {
  const llama_vocab* vocab = llama_model_get_vocab(model);
  std::vector<llama_token> toks(text.size() + 16);
  int n = llama_tokenize(vocab, text.c_str(), (int32_t)text.size(), toks.data(), (int32_t)toks.size(), false, true);
  if (n < 0) { toks.resize(-n); n = llama_tokenize(vocab, text.c_str(), (int32_t)text.size(), toks.data(), (int32_t)toks.size(), false, true); }
  if (n < ctx_len) { std::fprintf(stderr, "prompt has only %d tokens, need %d\n", n, ctx_len); std::exit(2); }
  // keep the TAIL: the observation window (request + newest observations) is at the end, and every agent prompt starts with the
  // same system prompt — taking the head would make all prompts identical
  toks.assign(toks.begin() + (n - ctx_len), toks.begin() + n);

  Probe pr = cfg;
  pr.N = ctx_len;
  pr.P = ctx_len - pr.W;
  pr.layers.assign(pr.n_layer, kvpolicy::Layer{});
  pr.verbose = verbose;

  llama_context_params cp = llama_context_default_params();
  cp.n_ctx = ctx_len;
  cp.n_batch = ctx_len;
  cp.n_ubatch = ctx_len;  // the whole prompt in ONE micro-batch, so every query row is in the same attention tensor
  cp.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_DISABLED;  // flash attention never materialises the softmax
  cp.type_k = GGML_TYPE_F16;
  cp.type_v = GGML_TYPE_F16;
  cp.cb_eval = cb_eval;
  cp.cb_eval_user_data = &pr;
  llama_context* ctx = llama_init_from_model(model, cp);
  if (!ctx) { std::fprintf(stderr, "context creation failed\n"); std::exit(3); }
  llama_batch b = llama_batch_get_one(toks.data(), (int32_t)toks.size());
  if (llama_decode(ctx, b) != 0) { std::fprintf(stderr, "decode failed\n"); std::exit(4); }
  llama_free(ctx);
  if (pr.seen != pr.n_layer) { std::fprintf(stderr, "captured attention of %d/%d layers (graph naming changed?)\n", pr.seen, pr.n_layer); std::exit(5); }
  return pr.layers;
}

/// Element-wise mean of the curves of several prompts (calibration set).
static std::vector<Layer> average(const std::vector<std::vector<Layer>>& runs) {
  std::vector<Layer> out = runs[0];
  const double k = (double)runs.size();
  for (size_t l = 0; l < out.size(); ++l) {
    for (size_t h = 0; h < out[l].heads.size(); ++h)
      for (size_t i = 0; i < out[l].heads[h].cum.size(); ++i) {
        double s = 0;
        for (auto& r : runs) s += r[l].heads[h].cum[i];
        out[l].heads[h].cum[i] = (float)(s / k);
      }
    double e = 0, v = 0;
    for (auto& r : runs) { e += r[l].entropy; v += r[l].variance; }
    out[l].entropy = e / k;
    out[l].variance = v / k;
  }
  return out;
}

static void json_vec(std::ostream& o, const std::vector<int>& v) {
  o << "[";
  for (size_t i = 0; i < v.size(); ++i) o << (i ? "," : "") << v[i];
  o << "]";
}

static int selftest() {
  using namespace kvpolicy;
  int fails = 0;
  auto check = [&](bool ok, const char* what) { if (!ok) { std::fprintf(stderr, "FAIL %s\n", what); ++fails; } };
  // waterfill: conserves the total, honours floor/ceiling, saturated layers release their share
  auto wf = waterfill({1, 1, 8}, 300, 10, 120);
  check(wf[0] + wf[1] + wf[2] == 300, "waterfill keeps the total");
  check(wf[2] == 120 && wf[0] == wf[1] && wf[0] == 90, "waterfill: ceiling layer saturates, rest share the remainder");
  auto lo = waterfill({1, 0, 0}, 60, 10, 100);
  check(lo[1] >= 10 && lo[2] >= 10, "waterfill: floor");
  auto py = pyramid(10, 1000, 500);
  check(py.front() > py.back(), "pyramid decreases with depth");
  long s = 0; for (int x : py) s += x;
  check(s == 1000, "pyramid keeps the total");
  // synthetic layers: layer 0 is flat (needs many keys), layer 1 is peaked (needs few)
  auto mk = [](double decay, int P) {
    Layer l; HeadCurve h; h.cum.assign(P + 1, 0.f);
    std::vector<double> w(P); double t = 0;
    for (int k = 0; k < P; ++k) { w[k] = std::exp(-decay * k / P); t += w[k]; }
    double c = 0; for (int k = 0; k < P; ++k) { c += w[k] / t; h.cum[k + 1] = (float)c; }
    l.heads = {h, h}; l.entropy = decay < 3 ? 0.9 : 0.2; l.variance = 0.1; return l;
  };
  std::vector<Layer> ls = {mk(1.0, 400), mk(12.0, 400), mk(12.0, 400), mk(1.0, 400)};
  const long total = 4 * 100;
  auto u = uniform(4, total, 400), d = depthkv(ls, total, 400, 100);
  check(d[0] + d[1] + d[2] + d[3] == total, "depthkv keeps the total");
  auto m = marginal(ls, total, 400);
  check(m[0] + m[1] + m[2] + m[3] == total, "marginal keeps the total");
  auto su = evaluate(ls, u), sd = evaluate(ls, d), sm = evaluate(ls, m);
  check(sm.mean_loss <= su.mean_loss + 1e-9 && sm.mean_loss <= sd.mean_loss + 1e-9, "marginal allocation is optimal for the mass proxy (never worse than uniform or proportional)");
  check(m[1] < u[1] && m[0] > u[0], "marginal: flat-attention layers get more, peaked layers fewer");
  check(capture_pooled(ls[0], 100) >= capture(ls[0], 100) - 1e-9, "pooled head budgets are never worse than equal split");
  std::printf(fails ? "selftest FAILED\n" : "selftest ok\n");
  return fails ? 1 : 0;
}

int main(int argc, char** argv) {
  std::string model_path, out_path;
  std::vector<std::string> calib, eval;
  int ctx_len = 1536, window = 32;
  bool verbose = false;
  for (int i = 1; i < argc; ++i) {
    std::string a = argv[i];
    auto next = [&]() -> std::string { return i + 1 < argc ? argv[++i] : ""; };
    if (a == "--selftest") return selftest();
    else if (a == "--model") model_path = next();
    else if (a == "--calib") calib.push_back(next());
    else if (a == "--eval") eval.push_back(next());
    else if (a == "--ctx") ctx_len = std::atoi(next().c_str());
    else if (a == "--window") window = std::atoi(next().c_str());
    else if (a == "--out") out_path = next();
    else if (a == "--verbose") verbose = true;
  }
  if (model_path.empty() || calib.empty() || eval.empty()) { std::fprintf(stderr, "usage: kvprof --model m.gguf --calib a.txt [...] --eval b.txt [...] [--ctx N] [--window W] [--out f.json]\n"); return 1; }

  if (!verbose) llama_log_set([](enum ggml_log_level, const char*, void*) {}, nullptr);
  llama_backend_init();
  llama_model_params mp = llama_model_default_params();
  mp.n_gpu_layers = 99;
  llama_model* model = llama_model_load_from_file(model_path.c_str(), mp);
  if (!model) { std::fprintf(stderr, "cannot load %s\n", model_path.c_str()); return 3; }

  Probe cfg;
  cfg.W = window;
  cfg.n_layer = llama_model_n_layer(model);
  cfg.n_head = llama_model_n_head(model);
  cfg.n_kv = llama_model_n_head_kv(model);
  cfg.group = std::max(1, cfg.n_head / std::max(1, cfg.n_kv));
  const int P = ctx_len - window;

  std::fprintf(stderr, "model: %d layers, %d heads (%d KV heads), prompt %d tokens, window %d\n", cfg.n_layer, cfg.n_head, cfg.n_kv, ctx_len, window);
  std::vector<std::vector<Layer>> calib_runs, eval_runs;
  for (auto& f : calib) { std::fprintf(stderr, "calibration prompt %s ...\n", f.c_str()); calib_runs.push_back(profile_prompt(model, read_file(f), cfg, ctx_len, verbose)); }
  for (auto& f : eval) { std::fprintf(stderr, "held-out prompt %s ...\n", f.c_str()); eval_runs.push_back(profile_prompt(model, read_file(f), cfg, ctx_len, verbose)); }
  const std::vector<Layer> cal = average(calib_runs);
  const int L = cfg.n_layer;

  const std::vector<double> rhos = {0.05, 0.1, 0.2, 0.4};
  std::ostringstream o;
  o.precision(5);
  o << "{\"model\":\"" << model_path << "\",\"layers\":" << L << ",\"heads\":" << cfg.n_head << ",\"kvHeads\":" << cfg.n_kv << ",\"ctx\":" << ctx_len << ",\"window\":" << window << ",\"prefix\":" << P
    << ",\"calibPrompts\":" << calib.size() << ",\"evalPrompts\":" << eval.size() << ",\"perLayer\":[";
  for (int l = 0; l < L; ++l) {
    o << (l ? "," : "") << "{\"layer\":" << l << ",\"entropy\":" << cal[l].entropy << ",\"variance\":" << cal[l].variance << ",\"capture\":{";
    for (size_t r = 0; r < rhos.size(); ++r) o << (r ? "," : "") << "\"" << rhos[r] << "\":" << kvpolicy::capture(cal[l], (int)(rhos[r] * P));
    o << "}}";
  }
  o << "],\"budgets\":{";
  std::map<std::string, std::map<std::string, std::vector<double>>> agg_mean, agg_worst;  // rho -> policy -> per eval prompt
  for (size_t r = 0; r < rhos.size(); ++r) {
    const int Bref = std::max(1, (int)(rhos[r] * P));
    const long total = (long)Bref * L;
    std::map<std::string, std::vector<int>> pol;
    pol["uniform"] = kvpolicy::uniform(L, total, P);
    pol["pyramid"] = kvpolicy::pyramid(L, total, P);
    pol["cake"] = kvpolicy::cake(cal, total, P);
    pol["depthkv-proportional"] = kvpolicy::depthkv(cal, total, P, Bref);
    pol["marginal"] = kvpolicy::marginal(cal, total, P);
    o << (r ? "," : "") << "\"" << rhos[r] << "\":{";
    bool first = true;
    for (auto& [name, b] : pol) { o << (first ? "" : ",") << "\"" << name << "\":"; json_vec(o, b); first = false; }
    o << "}";
    const std::string key = std::to_string(rhos[r]);
    for (auto& er : eval_runs) {
      for (auto& [name, b] : pol) { auto s = kvpolicy::evaluate(er, b); agg_mean[key][name].push_back(s.mean_loss); agg_worst[key][name].push_back(s.worst_loss); }
      auto ada = kvpolicy::evaluate(er, pol["uniform"], true);  // uniform layer budgets, heads pooled (Ada-KV)
      agg_mean[key]["adakv(uniform layers)"].push_back(ada.mean_loss); agg_worst[key]["adakv(uniform layers)"].push_back(ada.worst_loss);
      auto adad = kvpolicy::evaluate(er, pol["marginal"], true);  // both: layer-dependent budgets + head pooling
      agg_mean[key]["marginal+adakv"].push_back(adad.mean_loss); agg_worst[key]["marginal+adakv"].push_back(adad.worst_loss);
      auto oracle = kvpolicy::marginal(er, total, P);  // calibrated on the very prompt it is scored on (upper bound)
      auto so = kvpolicy::evaluate(er, oracle);
      agg_mean[key]["marginal(oracle)"].push_back(so.mean_loss); agg_worst[key]["marginal(oracle)"].push_back(so.worst_loss);
    }
  }
  o << "},\"eval\":{";
  bool fr = true;
  for (auto& [rho, pols] : agg_mean) {
    o << (fr ? "" : ",") << "\"" << std::stod(rho) << "\":{";
    fr = false;
    bool fp = true;
    for (auto& [name, v] : pols) {
      double m = 0, w = 0;
      for (double x : v) m += x;
      for (double x : agg_worst[rho][name]) w += x;
      m /= v.size();
      w /= v.size();
      o << (fp ? "" : ",") << "\"" << name << "\":{\"meanLoss\":" << m << ",\"worstLayerLoss\":" << w << "}";
      fp = false;
    }
    o << "}";
  }
  o << "}}\n";
  if (out_path.empty()) std::cout << o.str();
  else { std::ofstream f(out_path); f << o.str(); }
  llama_model_free(model);
  return 0;
}
