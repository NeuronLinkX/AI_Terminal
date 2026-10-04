'use strict';
// The remote layer against REAL shells: a nested bash inside a real PTY stands in for the far side of an ssh session
// (the sentinel does not care which program owns the foreground — that is exactly how it works over ssh).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PtySession } = require('../src/main/pty-session');
const { RemoteFS, resolveRemote, pathProblem, shCmd, sha256 } = require('../src/main/remotefs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ait-remote-')));

/** A PTY whose foreground program is a nested bash (state 'busy'), like a shell reached through ssh. */
async function nestedShell(cwd) {
  const s = new PtySession({ cwd }).start();
  await new Promise((r) => { const i = setInterval(() => s.integrated && (clearInterval(i), r()), 50); });
  const r = await s.runCommand('bash --noprofile --norc', { idleMs: 700 });
  assert.equal(r.status, 'running');
  assert.equal(s.state, 'busy');
  await sleep(300);
  return s;
}
const runnerFor = (s, tweak) => ({
  run: (cmd, o = {}) => s.runSentinel(cmd, { kind: 'posix', ...o }),
  upload: (dest, lines, o = {}) => s.uploadToRemote(dest, tweak ? tweak(lines) : lines, o),
});

test('sentinel: output, exit status and cwd come back; a long wrapped command is not left in the output', async () => {
  const dir = tmp();
  const s = await nestedShell(dir);
  try {
    let r = await s.runSentinel(`cd ${dir} && echo hello && pwd`);
    assert.equal(r.status, 'done');
    assert.equal(r.exitCode, 0);
    assert.equal(r.cwd, dir);
    assert.equal(r.output, `hello\n${dir}`);
    r = await s.runSentinel('false');
    assert.equal(r.exitCode, 1);
    assert.equal(r.output, '');
    const long = `echo ${'x'.repeat(400)}`; // wider than the terminal: the echo of the typed line wraps
    r = await s.runSentinel(long);
    assert.equal(r.output, 'x'.repeat(400), 'only the command output, no echo of the typed line');
    r = await s.runSentinel('echo $((6*7)); echo err 1>&2; (exit 3)');
    assert.equal(r.exitCode, 3);
    assert.match(r.output, /42/);
    assert.match(r.output, /err/);
  } finally { s.kill(); }
});

test('sentinel: the far side going away is reported as disconnected, not as a hang', async () => {
  const s = await nestedShell(tmp());
  try {
    const t0 = Date.now();
    const r = await s.runSentinel('echo bye; exit 0', { maxMs: 20000 });
    assert.equal(r.status, 'disconnected');
    assert.ok(Date.now() - t0 < 6000, 'noticed promptly');
    assert.equal((await s.runSentinel('echo again')).status, 'disconnected', 'and later requests say so at once');
  } finally { s.kill(); }
});

test('sentinel: a password prompt stops the AI (waiting_input) and a full-screen program is never typed into', async () => {
  const s = await nestedShell(tmp());
  try {
    const r = await s.runSentinel('read -s -p "Password: " pw; echo got', { maxMs: 20000 });
    assert.equal(r.status, 'waiting_input');
    s.write('\r'); // the user answers
    await sleep(500);
    s.write('printf "\\033[?1049h"\r'); // what vim / top / less do on start
    await sleep(500);
    assert.equal((await s.runSentinel('echo nope')).status, 'fullscreen');
    s.write('printf "\\033[?1049l"\r');
    await sleep(500);
    const ok = await s.runSentinel('echo fine');
    assert.equal(ok.status, 'done');
    assert.equal(ok.output, 'fine');
  } finally { s.kill(); }
});

