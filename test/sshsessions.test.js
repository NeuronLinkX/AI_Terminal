'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { SessionStore, validateSession, buildCommand, buildDestinationCommand, pathOk, jumpOk } = require('../src/main/sshsessions');
const { parseSshArgs } = require('../src/main/ssh');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ait-sess-'));
/** What the SHELL makes of a typed command line: its argument vector (and proof that nothing else got executed). */
function argvOf(command) {
  const script = `ssh() { for a in "$@"; do printf '%s\\n' "$a"; done; }; ${command}`;
  return execFileSync('/bin/bash', ['-c', script], { encoding: 'utf8' }).split('\n').slice(0, -1);
}
const base = { name: 'Build box', host: '192.168.64.4', user: 'ubuntu' };

test('a minimal session is valid and gets sensible defaults; unknown fields (a password!) are dropped', () => {
  const v = validateSession({ ...base, password: 'hunter2', privateKey: '-----BEGIN', token: 'x', evil: { a: 1 } });
  assert.equal(v.ok, true);
  assert.deepEqual(Object.keys(v.session).sort(), ['createdAt', 'folder', 'forwards', 'host', 'id', 'jump', 'keepAlive', 'keyFile', 'lastUsed', 'name', 'notes', 'port', 'share', 'startDir', 'user', 'x11']);
  assert.equal(v.session.port, 22);
  assert.equal(v.session.keepAlive, true);
  assert.equal(v.session.share, true);
  assert.equal(v.session.x11, 'off');
  assert.ok(!JSON.stringify(v.session).includes('hunter2'), 'no password field exists in the schema');
  assert.equal(validateSession({ host: 'example.com' }).session.name, 'example.com', 'the name defaults to user@host');
  assert.equal(validateSession({ host: 'h', user: 'u' }).session.name, 'u@h');
});

test('every field is checked: bad hosts, users, ports, paths, jump hosts and tunnels are refused with a reason', () => {
  const bad = (patch) => validateSession({ ...base, ...patch });
  const fields = (r) => (r.ok ? [] : r.errors.map((e) => e.field));
  assert.ok(fields(validateSession({ name: 'x' })).includes('host'));
  for (const h of ['-oProxyCommand=x', 'host name', 'a;b', 'a&&b', '$(id)', '`id`', 'a|b', 'a\nb', '', 'x'.repeat(300), "a'b", 'a"b', '../x']) {
    assert.ok(fields(bad({ host: h })).includes('host'), `host ${JSON.stringify(h)}`);
  }
  for (const h of ['example.com', '10.0.0.1', 'host-1.internal', 'my_host', 'fe80::1', '[fe80::1]', 'a.b.c.d']) assert.equal(bad({ host: h }).ok, true, h);
  for (const u of ['-x', 'a b', 'a;b', 'a@b', '$x', 'x'.repeat(70), '']) if (u) assert.ok(fields(bad({ user: u })).includes('user'), `user ${u}`);
  assert.equal(bad({ user: '' }).ok, true, 'the user may be empty (ssh uses the default / ~/.ssh/config)');
  for (const p of [0, 70000, -1, 'abc', 22.5]) assert.ok(fields(bad({ port: p })).includes('port'), `port ${p}`);
  assert.equal(bad({ port: '2222' }).session.port, 2222);
  for (const k of ["/tmp/a'b", '/tmp/a"b', '/tmp/a$b', '/tmp/a`b', '/tmp/a\\b', 'relative/key', '/tmp/a\nb', '~', '']) if (k) assert.ok(fields(bad({ keyFile: k })).includes('keyFile'), `key ${JSON.stringify(k)}`);
  for (const k of ['/Users/me/.ssh/id_work', '~/.ssh/id ed25519', '/tmp/한글 키']) assert.equal(bad({ keyFile: k }).ok, true, k);
  for (const j of ['-oProxy=x', 'a b', 'u@h;id', 'a,b,c,d', 'u@h:99999', '@h']) assert.ok(fields(bad({ jump: j })).includes('jump'), `jump ${j}`);
  for (const j of ['bastion', 'u@bastion', 'u@bastion:2200', 'a@b,c@d:22,e']) assert.equal(bad({ jump: j }).ok, true, j);
  for (const d of ['relative', '~/x', '/a"b', "/a'b", '/a$b', '/a\nb']) assert.ok(fields(bad({ startDir: d })).includes('startDir'), `startDir ${JSON.stringify(d)}`);
  assert.equal(bad({ startDir: '/srv/my app' }).ok, true);
  assert.ok(fields(bad({ name: 'x'.repeat(61) })).includes('name'));
  assert.ok(fields(bad({ name: 'a\nb' })).includes('name'));
  assert.equal(pathOk('/ok/path'), true);
  assert.equal(jumpOk('a,b'), true);
});

