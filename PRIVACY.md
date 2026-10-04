# Privacy

AI Terminal runs on your Mac. There is **no account, no telemetry, no analytics and no crash reporting**. This page lists exactly what is stored, what can leave the machine, and when.

## What is stored (all local, in `~/Library/Application Support/AI Terminal/`)

| File / folder | Content | Notes |
|---|---|---|
| `settings.json` | your settings | no secrets |
| `secrets.json` | API keys you saved in Settings | encrypted with the macOS Keychain (Electron `safeStorage`); if encryption is unavailable the key is **not** saved |
| `history/*.jsonl` | session history: requests, AI messages, commands, outputs | secrets are masked before writing; can be switched off (Settings → "세션 기록 저장") and deleted per session; the newest 200 are kept |
| `audit/*.jsonl` | every command the AI ran or tried to run + approve/deny decisions | secrets masked; exportable (Settings) |
| `usage/*.jsonl` | **token counts only** per API call (provider, host, model, input/output/cached tokens) | never prompts, answers or keys |
| `project-rules.json` | "always allow" rules you chose to keep per project | stored here, never inside a repository |
| `tabs.json`, `llm-settings.json`, `kv-engine.json`, `theme` | open tabs / chosen model / the private engine's process id / light-dark | |
| `ssh-sessions.json` | the SSH sessions you saved in the side bar: name, folder, host, port, user name, the **path** of a key file, jump host, tunnels, X11 mode | **never a password, passphrase or key**; the file is private (mode 0600); every field is validated before it can reach a command line |
| `ssh-recent.json` | destinations (`user@host[:port]` or an `~/.ssh/config` name) of the last SSH sessions | names only; mode 0600 |

Delete everything: quit the app and remove that folder. Nothing is stored anywhere else (your shell history stays in your own `~/.zsh_history`).

## What can leave your Mac — and only when you choose it

| Feature | What is sent | To whom | When |
|---|---|---|---|
| **Local model (default)** | prompts and command output | `127.0.0.1` (your own Ollama) | every request — never leaves the machine |
| **OpenAI-compatible server** (LM Studio, gateway, OpenAI API) | the conversation context and your API key | the server you entered in Settings | only after you pick it in the model chip; remote servers are never selected automatically and the UI warns that the context is sent off-device |
| **Codex CLI** | the conversation context | OpenAI via the `codex` tool | only after you pick it; its login is handled by `codex`, not by this app |
| **Official usage lookup** | your *admin* key and a date range | `api.openai.com` (organization Usage / Costs endpoints) | only when you press "공식 사용량 불러오기" |
| **Update check** | nothing but the request itself | `api.github.com` (releases of this repository) | off by default; when you press "지금 확인" or turn it on |
| **Model download** | the model name | your Ollama → its registry | only when you press a download button; the app never downloads on its own |
| **Opening links** | — | `ollama.com`, `github.com`, `platform.openai.com` pages | only on click (other addresses are refused) |

## SSH (servers you connect to)

- The app **never asks for, receives or stores an SSH password or key passphrase**. You type it in the terminal, exactly as with plain `ssh`. Saved sessions hold *where* to connect, never *how to authenticate* beyond the path of a key file you chose (the key itself is never read by the app).
- The server monitor and the file panel use a **separate, non-interactive** `ssh` connection (`BatchMode=yes`: it can never prompt, so it works with key login or with the shared connection of a session you opened from the side bar). When no such connection is possible they simply stay empty.
- The monitor runs one **read-only** script (it reads `/proc`, `vm_stat`, `df`, `nvidia-smi` …) and parses the numbers; nothing is written on the server. The file panel only does what you click or drag.
- With the AI on a server, commands and file tools run on that server **through the terminal you can see** (or through the same connection, after it proved to reach the same account). Their output goes to your configured model like any other command output — with a cloud model that means server output leaves your Mac, just as it would for local commands; secrets are masked first. Changes on a server always ask for approval (Settings → SSH).
- Host-key warnings (changed key, refused connection …) are shown as notes in the timeline with the key fingerprint; the app never answers a host-key question for you.
- Everything the app writes during a transfer is verified with SHA-256 before it replaces anything; a cancelled transfer never leaves a half-written file under its final name. Files you drag out to the Finder are cached in a temporary folder that is removed when the app quits.

## API keys

- `OPENAI_API_KEY` / `OPENAI_ADMIN_KEY` are read from the environment — including from your login shell, because an app started from the Dock does not inherit `~/.zshrc` — and are held in the app's memory only.
- The environment `OPENAI_API_KEY` is sent to `api.openai.com` **only**; for any other server only a key you saved for it in Settings is used.
- Keys are never shown in the UI (it only shows the *source*: environment / Keychain), never logged, and masked if they ever appear in command output, history, audit or the text sent to the model.
- This app never enters credentials on your behalf and the AI cannot read key files (`~/.ssh`, `.env`, cloud credentials … are blocked and masked).

## What the AI can see

The AI sees the terminal state it needs for the request: the working directory listing, project files it opens, recent command output. **Outputs and file contents are treated as untrusted data** (a file cannot give the AI instructions), secrets are masked before anything is sent to a model, and risky actions need your approval (see "동작 원칙" in the README). With a local model none of this leaves the Mac.

## Contact / changes

If this behaviour ever changes it will be recorded in `CHANGELOG.md` before release.
