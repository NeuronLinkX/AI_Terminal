#!/usr/bin/env node
'use strict';
// Documentation screenshots of the SSH features (README / docs/SSH.md), taken from the INSTALLED app:
//   AIT_DOC_PROMPT='%F{green}user@mac%f %F{blue}%~%f %# ' AIT_APP_BIN="/Applications/AI Terminal.app/Contents/MacOS/AI Terminal" \
//   AIT_SHOT_DIR=docs/screenshots node scripts/shots-ssh.js
// The "server" is a throw-away sshd on 127.0.0.1 (key login, generated keys) running as this account, with a made-up
// project tree in /private/tmp, so the shots show a realistic server without any real host, user or file. The AI answers in
// the last two shots come from the REAL local model (Ollama). Every capture is scanned for the local account / host name.
const fs = require('fs');
const path = require('path');
const { launch, check, results, sleep, ask, aiIdle, typeInTerm, OUT, privacyHits } = require('./e2e');
const { startSshd } = require('../test/helpers/sshd');

const SIZE = process.env.AIT_WIN_SIZE || '1680x1080';
const SRV = '/private/tmp/ait-demo-server';
const LOC = '/private/tmp/ait-demo-local';
const put = (f, c) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); };
const big = (f, mb) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const fd = fs.openSync(f, 'w'); fs.ftruncateSync(fd, mb * 1024 * 1024); fs.closeSync(fd); };
const click = (a, sel) => a.ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
const row = (side, p) => `(() => { const pane = document.querySelector('.fpane[data-side="${side}"]'); return pane && [...pane.querySelectorAll('.frow')].find((r) => r.dataset.path === ${JSON.stringify(p)}); })()`;
const caret = (a, side, p) => a.ev(`${row(side, p)}.querySelector('.fcaret').click()`);
const dnd = (a, from, fromPath, to, toPath) => a.ev(`(() => {
  const r = (s, p) => { const pane = document.querySelector('.fpane[data-side="' + s + '"]'); return [...pane.querySelectorAll('.frow')].find((x) => x.dataset.path === p); };
  const src = r(${JSON.stringify(from)}, ${JSON.stringify(fromPath)}); const dst = r(${JSON.stringify(to)}, ${JSON.stringify(toPath)});
  if (!src || !dst) return 'missing';
  const dt = new DataTransfer(); const fire = (el, t) => el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }));
  fire(src, 'dragstart'); fire(dst, 'dragenter'); fire(dst, 'dragover'); fire(dst, 'drop'); fire(src, 'dragend'); return 'ok';
})()`);

