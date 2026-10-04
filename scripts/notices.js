#!/usr/bin/env node
'use strict';
// Generates THIRD_PARTY_NOTICES.md from the production dependency tree actually installed in node_modules
// (name, version, license identifier, homepage) — no hand-copied list.   node scripts/notices.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const tree = JSON.parse(execFileSync('npm', ['ls', '--omit=dev', '--all', '--json', '--long'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 }));
const seen = new Map();
(function walk(deps) {
  for (const [name, d] of Object.entries(deps || {})) {
    const key = `${name}@${d.version}`;
    if (!seen.has(key)) {
      let pkg = {};
      try { pkg = JSON.parse(fs.readFileSync(path.join(d.path || path.join(root, 'node_modules', name), 'package.json'), 'utf8')); } catch { /* use tree data */ }
      const lic = typeof pkg.license === 'string' ? pkg.license : pkg.license && pkg.license.type ? pkg.license.type : (pkg.licenses || []).map((l) => l.type).join(' OR ') || 'UNKNOWN';
      const home = pkg.homepage || (pkg.repository && (pkg.repository.url || pkg.repository)) || '';
      seen.set(key, { name, version: d.version, license: lic, home: String(home).replace(/^git\+/, '').replace(/\.git$/, '') });
    }
    walk(d.dependencies);
  }
})(tree.dependencies);

const rows = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
const out = [
  '# Third-party notices',
  '',
  'AI Terminal is built on the open-source components below. The list is generated from the production dependencies installed in `node_modules` (`node scripts/notices.js`); each component remains under its own license.',
  '',
  '## Bundled in the app',
  '',
  '| Component | Version | License | Source |',
  '|---|---|---|---|',
  ...rows.map((r) => `| ${r.name} | ${r.version} | ${r.license} | ${r.home || '—'} |`),
  '',
  '**Electron** (Chromium + Node.js) is the runtime of the app. Its own license texts ship inside the app bundle (`LICENSE` and `LICENSES.chromium.html` in `AI Terminal.app/Contents/Resources` / the Electron framework folder).',
  '',
  '## Used but NOT bundled (installed separately by the user)',
  '',
  '| Component | How the app uses it | License |',
  '|---|---|---|',
  '| [Ollama](https://github.com/ollama/ollama) | local model server the app talks to over HTTP (127.0.0.1) | MIT |',
  '| [llama.cpp](https://github.com/ggml-org/llama.cpp) | the inference engine inside Ollama; `native/kvprof` (a research tool, not shipped in the app) links libllama | MIT |',
  '| Language models (e.g. Qwen3) | downloaded by the user with `ollama pull`; never redistributed by this project | per model (Qwen3: Apache-2.0) |',
  '| Vim | the system `vim` is started with the app\'s configuration; no Vim code is shipped | Vim license |',
  '',
  '## Research the design is based on',
  '',
  'Algorithms in `src/main/kv/` and `native/` are independent implementations of ideas from published papers (see `docs/KV_CACHE.md` for the list and links); no source code from those projects is included.',
  '',
];
fs.writeFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), out.join('\n'));
console.log(`THIRD_PARTY_NOTICES.md: ${rows.length} packages`);
