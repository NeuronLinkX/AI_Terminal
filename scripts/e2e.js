#!/usr/bin/env node
'use strict';
// End-to-end driver: launches the real Electron app (real PTY + real LLM) and drives its UI over the
// Chrome DevTools Protocol. Screenshots land in ./e2e-out. Usage: node scripts/e2e.js [scenario...]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');

const PORT = 9333;
// tests never touch the real app profile (saved theme / permission mode / settings): use a throw-away profile
const PROFILE = () => fs.mkdtempSync(path.join(require('os').tmpdir(), 'ait-e2e-profile-'));
const OUT = process.env.AIT_SHOT_DIR || path.join(__dirname, '..', 'e2e-out');
const WS = process.env.AIT_E2E_WS || '/private/tmp/ait-demo-ws';
fs.mkdirSync(OUT, { recursive: true });
/** The scenarios work on a small throw-away project; create it when it does not exist (fresh machine / CI). */
function ensureWorkspace() {
  if (fs.existsSync(path.join(WS, 'package.json'))) return;
  const files = {
    'package.json': '{"name":"demo","scripts":{"test":"node test.js"}}\n',
    'notes.txt': 'demo notes\n',
    'src/util.js': 'function add(a, b) { return a + b; }\nmodule.exports = { add };\n',
    'test.js': "const { add } = require('./src/util');\nif (add(2, 3) !== 5) { console.error('FAIL add'); process.exit(1); }\nconsole.log('ok');\n",
    'server.js': "require('http').createServer((q, r) => r.end('hi')).listen(3000);\n",
  };
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(WS, f)), { recursive: true }); fs.writeFileSync(path.join(WS, f), c); }
  try { const g = (...a) => require('child_process').execFileSync('git', a, { cwd: WS, stdio: 'ignore' }); g('init', '-q'); g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'); } catch { /* git is optional */ }
}
ensureWorkspace();
// Documentation runs (screenshots / video): set AIT_DOC_PROMPT to a neutral zsh prompt so the local account and host name
// never appear in the images, and every capture is checked for them (see `privacyHits`).
const DOC_ENV = process.env.AIT_DOC_PROMPT ? { AIT_PROMPT: process.env.AIT_DOC_PROMPT } : {};
const PRIVATE_RE = new RegExp([require('os').userInfo().username, require('os').hostname().split('.')[0]].filter((x) => x && x.length > 2).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') || '^$', 'i');
const privacyHits = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch(extraEnv = {}, profile = null) {
  const profDir = profile || PROFILE();
  /** The app is killed with SIGKILL below, so its private KV engine (`ollama serve`) would outlive it. Stop that server
   *  through the pid file the engine keeps in the profile — the same file a normal restart uses to reap a crashed run. */
  const stopEngine = () => {
    try {
      const { pid } = JSON.parse(fs.readFileSync(path.join(profDir, 'kv-engine.json'), 'utf8'));
      const cmd = require('child_process').execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (/ollama/.test(cmd) && /serve/.test(cmd)) process.kill(pid, 'SIGTERM');
    } catch { /* no engine was started */ }
  };
  const proc = (process.env.AIT_APP_BIN ? spawn(process.env.AIT_APP_BIN, [`--user-data-dir=${profDir}`], { cwd: '/', env: { ...process.env, AIT_DEBUG_PORT: PORT, AIT_CWD: WS, AIT_LANG: process.env.AIT_LANG || 'ko', AIT_NO_SHELL_ENV: '1', OPENAI_API_KEY: '', OPENAI_ADMIN_KEY: '', AIT_NO_KEYCHAIN: '1', AIT_EXPORT_DIR: os.tmpdir(), ...DOC_ENV, ...extraEnv }, stdio: ['ignore', 'ignore', 'pipe'] }) : spawn(electron, ['.', '--no-sandbox', `--user-data-dir=${profDir}`], { cwd: path.join(__dirname, '..'), env: { ...process.env, AIT_DEBUG_PORT: PORT, AIT_CWD: WS, AIT_LANG: process.env.AIT_LANG || 'ko', AIT_NO_SHELL_ENV: '1', OPENAI_API_KEY: '', OPENAI_ADMIN_KEY: '', AIT_NO_KEYCHAIN: '1', AIT_EXPORT_DIR: os.tmpdir(), ...DOC_ENV, ...extraEnv }, stdio: ['ignore', 'ignore', 'pipe'] }));
  let err = '';
  let closing = false;
  proc.stderr.on('data', (d) => (err += d));
  proc.on('exit', (code, sig) => { if (!closing) console.log(`\n!! APP EXITED UNEXPECTEDLY code=${code} signal=${sig}\n${err.slice(-800)}`); });
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      target = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
    } catch { /* not up yet */ }
  }
  if (!target) { proc.kill('SIGKILL'); throw new Error('app did not start: ' + err.slice(-500)); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  const cdp = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  // a native confirm()/alert() blocks the page (and every CDP call) until somebody answers it: answer "OK" so a run never hangs
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
    else if (d.method === 'Page.javascriptDialogOpening') { console.log(`  (dialog auto-accepted: ${String(d.params.message).slice(0, 80)})`); cdp('Page.handleJavaScriptDialog', { accept: true }); }
  };
  cdp('Page.enable');
  const ev = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (!r.result) throw new Error('CDP: ' + JSON.stringify(r.error)); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception || r.result.exceptionDetails)); return r.result.result.value; };
  const visibleText = () => ev(`(typeof __ait !== 'undefined' && __ait.bufferText ? __ait.bufferText() : '') + '\\n' + document.body.innerText`);
  // Documentation captures must never contain a real key: compare against the real environment value WITHOUT printing it,
  // plus the generic shape of an OpenAI key.
  const realKeys = ['OPENAI_API_KEY', 'OPENAI_ADMIN_KEY'].map((k) => process.env[k]).filter((v) => v && v.length > 8);
  const keyLike = /sk-[A-Za-z0-9_-]{16,}/;
  const around = (text) => { const i = text.search(PRIVATE_RE); return text.slice(Math.max(0, i - 40), i + 40).replace(/\s+/g, ' ').trim(); };
  const scan = async (what) => {
    if (!process.env.AIT_DOC_PROMPT) return false;
    const t = await visibleText();
    if (realKeys.some((k) => t.includes(k)) || keyLike.test(t)) { privacyHits.push(`${what}: API KEY visible`); console.log(`  !!! API 키로 보이는 문자열이 화면에 있습니다 — ${what}`); return true; }
    let m = t.match(PRIVATE_RE);
    if (m) { // an `ls -l` listing shows the file owner: clear the terminal scrollback (xterm API, no shell command) and look again
      const cleared = await ev(`(() => { try { if (__ait.state.pty === 'prompt') { __ait.term.clear(); return 1; } } catch (e) {} return 0; })()`);
      if (cleared) { await sleep(350); const t2 = await visibleText(); m = t2.match(PRIVATE_RE); if (m) { privacyHits.push(`${what}: ${around(t2)}`); console.log(`  ! 개인 정보(계정/호스트명)가 화면에 보입니다 — ${what}`); } return !!m; }
      privacyHits.push(`${what}: ${around(t)}`); console.log(`  ! 개인 정보(계정/호스트명)가 화면에 보입니다 — ${what}`);
    }
    return !!m;
  };
  const shot = async (name) => { await scan(name); const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.result.data, 'base64')); };
  const waitFor = async (expr, ms = 120000, what = expr) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(300); } throw new Error('timeout waiting: ' + what); };
  const close = () => { closing = true; try { ws.close(); } catch {} proc.kill('SIGKILL'); stopEngine(); };
  process.on('exit', () => { try { proc.kill('SIGKILL'); } catch {} stopEngine(); }); // never leave a test window behind
  await sleep(1500);
  if (process.env.AIT_THEME) { // run the scenario in this theme (a fresh profile always starts dark)
    await waitFor(`!!document.documentElement.dataset.theme && !!document.getElementById('btn-theme')`, 30000).catch(() => {});
    if ((await ev(`document.documentElement.dataset.theme`)) !== process.env.AIT_THEME) { await ev(`document.getElementById('btn-theme').click()`); await sleep(500); }
  }
  return { proc, cdp, ev, shot, scan, waitFor, close };
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGALRM']) process.once(sig, () => process.exit(130)); // a runner stopped by a signal still runs the 'exit' handlers that close the app

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const termText = (a) => a.ev('__ait.bufferText()');
const typeInTerm = async (a, text) => { await a.ev(`__ait.term.input(${JSON.stringify(text)}, true)`); };
const tlText = (a) => a.ev(`document.querySelector('.timeline.active').innerText`);
const aiIdle = (a, ms = 240000) => a.waitFor(`document.getElementById('state').dataset.phase === 'idle' && !__ait.state.aiBusy`, ms, 'AI idle');

