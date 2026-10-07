'use strict';
// The remote screen's byte path (src/main/vnc.js, SshLink.forward): unit tests with a fake `ssh` child, then the same code over a
// REAL ssh connection (throw-away sshd on 127.0.0.1, helpers/sshd.js) to a fake VNC server. Nothing leaves this machine.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');
const { VncBridge, validateTarget, classify, DEFAULTS, activeCount } = require('../src/main/vnc');
const { SshLink } = require('../src/main/sshlink');
const { parseSshArgs } = require('../src/main/ssh');
const { startSshd } = require('./helpers/sshd');
const { startFakeVnc, startTcp, W, H, COLORS } = require('./helpers/fake-vnc');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 15000) => { const t = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t > ms) return false; await sleep(25); } };

// ---------------------------------------------------------------- fakes for the unit tests
function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.written = [];
  c.stdin = new Writable({ write(chunk, _enc, cb) { c.written.push(Buffer.from(chunk)); cb(); } });
  c.killed = null;
  c.kill = (sig) => { c.killed = sig || 'SIGTERM'; setImmediate(() => c.emit('close', null, c.killed)); return true; };
  return c;
}
function rig(limits = {}) {
  const child = fakeChild();
  const sent = [];
  const link = { forward: async (host, port) => { link.last = { host, port }; return child; } };
  const bridge = new VncBridge({ link: () => link, send: (ch, p) => sent.push([ch, p]), limits: { flushMs: 5, firstByteMs: 60000, ...limits } });
  return { child, sent, link, bridge, data: () => sent.filter(([c]) => c === 'vnc:data').map(([, p]) => p), end: () => sent.filter(([c]) => c === 'vnc:end').map(([, p]) => p) };
}
const GREETING = Buffer.from('RFB 003.008\n');

test('target validation: a host name / IPv4 / bracketed IPv6 and a port, nothing that could become an ssh option or shell syntax', () => {
  assert.deepEqual(validateTarget({ port: 5901 }), { ok: true, host: '127.0.0.1', port: 5901 });
  assert.deepEqual(validateTarget({ host: 'localhost', port: '5900' }), { ok: true, host: 'localhost', port: 5900 });
  assert.deepEqual(validateTarget({ host: '[::1]', port: 5902 }), { ok: true, host: '[::1]', port: 5902 });
  assert.deepEqual(validateTarget({ host: 'gpu-01.example.com', port: 5901 }), { ok: true, host: 'gpu-01.example.com', port: 5901 });
  for (const bad of [
    { port: 0 }, { port: 65536 }, { port: -1 }, { port: 1.5 }, { port: 'abc' }, { port: '59 01' }, {}, null, undefined, 'x',
    { host: '-oProxyCommand=x', port: 5901 }, { host: 'a b', port: 5901 }, { host: 'a;b', port: 5901 }, { host: '$(id)', port: 5901 },
    { host: 'a:5901', port: 5901 }, { host: '::1', port: 5901 }, { host: '', port: 'x' }, { host: 'a\nb', port: 5901 }, { host: 'x'.repeat(300), port: 5901 }, { host: 5, port: 5901 },
  ]) assert.equal(validateTarget(bad).ok, false, JSON.stringify(bad));
});

test('ssh -W arguments: the shared-connection options, the destination as ONE argument, the host after --', async () => {
  const spawned = [];
  const link = new SshLink(parseSshArgs('ssh -p 2222 -i /home/u/.ssh/id_work -J jump@bastion alice@gpu.example.com'), {
    ctl: '/tmp/ait-test-ctl',
    execImpl: async () => ({ code: 1, stdout: '', stderr: '' }), // no master anywhere: the app's own connection
    spawnImpl: (args) => { const c = fakeChild(); spawned.push(args); return c; },
  });
  await link.forward('127.0.0.1', 5901);
  const a = spawned[0];
  assert.ok(a.includes('BatchMode=yes'), 'never asks for a password');
  assert.deepEqual(a.slice(a.indexOf('-W'), a.indexOf('-W') + 2), ['-W', '127.0.0.1:5901']);
  assert.equal(a[a.length - 2], '--');
  assert.match(a[a.length - 1], /gpu\.example\.com/);
  assert.ok(a.includes('ExitOnForwardFailure=yes'));
  assert.ok(!a.includes('-C') && !a.some((x) => /Compression/i.test(x)), 'VNC encodings are compressed already (R10)');
  assert.ok(a.includes('-p') && a.includes('2222') && a.includes('-J'), 'the user\'s port and jump host are kept');
  assert.equal(link.children.size, 1);
});

