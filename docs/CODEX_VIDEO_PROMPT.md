# Prompt for Codex: produce the MacAIterm promo video

Copy everything below the line into Codex (working directory: `/Users/juhee/Desktop/workspace/AI_terminal`).

---

You are producing a short product video of the macOS app **MacAIterm** (an Electron terminal with a built-in AI agent). The recording is fully automated by one script that already exists. Your job is to run it, check the result, and fix small problems in the script if needed. Do not change anything else.

## What exists

- Script: `scripts/demo-show.js` (run with `npm run record`). It launches the real app in a throw-away profile, runs a scripted tour with the default local model (Ollama, qwen3:8b) and a real `ssh dgx` session, and records the app window by itself: visible mouse pointer with click ripples, smooth zoom, scene captions, an opening and an ending card. Output: an MP4 in `~/Movies/`.
- Helper: `scripts/ocr-check.swift` (privacy check, compiled automatically by the script).
- Docs: the "시연 영상 자동 실행" section of `README.md`.

## Goal

One English, light-theme video of about 2 minutes (1920x1200, H.264, no audio) that shows these scenes in order: the agent fixes a failing test, terminal search, plan mode, approval before a delete, session history, model and settings, split panes, saved SSH sessions, `ssh dgx` with server monitors and file trees, drag and drop with SHA-256 verification, server status, the agent working on the server, and an approval that names the server (denied).

## Run it

```bash
cd /Users/juhee/Desktop/workspace/AI_terminal
npm run record                 # English, light theme, promo look, about 120 s
```

Useful options: `--lang=ko`, `--theme=dark`, `--target=90` (length in seconds), `--short` (core scenes only), `--plain` (no pointer/zoom/captions), `--record-mode=real` (no time compression), `--fxtest` (30-second check of the effects only, no model and no server).

The run takes roughly 10 to 15 minutes because the local model works in real time. While it runs, an app window opens on this Mac and plays sounds. Do not touch it, do not minimise it, and keep the Mac awake and the screen unlocked (the script wraps itself in `caffeinate` only if you start it that way, so start it with `caffeinate -d -i npm run record`).

At the end the script prints a report. A good take has all of these:

- every line of the result list starts with a check mark, and no scene is reported as skipped;
- `OCR check of the video: no account / host name readable in N pictures`;
- a file name without the suffix `-CHECK-PRIVACY`;
- the line `server demo folder removed`.

The first scene repeats itself automatically (up to three times, the failed attempts are cut out of the video) when the small local model loops or gives up; the console prints `attempt N did not end clean` when that happens. Notes about this Mac's free memory are removed from the picture on purpose (they describe the machine, not the product).

If a scene is skipped or a check fails, run it again (a small local model sometimes repeats an action). If the same scene fails twice, read the error, fix the scene in `scripts/demo-show.js` with the smallest possible change, and run `npm run record -- --fxtest` first to check any change to the effects.

## Review the video before you report

1. `ffprobe` the MP4: 1920x1200, about 120 s, h264, no audio stream.
2. Extract one picture per second and look at them (a contact sheet is enough): the opening card must be the first picture, captions must be readable, the zoom must show the area that matters (chat, plan card, settings, file trees, transfers, server status), the pointer must be visible and must click the real buttons, and the ending card must be last.
3. Read the text in the pictures with the OCR helper for words that must not appear: the account and host names of this Mac and of the server, any IP address, and any Korean word in the English video. Build the pattern list yourself (do not print the private names in your report): `ssh -G dgx` gives the server's user and host name; `id -un` and `hostname -s` give this Mac's.

## Hard rules

- Never type, read, store or ask for a password. The server `dgx` is used with key login only (BatchMode). Never put credentials, keys, real host names, user names or IP addresses into any file, report or screenshot.
- Record only the app window with this script. Do not use screen recording of the whole screen: other windows and the menu bar are outside what the script protects.
- The script creates one throw-away folder `/tmp/macaiterm-demo-<random>` on the server and removes it at the end. If a run is interrupted, delete only that folder (`ssh dgx 'rm -rf /tmp/macaiterm-demo-<name>'`) after checking its exact name. Touch nothing else on the server.
- Do not run the app from `~/Desktop` (it cannot start its helpers there); the script copies the newest build from `dist/mac-arm64` to a temporary folder by itself. If `dist/mac-arm64/MacAIterm.app` is missing or old, run `npm run dist` first.
- Do not commit, push, publish, upload or send anything. Do not edit `site/`, `README.md` or the public repository. Do not run `npm run site`.
- Do not use Codex or any cloud model inside the recording: the demo must use the default local model.

## Report back

Give me: the full path of the MP4, its length and size, the report lines of the script (without private names), what you checked in the pictures, and anything that looks wrong or that you changed in `scripts/demo-show.js` (with the reason).
