'use strict';
// API keys: one place that decides WHERE a key comes from, with the standard variable names.
//   OPENAI_API_KEY     chat requests (OpenAI and OpenAI-compatible servers)
//   OPENAI_ADMIN_KEY   organization usage / costs lookup (an Admin key, not a normal key)
// Order: the environment variable (also imported from the user's login shell, because a Dock-launched app does not inherit
// ~/.zshrc), then the key saved in Settings (macOS Keychain). Values are returned to the caller only — never logged,
// never put in a result that goes to the UI (the UI gets the SOURCE: 'env' | 'keychain' | null).
//
// Safety: OPENAI_API_KEY from the environment is sent to OpenAI's own host (api.openai.com) only. For any other server the
// user configured (LM Studio, a gateway, …) only a key saved in Settings for it is used, so a real OpenAI key can never be
// sent to a mistyped or third-party URL by accident.
const { isOfficial } = require('./usage');

const ENV = { openai: 'OPENAI_API_KEY', 'openai-admin': 'OPENAI_ADMIN_KEY' };
const SHELL_IMPORT = Object.values(ENV);

/** @returns {{value: string, source: 'env'|'keychain'|null}} */
function resolveKey(name, { secrets, baseUrl } = {}) {
  const envName = ENV[name];
  const envVal = envName ? String(process.env[envName] || '').trim() : '';
  const envAllowed = name === 'openai-admin' || isOfficial(baseUrl || '');
  if (envVal && envAllowed) return { value: envVal, source: 'env' };
  const stored = secrets && secrets.available ? secrets.get(name) : '';
  if (stored) return { value: stored, source: 'keychain' };
  return { value: '', source: null };
}

/** What the UI may know: where the key comes from, never the key. */
function keyStatus(name, { secrets, baseUrl } = {}) {
  const envName = ENV[name];
  const envSet = !!(envName && String(process.env[envName] || '').trim());
  const r = resolveKey(name, { secrets, baseUrl });
  return { envName, envSet, saved: !!(secrets && secrets.has(name)), source: r.source, envIgnored: envSet && r.source !== 'env' };
}

/**
 * Ask the user's login shell for PATH and the given variables (a GUI app does not inherit ~/.zshrc). Returns
 * { PATH, values: {NAME: value} } with only non-empty values; shell start-up noise before the output is ignored.
 */
function importShellEnv(names, { shell = process.env.SHELL || '/bin/zsh', env = process.env } = {}) {
  const want = names.filter((n) => /^[A-Z][A-Z0-9_]*$/.test(n));
  const script = ['printf "%s\\0" "$PATH"', ...want.map((n) => `printf "%s\\0" "\${${n}}"`)].join('; ');
  const out = require('child_process').execFileSync(shell, ['-ilc', script], { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env });
  const parts = out.split('\0');
  const vals = parts.slice(-(want.length + 1) - 1, -1); // [PATH, ...values]; anything before is start-up noise
  const values = {};
  want.forEach((n, i) => { const v = (vals[i + 1] || '').trim(); if (v) values[n] = v; });
  return { PATH: vals[0] ? vals[0].split('\n').pop() : '', values };
}

module.exports = { resolveKey, keyStatus, importShellEnv, ENV, SHELL_IMPORT };