function seed() {
  fs.rmSync(SRV, { recursive: true, force: true });
  fs.rmSync(LOC, { recursive: true, force: true });
  const lines = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join('\n') + '\n';
  put(path.join(SRV, 'projects/api-server/main.py'), 'from fastapi import FastAPI\n\napp = FastAPI()\n\n\n@app.get("/health")\ndef health():\n    return {"ok": True}\n');
  put(path.join(SRV, 'projects/api-server/requirements.txt'), 'fastapi==0.115.0\nuvicorn==0.30.6\n');
  put(path.join(SRV, 'projects/api-server/config.yaml'), 'port: 8000\nworkers: 4\nlog_level: info\n');
  put(path.join(SRV, 'projects/trainer/train.py'), 'import torch\n\n\ndef main():\n    print("training...")\n\n\nif __name__ == "__main__":\n    main()\n');
  put(path.join(SRV, 'projects/trainer/configs/base.yaml'), 'epochs: 20\nlr: 0.0003\nbatch_size: 32\n');
  big(path.join(SRV, 'models/llama-7b-q4.gguf'), 48);
  big(path.join(SRV, 'models/embedder.bin'), 9);
  put(path.join(SRV, 'logs/app.log'), lines(400, (i) => `2026-10-0${1 + (i % 4)} 12:${String(i % 60).padStart(2, '0')}:00 INFO request id=${1000 + i} status=200`));
  put(path.join(SRV, 'logs/train.log'), lines(120, (i) => `step ${i * 50} loss=${(2.4 / (1 + i / 9)).toFixed(4)}`));
  put(path.join(SRV, 'logs/old-2026-09-12.log'), lines(50, (i) => `2026-09-12 08:00:${String(i).padStart(2, '0')} INFO archived`));
  fs.mkdirSync(path.join(SRV, 'backup'), { recursive: true });
  put(path.join(SRV, 'deploy.sh'), '#!/bin/sh\nset -e\ncd ~/projects/api-server\ngit pull\nsystemctl restart api-server\n');
  put(path.join(SRV, 'notes.txt'), '배포는 금요일 18:00\n');
  put(path.join(LOC, 'dataset.csv'), lines(200, (i) => `${i},${(i * 7) % 13},${(i * 11) % 17}`));
  put(path.join(LOC, 'deploy-notes.md'), '# 배포 메모\n\n- 금요일 18:00\n');
  put(path.join(LOC, 'config.yaml'), 'port: 8080\n');
  put(path.join(LOC, 'photos/team.txt'), 'team photo placeholder\n');
  put(path.join(LOC, 'photos/office.txt'), 'office photo placeholder\n');
  fs.mkdirSync(path.join(LOC, 'Downloads'), { recursive: true });
  fs.mkdirSync(path.join(LOC, 'Documents'), { recursive: true });
}

