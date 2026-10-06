#!/usr/bin/env node
'use strict';
// Screenshots for the download website (site/): ENGLISH UI, the AI is Codex CLI (ChatGPT login) — nothing is on the local model
// except one very small lookup — and the SSH screens are a real server from ~/.ssh/config (default alias "dgx").
//   AIT_APP_BIN="/Applications/MacAIterm.app/Contents/MacOS/MacAIterm" AIT_SHOT_DIR=/tmp/site-shots node scripts/shots-site.js [dgx-alias]
// What it touches on the server: ONE throw-away folder /tmp/macaiterm-demo-<random> (sample files, removed at the end), key login only
// (no password). The server's account / host name never appear in an image: the prompt of the session is replaced, the session list
// shows a placeholder for the host, and every capture is scanned (DOM text) and should be OCR-checked afterwards.
// Codex sends the conversation (here: harmless demo commands and their output) to OpenAI under the account that is logged in to `codex`.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

// SHOTS_LANG=ko takes the same pictures with the Korean UI and Korean requests (the site has an English and a Korean edition)
const LANG = process.env.SHOTS_LANG === 'ko' ? 'ko' : 'en';
process.env.AIT_LANG = LANG;
const TXT = {
  en: {
    local: 'What is the current working directory? Use pwd.', fix: 'npm test is failing. Find the cause and fix it.', plan: 'Which npm scripts are defined in package.json?',
    del: 'Delete the file tmp_shot.txt with rm.', gpu: 'What are the GPU utilization and temperature right now? Use nvidia-smi with --query-gpu and CSV output.',
    rmlog: 'Delete logs/old-2026-09-12.log in this folder.', work: 'Work', personal: 'Personal', box: 'GPU training box', newBtn: /New/, mem: /Memory is (short|low)/, checking: /Checking/,
  },
  ko: {
    local: '현재 작업 디렉터리가 어디야? pwd 로 확인해 줘.', fix: 'npm test 가 실패해. 원인을 찾아서 고쳐줘.', plan: 'package.json 에 정의된 npm 스크립트가 뭐야?',
    del: 'tmp_shot.txt 파일을 rm 으로 삭제해 줘.', gpu: '지금 GPU 사용률과 온도가 얼마야? nvidia-smi 에 --query-gpu 와 CSV 출력을 써줘.',
    rmlog: '이 폴더의 logs/old-2026-09-12.log 를 삭제해 줘.', work: '업무', personal: '개인', box: 'GPU 학습 서버', newBtn: /새 세션/, mem: /메모리가 부족/, checking: /확인 중/,
  },
}[LANG];
const { launch, check, results, sleep, ask, typeInTerm, privacyHits, OUT } = require('./e2e');

const ONLY = (process.argv.find((x) => x.startsWith('--only=')) || '').slice(7); // local | codex | server (default: everything)
const ALIAS = (process.argv.slice(2).find((x) => !x.startsWith('--')) || 'dgx').replace(/[^A-Za-z0-9._-]/g, '');
const SIZE = process.env.AIT_WIN_SIZE || '1680x1080';
const WS = process.env.AIT_E2E_WS || '/private/tmp/ait-demo-ws';
const LOC = '/private/tmp/ait-demo-local';
const SRV = `/tmp/macaiterm-demo-${crypto.randomBytes(3).toString('hex')}`;
const put = (f, c) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); };
const click = (a, sel) => a.ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
const idle = (a, ms = 300000) => a.waitFor(`document.getElementById('state').dataset.phase === 'idle' && !__ait.state.aiBusy`, ms, 'AI idle');
// while the shell is on a server the state chip says "Shell busy" for the whole session, so only the AI flag counts there
const idleAi = (a, ms = 300000) => a.waitFor(`!__ait.state.aiBusy`, ms, 'AI idle');
const tl = (a) => a.ev(`document.querySelector('.timeline.active').innerText`);
const row = (side, p) => `(() => { const pane = document.querySelector('.fpane[data-side="${side}"]'); return pane && [...pane.querySelectorAll('.frow')].find((r) => r.dataset.path === ${JSON.stringify(p)}); })()`;
const caret = (a, side, p) => a.ev(`${row(side, p)}.querySelector('.fcaret').click()`);
const dnd = (a, from, fromPath, to, toPath) => a.ev(`(() => {
  const r = (s, p) => { const pane = document.querySelector('.fpane[data-side="' + s + '"]'); return [...pane.querySelectorAll('.frow')].find((x) => x.dataset.path === p); };
  const src = r(${JSON.stringify(from)}, ${JSON.stringify(fromPath)}); const dst = r(${JSON.stringify(to)}, ${JSON.stringify(toPath)});
  if (!src || !dst) return 'missing';
  const dt = new DataTransfer(); const fire = (el, t) => el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }));
  fire(src, 'dragstart'); fire(dst, 'dragenter'); fire(dst, 'dragover'); fire(dst, 'drop'); fire(src, 'dragend'); return 'ok';
})()`);

