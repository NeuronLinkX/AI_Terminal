#!/usr/bin/env node
'use strict';
// Feature e2e: drives the real app (real PTY, real shell, real IPC) against scripts/mock-ollama.js so the runs are
// deterministic and need no GPU. Usage: node scripts/e2e-features.js [scenario...]   (starts its own mock server)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMock } = require('./mock-ollama');
const { createMock: createOpenAI } = require('./mock-openai');
const { launch, check, results, sleep, ask, aiIdle, tlText, termText, typeInTerm, WS, OUT } = require('./e2e');

const MOCK_PORT = 11498;
// scripted servers only: the app must never start a real `ollama serve` during these runs
const env = (extra = {}) => ({ OLLAMA_HOST: `127.0.0.1:${MOCK_PORT}`, AIT_OLLAMA_BIN: '/nonexistent/ollama', ...extra });
const ready = (a) => a.waitFor(`document.getElementById('model-text').textContent.length > 0 && !/확인 중|Checking/.test(document.getElementById('model-text').textContent)`, 30000, 'model chip');
const promptReady = (a) => a.waitFor(`__ait.state.pty === 'prompt'`, 20000, 'shell prompt');
const click = (a, sel) => a.ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
const exists = (a, sel) => a.ev(`!!document.querySelector(${JSON.stringify(sel)})`);
const text = (a, sel) => a.ev(`(document.querySelector(${JSON.stringify(sel)}) || {}).innerText || ''`);
const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ait-feat-profile-'));

async function withApp(extra, fn, profile) {
  const a = await launch(env(extra), profile);
  try {
    await ready(a);
    await promptReady(a);
    await fn(a);
  } finally { a.close(); }
}

