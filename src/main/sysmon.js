'use strict';
// Lightweight system monitor for the top bar: CPU and GPU utilisation, available memory, and the model Ollama has loaded.
// Everything is read-only and cheap (ioreg / vm_stat / one local HTTP call every few seconds, paused when the window is hidden).
const os = require('os');
const { execFile } = require('child_process');

const run = (cmd, args, timeout = 1500) =>
  new Promise((resolve) => execFile(cmd, args, { timeout, maxBuffer: 1 << 21 }, (err, out) => resolve(err ? '' : String(out))));
const num = (s, re) => {
  const m = s.match(re);
  return m ? Number(m[1]) : null;
};
const gb = (b) => Math.round((b / 1073741824) * 10) / 10; // system memory: GB as macOS reports it
const gbDec = (b) => Math.round(b / 1e8) / 10; // model size: same decimal GB that `ollama ps` / `ollama list` print

let prevCpu = null;
/** CPU utilisation (all cores) since the previous poll, from the kernel's per-core tick counters — no process is started. */
function cpuStats() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    for (const k of Object.keys(c.times)) total += c.times[k];
    idle += c.times.idle;
  }
  const prev = prevCpu;
  prevCpu = { idle, total };
  if (!prev || total <= prev.total) return { pct: null, cores: cpus.length };
  const pct = Math.round((1 - (idle - prev.idle) / (total - prev.total)) * 100);
  return { pct: Math.max(0, Math.min(100, pct)), cores: cpus.length };
}

/** Apple Silicon / AMD GPU via the IOAccelerator registry (no sudo needed). */
async function gpuStats() {
  const out = await run('/usr/sbin/ioreg', ['-r', '-d', '1', '-w0', '-c', 'IOAccelerator']);
  const util = num(out, /"Device Utilization %"=(\d+)/);
  if (util === null) return null;
  const used = num(out, /"In use system memory"=(\d+)/);
  const name = (out.match(/"model" = "([^"]+)"/) || [])[1] || 'GPU';
  const cores = num(out, /"gpu-core-count" = (\d+)/);
  return { util: Math.min(100, util), usedGB: used === null ? null : gb(used), name, cores };
}

/** Unified/system memory: "available" = free + inactive + speculative + purgeable pages (what macOS can hand out). */
async function memStats() {
  const total = os.totalmem();
  const out = await run('/usr/bin/vm_stat', []);
  const page = num(out, /page size of (\d+) bytes/) || 16384;
  const pages = (k) => num(out, new RegExp(`${k}:\\s+(\\d+)`)) || 0;
  const avail = (pages('Pages free') + pages('Pages inactive') + pages('Pages speculative') + pages('Pages purgeable')) * page;
  const availB = Math.min(total, avail || os.freemem());
  return { totalGB: gb(total), availGB: gb(availB), usedGB: gb(total - availB), usedPct: Math.round(((total - availB) / total) * 100) };
}

// extra Ollama servers to read (the managed KV engine listens on its own private port)
let extraBases = () => [];
const setExtraBases = (fn) => { extraBases = fn; };

/** Models currently resident in Ollama (what the app is "using"): the user's server plus the managed KV engine. */
async function modelStats() {
  const shared = process.env.OLLAMA_HOST ? (/^https?:/.test(process.env.OLLAMA_HOST) ? process.env.OLLAMA_HOST : `http://${process.env.OLLAMA_HOST}`) : 'http://127.0.0.1:11434';
  const bases = [shared, ...extraBases().filter((b) => b && b !== shared)];
  const lists = await Promise.all(
    bases.map(async (base) => {
      try {
        const r = await fetch(`${base}/api/ps`, { signal: AbortSignal.timeout(900) });
        const j = await r.json();
        return (j.models || []).map((m) => ({ name: m.name, sizeGB: gbDec(m.size || 0), gpuPct: m.size ? Math.round(((m.size_vram || 0) / m.size) * 100) : 0, ctx: m.context_length || null, managed: base !== shared }));
      } catch {
        return [];
      }
    })
  );
  return lists.flat();
}

async function snapshot() {
  const [gpu, mem, models] = await Promise.all([gpuStats(), memStats(), modelStats()]);
  return { cpu: cpuStats(), gpu, mem, models, at: Date.now() };
}

/** Poll while `isActive()` is true. Returns a stop function. */
function startPolling(send, isActive, ms = 2000) {
  let busy = false;
  const tick = async () => {
    if (busy || !isActive()) return;
    busy = true;
    try {
      send(await snapshot());
    } finally {
      busy = false;
    }
  };
  tick();
  const t = setInterval(tick, ms);
  return () => clearInterval(t);
}

module.exports = { snapshot, startPolling, cpuStats, gpuStats, memStats, modelStats, setExtraBases };
