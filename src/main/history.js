'use strict';
// Session history (conversation + executed steps) and tab restoration state. Everything is stored locally as JSON Lines
// under the app data folder; nothing leaves the Mac. Large outputs are trimmed and secrets are masked before writing.
const fs = require('fs');
const path = require('path');
const { maskSecrets, truncateMiddle } = require('./text');

const MAX_SESSIONS = 200;

class History {
  constructor(dataDir, settings) {
    this.dir = path.join(dataDir, 'history');
    this.settings = settings;
    this.files = new Map(); // live session id -> file path
  }

  enabled() {
    return !this.settings || this.settings.get('keepHistory');
  }

  /** Begin a new session record for a tab (the file is created lazily on the first entry). */
  start(tabId, cwd) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const id = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${tabId}`;
    this.files.set(id, path.join(this.dir, `${id}.jsonl`));
    this.meta = this.meta || new Map();
    this.meta.set(id, { cwd });
    return id;
  }

  append(id, entry) {
    if (!this.enabled() || !this.files.has(id)) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const file = this.files.get(id);
      if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ t: 'meta', ts: new Date().toISOString(), cwd: (this.meta.get(id) || {}).cwd }) + '\n');
      const slim = JSON.parse(JSON.stringify(entry, (k, v) => (typeof v === 'string' ? truncateMiddle(maskSecrets(v), k === 'output' ? 4000 : 2000) : v)));
      fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...slim }) + '\n');
    } catch {
      /* history is best-effort */
    }
  }

  _read(file) {
    const out = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip damaged line */ }
    }
    return out;
  }

  list(limit = 100) {
    let names = [];
    try { names = fs.readdirSync(this.dir).filter((f) => f.endsWith('.jsonl')).sort().reverse(); } catch { return []; }
    return names.slice(0, limit).map((f) => {
      const id = f.replace(/\.jsonl$/, '');
      const rows = this._read(path.join(this.dir, f));
      const meta = rows.find((r) => r.t === 'meta') || {};
      const first = rows.find((r) => r.t === 'user');
      return { id, startedAt: meta.ts || '', cwd: meta.cwd || '', title: first ? String(first.text).slice(0, 80) : '(요청 없음)', turns: rows.filter((r) => r.t === 'user').length };
    }).filter((s) => s.turns > 0);
  }

  read(id) {
    const file = path.join(this.dir, `${path.basename(id)}.jsonl`);
    return fs.existsSync(file) ? this._read(file) : [];
  }

  /** Case-insensitive full-text search over user requests, AI messages and commands. */
  search(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const hits = [];
    for (const s of this.list(MAX_SESSIONS)) {
      for (const r of this.read(s.id)) {
        // every searchable field of the record: a command-result has both the command and its output
        const text = r.t === 'user' ? r.text : r.ev && [r.ev.text, r.ev.command, r.ev.output, r.ev.message, r.ev.path].filter(Boolean).join('\n');
        if (text && String(text).toLowerCase().includes(q)) {
          const i = String(text).toLowerCase().indexOf(q);
          hits.push({ id: s.id, title: s.title, ts: r.ts, snippet: String(text).slice(Math.max(0, i - 30), i + 90).replace(/\n/g, ' ') });
          break; // one hit per session is enough for the list
        }
      }
    }
    return hits.slice(0, 50);
  }

  toMarkdown(id) {
    const rows = this.read(id);
    const meta = rows.find((r) => r.t === 'meta') || {};
    const out = [`# MacAIterm 세션 ${id}`, '', `- 시작: ${meta.ts || ''}`, `- 디렉터리: \`${meta.cwd || ''}\``, ''];
    for (const r of rows) {
      if (r.t === 'user') out.push(`## 🧑 ${r.mode === 'shell' ? '`$` ' : ''}${r.text}`, '');
      else if (r.t === 'ai' && r.ev) {
        const e = r.ev;
        if (e.type === 'say') out.push(`**AI**: ${e.text}`, '');
        else if (e.type === 'command-start') out.push('```bash', `$ ${e.command}`, '```');
        else if (e.type === 'command-result') out.push('```', (e.output || '(출력 없음)').trimEnd(), `[종료코드 ${e.exitCode}]`, '```', '');
        else if (e.type === 'file-write') out.push(`✏️ \`${e.path}\` ${e.created ? '생성' : '수정'} (+${e.diff ? e.diff.added : 0}/-${e.diff ? e.diff.removed : 0})`, '', '```diff', ...(e.diff ? e.diff.lines : []), '```', '');
        else if (e.type === 'plan') out.push('**계획**', ...e.steps.map((s, i) => `${i + 1}. ${s}`), '');
        else if (e.type === 'error') out.push(`> ❌ ${e.message}`, '');
      }
    }
    return out.join('\n') + '\n';
  }

  remove(id) {
    try { fs.rmSync(path.join(this.dir, `${path.basename(id)}.jsonl`), { force: true }); } catch { /* ignore */ }
  }

  prune(max = MAX_SESSIONS) {
    try {
      const names = fs.readdirSync(this.dir).filter((f) => f.endsWith('.jsonl')).sort();
      for (const f of names.slice(0, Math.max(0, names.length - max))) fs.rmSync(path.join(this.dir, f), { force: true });
    } catch { /* ignore */ }
  }
}

/** Which tabs were open (and where) when the app last quit, so the next launch can restore them. */
class TabState {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'tabs.json');
  }
  save(tabs, active) {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ tabs, active }));
    } catch { /* ignore */ }
  }
  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const tabs = (j.tabs || []).filter((t) => t && typeof t.cwd === 'string' && fs.existsSync(t.cwd)).slice(0, 12).map((t) => ({ cwd: t.cwd, title: typeof t.title === 'string' ? t.title.slice(0, 40) : '' }));
      return { tabs, active: Math.min(Math.max(0, j.active || 0), Math.max(0, tabs.length - 1)) };
    } catch {
      return { tabs: [], active: 0 };
    }
  }
}

module.exports = { History, TabState };
