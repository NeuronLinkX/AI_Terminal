'use strict';
// Resource monitor for the server a tab is connected to (CPU, memory, GPU, disk, load, uptime) — the remote counterpart of
// sysmon.js, shown in the top bar while an ssh session is active.
//
// The user's interactive shell is never touched: the app opens its OWN short-lived ssh connection (BatchMode, so it can never
// ask for or send a password) and pipes a read-only script into `sh` on stdin. If the session was started from the app's SSH
// menu it shares that session's authenticated connection (ControlMaster); otherwise key / agent login is used.
const { execFile, spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Read-only POSIX sh. Prints AITM:<key>=<value> lines. CPU is sampled twice inside the script so every poll is self-contained.
const SCRIPT = `export LC_ALL=C
o=$(uname -s)
echo "AITM:os=$o"
echo "AITM:arch=$(uname -m)"
echo "AITM:host=$(hostname 2>/dev/null)"
if [ "$o" = Linux ]; then
  a=$(head -n1 /proc/stat); sleep 0.25; b=$(head -n1 /proc/stat)
  echo "AITM:cpu1=$a"; echo "AITM:cpu2=$b"
  echo "AITM:load=$(cut -d' ' -f1-3 /proc/loadavg)"
  echo "AITM:cores=$(nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo)"
  awk '/^MemTotal/{t=$2}/^MemAvailable/{a=$2}/^MemFree/{f=$2}/^Buffers/{bu=$2}/^Cached/{c=$2}/^SwapTotal/{st=$2}/^SwapFree/{sf=$2}END{if(a=="")a=f+bu+c;print "AITM:mem=" t " " a " " st " " sf}' /proc/meminfo
  echo "AITM:up=$(cut -d' ' -f1 /proc/uptime)"
else
  n=$(sysctl -n hw.ncpu 2>/dev/null || echo 1)
  echo "AITM:cores=$n"
  echo "AITM:cpupct=$(ps -A -o %cpu= 2>/dev/null | awk -v n="$n" '{s+=$1}END{printf "%.1f", s/n}')"
  echo "AITM:load=$(sysctl -n vm.loadavg 2>/dev/null | tr -d '{}' | awk '{print $1,$2,$3}')"
  t=$(sysctl -n hw.memsize 2>/dev/null)
  vm_stat 2>/dev/null | awk -v t="$t" '/page size of/{p=$8}/^Pages free/{f=$3}/^Pages inactive/{i=$3}/^Pages speculative/{s=$3}/^Pages purgeable/{u=$3}END{gsub(/\\./,"",f);gsub(/\\./,"",i);gsub(/\\./,"",s);gsub(/\\./,"",u);print "AITM:mem=" int(t/1024) " " int((f+i+s+u)*p/1024) " 0 0"}'
  echo "AITM:up=$(( $(date +%s) - $(sysctl -n kern.boottime 2>/dev/null | sed 's/^{ sec = \\([0-9]*\\).*/\\1/') ))"
fi
df -Pk "\${HOME:-/}" 2>/dev/null | awk 'NR==2{print "AITM:disk=" $2 " " $3 " " $6}'
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits 2>/dev/null | head -n 8 | while IFS= read -r l; do echo "AITM:gpu=$l"; done
elif [ "$o" = Darwin ]; then
  ioreg -r -d 1 -w0 -c IOAccelerator 2>/dev/null | awk '/"model" =/{gsub(/.*= "|"$/,"");m=$0}/Device Utilization %/{match($0,/Device Utilization %"=[0-9]+/);u=substr($0,RSTART+22,RLENGTH-22)}END{if(u!="")print "AITM:gpu=" m ", " u ", , , "}'
fi
echo AITM:end
`;

const num = (v) => {
  const t = String(v === undefined || v === null ? '' : v).trim();
  if (t === '') return null; // an empty field is "unknown", not zero
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const gb1 = (kb) => Math.round((kb / 1048576) * 10) / 10;
const cpuTimes = (line) => {
  const p = String(line || '').trim().split(/\s+/);
  if (p[0] !== 'cpu') return null;
  const v = p.slice(1, 9).map(Number);
  if (v.length < 4 || v.some((x) => !Number.isFinite(x))) return null;
  const idle = v[3] + (v[4] || 0); // idle + iowait
  return { idle, total: v.reduce((a, b) => a + b, 0) };
};

/** Turn the script output into metrics. Missing pieces stay null (no GPU, no /proc …) — never an exception. */
function parseMetrics(text) {
  const kv = {};
  const gpuLines = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^AITM:([a-z0-9]+)=(.*)$/);
    if (!m) continue;
    if (m[1] === 'gpu') gpuLines.push(m[2]);
    else kv[m[1]] = m[2].trim();
  }
  if (!('end' in kv) && !/AITM:end/.test(text || '') && !kv.os) return null;
  const out = { os: kv.os || '', arch: kv.arch || '', hostname: kv.host || '', cpu: null, load: null, cores: num(kv.cores), mem: null, disk: null, gpus: [], uptimeSec: null };
  const a = cpuTimes(kv.cpu1);
  const b = cpuTimes(kv.cpu2);
  let pct = null;
  if (a && b && b.total > a.total) pct = Math.round((1 - (b.idle - a.idle) / (b.total - a.total)) * 100);
  else if (kv.cpupct !== undefined && num(kv.cpupct) !== null) pct = Math.round(num(kv.cpupct));
  if (pct !== null) out.cpu = { pct: Math.max(0, Math.min(100, pct)) };
  if (kv.load) {
    const l = kv.load.split(/\s+/).map(Number);
    if (l.length >= 3 && l.every(Number.isFinite)) out.load = l.slice(0, 3);
  }
  if (kv.mem) {
    const [t, av, st, sf] = kv.mem.split(/\s+/).map(Number);
    if (t > 0 && Number.isFinite(av)) {
      const used = Math.max(0, t - av);
      out.mem = { totalGB: gb1(t), availGB: gb1(av), usedGB: gb1(used), usedPct: Math.round((used / t) * 100), swapUsedGB: st > 0 ? gb1(st - sf) : 0, swapTotalGB: st > 0 ? gb1(st) : 0 };
    }
  }
  if (kv.disk) {
    const [t, u, ...mount] = kv.disk.split(/\s+/);
    if (num(t) > 0) out.disk = { totalGB: gb1(Number(t)), usedGB: gb1(Number(u)), usedPct: Math.round((Number(u) / Number(t)) * 100), mount: mount.join(' ') || '/' };
  }
  for (const l of gpuLines) {
    const f = l.split(',').map((x) => x.trim());
    if (f.length < 2) continue;
    const util = num(f[1]);
    if (util === null) continue;
    out.gpus.push({ name: f[0] || 'GPU', util: Math.max(0, Math.min(100, Math.round(util))), memUsedMB: num(f[2]), memTotalMB: num(f[3]), temp: num(f[4]) });
  }
  const up = num(kv.up);
  if (up !== null && up >= 0) out.uptimeSec = Math.round(up);
  return out;
}