test('RemoteFS paths: ~ / relative / absolute resolve on the remote side; unquotable characters are refused', () => {
  assert.equal(resolveRemote('~/a/b.txt', { home: '/home/u' }), '/home/u/a/b.txt');
  assert.equal(resolveRemote('~', { home: '/home/u' }), '/home/u');
  assert.equal(resolveRemote('src/../x.js', { cwd: '/srv/app', home: '/home/u' }), '/srv/app/x.js');
  assert.equal(resolveRemote('/etc/hosts', { cwd: '/srv' }), '/etc/hosts');
  assert.equal(resolveRemote('rel', { home: '/home/u' }), '/home/u/rel', 'no cwd known yet: relative to home');
  for (const bad of ["it's", 'a\nb', 'a\0b', '', 'x'.repeat(1100)]) assert.notEqual(pathProblem(bad), '', JSON.stringify(bad));
  assert.equal(pathProblem('/home/u/한글 폴더/a b.txt'), '', 'spaces and unicode are fine');
  assert.throws(() => shCmd("echo 'x'"), /single quote/);
});

test('RemoteFS: stat, read (whole / range), refusals — on a real shell', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'a.txt'), Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'ctl.txt'), 'plain\x1b[31mred\x1b]777;ait;D;0;ZXZpbA==\x07tail\n');
  fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 3, 255, 0, 9]));
  fs.writeFileSync(path.join(dir, 'empty.txt'), '');
  fs.writeFileSync(path.join(dir, '한글 파일.txt'), '안녕하세요\n두 번째 줄\n');
  fs.writeFileSync(path.join(dir, 'big.txt'), 'y'.repeat(300 * 1024));
  const s = await nestedShell(dir);
  try {
    const rfs = new RemoteFS(runnerFor(s), { home: dir, getCwd: () => dir });
    assert.deepEqual(await rfs.stat(path.join(dir, 'nope')), { kind: 'none', size: 0, text: true });
    assert.equal((await rfs.stat(dir)).kind, 'dir');
    assert.deepEqual(await rfs.stat(path.join(dir, 'a.txt')), { kind: 'file', size: fs.statSync(path.join(dir, 'a.txt')).size, text: true });
    assert.equal((await rfs.stat(path.join(dir, 'bin.dat'))).text, false);
    assert.equal((await rfs.stat(path.join(dir, 'empty.txt'))).text, true);

    let r = await rfs.read(path.join(dir, 'a.txt'));
    assert.equal(r.totalLines, 50);
    assert.ok(r.content.startsWith('line 1\n') && r.content.endsWith('line 50'));
    r = await rfs.read(path.join(dir, 'a.txt'), 10, 12);
    assert.equal(r.content, 'line 10\nline 11\nline 12');
    assert.deepEqual([r.from, r.to, r.totalLines], [10, 12, 50]);
    assert.equal((await rfs.read(path.join(dir, 'a.txt'), 48)).content, 'line 48\nline 49\nline 50');

    r = await rfs.read(path.join(dir, 'ctl.txt'));
    assert.equal(r.content, 'plain[31mred]777;ait;D;0;ZXZpbA==tail', 'ESC and BEL are removed: no escape sequence survives');
    assert.equal((await rfs.read(path.join(dir, 'empty.txt'))).content, '');
    assert.equal((await rfs.read(path.join(dir, '한글 파일.txt'))).content, '안녕하세요\n두 번째 줄', 'unicode and spaces in the path');
    assert.match((await rfs.read(path.join(dir, 'bin.dat'))).error, /바이너리/);
    assert.match((await rfs.read(path.join(dir, 'big.txt'))).error, /너무 큽니다/);
    assert.match((await rfs.read(path.join(dir, 'nope'))).error, /없거나/);
    assert.match((await rfs.read(dir)).error, /없거나|일반 파일/, 'a directory is not a file');
    assert.match((await rfs.read("/tmp/it's")).error, /작은따옴표/);
    // the shell is still healthy after all that
    assert.equal((await s.runSentinel('echo alive')).output, 'alive');
  } finally { s.kill(); }
});

