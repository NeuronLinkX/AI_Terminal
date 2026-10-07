'use strict';
// A tiny VNC (RFB 3.8) server for tests: security type "None", a small framebuffer drawn from a fixed pattern, Raw encoding only.
// It records what a client does (pointer, keys, clipboard) so a test can check that input really arrives. It listens on
// 127.0.0.1 only and holds no data of its own: the picture is three coloured blocks and a white marker that follows the pointer.
const net = require('net');

const W = 320;
const H = 200;
const MARK = 12; // marker size

/** Colours at fixed places (the window tests read the canvas back and compare). */
const COLORS = { topLeft: [255, 0, 0], bottomRight: [0, 0, 255], middle: [0, 160, 0], marker: [255, 255, 255] };

function pixelAt(x, y, mark) {
  if (mark && x >= mark.x && x < mark.x + MARK && y >= mark.y && y < mark.y + MARK) return COLORS.marker;
  if (x < W / 2 && y < H / 2) return COLORS.topLeft;
  if (x >= W / 2 && y >= H / 2) return COLORS.bottomRight;
  return COLORS.middle;
}

/**
 * @param {{name?: string, password?: string, port?: number}} o  password: ask for "VNC Authentication" (security type 2) instead of None. The DES step
 *   of the protocol is computed with noVNC's own implementation (the node build of OpenSSL no longer ships DES).
 * @returns {Promise<{port, events, clients, cutText(text), stop()}>}
 */
