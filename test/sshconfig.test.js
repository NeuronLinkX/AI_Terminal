'use strict';
// The ~/.ssh/config editor's engine (src/main/sshconfig.js), against the real `ssh -G`. Temporary folders only; the real ~/.ssh is never touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SshConfigFile, MAX_BYTES, KEEP_BACKUPS } = require('../src/main/sshconfig');

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ait-cfg-')));
const GOOD = 'Host vm\n  HostName 192.0.2.10\n  User demo\n  Port 2222\n';

test('a missing file reads as empty, and saving creates it privately without a backup', () => {
  const dir = path.join(tmp(), '.ssh');
  const f = new SshConfigFile(dir);
  const r = f.read();
  assert.deepEqual([r.exists, r.text], [false, '']);
  const w = f.write(GOOD, r.hash);
  assert.equal(w.ok, true);
  assert.equal(w.backup, '');
  assert.equal(fs.readFileSync(path.join(dir, 'config'), 'utf8'), GOOD);
  assert.equal(fs.statSync(path.join(dir, 'config')).mode & 0o077, 0, 'owner only');
  assert.equal(fs.statSync(dir).mode & 0o077, 0, 'the folder is private too');
});

test('a syntax error is reported with its line and nothing is written', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'config'), GOOD);
  const f = new SshConfigFile(dir);
  const r = f.read();
  const bad = GOOD + '\nHost other\n  NoSuchOption yes\n';
  const c = f.check(bad);
  assert.equal(c.ok, false);
  assert.equal(c.line, 7);
  assert.match(c.message, /Bad configuration option|Unsupported/i);
  const w = f.write(bad, r.hash);
  assert.deepEqual([w.ok, w.code, w.line], [false, 'syntax', 7]);
  assert.equal(fs.readFileSync(path.join(dir, 'config'), 'utf8'), GOOD, 'the file is untouched');
  assert.equal(f.check(GOOD).ok, true);
});

test('checking never runs a Match exec command', () => {
  const dir = tmp();
  const marker = path.join(dir, 'ran');
  const f = new SshConfigFile(dir);
  const c = f.check(`Match exec "touch ${marker}"\n  User x\nHost a\n  HostName b\n`);
  assert.equal(c.ok, true);
  assert.equal(fs.existsSync(marker), false, 'the command was not executed');
});

test('a file changed since it was read is not overwritten', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'config'), GOOD);
  const f = new SshConfigFile(dir);
  const r = f.read();
  fs.writeFileSync(path.join(dir, 'config'), GOOD + '# edited elsewhere\n'); // an editor saves meanwhile
  const w = f.write('Host mine\n  HostName x\n', r.hash);
  assert.deepEqual([w.ok, w.code], [false, 'changed']);
  assert.match(fs.readFileSync(path.join(dir, 'config'), 'utf8'), /edited elsewhere/);
});

test('saving keeps the previous content as a backup, only the newest 5 stay, and the hash allows saving again', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'config'), GOOD);
  const f = new SshConfigFile(dir);
  let r = f.read();
  let backups = [];
  for (let i = 0; i < KEEP_BACKUPS + 3; i++) {
    const w = f.write(`${GOOD}# v${i}\n`, r.hash);
    assert.equal(w.ok, true, JSON.stringify(w));
    backups.push(w.backup);
    r = f.read();
    assert.equal(r.hash, w.hash);
    await new Promise((x) => setTimeout(x, 1100)); // backups are named by the second
  }
  assert.equal(backups.every((b) => /^config\.bak-\d{14}$/.test(b)), true);
  const left = fs.readdirSync(dir).filter((x) => x.startsWith('config.bak-'));
  assert.equal(left.length, KEEP_BACKUPS);
  assert.equal(fs.statSync(path.join(dir, left[0])).mode & 0o077, 0, 'backups are private');
  assert.match(fs.readFileSync(path.join(dir, 'config'), 'utf8'), new RegExp(`# v${KEEP_BACKUPS + 2}`));
});

test('a config that is a symlink is written through the link and keeps its permissions', () => {
  const dir = tmp();
  const real = path.join(tmp(), 'dotfiles-config');
  fs.writeFileSync(real, GOOD, { mode: 0o640 });
  fs.symlinkSync(real, path.join(dir, 'config'));
  const f = new SshConfigFile(dir);
  const w = f.write(GOOD + '# more\n', f.read().hash);
  assert.equal(w.ok, true);
  assert.equal(fs.lstatSync(path.join(dir, 'config')).isSymbolicLink(), true, 'still a link');
  assert.match(fs.readFileSync(real, 'utf8'), /# more/);
  assert.equal(fs.statSync(real).mode & 0o777, 0o640);
});

test('limits: a huge or NUL-containing text is refused', () => {
  const f = new SshConfigFile(tmp());
  const h = f.read().hash;
  assert.equal(f.write('a'.repeat(MAX_BYTES + 1), h).code, 'too-big');
  assert.equal(f.write('Host a\0b', h).code, 'bad');
  assert.equal(f.check('x\0').ok, false);
});

test('the label shows ~ for the real home folder', () => {
  assert.equal(new SshConfigFile().label, '~/.ssh/config');
  assert.equal(new SshConfigFile('/srv/x').label, '/srv/x/config');
});
