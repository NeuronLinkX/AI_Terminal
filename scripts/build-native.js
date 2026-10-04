#!/usr/bin/env node
'use strict';
// Builds the C++ research tools in native/ (kvprof: per-layer attention profiler on top of libllama).
//   node scripts/build-native.js            build build/native/kvprof and run its self-test
// Needs Homebrew's llama.cpp (brew install llama.cpp) and Apple's command line tools. Not part of the app bundle:
// the app itself needs no native code beyond node-pty; these tools back the layer-wise KV study (docs/KV_CACHE.md).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const out = path.join(root, 'build', 'native', 'kvprof');
const brew = fs.existsSync('/opt/homebrew/include/llama.h') ? '/opt/homebrew' : fs.existsSync('/usr/local/include/llama.h') ? '/usr/local' : null;

function build() {
  if (!brew) return { ok: false, reason: 'llama.h not found — install with `brew install llama.cpp`' };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const arch = process.env.AIT_ARCH || (process.arch === 'arm64' ? 'arm64' : 'x86_64');
  const base = ['-std=c++17', '-O2', '-Wall', '-Wextra', '-arch', arch, path.join(root, 'native', 'kvprof.cpp'), `-I${brew}/include`, `-L${brew}/lib`, '-lllama', '-lggml', '-lggml-base', `-Wl,-rpath,${brew}/lib`, '-o', out];
  // a brand-new macOS SDK can be newer than the command line tools' linker: fall back to the older SDKs that are installed
  const sdkDir = '/Library/Developer/CommandLineTools/SDKs';
  const sdks = [null, ...(fs.existsSync(sdkDir) ? fs.readdirSync(sdkDir).filter((d) => /^MacOSX\d+(\.\d+)?\.sdk$/.test(d)).sort().reverse().map((d) => path.join(sdkDir, d)) : [])];
  let last = '';
  for (const sdk of sdks) {
    const r = spawnSync('/usr/bin/clang++', sdk ? ['-isysroot', sdk, ...base] : base, { encoding: 'utf8' });
    if (r.status === 0) return { ok: true, sdk };
    last = (r.stderr || '').split('\n').slice(0, 6).join('\n');
  }
  return { ok: false, reason: last };
}

if (require.main === module) {
  const r = build();
  if (!r.ok) { console.error('native build failed:', r.reason); process.exit(1); }
  console.log(`built ${path.relative(root, out)}${r.sdk ? ` (SDK ${path.basename(r.sdk)})` : ''}`);
  const t = spawnSync(out, ['--selftest'], { encoding: 'utf8' });
  process.stdout.write(t.stdout);
  process.exit(t.status || 0);
}
module.exports = { build, out };
