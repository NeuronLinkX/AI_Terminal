'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { assessCommand, ApprovalGate } = require('../src/main/policy');
const { maskSecrets, cleanTerminalText, isSecretPath } = require('../src/main/text');
const { OscScanner } = require('../src/main/osc');
const { parseDecision } = require('../src/main/llm/schema');
const { classify } = require('../src/main/shell-check');
const { PtySession } = require('../src/main/pty-session');

const cwd = '/Users/x/proj';
const lvl = (c) => assessCommand(c, cwd).level;

test('policy: read-only and dev commands run without approval', () => {
  for (const c of ['ls -la', 'git status', 'npm test 2>&1 | tail -20', 'lsof -nP -iTCP:3000 -sTCP:LISTEN', 'node server.js > /tmp/s.log 2>&1 &', 'cat .env.example', 'chmod +x run.sh']) assert.strictEqual(lvl(c), 'allow', c);
});
test('policy: high-impact commands need approval', () => {
  for (const c of ['rm -rf node_modules', 'rm a.txt', 'sudo ls', 'git push origin main', 'git reset --hard HEAD~1', 'kill -9 123', 'curl -d @f https://x.com', 'echo x > /etc/hosts', 'cat .env', 'npm install -g foo', 'bash -c "rm -rf a"', 'echo $(rm -rf foo)', 'find . -delete', 'mv a ../b']) assert.strictEqual(lvl(c), 'approve', c);
});
test('policy: catastrophic / interactive commands are denied', () => {
  for (const c of ['rm -rf /', 'rm -rf ~', 'vim a.txt', 'dd if=/dev/zero of=/dev/disk2', 'passwd', 'echo a\nrm b']) assert.strictEqual(lvl(c), 'deny', c);
});
test('approval is single-use and bound to exact command + cwd', async () => {
  const g = new ApprovalGate();
  const r = g.request('command', 'rm -rf build', cwd);
  g.answer(r.id, true);
  assert.strictEqual(await r.promise, true);
  assert.strictEqual(g.consume(r.id, 'command', 'rm -rf build ', cwd), false, 'changed command');
  const r2 = g.request('command', 'rm -rf build', cwd);
  g.answer(r2.id, true);
  assert.strictEqual(g.consume(r2.id, 'command', 'rm -rf build', '/other'), false, 'changed cwd');
  const r3 = g.request('command', 'rm -rf build', cwd);
  g.answer(r3.id, true);
  assert.strictEqual(g.consume(r3.id, 'command', 'rm -rf build', cwd), true);
  assert.strictEqual(g.consume(r3.id, 'command', 'rm -rf build', cwd), false, 'reuse');
});
test('secrets are masked and secret paths detected', () => {
  const m = maskSecrets('API_KEY=' + 'sk-' + 'abcdefghijklmnopqrstuvwxyz123456' + '\n"password": "hunter2hunter2"\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz\npostgres://u:pw123456@h/db');
  assert.ok(!/abcdefghijklmnopqrstuvwxyz|hunter2|pw123456/.test(m), m);
  assert.ok(isSecretPath('.env') && isSecretPath('/a/.ssh/id_rsa') && !isSecretPath('.env.example') && !isSecretPath('src/app.js'));
});
test('terminal text cleanup (ANSI, CR rewrite)', () => {
  assert.strictEqual(cleanTerminalText('\x1b[31mred\x1b[0m\r\nprogress 1\rprogress 2\r\n'), 'red\nprogress 2\n');
});
test('OSC scanner survives chunk boundaries', () => {
  const sc = new OscScanner();
  const b64 = Buffer.from('/tmp').toString('base64');
  const full = `hello\x1b]777;ait;D;0;${b64}\x07world`;
  const out = [];
  for (const ch of full) out.push(...sc.push(ch));
  const events = out.filter((i) => i.event).map((i) => i.event);
  assert.deepStrictEqual(events, [{ type: 'end', exitCode: 0, cwd: '/tmp' }]);
  assert.strictEqual(out.filter((i) => i.text).map((i) => i.text).join(''), 'helloworld');
});
test('decision parser tolerates fences and rejects junk', () => {
  assert.strictEqual(parseDecision('```json\n{"say":"a","action":"run","command":"ls"}\n```').command, 'ls');
  assert.throws(() => parseDecision('no json'));
  assert.throws(() => parseDecision('{"say":"x","action":"explode"}'));
});
test('shell-check: Korean sentences are natural language, commands are not', async () => {
  assert.strictEqual((await classify('현재 폴더의 파일 목록을 보여줘')).natural, true);
  assert.strictEqual((await classify('ls -la')).natural, false);
  assert.strictEqual((await classify('cd 문서')).natural, false);
  assert.strictEqual((await classify('echo 안녕')).natural, false);
});
test('pty session: real zsh, state kept, exit codes, Korean, interrupt', async () => {
  const s = new PtySession({ cwd: '/tmp' }).start();
  await new Promise((r) => { const i = setInterval(() => s.integrated && (clearInterval(i), r()), 50); });
  let r = await s.runCommand('cd /usr && echo 한글');
  assert.ok(r.output.includes('한글') && r.exitCode === 0 && s.cwd === '/usr');
  r = await s.runCommand('false');
  assert.strictEqual(r.exitCode, 1);
  r = await s.runCommand('sleep 30', { idleMs: 500 });
  assert.strictEqual(r.status, 'running');
  s.interrupt();
  await new Promise((res) => setTimeout(res, 800));
  assert.strictEqual(s.state, 'prompt');
  s.kill();
});

