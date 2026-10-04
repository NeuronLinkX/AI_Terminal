'use strict';
// Processes started from a tab's shell (the shell's descendants) with the TCP ports they listen on, so a dev server
// started by the AI (or by hand) can be seen and stopped from the Processes panel.
const { execFile } = require('child_process');

// keep stdout even on a non-zero exit: lsof exits 1 when ONE of the listed pids vanished (short-lived children) but still reports the others
const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 4000, maxBuffer: 4 << 20 }, (_err, out) => resolve(String(out || ''))));

async function descendants(rootPid) {
  const out = await run('/bin/ps', ['-axo', 'pid=,ppid=,etime=,pcpu=,rss=,command=']);
  const rows = out.split('\n').filter(Boolean).map((l) => {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.*)$/);
    return m ? { pid: +m[1], ppid: +m[2], etime: m[3], cpu: +m[4], rssMB: Math.round(+m[5] / 1024), command: m[6] } : null;
  }).filter(Boolean);
  const kids = new Map();
  for (const r of rows) (kids.get(r.ppid) || kids.set(r.ppid, []).get(r.ppid)).push(r);
  const out2 = [];
  const walk = (pid, depth) => {
    for (const c of kids.get(pid) || []) {
      out2.push({ ...c, depth });
      walk(c.pid, depth + 1);
    }
  };
  walk(rootPid, 0);
  return out2;
}

async function listProcesses(shellPid) {
  const list = await descendants(shellPid);
  if (!list.length) return [];
  const lsof = await run('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', list.map((p) => p.pid).join(','), '-F', 'pn']);
  const ports = new Map();
  let cur = null;
  for (const line of lsof.split('\n')) {
    if (line.startsWith('p')) cur = +line.slice(1);
    else if (line.startsWith('n') && cur) (ports.get(cur) || ports.set(cur, []).get(cur)).push(line.slice(1).replace(/^.*:/, ''));
  }
  return list.map((p) => ({ ...p, ports: [...new Set(ports.get(p.pid) || [])] }));
}

/** Only descendants of the tab's shell may be signalled from the UI. */
async function signalProcess(shellPid, pid, signal) {
  const list = await descendants(shellPid);
  if (!list.some((p) => p.pid === pid)) return { ok: false, reason: '이 탭의 셸에서 시작된 프로세스가 아닙니다.' };
  try {
    process.kill(pid, signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM');
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.code || e.message };
  }
}

module.exports = { listProcesses, signalProcess, descendants };
