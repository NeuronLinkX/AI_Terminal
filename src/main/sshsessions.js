'use strict';
// Saved SSH sessions (the session manager of the left side bar): what to connect to, validated, and the exact `ssh` command
// line that is typed into a terminal tab. The user types the password (or key passphrase) in that terminal — no password,
// passphrase or private key is ever stored here; a session only remembers WHERE to connect and HOW (key file path, jump host,
// forwards, X11).
//
// Every field is checked against a strict character set before it can reach a command line, so a saved or imported value can
// never inject an ssh option or shell syntax (see test/sshsessions.test.js).
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { controlDir } = require('./sshlink');

const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._:%-]*$|^\[[0-9A-Fa-f:.%]+\]$/;
const USER_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const NAME_MAX = 60;
const X11_MODES = ['off', 'safe', 'trusted'];

const ctl = (s) => /[\x00-\x1f\x7f]/.test(s);

/** A path that can be placed inside single quotes: no quote, backslash, control character, `$` or backtick. */
function pathOk(p) {
  const s = String(p || '');
  return s.length > 0 && s.length <= 512 && !ctl(s) && !/['"\\$`]/.test(s) && (s.startsWith('/') || s.startsWith('~/'));
}
const q = (s) => `'${s}'`;

function jumpOk(j) {
  const parts = String(j).split(',');
  return parts.length <= 3 && parts.every((p) => {
    const m = p.match(/^(?:([A-Za-z0-9_][A-Za-z0-9._-]{0,63})@)?([^@:]+|\[[0-9A-Fa-f:.%]+\])(?::(\d{1,5}))?$/);
    return !!m && HOST_RE.test(m[2]) && (!m[3] || (Number(m[3]) >= 1 && Number(m[3]) <= 65535));
  });
}

const port = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 0; };

/**
 * @returns {{ok: true, session} | {ok: false, errors: {field: string, message: string}[]}}
 * Unknown fields are dropped, so nothing but the schema below is ever stored.
 */
function validateSession(input, { keepId = true } = {}) {
  const i = input && typeof input === 'object' ? input : {};
  const errors = [];
  const bad = (field, message) => errors.push({ field, message });
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const s = {
    id: keepId && /^[a-f0-9]{16}$/.test(str(i.id)) ? str(i.id) : '',
    name: str(i.name),
    folder: str(i.folder),
    host: str(i.host),
    user: str(i.user),
    port: i.port === undefined || i.port === '' || i.port === null ? 22 : port(i.port),
    keyFile: str(i.keyFile),
    jump: str(i.jump),
    x11: X11_MODES.includes(i.x11) ? i.x11 : 'off',
    keepAlive: i.keepAlive !== false,
    share: i.share !== false,
    startDir: str(i.startDir),
    forwards: [],
    notes: typeof i.notes === 'string' ? i.notes.slice(0, 500) : '',
    lastUsed: Number(i.lastUsed) || 0,
    createdAt: Number(i.createdAt) || 0,
  };
  if (!s.host) bad('host', '호스트를 입력하세요.');
  else if (!HOST_RE.test(s.host) || s.host.length > 253) bad('host', '호스트에는 영문자·숫자·점·하이픈·콜론만 쓸 수 있습니다(주소가 -로 시작할 수 없음).');
  if (s.user && !USER_RE.test(s.user)) bad('user', '사용자 이름이 올바르지 않습니다.');
  if (!s.port) bad('port', '포트는 1~65535 입니다.');
  if (!s.name) s.name = `${s.user ? s.user + '@' : ''}${s.host}`.slice(0, NAME_MAX);
  if (s.name.length > NAME_MAX || ctl(s.name)) bad('name', `이름은 ${NAME_MAX}자 이하의 한 줄이어야 합니다.`);
  if (s.folder.length > 40 || ctl(s.folder)) bad('folder', '폴더 이름이 너무 깁니다(40자).');
  if (s.keyFile && !pathOk(s.keyFile)) bad('keyFile', '키 파일 경로는 / 또는 ~/ 로 시작하고 따옴표·$·백슬래시가 없어야 합니다.');
  if (s.jump && !jumpOk(s.jump)) bad('jump', '점프 호스트는 user@host[:port] 형식(쉼표로 최대 3개)이어야 합니다.');
  if (s.startDir && !(pathOk(s.startDir) && !s.startDir.startsWith('~'))) bad('startDir', '시작 폴더는 / 로 시작하는 서버의 절대 경로여야 합니다.');
  const fw = Array.isArray(i.forwards) ? i.forwards : [];
  if (fw.length > 12) bad('forwards', '터널은 12개까지 저장할 수 있습니다.');
  for (const f of fw.slice(0, 12)) {
    const kind = f && f.kind;
    const lp = port(f && f.listenPort);
    if (!['L', 'R', 'D'].includes(kind)) { bad('forwards', '터널 종류는 L / R / D 입니다.'); continue; }
    if (!lp) { bad('forwards', '터널의 수신 포트가 올바르지 않습니다.'); continue; }
    if (kind === 'D') { s.forwards.push({ kind, listenPort: lp }); continue; }
    const h = str(f.host);
    const p = port(f.port);
    if (!(HOST_RE.test(h) && h.length <= 253) || !p) { bad('forwards', '터널의 대상 호스트·포트가 올바르지 않습니다.'); continue; }
    s.forwards.push({ kind, listenPort: lp, host: h, port: p });
  }
  return errors.length ? { ok: false, errors } : { ok: true, session: s };
}

