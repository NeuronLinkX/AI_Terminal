# 원격 화면(VNC) 코드 가이드

SSH 탭에서 서버의 VNC 화면을 앱 안에 띄우는 기능(`원격 화면`)을 만들고 고칠 때 따르는 설계 기준입니다.
기능 설명은 `docs/SSH.md`, 이 문서는 **코드를 어떻게 짜야 가볍고 안전하게 유지되는지**를 정리합니다.

## 1. 한 줄 요약

화면 데이터는 **로컬 포트를 열지 않고** 이미 열려 있는 SSH 연결 위로만 흐릅니다.
앱 안에서는 noVNC가 그림을 그리고, 키보드와 마우스는 같은 길로 서버에 돌아갑니다.

```
noVNC (렌더러)
  ⇄ IpcChannel        WebSocket 모양의 얇은 어댑터 (src/renderer/vnc.js)
  ⇄ preload           ipcRenderer 호출만 노출 (src/preload.js)
  ⇄ ipcMain           검증 후 전달 (src/main/main.js)
  ⇄ VncBridge         청크 합치기, 흐름 제어, 종료 처리 (src/main/vnc.js)
  ⇄ ssh -W 127.0.0.1:<포트>   탭의 SshLink 연결을 재사용 (src/main/sshlink.js)
  ⇄ sshd ⇄ 서버의 VNC 서버 (서버의 루프백)
```

만들지 않는 것: WebSocket 서버, 로컬 TCP 포트, websockify, 별도 프록시 프로세스, 비밀번호 저장.

## 2. 만들 파일과 책임

| 파일 | 책임 | 넣지 말 것 |
|---|---|---|
| `src/main/sshlink.js` | `SshLink.forward(host, port)`: `ssh -W` 자식 프로세스를 돌려준다. 연결 옵션은 기존 `connOptions` 그대로 | 화면 로직 |
| `src/main/vnc.js` | `validateTarget`, `VncBridge`(탭당 한 세션): 시작, 쓰기, 종료, 흐름 제어, 오류 분류 | Electron API 직접 호출(`send`는 주입) |
| `src/main/ssh-tab.js` | 탭의 `SshLink`와 `VncBridge`를 묶고, SSH가 끝나면 함께 닫는다 | 프로토콜 처리 |
| `src/main/main.js` | IPC 등록(`vnc:open`, `vnc:write`, `vnc:ack`, `vnc:close`)과 입력 검증 | 비즈니스 로직 |
| `src/preload.js` | 위 채널을 `ait.vncOpen` 등으로 노출 | 로직, 상태 |
| `src/renderer/vnc.js` | 보기 화면(툴바, 상태, 비밀번호 창), noVNC 지연 로딩, `IpcChannel` | 서버 주소 해석, 파일 읽기 |
| `src/renderer/style.css` | `.vnc-*` 스타일만 | 기존 규칙 수정 |
| `src/renderer/i18n.js` | `vnc.*` 문구(한국어 원문 + 영어) | 하드코딩된 문장 |
| `test/vnc.test.js`, `test/helpers/fake-vnc.js` | 단위, 실제 sshd 통합 시험, 가짜 RFB 서버 | 실제 서버 접속 |
| `scripts/e2e-vnc.js` | 실제 Electron 창에서 끝까지 확인 | 사용자 계정, 실제 호스트 |

## 3. 효율화 규칙

**R1. 필요할 때만 읽는다.** noVNC(약 700KB)는 `import()`로 처음 연결할 때만 불러옵니다.
시작 속도와 메모리는 이 기능이 없을 때와 같아야 합니다. 메인의 `vnc.js`도 처음 `vnc:open`에서 `require`합니다.

**R2. 복사 단계를 늘리지 않는다.** 서버에서 온 바이트는 `Buffer` 그대로 IPC로 보내고,
렌더러에서는 `Uint8Array` 한 번만 `ArrayBuffer`로 넘깁니다. 문자열 변환(base64, JSON)은 금지입니다.

**R3. 메시지를 합친다.** `ssh` 표준출력은 잘게 쪼개져 옵니다.
`VncBridge`는 4ms 안에 온 조각을 모아 한 번에 보내고, 64KiB가 차면 바로 보냅니다.
작은 조각이 자주 오는 화면 갱신에서 IPC 호출 수가 줄어듭니다(측정값은 9장). 큰 덩어리가 한꺼번에 올 때는 효과가 없고, 지연은 최대 4ms 늘어납니다.