test('RemoteFS.write: verified transfer, nothing echoed to the terminal, mode kept, new file created, temp files gone', async () => {
  const dir = tmp();
  const target = path.join(dir, 'conf.txt');
  fs.writeFileSync(target, 'old\n', { mode: 0o640 });
  const inode = fs.statSync(target).ino;
  const s = await nestedShell(dir);
  const seen = [];
  s.on('data', (t) => seen.push(t));
  try {
    const rfs = new RemoteFS(runnerFor(s), { home: dir, getCwd: () => dir });
    const content = `# 설정\r\nkey = "값"\n\tindented\n${'z'.repeat(1500)}\nno trailing newline`;
    const w = await rfs.write(target, content);
    assert.equal(w.ok, true, JSON.stringify(w));
    assert.equal(w.created, false);
    assert.equal(w.hash, sha256(content));
    assert.equal(fs.readFileSync(target, 'utf8'), content, 'byte-exact, CRLF / unicode / tabs / missing newline included');
    assert.equal(fs.statSync(target).mode & 0o777, 0o640, 'permissions of the existing file are kept');
    assert.equal(fs.statSync(target).ino, inode, 'the same file was updated in place');
    const b64 = Buffer.from(content).toString('base64');
    assert.ok(!seen.join('').includes(b64.slice(40, 120)), 'the payload was NOT echoed into the terminal the user is watching');
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.ait-')), [], 'no temp files left');
    const echo = await s.runSentinel('stty -a | tr " " "\\n" | grep -x -e "echo" -e "-echo"');
    assert.equal(echo.output, 'echo', 'the tty echo is back on');

    const created = await rfs.write(path.join(dir, 'new.txt'), 'brand new\n');
    assert.deepEqual([created.ok, created.created], [true, true]);
    assert.equal(fs.readFileSync(path.join(dir, 'new.txt'), 'utf8'), 'brand new\n');
    assert.equal(fs.statSync(path.join(dir, 'new.txt')).mode & 0o777, 0o644);
    assert.equal((await rfs.write(path.join(dir, 'empty.out'), '')).ok, true);
    assert.equal(fs.readFileSync(path.join(dir, 'empty.out'), 'utf8'), '');
    assert.equal((await rfs.hash(target)).hash, sha256(content));
  } finally { s.kill(); }
});

test('RemoteFS.write: refusals and failures leave the target file untouched', async () => {
  const dir = tmp();
  const target = path.join(dir, 'keep.txt');
  fs.writeFileSync(target, 'precious\n');
  fs.mkdirSync(path.join(dir, 'ro'));
  fs.chmodSync(path.join(dir, 'ro'), 0o555);
  const s = await nestedShell(dir);
  try {
    const rfs = new RemoteFS(runnerFor(s), { home: dir, getCwd: () => dir });
    assert.match((await rfs.write(path.join(dir, 'no', 'such', 'f.txt'), 'x')).error, /디렉터리가 없습니다/);
    assert.match((await rfs.write(path.join(dir, 'ro', 'f.txt'), 'x')).error, /쓰기 권한이 없습니다/);
    assert.match((await rfs.write("/tmp/q'uote", 'x')).error, /작은따옴표/);
    assert.match((await rfs.write(target, 'x'.repeat(201 * 1024))).error, /너무 큽니다/);
    assert.match((await new RemoteFS(runnerFor(s), { posix: false }).write(target, 'x')).error, /지원하지 않습니다/);
    // a transfer that arrives damaged: the checksum catches it and the file is not touched
    const bad = new RemoteFS(runnerFor(s, (lines) => lines.map((l, i) => (i === 0 ? 'A' + l.slice(1) : l))), { home: dir, getCwd: () => dir });
    const r = await bad.write(target, 'replacement that must never be installed\n');
    assert.match(r.error, /달라져 파일을 바꾸지 않았습니다/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'precious\n');
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.ait-')), [], 'and the partial files are removed');
    assert.equal((await s.runSentinel('echo ok')).output, 'ok');
  } finally { s.kill(); fs.chmodSync(path.join(dir, 'ro'), 0o755); }
});

