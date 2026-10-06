#!/usr/bin/env node
'use strict';
// Records a short demo clip of the REAL app for the website: a quick back-and-forth with the agent (the default local model, Ollama) that fixes and edits code in a
// throw-away project, then `ssh dgx` into a real server, a GPU lookup and an approval before a delete. Only the app's web contents are
// captured (no menu bar, no other windows). Account / host names and IP addresses are replaced on screen while recording, a watcher flags
// anything that still shows up, and the finished clip should be OCR-checked (scripts/ocr-check.swift).
//   AIT_APP_BIN=<copy of the app outside ~/Desktop> AIT_DOC_PROMPT='%F{green}user@mac%f %F{blue}%~%f %# ' \
//   SHOTS_LANG=en|ko node scripts/record-demo.js [ssh-alias]       -> site/assets/video/demo[-ko].mp4 (+ poster)
// What it touches on the server: ONE throw-away folder /tmp/macaiterm-demo-<random>, key login only, removed at the end.
// The model is warmed up with one hidden request first. A notice about this Mac's free memory is not part of the clip (it says nothing about the product).
// Waiting for the model is shortened: a frame is kept only when the screen changed and never longer than AIT_VIDEO_CAP seconds.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const LANG = process.env.SHOTS_LANG === 'ko' ? 'ko' : 'en';
process.env.AIT_LANG = LANG;
process.env.AIT_THEME = process.env.AIT_THEME || 'light';
const { launch, sleep, WS, privacyHits } = require('./e2e');

const ALIAS = (process.argv.slice(2).find((x) => !x.startsWith('--')) || 'dgx').replace(/[^A-Za-z0-9._-]/g, '');
const SIZE = process.env.AIT_WIN_SIZE || '1680x1080';
const CAP = Number(process.env.AIT_VIDEO_CAP || 0.7);
const FRAMES = process.env.AIT_VIDEO_DIR || path.join(os.tmpdir(), `macaiterm-demo-frames-${LANG}`);
const VIDEO_DIR = path.join(__dirname, '..', 'site', 'assets', 'video');
const NAME = LANG === 'ko' ? 'demo-ko' : 'demo';
const SRV = `/tmp/macaiterm-demo-${crypto.randomBytes(3).toString('hex')}`;
const TXT = {
  en: { fix: 'npm test is failing. Find the cause and fix it.', again: 'Run the tests once more to confirm.',
        gpu: 'What are the GPU utilization and temperature right now? Use nvidia-smi.', rmlog: 'Delete logs/old-2026-09-12.log in this folder.' },
  ko: { fix: 'npm test 가 실패해. 원인을 찾아서 고쳐줘.', again: '테스트를 한 번 더 실행해서 확인해 줘.',
        gpu: '지금 GPU 사용률과 온도가 얼마야? nvidia-smi 를 써줘.', rmlog: '이 폴더의 logs/old-2026-09-12.log 를 삭제해 줘.' },
}[LANG];

// ---- what must never be on screen: this Mac's account / host and the server's (read from `ssh -G`, never printed)
const sshG = {};
try { for (const l of execFileSync('ssh', ['-G', ALIAS], { encoding: 'utf8' }).split('\n')) { const [k, ...v] = l.split(' '); (sshG[k] = sshG[k] || []).push(v.join(' ')); } } catch { /* no such alias */ }
const stand = [[os.userInfo().username, 'user'], [os.hostname().split('.')[0], 'mac']];
if (sshG.user) stand.push([sshG.user[0], 'ubuntu']);
if (sshG.hostname && sshG.hostname[0] !== ALIAS) stand.push([sshG.hostname[0], `${ALIAS}-spark`]);
const pairs = stand.filter(([k]) => k && k.length > 2);
const secrets = pairs.map(([k]) => k.toLowerCase());
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const idleExpr = `document.getElementById('state').dataset.phase === 'idle' && !__ait.state.aiBusy`;
const aiIdleExpr = `!__ait.state.aiBusy`; // on a server the state chip says "Shell busy" for the whole session
// what the screen shows, without running timers (a long wait is one frame, not one per second)
const sigExpr = `(() => { const tl = document.querySelector('.timeline.active'); return [tl ? tl.innerText.replace(/\\d+(\\.\\d+)?\\s?s\\b/g, '#') : '', !document.getElementById('approval-bar').hidden, __ait.bufferText().length, document.querySelector('.card.plan') ? 1 : 0].join('|'); })()`;
const put = (f, c) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); };
const remote = (script) => spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', ALIAS, script], { encoding: 'utf8', timeout: 60000 });

