'use strict';
// Verifies that every translation key referenced by the renderer exists in both languages (used by tests + CI).
const fs = require('fs');
const path = require('path');
global.window = {};
const I18N = require('../src/renderer/i18n.js');
const R = path.join(__dirname, '..', 'src', 'renderer');
const read = (f) => fs.readFileSync(path.join(R, f), 'utf8');

function usedKeys() {
  const keys = new Set();
  const dyn = [];
  for (const f of ['core.js', 'panels.js']) {
    const src = read(f);
    // t('key'…) / T('key'…) / tt('key'…)
    for (const m of src.matchAll(/\b(?:t|T|tt|I18N\.t)\(\s*(?:[a-zA-Z.]+\s*,\s*)?'([a-z0-9][\w.-]*)'/g)) keys.add(m[1]);
    for (const m of src.matchAll(/\b(?:t|T|tt)\(\s*`([^`]*)`/g)) dyn.push(m[1]);
  }
  const html = read('index.html');
  for (const m of html.matchAll(/data-i18n(?:-[a-z]+)?="([^"]+)"/g)) keys.add(m[1]);
  return { keys: [...keys], dyn };
}

function check() {
  const { keys, dyn } = usedKeys();
  const missing = { ko: [], en: [] };
  const S = require('../src/main/settings');
  const fam = [];
  for (const n of S.CONTEXT_CHOICES) fam.push('set.ctx.hint.' + n);
  for (const l of S.LANG_CHOICES) fam.push('set.lang.' + l);
  for (const c of S.CURSOR_CHOICES) fam.push('set.cursor.' + c);
  for (const a of S.KEY_ACTIONS) fam.push('key.' + a);
  for (const m of ['readonly', 'default', 'ask-all', 'trust']) fam.push('perm.' + m + '.short', 'perm.' + m + '.name', 'perm.' + m + '.desc');
  for (const k of ['not-installed', 'not-authenticated', 'outdated', 'server-down', 'model-missing', 'timeout', 'network', 'invalid-output', 'busy', 'internal', 'failed', 'aborted']) fam.push('err.' + k);
  for (const k of ['idle', 'thinking', 'running', 'approval', 'input', 'busy']) fam.push('phase.' + k);
  for (let i = 1; i <= 5; i++) fam.push('welcome.ex' + i);
  for (const k of ['session', 'today', 'd7', 'd30']) fam.push('usage.col.' + k);
  for (const k of ['input', 'output', 'total', 'cached', 'calls', 'requests', 'cost']) fam.push('usage.row.' + k);
  for (const k of ['no-admin-key', 'admin-key-rejected', 'network', 'http', 'official-host-only']) fam.push('usage.err.' + k);
  for (const k of fam) keys.push(k);
  for (const k of keys.filter((x) => x.endsWith('.'))) keys.splice(keys.indexOf(k), 1);
  for (const k of keys) for (const l of ['ko', 'en']) if (!(k in I18N.D[l])) missing[l].push(k);
  const onlyKo = Object.keys(I18N.D.ko).filter((k) => !(k in I18N.D.en));
  const onlyEn = Object.keys(I18N.D.en).filter((k) => !(k in I18N.D.ko));
  const placeholders = [];
  for (const k of Object.keys(I18N.D.ko)) {
    if (!(k in I18N.D.en)) continue;
    const a = [...(I18N.D.ko[k].match(/\{(\w+)\}/g) || [])].sort().join();
    const b = [...(I18N.D.en[k].match(/\{(\w+)\}/g) || [])].sort().join();
    if (a !== b) placeholders.push(`${k}: ko=${a} en=${b}`);
  }
  return { keys: keys.length, dyn, missing, onlyKo, onlyEn, placeholders };
}
module.exports = { check, usedKeys };
if (require.main === module) {
  const r = check();
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.missing.ko.length || r.missing.en.length || r.onlyKo.length || r.onlyEn.length || r.placeholders.length ? 1 : 0);
}
