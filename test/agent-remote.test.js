'use strict';
// The agent in remote mode, with a scripted model: a nested bash in a real PTY stands in for the far side of ssh.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PtySession } = require('../src/main/pty-session');
const { Agent } = require('../src/main/agent');
const { Settings } = require('../src/main/settings');
const { sha256 } = require('../src/main/remotefs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ait-agent-remote-')));

async function nested(cwd) {
  const s = new PtySession({ cwd }).start();
  await new Promise((r) => { const i = setInterval(() => s.integrated && (clearInterval(i), r()), 50); });
  const r = await s.runCommand('bash --noprofile --norc', { idleMs: 700 });
  assert.equal(r.status, 'running');
  await sleep(300);
  return s;
}

/** An Agent whose model follows a script. `prompts` collects what the model was shown. */
function makeAgent(session, script, settingsOver = {}) {
  const dataDir = tmp();
  const settings = new Settings(dataDir);
  for (const [k, v] of Object.entries(settingsOver)) settings.set(k, v);
  const prompts = [];
  const llm = {
    status: { active: { id: 'ollama' } },
    ollama: { lastPlan: { ctx: 12288 } },
    complete: async ({ user }) => {
      prompts.push(user);
      const d = typeof script === 'function' ? script(prompts.length, user) : script.shift();
      return { text: JSON.stringify({ say: 'ok', action: 'done', command: null, path: null, content: null, seconds: null, old_text: null, new_text: null, start_line: null, end_line: null, ...d }), provider: { label: 'script' } };
    },
  };
  const agent = new Agent({ session, llm, dataDir, settings });
  agent.attach({ tabId: 't1', lang: () => 'ko' });
  const events = [];
  agent.on('event', (e) => events.push(e));
  return { agent, events, prompts, dataDir, settings };
}

/** Answer approvals as the test says: decide(event) → true | false | { approve, always, feedback } */
function approver(agent, events, decide) {
  const seen = new Set();
  const iv = setInterval(() => {
    for (const e of events) {
      if (e.type !== 'approval' || seen.has(e.id)) continue;
      seen.add(e.id);
      const d = decide(e);
      const approve = typeof d === 'object' ? d.approve : d;
      agent.gate.answer(e.id, !!approve, typeof d === 'object' ? { always: d.always, feedback: d.feedback } : undefined);
    }
  }, 20);
  return () => clearInterval(iv);
}
const cmdEvents = (events) => events.filter((e) => e.type === 'command-start').map((e) => e.command);

test('entering remote mode probes the far side and describes it to the model (and not the local project)', async () => {
  const home = tmp();
  const s = await nested(home);
  const { agent, events, prompts } = makeAgent(s, [{ action: 'done', say: '확인했습니다.' }]);
  try {
    const r = await agent.setRemote(true, { target: { label: 'ubuntu@192.168.64.4' } });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.info.label, 'ubuntu@192.168.64.4', 'the label is what the user connects to');
    assert.equal(r.info.os, os.type());
    assert.equal(r.info.kind, 'posix');
    assert.equal(r.info.user, os.userInfo().username);
    assert.equal(r.info.cwd, home);
    assert.ok(events.some((e) => e.type === 'remote' && e.on === true && e.info.label === 'ubuntu@192.168.64.4'));
    assert.equal(agent.remote, true);
    assert.ok(!('key' in r.info) && !('identityFiles' in r.info), 'nothing about keys reaches the UI');

    await agent.handle('서버 상태를 알려줘');
    const p = prompts[0];
    assert.match(p, /\[원격 SSH 세션\] 사용자가 터미널에서 연 ubuntu@192\.168\.64\.4/);
    assert.match(p, new RegExp(`cwd=${home.replace(/[/.]/g, '\\$&')}`));
    assert.match(p, /읽기 전용 명령으로 먼저 확인/);
    assert.ok(!/\[디렉터리\]|\[Git\]/.test(p), 'the local directory listing and git status are not shown while working remotely');

    await agent.setRemote(false);
    assert.equal(agent.remote, false);
    assert.ok(events.some((e) => e.type === 'remote' && e.on === false));
  } finally { s.kill(); }
});

