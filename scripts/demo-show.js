#!/usr/bin/env node
'use strict';
// Automatic, real-time demo for a screen recording (for example a YouTube video). You start your own screen recording; the demo starts
// by itself after a countdown and runs through: the agent fixes a failing test, asks for approval before a delete, then `ssh dgx` into a
// real server, a GPU lookup and an approval before a delete there. Everything is real (real shell, real default local model, real server);
// nothing is sped up or faked, and the pauses are long enough to read.
//
//   npm run demo                                  Korean prompts, dark theme, 15 s countdown
//   npm run demo -- --lang=en --theme=light --countdown=30
//   npm run demo -- --no-ssh                      without the server part
//   npm run record                                records it by itself: a ~2 minute MP4 of the app window in ~/Movies (see below)
//   npm run record -- --short                     only the core scenes (about a minute), --target=90 sets the length in seconds
//   npm run record -- --lang=en --plain          without pointer / zoom / captions
//   npm run demo -- --manual                      wait for:  touch /private/tmp/ait-demo-go   instead of the countdown
//   npm run demo -- --ssh=myserver                another alias from ~/.ssh/config (key login only, never a password)
//
// Automatic recording (--record, or npm run record): the script records the app window ITSELF, with no screen-recording permission and
// without ever capturing the menu bar or other windows (it takes the window's own pictures). Default mode "tight" keeps every change of the
// screen but shortens waiting for the model (the chat still appears by itself: typing, answers, approvals); --record-mode=real keeps the
// real timing. The result is checked with OCR for account / host names before it is called done.
//   npm run record -- --lang=en --theme=light --out=/path/demo.mp4 --scale=1.5
// Privacy while recording: the window is a throw-away profile on a throw-away project with a neutral prompt; this Mac's account / host
// names, the server's account / host names and every IPv4 address are replaced on screen the moment they appear; while the ssh login runs
// (banner, host name, home folder) the window is covered by a blurred curtain; a watcher covers the window again if anything slips through.
// On the server it touches ONE throw-away folder in /tmp (created before the countdown, removed at the end). Record only this window
// (Cmd+Shift+5, "Record Selected Portion"), not the whole screen: the menu bar and other apps are outside what this script can protect.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, execFile, spawnSync } = require('child_process');

const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const flag = (n) => process.argv.includes(`--${n}`);
const LANG = arg('lang', process.env.AIT_LANG === 'en' ? 'en' : 'ko') === 'en' ? 'en' : 'ko';
const THEME = arg('theme', 'light') === 'dark' ? 'dark' : 'light';
const FXTEST = flag('fxtest'); // only the effects (pointer, zoom, captions, cards) on the plain window: no model, no server, about 30 s
const RECORD = flag('record');
const PROMO = (RECORD && !flag('plain')) || flag('promo'); // pointer, zoom, captions, title and end card: like a product video (--plain turns it off)
const COUNTDOWN = Math.max(3, Number(arg('countdown', RECORD ? 4 : 15)));
const REC_MODE = arg('record-mode', 'tight') === 'real' ? 'real' : 'tight';
const REC_SCALE = Math.min(2, Math.max(1, Number(arg('scale', 1.5))));
const REC_HOLD = Number(arg('hold', 0.8)); // tight mode: the longest time one unchanged screen stays up
const REC_TEMPO = Math.max(0.3, Number(arg('tempo', 1))); // tight mode: multiplies the seconds the held screens stay up
const REC_TARGET = Number(arg('target', RECORD && !flag('short') && !FXTEST ? 120 : 0)); // seconds; 0 = as recorded
const REC_MAXRUN = Number(arg('maxrun', 10)); // tight mode: at most this many pictures for one wait for the model
const STAMP = (() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; })();
const OUT = arg('out', FXTEST ? path.join(os.tmpdir(), 'macaiterm-fxtest.mp4') : path.join(os.homedir(), 'Movies', `MacAIterm-demo-${LANG}-${STAMP}.mp4`));
const ALIAS = arg('ssh', 'dgx').replace(/[^A-Za-z0-9._-]/g, '');
const WITH_SSH = !flag('no-ssh') && !FXTEST;
const MANUAL = flag('manual');
const SIZE = arg('size', process.env.AIT_WIN_SIZE || '1600x1000');

const DIR = '/private/tmp/ait-live-demo';
const GO = '/private/tmp/ait-demo-go';
const PROFILE = '/private/tmp/ait-demo-profile';
const SRV = `/tmp/macaiterm-demo-${crypto.randomBytes(3).toString('hex')}`;
process.env.AIT_E2E_WS = DIR; // e2e.js reads it on load
process.env.AIT_LANG = LANG;
process.env.AIT_THEME = THEME;
process.env.AIT_DOC_PROMPT = process.env.AIT_DOC_PROMPT || '%F{green}user@mac%f %F{blue}%~%f %# ';

