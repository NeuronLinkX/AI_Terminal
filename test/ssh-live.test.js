'use strict';
// Real ssh: a throw-away sshd on 127.0.0.1 (see helpers/sshd.js), real PTY sessions, the real `ssh` client.
// Skipped when sshd cannot run here. Nothing leaves the machine and no password is involved anywhere.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { PtySession } = require('../src/main/pty-session');
const { descendants } = require('../src/main/procs');
const { SshWatcher, parseSshArgs } = require('../src/main/ssh');
const { RemoteFS, sha256 } = require('../src/main/remotefs');
const { RemoteMonitor, monitorArgs, controlDir } = require('../src/main/remotemon');
const { startSshd } = require('./helpers/sshd');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 8000, step = 50) => { const t = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t > ms) return false; await sleep(step); } };
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ait-live-')));

let srv;
test.before(async () => { srv = await startSshd(); });
test.after(() => { if (srv) srv.stop(); });
const need = (t) => { if (srv) return true; t.skip('sshd cannot run here'); return false; };

/** A local PTY (zsh) with an ssh session to the throw-away server running in the foreground. */
async function sshSession(extra = '') {
  const s = new PtySession({ cwd: tmp() }).start();
  await new Promise((r) => { const i = setInterval(() => s.integrated && (clearInterval(i), r()), 50); });
  const r = await s.runCommand(`${srv.command}${extra}`, { idleMs: 1500, maxMs: 12000 });
  assert.equal(r.status, 'running', JSON.stringify(r));
  await sleep(500);
  return s;
}
const runnerFor = (s) => ({ run: (cmd, o = {}) => s.runSentinel(cmd, { kind: 'posix', ...o }), upload: (d, l, o = {}) => s.uploadToRemote(d, l, o) });

test('SshWatcher sees a real ssh session start and end in a tab', async (tc) => {
  if (!need(tc)) return;
  const s = new PtySession({ cwd: tmp() }).start();
  await new Promise((r) => { const i = setInterval(() => s.integrated && (clearInterval(i), r()), 50); });
  const w = new SshWatcher(s, { descendants, intervalMs: 300 });
  const ev = [];
  w.on('change', (c) => ev.push(c));
  w.start();
  try {
    await s.runCommand(srv.command, { idleMs: 1500, maxMs: 12000 });
    assert.ok(await until(() => ev.some((e) => e.active)), 'ssh recognised');
    const on = ev.find((e) => e.active);
    assert.equal(on.target.label, `${srv.user}@127.0.0.1:${srv.port}`);
    assert.equal(on.target.port, srv.port);
    assert.deepEqual(on.target.identity, ['client_key'], 'only the file name of the key is exposed');
    assert.ok(on.target.identityFiles[0].endsWith('client_key'));
    s.write('exit\r');
    assert.ok(await until(() => ev.some((e) => !e.active)), 'end of the session recognised');
  } finally { w.stop(); s.kill(); }
});

test('real ssh: sentinel keeps the remote shell state, and RemoteFS writes / reads through the real tty', async (tc) => {
  if (!need(tc)) return;
  const s = await sshSession();
  const seen = [];
  s.on('data', (t) => seen.push(t));
  try {
    const dir = tmp();
    let r = await s.runSentinel(`cd ${dir} && export AIT_T=remote-state && pwd`);
    assert.deepEqual([r.status, r.exitCode, r.cwd], ['done', 0, dir]);
    r = await s.runSentinel('echo $AIT_T; pwd');
    assert.equal(r.output, `remote-state\n${dir}`, 'cd and exported variables persist: it is one shell');
    const rfs = new RemoteFS(runnerFor(s), { home: dir, getCwd: () => dir });

    const big = Array.from({ length: 2500 }, (_, i) => `line ${i} — 한글 ${'x'.repeat(20)}`).join('\n') + '\n';
    assert.ok(Buffer.byteLength(big) > 100 * 1024);
    const t0 = Date.now();
    const w = await rfs.write(path.join(dir, 'big.txt'), big);
    assert.equal(w.ok, true, JSON.stringify(w));
    assert.equal(fs.readFileSync(path.join(dir, 'big.txt'), 'utf8'), big, 'byte-exact over a real ssh channel');
    assert.ok(Date.now() - t0 < 60000);
    const b64 = Buffer.from(big).toString('base64');
    assert.ok(!seen.join('').includes(b64.slice(2000, 2200)), 'the user\'s terminal did not receive the payload');
    const echo = await s.runSentinel('stty -a | tr " " "\\n" | grep -x -e echo -e -echo');
    assert.equal(echo.output, 'echo', 'tty echo restored');
    const rd = await rfs.read(path.join(dir, 'big.txt'), 2499, 2500);
    assert.equal(rd.content, 'line 2498 — 한글 xxxxxxxxxxxxxxxxxxxx\nline 2499 — 한글 xxxxxxxxxxxxxxxxxxxx');
    assert.equal(rd.totalLines, 2500);
    assert.equal((await rfs.hash(path.join(dir, 'big.txt'))).hash, sha256(big));
    const edit = await rfs.write(path.join(dir, 'big.txt'), big.replace('line 5 ', 'LINE 5 '));
    assert.equal(edit.created, false);
    assert.match((await rfs.read(path.join(dir, 'big.txt'), 6, 6)).content, /^LINE 5 /);
  } finally { s.write('exit\r'); await sleep(300); s.kill(); }
});

