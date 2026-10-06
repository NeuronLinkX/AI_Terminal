'use strict';
// The remote (ssh / nested shell) half of the agent: entering and leaving remote mode, the description of the far side the
// model gets, and file tools that act on the REMOTE machine. Mixed into Agent.prototype (see agent.js).
//
// Safety rules that differ from local work:
//   - every remote file write asks the user (unless trust mode), shows the diff, and names the server
//   - a remote command that is not read-only asks too (settings.sshStrict, default on)
//   - rules the user grants ("allow this session") are scoped to that server and never leak to local or other hosts
//   - passwords / passphrases / host-key questions are never answered by the agent
const fs = require('fs');
const path = require('path');
const ssh = require('./ssh');
const { RemoteFS, sha256, MAX_WRITE } = require('./remotefs');
const { truncateMiddle, maskSecrets, isSecretPath } = require('./text');

const STATUS_TEXT = {
  disconnected: 'SSH 연결이 끊어졌거나 원격 셸이 종료되었습니다.',
  waiting_input: '원격이 비밀번호/입력을 기다리고 있습니다. 사용자가 터미널에서 직접 입력해야 합니다(AI는 입력하지 않습니다).',
  fullscreen: '원격에서 전체 화면 프로그램(vim, top, less 등)이 실행 중입니다. 사용자가 먼저 종료해야 합니다.',
  busy: '원격 셸이 다른 작업을 처리 중입니다.',
};