test('tunnels: local / remote / dynamic, validated; at most 12', () => {
  const ok = validateSession({ ...base, forwards: [{ kind: 'L', listenPort: 8080, host: 'localhost', port: 80 }, { kind: 'R', listenPort: 9000, host: '127.0.0.1', port: 3000 }, { kind: 'D', listenPort: 1080 }] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.session.forwards, [{ kind: 'L', listenPort: 8080, host: 'localhost', port: 80 }, { kind: 'R', listenPort: 9000, host: '127.0.0.1', port: 3000 }, { kind: 'D', listenPort: 1080 }]);
  for (const f of [{ kind: 'X', listenPort: 1 }, { kind: 'L', listenPort: 0, host: 'h', port: 1 }, { kind: 'L', listenPort: 80, host: 'h;id', port: 1 }, { kind: 'L', listenPort: 80, host: 'h', port: 99999 }, { kind: 'L', listenPort: 80, host: '-o x', port: 1 }, { kind: 'D' }, null]) {
    assert.equal(validateSession({ ...base, forwards: [f] }).ok, false, JSON.stringify(f));
  }
  assert.equal(validateSession({ ...base, forwards: Array.from({ length: 13 }, (_, i) => ({ kind: 'D', listenPort: 2000 + i })) }).ok, false);
});

test('buildCommand: the shell sees exactly the intended arguments — no extra option, nothing executed', () => {
  const home = '/Users/test';
  const s = { ...base, port: 2222, keyFile: '~/.ssh/id work', jump: 'jumper@bastion:2200', x11: 'safe', forwards: [{ kind: 'L', listenPort: 8080, host: 'localhost', port: 80 }, { kind: 'D', listenPort: 1080 }], startDir: '/srv/my app' };
  const r = buildCommand(s, { ctlDir: '/tmp/ait-ssh-501', home });
  assert.equal(r.ok, true);
  assert.deepEqual(argvOf(r.command), [
    '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-o', 'ControlMaster=auto', '-o', 'ControlPath=/tmp/ait-ssh-501/%C',
    '-p', '2222', '-i', '/Users/test/.ssh/id work', '-o', 'IdentitiesOnly=yes', '-J', 'jumper@bastion:2200', '-X', '-L', '8080:localhost:80', '-D', '1080', '-t',
    'ubuntu@192.168.64.4', 'cd "/srv/my app" && exec "$SHELL" -l',
  ]);
  // the same line, read back the way the app reads a typed ssh command (so the watcher / monitor / file panel can follow it)
  const t = parseSshArgs(r.command.replace(/^ssh /, 'ssh ').replace(/'/g, '"'));
  assert.equal(t.user, 'ubuntu');
  assert.equal(t.host, '192.168.64.4');
  assert.equal(t.port, 2222);
  assert.equal(t.jump, 'jumper@bastion:2200');
  assert.equal(t.interactive, true, 'a start folder uses -t with a command: still a login the user works in');
  // defaults: nothing optional appears
  const plain = buildCommand({ host: 'example.com' }, { ctlDir: null });
  assert.equal(plain.command, 'ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=3 example.com');
  assert.equal(buildCommand({ host: 'example.com', keepAlive: false, share: false }, { ctlDir: '/tmp/x' }).command, 'ssh example.com');
  assert.ok(buildCommand({ host: 'h', x11: 'trusted' }, { ctlDir: null }).command.includes(' -Y '));
});

test('hostile values never reach a command line: they are refused, and what is accepted is a plain argv', () => {
  const attacks = [
    { host: 'x -oProxyCommand=touch /tmp/pwned' }, { host: 'x; touch /tmp/pwned' }, { host: '$(touch /tmp/pwned)' },
    { host: 'ok', user: 'u; touch /tmp/pwned' }, { host: 'ok', keyFile: "/tmp/k'; touch /tmp/pwned; '" }, { host: 'ok', jump: 'a;touch /tmp/pwned' },
    { host: 'ok', startDir: '/x"; touch /tmp/pwned; "' }, { host: 'ok', forwards: [{ kind: 'L', listenPort: 1, host: 'h;touch /tmp/pwned', port: 1 }] },
  ];
  fs.rmSync('/tmp/pwned', { force: true });
  for (const a of attacks) {
    const r = buildCommand(a);
    assert.equal(r.ok, false, JSON.stringify(a));
    assert.ok(r.errors.length >= 1);
  }
  assert.ok(!fs.existsSync('/tmp/pwned'));
});

test('SessionStore: save / edit / duplicate / delete, survives a restart, file is private and holds no secrets, damaged entries are skipped', () => {
  const dir = tmp();
  const st = new SessionStore(dir);
  const a = st.save({ ...base, folder: 'Work', password: 'nope' });
  assert.equal(a.ok, true);
  assert.match(a.session.id, /^[a-f0-9]{16}$/);
  const id = a.session.id;
  const b = st.save({ id, name: 'Renamed', host: 'new.example.com', user: 'dev', port: 2200, forwards: [{ kind: 'D', listenPort: 1080 }] });
  assert.equal(b.session.id, id, 'saving with an id edits that session');
  assert.equal(st.list().length, 1);
  assert.equal(st.get(id).createdAt, a.session.createdAt, 'the creation time is kept');
  const copy = st.duplicate(id);
  assert.equal(copy.ok, true);
  assert.notEqual(copy.session.id, id);
  assert.equal(copy.session.name, 'Renamed (복사)');
  assert.equal(st.list().length, 2);
  st.touch(id);
  assert.ok(st.get(id).lastUsed > 0);
  assert.equal(st.save({ id, host: 'bad host' }).ok, false);
  assert.equal(st.get(id).host, 'new.example.com', 'a refused edit changes nothing');

  const file = path.join(dir, 'ssh-sessions.json');
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!/password|passphrase|BEGIN|nope/i.test(raw), raw);
  assert.equal(fs.statSync(file).mode & 0o077, 0, 'readable by the owner only');
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')), 'the atomic write left no temp file');

  const again = new SessionStore(dir);
  assert.deepEqual(again.list().map((s) => s.name).sort(), ['Renamed', 'Renamed (복사)']);
  // a hand-edited file with a hostile or broken entry
  const j = JSON.parse(raw);
  j.sessions.push({ id: 'abcdef0123456789', name: 'evil', host: '-oProxyCommand=x' }, { name: 'no id', host: 'h' }, 'junk', null);
  fs.writeFileSync(file, JSON.stringify(j));
  assert.deepEqual(new SessionStore(dir).list().map((s) => s.name).sort(), ['Renamed', 'Renamed (복사)'], 'unsafe or malformed entries are skipped on load');
  assert.equal(again.remove(id), true);
  assert.equal(again.remove(id), false);
  assert.equal(new SessionStore(dir).list().length, 1);
  fs.writeFileSync(file, '{ not json');
  assert.deepEqual(new SessionStore(dir).list(), []);
});

test('importing from ~/.ssh/config: a prefilled session that still goes through validation', () => {
  const st = new SessionStore(tmp());
  const p = st.fromConfig({ alias: 'vm', hostName: '192.168.64.4', user: 'ubuntu', port: 2200, proxyJump: 'bastion' });
  assert.deepEqual([p.name, p.host, p.user, p.port, p.jump], ['vm', '192.168.64.4', 'ubuntu', 2200, 'bastion']);
  assert.equal(st.save(p).ok, true);
  assert.equal(validateSession(st.fromConfig({ alias: 'x', hostName: '-oEvil=1' })).ok, false);
});

test('buildDestinationCommand: an alias or a recent user@host:port becomes a plain ssh command; anything else is refused', () => {
  const o = { ctlDir: '/tmp/ait-ssh-501' };
  assert.deepEqual(argvOf(buildDestinationCommand('vm', o).command), ['-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-o', 'ControlMaster=auto', '-o', 'ControlPath=/tmp/ait-ssh-501/%C', 'vm']);
  assert.deepEqual(argvOf(buildDestinationCommand('ubuntu@192.168.64.4:2200', { ...o, share: false, keepAlive: false }).command), ['-p', '2200', 'ubuntu@192.168.64.4']);
  assert.deepEqual(argvOf(buildDestinationCommand('u@h:22', { ...o, share: false, keepAlive: false }).command), ['u@h'], 'port 22 is the default');
  assert.deepEqual(argvOf(buildDestinationCommand('[fe80::1]', { ctlDir: null, keepAlive: false }).command), ['[fe80::1]']);
  for (const bad of ['-oProxyCommand=x', 'a b', 'h;id', '$(id)', 'u@', '@h', 'h:99999', 'h:0', '', 'x'.repeat(300), "h'x"]) {
    assert.equal(buildDestinationCommand(bad, o).ok, false, JSON.stringify(bad));
  }
});