/** The installed app when there is one; otherwise a copy of the fresh build in /tmp (an app run from ~/Desktop cannot start its helpers). */
function resolveApp() {
  if (process.env.AIT_APP_BIN) return;
  const installed = '/Applications/MacAIterm.app';
  const built = path.join(__dirname, '..', 'dist', 'mac-arm64', 'MacAIterm.app');
  const src = fs.existsSync(built) ? built : installed; // the newest local build wins over an older installed copy
  if (!fs.existsSync(src)) { console.log('No MacAIterm.app found: run "npm run dist" first, or set AIT_APP_BIN.'); process.exit(2); }
  if (src === installed) { process.env.AIT_APP_BIN = path.join(installed, 'Contents/MacOS/MacAIterm'); return; }
  const copy = path.join(os.tmpdir(), 'macaiterm-demo-app', 'MacAIterm.app');
  fs.rmSync(path.dirname(copy), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  execFileSync('ditto', [src, copy]);
  try { execFileSync('xattr', ['-cr', copy]); } catch { /* nothing to clear */ }
  process.env.AIT_APP_BIN = path.join(copy, 'Contents/MacOS/MacAIterm');
}
resolveApp();
const { launch, sleep } = require('./e2e');

const T = {
  en: { fix: 'npm test is failing. Find the cause and fix it.', again: 'Run the tests once more to confirm the fix.', del: 'Delete the file tmp_shot.txt.',
        gpu: 'What are the GPU utilization and temperature right now? Use nvidia-smi.', rmlog: 'Delete logs/old-2026-09-12.log in this folder.',
        plan: 'Which npm scripts are defined in package.json?', work: 'Work', personal: 'Personal',
        cap: { 1: 'An AI agent that works inside your shell', 2: 'Search the terminal output', 3: 'Plan mode: review every step before it runs', 4: 'Risky commands wait for your approval', 5: 'Every session is saved and searchable', 6: 'Pick your model: local or cloud', 7: 'Split panes', 8: 'Saved SSH sessions', 9: 'SSH into a server: monitors and files in the same window', 10: 'Drag and drop, verified with SHA-256', 11: 'Server status at a glance', 12: 'The agent works on the server too', 13: 'Changes name the server they touch' },
        title: 'A macOS terminal with a built-in AI agent', outro1: 'Free for macOS · Apple silicon', outro2: 'github.com/NeuronLinkX/macAIterm', conn: `Connecting to ${ALIAS}…`, back: 'Disconnecting…', count: (n) => (RECORD ? `Recording starts by itself in ${n} s` : `Start your screen recording · the demo begins in ${n} s`), ready: 'Starting…' },
  ko: { fix: 'npm test가 실패해. 원인을 찾아서 수정해줘.', again: '수정한 걸 테스트로 한 번 더 확인해줘.', del: 'tmp_shot.txt 파일을 삭제해줘.',
        gpu: '지금 GPU 사용률과 온도가 얼마야? nvidia-smi 를 써줘.', rmlog: '이 폴더의 logs/old-2026-09-12.log 를 삭제해줘.',
        plan: 'package.json 에 정의된 npm 스크립트가 뭐가 있는지 알려줘.', work: '업무', personal: '개인',
        cap: { 1: '셸 안에서 일하는 AI 에이전트', 2: '터미널 출력 검색', 3: '계획 모드: 실행 전에 모든 단계를 확인', 4: '위험한 명령은 승인을 기다립니다', 5: '모든 세션이 저장되고 검색됩니다', 6: '모델 선택: 로컬 또는 클라우드', 7: '화면 분할', 8: '저장된 SSH 세션', 9: 'SSH 접속: 모니터와 파일을 한 창에서', 10: '끌어다 놓기, SHA-256 검증', 11: '서버 상태를 한눈에', 12: '에이전트는 서버에서도 일합니다', 13: '변경은 대상 서버를 밝힙니다' },
        title: 'AI 에이전트를 내장한 macOS 터미널', outro1: 'macOS용 무료 · Apple 실리콘', outro2: 'github.com/NeuronLinkX/macAIterm', conn: `${ALIAS}에 연결하는 중…`, back: '연결을 닫는 중…', count: (n) => (RECORD ? `${n}초 뒤 자동으로 녹화가 시작됩니다` : `화면 녹화를 시작하세요 · ${n}초 뒤 시연이 시작됩니다`), ready: '시작합니다…' },
}[LANG];

const put = (f, c) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); };
const sound = (n) => execFile('afplay', [`/System/Library/Sounds/${n}.aiff`], () => {});
const remote = (script) => spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', ALIAS, script], { encoding: 'utf8', timeout: 60000 });

/** (Re)writes the throw-away project. The folder itself is never removed: the app's shell is standing in it. */
function prep() {
  fs.mkdirSync(path.join(DIR, 'src'), { recursive: true });
  const files = {
    'package.json': '{"name":"demo-app","version":"1.0.0","scripts":{"test":"node test.js"}}\n',
    'notes.txt': 'meeting notes\n',
    'tmp_shot.txt': 'temporary file\n',
    'src/util.js': 'function add(a, b) {\n  return a - b;\n}\n\nmodule.exports = { add };\n',
    'test.js': "const { add } = require('./src/util');\nif (add(2, 3) !== 5) { console.error('FAIL: add(2,3) expected 5 got ' + add(2, 3)); process.exit(1); }\nconsole.log('ok');\n",
  };
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(DIR, f), c);
  if (!fs.existsSync(path.join(DIR, '.git'))) { try { const g = (...a) => execFileSync('git', a, { cwd: DIR, stdio: 'ignore' }); g('init', '-q'); g('add', '-A'); g('-c', 'user.name=demo', '-c', 'user.email=demo@example.com', 'commit', '-qm', 'init'); } catch { /* git is optional */ } }
}

// ---- what must never be on screen: this Mac's and the server's account / host names (read from `ssh -G`, never printed), every IPv4
const sshG = {};
if (WITH_SSH) { try { for (const l of execFileSync('ssh', ['-G', ALIAS], { encoding: 'utf8' }).split('\n')) { const [k, ...v] = l.split(' '); (sshG[k] = sshG[k] || []).push(v.join(' ')); } } catch { /* no such alias */ } }
const stand = [[os.userInfo().username, 'user'], [os.hostname().split('.')[0], 'mac']];
if (sshG.user) stand.push([sshG.user[0], 'ubuntu']);
if (sshG.hostname && sshG.hostname[0] !== ALIAS) stand.push([sshG.hostname[0], `${ALIAS}-spark`]);
const pairs = stand.filter(([k]) => k && k.length > 2);
const secrets = pairs.map(([k]) => k.toLowerCase());