const prepWorkspace = () => {
  put(path.join(WS, 'src', 'util.js'), 'function add(a, b) { return a - b; }   // BUG: should add\nmodule.exports = { add };\n');
  put(path.join(WS, 'tmp_shot.txt'), 'temporary file\n');
};

(async () => {
  if (!sshG.hostname) throw new Error(`no "${ALIAS}" in ~/.ssh/config`);
  if (!/ok/.test(remote('echo ok').stdout)) throw new Error('key login to the server failed (BatchMode)');
  fs.rmSync(FRAMES, { recursive: true, force: true });
  fs.mkdirSync(FRAMES, { recursive: true });
  fs.mkdirSync(VIDEO_DIR, { recursive: true });
  prepWorkspace();
  // sample project on the server: one throw-away folder in /tmp
  const files = {
    'README.md': '# LLM serving demo\n', 'notes.txt': 'Deploy window: Friday 18:00\n',
    'deploy.sh': '#!/bin/sh\nset -e\ncd ~/projects/llm-serving\ngit pull\nsystemctl restart llm-serving\n',
    'projects/llm-serving/serve.py': 'from fastapi import FastAPI\n\napp = FastAPI()\n\n\n@app.get("/health")\ndef health():\n    return {"ok": True}\n',
    'projects/llm-serving/config.yaml': 'port: 8000\nworkers: 4\nlog_level: info\n',
    'projects/trainer/train.py': 'import torch\n\n\ndef main():\n    print("training...")\n',
    'models/tokenizer.json': '{"version": "demo"}\n',
    'logs/server.log': Array.from({ length: 80 }, (_, i) => `2026-10-0${1 + (i % 4)} 12:${String(i % 60).padStart(2, '0')}:00 INFO request id=${1000 + i} status=200`).join('\n') + '\n',
    'logs/old-2026-09-12.log': Array.from({ length: 30 }, (_, i) => `2026-09-12 08:00:${String(i).padStart(2, '0')} INFO archived`).join('\n') + '\n',
  };
  const b64 = (s) => Buffer.from(s).toString('base64');
  const made = remote(`mkdir -p '${SRV}' && cd '${SRV}' && ` + Object.entries(files).map(([f, c]) => `mkdir -p "$(dirname '${f}')" && echo '${b64(c)}' | base64 -d > '${f}'`).join(' && '));
  if (made.status) throw new Error('could not create the demo folder on the server: ' + made.stderr.slice(0, 100));
  // an ssh config with only this server (the session list of the app never shows other hosts)
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-demo-ssh-'));
  const ids = (sshG.identityfile || []).map((p) => p.replace(/^~/, os.homedir())).filter((p) => fs.existsSync(p));
  put(path.join(cfgDir, 'config'), [`Host ${ALIAS}`, `  HostName ${sshG.hostname[0]}`, sshG.user ? `  User ${sshG.user[0]}` : '', sshG.port && sshG.port[0] !== '22' ? `  Port ${sshG.port[0]}` : '', sshG.proxyjump ? `  ProxyJump ${sshG.proxyjump[0]}` : '', ...ids.map((p) => `  IdentityFile ${p}`), ids.length ? '  IdentitiesOnly yes' : '', ''].filter(Boolean).join('\n') + '\n');
  fs.chmodSync(path.join(cfgDir, 'config'), 0o600);

  const a = await launch({ AIT_WIN_SIZE: SIZE, AIT_SSH_DIR: cfgDir });
  const frames = [];
  let n = 0;
  let posterAt = -1;
  const snap = async (fixed) => {
    const r = await a.cdp('Page.captureScreenshot', { format: 'jpeg', quality: 86 });
    const f = path.join(FRAMES, String(n++).padStart(5, '0') + '.jpg');
    fs.writeFileSync(f, Buffer.from(r.result.data, 'base64'));
    frames.push({ f, t: Date.now() / 1000, fixed });
  };
  /** keep one frame per change of the screen until `done` is true */
  const watch = async (done, ms) => {
    let last = null; const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const sig = await a.ev(sigExpr);
      if (sig !== last) { last = sig; await snap(); }
      if (await a.ev(done)) return;
      await sleep(180);
    }
    throw new Error('timeout waiting for: ' + done);
  };
  const typeRequest = async (text) => {
    await a.ev(`__ait.setMode('ai')`);
    for (let i = 1; i <= text.length; i++) {
      await a.ev(`(() => { __ait.input.value = ${JSON.stringify(text.slice(0, i))}; __ait.input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      if (i % 3 === 0 || i === text.length) await snap(0.06);
    }
    await snap(0.4);
    await a.ev(`__ait.submit()`);
  };
  const click = (sel) => a.ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
  const failed = () => a.ev(`/AI error|AI 오류|Re-check model|모델 연결 다시/.test((document.querySelector('.timeline.active') || {}).innerText || '')`);
  const turn = async (text, done, ms) => { await typeRequest(text); await sleep(700); await watch(done, ms); if (await failed()) throw new Error('the model answered with an error: the clip is not usable'); };

  try {
    await a.waitFor(`document.getElementById('model-text').textContent.length > 0`, 60000);
    await a.waitFor(`__ait.state.pty === 'prompt'`, 30000);
    await a.waitFor(`/Ollama/.test(document.getElementById('model-text').textContent)`, 90000, 'the local model chip');
    console.log('model chip:', await a.ev(`document.getElementById('model-text').textContent`));
    // warm-up (not recorded): the first request loads the model into memory
    await a.ev(`(() => { __ait.setMode('ai'); __ait.input.value = 'Reply with the single word ok.'; __ait.submit(); })()`);
    await sleep(800);
    await a.waitFor(idleExpr, 420000, 'model warm-up');
    await a.ev(`window.confirm = () => true; document.getElementById('btn-reset').click()`);
    await sleep(1500);
    await a.ev(`__ait.term.clear()`);
    // live redaction: account / host names and every IPv4 address are replaced the moment they reach the page (before it is painted)
    await a.ev(`(() => {
      const P = ${JSON.stringify(pairs)}.map(([k, r]) => [new RegExp(k.replace(/[.*+?^$\{}()|[\\]\\\\]/g, '\\\\$&'), 'gi'), r]);
      P.push([/\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b/g, '203.0.113.7']);
      const fix = (s) => { for (const [re, r] of P) s = s.replace(re, r); return s; };
      const text = (n) => { const v = fix(n.nodeValue); if (v !== n.nodeValue) n.nodeValue = v; };
      const walk = (root) => { const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) text(n); if (root.querySelectorAll) root.querySelectorAll('[title]').forEach((e) => { const v = fix(e.title); if (v !== e.title) e.title = v; }); };
      walk(document.body);
      new MutationObserver((ms) => { for (const m of ms) { if (m.type === 'characterData') text(m.target); else m.addedNodes.forEach((x) => { if (x.nodeType === 3) text(x); else if (x.nodeType === 1) walk(x); }); } }).observe(document.body, { subtree: true, childList: true, characterData: true });
      const memo = () => document.querySelectorAll('.timeline .note').forEach((n) => { if (/Memory is (short|low)|메모리가 부족/.test(n.innerText)) n.remove(); });
      new MutationObserver(memo).observe(document.body, { subtree: true, childList: true }); memo();
      window.__leaks = 0; const S = ${JSON.stringify(secrets)};
      setInterval(() => { try { const t = document.body.innerText.toLowerCase(); if (S.some((s) => t.includes(s)) || /\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b/.test(t.replace(/203\\.0\\.113\\.7/g, ''))) window.__leaks++; } catch (e) {} }, 300);
    })()`);
    await sleep(600);
    await snap(1.6);

    // 1) quick back-and-forth with the agent on the local project
    await turn(TXT.fix, idleExpr, 480000);
    await sleep(400); await snap(0.8);
    await turn(TXT.again, idleExpr, 480000);
    await sleep(400); await snap(1.2);

    // 2) ssh into the server: the typed command is shown, the login itself (banner, prompt set-up) is not recorded
    await a.ev(`__ait.setMode('shell')`);
    const cmd = `ssh ${ALIAS}`;
    for (let i = 1; i <= cmd.length; i++) { await a.ev(`__ait.term.input(${JSON.stringify(cmd[i - 1])}, true)`); await snap(0.09); }
    await snap(0.5);
    await a.ev(`__ait.term.input('\\r', true)`);
    await a.waitFor(`!document.getElementById('ssh-chip').hidden`, 90000, 'ssh chip');
    await a.waitFor(`document.querySelector('#rmon .rcpu') && !document.querySelector('#rmon .rcpu').hidden`, 90000, 'server monitor');
    await sleep(1200);
    await a.ev(`__ait.term.input(${JSON.stringify(`export PS1='demo@${ALIAS}:\\w$ ' LC_ALL=C.UTF-8 LANG=C.UTF-8\r`)}, true)`);
    await sleep(500);
    await a.ev(`__ait.term.input(${JSON.stringify(`cd ${SRV}\r`)}, true)`);
    await sleep(600);
    await a.ev(`__ait.term.clear()`);
    if (await a.ev(`document.getElementById('sp-files').hidden`)) await click('.act[data-pane="files"]');
    await a.ev(`(() => { const i = document.querySelector('.fpane[data-side="remote"] .fpath'); if (i) { i.value = ${JSON.stringify(SRV)}; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true })); } })()`);
    await sleep(2500);
    await snap(1.6); // connected: server strip, file trees, clean prompt
    const offer = await a.ev(`!!document.querySelector('.timeline.active .note button.btn.primary')`);
    if (offer) await click('.timeline.active .note button.btn.primary'); else await a.ev(`window.AITCore.setRemote(true)`);
    await a.waitFor(`/· AI/.test(document.getElementById('ssh-chip').innerText)`, 60000, 'remote on');
    await sleep(500);
    await a.ev(`__ait.term.clear()`);
    await snap(0.9);

    // 3) the same conversation, now on the server
    await turn(TXT.gpu, aiIdleExpr, 480000);
    await sleep(500); await a.ev(`__ait.term.clear()`); await snap(1.4);
    posterAt = frames.length - 1;
    await turn(TXT.rmlog, `!document.getElementById('approval-bar').hidden`, 480000);
    await a.ev(`__ait.term.clear()`);
    await sleep(500); await snap(3.0);
    await click('#ap-no');
    await watch(aiIdleExpr, 120000).catch(() => {});
    await sleep(500); await snap(2.0);

    const leaks = await a.ev(`window.__leaks`);
    console.log(`frames: ${frames.length} | moments with an account / host name or address on screen: ${leaks} | harness privacy hits: ${privacyHits.length}`);
    if (leaks || privacyHits.length) throw new Error('an account / host name or IP address was on screen: the clip is not usable');
    const gone = a.ev(`__ait.term.input('exit\\r', true)`); await gone;
  } finally {
    a.close();
    const rm = remote(`rm -rf '${SRV}' && test ! -e '${SRV}' && echo gone`);
    console.log(/gone/.test(rm.stdout) ? 'server demo folder removed' : '!! server demo folder NOT removed: ' + SRV);
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }

  // timeline: a frame lasts until the next one, but never longer than CAP; typing frames have a fixed (short) length
  // long waits for the model are thinned out: at most MAXRUN key frames per wait, each shown for KEEP seconds
  const MAXRUN = Number(process.env.AIT_VIDEO_MAXRUN || 9);
  const KEEP = Number(process.env.AIT_VIDEO_KEEP || 0.6);
  const list = [];
  for (let i = 0; i < frames.length;) {
    if (frames[i].fixed != null) { list.push({ f: frames[i].f, dur: frames[i].fixed }); i++; continue; }
    let j = i; while (j < frames.length && frames[j].fixed == null) j++; // frames[i..j) is one wait for the model
    const run = frames.slice(i, j);
    if (run.length <= MAXRUN) run.forEach((fr, k) => { const next = run[k + 1] || frames[j]; list.push({ f: fr.f, dur: Math.min(CAP, Math.max(0.06, next ? next.t - fr.t : 1.5)) }); });
    else for (let k = 0; k < MAXRUN; k++) list.push({ f: run[Math.round(k * (run.length - 1) / (MAXRUN - 1))].f, dur: KEEP }); // evenly spaced, first and last included
    i = j;
  }
  const total = list.reduce((s, x) => s + x.dur, 0);
  fs.writeFileSync(path.join(FRAMES, 'list.txt'), list.map((x) => `file '${x.f}'\nduration ${x.dur.toFixed(3)}`).join('\n') + `\nfile '${list[list.length - 1].f}'\n`);
  const target = path.join(VIDEO_DIR, NAME + '.mp4');
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(FRAMES, 'list.txt'),
    '-vf', 'scale=1680:-2:flags=lanczos,fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', process.env.AIT_VIDEO_CRF || '27',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', target], { encoding: 'utf8' });
  if (r.status) throw new Error('ffmpeg failed: ' + r.stderr);
  const poster = path.join(VIDEO_DIR, NAME + '-poster.jpg');
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', frames[Math.max(0, posterAt)].f, '-vf', 'scale=1680:-2:flags=lanczos', '-q:v', '4', poster]);
  console.log(`wrote ${path.relative(process.cwd(), target)}: ${total.toFixed(1)} s, ${(fs.statSync(target).size / 1e6).toFixed(1)} MB; poster ${(fs.statSync(poster).size / 1e3).toFixed(0)} KB (frames kept in ${FRAMES} for review)`);
  process.exit(0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
