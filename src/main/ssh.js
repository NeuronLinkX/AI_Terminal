'use strict';
// SSH support for a tab: recognise a running ssh session, read ~/.ssh/config, classify connection problems, remember
// recently used hosts, and build the shell-specific "sentinel" that lets the agent run commands inside a remote shell.
//
// Nothing here stores or handles secrets. Passwords, passphrases and host-key questions are answered by the user in the
// terminal; only host aliases, user names and ports are remembered (see PRIVACY.md).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { cleanTerminalText } = require('./text');

// ------------------------------------------------------------------ command line of an ssh process
// ssh(1) options that take an argument
const ARG_FLAGS = new Set(['B', 'b', 'c', 'D', 'E', 'e', 'F', 'I', 'i', 'J', 'L', 'l', 'm', 'O', 'o', 'P', 'p', 'Q', 'R', 'S', 'W', 'w']);
// flags after which ssh does not open an interactive shell
const NO_SHELL_FLAGS = new Set(['N', 'f', 'W', 'G', 'V', 'Q', 'O']);

function splitArgs(s) {
  const out = [];
  let cur = '';
  let q = '';
  let has = false;
  for (const ch of String(s)) {
    if (q) {
      if (ch === q) q = '';
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

function parseDestination(dest) {
  let s = String(dest);
  let port = 0;
  let user = '';
  const url = s.match(/^ssh:\/\/(.+)$/i);
  if (url) s = url[1];
  const at = s.lastIndexOf('@');
  if (at >= 0) {
    user = s.slice(0, at);
    s = s.slice(at + 1);
  }
  const v6 = s.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (v6) {
    s = v6[1];
    if (v6[2]) port = Number(v6[2]);
  } else if (url) {
    const pm = s.match(/^(.*):(\d+)$/);
    if (pm) {
      s = pm[1];
      port = Number(pm[2]);
    }
  }
  return { user, host: s, port };
}

/**
 * Understand `ssh [options] destination [command]`. Returns null when it is not an ssh command line.
 * `interactive` is true only when ssh opens a login shell (no remote command, not -N / -f / -W …).
 */
function parseSshArgs(input) {
  const argv = Array.isArray(input) ? input.slice() : splitArgs(input);
  if (!argv.length || path.basename(argv[0]) !== 'ssh') return null;
  // `identity` holds only file names (safe to show); `identityFiles` / `configFile` keep full paths for re-connecting and must never reach the UI
  const r = { user: '', host: '', port: 0, jump: '', identity: [], identityFiles: [], configFile: '', options: {}, flags: [], command: '', interactive: true, label: '' };
  const setOpt = (k, v) => { r.options[String(k).toLowerCase()] = v; };
  const rest = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { rest.push(...argv.slice(i + 1)); break; }
    if (a.length > 1 && a[0] === '-') {
      for (let j = 1; j < a.length; j++) {
        const f = a[j];
        if (ARG_FLAGS.has(f)) {
          const val = a.length > j + 1 ? a.slice(j + 1) : argv[++i];
          if (val === undefined) break;
          if (f === 'p') r.port = Number(val) || 0;
          else if (f === 'l') r.user = val;
          else if (f === 'J') r.jump = val;
          else if (f === 'i') { r.identity.push(path.basename(val)); r.identityFiles.push(val.replace(/^~(?=\/)/, os.homedir())); }
          else if (f === 'F') r.configFile = val.replace(/^~(?=\/)/, os.homedir());
          else if (f === 'o') { const m = String(val).match(/^\s*([A-Za-z]+)\s*[=\s]\s*(.*)$/); if (m) setOpt(m[1], m[2].trim()); }
          if (NO_SHELL_FLAGS.has(f)) r.flags.push(f);
          break;
        }
        r.flags.push(f);
      }
      continue;
    }
    rest.push(...argv.slice(i));
    break;
  }
  const dest = rest.shift();
  if (!dest) return null;
  const d = parseDestination(dest);
  r.host = d.host;
  if (d.user && !r.user) r.user = d.user;
  if (d.port && !r.port) r.port = d.port;
  if (!r.user && r.options.user) r.user = r.options.user;
  if (!r.port && r.options.port) r.port = Number(r.options.port) || 0;
  if (!r.jump && r.options.proxyjump) r.jump = r.options.proxyjump;
  r.command = rest.join(' ');
  // a remote command normally means a one-off run; with -t / -tt the user asked for a terminal (`ssh -t host bash`) and works in it
  r.interactive = (!r.command || r.flags.includes('t')) && !r.flags.some((f) => NO_SHELL_FLAGS.has(f));
  r.id = idOf(r);
  r.label = labelOf(r);
  return r;
}

/** The technical identity of a connection — `user@host` (+ `:port` when it is not 22). Allow-rules are scoped by it. */
function idOf(t) {
  const host = t.hostName || t.host;
  return `${t.user ? t.user + '@' : ''}${host}${t.port && t.port !== 22 ? ':' + t.port : ''}`;
}
/** What the window shows: the ~/.ssh/config name the user knows the server by, else the identity. */
function labelOf(t) {
  return t.alias || idOf(t);
}

/** Fill user / host / port from ~/.ssh/config when the destination was just an alias. */
function resolveFromConfig(parsed, hosts) {
  if (!parsed) return parsed;
  const h = (hosts || []).find((x) => x.alias === parsed.host);
  if (!h) return parsed;
  const r = { ...parsed, alias: h.alias, hostName: h.hostName || parsed.host };
  if (!r.user && h.user) r.user = h.user;
  if (!r.port && h.port) r.port = h.port;
  if (!r.jump && h.proxyJump) r.jump = h.proxyJump;
  r.id = idOf(r);
  r.label = labelOf(r);
  return r;
}

// ------------------------------------------------------------------ ~/.ssh/config
function globToRe(g) {
  return new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
}

/** Hosts a user can pick from. Wildcard / negated patterns are defaults, not hosts, and are skipped. */
function parseSshConfig(text, { baseDir = path.join(os.homedir(), '.ssh'), depth = 0 } = {}) {
  const hosts = [];
  let cur = null; // the Host block being read: { names: [], opts: {} }
  const flush = () => {
    if (!cur) return;
    for (const alias of cur.names) {
      if (/[*?!]/.test(alias)) continue;
      const o = cur.opts;
      hosts.push({ alias, hostName: o.hostname || '', user: o.user || '', port: o.port ? Number(o.port) || 0 : 0, proxyJump: o.proxyjump || '', identityFile: o.identityfile ? path.basename(o.identityfile.split(/\s+/)[0]) : '' });
    }
    cur = null;
  };
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(\S+?)(?:\s*=\s*|\s+)(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim().replace(/^"(.*)"$/, '$1');
    if (key === 'host') { flush(); cur = { names: splitArgs(val), opts: {} }; continue; }
    if (key === 'match') { flush(); continue; }
    if (key === 'include' && depth < 3) {
      for (const pat of splitArgs(val)) {
        const full = path.isAbsolute(pat) ? pat : path.join(baseDir, pat);
        const dir = path.dirname(full);
        const re = globToRe(path.basename(full));
        let names = [];
        try { names = fs.readdirSync(dir).filter((n) => re.test(n)).sort(); } catch { /* missing dir */ }
        for (const n of names) {
          try { hosts.push(...parseSshConfig(fs.readFileSync(path.join(dir, n), 'utf8'), { baseDir, depth: depth + 1 })); } catch { /* unreadable include */ }
        }
      }
      continue;
    }
    if (cur && !(key in cur.opts)) cur.opts[key] = val; // OpenSSH: the first value wins
  }
  flush();
  return hosts;
}

// ------------------------------------------------------------------ connection problems
const PROBLEMS = [
  { kind: 'host-key-changed', level: 'danger', re: /REMOTE HOST IDENTIFICATION HAS CHANGED/i,
    hint: '서버의 호스트 키가 바뀌었습니다. 중간자 공격이거나 서버를 다시 설치한 경우입니다. 확인되기 전에는 접속하지 마세요. 서버를 다시 설치한 것이 맞다면 `ssh-keygen -R <호스트>` 로 이전 키를 지운 뒤 다시 접속하세요(앱은 이 명령을 자동으로 실행하지 않습니다).' },
  { kind: 'host-key-unknown', level: 'warn', re: /The authenticity of host .+ can't be established/i,
    hint: '처음 접속하는 서버입니다. 표시된 지문이 서버 관리자가 알려 준 값과 같을 때만 yes 를 입력하세요(AI 는 이 질문에 답하지 않습니다).' },
  { kind: 'host-key-failed', level: 'danger', re: /Host key verification failed/i,
    hint: '호스트 키 확인에 실패해 연결이 끊겼습니다. known_hosts 와 서버 키가 같은지 확인하세요.' },
  { kind: 'auth-failed', level: 'warn', re: /Permission denied \(([^)]*)\)/i,
    hint: '인증에 실패했습니다. 사용자 이름, 키 또는 비밀번호를 확인하세요. 키가 많으면 `-o IdentitiesOnly=yes -i <키>` 로 쓸 키를 지정해 보세요.' },
  { kind: 'auth-failed', level: 'warn', re: /Too many authentication failures/i,
    hint: '시도한 키가 너무 많아 서버가 거부했습니다. `-o IdentitiesOnly=yes -i <키>` 로 쓸 키를 지정하세요.' },
  { kind: 'refused', level: 'warn', re: /Connection refused/i,
    hint: '서버가 연결을 거부했습니다. 주소와 포트, 서버의 sshd 실행 여부를 확인하세요.' },
  { kind: 'timeout', level: 'warn', re: /Connection timed out|Operation timed out/i,
    hint: '서버가 응답하지 않습니다. 주소·네트워크·방화벽을 확인하세요.' },
  { kind: 'dns', level: 'warn', re: /Could not resolve hostname|Name or service not known|nodename nor servname/i,
    hint: '호스트 이름을 찾을 수 없습니다. 철자와 DNS 를 확인하세요.' },
  { kind: 'unreachable', level: 'warn', re: /No route to host|Network is unreachable/i,
    hint: '서버까지 가는 경로가 없습니다. 같은 네트워크(VPN 포함)에 있는지 확인하세요.' },
  { kind: 'dropped', level: 'warn', re: /client_loop: send disconnect|Write failed: Broken pipe|packet_write_wait|Connection reset by|Timeout, server .* not responding|Connection to .+ (closed by remote host|timed out)/i,
    hint: '연결이 끊어졌습니다. 다시 접속하세요. 자주 끊기면 `-o ServerAliveInterval=30` 옵션을 쓰세요.' },
  { kind: 'closed', level: 'info', re: /^Connection to \S+ closed\.?$/im, hint: '원격 셸이 정상적으로 종료되었습니다.' },
];

/** First recognised ssh problem in `text`, or null. { kind, level, hint, detail } */
function classifySshOutput(text) {
  const s = String(text || '');
  for (const p of PROBLEMS) {
    const m = s.match(p.re);
    if (m) return { kind: p.kind, level: p.level, hint: p.hint, detail: (m[0] || '').slice(0, 120) };
  }
  return null;
}

/** The SHA256 fingerprint ssh shows for an unknown host, if the text contains the question. */
function fingerprintOf(text) {
  const m = String(text || '').match(/(ED25519|RSA|ECDSA|DSA) key fingerprint is (SHA256:[A-Za-z0-9+/=]+)/);
  return m ? { type: m[1], fingerprint: m[2] } : null;
}

// ------------------------------------------------------------------ the remote shell
/** posix (sh/bash/zsh/dash/ksh/ash) | fish | csh (csh/tcsh) | unknown */
function shellKind(shell) {
  const n = path.basename(String(shell || '')).replace(/^-/, '').toLowerCase();
  if (!n) return 'unknown';
  if (n === 'fish') return 'fish';
  if (n === 'csh' || n === 'tcsh') return 'csh';
  if (/^(sh|bash|zsh|dash|ksh|mksh|pdksh|ash|busybox|rbash|yash)$/.test(n)) return 'posix';
  return 'unknown';
}

/**
 * What to type so the shell reports the exit status and the cwd after `command` (the marker line wipes itself).
 * The line ends with `: <marker>EOL`, a no-op in every shell that only exists so the echo of this typed line — which the
 * remote readline may wrap anywhere — can be found and removed from the captured output.
 */
function sentinelLine(kind, command, marker) {
  const tail = `printf '\\n${marker}:%s:%s__\\r\\033[2K'`;
  const eol = `: ${marker}EOL`;
  if (kind === 'fish') return `\x15${command}; ${tail} $status $PWD; ${eol}\r`;
  if (kind === 'csh') return `\x15${command}; ${tail} $status $cwd; ${eol}\r`;
  return `\x15${command}; ${tail} "$?" "$PWD"; ${eol}\r`;
}

// valid in every shell: lets us learn the login shell before we know which syntax to use
const SHELL_PROBE = 'echo AITSHELL:$SHELL';
function parseShellProbe(text) {
  const m = String(text || '').match(/^AITSHELL:(\/\S*)\s*$/m); // the typed line is echoed with "$SHELL" unexpanded — only an expanded path counts
  return m ? m[1] : '';
}

/** One command, in the syntax of `kind`, that prints `AITPROBE|user|host|os arch|shell|home|cwd`. */
function probeCommand(kind) {
  if (kind === 'fish') return "printf 'AITPROBE|%s|%s|%s|%s|%s|%s\\n' (id -un) (hostname) (uname -sm) fish $HOME $PWD";
  if (kind === 'csh') return "printf 'AITPROBE|%s|%s|%s|%s|%s|%s\\n' \"`id -un`\" \"`hostname`\" \"`uname -sm`\" csh $HOME $cwd";
  return "printf 'AITPROBE|%s|%s|%s|%s|%s|%s\\n' \"$(id -un)\" \"$(hostname 2>/dev/null)\" \"$(uname -sm)\" \"${SHELL##*/}\" \"$HOME\" \"$PWD\"";
}

function parseProbe(text) {
  const m = String(text || '').match(/^AITPROBE\|([^|\n]*)\|([^|\n]*)\|([^|\n]*)\|([^|\n]*)\|([^|\n]*)\|([^\n]*)$/m);
  if (!m || /%s/.test(m[0])) return null; // the echoed command line contains the literal format string
  const [, user, host, uname, shell, home, cwd] = m;
  const [osName, arch] = uname.trim().split(/\s+/);
  return { user, host, os: osName || '', arch: arch || '', shell, home, cwd: cwd.trim() };
}

// ------------------------------------------------------------------ recent hosts (names only)
const TARGET_RE = /^[A-Za-z0-9_.@:[\]-]+$/;

/** A destination that is safe to put on an `ssh` command line (no option injection, no shell metacharacters). */
function validTarget(t) {
  const s = String(t || '');
  return s.length > 0 && s.length <= 300 && !s.startsWith('-') && TARGET_RE.test(s) && !/@$/.test(s);
}

/**
 * `AI Terminal --ssh=<host>`: the host to connect to, or null. Used by the menu-bar server list.
 * Use the `=` form: when a running instance is asked, Electron reorders the second launch's arguments (switches first,
 * positional values last), so a separate `--ssh <host>` can lose its value.
 * Only an acceptable destination (see validTarget) is returned, so nothing here can inject an ssh option or shell syntax.
 */
function externalSshTarget(argv) {
  const list = Array.isArray(argv) ? argv : [];
  const i = list.findIndex((a) => a === '--ssh' || (typeof a === 'string' && a.startsWith('--ssh=')));
  if (i < 0) return null;
  const v = list[i] === '--ssh' ? list[i + 1] : list[i].slice('--ssh='.length);
  return validTarget(v) ? String(v) : null;
}

/** The command line typed into the terminal for a host picked in the UI, or null when the target is not acceptable. */
function connectCommand(target, { keepAlive = true } = {}) {
  if (!validTarget(target)) return null;
  const d = parseDestination(target);
  if (!d.host || d.host.startsWith('-')) return null;
  const parts = ['ssh'];
  if (keepAlive) parts.push('-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3');
  // user@host:port is not ssh syntax; a bare [v6] stays as is
  const bare = /^\[/.test(target) ? target : `${d.user ? d.user + '@' : ''}${d.host}`;
  const m = !/^\[/.test(target) && target.match(/:(\d{1,5})$/);
  if (m && Number(m[1]) > 0 && Number(m[1]) < 65536) parts.push('-p', m[1]);
  parts.push(m ? bare.replace(/:\d+$/, '') : bare);
  return parts.join(' ');
}

class HostBook {
  constructor(dataDir, { sshDir = path.join(os.homedir(), '.ssh') } = {}) {
    this.file = dataDir ? path.join(dataDir, 'ssh-recent.json') : null;
    this.sshDir = sshDir;
    this.recent = [];
    try { if (this.file) this.recent = (JSON.parse(fs.readFileSync(this.file, 'utf8')).recent || []).filter((r) => validTarget(r.target)).slice(0, 20); } catch { /* none yet */ }
  }
  /** Hosts from ~/.ssh/config (never from known_hosts: hashed names cannot be listed and it may hold unrelated hosts). */
  configured() {
    try { return parseSshConfig(fs.readFileSync(path.join(this.sshDir, 'config'), 'utf8'), { baseDir: this.sshDir }); } catch { return []; }
  }
  list() {
    return { configured: this.configured(), recent: this.recent.map((r) => ({ ...r })) };
  }
  remember(target) {
    if (!validTarget(target)) return false;
    this.recent = [{ target, at: Date.now() }, ...this.recent.filter((r) => r.target !== target)].slice(0, 20);
    this._save();
    return true;
  }
  forget(target) {
    this.recent = this.recent.filter((r) => r.target !== target);
    this._save();
  }
  _save() {
    if (!this.file) return;
    try { fs.writeFileSync(this.file, JSON.stringify({ recent: this.recent }, null, 1), { mode: 0o600 }); } catch { /* read-only profile */ }
  }
}

// ------------------------------------------------------------------ watching a tab for an ssh session
/**
 * Polls the descendants of a tab's shell for an interactive `ssh` process and reads its output for connection problems.
 * Events: 'change' { active, pid, target, since }   'problem' { kind, level, hint, detail, fingerprint? }
 */
class SshWatcher extends EventEmitter {
  constructor(session, { descendants, intervalMs = 1500, hosts = () => [] } = {}) {
    super();
    this.session = session;
    this.descendants = descendants;
    this.intervalMs = intervalMs;
    this.hosts = hosts;
    this.cur = null;
    this.tail = '';
    this.lastProblem = new Map();
    this.timer = null;
    this.busy = false;
    this._onData = (t) => this._data(t);
  }
  start() {
    if (this.timer) return;
    this.session.on('data', this._onData);
    this.timer = setInterval(() => this.poll(), this.intervalMs);
  }
  stop() {
    clearTimeout(this._wait);
    this._wait = null;
    clearInterval(this.timer);
    this.timer = null;
    this.session.off('data', this._onData);
  }
  get active() {
    return this.cur;
  }
  _data(text) {
    this.tail = (this.tail + cleanTerminalText(text)).slice(-4000);
    const hit = classifySshOutput(this.tail);
    if (!hit) return;
    // the question and its fingerprint line usually arrive in separate chunks: give the second one a moment
    if (hit.kind === 'host-key-unknown' && !fingerprintOf(this.tail)) {
      if (!this._wait) this._wait = setTimeout(() => { this._wait = null; this._report(); }, 300);
      return;
    }
    this._report();
  }
  _report() {
    const hit = classifySshOutput(this.tail);
    if (!hit) return;
    // whatever was recognised is consumed, so the next problem is judged on its own text (and a repeat inside the
    // debounce window is simply dropped instead of hiding a different problem that follows it)
    const seenText = this.tail;
    this.tail = '';
    const now = Date.now();
    if (now - (this.lastProblem.get(hit.kind) || 0) < 15000) return;
    this.lastProblem.set(hit.kind, now);
    const fp = hit.kind === 'host-key-unknown' ? fingerprintOf(seenText) : null;
    this.emit('problem', { ...hit, ...(fp ? { fingerprint: fp } : {}), target: this.cur ? this.cur.target : null });
  }
  async poll() {
    if (this.busy || this.session.state === 'exited') return;
    this.busy = true;
    try {
      const list = await this.descendants(this.session.pid);
      let found = null;
      for (const p of list) {
        if (!/(^|\/)ssh(\s|$)/.test(p.command.split(/\s+/)[0] + ' ')) continue;
        const parsed = parseSshArgs(p.command);
        if (parsed && parsed.interactive && (!found || p.depth < found.depth)) found = { pid: p.pid, depth: p.depth, parsed };
      }
      const next = found ? { active: true, pid: found.pid, target: resolveFromConfig(found.parsed, this.hosts()), since: this.cur && this.cur.pid === found.pid ? this.cur.since : Date.now() } : null;
      const changed = (next && next.pid) !== (this.cur && this.cur.pid);
      this.cur = next;
      if (changed) this.emit('change', next ? next : { active: false });
    } catch { /* ps hiccup: keep the previous state */ } finally {
      this.busy = false;
    }
  }
}

module.exports = {
  parseSshArgs, parseDestination, resolveFromConfig, labelOf, idOf, splitArgs, parseSshConfig,
  classifySshOutput, fingerprintOf,
  shellKind, sentinelLine, SHELL_PROBE, parseShellProbe, probeCommand, parseProbe,
  validTarget, connectCommand, externalSshTarget, HostBook, SshWatcher,
};
