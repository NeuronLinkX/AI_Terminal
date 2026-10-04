#!/usr/bin/env node
'use strict';
// Headless driver: real PTY shell + real LLM, prints the agent's event stream. Used for verification.
//   node scripts/headless.js <cwd> "<request>" [--approve]   (approvals are denied unless --approve)
const os = require('os');
const path = require('path');
const { PtySession } = require('../src/main/pty-session');
const { LlmManager } = require('../src/main/llm/manager');
const { Agent } = require('../src/main/agent');
const { Settings } = require('../src/main/settings');

(async () => {
  const [cwd, ...rest] = process.argv.slice(2);
  const approve = rest.includes('--approve');
  const requests = rest.filter((a) => !a.startsWith('--'));
  const dataDir = path.join(os.tmpdir(), 'ait-headless');
  const session = new PtySession({ cwd }).start();
  session.on('data', (d) => process.env.AIT_SHOW_PTY && process.stdout.write(d));
  await new Promise((r) => { const i = setInterval(() => { if (session.integrated) { clearInterval(i); r(); } }, 50); });
  const settings = new Settings(dataDir);
  const llm = new LlmManager({ dataDir, settings });
  await llm.detect();
  console.log('LLM:', llm.status.active ? llm.status.active.label : 'NONE', '| cwd:', session.cwd);
  const agent = new Agent({ session, llm, dataDir, settings });
  agent.on('event', (e) => {
    switch (e.type) {
      case 'say': return console.log(`  🤖 ${e.text}`);
      case 'command-start': return console.log(`  ▶ $ ${e.command}`);
      case 'command-result': return console.log(`  ◀ [${e.status} exit=${e.exitCode}] ${JSON.stringify((e.output || '').slice(0, 160))}`);
      case 'command-blocked': return console.log(`  ⛔ blocked: ${e.command} (${e.reasons.join('; ')})`);
      case 'approval':
        console.log(`  ❓ APPROVAL ${e.id}: ${e.command} — ${e.reasons.join('; ')} → ${approve ? 'APPROVE' : 'DENY'}`);
        return setTimeout(() => agent.answerApproval(e.id, approve), 50);
      case 'file-read': return console.log(`  📖 read ${e.path}`);
      case 'file-write': return console.log(`  ✏️ write ${e.path} (+${e.diff.added}/-${e.diff.removed})`);
      case 'error': return console.log(`  ❌ ${e.kind}: ${e.message} ${e.hint || ''}`);
      case 'summary': return console.log(`  Σ commands=${e.commands} failed=${e.failed} files=${e.files}`);
      case 'note': case 'aborted': case 'ask': return console.log(`  · ${e.type} ${e.text || ''}`);
      case 'status': if (e.phase === 'waiting-input') console.log('  ⏳', e.text);
    }
  });
  for (const req of requests) {
    console.log(`\n>>> ${req}`);
    const t = Date.now();
    await agent.handle(req);
    console.log(`    (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  }
  console.log('final cwd:', session.cwd);
  session.kill();
  process.exit(0);
})();