async function startFakeVnc({ name = 'test-desktop', password = '', port: wantPort = 0 } = {}) {
  let DESECB = null;
  if (password) {
    const f = require('path').join(__dirname, '..', '..', 'node_modules', '@novnc', 'novnc', 'core', 'crypto', 'des.js');
    DESECB = (await import(require('url').pathToFileURL(f).href)).DESECBCipher;
  }
  const events = [];
  const clients = new Set();
  let mark = null;
  const server = net.createServer((sock) => {
    clients.add(sock);
    sock.on('close', () => clients.delete(sock));
    sock.on('error', () => {});
    const st = { buf: Buffer.alloc(0), phase: 'version', fmt: { bpp: 32, bigEndian: 0, rs: 16, gs: 8, bs: 0 }, want: false, damage: null };
    sock.write('RFB 003.008\n');
    const send = (b) => { try { sock.write(b); } catch { /* closed */ } };
    const frame = (x, y, w, h) => {
      const bytes = st.fmt.bpp / 8;
      const out = Buffer.alloc(4 + 12 + w * h * bytes);
      out.writeUInt8(0, 0); out.writeUInt16BE(1, 2);
      out.writeUInt16BE(x, 4); out.writeUInt16BE(y, 6); out.writeUInt16BE(w, 8); out.writeUInt16BE(h, 10); out.writeInt32BE(0, 12);
      let o = 16;
      for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
          const [r, g, b] = pixelAt(xx, yy, mark);
          const v = ((r << st.fmt.rs) | (g << st.fmt.gs) | (b << st.fmt.bs)) >>> 0;
          if (st.fmt.bigEndian) out.writeUInt32BE(v, o); else out.writeUInt32LE(v, o);
          o += bytes;
        }
      }
      return out;
    };
    const respond = () => {
      if (!st.want) return;
      const d = st.full || !st.damage ? { x: 0, y: 0, w: W, h: H } : st.damage;
      st.want = false;
      st.damage = null;
      st.full = false;
      send(frame(d.x, d.y, d.w, d.h));
    };
    const addDamage = (x, y, w, h) => {
      const x0 = Math.max(0, x); const y0 = Math.max(0, y); const x1 = Math.min(W, x + w); const y1 = Math.min(H, y + h);
      if (x1 <= x0 || y1 <= y0) return;
      const d = st.damage;
      st.damage = d ? { x: Math.min(d.x, x0), y: Math.min(d.y, y0), w: Math.max(d.x + d.w, x1) - Math.min(d.x, x0), h: Math.max(d.y + d.h, y1) - Math.min(d.y, y0) } : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    };
    const take = (n) => { if (st.buf.length < n) return null; const b = st.buf.subarray(0, n); st.buf = st.buf.subarray(n); return b; };
    const step = () => {
      for (;;) {
        if (st.phase === 'version') {
          if (!take(12)) return;
          send(Buffer.from([1, password ? 2 : 1])); // one security type: None, or VNC Authentication
          st.phase = 'security';
        } else if (st.phase === 'security') {
          if (!take(1)) return;
          if (password) {
            st.challenge = require('crypto').randomBytes(16);
            send(st.challenge);
            st.phase = 'authresp';
          } else {
            send(Buffer.from([0, 0, 0, 0])); // SecurityResult: OK
            st.phase = 'init';
          }
        } else if (st.phase === 'authresp') {
          const r = take(16); if (!r) return;
          const key = DESECB.importKey(Array.from(password).map((c) => c.charCodeAt(0)));
          const want = Buffer.from(key.encrypt({ name: 'DES-ECB' }, st.challenge));
          if (Buffer.compare(want, r) === 0) { send(Buffer.from([0, 0, 0, 0])); st.phase = 'init'; events.push({ type: 'auth', ok: true }); }
          else {
            const why = Buffer.from('Authentication failed');
            const b = Buffer.alloc(8 + why.length); b.writeUInt32BE(1, 0); b.writeUInt32BE(why.length, 4); why.copy(b, 8);
            send(b); events.push({ type: 'auth', ok: false }); setTimeout(() => sock.destroy(), 50); return;
          }
        } else if (st.phase === 'init') {
          if (!take(1)) return;
          const n = Buffer.from(name);
          const b = Buffer.alloc(24 + n.length);
          b.writeUInt16BE(W, 0); b.writeUInt16BE(H, 2);
          Buffer.from([32, 24, 0, 1]).copy(b, 4); // bpp, depth, little endian, true colour
          b.writeUInt16BE(255, 8); b.writeUInt16BE(255, 10); b.writeUInt16BE(255, 12);
          Buffer.from([16, 8, 0]).copy(b, 14); // shifts r g b
          b.writeUInt32BE(n.length, 20); n.copy(b, 24);
          send(b);
          st.phase = 'run';
        } else {
          if (st.buf.length < 1) return;
          const t = st.buf[0];
          if (t === 0) { // SetPixelFormat
            const m = take(20); if (!m) return;
            st.fmt = { bpp: m[4], bigEndian: m[6], rs: m[14], gs: m[15], bs: m[16] };
          } else if (t === 2) { // SetEncodings
            if (st.buf.length < 4) return;
            const n = st.buf.readUInt16BE(2);
            if (!take(4 + 4 * n)) return;
          } else if (t === 3) { // FramebufferUpdateRequest
            const m = take(10); if (!m) return;
            st.want = true;
            if (!m[1]) st.damage = null; // not incremental: the whole picture (respond() uses the full area when nothing is marked)
            if (!m[1]) st.full = true;
            respond();
          } else if (t === 4) { // KeyEvent
            const m = take(8); if (!m) return;
            events.push({ type: 'key', down: !!m[1], key: m.readUInt32BE(4) });
          } else if (t === 5) { // PointerEvent
            const m = take(6); if (!m) return;
            const e = { type: 'pointer', mask: m[1], x: m.readUInt16BE(2), y: m.readUInt16BE(4) };
            events.push(e);
            if (mark) addDamage(mark.x, mark.y, MARK, MARK);
            mark = { x: Math.max(0, Math.min(W - MARK, e.x)), y: Math.max(0, Math.min(H - MARK, e.y)) };
            addDamage(mark.x, mark.y, MARK, MARK);
            respond();
          } else if (t === 6) { // ClientCutText
            if (st.buf.length < 8) return;
            const len = st.buf.readUInt32BE(4);
            const m = take(8 + len); if (!m) return;
            events.push({ type: 'cut', text: m.subarray(8).toString('latin1') });
          } else { sock.destroy(); return; }
        }
      }
    };
    sock.on('data', (d) => { st.buf = Buffer.concat([st.buf, d]); step(); });
    sock._cut = (text) => { const b = Buffer.alloc(8 + text.length); b[0] = 3; b.writeUInt32BE(text.length, 4); b.write(text, 8, 'latin1'); send(b); };
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(wantPort, '127.0.0.1', () => resolve({
      port: server.address().port,
      events,
      clients,
      width: W,
      height: H,
      colors: COLORS,
      cutText: (text) => { for (const c of clients) c._cut(text); },
      stop: () => new Promise((r) => { for (const c of clients) c.destroy(); server.close(() => r()); }),
    }));
  });
}

/** A plain TCP server for the odd cases (flood of bytes, silence, a service that is not VNC). @param {(sock) => void} onConn */
function startTcp(onConn) {
  const clients = new Set();
  const server = net.createServer((s) => { clients.add(s); s.on('close', () => clients.delete(s)); s.on('error', () => {}); onConn(s); });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, clients, stop: () => new Promise((r) => { for (const c of clients) c.destroy(); server.close(() => r()); }) }));
  });
}

module.exports = { startFakeVnc, startTcp, W, H, COLORS };
