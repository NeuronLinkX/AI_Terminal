#!/usr/bin/env node
'use strict';
// Live, real-time demo of the core features for someone who is screen-recording the window themselves.
// Real shell, real local model, real approval flow — nothing is time-lapsed or faked; pauses are long enough to read.
//   1. starts the app in a throw-away profile (no history / settings / keys) on a throw-away project, neutral prompt
//   2. warms the model up, resets the session, then WAITS for the file /private/tmp/ait-demo-go
//      (start your screen recording, then:  touch /private/tmp/ait-demo-go)
//   3. runs the demo (~80 s): failing test fixed by the agent → approval gate for a delete → model chip + KV settings
//
//   AIT_APP_BIN="/Applications/MacAIterm.app/Contents/MacOS/MacAIterm" node scripts/demo-live.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = '/private/tmp/ait-live-demo';
process.env.AIT_E2E_WS = DIR; // e2e.js reads it on load
process.env.AIT_DOC_PROMPT = process.env.AIT_DOC_PROMPT || '%F{green}user@mac%f %F{blue}%~%f %# ';
const { launch, sleep, privacyHits } = require('./e2e');

const SIZE = process.env.AIT_WIN_SIZE || '1360x860';
const GO = '/private/tmp/ait-demo-go';
const PROFILE = '/private/tmp/ait-demo-profile';

/** (Re)writes the throw-away project. The folder itself is never removed: the app's shell is standing in it. */
function prep() {
  fs.mkdirSync(path.join(DIR, 'src'), { recursive: true });
  const files = {
    'package.json': '{"name":"demo-app","version":"1.0.0","scripts":{"test":"node test.js"}}\n',
    'notes.txt': 'meeting notes\n',
    'tmp_shot.txt': 'temporary file\n',
    'src/util.js': 'function add(a, b) { return a - b; }   // BUG: should add\nmodule.exports = { add };\n',
    'test.js': "const { add } = require('./src/util');\nif (add(2, 3) !== 5) { console.error('FAIL: add(2,3) expected 5 got ' + add(2, 3)); process.exit(1); }\nconsole.log('ok');\n",
  };
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(DIR, f), c);
  if (!fs.existsSync(path.join(DIR, '.git'))) { try { const g = (...a) => execFileSync('git', a, { cwd: DIR, stdio: 'ignore' }); g('init', '-q'); g('add', '-A'); g('-c', 'user.name=demo', '-c', 'user.email=demo@example.com', 'commit', '-qm', 'init'); } catch { /* git is optional */ } }
}

