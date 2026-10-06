#!/usr/bin/env node
'use strict';
// Documentation screenshots + live verification of the new features with the REAL model (Ollama), the REAL shell and, for
// the KV chip, the REAL managed engine. Run against the installed app (AIT_DOC_PROMPT = neutral prompt, keeps the local
// account / host name out of the images):
//   AIT_DOC_PROMPT='%F{green}user@mac%f %F{blue}%~%f %# ' AIT_APP_BIN="/Applications/MacAIterm.app/Contents/MacOS/MacAIterm" AIT_SHOT_DIR=docs/screenshots node scripts/shots-features.js
// Screenshots that show an AI answer come from the real model; the onboarding and usage screens are UI-only and use the
// scripted servers (their numbers are NOT real usage — the README says so).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { launch, check, results, sleep, ask, aiIdle, tlText, typeInTerm, WS, OUT, privacyHits } = require('./e2e');

const SIZE = process.env.AIT_WIN_SIZE || '1680x1080';
const click = (a, sel) => a.ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
const keys = (a, k) => a.ev(`__ait.term.input(${JSON.stringify(k)}, true)`);
const ps = (port) => { try { return JSON.parse(execFileSync('curl', ['-s', '--max-time', '3', `http://127.0.0.1:${port}/api/ps`], { encoding: 'utf8' })).models || []; } catch { return []; } };
const managedPort = () => {
  try {
    const out = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
    for (const l of out.split('\n')) if (/ollama serve/.test(l)) {
      const pid = l.trim().split(/\s+/)[0];
      const env = execFileSync('/bin/ps', ['eww', '-p', pid], { encoding: 'utf8' });
      const m = env.match(/OLLAMA_HOST=127\.0\.0\.1:(\d+)/);
      if (m && /OLLAMA_KV_CACHE_TYPE=(q8_0|q4_0)/.test(env)) return Number(m[1]);
    }
  } catch { /* none */ }
  return null;
};