(async () => {
  seed();
  const sshd = await startSshd({ home: SRV, ps1: 'demo@gpu-server:~\\$ ' });
  if (!sshd) { console.log('sshd cannot run here'); process.exit(1); }
  put(path.join(LOC, '.ssh/config'), [
    'Host gpu-server', '  HostName 127.0.0.1', `  Port ${sshd.port}`, `  IdentityFile ${sshd.key}`, '  IdentitiesOnly yes',
    `  UserKnownHostsFile ${sshd.knownHosts}`, '  StrictHostKeyChecking yes', '',
  ].join('\n'));
  fs.chmodSync(path.join(LOC, '.ssh/config'), 0o600);
  const a = await launch({ AIT_WIN_SIZE: SIZE, AIT_CWD: LOC, AIT_SSH_DIR: path.join(LOC, '.ssh') });
  const theme = async (t) => { if ((await a.ev(`document.documentElement.dataset.theme`)) !== t) { await a.ev(`__ait.toggleTheme()`); await sleep(400); } };
  try {
    await a.waitFor(`document.getElementById('model-text').textContent.length > 0 && !/확인 중/.test(document.getElementById('model-text').textContent)`, 40000);
    await a.waitFor(`__ait.state.pty === 'prompt'`, 20000);
    await theme('dark');

    // ---- 60: session manager (saved sessions are examples with reserved example addresses; they are never connected)
    await a.ev(`(async () => {
      const s = (o) => window.ait.sessSave({ keepAlive: true, share: true, x11: 'off', forwards: [], ...o });
      await s({ name: 'build-box', folder: '회사', host: 'build.example.com', user: 'deploy', port: 22, jump: 'bastion@203.0.113.5' });
      await s({ name: 'db-staging', folder: '회사', host: '203.0.113.20', user: 'admin', port: 2222, forwards: [{ kind: 'L', listenPort: 5433, host: 'localhost', port: 5432 }] });
      await s({ name: 'home-nas', folder: '개인', host: 'nas.example.org', user: 'me', port: 22 });
    })()`);
    await click(a, '.act[data-pane="sessions"]');
    await a.waitFor(`document.querySelectorAll('#sp-sessions .sess-row').length >= 4`, 15000, 'session rows');
    await sleep(500);
    await a.shot('60-ssh-sessions');
    check('세션 관리자: 저장 세션 3개와 ~/.ssh/config 호스트가 표시', /build-box/.test(await a.ev(`document.getElementById('sp-sessions').innerText`)) && /gpu-server/.test(await a.ev(`document.getElementById('sp-sessions').innerText`)));

    // ---- connect
    await a.ev(`[...document.querySelectorAll('#sp-sessions .sess-row')].find((x) => /gpu-server/.test(x.innerText)).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await a.waitFor(`!document.getElementById('ssh-chip').hidden`, 40000, 'ssh chip');
    await a.waitFor(`document.querySelector('#rmon .rcpu') && !document.querySelector('#rmon .rcpu').hidden`, 40000, 'server monitor');
    await a.waitFor(`!document.getElementById('sp-files').hidden`, 20000, 'files panel');
    await a.waitFor(`!!${row('remote', SRV + '/notes.txt')} && !!${row('local', LOC + '/dataset.csv')}`, 25000, 'trees');
    // the typed ssh command line carries the test hook's -F option: clear the screen (xterm API only) and show a normal remote session
    await a.ev(`__ait.term.clear()`);
    await typeInTerm(a, 'ls\r');
    await sleep(900);
    await caret(a, 'remote', SRV + '/projects');
    await a.waitFor(`!!${row('remote', SRV + '/projects/api-server')}`, 15000);
    await caret(a, 'remote', SRV + '/projects/api-server');
    await a.waitFor(`!!${row('remote', SRV + '/projects/api-server/main.py')}`, 15000);
    await caret(a, 'local', LOC + '/photos');
    await a.ev(`${row('remote', SRV + '/projects/api-server/main.py')}.click()`);
    await sleep(2500); // let the monitor draw a few samples
    await a.shot('61-ssh-files');
    check('폴더 트리: 서버 트리와 이 Mac 트리가 동시에 표시', true);

    // ---- 62: drag & drop copies, both directions, verified
    const r1 = await dnd(a, 'local', LOC + '/dataset.csv', 'remote', SRV + '/projects/trainer');
    await sleep(1200);
    const r2 = await dnd(a, 'local', LOC + '/photos', 'remote', SRV + '/backup');
    await sleep(1200);
    await caret(a, 'remote', SRV + '/logs').catch(() => {});
    const r3 = await dnd(a, 'remote', SRV + '/notes.txt', 'local', LOC + '/Downloads');
    await sleep(2500);
    // show where the copies landed
    await caret(a, 'remote', SRV + '/projects/trainer').catch(() => {});
    await caret(a, 'remote', SRV + '/backup').catch(() => {});
    await caret(a, 'local', LOC + '/Downloads').catch(() => {});
    await sleep(1500);
    check('드래그 복사: 업로드(파일·폴더)·다운로드 처리', r1 === 'ok' && r2 === 'ok' && r3 === 'ok', [r1, r2, r3].join(','));
    check('드래그 복사: 결과 파일이 실제로 도착', fs.existsSync(path.join(SRV, 'projects/trainer/dataset.csv')) && fs.existsSync(path.join(SRV, 'backup/photos/team.txt')) && fs.existsSync(path.join(LOC, 'Downloads/notes.txt')));
    await a.shot('62-ssh-transfers');

    // ---- 63: server status panel
    await click(a, '.act[data-pane="status"]');
    await a.waitFor(`/CPU/.test(document.getElementById('sp-status').innerText)`, 15000);
    // real load on the "server" (this Mac) for a few seconds, so the graphs show something other than a flat line
    const burners = [1, 2, 3].map(() => require('child_process').spawn('/usr/bin/yes', [], { stdio: ['ignore', 'ignore', 'ignore'] }));
    await sleep(14000);
    burners.forEach((b) => b.kill('SIGKILL'));
    await sleep(6000);
    await a.shot('63-ssh-status');
    await click(a, '.act[data-pane="files"]');

    // ---- 64/65: the AI works on the server (real model)
    const yes = await a.ev(`!!document.querySelector('.timeline.active .note button.btn.primary')`);
    check('서버 AI: 접속 직후 제안 표시', yes);
    await a.ev(`document.querySelector('.timeline.active .note button.btn.primary').click()`);
    await a.waitFor(`/· AI/.test(document.getElementById('ssh-chip').innerText)`, 40000, 'remote on');
    await a.ev(`__ait.term.clear()`); // the probe that switches the AI over prints the server's account / host name: not for the images
    await sleep(400);
    await ask(a, '이 서버의 디스크 사용량을 df -h 로 확인하고, 가장 많이 쓰는 파티션을 한 줄로 알려줘.');
    await a.waitFor(`!__ait.state.aiBusy`, 300000, 'AI turn');
    await sleep(800);
    await a.shot('64-ssh-ai');
    check('서버 AI(실모델): 명령이 서버에서 실행되어 결과 카드 표시', /성공 · exit 0/.test(await a.ev(`document.querySelector('.timeline.active').innerText`)));
    const asks = ['서버의 logs 폴더에 있는 old-2026-09-12.log 파일을 rm 명령으로 삭제해줘.', 'rm logs/old-2026-09-12.log 명령을 실행해서 오래된 로그를 지워줘.'];
    for (const q of asks) { // a small local model sometimes answers without acting: ask more explicitly once
      await ask(a, q);
      await a.waitFor(`!document.getElementById('approval-bar').hidden || !__ait.state.aiBusy`, 300000, 'approval or end of turn');
      if (!(await a.ev(`document.getElementById('approval-bar').hidden`))) break;
    }
    await a.waitFor(`!document.getElementById('approval-bar').hidden`, 5000, 'approval');
    await sleep(500);
    await a.shot('65-ssh-approval');
    check('서버 AI(실모델): 서버를 바꾸는 명령은 서버 이름이 적힌 승인을 요청', !(await a.ev(`document.getElementById('ap-host').hidden`)) && /gpu-server/.test(await a.ev(`document.getElementById('ap-host').innerText`)));
    await a.ev(`document.getElementById('ap-no').click()`);
    await a.waitFor(`!__ait.state.aiBusy`, 120000, 'AI turn after deny');
    check('서버 AI: 거부하면 서버 파일이 그대로 있음', fs.existsSync(path.join(SRV, 'logs/old-2026-09-12.log')));

    // ---- 66: session editor
    await click(a, '.act[data-pane="sessions"]');
    await a.waitFor(`document.querySelector('#sp-sessions .btn.primary')`, 10000);
    await a.ev(`[...document.querySelectorAll('#sp-sessions .btn.primary')].find((b) => /새 세션/.test(b.textContent)).click()`);
    await a.waitFor(`!!document.querySelector('.ait-modal input[data-k="host"]')`, 10000, 'editor');
    await a.ev(`(() => { const set = (k, v) => { const i = document.querySelector('.ait-modal input[data-k="' + k + '"]'); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); };
      set('name', 'GPU 학습 서버'); set('folder', '회사'); set('host', 'gpu.example.com'); set('user', 'ubuntu'); set('port', '22'); set('jump', 'bastion@203.0.113.5:22'); set('startDir', '/srv/train'); })()`);
    await sleep(500);
    await a.shot('66-ssh-session-editor');
    await a.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(300);

    await typeInTerm(a, 'exit\r');
    await a.waitFor(`document.getElementById('ssh-chip').hidden`, 30000, 'disconnect');
  } catch (e) {
    console.log('ERROR', e.message);
    results.push({ name: `harness:${e.message}`, ok: false });
    try { await a.shot('99-ssh-error'); } catch { /* window gone */ }
  } finally {
    a.close();
    sshd.stop();
  }
  if (privacyHits.length) { console.log('\n!! 개인 정보가 보이는 화면:\n' + privacyHits.join('\n')); }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed · privacy hits: ${privacyHits.length}`);
  process.exit(failed || privacyHits.length ? 1 : 0);
})();
