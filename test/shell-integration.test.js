'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = path.join(__dirname, '..', 'src', 'main', 'shell-integration');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-shint-'));
fs.writeFileSync(path.join(HOME, '.zshrc'), ''); // an empty user rc: the stock zsh prompt applies
fs.writeFileSync(path.join(HOME, '.bashrc'), '');

const zshPrompt = (env = {}) => {
  const r = spawnSync('/bin/zsh', ['-i', '-c', 'print -r -- "$PS1"'], { encoding: 'utf8', timeout: 15000, env: { PATH: process.env.PATH, HOME, ZDOTDIR: path.join(DIR, 'zsh'), AIT_USER_ZDOTDIR: HOME, ...env } });
  return r.stdout.replace(/\n$/, '').split('\n').pop();
};

test('zsh integration: default Mac-style prompt, AIT_PROMPT replaces it, AIT_KEEP_PROMPT leaves the stock one', { skip: !fs.existsSync('/bin/zsh') }, () => {
  assert.strictEqual(zshPrompt(), '%F{green}%n@%m%f %F{blue}%~%f %# ');
  assert.strictEqual(zshPrompt({ AIT_PROMPT: 'demo %# ' }), 'demo %# ');
  assert.notStrictEqual(zshPrompt({ AIT_KEEP_PROMPT: '1' }), '%F{green}%n@%m%f %F{blue}%~%f %# ');
});
