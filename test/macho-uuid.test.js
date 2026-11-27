'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { patchFile, patchSlice, uuidFor } = require('../build/macho-uuid');

const U1 = Buffer.from('4c4c448f5555314 4a1abf1a26eb65237'.replace(/ /g, ''), 'hex');
/** A minimal 64-bit Mach-O slice: header, one dummy segment command, LC_UUID, then some code bytes. */
function slice(uuid = U1, cputype = 0x0100000c) {
  const hdr = Buffer.alloc(32);
  hdr.writeUInt32LE(0xfeedfacf, 0); hdr.writeUInt32LE(cputype, 4); hdr.writeUInt32LE(2, 12); hdr.writeUInt32LE(2, 16); hdr.writeUInt32LE(72 + 24, 20);
  const seg = Buffer.alloc(72); seg.writeUInt32LE(0x19, 0); seg.writeUInt32LE(72, 4);
  const cmd = Buffer.alloc(24); cmd.writeUInt32LE(0x1b, 0); cmd.writeUInt32LE(24, 4); uuid.copy(cmd, 8);
  return Buffer.concat([hdr, seg, cmd, Buffer.from('CODECODECODE')]);
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ait-uuid-'));

test('patchSlice: only the 16 UUID bytes change, deterministically, and differently per seed', () => {
  const a = slice(); const orig = Buffer.from(a);
  const r = patchSlice(a, 'com.example.app|MacOS/App');
  assert.equal(r.old, U1.toString('hex'));
  assert.notEqual(r.new, r.old);
  const diff = [...a].map((b, i) => (b === orig[i] ? -1 : i)).filter((i) => i >= 0);
  assert.ok(diff.length > 0 && diff.every((i) => i >= 32 + 72 + 8 && i < 32 + 72 + 24), `changed bytes: ${diff}`);
  const b = slice(); patchSlice(b, 'com.example.app|MacOS/App');
  assert.deepEqual(a, b, 'same seed, same result: a rebuild keeps the UUID');
  const c = slice(); patchSlice(c, 'com.example.app|MacOS/Other');
  assert.notDeepEqual(a, c, 'another executable gets another UUID');
  const v = uuidFor('x'); assert.equal(v[6] >> 4, 5); assert.equal(v[8] >> 6, 2);
});

test('patchSlice: not a 64-bit Mach-O, or no LC_UUID: nothing happens', () => {
  assert.equal(patchSlice(Buffer.from('#!/bin/sh\necho hi\n'.repeat(5)), 's'), null);
  const noUuid = slice(); noUuid.writeUInt32LE(0x19, 32 + 72); // the LC_UUID command becomes another command
  assert.equal(patchSlice(noUuid, 's'), null);
});

test('patchFile: a thin file and a fat file with two slices', () => {
  const d = tmp();
  const thin = path.join(d, 'thin'); fs.writeFileSync(thin, slice());
  const r = patchFile(thin, 'seed');
  assert.equal(r.length, 1);
  assert.equal(fs.readFileSync(thin).subarray(32 + 72 + 8, 32 + 72 + 24).toString('hex'), r[0].new);
  assert.equal(fs.readFileSync(thin).subarray(-12).toString(), 'CODECODECODE', 'the rest of the file is untouched');
  // fat: 2 slices at 16 KiB and 32 KiB
  const fat = Buffer.alloc(32768 + slice().length);
  fat.writeUInt32BE(0xcafebabe, 0); fat.writeUInt32BE(2, 4);
  for (const [i, [cpu, off]] of [[0x0100000c, 16384], [0x01000007, 32768]].entries()) { const e = 8 + i * 20; fat.writeUInt32BE(cpu, e); fat.writeUInt32BE(off, e + 8); fat.writeUInt32BE(slice().length, e + 12); slice(U1, cpu).copy(fat, off); }
  const f = path.join(d, 'fat'); fs.writeFileSync(f, fat);
  const rf = patchFile(f, 'seed');
  assert.equal(rf.length, 2);
  assert.notEqual(rf[0].new, rf[1].new, 'each architecture has its own UUID');
  fs.rmSync(d, { recursive: true, force: true });
});

test('a real binary keeps working after the patch: the tool still reads it and shows the new UUID', { skip: !fs.existsSync('/usr/bin/dwarfdump') || !fs.existsSync('/bin/ls') }, () => {
  const d = tmp();
  const f = path.join(d, 'ls'); fs.copyFileSync('/bin/ls', f);
  const before = execFileSync('/usr/bin/dwarfdump', ['--uuid', f], { encoding: 'utf8' });
  const r = patchFile(f, 'seed');
  if (!r.length) { fs.rmSync(d, { recursive: true, force: true }); return; } // system binary shapes vary: nothing to check
  const after = execFileSync('/usr/bin/dwarfdump', ['--uuid', f], { encoding: 'utf8' });
  assert.notEqual(after, before);
  for (const x of r) assert.ok(after.replace(/-/g, '').toLowerCase().includes(x.new), 'dwarfdump reports the new UUID');
  fs.rmSync(d, { recursive: true, force: true });
});
