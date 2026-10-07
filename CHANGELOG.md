# Changelog

## Unreleased

### Added
- **~/.ssh/config editor** in the session panel: a modal with a syntax check (`ssh -G`), line-numbered errors, backups (`config.bak-<time>`, newest 5) and a conflict check; the right-click menu of ~/.ssh/config hosts is no longer empty.
- **Remote screen (VNC)** inside the window: an SSH tab can show the server's VNC desktop (noVNC). The picture travels only inside the tab's SSH connection (`ssh -W`, no local port, no extra login); the VNC password is asked for once and never stored; the screen is never sent to the AI. A per-server "Open on connect" option shows the screen as soon as the SSH login works and waits for a VNC server that is still starting.
- **Tabs, split panes, session history** (search / export / delete), command blocks, process panel, terminal search (⌘F), clickable URLs and file paths.
- **Plan mode**, project search tool, test-command detection, project guidance files (`AGENTS.md`), per-project saved "always allow" rules (stored outside the repository).
- **Streaming answers** and approval choices (once / this session / this project / deny with feedback); permission modes (read-only, default, ask-all, trust).
- **More providers**: OpenAI-compatible servers (LM Studio, llama.cpp, OpenAI API) with Keychain-protected keys; `OPENAI_API_KEY` / `OPENAI_ADMIN_KEY` environment variables.
- **API token usage**: real `usage` from every response, local daily/7/30-day totals, per-turn token line, and the official organization Usage / Costs lookup (admin key, on request).
- **KV-cache economy** (docs/KV_CACHE.md): exact KV memory model, KV-precision planner and managed engine (f16 / q8_0 / q4_0), sensitivity-based prompt compaction that keeps the prompt prefix stable (KV reuse), context right-sizing, C++ layer-attention profiler (`native/kvprof`).
- **bash / fish** shell integration, experimental remote (SSH / nested shell) mode, network-block mode, audit log export.
- First-run onboarding with model download progress, update check (manual), English UI, font / cursor / key-binding settings, accessibility (labels, focus, reduced motion).
- Tests: unit tests (`npm test`), feature e2e with scripted model servers (`npm run e2e:features`), i18n key coverage (`npm run i18n:check`).

- **SSH, MobaXterm-style** (docs/SSH.md): the app recognises an `ssh` session in a tab and offers to work on that server — commands, `read_file` / `edit_file` / `write_file` / `search` then apply to it (approval with the server's name, read-only checks run freely, per-server session rules, hash-guarded undo).
- **Server resource monitor**: CPU, memory, GPU (NVIDIA via `nvidia-smi`, Apple GPUs), disk, load and uptime of the server in a strip under the tabs, next to this Mac's own CPU / GPU / memory in the top bar; a status panel with history graphs and a side-by-side comparison.
- **Left side bar** with a **session manager** (saved sessions, folders, search, import from `~/.ssh/config`, key file, jump host, X11, port forwards, keep-alive, shared connection) and **file trees of the server and this Mac** with drag & drop copy both ways (files and folders, Finder → server, server → Finder), transfers with progress / cancel / SHA-256 verification, conflict dialog, rename / delete (guarded) / chmod / preview / ask the AI / `cd` in the terminal.
- This Mac's CPU utilisation in the top bar; the server's file engine uses plain `ssh` channels (no SFTP subsystem needed).

### Added (site)
- **Download website** (`site/`, bilingual, light / dark, no cookies or external requests): an overview page and a download page (.dmg / .zip, SHA-256, install and first-launch steps, requirements, FAQ, changelog); `npm run site` fills in version, sizes and checksums from `dist/`; a Pages workflow publishes it. Added the MIT `LICENSE` file.

### Changed
- **The app is now called MacAIterm** (was *AI Terminal*): app bundle `MacAIterm.app`, installers `MacAIterm-<version>-<arch>.dmg`, bundle id `com.neuronlinkx.macaiterm`. On the first start the old data folder (`~/Library/Application Support/AI Terminal`) is copied to `MacAIterm` (settings, tabs, history, audit, usage, project rules, saved SSH sessions; never moved or overwritten). API keys saved in Settings are not copied (the Keychain item is named after the app) and must be entered again. Project guidance files may now also be called `MACAITERM.md` / `.macaiterm.md` (the old names still work).
- Larger default window (1720×1060, never larger than the screen); the top bar now gives up labels and button captions step by step instead of cutting content off or overlapping when the window is narrow.

### Fixed
- SSH (found against a real Ubuntu server): bash 5's bracketed-paste reset left a stray carriage return in front of the output of commands typed through the terminal, which made the terminal route of the AI's remote file tools fail to read results.
- Saved project rules were not loaded when a tab opened or when moving between projects.
- `lsof` failures hid every listening port in the process panel when one child exited in between.
- History search only looked at one field of a record (the output of a command was never found).
- A "done" that was nudged for a better answer was displayed twice.
- The installed app would have lacked the search and link add-ons (packaging file list).
- Prompt compaction labelled an intact file read as "(이후 수정됨)" once the file had been edited; small local models took that as "still to be edited" and repeated finished edits until the failure limit. Only observations that were really cut are labelled now.
- The process drawer showed the previous list while the new one was loading.
- vim `:AitAI`: cancelling or applying left a "Press ENTER" prompt.
- OpenAI-compatible server: an address without `/v1` (404 on `/models`) now says exactly what to change; the "(?)" in the environment-key notice is gone.
- `scripts/headless.js` no longer crashes (settings were not passed to the providers).

### Also added
- `AIT_PROMPT` (zsh / bash): replaces the shell prompt, e.g. to keep the account and host name out of screen recordings.

### Known limits
- Not code-signed or notarized (Gatekeeper needs the right-click → Open step); updates are therefore check-only.
- Per-layer KV pruning (DepthKV and friends) needs engine support Ollama / llama.cpp do not have; see docs/KV_CACHE.md for what is real and what is measurement only.
- fish and Intel (x86_64) builds are not run. SSH: tested against a throw-away local `sshd` (key login) in unit, integration and window tests; a password-only server needs the shared connection of a session opened from the side bar for the monitor and file panel; X11 forwarding needs XQuartz; dragging a server file out to the Finder is best-effort (files up to 25 MB).

## 0.1.0
- First version: real PTY shell + natural-language agent with approval policy, Korean support, light/dark UI, DMG distribution.
