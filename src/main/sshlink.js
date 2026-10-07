'use strict';
// One non-interactive route to a server, shared by everything the app runs besides the user's own terminal session
// (resource monitor, file panel). It never asks for or sends a password (BatchMode) and reuses a connection that already
// exists whenever there is one:
//   mode 'config'  a connection the user's own ssh configuration shares (ControlPath in ~/.ssh/config or on the command line)
//   mode 'user'    the shared connection of a session opened from the app's SSH menu (<ctl>/%C)
//   mode 'own'     the app's own connection on <ctl>/m-%C, kept alive for a minute between uses
// A connection that belongs to the user's interactive session is only ever REUSED (ControlMaster=no); `-O exit` is sent for
// the app's own connection alone — ending the user's master would disconnect them.
const { execFile, spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

// options of the user's own ssh command that are safe and needed to reach the same server again
const KEEP_OPTS = ['proxyjump', 'proxycommand', 'port', 'user', 'hostname', 'identityfile', 'identitiesonly', 'userknownhostsfile', 'globalknownhostsfile', 'certificatefile', 'hostkeyalias', 'kexalgorithms', 'ciphers', 'macs', 'hostkeyalgorithms', 'pubkeyacceptedalgorithms', 'controlpath'];
const CTL_DIR = path.join('/tmp', `ait-ssh-${process.getuid ? process.getuid() : 'u'}`);

/** Directory for the shared connections (short path: unix socket paths are limited to ~100 characters). */
function controlDir() {
  try {
    fs.mkdirSync(CTL_DIR, { recursive: true, mode: 0o700 });
    const st = fs.statSync(CTL_DIR);
    if (process.getuid && st.uid !== process.getuid()) return null; // somebody else's directory: do not use it
    fs.chmodSync(CTL_DIR, 0o700);
    return CTL_DIR;
  } catch { return null; }
}

/** The ssh options that reach `target` (as parsed from the user's command) in `mode`, without any chance of a prompt. */
function connOptions(target, { ctl = controlDir(), mode = 'own', connectTimeout = 6 } = {}) {
  const a = ['-T', '-o', 'BatchMode=yes', '-o', `ConnectTimeout=${connectTimeout}`, '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2', '-o', 'LogLevel=ERROR'];
  if (mode === 'user' && ctl) a.push('-o', 'ControlMaster=no', '-o', `ControlPath=${ctl}/%C`);
  else if (mode === 'config') a.push('-o', 'ControlMaster=no');
  else if (ctl) a.push('-o', 'ControlMaster=auto', '-o', `ControlPath=${ctl}/m-%C`, '-o', 'ControlPersist=60');
  if (target.configFile) a.push('-F', target.configFile);
  if (target.port) a.push('-p', String(target.port));
  if (target.user) a.push('-l', target.user);
  if (target.jump) a.push('-J', target.jump);
  for (const f of target.identityFiles || []) a.push('-i', f);
  for (const [k, v] of Object.entries(target.options || {})) {
    if (KEEP_OPTS.includes(k) && !/[\n\r\0]/.test(v)) a.push('-o', `${k}=${v}`);
  }
  return a;
}
const hostOf = (t) => (t.alias && !t.hostName ? t.alias : t.hostName || t.host);

/** `ssh [-O check] <options> -- host [command]` */
function sshArgs(target, { command, check = false, ...opts } = {}) {
  const a = [...(check ? ['-O', 'check'] : []), ...connOptions(target, opts), '--', hostOf(target)];
  if (!check && command) a.push(command);
  return a;
}

class SshLink extends EventEmitter {
  /** @param {object} target parsed ssh target (ssh.js parseSshArgs / SshWatcher) */
  constructor(target, { ctl, sshBin = '/usr/bin/ssh', execImpl, spawnImpl } = {}) {
    super();
    this.target = target;
    this.ctl = ctl === undefined ? controlDir() : ctl;
    this.sshBin = sshBin;
    this.users = 0;
    this._mode = null;
    this._detecting = null;
    this.children = new Set();
    this._exec = execImpl || ((args, stdin, opts = {}) => new Promise((resolve) => {
      const child = execFile(this.sshBin, args, { timeout: opts.timeoutMs || 20000, maxBuffer: opts.maxBuffer || (4 << 20), env: { ...process.env, SSH_ASKPASS: '', DISPLAY: '' } }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
      child.stdin.on('error', () => {});
      if (opts.signal) opts.signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
      if (stdin !== undefined) child.stdin.end(stdin); else child.stdin.end();
    }));
    this._spawn = spawnImpl || ((args) => spawn(this.sshBin, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, SSH_ASKPASS: '', DISPLAY: '' } }));
  }

  get mode() {
    return this._mode || 'own';
  }

  /** Decide once which connection to use; call invalidate() after a failure to look again. */
  async ready() {
    if (this._mode) return this._mode;
    if (!this._detecting) {
      this._detecting = (async () => {
        const tries = [['config', { mode: 'config' }]];
        if (this.ctl) tries.push(['user', { mode: 'user' }]);
        for (const [mode, o] of tries) {
          const r = await this._exec(sshArgs(this.target, { ctl: this.ctl, check: true, ...o }), undefined, { timeoutMs: 8000 });
          if (r.code === 0 && /Master running/i.test(r.stderr + r.stdout)) return (this._mode = mode);
        }
        return (this._mode = 'own');
      })().finally(() => { this._detecting = null; });
    }
    return this._detecting;
  }
  invalidate() {
    this._mode = null;
  }

  /** Run `command` (one string, interpreted by the remote login shell) and collect its output. */
  async exec(command, { stdin, timeoutMs, maxBuffer, signal } = {}) {
    const mode = await this.ready();
    return this._exec(sshArgs(this.target, { ctl: this.ctl, mode, command }), stdin, { timeoutMs, maxBuffer, signal });
  }

  /** Start `command` and hand back the child process (stdin / stdout streams) — for file transfers. */
  async child(command) {
    const mode = await this.ready();
    const c = this._spawn(sshArgs(this.target, { ctl: this.ctl, mode, command }));
    this.children.add(c);
    c.on('close', () => this.children.delete(c));
    return c;
  }

  /**
   * Start `ssh -W host:port` (stdio is the connection to host:port, seen from the server) and hand back the child process.
   * No local port is opened; the connection is the same one the other features use. host / port must be validated by the caller.
   */
  async forward(host, port) {
    const mode = await this.ready();
    const a = [...connOptions(this.target, { ctl: this.ctl, mode }), '-o', 'ExitOnForwardFailure=yes', '-W', `${host}:${port}`, '--', hostOf(this.target)];
    const c = this._spawn(a);
    this.children.add(c);
    c.on('close', () => this.children.delete(c));
    return c;
  }

  retain() {
    this.users++;
  }
  /** The last user of the app's OWN connection closes it; a shared connection of the user is left alone. */
  release() {
    this.users = Math.max(0, this.users - 1);
    if (this.users === 0) this.close();
  }
  close() {
    for (const c of this.children) { try { c.kill('SIGTERM'); } catch { /* gone */ } }
    this.children.clear();
    if (this._mode === 'own' && this.ctl) {
      const args = sshArgs(this.target, { ctl: this.ctl, mode: 'own', check: true });
      args[1] = 'exit';
      try { const c = this._spawn(args); if (c && c.on) c.on('error', () => {}); if (c && c.unref) c.unref(); } catch { /* no ssh binary */ }
    }
    this._mode = null;
  }
}

module.exports = { SshLink, sshArgs, connOptions, controlDir, hostOf, KEEP_OPTS, CTL_DIR };
