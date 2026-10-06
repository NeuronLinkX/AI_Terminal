'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { migrateLegacyData } = require('../src/main/legacy');

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ait-legacy-')));
const put = (f, c) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); };

test('the data folder of the old name is copied once: settings, tabs, history … yes — saved keys and caches no', () => {
  const appData = tmp();
  const old = path.join(appData, 'AI Terminal');
  put(path.join(old, 'settings.json'), '{"language":"ko"}');
  put(path.join(old, 'tabs.json'), '[]');
  put(path.join(old, 'history', 'a.jsonl'), 'x');
  put(path.join(old, 'ssh-sessions.json'), '{"sessions":[]}');
  put(path.join(old, 'secrets.json'), '{"openai":"encrypted-with-the-old-keychain-item"}');
  put(path.join(old, 'kv-engine.json'), '{"pid":1}');
  put(path.join(old, 'Cache', 'big'), 'cache');
  const dir = path.join(appData, 'MacAIterm');
  const copied = migrateLegacyData(dir, appData);
  assert.ok(copied.includes('settings.json') && copied.includes('history') && copied.includes('ssh-sessions.json'));
  assert.equal(fs.readFileSync(path.join(dir, 'history', 'a.jsonl'), 'utf8'), 'x');
  for (const f of ['secrets.json', 'kv-engine.json', 'Cache']) assert.ok(!fs.existsSync(path.join(dir, f)), `${f} must not be copied`);
  assert.ok(fs.existsSync(path.join(old, 'settings.json')), 'the old folder is left as it was');
  // a second start does nothing, and a changed setting is not overwritten by the old one
  fs.writeFileSync(path.join(dir, 'settings.json'), '{"language":"en"}');
  assert.deepEqual(migrateLegacyData(dir, appData), []);
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), '{"language":"en"}');
});

test('a profile chosen with --user-data-dir (tests) is never filled from the real data folder; no old folder → nothing happens', () => {
  const appData = tmp();
  put(path.join(appData, 'AI Terminal', 'settings.json'), '{}');
  const custom = path.join(tmp(), 'profile');
  assert.deepEqual(migrateLegacyData(custom, appData), []);
  assert.ok(!fs.existsSync(custom));
  const fresh = tmp();
  assert.deepEqual(migrateLegacyData(path.join(fresh, 'MacAIterm'), fresh), []);
});
