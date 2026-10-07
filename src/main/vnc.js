'use strict';
// The remote screen (VNC) of one SSH tab. The picture is drawn by noVNC in the window; this file only moves the bytes:
//
//   noVNC (window) <-> IPC <-> VncBridge <-> `ssh -W 127.0.0.1:<port>` (the tab's shared connection) <-> sshd <-> VNC server
//
// No local port is opened and nothing listens on this Mac. Bytes are merged into few IPC messages and the window confirms what
// it has processed, so a hidden or slow window cannot make the buffers grow (see docs/VNC_CODE_GUIDE.md, R3 and R4).
// The VNC password never passes through here in clear text and is never stored: noVNC answers the server's challenge itself.
//
// Events to the window (via `send`):  vnc:data { vid, data }   vnc:end { vid, code }
// Error codes: no-ssh bad-target too-many refused forbidden auth timeout not-vnc closed dropped failed
const { EventEmitter } = require('events');

const HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const HOST_V6 = /^\[[0-9A-Fa-f:.]{2,45}\]$/;

/** The server-side destination: a plain host name / IPv4 / bracketed IPv6 literal and a port. Default host: the server itself. */
function validateTarget(input) {
  const i = input && typeof input === 'object' ? input : {};
  const host = i.host === undefined || i.host === null || i.host === '' ? '127.0.0.1' : i.host;
  const port = typeof i.port === 'string' && /^\d{1,5}$/.test(i.port) ? Number(i.port) : i.port;
  if (typeof host !== 'string' || !(HOST_NAME.test(host) || HOST_V6.test(host))) return { ok: false, code: 'bad-target' };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, code: 'bad-target' };
  return { ok: true, host, port };
}

/** What ssh said when it gave up (stderr, LogLevel=ERROR) -> an error code the window can translate. */
function classify(stderr, gotData) {
  const s = String(stderr || '');
  if (/administratively prohibited|forwarding is (disabled|not allowed)/i.test(s)) return 'forbidden';
  // over the shared connection ssh only says "Session open refused by peer": nothing listens on that port (or forwarding is off)
  if (/Connection refused|Session open refused by peer|open failed|Stdio forwarding (request )?failed/i.test(s)) return 'refused';
  if (/Permission denied|publickey|Host key verification|no such identity|too many authentication/i.test(s)) return 'auth';
  return gotData ? 'dropped' : 'failed';
}

const DEFAULTS = {
  flushMs: 4, // merge the pieces that arrive within this time into one message
  chunk: 64 * 1024, // ...or as soon as this many bytes are waiting
  high: 1024 * 1024, // stop reading from ssh while more than this is unconfirmed
  low: 256 * 1024, // ...and continue below this
  maxWrite: 1024 * 1024, // largest message accepted from the window
  firstByteMs: 15000, // a VNC server speaks first; silence this long means it is not one
  maxPerTab: 1,
  maxTotal: 4,
};
const active = new Set(); // every running session of the app (R8)

class VncBridge extends EventEmitter {
  /**
   * @param {{link: () => (object|null), send: (channel: string, payload: object) => void, limits?: object}} o
   *   link: the tab's SshLink (or null while no ssh session is active); send: tab id is added by the caller
   */
  constructor({ link, send, limits = {} }) {
    super();
    this.link = link;
    this.send = send;
    this.L = { ...DEFAULTS, ...limits };
    this.sessions = new Map();
    this.seq = 0;
  }

  /** @returns {Promise<{ok: true, vid: number} | {ok: false, code: string}>} */
  async open(input) {
    const v = validateTarget(input);
    if (!v.ok) return v;
    const link = this.link();
    if (!link) return { ok: false, code: 'no-ssh' };
    if (this.sessions.size >= this.L.maxPerTab || active.size >= this.L.maxTotal) return { ok: false, code: 'too-many' };
    const vid = ++this.seq;
    const s = { vid, child: null, head: Buffer.alloc(0), headOk: false, pending: [], pendingBytes: 0, flushTimer: null, firstTimer: null, unacked: 0, paused: false, closed: false, gotData: false, stderr: '' };
    this.sessions.set(vid, s);
    active.add(s);
    try {
      s.child = await link.forward(v.host, v.port);
    } catch {
      this._drop(s);
      return { ok: false, code: 'failed' };
    }
    if (s.closed) { this._kill(s); return { ok: false, code: 'closed' }; }
    const c = s.child;
    c.stdout.on('data', (d) => this._onData(s, d));
    c.stderr.on('data', (d) => { if (s.stderr.length < 4000) s.stderr += d; });
    c.stdin.on('error', () => {});
    c.on('error', () => this._end(s, 'failed'));
    c.on('close', (code) => this._end(s, code === 0 && s.gotData ? 'closed' : classify(s.stderr, s.gotData)));
    s.firstTimer = setTimeout(() => this._end(s, s.gotData ? 'dropped' : 'timeout', true), this.L.firstByteMs);
    if (s.firstTimer.unref) s.firstTimer.unref();
    return { ok: true, vid };
  }

