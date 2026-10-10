# ScrollCollector 📜🤖

ScrollCollector is a privacy-first, zero-latency Chromium browser extension that extracts, redacts, and classifies text content in real time as you scroll through social feeds and web pages. It runs entirely on your local machine, utilizing your browser's built-in on-device AI (Gemini Nano) or a lightweight local keyword engine.

It is designed as a high-performance keyboard-driven curator to capture, filter, and compile web insights into interactive offline feed diaries.

---

## Key Features

- **On-Device AI, no model downloads**: Semantic classification uses the browser's built-in **Prompt API** (Chrome Gemini Nano / Edge Phi-4-mini) and falls back to the **Rule-based Classifier** (always available offline). The extension never downloads a generative model of its own.
- **Dynamic Tag Generation**: Automatically extracts and suggests new category tags (e.g. *Cooking*, *Space*, *Tesla*) for items that do not match existing tags.
- **Priority Routing**: Custom and default tags always take classification priority over dynamic tags.
- **Segmented Workspace**: A clean, modern tabbed interface (**Stream**, **Export**, **Settings**) replacing vertical collapsible widgets to optimize narrow side panels.
- **List Virtualization**: Built-in `IntersectionObserver`-based DOM windowing. Off-screen cards are cleared from the DOM and replaced with height-matched spacers to maintain smooth scrolling and ultra-low memory usage even with thousands of items.
- **Double Filtering System**:
  - **Category Tags Bar**: Horizontal scrollable pills showing category count badges. Enabled categories are **always visible** even with 0 counts.
  - **Websites Bar**: A second horizontal scrollable pills row to filter items by source domain (LinkedIn, X/Twitter, YouTube, Medium, Facebook, Instagram, or custom sites).
  - Supports click-and-drag horizontal mouse-scrolling on both scrollers.
- **Active Tab Auto-Detection**: Auto-detects when you change active browser tabs and automatically selects the corresponding website filter pill (e.g. switching to a YouTube tab focuses the YouTube feed, switching to LinkedIn focuses LinkedIn items), falling back to "All Sites" on untracked domains.
- **Instant Activation (No Refresh Required)**: Programmatically injects content scripts into existing open browser tabs matching both root domains and subdomains immediately upon extension installation or reload.
- **Scroll-Optimized Observers**: Uses globally-cached states inside content scripts to evaluate pause states and site activation synchronously in memory, ensuring scrolling remains lag-free and free from storage API throttling.
- **Obfuscation-Proof Selectors**: Uses modern HTML React data attributes (like `[data-urn*="urn:li:"]` for LinkedIn) to detect posts, remaining completely immune to dynamic class obfuscations.
- **Native Favicon Collector**: Automatically resolves and displays the site's official favicon in each card header using Chrome's offline `_favicon` API.
- **Keyboard-driven Curation (HUD)**:
  - <kbd>↑</kbd> / <kbd>↓</kbd> or <kbd>Tab</kbd> / <kbd>Shift+Tab</kbd> to focus cards (scrolls into view smoothly).
  - <kbd>←</kbd> / <kbd>→</kbd> to cycle the category tag of the focused card in real time.
  - <kbd>Space</kbd> to toggle Favorite (`<3`) status.
  - <kbd>Enter</kbd> to expand or collapse card snippet body.
  - <kbd>Shift+Enter</kbd> or <kbd>Ctrl+Enter</kbd> to open card link in a new tab.
- **Favorites (`<3`)**: Mark items as favorites (❤️), which records a custom `favoritedAt` timestamp and preserves items during "Clear stream" triggers.
- **Master Pause Switch**: Toggle button in the header that pauses scanning, showing a banner: **"Collection paused since HH:MM:SS"**.
- **Ignored Keywords**: Settings form to add keyword filters. Incoming posts containing ignored words are skipped.
- **Interactive HTML Diary Export**: One-click action to download your collected feed as a standalone, styled HTML file with a responsive card layout, theme toggles, search filtering, and category controls.
- **Privacy First**: Built-in inline PII sanitizer scrubs emails, credit cards (Luhn-validated), and phone numbers before text is processed.
- **Subtle Gradient Border Glow**: News-type cards automatically receive a premium multi-color gradient border glow that respects the card's rounded borders.
- **No Overflow Cards**: Modern CSS styling ensures long continuous strings wrap gracefully and platform links display with clean ellipsis.

---

## How to Install (Local unpacked)

ScrollCollector runs 100% locally. To load it into any Chromium-based browser (Chrome, Edge, Brave, Arc, Opera):

### Standalone Installer (1-Click Setup)
ScrollCollector features a unified standalone setup installer built in Go.
1. **Windows:** Double-click `ScrollCollectorInstaller.exe` in the root folder.
2. **macOS:** Compile and run `ScrollCollectorInstaller` (see building instructions below).
3. The installer runs a temporary local server and opens your browser to an interactive setup wizard:
   - It auto-detects browser installations (Chrome, Edge, Brave).
   - If multiple browsers are found, it presents a checkbox list to choose your targets.
   - It extracts extension files to `%USERPROFILE%\ScrollCollector` (Windows) or `/Applications/ScrollCollector` (macOS) and copies the installation path to your clipboard.