**R4. 받는 쪽이 느리면 멈춘다(흐름 제어).** 렌더러가 처리한 양을 `vnc:ack`로 알립니다(64KiB마다).
아직 확인되지 않은 양이 1MiB를 넘으면 `child.stdout.pause()`, 256KiB 아래로 내려가면 `resume()`합니다.
숨겨진 탭이나 최소화된 창에서는 ack를 미루므로 메모리가 쌓이지 않습니다.

**R5. 화면은 noVNC에 맡긴다.** 변경된 영역만 그리는 일, 인코딩 해석(Tight, ZRLE, Hextile, JPEG)은 noVNC가 합니다.
직접 캔버스를 다시 그리거나 `requestAnimationFrame` 루프를 만들지 않습니다.
크기 맞춤은 noVNC의 `scaleViewport`에 맡기고, 우리 쪽 `ResizeObserver`는 80ms로 묶습니다.

**R6. 품질은 3단계 프리셋만 둔다.** 숫자 슬라이더를 만들지 않습니다.

| 프리셋 | qualityLevel | compressionLevel | 쓰임 |
|---|---|---|---|
| 빠르게 | 3 | 6 | 느린 회선 |
| 균형(기본) | 6 | 2 | 보통 |
| 선명하게 | 9 | 0 | 같은 네트워크 |

**R7. 끝나면 모두 정리한다.** 연결 종료, 탭 닫기, SSH 종료, 창 새로고침, 앱 종료에서
`rfb.disconnect()`, 이벤트 리스너 제거, DOM 제거, `ssh -W` 자식 `SIGTERM`이 모두 일어나야 합니다.
정리 함수는 하나(`closeView`, `VncBridge.close`)로 두고 여러 번 불려도 안전해야 합니다(멱등).

**R8. 세션 수를 제한한다.** 탭당 1개, 앱 전체 4개. 초과 요청은 `too-many`로 거절합니다.

**R9. 연결을 새로 만들지 않는다.** `SshLink`의 모드(`config`, `user`, `own`)를 그대로 따릅니다.
`-W`도 같은 공유 연결(ControlMaster)로 들어가므로 로그인과 키 확인이 다시 일어나지 않습니다.

**R10. 쓸모없는 압축은 하지 않는다.** VNC 인코딩이 이미 압축하므로 `ssh -C` 같은 옵션을 켜지 않습니다.

## 4. 보안 규칙

- 서버 쪽 목적지는 `host:port`로 검증합니다(`HOST_RE`, 포트 1 to 65535). `-`로 시작하는 값, 공백, 따옴표, 제어문자는 거절합니다.
  기본 호스트는 `127.0.0.1`입니다. 값은 인자 배열로만 넘기고 셸 문자열로 합치지 않습니다.
- 접속은 BatchMode입니다. 비밀번호를 묻는 새 로그인을 만들지 않습니다(키 로그인, 또는 사용자가 연 공유 연결만 사용).
- **VNC 비밀번호는 앱이 저장하지 않습니다.** noVNC가 `credentialsrequired`를 내면 비밀번호 창을 띄우고,
  입력값은 `rfb.sendCredentials` 호출 직후 지웁니다. 로그, 설정 파일, localStorage, AI 컨텍스트에 남기지 않습니다.
- 원격 화면은 AI에 보내지 않습니다. 화면 이미지를 모델 입력, 기록, 감사 로그에 넣는 코드를 만들지 않습니다.
- 원격 클립보드는 자동으로 Mac 클립보드를 덮어쓰지 않습니다. 사용자가 "복사"를 눌렀을 때만 씁니다.
- IPC 입력은 렌더러를 믿지 않고 `main.js`에서 다시 검증합니다(탭 ID, 포트, 쓰기 크기 1MiB 이하).
- 렌더러의 CSP(`default-src 'self'`)를 넓히지 않습니다. 네트워크는 렌더러에 없고 IPC만 있습니다.
- 오류 메시지에 호스트 이름, 계정, 키 경로를 넣지 않습니다. 렌더러에는 오류 **코드**만 보내고 문장은 `vnc.err.*` 번역에서 만듭니다.

