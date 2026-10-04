'use strict';
// A real shell running in a PTY. The same session serves the user's keystrokes and the AI's commands,
// so cwd / env / shell state are always identical for both.
const os = require('os');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const { OscScanner } = require('./osc');
const { cleanTerminalText, stripAnsi, truncateMiddle, maskSecrets } = require('./text');
const { sentinelLine, SHELL_PROBE, parseShellProbe } = require('./ssh');

// zsh must read these files from the real filesystem, not from inside app.asar
const INTEGRATION_DIR = path.join(__dirname, 'shell-integration', 'zsh').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
const BASH_RC = path.join(__dirname, 'shell-integration', 'bash', 'ait.bashrc').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
const FISH_INIT = path.join(__dirname, 'shell-integration', 'fish', 'ait.fish').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
const VIM_DIR = path.join(__dirname, 'shell-integration', 'vim').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
const PASSWORD_PROMPT = /(?:password|passphrase|암호|비밀번호)[^\n]{0,40}[:：]\s*$|\[sudo\][^\n]*:\s*$/i;

class Capture {
  constructor(headMax = 6000, tailMax = 6000) {
    this.headMax = headMax;
    this.tailMax = tailMax;
    this.head = '';
    this.tail = '';
    this.total = 0;
  }
  push(t) {
    this.total += t.length;
    if (this.head.length < this.headMax) {
      const room = this.headMax - this.head.length;
      this.head += t.slice(0, room);
      t = t.slice(room);
    }
    if (t) {
      this.tail += t;
      if (this.tail.length > this.tailMax * 2) this.tail = this.tail.slice(-this.tailMax);
    }
  }
  raw() {
    const tail = this.tail.slice(-this.tailMax);
    const dropped = this.total - this.head.length - tail.length;
    return dropped > 0 ? `${this.head}\n…[${dropped}자 생략]…\n${tail}` : this.head + tail;
  }
}

class PtySession extends EventEmitter {
  constructor({ cwd, cols = 100, rows = 30, shell, themeFile } = {}) {
    super();
    this.themeFile = themeFile || '';
    this.shell = shell || process.env.SHELL || '/bin/zsh';
    this.cwd = cwd || os.homedir();
    this.cols = cols;
    this.rows = rows;
    this.state = 'starting'; // starting | prompt | busy | exited
    this.integrated = false; // got at least one prompt marker
    this.history = []; // finished commands (user + AI)
    this.active = null; // currently running command record
    this.lastExit = 0;
    this.scanner = new OscScanner();
    this.pty = null;
    this._pendingStart = null; // AI command written, waiting for start marker
  }

  get shellName() {
    return path.basename(this.shell);
  }

  /** zsh, bash and fish report command boundaries; anything else is a plain terminal (AI uses sentinel mode). */
  get supportsIntegration() {
    return ['zsh', 'bash', 'fish'].includes(this.shellName);
  }