async function ask(a, text) {
  await a.ev(`(()=>{__ait.setMode('ai'); __ait.input.value=${JSON.stringify(text)}; __ait.submit();})()`);
  await sleep(500);
}

const scenarios = {
  async shell(a) {
    await a.waitFor(`__ait.state.pty === 'prompt'`, 20000, 'prompt ready');
    await typeInTerm(a, 'echo 안녕하세요 한글출력 && pwd\r');
    await a.waitFor(`__ait.bufferText().includes('한글출력')`, 10000);
    await typeInTerm(a, 'cd src && pwd\r');
    await sleep(800);
    const t = await termText(a);
    check('일반 셸 명령 + 한글 출력', /안녕하세요 한글출력/.test(t));
    check('cd 로 디렉터리 이동 (PTY 상태 유지)', /ait-demo-ws\/src/.test(t) && /ait-demo-ws\/src/.test(await a.ev(`document.getElementById('cwd-text').textContent`)));
    await typeInTerm(a, 'cd ..\r');
    await sleep(600);
    await a.shot('01-shell');
  },
  async structure(a) {
    await ask(a, '현재 프로젝트 구조를 설명해줘.');
    await aiIdle(a);
    const t = await tlText(a);
    check('자연어로 프로젝트 구조 확인 (실제 명령 실행 카드 존재)', /명령 실행/.test(t) && /성공 · exit 0/.test(t));
    check('최종 답변이 한국어로 표시', /[가-힣]{4,}/.test(t));
    await a.shot('02-structure');
  },
  async streaming(a) {
    await typeInTerm(a, 'for i in 1 2 3 4 5 6 7 8; do echo "tick $i"; sleep 1; done\r');
    await a.waitFor(`__ait.bufferText().includes('tick 1')`, 8000);
    await sleep(1500);
    const mid = await termText(a);
    check('출력 스트리밍 (완료 전 부분 출력 표시)', /tick 1/.test(mid) && !/tick 8/.test(mid));
    await a.ev(`document.getElementById('btn-stop').click()`);
    await sleep(1200);
    const after = await termText(a);
    await sleep(2500);
    const later = await termText(a);
    check('실행 중단 (Ctrl+C 후 더 이상 출력 없음, 프롬프트 복귀)', !/tick 8/.test(later) && (await a.ev(`__ait.state.pty`)) === 'prompt');
    await a.shot('03-stream-stop');
  },
  async failure(a) {
    fs.writeFileSync(path.join(WS, 'src', 'util.js'), 'function add(a, b) { return a - b; }   // BUG: should add\nmodule.exports = { add };\n');
    await ask(a, 'npm test가 실패해. 원인만 분석해서 알려줘. 파일은 수정하지 마.');
    await aiIdle(a);
    const t = await tlText(a);
    check('실패한 명령 실행 + 오류 분석', /실패 · exit 1/.test(t) && /(add|뺄셈|덧셈|util)/.test(t));
    await a.shot('04-failure');
  },
  async approval(a) {
    await ask(a, 'src 폴더를 통째로 삭제해줘.');
    await a.waitFor(`!!document.querySelector('.card.approval')`, 180000, 'approval card');
    await a.shot('05-approval');
    const before = await a.ev(`document.querySelector('.card.approval').innerText`);
    check('위험 작업에 승인 카드 표시 (대상·사유 포함)', /rm/.test(before) && /승인/.test(before));
    check('승인 전에는 실제 삭제되지 않음', fs.existsSync(path.join(WS, 'src', 'util.js')));
    await a.ev(`document.querySelector('.card.approval .btn.no').click()`);
    await aiIdle(a);
    check('거부 후에도 파일 유지', fs.existsSync(path.join(WS, 'src', 'util.js')));
    await a.shot('06-approval-denied');
  },
  async approve_yes(a) {
    const f = path.join(WS, 'tmp_to_delete.txt');
    fs.writeFileSync(f, 'temp');
    await ask(a, 'tmp_to_delete.txt 파일을 삭제해줘.');
    await a.waitFor(`!document.getElementById('approval-bar').hidden`, 180000, 'approval bar');
    await a.shot('10-approval-bar');
    const bar = await a.ev(`document.getElementById('approval-bar').innerText`);
    const card = await a.ev(`document.querySelector('.card.approval').getBoundingClientRect().height`);
    check('승인 바 표시 (명령·사유·승인/거부 버튼) + 카드 안 찌그러짐', /rm/.test(bar) && /한 번만 승인/.test(bar) && /거부/.test(bar) && card > 80, `card height ${Math.round(card)}`);
    check('승인 전에는 파일이 그대로', fs.existsSync(f));
    await a.ev(`document.getElementById('ap-once').click()`);
    await aiIdle(a);
    check('사용자 승인 후 실제 삭제 실행', !fs.existsSync(f));
    check('승인 바 사라짐', await a.ev(`document.getElementById('approval-bar').hidden`));
    await a.shot('11-approved-done');
  },
  async perm(a) {
    const barShown = `!document.getElementById('approval-bar').hidden`;
    // 1) read-only mode refuses to change anything
    await a.ev(`__ait.permSet('readonly')`); await sleep(400);
    const chip = await a.ev(`document.getElementById('perm-chip').textContent`);
    await a.ev(`document.getElementById('perm-chip').click()`); await sleep(300);
    await a.shot('12-perm-popover');
    await a.ev(`document.body.click()`);
    const ro = path.join(WS, 'ro_test.txt');
    await ask(a, 'ro_test.txt 라는 새 파일을 만들고 hello 라고 써줘.');
    await aiIdle(a);
    const t1 = await tlText(a);
    check('권한: 읽기 전용 모드에서는 파일이 만들어지지 않음', !fs.existsSync(ro) && /읽기 전용/.test(chip + t1), chip);
    await a.shot('13-readonly');
    // 2) ask-all: even `ls` needs approval; approve once
    await a.ev(`__ait.permSet('ask-all')`); await sleep(400);
    await ask(a, 'ls 명령으로 현재 폴더 목록을 보여줘.');
    await a.waitFor(barShown, 180000, 'ask-all approval bar');
    const why = await a.ev(`document.getElementById('ap-why').textContent`);
    check('권한: 모든 명령 확인 모드에서는 일반 명령도 승인 요청', /모든 명령 확인/.test(why), why);
    await a.ev(`document.getElementById('ap-once').click()`);
    await aiIdle(a);
    check('권한: 한 번만 승인 후 명령 실행됨', /성공 · exit 0/.test(await tlText(a)));
    // 3) default mode: "always allow" (exact rule for rm), then a different rm asks again, deny with feedback
    await a.ev(`__ait.permSet('default')`); await sleep(400);
    const f1 = path.join(WS, 'perm_a.txt'); const f2 = path.join(WS, 'perm_b.txt');
    fs.writeFileSync(f1, 'a'); fs.writeFileSync(f2, 'b');
    await ask(a, 'perm_a.txt 파일을 삭제해줘.');
    await a.waitFor(barShown, 180000, 'approval 1');
    await a.shot('14-approval-choices');
    const bar = await a.ev(`document.getElementById('approval-bar').innerText`);
    check('승인 선택지 표시 (한 번만 / 이 세션 항상 허용 / 거부 / 의견 입력)', /한 번만 승인/.test(bar) && /항상 허용/.test(bar) && /거부/.test(bar) && await a.ev(`!!document.getElementById('ap-fb')`));
    await a.ev(`document.getElementById('ap-always').click()`);
    await aiIdle(a);
    const rules = await a.ev(`document.getElementById('perm-chip').textContent`);
    check('"항상 허용" 선택 → 실제 삭제 + 세션 규칙 등록', !fs.existsSync(f1) && /규칙 1/.test(rules), rules);
    await ask(a, 'perm_b.txt 파일을 삭제해줘.');
    await a.waitFor(barShown, 180000, 'approval 2');
    check('다른 대상(perm_b.txt)은 규칙에 걸리지 않고 다시 승인 요청', fs.existsSync(f2));
    await a.ev(`(()=>{const i=document.getElementById('ap-fb'); i.value='삭제하지 말고 이름만 old_b.txt 로 바꿔줘'; i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:13,bubbles:true}));})()`);
    await aiIdle(a);
    check('거부 + 의견 전달 → 삭제 안 됨', fs.existsSync(f2) || fs.existsSync(path.join(WS, 'old_b.txt')));
    await a.shot('15-deny-feedback');
    for (const f of [f2, path.join(WS, 'old_b.txt')]) try { fs.unlinkSync(f); } catch {}
  },
  async tabs(a) {
    await a.waitFor(`__ait.state.pty === 'prompt'`, 20000);
    await typeInTerm(a, 'cd src'); await typeInTerm(a, '\r');
    await a.waitFor(`/ait-demo-ws\\/src/.test(__ait.active.state.cwd)`, 8000);
    // tab 2 starts in the active tab's directory and has its own shell state
    await a.ev(`__ait.newTab().then(() => 1)`);
    await a.waitFor(`__ait.order().length === 2 && __ait.state.pty === 'prompt'`, 20000, 'second tab ready');
    const cwd2 = await a.ev(`__ait.active.state.cwd`);
    check('새 탭은 현재 탭의 디렉터리에서 시작', /ait-demo-ws\/src$/.test(cwd2), cwd2);
    await typeInTerm(a, 'export TABVAR=second; cd /usr'); await typeInTerm(a, '\r');
    await a.waitFor(`__ait.active.state.cwd === '/usr'`, 8000);
    await a.ev(`__ait.newTab().then(() => 1)`);
    await a.waitFor(`__ait.order().length === 3 && __ait.state.pty === 'prompt'`, 20000);
    await a.shot('16-tabs-three');
    const titles = await a.ev(`[...document.querySelectorAll('#tabbar .tab .ttl')].map(e=>e.textContent).join('|')`);
    check('탭 바에 3개 탭 표시', (titles.match(/\|/g) || []).length === 2, titles);
    // independence
    await a.ev(`__ait.activate(__ait.order()[0])`);
    await sleep(500);
    await typeInTerm(a, 'echo TABVAR=${TABVAR:-unset}'); await typeInTerm(a, '\r');
    await a.waitFor(`__ait.bufferText().includes('TABVAR=unset')`, 8000);
    check('탭마다 독립된 셸 (환경변수·디렉터리 분리)', /ait-demo-ws\/src$/.test(await a.ev(`__ait.active.state.cwd`)));
    // AI works per tab, and keeps running while another tab is in front
    await ask(a, 'pwd 명령을 실행해서 현재 디렉터리를 알려줘.');
    await a.ev(`__ait.activate(__ait.order()[1])`);
    await sleep(800);
    const st = await a.ev(`document.querySelectorAll('#tabbar .tab')[0].dataset.status`);
    check('백그라운드 탭의 AI 작업 상태가 탭에 표시됨', st === 'ai' || st === 'idle', st);
    await a.waitFor(`!__ait.tabs.get(__ait.order()[0]).state.aiBusy`, 240000, 'tab1 AI done');
    const t1 = await a.ev(`__ait.tabs.get(__ait.order()[0]).tl.innerText`);
    const t2 = await a.ev(`__ait.tabs.get(__ait.order()[1]).tl.innerText`);
    check('AI 대화·실행 카드가 해당 탭에만 쌓임', /pwd/.test(t1) && !/pwd 명령을 실행/.test(t2));
    check('AI는 그 탭의 디렉터리(src)에서 실행', /ait-demo-ws\/src/.test(t1));
    await a.ev(`__ait.activate(__ait.order()[0])`); await sleep(400);
    await a.shot('17-tab1-ai');
    // close
    await a.ev(`__ait.closeTab(__ait.order()[2])`); await sleep(500);
    await a.ev(`__ait.closeTab(__ait.order()[1])`); await sleep(500);
    check('탭 닫기', (await a.ev(`__ait.order().length`)) === 1);
    await typeInTerm(a, 'cd ..'); await typeInTerm(a, '\r'); await sleep(400);
  },
  async ui(a) {
    await a.waitFor(`__ait.state.pty === 'prompt'`, 20000);
    await sleep(800);
    await a.shot('20-ui-main');
    await a.ev(`document.getElementById('model').click()`); await sleep(500); await a.shot('21-ui-model-popover'); await a.ev(`document.body.click()`);
    await a.ev(`document.getElementById('perm-chip').click()`); await sleep(500); await a.shot('22-ui-perm-popover'); await a.ev(`document.body.click()`);
    for (const m of ['readonly', 'ask-all', 'trust', 'default']) { if (m !== 'trust') { await a.ev(`__ait.permSet('${m}')`); await sleep(350); } await a.shot('23-perm-chip-' + m); }
    const n = await a.ev(`document.querySelectorAll('.ic svg').length`);
    check('SVG 아이콘 렌더링', n >= 8, `${n}개`);
  },
  async unload(a) {
    const { execFileSync } = require('child_process');
    const loaded = () => /qwen|llama|gemma|mistral/.test(execFileSync('ollama', ['ps'], { encoding: 'utf8' }));
    await a.waitFor(`__ait.state.pty === 'prompt'`, 20000);
    await a.ev(`window.confirm = () => true`);
    await ask(a, 'pwd 명령으로 현재 디렉터리를 알려줘.'); await aiIdle(a);
    check('AI 요청 후 모델이 메모리에 올라옴', loaded());
    // close a tab while another request is in flight: request is cancelled and the model is unloaded
    await ask(a, '현재 프로젝트 구조를 설명해줘.'); await sleep(2500);
    await a.ev(`__ait.closeTab(__ait.active.id).then(() => 1)`);
    await sleep(5000);
    check('탭을 닫으면 모델이 즉시 메모리에서 내려감', !loaded());
    // quitting the app also frees it
    await a.waitFor(`__ait.state.pty === 'prompt'`, 20000);
    await ask(a, 'pwd 명령으로 현재 디렉터리를 알려줘.'); await aiIdle(a);
    check('(재확인) 다시 요청하면 모델이 올라옴', loaded());
    a.cdp('Browser.close');
    await sleep(6000);
    check('창을 닫아 앱이 종료되면 모델이 메모리에서 내려감', !loaded());
  },
  async settings(a) {
    const { execFileSync } = require('child_process');
    require('child_process').execFileSync('ollama', ['stop', 'qwen3:8b'], { stdio: 'ignore' });
    await a.waitFor(`__ait.state.pty === 'prompt'`, 20000);
    await a.ev(`document.getElementById('btn-settings').click()`); await sleep(600);
    await a.shot('24-settings');
    const txt = await a.ev(`document.querySelector('#settings-modal .sm-dialog').innerText`);
    check('설정 창에 컨텍스트·유지시간·모니터·권한 항목 표시', /컨텍스트 길이/.test(txt) && /모델 메모리 유지 시간/.test(txt) && /GPU·메모리 표시/.test(txt) && /기본 권한 모드/.test(txt) && /예상 메모리/.test(txt));
    // pick 8K in the UI
    await a.ev(`[...document.querySelectorAll('.seg-b')].find(b => b.textContent === '8K').click()`); await sleep(2500);
    check('컨텍스트 8K 선택이 저장됨', (await a.ev(`__ait.settingsNow ? 1 : 1`)) === 1 && /8K/.test(await a.ev(`document.querySelector('.seg-b.on').textContent`)));
    await a.ev(`document.querySelector('#settings-modal .sm-backdrop').click()`); await sleep(300);
    await ask(a, 'pwd 명령으로 현재 디렉터리를 알려줘.'); await aiIdle(a);
    const ps = execFileSync('ollama', ['ps'], { encoding: 'utf8' });
    if (!/8192/.test(ps)) console.log('   debug timeline:', (await tlText(a)).replace(/\n+/g, ' | ').slice(-300));
    check('설정한 컨텍스트(8192)가 실제 모델에 적용됨', /\b8192\b/.test(ps), ps.split('\n')[1] || '');
    // monitor toggle
    await a.ev(`document.getElementById('btn-settings').click()`); await sleep(400);
    await a.ev(`[...document.querySelectorAll('.srow')].find(r => /상단 바에 GPU/.test(r.innerText)).querySelector('.switch').click()`); await sleep(400);
    check('GPU·메모리 표시 끄기 → 상단 바에서 사라짐', (await a.ev(`getComputedStyle(document.getElementById('sysmon')).display`)) === 'none');
    await a.ev(`[...document.querySelectorAll('.srow')].find(r => /상단 바에 GPU/.test(r.innerText)).querySelector('.switch').click()`); await sleep(400);
    check('다시 켜면 표시됨', (await a.ev(`getComputedStyle(document.getElementById('sysmon')).display`)) !== 'none');
    // back to defaults
    await a.ev(`[...document.querySelectorAll('.sm-foot .btn')].find(b => /기본값/.test(b.textContent)).click()`); await sleep(500);
    check('기본값으로 되돌리기', /12K/.test(await a.ev(`document.querySelector('.seg-b.on').textContent`)));
    await a.ev(`__panels.closeSettings()`);
  },
  async vimspace(a) {
    const keys = (k) => a.ev(`__ait.term.input(${JSON.stringify(k)}, true)`);
    await a.waitFor(`__ait.state.pty === 'prompt'`, 20000);
    await keys('cd /private/tmp/ait-vim'); await keys('\r'); await sleep(500);
    await keys('vim a.py'); await keys('\r'); await a.waitFor(`/NORMAL/.test(__ait.bufferText())`, 15000); await sleep(800);
    await keys(' '); await sleep(150); await keys('r'); await sleep(3500);
    check('vim: Space r 로 실행 (fn 키 없이, Mac 친화 키)', /종료코드 0/.test(await termText(a)));
    await keys('\x1b\x1b'); await keys(':qa!'); await keys('\r');
    await a.waitFor(`__ait.state.pty === 'prompt'`, 8000);
    await keys('vim a.py'); await keys('\r'); await a.waitFor(`/NORMAL/.test(__ait.bufferText())`, 15000); await sleep(800);
    await keys(' '); await sleep(150); await keys('c'); await sleep(3000);
    check('vim: Space c 로 검사 (fn 키 없이)', /문제 없음|개 문제/.test(await termText(a)));
    await keys('\x1b'); await keys(':qa!'); await keys('\r');
  },
  async nl_guard(a) {
    await a.ev(`__ait.setMode('sh')`);
    await a.ev(`(()=>{__ait.input.value='현재 폴더의 파일 목록을 보여줘'; __ait.submit();})()`);
    await sleep(1500);
    const t = await tlText(a);
    const tt = await termText(a);
    check('셸 모드에서 입력한 자연어는 셸 실행 대신 AI로 전달', /AI에게 전달/.test(t) && !/command not found/.test(tt));
    await aiIdle(a);
    await a.ev(`__ait.setMode('ai')`);
  },
  async theme(a) {
    const before = await a.ev(`document.documentElement.dataset.theme`);
    await a.ev(`document.getElementById('btn-theme').click()`);
    await sleep(300);
    const after = await a.ev(`document.documentElement.dataset.theme`);
    check('라이트/다크 전환', before !== after, `${before} → ${after}`);
    await a.shot('07-theme-' + after);
    await a.ev(`document.getElementById('btn-theme').click()`);
    await sleep(200);
  },
  async nl_term(a) {
    await typeInTerm(a, '이 폴더에 무슨 파일이 있는지 알려줘');
    await typeInTerm(a, '\r');
    await sleep(2000);
    const t = await tlText(a);
    const tt = await termText(a);
    check('터미널에 직접 친 한글 자연어도 셸 실행 차단 → AI 전달', /AI에게 전달/.test(t) && !/command not found/.test(tt));
    await a.waitFor(`__ait.state.aiBusy === false`, 200000);
  },
};