test('no ssh session, bad target, one screen per tab', async () => {
  const none = new VncBridge({ link: () => null, send: () => {} });
  assert.deepEqual(await none.open({ port: 5901 }), { ok: false, code: 'no-ssh' });
  const r = rig();
  assert.deepEqual(await r.bridge.open({ host: '-x', port: 5901 }), { ok: false, code: 'bad-target' });
  const first = await r.bridge.open({ port: 5901 });
  assert.equal(first.ok, true);
  assert.deepEqual(r.link.last, { host: '127.0.0.1', port: 5901 });
  assert.deepEqual(await r.bridge.open({ port: 5902 }), { ok: false, code: 'too-many' });
  r.bridge.close(first.vid);
  assert.equal(r.bridge.count, 0);
  assert.equal((await r.bridge.open({ port: 5902 })).ok, true, 'after closing, a new screen can be opened');
  r.bridge.closeAll();
});

test('the app as a whole is limited too (R8)', async () => {
  const a = rig({ maxTotal: 1 });
  const b = rig({ maxTotal: 1 });
  const base = activeCount();
  const o = await a.bridge.open({ port: 5901 });
  assert.equal(o.ok, base + 1 <= 1, 'first one fits only if nothing else is running');
  if (o.ok) assert.deepEqual(await b.bridge.open({ port: 5901 }), { ok: false, code: 'too-many' });
  a.bridge.closeAll();
});

test('pieces arriving together are merged into one message (R3), bytes unchanged', async () => {
  const r = rig();
  const { vid } = await r.bridge.open({ port: 5901 });
  r.child.stdout.write(GREETING.subarray(0, 3)); // shorter than the 4 bytes needed to recognise the greeting
  r.child.stdout.write(GREETING.subarray(3));
  r.child.stdout.write(Buffer.from([1, 2, 3]));
  r.child.stdout.write(Buffer.from([4, 5]));
  await sleep(40);
  assert.equal(r.data().length, 1, 'one IPC message');
  assert.equal(r.data()[0].vid, vid);
  assert.deepEqual([...r.data()[0].data], [...GREETING, 1, 2, 3, 4, 5]);
  r.bridge.closeAll();
});

test('a big burst is sent at once, without waiting for the timer', async () => {
  const r = rig({ flushMs: 60000, chunk: 1000 });
  await r.bridge.open({ port: 5901 });
  r.child.stdout.write(Buffer.concat([GREETING, Buffer.alloc(1200, 7)]));
  await sleep(30);
  assert.equal(r.data().length, 1);
  assert.equal(r.data()[0].data.length, 1212);
  r.bridge.closeAll();
});

test('flow control: reading from ssh stops while too much is unconfirmed and continues after the window confirms (R4)', async () => {
  const r = rig({ high: 100, low: 30, chunk: 50 });
  const { vid } = await r.bridge.open({ port: 5901 });
  r.child.stdout.write(Buffer.concat([GREETING, Buffer.alloc(200, 1)]));
  await sleep(30);
  assert.equal(r.child.stdout.isPaused(), true, 'paused');
  r.bridge.ack(vid, 100);
  assert.equal(r.child.stdout.isPaused(), true, 'still above the low mark');
  r.bridge.ack(vid, 100);
  assert.equal(r.child.stdout.isPaused(), false, 'resumed');
  r.bridge.ack(vid, 99999); // an excessive confirmation never makes the counter negative
  r.bridge.ack(vid, -5);
  r.bridge.ack(vid, 'x');
  r.bridge.closeAll();
});

