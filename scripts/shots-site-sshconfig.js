#!/usr/bin/env node
'use strict';
// Screenshot of the ~/.ssh/config editor for the website: site/assets/img/site-ssh-config.png (English) or ko/ (SHOTS_LANG=ko).
// Works on a TEMPORARY .ssh folder with neutral example hosts (documentation addresses), so no real host, account or key is shown, and
// connects to nothing.   node scripts/shots-site-sshconfig.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const LANG = process.env.SHOTS_LANG === 'ko' ? 'ko' : 'en';
process.env.AIT_LANG = LANG;
process.env.AIT_THEME = 'light';
process.env.AIT_DOC_PROMPT = process.env.AIT_DOC_PROMPT || 'demo@mac %1~ %# '; // a neutral prompt: the real account / host name never appear in the terminal
process.env.AIT_SHOT_DIR = process.env.AIT_SHOT_DIR || '/private/tmp/ait-site-shots-sshconfig';
const { launch, check, results, sleep, privacyHits, OUT } = require('./e2e');

const T = { en: { check: 'Check syntax', ok: /syntax is valid/i, edit: 'Edit ~/.ssh/config' }, ko: { check: '문법 검사', ok: /문법이 올바릅니다/, edit: '~/.ssh/config 편집' } }[LANG];
const LOC = '/private/tmp/ait-demo-local';
const CONFIG = `# Servers I work on
Host gpu-server
  HostName 192.0.2.10
  User demo
  IdentityFile ~/.ssh/id_ed25519
  ServerAliveInterval 30

Host build-box
  HostName 192.0.2.20
  User demo
  ProxyJump bastion

Host bastion
  HostName 192.0.2.5
  User demo
  Port 2222

Host github.com
  HostName github.com
  User git
`;
const secret = [os.userInfo().username, os.hostname().split('.')[0]].filter((x) => x && x.length > 2);

(async () => {
  fs.rmSync(LOC, { recursive: true, force: true });
  fs.mkdirSync(path.join(LOC, 'Documents'), { recursive: true });
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ait-shot-ssh-')));
  const dir = path.join(home, '.ssh');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'config'), CONFIG, { mode: 0o600 });
  const a = await launch({ AIT_NO_KEYCHAIN: '1', AIT_WIN_SIZE: process.env.AIT_WIN_SIZE || '1680x1080', AIT_CWD: LOC, AIT_SSH_DIR: dir });
  try {
    await a.waitFor(`__ait.state.pty === 'prompt'`, 40000, 'prompt');
    await a.ev(`document.querySelector('.act[data-pane="sessions"]').click()`);
    await a.waitFor(`[...document.querySelectorAll('#sp-sessions .sess-row')].some((r) => r.innerText.includes('gpu-server'))`, 10000, 'hosts');
    await a.ev(`(() => { const r = [...document.querySelectorAll('#sp-sessions .sess-row')].find((x) => x.innerText.includes('gpu-server')); [...r.querySelectorAll('.sact')].find((b) => b.title === ${JSON.stringify(T.edit)}).click(); })()`);
    await a.waitFor(`!!document.querySelector('.cfg-editor .cfg-text')`, 8000, 'editor');
    await a.waitFor(`(() => { const t = document.querySelector('.cfg-text'); return t.selectionEnd > t.selectionStart; })()`, 4000, 'host selected').catch(() => {});
    await a.ev(`[...document.querySelectorAll('.cfg-editor .sm-foot .btn')].find((b) => b.innerText.includes(${JSON.stringify(T.check)})).click()`);
    await a.waitFor(`${T.ok}.test(document.querySelector('.cfg-status').innerText)`, 8000, 'syntax ok');
    // the temporary folder is not part of the picture: the file is shown as ~/.ssh/config (the real app's title already is "Edit ~/.ssh/config", so the ' · <path>' tail goes)
    await a.ev(`(() => { const tmp = ${JSON.stringify(path.join(dir, 'config'))}; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); const ns = []; while (w.nextNode()) ns.push(w.currentNode); for (const n of ns) if (n.nodeValue.includes(tmp)) n.nodeValue = n.nodeValue.split(' · ' + tmp).join('').split(tmp).join('~/.ssh/config'); document.querySelectorAll('[aria-label]').forEach((e) => { if (e.getAttribute('aria-label').includes(tmp)) e.setAttribute('aria-label', '~/.ssh/config'); }); })()`);
    const dom = await a.ev('document.body.innerText + document.querySelector(".cfg-text").value');
    const leaks = secret.filter((s) => dom.toLowerCase().includes(s.toLowerCase()));
    check('page text: this Mac\'s account / host name are not on screen', leaks.length === 0, `${leaks.length} hit(s)`);
    check('page text: the temporary folder is not on screen', !/ait-shot-ssh/.test(dom));
    await sleep(600);
    await a.shot('site-ssh-config');
    console.log(`saved ${path.join(OUT, 'site-ssh-config.png')}`);
  } catch (e) {
    check('scene completed', false, String(e.message).slice(0, 300));
  } finally {
    a.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
  const bad = results.filter((x) => !x.ok).length + privacyHits.length;
  console.log(`${results.length - bad}/${results.length} ok`);
  process.exit(bad ? 1 : 0);
})();