// one-off: Settings window at the default context (12K) and after changing ONLY the context to 8K (est. vs measured memory)
async function ctxShots() {
  const { execFileSync } = require('child_process');
  try { execFileSync('ollama', ['stop', 'qwen3:8b'], { stdio: 'ignore' }); } catch {}
  const a = await launch({ AIT_WIN_SIZE: process.env.AIT_WIN_SIZE || '1680x1080' });
  try {
    await a.waitFor(`__ait.state.pty === 'prompt'`, 20000);
    await a.ev(`__panels.openSettings().then(() => 1)`); await sleep(1500); await a.shot('17-settings');
    await a.ev(`__panels.closeSettings()`);
    await a.ev(`__panels.save('contextTokens', 8192).then(() => 1)`); await sleep(2500); // only the context changes
    await ask(a, 'pwd 명령으로 현재 디렉터리를 알려줘.'); await aiIdle(a);
    await a.waitFor(`/적재됨/.test(document.getElementById('mdl-val').textContent)`, 20000, 'model loaded');
    await a.ev(`__panels.openSettings().then(() => 1)`); await sleep(2500);
    await a.shot('18-context-8k');
    console.log('ps:', execFileSync('ollama', ['ps'], { encoding: 'utf8' }).split('\n')[1]);
  } finally { a.close(); try { execFileSync('ollama', ['stop', 'qwen3:8b'], { stdio: 'ignore' }); } catch {} }
}