const { SshLink, sshArgs, controlDir, KEEP_OPTS } = require('./sshlink');

/** Arguments of the monitor's own ssh call (kept for tests / callers): `ssh [-O check] <options> -- host sh`. */
function monitorArgs(target, { ctl = controlDir(), mode = 'own', connectTimeout = 6, check = false } = {}) {
  return sshArgs(target, { ctl, mode, connectTimeout, check, command: 'sh' });
}

/** Classify an ssh failure of the monitor connection from its stderr / exit status. */
function classifyFailure(stderr, code) {
  const s = String(stderr || '');
  if (/Permission denied|Too many authentication failures/i.test(s)) return { kind: 'needs-auth', hint: '원격 지표는 비밀번호를 묻지 않는 연결(SSH 키)이나 앱의 "SSH 접속" 메뉴로 연 세션이 필요합니다.' };
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(s)) return { kind: 'hostkey', hint: '호스트 키를 확인할 수 없어 지표를 가져오지 않습니다.' };
  if (/timed out|Connection refused|No route|Could not resolve|Network is unreachable/i.test(s)) return { kind: 'unreachable', hint: '서버에 연결할 수 없어 지표를 가져오지 못했습니다.' };
  if (/ControlPath.*too long/i.test(s)) return { kind: 'ctl', hint: '연결 공유 경로가 너무 깁니다.' };
  return { kind: 'failed', hint: code ? `지표 수집 실패(종료 ${code})` : '지표 수집 실패' };
}