4. Follow the interactive guide in your browser to load the unpacked extension.

### Storage (no companion app)
All collected items live in the browser's own `chrome.storage.local`. There is no
background service, no sync server, and no cross-browser synchronization — each
browser profile keeps its own independent stream.

> **Note:** earlier revisions shipped a system-tray companion app that provided a
> desktop dashboard and cross-browser sync. It was removed in commit `3416521`
> ("refactor: remove companion app") and the extension contains no runtime
> references to it. The Go sources remain under `companion/` unbuilt, in case the
> feature is revived; they are not part of the extension.

To keep the stream bounded, the collector caps stored items (see
`MAX_STACK_ITEMS` in `background.js`) and evicts the oldest entries first.
Favourited items (`<3`) are never evicted.

### Building from Source (Developers)
Run the compilation script in your shell to build the standalone installers:
```bash
./build-installer.sh
```
*Note: macOS systray compilation requires CGO/Xcode clang compiler.*

### Manual Installation (All Platforms)
1. **Download/Clone the Repository**:
   ```bash
   git clone git@github.com:fauzulkc/ScrollCollector.git
   ```

2. **Load into Browser**:
   - Open your browser and navigate to `chrome://extensions/` (or `edge://extensions/` / `brave://extensions/`).
   - Enable **Developer Mode** (toggle in the top-right corner).
   - Click the **Load unpacked** button in the top-left.
   - Select the `ScrollCollector` folder containing `manifest.json`.

3. **Open the App**:
   - Click the extension puzzle icon in the toolbar.
   - Click **ScrollCollector** to open the side panel.

---

## Enabling On-Device AI

ScrollCollector uses progressive enhancement for semantic inference:

| Tier | Engine | Browsers |
|------|--------|----------|
| 1 | Browser Prompt API (built-in model) | Chrome (Gemini Nano), Edge (Phi-4-mini) |
| 3 | Rule-based Classifier | All browsers (keyword fallback) |

The header status pill shows which tier is active: **green** = semantic AI ready, **orange** = downloading or keyword fallback.

### Chrome 138+

ScrollCollector uses the **`LanguageModel`** global (Prompt API). No origin-trial permissions are required.

1. **Chrome version**: Prompt API for extensions requires **Chrome 138+** on desktop.

2. **Enable flags** (if not already on):
   ```text
   chrome://flags/#prompt-api-for-gemini-nano
   ```
   Select **Enabled** (or **Enabled for Extension** if shown).

   ```text
   chrome://flags/#optimization-guide-on-device-model
   ```
   Select **Enabled BypassPerfRequirement**.

3. **Relaunch Chrome**, verify at `chrome://on-device-internals`, then **reload the extension**.

4. Header should show **Gemini Nano** with a green dot.

**Hardware requirements** (Chrome enforced): 22 GB free disk, 16 GB+ RAM recommended, unmetered connection for the initial model download.

### Microsoft Edge (Dev / Canary recommended)

Edge uses the same **Prompt API** standard with **Phi-4-mini** as the on-device model.

1. Use **Edge Dev or Canary** with the Prompt API flag enabled:
   ```text
   edge://flags/#prompt-api-for-gemini-nano
   ```
   (Edge may label this *Prompt API for on-device language model*.)

2. Enable the on-device model flag (same as Chrome):
   ```text
   edge://flags/#optimization-guide-on-device-model
   ```
   Select **Enabled BypassPerfRequirement**.

3. Relaunch Edge and verify at `edge://on-device-internals`.

4. Reload ScrollCollector — header should show **Phi-4-mini** with a green dot.

**Smoke test** (service worker console at `edge://extensions` → ScrollCollector → Service worker):
```javascript
await LanguageModel.availability({
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }]
});
// Expected: "available"
```

### Brave

Brave does not ship Google's Gemini Nano download, so ScrollCollector uses the **Rule-based
Classifier** there (keyword matching, no flags required). It does not download a replacement
language model.

---

## How to Use

1. **Browse**: Navigate to any enabled site (LinkedIn, YouTube, Twitter/X, Medium, etc.).
2. **Curation**: 
   - Hover/focus on cards in the side panel.
   - Reclassify category tags inline using the **Override** popup, or use the **Left/Right arrow keys**.
   - Favorite items with <kbd>Space</kbd> or remove individual items with the `×` button.
3. **Ignored Keywords**: Add unwanted words in the settings panel to automatically skip them.
4. **Export**: Open the Export tab and click **Generate HTML Diary** to save a local styled copy of your feed.
5. **Clear**: Click **Clear stream** in the footer to purge all un-favorited items.

---

## License

MIT License. Operates 100% locally with zero external network tracking.
