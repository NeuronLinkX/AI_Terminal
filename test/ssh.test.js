'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const S = require('../src/main/ssh');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ait-ssh-'));

test('parseSshArgs: destination, user, port, options and the forms people really type', () => {
  let r = S.parseSshArgs('ssh ubuntu@192.168.64.4');
  assert.equal(r.user, 'ubuntu');
  assert.equal(r.host, '192.168.64.4');
  assert.equal(r.port, 0);
  assert.equal(r.interactive, true);
  assert.equal(r.label, 'ubuntu@192.168.64.4');

  r = S.parseSshArgs('ssh -o ServerAliveInterval=30 -p 2222 -i ~/.ssh/id_work dev@build.example.com');
  assert.equal(r.port, 2222);
  assert.deepEqual(r.identity, ['id_work'], 'only the file name of a key is kept, never its path');
  assert.equal(r.options.serveraliveinterval, '30');
  assert.equal(r.label, 'dev@build.example.com:2222');

  assert.equal(S.parseSshArgs('ssh -p2200 host').port, 2200, 'attached option value');
  assert.equal(S.parseSshArgs('ssh -l alice host').user, 'alice');
  assert.equal(S.parseSshArgs('ssh -oUser=bob -oPort=2201 host').user, 'bob');
  assert.equal(S.parseSshArgs('ssh -o "Port 2202" host').port, 2202, 'ssh_config style "Key value"');
  assert.equal(S.parseSshArgs('ssh -J jump@bastion target').jump, 'jump@bastion');
  assert.equal(S.parseSshArgs('ssh -tt -A -vvv host').host, 'host', 'combined and repeated flags');

  r = S.parseSshArgs('ssh ssh://carol@example.org:2300');
  assert.deepEqual([r.user, r.host, r.port], ['carol', 'example.org', 2300]);
  r = S.parseSshArgs('ssh root@[fe80::1]:22');
  assert.equal(r.host, 'fe80::1');
  assert.equal(S.parseSshArgs('/usr/bin/ssh host').host, 'host', 'absolute path of the binary');
});

test('parseSshArgs: only a login shell counts as interactive; other programs are not ssh', () => {
  assert.equal(S.parseSshArgs('ssh host ls -la').interactive, false, 'a remote command is not a shell');
  assert.equal(S.parseSshArgs('ssh -t host bash').interactive, true, 'a forced terminal means the user works in it');
  assert.equal(S.parseSshArgs('ssh -tt host "sudo -i"').interactive, true);
  assert.equal(S.parseSshArgs('ssh -N -t host').interactive, false, 'but -N never runs a shell');
  assert.equal(S.parseSshArgs('ssh host ls -la').command, 'ls -la');
  assert.equal(S.parseSshArgs('ssh -N -L 8080:localhost:80 host').interactive, false, 'port forward only');
  assert.equal(S.parseSshArgs('ssh -f host sleep 1').interactive, false);
  assert.equal(S.parseSshArgs('ssh -W h:22 jump').interactive, false);
  assert.equal(S.parseSshArgs('ssh -O check host').interactive, false, 'control-master command');
  assert.equal(S.parseSshArgs('scp a b:/tmp'), null);
  assert.equal(S.parseSshArgs('sshd -D'), null);
  assert.equal(S.parseSshArgs('ssh'), null, 'no destination');
  assert.equal(S.parseSshArgs(''), null);
  assert.equal(S.parseSshArgs('ssh -- host').host, 'host');
});

test('resolveFromConfig: an alias picks up user, port and host name from ~/.ssh/config', () => {
  const hosts = [{ alias: 'vm', hostName: '192.168.64.4', user: 'ubuntu', port: 2200, proxyJump: '' }];
  const r = S.resolveFromConfig(S.parseSshArgs('ssh vm'), hosts);
  assert.equal(r.user, 'ubuntu');
  assert.equal(r.port, 2200);
  assert.equal(r.alias, 'vm');
  assert.equal(r.label, 'vm', 'a ~/.ssh/config name is what the window shows');
  assert.equal(r.id, 'ubuntu@192.168.64.4:2200', '…while rules are scoped by the real user@host:port');
  assert.equal(S.resolveFromConfig(S.parseSshArgs('ssh -l zed -p 22 vm'), hosts).user, 'zed', 'the command line wins over the config');
  assert.equal(S.resolveFromConfig(S.parseSshArgs('ssh other'), hosts).host, 'other');
});