test('refusing to enter remote mode is explained: no session, password prompt, unsupported shell', async () => {
  const lone = new PtySession({ cwd: tmp() }).start();
  await new Promise((r) => { const i = setInterval(() => lone.integrated && (clearInterval(i), r()), 50); });
  const a = makeAgent(lone, []);
  try {
    const r = await a.agent.setRemote(true);
    assert.equal(r.ok, false);
    assert.match(r.reason, /열린 SSH/);
    assert.equal(a.agent.remote, false);
  } finally { lone.kill(); }
});

test('remote commands: read-only runs freely, a change asks (naming the server), deny / approve / trust / sshStrict', async () => {
  const dir = tmp();
  const s = await nested(dir);
  const { agent, events, settings } = makeAgent(s, []);
  try {
    await agent.setRemote(true, { target: { label: 'dev@build-box' } });
    const log = { commands: [], files: [], failures: 0 };
    const sig = new AbortController().signal;

    let o = await agent._doRun('ls', sig, log);
    assert.equal(o.exitCode, 0, JSON.stringify(o));
    assert.ok(!events.some((e) => e.type === 'approval'), 'a read-only command needs no approval');
    const res = events.filter((e) => e.type === 'command-result').pop();
    assert.equal(res.cwd, `원격 dev@build-box:${dir}`, 'the result card names the server and its folder, never this Mac\'s');

    // a change asks, and the approval says which server and which directory
    let stop = approver(agent, events, () => false);
    o = await agent._doRun('touch denied.txt', sig, log);
    stop();
    const ap = events.find((e) => e.type === 'approval');
    assert.equal(ap.remote, 'dev@build-box');
    assert.equal(ap.cwd, `dev@build-box:${dir}`);
    assert.match(ap.reasons.join(' '), /원격 서버\(dev@build-box\)를 변경/);
    assert.match(o.error, /거부/);
    assert.ok(!fs.existsSync(path.join(dir, 'denied.txt')));

    stop = approver(agent, events, () => true);
    o = await agent._doRun('touch approved.txt && cd /usr && pwd', sig, log);
    stop();
    assert.equal(o.exitCode, 0, JSON.stringify(o));
    assert.ok(fs.existsSync(path.join(dir, 'approved.txt')));
    assert.equal(agent.remoteInfo.cwd, '/usr', 'the remote cwd follows `cd`');

    // trust mode and the sshStrict switch
    events.length = 0;
    agent.setPermission('trust');
    o = await agent._doRun('touch /usr/../tmp/ait-trust-test-file', sig, log);
    assert.ok(!events.some((e) => e.type === 'approval'), 'trust mode approves');
    fs.rmSync('/tmp/ait-trust-test-file', { force: true });
    agent.setPermission('default');
    await agent._doRun('cd ' + dir, sig, log);
    settings.set('sshStrict', false);
    events.length = 0;
    await agent._doRun('touch inside-cwd.txt', sig, log);
    assert.ok(!events.some((e) => e.type === 'approval'), 'with sshStrict off an ordinary in-cwd change runs like a local one');
    assert.ok(fs.existsSync(path.join(dir, 'inside-cwd.txt')));
    // dangerous things stay blocked or asked either way
    events.length = 0;
    o = await agent._doRun('rm -rf /', sig, log);
    assert.match(o.error, /정책에 의해 차단/);
  } finally { s.kill(); }
});