test('real ssh: a password prompt on the far side stops the AI; the user answers; work continues', async (tc) => {
  if (!need(tc)) return;
  const s = await sshSession();
  try {
    const r = await s.runSentinel('read -s -p "[sudo] password for test: " x; echo done', { maxMs: 20000 });
    assert.equal(r.status, 'waiting_input');
    s.write('\r');
    await sleep(600);
    assert.equal((await s.runSentinel('echo continue')).output, 'continue');
  } finally { s.write('exit\r'); await sleep(300); s.kill(); }
});

test('real ssh: the server going away mid-session is reported as disconnected and classified as a dropped connection', async (tc) => {
  if (!need(tc)) return;
  const own = await startSshd(); // a second server we are free to kill
  assert.ok(own);
  const s = new PtySession({ cwd: tmp() }).start();
  await new Promise((r) => { const i = setInterval(() => s.integrated && (clearInterval(i), r()), 50); });
  const w = new SshWatcher(s, { descendants, intervalMs: 300 });
  const problems = [];
  w.on('problem', (p) => problems.push(p));
  w.start();
  try {
    await s.runCommand(own.command, { idleMs: 1500, maxMs: 12000 });
    await sleep(500);
    assert.equal((await s.runSentinel('echo up')).output, 'up');
    // kill every sshd child serving this session: the client sees the connection die
    spawnSync('pkill', ['-f', `sshd.*${own.dir.slice(-12)}`]);
    spawnSync('pkill', ['-f', `sshd -D -e -f ${own.dir}`]);
    spawnSync('pkill', ['-f', `sshd-session`]); // macOS names the per-connection process this way
    const t0 = Date.now();
    const r = await s.runSentinel('echo after-kill', { maxMs: 20000 });
    assert.ok(['disconnected', 'running'].includes(r.status), r.status);
    assert.ok(Date.now() - t0 < 25000);
    assert.ok(await until(() => s.state === 'prompt', 20000), 'ssh ended and the local shell has its prompt back');
    assert.equal((await s.runSentinel('echo again')).status, 'disconnected');
  } finally { w.stop(); s.kill(); own.stop(); }
});

test('real ssh: a changed host key is reported as dangerous and the session does not open', async (tc) => {
  if (!need(tc)) return;
  const dir = tmp();
  const { execFileSync } = require('child_process');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(dir, 'other')]);
  const kh = path.join(dir, 'known_hosts');
  fs.writeFileSync(kh, `[127.0.0.1]:${srv.port} ${fs.readFileSync(path.join(dir, 'other.pub'), 'utf8').split(' ').slice(0, 2).join(' ')}\n`);
  const s = new PtySession({ cwd: tmp() }).start();
  await new Promise((r) => { const i = setInterval(() => s.integrated && (clearInterval(i), r()), 50); });
  const w = new SshWatcher(s, { descendants, intervalMs: 300 });
  const problems = [];
  w.on('problem', (p) => problems.push(p));
  w.start();
  try {
    const cmd = `ssh -i ${srv.key} -o IdentitiesOnly=yes -o UserKnownHostsFile=${kh} -o StrictHostKeyChecking=yes -o BatchMode=yes -p ${srv.port} ${srv.user}@127.0.0.1`;
    await s.runCommand(cmd, { idleMs: 1500, maxMs: 12000 });
    assert.ok(await until(() => problems.some((p) => p.kind === 'host-key-changed')), JSON.stringify(problems));
    const p = problems.find((x) => x.kind === 'host-key-changed');
    assert.equal(p.level, 'danger');
    assert.match(p.hint, /자동으로 실행하지 않습니다/);
    assert.ok(await until(() => s.state === 'prompt'), 'ssh refused to connect');
  } finally { w.stop(); s.kill(); }
});

