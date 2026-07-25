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

The Prompt API is **document-scoped**. It is exposed as the `LanguageModel`
global, and its availability differs by execution context, so the extension does
not assume a single home for inference:

1. `lib/inference/router.js` walks providers in priority order —
   `browser-prompt` (Chrome Gemini Nano / Edge Phi-4-mini) → `webgpu` → `cloud`
   — falling back to the offline keyword engine when none is ready.
2. `lib/inference/providers/browser-prompt.js` probes for the `LanguageModel`
   global first, and only then the retired `chrome.aiOriginTrial` / `self.ai`
   namespaces.
3. When that global is **not** reachable from the MV3 service worker, the
   extension creates an offscreen document (`offscreen/offscreen.html` +
   `offscreen.js`) and relays inference through it. This is the standard MV3
   escape hatch for document-only APIs, and is why `manifest.json` declares the
   `offscreen` permission.

**This is the single fact the inference architecture depends on.** If Chrome
changes where the Prompt API is exposed, re-check it by evaluating
`typeof LanguageModel` and `await LanguageModel.availability()` in all three
contexts — service worker, side panel, and offscreen document — before changing
the routing.

Sessions are cached per system prompt and cloned per call, with `resetSessions()`
to clear them. Do not reintroduce a create-and-destroy-per-item pattern: session
construction dominates on-device latency and makes classification unusable at
scroll speed.
