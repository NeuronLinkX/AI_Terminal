#!/usr/bin/env node
'use strict';
// The ~/.ssh/config editor in the real window (temporary .ssh folder through AIT_SSH_DIR; the real ~/.ssh is never read).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch, check, results, sleep } = require('./e2e');

(async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ait-sshcfg-home-')));
  const dir = path.join(home, '.ssh');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'config');
  fs.writeFileSync(file, 'Host alpha\n  HostName 192.0.2.10\n  User demo\n\nHost beta\n  HostName 192.0.2.20\n', { mode: 0o600 });
  const a = await launch({ AIT_NO_KEYCHAIN: '1', AIT_LANG: 'en', AIT_CWD: home, AIT_SSH_DIR: dir });
  try {
    await a.waitFor(`__ait.state.pty === 'prompt'`, 30000, 'prompt');
    await a.ev(`document.querySelector('.act[data-pane="sessions"]').click()`);
    const row = (name) => `[...document.querySelectorAll('#sp-sessions .sess-row')].find((r) => r.innerText.includes(${JSON.stringify(name)}))`;
    await a.waitFor(`!!(${row('beta')})`, 10000, 'config rows');
    // nothing to offer -> no box at all
    await a.ev(`AITSsh.ctxMenu(new MouseEvent('contextmenu', { clientX: 50, clientY: 50, cancelable: true }), [])`);
    check('menu: an empty menu draws no empty box', (await a.ev(`document.querySelectorAll('.ctx').length`)) === 0);
    // right click on a config host
    await a.ev(`${row('beta')}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 200 }))`);
    const items = await a.ev(`[...document.querySelectorAll('.ctx .ctx-i')].map((b) => b.innerText.trim())`);
    check('menu: right-click on a ~/.ssh/config host offers connect, import and edit', items.length >= 4 && items.some((x) => /Edit ~\/.ssh\/config/.test(x)), items.join(' | '));
    await a.ev(`[...document.querySelectorAll('.ctx .ctx-i')].find((b) => /Edit ~\\/.ssh\\/config/.test(b.innerText)).click()`);
    await a.waitFor(`!!document.querySelector('.cfg-editor .cfg-text')`, 8000, 'editor');
    await a.waitFor(`(() => { const t = document.querySelector('.cfg-text'); return t && t.selectionEnd > t.selectionStart; })()`, 4000, 'host selected').catch(() => {});
    const opened = await a.ev(`(() => { const t = document.querySelector('.cfg-text'); return { same: t.value.includes('Host beta') && t.value.includes('Host alpha'), sel: t.value.slice(t.selectionStart, t.selectionEnd) }; })()`);
    check('editor: opens with the file content and selects the clicked host', opened.same && /Host beta/.test(opened.sel), JSON.stringify(opened.sel));
    // a mistake is explained with its line and is not saved
    await a.ev(`(() => { const t = document.querySelector('.cfg-text'); t.value += '\\nHost gamma\\n  NoSuchOption yes\\n'; t.dispatchEvent(new Event('input')); [...document.querySelectorAll('.cfg-editor .sm-foot .btn')].find((b) => /Check syntax/.test(b.innerText)).click(); })()`);
    await a.waitFor(`/Line \\d+/.test(document.querySelector('.cfg-status').innerText)`, 8000, 'syntax message');
    check('editor: a mistake is reported with its line', /Line 9: .*Bad configuration option/i.test(await a.ev(`document.querySelector('.cfg-status').innerText`)), await a.ev(`document.querySelector('.cfg-status').innerText`));
    await a.ev(`[...document.querySelectorAll('.cfg-editor .sm-foot .btn')].find((b) => /Save and apply/.test(b.innerText)).click()`);
    await sleep(900);
    check('editor: saving with a mistake is refused and the file is unchanged', !/gamma/.test(fs.readFileSync(file, 'utf8')));
    // fix it, save, the list follows
    await a.ev(`(() => { const t = document.querySelector('.cfg-text'); t.value = t.value.replace('  NoSuchOption yes', '  HostName 192.0.2.30'); t.dispatchEvent(new Event('input')); [...document.querySelectorAll('.cfg-editor .sm-foot .btn')].find((b) => /Save and apply/.test(b.innerText)).click(); })()`);
    await a.waitFor(`/Saved/.test(document.querySelector('.cfg-status').innerText)`, 8000, 'saved');
    check('editor: the corrected text is saved to the file', /Host gamma/.test(fs.readFileSync(file, 'utf8')));
    check('editor: the previous content is kept as a backup', fs.readdirSync(dir).some((f) => /^config\.bak-\d{14}$/.test(f)));
    await a.waitFor(`!!(${row('gamma')})`, 8000, 'new host in the list').catch(async (e) => {
      console.log('debug rows:', JSON.stringify(await a.ev(`({ panel: AITSsh.S.panel, rows: [...document.querySelectorAll('#sp-sessions .sess-row')].map((r) => r.innerText.replace(/\\s+/g, ' ').slice(0, 40)), fileHasGamma: ${JSON.stringify(/Host gamma/.test(fs.readFileSync(file, 'utf8')))} })`)));
      throw e;
    });
    check('editor: the new host is in the session list at once', true);
    check('editor: the file stays private', (fs.statSync(file).mode & 0o077) === 0);
    await a.ev(`[...document.querySelectorAll('.cfg-editor .sm-foot .btn')].find((b) => /Cancel/.test(b.innerText)).click()`);
    await sleep(300);
    check('editor: closes without a question when nothing is unsaved', (await a.ev(`!document.querySelector('.cfg-editor')`)) === true);
    // the header button opens it too
    await a.ev(`document.querySelector('#sp-sessions .sp-head .btn.icon').click()`);
    await a.waitFor(`!!document.querySelector('.cfg-editor .cfg-text')`, 8000, 'editor from the header button');
    check('editor: the key button in the panel header opens it', true);
  } catch (e) {
    check('scenario completed', false, String(e.message).slice(0, 300));
  } finally {
    a.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - bad}/${results.length} passed`);
  process.exit(bad ? 1 : 0);
})();