// injected into the page: live redaction, the curtain, the countdown badge and a watcher that closes the curtain on any leak
const pageScript = () => `(() => {
  const P = ${JSON.stringify(pairs)}.map(([k, r]) => [new RegExp(k.replace(/[.*+?^$\\{}()|[\\]\\\\]/g, '\\\\$&'), 'gi'), r]);
  const IP = /\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b/g;
  P.push([IP, '203.0.113.7']);
  const fix = (s) => { for (const [re, r] of P) s = s.replace(re, r); return s; };
  const text = (n) => { const v = fix(n.nodeValue); if (v !== n.nodeValue) n.nodeValue = v; };
  const walk = (root) => { const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) text(n); if (root.querySelectorAll) root.querySelectorAll('[title]').forEach((e) => { const v = fix(e.title); if (v !== e.title) e.title = v; }); };
  walk(document.body);
  new MutationObserver((ms) => { for (const m of ms) { if (m.type === 'characterData') text(m.target); else m.addedNodes.forEach((x) => { if (x.nodeType === 3) text(x); else if (x.nodeType === 1) walk(x); }); } }).observe(document.body, { subtree: true, childList: true, characterData: true });
  // text boxes keep their text in .value, which is not a text node (for example the remote path box)
  setInterval(() => document.querySelectorAll('input, textarea').forEach((e) => { if (e === window.__ait.input || e.type === 'checkbox' || e.type === 'radio') return; const v = fix(e.value || ''); if (v !== e.value) e.value = v; }), 120);
  const memo = () => document.querySelectorAll('.timeline .note').forEach((n) => { if (/Memory is (short|low)|메모리가 부족/.test(n.innerText)) n.remove(); });
  new MutationObserver(memo).observe(document.body, { subtree: true, childList: true }); memo();
  const dark = () => document.documentElement.dataset.theme === 'dark';
  const el = (id, css) => { let d = document.getElementById(id); if (!d) { d = document.createElement('div'); d.id = id; d.style.cssText = css; document.documentElement.appendChild(d); } return d; };
  window.__curtain = (on, msg) => {
    const d = el('demo-curtain', 'position:fixed;inset:0;z-index:2147483647;display:none;align-items:center;justify-content:center;font:600 30px -apple-system,system-ui,sans-serif;letter-spacing:-.01em;backdrop-filter:blur(38px) saturate(.5);-webkit-backdrop-filter:blur(38px) saturate(.5);');
    d.style.background = dark() ? 'rgba(14,16,20,.9)' : 'rgba(246,244,238,.92)'; d.style.color = dark() ? '#e8e6df' : '#16181d';
    d.textContent = msg || ''; d.style.display = on || window.__panic ? 'flex' : 'none';
  };
  window.__badge = (msg) => { const d = el('demo-badge', 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483646;padding:10px 20px;border-radius:999px;font:600 17px -apple-system,system-ui,sans-serif;background:#c0392b;color:#fff;box-shadow:0 6px 24px rgba(0,0,0,.35);'); d.style.display = msg ? 'block' : 'none'; d.textContent = msg || ''; };
  window.__leaks = 0; const S = ${JSON.stringify(secrets)};
  setInterval(() => { try { const c = document.getElementById('demo-curtain'); if (c && c.style.display === 'flex') return; const vals = [...document.querySelectorAll('input, textarea')].map((e) => e.value || '').join('\\n'); const t = (document.body.innerText + '\\n' + vals).toLowerCase(); const ips = t.replace(/203\\.0\\.113\\.7/g, '').match(/\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b/); if (S.some((s) => t.includes(s)) || ips) { window.__leaks++; window.__panic = true; window.__curtain(true, ''); } } catch (e) {} }, 200);
})()`;
const fxScript = () => `(() => {
  const root = document.documentElement;
  const mk = (id, css) => { let d = document.getElementById(id); if (!d) { d = document.createElement('div'); d.id = id; d.style.cssText = css; root.appendChild(d); } return d; };
  const cur = mk('fx-cursor', 'position:fixed;left:760px;top:560px;width:32px;height:32px;margin:-3px 0 0 -5px;z-index:2147483640;pointer-events:none;display:none;filter:drop-shadow(0 2px 3px rgba(0,0,0,.4));');
  cur.innerHTML = '<svg width="32" height="32" viewBox="0 0 28 28"><path d="M5 3 L5 22 L10 17.5 L13.5 25 L17 23.5 L13.7 16.2 L20.5 16 Z" fill="#111" stroke="#fff" stroke-width="1.7" stroke-linejoin="round"/></svg>';
  const rip = mk('fx-ripple', 'position:fixed;width:54px;height:54px;margin:-27px 0 0 -27px;border-radius:50%;background:rgba(70,120,255,.26);border:3px solid rgba(70,120,255,.9);z-index:2147483639;pointer-events:none;opacity:0;');
  const cap = mk('fx-caption', 'position:fixed;left:50%;bottom:84px;z-index:2147483641;pointer-events:none;padding:13px 30px;border-radius:999px;font:600 25px -apple-system,system-ui,sans-serif;letter-spacing:-.01em;color:#fff;background:rgba(18,20,26,.86);box-shadow:0 10px 34px rgba(0,0,0,.35);opacity:0;white-space:nowrap;transition:opacity .25s;');
  const card = mk('fx-card', 'position:fixed;inset:0;z-index:2147483642;display:none;flex-direction:column;align-items:center;justify-content:center;gap:24px;text-align:center;font-family:-apple-system,system-ui,sans-serif;');
  const W = () => window.innerWidth, H = () => window.innerHeight;
  // the zoom: which part of the window the next picture shows (the page itself is never scaled, so nothing is re-rendered or blank)
  const st = { z: 1, cx: W() / 2, cy: H() / 2 };
  const view = () => { const w = W() / st.z, h = H() / st.z; return { x: Math.min(W() - w, Math.max(0, st.cx - w / 2)), y: Math.min(H() - h, Math.max(0, st.cy - h / 2)), w, h }; };
  const placeCaption = () => { const v = view(); cap.style.left = (v.x + v.w / 2) + 'px'; cap.style.bottom = (H() - (v.y + v.h) + 84 / st.z) + 'px'; cap.style.transformOrigin = '50% 100%'; cap.style.transform = 'translateX(-50%) scale(' + (1 / st.z) + ')'; };
  placeCaption();
  window.__fx = {
    cursor(on) { cur.style.display = on ? 'block' : 'none'; },
    place(x, y) { cur.style.left = x + 'px'; cur.style.top = y + 'px'; },
    pos() { return { x: parseFloat(cur.style.left), y: parseFloat(cur.style.top) }; },
    click(x, y) { rip.style.left = x + 'px'; rip.style.top = y + 'px'; rip.animate([{ opacity: 1, transform: 'scale(.35)' }, { opacity: 0, transform: 'scale(1.3)' }], { duration: 560, easing: 'ease-out' }); },
    caption(t) { cap.textContent = t || ''; cap.style.opacity = t ? '1' : '0'; placeCaption(); },
    card(html, dark) { card.style.background = dark ? '#0f1114' : '#fbfaf7'; card.style.color = dark ? '#ece9e2' : '#16181d'; card.innerHTML = html || ''; card.style.display = html ? 'flex' : 'none'; card.style.opacity = '1'; },
    cardOpacity(o) { card.style.opacity = String(o); if (o <= 0) card.style.display = 'none'; },
    rectOf(sel) { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return r.width ? { x: r.left, y: r.top, w: r.width, h: r.height } : null; },
    centerOf(sel) { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); if (!r.width) return null; return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; },
    get() { return { z: st.z, cx: st.cx, cy: st.cy }; },
    set(z, cx, cy) { st.z = z; st.cx = cx; st.cy = cy; placeCaption(); },
    view() { return view(); },
    size() { return { w: W(), h: H() }; },
  };
})()`;
if (flag('selftest')) { try { new Function(pageScript()); new Function(fxScript()); console.log(`page script compiles | lang=${LANG} theme=${THEME} size=${SIZE} countdown=${COUNTDOWN}s ssh=${WITH_SSH ? ALIAS : 'off'} app=${process.env.AIT_APP_BIN}`); } catch (e) { console.log('page script error:', e.message); process.exit(1); } process.exit(0); }