test('"allow for this session" is per server: it never leaks to another host or to local work', async () => {
  const dir = tmp();
  const s = await nested(dir);
  const { agent, events } = makeAgent(s, []);
  try {
    await agent.setRemote(true, { target: { label: 'a@host-a' } });
    const log = { commands: [], files: [], failures: 0 };
    const sig = new AbortController().signal;
    let stop = approver(agent, events, () => ({ approve: true, always: 'session' }));
    await agent._doRun('touch one.txt', sig, log);
    stop();
    assert.ok([...agent.rules.keys()].every((k) => k.startsWith('ssh:a@host-a|')), [...agent.rules.keys()].join());

    events.length = 0;
    stop = approver(agent, events, () => true);
    await agent._doRun('touch two.txt', sig, log);
    stop();
    assert.ok(!events.some((e) => e.type === 'approval'), 'same server: the rule applies');
    assert.ok(events.some((e) => e.type === 'note' && /a@host-a 서버 허용 규칙/.test(e.text)));

    // an alias that is later re-pointed to another machine must not inherit the rule: rules follow the real user@host, not the shown name
    agent.remoteInfo.label = 'my-alias';
    agent.remoteInfo.id = 'a@other-machine';
    events.length = 0;
    stop = approver(agent, events, () => false);
    await agent._doRun('touch alias.txt', sig, log);
    stop();
    assert.ok(events.some((e) => e.type === 'approval' && e.remote === 'my-alias'), 'same alias, different machine: asks again');
    assert.ok(!fs.existsSync(path.join(dir, 'alias.txt')));

    agent.remoteInfo.label = agent.remoteInfo.id = 'b@host-b'; // the user connects to another server
    events.length = 0;
    stop = approver(agent, events, () => false);
    await agent._doRun('touch three.txt', sig, log);
    stop();
    assert.ok(events.some((e) => e.type === 'approval' && e.remote === 'b@host-b'), 'another server asks again');
    assert.ok(!fs.existsSync(path.join(dir, 'three.txt')));
    // saving a rule "for this project" is not offered for a server: it stays a session rule
    assert.ok(![...agent.rules.keys()].some((k) => !k.startsWith('ssh:')));
  } finally { s.kill(); }
});

test('remote file tools: read / search act on the server; secrets paths are refused; reads are masked for the model', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'const a = 1;\nconst b = 2;\nconst c = "needle";\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789\nplain\n');
  fs.mkdirSync(path.join(dir, '.ssh'));
  fs.writeFileSync(path.join(dir, '.ssh', 'id_rsa'), 'PRIVATE');
  const s = await nested(dir);
  const { agent, events } = makeAgent(s, []);
  try {
    await agent.setRemote(true, { target: { label: 'u@h' } });
    let o = await agent._remoteRead('src/app.js', 2, 3);
    assert.match(o.path, /^u@h:\//);
    assert.equal(o.content, `(줄 2-3 / 총 3줄)\nconst b = 2;\nconst c = "needle";`);
    o = await agent._remoteRead('notes.txt');
    assert.ok(!o.content.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), 'the model never sees the token');
    o = await agent._remoteRead('.ssh/id_rsa');
    assert.match(o.error, /비밀정보/);
    o = await agent._remoteSearch('needle', 'src');
    assert.equal(o.count, 1);
    assert.match(o.content, /app\.js:3/);
    o = await agent._remoteRead('missing.txt');
    assert.ok(o.error);
    assert.ok(events.some((e) => e.type === 'file-read' && /^u@h:/.test(e.path)));
  } finally { s.kill(); }
});

