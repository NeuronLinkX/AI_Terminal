'use strict';
// Execution policy: classify a shell command as allow / approve / deny BEFORE it is typed into the shell.
//  allow   - read-only investigation and ordinary development work
//  approve - high impact (bulk delete, sudo, forced git, external transmission, system config...): needs user OK
//  deny    - never run through the AI (catastrophic, or must be done by the user: passwords, interactive editors)
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { isSecretPath } = require('./text');

const LEVEL = { allow: 0, approve: 1, deny: 2 };
const SAFE_WRITE_DIRS = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders', '/dev/null', '/dev/stdout', '/dev/stderr', os.tmpdir()];

function splitSegments(cmd) {
  const segs = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      cur += c;
      if (q === '"' && c === '\\') cur += cmd[++i] || '';
      else if (c === q) q = null;
      continue;
    }
    if (c === '\\') {
      cur += c + (cmd[++i] || '');
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      cur += c;
      continue;
    }
    if (c === ';' || c === '\n' || c === '|' || c === '&') {
      if (c === '&' && (cmd[i - 1] === '>' || cmd[i - 1] === '<' || cmd[i + 1] === '>')) {
        cur += c;
        continue;
      }
      segs.push(cur);
      cur = '';
      if ((c === '|' || c === '&') && cmd[i + 1] === c) i++;
      continue;
    }
    cur += c;
  }
  segs.push(cur);
  return segs.map((s) => s.trim()).filter(Boolean);
}