test('input from the window: forwarded unchanged, oversize and wrong kinds refused', async () => {
  const r = rig({ maxWrite: 1000 });
  const { vid } = await r.bridge.open({ port: 5901 });
  assert.equal(r.bridge.write(vid, new Uint8Array([5, 1, 0, 10, 0, 20])), true);
  assert.deepEqual([...Buffer.concat(r.child.written)], [5, 1, 0, 10, 0, 20]);
  assert.equal(r.bridge.write(vid, new Uint8Array(1001)), false, 'larger than the limit');
  assert.equal(r.bridge.write(vid, 'text'), false);
  assert.equal(r.bridge.write(vid, null), false);
  assert.equal(r.bridge.write(999, new Uint8Array(1)), false, 'unknown screen');
  const ab = new Uint8Array([9, 8, 7, 6]).buffer;
  assert.equal(r.bridge.write(vid, new Uint8Array(ab, 1, 2)), true, 'a view into a bigger buffer sends only its own bytes');
  assert.deepEqual([...r.child.written[r.child.written.length - 1]], [8, 7]);
  r.bridge.closeAll();
});

test('something that is not a VNC server is recognised from its first bytes', async () => {
  const r = rig();
  await r.bridge.open({ port: 8080 });
  r.child.stdout.write(Buffer.from('HTTP/1.1 400 Bad Request\r\n'));
  await sleep(20);
  assert.deepEqual(r.end().map((e) => e.code), ['not-vnc']);
  assert.ok(r.child.killed, 'the ssh child is stopped');
  assert.equal(r.data().length, 0, 'nothing is forwarded to the window');
});

test('how a connection ends is reported as a code, and no server details are put into it', async () => {
  const cases = [
    ['channel 0: open failed: connect failed: Connection refused\r\nstdio forwarding failed\r\n', false, 255, 'refused'],
    ['Stdio forwarding request failed: Session open refused by peer\r\n', false, 255, 'refused'],
    ['channel 0: open failed: administratively prohibited: open failed\r\n', false, 255, 'forbidden'],
    ['alice@gpu.example.com: Permission denied (publickey).\r\n', false, 255, 'auth'],
    ['Host key verification failed.\r\n', false, 255, 'auth'],
    ['something unexpected\r\n', false, 255, 'failed'],
    ['', true, 255, 'dropped'],
    ['', true, 0, 'closed'],
  ];
  for (const [stderr, data, exit, code] of cases) {
    const r = rig();
    await r.bridge.open({ port: 5901 });
    if (stderr) r.child.stderr.write(stderr);
    if (data) r.child.stdout.write(Buffer.concat([GREETING, Buffer.from([1])]));
    await sleep(20);
    r.child.emit('close', exit);
    const e = r.end();
    assert.deepEqual(e.map((x) => x.code), [code], `${JSON.stringify(stderr)} -> ${code}`);
    assert.deepEqual(Object.keys(e[0]).sort(), ['code', 'vid'], 'only a code and the screen number');
  }
  assert.equal(classify('', false), 'failed');
});

test('a refused login makes the link look for a shared connection again next time', async () => {
  const r = rig();
  let invalidated = 0;
  r.link.invalidate = () => { invalidated++; };
  await r.bridge.open({ port: 5901 });
  r.child.stderr.write('alice@gpu: Permission denied (publickey).\r\n');
  await sleep(10);
  r.child.emit('close', 255);
  assert.deepEqual(r.end().map((e) => e.code), ['auth']);
  assert.equal(invalidated, 1);
  const q = rig();
  q.link.invalidate = () => { invalidated++; };
  await q.bridge.open({ port: 5901 });
  q.child.stderr.write('Stdio forwarding request failed: Session open refused by peer\r\n');
  q.child.emit('close', 255);
  assert.equal(invalidated, 1, 'other failures keep the route');
});

test('data that was waiting when the connection ended is delivered before the end', async () => {
  const r = rig({ flushMs: 60000 });
  await r.bridge.open({ port: 5901 });
  r.child.stdout.write(Buffer.concat([GREETING, Buffer.from([1, 2, 3])]));
  await sleep(10);
  r.child.emit('close', 0);
  assert.deepEqual(r.sent.map(([c]) => c), ['vnc:data', 'vnc:end']);
});

test('silence is a timeout: the server of a VNC session speaks first', async () => {
  const r = rig({ firstByteMs: 80 });
  await r.bridge.open({ port: 5901 });
  assert.equal(await until(() => r.end().length === 1, 2000), true);
  assert.equal(r.end()[0].code, 'timeout');
  assert.ok(r.child.killed);
});