// strings that must never be on screen: this Mac's account / host name and the server's (read from `ssh -G`, never printed)
const secret = [os.userInfo().username, os.hostname().split('.')[0]];
let sshG = {};
try { for (const l of execFileSync('ssh', ['-G', ALIAS], { encoding: 'utf8' }).split('\n')) { const [k, ...v] = l.split(' '); (sshG[k] = sshG[k] || []).push(v.join(' ')); } } catch { /* no such alias */ }
if (sshG.user) secret.push(sshG.user[0]);
if (sshG.hostname && sshG.hostname[0] !== ALIAS) secret.push(sshG.hostname[0]);
// neutral stand-ins for the real account / host names, applied to the text on screen right before a capture (like the neutral prompt)
const stand = [[os.userInfo().username, 'user'], [os.hostname().split('.')[0], 'mac']];
if (sshG.user) stand.push([sshG.user[0], 'ubuntu']);
if (sshG.hostname && sshG.hostname[0] !== ALIAS) stand.push([sshG.hostname[0], `${ALIAS}-spark`]);
const redact = (a) => a.ev(`(() => {
  const pairs = ${JSON.stringify(stand.filter(([k]) => k && k.length > 2))};
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = []; while (w.nextNode()) nodes.push(w.currentNode);
  let n = 0;
  for (const t of nodes) { let v = t.nodeValue; for (const [k, r] of pairs) { const re = new RegExp(k.replace(/[.*+?^$\{}()|[\]\\]/g, '\\$&'), 'gi'); if (re.test(v)) { v = v.replace(re, r); } } if (v !== t.nodeValue) { t.nodeValue = v; n++; } }
  document.querySelectorAll('[title]').forEach((e) => { let v = e.title; for (const [k, r] of pairs) v = v.split(k).join(r); if (v !== e.title) e.title = v; });
  return n;
})()`);
const leaks = async (a, what) => {
  await redact(a);
  const buf = await a.ev(`(typeof __ait !== 'undefined' && __ait.bufferText ? __ait.bufferText() : '')`);
  const dom = await a.ev(`document.body.innerText`);
  const where = [];
  for (const [label, text] of [['terminal buffer', buf], ['page text', dom]]) {
    for (const sec of secret.filter((x) => x && x.length > 2)) {
      const i = text.toLowerCase().indexOf(sec.toLowerCase());
      if (i >= 0) where.push(`${label}: "${text.slice(Math.max(0, i - 30), i).replace(/\s+/g, ' ')}***${text.slice(i + sec.length, i + sec.length + 20).replace(/\s+/g, ' ')}"`);
    }
  }
  if (where.length) { privacyHits.push(`${what}: ${where.length} private string(s) on screen`); console.log(`  !!! private string on screen: ${what}`); where.forEach((w) => console.log('      ' + w)); }
  return where.length > 0;
};
const shot = async (a, name) => { await leaks(a, name); await a.shot(name); };