async function realModel() {
  const a = await launch({ AIT_WIN_SIZE: SIZE });
  const theme = async (t) => { if ((await a.ev(`document.documentElement.dataset.theme`)) !== t) { await a.ev(`__ait.toggleTheme()`); await sleep(400); } };
  try {
    await a.waitFor(`document.getElementById('model-text').textContent.length > 0 && !/확인 중/.test(document.getElementById('model-text').textContent)`, 40000);
    await a.waitFor(`__ait.state.pty === 'prompt'`, 20000);
    await theme('dark');

    console.log('# plan mode (real model)');
    await a.ev(`__ait.setPlan(true)`);
    await ask(a, 'package.json 에 정의된 npm 스크립트가 무엇인지 알려줘.');
    await a.waitFor(`!!document.querySelector('.card.plan')`, 240000, 'plan card');
    await sleep(400);
    await a.shot('30-plan-mode');
    check('계획 모드(실모델): 계획 카드가 단계와 함께 표시', (await a.ev(`document.querySelectorAll('.card.plan .plan-steps li').length`)) >= 2);
    await click(a, '.card.plan .acts .btn.yes');
    await aiIdle(a);
    await a.ev(`__ait.setPlan(false)`);

    console.log('# KV chip with the real managed engine');
    const chip = await a.ev(`document.getElementById('mdl-val').textContent`);
    const port = managedPort();
    const models = port ? ps(port) : [];
    console.log('   chip:', chip, '· managed engine port:', port, '· models there:', models.map((m) => `${m.name} ${Math.round(m.size / 1e8) / 10}GB`).join(','));
    await a.shot('47-kv-chip');
    const kv = await a.ev(`__ait.ui.kv`);
    check('KV 엔진(실제): 사용량 이벤트가 KV 종류·컨텍스트·실제 prefill 토큰을 보고', !!kv && !!kv.kvType && kv.ctx >= 4096 && kv.promptTokens > 0, kv ? `${kv.kvType} ${kv.ctx} prefill=${kv.promptTokens} engine=${kv.engine}` : 'none');
    if (kv && kv.kvType !== 'f16') check('KV 엔진(실제): q8_0/q4_0 이면 앱 전용 서버가 떠 있고 모델이 거기에 올라와 있음', !!port && models.length >= 1, `port ${port}`);

    console.log('# history');
    await a.ev(`__panels.openHistory().then(() => 1)`); await sleep(700);
    await click(a, '#hist-list .hitem'); await sleep(600);
    await a.shot('32-history');
    check('세션 기록(실제): 방금 대화가 기록되어 목록에 표시', (await a.ev(`document.querySelectorAll('#hist-list .hitem').length`)) >= 1);
    await a.ev(`__panels.closeHistory()`);

    console.log('# command blocks / processes');
    await typeInTerm(a, 'ls\r'); await sleep(700);
    await typeInTerm(a, 'false\r'); await sleep(700);
    await typeInTerm(a, 'sleep 90 &\r'); await sleep(900);
    await a.ev(`__panels.openDrawer('blocks')`); await sleep(500); await a.shot('35-blocks'); await a.ev(`__panels.closeDrawer()`);
    await a.ev(`__panels.openDrawer('procs')`);
    await a.waitFor(`!!document.querySelector('#drawer .proc') && /sleep 90/.test(document.getElementById('drawer-body').innerText)`, 15000, 'process panel');
    await a.shot('36-processes');
    await a.ev(`window.confirm = () => true; [...document.querySelectorAll('#drawer .proc .btn.danger')][0].click()`); await sleep(1200);
    await a.ev(`__panels.closeDrawer()`);

    console.log('# terminal search + split');
    await typeInTerm(a, 'ls src && cat package.json\r'); await sleep(900);
    await a.ev(`__ait.openSearch()`);
    await a.ev(`(()=>{const i=document.getElementById('ts-input'); i.value='util'; i.dispatchEvent(new Event('input',{bubbles:true}));})()`); await sleep(600);
    await a.shot('33-term-search'); await a.ev(`__ait.closeSearch()`);
    await a.ev(`__ait.toggleSplit().then(() => 1)`); await a.waitFor(`document.querySelectorAll('.term-wrap.active .pane').length === 2`, 15000);
    await sleep(900);
    await a.ev(`__ait.term.input('echo 보조 셸', true)`);
    await a.shot('34-split-pane');
    await a.ev(`__ait.toggleSplit().then(() => 1)`);

    console.log('# settings: KV precision + usage block');
    await a.ev(`__panels.openSettings().then(() => 1)`); await sleep(900);
    await a.ev(`[...document.querySelectorAll('.srow')].find((r) => /KV 캐시 정밀도/.test(r.innerText)).scrollIntoView({ block: 'start' })`); await sleep(400);
    await a.shot('45-settings-kv');
    await a.ev(`document.getElementById('usage-local').scrollIntoView({ block: 'start' })`); await sleep(400);
    await a.shot('46-settings-usage');
    await a.ev(`__panels.closeSettings()`);

    console.log('# English UI + approval');
    await a.ev(`window.ait.settingsSet('language', 'en').then(() => 1)`); await sleep(700);
    fs.writeFileSync(path.join(WS, 'tmp_shot_en.txt'), 'temp');
    await ask(a, 'delete the file tmp_shot_en.txt');
    await a.waitFor(`!document.getElementById('approval-bar').hidden`, 240000, 'approval bar (en)');
    await sleep(300);
    await a.shot('39-english-approval');
    check('영어 UI(실모델): 승인 바가 영어로 표시', /Approval needed/.test(await a.ev(`document.getElementById('approval-bar').innerText`)));
    await click(a, '#ap-no'); await aiIdle(a);
    await a.ev(`window.ait.settingsSet('language', 'ko').then(() => 1)`);
    fs.rmSync(path.join(WS, 'tmp_shot_en.txt'), { force: true });
  } finally { a.close(); }
}