class RemoteMonitor extends EventEmitter {
  /**
   * @param {{link?: SshLink, intervalMs?: number, isActive?: Function}} o  `link` is shared with the file panel; without one the
   *   monitor makes its own (sshBin / execImpl / spawnImpl / ctl are passed through to it — used by the tests)
   */
  constructor({ link, sshBin, intervalMs = 3000, isActive = () => true, execImpl, spawnImpl, ctl } = {}) {
    super();
    this.link = link || null;
    this.linkOpts = { sshBin, execImpl, spawnImpl, ctl };
    this.ownsLink = !link;
    this.intervalMs = intervalMs;
    this.isActive = isActive;
    this.target = null;
    this.timer = null;
    this.busy = false;
    this.fails = 0;
    this.stopped = true;
    this.last = null;
  }
  get running() {
    return !this.stopped;
  }
  get mode() {
    return this.link ? this.link.mode : 'own';
  }
  start(target, link) {
    this.stop();
    this.target = target;
    if (link) { this.link = link; this.ownsLink = false; }
    if (!this.link || this.ownsLink) {
      const o = Object.fromEntries(Object.entries(this.linkOpts).filter(([, v]) => v !== undefined));
      this.link = new SshLink(target, o);
      this.ownsLink = true;
    }
    this.link.retain();
    this.stopped = false;
    this.fails = 0;
    this._schedule(0);
  }
  _schedule(ms) {
    clearTimeout(this.timer);
    if (this.stopped) return;
    this.timer = setTimeout(() => this.poll(), ms);
  }
  async poll() {
    if (this.stopped) return;
    if (this.busy || !this.isActive()) return this._schedule(this.intervalMs);
    this.busy = true;
    const target = this.target;
    try {
      const r = await this.link.exec('sh', { stdin: SCRIPT, timeoutMs: 15000 });
      if (this.stopped || this.target !== target) return;
      const m = r.code === 0 ? parseMetrics(r.stdout) : null;
      if (m) {
        this.fails = 0;
        this.last = { ...m, at: Date.now(), via: this.link.mode };
        this.emit('metrics', this.last);
      } else {
        this.fails++;
        const f = classifyFailure(r.stderr, r.code);
        if (this.fails === 1 || f.kind === 'needs-auth') this.emit('unavailable', { ...f, fails: this.fails });
        if (f.kind === 'needs-auth' || f.kind === 'hostkey') { this.stop(); return; } // retrying cannot help
        if (this.link.mode !== 'own') { this.link.invalidate(); this.fails = 0; this.last = null; } // the shared connection is gone: look again
      }
    } catch {
      this.fails++;
    } finally {
      this.busy = false;
    }
    this._schedule(this.fails >= 3 ? 20000 : this.intervalMs);
  }
  /** Stop polling. A connection the monitor itself opened is closed once nobody else is using it; shared ones are left alone. */
  stop() {
    if (this.stopped && !this.link) return;
    const was = !this.stopped;
    this.stopped = true;
    clearTimeout(this.timer);
    this.target = null;
    this.last = null;
    if (was && this.link) this.link.release();
    if (this.ownsLink) this.link = null;
  }
}

module.exports = { SCRIPT, parseMetrics, monitorArgs, classifyFailure, RemoteMonitor, controlDir, KEEP_OPTS, SshLink };