const seedLocal = () => {
  fs.rmSync(LOC, { recursive: true, force: true });
  const lines = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join('\n') + '\n';
  put(path.join(LOC, 'dataset.csv'), lines(200, (i) => `${i},${(i * 7) % 13},${(i * 11) % 17}`));
  put(path.join(LOC, 'deploy-notes.md'), '# Deploy notes\n\n- Friday 18:00\n');
  put(path.join(LOC, 'config.yaml'), 'port: 8080\n');
  put(path.join(LOC, 'photos/team.txt'), 'team photo placeholder\n');
  put(path.join(LOC, 'photos/office.txt'), 'office photo placeholder\n');
  fs.mkdirSync(path.join(LOC, 'Downloads'), { recursive: true });
  fs.mkdirSync(path.join(LOC, 'Documents'), { recursive: true });
};
const prepWorkspace = () => {
  put(path.join(WS, 'src', 'util.js'), 'function add(a, b) { return a - b; }   // BUG: should add\nmodule.exports = { add };\n');
  put(path.join(WS, 'tmp_shot.txt'), 'temporary file\n');
};
const remote = (script) => spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', ALIAS, script], { encoding: 'utf8', timeout: 60000 });

async function phaseWorkspace() {
  console.log('# A: workspace, local lookup, then Codex');
  prepWorkspace();
  process.env.AIT_THEME = 'light'; // every image is light except hero-dark
  const a = await launch({ AIT_WIN_SIZE: SIZE });
  try {
    await a.waitFor(`document.getElementById('model-text').textContent.length > 0 && !${TXT.checking}.test(document.getElementById('model-text').textContent)`, 60000);
    await a.waitFor(`__ait.state.pty === 'prompt'`, 30000);
    // A1 — the local model only does a tiny lookup
    const chipLocal = await a.ev(`document.getElementById('model-text').textContent`);
    console.log('   local chip:', chipLocal);
    if (/Ollama/.test(chipLocal) && ONLY !== 'codex') {
      await ask(a, TXT.local);
      await idle(a, 240000).catch(() => console.log('   (the local model did not finish in time)'));
      await sleep(3500); // let the GPU / memory gauges settle after the model stops
      // memory-pressure advice depends on how busy the capture Mac is, not on the product: not part of the image
      await a.ev(`document.querySelectorAll('.timeline.active .note').forEach((n) => { if (${TXT.mem}.test(n.innerText)) n.remove(); })`);
      await shot(a, 'site-local-simple');
      check('local model: a tiny lookup command ran', /exit 0|ok · exit 0/.test(await tl(a)));
      await a.ev(`window.confirm = () => true; document.getElementById('btn-reset').click()`); await sleep(1200);
      await a.ev(`__ait.term.clear()`); // the listing the local model printed (file owner) must not stay in the scrollback
    }
    if (ONLY === 'local') return;
    // A2 — everything else with Codex
    await a.ev(`window.ait.llmPrefer('codex').then(() => 1)`);
    await a.waitFor(`/Codex/.test(document.getElementById('model-text').textContent)`, 30000, 'Codex chip');
    prepWorkspace();
    await ask(a, TXT.fix);
    await idle(a);
    const fixed = /a \+ b/.test(fs.readFileSync(path.join(WS, 'src', 'util.js'), 'utf8'));
    check('Codex: fixes the failing test', fixed);
    await sleep(500);
    await shot(a, 'hero-light');
    await click(a, '#btn-theme'); await sleep(900);
    check('theme: the dark theme is active for hero-dark', await a.ev(`document.documentElement.dataset.theme`) === 'dark');
    await shot(a, 'hero-dark');
    await click(a, '#btn-theme'); await sleep(700);
    // plan mode
    await a.ev(`window.confirm = () => true; document.getElementById('btn-reset').click()`); await sleep(1200);
    await a.ev(`__ait.setPlan(true)`);
    await ask(a, TXT.plan);
    await a.waitFor(`!!document.querySelector('.card.plan')`, 240000, 'plan card');
    await sleep(500);
    await shot(a, 'site-plan');
    await click(a, '.card.plan .acts .btn.yes');
    await idle(a);
    await a.ev(`__ait.setPlan(false)`);
    // approval
    await a.ev(`window.confirm = () => true; document.getElementById('btn-reset').click()`); await sleep(1200);
    await ask(a, TXT.del);
    await a.waitFor(`!document.getElementById('approval-bar').hidden`, 240000, 'approval bar');
    await sleep(500);
    await shot(a, 'site-approval');
    await click(a, '#ap-no');
    await idle(a, 120000).catch(() => {});
    check('approval: nothing is deleted without a yes', fs.existsSync(path.join(WS, 'tmp_shot.txt')));
  } finally { a.close(); }
}

