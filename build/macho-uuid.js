'use strict';
// Gives a Mach-O executable its OWN LC_UUID (the identifier macOS's network layer keeps per-app policies under).
//
// Why: every app made from the same Electron release ships the very same main executable, so they all share one UUID (the stock
// Electron app, an older build of this app, this app under another bundle id ...). macOS keeps its "local network" decision per
// identity but enforces it per UUID: with several identities on one UUID, one that has already been answered makes macOS skip the
// question for the others, and they are blocked without ever being asked ("No route to host", no entry in Local Network settings).
// The new UUID is derived from the app id and the file's path inside the app, so it is stable: every rebuild keeps it.
//
// Only the 16 bytes of LC_UUID change (the signature is made afterwards). A thin 64-bit file or a fat one with 64-bit slices.
const crypto = require('crypto');
const fs = require('fs');

const LC_UUID = 0x1b;
const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const HEAD = 65536; // the load commands live in the first bytes of a slice

/** A version-5 style UUID (16 bytes) from a seed string. */
function uuidFor(seed) {
  const h = crypto.createHash('sha256').update(String(seed)).digest().subarray(0, 16);
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  return Buffer.from(h);
}

/** Rewrites LC_UUID inside ONE slice that starts at buf[0]. Returns { old, new } (hex) or null when there is none. */
function patchSlice(buf, seed) {
  if (buf.length < 32 || buf.readUInt32LE(0) !== MH_MAGIC_64) return null;
  const ncmds = buf.readUInt32LE(16);
  const cputype = buf.readUInt32LE(4);
  let off = 32;
  for (let i = 0; i < ncmds && off + 8 <= buf.length; i++) {
    const cmd = buf.readUInt32LE(off);
    const size = buf.readUInt32LE(off + 4);
    if (size < 8) return null;
    if (cmd === LC_UUID && size >= 24 && off + 24 <= buf.length) {
      const old = buf.subarray(off + 8, off + 24).toString('hex');
      const fresh = uuidFor(`${seed}|${cputype}`);
      fresh.copy(buf, off + 8);
      return { old, new: fresh.toString('hex') };
    }
    off += size;
  }
  return null;
}

/** Patches `file` in place. @returns {{old: string, new: string}[]} one entry per slice that had an LC_UUID */
function patchFile(file, seed) {
  const fd = fs.openSync(file, 'r+');
  try {
    const size = fs.fstatSync(fd).size;
    const read = (pos, len) => { const b = Buffer.alloc(Math.min(len, Math.max(0, size - pos))); fs.readSync(fd, b, 0, b.length, pos); return b; };
    const out = [];
    const head = read(0, 8);
    const magic = head.length === 8 ? head.readUInt32BE(0) : 0;
    const slices = [];
    if (magic === FAT_MAGIC || magic === FAT_MAGIC_64) {
      const n = head.readUInt32BE(4);
      const entry = magic === FAT_MAGIC ? 20 : 32;
      const table = read(8, n * entry);
      for (let i = 0; i < n; i++) slices.push(magic === FAT_MAGIC ? table.readUInt32BE(i * entry + 8) : Number(table.readBigUInt64BE(i * entry + 8)));
    } else slices.push(0);
    for (const pos of slices) {
      const buf = read(pos, HEAD);
      const r = patchSlice(buf, seed);
      if (!r) continue;
      fs.writeSync(fd, buf, 0, buf.length, pos);
      out.push(r);
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { patchFile, patchSlice, uuidFor };