function tokenize(seg) {
  const toks = [];
  let cur = '';
  let q = null;
  let has = false;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (q) {
      if (c === q) q = null;
      else if (q === '"' && c === '\\' && i + 1 < seg.length) cur += seg[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      has = true;
      continue;
    }
    if (c === '\\' && i + 1 < seg.length) {
      cur += seg[++i];
      has = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (has || cur) toks.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += c;
    has = true;
  }
  if (has || cur) toks.push(cur);
  return toks;
}

let HOME_OVERRIDE = null; // set by assessCommand while it works on a command that will run on another machine
const homeDir = () => HOME_OVERRIDE || os.homedir();

function expandPath(p, cwd) {
  if (!p) return null;
  let s = p;
  if (s === '~' || s.startsWith('~/')) s = path.join(homeDir(), s.slice(1));
  s = s.replace(/^\$HOME(?=\/|$)|^\$\{HOME\}(?=\/|$)/, homeDir());
  if (/\$|`/.test(s)) return null; // unknown expansion
  return path.resolve(cwd, s);
}

function isInside(abs, dir) {
  return abs === dir || abs.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}

function outsideWorkspace(arg, cwd) {
  const abs = expandPath(arg, cwd);
  if (abs === null) return true;
  if (isInside(abs, cwd)) return false;
  return !SAFE_WRITE_DIRS.some((d) => d && isInside(abs, d));
}

const WRAPPERS = new Set(['env', 'command', 'nohup', 'time', 'exec', 'nice', 'builtin', 'stdbuf', 'caffeinate', 'timeout', 'gtimeout']);
const INTERACTIVE = new Set(['vim', 'vi', 'nvim', 'nano', 'emacs', 'pico', 'less', 'more', 'man', 'top', 'htop', 'btop', 'screen', 'tmux', 'ftp', 'telnet']);
const PASSWORD_TOOLS = new Set(['passwd', 'chsh', 'chpass', 'kinit', 'login']);
const WRITE_CMDS = new Set(['rm', 'rmdir', 'mv', 'cp', 'ln', 'mkdir', 'touch', 'chmod', 'chown', 'chgrp', 'tee', 'truncate', 'install', 'ditto', 'rsync', 'unlink', 'shred']);
const SYSTEM_APPROVE = new Set(['shutdown', 'reboot', 'halt', 'launchctl', 'defaults', 'networksetup', 'scutil', 'pmset', 'systemsetup', 'dscl', 'tmutil', 'security', 'spctl', 'osascript', 'sysctl', 'nvram', 'kextload', 'pfctl', 'killall', 'pkill', 'kill', 'crontab', 'at']);
const NET_SEND = new Set(['scp', 'sftp', 'nc', 'ncat', 'netcat', 'socat', 'ssh', 'mosh', 'rsync']);

function add(findings, level, reason) {
  findings.push({ level, reason });
}

const NET_PROGS = new Set(['curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'netcat', 'telnet', 'ftp', 'ping', 'dig', 'nslookup', 'traceroute', 'mosh', 'socat', 'httpie', 'http', 'aria2c', 'brew', 'pip', 'pip3', 'pipx', 'gem', 'cargo', 'go', 'docker', 'gh']);
const NET_SUBCMDS = { git: ['push', 'pull', 'fetch', 'clone', 'remote', 'ls-remote', 'submodule'], npm: ['install', 'i', 'ci', 'update', 'up', 'publish', 'view', 'search', 'audit'], pnpm: ['install', 'i', 'add', 'update', 'publish'], yarn: ['install', 'add', 'upgrade', 'publish'], cargo: ['install', 'update', 'publish', 'fetch', 'search'], go: ['get', 'install', 'mod'] };

/** "Block network" mode: commands that talk to the network are refused outright (deny, not approve). */
function networkReason(tokens) {
  const prog = path.basename(tokens[0] || '');
  const sub = tokens.slice(1).find((t) => !t.startsWith('-')) || '';
  if (NET_SUBCMDS[prog]) return NET_SUBCMDS[prog].includes(sub) ? `${prog} ${sub}` : null;
  if (NET_PROGS.has(prog)) return prog;
  return null;
}

function assessTokens(tokensIn, raw, cwd, findings, depth, opts = {}) {
  let tokens = tokensIn.slice();
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
  while (tokens.length && WRAPPERS.has(tokens[0])) {
    const w = tokens.shift();
    if (w === 'timeout' || w === 'gtimeout') tokens.shift();
    while (tokens.length && (tokens[0].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]))) tokens.shift();
  }
  if (!tokens.length) return;
  let cmd = path.basename(tokens[0]);
  const args = tokens.slice(1);
  const flags = args.filter((a) => a.startsWith('-')).join(' ');
  const operands = args.filter((a) => !a.startsWith('-'));

  if (opts.blockNetwork) {
    const net = networkReason([cmd, ...args]);
    if (net) return add(findings, 'deny', `네트워크 차단 모드: ${net} 은(는) 외부 네트워크를 사용하므로 실행하지 않습니다 (설정에서 해제할 수 있습니다)`);
  }
  if (cmd === 'sudo' || cmd === 'doas' || cmd === 'su') {
    add(findings, 'approve', '관리자 권한(sudo/su) 사용');
    if (cmd !== 'su') assessTokens(args.filter((a, i) => !(a.startsWith('-') && i === 0)), raw, cwd, findings, depth, opts);
    return;
  }
  if (PASSWORD_TOOLS.has(cmd)) return add(findings, 'deny', `${cmd}: 비밀번호 입력이 필요한 작업은 터미널에서 직접 실행하세요`);
  if (INTERACTIVE.has(cmd)) return add(findings, 'deny', `${cmd}: 대화형 프로그램은 AI가 실행하지 않습니다 (터미널에서 직접 실행하세요)`);
  if (/^(mkfs(\..+)?|newfs.*|fdisk|csrutil)$/.test(cmd)) return add(findings, 'deny', `${cmd}: 디스크/보안 설정을 파괴할 수 있어 차단됨`);
  if (cmd === 'diskutil' && /\b(erase|partition|apfs\s+delete|secureErase|zeroDisk|randomDisk)/i.test(args.join(' '))) return add(findings, 'deny', 'diskutil: 디스크 삭제/파티션 작업은 차단됨');
  if (cmd === 'dd' && args.some((a) => /^of=\/dev\//.test(a))) return add(findings, 'deny', 'dd: 장치에 직접 쓰기는 차단됨');

  if (['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(cmd) || cmd === 'eval') {
    const ci = args.indexOf('-c');
    const inner = cmd === 'eval' ? args.join(' ') : ci >= 0 ? args[ci + 1] : null;
    if (inner && depth < 3) {
      const sub = assessCommand(inner, cwd, depth + 1, opts);
      sub.reasons.forEach((r) => add(findings, sub.level, r));
    } else if (cmd !== 'eval' && ci < 0 && args.length === 0) add(findings, 'deny', `${cmd}: 대화형 셸은 AI가 실행하지 않습니다`);
    else if (ci < 0 && args[0]) add(findings, 'approve', `스크립트 실행(${args[0]}): 내용 확인 필요`);
    return;
  }
  if (cmd === 'xargs') {
    const rest = args.filter((a, i, arr) => !(a.startsWith('-') && (i === 0 || arr[i - 1].startsWith('-'))));
    if (rest.length) assessTokens(rest, raw, cwd, findings, depth, opts);
    return;
  }
  if (['python', 'python3', 'node', 'ruby', 'perl', 'irb', 'ipython', 'lua', 'php'].includes(cmd) && args.length === 0) {
    return add(findings, 'deny', `${cmd}: 대화형 REPL은 AI가 실행하지 않습니다`);
  }

  if (cmd === 'rm' || cmd === 'rmdir' || cmd === 'unlink' || cmd === 'shred' || cmd === 'trash') {
    const catastrophic = operands.some((o) => ['/', '~', '~/', '$HOME', '/*', '~/*', '$HOME/*', '.', '..', '*'].includes(o) || /^\/(usr|bin|sbin|etc|System|Library|Applications|Users|private|var|opt)\/?$/.test(o));
    if (catastrophic && /r|R|f/.test(flags.replace(/-/g, ''))) return add(findings, 'deny', `${cmd} ${flags}: 광범위/시스템 경로 삭제는 차단됨`);
    return add(findings, 'approve', `파일 삭제(${cmd}${flags ? ' ' + flags : ''}), 대상: ${operands.join(' ') || '(없음)'}`);
  }
  if (cmd === 'find' && /(^|\s)(-delete|-exec\s+rm|-execdir\s+rm)/.test(args.join(' '))) return add(findings, 'approve', 'find로 파일 일괄 삭제');
  if (cmd === 'git') {
    const sub = args.find((a) => !a.startsWith('-')) || '';
    const rest = args.join(' ');
    if (sub === 'push') add(findings, 'approve', 'git push: 외부 저장소로 전송');
    if (/(^|\s)(--force|--force-with-lease|-f)(\s|$)/.test(rest) && ['push', 'checkout', 'branch', 'clean', 'tag', 'worktree'].includes(sub)) add(findings, 'approve', `git ${sub} 강제 옵션`);
    if (sub === 'reset' && /--hard|--merge|--keep/.test(rest)) add(findings, 'approve', 'git reset --hard: 작업 내용 폐기');
    if (sub === 'clean') add(findings, 'approve', 'git clean: 추적되지 않는 파일 삭제');
    if (sub === 'checkout' && /(^|\s)(--\s|\.\s*$|\.$)/.test(rest)) add(findings, 'approve', 'git checkout: 변경 사항 폐기');
    if (sub === 'restore' && !/--staged/.test(rest)) add(findings, 'approve', 'git restore: 변경 사항 폐기');
    if (sub === 'branch' && /(^|\s)-D(\s|$)/.test(rest)) add(findings, 'approve', 'git branch -D: 브랜치 강제 삭제');
    if (['rebase', 'filter-branch', 'filter-repo'].includes(sub)) add(findings, 'approve', `git ${sub}: 히스토리 재작성`);
    if (sub === 'stash' && /\b(drop|clear)\b/.test(rest)) add(findings, 'approve', 'git stash 삭제');
    if ((sub === 'reflog' && /expire/.test(rest)) || (sub === 'gc' && /prune/.test(rest))) add(findings, 'approve', 'git 객체 영구 삭제');
    if (sub === 'remote' && /\b(add|set-url)\b/.test(rest)) add(findings, 'approve', 'git remote 변경');
    return;
  }
  if (cmd === 'curl' || cmd === 'wget') {
    const a = args.join(' ');
    if (/(^|\s)(-d|--data[a-z-]*|-F|--form[a-z-]*|-T|--upload-file|--post[a-z0-9-]*)(\s|=|$)/.test(a) || /(^|\s)-X\s*(POST|PUT|DELETE|PATCH)/i.test(a) || /--method[ =](POST|PUT|DELETE|PATCH)/i.test(a)) {
      add(findings, 'approve', `${cmd}: 외부로 데이터 전송`);
    }
    return;
  }
  if (cmd === 'npm' || cmd === 'pnpm' || cmd === 'yarn') {
    const sub = args.find((a) => !a.startsWith('-')) || '';
    if (['publish', 'login', 'adduser', 'logout', 'token', 'unpublish', 'deprecate', 'owner'].includes(sub)) add(findings, 'approve', `${cmd} ${sub}: 외부 레지스트리/인증 변경`);
    if (/^(i|install|add|remove|uninstall|rm|update|up|link)$/.test(sub) && /(^|\s)(-g|--global)(\s|$)/.test(args.join(' '))) add(findings, 'approve', `${cmd} 전역 패키지 변경`);
    return;
  }
  if (cmd === 'brew' && /^(install|uninstall|remove|reinstall|upgrade|tap|untap|cleanup|services)$/.test(args[0] || '')) return add(findings, 'approve', `brew ${args[0]}: 시스템 패키지 변경`);
  if ((cmd === 'pip' || cmd === 'pip3') && /^(uninstall)$/.test(args[0] || '')) return add(findings, 'approve', 'pip uninstall');
  if (cmd === 'twine' || cmd === 'cargo' && args[0] === 'publish') return add(findings, 'approve', '패키지 배포');
  if (cmd === 'docker' && /^(push|login|system|rm|rmi|volume|prune)/.test(args[0] || '')) return add(findings, 'approve', `docker ${args[0]}`);
  if (cmd === 'gh') {
    if (/^(pr|issue|release|repo|gist|workflow|secret|auth|api)$/.test(args[0] || '') && !/^(list|view|status|diff|checks)$/.test(args[1] || '')) return add(findings, 'approve', `gh ${args.slice(0, 2).join(' ')}: GitHub로 전송/변경`);
    return;
  }
  if (cmd === 'chmod' || cmd === 'chown' || cmd === 'chgrp') {
    if (/(^|\s)-[A-Za-z]*R/.test(flags) || operands.slice(1).some((o) => outsideWorkspace(o, cwd))) add(findings, 'approve', `${cmd}: 재귀 변경 또는 작업 디렉터리 밖 권한 변경`);
    return;
  }
  if (NET_SEND.has(cmd)) {
    if (cmd === 'rsync' && !args.some((a) => /^[^/\s]+:/.test(a) && !a.startsWith('-'))) {
      /* local rsync handled below by write-outside check */
    } else return add(findings, 'approve', `${cmd}: 원격 호스트 접속/전송`);
  }
  if (SYSTEM_APPROVE.has(cmd)) {
    if (cmd === 'defaults' && /^(read|domains|find|export)/.test(args[0] || '')) return;
    if (cmd === 'kill' && args.includes('-l')) return;
    if (cmd === 'security' || cmd === 'osascript') return add(findings, 'approve', `${cmd}: 키체인/UI 제어 접근`);
    return add(findings, 'approve', `${cmd}: 시스템 설정 또는 프로세스에 영향`);
  }
  if (cmd === 'sed' && /(^|\s)-i/.test(flags + ' ' + args.join(' '))) {
    const files = operands.slice(1);
    if (files.some((f) => outsideWorkspace(f, cwd))) add(findings, 'approve', 'sed -i: 작업 디렉터리 밖 파일 수정');
  }
  if (WRITE_CMDS.has(cmd)) {
    const targets = cmd === 'chmod' ? operands.slice(1) : operands;
    const bad = targets.filter((t) => outsideWorkspace(t, cwd));
    if (bad.length) add(findings, 'approve', `${cmd}: 작업 디렉터리 밖 경로 변경 (${bad.slice(0, 3).join(', ')})`);
  }
  // reading/using secret-bearing files
  const secretOps = operands.filter((o) => isSecretPath(o) || isSecretPath(expandPath(o, cwd) || ''));
  if (secretOps.length) add(findings, 'approve', `비밀정보 파일 접근 (${secretOps.slice(0, 3).join(', ')})`);
}

/** opts.home: the home directory of the machine the command will run on (default: this Mac) */
function assessCommand(command, cwd, depth = 0, opts = {}) {
  const prev = HOME_OVERRIDE;
  if (opts.home) HOME_OVERRIDE = opts.home;
  try {
    return assessCommandHere(command, cwd, depth, opts);
  } finally {
    HOME_OVERRIDE = prev;
  }
}

function assessCommandHere(command, cwd, depth = 0, opts = {}) {
  const findings = [];
  const cmd = String(command || '');
  if (!cmd.trim()) return { level: 'deny', reasons: ['빈 명령'], hash: hashCommand(cmd, cwd) };
  if (cmd.includes('\n')) add(findings, 'deny', '여러 줄 명령은 지원하지 않습니다. 한 줄 명령(;, &&)으로 작성하세요');
  if (cmd.length > 2000) add(findings, 'deny', '명령이 너무 깁니다 (2000자 초과)');
  if (/:\(\)\s*\{\s*:\|:&\s*\};:/.test(cmd)) add(findings, 'deny', '포크 폭탄 패턴');

  if (/\b(curl|wget)\b[^;&]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/.test(cmd) || /\b(curl|wget)\b[^;&]*\|\s*(sudo\s+)?(python3?|node|ruby|perl)\b/.test(cmd)) {
    add(findings, 'approve', '원격 스크립트를 내려받아 바로 실행(curl | sh)');
  }
  // redirections
  const redirRe = /(?:^|[\s\d])>>?\s*([^\s<>|&;]+)/g;
  let m;
  while ((m = redirRe.exec(cmd))) {
    const target = m[1].replace(/^["']|["']$/g, '');
    if (target.startsWith('&')) continue;
    if (isSecretPath(target)) add(findings, 'approve', `비밀정보 파일에 쓰기 (${target})`);
    else if (outsideWorkspace(target, cwd)) add(findings, 'approve', `작업 디렉터리 밖 파일에 리다이렉트 (${target})`);
  }
  // substitutions
  if (depth < 3) {
    for (const re of [/\$\(([^()]*)\)/g, /`([^`]*)`/g, /[<>]\(([^()]*)\)/g]) {
      let sm;
      while ((sm = re.exec(cmd))) {
        const sub = assessCommand(sm[1], cwd, depth + 1, opts);
        sub.reasons.forEach((r) => add(findings, sub.level, r));
      }
    }
  }
  if (/(^|[;&|\s])(export\s+|typeset\s+|declare\s+)?(PS1|PS2|PROMPT|RPROMPT|RPS1)\s*=/.test(cmd)) add(findings, 'approve', '셸 프롬프트(PS1/PROMPT) 변경');
  for (const seg of splitSegments(cmd)) assessTokens(tokenize(seg), seg, cwd, findings, depth, opts);

  let level = 'allow';
  for (const f of findings) if (LEVEL[f.level] > LEVEL[level]) level = f.level;
  const reasons = [...new Set(findings.map((f) => f.reason))];
  return { level, reasons, hash: hashCommand(cmd, cwd) };
}

function hashCommand(command, cwd) {
  return crypto.createHash('sha256').update(`${cwd}\0${command}`).digest('hex');
}

/** Approvals are single-use and bound to the exact command text + cwd. */
class ApprovalGate {
  constructor() {
    this.pending = new Map();
    this.granted = new Map(); // id -> hash
    this.seq = 0;
  }
  request(kind, subject, cwd) {
    const id = `ap${++this.seq}`;
    const hash = hashCommand(`${kind}:${subject}`, cwd);
    return {
      id,
      hash,
      promise: new Promise((resolve) => this.pending.set(id, { resolve, hash })),
    };
  }
  answer(id, approved, extra) {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    this.extras = this.extras || new Map();
    if (extra) this.extras.set(id, extra);
    if (approved) this.granted.set(id, p.hash);
    p.resolve(!!approved);
    return true;
  }
  takeExtra(id) {
    const e = this.extras && this.extras.get(id);
    if (this.extras) this.extras.delete(id);
    return e || {};
  }
  /** True only if `id` was approved for exactly this kind/subject/cwd; consumes the grant. */
  consume(id, kind, subject, cwd) {
    const h = this.granted.get(id);
    this.granted.delete(id);
    return h !== undefined && h === hashCommand(`${kind}:${subject}`, cwd);
  }
  rejectAll() {
    for (const [id, p] of this.pending) {
      p.resolve(false);
      this.pending.delete(id);
    }
  }
}

// ---------- session allow-rules ("don't ask again") ----------
const SUBCMD_PROGS = new Set(['git', 'npm', 'pnpm', 'yarn', 'brew', 'docker', 'gh', 'cargo', 'pip', 'pip3', 'kubectl', 'launchctl']);
// destructive programs: "always" only remembers the exact command line, never the whole program
const EXACT_ONLY = new Set(['rm', 'rmdir', 'unlink', 'shred', 'kill', 'pkill', 'killall', 'mv', 'chmod', 'chown', 'chgrp', 'find', 'xargs', 'truncate', 'tee', 'ln']);
const NO_ALWAYS_REASON = /관리자|강제|원격 스크립트|히스토리 재작성|비밀정보|디스크|sudo/;

/** @returns {null | {key:string, label:string, exact:boolean}} null = "always allow" is not offered */
function ruleFor(command, reasons = []) {
  const cmd = String(command || '').trim();
  if (!cmd || reasons.some((r) => NO_ALWAYS_REASON.test(r))) return null;
  if (/[`$()<>|;&\n]/.test(cmd.replace(/2>&1|>\s*\/dev\/null/g, ''))) return null;
  const toks = tokenize(cmd).filter((t, i, a) => !(i < a.findIndex((x) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x))));
  if (!toks.length) return null;
  const prog = path.basename(toks[0]);
  if (['sudo', 'su', 'doas', 'sh', 'bash', 'zsh', 'eval', 'ssh'].includes(prog)) return null;
  if (EXACT_ONLY.has(prog)) return { key: `x:${cmd}`, label: cmd.length > 60 ? cmd.slice(0, 57) + '…' : cmd, exact: true };
  const sub = SUBCMD_PROGS.has(prog) ? toks.slice(1).find((t) => !t.startsWith('-')) : null;
  const label = sub ? `${prog} ${sub}` : prog;
  return { key: `p:${label}`, label: `${label} …`, exact: false };
}

function matchesRule(command, rules) {
  const cmd = String(command || '').trim();
  if (rules.has(`x:${cmd}`)) return true;
  const r = ruleFor(cmd);
  return !!(r && !r.exact && rules.has(r.key));
}

// ---------- read-only mode ----------
const READONLY_PROGS = new Set(['ls', 'find', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'pwd', 'echo', 'printf', 'which', 'whereis', 'type', 'file', 'stat', 'wc', 'sort', 'uniq', 'cut', 'tr', 'diff', 'du', 'df', 'ps', 'lsof', 'uname', 'whoami', 'id', 'date', 'env', 'printenv', 'hostname', 'sw_vers', 'tree', 'basename', 'dirname', 'realpath', 'readlink', 'jq', 'cd', 'true', 'false', 'test', '[', 'ping', 'dig', 'nslookup', 'netstat', 'ifconfig', 'top', 'uptime', 'ls-files', 'column', 'nl', 'md5', 'shasum', 'od', 'xxd', 'hexdump', 'git', 'node', 'python3', 'python', 'npm', 'cargo', 'rustc', 'gcc', 'g++', 'cc', 'clang']);
const READONLY_GIT = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'remote', 'branch', 'config', 'shortlog', 'reflog', 'tag', 'stash']);

// Server inspection commands, judged by their arguments: `systemctl status` reads, `systemctl restart` does not;
// `vmstat 1` never ends and would block the shell. Returns true / false, or undefined for programs not handled here.
const SYSTEMCTL_RO = new Set(['status', 'is-active', 'is-enabled', 'is-failed', 'list-units', 'list-unit-files', 'list-sockets', 'list-timers', 'list-dependencies', 'show', 'cat', 'get-default']);
const DOCKER_RO = new Set(['ps', 'images', 'logs', 'inspect', 'stats', 'top', 'version', 'info', 'port', 'history', 'diff']);
const DOCKER_OBJ = new Set(['container', 'image', 'volume', 'network', 'system', 'node', 'service']);
const DOCKER_OBJ_RO = new Set(['ls', 'list', 'inspect', 'ps', 'df', 'logs', 'top', 'stats', 'history', 'port']);
const KUBECTL_RO = new Set(['get', 'describe', 'logs', 'top', 'version', 'api-resources', 'api-versions', 'cluster-info', 'explain']);
const IP_OBJ = new Set(['a', 'addr', 'address', 'l', 'link', 'r', 'route', 'n', 'neigh', 'neighbor', 'rule', 'maddr', 'tunnel']);

function serverReadOnly(prog, args) {
  const flags = args.filter((a) => a.startsWith('-'));
  const pos = args.filter((a) => !a.startsWith('-'));
  const has = (re) => args.some((a) => re.test(a));
  const nums = pos.filter((a) => /^\d+$/.test(a)).length;
  switch (prog) {
    case 'free': return !has(/^(-s|--seconds)/) || has(/^(-c|--count)/);
    case 'vmstat': case 'iostat': case 'mpstat': return nums !== 1; // an interval without a count never ends
    case 'lscpu': case 'lsblk': case 'lsusb': case 'lspci': case 'lsmod': case 'lsb_release': case 'groups': case 'last': case 'locale':
    case 'nproc': case 'arch': case 'getconf': case 'who': case 'w': return true;
    case 'sensors': return !has(/^-s$|^--set$/);
    case 'hostname': return pos.length === 0 && args.every((a) => /^-(f|s|i|I|d|A|y|a|F)$|^--(fqdn|short|ip-address|all-ip-addresses|domain|alias)$/.test(a));
    case 'hostnamectl': return pos.length === 0 || pos[0] === 'status';
    case 'timedatectl': return pos.length === 0 || ['status', 'show', 'list-timezones', 'timesync-status', 'show-timesync'].includes(pos[0]);
    case 'date': return !has(/^(-s|--set)/) && args.every((a, i) => !(!a.startsWith('-') && !a.startsWith('+') && !/^(-d|--date|-r|--reference)$/.test(args[i - 1] || '')));
    case 'ifconfig': return args.length === 0 || (args.length === 1 && (args[0] === '-a' || (/^[A-Za-z0-9.:_-]+$/.test(args[0]) && !/^(up|down)$/.test(args[0]))));
    case 'ip': {
      const obj = pos[0];
      if (!IP_OBJ.has(obj)) return false;
      return !pos.some((a) => /^(add|del|delete|set|flush|change|replace|append|up|down|prepend|annotate)$/.test(a));
    }
    case 'ss': return !has(/^-[a-zA-Z]*K|^--kill/);
    case 'dmesg': return !has(/^(-c|-C|--clear|--read-clear|-D|--console-off|-E|--console-on|-n|--console-level|-w|--follow|-W|--follow-new)$/);
    case 'journalctl': return !has(/^(--vacuum-|--rotate|--flush|--sync|--relinquish|--smart-relinquish|--setup-keys|--update-catalog|-f$|--follow)/);
    case 'systemctl': return pos.length === 0 ? !flags.length || flags.every((f) => /^(--version|--no-pager|--failed|-a|--all|-t|--type|--state)/.test(f)) : SYSTEMCTL_RO.has(pos[0]);
    case 'docker': case 'podman': {
      if (has(/^(-f|--follow)$/) && pos[0] === 'logs') return false;
      if (pos[0] === 'stats') return args.includes('--no-stream');
      if (DOCKER_RO.has(pos[0])) return true;
      return DOCKER_OBJ.has(pos[0]) && DOCKER_OBJ_RO.has(pos[1]) && !(pos[0] === 'system' && pos[1] !== 'df');
    }
    case 'kubectl': return KUBECTL_RO.has(pos[0]) && !has(/^(-w|--watch|--watch-only|-f|--follow)$/) && !(pos[0] === 'get' && has(/^--watch/));
    case 'nvidia-smi': {
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (/^(-q|-L|-x|--query-gpu=.+|--query-compute-apps=.+|--query-accounted-apps=.+|--format=.+|--id=.+|--list-gpus|--xml-format)$/.test(a)) continue;
        if (a === '-i' || a === '--id') { if (/^[0-9A-Za-z,:_-]+$/.test(args[i + 1] || '')) { i++; continue; } return false; }
        return false; // anything else (-pm, -r, -pl, dmon, topo, -l …) changes the GPU or never ends
      }
      return true;
    }
    case 'rocm-smi': return args.every((a) => /^(--show[a-z]*|--json|-a|--alldevices)$/.test(a));
    case 'top': return (has(/^-[a-zA-Z]*b/) && has(/^-n\d*$/)) || (args.includes('-l') && /^\d+$/.test(args[args.indexOf('-l') + 1] || '')); // batch / logging mode with a count
    case 'sleep': return pos.length === 1 && /^\d+(\.\d+)?$/.test(pos[0]) && Number(pos[0]) <= 30;
    case 'tail': return has(/^(-[a-zA-Z]*[fF]|--follow)/) ? false : undefined; // following never ends
    default: return undefined;
  }
}

function isReadOnlyCommand(command) {
  const cmd = String(command || '').trim();
  if (!cmd || /[`]|\$\(|<\(/.test(cmd)) return false;
  const stripped = cmd.replace(/2>&1|\d?>\s*\/dev\/null|&>\s*\/dev\/null/g, '');
  if (/>/.test(stripped)) return false; // any other redirect writes a file
  for (const seg of splitSegments(cmd)) {
    const toks = tokenize(seg).filter((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
    if (!toks.length) continue;
    const prog = path.basename(toks[0]);
    const args = toks.slice(1);
    const sr = serverReadOnly(prog, args);
    if (sr === false) return false;
    if (sr === true) continue;
    if (!READONLY_PROGS.has(prog)) return false;
    if (prog === 'git') {
      const sub = args.find((a) => !a.startsWith('-'));
      if (!READONLY_GIT.has(sub)) return false;
      if (sub === 'branch' && args.some((a) => /^-(d|D|m|M|c|C)$|--delete|--move|--copy/.test(a))) return false;
      if (sub === 'tag' && args.some((a) => !a.startsWith('-') && a !== 'tag')) return false;
      if (sub === 'remote' && args.some((a) => /^(add|remove|rm|rename|set-url|prune)$/.test(a))) return false;
      if (sub === 'config' && !args.includes('--get') && !args.includes('--list') && !args.includes('-l')) return false;
      if (sub === 'stash' && !args.includes('list') && !args.includes('show')) return false;
    } else if (['node', 'python3', 'python', 'rustc', 'gcc', 'g++', 'cc', 'clang'].includes(prog)) {
      if (!args.every((a) => /^(-v|-V|--version|-version)$/.test(a))) return false; // only version probes
    } else if (prog === 'npm' || prog === 'cargo') {
      if (!/^(ls|list|view|--version|-v|outdated|tree)$/.test(args[0] || '')) return false;
    } else if (prog === 'find') {
      if (args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint|fprintf|fprint0|fls)$/.test(a))) return false;
    } else if (prog === 'env') {
      if (args.length) return false;
    } else if (prog === 'ping') {
      return false; // never terminates
    }
  }
  return true;
}

module.exports = { assessCommand, ApprovalGate, hashCommand, splitSegments, tokenize, outsideWorkspace, ruleFor, matchesRule, isReadOnlyCommand };
