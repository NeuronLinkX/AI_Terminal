'use strict';
// macOS asks the user for "local network" access per APP, and only when the app's OWN process first talks to a local address:
// the `ssh` in a terminal tab is a child process and never triggers the question, it is simply refused ("No route to host").
// probe() makes this process do one short connection attempt to the address, which is what makes macOS show its question (and, once
// the user has allowed it, lets the children of this app through). It sends nothing: connect, then close.
const net = require('net');

// private / link-local / carrier-grade NAT IPv4 addresses (the ranges the local-network permission covers)
const PRIVATE_V4 = /^(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})$/;
const isPrivateV4 = (h) => typeof h === 'string' && PRIVATE_V4.test(h) && h.split('.').every((n) => Number(n) <= 255);

/** @returns {Promise<{ok: boolean, code: string}>} code: connected | refused (the machine answered: allowed) | blocked | timeout | error */
function probe(host, port = 22, timeoutMs = 4000) {
  return new Promise((resolve) => {
    if (!isPrivateV4(host)) return resolve({ ok: false, code: 'skipped' });
    const s = net.createConnection({ host, port: Number(port) || 22 });
    let done = false;
    const end = (ok, code) => { if (done) return; done = true; s.destroy(); resolve({ ok, code }); };
    s.setTimeout(timeoutMs, () => end(false, 'timeout'));
    s.on('connect', () => end(true, 'connected'));
    s.on('error', (e) => end(e.code === 'ECONNREFUSED', e.code === 'ECONNREFUSED' ? 'refused' : e.code === 'EHOSTUNREACH' || e.code === 'ENETUNREACH' || e.code === 'EPERM' ? 'blocked' : 'error'));
  });
}

module.exports = { probe, isPrivateV4 };
