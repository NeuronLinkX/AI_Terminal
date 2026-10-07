#!/usr/bin/env node
'use strict';
// Screenshot of the remote screen (VNC) for the website: site/assets/img/site-vnc.png (English UI) or ko/site-vnc.png (SHOTS_LANG=ko).
// The scene: a tab on a server, the server's desktop in the window, and the AI chat answering "open a terminal window and type whoami"
// with a shell command (the AI cannot operate the screen).
//
//   Needs a login to the server that is ALREADY OPEN (the app's shared connection, see docs/SSH.md): this script never asks for or
//   types a password. It starts ONE throw-away VNC server (:2, loopback only, random one-off password that is never printed), opens
//   a file manager window on it, and removes everything again.
//   node scripts/shots-site-vnc.js [ssh-alias]            (default alias: H_ubuntu; SHOTS_LANG=ko for the Korean edition)
// The image is scanned for this Mac's account / host name in the page text; run scripts/ocr-check.swift over it as well.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const LANG = process.env.SHOTS_LANG === 'ko' ? 'ko' : 'en';
process.env.AIT_LANG = LANG;
process.env.AIT_THEME = 'light';
process.env.AIT_SHOT_DIR = process.env.AIT_SHOT_DIR || '/private/tmp/ait-site-shots-vnc';
const { launch, check, results, sleep, ask, typeInTerm, privacyHits, OUT } = require('./e2e');
const { CTL_DIR } = require('../src/main/sshlink');

const ALIAS = (process.argv[2] || 'H_ubuntu').replace(/[^A-Za-z0-9._-]/g, '');
const T = { en: { prompt: 'Open a terminal window and type whoami.', noteRe: /Memory|KV cache/i, alias: 'Let the AI work here' }, ko: { prompt: 'terminal 창을 켜서 whoami를 입력해봐.', noteRe: /메모리|KV/, alias: 'AI 를 서버에서 작업시키기' } }[LANG];
const LOC = '/private/tmp/ait-demo-local';
const PW = crypto.randomBytes(4).toString('hex'); // 8 characters, this run only, never printed
const SSH = ['-o', 'ControlMaster=no', '-o', `ControlPath=${CTL_DIR}/%C`, '-o', 'BatchMode=yes'];
const vm = (cmd, input) => spawnSync('ssh', [...SSH, ALIAS, cmd], { input, encoding: 'utf8', timeout: 120000 });
const put = (f, c) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); };

// the real names that must not be on screen (page text is replaced right before the capture; the desktop picture is OCR-checked)
const secret = [os.userInfo().username, os.hostname().split('.')[0]].filter((x) => x && x.length > 2);
const redact = (a) => a.ev(`(() => { const pairs = ${JSON.stringify(secret.map((k, i) => [k, i ? 'mac' : 'user']))}; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); const ns = []; while (w.nextNode()) ns.push(w.currentNode);
  for (const t of ns) { let v = t.nodeValue; for (const [k, r] of pairs) v = v.split(k).join(r); if (v !== t.nodeValue) t.nodeValue = v; }
  document.querySelectorAll('[title]').forEach((e) => { let v = e.title; for (const [k, r] of pairs) v = v.split(k).join(r); if (v !== e.title) e.title = v; }); })()`);
const leaks = async (a) => { await redact(a); const dom = await a.ev('document.body.innerText'); return secret.filter((s) => dom.toLowerCase().includes(s.toLowerCase())).length; };

let cleaned = false;
const cleanup = () => {
  if (cleaned) return; cleaned = true;
  const r = vm('vncserver -kill :2 >/dev/null 2>&1; rm -f /tmp/ait-vnc-shot.passwd ~/.config/tigervnc/*:2.log ~/.config/tigervnc/*:2.pid; ss -ltn | grep -c ":5902 " || true');
  console.log('server cleaned up, listeners left on 5902:', String(r.stdout).trim());
};
process.on('exit', cleanup);