test('RemoteMonitor over real ssh: its own connection, real metrics, and the connection is closed when it stops', async (tc) => {
  if (!need(tc)) return;
  const t = parseSshArgs(`${srv.command}`);
  const mon = new RemoteMonitor({ intervalMs: 300 });
  const got = [];
  mon.on('metrics', (m) => got.push(m));
  mon.start(t);
  try {
    assert.ok(await until(() => got.length >= 2, 20000), 'two samples');
    const m = got[got.length - 1];
    assert.equal(m.via, 'own');
    assert.equal(m.os, 'Darwin');
    assert.ok(m.mem && m.mem.totalGB > 1 && m.mem.usedPct >= 0 && m.mem.usedPct <= 100);
    assert.ok(m.cpu && m.cpu.pct >= 0 && m.cpu.pct <= 100);
    assert.ok(m.disk && m.disk.totalGB > 1);
    assert.ok(Array.isArray(m.load) && m.load.length === 3);
    assert.ok(m.uptimeSec > 60);
    assert.ok(m.gpus.length >= 0);
  } finally { mon.stop(); }
  const args = monitorArgs(t, { ctl: controlDir(), mode: 'own', check: true });
  assert.ok(await until(() => spawnSync('ssh', args, { encoding: 'utf8' }).status !== 0, 6000), 'the monitor\'s own master is gone after stop()');
});

test('RemoteMonitor shares a session opened from the SSH menu — and stopping it NEVER ends the user\'s connection', async (tc) => {
  if (!need(tc)) return;
  const ctl = controlDir();
  assert.ok(ctl);
  const t = parseSshArgs(srv.command);
  // what the SSH menu does: the interactive session is the master on the shared path
  const master = spawnSync('ssh', ['-M', '-N', '-f', '-o', `ControlPath=${ctl}/%C`, '-o', 'BatchMode=yes', ...srv.sshArgs, `${srv.user}@127.0.0.1`], { encoding: 'utf8', timeout: 15000 });
  assert.equal(master.status, 0, master.stderr);
  const check = () => spawnSync('ssh', ['-O', 'check', '-o', `ControlPath=${ctl}/%C`, ...srv.sshArgs, `${srv.user}@127.0.0.1`], { encoding: 'utf8' });
  try {
    assert.equal(check().status, 0, 'the user\'s master is alive');
    const mon = new RemoteMonitor({ intervalMs: 300 });
    const got = [];
    mon.on('metrics', (m) => got.push(m));
    mon.start(t);
    assert.ok(await until(() => got.length >= 2, 20000));
    assert.equal(got[0].via, 'user', 'reused the shared connection instead of opening another');
    mon.stop();
    await sleep(800);
    assert.equal(check().status, 0, 'stopping the monitor left the user\'s connection running');
  } finally { spawnSync('ssh', ['-O', 'exit', '-o', `ControlPath=${ctl}/%C`, ...srv.sshArgs, `${srv.user}@127.0.0.1`]); }
});

test('RemoteMonitor without a usable key says so once and stops (no password is ever asked for)', async (tc) => {
  if (!need(tc)) return;
  const dir = tmp();
  spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(dir, 'stranger')]);
  const t = parseSshArgs(`ssh -i ${path.join(dir, 'stranger')} -o IdentitiesOnly=yes -o UserKnownHostsFile=${srv.knownHosts} -p ${srv.port} ${srv.user}@127.0.0.1`);
  const mon = new RemoteMonitor({ intervalMs: 300 });
  const un = [];
  mon.on('unavailable', (u) => un.push(u));
  mon.start(t);
  assert.ok(await until(() => !mon.running, 20000));
  assert.equal(un[0].kind, 'needs-auth');
  assert.equal(un.length, 1);
});
