'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveKey, keyStatus, importShellEnv, ENV } = require('../src/main/keys');

const OFFICIAL = 'https://api.openai.com/v1';
const LOCAL = 'http://127.0.0.1:1234/v1';
const secrets = (store) => ({ available: true, has: (n) => !!store[n], get: (n) => store[n] || '' });
const withEnv = (env, fn) => {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] === null) delete process.env[k]; else process.env[k] = env[k]; }
  try { return fn(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
};

test('keys: the standard variable names are used', () => {
  assert.equal(ENV.openai, 'OPENAI_API_KEY');
  assert.equal(ENV['openai-admin'], 'OPENAI_ADMIN_KEY');
});

test('keys: OPENAI_API_KEY wins on the official host, the saved key on everything else; the env key never leaves for another server', () => {
  withEnv({ OPENAI_API_KEY: 'env-key-value' }, () => {
    const s = secrets({ openai: 'saved-key-value' });
    assert.deepEqual(resolveKey('openai', { secrets: s, baseUrl: OFFICIAL }), { value: 'env-key-value', source: 'env' });
    assert.deepEqual(resolveKey('openai', { secrets: s, baseUrl: LOCAL }), { value: 'saved-key-value', source: 'keychain' }, 'a local/other server gets only its saved key');
    assert.deepEqual(resolveKey('openai', { secrets: secrets({}), baseUrl: LOCAL }), { value: '', source: null }, 'no saved key → no key at all, never the env one');
    assert.deepEqual(resolveKey('openai', { secrets: secrets({}), baseUrl: 'https://api.openai.com.evil.example/v1' }), { value: '', source: null }, 'look-alike hosts are not official');
  });
  withEnv({ OPENAI_API_KEY: null }, () => {
    assert.deepEqual(resolveKey('openai', { secrets: secrets({ openai: 'saved-key-value' }), baseUrl: OFFICIAL }), { value: 'saved-key-value', source: 'keychain' });
    assert.deepEqual(resolveKey('openai', { secrets: { available: false, get: () => 'x', has: () => true }, baseUrl: OFFICIAL }), { value: '', source: null }, 'no encryption available → a stored key is not used');
  });
});

test('keys: OPENAI_ADMIN_KEY (usage lookup) from the environment or the Keychain', () => {
  withEnv({ OPENAI_ADMIN_KEY: 'admin-env-value' }, () => assert.deepEqual(resolveKey('openai-admin', { secrets: secrets({}) }), { value: 'admin-env-value', source: 'env' }));
  withEnv({ OPENAI_ADMIN_KEY: null }, () => assert.deepEqual(resolveKey('openai-admin', { secrets: secrets({ 'openai-admin': 'adm-saved' }) }), { value: 'adm-saved', source: 'keychain' }));
});

test('keys: the UI status says where a key comes from — and never contains the key', () => {
  withEnv({ OPENAI_API_KEY: 'super-secret-env-value' }, () => {
    const st = keyStatus('openai', { secrets: secrets({}), baseUrl: OFFICIAL });
    assert.equal(st.source, 'env');
    assert.equal(st.envName, 'OPENAI_API_KEY');
    assert.equal(JSON.stringify(st).includes('super-secret-env-value'), false);
    const other = keyStatus('openai', { secrets: secrets({}), baseUrl: LOCAL });
    assert.equal(other.source, null);
    assert.equal(other.envIgnored, true, 'the UI can explain that the variable is set but not used for this server');
  });
});

test('keys: the login shell is asked for PATH and the key variables (the way a Dock-launched app gets ~/.zshrc)', () => {
  const zd = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-zdot-'));
  fs.writeFileSync(path.join(zd, '.zshrc'), 'echo "noise from rc file"\nexport OPENAI_API_KEY=from-zshrc-value\nexport PATH="/opt/test-bin:$PATH"\n');
  const r = importShellEnv(['OPENAI_API_KEY', 'OPENAI_ADMIN_KEY'], { shell: '/bin/zsh', env: { ...process.env, ZDOTDIR: zd, OPENAI_API_KEY: '', OPENAI_ADMIN_KEY: '' } });
  assert.equal(r.values.OPENAI_API_KEY, 'from-zshrc-value');
  assert.equal('OPENAI_ADMIN_KEY' in r.values, false, 'unset variables are simply absent');
  assert.ok(r.PATH.startsWith('/opt/test-bin:'), 'PATH comes from the same shell');
  assert.deepEqual(importShellEnv(['lower;rm -rf /', 'OK_NAME'], { shell: '/bin/zsh', env: { ...process.env, ZDOTDIR: zd } }).values, {}, 'only plain variable names are ever interpolated into the script');
  fs.rmSync(zd, { recursive: true, force: true });
});