(async () => {
  if (WITH_SSH && !sshG.hostname) { console.log(`No "${ALIAS}" in ~/.ssh/config: continuing without the server part (use --ssh=<alias> or --no-ssh).`); }
  const withSsh = WITH_SSH && !!sshG.hostname;
  fs.rmSync(GO, { force: true });
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.rmSync(DIR, { recursive: true, force: true }); // fresh project before the app starts
  prep();
  let cfgDir = null; let srvMade = false;
  if (withSsh) {
    if (!/ok/.test(remote('echo ok').stdout)) { console.log(`Key login to ${ALIAS} failed (BatchMode): continuing without the server part.`); }
    else {
      const files = {
        'README.md': '# LLM serving demo\n', 'notes.txt': 'Deploy window: Friday 18:00\n',
        'deploy.sh': '#!/bin/sh\nset -e\ncd ~/projects/llm-serving\ngit pull\nsystemctl restart llm-serving\n',
        'projects/llm-serving/serve.py': 'from fastapi import FastAPI\n\napp = FastAPI()\n\n\n@app.get("/health")\ndef health():\n    return {"ok": True}\n',
        'projects/llm-serving/config.yaml': 'port: 8000\nworkers: 4\nlog_level: info\n',
        'projects/trainer/train.py': 'import torch\n\n\ndef main():\n    print("training...")\n',
        'models/tokenizer.json': '{"version": "demo"}\n',
        'logs/server.log': Array.from({ length: 60 }, (_, i) => `2026-10-0${1 + (i % 4)} 12:${String(i % 60).padStart(2, '0')}:00 INFO request id=${1000 + i} status=200`).join('\n') + '\n',
        'logs/old-2026-09-12.log': Array.from({ length: 30 }, (_, i) => `2026-09-12 08:00:${String(i).padStart(2, '0')} INFO archived`).join('\n') + '\n',
      };
      const b64 = (s) => Buffer.from(s).toString('base64');
      const made = remote(`mkdir -p '${SRV}' && cd '${SRV}' && ` + Object.entries(files).map(([f, c]) => `mkdir -p "$(dirname '${f}')" && echo '${b64(c)}' | base64 -d > '${f}'`).join(' && '));
      srvMade = made.status === 0;
      if (srvMade) {
        const who = remote('hostname -s; id -un').stdout.split('\n').map((x) => x.trim()).filter(Boolean);
        if (who[0] && who[0].length > 2) { pairs.push([who[0], `${ALIAS}-spark`]); secrets.push(who[0].toLowerCase()); }
        if (who[1] && who[1].length > 2 && !secrets.includes(who[1].toLowerCase())) { pairs.push([who[1], 'ubuntu']); secrets.push(who[1].toLowerCase()); }
        cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-demo-ssh-'));
        const ids = (sshG.identityfile || []).map((p) => p.replace(/^~/, os.homedir())).filter((p) => fs.existsSync(p));
        put(path.join(cfgDir, 'config'), [`Host ${ALIAS}`, `  HostName ${sshG.hostname[0]}`, sshG.user ? `  User ${sshG.user[0]}` : '', sshG.port && sshG.port[0] !== '22' ? `  Port ${sshG.port[0]}` : '', sshG.proxyjump ? `  ProxyJump ${sshG.proxyjump[0]}` : '', ...ids.map((p) => `  IdentityFile ${p}`), ids.length ? '  IdentitiesOnly yes' : '', ''].filter(Boolean).join('\n') + '\n');
        fs.chmodSync(path.join(cfgDir, 'config'), 0o600);
      } else console.log('Could not prepare the demo folder on the server: continuing without the server part.');
    }
  }
  const serverPart = withSsh && srvMade;

  if (!cfgDir) { cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-demo-ssh-')); put(path.join(cfgDir, 'config'), '# demo: no hosts\n'); fs.chmodSync(path.join(cfgDir, 'config'), 0o600); } // never the real ~/.ssh/config
  const a = await launch({ AIT_WIN_SIZE: SIZE, AIT_SSH_DIR: cfgDir }, PROFILE);
  let appGone = false;
  a.proc.on('exit', () => { appGone = true; });
  const alive = () => { if (appGone) { console.log('\nABORTED: the demo window was closed (the app quits when its window closes). Nothing more was demonstrated: start again.'); process.exit(2); } };
  const result = [];
  try {
    await a.waitFor(`document.getElementById('model-text').textContent.length > 0 && !/확인 중|Checking/.test(document.getElementById('model-text').textContent)`, 60000, 'model chip');
    await a.waitFor(`/Ollama/.test(document.getElementById('model-text').textContent)`, 90000, 'the default local model (Ollama)');
    await a.waitFor(`__ait.state.pty === 'prompt'`, 20000, 'shell prompt');
    await a.cdp('Page.bringToFront');
    await a.ev(pageScript());
    if (PROMO) await a.ev(fxScript());
    await a.ev(`window.__curtain(true, ${JSON.stringify(T.ready)})`); // nothing is shown until the countdown ends

    // ---- recorder: pictures of the window's own contents (no screen-recording permission, nothing outside the window)
    const rec = { on: false, paused: false, typing: false, frames: [], n: 0, dir: null, w: 0, h: 0, loop: null };
    const sigExpr = `(() => { const tl = document.querySelector('.timeline.active'); return [tl ? tl.innerText.replace(/\\d+(\\.\\d+)?\\s?s\\b/g, '#') : '', !document.getElementById('approval-bar').hidden, __ait.bufferText().length, __ait.input.value, document.querySelector('.card.plan') ? 1 : 0].join('|'); })()`;
    rec.snap = async (fixed) => {
      if (!rec.on || rec.paused) return;
      const v = PROMO ? await a.ev(`window.__fx.view()`) : { x: 0, y: 0, w: rec.w, h: rec.h };
      const r = await a.cdp('Page.captureScreenshot', { format: 'jpeg', quality: 82, optimizeForSpeed: true, clip: { x: v.x, y: v.y, width: v.w, height: v.h, scale: (rec.w * REC_SCALE) / v.w } });
      if (!r.result) return;
      const f = path.join(rec.dir, String(rec.n++).padStart(5, '0') + '.jpg');
      fs.writeFileSync(f, Buffer.from(r.result.data, 'base64'));
      rec.frames.push({ f, t: Date.now() / 1000, fixed: rec.typing ? 0.07 : fixed });
    };
    rec.start = async () => {
      const v = await a.ev(`({ w: window.innerWidth, h: window.innerHeight })`);
      rec.w = v.w; rec.h = v.h; rec.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'macaiterm-rec-')); rec.on = true;
      rec.loop = (async () => {
        let last = null;
        while (rec.on) {
          try {
            if (REC_MODE === 'real') await rec.snap();
            else { const sig = await a.ev(sigExpr); if (sig !== last) { last = sig; await rec.snap(); } await sleep(110); }
          } catch { await sleep(300); }
        }
      })();
    };
    rec.stop = async () => { rec.on = false; await rec.loop; };
    /** wait `ms` for the viewer of the live window; in the video a tight recording shows that moment for `videoSec` */
    const pause = async (ms, videoSec) => { if (rec.on && REC_MODE === 'tight') await rec.snap(videoSec * REC_TEMPO); await sleep(ms); };
    const encode = () => {
      const frames = rec.frames; const list = [];
      for (let i = 0; i < frames.length;) {
        if (frames[i].fixed != null) { list.push({ f: frames[i].f, dur: frames[i].fixed }); i++; continue; }
        let j = i; while (j < frames.length && frames[j].fixed == null) j++; // frames[i..j) is one stretch of changes while nothing was typed
        const run = frames.slice(i, j);
        const gapOf = (k) => { const nx = run[k + 1] || frames[j]; return nx ? nx.t - run[k].t : 1.5; };
        if (REC_MODE === 'real') run.forEach((fr, k) => list.push({ f: fr.f, dur: Math.max(0.03, gapOf(k)) }));
        else if (run.length <= REC_MAXRUN) run.forEach((fr, k) => list.push({ f: fr.f, dur: Math.min(REC_HOLD, Math.max(0.05, gapOf(k))) }));
        else for (let k = 0; k < REC_MAXRUN; k++) list.push({ f: run[Math.round(k * (run.length - 1) / (REC_MAXRUN - 1))].f, dur: 0.55 }); // evenly spaced, first and last included
        i = j;
      }
      if (REC_MODE === 'tight' && REC_TARGET > 0) { const tot = list.reduce((n, x) => n + x.dur, 0); const k = Math.min(1.8, Math.max(0.6, REC_TARGET / tot)); list.forEach((x) => { x.dur *= k; }); console.log(`  video length ${tot.toFixed(0)} s scaled by ${k.toFixed(2)} towards ${REC_TARGET} s`); }
      fs.writeFileSync(path.join(rec.dir, 'list.txt'), list.map((x) => `file '${x.f}'\nduration ${x.dur.toFixed(3)}`).join('\n') + `\nfile '${list[list.length - 1].f}'\n`);
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(rec.dir, 'list.txt'), '-vf', "scale='min(1920,iw)':-2:flags=lanczos,fps=30,format=yuv420p",
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', OUT], { encoding: 'utf8' });
      if (r.status) throw new Error('ffmpeg failed (is it installed? brew install ffmpeg): ' + r.stderr.slice(0, 200));
      return { list, seconds: list.reduce((n, x) => n + x.dur, 0) };
    };
    /** OCR over evenly chosen pictures: no account / host name may be readable in the video */
    const ocrCheck = (list) => {
      const bin = path.join(os.tmpdir(), 'macaiterm-ocr-check');
      if (!fs.existsSync(bin)) { const c = spawnSync('swiftc', ['-O', path.join(__dirname, 'ocr-check.swift'), '-o', bin], { encoding: 'utf8' }); if (c.status) return { ok: null, n: 0 }; }
      const files = [...new Set(list.map((x) => x.f))]; const step = Math.max(1, Math.floor(files.length / 70)); const sample = files.filter((_, i) => i % step === 0);
      const r = spawnSync(bin, sample, { env: { ...process.env, OCR_PATTERNS: secrets.join(',') }, encoding: 'utf8', timeout: 600000 });
      return { ok: r.status === 0, n: sample.length };
    };

    const idle = (ms = 480000) => a.waitFor(`document.getElementById('state').dataset.phase === 'idle' && !__ait.state.aiBusy`, ms, 'AI idle');
    const aiIdle = (ms = 480000) => a.waitFor(`!__ait.state.aiBusy`, ms, 'AI idle'); // on a server the state chip says "Shell busy" all session
    const typeSlow = async (text, perChar = 55) => {
      await a.ev(`__ait.setMode('ai')`);
      rec.typing = true;
      for (const ch of text) { await a.ev(`(() => { __ait.input.value += ${JSON.stringify(ch)}; __ait.input.dispatchEvent(new Event('input', { bubbles: true })); })()`); await sleep(perChar); }
      rec.typing = false;
      await sleep(900);
      await a.ev(`__ait.submit()`);
      await sleep(700);
    };
    const rawClick = (sel) => a.ev(`document.querySelector(${JSON.stringify(sel)}).click()`);

    // warm-up (the window stays covered): the first request loads the model, so the recorded run starts at full speed
    if (!FXTEST) {
    console.log('warming up the model … (the window is covered; this takes a minute)');
    await a.ev(`(() => { __ait.setMode('ai'); __ait.input.value = 'Reply with the single word ok.'; __ait.submit(); })()`);
    await sleep(900); await idle(420000);
    await a.ev(`window.confirm = () => true; document.getElementById('btn-reset').click()`); await sleep(1500);
    prep(); await a.ev(`__ait.term.clear()`); await sleep(500);
    }

    // ---- the product-video look: a visible pointer with click ripples, smooth zoom, captions, title and end card
    const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
    const fx = (expr) => a.ev(`window.__fx.${expr}`);
    let pointerOn = false;
    const cursorTo = async (target, ms = 700) => {
      if (!PROMO) return;
      const to = typeof target === 'string' ? await fx(`centerOf(${JSON.stringify(target)})`) : target;
      if (!to) return;
      if (!pointerOn) { pointerOn = true; await fx('cursor(true)'); }
      const from = await fx('pos()');
      const n = Math.max(5, Math.round(ms / 75));
      for (let i = 1; i <= n; i++) { const t = ease(i / n); await fx(`place(${from.x + (to.x - from.x) * t}, ${from.y + (to.y - from.y) * t})`); await rec.snap(0.06); await sleep(28); }
    };
    const click = async (sel) => {
      if (PROMO) {
        await cursorTo(sel, 650);
        const c = await fx(`centerOf(${JSON.stringify(sel)})`);
        if (c) { await fx(`click(${c.x}, ${c.y})`); await rec.snap(0.09); await sleep(170); await rec.snap(0.08); }
      }
      await rawClick(sel);
    };
    const tween = async (c, t, ms) => { const n = Math.max(6, Math.round(ms / 80)); for (let i = 1; i <= n; i++) { const e = ease(i / n); await fx(`set(${c.z + (t.z - c.z) * e}, ${c.cx + (t.cx - c.cx) * e}, ${c.cy + (t.cy - c.cy) * e})`); await rec.snap(0.07); await sleep(25); } };
    /** zoom to an element (selector) or to a rectangle given as fractions of the window {fx, fy, fw, fh} */
    const zoomTo = async (what, maxZoom = 1.5, ms = 850) => {
      if (!PROMO) return;
      const S = await fx('size()');
      const R = typeof what === 'string' ? await fx(`rectOf(${JSON.stringify(what)})`) : { x: what.fx * S.w, y: what.fy * S.h, w: what.fw * S.w, h: what.fh * S.h };
      if (!R) return;
      const cur = await fx('get()');
      const z = Math.max(1, Math.min(maxZoom, 0.94 * S.w / R.w, 0.94 * S.h / R.h));
      await tween(cur, { z, cx: R.x + R.w / 2, cy: R.y + R.h / 2 }, ms);
    };
    const zoomReset = async (ms = 750) => { if (!PROMO) return; const cur = await fx('get()'); if (cur.z !== 1) { const S = await fx('size()'); await tween(cur, { z: 1, cx: S.w / 2, cy: S.h / 2 }, ms); } };
    const caption = async (t) => { if (PROMO) await fx(`caption(${JSON.stringify(t || '')})`); };
    const hidePointer = async () => { if (PROMO) { await fx('cursor(false)'); pointerOn = false; } };
    const ICON = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.png')).toString('base64');
    const cardHtml = (l1, l2) => `<img src="data:image/png;base64,${ICON}" style="width:150px;height:150px;border-radius:34px;box-shadow:0 18px 50px rgba(0,0,0,.28)"><div style="font:700 70px/1.1 -apple-system,system-ui,sans-serif;letter-spacing:-.03em">MacAIterm</div><div style="font:500 32px/1.35 -apple-system,system-ui,sans-serif;opacity:.72;max-width:1100px">${l1}</div>${l2 ? `<div style="font:600 24px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;opacity:.6">${l2}</div>` : ''}`;
    const showCard = async (html, holdSec, fadeOut) => {
      if (!PROMO) return;
      await fx(`card(${JSON.stringify(html)}, ${THEME === 'dark'})`); await rec.snap(holdSec); await sleep(Math.min(1500, holdSec * 450));
      if (fadeOut) for (let i = 1; i <= 5; i++) { await fx(`cardOpacity(${1 - i / 5})`); await rec.snap(0.07); await sleep(30); }
    };
    const INPUT = await a.ev(`(() => { const i = __ait.input; if (!i.id) i.id = 'fx-ai-input'; return '#' + i.id; })()`);
    const CHAT = { fx: 0.3, fy: 0.45, fw: 0.7, fh: 0.55 }; // the newest part of the chat and the input box

    // ---- countdown (you start the screen recording now)
    if (MANUAL) { console.log(`\nREADY: start your screen recording, then run:\n  touch ${GO}\n`); await a.ev(`window.__curtain(false); window.__badge(${JSON.stringify(LANG === 'ko' ? '녹화를 시작한 뒤 신호를 보내 주세요' : 'Start recording, then send the signal')})`); const t0 = Date.now(); while (!fs.existsSync(GO)) { alive(); if (Date.now() - t0 > 45 * 60 * 1000) { console.log('no go signal for 45 minutes: closing'); return; } await sleep(300); } fs.rmSync(GO, { force: true }); }
    else {
      console.log(`\nREADY: the demo window is up. Start your screen recording of THIS WINDOW now: the demo begins in ${COUNTDOWN} s.\n`);
      await a.ev(`window.__curtain(false)`);
      for (let n = COUNTDOWN; n > 0; n--) { alive(); await a.ev(`window.__badge(${JSON.stringify(T.count(n))})`); if (n <= 3) sound('Tink'); await sleep(1000); }
    }
    await a.ev(`window.__badge('')`);
    if (PROMO) await fx(`card(${JSON.stringify(cardHtml(T.title))}, ${THEME === 'dark'})`); // already up when the first picture is taken
    if (RECORD) { await rec.start(); console.log(`recording the window by itself (${REC_MODE} mode) …`); }
    sound('Pop');
    console.log('GO: demo running (real time)');
    await showCard(cardHtml(T.title), 3.0, true); // opening card
    await pause(3500, 1.4); // a moment of the clean window

    tour: {
    if (FXTEST) {
      await caption(T.cap[6]); await click('#btn-settings'); await zoomTo('#settings-modal .sm-dialog', 1.25); await pause(1500, 1.4);
      await zoomReset(); await a.ev(`__panels.closeSettings()`); await sleep(500);
      await caption(T.cap[2]); await click('#model'); await pause(1500, 1.4); await a.ev(`document.body.click()`); await sleep(400);
      await caption(T.cap[1]); await cursorTo(INPUT, 800); await zoomTo(CHAT, 1.4); await pause(1500, 1.4); await zoomReset();
      await caption(''); await hidePointer(); await showCard(cardHtml(T.outro1, T.outro2), 2.0, false);
      break tour;
    }
    // ---- helpers for the tour
    const skipped = [];
    const resetUi = () => a.ev(`(() => { try { __panels.closeHistory(); } catch (e) {} try { __panels.closeSettings(); } catch (e) {} try { __ait.closeSearch(); } catch (e) {} try { __ait.setPlan(false); } catch (e) {} document.body.click(); })()`).catch(() => {});
    /** a scene that fails is skipped (and reported), it never ends the whole demo */
    const scene = async (name, fn, capKey) => { alive(); console.log('# ' + name); if (capKey) await caption(T.cap[capKey]); try { await fn(); } catch (e) { if (appGone) throw e; console.log(`  ! "${name}" was skipped: ${String(e.message).slice(0, 110)}`); skipped.push(name); await resetUi(); } };
    const rowOf = (side, p) => `(() => { const pane = document.querySelector('.fpane[data-side="${side}"]'); return pane && [...pane.querySelectorAll('.frow')].find((r) => r.dataset.path === ${JSON.stringify(p)}); })()`;
    const dnd = (from, fromPath, to, toPath) => a.ev(`(() => {
      const r = (s, p) => { const pane = document.querySelector('.fpane[data-side="' + s + '"]'); return [...pane.querySelectorAll('.frow')].find((x) => x.dataset.path === p); };
      const src = r(${JSON.stringify(from)}, ${JSON.stringify(fromPath)}); const dst = r(${JSON.stringify(to)}, ${JSON.stringify(toPath)});
      if (!src || !dst) return 'missing';
      const dt = new DataTransfer(); const fire = (el, t) => el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }));
      fire(src, 'dragstart'); fire(dst, 'dragenter'); fire(dst, 'dragover'); fire(dst, 'drop'); fire(src, 'dragend'); return 'ok';
    })()`);
    const FULL = !flag('short');

    // ---- 1 the agent works in the shell
    // A small local model sometimes loops or gives up. The first scene must end clean (tests pass, no "stopped"/error note): otherwise the
    // attempt is cut out of the video (and the screen reset) and the scene is taken again, up to three times.
    const testsPass = () => spawnSync('node', ['test.js'], { cwd: DIR }).status === 0;
    const trouble = () => a.ev(`/Stopped automatic attempts|AI error|AI 오류|Re-check model|모델 연결 다시/.test((document.querySelector('.timeline.active') || {}).innerText || '')`);
    await scene('1 the agent fixes a failing test', async () => {
      let clean = false;
      for (let attempt = 1; attempt <= 3 && !clean; attempt++) {
        const mark = rec.frames.length;
        await cursorTo(INPUT, 900);
        await typeSlow(T.fix); await zoomTo(CHAT, 1.4); await idle(); alive();
        let ok = testsPass() && !(await trouble());
        if (ok) {
          await pause(3500, 1.6);
          await typeSlow(T.again); await idle(); alive();
          ok = testsPass() && !(await trouble());
        }
        if (ok) { clean = true; await pause(3000, 1.2); await zoomReset(); break; }
        console.log(`  attempt ${attempt} did not end clean: it is cut from the video and taken again`);
        rec.paused = true; rec.typing = false;
        await zoomReset(300);
        rec.frames.length = mark; // the failed attempt disappears from the video
        await a.ev(`window.confirm = () => true; document.getElementById('btn-reset').click()`); await sleep(1800);
        prep(); await a.ev(`__ait.term.clear()`); await sleep(600);
        rec.paused = false;
      }
      result.push([clean, 'the agent fixed the bug and the tests pass (no loop, no give-up note)']);
    }, 1);

    if (FULL) {
      // ---- 2 terminal search (⌘F)
      await scene('2 terminal search', async () => {
        await a.ev(`__ait.openSearch()`);
        await a.ev(`(() => { const i = document.getElementById('ts-input'); i.value = 'FAIL'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await sleep(500); await pause(2400, 2.2);
        await a.ev(`__ait.closeSearch()`); await sleep(400);
      }, 2);

      // ---- 3 plan mode: the steps first, then run
      await scene('3 plan mode', async () => {
        await a.ev(`__ait.setPlan(true)`); await sleep(500); await pause(900, 0.9);
        await typeSlow(T.plan);
        await a.waitFor(`!!document.querySelector('.card.plan')`, 240000, 'plan card'); alive();
        await zoomTo('.card.plan', 1.7); await pause(4200, 3.0);
        await click('.card.plan .acts .btn.yes');
        await zoomReset(); await idle(); alive();
        await a.ev(`__ait.setPlan(false)`);
        await pause(2500, 1.2);
      }, 3);
    }

    // ---- 4 approval gate for a delete on this Mac
    await scene('4 approval before a delete', async () => {
      await typeSlow(T.del);
      await a.waitFor(`!document.getElementById('approval-bar').hidden`, 480000, 'approval bar'); alive();
      await pause(4500, 2.4); // read the choices
      await click('#ap-once');
      await idle(); alive();
      result.push([!fs.existsSync(path.join(DIR, 'tmp_shot.txt')), 'the file was deleted only after the approval']);
      await pause(3000, 1.2);
    }, 4);

    if (FULL) {
      // ---- 5 session history
      await scene('5 session history', async () => {
        await a.ev(`__panels.openHistory().then(() => 1)`); await sleep(900);
        await click('#hist-list .hitem'); await pause(2800, 2.4);
        await a.ev(`(() => { const q = document.getElementById('hist-q'); q.value = 'npm'; q.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await pause(1800, 1.4);
        await a.ev(`__panels.closeHistory()`); await sleep(500);
      }, 5);

      // ---- 6 model chip and settings
      await scene('6 model and settings', async () => {
        await click('#model'); await pause(3500, 2.6);
        await a.ev(`document.body.click()`); await sleep(700);
        await click('#btn-settings'); await zoomTo('#settings-modal .sm-dialog', 1.2); await pause(2200, 1.3);
        for (let i = 0; i < 6; i++) {
          await a.ev(`(() => { const d = [...document.querySelectorAll('#settings-modal *')].find((e) => e.scrollHeight > e.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(e).overflowY)); if (d) d.scrollTop += 140; })()`);
          await pause(650, 0.55);
        }
        await a.ev(`__panels.closeSettings()`); await zoomReset(); await sleep(600);
      }, 6);

      // ---- 7 a second shell next to the first
      await scene('7 split panes', async () => {
        await a.ev(`__ait.toggleSplit().then(() => 1)`);
        await a.waitFor(`document.querySelectorAll('.term-wrap.active .pane').length === 2`, 15000, 'two panes');
        await sleep(900);
        await a.ev(`document.querySelector('.term-wrap.active .pane-second .xterm-helper-textarea').focus()`);
        rec.typing = true;
        for (const ch of 'ls src') { await a.ev(`__ait.term.input(${JSON.stringify(ch)}, true)`); await sleep(110); }
        rec.typing = false;
        await a.ev(`__ait.term.input('\\r', true)`);
        await pause(2200, 2.0);
        await a.ev(`__ait.toggleSplit().then(() => 1)`);
        await a.waitFor(`document.querySelectorAll('.term-wrap.active .pane').length === 1`, 15000, 'single pane');
        await pause(500, 0.4);
      }, 7);

      // ---- 8 saved sessions (example servers only; nothing is ever connected to them)
      await scene('8 saved sessions', async () => {
        await a.ev(`(async () => {
          const s = (o) => window.ait.sessSave({ keepAlive: true, share: true, x11: 'off', forwards: [], ...o });
          await s({ name: 'build-box', folder: ${JSON.stringify(T.work)}, host: 'build.example.com', user: 'deploy', port: 22, jump: 'bastion@203.0.113.5' });
          await s({ name: 'db-staging', folder: ${JSON.stringify(T.work)}, host: '203.0.113.20', user: 'admin', port: 2222, forwards: [{ kind: 'L', listenPort: 5433, host: 'localhost', port: 5432 }] });
          await s({ name: 'home-nas', folder: ${JSON.stringify(T.personal)}, host: 'nas.example.org', user: 'me', port: 22 });
        })()`);
        await click('.act[data-pane="sessions"]');
        await pause(3600, 3.0);
      }, 8);
    }

    if (serverPart) {
      console.log(`# 9 ssh ${ALIAS}`);
      await caption(T.cap[9]); await zoomReset(); await hidePointer();
      await a.ev(`__ait.setMode('shell')`);
      const cmd = `ssh ${ALIAS}`;
      rec.typing = true;
      for (const ch of cmd) { await a.ev(`__ait.term.input(${JSON.stringify(ch)}, true)`); await sleep(110); }
      rec.typing = false;
      await sleep(900);
      await a.ev(`window.__curtain(true, ${JSON.stringify(T.conn)})`); // the login banner, host name and home folder are never on screen
      await a.ev(`__ait.term.input('\\r', true)`);
      await a.waitFor(`!document.getElementById('ssh-chip').hidden`, 90000, 'ssh chip');
      await a.waitFor(`document.querySelector('#rmon .rcpu') && !document.querySelector('#rmon .rcpu').hidden`, 90000, 'server monitor');
      await sleep(1500);
      await a.ev(`__ait.term.input(${JSON.stringify(`export PS1='demo@${ALIAS}:\\w$ ' LC_ALL=C.UTF-8 LANG=C.UTF-8\r`)}, true)`); await sleep(600);
      await a.ev(`__ait.term.input(${JSON.stringify(`cd ${SRV}\r`)}, true)`); await sleep(700);
      await a.ev(`__ait.term.clear()`);
      await click('.act[data-pane="files"]'); // the sessions list is closed again, the file trees open
      await a.ev(`(() => { const i = document.querySelector('.fpane[data-side="remote"] .fpath'); if (i) { i.value = ${JSON.stringify(SRV)}; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true })); } })()`);
      await a.waitFor(`!!${rowOf('remote', SRV + '/logs')}`, 30000, 'the demo folder in the file tree');
      await sleep(1200);
      const clean = await a.ev(`(() => { const t = document.body.innerText.toLowerCase(); return !${JSON.stringify(secrets)}.some((s) => t.includes(s)); })()`);
      if (!clean) { console.log('  ! the window still showed a private name: staying covered for safety'); }
      else await a.ev(`window.__curtain(false)`);
      await zoomTo({ fx: 0, fy: 0.04, fw: 0.55, fh: 0.62 }, 1.5); await pause(3500, 2.2); // the server strip and the file trees
      await zoomReset();

      await scene('10 drag and drop between the Mac and the server', async () => {
        await zoomTo({ fx: 0, fy: 0.36, fw: 0.55, fh: 0.64 }, 1.6);
        await a.ev(`${rowOf('remote', SRV + '/projects')}.querySelector('.fcaret').click()`);
        await a.waitFor(`!!${rowOf('remote', SRV + '/projects/trainer')}`, 15000, 'projects folder');
        await pause(1200, 1.0);
        const up = await dnd('local', path.join(DIR, 'notes.txt'), 'remote', SRV + '/projects/trainer'); await pause(2800, 2.0);
        const down = await dnd('remote', SRV + '/notes.txt', 'local', path.join(DIR, 'src')); await pause(3200, 2.4);
        if (up !== 'ok' || down !== 'ok') throw new Error(`drag and drop: ${up}, ${down}`);
        result.push([/notes.txt/.test(remote(`ls '${SRV}/projects/trainer'`).stdout) && fs.existsSync(path.join(DIR, 'src', 'notes.txt')), 'files were copied both ways']);
        await zoomReset();
      }, 10);

      await scene('11 server status', async () => {
        await click('.act[data-pane="status"]');
        await a.waitFor(`/CPU/.test(document.getElementById('sp-status').innerText)`, 20000, 'status panel');
        await zoomTo({ fx: 0, fy: 0.04, fw: 0.5, fh: 0.75 }, 1.4);
        await pause(12000, 4.0); // the graphs fill with real samples
        await zoomReset(); await click('.act[data-pane="files"]'); await sleep(500);
      }, 11);

      const offer = await a.ev(`!!document.querySelector('.timeline.active .note button.btn.primary')`);
      if (offer) await click('.timeline.active .note button.btn.primary'); else await a.ev(`window.AITCore.setRemote(true)`);
      await a.waitFor(`/· AI/.test(document.getElementById('ssh-chip').innerText)`, 60000, 'remote on');
      await sleep(700); await a.ev(`__ait.term.clear()`); // the app's own probe lines are not part of the story
      await sleep(1800);
      await scene('12 the agent on the server', async () => {
        await cursorTo(INPUT, 800);
        await typeSlow(T.gpu); await zoomTo(CHAT, 1.4); await aiIdle(); alive();
        await pause(3500, 1.8); await a.ev(`__ait.term.clear()`); // the command's raw output was on screen long enough; tidy the marker line the app adds
        await sleep(1500);
      }, 12);
      await scene('13 approval naming the server', async () => {
        await typeSlow(T.rmlog);
        await a.waitFor(`!document.getElementById('approval-bar').hidden`, 480000, 'server approval'); alive();
        await pause(5000, 2.6);
        await click('#ap-no');
        await aiIdle(120000).catch(() => {}); alive();
        result.push([/old-2026-09-12/.test(remote(`ls '${SRV}/logs'`).stdout), 'the server file is still there after "deny"']);
        await pause(4000, 1.5); await zoomReset();
      }, 13);
      // leave the server: the closing line names the host, so the window is covered again for it
      await caption(''); await zoomReset(); await hidePointer();
      await a.ev(`window.__curtain(true, ${JSON.stringify(T.back)})`);
      await a.ev(`__ait.setMode('shell')`);
      await a.ev(`__ait.term.input('exit\\r', true)`);
      await a.waitFor(`document.getElementById('ssh-chip').hidden`, 30000).catch(() => {});
      await sleep(1500); await a.ev(`__ait.term.clear()`);
      await a.ev(`window.__curtain(false)`);
      await pause(3000, 1.4);
    }
    await caption(''); await zoomReset(); await hidePointer();
    await showCard(cardHtml(T.outro1, T.outro2), 3.6, false); // end card
    if (skipped.length) result.push([false, `scenes skipped: ${skipped.join(', ')}`]);
    } // end of the tour

    const leaks = await a.ev(`window.__leaks`);
    let recorded = null;
    if (RECORD) {
      await rec.snap(2.0); await rec.stop();
      console.log(`\nrecording finished: ${rec.frames.length} pictures; encoding …`);
      const out = encode();
      const ocr = ocrCheck(out.list);
      recorded = { seconds: out.seconds, ocr };
      if (ocr.ok === false || leaks) { const bad = OUT.replace(/\.mp4$/, '') + '-CHECK-PRIVACY.mp4'; fs.renameSync(OUT, bad); recorded.file = bad; } else recorded.file = OUT;
      fs.rmSync(rec.dir, { recursive: true, force: true });
    }
    console.log(RECORD ? '\nDONE: the recording is finished; the window closes in a few seconds.' : '\nDONE: you can stop the recording now. The window stays open for 20 s.');
    sound('Glass'); await sleep(900); sound('Glass');
    console.log('\nResult of this take:');
    for (const [ok, what] of result) console.log(`  ${ok ? '✓' : '✗'} ${what}`);
    if (recorded) {
      console.log(`  ${recorded.ocr.ok === false ? '✗' : '✓'} OCR check of the video: ${recorded.ocr.ok === null ? 'skipped (swiftc is not available)' : recorded.ocr.ok ? `no account / host name readable in ${recorded.ocr.n} pictures` : 'an account / host name is READABLE: the file is marked CHECK-PRIVACY, do not publish it'}`);
      console.log(`  ✓ video: ${recorded.file}  (${recorded.seconds.toFixed(0)} s, ${(fs.statSync(recorded.file).size / 1e6).toFixed(1)} MB)`);
    }
    console.log(leaks ? `  ✗ ${leaks} moment(s) when a private name or an address reached the screen (the window was covered; check that part of the recording and take it again)` : '  ✓ no account / host name or IP address reached the screen');
    if (result.some(([ok]) => !ok) || leaks) console.log('  → run the demo again for another take.');
    await sleep(RECORD ? 4000 : 20000);
    if (recorded && recorded.file) { try { execFile('open', ['-R', recorded.file], () => {}); } catch { /* Finder is optional */ } }
  } finally {
    try { await a.ev(`window.__curtain(true, '')`); } catch { /* window gone */ }
    a.close();
    if (srvMade) { const rm = remote(`rm -rf '${SRV}' && test ! -e '${SRV}' && echo gone`); console.log(/gone/.test(rm.stdout) ? 'server demo folder removed' : '!! server demo folder NOT removed: ' + SRV); }
    if (cfgDir) fs.rmSync(cfgDir, { recursive: true, force: true });
    process.exit(0);
  }
})().catch((e) => { console.error(e); process.exit(1); });