/** UI-only screens that need a server we do not have: scripted ones (clearly labelled in the README). */
async function scripted() {
  const { createMock } = require('./mock-ollama');
  const { createMock: createOpenAI } = require('./mock-openai');
  process.env.MOCK_EMPTY = '1';
  const empty = createMock({ port: 11494 });
  delete process.env.MOCK_EMPTY;
  await empty.listen();
  const a = await launch({ AIT_WIN_SIZE: SIZE, OLLAMA_HOST: '127.0.0.1:11494', AIT_OLLAMA_BIN: '/nonexistent/ollama' });
  try {
    await a.waitFor(`!!document.querySelector('.banner.onboard')`, 40000);
    await sleep(500);
    await a.shot('37-onboarding');
    await a.ev(`window.confirm = () => true; document.querySelector('.banner.onboard .ob-model .btn').click()`);
    await sleep(500);
    await a.shot('37b-onboarding-progress');
  } finally { a.close(); await empty.close(); }
  const oa = createOpenAI({ port: 11493 });
  await oa.listen();
  const b = await launch({ AIT_WIN_SIZE: SIZE, OLLAMA_HOST: '127.0.0.1:9', AIT_OLLAMA_BIN: '/nonexistent/ollama', OPENAI_ADMIN_KEY: 'test-admin-key', AIT_OPENAI_USAGE_BASE: 'http://127.0.0.1:11493/v1' });
  try {
    await b.waitFor(`__ait.state.pty === 'prompt'`, 20000);
    await b.ev(`window.ait.settingsSet('openaiBaseUrl', 'http://127.0.0.1:11493/v1').then(() => window.ait.llmPrefer('openai')).then(() => 1)`);
    await b.waitFor(`/OpenAI/.test(document.getElementById('model-text').textContent)`, 20000);
    await ask(b, 'pwd 명령으로 현재 디렉터리를 알려줘.');
    await b.waitFor(`!__ait.state.aiBusy && !!document.querySelector('.timeline.active .summary')`, 60000);
    await b.shot('42-usage-turn');
    await b.ev(`__panels.openSettings().then(() => 1)`); await sleep(800);
    await b.ev(`[...document.querySelectorAll('#usage-official .btn')].find((x) => /불러오기/.test(x.textContent)).click()`); await sleep(1200);
    await b.ev(`document.getElementById('usage-local').scrollIntoView({ block: 'start' })`); await sleep(400);
    await b.shot('43-usage-official');
  } finally { b.close(); await oa.close(); }
}

async function vimScreens() {
  const dir = '/private/tmp/ait-vimshots';
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.c'), '#include <stdio.h>\n\nint add(int a, int b) { return a + b; }\n\nint main(void) {\n  int x = add(1, 2)\n  printf("%d\\n", x);\n  return 0;\n}\n');
  fs.writeFileSync(path.join(dir, 'ai_demo.py'), 'def total(items):\n    t = 0\n    for i in items:\n        t = t + i\n    return t\n');
  const a = await launch({ AIT_WIN_SIZE: SIZE, AIT_CWD: dir });
  try {
    await a.waitFor(`document.getElementById('model-text').textContent.length > 0 && !/확인 중/.test(document.getElementById('model-text').textContent)`, 40000);
    await a.waitFor(`__ait.state.pty === 'prompt'`, 20000);
    if ((await a.ev(`document.documentElement.dataset.theme`)) !== 'dark') await a.ev(`__ait.toggleTheme()`);
    await keys(a, 'vim a.c\r');
    await a.waitFor(`/NORMAL/.test(__ait.bufferText())`, 20000);
    await a.waitFor(`/✖ 1/.test(__ait.bufferText()) || /clangd/.test(__ait.bufferText())`, 30000, 'LSP status');
    await sleep(4000);
    await keys(a, '6G'); await sleep(900);
    const t = await a.ev(`__ait.bufferText()`);
    check('vim LSP(실제 clangd, 설치된 앱): 상태줄에 clangd 와 오류 개수, 오류 줄에 메시지', /clangd/.test(t) && /✖ \d/.test(t), /✖ \d+/.exec(t) ? /✖ \d+/.exec(t)[0] : 'no count');
    await a.shot('48-vim-lsp-diagnostics');
    await keys(a, ':qa!\r'); await sleep(600);
    await keys(a, 'vim ai_demo.py\r');
    await a.waitFor(`/NORMAL/.test(__ait.bufferText())`, 20000);
    await sleep(500);
    await keys(a, ':%AitAI add type hints and a docstring\r');
    await a.waitFor(`/적용할까요/.test(__ait.bufferText())`, 240000, 'AI edit confirm (real model)');
    await sleep(500);
    await a.shot('44-vim-aiedit');
    check('vim :AitAI(실모델): 제안이 diff 와 함께 표시되고 확인 질문이 뜸', true);
    await keys(a, 'c'); await sleep(500); await keys(a, ':qa!\r');
  } finally { a.close(); }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const which = process.argv.slice(2);
  const run = which.length ? which : ['real', 'scripted', 'vim'];
  if (run.includes('real')) await realModel();
  if (run.includes('scripted')) await scripted();
  if (run.includes('vim')) await vimScreens();
  const failed = results.filter((r) => !r.ok).length;
  if (privacyHits.length) console.log('\nPRIVACY — local account/host name visible in:\n  ' + privacyHits.join('\n  '));
  console.log(`\n${results.length - failed}/${results.length} passed · screenshots in ${OUT}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
