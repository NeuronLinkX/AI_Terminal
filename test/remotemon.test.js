'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMetrics, monitorArgs, classifyFailure, RemoteMonitor, SCRIPT } = require('../src/main/remotemon');
const { parseSshArgs } = require('../src/main/ssh');

// Real output of SCRIPT on an Ubuntu 24 VM (aarch64) and on an Apple Silicon Mac (host names replaced).
const LINUX = `AITM:os=Linux
AITM:arch=aarch64
AITM:host=build-vm
AITM:cpu1=cpu  4487 70 3664 175187 352 0 54 0 0 0
AITM:cpu2=cpu  4588 70 3684 175236 352 0 54 0 0 0
AITM:load=0.07 0.08 0.08
AITM:cores=2
AITM:mem=8110096 7025216 4194300 4194300
AITM:up=936.54
AITM:disk=34236032 11089708 /
AITM:end
`;
const MAC = `AITM:os=Darwin
AITM:arch=arm64
AITM:host=mac-host.local
AITM:cores=10
AITM:cpupct=28.8
AITM:load=4.03 4.48 4.17
AITM:mem=16777216 3119056 0 0
AITM:up=49084
AITM:disk=482797652 451738256 /System/Volumes/Data
AITM:gpu=Apple M4, 46, , ,
AITM:end
`;
const NVIDIA = `AITM:os=Linux
AITM:arch=x86_64
AITM:host=gpu-box
AITM:cpu1=cpu  1000 0 500 8000 100 0 0 0
AITM:cpu2=cpu  1300 0 600 8100 100 0 0 0
AITM:load=12.5 10.1 8.0
AITM:cores=32
AITM:mem=131923456 20000000 8388604 8000000
AITM:up=1234567
AITM:disk=1000000000 250000000 /
AITM:gpu=NVIDIA GeForce RTX 4090, 87, 20480, 24564, 71
AITM:gpu=NVIDIA GeForce RTX 4090, 3, 512, 24564, 38
AITM:end
`;

test('parseMetrics: Linux VM — CPU from two /proc/stat samples, memory, disk, load, uptime; no GPU is not an error', () => {
  const m = parseMetrics(LINUX);
  assert.deepEqual([m.os, m.arch, m.hostname], ['Linux', 'aarch64', 'build-vm']);
  // between the samples: total +(101+0+20+49+0+0+0) = 170, idle +49 → 71 % busy
  assert.equal(m.cpu.pct, 71);
  assert.equal(m.cores, 2);
  assert.deepEqual(m.load, [0.07, 0.08, 0.08]);
  assert.deepEqual(m.mem, { totalGB: 7.7, availGB: 6.7, usedGB: 1.0, usedPct: 13, swapUsedGB: 0, swapTotalGB: 4 });
  assert.deepEqual(m.disk, { totalGB: 32.7, usedGB: 10.6, usedPct: 32, mount: '/' });
  assert.deepEqual(m.gpus, []);
  assert.equal(m.uptimeSec, 937);
});

test('parseMetrics: macOS — CPU from ps, GPU from ioreg, unified memory', () => {
  const m = parseMetrics(MAC);
  assert.equal(m.os, 'Darwin');
  assert.equal(m.cpu.pct, 29);
  assert.equal(m.cores, 10);
  assert.deepEqual(m.mem, { totalGB: 16, availGB: 3, usedGB: 13, usedPct: 81, swapUsedGB: 0, swapTotalGB: 0 });
  assert.deepEqual(m.gpus, [{ name: 'Apple M4', util: 46, memUsedMB: null, memTotalMB: null, temp: null }]);
  assert.equal(m.disk.mount, '/System/Volumes/Data');
  assert.equal(m.uptimeSec, 49084);
});