## 5. 인터페이스 계약

**렌더러 → 메인** (모두 `ipcRenderer.invoke` 또는 `send`)

| 채널 | 인자 | 결과 |
|---|---|---|
| `vnc:open` | `{ id: 탭ID, host?: string, port: number }` | `{ ok: true, vid }` 또는 `{ ok: false, code }` |
| `vnc:write` | `{ id, vid, data: Uint8Array }` | 없음(`send`) |
| `vnc:ack` | `{ id, vid, bytes }` | 없음(`send`) |
| `vnc:close` | `{ id, vid }` | 없음(`send`) |
| `clipboard:read` | 없음 | Mac 클립보드 글자(최대 10만 자). "클립보드 보내기"를 눌렀을 때만 호출 |

**메인 → 렌더러** (`webContents.send`)

| 이벤트 | 내용 |
|---|---|
| `vnc:data` | `{ id, vid, data: Uint8Array }` |
| `vnc:end` | `{ id, vid, code }` |

**오류 코드**: `no-ssh`(탭에 SSH 세션 없음), `bad-target`, `too-many`, `refused`(서버에 그 포트의 VNC 서버 없음, 공유 연결에서는 포워딩 거부도 같은 문구로 옵니다),
`forbidden`(서버가 `AllowTcpForwarding`을 막음, 공유 연결이 아닐 때만 구분됨),
`auth`(키 로그인 불가), `timeout`(15초 안에 응답 없음), `not-vnc`(RFB 인사말이 아님), `closed`(정상 종료), `dropped`(연결 끊김), `failed`.

**창 안의 규칙**
- `IpcChannel`은 noVNC가 핸들러를 붙이기 전에 도착한 데이터를 대기열에 두었다가 순서대로 넘깁니다(noVNC는 연결을 비동기로 시작합니다).
- **자동 열기**는 서버별 체크박스(`localStorage`의 `ait.vnc.auto.<서버 이름>`)로 켭니다. 로그인이 끝났다는 신호로 그 탭의 첫 서버 지표(`ssh:metrics`)를 쓰고(모니터를 끈 경우에는 4초 대기), SSH 한 번에 한 번만 엽니다.
- 자동 열기는 `refused`(서버의 VNC가 아직 없음)일 때만 4초 간격으로 5번 다시 시도합니다. 로그인 실패(`auth`)는 다시 시도하지 않습니다. 비밀번호 서버에 실패한 로그인을 반복해 보내면 서버의 차단 도구(fail2ban 등)가 이 Mac의 주소를 막을 수 있기 때문입니다. `auth`가 나면 `SshLink.invalidate()`로 연결 방식을 다시 찾게 합니다.
- AI 채팅은 원격 화면과 연결되지 않습니다. 화면을 모델에 보내거나 AI가 마우스와 키를 보내는 코드는 만들지 않습니다. 이 사실은 화면 안의 안내(`vnc.aiNote`), `docs/SSH.md`, 웹사이트에 명시합니다.
- 탭이 닫히면 `core.js`가 `ait-tab-closed`를 보내고, SSH가 끝나면 `ssh:state`가 와서 보기 화면을 지웁니다.
- 확인용 훅: `window.AITVnc.loaded()`(noVNC를 불러왔는지), `window.AITVnc.views`(탭별 보기 화면). 시험 외에는 쓰지 않습니다.

## 6. 코드를 쓰는 방식 (이 저장소의 관례)

- 메인 파일은 `'use strict'`, CommonJS, 위쪽에 역할 주석 한 단락. 부수 효과는 주입(`spawnImpl`, `send`)으로 받아 시험에서 바꿉니다.
- 렌더러 파일은 기존 파일처럼 `(() => { const start = () => { … }; … })()` 안에서 `window.AITCore`, `window.AITSsh`를 사용합니다. 전역은 `window.AITVnc` 하나만 추가합니다.
- 화면 문구는 한국어가 원문입니다. `t('vnc.…')`와 `i18n.js`의 `ko`, `en` 양쪽에 같은 키를 추가합니다.
- 주석은 "왜"만 적습니다. 문장 끝의 줄바꿈 규칙과 em dash 금지는 문서와 화면 문구에 똑같이 적용합니다.
- 한 함수는 한 가지 일만 합니다. 40줄이 넘어가면 나눕니다. 상태는 `Map<탭ID, 세션>` 하나에 둡니다.