/** `-L 8080:localhost:80` style argument (host may be a v6 literal). */
const fwdArg = (f) => (f.kind === 'D' ? `${f.listenPort}` : `${f.listenPort}:${f.host.startsWith('[') ? f.host : f.host}:${f.port}`);

/**
 * The command line for a session. Everything is validated, so the result is safe to type into any shell.
 * `share` adds the app's shared-connection options: the terminal, the file panel and the server monitor then use ONE login.
 * @returns {{ok: true, command: string} | {ok: false, errors: object[]}}
 */
function buildCommand(session, { ctlDir = controlDir(), home = os.homedir(), configFile = '' } = {}) {
  const v = validateSession(session);
  if (!v.ok) return v;
  const s = v.session;
  const a = ['ssh'];
  if (configFile && pathOk(configFile)) a.push('-F', q(configFile));
  if (s.keepAlive) a.push('-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3');
  if (s.share && ctlDir) a.push('-o', 'ControlMaster=auto', '-o', `ControlPath=${ctlDir}/%C`);
  if (s.port !== 22) a.push('-p', String(s.port));
  if (s.keyFile) a.push('-i', q(s.keyFile.startsWith('~/') ? path.join(home, s.keyFile.slice(2)) : s.keyFile), '-o', 'IdentitiesOnly=yes');
  if (s.jump) a.push('-J', s.jump);
  if (s.x11 === 'safe') a.push('-X');
  if (s.x11 === 'trusted') a.push('-Y');
  for (const f of s.forwards) a.push(`-${f.kind}`, fwdArg(f));
  if (s.startDir) a.push('-t');
  a.push(`${s.user ? s.user + '@' : ''}${s.host}`);
  if (s.startDir) a.push(`'cd "${s.startDir}" && exec "$SHELL" -l'`);
  return { ok: true, command: a.join(' ') };
}

/**
 * `ssh [options] <destination>` for an ~/.ssh/config alias or a "recent" destination (user@host[:port]) — the same options as a
 * saved session (keep-alive, shared connection), nothing else. The destination is checked like a session's host.
 */
