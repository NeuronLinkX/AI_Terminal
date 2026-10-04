#!/usr/bin/env node
'use strict';
// Runs ONE request live in the real app window on the real machine, for a person who is watching.
// The app starts in a throw-away profile (your settings and history are not touched) inside TASK_DIR, the request is typed
// in at a readable pace, and the script then reports what the agent does. It never approves anything by itself:
// when the agent asks for approval the command is printed and the script waits for a decision file.
//
//   TASK_DIR=/path/to/project TASK_TEXT="…" AIT_APP_BIN="/Applications/AI Terminal.app/Contents/MacOS/AI Terminal" node scripts/live-task.js
//   approve / deny:  echo once > /private/tmp/ait-live-decision      (or `no`)
//   close the window when done:  touch /private/tmp/ait-live-stop
const fs = require('fs');

const DIR = process.env.TASK_DIR;
const TEXT = process.env.TASK_TEXT;
if (!DIR || !TEXT) { console.error('TASK_DIR and TASK_TEXT are required'); process.exit(2); }
process.env.AIT_E2E_WS = DIR; // e2e.js reads it on load and starts the shell there
const { launch, sleep } = require('./e2e');

const DECISION = '/private/tmp/ait-live-decision';
const STOP = '/private/tmp/ait-live-stop';
const PROFILE = '/private/tmp/ait-live-profile';

(async () => {
  for (const f of [DECISION, STOP]) fs.rmSync(f, { force: true });
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const a = await launch({ AIT_WIN_SIZE: process.env.AIT_WIN_SIZE || '1400x880' }, PROFILE);
  let gone = false;
  a.proc.on('exit', () => { gone = true; });
  try {
    await a.waitFor(`document.getElementById('model-text').textContent.length > 0 && !/확인 중/.test(document.getElementById('model-text').textContent)`, 40000, 'model chip');
    if ((await a.ev(`document.documentElement.dataset.theme`)) !== 'dark') { await a.ev(`document.getElementById('btn-theme').click()`); await sleep(500); }
    await a.waitFor(`__ait.state.pty === 'prompt'`, 20000, 'shell prompt');
    console.log('window is up — typing the request');
    await sleep(2500);
    await a.ev(`__ait.setMode('ai')`);
    for (const ch of TEXT) { await a.ev(`(() => { __ait.input.value += ${JSON.stringify(ch)}; __ait.input.dispatchEvent(new Event('input', { bubbles: true })); })()`); await sleep(55); }
    await sleep(1200);
    await a.ev(`__ait.submit()`);
    console.log('request sent: ' + TEXT);

    let lastCards = '';
    let askedFor = '';
    const t0 = Date.now();
    while (!gone && Date.now() - t0 < 25 * 60 * 1000) {
      const st = await a.ev(`({ busy: !!__ait.state.aiBusy, phase: document.getElementById('state').dataset.phase, ap: !document.getElementById('approval-bar').hidden, cmd: (document.getElementById('ap-cmd')||{}).textContent||'', why: (document.getElementById('ap-why')||{}).textContent||'' })`);
      // progress: print the titles of timeline cards as they appear
      const cards = await a.ev(`[...document.querySelectorAll('.timeline.active > *')].map((e) => (e.className.split(' ')[0] || 'x') + ': ' + e.innerText.replace(/\\s+/g, ' ').slice(0, 150)).join('\\n')`);
      if (cards !== lastCards) { const old = lastCards.split('\n'); for (const l of cards.split('\n')) if (!old.includes(l)) console.log('  ' + l); lastCards = cards; }
      if (st.ap && st.cmd !== askedFor) {
        askedFor = st.cmd;
        console.log(`\nAPPROVAL NEEDED\n  command: ${st.cmd}\n  why: ${st.why}\n  → decide with:  echo once > ${DECISION}   (or: echo no > ${DECISION})\n`);
      }
      if (st.ap && fs.existsSync(DECISION)) {
        const d = fs.readFileSync(DECISION, 'utf8').trim(); fs.rmSync(DECISION, { force: true });
        console.log(`decision: ${d}`);
        await a.ev(`document.getElementById(${JSON.stringify(d === 'once' ? 'ap-once' : 'ap-no')}).click()`);
        askedFor = '';
      }
      if (!st.busy && !st.ap && st.phase === 'idle' && Date.now() - t0 > 5000) break;
      await sleep(1000);
    }
    if (gone) { console.log('\nTHE WINDOW WAS CLOSED before the agent finished.'); process.exit(3); }
    console.log('\nAGENT FINISHED. Summary shown in the window:');
    console.log('  ' + (await a.ev(`document.querySelector('.timeline.active').innerText.split('\\n').filter(Boolean).slice(-6).join(' | ')`)).slice(0, 600));
    console.log(`\nThe window stays open. Close it with:  touch ${STOP}   (auto-closes after 30 minutes)`);
    const t1 = Date.now();
    while (!gone && !fs.existsSync(STOP) && Date.now() - t1 < 30 * 60 * 1000) await sleep(1000);
  } finally {
    a.close();
    fs.rmSync(STOP, { force: true });
    process.exit(0);
  }
})().catch((e) => { console.error(e); process.exit(1); });
