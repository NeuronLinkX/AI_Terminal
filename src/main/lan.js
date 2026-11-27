'use strict';
// macOS asks the user for "local network" access per APP, and only when the app's OWN process first talks to a local address:
// the `ssh` in a terminal tab is a child process and never triggers the question, it is simply refused ("No route to host").
// probe() makes this process do one short connection attempt to the address, which is what makes macOS show its question (and, once
// the user has allowed it, lets the children of this app through). It sends nothing: connect, then close.
const net = require('net');
const os = require('os');
const dgram = require('dgram');
const { execFile } = require('child_process');

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

const v4 = (a) => a.split('.').reduce((n, x) => n * 256 + Number(x), 0) >>> 0;

/**
 * Is a private address on one of this Mac's own networks? { mine: [this Mac's IPv4 addresses], same: boolean }, or null when `host`
 * is not a private IPv4 address (a name, a public address: nothing to compare). Routed networks and VPNs can still reach a server
 * that is not on the same subnet, so a "not the same" answer is only a hint to show AFTER a connection has already failed.
 */
function networkOf(host, ifaces = os.networkInterfaces()) {
  if (!isPrivateV4(host)) return null;
  const mine = [];
  let same = false;
  for (const list of Object.values(ifaces || {})) {
    for (const i of list || []) {
      if ((i.family !== 'IPv4' && i.family !== 4) || i.internal || !isPrivateV4(i.address)) continue;
      mine.push(i.address);
      if (i.netmask && ((v4(i.address) & v4(i.netmask)) >>> 0) === ((v4(host) & v4(i.netmask)) >>> 0)) same = true;
    }
  }
  return { mine, same };
}

/** { host, mine } when the server of an ssh target is a private address outside every network this Mac is on (and it has one), else null. */
function networkNote(target, ifaces) {
  const host = target && (target.hostName || target.host);
  const n = networkOf(host, ifaces);
  return n && n.mine.length && !n.same ? { host, mine: n.mine.slice(0, 3) } : null;
}

/** The smallest valid mDNS (Bonjour) question, "which services exist here" (PTR _services._dns-sd._udp.local). Nothing private in it. */
function mdnsQuery() {
  const name = Buffer.concat([...['_services', '_dns-sd', '_udp', 'local'].map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);
  const head = Buffer.alloc(12);
  head.writeUInt16BE(1, 4); // one question
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(12, 0); // PTR
  tail.writeUInt16BE(1, 2); // IN
  return Buffer.concat([head, name, tail]);
}

const defaultGateway = () => new Promise((resolve) => execFile('/sbin/route', ['-n', 'get', 'default'], { timeout: 2000 }, (e, out) => resolve(e ? '' : (String(out).match(/gateway:\s*(\S+)/) || [])[1] || '')));

/**
 * Makes THIS process touch the local network, which is what makes macOS show its "allow local network access" question (the Settings
 * > Privacy & Security > Local Network entry only exists after that question): one Bonjour question to the multicast group and one
 * connection attempt to the router. Works on any network, so it does not depend on the server being reachable. macOS shows the
 * question once; after an answer (either one) this does nothing visible.
 * @returns {Promise<{multicast: boolean, gateway: string, probe: string}>} probe: connected | refused (the router answered: access works) | blocked | timeout | error | ''
 */
async function request({ dgramMod = dgram, probeImpl = probe, gatewayImpl = defaultGateway } = {}) {
  const result = { multicast: false, gateway: '', probe: '' };
  await new Promise((resolve) => {
    let s;
    try { s = dgramMod.createSocket('udp4'); } catch { return resolve(); }
    const done = () => { clearTimeout(cap); try { s.close(); } catch { /* closed */ } resolve(); };
    const cap = setTimeout(done, 1500); // a send that macOS holds back must not hold this up
    s.on('error', done);
    try { s.send(mdnsQuery(), 5353, '224.0.0.251', (err) => { result.multicast = !err; setTimeout(done, 200); }); } catch { done(); }
  });
  const gw = await Promise.race([Promise.resolve(gatewayImpl()).catch(() => ''), new Promise((r) => setTimeout(() => r(''), 2500))]);
  if (isPrivateV4(gw)) {
    result.gateway = gw;
    const r = await probeImpl(gw, 80, 1500);
    result.probe = (r && r.code) || '';
  }
  return result;
}

module.exports = { probe, isPrivateV4, networkOf, networkNote, request, mdnsQuery };