function buildDestinationCommand(destination, { keepAlive = true, share = true, ctlDir = controlDir(), configFile = '' } = {}) {
  const d = String(destination || '');
  const m = d.match(/^(?:([A-Za-z0-9_][A-Za-z0-9._-]{0,63})@)?([^@:\s]+|\[[0-9A-Fa-f:.%]+\])(?::(\d{1,5}))?$/);
  if (!m || !HOST_RE.test(m[2]) || m[2].length > 253 || (m[3] && !port(m[3]))) return { ok: false, errors: [{ field: 'host', message: '접속 대상이 올바르지 않습니다.' }] };
  const a = ['ssh'];
  if (configFile && pathOk(configFile)) a.push('-F', q(configFile));
  if (keepAlive) a.push('-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3');
  if (share && ctlDir) a.push('-o', 'ControlMaster=auto', '-o', `ControlPath=${ctlDir}/%C`);
  if (m[3] && Number(m[3]) !== 22) a.push('-p', m[3]);
  a.push(`${m[1] ? m[1] + '@' : ''}${m[2]}`);
  return { ok: true, command: a.join(' ') };
}

/** XQuartz (or another X server) is needed for X11 forwarding on a Mac. */
function x11Available() {
  return fs.existsSync('/opt/X11/bin/Xquartz') || fs.existsSync('/Applications/Utilities/XQuartz.app') || fs.existsSync('/usr/X11/bin/Xquartz');
}

class SessionStore {
  constructor(dataDir) {
    this.file = dataDir ? path.join(dataDir, 'ssh-sessions.json') : null;
    this.sessions = [];
    try {
      const raw = this.file ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : null;
      for (const r of (raw && raw.sessions) || []) {
        const v = validateSession(r);
        if (v.ok && v.session.id) this.sessions.push(v.session); // a hand-edited / damaged entry never reaches a command line
      }
    } catch { /* none yet */ }
  }
  list() {
    return this.sessions.map((s) => ({ ...s, forwards: s.forwards.map((f) => ({ ...f })) })).sort((a, b) => (a.folder || '').localeCompare(b.folder || '') || a.name.localeCompare(b.name));
  }
  get(id) {
    return this.sessions.find((s) => s.id === id) || null;
  }
  save(input) {
    const v = validateSession(input);
    if (!v.ok) return v;
    const s = v.session;
    const now = Date.now();
    const at = s.id ? this.sessions.findIndex((x) => x.id === s.id) : -1;
    if (at >= 0) {
      s.createdAt = this.sessions[at].createdAt || now;
      this.sessions[at] = { ...s, lastUsed: this.sessions[at].lastUsed };
    } else {
      s.id = crypto.randomBytes(8).toString('hex');
      s.createdAt = now;
      this.sessions.push(s);
    }
    this._write();
    return { ok: true, session: this.get(s.id) };
  }
  remove(id) {
    const n = this.sessions.length;
    this.sessions = this.sessions.filter((s) => s.id !== id);
    if (this.sessions.length !== n) this._write();
    return this.sessions.length !== n;
  }
  duplicate(id) {
    const s = this.get(id);
    if (!s) return { ok: false, errors: [{ field: 'id', message: '세션을 찾을 수 없습니다.' }] };
    const copy = { ...s, id: '', name: `${s.name} (복사)`.slice(0, NAME_MAX), lastUsed: 0 };
    return this.save(copy);
  }
  touch(id) {
    const s = this.get(id);
    if (s) { s.lastUsed = Date.now(); this._write(); }
  }
  /** A session prefilled from an ~/.ssh/config entry (not saved until the user does). */
  fromConfig(h) {
    return { name: h.alias, host: h.hostName || h.alias, user: h.user || '', port: h.port || 22, keyFile: '', jump: h.proxyJump || '', x11: 'off', keepAlive: true, share: true, startDir: '', forwards: [], notes: '~/.ssh/config 에서 가져옴' };
  }
  _write() {
    if (!this.file) return;
    try {
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, sessions: this.sessions }, null, 1), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch { /* read-only profile */ }
  }
}

module.exports = { SessionStore, validateSession, buildCommand, buildDestinationCommand, x11Available, pathOk, jumpOk, HOST_RE, USER_RE };
