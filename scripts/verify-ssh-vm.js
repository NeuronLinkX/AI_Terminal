#!/usr/bin/env node
'use strict';
// Manual check against a REAL server (not part of `npm test`): the same engines the window uses — server monitor, file engine,
// the AI's remote file tools (quiet route and terminal route) — against a real Linux box.
//   AIT_SSH_TEST_TARGET=ubuntu@192.168.64.4 node scripts/verify-ssh-vm.js
// Key login only (BatchMode: no password is ever sent or stored). Everything happens in one throw-away folder under /tmp on the
// server, which is removed at the end. The host key is read once with ssh-keyscan into a TEMPORARY known_hosts file (trust on
// first use for this check only), so the user's own known_hosts is never touched.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { parseSshArgs } = require('../src/main/ssh');
const { SshLink } = require('../src/main/sshlink');
const { RemoteMonitor } = require('../src/main/remotemon');
const { RemoteBrowser } = require('../src/main/sftp');
const { PtySession } = require('../src/main/pty-session');
const { Agent } = require('../src/main/agent');
const { Settings } = require('../src/main/settings');

const TARGET = process.env.AIT_SSH_TEST_TARGET;
if (!TARGET) { console.log('set AIT_SSH_TEST_TARGET=user@host'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

(async () => {
  const host = TARGET.replace(/^.*@/, '').replace(/:\d+$/, '');
  const kh = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ait-verify-kh-')), 'known_hosts');
  fs.writeFileSync(kh, require('child_process').execFileSync('ssh-keyscan', ['-t', 'ed25519', host], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  const opts = `-o UserKnownHostsFile=${kh} -o StrictHostKeyChecking=yes -o LogLevel=ERROR`;
  const target = parseSshArgs(`ssh ${opts} ${TARGET}`);
  const ctl = fs.mkdtempSync('/tmp/aqv-');
  const link = new SshLink(target, { ctl });
  const remoteDir = `/tmp/ait-verify-${crypto.randomBytes(4).toString('hex')}`;
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-verify-'));
  try {
    // ---- login + environment
    let r = await link.exec('uname -sm; echo $SHELL; id -un; hostname');
    check('key login (BatchMode) works and a command runs', r.code === 0, r.stdout.replace(/\n/g, ' | ') || r.stderr.trim());
    if (r.code !== 0) throw new Error('cannot log in without a prompt');
    const [uname, shell] = r.stdout.split('\n');
    // ---- monitor: one real sample from the server
    const mon = new RemoteMonitor({ link, intervalMs: 1000 });
    const got = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 30000);
      mon.on('metrics', (m) => { clearTimeout(t); resolve(m); });
      mon.on('unavailable', (u) => { clearTimeout(t); resolve({ unavailable: u }); });
      mon.start(target, link);
    });
    mon.stop();
    check('monitor: real server metrics parsed (OS, CPU, memory, disk, uptime)', !!got && !got.unavailable && got.os && got.cpu && got.mem && got.disk && got.uptimeSec != null, JSON.stringify(got && !got.unavailable ? { os: got.os, arch: got.arch, cores: got.cores, cpu: got.cpu && got.cpu.pct, mem: got.mem && `${got.mem.usedGB}/${got.mem.totalGB}GB`, gpus: got.gpus.length, disk: got.disk && `${got.disk.usedPct}%` } : got));
    // ---- file engine
    const fb = new RemoteBrowser(link);
    const home = await fb.home();
    check('files: home folder', !!home.path && home.path.startsWith('/'), home.path || home.error);
    check('files: mkdir', !(await fb.mkdir(remoteDir)).error);
    const buf = crypto.randomBytes(300 * 1024);
    fs.writeFileSync(path.join(local, '한글 파일 (1).bin'), buf);
    fs.mkdirSync(path.join(local, 'tree/sub dir'), { recursive: true });
    fs.writeFileSync(path.join(local, 'tree/a.txt'), 'A\n');
    fs.writeFileSync(path.join(local, "tree/sub dir/it's.txt"), 'B\n');
    const waitDone = async (id) => { for (let i = 0; i < 200; i++) { const t = fb.list_transfers().find((x) => x.id === id); if (t && ['done', 'error', 'cancelled'].includes(t.state)) return t; await sleep(150); } return null; };
    let up = await fb.upload(path.join(local, '한글 파일 (1).bin'), remoteDir);
    let t = up.id ? await waitDone(up.id) : null;
    check('files: upload a 300 KB binary file (name with spaces / Korean / parentheses), verified by SHA-256', !!t && t.state === 'done' && t.verified, t ? t.state + (t.error ? ' ' + t.error : '') : JSON.stringify(up));
    const h = await fb.hash(`${remoteDir}/한글 파일 (1).bin`);
    check('files: the server-side hash equals the local one', h.hash === sha(buf), h.hash || h.error);
    up = await fb.upload(path.join(local, 'tree'), remoteDir);
    t = up.id ? await waitDone(up.id) : null;
    check('files: upload a folder (tar stream, GNU tar on the server)', !!t && t.state === 'done', t ? t.state + (t.error ? ' ' + t.error : '') : JSON.stringify(up));
    const ls = await fb.list(remoteDir);
    check('files: listing (GNU stat) shows the entries with sizes and types', !ls.error && ls.entries.some((e) => e.name === 'tree' && e.type === 'dir') && ls.entries.some((e) => e.name === '한글 파일 (1).bin' && e.size === buf.length), ls.error || ls.entries.map((e) => `${e.name}:${e.type}:${e.size}`).join(', '));
    const sub = await fb.list(`${remoteDir}/tree/sub dir`);
    check("files: nested folder with a space and a quote in a name", !sub.error && sub.entries.some((e) => e.name === "it's.txt"), sub.error || '');
    fs.mkdirSync(path.join(local, 'down'));
    const dn = await fb.download(`${remoteDir}/한글 파일 (1).bin`, path.join(local, 'down'));
    t = dn.id ? await waitDone(dn.id) : null;
    check('files: download is byte-identical', !!t && t.state === 'done' && fs.existsSync(path.join(local, 'down', '한글 파일 (1).bin')) && sha(fs.readFileSync(path.join(local, 'down', '한글 파일 (1).bin'))) === sha(buf), t ? t.state : JSON.stringify(dn));
    const dd = await fb.download(`${remoteDir}/tree`, path.join(local, 'down'));
    t = dd.id ? await waitDone(dd.id) : null;
    check('files: download a folder', !!t && t.state === 'done' && fs.readFileSync(path.join(local, 'down', "tree/sub dir/it's.txt"), 'utf8') === 'B\n', t ? t.state + (t.error || '') : JSON.stringify(dd));
    const again = await fb.upload(path.join(local, '한글 파일 (1).bin'), remoteDir);
    check('files: same name → conflict is reported, nothing overwritten silently', !!again.conflict, JSON.stringify(again).slice(0, 100));
    check('files: rename', !(await fb.rename(`${remoteDir}/tree/a.txt`, `${remoteDir}/tree/b.txt`)).error);
    const cm = await fb.chmod(`${remoteDir}/tree/b.txt`, '600');
    check('files: chmod 600 (checked with stat on the server)', !cm.error && (await link.exec(`stat -c %a '${remoteDir}/tree/b.txt'`)).stdout.trim() === '600', cm.error || '');
    const pv = await fb.preview(`${remoteDir}/tree/b.txt`);
    check('files: preview', /A/.test(pv.text || ''), pv.error || '');
    check('files: delete guard refuses the home folder', !!(await fb.remove(home.path)).error);
    check('files: remove a file', !(await fb.remove(`${remoteDir}/tree/b.txt`)).error);
    fb.close();

    // ---- the AI's remote file tools through a real interactive ssh session (terminal route) and the quiet route
    const s = new PtySession({ cwd: local }).start();
    await new Promise((res) => { const i = setInterval(() => s.integrated && (clearInterval(i), res()), 50); });
    const login = await s.runCommand(`ssh ${opts} ${TARGET}`, { idleMs: 2500, maxMs: 20000 });
    check('terminal: an interactive ssh session opens in the PTY', login.status === 'running', login.status);
    await sleep(800);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-verify-data-'));
    const llm = { status: { active: { id: 'ollama' } }, ollama: { lastPlan: { ctx: 12288 } }, complete: async () => ({ text: '{}', provider: { label: 'x' } }) };
    const agent = new Agent({ session: s, llm, dataDir, settings: new Settings(dataDir) });
    agent.attach({ tabId: 'v', lang: () => 'ko' });
    const events = [];
    agent.on('event', (e) => events.push(e));
    const sig = new AbortController().signal;
    const log = { commands: [], files: [], failures: 0 };
    const iv = setInterval(() => { for (const e of events) if (e.type === 'approval' && !e._done) { e._done = true; agent.gate.answer(e.id, true); } }, 30);
    const on = await agent.setRemote(true, { target: { ...target, label: 'real-vm', id: TARGET } });
    check('AI remote mode: probe of the real Linux server', on.ok && /Linux/.test(on.info.os), on.ok ? `${on.info.os} ${on.info.arch} ${on.info.shell}` : on.reason);
    agent.linkProvider = () => link;
    const wr = await agent._remoteWrite(`${remoteDir}/hello.py`, 'print("안녕하세요")\n', sig, log);
    check('AI remote write_file (new file) on the server, hash-verified', !wr.error, wr.error || '');
    const rd = await agent._remoteRead(`${remoteDir}/hello.py`);
    check('AI remote read_file returns the content', /안녕하세요/.test(rd.content || ''), rd.error || '');
    const ed = await agent._remoteEdit(`${remoteDir}/hello.py`, '안녕하세요', '반갑습니다', sig, log);
    check('AI remote edit_file', !ed.error, ed.error || '');
    const sr = await agent._remoteSearch('반갑습니다', remoteDir);
    check('AI remote search', sr.count >= 1, sr.error || '');
    check('quiet route was used for these (after proving it reaches the same account)', !!agent._quiet && agent._quiet.ok === true);
    const run = await agent._doRun(`cat ${remoteDir}/hello.py; uname -s`, sig, log);
    check('AI remote run (read-only, in the visible terminal)', run.exitCode === 0 && /반갑습니다/.test(run.output || '') && /Linux/.test(run.output || ''), JSON.stringify(run).slice(0, 120));
    agent._quiet = { link, id: agent.remoteInfo.id, ok: false }; // force the terminal route too
    const w2 = await agent._remoteWrite(`${remoteDir}/via-terminal.txt`, 'terminal route\n', sig, log);
    const r2 = await agent._remoteRead(`${remoteDir}/via-terminal.txt`);
    check('terminal route: write + read on the real server', !w2.error && /terminal route/.test(r2.content || ''), w2.error || r2.error || '');
    clearInterval(iv);
    await agent.setRemote(false);
    s.write('exit\r');
    await sleep(800);
    s.kill();
  } catch (e) {
    failed++;
    console.log('ERROR', e.message);
  } finally {
    try { await link.exec(`rm -rf ${remoteDir}`); } catch { /* best effort */ }
    const gone = await link.exec(`test ! -e ${remoteDir} && echo gone`).catch(() => ({ stdout: '' }));
    check('cleanup: the throw-away folder on the server is removed', /gone/.test(gone.stdout));
    link.close();
    fs.rmSync(local, { recursive: true, force: true });
    fs.rmSync(ctl, { recursive: true, force: true });
  }
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