## 7. 시험과 완료 기준

1. **단위**(`test/vnc.test.js`): 목적지 검증(주입 시도 거절), `-W` 인자 구성, 청크 합치기, 흐름 제어 pause/resume,
   쓰기 크기 제한, 종료 코드 분류, 멱등 정리, 세션 수 제한. 가짜 `spawn`을 쓰므로 sshd가 필요 없습니다.
2. **실제 sshd**(같은 파일, sshd가 없으면 건너뜀): 임시 sshd(127.0.0.1, 임시 키) + 가짜 RFB 서버로
   `ssh -W` 경로 전체를 확인합니다. 서버가 보낸 바이트가 그대로 도착하고, 쓴 바이트가 서버에 그대로 도착해야 합니다.
3. **창 e2e**(`scripts/e2e-vnc.js`): 실제 앱 창에서 SSH 탭을 열고 원격 화면을 켜 가짜 서버의 그림이 캔버스에 나타나는지,
   포인터와 키 입력이 서버에 도달하는지, 끄면 `ssh -W` 프로세스가 사라지는지 확인합니다.
4. **회귀**: `npm test`, `npm run i18n:check`가 모두 통과해야 합니다.

완료 기준: 위 시험이 통과하고, 열려 있던 `ssh -W`와 임시 서버가 시험 뒤에 남아 있지 않으며,
기능을 쓰지 않을 때 시작 시간과 메모리가 달라지지 않습니다(R1).

## 8. 확인 결과 (2026-10-07, Apple M4, 이 Mac의 임시 sshd와 가짜 VNC 서버)

| 항목 | 결과 |
|---|---|
| `test/vnc.test.js` | 20개 통과 (가짜 `ssh` 15개, 실제 `ssh -W` 5개) |
| 전체 `npm test` | 172개 통과, 실패 0, 건너뜀 1(기존) |
| `scripts/e2e-vnc.js` | 33개 통과 (비밀번호 창, 접속하면 자동 열기, VNC 서버가 늦게 켜지는 경우 포함) |
| 지연 로딩(R1) | 시작 시 noVNC 미로딩, 첫 연결에서 로딩 (e2e로 확인) |
| 로컬 포트 | 연결 전후 이 Mac의 LISTEN 포트 수 동일 (e2e로 확인) |
| 정리(R7) | 연결 끊기, SSH 종료 뒤 `ssh -W` 프로세스 0개 (e2e로 확인) |
| 흐름 제어(R4) | 확인(ack)이 없으면 12MiB 중 임계값(시험에서 512KiB)에 1.5MiB를 더한 양 미만에서 읽기가 멈춰 그대로 유지되고, 확인하면 12MiB 전부 도착 |
| 메시지 합치기(R3) | 700바이트 조각이 자주 오는 8MiB 스트림에서 IPC 메시지 4566회가 839회로 줄어듦(약 5.4배). 64KiB 이상 덩어리가 오는 스트림에서는 차이 없음 |
| 처리량 | 이 Mac의 루프백 `ssh -W`에서 64MiB를 약 0.13초에 전달(수백 MiB/s). 병목은 브리지가 아니라 서버와 회선 |

메시지 합치기가 CPU를 줄인다는 증거는 얻지 못했습니다(측정 프로그램이 서버까지 같은 프로세스에서 돌아 CPU 값을 가를 수 없음).
실제 서버, 실제 회선(지연, 대역폭), 실제 VNC 서버(TigerVNC, x11vnc)에서의 화면 품질은 확인하지 못했습니다.

## 9. 알려진 한계

- 실제 VNC 서버(TigerVNC, x11vnc 등)와의 호환은 noVNC가 처리하며, 이 저장소의 시험은 가짜 서버로만 확인합니다. 실제 서버는 사용자가 한 번 확인해야 합니다.
- 서버에 VNC 서버가 켜져 있어야 합니다. 이 기능은 서버에 아무것도 설치하거나 실행하지 않습니다.
- 소리, 파일 전송, 여러 모니터 선택은 지원하지 않습니다.
- Cmd 키 조합은 앱 메뉴가 먼저 받으므로 원격으로 전달되지 않을 수 있습니다.
- 화면은 앱 밖(다른 창)으로 분리할 수 없습니다.
