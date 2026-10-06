#!/usr/bin/env node
'use strict';
// Compares a deployed copy of the website with the local site/ folder, file by file, and lists what the server lacks or serves differently.
//   node scripts/check-site.js https://macaiterm.dothome.co.kr        (the deployed site)
//   node scripts/check-site.js                                         (only checks that every reference inside site/ resolves locally)
// Read-only: it only downloads public files with GET requests. Typical result after a partial FTP upload: assets/img/* and release.js "missing".
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const site = path.join(__dirname, '..', 'site');
const base = (process.argv[2] || '').replace(/\/+$/, '');
const SKIP = new Set(['.nojekyll']); // not needed on the server

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const files = walk(site).map((f) => path.relative(site, f)).filter((f) => !SKIP.has(f)).sort();
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// references inside the pages (src / href / url()) that must resolve to a file of site/
function references() {
  const out = [];
  for (const f of files.filter((x) => /\.(html|css)$/.test(x))) {
    const text = fs.readFileSync(path.join(site, f), 'utf8');
    for (const m of text.matchAll(/(?:src|href|poster|action)="([^"#]+)(?:#[^"]*)?"|url\(['"]?([^)'"#]+)/g)) {
      const u = m[1] || m[2];
      if (!u || /^(?:[a-z][a-z0-9+.-]*:|\/\/|data:)/i.test(u)) continue;
      if (!/\.(png|jpe?g|css|js|html|php|ico|svg|webp|mp4|webm)$/i.test(u)) continue;
      out.push({ from: f, ref: u, file: path.normalize(path.join(path.dirname(f), u)) });
    }
  }
  return out;
}

(async () => {
  let bad = 0;
  const local = references().filter((r) => !fs.existsSync(path.join(site, r.file)));
  for (const r of local) { bad++; console.log(`  ! ${r.from} refers to ${r.ref}, which is not in site/`); }
  console.log(`local: ${references().length} references checked, ${local.length} unresolved`);
  if (!base) process.exit(bad ? 1 : 0);

  const missing = []; const different = []; let ok = 0;
  for (const f of files) {
    const url = `${base}/${f.split(path.sep).map(encodeURIComponent).join('/')}`;
    let res;
    try { res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'macaiterm-site-check' } }); } catch (e) { missing.push(`${f} (${e.cause ? e.cause.code : e.message})`); continue; }
    if (!res.ok) { missing.push(`${f} (HTTP ${res.status})`); continue; }
    const body = Buffer.from(await res.arrayBuffer());
    const want = fs.readFileSync(path.join(site, f));
    const type = res.headers.get('content-type') || '';
    if (/\.(png|jpe?g)$/.test(f) && !/image\//.test(type)) { missing.push(`${f} (served as ${type || 'unknown'}, not an image)`); continue; }
    if (/\.mp4$/.test(f) && !/video\/mp4|octet-stream/.test(type)) { missing.push(`${f} (served as ${type || 'unknown'}, not a video)`); continue; }
    if (/\.php$/.test(f)) { ok++; continue; }
    if (sha(body) === sha(want)) ok++;
    else different.push(`${f} (server ${body.length} B, local ${want.length} B${/\.html$/.test(f) ? '; an older version, or the host adds something to pages' : ''})`);
  }
  console.log(`\nserver ${base}: ${ok} of ${files.length} files match`);
  if (missing.length) { console.log(`\nMISSING on the server (${missing.length}): upload these`); missing.forEach((m) => console.log('  - ' + m)); }
  if (different.length) { console.log(`\nDIFFERENT on the server (${different.length}): upload again to replace`); different.forEach((m) => console.log('  - ' + m)); }
  if (!missing.length && !different.length) console.log('everything the pages need is on the server');
  process.exit(bad || missing.length || different.length ? 1 : 0);
})();
