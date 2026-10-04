'use strict';
// The file panel's engine: browse a server and move files / folders between it and this Mac, over plain ssh channels
// (no SFTP subsystem or extra software is needed on the server — it only needs `sh`, `tar`, `base64` and `cat`).
//
//   listing     one `sh -c` script prints type / size / mode / mtime / owner per entry
//   edit        mkdir, rename (never clobbers), delete (refuses `/`, the home directory and relative paths), chmod
//   transfer    file → `cat` stream, folder → `tar` stream; progress, cancel, and a SHA-256 check for files
//
// Every remote path travels as base64 inside the command line, so no file name — spaces, quotes, `$`, unicode — can break
// the quoting, whatever the server's login shell is (bash, zsh, fish, csh).
// Credentials never pass through here: the connection is the SshLink (BatchMode / the user's shared connection).
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const D = 'd(){ printf %s "$1" | { base64 -d 2>/dev/null || base64 -D 2>/dev/null; }; }';
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

/** `sh -c '<script>' ait 'b64' …` — the script must not contain a single quote; arguments are base64 (alphabet is quote-safe). */
function shCmd(script, ...args) {
  if (script.includes("'")) throw new Error('script contains a single quote');
  const one = `${D}; ${script}`.replace(/\n/g, '; ').replace(/;\s*;/g, ';').replace(/\{\s*;/g, '{').replace(/then\s*;/g, 'then').replace(/else\s*;/g, 'else').replace(/do\s*;/g, 'do');
  return `sh -c '${one}' ait ${args.map((a) => `'${b64(a)}'`).join(' ')}`;
}

const LIST = `d=$(d "$1"); [ -n "$d" ] || d=.
cd -- "$d" 2>/dev/null || { echo AITERR:nodir; exit 3; }
echo "AITPWD:$(pwd -P)"
set -- ./* ./.[!.]* ./..?*
if stat --version >/dev/null 2>&1; then stat -c "AITLS:%F|%s|%a|%Y|%U|%n" -- "$@" 2>/dev/null; else stat -f "AITLS:%HT|%z|%Lp|%m|%Su|%N" -- "$@" 2>/dev/null; fi
for l in "$@"; do [ -L "$l" ] || continue; if [ -d "$l" ]; then k=d; else k=f; fi; printf "AITLNK:%s|%s|%s\\n" "$k" "$l" "$(readlink "$l")"; done
echo AITEND`;
const HOME = `echo "AITPWD:$(cd && pwd -P)"`;
const MKDIR = `p=$(d "$1"); o=$(mkdir -- "$p" 2>&1) && echo AITOK || { echo AITERR:fail; echo "$o"; }`;
const RENAME = `a=$(d "$1"); b=$(d "$2"); if [ -e "$b" ] || [ -L "$b" ]; then echo AITERR:exists; exit 4; fi; o=$(mv -- "$a" "$b" 2>&1) && echo AITOK || { echo AITERR:fail; echo "$o"; }`;
const REMOVE = `p=$(d "$1"); h=$(cd 2>/dev/null && pwd -P); if [ -z "$p" ] || [ "\${p#/}" = "$p" ] || [ "$p" = / ] || [ "$p" = "$HOME" ] || [ "$p" = "$HOME/" ] || [ "$p" = "$h" ] || [ "$p" = "$h/" ] || echo "$p" | grep -Eq "(^|/)[.][.]?(/|$)" || echo "$p" | grep -Eq "^/(etc|usr|bin|sbin|lib|lib32|lib64|var|opt|boot|dev|proc|sys|root|home|srv|tmp|mnt|media|run|System|Library|Applications|Users|Volumes|private|cores|Network)/?$"; then echo AITERR:refuse; exit 5; fi; o=$(rm -rf -- "$p" 2>&1) && echo AITOK || { echo AITERR:fail; echo "$o"; }`;
const CHMOD = `p=$(d "$1"); m=$(d "$2"); o=$(chmod -- "$m" "$p" 2>&1) && echo AITOK || { echo AITERR:fail; echo "$o"; }`;
const STAT1 = `p=$(d "$1"); if [ -d "$p" ]; then echo AITSTAT:d; elif [ -e "$p" ] || [ -L "$p" ]; then echo AITSTAT:f:$(wc -c < "$p" 2>/dev/null | tr -d " "); else echo AITSTAT:none; fi`;
const UPLOAD = `d=$(d "$1"); n=$(d "$2"); sz=$(d "$3"); t="$d/.$n.ait-$$.part"; trap "rm -f \\"$t\\"" EXIT; if cat > "$t" && [ "$(wc -c < "$t" | tr -d " ")" = "$sz" ] && mv -f -- "$t" "$d/$n"; then echo AITOK; else echo AITERR:write; fi`;
const UNTAR = `d=$(d "$1"); n=$(d "$2"); top=$(d "$3"); mkdir -p -- "$d" || { echo AITERR:tar; exit 6; }; s=$(mktemp -d "$d/.ait-stage.XXXXXX") || { echo AITERR:write; exit 6; }; trap "rm -rf \\"$s\\"" EXIT; if tar -C "$s" -xf - && [ -d "$s/$top" ]; then if [ -d "$d/$n" ]; then cp -Rp "$s/$top/." "$d/$n/" && echo AITOK || echo AITERR:write; else mv -- "$s/$top" "$d/$n" && echo AITOK || echo AITERR:write; fi; else echo AITERR:tar; fi`;
const CATFILE = `p=$(d "$1"); exec cat -- "$p"`;
const TARDIR = `p=$(d "$1"); exec tar -C "$(dirname "$p")" -cf - "$(basename "$p")"`;
const HASHF = `f=$(d "$1"); echo "AITHASH:$( { sha256sum "$f" 2>/dev/null || shasum -a 256 "$f"; } | cut -d" " -f1)"`;
const PREVIEW = `f=$(d "$1"); n=$(d "$2"); [ -f "$f" ] || { echo AITERR:notfile; exit 3; }; grep -Iq . "$f" 2>/dev/null || [ ! -s "$f" ] || { echo AITERR:binary; exit 5; }; echo AITBEGIN; head -c "$n" "$f" | LC_ALL=C tr -d "\\000-\\010\\013\\014\\016-\\037\\177"; echo; echo AITEND`;

const permString = (mode) => {
  const n = parseInt(mode, 8);
  if (!Number.isFinite(n)) return '?????????';
  const t = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx'];
  return t[(n >> 6) & 7] + t[(n >> 3) & 7] + t[n & 7];
};

/** One `AITLS:` line → entry. */
function parseEntry(line) {
  const m = line.match(/^AITLS:([^|]*)\|(\d*)\|([0-7]*)\|(\d*)\|([^|]*)\|(.*)$/);
  if (!m) return null;
  const [, kind, size, mode, mtime, owner, rawName] = m;
  const name = rawName.replace(/^\.\//, '');
  if (!name || name === '.' || name === '..' || /[\n\0]/.test(name)) return null;
  const k = kind.toLowerCase();
  const type = k.includes('directory') ? 'dir' : k.includes('symbolic') ? 'link' : k.includes('regular') ? 'file' : 'other';
  return { name, type, size: Number(size) || 0, mode, perm: permString(mode), mtime: Number(mtime) || 0, owner, link: null };
}

/** Parse the whole listing output. */
function parseListing(out) {
  const entries = new Map();
  let cwd = '';
  let error = '';
  for (const raw of String(out).split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('AITPWD:')) cwd = line.slice(7);
    else if (line.startsWith('AITERR:')) error = line.slice(7);
    else if (line.startsWith('AITLS:')) {
      const e = parseEntry(line);
      if (e) entries.set(e.name, e);
    } else if (line.startsWith('AITLNK:')) {
      const m = line.slice(7).match(/^([df])\|\.\/([^|]*)\|(.*)$/);
      if (m && entries.has(m[2])) entries.get(m[2]).link = { target: m[3], dir: m[1] === 'd' };
    }
  }
  const list = [...entries.values()].sort((a, b) => {
    const da = a.type === 'dir' || (a.link && a.link.dir) ? 0 : 1;
    const db = b.type === 'dir' || (b.link && b.link.dir) ? 0 : 1;
    return da - db || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
  return { cwd, error, entries: list.slice(0, 5000), truncated: list.length > 5000 };
}

const errText = (out) => {
  const m = String(out).match(/AITERR:(\w+)\n?([^\n]*)/);
  return m ? { code: m[1], detail: m[2] } : null;
};
const MSG = {
  nodir: '폴더를 열 수 없습니다(없거나 권한이 없음).',
  exists: '같은 이름이 이미 있습니다.',
  refuse: '안전을 위해 이 경로는 지우지 않습니다(루트·홈·상대 경로).',
  fail: '실패했습니다.',
  write: '서버에 쓰지 못했습니다(권한 또는 디스크 공간).',
  tar: '서버에서 폴더를 풀지 못했습니다(tar 필요).',
  notfile: '파일이 아닙니다.',
  binary: '바이너리 파일입니다.',
};
const explain = (e) => (e ? `${MSG[e.code] || '실패했습니다.'}${e.detail ? ` (${e.detail.slice(0, 160)})` : ''}` : '응답을 해석하지 못했습니다.');

const safeName = (n) => {
  const s = path.basename(String(n || '')).replace(/[\0/]/g, '_');
  return s && s !== '.' && s !== '..' ? s : 'download';
};
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const uniqueName = (dir, name, taken = () => false) => {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const n = `${base} (${i})${ext}`;
    if (!exists(path.join(dir, n)) && !taken(n)) return n;
  }
  return `${base}-${Date.now()}${ext}`;
};

async function dirSize(p, cap = 200000) {
  let total = 0;
  let n = 0;
  const walk = async (d) => {
    let list;
    try { list = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (++n > cap) return;
      const f = path.join(d, e.name);
      if (e.isDirectory()) await walk(f);
      else if (e.isFile()) { try { total += (await fs.promises.stat(f)).size; } catch { /* vanished */ } }
    }
  };
  await walk(p);
  return total;
}

class RemoteBrowser extends EventEmitter {
  /** @param {SshLink} link  @param {{concurrency?: number}} o */
  constructor(link, { concurrency = 2 } = {}) {
    super();
    this.link = link;
    this.concurrency = concurrency;
    this.seq = 0;
    this.transfers = new Map(); // id -> record
    this.queue = [];
    this.running = 0;
    this.link.retain();
  }

  close() {
    for (const t of this.transfers.values()) if (t.state === 'running' || t.state === 'queued') this.cancel(t.id);
    this.link.release();
  }

  // ------------------------------------------------------------ browsing
  async _sh(script, args, opts) {
    return this.link.exec(shCmd(script, ...args), { timeoutMs: 20000, ...opts });
  }
  _fail(r, fallback) {
    if (r.code === 255 || /Permission denied|Connection (refused|closed|timed out|reset)|No route|Could not resolve/i.test(r.stderr)) {
      this.link.invalidate();
      return { error: /Permission denied/i.test(r.stderr) ? '비밀번호를 묻지 않는 연결(SSH 키)이나 앱의 "SSH 접속" 메뉴로 연 세션이 필요합니다.' : `서버에 연결하지 못했습니다. ${r.stderr.trim().split('\n').pop() || ''}`.trim(), offline: true };
    }
    return { error: fallback };
  }

  /** The login directory on the server. */
  async home() {
    const r = await this._sh(HOME, []);
    const m = r.stdout.match(/^AITPWD:(.+)$/m);
    return m ? { path: m[1] } : this._fail(r, '홈 디렉터리를 알 수 없습니다.');
  }

  /** @returns {{path, entries, truncated} | {error}} — `dir` may be '' (home), relative to home, or absolute */
  async list(dir) {
    const r = await this._sh(LIST, [dir || '']);
    const out = parseListing(r.stdout);
    if (out.error) return { error: explain({ code: out.error, detail: '' }) };
    if (!out.cwd) return this._fail(r, '목록을 읽지 못했습니다.');
    return { path: out.cwd, entries: out.entries, truncated: out.truncated };
  }

  async mkdir(p) {
    const r = await this._sh(MKDIR, [p]);
    return /AITOK/.test(r.stdout) ? { ok: true } : { error: explain(errText(r.stdout)) };
  }
  async rename(from, to) {
    const r = await this._sh(RENAME, [from, to]);
    return /AITOK/.test(r.stdout) ? { ok: true } : { error: explain(errText(r.stdout)) };
  }
  async remove(p) {
    if (!path.posix.isAbsolute(p)) return { error: explain({ code: 'refuse', detail: '' }) };
    const r = await this._sh(REMOVE, [p], { timeoutMs: 120000 });
    return /AITOK/.test(r.stdout) ? { ok: true } : { error: explain(errText(r.stdout)) };
  }
  async chmod(p, mode) {
    if (!/^[0-7]{3,4}$/.test(String(mode))) return { error: '권한은 8진수 3~4자리여야 합니다(예: 644).' };
    const r = await this._sh(CHMOD, [p, String(mode)]);
    return /AITOK/.test(r.stdout) ? { ok: true } : { error: explain(errText(r.stdout)) };
  }
  /** { kind: 'dir' | 'file' | 'none', size } */
  async stat(p) {
    const r = await this._sh(STAT1, [p]);
    const m = r.stdout.match(/^AITSTAT:(d|none|f)(?::(\d*))?$/m);
    if (!m) return this._fail(r, '확인하지 못했습니다.');
    return { kind: m[1] === 'd' ? 'dir' : m[1] === 'f' ? 'file' : 'none', size: Number(m[2]) || 0 };
  }
  async hash(p) {
    const r = await this._sh(HASHF, [p], { timeoutMs: 120000 });
    const m = r.stdout.match(/^AITHASH:([0-9a-f]{64})$/m);
    return m ? { hash: m[1] } : { error: '해시를 계산하지 못했습니다.' };
  }
  /** First `max` bytes of a text file (control characters removed), for the quick look in the panel. */
  async preview(p, max = 20000) {
    const r = await this._sh(PREVIEW, [p, String(Math.min(max, 200000))]);
    const e = errText(r.stdout);
    if (e) return { error: explain(e) };
    const m = r.stdout.match(/(?:^|\n)AITBEGIN\n([\s\S]*)\nAITEND\s*$/);
    return m ? { text: m[1].replace(/\r\n/g, '\n').replace(/\n$/, '') } : { error: '미리보기를 읽지 못했습니다.' };
  }

  // ------------------------------------------------------------ transfers
  /**
   * Queue an upload of local files / folders into a remote directory. Resolves when it is queued with { id } (the work runs
   * in the background; watch the 'transfer' events), or { conflict } / { error } straight away.
   * `mode` decides what happens when the name already exists: 'fail' (default: report the conflict), 'overwrite', 'rename', 'skip'.
   */
  async upload(localPath, remoteDir, { mode = 'fail', verify = true } = {}) {
    let st;
    try { st = await fs.promises.lstat(localPath); } catch { return { error: '로컬 파일을 찾을 수 없습니다.' }; }
    if (!st.isFile() && !st.isDirectory()) return { error: '일반 파일이나 폴더만 올릴 수 있습니다.' };
    const name = safeName(localPath);
    const dest = path.posix.join(remoteDir, name);
    const cur = await this.stat(dest);
    if (cur.error) return cur;
    let finalName = name;
    if (cur.kind !== 'none') {
      if (mode === 'fail') return { conflict: { name, kind: cur.kind, remote: dest } };
      if (mode === 'skip') return { skipped: true, name };
      if (mode === 'rename') {
        let n = name;
        for (let i = 1; i < 200 && (await this.stat(path.posix.join(remoteDir, n))).kind !== 'none'; i++) {
          const ext = path.extname(name);
          n = `${name.slice(0, name.length - ext.length)} (${i})${ext}`;
        }
        finalName = n;
      } else if (cur.kind === 'dir' || st.isDirectory()) {
        if (!(cur.kind === 'dir' && st.isDirectory())) return { error: '파일과 폴더는 서로 덮어쓸 수 없습니다.' };
      }
    }
    const total = st.isDirectory() ? await dirSize(localPath) : st.size;
    return this._enqueue({ dir: 'up', name: finalName, local: localPath, remote: path.posix.join(remoteDir, finalName), remoteDir, isDir: st.isDirectory(), total, verify: verify && st.isFile() && st.size <= 200 * 1024 * 1024, overwrite: cur.kind !== 'none' && mode === 'overwrite' });
  }

  /** Queue a download of a remote file / folder into a local directory (same `mode` rules). */
  async download(remotePath, localDir, { mode = 'fail', verify = true } = {}) {
    const st = await this.stat(remotePath);
    if (st.error) return st;
    if (st.kind === 'none') return { error: '서버에 파일이 없습니다.' };
    const name = safeName(path.posix.basename(remotePath));
    let finalName = name;
    if (exists(path.join(localDir, name))) {
      if (mode === 'fail') return { conflict: { name, kind: st.kind, local: path.join(localDir, name) } };
      if (mode === 'skip') return { skipped: true, name };
      if (mode === 'rename') finalName = uniqueName(localDir, name, (n) => [...this.transfers.values()].some((t) => t.state !== 'done' && t.local === path.join(localDir, n)));
    }
    return this._enqueue({ dir: 'down', name: finalName, remoteName: name, local: path.join(localDir, finalName), localDir, remote: remotePath, isDir: st.kind === 'dir', total: st.size, verify: verify && st.kind === 'file' && st.size <= 200 * 1024 * 1024, overwrite: mode === 'overwrite' });
  }

  _enqueue(t) {
    const rec = { id: `x${++this.seq}`, state: 'queued', bytes: 0, startedAt: 0, error: '', ...t, ctl: new AbortController() };
    this.transfers.set(rec.id, rec);
    this.queue.push(rec);
    this._emit(rec);
    this._pump();
    return { id: rec.id, name: rec.name };
  }
  _pump() {
    while (this.running < this.concurrency && this.queue.length) {
      const t = this.queue.shift();
      if (t.state !== 'queued') continue;
      this.running++;
      t.state = 'running';
      t.startedAt = Date.now();
      this._emit(t);
      (t.dir === 'up' ? this._runUpload(t) : this._runDownload(t))
        .catch((e) => { t.error = t.error || e.message; t.state = 'error'; })
        .finally(() => {
          this.running--;
          if (t.state === 'running') t.state = t.error ? 'error' : 'done';
          this._emit(t, true);
          this._pump();
        });
    }
  }
  cancel(id) {
    const t = this.transfers.get(id);
    if (!t || t.state === 'done' || t.state === 'error' || t.state === 'cancelled') return false;
    t.ctl.abort();
    if (t.state === 'queued') { t.state = 'cancelled'; this._emit(t, true); }
    else t.state = 'cancelling';
    return true;
  }
  clearFinished() {
    for (const [id, t] of this.transfers) if (['done', 'error', 'cancelled'].includes(t.state)) this.transfers.delete(id);
  }
  list_transfers() {
    return [...this.transfers.values()].map((t) => this._public(t));
  }
  _public(t) {
    const secs = Math.max(0.001, (Date.now() - (t.startedAt || Date.now())) / 1000);
    return { id: t.id, dir: t.dir, name: t.name, isDir: t.isDir, state: t.state, bytes: t.bytes, total: t.total, speed: t.state === 'running' ? Math.round(t.bytes / secs) : 0, error: t.error, verified: !!t.verified, local: t.local, remote: t.remote };
  }
  _emit(t, force) {
    const now = Date.now();
    if (!force && t._last && now - t._last < 120) return;
    t._last = now;
    this.emit('transfer', this._public(t));
  }
  _finish(t, error) {
    if (t.ctl.signal.aborted) { t.state = 'cancelled'; t.error = ''; } else if (error) { t.state = 'error'; t.error = error; } else t.state = 'done';
  }

  async _runUpload(t) {
    const link = this.link;
    const stderr = [];
    let tarProc = null;
    let src;
    const hasher = t.verify ? crypto.createHash('sha256') : null;
    const child = await link.child(t.isDir ? shCmd(UNTAR, t.remoteDir, t.name, path.basename(t.local)) : shCmd(UPLOAD, t.remoteDir, t.name, String(t.total)));
    child.stderr.on('data', (d) => stderr.push(d));
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const closed = new Promise((res) => child.on('close', (code) => res(code)));
    const abort = () => { try { child.kill('SIGTERM'); } catch { /* gone */ } if (tarProc) try { tarProc.kill('SIGTERM'); } catch { /* gone */ } if (src) src.destroy(); };
    t.ctl.signal.addEventListener('abort', abort, { once: true });
    child.stdin.on('error', () => {});
    try {
      if (t.isDir) {
        tarProc = spawn('tar', ['-C', path.dirname(t.local), '-cf', '-', path.basename(t.local)], { env: { ...process.env, COPYFILE_DISABLE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
        src = tarProc.stdout;
      } else src = fs.createReadStream(t.local);
      src.on('data', (d) => { t.bytes += d.length; if (hasher) hasher.update(d); this._emit(t); });
      src.pipe(child.stdin);
      await new Promise((res) => { src.on('end', res); src.on('error', res); src.on('close', res); });
      const code = await closed;
      if (t.ctl.signal.aborted) return this._finish(t);
      if (!/AITOK/.test(out)) return this._finish(t, code === 255 ? `연결이 끊어졌습니다. ${Buffer.concat(stderr).toString().trim().split('\n').pop()}` : explain(errText(out) || { code: 'write', detail: Buffer.concat(stderr).toString().trim().split('\n').pop() }));
      if (hasher) {
        const h = await this.hash(t.remote);
        if (h.error || h.hash !== hasher.digest('hex')) return this._finish(t, '전송 후 검증에 실패했습니다(내용이 다릅니다). 다시 시도하세요.');
        t.verified = true;
      }
      this._finish(t);
    } finally {
      t.ctl.signal.removeEventListener('abort', abort);
    }
  }

  async _runDownload(t) {
    const link = this.link;
    const part = path.join(t.localDir, `.${t.name}.ait-${process.pid}.part`);
    const stderr = [];
    let untar = null;
    let dst = null;
    const hasher = t.verify ? crypto.createHash('sha256') : null;
    const child = await link.child(shCmd(t.isDir ? TARDIR : CATFILE, t.remote));
    child.stderr.on('data', (d) => stderr.push(d));
    const closed = new Promise((res) => child.on('close', (code) => res(code)));
    const abort = () => { try { child.kill('SIGTERM'); } catch { /* gone */ } if (untar) try { untar.kill('SIGTERM'); } catch { /* gone */ } if (dst) dst.destroy(); };
    t.ctl.signal.addEventListener('abort', abort, { once: true });
    const cleanup = () => { try { fs.rmSync(part, { recursive: true, force: true }); } catch { /* ignore */ } };
    try {
      if (t.isDir) {
        // extract into a private staging folder first, then move the single top-level item into place
        fs.mkdirSync(part, { recursive: true });
        untar = spawn('tar', ['-xf', '-', '-C', part], { stdio: ['pipe', 'ignore', 'pipe'] });
        untar.stdin.on('error', () => {});
        untar.stderr.on('data', (d) => stderr.push(d));
        child.stdout.on('data', (d) => { t.bytes += d.length; this._emit(t); });
        child.stdout.pipe(untar.stdin);
        const untarDone = new Promise((res) => untar.on('close', (code) => res(code)));
        const code = await closed;
        const ucode = await untarDone;
        if (t.ctl.signal.aborted) { cleanup(); return this._finish(t); }
        if (code !== 0 || ucode !== 0) { cleanup(); return this._finish(t, `폴더를 받지 못했습니다. ${Buffer.concat(stderr).toString().trim().split('\n').pop() || ''}`.trim()); }
        const got = fs.readdirSync(part);
        if (got.length !== 1) { cleanup(); return this._finish(t, '받은 폴더의 구성이 예상과 다릅니다.'); }
        if (t.overwrite) fs.rmSync(t.local, { recursive: true, force: true });
        fs.renameSync(path.join(part, got[0]), t.local);
        cleanup();
        return this._finish(t);
      }
      dst = fs.createWriteStream(part, { mode: 0o600 });
      child.stdout.on('data', (d) => { t.bytes += d.length; if (hasher) hasher.update(d); this._emit(t); });
      child.stdout.pipe(dst);
      const wrote = new Promise((res) => { dst.on('finish', res); dst.on('close', res); dst.on('error', res); });
      const code = await closed;
      await wrote;
      if (t.ctl.signal.aborted) { cleanup(); return this._finish(t); }
      if (code !== 0) { cleanup(); return this._finish(t, `파일을 받지 못했습니다. ${Buffer.concat(stderr).toString().trim().split('\n').pop() || ''}`.trim()); }
      if (hasher) {
        const h = await this.hash(t.remote);
        if (h.error || h.hash !== hasher.digest('hex')) { cleanup(); return this._finish(t, '전송 후 검증에 실패했습니다(내용이 다릅니다). 다시 시도하세요.'); }
        t.verified = true;
      }
      fs.renameSync(part, t.local); // replaces an existing file only when the caller chose to overwrite
      try { fs.chmodSync(t.local, 0o644 & ~process.umask()); } catch { /* ignore */ }
      this._finish(t);
    } catch (e) {
      cleanup();
      this._finish(t, e.message);
    } finally {
      t.ctl.signal.removeEventListener('abort', abort);
    }
  }
}

// ------------------------------------------------------------ this Mac
/** The local side of the panel: a folder listing (names, types, sizes) — read-only, never follows links for type. */
async function localList(dir) {
  const p = dir ? path.resolve(String(dir).replace(/^~(?=\/|$)/, os.homedir())) : os.homedir();
  let names;
  try { names = await fs.promises.readdir(p, { withFileTypes: true }); } catch (e) { return { error: e.code === 'EACCES' ? '이 폴더를 읽을 권한이 없습니다.' : '폴더를 열 수 없습니다.' }; }
  const entries = [];
  for (const e of names.slice(0, 5000)) {
    let st;
    try { st = await fs.promises.lstat(path.join(p, e.name)); } catch { continue; }
    let linkDir = false;
    if (st.isSymbolicLink()) { try { linkDir = (await fs.promises.stat(path.join(p, e.name))).isDirectory(); } catch { /* dangling */ } }
    entries.push({ name: e.name, type: st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'link' : st.isFile() ? 'file' : 'other', size: st.size, mode: (st.mode & 0o777).toString(8), perm: permString((st.mode & 0o777).toString(8)), mtime: Math.floor(st.mtimeMs / 1000), link: st.isSymbolicLink() ? { dir: linkDir } : null });
  }
  entries.sort((a, b) => {
    const da = a.type === 'dir' || (a.link && a.link.dir) ? 0 : 1;
    const db = b.type === 'dir' || (b.link && b.link.dir) ? 0 : 1;
    return da - db || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
  return { path: p, entries, truncated: names.length > 5000 };
}

module.exports = { RemoteBrowser, localList, shCmd, parseListing, parseEntry, permString, safeName, uniqueName, dirSize, b64 };