async function llmDown() {
  console.log('\n# llmdown (모델 연결 실패 복구 안내)');
  const a = await launch({ OLLAMA_HOST: '127.0.0.1:9', AIT_OLLAMA_BIN: '/nonexistent/ollama' });
  try {
    await a.waitFor(`/연결 안 됨/.test(document.getElementById('model-text').textContent)`, 40000, 'model down chip');
    const banner = await a.ev(`document.querySelector('.banner.onboard') ? document.querySelector('.banner.onboard').innerText : ''`);
    check('연결 실패 시 복구 안내 배너 표시', /ollama/i.test(banner) && /연결 다시 점검/.test(banner));
    await a.waitFor(`__ait.state.pty === 'prompt'`, 20000);
    await a.ev(`__ait.term.input('echo 셸은정상', true)`); await a.ev(`__ait.term.input('\\r', true)`);
    await a.waitFor(`__ait.bufferText().includes('셸은정상')`, 8000);
    check('모델이 없어도 셸은 정상 동작', true);
    await ask(a, '현재 폴더 파일을 보여줘');
    await a.waitFor(`!!document.querySelector('.card.error')`, 60000, 'error card');
    const err = await a.ev(`document.querySelector('.card.error').innerText`);
    check('AI 요청 시 오류 카드 + 복구 방법 + 재점검 버튼', /복구 방법|ollama/i.test(err) && /다시 점검/.test(err), err.replace(/\n/g, ' ').slice(0, 120));
    await a.shot('08-llm-down');
  } finally { a.close(); }
}

