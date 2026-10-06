#!/usr/bin/env node
'use strict';
// Build the macOS app. The CPU architecture is NOT hard-coded: by default the build targets this machine's CPU.
//   npm run dist                  -> this Mac's architecture (arm64 on Apple Silicon, x64 on Intel)
//   npm run dist -- --arch=x64    -> force Intel
//   npm run dist:arm64 | dist:x64 | dist:universal
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const given = (process.argv.find((a) => a.startsWith('--arch=')) || '').split('=')[1];
const host = process.arch === 'arm64' ? 'arm64' : 'x64';
const arch = given || host;
if (!['arm64', 'x64', 'universal'].includes(arch)) {
  console.error(`unknown --arch=${arch} (use arm64, x64 or universal)`);
  process.exit(2);
}

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
};

console.log(`\n▶ building MacAIterm for ${arch}${given ? '' : ' (this Mac)'}\n`);
run(process.execPath, [path.join(__dirname, 'stamp.js')]); // build time shown in the app
run(path.join(root, 'node_modules', '.bin', 'electron-builder'), ['--mac', 'dmg', 'zip', `--${arch}`]);
run(process.execPath, [path.join(__dirname, 'detach-dmg.js')]); // electron-builder leaves the DMG mounted
