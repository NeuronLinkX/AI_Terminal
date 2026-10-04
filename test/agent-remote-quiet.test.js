'use strict';
// The AI's file tools on a real ssh session use the tab's own ssh connection when it provably reaches the same account as the
// terminal — nothing is typed into the user's terminal — and fall back to the terminal otherwise. Real sshd (helpers/sshd.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PtySession } = require('../src/main/pty-session');
const { Agent } = require('../src/main/agent');
const { Settings } = require('../src/main/settings');
const { SshLink } = require('../src/main/sshlink');
const { parseSshArgs } = require('../src/main/ssh');
const { startSshd } = require('./helpers/sshd');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ait-quiet-')));
const shorts = [];
const shortDir = () => { const d = fs.mkdtempSync('/tmp/aq-'); shorts.push(d); return d; }; // unix socket paths are limited to ~100 characters

let srv;
let home;
test.before(async () => { home = tmp(); srv = await startSshd({ home }); });
test.after(() => { if (srv) srv.stop(); for (const d of shorts) fs.rmSync(d, { recursive: true, force: true }); });
const need = (t) => { if (srv) return true; t.skip('sshd cannot run here'); return false; };

async function sshSession() {
  const s = new PtySession({ cwd: tmp() }).start();
  await new Promise((r) => { const i = setInterval(() => s.integrated && (clearInterval(i), r()), 50); });
  const r = await s.runCommand(srv.command, { idleMs: 1500, maxMs: 12000 });
  assert.equal(r.status, 'running', JSON.stringify(r));
  await sleep(500);
  return s;
}

function makeAgent(session) {
  const dataDir = tmp();
  const llm = { status: { active: { id: 'ollama' } }, ollama: { lastPlan: { ctx: 12288 } }, complete: async () => ({ text: '{}', provider: { label: 'script' } }) };
  const agent = new Agent({ session, llm, dataDir, settings: new Settings(dataDir) });
  agent.attach({ tabId: 't1', lang: () => 'ko' });
  const events = [];
  agent.on('event', (e) => events.push(e));
  return { agent, events };
}
function approveAll(agent, events) {
  const seen = new Set();
  const iv = setInterval(() => { for (const e of events) if (e.type === 'approval' && !seen.has(e.id)) { seen.add(e.id); agent.gate.answer(e.id, true); } }, 20);
  return () => clearInterval(iv);
}
const target = () => ({ ...parseSshArgs(srv.command), label: 'quiet-box', id: `${srv.user}@127.0.0.1:${srv.port}` });

test('file tools take the quiet route: nothing is typed into the terminal, results are the same', async (tc) => {
  if (!need(tc)) return;
  fs.writeFileSync(path.join(home, 'notes.txt'), 'alpha\nbeta needle\ngamma\n');
  const s = await sshSession();
  const typed = [];
  s.on('data', (t) => typed.push(t));
  const link = new SshLink(target(), { ctl: shortDir() });
  const { agent, events } = makeAgent(s);
  agent.linkProvider = () => link;
  try {
    const r = await agent.setRemote(true, { target: target() });
    assert.equal(r.ok, true, JSON.stringify(r));
    typed.length = 0;
    const sig = new AbortController().signal;
    const log = { commands: [], files: [], failures: 0 };
    let o = await agent._remoteRead('notes.txt');
    assert.match(o.content, /beta needle/);
    o = await agent._remoteSearch('needle', '.');
    assert.equal(o.count, 1);
    const stop = approveAll(agent, events);
    o = await agent._remoteWrite('made.txt', 'hello over the quiet route\n', sig, log);
    o = await agent._remoteEdit('notes.txt', 'gamma', 'GAMMA', sig, log);
    stop();
    assert.equal(fs.readFileSync(path.join(home, 'made.txt'), 'utf8'), 'hello over the quiet route\n');
    assert.match(fs.readFileSync(path.join(home, 'notes.txt'), 'utf8'), /GAMMA/);
    const seen = typed.join('');
    assert.ok(!/AITBEGIN|base64|sha256sum|AITOK|sh -c/.test(seen), 'the terminal stayed quiet: ' + seen.slice(0, 200));
    assert.equal(agent._quiet.ok, true);
  } finally { link.close(); s.kill(); }
});

test('the quiet route is refused when it would reach a different account than the terminal (nested ssh / su): the terminal route is used', async (tc) => {
  if (!need(tc)) return;
  fs.writeFileSync(path.join(home, 'who.txt'), 'x\n');
  const s = await sshSession();
  const typed = [];
  s.on('data', (t) => typed.push(t));
  const link = new SshLink(target(), { ctl: shortDir() });
  const { agent } = makeAgent(s);
  agent.linkProvider = () => link;
  try {
    await agent.setRemote(true, { target: target() });
    agent.remoteInfo.user = 'somebody-else'; // the terminal is (pretend) another account than the link reaches
    agent._quiet = null;
    typed.length = 0;
    const o = await agent._remoteRead('who.txt');
    assert.match(o.content, /^x/);
    assert.equal(agent._quiet.ok, false);
    assert.match(typed.join(''), /AITBEGIN|sh -c/, 'it went through the terminal');
  } finally { link.close(); s.kill(); }
});

test('a link that cannot log in without a prompt falls back to the terminal, and is not retried', async (tc) => {
  if (!need(tc)) return;
  fs.writeFileSync(path.join(home, 'fb.txt'), 'fallback ok\n');
  const s = await sshSession();
  const bad = { ...target(), identityFiles: [], options: {}, port: 1 }; // nothing listens on port 1
  const link = new SshLink(bad, { ctl: shortDir() });
  const { agent } = makeAgent(s);
  agent.linkProvider = () => link;
  try {
    await agent.setRemote(true, { target: target() });
    const o = await agent._remoteRead('fb.txt');
    assert.match(o.content, /fallback ok/);
    assert.equal(agent._quiet.ok, false);
  } finally { link.close(); s.kill(); }
});
