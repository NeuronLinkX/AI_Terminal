'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { Audit } = require('../src/main/audit');
const { History, TabState } = require('../src/main/history');
const { ProjectRules } = require('../src/main/projects');
const { cmp, repoSlug, checkForUpdate } = require('../src/main/updater');
const { listProcesses, signalProcess } = require('../src/main/procs');
const { OscScanner, PREFIX } = require('../src/main/osc');
const { assessCommand } = require('../src/main/policy');
const { maskSecrets, isSecretPath } = require('../src/main/text');
const { detectTestCommand, projectGuidance } = require('../src/main/context');
const { parsePlan, parseDecision, LlmError } = require('../src/main/llm/schema');
const { Settings, DEFAULT_KEYS, KEY_ACTIONS } = require('../src/main/settings');
const { extractSay } = require('../src/main/agent');

const tmp = (p = 'ait-be-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const b64 = (s) => Buffer.from(s).toString('base64');

test('audit: every decision is logged with secrets masked, exportable as JSON and Markdown', () => {
  const dir = tmp();
  const a = new Audit(dir);
  a.log({ tab: 't1', cwd: '/x', kind: 'command', subject: 'curl -H "Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz123456" https://x', decision: 'denied', reasons: ['network | blocked'] });
  a.log({ tab: 't1', cwd: '/x', kind: 'command', subject: 'ls', decision: 'allowed', exitCode: 0 });
  const rows = a.read();
  assert.equal(rows.length, 2);
  assert.ok(!JSON.stringify(rows).includes('sk-abcdefghijklmnopqrstuvwxyz123456'), 'the key is masked in the log');
  const md = a.export('md');
  assert.match(md, /\| 거부 \|/);
  assert.ok(md.includes('network \\| blocked'), 'pipes are escaped so the table stays valid');
  assert.equal(JSON.parse(a.export('json')).length, 2);
  fs.appendFileSync(path.join(dir, 'audit', fs.readdirSync(path.join(dir, 'audit'))[0]), '{broken\n');
  assert.equal(a.read().length, 2, 'a damaged line is skipped');
});

test('history: sessions are stored locally, masked, searchable, exportable, deletable, prunable; off switch respected', () => {
  const dir = tmp();
  const settings = new Settings(null);
  const h = new History(dir, settings);
  const id = h.start('t1', '/proj');
  h.append(id, { t: 'user', text: '서버를 실행해줘 password=hunter2hunter2', mode: 'ai' });
  h.append(id, { t: 'ai', ev: { type: 'command-start', command: 'npm start' } });
  h.append(id, { t: 'ai', ev: { type: 'command-result', command: 'npm start', exitCode: 0, output: 'listening on 3000' } });
  const list = h.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].turns, 1);
  assert.equal(list[0].cwd, '/proj');
  assert.ok(!fs.readFileSync(path.join(dir, 'history', `${id}.jsonl`), 'utf8').includes('hunter2hunter2'), 'secret masked on disk');
  assert.equal(h.search('LISTENING').length, 1, 'case-insensitive full-text search');
  assert.equal(h.search('nothing-like-this').length, 0);
  assert.match(h.toMarkdown(id), /npm start/);
  settings.set('keepHistory', false);
  h.append(id, { t: 'user', text: 'not stored', mode: 'ai' });
  assert.equal(h.read(id).filter((r) => r.text === 'not stored').length, 0, 'history off → nothing new is written');
  settings.set('keepHistory', true);
  for (let i = 0; i < 4; i++) { const x = h.start('t' + (i + 2), '/p'); h.append(x, { t: 'user', text: 'q' + i }); }
  h.prune(3);
  assert.equal(fs.readdirSync(path.join(dir, 'history')).length, 3);
  h.remove(id);
  assert.equal(h.read(id).length, 0);
  assert.equal(h.read('../../etc/passwd').length, 0, 'ids cannot escape the history folder');
});

test('tab state: restores only folders that still exist, clamps the active tab', () => {
  const dir = tmp();
  const t = new TabState(dir);
  const keep = tmp('ait-tab-');
  t.save([{ cwd: keep, title: '내 탭' }, { cwd: '/definitely/not/here', title: 'x' }], 5);
  const r = t.load();
  assert.deepEqual(r.tabs, [{ cwd: keep, title: '내 탭' }]);
  assert.equal(r.active, 0);
  assert.deepEqual(new TabState(tmp()).load(), { tabs: [], active: 0 });
});

test('project rules: stored in the app data folder per project root, never in the repository', () => {
  const dir = tmp();
  const repo = tmp('ait-repo-');
  execFileSync('git', ['init', '-q', repo]);
  fs.mkdirSync(path.join(repo, 'sub'));
  const p = new ProjectRules(dir);
  p.add(path.join(repo, 'sub'), 'rm a.txt', 'rm a.txt');
  assert.equal(p.list(repo).length, 1, 'a rule added from a sub-folder belongs to the whole repository');
  p.add(repo, 'rm a.txt', 'rm a.txt');
  assert.equal(p.list(repo).length, 1, 'no duplicates');
  assert.ok(fs.existsSync(path.join(dir, 'project-rules.json')));
  assert.equal(fs.readdirSync(repo).filter((f) => /rule/i.test(f)).length, 0);
  assert.equal(new ProjectRules(dir).list(repo).length, 1, 'persisted');
  p.remove(repo, 'rm a.txt');
  assert.equal(p.list(repo).length, 0);
});