test('parseSshConfig: hosts, first-value-wins, wildcards skipped, Match ignored, Include with globs', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'conf.d'));
  fs.writeFileSync(path.join(dir, 'conf.d', 'work.conf'), 'Host work-db\n  HostName 10.0.0.5\n  User dba\n');
  fs.writeFileSync(path.join(dir, 'conf.d', 'notes.txt'), 'Host should-not-load\n  HostName x\n');
  const text = [
    '# my machines',
    'Include conf.d/*.conf',
    'Host vm vm-alt   # two aliases',
    '  HostName 192.168.64.4',
    '  User ubuntu',
    '  Port 22',
    '  User ignored-second-value',
    '  IdentityFile ~/.ssh/id_vm',
    '  ProxyJump bastion',
    'Host *.internal build-?',
    '  User wildcard',
    'Host !secret *',
    '  ServerAliveInterval 30',
    'Match host foo',
    '  User nobody',
    'Host quoted',
    '  HostName="q.example.com"',
    'Host eq=1',
  ].join('\n');
  const hosts = S.parseSshConfig(text, { baseDir: dir });
  const by = Object.fromEntries(hosts.map((h) => [h.alias, h]));
  assert.deepEqual(Object.keys(by).sort(), ['eq=1', 'quoted', 'vm', 'vm-alt', 'work-db'].sort());
  assert.equal(by.vm.user, 'ubuntu', 'the first value wins, as in OpenSSH');
  assert.equal(by.vm.hostName, '192.168.64.4');
  assert.equal(by.vm.identityFile, 'id_vm', 'only the file name of the key');
  assert.equal(by.vm.proxyJump, 'bastion');
  assert.equal(by['vm-alt'].hostName, '192.168.64.4');
  assert.equal(by['work-db'].user, 'dba', 'included file');
  assert.equal(by.quoted.hostName, 'q.example.com');
  assert.ok(!by['should-not-load'], 'the glob only matches *.conf');
});

test('classifySshOutput: every connection problem has a kind, a level and a hint — and a clean session has none', () => {
  const cases = [
    ['@@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@@', 'host-key-changed', 'danger'],
    ["The authenticity of host 'x (1.2.3.4)' can't be established.", 'host-key-unknown', 'warn'],
    ['Host key verification failed.', 'host-key-failed', 'danger'],
    ['ubuntu@1.2.3.4: Permission denied (publickey,password).', 'auth-failed', 'warn'],
    ['Received disconnect: Too many authentication failures', 'auth-failed', 'warn'],
    ['ssh: connect to host 1.2.3.4 port 22: Connection refused', 'refused', 'warn'],
    ['ssh: connect to host 1.2.3.4 port 22: Operation timed out', 'timeout', 'warn'],
    ['ssh: Could not resolve hostname nope: Name or service not known', 'dns', 'warn'],
    ['ssh: connect to host 10.9.9.9 port 22: No route to host', 'unreachable', 'warn'],
    ['client_loop: send disconnect: Broken pipe', 'dropped', 'warn'],
    ['Timeout, server 1.2.3.4 not responding.', 'dropped', 'warn'],
    ['Connection to 1.2.3.4 closed by remote host.', 'dropped', 'warn'],
    ['Connection to 1.2.3.4 closed.', 'closed', 'info'],
  ];
  for (const [text, kind, level] of cases) {
    const r = S.classifySshOutput(text);
    assert.ok(r, text);
    assert.equal(r.kind, kind, text);
    assert.equal(r.level, level, text);
    assert.ok(r.hint.length > 10, 'every problem explains what to do');
  }
  assert.equal(S.classifySshOutput('ubuntu@host:~$ ls\nfile1 file2'), null);
  assert.equal(S.classifySshOutput(''), null);
  // the host-key-changed hint must not tell the user to run a command automatically
  assert.match(S.classifySshOutput('REMOTE HOST IDENTIFICATION HAS CHANGED').hint, /자동으로 실행하지 않습니다/);
  const fp = S.fingerprintOf("ED25519 key fingerprint is SHA256:abcDEF123+/=.\nAre you sure you want to continue connecting (yes/no)?");
  assert.deepEqual(fp, { type: 'ED25519', fingerprint: 'SHA256:abcDEF123+/=' });
  assert.equal(S.fingerprintOf('nothing here'), null);
});