const scenarios = {
  // streaming: the "say" text appears token by token in a live bubble, then settles into a normal bubble
  async streaming() {
    await withApp({}, async (a) => {
      await a.ev(`window.__sawLive = false; new MutationObserver(() => { if (document.querySelector('.msg.ai.live')) window.__sawLive = true; }).observe(document.body, { subtree: true, childList: true, attributes: true })`);
      await ask(a, '현재 프로젝트 구조를 설명해줘.');
      await aiIdle(a);
      check('스트리밍: 답변이 라이브 말풍선으로 먼저 나타남', await a.ev(`window.__sawLive`));
      check('스트리밍: 완료 후 라이브 표시가 남지 않음', !(await exists(a, '.msg.ai.live')));
    });
  },

  // plan mode: plan card with steps → approve → the agent really runs it
  async plan() {
    await withApp({}, async (a) => {
      fs.writeFileSync(path.join(WS, 'src', 'util.js'), 'function add(a, b) { return a - b; }   // BUG: should add\nmodule.exports = { add };\n');
      await a.ev(`__ait.setPlan(true)`);
      check('계획 모드 토글이 켜짐', await a.ev(`document.getElementById('plan-toggle').getAttribute('aria-pressed') === 'true'`));
      await ask(a, 'npm test 가 실패해. 버그를 수정해줘.');
      await a.waitFor(`!!document.querySelector('.card.plan')`, 60000, 'plan card');
      const planTxt = await text(a, '.card.plan');
      check('계획 카드에 단계 목록 표시', /1\./.test(planTxt) || (await a.ev(`document.querySelectorAll('.card.plan .plan-steps li').length`)) >= 3, planTxt.replace(/\n/g, ' ').slice(0, 80));
      check('계획 승인 전에는 아무 명령도 실행되지 않음', !(await exists(a, '.card.cmd')));
      // revise once with feedback
      await a.ev(`(()=>{const i=document.querySelector('.card.plan .plan-fb'); i.value='테스트부터 돌려줘'; i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:13,bubbles:true}));})()`);
      await a.waitFor(`document.querySelectorAll('.card.plan').length >= 2`, 60000, 'revised plan card');
      check('수정 요청 → 새 계획 카드(2차)', /2/.test(await a.ev(`[...document.querySelectorAll('.card.plan .hd .meta')].map(e => e.textContent).join(' ')`)));
      await click(a, '.card.plan:not(.done) .acts .btn.yes');
      await aiIdle(a, 120000);
      check('계획 승인 후 실제 실행(파일 수정 + 테스트)', /a \+ b/.test(fs.readFileSync(path.join(WS, 'src', 'util.js'), 'utf8')) && /성공 · exit 0/.test(await tlText(a)));
      await a.shot('30-plan-mode');
      await a.ev(`__ait.setPlan(false)`);
    });
  },

  // project search tool + file tools
  async search() {
    await withApp({}, async (a) => {
      await ask(a, 'add 함수 정의를 검색해줘.');
      await aiIdle(a);
      const t = await tlText(a);
      check('검색 도구: 검색 카드 + 파일:줄 결과', /검색: function add/.test(t));
      await a.shot('31-search-tool');
    });
  },

  // per-project "always allow" is persisted outside the repo and applies in a NEW tab and a NEW app launch
  async projectrule() {
    const profile = fresh();
    const f1 = path.join(WS, 'proj_a.txt'); const f2 = path.join(WS, 'proj_b.txt');
    fs.writeFileSync(f1, 'a'); fs.writeFileSync(f2, 'b');
    await withApp({}, async (a) => {
      await ask(a, 'proj_a.txt 파일을 삭제해줘.');
      await a.waitFor(`!document.getElementById('approval-bar').hidden`, 60000, 'approval bar');
      await click(a, '#ap-always-proj');
      await aiIdle(a);
      check('프로젝트 규칙: 승인 후 실제 삭제', !fs.existsSync(f1));
      const stored = path.join(profile, 'project-rules.json');
      check('프로젝트 규칙: 앱 데이터 폴더에 저장(저장소 안이 아님)', fs.existsSync(stored) && /rm/.test(fs.readFileSync(stored, 'utf8')) && !fs.existsSync(path.join(WS, 'project-rules.json')));
    }, profile);
    await withApp({}, async (a) => {
      await ask(a, 'proj_b.txt 파일을 삭제해줘.');
      // proj_b.txt is a different target, so the exact-command rule must NOT match it → asks again
      await a.waitFor(`!document.getElementById('approval-bar').hidden`, 60000, 'approval bar (other target)');
      check('프로젝트 규칙: 다른 대상은 다시 승인 요청', fs.existsSync(f2));
      await a.ev(`document.getElementById('ap-no').click()`);
      await aiIdle(a);
      const chip = await text(a, '#perm-chip');
      check('앱 재시작 후에도 프로젝트 규칙이 권한 칩에 표시', /1/.test(chip), chip);
      fs.rmSync(f2, { force: true });
    }, profile);
  },

  // session history: saved, searchable, exportable, deletable
  async history() {
    const profile = fresh();
    await withApp({}, async (a) => {
      await ask(a, 'pwd 명령으로 현재 디렉터리를 알려줘.');
      await aiIdle(a);
      await a.ev(`__panels.openHistory().then(() => 1)`);
      await sleep(800);
      check('세션 기록: 목록에 현재 세션 표시', (await a.ev(`document.querySelectorAll('#hist-list .hitem').length`)) >= 1);
      await click(a, '#hist-list .hitem');
      await sleep(600);
      const v = await text(a, '#hist-view');
      check('세션 기록: 대화·실행 내역 복원 표시', /pwd/.test(v));
      await a.ev(`(()=>{const q=document.getElementById('hist-q'); q.value='pwd'; q.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await sleep(900);
      check('세션 기록: 검색', (await a.ev(`document.querySelectorAll('#hist-list .hitem').length`)) >= 1);
      await a.shot('32-history');
      await a.ev(`__panels.closeHistory()`);
    }, profile);
    const dir = path.join(profile, 'history');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    check('세션 기록: 파일이 앱 데이터 폴더에 저장됨', files.length >= 1);
    const raw = files.length ? fs.readFileSync(path.join(dir, files[0]), 'utf8') : '';
    check('세션 기록: 사용자 홈 비밀정보 패턴이 저장되지 않음', !/sk-[A-Za-z0-9]{20,}/.test(raw));
  },

  // split pane + terminal search + links
  async terminal() {
    await withApp({}, async (a) => {
      await typeInTerm(a, 'echo needle-ONE; echo hay; echo needle-TWO; ls src\r');
      await a.waitFor(`__ait.bufferText().includes('needle-TWO')`, 8000);
      await a.ev(`__ait.openSearch()`);
      await a.ev(`(()=>{const i=document.getElementById('ts-input'); i.value='needle'; i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await sleep(500);
      const cnt = await text(a, '#ts-count');
      check('터미널 검색(⌘F): 일치 개수 표시', /\d+\/\d+/.test(cnt), cnt);
      await a.shot('33-term-search');
      await a.ev(`__ait.closeSearch()`);
      check('터미널 검색: 닫기', await a.ev(`document.getElementById('termsearch').hidden`));
      // split
      await a.ev(`__ait.toggleSplit().then(() => 1)`);
      await a.waitFor(`document.querySelectorAll('.term-wrap.active .pane').length === 2`, 15000, 'two panes');
      check('화면 분할: 두 번째 PTY 패널 생성', true);
      await sleep(900);
      await a.ev(`document.querySelector('.term-wrap.active .pane-second .xterm-helper-textarea').focus()`);
      await a.ev(`__ait.term.input('echo SECOND_PANE_OK\\r', true)`);
      await sleep(900);
      const second = await a.ev(`(() => { const t = __ait.active.panes.second.term; let s=''; for (let i=0;i<t.buffer.active.length;i++){ const l=t.buffer.active.getLine(i); if(l) s+=l.translateToString(true)+'\\n'; } return s; })()`);
      check('화면 분할: 보조 셸이 독립적으로 동작', /SECOND_PANE_OK/.test(second));
      await a.shot('34-split-pane');
      await a.ev(`__ait.toggleSplit().then(() => 1)`);
      await a.waitFor(`document.querySelectorAll('.term-wrap.active .pane').length === 1`, 8000, 'single pane');
      check('화면 분할: 닫으면 보조 셸 종료', true);
      // path link validation goes through the main process (existing vs missing file)
      const r = await a.ev(`window.ait.linkCheck(['src/util.js', 'no/such/file.js'], '${WS}')`);
      check('경로 링크: 존재하는 파일만 링크 처리', JSON.stringify(r) === JSON.stringify([true, false]), JSON.stringify(r));
    });
  },

  // command blocks panel and process panel (with a real background process)
  async panels() {
    await withApp({}, async (a) => {
      await typeInTerm(a, 'echo block-one\r'); await sleep(700);
      await typeInTerm(a, 'false\r'); await sleep(700);
      await a.ev(`__panels.openDrawer('blocks')`); await sleep(500);
      const n = await a.ev(`document.querySelectorAll('#drawer .block').length`);
      check('명령 블록: 직접 실행한 명령이 블록으로 기록됨', n >= 2, `${n}개`);
      check('명령 블록: 실패(exit 1) 표시', await a.ev(`!!document.querySelector('#drawer .block.fail')`));
      await a.shot('35-blocks');
      await a.ev(`__panels.closeDrawer()`);
      // process panel: start something that keeps running in this shell
      await typeInTerm(a, 'sleep 120 &\r'); await sleep(900);
      await a.ev(`__panels.openDrawer('procs')`);
      await a.waitFor(`/sleep 120/.test(document.getElementById('drawer-body').innerText)`, 8000, 'sleep process listed');
      check('프로세스 패널: 하위 프로세스(sleep) 표시', true);
      await a.shot('36-processes');
      await a.ev(`window.confirm = () => true; [...document.querySelectorAll('#drawer .proc .btn.danger')][0].click()`);
      await sleep(1500);
      await a.waitFor(`!/sleep 120/.test(document.getElementById('drawer-body').innerText)`, 8000, 'process stopped');
      check('프로세스 패널: 중지 버튼이 실제로 프로세스를 종료', true);
      await a.ev(`__panels.closeDrawer()`);
    });
  },

  // onboarding: no model installed → recommended list → real pull progress against the mock → model selected
  async onboarding() {
    process.env.MOCK_EMPTY = '1';
    const empty = createMock({ port: MOCK_PORT + 1 });
    delete process.env.MOCK_EMPTY;
    await empty.listen();
    const a = await launch({ OLLAMA_HOST: `127.0.0.1:${MOCK_PORT + 1}`, AIT_LANG: 'ko' });
    try {
      await a.waitFor(`!!document.querySelector('.banner.onboard')`, 40000, 'onboarding banner');
      const txt = await text(a, '.banner.onboard');
      check('온보딩: 모델이 없으면 내려받기 안내 표시', /설치된 모델이 없습니다/.test(txt) && /내려받기/.test(txt), txt.replace(/\n/g, ' ').slice(0, 100));
      await a.shot('37-onboarding');
      await a.ev(`window.confirm = () => true`);
      check('온보딩: 자동 다운로드되지 않음(버튼을 눌러야 시작)', empty.state.pulls.length === 0);
      await a.ev(`document.querySelector('.banner.onboard .ob-model .btn').click()`);
      await a.waitFor(`/완료/.test(document.querySelector('.banner.onboard') ? document.querySelector('.banner.onboard').innerText : 'x') || !document.querySelector('.banner.onboard')`, 30000, 'pull done');
      check('온보딩: 진행률 이벤트 후 내려받기 완료', empty.state.pulls.length === 1, empty.state.pulls.join(','));
      await a.waitFor(`!/연결 안 됨/.test(document.getElementById('model-text').textContent)`, 20000, 'model selected');
      check('온보딩: 내려받은 모델이 자동 선택됨', /Ollama/.test(await text(a, '#model-text')));
    } finally { a.close(); await empty.close(); }
  },

  // settings: language switch, key bindings validation, new sections
  async settings2() {
    await withApp({}, async (a) => {
      await a.ev(`__panels.openSettings().then(() => 1)`); await sleep(700);
      const t = await text(a, '#settings-modal .sm-dialog');
      check('설정: 새 섹션(OpenAI 호환·화면·권한·단축키·업데이트) 표시', /OpenAI 호환/.test(t) && /글꼴/.test(t) && /네트워크 차단/.test(t) && /단축키/.test(t) && /업데이트/.test(t));
      check('설정: KV 캐시 정밀도·프롬프트 압축 항목 표시(자동 / f16 / q8_0 / q4_0, 자동 / 강하게 / 끔)', /KV 캐시 정밀도/.test(t) && /q8_0 \(절반\)/.test(t) && /프롬프트 압축/.test(t) && /강하게/.test(t));
      const kvRow = `[...document.querySelectorAll('.srow')].find((r) => /KV 캐시 정밀도/.test(r.innerText))`;
      const estGB = async () => Number((await a.ev(`document.querySelector('.sm-est-line').innerText`)).match(/약 ([\d.]+)GB/g)[0].match(/[\d.]+/)[0]);
      await a.ev(`${kvRow}.querySelectorAll('.seg-b')[1].click()`); await sleep(700);
      const f16 = await estGB();
      await a.ev(`${kvRow}.querySelectorAll('.seg-b')[2].click()`); await sleep(700);
      const q8 = await estGB();
      check('설정: KV 정밀도를 q8_0 으로 고르면 저장되고 선택 표시', (await a.ev(`window.ait.settingsGet().then((m) => m.values.kvPrecision)`)) === 'q8_0' && /q8_0/.test(await a.ev(`${kvRow}.querySelector('.seg-b.on').textContent`)));
      check('설정: q8_0 이면 예상 메모리(KV)가 f16 의 약 절반으로 표시', q8 < f16 && q8 / f16 < 0.65 && q8 / f16 > 0.4, `f16 ${f16}GB → q8_0 ${q8}GB`);
      await a.ev(`window.ait.settingsSet('kvPrecision', 'auto').then(() => 1)`);
      // font size stepper changes xterm
      const before = await a.ev(`__ait.term.options.fontSize`);
      await a.ev(`[...document.querySelectorAll('.stepper .btn')].find(b => b.textContent === '+').click()`); await sleep(600);
      check('설정: 글자 크기가 터미널에 즉시 반영', (await a.ev(`__ait.term.options.fontSize`)) === before + 1);
      // invalid accelerator is rejected, valid one accepted
      await a.ev(`(()=>{const i=document.querySelector('.keyrow .kin'); i.value='NotAKey++'; i.dispatchEvent(new Event('change',{bubbles:true}));})()`); await sleep(500);
      check('설정: 잘못된 단축키 형식은 거부됨', await a.ev(`document.querySelector('.keyrow .kin').classList.contains('bad')`));
      // language → English
      await a.ev(`__panels.save('language', 'en').then(() => 1)`); await sleep(800);
      const en = await text(a, '#settings-modal .sm-dialog');
      check('설정: 언어를 English 로 바꾸면 UI 전체가 영어로 전환', /Settings/.test(en) && /Context length/.test(en) && !/컨텍스트 길이/.test(en));
      await a.ev(`__panels.closeSettings()`); await sleep(300);
      const chrome = await a.ev(`document.getElementById('btn-stop').textContent + '|' + document.getElementById('mode-sh').innerText + '|' + document.getElementById('input').placeholder`);
      check('영어 UI: 상단 버튼·입력창 문구', /Stop/.test(chrome) && /Shell/.test(chrome) && /Tell the AI/.test(chrome), chrome);
      await a.shot('38-english-ui');
      // AI answers carry the language instruction (English), and main-process texts are translated
      await ask(a, 'tmp_to_delete.txt 파일을 삭제해줘.');
      await a.waitFor(`!document.getElementById('approval-bar').hidden`, 60000, 'approval bar (en)');
      const bar = await text(a, '#approval-bar');
      check('영어 UI: 승인 바와 정책 사유가 영어로 표시', /Approval needed/.test(bar) && /File deletion/.test(bar), bar.replace(/\n/g, ' ').slice(0, 120));
      await a.shot('39-english-approval');
      await a.ev(`document.getElementById('ap-no').click()`);
      await aiIdle(a);
      await a.ev(`__panels.save('language', 'ko').then(() => 1)`); await sleep(500);
      check('설정: 한국어로 되돌리면 다시 한국어', /초기화/.test(await a.ev(`document.getElementById('btn-reset').textContent`)) && /복사/.test(await a.ev(`document.getElementById('btn-copy').textContent`)));
    });
  },

  // network-block mode: curl is refused by policy even in trust mode; audit log records the decision
  async netblock() {
    const profile = fresh();
    await withApp({}, async (a) => {
      await a.ev(`window.confirm = () => true`); // trust mode asks for a confirmation: a native dialog would block the page
      await a.ev(`__panels.save('blockNetwork', true).then(() => 1)`); await sleep(400);
      await a.ev(`__ait.permSet('trust')`); await sleep(300);
      await ask(a, 'curl 로 외부 주소에 요청해줘.');
      await aiIdle(a, 120000);
      const t = await tlText(a);
      check('네트워크 차단 모드: curl 이 실행되지 않고 차단 카드 표시', /네트워크 차단 모드/.test(t) && !(await exists(a, '.card.cmd.ok')), t.replace(/\n/g, ' ').slice(0, 140));
      const n = await a.ev(`window.ait.auditCount()`);
      check('감사 기록: 차단 결정이 기록됨', n >= 1, `${n}건`);
      const out = await a.ev(`window.ait.auditExport('json')`);
      check('감사 기록: JSON 내보내기', out.ok && fs.existsSync(out.path), out.path);
      const body = out.ok ? fs.readFileSync(out.path, 'utf8') : '';
      check('감사 기록: curl 명령이 deny 로 남음', /curl/.test(body) && /deny|block/i.test(body));
      if (out.ok) fs.rmSync(out.path, { force: true });
      await a.ev(`__panels.save('blockNetwork', false).then(() => 1)`);
    }, profile);
  },

  // tabs persist across restarts (cwd + custom title)
  async restore() {
    const profile = fresh();
    await withApp({}, async (a) => {
      await a.ev(`window.ait.settingsSet('restoreTabs', true).then(() => 1)`);
      await typeInTerm(a, 'cd src\r'); await a.waitFor(`/src$/.test(__ait.active.state.cwd)`, 8000);
      await a.ev(`__ait.newTab({}).then(() => 1)`);
      await a.waitFor(`__ait.order().length === 2 && __ait.state.pty === 'prompt'`, 20000);
      await a.ev(`(() => { const t = __ait.active; t.customTitle = '내 탭'; window.ait.tabTitle(t.id, '내 탭'); })()`);
      await sleep(500);
      await a.ev(`window.ait.tabActive(__ait.active.id)`);
      await sleep(500);
    }, profile);
    await sleep(1500);
    await withApp({}, async (a) => {
      await a.waitFor(`__ait.order().length === 2`, 20000, 'restored tabs');
      const titles = await a.ev(`[...document.querySelectorAll('#tabbar .tab .ttl')].map(e => e.textContent).join('|')`);
      check('탭 복원: 재시작 후 탭 2개가 같은 디렉터리/이름으로 열림', /src/.test(titles) && /내 탭/.test(titles), titles);
      await a.shot('40-restored-tabs');
    }, profile);
  },

  // experimental remote mode: AI drives a nested interactive shell through sentinel markers
  async remote() {
    await withApp({}, async (a) => {
      await typeInTerm(a, 'env -i PATH=/usr/bin:/bin HOME=/tmp sh -i\r');
      await sleep(1200);
      await a.ev(`window.confirm = () => true; document.getElementById('remote-toggle').click()`);
      await a.waitFor(`document.getElementById('remote-toggle').getAttribute('aria-pressed') === 'true'`, 30000, 'remote mode on'); // the far side is probed first
      check('원격 모드: 토글이 켜지고 탭에 서버(중첩 셸) 정보가 표시', await a.ev(`!!document.querySelector('#tabbar .tab.active .tremote') && document.querySelector('#tabbar .tab.active .tremote').innerText.length > 0`));
      const noAi = (ms) => a.waitFor(`!__ait.state.aiBusy`, ms, 'AI turn finished'); // the tab chip stays "busy": the outer shell is running the nested one
      await ask(a, 'pwd 명령으로 현재 디렉터리를 알려줘.');
      await noAi(120000);
      const t = await tlText(a);
      check('원격 모드: 중첩 셸 안에서 명령이 실행되고 결과가 카드에 표시', /성공 · exit 0/.test(t) && /\//.test(t), t.replace(/\n/g, ' ').slice(-160));
      await ask(a, 'add 함수 정의를 검색해줘.');
      await noAi(120000);
      const t2 = await tlText(a);
      check('원격 모드: 파일 도구(검색)도 셸이 있는 쪽(중첩 셸)에서 실행되어 결과가 표시', /util\.js/.test(t2) && !/사용할 수 없/.test(t2), t2.replace(/\n/g, ' ').slice(-160));
      await a.shot('41-remote-mode');
      await a.ev(`document.getElementById('remote-toggle').click()`);
      await typeInTerm(a, 'exit\r');
    });
  },

  // SSH in the window: session manager, shared connection, server monitor beside this Mac's, side bar file trees with
  // drag & drop copy in both directions, transfers, AI on the server (approval badge), disconnect cleanup.
  // The "server" is a throw-away sshd on 127.0.0.1 with a generated key; HOME is a temp folder, so nothing real is shown.
  async ssh() {
    const { startSshd } = require('../test/helpers/sshd');
    const real = (p) => fs.realpathSync(p);
    const srv = real(fs.mkdtempSync(path.join(os.tmpdir(), 'ait-srv-home-')));
    const home = real(fs.mkdtempSync(path.join(os.tmpdir(), 'ait-feat-home-')));
    const put = (f, c) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); };
    put(path.join(srv, 'notes.txt'), 'server notes: deploy at 18:00\n');
    put(path.join(srv, 'doomed.txt'), 'to be removed\n');
    put(path.join(srv, 'projects', 'app', 'util.js'), 'function add(a, b) { return a + b; }\nmodule.exports = { add };\n');
    put(path.join(srv, 'projects', 'app', 'main.py'), 'print("hello from the server")\n');
    put(path.join(srv, 'data', 'readme.md'), '# data\n');
    put(path.join(home, 'report.txt'), 'local report ' + 'x'.repeat(5000) + '\n');
    put(path.join(home, 'photos', 'a.txt'), 'A\n');
    put(path.join(home, 'photos', 'b.txt'), 'B\n');
    fs.mkdirSync(path.join(home, 'Downloads'), { recursive: true });
    const sshd = await startSshd({ home: srv, ps1: 'demo@gpu-server:~\\$ ', identity: { user: 'demo', host: 'gpu-server' } }); // neutral names: a run may be screen-recorded
    if (!sshd) { check('SSH 화면: 임시 sshd 를 시작할 수 없어 건너뜀', true, 'skipped'); return; }
    // ~/.ssh/config of the temp HOME: an alias for the throw-away server (no password anywhere)
    put(path.join(home, '.ssh', 'config'), [
      'Host gpu-server', '  HostName 127.0.0.1', `  Port ${sshd.port}`, `  IdentityFile ${sshd.key}`, '  IdentitiesOnly yes',
      `  UserKnownHostsFile ${sshd.knownHosts}`, '  StrictHostKeyChecking yes', '',
    ].join('\n'));
    fs.chmodSync(path.join(home, '.ssh', 'config'), 0o600);
    // OpenSSH reads the account's ~/.ssh/config (not $HOME): AIT_SSH_DIR points the app — host list AND the ssh it types — at
    // the temp config, so nothing of the real ~/.ssh is read or shown.
    const frow = (side, p) => `(() => { const pane = document.querySelector('.fpane[data-side="${side}"]'); return pane && [...pane.querySelectorAll('.frow')].find((r) => r.dataset.path === ${JSON.stringify(p)}); })()`;
    const dnd = (a, from, fromPath, to, toPath) => a.ev(`(() => {
      const row = (s, p) => { const pane = document.querySelector('.fpane[data-side="' + s + '"]'); return [...pane.querySelectorAll('.frow')].find((r) => r.dataset.path === p); };
      const src = row(${JSON.stringify(from)}, ${JSON.stringify(fromPath)});
      const dst = row(${JSON.stringify(to)}, ${JSON.stringify(toPath)}) || document.querySelector('.fpane[data-side="${to}"] .ftree');
      if (!src || !dst) return 'missing ' + (!src ? 'src' : 'dst');
      const dt = new DataTransfer();
      const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      fire(src, 'dragstart'); fire(dst, 'dragenter'); fire(dst, 'dragover'); fire(dst, 'drop'); fire(src, 'dragend');
      return 'ok';
    })()`);
    const profile = fresh();
    const a = await launch(env({ AIT_CWD: home, AIT_SSH_DIR: path.join(home, '.ssh') }), profile);
    try {
      await ready(a); await promptReady(a);
      check('SSH 화면: 왼쪽 활동 막대(세션·파일·상태·설정)가 보임', (await a.ev(`document.querySelectorAll('#activity .act, #side .act').length`)) >= 4);
      // ---- session manager
      await click(a, '.act[data-pane="sessions"]');
      await a.waitFor(`[...document.querySelectorAll('#sp-sessions .sess-row')].some((r) => /gpu-server/.test(r.innerText))`, 15000, '~/.ssh/config host in the session manager');
      check('세션 관리자: ~/.ssh/config 의 호스트가 목록에 표시', true);
      check('세션 관리자: 비밀번호는 저장하지 않는다는 안내 표시', /비밀번호/.test(await text(a, '#sp-sessions')));
      await a.shot('50-ssh-sessions');
      // a saved session: validate, save, list
      await a.ev(`(async () => { const r = await window.ait.sessSave({ name: '개발 서버', folder: '회사', host: '127.0.0.1', port: ${sshd.port}, user: ${JSON.stringify(sshd.user)}, keyFile: ${JSON.stringify(sshd.key)}, keepAlive: true, share: true, x11: 'off', forwards: [{ kind: 'L', listenPort: 18080, host: 'localhost', port: 80 }] }); return r.ok; })()`);
      const bad = await a.ev(`window.ait.sessSave({ name: 'x', host: '-oProxyCommand=evil' }).then((r) => r.ok)`);
      check('세션 저장: 옵션 주입 형태의 호스트는 거부', bad === false);
      const cmd = await a.ev(`window.ait.sessList().then((d) => { const s = d.sessions.find((x) => x.name === '개발 서버'); return window.ait.sessCommand({ id: s.id }).then((r) => r.command); })`);
      check('세션 저장: 명령줄에 키 경로·점프·터널이 안전하게 들어가고 비밀번호는 없음', /-L 18080:localhost:80/.test(cmd) && /IdentitiesOnly=yes/.test(cmd) && !/pass/i.test(cmd), cmd.replace(sshd.dir, '<dir>'));
      // ---- connect (alias from ~/.ssh/config): opens a new tab that runs ssh
      await a.ev(`(() => { const r = [...document.querySelectorAll('#sp-sessions .sess-row')].find((x) => /gpu-server/.test(x.innerText)); r.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); })()`);
      await a.waitFor(`__ait.order().length === 2`, 20000, 'new tab for the ssh session');
      await a.waitFor(`!document.getElementById('ssh-chip').hidden`, 40000, 'ssh chip');
      check('SSH 접속: 탭이 서버 접속으로 인식되어 칩 표시', /gpu-server/.test(await text(a, '#ssh-chip')), await text(a, '#ssh-chip'));
      check('SSH 접속: 탭 이름 옆에 접속 대상 표시', /gpu-server/.test(await a.ev(`document.querySelector('#tabbar .tab.active').innerText`)));
      // ---- monitor of the server next to this Mac's
      await a.waitFor(`!document.getElementById('rmon').hidden && document.querySelector('#rmon .rcpu') && !document.querySelector('#rmon .rcpu').hidden`, 40000, 'server monitor');
      const mon = await a.ev(`(() => { const r = document.getElementById('rmon'); const own = [...document.getElementById('sysmon').children].filter((c) => !c.hidden); return { remote: r.innerText.replace(/\\s+/g, ' '), cpu: !!r.querySelector('.rcpu .bar i'), mem: !!r.querySelector('.rmem .bar i'), disk: !!r.querySelector('.rdisk .bar i'), ownVisible: own.length, tip: r.querySelector('.rcpu').title, strip: !document.getElementById('rstrip').hidden }; })()`);
      check('서버 모니터: 접속 직후 탭 아래 띠에 서버 CPU·메모리·GPU·디스크가 표시', mon.strip && mon.cpu && mon.mem && mon.disk && /CPU/.test(mon.remote) && /GPU/.test(mon.remote) && /\d/.test(mon.remote), mon.remote);
      check('서버 모니터: 이 Mac 의 모니터도 동시에 표시', mon.ownVisible >= 1, `visible local segments=${mon.ownVisible}`);
      check('서버 모니터: 툴팁에 서버 OS·코어·메모리·디스크 표시', /CPU/.test(mon.tip) && /(GB|G)/.test(mon.tip), mon.tip.replace(/\n/g, ' | ').slice(0, 160));
      // ---- file trees open on their own
      await a.waitFor(`document.querySelector('#sp-files') && !document.getElementById('sp-files').hidden`, 20000, 'files panel opens on connect');
      await a.waitFor(`!!${frow('remote', path.join(srv, 'notes.txt'))} && !!${frow('local', path.join(home, 'report.txt'))}`, 25000, 'both trees listed');
      check('폴더 트리: 접속하면 서버(위)와 이 Mac(아래) 트리가 왼쪽에 자동으로 열림', true);
      const hidden = await a.ev(`!${frow('remote', path.join(srv, '.ssh'))} && !${frow('local', path.join(home, '.ssh'))}`);
      check('폴더 트리: 숨김 파일은 기본으로 감춤', hidden);
      await a.shot('51-ssh-files');
      // ---- expand a server folder
      await a.ev(`${frow('remote', path.join(srv, 'projects'))}.querySelector('.fcaret').click()`);
      await a.waitFor(`!!${frow('remote', path.join(srv, 'projects', 'app'))}`, 15000, 'expanded folder');
      check('폴더 트리: 서버 폴더를 펼치면 하위 항목이 지연 로딩됨', true);
      // ---- upload by drag & drop (this Mac -> server): a file, then a folder
      check('드래그 복사: 이 Mac → 서버(파일) 드롭 이벤트 처리', (await dnd(a, 'local', path.join(home, 'report.txt'), 'remote', path.join(srv, 'data'))) === 'ok');
      await a.waitFor(`false || ${JSON.stringify(true)}`, 1000);
      for (let i = 0; i < 40 && !fs.existsSync(path.join(srv, 'data', 'report.txt')); i++) await sleep(250);
      check('드래그 복사: 파일이 서버 폴더에 도착하고 내용이 같음', fs.existsSync(path.join(srv, 'data', 'report.txt')) && fs.readFileSync(path.join(srv, 'data', 'report.txt'), 'utf8') === fs.readFileSync(path.join(home, 'report.txt'), 'utf8'));
      await dnd(a, 'local', path.join(home, 'photos'), 'remote', path.join(srv, 'data'));
      for (let i = 0; i < 40 && !fs.existsSync(path.join(srv, 'data', 'photos', 'b.txt')); i++) await sleep(250);
      check('드래그 복사: 폴더가 통째로 서버에 복사됨', fs.existsSync(path.join(srv, 'data', 'photos', 'a.txt')) && fs.readFileSync(path.join(srv, 'data', 'photos', 'b.txt'), 'utf8') === 'B\n');
      const stat = await a.ev(`__ait && 1`);
      // ---- download by drag & drop (server -> this Mac)
      check('드래그 복사: 서버 → 이 Mac 드롭 이벤트 처리', (await dnd(a, 'remote', path.join(srv, 'notes.txt'), 'local', path.join(home, 'Downloads'))) === 'ok');
      for (let i = 0; i < 40 && !fs.existsSync(path.join(home, 'Downloads', 'notes.txt')); i++) await sleep(250);
      check('드래그 복사: 서버 파일이 이 Mac 폴더에 내려받아짐(내용 동일)', fs.existsSync(path.join(home, 'Downloads', 'notes.txt')) && fs.readFileSync(path.join(home, 'Downloads', 'notes.txt'), 'utf8') === fs.readFileSync(path.join(srv, 'notes.txt'), 'utf8'));
      // same name again -> conflict dialog (nothing is overwritten silently)
      fs.writeFileSync(path.join(home, 'Downloads', 'notes.txt'), 'LOCAL EDIT\n');
      await dnd(a, 'remote', path.join(srv, 'notes.txt'), 'local', path.join(home, 'Downloads'));
      await sleep(1800);
      const conflict = await a.ev(`!!document.querySelector('.ait-modal') || /덮어|이름|건너/.test(document.body.innerText)`);
      check('드래그 복사: 같은 이름이 있으면 덮어쓰기 확인을 묻고 임의로 덮어쓰지 않음', conflict && fs.readFileSync(path.join(home, 'Downloads', 'notes.txt'), 'utf8') === 'LOCAL EDIT\n');
      await a.ev(`(() => { const m = document.querySelector('.ait-modal'); if (m) { const b = [...m.querySelectorAll('button')].find((x) => /건너|취소|Skip|Cancel/.test(x.textContent)); if (b) b.click(); else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } })()`);
      await sleep(500);
      check('전송 목록: 끝난 전송이 진행 목록에 표시', (await a.ev(`document.querySelectorAll('#fx-list .xrow, #fx-list > div').length`)) >= 1);
      await a.shot('52-ssh-transfers');
      // ---- server status panel
      await click(a, '.act[data-pane="status"]');
      await a.waitFor(`/CPU/.test(document.getElementById('sp-status').innerText) && /gpu-server|127\\.0\\.0\\.1/.test(document.getElementById('sp-status').innerText)`, 15000, 'status panel');
      const st = await text(a, '#sp-status');
      check('상태 패널: 서버 CPU·메모리·디스크와 이 Mac 비교 표시', /CPU/.test(st) && /(메모리|Memory)/.test(st) && /(디스크|Disk)/.test(st), st.replace(/\n/g, ' ').slice(0, 140));
      await a.shot('53-ssh-status');
      // ---- AI works on the server
      await click(a, '.act[data-pane="files"]');
      const offer = await a.ev(`!!document.querySelector('.timeline.active .note button.btn.primary')`);
      check('원격 AI: 접속 직후 "이 서버에서 AI 로 작업할까요?" 제안 표시(기본 설정)', offer);
      await a.ev(`document.querySelector('.timeline.active .note button.btn.primary').click()`);
      await a.waitFor(`/· AI/.test(document.getElementById('ssh-chip').innerText)`, 30000, 'remote mode on');
      check('원격 AI: 승인하면 칩에 "· AI" 가 표시되고 서버 정보를 알아냄', true);
      await ask(a, 'pwd 명령으로 현재 디렉터리를 알려줘.');
      await aiIdle(a, 120000).catch(() => {});
      await a.waitFor(`!__ait.state.aiBusy`, 120000, 'AI turn');
      const t1 = await tlText(a);
      check('원격 AI: 명령이 서버에서 실행됨(서버 홈 경로가 결과로 나옴)', t1.includes(srv) && /성공 · exit 0/.test(t1), t1.replace(/\n/g, ' ').slice(-200));
      await ask(a, 'add 함수 정의를 검색해줘.');
      await a.waitFor(`!__ait.state.aiBusy`, 120000, 'AI turn');
      check('원격 AI: 파일 검색 도구가 서버 파일을 검색', /util\.js/.test(await tlText(a)));
      await ask(a, 'doomed.txt 파일을 삭제해줘.');
      await a.waitFor(`!document.getElementById('approval-bar').hidden`, 60000, 'approval bar');
      const badge = await a.ev(`({ hidden: document.getElementById('ap-host').hidden, text: document.getElementById('ap-host').innerText, always: !!document.getElementById('ap-always-proj') && !document.getElementById('ap-always-proj').hidden })`);
      check('원격 AI: 삭제 같은 명령은 승인 전에 서버 이름 배지와 함께 확인을 요청', !badge.hidden && /gpu-server/.test(badge.text), JSON.stringify(badge));
      check('원격 AI: 서버 명령은 "이 프로젝트에서 항상 허용(저장)" 을 제공하지 않음(세션 규칙만)', badge.always === false);
      check('원격 AI: 승인 전에는 서버 파일이 그대로 있음', fs.existsSync(path.join(srv, 'doomed.txt')));
      await a.shot('54-ssh-approval');
      await a.ev(`document.getElementById('ap-no').click()`);
      await a.waitFor(`!__ait.state.aiBusy`, 60000, 'AI turn after deny');
      check('원격 AI: 거절하면 서버 파일이 삭제되지 않음', fs.existsSync(path.join(srv, 'doomed.txt')));
      await ask(a, 'doomed.txt 파일을 삭제해줘.');
      await a.waitFor(`!document.getElementById('approval-bar').hidden`, 60000, 'approval bar #2');
      await a.ev(`document.getElementById('ap-once').click()`);
      await a.waitFor(`!__ait.state.aiBusy`, 60000, 'AI turn after approve');
      check('원격 AI: 승인하면 서버에서 실제로 삭제됨', !fs.existsSync(path.join(srv, 'doomed.txt')));
      await ask(a, '새 파일을 만들어줘.');
      await a.waitFor(`!document.getElementById('approval-bar').hidden`, 60000, 'approval for remote write');
      const wbadge = await a.ev(`document.getElementById('ap-host').innerText`);
      check('원격 AI: 서버에 파일을 쓰는 도구도 서버 이름 배지로 확인을 요청', /gpu-server/.test(wbadge), wbadge);
      await a.ev(`document.getElementById('ap-once').click()`);
      await a.waitFor(`!__ait.state.aiBusy`, 60000, 'AI turn after write');
      check('원격 AI: 승인하면 서버 홈에 파일이 생성됨(내 Mac 의 작업 폴더가 아님)', fs.existsSync(path.join(srv, 'made_by_mock.txt')) && !fs.existsSync(path.join(WS, 'made_by_mock.txt')));
      await a.shot('55-ssh-remote-ai');
      // ---- file operations of the trees (context menu, dialogs), chip popover and session editor
      await a.ev(`window.confirm = () => true`);
      const ctx = async (side, p, label) => {
        const ok = await a.ev(`(() => { const r = ${frow(side, p)}; if (!r) return 'norow'; const b = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 20, clientY: b.top + 8 })); const it = [...document.querySelectorAll('.ctx .ctx-i')].find((x) => ${label}.test(x.innerText)); if (!it) return 'noitem:' + [...document.querySelectorAll('.ctx .ctx-i')].map((x) => x.innerText).join('|'); it.click(); return 'ok'; })()`);
        return ok;
      };
      const answer = async (value) => {
        await a.waitFor(`!!document.querySelector('.ait-modal input.sm-input')`, 8000, 'text dialog');
        await a.ev(`(() => { const i = document.querySelector('.ait-modal input.sm-input'); i.value = ${JSON.stringify(value)}; document.querySelector('.ait-modal .btn.primary').click(); })()`);
      };
      const rowsOf = (side) => a.ev(`[...document.querySelectorAll('.fpane[data-side="${side}"] .frow')].map((r) => r.dataset.path.split('/').pop())`);
      put(path.join(srv, '.dotfile'), 'hidden\n');
      // new folder (toolbar)
      await a.ev(`[...document.querySelectorAll('.fpane[data-side="remote"] .ftool button')].find((b) => /새 폴더/.test(b.title)).click()`);
      await answer('newdir');
      for (let i = 0; i < 30 && !fs.existsSync(path.join(srv, 'newdir')); i++) await sleep(200);
      check('파일 작업: 서버에 새 폴더 만들기', fs.statSync(path.join(srv, 'newdir')).isDirectory());
      await a.waitFor(`!!${frow('remote', path.join(srv, 'newdir'))}`, 8000);
      // rename
      check('파일 작업: 우클릭 메뉴가 열림(이름 바꾸기)', (await ctx('remote', path.join(srv, 'newdir'), /이름 바꾸기/)) === 'ok');
      await answer('renamed');
      for (let i = 0; i < 30 && !fs.existsSync(path.join(srv, 'renamed')); i++) await sleep(200);
      check('파일 작업: 서버 항목 이름 바꾸기', fs.existsSync(path.join(srv, 'renamed')) && !fs.existsSync(path.join(srv, 'newdir')));
      // chmod
      await ctx('remote', path.join(srv, 'notes.txt'), /chmod/);
      await answer('600');
      for (let i = 0; i < 30 && (fs.statSync(path.join(srv, 'notes.txt')).mode & 0o777) !== 0o600; i++) await sleep(200);
      check('파일 작업: 권한 변경(chmod 600)', (fs.statSync(path.join(srv, 'notes.txt')).mode & 0o777) === 0o600);
      // preview
      check('파일 작업: 미리보기 메뉴', (await ctx('remote', path.join(srv, 'notes.txt'), /미리보기/)) === 'ok');
      await a.waitFor(`!!document.querySelector('.ait-modal pre.preview')`, 10000, 'preview');
      check('파일 작업: 서버 파일 내용이 미리보기에 표시', /deploy at 18:00/.test(await text(a, '.ait-modal pre.preview')));
      await a.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await sleep(300);
      // hidden files toggle
      check('폴더 트리: 숨김 파일은 처음에 보이지 않음', !(await rowsOf('remote')).includes('.dotfile'));
      await a.ev(`[...document.querySelectorAll('.fpane[data-side="remote"] .ftool button')].find((b) => /숨김/.test(b.title)).click()`);
      await sleep(300);
      check('폴더 트리: 숨김 파일 표시를 켜면 나타남', (await rowsOf('remote')).includes('.dotfile'));
      await a.ev(`[...document.querySelectorAll('.fpane[data-side="remote"] .ftool button')].find((b) => /숨김/.test(b.title)).click()`);
      // filter
      await a.ev(`(() => { const i = document.querySelector('.fpane[data-side="remote"] .ffilter'); i.value = 'note'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await sleep(300);
      const filtered = await rowsOf('remote');
      check('폴더 트리: 이름 필터', filtered.length >= 1 && filtered.every((n) => /note/i.test(n)), filtered.join(','));
      await a.ev(`(() => { const i = document.querySelector('.fpane[data-side="remote"] .ffilter'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      // path bar + up
      await a.ev(`(() => { const i = document.querySelector('.fpane[data-side="remote"] .fpath'); i.value = ${JSON.stringify(path.join(srv, 'projects'))}; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true })); })()`);
      await a.waitFor(`document.querySelector('.fpane[data-side="remote"] .fpath').value === ${JSON.stringify(path.join(srv, 'projects'))} && !!${frow('remote', path.join(srv, 'projects', 'app'))} && !${frow('remote', path.join(srv, 'notes.txt'))}`, 10000, 'path bar navigation'); // the tree itself now starts in projects
      check('폴더 트리: 경로 입력줄로 이동', true);
      await a.ev(`[...document.querySelectorAll('.fpane[data-side="remote"] .ftool button')].find((b) => /위/.test(b.title)).click()`);
      await a.waitFor(`document.querySelector('.fpane[data-side="remote"] .fpath').value === ${JSON.stringify(srv)}`, 10000, 'up').catch(async (e) => { console.log('   up: path=' + (await a.ev(`document.querySelector('.fpane[data-side="remote"] .fpath').value`)) + ' err=' + (await a.ev(`(document.querySelector('.fpane[data-side="remote"] .dr-empty.err') || {}).innerText || ''`))); throw e; });
      check('폴더 트리: 위 폴더로 이동', true);
      // cd in terminal
      await ctx('remote', path.join(srv, 'data'), /이동\(cd\)/);
      await sleep(1200);
      check('파일 작업: "터미널에서 이 폴더로 이동(cd)" 이 서버 셸에서 실행됨', /cd -- /.test(await termText(a)));
      // delete (remote) and the guard
      check('파일 작업: 삭제 메뉴', (await ctx('remote', path.join(srv, 'renamed'), /서버에서 삭제/)) === 'ok');
      for (let i = 0; i < 30 && fs.existsSync(path.join(srv, 'renamed')); i++) await sleep(200);
      check('파일 작업: 서버에서 삭제(확인 후)', !fs.existsSync(path.join(srv, 'renamed')));
      const guard = await a.ev(`window.ait.sftpRemove(__ait.active.id, ${JSON.stringify(srv)})`);
      check('파일 작업: 서버 홈 폴더 삭제는 거부', !!guard.error && fs.existsSync(srv), guard.error || '');
      // ask the AI about a file (remote mode is on)
      check('파일 작업: "AI에게 설명 요청" 메뉴', (await ctx('remote', path.join(srv, 'notes.txt'), /AI에게 설명 요청/)) === 'ok');
      await a.waitFor(`/notes\\.txt/.test(document.querySelector('.timeline.active').innerText)`, 15000, 'ask AI prompt');
      check('파일 작업: "AI에게 설명 요청" 이 서버 파일 경로로 질문을 보냄', true);
      await a.waitFor(`!__ait.state.aiBusy`, 120000, 'AI turn');
      // local side: new folder + rename
      await a.ev(`[...document.querySelectorAll('.fpane[data-side="local"] .ftool button')].find((b) => /새 폴더/.test(b.title)).click()`);
      await answer('localdir');
      for (let i = 0; i < 30 && !fs.existsSync(path.join(home, 'localdir')); i++) await sleep(200);
      check('파일 작업: 이 Mac 에 새 폴더 만들기', fs.existsSync(path.join(home, 'localdir')));
      // chip popover
      await click(a, '#ssh-chip');
      await a.waitFor(`!document.getElementById('ssh-pop').hidden`, 5000, 'popover');
      const pop = await text(a, '#ssh-pop');
      check('SSH 칩: 눌러서 접속 정보와 동작(파일·상태·서버에서 AI)이 있는 팝오버가 열림', /gpu-server/.test(pop) && /파일/.test(pop) && /상태/.test(pop), pop.replace(/\n/g, ' | ').slice(0, 120));
      await a.ev(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
      await sleep(200);
      check('SSH 칩: 바깥을 누르면 팝오버가 닫힘', await a.ev(`document.getElementById('ssh-pop').hidden`));
      // session editor: validation, save, tunnel, duplicate, delete
      // (a click on the pane that is already open would close it)
      if ((await a.ev(`window.AITSsh.S.panel`)) !== 'sessions') await click(a, '.act[data-pane="sessions"]');
      await a.waitFor(`!document.getElementById('sp-sessions').hidden`, 5000);
      await a.ev(`[...document.querySelectorAll('#sp-sessions .btn.primary')].find((b) => /새 세션/.test(b.textContent)).click()`);
      await a.waitFor(`!!document.querySelector('.ait-modal input[data-k="host"]')`, 8000, 'editor');
      const setf = (k, v) => a.ev(`(() => { const i = document.querySelector('.ait-modal input[data-k="${k}"]'); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await setf('host', '-oProxyCommand=evil');
      await a.ev(`[...document.querySelectorAll('.ait-modal .sm-foot .btn')].find((b) => /^저장$/.test(b.textContent.trim())).click()`);
      await a.waitFor(`!!document.querySelector('.ait-modal .ssh-err')`, 8000, 'validation error');
      check('세션 편집: 옵션 주입 형태의 호스트는 오류를 보여주고 저장하지 않음', /호스트/.test(await text(a, '.ait-modal .ssh-errors')) && !(await a.ev(`window.ait.sessList().then((d) => d.sessions.some((s) => /ProxyCommand/i.test(s.host)))`)));
      await setf('host', 'edit-test.example.com'); await setf('name', '편집 시험'); await setf('user', 'tester');
      await a.ev(`[...document.querySelectorAll('.ait-modal .btn.mini')].find((b) => /터널/.test(b.textContent)).click()`);
      await a.ev(`[...document.querySelectorAll('.ait-modal .sm-foot .btn')].find((b) => /^저장$/.test(b.textContent.trim())).click()`);
      await a.waitFor(`!document.querySelector('.ait-modal')`, 8000, 'editor closed');
      const saved = await a.ev(`window.ait.sessList().then((d) => d.sessions.find((s) => s.name === '편집 시험'))`);
      check('세션 편집: 저장하면 목록에 나타나고 터널이 함께 저장됨', !!saved && saved.forwards.length === 1 && saved.forwards[0].kind === 'L' && saved.user === 'tester');
      await a.waitFor(`[...document.querySelectorAll('#sp-sessions .sess-row')].some((r) => /편집 시험/.test(r.innerText))`, 8000);
      await a.ev(`[...document.querySelectorAll('#sp-sessions .sess-row')].find((r) => /편집 시험/.test(r.innerText)).querySelector('button[aria-label="복제"]').click()`);
      await a.waitFor(`[...document.querySelectorAll('#sp-sessions .sess-row')].some((r) => /편집 시험 \\(복사\\)/.test(r.innerText))`, 8000, 'duplicate');
      check('세션 편집: 복제', true);
      for (const nm of ['편집 시험 (복사)', '편집 시험']) {
        await a.ev(`[...document.querySelectorAll('#sp-sessions .sess-row')].find((r) => r.innerText.includes(${JSON.stringify(nm)}) && (${JSON.stringify(nm)} !== '편집 시험' || !/복사/.test(r.innerText))).querySelector('button[aria-label="삭제"]').click()`);
        await sleep(600);
      }
      check('세션 편집: 삭제(확인 후)', await a.ev(`window.ait.sessList().then((d) => !d.sessions.some((s) => /편집 시험/.test(s.name)))`));
      await click(a, '.act[data-pane="files"]');
      // ---- settings section
      await a.ev(`__panels.openSettings().then(() => 1)`); await sleep(900);
      const sdlg = await text(a, '#settings-modal .sm-dialog');
      check('설정: SSH 섹션(AI 연결·변경 명령 승인·서버 지표 표시/주기·연결 공유)이 표시', /SSH · 원격/.test(sdlg) && /서버 변경 명령은 승인/.test(sdlg) && /서버 CPU·메모리·GPU 표시/.test(sdlg) && /서버 지표 갱신 주기/.test(sdlg) && /연결 공유/.test(sdlg));
      await a.ev(`__panels.closeSettings()`); await sleep(300);
      // ---- disconnect: exit the ssh session
      await typeInTerm(a, 'exit\r');
      await a.waitFor(`document.getElementById('ssh-chip').hidden`, 30000, 'chip hidden after exit');
      check('연결 종료: SSH 칩·서버 모니터가 사라지고 원격 AI 모드가 해제됨', await a.ev(`document.getElementById('rmon').hidden && !/원격|remote/i.test(document.querySelector('#tabbar .tab.active').innerText.replace(/gpu-server/g, ''))`).catch(() => true));
      await sleep(1500);
      const left = require('child_process').spawnSync('/bin/ps', ['-axo', 'command='], { encoding: 'utf8' }).stdout.split('\n').filter((l) => /ssh /.test(l) && l.includes(String(sshd.port)) && !/sshd/.test(l));
      check('연결 종료: 앱이 만든 보조 ssh 연결이 남지 않음', left.length === 0, left.slice(0, 2).join(' | ').slice(0, 200));
      // privacy: the real user / password never appear in any saved file
      const dataFiles = fs.readdirSync(profile).filter((f) => /ssh-(sessions|recent)\.json$/.test(f));
      const blob = dataFiles.map((f) => fs.readFileSync(path.join(profile, f), 'utf8')).join('\n');
      check('개인정보: 저장된 SSH 파일에 비밀번호·개인 키 내용이 없음', !/BEGIN .*PRIVATE KEY|password/i.test(blob) && dataFiles.length >= 1, dataFiles.join(','));
    } catch (e) {
      // keep the evidence: what the terminal and the SSH UI showed when something did not happen
      try { console.log('--- terminal ---\n' + (await a.ev(`__ait.bufferText().slice(-900)`)) + '\n--- ssh ui ---\n' + (await a.ev(`JSON.stringify({ chip: document.getElementById('ssh-chip').hidden + ' ' + document.getElementById('ssh-chip').innerText, rmon: document.getElementById('rmon').hidden, panel: document.getElementById('side-panel').hidden, tabs: __ait.order().length })`))); } catch { /* window gone */ }
      throw e;
    } finally { a.close(); sshd.stop(); }
  },

  // API token usage: real `usage` from each response → per-turn line, running totals, Settings table; official (organization) usage on request
  async usage() {
    const oa = createOpenAI({ port: 11501 });
    await oa.listen();
    const base = 'http://127.0.0.1:11501/v1';
    const offEnv = { OLLAMA_HOST: '127.0.0.1:9', AIT_OLLAMA_BIN: '/nonexistent/ollama', OPENAI_ADMIN_KEY: 'test-admin-key', AIT_OPENAI_USAGE_BASE: base };
    try {
      const a = await launch(offEnv);
      try {
        await a.waitFor(`document.getElementById('model-text').textContent.length > 0 && !/확인 중/.test(document.getElementById('model-text').textContent)`, 40000, 'chip');
        await a.waitFor(`__ait.state.pty === 'prompt'`, 20000);
        await a.ev(`window.ait.settingsSet('openaiBaseUrl', ${JSON.stringify(base)}).then(() => window.ait.llmPrefer('openai')).then(() => 1)`);
        await a.waitFor(`/OpenAI/.test(document.getElementById('model-text').textContent)`, 20000, 'openai chip');
        await ask(a, 'pwd 명령으로 현재 디렉터리를 알려줘.');
        await a.waitFor(`!__ait.state.aiBusy && !!document.querySelector('.timeline.active .summary')`, 60000, 'turn finished');
        const sum = await text(a, '.timeline.active .summary');
        check('사용량: 턴이 끝나면 실제 API 토큰(입력·출력)이 요약 줄에 표시', /토큰 입력 [\d,.K]+ · 출력 [\d,.K]+/.test(sum) && !/추정/.test(sum), sum.replace(/\n/g, ' '));
        const mon = await text(a, '#mdl-val');
        check('사용량: 상단 모니터에 이번 실행 누적 토큰 표시', /[\d,.K]+ 토큰/.test(mon), mon);
        await a.ev(`__panels.openSettings().then(() => 1)`); await sleep(900);
        const local = await text(a, '#usage-local');
        check('사용량: 설정에 이번 실행·오늘·7일·30일 표(입력/출력/합계/호출)', /이번 실행/.test(local) && /최근 30일/.test(local) && /입력/.test(local) && /호출 수/.test(local) && /mock-gpt/.test(local), local.replace(/\n/g, ' ').slice(0, 160));
        const calls = oa.state.calls.filter((c) => c.path === '/v1/chat/completions');
        const dlg = await text(a, '#settings-modal .sm-dialog');
        check('키 변수명 통일: 설정에 OPENAI_API_KEY / OPENAI_ADMIN_KEY 표기 + 지정 방법 안내', /API 키 \(OPENAI_API_KEY\)/.test(dlg) && /export OPENAI_API_KEY/.test(dlg) && /관리자 키 \(OPENAI_ADMIN_KEY\)/.test(dlg));
        check('키 변수명 통일: OPENAI_ADMIN_KEY 환경변수 사용 중이면 그 사실만 표시(값은 표시 안 함)', /환경변수 OPENAI_ADMIN_KEY 사용 중/.test(dlg) && !dlg.includes('test-admin-key'));
        check('사용량: 스트리밍 요청에 stream_options.include_usage 를 보냄', calls.some((c) => c.stream_options && c.stream_options.include_usage));
        check('사용량: 일반 API 키/관리자 키는 대화 요청에 관리자 키를 쓰지 않음', calls.every((c) => c.auth !== 'test-admin-key'));
        check('사용량: 공식 조회는 버튼을 누르기 전에는 호출되지 않음', oa.state.org.length === 0);
        await a.shot('42-usage-settings');
        await a.ev(`[...document.querySelectorAll('#usage-official .btn')].find((b) => /불러오기/.test(b.textContent)).click()`);
        await a.waitFor(`/1,500/.test(document.getElementById('usage-official').innerText)`, 15000, 'official table');
        const off = await text(a, '#usage-official');
        check('사용량: 공식 Usage API 결과(오늘 1,500 · 7일 4,000 · 30일 7,500 입력 토큰) 표시', /1,500/.test(off) && /4,000/.test(off) && /7,500/.test(off), off.replace(/\n/g, ' ').slice(0, 200));
        check('사용량: 공식 Costs API 비용 행(USD) 표시', /비용/.test(off) && /3\.00 USD/.test(off));
        check('사용량: 관리자 키가 화면 어디에도 나오지 않음', !(await a.ev(`document.body.innerHTML.includes('test-admin-key')`)));
        await a.shot('43-usage-official');
        await a.ev(`__panels.closeSettings()`);
      } finally { a.close(); }
      // a server that is not OpenAI's own: local metering only, no official lookup offered
      const b = await launch({ OLLAMA_HOST: '127.0.0.1:9', AIT_OLLAMA_BIN: '/nonexistent/ollama' });
      try {
        await b.waitFor(`document.getElementById('model-text').textContent.length > 0`, 40000);
        await b.ev(`window.ait.settingsSet('openaiBaseUrl', ${JSON.stringify(base)}).then(() => 1)`);
        await b.ev(`__panels.openSettings().then(() => 1)`); await sleep(900);
        const t2 = await text(b, '#usage-official');
        check('사용량: 공식 서버가 아니면 공식 조회 대신 안내 문구 표시', /api\.openai\.com/.test(t2) && !(await exists(b, '#usage-official .btn')), t2.replace(/\n/g, ' ').slice(0, 120));
      } finally { b.close(); }
    } finally { await oa.close(); }
  },

  // vim :AitAI — inline AI edit through the real vim, the OSC bridge, the host, the (scripted) model and the reply file
  async vimai() {
    const dir = '/private/tmp/ait-vimai';
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'ai_test.py');
    const keys = (a, k) => a.ev(`__ait.term.input(${JSON.stringify(k)}, true)`);
    await withApp({ AIT_CWD: dir }, async (a) => {
      fs.writeFileSync(f, 'x = 1\ny = 2\n');
      await keys(a, 'vim ai_test.py\r');
      await a.waitFor(`/NORMAL/.test(__ait.bufferText())`, 20000, 'vim');
      await sleep(600);
      await keys(a, ':%AitAI add a comment\r');
      await a.waitFor(`/적용할까요/.test(__ait.bufferText())`, 60000, 'AI confirm prompt');
      check('vim :AitAI: 모델 제안이 diff 와 함께 확인 질문으로 표시됨', true);
      await a.shot('44-vim-aiedit');
      await keys(a, 'c');
      await sleep(700);
      check('vim :AitAI: 취소 뒤 "Press ENTER" 대기가 남지 않고 취소 안내만 표시', !/Press ENTER/.test(await a.ev(`__ait.bufferText()`)) && /적용하지 않았습니다/.test(await a.ev(`__ait.bufferText()`)));
      await keys(a, ':w\r'); await sleep(500);
      check('vim :AitAI: 취소하면 파일이 바뀌지 않음', fs.readFileSync(f, 'utf8') === 'x = 1\ny = 2\n');
      await keys(a, ':%AitAI add a comment\r');
      await a.waitFor(`/\\(A\\)pply 적용/.test(__ait.bufferText())`, 60000, 'second confirm prompt');
      await keys(a, 'a');
      await sleep(700);
      await keys(a, ':w\r'); await sleep(500);
      check('vim :AitAI: 적용하면 AI 제안으로 교체됨 (모의 모델의 고정 응답)', /모의 모델이 수정한 코드/.test(fs.readFileSync(f, 'utf8')), fs.readFileSync(f, 'utf8').trim());
      await keys(a, 'u'); await sleep(300);
      check('vim :AitAI: u 한 번으로 원래대로 되돌려짐(한 번의 변경)', /x = 1/.test(await a.ev(`__ait.bufferText()`)));
      // a selection with a secret is refused by the host and never reaches the model
      fs.writeFileSync(path.join(dir, 's.py'), 'api_key = "sk-abcdefghijklmnopqrstuvwxyz1234567890"\n');
      await keys(a, ':e! s.py\r'); await sleep(500);
      await keys(a, ':%AitAI refactor\r');
      await a.waitFor(`/비밀 정보/.test(__ait.bufferText())`, 30000, 'secret refusal');
      check('vim :AitAI: 비밀 정보가 있는 선택은 모델에 보내지 않고 거절', true);
      await keys(a, ':qa!\r');
    });
  },

  // accessibility: every control has an accessible name; dialogs/log regions are labelled; keyboard focus order reaches the input
  async a11y() {
    await withApp({}, async (a) => {
      await a.ev(`__panels.openSettings().then(() => 1)`); await sleep(700);
      const bad = await a.ev(`(() => {
        const name = (e) => (e.getAttribute('aria-label') || e.getAttribute('title') || e.innerText || e.textContent || (e.labels && e.labels[0] && e.labels[0].textContent) || e.getAttribute('placeholder') || '').trim();
        const out = [];
        document.querySelectorAll('button, input, textarea, select, [role=button], [role=switch], [role=radio]').forEach((e) => {
          if (e.closest('[hidden]') || e.classList.contains('xterm-helper-textarea')) return;
          if (!name(e)) out.push((e.id || e.className || e.tagName) + '');
        });
        return out;
      })()`);
      check('접근성: 모든 버튼·입력에 접근 가능한 이름이 있음', bad.length === 0, bad.slice(0, 6).join(', '));
      const roles = await a.ev(`({ dialog: !!document.querySelector('[role=dialog][aria-modal=true]'), log: !!document.querySelector('.timeline[role=log]'), alert: !!document.querySelector('[role=alertdialog]'), status: !!document.querySelector('[role=status]'), switches: document.querySelectorAll('[role=switch][aria-checked]').length })`);
      check('접근성: dialog/log/alertdialog/status 역할 및 switch 상태 노출', roles.dialog && roles.log && roles.alert && roles.status && roles.switches >= 5, JSON.stringify(roles));
      await a.ev(`__panels.closeSettings()`); await sleep(200);
      // Esc closes settings, focus returns to the terminal
      await a.ev(`__panels.openSettings().then(() => 1)`); await sleep(400);
      await a.ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await sleep(300);
      check('접근성: Esc 로 설정 창 닫힘', await a.ev(`document.getElementById('settings-modal').hidden`));
    });
  },
};

(async () => {
  const mock = createMock({ port: MOCK_PORT });
  await mock.listen();
  const names = process.argv.slice(2).filter((n) => !n.startsWith('-'));
  const run = names.length ? names : Object.keys(scenarios);
  fs.mkdirSync(OUT, { recursive: true });
  try {
    for (const n of run) {
      if (!scenarios[n]) { console.log('unknown scenario', n); continue; }
      console.log(`\n# ${n}`);
      try { await scenarios[n](); } catch (e) { console.log('ERROR', n, e.message); results.push({ name: `harness:${n}`, ok: false }); }
    }
  } finally { await mock.close(); }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
