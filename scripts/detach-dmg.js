// electron-builder leaves the freshly built DMG mounted after every build, which piles up "AI Terminal x.y.z N" volumes
// on the desktop. Detach every mounted copy of this project's DMGs (run automatically after `npm run dist`).
const { execFileSync } = require('child_process');
let info = '';
try {
  info = execFileSync('hdiutil', ['info'], { encoding: 'utf8' });
} catch {
  process.exit(0);
}
let n = 0;
for (const block of info.split(/^=+$/m)) {
  if (!/image-path\s*:.*AI Terminal-.*\.dmg/.test(block)) continue;
  for (const m of block.matchAll(/\/dev\/(disk\d+)\s*\n?/g)) {
    try {
      execFileSync('hdiutil', ['detach', `/dev/${m[1]}`, '-quiet']);
      n++;
      break;
    } catch {
      /* busy: try the next device node of the same image */
    }
  }
}
console.log(`detached ${n} stale DMG volume(s)`);