  start() {
    const pty = require('node-pty');
    const env = { ...process.env };
    for (const k of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'ELECTRON_ENABLE_LOGGING', 'NODE_OPTIONS']) delete env[k];
    Object.assign(env, {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'AITerminal',
      LANG: env.LANG && /UTF-?8/i.test(env.LANG) ? env.LANG : 'en_US.UTF-8',
    });
    if (!env.LC_ALL || !/UTF-?8/i.test(env.LC_ALL)) delete env.LC_ALL;
    // Bundled Vim setup (line numbers, statusline, per-language settings, F5/F6/F7 ...). AIT_VIM=0 disables it.
    if (process.env.AIT_VIM !== '0' && !process.env.VIMINIT) {
      env.AIT_VIM_DIR = VIM_DIR;
      env.AIT_THEME_FILE = this.themeFile;
      env.VIMINIT = 'exe "source ".fnameescape($AIT_VIM_DIR."/ait.vim")';
    }
    let args = ['-l', '-i'];
    if (this.shellName === 'zsh') {
      env.AIT_USER_ZDOTDIR = process.env.ZDOTDIR || '';
      env.ZDOTDIR = INTEGRATION_DIR;
    } else if (this.shellName === 'bash') {
      args = ['--rcfile', BASH_RC, '-i'];
    } else if (this.shellName === 'fish') {
      args = ['-i', '-l', '--init-command', `source ${FISH_INIT.replace(/ /g, '\\ ')}`];
    }
    let cwd = this.cwd;
    try {
      if (!fs.statSync(cwd).isDirectory()) cwd = os.homedir();
    } catch {
      cwd = os.homedir();
    }
    this.cwd = cwd;
    this.pty = pty.spawn(this.shell, args, { name: 'xterm-256color', cols: this.cols, rows: this.rows, cwd, env });
    this.pid = this.pty.pid;
    this.pty.onData((d) => this._onData(d));
    this.pty.onExit(({ exitCode }) => {
      this.state = 'exited';
      this.emit('state', this.snapshot());
      this.emit('exit', exitCode);
    });
    if (!this.supportsIntegration) {
      this.state = 'prompt'; // can't know better; AI execution stays disabled
    }
    return this;
  }

  snapshot() {
    return { state: this.state, cwd: this.cwd, integrated: this.integrated, lastExit: this.lastExit, pid: this.pid };
  }

  write(data) {
    if (this.pty && this.state !== 'exited') this.pty.write(data);
  }
  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    try {
      this.pty && this.pty.resize(Math.max(2, cols), Math.max(1, rows));
    } catch {
      /* pty may have exited */
    }
  }
  interrupt() {
    this.write('\x03');
  }
  kill() {
    try {
      this.pty && this.pty.kill();
    } catch {
      /* already gone */
    }
  }

  // ---- output pipeline ----
  _onData(chunk) {
    for (const item of this.scanner.push(chunk)) {
      if (item.text !== undefined) this._onText(item.text);
      else this._onEvent(item.event);
    }
  }

  _onText(text) {
    if (!text) return;
    // a full-screen program (vim, top, less …) switches to the alternate screen: nothing may be typed into it for the AI
    // (the sequence often arrives split across two chunks, ESC first: keep the last few characters)
    const probe = (this._escTail || '') + text;
    this._escTail = probe.slice(-12);
    let alt;
    for (const m of probe.matchAll(/\x1b\[\?(?:1049|1047|47)([hl])/g)) alt = m[1] === 'h';
    if (alt !== undefined) this.altScreen = alt;
    this._lastDataAt = Date.now();
    this.emit('data', text);
    if (this._sent) this._feedSentinel(text);
    const a = this.active;
    if (a && !a.done) {
      a.capture.push(text);
      a.lastOutputAt = Date.now();
      if (a.waitingInput && /\S/.test(stripAnsi(text)) && !PASSWORD_PROMPT.test(cleanTerminalText(text))) a.waitingInput = false;
      const tail = cleanTerminalText(a.capture.tail.slice(-300) || a.capture.head.slice(-300));
      if (!a.waitingInput && PASSWORD_PROMPT.test(tail)) {
        a.waitingInput = true;
        a.inputSince = Date.now();
        this.emit('sensitive-input', { command: a.command });
      }
    }
  }

  _onEvent(ev) {
    if (ev.type === 'start') {
      this.state = 'busy';
      this.emit('command-start', { command: ev.command, by: this._pendingStart ? 'ai' : 'user', at: Date.now() });
      this.active = {
        command: ev.command,
        by: this._pendingStart ? 'ai' : 'user',
        capture: new Capture(),
        startedAt: Date.now(),
        lastOutputAt: Date.now(),
        done: false,
        exitCode: null,
        waitingInput: false,
        cwd: this.cwd,
      };
      if (this._pendingStart) {
        this._pendingStart.started = true;
        this._pendingStart = null;
      }
    } else if (ev.type === 'ask') {
      let payload = null;
      try { payload = JSON.parse(ev.json); } catch { /* malformed request from a program that is not our vim setup */ }
      if (payload) this.emit('vim-ask', payload);
      return;
    } else if (ev.type === 'end') {
      this.integrated = true;
      if (ev.cwd) this.cwd = ev.cwd;
      this.lastExit = Number.isFinite(ev.exitCode) ? ev.exitCode : 0;
      const a = this.active;
      if (a && !a.done) {
        a.done = true;
        a.exitCode = this.lastExit;
        a.endedAt = Date.now();
        this.history.push(this._record(a));
        if (this.history.length > 30) this.history.shift();
      } else if (this._pendingStart) {
        // A "command" that never reached preexec (empty / comment-only line)
        this._pendingStart.noop = true;
      }
      this.state = 'prompt';
      this.altScreen = false;
      this._escTail = '';
      this.emit('command-end', a && a.done ? this.history[this.history.length - 1] : null);
    }
    this.emit('state', this.snapshot());
  }

  _record(a) {
    return {
      command: a.command,
      by: a.by,
      exitCode: a.exitCode,
      cwd: a.cwd,
      durationMs: (a.endedAt || Date.now()) - a.startedAt,
      output: truncateMiddle(maskSecrets(cleanTerminalText(a.capture.raw()).trimEnd()), 2400),
      outputRaw: cleanTerminalText(a.capture.raw()).trimEnd().slice(-20000), // for the user's own copy (never sent to a model)
    };
  }

  /** Cleaned + masked + bounded output of the active/last command. */
  outputOf(a, max = 3500) {
    return truncateMiddle(maskSecrets(cleanTerminalText(a.capture.raw()).trimEnd()), max);
  }

  // ---- sentinel mode: run commands inside a foreground shell we cannot instrument (ssh, nested shell, unknown shells) ----
  _feedSentinel(text) {
    const sent = this._sent;
    sent.raw += text;
    sent.lastAt = Date.now();
    const clean = cleanTerminalText(sent.raw);
    if (sent.ready && !sent.readyFired && sent.ready.re.test(clean)) {
      sent.readyFired = true;
      Promise.resolve().then(() => sent.ready.then());
    }
    const m = clean.match(new RegExp(`${sent.marker}:(\\d+):([^\\n]*?)__`));
    if (!m) return;
    // The echo of the typed line must be removed from the RAW text: when the remote readline wraps the line it sends
    // " \r" at the margin, and cleanTerminalText would turn that carriage return into an overwrite of the line start.
    const plain = stripAnsi(sent.raw);
    const at = plain.search(new RegExp(`${sent.marker}:\\d+:`));
    let body = at >= 0 ? afterEcho(plain.slice(0, at), `${sent.marker}EOL`) : null;
    if (body !== null) { if (!sent.rawMode) body = cleanTerminalText(body); }
    else {
      const before = clean.slice(0, clean.indexOf(m[0]));
      const lines = before.split('\n');
      if (lines.length && lines[0].includes(sent.marker)) lines.shift();
      if (lines.length && lines[0].trim() === sent.command.trim()) lines.shift();
      body = lines.join('\n');
    }
    this._sent = null;
    // raw: for callers that parse the output themselves (file contents must stay byte-exact: no trim, no masking, no cut);
    // the pty turns every \n into \r\n, undo that and nothing else
    const output = sent.rawMode ? body.replace(/\r\n/g, '\n').slice(0, 1500000) : truncateMiddle(maskSecrets(body.trim()), sent.maxChars);
    sent.resolve({ status: 'done', exitCode: Number(m[1]), cwd: m[2], output, durationMs: Date.now() - sent.startedAt });
  }

  /**
   * Type `command` into the foreground program (an ssh session, a nested shell …) followed by a marker that reports the
   * exit status and cwd. Requires a shell at its prompt; `kind` selects the syntax (posix | fish | csh).
   * Resolves { status: done | running | aborted | busy | disconnected | waiting_input | fullscreen, exitCode, cwd, output }.
   *   disconnected   the foreground program ended (ssh closed, shell exited) while we waited
   *   waiting_input  a password / passphrase prompt is waiting for the user (the AI never types those)
   *   fullscreen     vim / top / less … owns the screen; typing into it would be harmful
   * `ready` ({ re, then }) runs `then` once `re` matched the output — used to start streaming input after the remote side
   * has switched its echo off (see uploadToRemote).
   */
  async runSentinel(command, opts = {}) {
    if (this.state !== 'busy') return { status: 'disconnected', output: '', exitCode: null };
    if (this._sent || this._sentPending) return { status: 'busy', output: '', exitCode: null };
    // the previous marker line is still being wiped and the prompt redrawn: typing now would interleave with it
    this._sentPending = true;
    try {
      const until = Date.now() + 1500;
      while (Date.now() - (this._lastDataAt || 0) < 150 && Date.now() < until) await sleep(20);
    } finally {
      this._sentPending = false;
    }
    return this._runSentinelNow(command, opts);
  }

  _runSentinelNow(command, { maxMs = 60000, signal, kind = 'posix', maxChars = 3500, ready, raw = false } = {}) {
    return new Promise((resolve) => {
      if (this.state !== 'busy') return resolve({ status: 'disconnected', output: '', exitCode: null });
      if (this._sent) return resolve({ status: 'busy', output: '', exitCode: null });
      if (this.altScreen) return resolve({ status: 'fullscreen', output: '', exitCode: null });
      const id = (this._sentSeq = (this._sentSeq || 0) + 1);
      const marker = `__AIT${process.pid}X${id}END`;
      const done = (r) => {
        clearInterval(poll);
        resolve(r);
      };
      const sent = { marker, command, raw: '', startedAt: Date.now(), lastAt: Date.now(), resolve: done, maxChars, ready, rawMode: raw };
      this._sent = sent;
      const outNow = () => truncateMiddle(maskSecrets(cleanTerminalText(sent.raw).trim()), maxChars);
      const poll = setInterval(() => {
        if (this._sent !== sent) return;
        if (signal && signal.aborted) {
          this._sent = null;
          this.interrupt();
          return done({ status: 'aborted', output: cleanTerminalText(sent.raw).slice(-1500), exitCode: null });
        }
        if (this.state !== 'busy') {
          this._sent = null;
          return done({ status: 'disconnected', output: outNow(), exitCode: null });
        }
        if (Date.now() - sent.startedAt > maxMs) {
          this._sent = null;
          return done({ status: 'running', output: outNow(), exitCode: null });
        }
        const lastLine = cleanTerminalText(sent.raw).split('\n').pop();
        if (Date.now() - sent.lastAt > 800 && PASSWORD_PROMPT.test(lastLine)) {
          this._sent = null;
          return done({ status: 'waiting_input', output: outNow(), exitCode: null });
        }
      }, 200);
      // the marker prints on its own line and then wipes that line, so the remote terminal stays clean
      this.pty.write(sentinelLine(kind, command, marker));
    });
  }

  /**
   * Learn the login shell of the far side with a line that every shell understands, before the shell-specific sentinel can
   * be chosen. Resolves { status: 'done', shell } | { status: disconnected | busy | fullscreen | waiting_input | timeout }.
   */
  async probeLoginShell({ maxMs = 6000, signal } = {}) {
    if (this.state !== 'busy') return { status: 'disconnected' };
    if (this._sent || this._sentPending) return { status: 'busy' };
    if (this.altScreen) return { status: 'fullscreen' };
    this._sentPending = true;
    try {
      const until = Date.now() + 1500;
      while (Date.now() - (this._lastDataAt || 0) < 150 && Date.now() < until) await sleep(20);
    } finally {
      this._sentPending = false;
    }
    let raw = '';
    const on = (t) => { raw += t; };
    this.on('data', on);
    try {
      this.write(`\x15${SHELL_PROBE}\r`);
      const t0 = Date.now();
      let lastAt = Date.now();
      let seen = 0;
      while (Date.now() - t0 < maxMs) {
        if (signal && signal.aborted) return { status: 'aborted' };
        if (this.state !== 'busy') return { status: 'disconnected' };
        const shell = parseShellProbe(cleanTerminalText(raw));
        if (shell) return { status: 'done', shell };
        if (raw.length !== seen) { seen = raw.length; lastAt = Date.now(); }
        if (Date.now() - lastAt > 800 && PASSWORD_PROMPT.test(cleanTerminalText(raw).split('\n').pop())) return { status: 'waiting_input' };
        await sleep(60);
      }
      return { status: 'timeout' };
    } finally {
      this.off('data', on);
    }
  }

  /**
   * Send `lines` as the standard input of `cat > dest` on the remote side, with the remote tty echo switched off so the
   * data does not flood the user's terminal (POSIX shells only). The echo is restored by a trap, also on Ctrl-C / disconnect.
   * Resolves like runSentinel (the status of the `cat`).
   */
  uploadToRemote(destQuoted, lines, { signal, maxMs = 180000 } = {}) {
    const id = (this._upSeq = (this._upSeq || 0) + 1);
    const rdy = `AITRDY${process.pid}U${id}`;
    const command = `( trap 'stty echo' EXIT INT TERM; stty -echo; printf '${rdy}%s\\n' go; cat > ${destQuoted} )`;
    const send = async () => {
      let i = 0;
      while (i < lines.length) {
        if (signal && signal.aborted) return;
        const batch = lines.slice(i, i + 16).join('\n') + '\n';
        i += 16;
        this.write(batch);
        await sleep(4); // let the pty drain: a remote canonical tty keeps only a few KB in flight
      }
      this.write('\x04'); // EOF for cat (the last data line ended with a newline)
    };
    return this.runSentinel(command, { maxMs, signal, kind: 'posix', maxChars: 800, ready: { re: new RegExp(`${rdy}go`), then: send } });
  }

  // ---- AI execution ----
  /**
   * Type `command` into the live shell (visible to the user) and wait for completion.
   * Resolves { status: done|running|not_started|aborted|waiting_input|busy, exitCode, output, durationMs }.
   */
  async runCommand(command, { idleMs = 8000, maxMs = 60000, signal } = {}) {
    if (!this.integrated || !this.supportsIntegration) return { status: 'unsupported', output: '', exitCode: null };
    if (this.state !== 'prompt') return { status: 'busy', output: '', exitCode: null };
    const marker = { started: false, noop: false };
    this._pendingStart = marker;
    this.pty.write(`\x15${command}\r`); // ^U clears any half-typed input first
    const t0 = Date.now();
    while (!marker.started && !marker.noop) {
      if (signal && signal.aborted) {
        this._pendingStart = null;
        this.interrupt();
        return { status: 'aborted', output: '', exitCode: null };
      }
      if (Date.now() - t0 > 4000) {
        this._pendingStart = null;
        this.interrupt(); // e.g. unbalanced quote left the shell at a continuation prompt
        await sleep(300);
        return { status: 'not_started', output: '', exitCode: null };
      }
      await sleep(25);
    }
    if (marker.noop) return { status: 'done', exitCode: this.lastExit, output: '', durationMs: Date.now() - t0 };
    return this.waitActive({ idleMs, maxMs, signal });
  }

  /** Wait for the active command to finish (or go idle / time out). */
  async waitActive({ idleMs = 8000, maxMs = 60000, signal } = {}) {
    const t0 = Date.now();
    for (;;) {
      const a = this.active;
      if (!a) return { status: 'done', exitCode: this.lastExit, output: '', durationMs: 0 };
      const now = Date.now();
      const base = { exitCode: a.exitCode, durationMs: now - a.startedAt, output: this.outputOf(a) };
      if (a.done) return { ...base, status: 'done', exitCode: a.exitCode };
      if (signal && signal.aborted) {
        this.interrupt();
        const until = Date.now() + 2000;
        while (Date.now() < until && !a.done) await sleep(50);
        return { ...base, output: this.outputOf(a), status: 'aborted', exitCode: a.exitCode };
      }
      if (a.waitingInput) {
        if (now - a.inputSince > 180000) return { ...base, status: 'running' };
        if (!a.reportedInput) {
          a.reportedInput = true;
          this._inputNotified = true;
        }
        await sleep(100);
        continue;
      }
      if (now - t0 >= maxMs) return { ...base, status: 'running' };
      if (now - a.lastOutputAt >= idleMs && now - t0 >= idleMs) return { ...base, status: 'running' };
      await sleep(100);
    }
  }

  get isAwaitingUserInput() {
    return !!(this.active && !this.active.done && this.active.waitingInput);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Text after the line that ends with `token` (whitespace and line breaks inside the token are ignored); null if absent. */
function afterEcho(text, token) {
  const idx = [];
  let flat = '';
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) continue;
    flat += text[i];
    idx.push(i);
  }
  const at = flat.indexOf(token);
  if (at < 0) return null;
  const end = idx[at + token.length - 1];
  const nl = text.indexOf('\n', end);
  // bash 5 (every current Linux) ends a command line with `ESC[?2004l CR` (bracketed paste off): once the escape is stripped a bare
  // CR is left in front of the output, which must not become part of it
  return nl >= 0 ? text.slice(nl + 1).replace(/^\r+/, '') : '';
}

module.exports = { PtySession, Capture, sleep, VIM_DIR, afterEcho };