(async () => {
  fs.rmSync(GO, { force: true });
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.rmSync(DIR, { recursive: true, force: true }); // fresh project before the app starts
  prep();
  const a = await launch({ AIT_WIN_SIZE: SIZE }, PROFILE);
  const watch = { on: true };
  let appGone = false;
  a.proc.on('exit', () => { appGone = true; });
  const alive = () => { if (appGone) { console.log('\nABORTED: the demo window was closed (the app quits when its window closes). Nothing was demonstrated — start again.'); process.exit(2); } };
  try {
    await a.waitFor(`document.getElementById('model-text').textContent.length > 0 && !/확인 중/.test(document.getElementById('model-text').textContent)`, 40000, 'model chip');
    if ((await a.ev(`document.documentElement.dataset.theme`)) !== 'dark') { await a.ev(`document.getElementById('btn-theme').click()`); await sleep(500); }
    await a.waitFor(`__ait.state.pty === 'prompt'`, 20000, 'shell prompt');

    const idle = (ms = 240000) => a.waitFor(`document.getElementById('state').dataset.phase === 'idle' && !__ait.state.aiBusy`, ms, 'AI idle');
    const typeSlow = async (text, perChar = 60) => {
      await a.ev(`__ait.setMode('ai')`);
      for (const ch of text) { await a.ev(`(() => { __ait.input.value += ${JSON.stringify(ch)}; __ait.input.dispatchEvent(new Event('input', { bubbles: true })); })()`); await sleep(perChar); }
      await sleep(900);
      await a.ev(`__ait.submit()`);
    };

    // warm-up: load the model (and the private KV engine) now so the recorded run starts at full speed, then start clean
    console.log('warming up the model …');
    await a.ev(`(() => { __ait.setMode('ai'); __ait.input.value = '준비 확인: ok 라고만 답해줘.'; __ait.submit(); })()`);
    await sleep(800); await idle(300000);
    await a.ev(`window.confirm = () => true; document.getElementById('btn-reset').click()`); await sleep(1500);
    prep(); // same files again (the warm-up may have touched nothing, this just guarantees the starting state)
    await sleep(500);

    // every few seconds: nothing personal (account / host name) or key-like on screen
    (async () => { while (watch.on) { try { await a.scan('demo'); } catch { /* window closing */ } await sleep(3000); } })();
    if (privacyHits.length) console.log('PRIVACY WARNING before start:', privacyHits.join(' | '));

    console.log(`\nREADY — the app window is up. Start your screen recording, then run:\n  touch ${GO}\n`);
    const waitStart = Date.now();
    if (process.env.AIT_AUTOSTART) { console.log(`READY — the demo starts by itself in ${process.env.AIT_AUTOSTART} s`); fs.writeFileSync(GO + '.auto', ''); setTimeout(() => fs.writeFileSync(GO, ''), Number(process.env.AIT_AUTOSTART) * 1000); }
    while (!fs.existsSync(GO)) { alive(); if (Date.now() - waitStart > 45 * 60 * 1000) { console.log('no go signal for 45 minutes — closing'); return; } await sleep(400); }
    fs.rmSync(GO, { force: true });
    console.log('GO — demo running (real time)');

    await sleep(4000); // a moment of the clean window

    alive();
    console.log('# 1 coding agent');
    await typeSlow('npm test가 실패해. 원인을 찾아서 수정해줘.');
    await idle(); alive();
    const fixed = /a \+ b/.test(fs.readFileSync(path.join(DIR, 'src', 'util.js'), 'utf8'));
    console.log(fixed ? '  ✓ the agent fixed the bug and re-ran the tests' : '  ✗ TAKE FAILED: the bug is not fixed (ask for another take)');
    await sleep(5000);

    alive();
    console.log('# 2 approval gate');
    await typeSlow('tmp_shot.txt 파일을 삭제해줘.');
    await a.waitFor(`!document.getElementById('approval-bar').hidden`, 240000, 'approval bar'); alive();
    await sleep(4500); // read the choices
    await a.ev(`document.getElementById('ap-once').click()`);
    await idle();
    console.log(fs.existsSync(path.join(DIR, 'tmp_shot.txt')) ? '  ✗ the file still exists' : '  ✓ file deleted after the approval');
    await sleep(4000);

    alive();
    console.log('# 3 model chip + settings');
    await a.ev(`document.getElementById('model').click()`); await sleep(4000); await a.ev(`document.body.click()`); await sleep(1200);
    await a.ev(`document.getElementById('btn-settings').click()`); await sleep(2500);
    for (let i = 0; i < 8; i++) {
      await a.ev(`(() => { const d = [...document.querySelectorAll('#settings-modal *')].find((e) => e.scrollHeight > e.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(e).overflowY)); if (d) d.scrollTop += 100; })()`);
      await sleep(650);
    }
    await sleep(3000);
    await a.ev(`__panels.closeSettings()`); await sleep(2500);

    console.log('DONE — you can stop the recording. The window stays open for 25 s.');
    await sleep(25000);
  } finally {
    watch.on = false;
    a.close();
    if (privacyHits.length) console.log('\nPRIVACY — something personal was visible during the run:\n  ' + [...new Set(privacyHits)].join('\n  '));
    else console.log('privacy scan: nothing personal or key-like was visible');
    process.exit(0);
  }
})().catch((e) => { console.error(e); process.exit(1); });