module.exports = {
  /** `user@host` of the connected server (what the user typed), or '' */
  remoteLabel() {
    return this.remote && this.remoteInfo ? this.remoteInfo.label : '';
  },

  /**
   * Turn remote mode on (probing the far side first) or off.
   * @returns {Promise<{ok: boolean, remote: boolean, info?: object, reason?: string}>}
   */
  async setRemote(on, { target, signal } = {}) {
    if (!on) {
      const was = this.remote;
      this.remote = false;
      this.remoteInfo = null;
      this.remoteCwd = '';
      if (was) this.emitEv({ type: 'remote', on: false });
      return { ok: true, remote: false };
    }
    const p = await this._probeRemote({ target, signal });
    if (!p.ok) return { ok: false, remote: this.remote, reason: p.reason };
    this.remote = true;
    this._quiet = null;
    this.remoteInfo = p.info;
    this.remoteCwd = p.info.cwd;
    this.emitEv({ type: 'remote', on: true, info: this.publicRemoteInfo() });
    this._audit({ kind: 'remote', subject: p.info.label, decision: 'on', reasons: [`${p.info.os} ${p.info.arch} · ${p.info.shell}`] });
    return { ok: true, remote: true, info: this.publicRemoteInfo() };
  },

  /** What the UI may know about the far side (no key paths, nothing secret). */
  publicRemoteInfo() {
    const i = this.remoteInfo;
    return i ? { label: i.label, id: i.id, user: i.user, host: i.host, os: i.os, arch: i.arch, shell: i.shell, kind: i.kind, cwd: i.cwd, home: i.home } : null;
  },

  async _probeRemote({ target, signal } = {}) {
    const s = this.session;
    if (s.state !== 'busy') return { ok: false, reason: '열린 SSH(또는 중첩 셸) 세션이 없습니다. 먼저 터미널에서 ssh 로 접속하세요.' };
    const sh = await s.probeLoginShell({ signal });
    if (sh.status !== 'done') {
      return { ok: false, reason: STATUS_TEXT[sh.status] || (sh.status === 'timeout' ? '원격 셸이 응답하지 않습니다. 로그인이 끝나 프롬프트가 보일 때 다시 시도하세요.' : '원격 셸을 확인하지 못했습니다.') };
    }
    const kind = ssh.shellKind(sh.shell);
    if (kind === 'unknown') return { ok: false, reason: `이 원격 셸(${path.basename(sh.shell)})은 지원하지 않습니다. bash / zsh / sh / fish / csh 로 전환한 뒤 시도하세요.` };
    const r = await s.runSentinel(ssh.probeCommand(kind), { kind, maxMs: 15000, signal });
    if (r.status !== 'done') return { ok: false, reason: STATUS_TEXT[r.status] || '원격 정보를 읽지 못했습니다.' };
    const pr = ssh.parseProbe(r.output);
    if (!pr) return { ok: false, reason: '원격 정보를 해석하지 못했습니다. 원격 셸이 프롬프트 상태인지 확인하세요.' };
    const label = target && target.label ? target.label : `${pr.user}@${pr.host}`;
    return { ok: true, info: { label, id: (target && target.id) || label, hostname: pr.host, user: pr.user, host: pr.host, os: pr.os, arch: pr.arch, shell: pr.shell || path.basename(sh.shell), kind, home: pr.home, cwd: r.cwd || pr.cwd } };
  },

  /** The connection is gone: leave remote mode and tell the user why. */
  _remoteLost(reason) {
    if (!this.remote) return;
    const label = this.remoteLabel();
    this.remote = false;
    this.remoteInfo = null;
    this.remoteCwd = '';
    this._audit({ kind: 'remote', subject: label, decision: 'off', reasons: [reason || '연결 종료'] });
    this.emitEv({ type: 'remote', on: false, reason: reason || '' });
    this.emitEv({ type: 'note', text: `원격 모드를 껐습니다: ${reason || 'SSH 연결이 끝났습니다'} (${label})` });
  },

  /** The description of the far side that goes into the prompt in place of the local project context. */
  remoteContext() {
    const i = this.remoteInfo;
    if (!i) return '';
    return [
      `[원격 SSH 세션] 사용자가 터미널에서 연 ${i.label} (${i.os} ${i.arch}, ${i.shell}) 안에서 일합니다. 이 Mac(로컬)의 파일·환경은 여기에 해당하지 않습니다.`,
      `[원격 환경] user=${i.user} host=${i.hostname} home=${i.home} cwd=${i.cwd || i.home}`,
      'run / read_file / edit_file / write_file / search 는 모두 이 원격 서버에 적용됩니다(경로도 원격 경로, 상대 경로는 위 cwd 기준).',
      '원격 서버는 로컬보다 위험합니다: 읽기 전용 명령으로 먼저 확인하고 꼭 필요한 변경만 하세요. 변경 명령과 파일 쓰기는 앱이 사용자 승인을 받습니다.',
      '로컬 Mac 과 원격 사이의 파일 전송(scp 등)은 할 수 없으니 필요하면 done 에서 사용자에게 안내하세요. 비밀번호·키·토큰은 묻거나 출력하지 마세요.',
    ].join('\n');
  },

  /**
   * A quiet route for the file tools: the tab's own ssh connection (key login or the shared connection of the session menu),
   * so nothing is typed into the terminal the user is looking at and a program running there (vim, top …) does not block it.
   * It is used only after it proved to reach the SAME account as the terminal (nested ssh or an `su` would make them differ);
   * otherwise — or when it cannot log in without a prompt — the tools go through the terminal as before.
   */
  async _quietRoute(signal) {
    const link = this.linkProvider ? this.linkProvider() : null;
    const i = this.remoteInfo;
    if (!link || !i) return null;
    if (this._quiet && this._quiet.link === link && this._quiet.id === i.id) return this._quiet.ok ? link : null;
    let ok = false;
    try {
      const r = await link.exec(ssh.probeCommand(i.kind), { timeoutMs: 12000, signal });
      const pr = r.code === 0 ? ssh.parseProbe(r.stdout) : null;
      ok = !!pr && pr.user === i.user && pr.host === i.host && pr.home === i.home && pr.os === i.os;
    } catch { ok = false; }
    this._quiet = { link, id: i.id, ok };
    return ok ? link : null;
  },

  async _viaLink(link, cmd, stdin, o, signal) {
    const r = await link.exec(cmd, { stdin, timeoutMs: o.maxMs || 30000, signal, maxBuffer: 4 << 20 });
    if (signal && signal.aborted) return { status: 'aborted', exitCode: null, output: '' };
    if (r.code === 255) { // ssh itself failed (needs a prompt, network …): the terminal route still works
      this._quiet = { link, id: this.remoteInfo && this.remoteInfo.id, ok: false };
      return null;
    }
    return { status: 'done', exitCode: r.code, output: r.stdout };
  },

  _remoteFs(signal) {
    const i = this.remoteInfo;
    const s = this.session;
    const kind = i.kind;
    return new RemoteFS(
      {
        run: async (cmd, o = {}) => {
          const q = await this._quietRoute(signal);
          const r = q ? await this._viaLink(q, cmd, undefined, o, signal) : null;
          return r || s.runSentinel(cmd, { kind, signal, ...o });
        },
        upload: async (dest, lines, o = {}) => {
          const q = await this._quietRoute(signal);
          const r = q ? await this._viaLink(q, `cat > ${dest}`, lines.join('\n') + '\n', o, signal) : null;
          return r || s.uploadToRemote(dest, lines, { signal, ...o });
        },
      },
      { home: i.home, getCwd: () => i.cwd || i.home, posix: kind === 'posix' }
    );
  },

  _remoteGone(status) {
    if (status === 'disconnected') this._remoteLost('연결이 끊어졌습니다');
  },

  async _remoteTool(decision, signal, log) {
    switch (decision.action) {
      case 'read_file': return this._remoteRead(decision.path, decision.start_line, decision.end_line, signal);
      case 'search': return this._remoteSearch(decision.content, decision.path, signal);
      case 'edit_file': return this._remoteEdit(decision.path, decision.old_text, decision.new_text, signal, log);
      default: return this._remoteWrite(decision.path, decision.content, signal, log);
    }
  },

  async _remoteRead(p, startLine, endLine, signal) {
    const rfs = this._remoteFs(signal);
    const label = this.remoteLabel();
    if (!p) return { kind: 'read', path: p, error: 'path 가 비어 있습니다.' };
    const abs = rfs.resolve(p);
    const shown = `${label}:${abs}`;
    this.emitEv({ type: 'file-read', path: shown + (startLine ? `:${startLine}${endLine ? '-' + endLine : ''}` : '') });
    if (isSecretPath(abs)) return { kind: 'read', path: shown, error: '비밀정보가 들어 있을 수 있는 파일이라 읽지 않습니다.' };
    const r = await rfs.read(abs, startLine, endLine, { signal });
    if (r.error) {
      this._remoteGone(/끊어졌/.test(r.error) ? 'disconnected' : '');
      return { kind: 'read', path: shown, error: r.error };
    }
    const head = startLine ? `(줄 ${r.from}-${r.to} / 총 ${r.totalLines}줄)\n` : '';
    return { kind: 'read', path: shown, content: head + truncateMiddle(maskSecrets(r.content), 7000) };
  },

  async _remoteSearch(pattern, dir, signal) {
    const rfs = this._remoteFs(signal);
    if (!pattern) return { kind: 'search', pattern, error: 'content(검색 패턴)가 필요합니다.' };
    const abs = rfs.resolve(dir || '.');
    const r = await rfs.search(pattern, abs, { signal });
    if (r.error) {
      this._remoteGone(/끊어졌/.test(r.error) ? 'disconnected' : '');
      return { kind: 'search', pattern, error: r.error };
    }
    return { kind: 'search', pattern, count: r.count, content: truncateMiddle(maskSecrets(r.content || '(일치 없음)'), 3500) };
  },

  async _remoteEdit(p, oldText, newText, signal, log) {
    if (!p || oldText === null || oldText === undefined || newText === null || newText === undefined) return { kind: 'edit', path: p, error: 'path, old_text, new_text 가 모두 필요합니다.' };
    if (oldText === '') return { kind: 'edit', path: p, error: 'old_text 가 비어 있습니다. 새 파일은 write_file 을 쓰세요.' };
    const rfs = this._remoteFs(signal);
    const abs = rfs.resolve(p);
    const shown = `${this.remoteLabel()}:${abs}`;
    const r = await rfs.read(abs, 0, 0, { signal });
    if (r.error) {
      this._remoteGone(/끊어졌/.test(r.error) ? 'disconnected' : '');
      return { kind: 'edit', path: shown, error: `파일을 읽을 수 없습니다(${r.error}) 없는 파일이면 write_file 로 만드세요.` };
    }
    const cur = r.exact;
    // editing works on text we received through a terminal: only proceed when it is byte-identical to the file
    const h = await rfs.hash(abs, { signal });
    if (h.error || h.hash !== sha256(cur)) return { kind: 'edit', path: shown, error: '이 파일에는 제어문자나 인코딩이 다른 부분이 있어 안전하게 수정할 수 없습니다. run 의 sed 등으로 직접 처리하거나 사용자에게 안내하세요.' };
    const first = cur.indexOf(oldText);
    if (first < 0) return { kind: 'edit', path: shown, error: 'old_text 를 파일에서 찾지 못했습니다. read_file 로 현재 내용을 다시 읽고 들여쓰기·공백까지 그대로 복사하세요.' };
    if (cur.indexOf(oldText, first + 1) >= 0) return { kind: 'edit', path: shown, error: 'old_text 가 여러 곳에 일치합니다. 앞뒤 줄을 더 포함해 한 곳만 일치하도록 하세요.' };
    const res = await this._remoteWrite(p, cur.slice(0, first) + newText + cur.slice(first + oldText.length), signal, log, { known: cur });
    return { ...res, kind: 'edit' };
  },

  async _remoteWrite(p, content, signal, log, { known } = {}) {
    if (!p || content === null || content === undefined) return { kind: 'write', path: p, error: 'path 와 content 가 필요합니다.' };
    const rfs = this._remoteFs(signal);
    const label = this.remoteLabel();
    const abs = rfs.resolve(p);
    const shown = `${label}:${abs}`;
    if (isSecretPath(abs)) return { kind: 'write', path: shown, error: '비밀정보 파일에는 쓰지 않습니다.' };
    if (/(^|\/)\.git(\/|$)/.test(abs)) return { kind: 'write', path: shown, error: '.git 내부는 수정하지 않습니다.' };
    if (Buffer.byteLength(content) > MAX_WRITE) return { kind: 'write', path: shown, error: '내용이 너무 큽니다(200KB 초과).' };
    if (this.permission === 'readonly') return { kind: 'write', path: shown, error: '읽기 전용 모드에서는 파일을 수정하지 않습니다 (권한 모드를 바꾸면 허용됩니다).' };
    if (rfs.posix === false) return { kind: 'write', path: shown, error: '이 원격 셸(fish/csh)에서는 파일 쓰기를 지원하지 않습니다. run 으로 명령을 쓰세요.' };

    // the current content: for the diff, and to be able to undo
    let old = known === undefined ? null : known;
    if (known === undefined) {
      const st = await rfs.stat(abs, { signal });
      if (st.error) {
        this._remoteGone(/끊어졌/.test(st.error) ? 'disconnected' : '');
        return { kind: 'write', path: shown, error: st.error };
      }
      if (st.kind === 'dir') return { kind: 'write', path: shown, error: '디렉터리입니다.' };
      if (st.kind === 'file') {
        if (!st.text) return { kind: 'write', path: shown, error: '바이너리 파일은 덮어쓰지 않습니다.' };
        const cur = await rfs.read(abs, 0, 0, { signal });
        if (cur.error) return { kind: 'write', path: shown, error: `기존 내용을 읽지 못해 쓰지 않았습니다: ${cur.error}` };
        const h = await rfs.hash(abs, { signal });
        if (h.error || h.hash !== sha256(cur.exact)) return { kind: 'write', path: shown, error: '기존 파일에 제어문자나 인코딩이 다른 부분이 있어 안전하게 덮어쓸 수 없습니다.' };
        old = cur.exact;
      }
    }
    const diff = this._diff(old, content);
    if (this.permission !== 'trust') {
      const cwd = this.session.cwd; // the grant is bound to the local session's cwd, the display shows the remote one
      const reason = `원격 서버(${label})의 파일 ${old === null ? '생성' : '수정'}: ${abs}`;
      const ap = await this._askApproval('file', `${shown}\n${content}`, cwd, [reason], signal, { path: shown, diff, remote: label, cwd: `${label}:${(this.remoteInfo && this.remoteInfo.cwd) || ''}` });
      if (!ap.approved) return { kind: 'write', path: shown, error: ap.aborted ? '중단됨' : `사용자가 파일 쓰기를 거부했습니다.${ap.feedback ? ` 사용자 의견: "${ap.feedback}"` : ''}` };
    }
    const w = await rfs.write(abs, content, { signal });
    if (w.error) {
      this._remoteGone(/끊어졌/.test(w.error) ? 'disconnected' : '');
      return { kind: 'write', path: shown, error: `원격 쓰기 실패: ${w.error}` };
    }
    // a local copy of what was there, like the backups of local edits
    let backup = null;
    try {
      if (old !== null) {
        const bdir = path.join(this.dataDir, 'backups');
        fs.mkdirSync(bdir, { recursive: true });
        backup = path.join(bdir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${label.replace(/[^A-Za-z0-9._-]/g, '_')}-${path.basename(abs)}`);
        fs.writeFileSync(backup, old);
      }
    } catch { backup = null; }
    log.files.push(shown);
    this._audit({ kind: 'file', subject: shown, decision: 'done', reasons: [old === null ? '원격 새 파일 생성' : '원격 파일 수정'], host: label });
    const undoId = `u${++this.seq}`;
    this.undo.set(undoId, { remote: label, abs, old, backup, written: content, hash: w.hash });
    this.emitEv({ type: 'file-write', path: shown, created: old === null, diff, undoId, remote: label });
    return { kind: 'write', path: shown, ok: true, summary: old === null ? '원격에 새 파일 생성' : `원격 파일 수정됨 (+${diff.added}/-${diff.removed}줄), 원본은 앱 백업 폴더에 보관` };
  },

  /** Undo of a remote change: only when the file on the server is still exactly what we wrote. */
  async _remoteUndo(undoId, u) {
    if (!this.remote || !this.remoteInfo || this.remoteInfo.label !== u.remote) return { ok: false, message: `${u.remote} 에 연결되어 있지 않아 되돌릴 수 없습니다. 다시 접속한 뒤 시도하세요.` };
    const rfs = this._remoteFs(this.abortCtl ? this.abortCtl.signal : undefined);
    const h = await rfs.hash(u.abs);
    if (h.error) return { ok: false, message: `되돌리기 실패: ${h.error}` };
    if (h.hash !== u.hash) return { ok: false, message: '그 뒤에 파일이 다시 바뀌어서 자동으로 되돌리지 않았습니다.' };
    if (u.old !== null) {
      const w = await rfs.write(u.abs, u.old);
      if (w.error) return { ok: false, message: `되돌리기 실패: ${w.error}` };
    } else {
      const r = await this.session.runSentinel(`rm -f -- '${u.abs}'`, { kind: this.remoteInfo.kind });
      if (r.status !== 'done' || r.exitCode !== 0) return { ok: false, message: '새로 만든 원격 파일을 삭제하지 못했습니다.' };
    }
    this.undo.delete(undoId);
    return { ok: true, message: u.old !== null ? '이전 내용으로 되돌렸습니다.' : '새로 만든 원격 파일을 삭제했습니다.' };
  },
};