test('updater: version compare, repository slug, release lookup outcomes (no network)', async () => {
  assert.equal(cmp('1.2.0', '1.1.9'), 1);
  assert.equal(cmp('v1.0.0', '1.0.0'), 0);
  assert.equal(cmp('0.9.9', '1.0.0'), -1);
  assert.match(repoSlug(), /^[\w.-]+\/[\w.-]+$/);
  const fake = (status, json) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => json });
  const rel = { tag_name: 'v9.9.9', html_url: 'https://github.com/x/y/releases/tag/v9.9.9', body: 'notes', assets: [{ name: 'AI-Terminal-9.9.9-arm64.dmg', browser_download_url: 'https://github.com/x/y/a.dmg' }, { name: 'AI-Terminal-9.9.9-x64.dmg', browser_download_url: 'https://github.com/x/y/b.dmg' }] };
  const a = await checkForUpdate('0.1.0', fake(200, rel));
  assert.equal(a.status, 'available');
  assert.equal(a.latest, '9.9.9');
  assert.match(a.downloadUrl, /\.dmg$/);
  assert.equal((await checkForUpdate('9.9.9', fake(200, rel))).status, 'current');
  assert.equal((await checkForUpdate('0.1.0', fake(404, {}))).status, 'unavailable');
  assert.equal((await checkForUpdate('0.1.0', fake(500, {}))).status, 'error');
  assert.equal((await checkForUpdate('0.1.0', async () => { throw new Error('offline'); })).status, 'error');
});

test('processes: lists descendants of a shell with listening ports; only descendants may be signalled', async () => {
  const child = spawn(process.execPath, ['-e', "require('http').createServer(()=>{}).listen(0,'127.0.0.1');setInterval(()=>{},1000)"], { stdio: 'ignore' });
  try {
    let found;
    for (let i = 0; i < 20 && !found; i++) {
      await new Promise((r) => setTimeout(r, 300));
      found = (await listProcesses(process.pid)).find((p) => p.pid === child.pid && p.ports.length);
    }
    assert.ok(found, 'child process with its listening port is listed');
    assert.match(found.ports[0], /^\d+$/);
    const other = await signalProcess(process.pid, process.ppid, 'SIGTERM');
    assert.equal(other.ok, false, 'a process that is not a descendant is refused');
    assert.equal((await signalProcess(process.pid, child.pid, 'SIGTERM')).ok, true);
    await new Promise((r) => child.once('exit', r));
  } finally { try { child.kill('SIGKILL'); } catch { /* gone */ } }
});

test('osc scanner: command start/end, vim AI request, chunk boundaries, stray escapes', () => {
  const s = new OscScanner();
  const ev = (str) => s.push(str).filter((x) => x.event).map((x) => x.event);
  assert.deepEqual(ev(`${PREFIX}C;${b64('ls -la')}\x07`), [{ type: 'start', command: 'ls -la' }]);
  assert.deepEqual(ev(`${PREFIX}D;3;${b64('/tmp')}\x07`), [{ type: 'end', exitCode: 3, cwd: '/tmp' }]);
  assert.deepEqual(ev(`${PREFIX}A;${b64('{"x":1}')}\x07`), [{ type: 'ask', json: '{"x":1}' }]);
  const whole = `before${PREFIX}C;${b64('echo hi')}\x07after`;
  const out = [];
  for (let i = 0; i < whole.length; i += 3) out.push(...s.push(whole.slice(i, i + 3))); // 3-byte chunks
  assert.equal(out.filter((x) => x.event).length, 1);
  assert.equal(out.filter((x) => x.text).map((x) => x.text).join(''), 'beforeafter');
  assert.equal(new OscScanner().push('\x1b[31mred\x1b[0m').map((x) => x.text).join(''), '\x1b[31mred\x1b[0m', 'ordinary colour codes pass through untouched');
});

test('policy: network-block mode denies network commands but not local ones; core safety rules unchanged', () => {
  const net = (c) => assessCommand(c, '/tmp', 0, { blockNetwork: true }).level;
  for (const c of ['curl -s https://example.com', 'wget http://x', 'ssh host', 'git push origin main', 'npm install left-pad', 'pip install requests']) assert.equal(net(c), 'deny', c);
  for (const c of ['ls -la', 'git status', 'node test.js', 'cat README.md']) assert.equal(net(c), 'allow', c);
  assert.equal(assessCommand('curl -s https://example.com', '/tmp').level, 'approve' === assessCommand('curl -s https://example.com', '/tmp').level ? 'approve' : assessCommand('curl -s https://example.com', '/tmp').level, 'without the mode curl follows the normal policy');
  assert.equal(assessCommand('rm -rf /', '/tmp').level, 'deny');
  assert.equal(assessCommand('git push origin main', '/tmp').level, 'approve');
});

