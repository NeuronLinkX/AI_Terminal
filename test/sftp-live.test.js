'use strict';
// The file panel's engine against a REAL ssh server (throw-away sshd on 127.0.0.1, see helpers/sshd.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RemoteBrowser, localList, parseListing, shCmd, permString, safeName, b64 } = require('../src/main/sftp');
const { SshLink } = require('../src/main/sshlink');
const { parseSshArgs } = require('../src/main/ssh');
const { startSshd } = require('./helpers/sshd');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ait-sftp-')));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const until = async (f, ms = 20000) => { const t = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t > ms) return false; await sleep(40); } };

let srv; let link; let rb;
test.before(async () => {
  srv = await startSshd();
  if (!srv) return;
  link = new SshLink(parseSshArgs(srv.command));
  rb = new RemoteBrowser(link);
});
test.after(() => { if (rb) rb.close(); if (srv) srv.stop(); });
const need = (t) => { if (srv) return true; t.skip('sshd cannot run here'); return false; };
const finished = (id) => until(() => { const t = rb.transfers.get(id); return t && ['done', 'error', 'cancelled'].includes(t.state) ? t : null; });

test('parsing: entries, symlinks, permission strings, unsafe names are dropped — no server needed', () => {
  const out = [
    'AITPWD:/srv/app', 'AITLS:directory|4096|755|1700000000|ubuntu|./src', 'AITLS:regular file|1234|644|1700000100|ubuntu|./a b.txt',
    'AITLS:Regular File|5|600|1700000200|root|./.env', 'AITLS:symbolic link|9|777|1700000300|ubuntu|./latest', 'AITLS:Symbolic Link|5|755|1|u|./cfg',
    'AITLS:fifo|0|644|1|u|./pipe', 'AITLS:directory|1|755|1|u|./..', 'AITLS:regular file|1|644|1|u|./bad\x00name', 'AITLNK:d|./latest|releases/2026', 'AITLNK:f|./cfg|/etc/app.conf', 'AITEND',
  ].join('\n');
  const r = parseListing(out);
  assert.equal(r.cwd, '/srv/app');
  assert.deepEqual(r.entries.map((e) => e.name), ['latest', 'src', '.env', 'a b.txt', 'cfg', 'pipe'], 'folders (and links to folders) first, then natural order');
  const by = Object.fromEntries(r.entries.map((e) => [e.name, e]));
  assert.deepEqual([by.src.type, by['a b.txt'].type, by.latest.type, by.pipe.type], ['dir', 'file', 'link', 'other']);
  assert.deepEqual(by.latest.link, { target: 'releases/2026', dir: true });
  assert.deepEqual(by.cfg.link, { target: '/etc/app.conf', dir: false });
  assert.equal(by['a b.txt'].perm, 'rw-r--r--');
  assert.equal(by['.env'].perm, 'rw-------');
  assert.equal(permString('755'), 'rwxr-xr-x');
  assert.equal(parseListing('AITERR:nodir').error, 'nodir');
  assert.equal(safeName('../../etc/passwd'), 'passwd');
  assert.equal(safeName('..'), 'download');
  assert.equal(safeName('a/b'), 'b');
  const cmd = shCmd('echo $1', "it's a $path `x`");
  assert.ok(!/it's|\$path|`/.test(cmd.replace(/^sh -c '[^']*'/, '')), 'the arguments only appear base64-encoded');
  assert.ok(cmd.includes(`'${b64("it's a $path `x`")}'`));
});