test('shell kinds and the sentinel line for each: posix / fish / csh', () => {
  assert.equal(S.shellKind('/bin/bash'), 'posix');
  assert.equal(S.shellKind('-zsh'), 'posix', 'a login shell shows up as -zsh');
  assert.equal(S.shellKind('/usr/bin/fish'), 'fish');
  assert.equal(S.shellKind('/bin/tcsh'), 'csh');
  assert.equal(S.shellKind('/usr/bin/nu'), 'unknown');
  assert.equal(S.shellKind(''), 'unknown');
  const m = '__AITX1END';
  assert.equal(S.sentinelLine('posix', 'ls', m), `\x15ls; printf '\\n${m}:%s:%s__\\r\\033[2K' "$?" "$PWD"; : ${m}EOL\r`);
  assert.match(S.sentinelLine('fish', 'ls', m), /\$status \$PWD; : __AITX1ENDEOL\r$/);
  assert.match(S.sentinelLine('csh', 'ls', m), /\$status \$cwd; : __AITX1ENDEOL\r$/);
  assert.equal(S.sentinelLine('unknown', 'ls', m), S.sentinelLine('posix', 'ls', m));
});

test('probe parsing: the remote description is read from the output, never from the echoed command line', () => {
  assert.equal(S.parseShellProbe('echo AITSHELL:$SHELL\nAITSHELL:/bin/bash\n'), '/bin/bash');
  assert.equal(S.parseShellProbe('echo AITSHELL:$SHELL\n'), '', 'only the echoed (unexpanded) line');
  const out = `printf 'AITPROBE|%s|%s|%s|%s|%s|%s\\n' ...\nAITPROBE|ubuntu|ubuntu|Linux aarch64|bash|/home/ubuntu|/home/ubuntu/proj\n`;
  assert.deepEqual(S.parseProbe(out), { user: 'ubuntu', host: 'ubuntu', os: 'Linux', arch: 'aarch64', shell: 'bash', home: '/home/ubuntu', cwd: '/home/ubuntu/proj' });
  assert.equal(S.parseProbe("printf 'AITPROBE|%s|%s|%s|%s|%s|%s\\n'"), null);
  assert.ok(/AITPROBE/.test(S.probeCommand('posix')) && /\(id -un\)/.test(S.probeCommand('fish')) && /`id -un`/.test(S.probeCommand('csh')));
});

test('connectCommand: only a plain destination reaches the terminal (no option injection, no shell syntax)', () => {
  assert.equal(S.connectCommand('ubuntu@192.168.64.4'), 'ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=3 ubuntu@192.168.64.4');
  assert.equal(S.connectCommand('ubuntu@192.168.64.4', { keepAlive: false }), 'ssh ubuntu@192.168.64.4');
  assert.equal(S.connectCommand('dev@host:2200', { keepAlive: false }), 'ssh -p 2200 dev@host');
  assert.equal(S.connectCommand('myalias', { keepAlive: false }), 'ssh myalias');
  for (const bad of ['-oProxyCommand=touch /tmp/x', '-o', 'host; rm -rf ~', 'host && id', 'a b', '$(id)', '`id`', 'host|cat', '', 'user@', 'x'.repeat(400), 'host\nid']) {
    assert.equal(S.connectCommand(bad), null, JSON.stringify(bad));
    assert.equal(S.validTarget(bad), false, JSON.stringify(bad));
  }
});

