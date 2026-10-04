'use strict';
// Managed engine: a private `ollama serve` that runs with the KV-cache settings the planner picked.
//
// Ollama applies the KV cache type server-wide (OLLAMA_KV_CACHE_TYPE, needs OLLAMA_FLASH_ATTENTION=1) and its runner is
// llama.cpp's llama-server, so the only way for the app to get a quantized KV cache is to run its own server with that
// environment. It listens on 127.0.0.1 on a private port, shares the user's model store (nothing is downloaded or
// copied) and is stopped when the app quits. The user's own Ollama (default :11434) is left untouched and is still used
// for f16 and for everything that is not a model run (tags, pulls).
//
// Disabled when OLLAMA_HOST points elsewhere (remote / test servers) or AIT_KV_ENGINE=off.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const READY_MS = 20000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const portFree = (port) =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });

class KvEngine {
  constructor({ dataDir, basePort = 11435, bin = process.env.AIT_OLLAMA_BIN || 'ollama' } = {}) {
    this.bin = bin;
    this.basePort = basePort;
    this.available = !process.env.OLLAMA_HOST && process.env.AIT_KV_ENGINE !== 'off';
    this.pidFile = dataDir ? path.join(dataDir, 'kv-engine.json') : null;
    this.child = null;
    this.type = null; // KV type the running server was started with
    this.base = null; // http://127.0.0.1:<port>
    this.starting = null;
    this._reapStale();
  }

  /** A previous run that crashed may have left its server behind: stop it (only if the pid is really an ollama process). */
  _reapStale() {
    if (!this.pidFile) return;
    try {
      const { pid } = JSON.parse(fs.readFileSync(this.pidFile, 'utf8'));
      const cmd = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (/ollama/.test(cmd) && /serve/.test(cmd)) process.kill(pid, 'SIGTERM');
    } catch { /* nothing stale */ }
    try { fs.rmSync(this.pidFile, { force: true }); } catch { /* ignore */ }
  }

  async _healthy(base) {
    try {
      await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(1500) });
      return true;
    } catch {
      return false;
    }
  }

  /** Make sure a server with `kvType` is running; returns its base URL. Concurrent callers share one start. */
  async ensure(kvType) {
    if (!this.available) throw new Error('managed engine disabled');
    if (this.child && this.type === kvType && this.base && (await this._healthy(this.base))) return this.base;
    if (this.starting) {
      await this.starting.catch(() => {});
      if (this.type === kvType && this.base) return this.base;
    }
    this.starting = this._start(kvType);
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async _start(kvType) {
    await this.stop();
    let port = this.basePort;
    while (!(await portFree(port)) && port < this.basePort + 20) port++;
    const base = `http://127.0.0.1:${port}`;
    const env = { ...process.env, OLLAMA_HOST: `127.0.0.1:${port}`, OLLAMA_FLASH_ATTENTION: '1', OLLAMA_KV_CACHE_TYPE: kvType, OLLAMA_NUM_PARALLEL: '1', OLLAMA_MAX_LOADED_MODELS: '1' };
    const child = spawn(this.bin, ['serve'], { env, stdio: 'ignore' });
    let died = false;
    child.on('error', () => { died = true; });
    child.on('exit', () => { died = true; if (this.child === child) { this.child = null; this.base = null; this.type = null; } });
    this.child = child;
    const t0 = Date.now();
    while (Date.now() - t0 < READY_MS) {
      await sleep(250);
      if (died) break;
      if (await this._healthy(base)) {
        this.type = kvType;
        this.base = base;
        if (this.pidFile) { try { fs.writeFileSync(this.pidFile, JSON.stringify({ pid: child.pid, port, type: kvType })); } catch { /* ignore */ } }
        return base;
      }
    }
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    this.child = null;
    throw new Error(died ? 'ollama serve exited' : 'managed engine did not become ready');
  }

  async stop() {
    const c = this.child;
    this.child = null;
    this.base = null;
    this.type = null;
    if (!c) return;
    await new Promise((resolve) => {
      const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* ignore */ } resolve(); }, 4000);
      c.once('exit', () => { clearTimeout(t); resolve(); });
      try { c.kill('SIGTERM'); } catch { clearTimeout(t); resolve(); }
    });
    if (this.pidFile) { try { fs.rmSync(this.pidFile, { force: true }); } catch { /* ignore */ } }
  }

  dispose() {
    const c = this.child;
    this.child = null;
    if (c) { try { c.kill('SIGTERM'); } catch { /* ignore */ } }
    if (this.pidFile) { try { fs.rmSync(this.pidFile, { force: true }); } catch { /* ignore */ } }
  }
}

module.exports = { KvEngine };
