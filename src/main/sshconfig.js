'use strict';
// Reading, checking and saving the user's ssh config file (~/.ssh/config) for the editor in the session panel.
//
//   read()            { path, exists, text, hash }
//   check(text)       { ok } or { ok: false, line, message }   syntax check with the real `ssh -G` (nothing is connected)
//   write(text, hash) { ok, backup } | { ok: false, code }     refuses when the file changed since it was read; keeps the old
//                                                              content as config.bak-<time> (newest 5 kept); mode 0600; atomic
//
// Only the window's own editor reaches this (IPC from the UI); the AI has no tool for it. The text is the user's own, but it is never
// run here: `ssh -G` evaluates Host / Match blocks and would run a `Match exec` command, so those lines are neutralised in the
// temporary copy that is checked (the saved file keeps them as typed).
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MAX_BYTES = 256 * 1024;
const KEEP_BACKUPS = 5;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

class SshConfigFile {
  /** @param {string} dir the .ssh folder (default ~/.ssh) */
  constructor(dir = path.join(os.homedir(), '.ssh'), { sshBin = '/usr/bin/ssh' } = {}) {
    this.dir = dir;
    this.file = path.join(dir, 'config');
    this.sshBin = sshBin;
  }

  /** What the window shows as the file name. */
  get label() {
    const home = os.homedir();
    return this.file.startsWith(home + path.sep) ? `~${this.file.slice(home.length)}` : this.file;
  }

  read() {
    try {
      const text = fs.readFileSync(this.file, 'utf8');
      return { path: this.label, exists: true, text, hash: sha(text) };
    } catch (e) {
      if (e.code === 'ENOENT') return { path: this.label, exists: false, text: '', hash: sha('') };
      return { path: this.label, exists: false, text: '', hash: '', error: e.code || 'read' };
    }
  }

  /** Syntax check with `ssh -G -F <copy> <dummy host>`: parses the whole file, connects to nothing. */
  check(text) {
    const s = String(text);
    if (s.includes('\0')) return { ok: false, line: 0, message: 'NUL' };
    if (Buffer.byteLength(s) > MAX_BYTES) return { ok: false, line: 0, message: 'too-big' };
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-sshcfg-'));
    const tmp = path.join(tmpDir, 'config');
    try {
      // a `Match ... exec` line would run its command while ssh evaluates the file: replace it by `Match all` in the copy only
      fs.writeFileSync(tmp, s.replace(/^[ \t]*Match\b[^\n]*\bexec\b[^\n]*$/gim, 'Match all'), { mode: 0o600 });
      const r = spawnSync(this.sshBin, ['-G', '-F', tmp, '--', 'ait-config-check'], { encoding: 'utf8', timeout: 8000, env: { ...process.env, SSH_AUTH_SOCK: '' } });
      if (r.status === 0) return { ok: true };
      const out = String(r.stderr || '').replace(/\r/g, '');
      const err = out.split('\n').find((l) => /line \d+:|Bad|Unsupported|garbage|missing|invalid/i.test(l)) || out.trim().split('\n')[0] || 'ssh refused the file';
      const m = err.match(/line (\d+): (.*)$/);
      return { ok: false, line: m ? Number(m[1]) : 0, message: (m ? m[2] : err).replace(tmp, 'config').slice(0, 200) };
    } catch (e) {
      return { ok: false, line: 0, message: String(e.message || e).slice(0, 200) };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  write(text, expectedHash) {
    const s = String(text);
    if (s.includes('\0')) return { ok: false, code: 'bad' };
    if (Buffer.byteLength(s) > MAX_BYTES) return { ok: false, code: 'too-big' };
    const cur = this.read();
    if (cur.error) return { ok: false, code: 'read' };
    if (cur.hash !== expectedHash) return { ok: false, code: 'changed' }; // somebody (an editor, another window) wrote it meanwhile
    const c = this.check(s);
    if (!c.ok) return { ok: false, code: 'syntax', line: c.line, message: c.message };
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      let backup = '';
      if (cur.exists) {
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
        backup = path.join(this.dir, `config.bak-${stamp}`);
        fs.writeFileSync(backup, cur.text, { mode: 0o600 });
        const old = fs.readdirSync(this.dir).filter((f) => /^config\.bak-\d{14}$/.test(f)).sort().reverse().slice(KEEP_BACKUPS);
        for (const f of old) fs.rmSync(path.join(this.dir, f), { force: true });
      }
      // a config that is a symlink (dotfiles repository) is written THROUGH the link, and keeps its permissions (never group / world writable)
      const target = cur.exists ? fs.realpathSync(this.file) : this.file;
      const mode = cur.exists ? fs.statSync(target).mode & 0o755 : 0o600;
      const tmp = path.join(path.dirname(target), `.config.${process.pid}.tmp`);
      fs.writeFileSync(tmp, s, { mode });
      fs.renameSync(tmp, target);
      return { ok: true, backup: backup ? path.basename(backup) : '', hash: sha(s) };
    } catch (e) {
      return { ok: false, code: e.code === 'EACCES' || e.code === 'EPERM' ? 'denied' : 'write' };
    }
  }
}

module.exports = { SshConfigFile, MAX_BYTES, KEEP_BACKUPS };