async function phaseServer() {
  console.log(`# B: SSH (${ALIAS}) with Codex`);
  if (!sshG.hostname) { console.log(`   no "${ALIAS}" in ~/.ssh/config — skipped`); return; }
  const probe = remote('echo ok');
  if (!/ok/.test(probe.stdout)) { console.log('   key login to the server failed (BatchMode) — skipped'); return; }
  seedLocal();
  // sample project on the server: one throw-away folder in /tmp
  const files = {
    'README.md': '# LLM serving demo\n',
    'notes.txt': 'Deploy window: Friday 18:00\n',
    'deploy.sh': '#!/bin/sh\nset -e\ncd ~/projects/llm-serving\ngit pull\nsystemctl restart llm-serving\n',
    'projects/llm-serving/serve.py': 'from fastapi import FastAPI\n\napp = FastAPI()\n\n\n@app.get("/health")\ndef health():\n    return {"ok": True}\n',
    'projects/llm-serving/config.yaml': 'port: 8000\nworkers: 4\nlog_level: info\n',
    'projects/llm-serving/requirements.txt': 'fastapi==0.115.0\nuvicorn==0.30.6\n',
    'projects/trainer/train.py': 'import torch\n\n\ndef main():\n    print("training...")\n',
    'projects/trainer/configs/base.yaml': 'epochs: 20\nlr: 0.0003\nbatch_size: 32\n',
    'models/tokenizer.json': '{"version": "demo"}\n',
    'logs/server.log': Array.from({ length: 120 }, (_, i) => `2026-10-0${1 + (i % 4)} 12:${String(i % 60).padStart(2, '0')}:00 INFO request id=${1000 + i} status=200`).join('\n') + '\n',
    'logs/train.log': Array.from({ length: 60 }, (_, i) => `step ${i * 50} loss=${(2.4 / (1 + i / 9)).toFixed(4)}`).join('\n') + '\n',
    'logs/old-2026-09-12.log': Array.from({ length: 40 }, (_, i) => `2026-09-12 08:00:${String(i).padStart(2, '0')} INFO archived`).join('\n') + '\n',
  };
  const b64 = (s) => Buffer.from(s).toString('base64');
  const script = `mkdir -p '${SRV}/backup' && cd '${SRV}' && ` + Object.entries(files).map(([f, c]) => `mkdir -p "$(dirname '${f}')" && echo '${b64(c)}' | base64 -d > '${f}'`).join(' && ');
  const made = remote(script);
  check('server: demo folder created in /tmp', made.status === 0, made.stderr.trim().slice(0, 100));
  // a config that holds only this server (no other host of ~/.ssh/config is read or listed)
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-site-ssh-'));
  const ids = (sshG.identityfile || []).map((p) => p.replace(/^~/, os.homedir())).filter((p) => fs.existsSync(p));
  put(path.join(cfgDir, 'config'), [`Host ${ALIAS}`, `  HostName ${sshG.hostname[0]}`, sshG.user ? `  User ${sshG.user[0]}` : '', sshG.port && sshG.port[0] !== '22' ? `  Port ${sshG.port[0]}` : '', sshG.proxyjump ? `  ProxyJump ${sshG.proxyjump[0]}` : '', ...ids.map((p) => `  IdentityFile ${p}`), ids.length ? '  IdentitiesOnly yes' : '', ''].filter(Boolean).join('\n') + '\n');
  fs.chmodSync(path.join(cfgDir, 'config'), 0o600);
  process.env.AIT_THEME = 'light';
  const a = await launch({ AIT_WIN_SIZE: SIZE, AIT_CWD: LOC, AIT_SSH_DIR: cfgDir, OLLAMA_HOST: '127.0.0.1:9', AIT_OLLAMA_BIN: '/nonexistent/ollama' });
  try {
    await a.waitFor(`document.getElementById('model-text').textContent.length > 0`, 60000);
    await a.waitFor(`__ait.state.pty === 'prompt'`, 30000);
    await a.ev(`window.ait.llmPrefer('codex').then(() => 1)`);
    await a.waitFor(`/Codex/.test(document.getElementById('model-text').textContent)`, 30000, 'Codex chip');

    // sessions (examples use reserved example addresses and are never connected)
    await a.ev(`(async () => {
      const s = (o) => window.ait.sessSave({ keepAlive: true, share: true, x11: 'off', forwards: [], ...o });
      await s({ name: 'build-box', folder: ${JSON.stringify(TXT.work)}, host: 'build.example.com', user: 'deploy', port: 22, jump: 'bastion@203.0.113.5' });
      await s({ name: 'db-staging', folder: ${JSON.stringify(TXT.work)}, host: '203.0.113.20', user: 'admin', port: 2222, forwards: [{ kind: 'L', listenPort: 5433, host: 'localhost', port: 5432 }] });
      await s({ name: 'home-nas', folder: ${JSON.stringify(TXT.personal)}, host: 'nas.example.org', user: 'me', port: 22 });
    })()`);
    await click(a, '.act[data-pane="sessions"]');
    await a.waitFor(`[...document.querySelectorAll('#sp-sessions .sess-row')].some((r) => /${ALIAS}/.test(r.innerText))`, 15000, 'server row');
    await a.ev(`(() => { const r = [...document.querySelectorAll('#sp-sessions .sess-row')].find((x) => /${ALIAS}/.test(x.innerText)); const s = r.querySelector('.ssub'); if (s) s.textContent = 'user@' + '${ALIAS}-spark'; })()`); // the real user@address is not shown
    await sleep(500);
    await shot(a, 'site-sessions');

    // connect
    await a.ev(`[...document.querySelectorAll('#sp-sessions .sess-row')].find((x) => /${ALIAS}/.test(x.innerText)).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await a.waitFor(`!document.getElementById('ssh-chip').hidden`, 60000, 'ssh chip');
    await a.waitFor(`document.querySelector('#rmon .rcpu') && !document.querySelector('#rmon .rcpu').hidden`, 60000, 'server monitor');
    await a.waitFor(`!document.getElementById('sp-files').hidden`, 20000, 'files panel');
    await sleep(1500);
    // neutral prompt for this session only (typed, then the screen is cleared), then work in the demo folder
    await typeInTerm(a, `export PS1='demo@${ALIAS}:\\w$ ' LC_ALL=C.UTF-8 LANG=C.UTF-8\r`);
    await sleep(500);
    await typeInTerm(a, `cd ${SRV}\r`);
    await sleep(600);
    await a.ev(`__ait.term.clear()`);
    await typeInTerm(a, 'ls\r');
    await sleep(800);
    await a.ev(`(() => { const i = document.querySelector('.fpane[data-side="remote"] .fpath'); i.value = ${JSON.stringify(SRV)}; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true })); })()`);
    await a.waitFor(`!!${row('remote', SRV + '/projects')} && !!${row('local', LOC + '/dataset.csv')}`, 30000, 'trees');
    await caret(a, 'remote', SRV + '/projects');
    await a.waitFor(`!!${row('remote', SRV + '/projects/llm-serving')}`, 15000);
    await caret(a, 'remote', SRV + '/projects/llm-serving');
    await a.waitFor(`!!${row('remote', SRV + '/projects/llm-serving/serve.py')}`, 15000);
    await caret(a, 'local', LOC + '/photos');
    await a.ev(`${row('remote', SRV + '/projects/llm-serving/serve.py')}.click()`);
    await sleep(3500);
    await shot(a, 'site-ssh-files');
    check('server: file trees of the server and this Mac side by side', true);

    // drag & drop copies
    const r1 = await dnd(a, 'local', LOC + '/dataset.csv', 'remote', SRV + '/projects/trainer'); await sleep(1500);
    const r2 = await dnd(a, 'local', LOC + '/photos', 'remote', SRV + '/backup'); await sleep(1500);
    const r3 = await dnd(a, 'remote', SRV + '/notes.txt', 'local', LOC + '/Downloads'); await sleep(3000);
    await caret(a, 'remote', SRV + '/backup').catch(() => {});
    await caret(a, 'local', LOC + '/Downloads').catch(() => {});
    await sleep(1500);
    check('drag & drop: upload, folder upload and download', r1 === 'ok' && r2 === 'ok' && r3 === 'ok' && fs.existsSync(path.join(LOC, 'Downloads', 'notes.txt')), [r1, r2, r3].join(','));
    await shot(a, 'site-ssh-transfers');

    // status panel (the real numbers of the server)
    await click(a, '.act[data-pane="status"]');
    await a.waitFor(`/CPU/.test(document.getElementById('sp-status').innerText)`, 20000);
    await sleep(14000);
    await shot(a, 'site-ssh-status');
    await click(a, '.act[data-pane="files"]');

    // Codex works on the server
    const offer = await a.ev(`!!document.querySelector('.timeline.active .note button.btn.primary')`);
    if (offer) await a.ev(`document.querySelector('.timeline.active .note button.btn.primary').click()`); else await a.ev(`window.AITCore.setRemote(true)`);
    await a.waitFor(`/· AI/.test(document.getElementById('ssh-chip').innerText)`, 60000, 'remote on');
    await sleep(800);
    await a.ev(`__ait.term.clear()`); // the probe that switches the AI over prints the server's account / host name: not for the images
    await ask(a, TXT.gpu);
    await idleAi(a);
    await sleep(800);
    await a.ev(`__ait.term.clear()`); // the AI's own probe line is in the scrollback: show a plain listing instead
    await typeInTerm(a, 'ls\r');
    await sleep(900);
    await shot(a, 'site-ssh-ai');
    check('server AI: a read-only lookup ran on the server', /exit 0/.test(await tl(a)));
    await a.ev(`__ait.term.clear()`);
    await ask(a, TXT.rmlog);
    await a.waitFor(`!document.getElementById('approval-bar').hidden`, 240000, 'approval');
    await sleep(600);
    await a.ev(`__ait.term.clear()`);
    await sleep(400);
    await shot(a, 'site-ssh-approval');
    check('server AI: the change asks for approval naming the server', /dgx|${ALIAS}/.test(await a.ev(`document.getElementById('ap-host').innerText`)));
    await click(a, '#ap-no');
    await idleAi(a, 120000).catch(() => {});
    check('server AI: denied → the file is still there', /old-2026-09-12/.test(remote(`ls '${SRV}/logs'`).stdout));

    // session editor
    await click(a, '.act[data-pane="sessions"]');
    await a.waitFor(`document.querySelector('#sp-sessions .btn.primary')`, 10000);
    await a.ev(`[...document.querySelectorAll('#sp-sessions .btn.primary')].find((b) => ${TXT.newBtn}.test(b.textContent)).click()`);
    await a.waitFor(`!!document.querySelector('.ait-modal input[data-k="host"]')`, 10000, 'editor');
    await a.ev(`(() => { const set = (k, v) => { const i = document.querySelector('.ait-modal input[data-k="' + k + '"]'); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); };
      set('name', ${JSON.stringify(TXT.box)}); set('folder', ${JSON.stringify(TXT.work)}); set('host', 'gpu.example.com'); set('user', 'ubuntu'); set('port', '22'); set('jump', 'bastion@203.0.113.5:22'); set('startDir', '/srv/train'); })()`);
    await sleep(500);
    await shot(a, 'site-ssh-editor');
    await a.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(300);
    await typeInTerm(a, 'exit\r');
    await a.waitFor(`document.getElementById('ssh-chip').hidden`, 30000).catch(() => {});
  } catch (e) {
    console.log('ERROR', e.message);
    results.push({ name: `harness:${e.message}`, ok: false });
    try { await a.shot('site-error'); } catch { /* window gone */ }
  } finally {
    a.close();
    const gone = remote(`rm -rf '${SRV}' && test ! -e '${SRV}' && echo gone`);
    check('server: the demo folder is removed again', /gone/.test(gone.stdout));
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }
}

(async () => {
  if (ONLY !== 'server') try { await phaseWorkspace(); } catch (e) { console.log('ERROR (A)', e.message); results.push({ name: `harness:A ${e.message}`, ok: false }); }
  if (ONLY !== 'local' && ONLY !== 'codex') try { await phaseServer(); } catch (e) { console.log('ERROR (B)', e.message); results.push({ name: `harness:B ${e.message}`, ok: false }); }
  if (privacyHits.length) console.log('\n!! private information on screen:\n' + privacyHits.join('\n'));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed · privacy hits: ${privacyHits.length} · shots in ${OUT}`);
  process.exit(failed || privacyHits.length ? 1 : 0);
})();
