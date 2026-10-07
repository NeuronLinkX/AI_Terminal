# 유지보수 지도 (처음 보는 사람이 직접 고칠 수 있게)

MacAIterm의 코드가 얼마나 되는지, 앱이 켜지는 순서대로 어디를 따라가면 되는지, 무엇을 바꾸려면 어느 파일부터 열어야 하는지를 정리합니다.
줄 수는 빈 줄과 주석을 포함하며 2026-10-07 기준입니다.

## 1. 크기

| 영역 | 줄 | 파일 | 비고 |
|---|---:|---:|---|
| `src/main` (앱의 두뇌) | 7,285 | 37 | `llm/` 811줄, `kv/` 560줄 포함 |
| `src/renderer` (화면) | 5,107 | 8 | `i18n.js` 539줄은 로직이 아니라 한국어와 영어 문구표 |
| `src/preload.js` (다리) | 131 | 1 | 화면이 부를 수 있는 기능 목록 |
| `native/` (C++ 연구 도구) | 299 | 1 | 앱 번들에는 들어가지 않음 |
| **앱 본체 합계** | **12,822** | | |
| `test/` | 3,887 | 23 | |
| `scripts/` (시험, 촬영, 빌드 도구) | 5,210 | 34 | |
| `site/` (웹사이트) | 1,245 | 13 | |
| `docs/` 와 루트 문서 | 1,237 | | |

가장 큰 파일: `renderer/core.js` 1,473 / `main/agent.js` 721 / `main/main.js` 720 / `renderer/panels.js` 692 / `renderer/ssh.js` 642 / `main/pty-session.js` 487.
원격 화면(VNC) 기능은 앱 코드 620줄(`main/vnc.js` 178 + `renderer/vnc.js` 442), 시험과 도구 764줄, 가이드 164줄이고, 기존 9개 파일에 128줄을 더했습니다.

## 2. 무슨 기술로 되어 있나

| 부분 | 기술 |
|---|---|
| 앱 틀 | Electron 44.5.1 (Chromium 152과 Node가 들어 있음), macOS용 |
| 언어 | 순수 JavaScript. 프레임워크, 번들러, TypeScript 없음. 메인은 CommonJS, 화면은 `<script>` 순서 로딩 |
| 터미널 | `node-pty`(진짜 PTY 셸) + xterm.js 6(그리기, 검색, 링크) |
| AI 연결 | Ollama(로컬), OpenAI 호환 서버(LM Studio 등), Codex CLI. 모델 답은 JSON 스키마로 받음 |
| SSH | 이 Mac의 `/usr/bin/ssh`를 그대로 사용(SSH 라이브러리 없음), 연결 공유(ControlMaster) |
| 원격 화면 | noVNC 1.7(MPL-2.0), IPC와 `ssh -W`로 전달 |
| 저장 | Application Support 안의 JSON, JSON Lines. API 키는 Electron `safeStorage`(키체인) |
| 시험 | `node --test`, 실제 `sshd`, Chrome DevTools Protocol로 앱 창을 조종하는 e2e |
| 빌드 | electron-builder(DMG, zip, ad-hoc 서명, 공증 없음) |

## 3. 앱이 켜지는 순서대로 따라가기

1. **시작점**: `package.json`의 `"main": "src/main/main.js"`. `npm start`는 `electron .`입니다.
2. **`src/main/main.js`**
   - 맨 위: Dock에서 켠 앱은 PATH가 빈약해서 로그인 셸의 환경을 가져옵니다.
   - 50줄: 앱이 둘 켜지지 않게 잠금을 겁니다.
   - 351줄 `app.whenReady()`: 설정, 기록, 감사 로그, 호스트 목록, 모델 관리자 등을 만들고 → 242줄 `createWindow()` → 화면이 부를 수 있는 IPC 처리기(`ipcMain.handle`, `ipcMain.on`)를 모두 등록합니다.
   - 132줄 `createTab()`: 탭 하나는 **PTY 셸 + AI 에이전트 + SSH 감시자** 한 벌입니다.
3. **`src/preload.js`**: 화면이 쓸 수 있는 기능을 `window.ait.*`로 노출하는 유일한 다리입니다. 새 기능은 반드시 여기 한 줄이 필요합니다.
4. **`src/renderer/index.html`**: 뼈대와 스크립트 로딩 순서가 있습니다. `i18n.js`, `core.js`, `panels.js`, `ssh.js`, `files.js`, `vnc.js` 순서이고, 뒤 파일은 앞 파일이 만든 `window.AITCore`, `window.AITSsh`를 씁니다.
5. **`src/renderer/core.js`**: 1438줄 `boot`에서 설정을 받고 탭을 복원하거나 새로 만듭니다(283줄 `newTab()` → 메인의 `tab:new`).
6. **키 입력의 길**
   - 터미널에 직접 입력: xterm → `ait.ptyInput` → `pty:input` → `pty-session.js` → 셸. 출력은 `pty:data`로 돌아옵니다.
   - 아래 입력창: `core.js`의 `submit()`(1198줄) → `submitAi()`(1179줄) → `ait.aiSubmit` → `main/agent.js`의 `handle()`(182줄).