test('HostBook: remembers names only, dedupes, caps at 20, survives a restart, file is private, bad targets refused', () => {
  const dir = tmp();
  const sshDir = tmp();
  fs.writeFileSync(path.join(sshDir, 'config'), 'Host vm\n  HostName 192.168.64.4\n  User ubuntu\n  IdentityFile ~/.ssh/id_vm\n');
  const b = new S.HostBook(dir, { sshDir });
  assert.equal(b.remember('ubuntu@192.168.64.4'), true);
  assert.equal(b.remember('--evil'), false);
  assert.equal(b.remember('a b'), false);
  for (let i = 0; i < 25; i++) b.remember(`u@h${i}`);
  b.remember('ubuntu@192.168.64.4');
  assert.equal(b.recent.length, 20);
  assert.equal(b.recent[0].target, 'ubuntu@192.168.64.4', 'most recent first');
  assert.equal(b.recent.filter((r) => r.target === 'ubuntu@192.168.64.4').length, 1, 'no duplicates');
  const file = path.join(dir, 'ssh-recent.json');
  const raw = fs.readFileSync(file, 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(raw)), ['recent']);
  assert.ok(JSON.parse(raw).recent.every((r) => Object.keys(r).sort().join() === 'at,target'), 'only the target and a time are stored');
  assert.equal(fs.statSync(file).mode & 0o077, 0, 'readable by the owner only');
  const again = new S.HostBook(dir, { sshDir });
  assert.equal(again.recent[0].target, 'ubuntu@192.168.64.4');
  assert.deepEqual(again.list().configured.map((h) => [h.alias, h.user, h.identityFile]), [['vm', 'ubuntu', 'id_vm']]);
  again.forget('ubuntu@192.168.64.4');
  assert.ok(!new S.HostBook(dir, { sshDir }).recent.some((r) => r.target === 'ubuntu@192.168.64.4'));
  // a hand-edited file with a hostile entry is filtered on load
  fs.writeFileSync(file, JSON.stringify({ recent: [{ target: '-oProxyCommand=x', at: 1 }, { target: 'ok@host', at: 2 }] }));
  assert.deepEqual(new S.HostBook(dir, { sshDir }).recent.map((r) => r.target), ['ok@host']);
  assert.deepEqual(new S.HostBook(dir, { sshDir: path.join(dir, 'nope') }).configured(), []);
});

test('SshWatcher: reports an interactive ssh child, not port forwards or remote commands, and tells when it ends', async () => {
  const session = Object.assign(new EventEmitter(), { pid: 100, state: 'busy' });
  let procs = [];
  const w = new S.SshWatcher(session, { descendants: async () => procs, hosts: () => [{ alias: 'vm', hostName: '192.168.64.4', user: 'ubuntu', port: 0, proxyJump: '' }] });
  const seen = [];
  w.on('change', (c) => seen.push(c));
  await w.poll();
  assert.equal(seen.length, 0, 'nothing running');
  procs = [{ pid: 7, ppid: 100, depth: 0, command: 'ssh -N -L 8080:localhost:80 host' }, { pid: 8, ppid: 100, depth: 0, command: 'ssh host uptime' }, { pid: 9, ppid: 100, depth: 0, command: 'sshd -D' }];
  await w.poll();
  assert.equal(seen.length, 0, 'forward-only, remote-command and sshd are not shells');
  procs = [{ pid: 12, ppid: 100, depth: 0, command: 'ssh vm' }];
  await w.poll();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].active, true);
  assert.equal(seen[0].target.label, 'vm', 'the alias is what the window shows');
  assert.equal(seen[0].target.id, 'ubuntu@192.168.64.4', 'the alias is resolved through ~/.ssh/config');
  await w.poll();
  assert.equal(seen.length, 1, 'no event while nothing changes');
  procs = [];
  await w.poll();
  assert.deepEqual(seen[1], { active: false });
  // a descendants() failure keeps the last state instead of flapping
  procs = [{ pid: 12, ppid: 100, depth: 0, command: 'ssh vm' }];
  await w.poll();
  w.descendants = async () => { throw new Error('ps failed'); };
  await w.poll();
  assert.equal(w.active.pid, 12);
});