test('closing is safe to repeat, kills ssh, and later input is ignored', async () => {
  const r = rig();
  const { vid } = await r.bridge.open({ port: 5901 });
  r.bridge.close(vid);
  r.bridge.close(vid);
  r.bridge.closeAll();
  await sleep(10);
  assert.ok(r.child.killed);
  assert.equal(r.end().length, 1, 'the end is announced exactly once');
  assert.equal(r.bridge.write(vid, new Uint8Array(1)), false);
  r.child.stdout.write(GREETING);
  await sleep(20);
  assert.equal(r.data().length, 0);
});

test('the guide\'s numbers are the ones in the code', () => {
  assert.equal(DEFAULTS.flushMs, 4);
  assert.equal(DEFAULTS.chunk, 64 * 1024);
  assert.equal(DEFAULTS.high, 1024 * 1024);
  assert.equal(DEFAULTS.low, 256 * 1024);
  assert.equal(DEFAULTS.maxWrite, 1024 * 1024);
  assert.equal(DEFAULTS.firstByteMs, 15000);
  assert.equal(DEFAULTS.maxPerTab, 1);
  assert.equal(DEFAULTS.maxTotal, 4);
});

// ---------------------------------------------------------------- the same code over a real ssh connection
let srv; let link; let fake;
test.before(async () => {
  srv = await startSshd();
  if (!srv) return;
  link = new SshLink(parseSshArgs(srv.command));
  fake = await startFakeVnc();
});
test.after(async () => {
  if (link) link.close();
  if (fake) await fake.stop();
  if (srv) srv.stop();
});
const need = (t) => { if (srv) return true; t.skip('sshd cannot run here'); return false; };
function live(limits) {
  const sent = [];
  const bridge = new VncBridge({ link: () => link, send: (ch, p) => sent.push([ch, p]), limits });
  const received = () => Buffer.concat(sent.filter(([c]) => c === 'vnc:data').map(([, p]) => Buffer.from(p.data)));
  const ended = () => sent.filter(([c]) => c === 'vnc:end').map(([, p]) => p.code);
  return { bridge, sent, received, ended };
}

test('LIVE: the whole RFB handshake runs through ssh -W in both directions, and input arrives at the server', async (t) => {
  if (!need(t)) return;
  const L = live();
  const o = await L.bridge.open({ port: fake.port });
  assert.equal(o.ok, true);
  t.after(() => L.bridge.closeAll());
  assert.equal(await until(() => L.received().length >= 12), true, 'the server\'s greeting arrives');
  assert.equal(L.received().toString('latin1', 0, 12), 'RFB 003.008\n');
  L.bridge.write(o.vid, Buffer.from('RFB 003.008\n'));
  assert.equal(await until(() => L.received().length >= 14), true);
  assert.deepEqual([...L.received().subarray(12, 14)], [1, 1], 'security types: one, None');
  L.bridge.write(o.vid, Buffer.from([1])); // choose None
  assert.equal(await until(() => L.received().length >= 18), true);
  assert.deepEqual([...L.received().subarray(14, 18)], [0, 0, 0, 0], 'security result OK');
  L.bridge.write(o.vid, Buffer.from([1])); // ClientInit (shared)
  assert.equal(await until(() => L.received().length >= 18 + 24 + 'test-desktop'.length), true);
  const init = L.received().subarray(18);
  assert.equal(init.readUInt16BE(0), W);
  assert.equal(init.readUInt16BE(2), H);
  assert.equal(init.toString('latin1', 24, 24 + init.readUInt32BE(20)), 'test-desktop');
  // a pointer event and a key event reach the server unchanged
  L.bridge.write(o.vid, Buffer.from([5, 1, 0, 100, 0, 50]));
  L.bridge.write(o.vid, Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x61]));
  assert.equal(await until(() => fake.events.length >= 2), true);
  assert.deepEqual(fake.events.slice(0, 2), [{ type: 'pointer', mask: 1, x: 100, y: 50 }, { type: 'key', down: true, key: 0x61 }]);
  // a full picture request is answered with the whole framebuffer (Raw, 4 bytes per pixel)
  const before = L.received().length;
  L.bridge.write(o.vid, Buffer.from([3, 0, 0, 0, 0, 0, W >> 8, W & 255, H >> 8, H & 255]));
  assert.equal(await until(() => L.received().length >= before + 16 + W * H * 4), true);
  const px = (x, y) => { const at = before + 16 + (y * W + x) * 4; const b = L.received(); return [b[at + 2], b[at + 1], b[at]]; }; // little endian: B G R X
  assert.deepEqual(px(5, 5), COLORS.topLeft);
  assert.deepEqual(px(W - 5, H - 5), COLORS.bottomRight);
  L.bridge.close(o.vid);
  assert.equal(L.bridge.count, 0);
});