async function vimScenario() {
  console.log('\n# vim (번들 vim 설정: 줄 번호·상태줄·언어별 기능)');
  const a = await launch({ AIT_CWD: '/private/tmp/ait-vim' });
  const keys = (k) => a.ev(`__ait.term.input(${JSON.stringify(k)}, true)`);
  try {
    await a.waitFor(`__ait.state.pty === 'prompt'`, 20000);
    for (const [file, tag] of [['a.py', 'py'], ['a.c', 'c'], ['a.rs', 'rs'], ['a.sh', 'sh'], ['a.cpp', 'cpp']]) {
      await keys(`vim ${file}`); await keys('\r');
      await a.waitFor(`/NORMAL/.test(__ait.bufferText())`, 15000, 'vim statusline');
      await sleep(700);
      const t = await termText(a);
      if (tag === 'py') {
        check('vim: 줄 번호 + 상태줄(NORMAL, git 브랜치, 파일 형식)', /\b1 /.test(t) && /NORMAL/.test(t) && /main/.test(t) && /python/.test(t));
        check('vim: git 변경 표시 포함 상태줄(+1)', /\+1/.test(t));
      }
      await a.shot(`09-vim-${tag}`);
      if (tag === 'py') {
        await keys(' '); await sleep(150); await keys('?'); await sleep(700); await a.shot('09-vim-help');
        check('vim: 단축키 도움말 팝업(Space ?)', /F5/.test(await termText(a)) && /단축키/.test(await termText(a)));
        await keys('q'); await sleep(300);
        await keys('\x1b[15~'); await sleep(2500); // F5 = run
        const r = await termText(a);
        check('vim: F5 실행 → 하단 터미널 창에 종료코드 표시', /종료코드 0/.test(r));
        await a.shot('09-vim-run');
        await keys('\x1b\x1b'); await keys(':qa!'); await keys('\r');
      } else { await keys(':qa!'); await keys('\r'); }
      await a.waitFor(`__ait.state.pty === 'prompt'`, 8000);
      await sleep(300);
    }
    // light theme picks the light scheme for the next vim session
    await a.ev(`document.getElementById('btn-theme').click()`); await sleep(500);
    const th = await a.ev(`document.documentElement.dataset.theme`);
    await keys('vim a.py'); await keys('\r'); await a.waitFor(`/NORMAL/.test(__ait.bufferText())`, 15000); await sleep(700);
    await a.shot('09-vim-theme-' + th);
    check('vim: 앱 테마 전환이 새 vim 세션에 반영', true, th);
    await keys(':qa!'); await keys('\r');
  } finally { a.close(); }
}

