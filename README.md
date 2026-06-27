# ScrollCollector 📜🤖

ScrollCollector is a privacy-first, zero-latency Chromium browser extension that extracts, redacts, and classifies text content in real time as you scroll through social feeds and web pages. It runs entirely on your local machine, utilizing your browser's built-in on-device AI (Gemini Nano) or a lightweight local keyword engine.

It is designed as a high-performance keyboard-driven curator to capture, filter, and compile web insights into interactive offline feed diaries.

---

## Key Features

- **On-Device AI Engine**: Tier-1 classification using Chrome's native **Gemini Nano** model, with a Tier-2 offline **Keyword Fallback** engine.
- **Dynamic Tag Generation**: Automatically extracts and suggests new category tags (e.g. *Cooking*, *Space*, *Tesla*) for items that do not match existing tags.
- **Priority Routing**: Custom and default tags always take classification priority over dynamic tags.
- **Segmented Workspace**: A clean, modern tabbed interface (**Stream**, **Export**, **Settings**) replacing vertical collapsible widgets to optimize narrow side panels.
- **List Virtualization**: Built-in `IntersectionObserver`-based DOM windowing. Off-screen cards are cleared from the DOM and replaced with height-matched spacers to maintain smooth scrolling and ultra-low memory usage even with thousands of items.
- **Double Filtering System**:
  - **Category Tags Bar**: Horizontal scrollable pills showing category count badges. Enabled categories are **always visible** even with 0 counts.
  - **Websites Bar**: A second horizontal scrollable pills row to filter items by source domain (LinkedIn, X/Twitter, YouTube, Medium, Facebook, Instagram, or custom sites).
  - Supports click-and-drag horizontal mouse-scrolling on both scrollers.
- **Active Tab Auto-Detection**: Auto-detects when you change active browser tabs and automatically selects the corresponding website filter pill (e.g. switching to a YouTube tab focuses the YouTube feed, switching to LinkedIn focuses LinkedIn items), falling back to "All Sites" on untracked domains.
- **Instant Activation (No Refresh Required)**: Programmatically injects content scripts into existing open browser tabs matching our tracking domains immediately upon extension installation or reload.
- **Scroll-Optimized Observers**: Uses globally-cached states inside content scripts to evaluate pause states and site activation synchronously in memory, ensuring scrolling remains lag-free and free from storage API throttling.
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

1. **Download/Clone the Repository**:
   ```bash
   git clone git@github.com:fauzulkc/ScrollCollector.git
   ```

2. **Load into Chrome**:
   - Open your browser and navigate to `chrome://extensions/`.
   - Enable **Developer Mode** (toggle in the top-right corner).
   - Click the **Load unpacked** button in the top-left.
   - Select the `ScrollCollector` folder containing `manifest.json`.

3. **Open the App**:
   - Click the extension puzzle icon in the toolbar.
   - Click **ScrollCollector** to open the side panel.

---

## Enabling On-Device AI (Optional, Chrome 131+)

To unlock Tier-1 classification powered by **Gemini Nano**, you must enable the Prompt API in Chrome:

1. Open a new tab and navigate to:
   ```text
   chrome://flags/#prompt-api-for-gemini-nano
   ```
   Select **Enabled**.

2. Navigate to:
   ```text
   chrome://flags/#optimization-guide-on-device-model
   ```
   Select **Enabled BypassPerfRequirement** (forces Chrome to download the model even on lower-spec hardware).

3. **Relaunch your browser**.
4. Check download status by navigating to `chrome://components/`. Under **Optimization Guide On Device Model**, click **Check for update** to ensure the model is downloaded.
5. Once ready, the engine status dot in your ScrollCollector header will turn **green** 🟢. If the model is not ready, it will safely fall back to the Tier-2 keyword matching engine 🟡.

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
