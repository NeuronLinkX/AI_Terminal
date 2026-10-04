#!/usr/bin/env node
'use strict';
// Read-only connection check of one server from ~/.ssh/config (e.g. a GPU box): key login (BatchMode, no password), the app's own
// server monitor (one sample), and the file engine's listing of the home folder. Nothing is written on the server and no host
// name / address is printed.
//   node scripts/verify-ssh-alias.js dgx
const { parseSshArgs } = require('../src/main/ssh');
const { SshLink } = require('../src/main/sshlink');
const { RemoteMonitor } = require('../src/main/remotemon');
const { RemoteBrowser } = require('../src/main/sftp');

const alias = process.argv[2];
if (!alias || !/^[A-Za-z0-9._-]+$/.test(alias)) { console.log('usage: node scripts/verify-ssh-alias.js <alias from ~/.ssh/config>'); process.exit(2); }
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

(async () => {
  const fs = require('fs');
  const ctl = fs.mkdtempSync('/tmp/aqa-');
  const link = new SshLink(parseSshArgs(`ssh ${alias}`), { ctl });
  try {
    const r = await link.exec('uname -sm; id -un >/dev/null && echo login-ok');
    check('key login (BatchMode, no prompt, no password)', r.code === 0 && /login-ok/.test(r.stdout), r.code === 0 ? r.stdout.split('\n')[0] : (r.stderr.trim().split('\n').pop() || 'failed'));
    if (r.code !== 0) throw new Error('cannot log in without a prompt');
    const mon = new RemoteMonitor({ link, intervalMs: 1000 });
    const m = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 30000);
      mon.on('metrics', (x) => { clearTimeout(t); resolve(x); });
      mon.on('unavailable', (u) => { clearTimeout(t); resolve({ unavailable: u }); });
      mon.start(parseSshArgs(`ssh ${alias}`), link);
    });
    mon.stop();
    check('monitor: one real sample from the server', !!m && !m.unavailable && !!m.cpu && !!m.mem, m && !m.unavailable ? `${m.os} ${m.arch} · ${m.cores} cores · CPU ${m.cpu.pct}% · mem ${m.mem.usedGB}/${m.mem.totalGB} GB · disk ${m.disk ? m.disk.usedPct + '%' : '—'} · up ${Math.round((m.uptimeSec || 0) / 3600)} h` : JSON.stringify(m));
    const gpus = (m && m.gpus) || [];
    check('monitor: GPU read through nvidia-smi', gpus.length >= 1, gpus.map((g) => `${g.name} · util ${g.util}% · mem ${g.memTotalMB ? `${g.memUsedMB}/${g.memTotalMB} MB` : 'n/a (unified memory)'} · ${g.temp != null ? g.temp + '°C' : 'no temp'}`).join(' | '));
    const fb = new RemoteBrowser(link);
    const home = await fb.home();
    const ls = home.path ? await fb.list(home.path) : { error: home.error };
    check('files: the home folder lists (read-only)', !ls.error && Array.isArray(ls.entries), ls.error || `${ls.entries.length} entries`);
    fb.close();
  } catch (e) { failed++; console.log('ERROR', e.message); } finally {
    link.close();
    try { fs.rmSync(ctl, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