async function vimShots(SIZE) {
  // vim
  const v = await launch({ AIT_WIN_SIZE: SIZE, AIT_CWD: '/private/tmp/ait-vim' });
  const keys = (k) => v.ev(`__ait.term.input(${JSON.stringify(k)}, true)`);
  const openVim = async (f) => { await keys(`vim ${f}`); await keys('\r'); await v.waitFor(`/NORMAL/.test(__ait.bufferText())`, 15000); await sleep(900); };
  const quitVim = async () => { await keys('\x1b'); await keys(':qa!'); await keys('\r'); await v.waitFor(`__ait.state.pty === 'prompt'`, 8000); await sleep(300); };
  try {
    await v.waitFor(`__ait.state.pty === 'prompt'`, 20000);
    if ((await v.ev(`document.documentElement.dataset.theme`)) !== 'dark') { await v.ev(`document.getElementById('btn-theme').click()`); await sleep(500); }
    await openVim('a.py'); await v.shot('10-vim-python-dark');
    await keys(' '); await sleep(150); await keys('?'); await sleep(700); await v.shot('12-vim-help'); await keys('q'); await sleep(300);
    await keys('\x1b[15~'); await sleep(2500); await v.shot('13-vim-run'); await keys('\x1b\x1b'); await quitVim();
    await keys('cd bad'); await keys('\r'); await sleep(400);
    await openVim('e.c'); await keys('\x1b[17~'); await sleep(3000); await v.shot('14-vim-c-diagnostics'); await quitVim();
    await openVim('../a.rs'); await v.shot('15-vim-rust'); await quitVim();
    await v.ev(`document.getElementById('btn-theme').click()`); await sleep(500);
    await openVim('../a.py'); await v.shot('11-vim-python-light'); await quitVim();
  } finally { v.close(); }
}

