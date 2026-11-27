'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { probe, isPrivateV4, networkOf, networkNote, request, mdnsQuery } = require('../src/main/lan');

test('private IPv4 ranges are recognised, public and malformed addresses are not', () => {
  for (const ok of ['10.0.0.1', '192.168.50.34', '172.16.0.9', '172.31.255.1', '169.254.1.1', '100.64.0.1']) assert.equal(isPrivateV4(ok), true, ok);
  for (const no of ['8.8.8.8', '172.32.0.1', '192.169.1.1', '100.128.0.1', '192.168.1.300', 'dgx', '192.168.1', '', null, '192.168.1.1; id']) assert.equal(isPrivateV4(no), false, String(no));
});

test('probe skips anything that is not a private address and never touches the network for it', async () => {
  assert.deepEqual(await probe('8.8.8.8'), { ok: false, code: 'skipped' });
  assert.deepEqual(await probe('example.com'), { ok: false, code: 'skipped' });
});

// what os.networkInterfaces() returns, for a Mac on 10.20.32.68/19 (and an unused tunnel)
const IFACES = {
  lo0: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }],
  en0: [{ address: '10.20.32.68', netmask: '255.255.224.0', family: 'IPv4', internal: false }, { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false }],
  utun3: [{ address: '100.88.1.2', netmask: '255.255.255.255', family: 'IPv4', internal: false }],
};

test('networkOf: is a private server address on one of this Mac\'s own networks?', () => {
  assert.deepEqual(networkOf('192.168.7.34', IFACES), { mine: ['10.20.32.68', '100.88.1.2'], same: false });
  assert.equal(networkOf('10.20.32.200', IFACES).same, true, 'inside the /19 of en0');
  assert.equal(networkOf('10.20.64.1', IFACES).same, false, 'just outside it');
  assert.equal(networkOf('100.88.1.2', IFACES).same, true);
  assert.equal(networkOf('100.88.1.3', IFACES).same, false, 'a /32 tunnel address matches only itself');
  for (const no of ['dgx', '8.8.8.8', '', null, undefined, '192.168.1.300']) assert.equal(networkOf(no, IFACES), null, String(no));
  assert.deepEqual(networkOf('192.168.7.34', {}), { mine: [], same: false });
});

test('networkNote: only when the server is on another network and this Mac has one', () => {
  assert.deepEqual(networkNote({ hostName: '192.168.7.34' }, IFACES), { host: '192.168.7.34', mine: ['10.20.32.68', '100.88.1.2'] });
  assert.deepEqual(networkNote({ host: '192.168.7.34' }, IFACES), { host: '192.168.7.34', mine: ['10.20.32.68', '100.88.1.2'] });
  assert.equal(networkNote({ hostName: '10.20.32.200' }, IFACES), null, 'same network: no note');
  assert.equal(networkNote({ hostName: 'dgx.example.com' }, IFACES), null, 'a name or public address: nothing to compare');
  assert.equal(networkNote({ hostName: '192.168.7.34' }, { lo0: IFACES.lo0 }), null, 'no network at all is a different problem');
  assert.equal(networkNote(null, IFACES), null);
  assert.ok(networkNote({ hostName: '192.168.7.34' }, { a: Array.from({ length: 6 }, (_, i) => ({ address: `10.${i}.0.1`, netmask: '255.255.255.0', family: 'IPv4', internal: false })) }).mine.length <= 3);
});

test('mdnsQuery is one well-formed Bonjour question and carries nothing about this Mac', () => {
  const q = mdnsQuery();
  assert.equal(q.readUInt16BE(4), 1, 'one question');
  assert.equal(q.readUInt16BE(0), 0, 'id 0 as mDNS asks');
  assert.equal(q.subarray(12).toString('latin1').replace(/[\x00-\x20]/g, '.'), '._services._dns-sd._udp.local.....', 'the service-enumeration name, end mark, then type PTR and class IN');
  assert.equal(q.readUInt16BE(q.length - 4), 12);
  assert.equal(q.readUInt16BE(q.length - 2), 1);
});

test('request: one multicast question to 224.0.0.251:5353, then one connection attempt to the router; no network needed for the rest', async () => {
  const sent = [];
  const fakeDgram = { createSocket: () => ({ on() {}, send: (buf, port, addr, cb) => { sent.push({ port, addr, len: buf.length }); cb(null); }, close() {} }) };
  const probed = [];
  const r = await request({ dgramMod: fakeDgram, gatewayImpl: async () => '10.20.32.1', probeImpl: async (h, p, t) => { probed.push([h, p, t]); return { ok: false, code: 'timeout' }; } });
  assert.deepEqual(r, { multicast: true, gateway: '10.20.32.1', probe: 'timeout' });
  assert.deepEqual(sent.map((x) => [x.addr, x.port]), [['224.0.0.251', 5353]]);
  assert.deepEqual(probed, [['10.20.32.1', 80, 1500]]);
  // no router found (or not a private address): only the multicast question, nothing else is contacted
  probed.length = 0;
  assert.deepEqual(await request({ dgramMod: fakeDgram, gatewayImpl: async () => '', probeImpl: async (...a) => probed.push(a) }), { multicast: true, gateway: '', probe: '' });
  assert.deepEqual(await request({ dgramMod: fakeDgram, gatewayImpl: async () => '8.8.8.8', probeImpl: async (...a) => probed.push(a) }), { multicast: true, gateway: '', probe: '' });
  assert.equal(probed.length, 0);
  // a socket that cannot be made does not throw
  assert.equal((await request({ dgramMod: { createSocket() { throw new Error('x'); } }, gatewayImpl: async () => '' })).multicast, false);
});

test('request: a send that never completes does not hang it (the settings button must come back)', async () => {
  const hung = { createSocket: () => ({ on() {}, send() { /* the callback never fires */ }, close() {} }) };
  const t0 = Date.now();
  const r = await request({ dgramMod: hung, gatewayImpl: () => new Promise(() => {}), probeImpl: async () => ({ code: 'blocked' }) });
  assert.deepEqual(r, { multicast: false, gateway: '', probe: '' });
  assert.ok(Date.now() - t0 < 5000, `returned after ${Date.now() - t0} ms`);
});