test('LIVE: no VNC server on that port -> refused, from the real ssh message', async (t) => {
  if (!need(t)) return;
  const dead = await startTcp(() => {});
  const port = dead.port;
  await dead.stop(); // nothing listens there any more
  const L = live();
  const o = await L.bridge.open({ port });
  assert.equal(o.ok, true);
  assert.equal(await until(() => L.ended().length === 1), true);
  assert.deepEqual(L.ended(), ['refused']);
});

test('LIVE: another kind of service is recognised, silence times out', async (t) => {
  if (!need(t)) return;
  const web = await startTcp((s) => s.write('HTTP/1.1 400 Bad Request\r\n\r\n'));
  const quiet = await startTcp(() => {});
  try {
    const A = live();
    await A.bridge.open({ port: web.port });
    assert.equal(await until(() => A.ended().length === 1), true);
    assert.deepEqual(A.ended(), ['not-vnc']);
    const B = live({ firstByteMs: 1500 });
    await B.bridge.open({ port: quiet.port });
    assert.equal(await until(() => B.ended().length === 1, 8000), true);
    assert.deepEqual(B.ended(), ['timeout']);
  } finally { await web.stop(); await quiet.stop(); }
});

test('LIVE: flow control on real pipes: without confirmation only about the high mark arrives, with confirmation everything does', async (t) => {
  if (!need(t)) return;
  const TOTAL = 12 * 1024 * 1024;
  const flood = await startTcp((s) => {
    s.write('RFB 003.008\n');
    let sent = 0;
    const chunk = Buffer.alloc(64 * 1024, 0x55);
    const pump = () => { while (sent < TOTAL) { sent += chunk.length; if (!s.write(chunk)) return s.once('drain', pump); } s.end(); };
    pump();
  });
  try {
    const high = 512 * 1024;
    const L = live({ high, low: 128 * 1024 });
    const o = await L.bridge.open({ port: flood.port });
    assert.equal(o.ok, true);
    await until(() => L.received().length > 0);
    await sleep(1500); // give ssh time to deliver as much as it is allowed to
    const stalled = L.received().length;
    assert.ok(stalled >= 64 * 1024, `something arrived (${stalled})`);
    assert.ok(stalled < high + 1024 * 1024, `reading stopped near the high mark, not at ${TOTAL} (got ${stalled})`);
    await sleep(500);
    assert.equal(L.received().length, stalled, 'and it stays stopped while nothing is confirmed');
    // now behave like the window: confirm everything that has arrived, until the server is done
    let confirmed = 0;
    const done = await until(() => {
      const have = L.received().length;
      if (have > confirmed) { L.bridge.ack(o.vid, have - confirmed); confirmed = have; }
      return have >= TOTAL + 12;
    }, 30000);
    assert.equal(done, true, `all bytes arrive (${L.received().length} of ${TOTAL + 12})`);
    assert.equal(L.received().length, TOTAL + 12);
  } finally { await flood.stop(); }
});

test('LIVE: closing the screen ends the ssh child, and ending the connection closes everything', async (t) => {
  if (!need(t)) return;
  const L = live();
  const o = await L.bridge.open({ port: fake.port });
  assert.equal(o.ok, true);
  await until(() => L.received().length >= 12);
  const pids = [...link.children].map((c) => c.pid);
  assert.equal(pids.length >= 1, true);
  L.bridge.close(o.vid);
  const gone = await until(() => pids.every((p) => { try { process.kill(p, 0); return false; } catch { return true; } }), 8000);
  assert.equal(gone, true, 'the ssh -W process is gone');
  assert.equal(link.children.size, 0);
});
