'use strict';
// Append-only audit log of everything the AI ran or was asked to run (JSON Lines, one file per month, secrets masked).
// Exportable as Markdown or JSON from the Settings window.
const fs = require('fs');
const path = require('path');
const { maskSecrets, truncateMiddle } = require('./text');

class Audit {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'audit');
  }

  _file(d = new Date()) {
    return path.join(this.dir, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.jsonl`);
  }

  /** entry: { tab, cwd, kind: command|file|plan, subject, decision, reasons?, exitCode?, durationMs? } */
  log(entry) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const rec = { ts: new Date().toISOString(), ...entry, subject: truncateMiddle(maskSecrets(String(entry.subject || '')), 600) };
      fs.appendFileSync(this._file(), JSON.stringify(rec) + '\n');
    } catch {
      /* auditing must never break a task */
    }
  }

  read({ days = 31 } = {}) {
    const since = Date.now() - days * 864e5;
    const out = [];
    let files = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.jsonl')).sort();
    } catch {
      return out;
    }
    for (const f of files) {
      for (const line of fs.readFileSync(path.join(this.dir, f), 'utf8').split('\n')) {
        if (!line) continue;
        try {
          const r = JSON.parse(line);
          if (Date.parse(r.ts) >= since) out.push(r);
        } catch { /* skip a damaged line */ }
      }
    }
    return out;
  }

  export(format = 'md', opts) {
    const rows = this.read(opts);
    if (format === 'json') return JSON.stringify(rows, null, 1);
    const label = { allowed: '자동 허용', approved: '승인', denied: '거부', blocked: '차단', 'auto-rule': '허용 규칙으로 자동 승인', trust: '신뢰 모드 자동 승인', done: '실행됨' };
    const lines = ['# AI Terminal 실행·승인 기록', '', `내보낸 시각: ${new Date().toLocaleString('ko-KR')} · 항목 ${rows.length}개 (비밀 정보는 마스킹됨)`, '', '| 시각 | 탭 | 종류 | 대상 | 결정 | 종료코드 | 사유 |', '|---|---|---|---|---|---|---|'];
    for (const r of rows) {
      lines.push(`| ${r.ts.replace('T', ' ').slice(0, 19)} | ${r.tab || ''} | ${r.kind} | \`${String(r.subject).replace(/\|/g, '\\|').replace(/\n/g, ' ')}\` | ${label[r.decision] || r.decision} | ${r.exitCode ?? ''} | ${(r.reasons || []).join('; ').replace(/\|/g, '\\|')} |`);
    }
    return lines.join('\n') + '\n';
  }
}

module.exports = { Audit };
