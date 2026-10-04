'use strict';
// User settings (persisted as JSON in the app data folder). Precedence: saved value > environment variable > default.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const CONTEXT_CHOICES = [4096, 8192, 12288, 16384, 24576, 32768];
const KEEPALIVE_CHOICES = ['0', '1m', '5m', '15m', '30m'];
const PERMISSION_CHOICES = ['readonly', 'default', 'ask-all']; // "trust" is never a persisted default

const FONT_CHOICES = ['sf-mono', 'menlo', 'monaco', 'courier'];
const FONT_STACKS = {
  'sf-mono': '"SF Mono", Menlo, Monaco, "Apple SD Gothic Neo", monospace',
  menlo: 'Menlo, Monaco, "Apple SD Gothic Neo", monospace',
  monaco: 'Monaco, Menlo, "Apple SD Gothic Neo", monospace',
  courier: '"Courier New", Courier, "Apple SD Gothic Neo", monospace',
};
const CURSOR_CHOICES = ['block', 'bar', 'underline'];
const LANG_CHOICES = ['auto', 'ko', 'en'];
const KV_CHOICES = ['auto', 'f16', 'q8_0', 'q4_0'];
const COMPACT_CHOICES = ['auto', 'aggressive', 'off'];
const KEY_ACTIONS = ['new-tab', 'close-tab', 'next-tab', 'prev-tab', 'focus-ai', 'focus-term', 'toggle-mode', 'stop', 'copy', 'reset', 'theme', 'settings', 'search', 'split', 'history', 'blocks', 'processes', 'toggle-plan'];
const DEFAULT_KEYS = { 'new-tab': 'CmdOrCtrl+T', 'close-tab': 'CmdOrCtrl+W', 'next-tab': 'CmdOrCtrl+Shift+]', 'prev-tab': 'CmdOrCtrl+Shift+[', 'focus-ai': 'CmdOrCtrl+L', 'focus-term': 'CmdOrCtrl+Shift+L', 'toggle-mode': 'CmdOrCtrl+J', stop: 'CmdOrCtrl+.', copy: 'CmdOrCtrl+Shift+C', reset: 'CmdOrCtrl+Shift+K', theme: 'CmdOrCtrl+Shift+D', settings: 'CmdOrCtrl+,', search: 'CmdOrCtrl+F', split: 'CmdOrCtrl+D', history: 'CmdOrCtrl+Y', blocks: 'CmdOrCtrl+B', processes: 'CmdOrCtrl+Shift+P', 'toggle-plan': 'CmdOrCtrl+Shift+Enter' };
const ACCEL = /^((CmdOrCtrl|Cmd|Ctrl|Alt|Option|Shift|Super)\+)*([A-Za-z0-9]|F\d{1,2}|Enter|Tab|Space|Up|Down|Left|Right|Plus|[.,;'`\[\]\\/=-])$/;
const int = (lo, hi) => (v) => Number.isInteger(v) && v >= lo && v <= hi;
const num = (lo, hi) => (v) => typeof v === 'number' && v >= lo && v <= hi;

const SCHEMA = {
  autoContext: { def: () => true, ok: (v) => typeof v === 'boolean' },
  preloadModel: { def: () => false, ok: (v) => typeof v === 'boolean' },
  blockNetwork: { def: () => false, ok: (v) => typeof v === 'boolean' },
  keepHistory: { def: () => true, ok: (v) => typeof v === 'boolean' },
  restoreTabs: { def: () => true, ok: (v) => typeof v === 'boolean' },
  updateCheck: { def: () => false, ok: (v) => typeof v === 'boolean' },
  fontFamily: { def: () => 'sf-mono', ok: (v) => FONT_CHOICES.includes(v) },
  fontSize: { def: () => 13, ok: int(10, 22) },
  lineHeight: { def: () => 1.18, ok: num(1, 1.6) },
  cursorStyle: { def: () => 'block', ok: (v) => CURSOR_CHOICES.includes(v) },
  cursorBlink: { def: () => true, ok: (v) => typeof v === 'boolean' },
  scrollback: { def: () => 10000, ok: (v) => [1000, 5000, 10000, 50000].includes(v) },
  windowOpacity: { def: () => 1, ok: num(0.6, 1) },
  language: { def: () => 'auto', ok: (v) => LANG_CHOICES.includes(v) },
  keybindings: { def: () => ({}), ok: (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.entries(v).every(([k, a]) => KEY_ACTIONS.includes(k) && typeof a === 'string' && ACCEL.test(a)) },
  openaiBaseUrl: { def: () => '', ok: (v) => typeof v === 'string' && (v === '' || /^https?:\/\/[^\s]+$/.test(v)) },
  openaiModel: { def: () => '', ok: (v) => typeof v === 'string' && v.length <= 100 },
  contextTokens: { def: () => (CONTEXT_CHOICES.includes(Number(process.env.AIT_OLLAMA_CTX)) ? Number(process.env.AIT_OLLAMA_CTX) : 12288), ok: (v) => CONTEXT_CHOICES.includes(v) },
  keepAlive: { def: () => (KEEPALIVE_CHOICES.includes(process.env.AIT_OLLAMA_KEEPALIVE) ? process.env.AIT_OLLAMA_KEEPALIVE : '5m'), ok: (v) => KEEPALIVE_CHOICES.includes(v) },
  unloadOnClose: { def: () => true, ok: (v) => typeof v === 'boolean' },
  showMonitor: { def: () => true, ok: (v) => typeof v === 'boolean' },
  defaultPermission: { def: () => 'default', ok: (v) => PERMISSION_CHOICES.includes(v) },
  kvPrecision: { def: () => (KV_CHOICES.includes(process.env.AIT_KV_TYPE) ? process.env.AIT_KV_TYPE : 'auto'), ok: (v) => KV_CHOICES.includes(v) },
  ctxCompaction: { def: () => (COMPACT_CHOICES.includes(process.env.AIT_COMPACT) ? process.env.AIT_COMPACT : 'auto'), ok: (v) => COMPACT_CHOICES.includes(v) },
  // ---- SSH / remote mode ----
  sshAutoRemote: { def: () => 'ask', ok: (v) => ['ask', 'auto', 'off'].includes(v) }, // when an ssh session opens in a tab: ask to switch the AI to it / switch automatically / never
  sshStrict: { def: () => true, ok: (v) => typeof v === 'boolean' }, // remote commands that are not read-only ask for approval
  sshMonitor: { def: () => true, ok: (v) => typeof v === 'boolean' }, // show the server's CPU / memory / GPU next to this Mac's
  sshMonitorSec: { def: () => 3, ok: int(2, 30) },
  sshKeepAlive: { def: () => true, ok: (v) => typeof v === 'boolean' }, // ServerAliveInterval for connections opened from the SSH menu
  sshShare: { def: () => true, ok: (v) => typeof v === 'boolean' }, // share one login between the terminal, the file panel and the monitor (ControlMaster)
  sshFiles: { def: () => 'auto', ok: (v) => ['auto', 'manual'].includes(v) }, // open the server's file panel automatically when connected
};

class Settings extends EventEmitter {
  constructor(dir) {
    super();
    this.file = dir ? path.join(dir, 'settings.json') : null;
    this.saved = {};
    try {
      if (this.file) this.saved = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {};
    } catch {
      /* first run or unreadable: use defaults */
    }
  }
  get(key) {
    const spec = SCHEMA[key];
    if (!spec) return undefined;
    return key in this.saved && spec.ok(this.saved[key]) ? this.saved[key] : spec.def();
  }
  all() {
    return Object.fromEntries(Object.keys(SCHEMA).map((k) => [k, this.get(k)]));
  }
  defaults() {
    return Object.fromEntries(Object.keys(SCHEMA).map((k) => [k, SCHEMA[k].def()]));
  }
  /** @returns {boolean} true if the value was valid and stored */
  set(key, value) {
    const spec = SCHEMA[key];
    if (!spec || !spec.ok(value)) return false;
    const before = this.get(key);
    this.saved[key] = value;
    try {
      if (this.file) {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify(this.saved, null, 1));
      }
    } catch {
      /* keep in memory even if the disk write fails */
    }
    if (before !== value) this.emit('change', key, value, before);
    return true;
  }
  reset() {
    const keys = Object.keys(this.saved);
    this.saved = {};
    try {
      if (this.file) fs.rmSync(this.file, { force: true });
    } catch {
      /* ignore */
    }
    keys.forEach((k) => this.emit('change', k, this.get(k), undefined));
  }
}

module.exports = { Settings, KV_CHOICES, COMPACT_CHOICES, CONTEXT_CHOICES, KEEPALIVE_CHOICES, PERMISSION_CHOICES, FONT_CHOICES, FONT_STACKS, CURSOR_CHOICES, LANG_CHOICES, KEY_ACTIONS, DEFAULT_KEYS };