  /** From the window: bytes for the server. */
  write(vid, data) {
    const s = this.sessions.get(vid);
    if (!s || s.closed || !s.child) return false;
    const n = data && typeof data.byteLength === 'number' ? data.byteLength : -1;
    if (n < 0 || n > this.L.maxWrite) return false;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer || data, data.byteOffset || 0, n);
    try { return s.child.stdin.write(buf); } catch { return false; }
  }

  /** From the window: it has processed `bytes` more. */
  ack(vid, bytes) {
    const s = this.sessions.get(vid);
    const n = Number(bytes);
    if (!s || !(n > 0)) return;
    s.unacked = Math.max(0, s.unacked - n);
    if (s.paused && s.unacked < this.L.low && s.child) { s.paused = false; s.child.stdout.resume(); }
  }

  /** The window closed the screen (or the tab / ssh session ended). Safe to call more than once. */
  close(vid, code = 'closed') {
    const s = this.sessions.get(vid);
    if (s) this._end(s, code, true);
  }
  closeAll(code = 'closed') {
    for (const s of [...this.sessions.values()]) this._end(s, code, true);
  }
  get count() {
    return this.sessions.size;
  }

  // ---- internals
  _onData(s, d) {
    if (s.closed) return;
    if (!s.headOk) { // the first bytes must be the RFB greeting ("RFB 003.008\n"): anything else is some other service
      s.head = Buffer.concat([s.head, d]);
      if (s.head.length < 4) return;
      if (s.head.toString('latin1', 0, 4) !== 'RFB ') { this._end(s, 'not-vnc', true); return; }
      s.headOk = true;
      s.gotData = true;
      clearTimeout(s.firstTimer);
      d = s.head;
      s.head = Buffer.alloc(0);
    }
    s.pending.push(d);
    s.pendingBytes += d.length;
    if (s.pendingBytes >= this.L.chunk) this._flush(s);
    else if (!s.flushTimer) s.flushTimer = setTimeout(() => this._flush(s), this.L.flushMs);
  }

  _flush(s) {
    clearTimeout(s.flushTimer);
    s.flushTimer = null;
    if (!s.pendingBytes) return;
    const data = s.pending.length === 1 ? s.pending[0] : Buffer.concat(s.pending, s.pendingBytes);
    s.pending = [];
    s.pendingBytes = 0;
    s.unacked += data.length;
    if (!s.paused && s.unacked > this.L.high && s.child) { s.paused = true; s.child.stdout.pause(); }
    this.send('vnc:data', { vid: s.vid, data });
  }

  _kill(s) {
    if (s.child) { try { s.child.kill('SIGTERM'); } catch { /* gone */ } }
  }

  _drop(s) {
    clearTimeout(s.flushTimer);
    clearTimeout(s.firstTimer);
    this.sessions.delete(s.vid);
    active.delete(s);
  }

  /** The one place a session ends: data still waiting is delivered first, then the window learns why. */
  _end(s, code, kill = false) {
    if (s.closed) return;
    if (s.pendingBytes && !kill) this._flush(s);
    s.closed = true;
    this._drop(s);
    if (kill) this._kill(s);
    if (code === 'auth') { const l = this.link(); if (l && l.invalidate) l.invalidate(); } // look for a shared connection again next time (the login may have finished meanwhile)
    this.send('vnc:end', { vid: s.vid, code });
    this.emit('end', { vid: s.vid, code });
  }
}

module.exports = { VncBridge, validateTarget, classify, DEFAULTS, activeCount: () => active.size };
