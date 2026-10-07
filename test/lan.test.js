'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { probe, isPrivateV4 } = require('../src/main/lan');

test('private IPv4 ranges are recognised, public and malformed addresses are not', () => {
  for (const ok of ['10.0.0.1', '192.168.50.34', '172.16.0.9', '172.31.255.1', '169.254.1.1', '100.64.0.1']) assert.equal(isPrivateV4(ok), true, ok);
  for (const no of ['8.8.8.8', '172.32.0.1', '192.169.1.1', '100.128.0.1', '192.168.1.300', 'dgx', '192.168.1', '', null, '192.168.1.1; id']) assert.equal(isPrivateV4(no), false, String(no));
});

test('probe skips anything that is not a private address and never touches the network for it', async () => {
  assert.deepEqual(await probe('8.8.8.8'), { ok: false, code: 'skipped' });
  assert.deepEqual(await probe('example.com'), { ok: false, code: 'skipped' });
});