test('SshWatcher: problems found in the output are reported once per 15 s, with the fingerprint for a new host', () => {
  const session = Object.assign(new EventEmitter(), { pid: 1, state: 'busy' });
  const w = new S.SshWatcher(session, { descendants: async () => [] });
  w.start();
  try {
    const got = [];
    w.on('problem', (p) => got.push(p));
    session.emit('data', "The authenticity of host 'h' can't be established.\r\nED25519 key fingerprint is SHA256:AAAA.\r\n");
    session.emit('data', "The authenticity of host 'h' can't be established.\r\nED25519 key fingerprint is SHA256:AAAA.\r\n");
    assert.equal(got.length, 1, 'a repeat of the same problem inside 15 s is dropped');
    assert.equal(got[0].kind, 'host-key-unknown');
    assert.deepEqual(got[0].fingerprint, { type: 'ED25519', fingerprint: 'SHA256:AAAA' });
    session.emit('data', 'ssh: connect to host h port 22: Connection refused\r\n');
    assert.equal(got.at(-1).kind, 'refused');
    session.emit('data', 'plain output\r\n');
    assert.equal(got.length, 2);
  } finally { w.stop(); }
});

test('SshWatcher: the fingerprint arriving in a later chunk than the host-key question is still reported', async () => {
  const session = Object.assign(new EventEmitter(), { pid: 1, state: 'busy' });
  const w = new S.SshWatcher(session, { descendants: async () => [] });
  w.start();
  try {
    const got = [];
    w.on('problem', (p) => got.push(p));
    session.emit('data', "The authenticity of host 'h (1.2.3.4)' can't be established.\r\n");
    assert.equal(got.length, 0, 'waits briefly for the fingerprint line');
    session.emit('data', 'ED25519 key fingerprint is SHA256:ZZZZ.\r\nThis key is not known by any other names\r\n');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(got.length, 1);
    assert.deepEqual(got[0].fingerprint, { type: 'ED25519', fingerprint: 'SHA256:ZZZZ' });
    // and when no fingerprint ever comes, the question is still reported after the grace period
    const lone = new EventEmitter(); lone.pid = 2; lone.state = 'busy';
    const w2 = new S.SshWatcher(lone, { descendants: async () => [] });
    w2.start();
    const got2 = [];
    w2.on('problem', (p) => got2.push(p));
    lone.emit('data', "The authenticity of host 'z' can't be established.\r\n");
    await new Promise((r) => setTimeout(r, 450));
    w2.stop();
    assert.equal(got2.length, 1);
    assert.equal(got2[0].fingerprint, undefined);
  } finally { w.stop(); }
});

test('externalSshTarget: --ssh=<host> from the command line, only acceptable destinations', () => {
  assert.equal(S.externalSshTarget(['AI Terminal', '--ssh', 'ubuntu']), 'ubuntu');
  assert.equal(S.externalSshTarget(['--ssh=deploy@192.0.2.10']), 'deploy@192.0.2.10');
  assert.equal(S.externalSshTarget(['--user-data-dir=/x', '--ssh=dgx', '--other']), 'dgx');
  // Electron's reordering of a second launch: the separate value is lost, and that must not pick up a switch or '.'
  assert.equal(S.externalSshTarget(['Electron', '--ssh', '--allow-file-access-from-files', '.', 'dgx']), null);
  assert.equal(S.externalSshTarget([]), null);
  assert.equal(S.externalSshTarget(['--ssh']), null, 'missing value');
  assert.equal(S.externalSshTarget(['--ssh', '-oProxyCommand=touch /tmp/x']), null, 'an option is not a destination');
  assert.equal(S.externalSshTarget(['--ssh', 'host;rm -rf ~']), null, 'shell syntax is refused');
  assert.equal(S.externalSshTarget(['--ssh=a b']), null);
  assert.equal(S.externalSshTarget(null), null);
  // the command main hands to the window comes from connectCommand, never from the raw argument
  assert.equal(S.connectCommand(S.externalSshTarget(['--ssh', 'ubuntu'])), 'ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=3 ubuntu');
});
