# Third-party notices

MacAIterm is built on the open-source components below. The list is generated from the production dependencies installed in `node_modules` (`node scripts/notices.js`); each component remains under its own license.

## Bundled in the app

| Component | Version | License | Source |
|---|---|---|---|
| @novnc/novnc | 1.7.0 | MPL-2.0 | https://github.com/novnc/noVNC |
| @xterm/addon-fit | 0.11.0 | MIT | https://github.com/xtermjs/xterm.js/tree/master/addons/addon-fit |
| @xterm/addon-search | 0.16.0 | MIT | https://github.com/xtermjs/xterm.js/tree/master/addons/addon-search |
| @xterm/addon-web-links | 0.12.0 | MIT | https://github.com/xtermjs/xterm.js/tree/master/addons/addon-web-links |
| @xterm/xterm | 6.0.0 | MIT | https://github.com/xtermjs/xterm.js |
| node-addon-api | 7.1.1 | MIT | https://github.com/nodejs/node-addon-api |
| node-pty | 1.1.0 | MIT | https://github.com/microsoft/node-pty |

**Electron** (Chromium + Node.js) is the runtime of the app. Its own license texts ship inside the app bundle (`LICENSE` and `LICENSES.chromium.html` in `MacAIterm.app/Contents/Resources` / the Electron framework folder).

## Used but NOT bundled (installed separately by the user)

| Component | How the app uses it | License |
|---|---|---|
| [Ollama](https://github.com/ollama/ollama) | local model server the app talks to over HTTP (127.0.0.1) | MIT |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) | the inference engine inside Ollama; `native/kvprof` (a research tool, not shipped in the app) links libllama | MIT |
| Language models (e.g. Qwen3) | downloaded by the user with `ollama pull`; never redistributed by this project | per model (Qwen3: Apache-2.0) |
| Vim | the system `vim` is started with the app's configuration; no Vim code is shipped | Vim license |

## Research the design is based on

Algorithms in `src/main/kv/` and `native/` are independent implementations of ideas from published papers (see `docs/KV_CACHE.md` for the list and links); no source code from those projects is included.
