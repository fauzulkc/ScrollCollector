# ScrollCollector 📜🤖

ScrollCollector is a privacy-first, zero-latency Chromium browser extension that extracts, redacts, and classifies text content in real time as you scroll through social feeds and web pages. It runs entirely on your local machine, utilizing your browser's built-in on-device AI.

---

## Key Features

- **On-Device AI Engine**: Tier-1 classification using Chrome's native **Gemini Nano** model, with a Tier-2 offline **Keyword Fallback** engine.
- **Dynamic Tag Generation**: Automatically extracts and suggests new category tags (e.g. *Cooking*, *Space*, *Tesla*) for items that do not match existing tags.
- **Priority Routing**: Custom and default tags (e.g., Tech, Finance, Business) always take classification priority over dynamic tags.
- **Sleek Side Panel UI**: Persistent flat monochromatic layout containing category counters, stack feeds, and tags with animated scales on increment.
- **Tag Configurator**: Add, delete, toggle, or **promote (★)** dynamic tags to permanent status with a single click.
- **Privacy First**: Built-in inline PII sanitizer scrub emails, credit cards (Luhn-validated), and phone numbers before any text is processed.
- **Link Collection**: Every captured feed unit extracts its nearest clickable link so you can revisit the source post later.
- **Light & Dark Mode**: Respects your browser's preference and can be toggled manually.

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

1. **Browse**: Navigate to any scrollable social feed (LinkedIn, YouTube, Twitter/X, Medium, etc.).
2. **Track**: As you scroll, check the side panel to see text segments auto-classifying. Counters will pop on increment.
3. **Pin Insights**: Click the **pin button (◇/◆)** on any feed item to save it in your persistent *Pinned Insights* stack.
4. **Manage Tags**: Open the *Tags* configurator section:
   - Toggle switches to ignore/track categories.
   - Add new custom keywords.
   - Click **★** on dynamic tags to promote them to permanent status.
5. **Clear**: Click **Clear all** at the bottom to empty the recent stack, reset counters, and purge unpromoted dynamic tags.

---

## License

MIT License. Operates 100% locally with zero external network tracking.
