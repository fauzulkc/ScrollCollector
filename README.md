# ScrollCollector 📜🤖

ScrollCollector is a privacy-first, zero-latency Chromium browser extension that extracts, redacts, and classifies text content in real time as you scroll through social feeds and web pages. It runs entirely on your local machine, utilizing your browser's built-in on-device AI.

---

## Key Features

- **On-Device AI Engine**: Tier-1 classification using Chrome's native **Gemini Nano** model, with a Tier-2 offline **Keyword Fallback** engine.
- **Interactive Retagging**: Every card features a minimal select dropdown, letting you manually override classification and shift category metrics atomically.
- **Site configurations**: Enable/disable scanning on standard feeds (LinkedIn, YouTube, X, Facebook, Instagram) or register custom domains (e.g., `reddit.com`) to filter your tracking space.
- **Structured Boundary Parsing**: Groups text blocks by card/post boundaries (tweets, LinkedIn updates, article sections) and strips noise elements (like buttons and comments) before processing.
- **PII Sanitizer**: built-in regex scrubber for email, phone numbers, and Luhn-validated credit cards.
- **Dynamic Tag Generation**: Auto-extracts topics (e.g. *Tesla*, *Space*) for unclassified content.
- **Sticky Dynamic Tags**: Pin dynamic tags in configuration (`📌`/`📍`) to protect them from purging during stack clears.
- **Ad Detection & Red Chips**: Highlights sponsored/promoted updates with a red badge and counts them under a dedicated **Ads** category.
- **Language Detection**: Automatically identifies post languages (using `chrome.i18n`) and adds a flat badge (e.g. `🇬🇧 EN`, `🇯🇵 JA`) to the card.
- **Link Collection**: Extracts the nearest post permalinks, letting you visit sources later.

---

## How to Install (Local unpacked)

Since ScrollCollector runs locally, you can load it directly into any Chromium-based browser (Chrome, Edge, Brave, Arc, Opera):

1. **Download/Clone the Repository**:
   ```bash
   git clone git@github.com:fauzulkc/ScrollCollector.git
   ```
   *(Or download and extract the ZIP file).*

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

1. **Browse**: Navigate to any enabled feed (LinkedIn, X/Twitter, YouTube, Facebook, Medium, or custom added sites).
2. **Track**: Scroll through posts. ScrollCollector extracts text dynamically, showing the language code (e.g., `🇬🇧 EN`) and an `Ad` badge if it is sponsored.
3. **Pin Insights**: Click the **pin button (◇/◆)** on any feed item to save it in your persistent *Pinned Insights* stack.
4. **Reclassify**: Choose a new tag from a card's footer select dropdown to override category classifications.
5. **Manage Tags & Sites**: Open the configurator toggles in the sidepanel:
   - Customize tracked categories or click **★** to promote dynamic tags.
   - Toggle **pin (📌)** on dynamic tags to make them sticky.
   - Enable or disable domains to configure where ScrollCollector tracks scrolling.
6. **Clear**: Click **Clear all** at the bottom to empty the recent stack, reset counters, and purge unpromoted, non-sticky dynamic tags.

---

## Running Automated Tests

ScrollCollector comes with a zero-dependency test suite using Node's native `node:test` runner.

To run tests:
1. Ensure Node.js (v18 or higher) is installed on your machine.
2. In the project directory, run:
   ```bash
   node test.mjs
   ```
   *or*
   ```bash
   npm test
   ```

---

## License

MIT License. Operates 100% locally with zero external network tracking.

