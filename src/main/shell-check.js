'use strict';
// Decides whether a line typed as a "shell command" is really natural language (so it is never executed).
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const HANGUL = /[ᄀ-ᇿㄱ-ㆎ가-힣]/;
const BUILTINS = new Set(['cd', 'echo', 'export', 'alias', 'unalias', 'source', '.', 'type', 'which', 'pwd', 'set', 'unset', 'exit', 'history', 'jobs', 'fg', 'bg', 'kill', 'wait', 'read', 'eval', 'exec', 'ulimit', 'umask', 'test', 'printf', 'true', 'false', 'clear', 'pushd', 'popd', 'dirs', 'whence', 'builtin', 'command', 'trap', 'time', 'if', 'for', 'while', 'case', 'function', 'select', 'noglob', 'nocorrect', 'rehash', 'hash', 'let', 'local', 'declare', 'typeset', 'setopt', 'unsetopt', 'bindkey', 'autoload', 'zle', 'sudo']);
const cache = new Map();

function inPath(name) {
  for (const dir of (process.env.PATH || '').split(':')) {
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK);
      return true;
    } catch {
      /* next */
    }
  }
  return false;
}

function viaShell(tok) {
  if (cache.has(tok)) return Promise.resolve(cache.get(tok));
  return new Promise((resolve) => {
    execFile('/bin/zsh', ['-ic', 'whence -w -- "$1"', 'zsh', tok], { timeout: 4000, env: { ...process.env, AIT_NOHOOK: '1' } }, (err, stdout) => {
      const found = !err && !/: none\s*$/.test(String(stdout).trim());
      cache.set(tok, found);
      resolve(found);
    });
  });
}

/** @returns {Promise<{natural:boolean, reason?:string}>} */
async function classify(line) {
  const text = String(line || '').trim();
  if (!text) return { natural: false };
  const tokens = text.split(/\s+/);
  const first = tokens[0];
  if (/^[.~/$({!]/.test(first) || first.includes('=') || /^[|&;<>]/.test(first)) return { natural: false };
  if (HANGUL.test(first)) return { natural: true, reason: '첫 단어가 한글이라 셸 명령이 아닌 자연어로 판단했습니다' };
  if (tokens.length < 2) return { natural: false };
  if (BUILTINS.has(first) || inPath(first)) return { natural: false };
  if (await viaShell(first)) return { natural: false };
  return { natural: true, reason: `'${first}' 은(는) 이 셸에서 찾을 수 없는 명령이라 자연어로 판단했습니다` };
}

module.exports = { classify };