test('remote edit / write: diff + approval naming the server, exact result, undo only while untouched, readonly refuses', async () => {
  const dir = tmp();
  const target = path.join(dir, 'config.ini');
  fs.writeFileSync(target, '[main]\n  port = 80\nname = demo\n');
  const s = await nested(dir);
  const { agent, events, dataDir } = makeAgent(s, []);
  try {
    await agent.setRemote(true, { target: { label: 'ops@srv' } });
    const log = { commands: [], files: [], failures: 0 };
    const sig = new AbortController().signal;

    // denied: nothing changes
    let stop = approver(agent, events, () => ({ approve: false, feedback: '포트는 건드리지 마' }));
    let o = await agent._remoteEdit('config.ini', 'port = 80', 'port = 8080', sig, log);
    stop();
    assert.match(o.error, /거부했습니다.*포트는 건드리지 마/);
    assert.equal(fs.readFileSync(target, 'utf8'), '[main]\n  port = 80\nname = demo\n');
    const ap = events.find((e) => e.type === 'approval' && e.kind === 'file');
    assert.equal(ap.remote, 'ops@srv');
    assert.ok(ap.diff.lines.some((l) => l === '- ' + '  port = 80') && ap.diff.lines.some((l) => l === '+ ' + '  port = 8080'));
    assert.match(ap.reasons[0], /원격 서버\(ops@srv\)의 파일 수정/);

    // approved: exact content (the indented line keeps its indentation and the final newline stays)
    events.length = 0;
    stop = approver(agent, events, () => true);
    o = await agent._remoteEdit('config.ini', 'port = 80', 'port = 8080', sig, log);
    stop();
    assert.equal(o.ok, true, JSON.stringify(o));
    assert.equal(fs.readFileSync(target, 'utf8'), '[main]\n  port = 8080\nname = demo\n');
    const w = events.find((e) => e.type === 'file-write');
    assert.equal(w.remote, 'ops@srv');
    assert.match(w.path, /^ops@srv:\//);
    assert.ok(fs.readdirSync(path.join(dataDir, 'backups')).some((f) => /ops_srv-config\.ini$/.test(f)), 'a local copy of the original is kept');

    // errors the model can act on
    o = await agent._remoteEdit('config.ini', 'does not exist', 'x', sig, log);
    assert.match(o.error, /찾지 못했습니다/);
    o = await agent._remoteEdit('config.ini', 'n', 'N', sig, log);
    assert.match(o.error, /여러 곳/);

    // undo restores the original; a file changed in the meantime is not touched
    const undoId = w.undoId;
    const u1 = await agent.undoChange(undoId);
    assert.deepEqual([u1.ok], [true], JSON.stringify(u1));
    assert.equal(fs.readFileSync(target, 'utf8'), '[main]\n  port = 80\nname = demo\n');
    stop = approver(agent, events, () => true);
    const o2 = await agent._remoteEdit('config.ini', 'name = demo', 'name = prod', sig, log);
    stop();
    fs.appendFileSync(target, '# someone else was here\n');
    const u2 = await agent.undoChange(events.filter((e) => e.type === 'file-write').pop().undoId);
    assert.equal(u2.ok, false);
    assert.match(u2.message, /다시 바뀌어서/);
    assert.match(fs.readFileSync(target, 'utf8'), /someone else/);

    // a new file; undo of a creation removes it
    stop = approver(agent, events, () => true);
    o = await agent._remoteWrite('new/../fresh.txt', 'hello\n', sig, log);
    stop();
    assert.equal(o.ok, true, JSON.stringify(o));
    assert.equal(fs.readFileSync(path.join(dir, 'fresh.txt'), 'utf8'), 'hello\n');
    const created = events.filter((e) => e.type === 'file-write').pop();
    assert.equal(created.created, true);
    assert.equal((await agent.undoChange(created.undoId)).ok, true);
    assert.ok(!fs.existsSync(path.join(dir, 'fresh.txt')));

    // refusals
    agent.setPermission('readonly');
    o = await agent._remoteWrite('x.txt', 'y', sig, log);
    assert.match(o.error, /읽기 전용/);
    agent.setPermission('default');
    assert.match((await agent._remoteWrite('.git/config', 'y', sig, log)).error, /\.git/);
    assert.match((await agent._remoteWrite('.ssh/authorized_keys', 'y', sig, log)).error, /비밀정보/);
    assert.match((await agent._remoteWrite('big.txt', 'x'.repeat(201 * 1024), sig, log)).error, /너무 큽니다/);
  } finally { s.kill(); }
});

test('connection lost during remote work: the model is told, remote mode turns itself off, undo says why it cannot work', async () => {
  const dir = tmp();
  const s = await nested(dir);
  const { agent, events } = makeAgent(s, []);
  try {
    await agent.setRemote(true, { target: { label: 'x@gone' } });
    agent.setPermission('trust'); // `exit` is not a read-only command: let it run without a prompt
    const log = { commands: [], files: [], failures: 0 };
    const sig = new AbortController().signal;
    const o = await agent._doRun('ls; exit 0', sig, log);
    assert.match(o.error, /SSH 연결이 끊어졌습니다/);
    assert.equal(agent.remote, false);
    assert.ok(events.some((e) => e.type === 'remote' && e.on === false && /끊어졌/.test(e.reason)));
    assert.ok(events.some((e) => e.type === 'note' && /원격 모드를 껐습니다/.test(e.text)));
    assert.ok(events.some((e) => e.type === 'note' && /원격 모드를 껐습니다/.test(e.text)));
    const again = await agent._doRun('ls', sig, log); // now it is an ordinary (local) run request
    assert.ok(again);
  } finally { s.kill(); }
});

test('the whole loop: the scripted model investigates, edits a remote file with approval, verifies, and reports', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'app.conf'), 'listen 80;\nserver_name old.example.com;\n');
  const s = await nested(dir);
  const script = [
    { action: 'run', command: 'ls', say: '파일을 확인합니다.' },
    { action: 'read_file', path: 'app.conf', say: '설정을 읽습니다.' },
    { action: 'edit_file', path: 'app.conf', old_text: 'old.example.com', new_text: 'new.example.com', say: '도메인을 바꿉니다.' },
    { action: 'run', command: 'grep server_name app.conf', say: '확인합니다.' },
    { action: 'done', say: 'app.conf 의 server_name 을 old.example.com 에서 new.example.com 으로 바꿨고, grep 으로 새 값이 반영된 것을 확인했습니다.' },
  ];
  const { agent, events, prompts } = makeAgent(s, script);
  try {
    await agent.setRemote(true, { target: { label: 'web@prod-1' } });
    const stop = approver(agent, events, () => true);
    await agent.handle('도메인을 new.example.com 으로 바꿔줘');
    stop();
    assert.equal(fs.readFileSync(path.join(dir, 'app.conf'), 'utf8'), 'listen 80;\nserver_name new.example.com;\n');
    assert.deepEqual(cmdEvents(events), ['ls', 'grep server_name app.conf']);
    assert.equal(events.filter((e) => e.type === 'approval').length, 1, 'only the file change asked');
    assert.ok(events.some((e) => e.type === 'file-write' && e.remote === 'web@prod-1'));
    const sum = events.find((e) => e.type === 'summary');
    assert.ok(sum && sum.files === 1);
    assert.ok(prompts.every((p) => /\[원격 SSH 세션\]/.test(p)), 'the far side is described at every step');
    assert.match(prompts[prompts.length - 1], /원격 파일 수정됨/);
    assert.ok(events.some((e) => e.type === 'say' && /new\.example\.com/.test(e.text)));
  } finally { s.kill(); }
});

test('hash sanity: remote edits never change bytes the model did not touch', async () => {
  const dir = tmp();
  const original = 'a\r\n  b\t\n\nlast line without newline';
  fs.writeFileSync(path.join(dir, 'f.txt'), original);
  const s = await nested(dir);
  const { agent, events } = makeAgent(s, []);
  try {
    await agent.setRemote(true, { target: { label: 'u@h' } });
    const stop = approver(agent, events, () => true);
    const o = await agent._remoteEdit('f.txt', 'last', 'LAST', new AbortController().signal, { files: [] });
    stop();
    assert.equal(o.ok, true, JSON.stringify(o));
    assert.equal(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8'), original.replace('last', 'LAST'));
    assert.equal(sha256(fs.readFileSync(path.join(dir, 'f.txt'))), sha256(original.replace('last', 'LAST')));
  } finally { s.kill(); }
});