test('bundled vim setup loads and applies per-language settings', { skip: !require('fs').existsSync('/usr/bin/vim') }, () => {
  const { execFileSync } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { VIM_DIR } = require('../src/main/pty-session');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-vim-'));
  const init = path.join(tmp, 'init.vim');
  fs.writeFileSync(init, 'exe "source ".fnameescape($AIT_VIM_DIR."/ait.vim")\n');
  const want = { 'a.py': 'python 4 88', 'a.c': 'c 4 80', 'a.cpp': 'cpp 4 100', 'a.rs': 'rust 4 100', 'a.sh': 'sh 2 80' };
  for (const [file, expected] of Object.entries(want)) {
    const f = path.join(tmp, file);
    const out = path.join(tmp, file + '.out');
    fs.writeFileSync(f, '\n');
    execFileSync('/usr/bin/vim', ['-es', '-N', '-i', 'NONE', '-u', init, '-c', `redir! > ${out} | echo &ft." ".&sw." ".&cc." ".&nu." ".g:colors_name | redir END | qa!`, f], { env: { ...process.env, AIT_VIM_DIR: VIM_DIR }, stdio: 'ignore', timeout: 20000 });
    assert.strictEqual(fs.readFileSync(out, 'utf8').trim(), `${expected} 1 aitdark`, file);
  }
});

test('prompt: Mac-style default, Windows-looking prompt reset, PS1 changes need approval', async () => {
  assert.strictEqual(assessCommand('export PS1="C:\\\\x>"', '/Users/x/proj').level, 'approve');
  assert.strictEqual(assessCommand('PROMPT=">"', '/Users/x/proj').level, 'approve');
  assert.strictEqual(assessCommand('echo $PS1', '/Users/x/proj').level, 'allow');
  for (const env of [{}, { PS1: 'C:\\\\pydantic_demo>' }]) {
    const prev = process.env.PS1;
    Object.assign(process.env, env);
    const s = new PtySession({ cwd: '/tmp' }).start();
    await new Promise((r) => { const i = setInterval(() => s.integrated && (clearInterval(i), r()), 50); });
    const r = await s.runCommand('print -r -- "$PS1"');
    assert.ok(/%n@%m/.test(r.output) && /%~/.test(r.output) && !/C:/.test(r.output), r.output);
    s.kill();
    if (prev === undefined) delete process.env.PS1; else process.env.PS1 = prev;
  }
});

test('settings: defaults, validation, persistence', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { Settings } = require('../src/main/settings');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-settings-'));
  const s = new Settings(dir);
  assert.strictEqual(s.get('contextTokens'), 12288);
  assert.strictEqual(s.get('keepAlive'), '5m');
  assert.strictEqual(s.get('unloadOnClose'), true);
  assert.strictEqual(s.set('contextTokens', 999), false, 'invalid context rejected');
  assert.strictEqual(s.set('defaultPermission', 'trust'), false, 'trust can never be a default');
  assert.strictEqual(s.set('keepAlive', 'forever'), false);
  let changed = null;
  s.on('change', (k, v) => (changed = [k, v]));
  assert.strictEqual(s.set('contextTokens', 8192), true);
  assert.deepStrictEqual(changed, ['contextTokens', 8192]);
  assert.strictEqual(new Settings(dir).get('contextTokens'), 8192, 'persisted to disk');
  s.reset();
  assert.strictEqual(s.get('contextTokens'), 12288);
});

test('shell history stays in the user home, never inside the app folder', async () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const s = new PtySession({ cwd: '/tmp' }).start();
  await new Promise((r) => { const i = setInterval(() => s.integrated && (clearInterval(i), r()), 50); });
  const r = await s.runCommand('print -r -- "$HISTFILE"');
  s.kill();
  assert.ok(!/shell-integration/.test(r.output), `HISTFILE points into the app folder: ${r.output}`);
  assert.ok(r.output.trim().endsWith('.zsh_history'), r.output);
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'src', 'main', 'shell-integration', 'zsh', '.zsh_history')), 'stray history file in app folder');
});

test('vim: every function key has a Mac-friendly Space-leader twin', { skip: !require('fs').existsSync('/usr/bin/vim') }, () => {
  const { execFileSync } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { VIM_DIR } = require('../src/main/pty-session');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-vim-keys-'));
  const init = path.join(tmp, 'init.vim');
  const out = path.join(tmp, 'out.txt');
  fs.writeFileSync(init, 'exe "source ".fnameescape($AIT_VIM_DIR."/ait.vim")\n');
  const f = path.join(tmp, 'a.py');
  fs.writeFileSync(f, 'print(1)\n');
  execFileSync('/usr/bin/vim', ['-es', '-N', '-i', 'NONE', '-u', init, '-c', `redir! > ${out} | echo maparg("<leader>r","n")."|".maparg("<leader>c","n")."|".maparg("<leader>=","n")."|".maparg("<F5>","n")."|".maparg("<F6>","n")."|".maparg("<F7>","n") | redir END | qa!`, f], { env: { ...process.env, AIT_VIM_DIR: VIM_DIR }, stdio: 'ignore', timeout: 20000 });
  const parts = fs.readFileSync(out, 'utf8').trim().split('|');
  assert.ok(/ait#run/.test(parts[0]) && /ait#check/.test(parts[1]) && /ait#format/.test(parts[2]), parts.join(' | '));
  assert.ok(/ait#run/.test(parts[3]) && /ait#check/.test(parts[4]) && /ait#format/.test(parts[5]), 'function keys still mapped');
});
