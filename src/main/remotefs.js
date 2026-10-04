'use strict';
// File operations on the other side of an ssh session (or a nested shell), done through the shell the user can see.
//
//   read / search   `sh -c` scripts that print between markers; control characters (ESC …) are stripped so a hostile file
//                   cannot drive the local terminal or our private OSC channel
//   write           the content travels as base64 into a temp file (remote tty echo off), is decoded, checked against the
//                   SHA-256 computed here, and only then copied over the target — a broken transfer never touches the file
//
// The module is shell-agnostic: it talks to a `runner` { run(cmd, opts) -> {status, exitCode, output}, upload(destQuoted,
// lines, opts) -> same }. Every helper script is plain POSIX sh run as `sh -c '<script>' ait <args>` and the arguments
// are quoted here, so the login shell on the far side (bash, zsh, fish …) only has to understand `sh -c 'script' ait 'arg'`.
const crypto = require('crypto');
const path = require('path');

const MAX_READ = 256 * 1024; // bytes read through the terminal in one go
const MAX_WRITE = 200 * 1024; // same limit as local writes
const CHUNK = 512; // base64 characters per input line (a remote canonical tty keeps ≥ 1 KB lines)

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Paths are passed in single quotes; refuse the characters that cannot be quoted the same way in every shell. */
function pathProblem(p) {
  if (!p) return 'path 가 비어 있습니다.';
  if (/[\0\n\r']/.test(p)) return "경로에 작은따옴표(')·줄바꿈·NUL 은 쓸 수 없습니다.";
  if (p.length > 1024) return '경로가 너무 깁니다.';
  return '';
}
const q = (s) => `'${s}'`; // callers have already passed pathProblem(); numbers and fixed words need no escaping

/** Resolve ~, relative and absolute paths against the remote home / cwd (POSIX rules). */
function resolveRemote(p, { home = '', cwd = '' } = {}) {
  if (!p) return '';
  let s = String(p);
  if (s === '~') s = home || '~';
  else if (s.startsWith('~/')) s = path.posix.join(home || '~', s.slice(2));
  else if (!s.startsWith('/')) s = path.posix.join(cwd || home || '/', s);
  return path.posix.normalize(s);
}

// POSIX sh scripts; $1.. are the arguments. Printed markers sit on their own lines.
const SH_STAT = `f=$1
if [ -d "$f" ]; then echo AITSTAT:dir
elif [ -f "$f" ]; then
  s=$(wc -c < "$f" | tr -d " ")
  if [ "$s" = 0 ] || grep -Iq . "$f" 2>/dev/null; then k=text; else k=bin; fi
  echo AITSTAT:file:$s:$k
elif [ -e "$f" ]; then echo AITSTAT:other
else echo AITSTAT:none; fi`;

const SH_READ = `f=$1; a=$2; b=$3
[ -f "$f" ] || { echo AITERR:notfile; exit 3; }
s=$(wc -c < "$f" | tr -d " ")
[ "$s" -le ${MAX_READ} ] || [ -n "$a" ] || { echo AITERR:toolarge:$s; exit 4; }
[ "$s" = 0 ] || grep -Iq . "$f" 2>/dev/null || { echo AITERR:binary; exit 5; }
echo AITBEGIN
if [ -n "$a" ]; then sed -n "$a,\${b}p" "$f" | head -c ${MAX_READ}; else cat "$f"; fi | LC_ALL=C tr -d "\\000-\\010\\013\\014\\016-\\037\\177"
echo
echo AITEND:$(wc -l < "$f" | tr -d " ")`;

const SH_INSTALL = `d=$1; t=$2; h=$3
c() { rm -f "$t" "$t.b64"; }; trap c EXIT
{ base64 -d < "$t.b64" > "$t" 2>/dev/null || base64 -D < "$t.b64" > "$t" 2>/dev/null || openssl base64 -d -A < "$t.b64" > "$t"; } || { echo AITERR:decode; exit 6; }
g=$( { sha256sum "$t" 2>/dev/null || shasum -a 256 "$t"; } | cut -d" " -f1)
[ "$g" = "$h" ] || { echo AITERR:hash; exit 7; }
if [ -e "$d" ]; then cat "$t" > "$d" || { echo AITERR:write; exit 8; }
else mv "$t" "$d" && chmod 644 "$d" || { echo AITERR:write; exit 8; }; fi
echo AITOK`;

const SH_HASH = `f=$1; [ -f "$f" ] || { echo AITERR:notfile; exit 3; }
echo AITHASH:$( { sha256sum "$f" 2>/dev/null || shasum -a 256 "$f"; } | cut -d" " -f1)`;

const SH_WRITABLE = `d=$1; t=$2
[ -d "$d" ] || { echo AITERR:nodir; exit 3; }
: > "$t" 2>/dev/null || { echo AITERR:readonly; exit 4; }
rm -f "$t"; echo AITOK`;

const SH_SEARCH = `pat=$1; dir=$2
if command -v rg >/dev/null 2>&1; then rg -n --no-heading -S -m 5 -- "$pat" "$dir" 2>/dev/null | head -n 60
else grep -rIn --exclude-dir=.git --exclude-dir=node_modules -m 5 -- "$pat" "$dir" 2>/dev/null | head -n 60; fi | LC_ALL=C tr -d "\\000-\\010\\013\\014\\016-\\037\\177"
echo AITEND`;

/** `sh -c '<script>' ait 'a1' 'a2' …` — the script must not contain a single quote. */
function shCmd(script, ...args) {
  if (script.includes("'")) throw new Error('script contains a single quote');
  return `sh -c '${script.replace(/\n/g, '; ').replace(/;\s*;/g, ';').replace(/\{\s*;/g, '{').replace(/then\s*;/g, 'then').replace(/else\s*;/g, 'else').replace(/do\s*;/g, 'do')}' ait ${args.map((a) => q(a)).join(' ')}`;
}

const lineOf = (out, re) => { const m = String(out).match(re); return m ? m : null; };

class RemoteFS {
  /** @param {{run: Function, upload: Function}} runner  @param {{home?: string, getCwd?: Function, posix?: boolean}} env */
  constructor(runner, { home = '', getCwd = () => '', posix = true } = {}) {
    this.runner = runner;
    this.home = home;
    this.getCwd = getCwd;
    this.posix = posix;
  }

  resolve(p) {
    return resolveRemote(p, { home: this.home, cwd: this.getCwd() });
  }

  async _sh(script, args, opts = {}) {
    const r = await this.runner.run(shCmd(script, ...args), { maxMs: 30000, raw: true, ...opts });
    return r;
  }

  static failure(r) {
    if (r.status === 'disconnected') return '원격 연결이 끊어졌습니다.';
    if (r.status === 'waiting_input') return '원격이 비밀번호를 기다리고 있습니다. 사용자가 터미널에서 입력해야 합니다.';
    if (r.status === 'fullscreen') return '원격에서 전체 화면 프로그램(vim, top 등)이 실행 중입니다. 먼저 종료해야 합니다.';
    if (r.status === 'busy') return '원격 셸이 다른 작업을 처리 중입니다.';
    if (r.status === 'running') return '원격 명령이 시간 안에 끝나지 않았습니다.';
    if (r.status === 'aborted') return '중단됨';
    return '';
  }

  async stat(p, opts) {
    const bad = pathProblem(p);
    if (bad) return { error: bad };
    const r = await this._sh(SH_STAT, [p], opts);
    const f = RemoteFS.failure(r);
    if (f) return { error: f };
    const m = lineOf(r.output, /^AITSTAT:(dir|file|other|none)(?::(\d+):(text|bin))?$/m);
    if (!m) return { error: '원격 응답을 해석하지 못했습니다.' };
    return { kind: m[1], size: m[2] ? Number(m[2]) : 0, text: m[3] !== 'bin' };
  }

  /** Text of a remote file (or a line range). { content, totalLines } or { error }. */
  async read(p, start, end, opts) {
    const bad = pathProblem(p);
    if (bad) return { error: bad };
    const a = start ? String(Math.max(1, Math.floor(start))) : '';
    const b = start ? String(Math.max(Math.floor(start), Math.floor(end || start + 119))) : '';
    const r = await this._sh(SH_READ, [p, a, b], opts);
    const f = RemoteFS.failure(r);
    if (f) return { error: f };
    const err = lineOf(r.output, /^AITERR:(\w+)(?::(\d+))?$/m);
    if (err) {
      const msg = { notfile: '파일이 없거나 일반 파일이 아닙니다.', toolarge: `파일이 너무 큽니다(${Math.round(Number(err[2] || 0) / 1024)}KB, 256KB 초과). start_line/end_line 이나 grep 으로 일부만 보세요.`, binary: '바이너리 파일입니다.' }[err[1]];
      return { error: msg || `읽기 실패(${err[1]})` };
    }
    // the script prints AITBEGIN, the content, one added newline, then AITEND:<lines>
    const m = String(r.output).match(/(?:^|\n)AITBEGIN\n([\s\S]*)\nAITEND:(\d+)\s*$/);
    if (!m) return { error: '원격 응답을 해석하지 못했습니다.' };
    return { content: m[1].replace(/\n$/, ''), exact: m[1], totalLines: Number(m[2]), from: a ? Number(a) : 1, to: b ? Number(b) : Number(m[2]) };
  }

  async hash(p, opts) {
    const bad = pathProblem(p);
    if (bad) return { error: bad };
    const r = await this._sh(SH_HASH, [p], opts);
    const f = RemoteFS.failure(r);
    if (f) return { error: f };
    const m = lineOf(r.output, /^AITHASH:([0-9a-f]{64})$/m);
    return m ? { hash: m[1] } : { error: /AITERR:notfile/.test(r.output) ? '파일이 없습니다.' : '원격 응답을 해석하지 못했습니다.' };
  }

  /** Replace (or create) a remote file. { ok, hash, created } or { error }. Nothing is touched unless the transfer verifies. */
  async write(p, content, { signal } = {}) {
    const bad = pathProblem(p);
    if (bad) return { error: bad };
    if (!this.posix) return { error: '이 원격 셸(fish/csh 등)에서는 파일 쓰기를 지원하지 않습니다. run 으로 직접 명령을 쓰세요.' };
    const buf = Buffer.from(content, 'utf8');
    if (buf.length > MAX_WRITE) return { error: '내용이 너무 큽니다(200KB 초과).' };
    const hash = sha256(buf);
    const dir = path.posix.dirname(p);
    const tmp = `${p}.ait-${crypto.randomBytes(4).toString('hex')}`;
    const existed = (await this.stat(p, { signal })).kind === 'file';
    const w = await this._sh(SH_WRITABLE, [dir, tmp], { signal });
    const wf = RemoteFS.failure(w);
    if (wf) return { error: wf };
    if (/AITERR:nodir/.test(w.output)) return { error: `디렉터리가 없습니다: ${dir}` };
    if (/AITERR:readonly/.test(w.output)) return { error: `쓰기 권한이 없습니다: ${dir}` };
    if (!/AITOK/.test(w.output)) return { error: '원격 응답을 해석하지 못했습니다.' };
    const b64 = buf.toString('base64');
    const lines = [];
    for (let i = 0; i < b64.length; i += CHUNK) lines.push(b64.slice(i, i + CHUNK));
    if (!lines.length) lines.push('');
    const up = await this.runner.upload(q(`${tmp}.b64`), lines, { signal });
    const uf = RemoteFS.failure(up);
    if (uf) {
      await this._sh('rm -f "$1" "$1.b64"', [tmp], { maxMs: 8000 }).catch(() => {});
      return { error: uf };
    }
    const r = await this._sh(SH_INSTALL, [p, tmp, hash], { signal, maxMs: 60000 });
    const f = RemoteFS.failure(r);
    if (f) return { error: f };
    const err = lineOf(r.output, /^AITERR:(\w+)$/m);
    if (err) return { error: { decode: '원격에서 내용을 복원하지 못했습니다(base64 없음?).', hash: '전송한 내용이 원격에서 달라져 파일을 바꾸지 않았습니다.', write: '원격 파일을 쓰지 못했습니다(권한?).' }[err[1]] || `쓰기 실패(${err[1]})` };
    if (!/AITOK/.test(r.output)) return { error: '원격 응답을 해석하지 못했습니다.' };
    return { ok: true, hash, created: !existed };
  }

  async search(pattern, dir, opts) {
    if (!pattern || /[\0\n\r]/.test(pattern) || pattern.includes("'")) return { error: "검색어에는 작은따옴표(')·줄바꿈을 쓸 수 없습니다." };
    const bad = pathProblem(dir || '.');
    if (bad) return { error: bad };
    const r = await this._sh(SH_SEARCH, [pattern, dir || '.'], opts);
    const f = RemoteFS.failure(r);
    if (f) return { error: f };
    const m = String(r.output).match(/^([\s\S]*?)\n?^AITEND$/m);
    const text = (m ? m[1] : r.output).trim();
    return { content: text, count: text ? text.split('\n').length : 0 };
  }
}

module.exports = { RemoteFS, resolveRemote, pathProblem, shCmd, sha256, MAX_READ, MAX_WRITE, CHUNK };