test('listing a real directory: names with spaces / quotes / unicode, hidden files, links, sizes and permissions', async (t) => {
  if (!need(t)) return;
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'sub dir'));
  fs.mkdirSync(path.join(dir, "it's"));
  fs.mkdirSync(path.join(dir, '한글 폴더'));
  fs.writeFileSync(path.join(dir, 'plain.txt'), 'hello');
  fs.writeFileSync(path.join(dir, '$weird `name` "q".txt'), 'x');
  fs.writeFileSync(path.join(dir, '.hidden'), 'h', { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
  fs.symlinkSync('sub dir', path.join(dir, 'to-dir'));
  fs.symlinkSync('plain.txt', path.join(dir, 'to-file'));
  fs.symlinkSync('/nonexistent/target', path.join(dir, 'dangling'));
  const r = await rb.list(dir);
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.path, dir);
  const names = r.entries.map((e) => e.name);
  const real = fs.readdirSync(dir);
  assert.deepEqual([...names].sort(), [...real].sort(), 'every entry, hidden ones included, nothing extra');
  const by = Object.fromEntries(r.entries.map((e) => [e.name, e]));
  assert.equal(by['sub dir'].type, 'dir');
  assert.equal(by["it's"].type, 'dir');
  assert.equal(by['한글 폴더'].type, 'dir');
  assert.equal(by['plain.txt'].size, 5);
  assert.equal(by['.hidden'].perm, 'rw-------');
  assert.equal(by['run.sh'].perm, 'rwxr-xr-x');
  assert.deepEqual(by['to-dir'].link, { target: 'sub dir', dir: true });
  assert.deepEqual(by['to-file'].link, { target: 'plain.txt', dir: false });
  assert.equal(by.dangling.link.dir, false);
  assert.ok(Math.abs(by['plain.txt'].mtime - Math.floor(fs.statSync(path.join(dir, 'plain.txt')).mtimeMs / 1000)) <= 1);
  // folders first
  const firstFile = names.findIndex((n) => !(by[n].type === 'dir' || (by[n].link && by[n].link.dir)));
  assert.ok(names.slice(0, firstFile).every((n) => by[n].type === 'dir' || (by[n].link && by[n].link.dir)));
  // home, a missing folder, an empty folder
  const home = await rb.home();
  assert.equal(home.path, fs.realpathSync(os.homedir()));
  assert.match((await rb.list(path.join(dir, 'nope'))).error, /폴더를 열 수 없습니다/);
  fs.mkdirSync(path.join(dir, 'empty'));
  assert.deepEqual((await rb.list(path.join(dir, 'empty'))).entries, []);
  assert.equal((await rb.list('')).path, fs.realpathSync(os.homedir()), 'an empty path means the login directory');
});