test('RemoteFS.search finds matches, skips .git, tells when nothing matched', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'const needle = 1;\nother\n');
  fs.writeFileSync(path.join(dir, '.git', 'x'), 'needle in git\n');
  const s = await nestedShell(dir);
  try {
    const rfs = new RemoteFS(runnerFor(s), { home: dir, getCwd: () => dir });
    const r = await rfs.search('needle', dir);
    assert.ok(r.count >= 1 && /a\.js/.test(r.content), r.content);
    assert.ok(!/\.git/.test(r.content));
    assert.equal((await rfs.search('zzz-no-such-text', dir)).count, 0);
    assert.match((await rfs.search("it's", dir)).error, /작은따옴표/);
  } finally { s.kill(); }
});

test('RemoteFS reports a dropped connection and a password wait instead of pretending', async () => {
  const s = await nestedShell(tmp());
  const rfs = new RemoteFS(runnerFor(s), { home: '/', getCwd: () => '/' });
  try {
    s.write('\x15exit\r');
    await sleep(800);
    assert.match((await rfs.read('/etc/hosts')).error, /연결이 끊어졌습니다/);
    assert.match((await rfs.write('/tmp/x', 'y')).error, /연결이 끊어졌습니다/);
  } finally { s.kill(); }
});

test('RemoteFS.read keeps the exact bytes the machine needs for editing: indent, CRLF, secrets-looking text, trailing newline', async () => {
  const dir = tmp();
  const cases = {
    'indented.txt': '    first line is indented\n\tsecond uses a tab\n\n\nlast\n',
    'crlf.txt': 'one\r\ntwo\r\nthree\r\n',
    'nonl.txt': 'no newline at the end',
    'blank-first.txt': '\n\nstarts with blank lines\n',
    'secret.txt': 'API_KEY=sk-abcdefghijklmnopqrstuvwxyz1234567890\ntoken: ghp_abcdefghijklmnopqrstuvwxyz0123456789\n',
    'korean.txt': '한글 내용\n   들여쓴 줄\n',
  };
  for (const [n, c] of Object.entries(cases)) fs.writeFileSync(path.join(dir, n), c);
  const s = await nestedShell(dir);
  try {
    const rfs = new RemoteFS(runnerFor(s), { home: dir, getCwd: () => dir });
    for (const [n, c] of Object.entries(cases)) {
      const r = await rfs.read(path.join(dir, n));
      assert.equal(r.exact, c, `${n}: exact content`);
      assert.equal((await rfs.hash(path.join(dir, n))).hash, sha256(c), `${n}: hash of the raw bytes`);
    }
    // so a read → change → write round trip is lossless
    const r = await rfs.read(path.join(dir, 'indented.txt'));
    await rfs.write(path.join(dir, 'indented.txt'), r.exact.replace('last', 'LAST'));
    assert.equal(fs.readFileSync(path.join(dir, 'indented.txt'), 'utf8'), cases['indented.txt'].replace('last', 'LAST'));
    await rfs.write(path.join(dir, 'crlf.txt'), (await rfs.read(path.join(dir, 'crlf.txt'))).exact);
    assert.equal(fs.readFileSync(path.join(dir, 'crlf.txt'), 'utf8'), cases['crlf.txt'], 'CRLF files stay CRLF');
  } finally { s.kill(); }
});

test('afterEcho: the bare CR that bash 5 leaves after "bracketed paste off" is not part of the command output', () => {
  const { afterEcho } = require('../src/main/pty-session');
  assert.equal(afterEcho('cmd; : TOKEN\r\n\rAITBEGIN\nx\n', 'TOKEN'), 'AITBEGIN\nx\n');
  assert.equal(afterEcho('cmd; : TOK \rEN\r\n\r\rout\r\n', 'TOKEN'), 'out\r\n', 'a wrapped echo and several CRs');
  assert.equal(afterEcho('no marker here', 'TOKEN'), null);
});