test('secret masking: known formats and unknown high-entropy tokens, but not identifiers or paths', () => {
  const m = maskSecrets('token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 AKIAIOSFODNN7EXAMPLE key a8Zq3Kx9Lm2Pv7Rt1Wy4Bn6Cd5Fg0HjQs8U');
  assert.ok(!/ghp_abc|AKIAIOSF|a8Zq3Kx9/.test(m), m);
  const safe = 'const SomeVeryLongCamelCaseIdentifierNameForAComponent = require("./src/main/some/deep/path/file.js")';
  assert.equal(maskSecrets(safe), safe, 'long identifiers and paths are not secrets');
  assert.equal(maskSecrets('commit 3f1c36b7a9d2e4f5a6b7c8d9e0f1a2b3c4d5e6f7'), 'commit 3f1c36b7a9d2e4f5a6b7c8d9e0f1a2b3c4d5e6f7', 'git hashes are not secrets');
  assert.equal(isSecretPath('/Users/me/.ssh/id_rsa'), true);
  assert.equal(isSecretPath('/Users/me/project/src/app.js'), false);
});

test('context: test-command detection and project guidance files (AGENTS.md) with size limits', () => {
  const d = tmp('ait-proj-');
  assert.equal(detectTestCommand(d), '');
  fs.writeFileSync(path.join(d, 'package.json'), '{"scripts":{"test":"node t.js"}}');
  assert.equal(detectTestCommand(d), 'npm test');
  const r = tmp('ait-proj-');
  fs.writeFileSync(path.join(r, 'Cargo.toml'), '[package]');
  assert.equal(detectTestCommand(r), 'cargo test');
  const g = tmp('ait-proj-');
  assert.equal(projectGuidance(g), null);
  fs.writeFileSync(path.join(g, 'AGENTS.md'), '테스트는 npm test 로 실행하세요.');
  assert.equal(projectGuidance(g).file, 'AGENTS.md');
  fs.writeFileSync(path.join(g, 'AGENTS.md'), 'x'.repeat(50 * 1024));
  assert.equal(projectGuidance(g), null, 'oversized guidance files are ignored');
});

test('schema: plans are parsed and bounded; decisions reject unknown actions', () => {
  const p = parsePlan('```json\n{"say":"요약","plan":["a","b","","c"]}\n```'.replace(/```json\n|\n```/g, ''));
  assert.deepEqual(p.steps, ['a', 'b', 'c']);
  assert.equal(parsePlan(JSON.stringify({ say: '', plan: Array.from({ length: 20 }, (_, i) => 's' + i) })).steps.length, 8);
  assert.throws(() => parsePlan('{"say":"x","plan":[]}'), LlmError);
  assert.throws(() => parsePlan('no json here'), LlmError);
  assert.throws(() => parseDecision('{"say":"x","action":"format_disk"}'), LlmError);
  assert.equal(parseDecision('{"say":"x","action":"search","content":"foo"}').action, 'search');
});

test('settings: new keys validate; "trust" can never be a default; key bindings must be real accelerators', () => {
  const s = new Settings(tmp());
  assert.equal(s.set('defaultPermission', 'trust'), false);
  assert.equal(s.set('defaultPermission', 'ask-all'), true);
  assert.equal(s.set('kvPrecision', 'q8_0'), true);
  assert.equal(s.set('kvPrecision', 'q2_k'), false);
  assert.equal(s.set('ctxCompaction', 'aggressive'), true);
  assert.equal(s.set('ctxCompaction', 'maximum'), false);
  assert.equal(s.set('language', 'en'), true);
  assert.equal(s.set('language', 'fr'), false);
  assert.equal(s.set('fontSize', 40), false);
  assert.equal(s.set('openaiBaseUrl', 'javascript:alert(1)'), false);
  assert.equal(s.set('openaiBaseUrl', 'http://127.0.0.1:1234/v1'), true);
  assert.equal(s.set('keybindings', { 'new-tab': 'CmdOrCtrl+Shift+T' }), true);
  assert.equal(s.set('keybindings', { 'new-tab': 'NotAKey++' }), false);
  assert.equal(s.set('keybindings', { 'format-disk': 'CmdOrCtrl+K' }), false);
  assert.ok(KEY_ACTIONS.every((a) => DEFAULT_KEYS[a]), 'every action has a default accelerator');
  const again = new Settings(s.file ? path.dirname(s.file) : tmp());
  assert.equal(again.get('kvPrecision'), 'q8_0', 'persisted');
  s.reset();
  assert.equal(s.get('kvPrecision'), 'auto');
});

test('agent: streamed "say" preview is extracted from partial JSON without waiting for the end', () => {
  assert.equal(extractSay('{"say":"파일 목록을 확'), '파일 목록을 확');
  assert.equal(extractSay('{"say":"a \\"quoted\\" word","action":"run"'), 'a "quoted" word');
  assert.equal(extractSay('{"act'), '');
});