7. **AI 한 턴(`agent.js`)**: 맥락 모으기(`context.js`) → 모델 결정(`llm/`) → 위험 판정(`policy.js`의 `assessCommand`: 허용, 승인, 거부) → 승인 창 → 실제 실행(`pty-session.js`) → 결과를 보고 반복 → 답.
8. **SSH의 길**: `ssh.js`의 `SshWatcher`가 탭 셸의 하위 프로세스에서 `ssh`를 알아봅니다 → `ssh-tab.js`의 `SshTab`이 탭별로 묶음 → `sshlink.js`의 `SshLink`가 **비밀번호 없는 공유 경로**를 만듭니다. 이 경로 위에서 서버 모니터(`remotemon.js`), 파일 패널(`sftp.js`), 서버에서 일하는 AI(`agent-remote.js`), 원격 화면(`vnc.js`)이 돕니다.

## 4. 무엇을 바꾸려면 어디부터 여나

| 하고 싶은 일 | 먼저 열 파일 |
|---|---|
| 화면 문구 바꾸기 | `renderer/i18n.js` (`ko`와 `en` 둘 다), 확인은 `npm run i18n:check` |
| 색, 간격, 배치 | `renderer/style.css`, 뼈대는 `renderer/index.html` |
| 탭, 터미널, 입력창, AI 대화 표시 | `renderer/core.js` |
| 설정 창, 기록, 처음 실행 안내 | `renderer/panels.js`, 설정 항목 정의는 `main/settings.js` |
| AI가 일하는 순서 | `main/agent.js` |
| 어떤 명령을 막고 승인받을지 | `main/policy.js` (시험: `test/policy-server.test.js`, `test/core.test.js`) |
| 모델 종류와 연결 | `main/llm/` (`manager.js`가 고르고 `ollama.js`, `openai.js`, `codex.js`가 각각 연결) |
| 셸 실행과 출력, 프롬프트 감지 | `main/pty-session.js`, `main/shell-integration/`, `main/osc.js` |
| SSH 접속 인식과 오류 안내 | `main/ssh.js` |
| 저장한 세션, 최근 접속 | `main/sshsessions.js`, `main/ssh.js`의 `HostBook`, 화면은 `renderer/ssh.js` |
| 서버 모니터, 파일 패널 | `main/remotemon.js`, `main/sftp.js`, 화면은 `renderer/ssh.js`, `renderer/files.js` |
| 원격 화면(VNC) | `docs/VNC_CODE_GUIDE.md`, `main/vnc.js`, `renderer/vnc.js` |
| 새 기능을 화면에서 부르기 | `main/main.js`(처리기) + `preload.js`(노출) + `renderer/*.js`(호출) 세 곳 |
| 업데이트 확인, 이름 변경 이전 | `main/updater.js`, `main/legacy.js` |

## 5. 고칠 때 지킬 것

- 화면 문구의 원문은 한국어이고 영어 번역을 함께 넣습니다. 앱 화면과 사이트 문구에는 em dash(—)를 쓰지 않습니다.
- 사용자가 입력한 값이 명령줄에 들어가는 곳은 문자 규칙으로 엄격히 검사합니다(`sshsessions.js`, `vnc.js`의 `validateTarget` 참고). 새 입력도 같게 하세요.
- 비밀번호, 키, 호스트 이름을 파일, 로그, 스크린샷에 남기지 않습니다. 앱은 비밀번호를 저장하지 않습니다.
- 바꾼 뒤: `npm test`, `npm run i18n:check`. 화면을 건드렸으면 `node scripts/e2e-features.js <시나리오>` 또는 `node scripts/e2e-vnc.js`.
- 시험과 촬영은 `AIT_*` 환경변수(예: `AIT_NO_KEYCHAIN=1`, `AIT_SSH_DIR`, `AIT_LANG`)로 실제 설정을 건드리지 않게 합니다.

## 6. 빌드와 설치

- 앱만 빌드: `./node_modules/.bin/electron-builder --mac dir --arm64 --config.directories.output=/private/tmp/ait-build`. 배포용 DMG까지 만들려면 `npm run dist`입니다.
- 설치: 만들어진 `MacAIterm.app`을 `/Applications`에 `ditto`로 복사하고 `xattr -cr`을 실행합니다. **바탕화면 아래 폴더에서 바로 실행하면 시작되지 않습니다.** 새로 빌드한 앱은 처음 실행할 때 키체인 비밀번호를 묻습니다.
- 앱이 실행 중일 때 같은 위치에 덮어쓰지 마세요. 먼저 종료합니다.
- 웹사이트 체크섬은 실제로 배포한 DMG와 같아야 합니다. DMG를 다시 올리지 않을 때는 `npm run site`를 실행하지 마세요.

## 7. 처음 읽는 순서 (약 1시간)

1. `package.json` → `main.js`의 `createTab`(132줄)과 `whenReady`(351줄)
2. `preload.js` 전체 (화면이 할 수 있는 일의 목록)
3. `renderer/index.html` → `core.js`의 `boot`(1438줄), `newTab`(283줄), `submit`(1198줄)
4. `pty-session.js` 위쪽 주석과 `agent.js`의 `handle`(182줄), `policy.js`의 `assessCommand`
5. 필요한 기능 하나를 골라 4번 표의 파일로 내려가기