test('parseMetrics: several NVIDIA GPUs with memory and temperature, swap in use, busy CPU', () => {
  const m = parseMetrics(NVIDIA);
  assert.equal(m.gpus.length, 2);
  assert.deepEqual(m.gpus[0], { name: 'NVIDIA GeForce RTX 4090', util: 87, memUsedMB: 20480, memTotalMB: 24564, temp: 71 });
  assert.equal(m.gpus[1].util, 3);
  assert.equal(m.cpu.pct, Math.round((1 - 100 / 500) * 100)); // idle +100 (+0 iowait) of +500
  assert.equal(m.mem.swapUsedGB, 0.4);
  assert.deepEqual(m.load, [12.5, 10.1, 8]);
});

test('parseMetrics: damaged, partial or hostile output never throws and never yields nonsense', () => {
  assert.equal(parseMetrics(''), null);
  assert.equal(parseMetrics('Welcome to Ubuntu\nLast login: today\n'), null, 'a login banner is not metrics');
  assert.equal(parseMetrics(null), null);
  const part = parseMetrics('AITM:os=Linux\nAITM:mem=0 0 0 0\nAITM:cpu1=garbage\nAITM:cpu2=cpu 1 2\nAITM:load=a b c\nAITM:gpu=only-a-name\nAITM:gpu=X, notanumber, 1, 2, 3\nAITM:up=-5\nAITM:disk=0 0 /\nAITM:end\n');
  assert.deepEqual([part.cpu, part.load, part.mem, part.disk, part.uptimeSec], [null, null, null, null, null]);
  assert.deepEqual(part.gpus, []);
  // a banner before / after and extra lines are ignored
  assert.equal(parseMetrics('motd\n' + LINUX + 'bye\n').cpu.pct, 71);
  // CPU clamps to 0..100
  assert.equal(parseMetrics('AITM:os=Linux\nAITM:cpupct=250\nAITM:end\n').cpu.pct, 100);
  assert.equal(parseMetrics('AITM:os=Linux\nAITM:gpu=G, 400, 1, 2, 3\nAITM:end\n').gpus[0].util, 100);
});

