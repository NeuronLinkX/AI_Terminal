'use strict';
// Streaming scanner for the private shell-integration sequences  ESC ] 777 ; ait ; <payload> BEL
// Splits PTY data into plain-text items and integration events, tolerating chunk boundaries.

const PREFIX = '\x1b]777;ait;';

function parsePayload(payload) {
  const [kind, a, b] = payload.split(';');
  const b64 = (v) => (v ? Buffer.from(v, 'base64').toString('utf8') : '');
  if (kind === 'C') return { type: 'start', command: b64(a) };
  if (kind === 'D') return { type: 'end', exitCode: Number.parseInt(a, 10), cwd: b64(b) };
  if (kind === 'A') return { type: 'ask', json: b64(a) }; // vim -> host: inline AI edit request
  return { type: 'unknown', payload };
}

class OscScanner {
  constructor() {
    this.pending = '';
  }

  /** @returns {Array<{text:string}|{event:object}>} */
  push(chunk) {
    const out = [];
    const s = this.pending + chunk;
    this.pending = '';
    let i = 0;
    while (i < s.length) {
      const esc = s.indexOf('\x1b', i);
      if (esc === -1) {
        out.push({ text: s.slice(i) });
        break;
      }
      if (esc > i) out.push({ text: s.slice(i, esc) });
      const rest = s.slice(esc);
      if (rest.startsWith(PREFIX)) {
        const end = rest.indexOf('\x07');
        if (end === -1) {
          if (rest.length > 8192) out.push({ text: rest });
          else this.pending = rest;
          break;
        }
        out.push({ event: parsePayload(rest.slice(PREFIX.length, end)) });
        i = esc + end + 1;
      } else if (PREFIX.startsWith(rest)) {
        this.pending = rest;
        break;
      } else {
        out.push({ text: '\x1b' });
        i = esc + 1;
      }
    }
    return out;
  }
}

module.exports = { OscScanner, PREFIX };