test('mkdir, rename (never clobbers), chmod, preview, stat — and delete refuses the dangerous', async (t) => {
  if (!need(t)) return;
  const dir = tmp();
  assert.deepEqual(await rb.mkdir(path.join(dir, 'new folder')), { ok: true });
  assert.ok(fs.statSync(path.join(dir, 'new folder')).isDirectory());
  assert.match((await rb.mkdir(path.join(dir, 'new folder'))).error, /실패/);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'AAA');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'BBB');
  assert.deepEqual(await rb.rename(path.join(dir, 'a.txt'), path.join(dir, 'a2.txt')), { ok: true });
  assert.ok(fs.existsSync(path.join(dir, 'a2.txt')) && !fs.existsSync(path.join(dir, 'a.txt')));
  assert.match((await rb.rename(path.join(dir, 'a2.txt'), path.join(dir, 'b.txt'))).error, /이미 있습니다/);
  assert.equal(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8'), 'BBB', 'the target was not overwritten');
  assert.deepEqual(await rb.chmod(path.join(dir, 'a2.txt'), '640'), { ok: true });
  assert.equal(fs.statSync(path.join(dir, 'a2.txt')).mode & 0o777, 0o640);
  assert.match((await rb.chmod(path.join(dir, 'a2.txt'), '9z9')).error, /8진수/);
  assert.match((await rb.chmod(path.join(dir, 'a2.txt'), '640; rm -rf /')).error, /8진수/);
  assert.deepEqual(await rb.stat(path.join(dir, 'b.txt')), { kind: 'file', size: 3 });
  assert.deepEqual(await rb.stat(dir), { kind: 'dir', size: 0 });
  assert.equal((await rb.stat(path.join(dir, 'zzz'))).kind, 'none');
  assert.equal((await rb.preview(path.join(dir, 'b.txt'))).text, 'BBB');
  fs.writeFileSync(path.join(dir, 'bin'), Buffer.from([0, 1, 2, 255]));
  assert.match((await rb.preview(path.join(dir, 'bin'))).error, /바이너리/);
  // delete
  fs.mkdirSync(path.join(dir, 'tree', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tree', 'deep', 'f'), '1');
  assert.deepEqual(await rb.remove(path.join(dir, 'tree')), { ok: true });
  assert.ok(!fs.existsSync(path.join(dir, 'tree')));
  for (const bad of ['/', '', '.', '..', 'relative/path', '~', fs.realpathSync(os.homedir()), fs.realpathSync(os.homedir()) + '/', '/etc', '/usr/', '/Users', '/var', '/tmp', `${dir}/../x`, `${dir}/..`, '/tmp/./x/..']) {
    assert.match((await rb.remove(bad)).error || '', /지우지 않습니다/, JSON.stringify(bad));
  }
  assert.ok(fs.existsSync(os.homedir()), 'the home directory is untouched');
});

test('upload a file: byte-exact, verified, progress is monotonic, no temp file left', async (t) => {
  if (!need(t)) return;
  const local = tmp();
  const remote = tmp();
  const f = path.join(local, 'data with spaces.bin');
  fs.writeFileSync(f, crypto.randomBytes(6 * 1024 * 1024 + 123));
  const events = [];
  rb.on('transfer', (e) => events.push(e));
  const q = await rb.upload(f, remote);
  assert.ok(q.id, JSON.stringify(q));
  const done = await finished(q.id);
  rb.removeAllListeners('transfer');
  assert.equal(done.state, 'done', done.error);
  assert.equal(done.verified, true, 'checked against the hash computed while reading');
  assert.equal(sha(path.join(remote, 'data with spaces.bin')), sha(f));
  assert.deepEqual(fs.readdirSync(remote).filter((n) => n.includes('.ait-')), []);
  const mine = events.filter((e) => e.id === q.id);
  assert.ok(mine.length >= 2, 'progress was reported');
  assert.equal(mine[mine.length - 1].state, 'done');
  assert.ok(mine.every((e, i) => i === 0 || e.bytes >= mine[i - 1].bytes), 'bytes never go backwards');
  assert.equal(mine[mine.length - 1].bytes, fs.statSync(f).size);
  assert.equal(mine[mine.length - 1].total, fs.statSync(f).size);
});

test('upload a folder (tar stream): structure, content, permissions, empty folders, odd names', async (t) => {
  if (!need(t)) return;
  const local = tmp();
  const remote = tmp();
  const root = path.join(local, 'project 1');
  fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(root, 'empty'));
  fs.writeFileSync(path.join(root, 'README.md'), '# hi\n');
  fs.writeFileSync(path.join(root, 'src', 'main.js'), 'console.log(1)\n');
  fs.writeFileSync(path.join(root, 'src', 'deep', '한글 파일.txt'), '안녕');
  fs.writeFileSync(path.join(root, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
  fs.symlinkSync('README.md', path.join(root, 'link-to-readme'));
  const q = await rb.upload(root, remote);
  const done = await finished(q.id);
  assert.equal(done.state, 'done', done.error);
  const out = path.join(remote, 'project 1');
  assert.equal(fs.readFileSync(path.join(out, 'README.md'), 'utf8'), '# hi\n');
  assert.equal(fs.readFileSync(path.join(out, 'src', 'deep', '한글 파일.txt'), 'utf8'), '안녕');
  assert.ok(fs.statSync(path.join(out, 'empty')).isDirectory());
  assert.equal(fs.statSync(path.join(out, 'run.sh')).mode & 0o777, 0o755, 'permissions are kept');
  assert.equal(fs.readlinkSync(path.join(out, 'link-to-readme')), 'README.md');
  assert.ok(!fs.readdirSync(out).some((n) => n.startsWith('._')), 'no macOS metadata files');
});

test('download a file and a folder: exact content, hidden temp files removed, names cannot escape the target folder', async (t) => {
  if (!need(t)) return;
  const remote = tmp();
  const local = tmp();
  fs.writeFileSync(path.join(remote, 'big.bin'), crypto.randomBytes(3 * 1024 * 1024 + 7));
  fs.mkdirSync(path.join(remote, 'tree', 'a b'), { recursive: true });
  fs.writeFileSync(path.join(remote, 'tree', 'a b', 'x.txt'), 'x');
  fs.writeFileSync(path.join(remote, 'tree', 'y.txt'), 'y', { mode: 0o755 });
  let q = await rb.download(path.join(remote, 'big.bin'), local);
  let done = await finished(q.id);
  assert.equal(done.state, 'done', done.error);
  assert.equal(done.verified, true);
  assert.equal(sha(path.join(local, 'big.bin')), sha(path.join(remote, 'big.bin')));
  q = await rb.download(path.join(remote, 'tree'), local);
  done = await finished(q.id);
  assert.equal(done.state, 'done', done.error);
  assert.equal(fs.readFileSync(path.join(local, 'tree', 'a b', 'x.txt'), 'utf8'), 'x');
  assert.equal(fs.statSync(path.join(local, 'tree', 'y.txt')).mode & 0o111, 0o111);
  assert.deepEqual(fs.readdirSync(local).filter((n) => n.includes('.ait-')), [], 'no partial files');
  assert.match((await rb.download(path.join(remote, 'missing'), local)).error, /없습니다/);
});

test('name conflicts are reported first; overwrite / rename / skip do what they say, in both directions', async (t) => {
  if (!need(t)) return;
  const remote = tmp();
  const local = tmp();
  fs.writeFileSync(path.join(local, 'doc.txt'), 'LOCAL');
  fs.writeFileSync(path.join(remote, 'doc.txt'), 'REMOTE');
  // upload
  let r = await rb.upload(path.join(local, 'doc.txt'), remote);
  assert.deepEqual(r.conflict, { name: 'doc.txt', kind: 'file', remote: path.join(remote, 'doc.txt') });
  assert.equal(fs.readFileSync(path.join(remote, 'doc.txt'), 'utf8'), 'REMOTE', 'a conflict writes nothing');
  assert.equal((await rb.upload(path.join(local, 'doc.txt'), remote, { mode: 'skip' })).skipped, true);
  let q = await rb.upload(path.join(local, 'doc.txt'), remote, { mode: 'rename' });
  assert.equal(q.name, 'doc (1).txt');
  assert.equal((await finished(q.id)).state, 'done');
  assert.equal(fs.readFileSync(path.join(remote, 'doc (1).txt'), 'utf8'), 'LOCAL');
  assert.equal(fs.readFileSync(path.join(remote, 'doc.txt'), 'utf8'), 'REMOTE');
  q = await rb.upload(path.join(local, 'doc.txt'), remote, { mode: 'overwrite' });
  assert.equal((await finished(q.id)).state, 'done');
  assert.equal(fs.readFileSync(path.join(remote, 'doc.txt'), 'utf8'), 'LOCAL');
  // download
  fs.writeFileSync(path.join(remote, 'doc.txt'), 'REMOTE-2');
  r = await rb.download(path.join(remote, 'doc.txt'), local);
  assert.equal(r.conflict.name, 'doc.txt');
  q = await rb.download(path.join(remote, 'doc.txt'), local, { mode: 'rename' });
  assert.equal(q.name, 'doc (1).txt');
  assert.equal((await finished(q.id)).state, 'done');
  assert.equal(fs.readFileSync(path.join(local, 'doc (1).txt'), 'utf8'), 'REMOTE-2');
  assert.equal(fs.readFileSync(path.join(local, 'doc.txt'), 'utf8'), 'LOCAL');
  q = await rb.download(path.join(remote, 'doc.txt'), local, { mode: 'overwrite' });
  assert.equal((await finished(q.id)).state, 'done');
  assert.equal(fs.readFileSync(path.join(local, 'doc.txt'), 'utf8'), 'REMOTE-2');
  // a file and a folder never replace each other
  fs.mkdirSync(path.join(remote, 'thing'));
  fs.writeFileSync(path.join(local, 'thing'), 'file');
  assert.match((await rb.upload(path.join(local, 'thing'), remote, { mode: 'overwrite' })).error, /서로 덮어쓸 수 없습니다/);
});

test('cancel: a running transfer stops, leaves no partial file on either side, and the connection stays usable', async (t) => {
  if (!need(t)) return;
  const local = tmp();
  const remote = tmp();
  const big = path.join(local, 'big.bin');
  const fd = fs.openSync(big, 'w');
  for (let i = 0; i < 60; i++) fs.writeSync(fd, crypto.randomBytes(1024 * 1024)); // 60 MB
  fs.closeSync(fd);
  const q = await rb.upload(big, remote);
  await until(() => (rb.transfers.get(q.id) || {}).bytes > 0, 10000);
  assert.equal(rb.cancel(q.id), true);
  const done = await finished(q.id);
  assert.equal(done.state, 'cancelled');
  await sleep(500);
  assert.ok(!fs.existsSync(path.join(remote, 'big.bin')), 'the target was never created');
  assert.deepEqual(fs.readdirSync(remote), [], 'and no hidden partial file is left on the server side');
  assert.equal(rb.cancel(q.id), false, 'cancelling twice is harmless');
  // a queued one can be cancelled before it starts, and a download too
  const d = await rb.download(big, tmp());
  await until(() => (rb.transfers.get(d.id) || {}).state === 'running', 5000);
  rb.cancel(d.id);
  assert.equal((await finished(d.id)).state, 'cancelled');
  assert.ok((await rb.list(remote)).entries !== undefined, 'the connection still works');
});

test('several transfers run side by side (2 at a time) and all finish; clearFinished tidies the list', async (t) => {
  if (!need(t)) return;
  const local = tmp();
  const remote = tmp();
  const ids = [];
  for (let i = 0; i < 5; i++) {
    fs.writeFileSync(path.join(local, `f${i}.dat`), crypto.randomBytes(300 * 1024));
    ids.push((await rb.upload(path.join(local, `f${i}.dat`), remote)).id);
  }
  assert.ok(rb.running <= 2);
  for (const id of ids) assert.equal((await finished(id)).state, 'done');
  for (let i = 0; i < 5; i++) assert.equal(sha(path.join(remote, `f${i}.dat`)), sha(path.join(local, `f${i}.dat`)));
  rb.clearFinished();
  assert.equal(rb.list_transfers().filter((x) => ids.includes(x.id)).length, 0);
});

test('the local side: listing a folder, natural sort, links, errors', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'b dir'));
  fs.writeFileSync(path.join(dir, 'file10.txt'), '1');
  fs.writeFileSync(path.join(dir, 'file2.txt'), '22');
  fs.symlinkSync('b dir', path.join(dir, 'lnk'));
  const r = await localList(dir);
  assert.deepEqual(r.entries.map((e) => e.name), ['b dir', 'lnk', 'file2.txt', 'file10.txt']);
  assert.equal(r.entries.find((e) => e.name === 'lnk').link.dir, true);
  assert.equal(r.entries.find((e) => e.name === 'file2.txt').size, 2);
  assert.equal((await localList('')).path, os.homedir());
  assert.equal((await localList('~')).path, os.homedir());
  assert.match((await localList(path.join(dir, 'nope'))).error, /열 수 없습니다/);
});
