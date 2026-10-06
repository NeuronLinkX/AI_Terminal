#!/usr/bin/env node
'use strict';
// Puts a line break after every sentence in the text of the site pages (English: site/*.html, Korean: site/ko/*.html), so a
// paragraph never starts its next sentence in the middle of a line. Safe to run again: sentences that already end in <br> are left alone.
//   node scripts/site-breaks.js            (rewrites the pages)    node scripts/site-breaks.js --check   (only reports; exit 1 when something would change)
// Not touched: tags and attributes, <code>/<pre>/<script>/<style>/<title>, code boxes, the license text, "run-in" labels such as <b>Notice.</b>
const fs = require('fs');
const path = require('path');

const site = path.join(__dirname, '..', 'site');
const check = process.argv.includes('--check');
const pages = [...fs.readdirSync(site).filter((f) => f.endsWith('.html')).map((f) => path.join(site, f)),
  ...(fs.existsSync(path.join(site, 'ko')) ? fs.readdirSync(path.join(site, 'ko')).filter((f) => f.endsWith('.html')).map((f) => path.join(site, 'ko', f)) : [])];

const ABBR = /(?:e\.g|i\.e|vs|etc)\.$/i;
// sentence end: . ! ? (optionally followed by a closing quote / bracket), blanks, then a new sentence (capital, Korean, opening quote)
const END = /([.!?][”"’)\]]?)([ \t\r\n]+)(?=[“"‘(\[]?[A-Z가-힣])/g;
const TRAIL = /([.!?][”"’)\]]?)[ \t\r\n]+$/;
const INLINE_OPEN = /^<(?:a|b|strong|em|code|span|i)\b/i;

function breaks(html) {
  const keep = [];
  // blocks that must stay exactly as they are
  let s = html.replace(/<(script|style|code|pre|title|textarea)\b[\s\S]*?<\/\1>|<div class="(?:code|license-text)"[\s\S]*?<\/div>|<!--[\s\S]*?-->/g, (m) => { keep.push(m); return `\u0000${keep.length - 1}\u0000`; });
  const bodyAt = s.indexOf('<body');
  const head = bodyAt < 0 ? '' : s.slice(0, bodyAt);
  const parts = (bodyAt < 0 ? s : s.slice(bodyAt)).split(/(<[^>]+>)/);
  let n = 0;
  for (let i = 0; i < parts.length; i += 2) { // even entries are text, odd entries are tags
    let t = parts[i];
    if (!t || !/[.!?]/.test(t)) continue;
    t = t.replace(END, (m, p, ws, off) => { if (ABBR.test(t.slice(0, off) + p.charAt(0))) return m; n++; return `${p}<br>`; });
    const next = parts[i + 1] || '';
    const mt = TRAIL.exec(t);
    if (mt && INLINE_OPEN.test(next) && !ABBR.test(t.slice(0, mt.index) + mt[1].charAt(0)) && !/^<(?:b|strong)\b/i.test(parts[i - 1] || '')) { // not inside a bold run-in label
      t = t.slice(0, mt.index) + mt[1] + '<br>'; n++;
    }
    parts[i] = t;
  }
  s = head + parts.join('');
  return { html: s.replace(/\u0000(\d+)\u0000/g, (m, i) => keep[Number(i)]), n };
}

let total = 0;
for (const f of pages) {
  const src = fs.readFileSync(f, 'utf8');
  const { html, n } = breaks(src);
  if (n) { total += n; console.log(`${path.relative(site, f).padEnd(18)} +${n}`); if (!check) fs.writeFileSync(f, html); }
}
console.log(total ? (check ? `${total} sentence break(s) missing` : `${total} sentence break(s) added`) : 'all sentences already end a line');
process.exit(check && total ? 1 : 0);
