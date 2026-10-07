#!/usr/bin/env node
'use strict';
// End-to-end check of the remote screen in the REAL app window: a throw-away sshd (127.0.0.1, generated key) and a fake VNC server
// (test/helpers/fake-vnc.js) stand in for the server; nothing real is contacted and no password is involved.
//   node scripts/e2e-vnc.js            (screenshots in ./e2e-out, or AIT_SHOT_DIR)
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { spawnSync } = require('child_process');
const { launch, check, results, sleep, typeInTerm } = require('./e2e');
const { startSshd } = require('../test/helpers/sshd');
const { startFakeVnc } = require('../test/helpers/fake-vnc');

const freePort = () => new Promise((res) => { const sv = net.createServer(); sv.listen(0, '127.0.0.1', () => { const p = sv.address().port; sv.close(() => res(p)); }); });
const pgrep = (pat) => spawnSync('/usr/bin/pgrep', ['-f', '--', pat], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).length;
const listeners = () => spawnSync('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout.split('\n').filter((l) => /Electron|ssh/i.test(l)).map((l) => l.split(/\s+/).slice(0, 1).concat(l.split(/\s+/).slice(-2, -1))).map((x) => x.join(' ')).sort();

(async () => {
  const sshd = await startSshd();
  if (!sshd) { check('remote screen: no sshd available, skipped', true, 'skipped'); return; }
  const fake = await startFakeVnc();
  const pass = crypto.randomBytes(6).toString('hex'); // a test value that exists only in this run
  const locked = await startFakeVnc({ password: pass });
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ait-vnc-home-')));
  fs.mkdirSync(path.join(home, '.ssh'));
  fs.writeFileSync(path.join(home, '.ssh', 'config'), '\n', { mode: 0o600 });
  let late = null; // a server whose VNC starts only after the app has begun to look for it
  const a = await launch({ AIT_NO_KEYCHAIN: '1', AIT_LANG: 'en', AIT_CWD: home, AIT_SSH_DIR: path.join(home, '.ssh') });
  try {
    await a.waitFor(`__ait.state.pty === 'prompt'`, 30000, 'prompt');
    await a.ev(`window.__errs = []; addEventListener('error', (e) => __errs.push(String(e.message))); addEventListener('unhandledrejection', (e) => __errs.push(String(e.reason)));`);
    const btnHidden = await a.ev(`document.getElementById('btn-screen').hidden`);
    check('remote screen: no button while the tab is not on a server', btnHidden === true);
    check('remote screen: noVNC is not loaded at start (lazy, R1)', (await a.ev(`AITVnc.loaded()`)) === false);

    // ---- connect the tab to the throw-away server like a user would
    await typeInTerm(a, `${sshd.command}\r`);
    await a.waitFor(`!document.getElementById('ssh-chip').hidden`, 40000, 'ssh chip');
    check('remote screen: the button appears once the tab is on a server', (await a.ev(`!document.getElementById('btn-screen').hidden`)) === true);
    const before = listeners();

    // ---- open: nothing connects by itself the first time, the port field has the usual default
    await a.ev(`document.getElementById('btn-screen').click()`);
    await a.waitFor(`!!document.querySelector('.vnc-wrap') && !document.querySelector('.vnc-wrap').hidden`, 5000, 'screen view');
    const first = await a.ev(`(() => { const v = AITVnc.views.get(AITCore.getTab().id); return { state: v.state, port: v.port.value, term: !![...document.querySelectorAll('.term-wrap')].some((x) => x.classList.contains('active')) }; })()`);
    check('remote screen: opens as a view over the terminal, port 5901 suggested, not connected yet', first.state === 'idle' && first.port === '5901', JSON.stringify(first));
    check('remote screen: the view says that the AI chat cannot see or control the screen', /AI chat cannot see or control this screen/.test(await a.ev(`document.querySelector('.vnc-note').innerText`)));
    const noClick = await a.ev(`document.querySelector('.vnc-msg-text').innerText`);
    check('remote screen: the first view explains what it needs', /VNC server must be running/.test(noClick), noClick.slice(0, 80));

    // ---- connect
    await a.ev(`(() => { const v = AITVnc.views.get(AITCore.getTab().id); v.port.value = '${fake.port}'; v.go.click(); })()`);
    await a.waitFor(`AITVnc.views.get(AITCore.getTab().id).state === 'connected'`, 20000, 'connected');
    check('remote screen: connects through the ssh connection', true);
    check('remote screen: noVNC was loaded on first use', (await a.ev(`AITVnc.loaded()`)) === true);
    check('remote screen: an ssh -W process carries the picture', pgrep(`-W 127.0.0.1:${fake.port}`) >= 1);
    const after = listeners();
    check('remote screen: no listening port was opened on this Mac', JSON.stringify(after) === JSON.stringify(before), `${before.length} -> ${after.length}`);

    // ---- the picture
    await a.waitFor(`(() => { const c = AITVnc.views.get(AITCore.getTab().id).screen.querySelector('canvas'); return c && c.width === ${fake.width} && c.height === ${fake.height}; })()`, 10000, 'canvas size');
    const px = (x, y) => a.ev(`(() => { const c = AITVnc.views.get(AITCore.getTab().id).screen.querySelector('canvas'); return Array.from(c.getContext('2d').getImageData(${x}, ${y}, 1, 1).data).slice(0, 3); })()`);
    const tl = await px(5, 5);
    const br = await px(fake.width - 5, fake.height - 5);
    const mid = await px(fake.width - 5, 5);
    check('remote screen: the server\'s picture is drawn (colours at three places)', JSON.stringify(tl) === JSON.stringify(fake.colors.topLeft) && JSON.stringify(br) === JSON.stringify(fake.colors.bottomRight) && JSON.stringify(mid) === JSON.stringify(fake.colors.middle), JSON.stringify([tl, br, mid]));
    await a.shot('vnc-1-connected');

    // ---- input: a real mouse move, click and key press over the canvas
    const rect = await a.ev(`(() => { const c = AITVnc.views.get(AITCore.getTab().id).screen.querySelector('canvas'); const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    const at = { x: rect.x + rect.w * 0.25, y: rect.y + rect.h * 0.3 };
    await a.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
    await a.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    await a.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    await a.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', text: 'a', windowsVirtualKeyCode: 65 });
    await a.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await sleep(800);
    const wantX = Math.round(fake.width * 0.25); const wantY = Math.round(fake.height * 0.3);
    const ptr = fake.events.filter((e) => e.type === 'pointer');
    const press = ptr.find((e) => e.mask === 1);
    check('remote screen: a click over the picture reaches the server at the right place', !!press && Math.abs(press.x - wantX) <= 3 && Math.abs(press.y - wantY) <= 3, JSON.stringify(press) + ` want ~${wantX},${wantY}`);
    check('remote screen: a key press reaches the server (keysym a)', fake.events.some((e) => e.type === 'key' && e.down && e.key === 0x61), JSON.stringify(fake.events.filter((e) => e.type === 'key')));
    let mk = [];
    for (let i = 0; i < 50; i++) { mk = await px(Math.min(fake.width - 1, wantX + 3), Math.min(fake.height - 1, wantY + 3)); if (JSON.stringify(mk) === JSON.stringify(fake.colors.marker)) break; await sleep(100); } // the answer travels the whole way back: allow a slow machine a few seconds
    const okMark = JSON.stringify(mk) === JSON.stringify(fake.colors.marker);
    let why = JSON.stringify(mk);
    if (!okMark) why += ' | ' + JSON.stringify(await a.ev(`({ visible: document.visibilityState, focus: document.hasFocus(), state: AITVnc.views.get(AITCore.getTab().id).state })`)) + ' server events: ' + fake.events.filter((e) => e.type === 'pointer').length;
    check('remote screen: the server\'s answer to the click (a white marker) is drawn', okMark, why);
    await a.shot('vnc-2-marker');

    // ---- view only, clipboard from the server, quality / scale options
    await a.ev(`(() => { const v = AITVnc.views.get(AITCore.getTab().id); v.viewOnly.checked = true; v.viewOnly.dispatchEvent(new Event('change')); })()`);
    const n0 = fake.events.length;
    await a.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x + 20, y: at.y + 10 });
    await a.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x + 20, y: at.y + 10, button: 'left', clickCount: 1 });
    await a.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x + 20, y: at.y + 10, button: 'left', clickCount: 1 });
    await sleep(500);
    check('remote screen: "View only" sends no input', fake.events.length === n0);
    await a.ev(`(() => { const v = AITVnc.views.get(AITCore.getTab().id); v.viewOnly.checked = false; v.viewOnly.dispatchEvent(new Event('change')); })()`);
    fake.cutText('clipboard text from the server');
    await a.waitFor(`AITVnc.views.get(AITCore.getTab().id).remoteClip === 'clipboard text from the server' && !AITVnc.views.get(AITCore.getTab().id).clipGet.disabled`, 5000, 'remote clipboard');
    check('remote screen: the server\'s clipboard is offered (never copied by itself)', true);
    await a.ev(`(() => { const v = AITVnc.views.get(AITCore.getTab().id); v.preset.value = 'sharp'; v.preset.dispatchEvent(new Event('change')); v.scale.value = 'one'; v.scale.dispatchEvent(new Event('change')); })()`);
    const q = await a.ev(`(() => { const r = AITVnc.views.get(AITCore.getTab().id).rfb; return { q: r.qualityLevel, c: r.compressionLevel, s: r.scaleViewport }; })()`);
    check('remote screen: quality preset and size option apply', q.q === 9 && q.c === 0 && q.s === false, JSON.stringify(q));
    await a.ev(`(() => { const v = AITVnc.views.get(AITCore.getTab().id); v.preset.value = 'balanced'; v.preset.dispatchEvent(new Event('change')); v.scale.value = 'fit'; v.scale.dispatchEvent(new Event('change')); })()`);

    // ---- back to the terminal keeps the connection; the button shows it is still running
    await a.ev(`document.querySelector('.vnc-wrap .btn.mini').click()`);
    await sleep(300);
    const hid = await a.ev(`({ wrapHidden: document.querySelector('.vnc-wrap').hidden, live: document.getElementById('btn-screen').dataset.live, state: AITVnc.views.get(AITCore.getTab().id).state })`);
    check('remote screen: "Terminal" hides the view, the connection stays and the button shows it', hid.wrapHidden && hid.live === '1' && hid.state === 'connected', JSON.stringify(hid));
    await a.ev(`document.getElementById('btn-screen').click()`);
    await sleep(300);
    check('remote screen: the button shows the screen again, still connected', (await a.ev(`!document.querySelector('.vnc-wrap').hidden && AITVnc.views.get(AITCore.getTab().id).state === 'connected'`)) === true);

    // ---- disconnect: the ssh child must go
    await a.ev(`AITVnc.views.get(AITCore.getTab().id).go.click()`);
    await a.waitFor(`AITVnc.views.get(AITCore.getTab().id).state === 'idle'`, 8000, 'idle after disconnect');
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) { gone = pgrep(`-W 127.0.0.1:${fake.port}`) === 0; if (!gone) await sleep(100); }
    check('remote screen: disconnecting ends the ssh -W process', gone);

    // ---- an error is explained in words
    await a.ev(`(() => { const v = AITVnc.views.get(AITCore.getTab().id); v.port.value = '1'; v.go.click(); })()`);
    await a.waitFor(`AITVnc.views.get(AITCore.getTab().id).state === 'ended'`, 15000, 'ended with an error');
    const err = await a.ev(`document.querySelector('.vnc-msg-text').innerText`);
    check('remote screen: no server on the port -> a clear message', /No VNC server answers/.test(err), err.replace(/\n/g, ' | '));
    await a.shot('vnc-3-error');

    // ---- a server that asks for a password: a dialog opens, a wrong password is refused, the right one connects, nothing is kept
    const submitPw = (value) => a.ev(`(() => { const i = document.querySelector('.ait-modal .sm-dialog input[type="password"]'); if (!i) return false; i.value = ${JSON.stringify(value)}; [...document.querySelectorAll('.ait-modal .sm-dialog .btn.primary')].pop().click(); return true; })()`);
    await a.ev(`(() => { const v = AITVnc.views.get(AITCore.getTab().id); v.port.value = '${locked.port}'; v.go.click(); })()`);
    await a.waitFor(`!!document.querySelector('.ait-modal .sm-dialog input[type="password"]')`, 15000, 'password dialog');
    check('remote screen: a password-protected server opens a password dialog', true);
    check('remote screen: the dialog says the password is not stored', /not stored/.test(await a.ev(`document.querySelector('.ait-modal .sm-dialog').innerText`)));
    await a.shot('vnc-4-password');
    await submitPw('wrong-' + pass);
    await a.waitFor(`AITVnc.views.get(AITCore.getTab().id).state === 'ended'`, 15000, 'refused');
    const refused = await a.ev(`document.querySelector('.vnc-msg-text').innerText`);
    check('remote screen: a wrong password is refused with a clear message', /refused the login/.test(refused) && locked.events.some((e) => e.type === 'auth' && e.ok === false), refused);
    await a.ev(`AITVnc.views.get(AITCore.getTab().id).go.click()`);
    await a.waitFor(`!!document.querySelector('.ait-modal .sm-dialog input[type="password"]')`, 15000, 'password dialog again');
    await submitPw(pass);
    await a.waitFor(`AITVnc.views.get(AITCore.getTab().id).state === 'connected'`, 20000, 'connected with the password');
    check('remote screen: the right password connects and the server accepted it', locked.events.some((e) => e.type === 'auth' && e.ok === true));
    await a.waitFor(`(() => { const c = AITVnc.views.get(AITCore.getTab().id).screen.querySelector('canvas'); return c && c.getContext('2d').getImageData(5, 5, 1, 1).data[0] === 255; })()`, 10000, 'locked picture');
    check('remote screen: the dialog is gone and the picture is drawn', (await a.ev(`!document.querySelector('.ait-modal')`)) === true);
    const kept = await a.ev(`(() => { let all = ''; try { for (let i = 0; i < localStorage.length; i++) all += localStorage.key(i) + '=' + localStorage.getItem(localStorage.key(i)) + '|'; } catch (e) {} return all + document.documentElement.innerHTML; })()`);
    check('remote screen: the password is not kept in the page, its storage or its fields', !kept.includes(pass));
    await a.ev(`AITVnc.views.get(AITCore.getTab().id).go.click()`);
    await a.waitFor(`AITVnc.views.get(AITCore.getTab().id).state === 'idle'`, 8000, 'idle again');

    // ---- connect again, then leave the server: the view goes away and nothing is left running
    await a.ev(`(() => { const v = AITVnc.views.get(AITCore.getTab().id); v.port.value = '${fake.port}'; v.go.click(); })()`);
    await a.waitFor(`AITVnc.views.get(AITCore.getTab().id).state === 'connected'`, 20000, 'reconnected');
    await a.ev(`document.querySelector('.vnc-wrap .btn.mini').click()`);
    await typeInTerm(a, 'exit\r');
    await a.waitFor(`document.getElementById('ssh-chip').hidden`, 20000, 'ssh ended');
    await a.waitFor(`AITVnc.views.size === 0`, 8000, 'view removed');
    let none = false;
    for (let i = 0; i < 50 && !none; i++) { none = pgrep(`-W 127.0.0.1:${fake.port}`) === 0; if (!none) await sleep(100); }
    check('remote screen: when the ssh session ends the view is removed and no ssh -W is left', none);
    check('remote screen: the button is gone with the session', (await a.ev(`document.getElementById('btn-screen').hidden`)) === true);
    // ---- "open on connect": tick it once; the next connection to this server shows the screen by itself, and a VNC server that is
    // not up yet is waited for
    await typeInTerm(a, `${sshd.command}\r`);
    await a.waitFor(`!document.getElementById('ssh-chip').hidden`, 40000, 'ssh chip again');
    await a.ev(`document.getElementById('btn-screen').click()`); // the port of this server is remembered: it connects
    await a.waitFor(`AITVnc.views.get(AITCore.getTab().id) && AITVnc.views.get(AITCore.getTab().id).state === 'connected'`, 20000, 'connected again');
    const label = await a.ev(`AITSsh.S.tabs.get(AITCore.getTab().id).ssh.target.label`);
    await a.ev(`AITVnc.views.get(AITCore.getTab().id).auto.click()`);
    check('remote screen: "Open on connect" is remembered for this server', (await a.ev(`localStorage.getItem('ait.vnc.auto.' + ${JSON.stringify(label)})`)) === '1');
    const lateP = await freePort();
    await a.ev(`localStorage.setItem('ait.vnc.port.' + ${JSON.stringify(label)}, '${lateP}')`); // nothing listens there yet
    await typeInTerm(a, 'exit\r');
    await a.waitFor(`document.getElementById('ssh-chip').hidden && AITVnc.views.size === 0`, 20000, 'left the server');
    await typeInTerm(a, `${sshd.command}\r`);
    await a.waitFor(`AITVnc.views.size === 1 && /Waiting for the VNC server/.test(document.querySelector('.vnc-msg-text').innerText)`, 60000, 'waiting for VNC');
    check('remote screen: connecting to the server opens the screen by itself and waits for a VNC server that is not up yet', (await a.ev(`!document.querySelector('.vnc-wrap').hidden`)) === true);
    late = await startFakeVnc({ port: lateP });
    await a.waitFor(`AITVnc.views.get(AITCore.getTab().id).state === 'connected'`, 30000, 'connected after the wait');
    check('remote screen: once the VNC server is up the screen connects without any click', late.clients.size >= 1);
    await a.shot('vnc-5-auto');
    await a.ev(`document.querySelector('.vnc-wrap .btn.mini').click()`);
    await typeInTerm(a, 'exit\r');
    await a.waitFor(`document.getElementById('ssh-chip').hidden && AITVnc.views.size === 0`, 20000, 'left the server again');
    let none2 = false;
    for (let i = 0; i < 50 && !none2; i++) { none2 = pgrep(`-W 127.0.0.1:${lateP}`) === 0; if (!none2) await sleep(100); }
    check('remote screen: nothing is left running after the automatic session', none2);
    // ---- recent connections: a right click offers "Remove from recent", and it is really gone
    await a.ev(`document.querySelector('.act[data-pane="sessions"]').click()`);
    await a.waitFor(`[...document.querySelectorAll('#sp-sessions .sess-row')].some((r) => r.innerText.includes('127.0.0.1'))`, 10000, 'recent row');
    await a.ev(`(() => { const r = [...document.querySelectorAll('#sp-sessions .sess-row')].find((x) => x.innerText.includes('127.0.0.1')); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 160 })); })()`);
    const menuItems = await a.ev(`[...document.querySelectorAll('.ctx .ctx-i')].map((b) => b.innerText.trim())`);
    check('recent connections: the right-click menu is not empty and offers removal', menuItems.length >= 4 && menuItems.some((x) => /Remove from recent/.test(x)) && menuItems.some((x) => /Clear all recent/.test(x)), menuItems.join(' | '));
    await a.ev(`[...document.querySelectorAll('.ctx .ctx-i')].find((b) => /Remove from recent/.test(b.innerText)).click()`);
    await a.waitFor(`![...document.querySelectorAll('#sp-sessions .sess-row')].some((r) => r.innerText.includes('127.0.0.1'))`, 8000, 'recent row removed');
    check('recent connections: the entry is gone from the list', true);
    check('recent connections: and from the stored list', (await a.ev(`window.ait.sessList().then((d) => d.recent.some((r) => r.target.includes('127.0.0.1')))`)) === false);
    const errs = await a.ev(`window.__errs`);
    check('remote screen: no script errors in the window', errs.length === 0, errs.join(' | ').slice(0, 200));
  } catch (e) {
    check('remote screen: scenario completed', false, String(e.message).slice(0, 300));
  } finally {
    a.close();
    await fake.stop();
    await locked.stop();
    if (late) await late.stop();
    sshd.stop();
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - bad}/${results.length} passed`);
  process.exit(bad ? 1 : 0);
})();
