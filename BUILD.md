# Building and Packaging ScrollCollector

This document explains how to compile the binary executables and package the browser extension for friends & family distribution or official releases.

---

## 🛠️ Prerequisites

To build ScrollCollector, you need:
1. **Go Compiler (1.20+)**: Installed on your system.
2. **Zip Utility**: Command-line utility to package the extension files.

---

## 📦 Automated Build Script

We provide a shell script, `build-installer.sh`, that automates the entire process of zipping the extension assets, cross-compiling the Windows companion app, and packaging the standalone Windows installer.

To run the automated build script (e.g. from WSL or a Linux/macOS bash terminal):
```bash
./build-installer.sh
```

Upon success, this produces:
* `dist/ScrollCollectorInstaller.exe` (Windows standalone setup wizard containing the extension files).

---

## ⚙️ Manual Compilation Steps

If you want to compile individual components manually, follow these instructions:

### 1. Package the Extension
Compress the Chrome extension assets into a ZIP file. This zip is embedded directly into the installer installer payload.
```bash
zip -r installer/ScrollCollector.zip \
  icons/ \
  lib/ \
  offscreen/ \
  manifest.json \
  background.js \
  content.js \
  sidepanel.css \
  sidepanel.html \
  sidepanel.js \
  install-guide.html \
  README.md \
  -x "*.DS_Store"
```

### 2. Compile the Windows Installer Wizard
The installer contains the embedded web view (`go-webview2`) that guides the user through the Chrome extension drag-and-drop.
```bash
GOOS=windows GOARCH=amd64 go build \
  -ldflags "-H=windowsgui" \
  -o dist/ScrollCollectorInstaller.exe \
  ./installer
```

### 3. Compile the macOS Installer (Mac Only)
```bash
GOOS=darwin GOARCH=amd64 go build \
  -o dist/ScrollCollectorInstaller \
  ./installer
```

---

## 🚀 Creating a Distribution Release

To create a clean zip file ready to share with friends and family:
1. Compile the latest Windows installer using `./build-installer.sh`.
2. Zip the executable into a release bundle:
   ```bash
   zip -j dist/ScrollCollector-Setup.zip dist/ScrollCollectorInstaller.exe
   ```
3. Share the `ScrollCollector-Setup.zip` file with your target audience!

---

## 🧠 Where inference runs

Message routing between contexts is documented in `lib/messages.js`.

**Decisions run through one cascade.** `lib/bg/decision-runtime.js` composes
`lib/decision/cascade.js`: System 1 (local embeddings) answers every post; only posts it is
uncertain about go to ONE escalation provider (`none | nano | jev | openai`, default `nano`); the
rules tier (`lib/decision/providers/rules.js`) fills whatever no model answered. Ingest, the idle
retry and the re-decide pass (`lib/pipeline/redecide.js`) all call its `decideMany`. The engine
status (`ENGINE_STATUS`, the header badge), budgets, the decision cache and Diagnostics live there
too, and settings / API-key changes apply live (it watches `chrome.storage.onChanged`).

**Gemini Nano (the Prompt API) runs in the service worker.** `typeof LanguageModel === 'function'`
in the extension service worker (verified in Chrome for Testing 153 by `e2e/spike.spec.mjs`), so no
offscreen relay is needed for it. The browser's built-in `LanguageModel` is the **only** LLM the
extension uses: it never downloads a generative model (the former WebGPU/Qwen tier is retired).
`lib/decision/providers/nano.js` is the one Nano instance: it escalates uncertain posts and, through
`setSemanticGenerator()` in `lib/inference-engine.js`, backs the prompt tags, the prompt expansion
and the tag wand, which fall back to heuristics when Nano is not ready. Base sessions are cached per
system prompt (least recently used cache of 2) and cloned per call (`nano.resetSessions()` clears
them); do not go back to creating a session per item. The model download needs a user click: the
side panel's Download/Enable button calls `LanguageModel.create({ monitor })` and relays
`NANO_DOWNLOAD_STATE` to the service worker.

**System 1 runs in the offscreen document with bundled q8 weights.** A small sentence-embedding
model (`lib/decision/models.js`; the default is **MiniLM**, `Xenova/all-MiniLM-L6-v2`; `bge-small`
is selectable) is copied into `dist/ext/models/` by `npm run build:ext` (run `npm run fetch:models`
once), and Transformers.js plus the ONNX Runtime wasm are vendored into `dist/ext/lib/vendor/`.
Nothing is fetched at runtime and the CSP stays `script-src 'self' 'wasm-unsafe-eval'`.
`offscreen/system1-host.js` loads the model (progress pushed as `S1_STATUS`) and decides through
the shared scorer `lib/decision/system1-scorer.js`, caching embeddings in IndexedDB
(`offscreen/embedding-cache.js`). The service worker reaches it through `lib/offscreen-client.js`
and `lib/decision/providers/local-system1.js` (micro-batches of up to 16 posts or 25 ms, 30 s
decide timeout, 180 s while the model loads) and starts the load when it starts. The calibration
in `lib/decision/calibration/<model>.q8.json` comes from `node eval/run-eval.mjs --write-calibration`
and records the text normalizer (`lib/decision/state.js`) and prompt cleaner
(`lib/decision/questions.js`) it was fitted with: re-run it whenever either changes. The eval embeds
through onnxruntime-web (the same wasm the extension bundles) in Node, so its vectors match the
browser's exactly; `S1_EVAL_RUNTIME=node` selects onnxruntime-node instead.

**Cloud escalation is opt-in.** TypeSafe Jev and OpenAI are off by default
(`configuration.intelligence.providers.<id>.enabled: false`) and each has its own switch. You pick
one primary escalation provider (`none | nano | jev | openai`, default `nano`); there is no
chaining. Only posts System 1 is uncertain about escalate, within per-minute and per-day budgets,
and re-decides do not escalate unless allowed. API keys live under the top-level `secrets` key,
never in `configuration`; they are never broadcast, exported or logged, and only extension pages
can set them (`SET_SECRET` / `CLEAR_SECRET`).

**`chrome.storage.local` is restricted to trusted contexts** (`setAccessLevel` works), so content
scripts cannot read it: they get their settings through `GET_CONTENT_CONFIG` and
`CONTENT_CONFIG_UPDATED`.

If Chrome changes where the Prompt API is exposed, re-run `npx playwright test e2e/spike.spec.mjs`
(it prints the service-worker probe) before changing the routing.