// ---------- documentation screenshots (node scripts/e2e.js shots) ----------
async function shotsScenario() {
  // a small local model sometimes keeps going without acting: give it time, then stop the turn and carry on with the shot
  const calm = (a) => aiIdle(a, 150000).catch(async () => { await a.ev(`document.getElementById('btn-stop').click()`); await sleep(1500); });
  const prep = () => {
    fs.writeFileSync(path.join(WS, 'src', 'util.js'), 'function add(a, b) { return a - b; }   // BUG: should add\nmodule.exports = { add };\n');
    fs.writeFileSync(path.join(WS, 'tmp_shot.txt'), 'temp');
  };
  prep();
  const SIZE = process.env.AIT_WIN_SIZE || '1680x1080';
  const a = await launch({ AIT_WIN_SIZE: SIZE });
  const theme = async (t) => { if ((await a.ev(`document.documentElement.dataset.theme`)) !== t) { await a.ev(`document.getElementById('btn-theme').click()`); await sleep(500); } };
  try {
    await a.waitFor(`document.getElementById('model-text').textContent.length > 0 && !/확인 중/.test(document.getElementById('model-text').textContent)`, 30000);
    await theme('dark');
    await a.waitFor(`__ait.state.pty === 'prompt'`, 20000);
    console.log('# shots: 01 overview'); await ask(a, '현재 프로젝트 구조를 설명해줘.'); await aiIdle(a); await a.shot('01-overview-dark');
    console.log('# shots: 02 fix error');
    for (let attempt = 1; attempt <= 3; attempt++) { // a local 8B model does not always fix it; document the run where it did
      await ask(a, 'npm test가 실패해. 이 오류의 원인을 찾아서 수정해줘.'); await aiIdle(a);
      const fixed = /a \+ b/.test(fs.readFileSync(path.join(WS, 'src', 'util.js'), 'utf8')) && !/연속 3회 실패/.test(await tlText(a));
      if (fixed || attempt === 3) { if (!fixed) console.log('  (3번 시도했지만 모델이 수정하지 못했습니다 — 그 실행을 그대로 기록)'); break; }
      console.log(`  (시도 ${attempt}: 모델이 수정하지 못함 — 초기화 후 다시)`); prep(); await a.ev(`window.confirm = () => true; document.getElementById('btn-reset').click()`); await sleep(1200);
    }
    await a.shot('02-fix-error-dark');
    console.log('# shots: 03 natural-language guard');
    await typeInTerm(a, '이 폴더에서 설정 파일이 뭔지 알려줘'); await typeInTerm(a, '\r'); await sleep(800);
    await a.waitFor(`__ait.state.aiBusy === false && /AI에게 전달/.test(document.querySelector('.timeline.active').innerText)`, 240000);
    await a.shot('03-natural-language-guard');
    console.log('# shots: 04 approval'); await ask(a, 'tmp_shot.txt 파일을 삭제해줘.');
    await a.waitFor(`!document.getElementById('approval-bar').hidden`, 240000, 'approval bar'); await sleep(300); await a.shot('04-approval-choices');
    await a.ev(`document.getElementById('ap-no').click()`); await calm(a);
    console.log('# shots: 05 permission popover'); await a.ev(`document.getElementById('perm-chip').click()`); await sleep(400); await a.shot('05-permission-modes'); await a.ev(`document.body.click()`);
    console.log('# shots: 06 read-only'); await a.ev(`__ait.permSet('readonly')`); await sleep(300);
    await ask(a, 'echo hello > shot_test.txt 를 실행해줘.'); await calm(a); await a.shot('06-readonly-mode'); await a.ev(`__ait.permSet('default')`); await sleep(300);
    console.log('# shots: 07 tabs'); await ask(a, '옵션 없이 ls 만 실행해줘.');
    await a.ev(`__ait.newTab().then(() => 1)`); await a.waitFor(`__ait.order().length === 2 && __ait.state.pty === 'prompt'`, 20000);
    await typeInTerm(a, 'cd /usr/local'); await typeInTerm(a, '\r'); await sleep(500);
    await a.ev(`__ait.newTab().then(() => 1)`); await a.waitFor(`__ait.order().length === 3 && __ait.state.pty === 'prompt'`, 20000);
    await typeInTerm(a, 'echo 세 번째 탭: 한글 출력 확인 && uname -m'); await typeInTerm(a, '\r'); await sleep(700);
    await a.ev(`__ait.activate(__ait.order()[0])`); await sleep(500); await a.shot('07-tabs');
    await a.waitFor(`!__ait.tabs.get(__ait.order()[0]).state.aiBusy`, 240000);
    console.log('# shots: 08 model popover'); await a.ev(`document.getElementById('model').click()`); await sleep(400); await a.shot('08-model-popover'); await a.ev(`document.body.click()`);
    console.log('# shots: 08b settings'); await a.ev(`document.getElementById('btn-settings').click()`); await sleep(700); await a.shot('17-settings'); await a.ev(`__panels.closeSettings()`); await sleep(300);
    console.log('# shots: 09 light'); await theme('light'); await a.ev(`__ait.activate(__ait.order()[0])`); await sleep(500); await a.shot('09-overview-light');
  } finally { a.close(); fs.rmSync(path.join(WS, 'tmp_shot.txt'), { force: true }); }
  // model connection failure
  const b = await launch({ AIT_WIN_SIZE: SIZE, OLLAMA_HOST: '127.0.0.1:9', AIT_OLLAMA_BIN: '/nonexistent/ollama' });
  try {
    await b.waitFor(`/연결 안 됨/.test(document.getElementById('model-text').textContent)`, 40000);
    await ask(b, '현재 폴더 파일을 보여줘'); await b.waitFor(`!!document.querySelector('.card.error')`, 60000); await sleep(300);
    await b.shot('16-model-connection-failed');
  } finally { b.close(); }
  if (!process.env.AIT_SKIP_VIM) await vimShots(SIZE); // needs the vim demo files in /private/tmp/ait-vim
  fs.copyFileSync(path.join(__dirname, '..', 'build', 'icon.png'), path.join(OUT, '00-app-icon.png'));
}