(async () => {
  if (spawnSync('ssh', ['-O', 'check', '-o', `ControlPath=${CTL_DIR}/%C`, ALIAS], { encoding: 'utf8' }).status !== 0) {
    console.log(`No open login to "${ALIAS}". Connect once in the app (session menu), keep that tab open, and run this again. Nothing was done.`);
    process.exit(2);
  }
  fs.rmSync(LOC, { recursive: true, force: true });
  put(path.join(LOC, 'dataset.csv'), Array.from({ length: 50 }, (_, i) => `${i},${i * 7 % 13}`).join('\n') + '\n');
  put(path.join(LOC, 'config.yaml'), 'port: 8080\n');
  put(path.join(LOC, 'photos/team.txt'), 'team photo placeholder\n');
  fs.mkdirSync(path.join(LOC, 'Documents'), { recursive: true });
  fs.mkdirSync(path.join(LOC, 'Downloads'), { recursive: true });
  const a = await launch({ AIT_NO_KEYCHAIN: '1', AIT_WIN_SIZE: process.env.AIT_WIN_SIZE || '1680x1080', AIT_CWD: LOC, AIT_LLM: 'ollama' });
  try {
    await a.waitFor(`__ait.state.pty === 'prompt'`, 40000, 'prompt');
    await a.ev(`(async () => { await window.AITCore.newTab({ fromActive: false }); return 1; })()`);
    await a.waitFor(`__ait.order().length === 2 && __ait.state.pty === 'prompt'`, 30000, 'second tab');
    await typeInTerm(a, `ssh ${SSH.join(' ')} ${ALIAS}\r`);
    await a.waitFor(`!document.getElementById('ssh-chip').hidden`, 40000, 'ssh chip');
    // the AI works on the server (the app offers it; one click)
    await a.waitFor(`[...document.querySelectorAll('.timeline.active .btn.primary')].some((b) => ${JSON.stringify(T.alias)} && b.innerText.includes(${JSON.stringify(T.alias)}))`, 40000, 'offer');
    await a.ev(`[...document.querySelectorAll('.timeline.active .btn.primary')].find((b) => b.innerText.includes(${JSON.stringify(T.alias)})).click()`);
    await a.waitFor(`AITCore.getTab().remote === true`, 40000, 'remote mode');

    // the AI chat: it answers with a shell command, it does not operate the screen
    let ran = false;
    for (let i = 0; i < 3 && !ran; i++) {
      await ask(a, T.prompt);
      await a.waitFor(`!__ait.state.aiBusy`, 240000, 'AI idle');
      ran = await a.ev(`[...document.querySelectorAll('.timeline.active .card.cmd')].some((c) => /whoami/.test(c.innerText))`);
    }
    check('chat: the AI ran whoami in the server shell', ran);
    await a.ev(`document.querySelectorAll('.timeline.active .note').forEach((n) => { if (${T.noteRe}.test(n.innerText)) n.remove(); })`); // memory advice of THIS Mac is not part of the product

    // the screen: measure the area, start a throw-away desktop of that size, connect
    await a.ev(`document.getElementById('btn-screen').click()`);
    await a.waitFor(`!!document.querySelector('.vnc-wrap') && !document.querySelector('.vnc-wrap').hidden`, 8000, 'view').catch(async (e) => {
      console.log('debug:', JSON.stringify(await a.ev(`({ btnHidden: document.getElementById('btn-screen').hidden, views: AITVnc.views.size, active: AITCore.getTab().id, ssh: !!(AITSsh.S.tabs.get(AITCore.getTab().id) || {}).ssh, wraps: document.querySelectorAll('.vnc-wrap').length })`)));
      throw e;
    });
    const box = await a.ev(`(() => { const s = document.querySelector('.vnc-screen'); return { w: s.clientWidth, h: s.clientHeight }; })()`);
    const W = box.w - (box.w % 2); const H = box.h - (box.h % 2);
    let r = vm('umask 077; vncpasswd -f > /tmp/ait-vnc-shot.passwd', PW + '\n');
    check('server: one-off password file created (not shown)', r.status === 0);
    r = vm(`vncserver -localhost yes -geometry ${W}x${H} -PasswordFile /tmp/ait-vnc-shot.passwd :2 2>&1 | head -3`);
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { up = /127\.0\.0\.1:5902/.test(String(vm('ss -ltn').stdout)); if (!up) await sleep(1000); }
    check(`server: throw-away desktop ${W}x${H} is listening`, up);
    if (!up) throw new Error('no vnc server');
    // a file manager window on that clean throw-away desktop (nothing of the server's own settings is changed)
    vm(`export DISPLAY=:2; nohup thunar /home/ubuntu >/dev/null 2>&1 &`);
    await sleep(4000);
    await a.ev(`(() => { const v = AITVnc.views.get(AITCore.getTab().id); v.port.value = '5902'; v.go.click(); })()`);
    await a.waitFor(`!!document.querySelector('.ait-modal .sm-dialog input[type="password"]')`, 30000, 'password dialog');
    await a.ev(`(() => { const i = document.querySelector('.ait-modal .sm-dialog input[type="password"]'); i.value = ${JSON.stringify(PW)}; [...document.querySelectorAll('.ait-modal .sm-dialog .btn.primary')].pop().click(); })()`);
    await a.waitFor(`AITVnc.views.get(AITCore.getTab().id).state === 'connected'`, 30000, 'connected');
    const colours = () => a.ev(`(() => { const c = AITVnc.views.get(AITCore.getTab().id).screen.querySelector('canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; const s = new Set(); for (let i = 0; i < d.length; i += 4 * 97) s.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]); return s.size; })()`);
    let n = 0;
    for (let i = 0; i < 40 && n < 40; i++) { n = await colours(); if (n < 40) await sleep(1000); }
    check('screen: the desktop with wallpaper and a window is drawn', n >= 40, `${n} colours`);
    await a.ev(`AITVnc.views.get(AITCore.getTab().id).auto.click()`); // show the "open on connect" option as switched on
    await sleep(2500);
    const hits = await leaks(a);
    check('page text: this Mac\'s account / host name are not on screen', hits === 0, `${hits} hit(s)`);
    await a.shot('site-vnc');
    console.log(`saved ${path.join(OUT, 'site-vnc.png')}`);
    await a.ev(`AITVnc.views.get(AITCore.getTab().id).go.click()`);
    await sleep(800);
  } catch (e) {
    check('scene completed', false, String(e.message).slice(0, 300));
  } finally {
    cleanup();
    a.close();
  }
  const bad = results.filter((x) => !x.ok).length + privacyHits.length;
  console.log(`\n${results.length - bad}/${results.length} ok`);
  process.exit(bad ? 1 : 0);
})();
