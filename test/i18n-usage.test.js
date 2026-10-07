'use strict';
// Every text key the SSH screens ask for exists in both languages (the parity check only compares the two dictionaries).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ctx = { window: {} }; // i18n.js is a browser script
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'i18n.js'), 'utf8'), ctx);
const I18N = ctx.window.AIT_I18N;

const dir = path.join(__dirname, '..', 'src', 'renderer');
const src = ['ssh.js', 'files.js', 'vnc.js', 'core.js', 'panels.js'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');

test('keys used by the SSH UI exist in Korean and English', () => {
  const used = new Set([...src.matchAll(/\bt\('([a-zA-Z0-9_.-]+)'/g)].map((m) => m[1]));
  for (const m of html.matchAll(/data-i18n(?:-title|-ph)?="([^"]+)"/g)) used.add(m[1]);
  // keys built from a value at run time
  for (const k of ['host-key-changed', 'host-key-unknown', 'host-key-failed', 'auth-failed', 'refused', 'timeout', 'dns', 'unreachable', 'dropped', 'closed']) used.add(`ssh.problem.${k}`);
  for (const k of ['config', 'user', 'own']) used.add(`ssh.via.${k}`);
  for (const k of ['cancel', 'skip', 'rename', 'overwrite']) used.add(`files.conflict.${k}`);
  for (const k of ['ask', 'auto', 'off']) used.add(`set.ssh.auto.${k}`);
  for (const k of ['auto', 'manual']) used.add(`set.ssh.files.${k}`);
  used.add('files.xfer.done');
  used.add('files.xfer.doneVerified');
  const missing = [...used].filter((k) => !k.endsWith('.') && !I18N.has(k)); // a trailing dot is a prefix completed at run time
  assert.deepEqual(missing, [], `missing keys: ${missing.join(', ')}`);
});

test('English UI text for the SSH screens is really English (no leftover Korean)', () => {
  const hangul = /[가-힣]/;
  const leftovers = [];
  for (const k of Object.keys(I18N.D.en)) if (/^(ssh|files|side|set\.ssh)\./.test(k) && hangul.test(I18N.D.en[k])) leftovers.push(k);
  assert.deepEqual(leftovers, []);
});