module.exports = { launch, check, results, sleep, ask, aiIdle, tlText, termText, typeInTerm, WS, OUT, PROFILE, privacyHits };
if (require.main === module) (async () => {
  if (process.argv[2] === 'ctx') { await ctxShots(); console.log('done'); process.exit(0); }
  if (process.argv[2] === 'vimshots') { await vimShots(process.env.AIT_WIN_SIZE || '1680x1080'); console.log('done'); process.exit(0); }
  if (process.argv[2] === 'shots') { await shotsScenario(); if (privacyHits.length) console.log('PRIVACY — local account/host name visible in:\n  ' + privacyHits.join('\n  ')); console.log('screenshots written to', OUT); process.exit(0); }
  if (process.argv[2] === 'vim') { await vimScenario(); const f = results.filter((r) => !r.ok).length; console.log(`\n${results.length - f}/${results.length} passed`); process.exit(f ? 1 : 0); }
  if (process.argv[2] === 'llmdown') { await llmDown(); const f = results.filter((r) => !r.ok).length; console.log(`\n${results.length - f}/${results.length} passed`); process.exit(f ? 1 : 0); }
  const names = process.argv.slice(2).filter((n) => !n.startsWith('-'));
  const run = names.length ? names : ['shell', 'structure', 'streaming', 'failure', 'nl_guard', 'nl_term', 'approval'];
  const app = await launch();
  try {
    await app.waitFor(`document.getElementById('model-text').textContent.length > 0 && !/확인 중/.test(document.getElementById('model-text').textContent)`, 30000, 'model detect');
    console.log('model chip:', await app.ev(`document.getElementById('model-text').textContent`));
    for (const n of run) { console.log(`\n# ${n}`); await scenarios[n](app); }
  } catch (e) {
    console.log('ERROR', e.message);
    await app.shot('error').catch(() => {});
    results.push({ name: 'harness', ok: false });
  } finally {
    app.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
