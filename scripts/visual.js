#!/usr/bin/env node
'use strict';
// Visual regression: screenshots of fixed UI states (scripted model server, fixed window size, volatile bits hidden) are
// compared pixel-by-pixel with the baselines in test/visual/baseline/.
//   node scripts/visual.js            compare (exit 1 and write diffs to e2e-out/visual/ on a mismatch)
//   node scripts/visual.js --update   (re)write the baselines — review the PNGs before committing them
// Baselines depend on the macOS version, fonts and display scale of the machine that made them, so they are only meaningful
// on that machine (CI does not run this).
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch');
const { createMock } = require('./mock-ollama');
const { launch, sleep } = require('./e2e');

const BASE = path.join(__dirname, '..', 'test', 'visual', 'baseline');
const OUT = path.join(__dirname, '..', 'e2e-out', 'visual');
const UPDATE = process.argv.includes('--update');
const MAX_DIFF_RATIO = 0.002; // 0.2 % of the pixels may differ (anti-aliasing noise)
fs.mkdirSync(BASE, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function compare(name, buf) {
  const file = path.join(BASE, `${name}.png`);
  fs.writeFileSync(path.join(OUT, `${name}.actual.png`), buf);
  if (UPDATE || !fs.existsSync(file)) {
    fs.writeFileSync(file, buf);
    console.log(`${UPDATE ? 'UPDATED' : 'NEW BASELINE'}  ${name}`);
    return results.push({ name, ok: true });
  }
  const a = PNG.sync.read(fs.readFileSync(file));
  const b = PNG.sync.read(buf);
  if (a.width !== b.width || a.height !== b.height) {
    console.log(`FAIL  ${name}  size ${a.width}x${a.height} vs ${b.width}x${b.height}`);
    return results.push({ name, ok: false });
  }
  const diff = new PNG({ width: a.width, height: a.height });
  const n = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
  const ratio = n / (a.width * a.height);
  const ok = ratio <= MAX_DIFF_RATIO;
  if (!ok) fs.writeFileSync(path.join(OUT, `${name}.diff.png`), PNG.sync.write(diff));
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${n} px differ (${(ratio * 100).toFixed(3)}%)`);
  return results.push({ name, ok });
}

(async () => {
  const mock = createMock({ port: 11496 });
  await mock.listen();
  const a = await launch({ OLLAMA_HOST: '127.0.0.1:11496', AIT_OLLAMA_BIN: '/nonexistent/ollama', AIT_WIN_SIZE: '1200x800', AIT_LANG: 'ko' });
  const shot = async (name) => {
    const r = await a.cdp('Page.captureScreenshot', { format: 'png' });
    compare(name, Buffer.from(r.result.data, 'base64'));
  };
  const settle = () => sleep(500);
  try {
    await a.waitFor(`__ait.state.pty === 'prompt' && /mock/.test(document.getElementById('model-text').textContent)`, 40000, 'ready');
    // deterministic page: no blinking cursor, no live numbers, a fixed terminal screen
    await a.ev(`window.ait.settingsSet('cursorBlink', false).then(() => 1)`);
    await a.ev(`(() => { const s = document.createElement('style'); s.textContent = '#sysmon, .build-tag { visibility: hidden !important; } * { caret-color: transparent !important; animation: none !important; transition: none !important; }'; document.head.append(s); })()`);
    const screen = `__ait.term.reset(); __ait.term.write('\\x1b[32mdemo\\x1b[0m \\x1b[34m~/project\\x1b[0m % ls\\r\\nREADME.md  package.json  src  test.js\\r\\n\\x1b[32mdemo\\x1b[0m \\x1b[34m~/project\\x1b[0m % ')`;
    const dark = async () => { if ((await a.ev(`document.documentElement.dataset.theme`)) !== 'dark') await a.ev(`__ait.toggleTheme()`); };
    const light = async () => { if ((await a.ev(`document.documentElement.dataset.theme`)) !== 'light') await a.ev(`__ait.toggleTheme()`); };

    await dark(); await a.ev(screen); await settle(); await shot('main-dark');
    await a.ev(`document.getElementById('perm-chip').click()`); await settle(); await shot('permissions-dark'); await a.ev(`document.body.click()`);
    await a.ev(`document.getElementById('model').click()`); await settle(); await shot('model-popover-dark'); await a.ev(`document.body.click()`);
    await a.ev(`__panels.openSettings().then(() => 1)`); await settle(); await shot('settings-dark'); await a.ev(`__panels.closeSettings()`);
    await light(); await a.ev(screen); await settle(); await shot('main-light');
    await a.ev(`__panels.openSettings().then(() => 1)`); await settle(); await shot('settings-light'); await a.ev(`__panels.closeSettings()`);
  } finally { a.close(); await mock.close(); }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} scenes match`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