test('the script itself is read-only POSIX sh: no writes, no network, no privileged commands, no single-quote surprises', () => {
  assert.ok(!/(^|[\s;|&])(rm|mv|cp|tee|dd|chmod|chown|kill|sudo|su|curl|wget|nc|ssh|scp|systemctl|reboot|shutdown)\s/m.test(SCRIPT.replace(/"AITM:[^"]*"/g, '')), 'no mutating or networking commands');
  assert.ok(!/(^|[^2&])>\s*[^&\s/][^\s]*/.test(SCRIPT.replace(/2>\/dev\/null|2>&1|>\/dev\/null/g, '').replace(/<\s*[^\s]+/g, '')), 'no output redirection into files');
  assert.match(SCRIPT, /^export LC_ALL=C/);
  assert.match(SCRIPT, /echo AITM:end\n$/);
});

test('monitorArgs: BatchMode always, the same server as the user reached, no weakened host-key checks, unsafe options dropped', () => {
  const t = parseSshArgs('ssh -p 2222 -i /home/u/.ssh/id_work -F /home/u/cfg -J jump@bastion -o ProxyCommand=none -o "LocalCommand=touch /tmp/x" -o PermitLocalCommand=yes -o StrictHostKeyChecking=no -o Port=2222 dev@build.example.com');
  const a = monitorArgs(t, { ctl: '/tmp/ctl', mode: 'own' });
  const j = a.join(' ');
  assert.match(j, /-o BatchMode=yes/);
  assert.match(j, /-p 2222/);
  assert.match(j, /-l dev/);
  assert.match(j, /-J jump@bastion/);
  assert.match(j, /-i \/home\/u\/\.ssh\/id_work/);
  assert.match(j, /-F \/home\/u\/cfg/);
  assert.match(j, /-o proxycommand=none/);
  assert.ok(!/LocalCommand|PermitLocalCommand|StrictHostKeyChecking/i.test(j), 'only an allow-list of the user\'s options is carried over');
  assert.deepEqual(a.slice(-3), ['--', 'build.example.com', 'sh']);
  assert.ok(!a.includes('-t') && !a.includes('-tt'), 'never asks for a terminal');
  // a hostile destination cannot become an option
  const evil = monitorArgs({ host: '-oProxyCommand=x', options: {} }, { ctl: null });
  assert.equal(evil[evil.indexOf('--') + 1], '-oProxyCommand=x', 'it sits behind `--`, so ssh takes it as a host name');
});

test('monitorArgs: the three connection modes — only "own" may become a master, and only on its own control path', () => {
  const t = parseSshArgs('ssh ubuntu@192.168.64.4');
  const own = monitorArgs(t, { ctl: '/tmp/ctl', mode: 'own' }).join(' ');
  assert.match(own, /ControlMaster=auto/);
  assert.match(own, /ControlPath=\/tmp\/ctl\/m-%C/, 'its own path, distinct from sessions opened from the SSH menu');
  assert.match(own, /ControlPersist=60/);
  const user = monitorArgs(t, { ctl: '/tmp/ctl', mode: 'user' }).join(' ');
  assert.match(user, /ControlMaster=no/);
  assert.match(user, /ControlPath=\/tmp\/ctl\/%C/);
  assert.ok(!/ControlPersist|ControlMaster=auto/.test(user));
  const cfg = monitorArgs(t, { ctl: '/tmp/ctl', mode: 'config' }).join(' ');
  assert.match(cfg, /ControlMaster=no/);
  assert.ok(!/ControlPath/.test(cfg), "the user's own configuration decides the path");
  assert.deepEqual(monitorArgs(t, { ctl: '/tmp/ctl', mode: 'user', check: true }).slice(0, 2), ['-O', 'check']);
  assert.ok(!monitorArgs(t, { ctl: '/tmp/ctl', mode: 'user', check: true }).includes('sh'), 'a check has no command');
});

test('classifyFailure: a prompt-less login that cannot work is reported as such (and not retried forever)', () => {
  assert.equal(classifyFailure('ubuntu@h: Permission denied (publickey,password).', 255).kind, 'needs-auth');
  assert.equal(classifyFailure('Host key verification failed.', 255).kind, 'hostkey');
  assert.equal(classifyFailure('REMOTE HOST IDENTIFICATION HAS CHANGED', 255).kind, 'hostkey');
  assert.equal(classifyFailure('ssh: connect to host h port 22: Connection timed out', 255).kind, 'unreachable');
  assert.equal(classifyFailure('ssh: Could not resolve hostname x', 255).kind, 'unreachable');
  assert.equal(classifyFailure('', 7).kind, 'failed');
  assert.match(classifyFailure('Permission denied', 255).hint, /SSH 접속/);
});

/** A RemoteMonitor whose "ssh" is a function: records every call, answers from a script. */
function fake(answer) {
  const calls = [];
  const spawns = [];
  const mon = new RemoteMonitor({
    intervalMs: 5,
    ctl: '/tmp/ctl',
    execImpl: async (args, script) => { calls.push({ args, script }); return answer({ args, script, n: calls.length }); },
    spawnImpl: (args) => spawns.push(args),
  });
  return { mon, calls, spawns };
}
const target = () => parseSshArgs('ssh ubuntu@192.168.64.4');
const until = async (f, ms = 2000) => { const t = Date.now(); while (!f() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 5)); };

test('RemoteMonitor: detects a shared connection first (config, then the SSH menu), then streams metrics from it', async () => {
  const { mon, calls } = fake(({ args }) => {
    const isCheck = args[0] === '-O';
    if (isCheck) return /ControlPath=\/tmp\/ctl\/%C/.test(args.join(' ')) ? { code: 0, stdout: '', stderr: 'Master running (pid=123)' } : { code: 255, stdout: '', stderr: 'No ControlPath specified for "-O" command' };
    return { code: 0, stdout: LINUX, stderr: '' };
  });
  const got = [];
  mon.on('metrics', (m) => got.push(m));
  mon.start(target());
  await until(() => got.length >= 2);
  mon.stop();
  assert.ok(got.length >= 2);
  assert.equal(got[0].via, 'user', 'the session opened from the app menu shares its connection');
  assert.equal(got[0].cpu.pct, 71);
  assert.equal(calls[0].args[0], '-O', 'a master check comes first');
  const run = calls.find((c) => c.args[0] !== '-O');
  assert.equal(run.script, SCRIPT, 'the read-only script goes in on stdin');
  assert.match(run.args.join(' '), /ControlMaster=no/, 'it never becomes the master of the user\'s connection');
});

test('RemoteMonitor: stop() ends only a connection the monitor opened itself — never a shared one', async () => {
  for (const [shared, expectExit] of [[true, false], [false, true]]) {
    const { mon, spawns } = fake(({ args }) => (args[0] === '-O' ? (shared ? { code: 0, stdout: '', stderr: 'Master running' } : { code: 255, stdout: '', stderr: 'Control socket connect: No such file' }) : { code: 0, stdout: LINUX, stderr: '' }));
    const got = [];
    mon.on('metrics', (m) => got.push(m));
    mon.start(target());
    await until(() => got.length >= 1);
    mon.stop();
    assert.equal(spawns.length, expectExit ? 1 : 0, shared ? 'the user\'s master must not be told to exit' : 'the monitor\'s own master is closed');
    if (expectExit) {
      assert.deepEqual(spawns[0].slice(0, 2), ['-O', 'exit']);
      assert.match(spawns[0].join(' '), /ControlPath=\/tmp\/ctl\/m-%C/, 'on its own path only');
    }
  }
});

test('RemoteMonitor: key login missing → reported once and polling stops; transient failure → keeps trying; backs off', async () => {
  let a = fake(({ args }) => (args[0] === '-O' ? { code: 255, stdout: '', stderr: '' } : { code: 255, stdout: '', stderr: 'ubuntu@h: Permission denied (publickey,password).' }));
  const un = [];
  a.mon.on('unavailable', (u) => un.push(u));
  a.mon.start(target());
  await until(() => !a.mon.running);
  assert.equal(un.length, 1);
  assert.equal(un[0].kind, 'needs-auth');
  assert.equal(a.mon.running, false, 'retrying a password-only server every few seconds would be pointless');

  let n = 0;
  a = fake(({ args }) => (args[0] === '-O' ? { code: 255, stdout: '', stderr: '' } : ++n < 3 ? { code: 255, stdout: '', stderr: 'ssh: connect to host h port 22: Connection timed out' } : { code: 0, stdout: LINUX, stderr: '' }));
  const ok = [];
  const bad = [];
  a.mon.on('metrics', (m) => ok.push(m));
  a.mon.on('unavailable', (u) => bad.push(u));
  a.mon.start(target());
  await until(() => ok.length >= 1);
  a.mon.stop();
  assert.equal(bad.length, 1, 'one notice for a run of failures, not one per poll');
  assert.ok(ok.length >= 1, 'and it recovers by itself');
});

test('RemoteMonitor: pauses while the window is hidden, and a vanished shared connection falls back to its own', async () => {
  let active = false;
  const { mon, calls } = fake(({ args }) => (args[0] === '-O' ? { code: 255, stdout: '', stderr: '' } : { code: 0, stdout: LINUX, stderr: '' }));
  mon.isActive = () => active;
  mon.start(target());
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls.length, 0, 'nothing is run while the window is hidden');
  active = true;
  await until(() => calls.length >= 2);
  mon.stop();
  assert.ok(calls.length >= 2);

  // shared connection disappears mid-way: the next failure switches to mode "own"
  let phase = 0;
  const f = fake(({ args }) => {
    if (args[0] === '-O') return phase === 0 && /ControlPath=\/tmp\/ctl\/%C/.test(args.join(' ')) ? { code: 0, stdout: '', stderr: 'Master running' } : { code: 255, stdout: '', stderr: '' };
    if (/ControlMaster=no/.test(args.join(' ')) && phase++ > 0) return { code: 255, stdout: '', stderr: 'Control socket connect: No such file' };
    return { code: 0, stdout: LINUX, stderr: '' };
  });
  const seen = [];
  f.mon.on('metrics', (m) => seen.push(m.via));
  f.mon.start(target());
  await until(() => seen.includes('own'));
  f.mon.stop();
  assert.equal(seen[0], 'user');
  assert.ok(seen.includes('own'), seen.join());
});
