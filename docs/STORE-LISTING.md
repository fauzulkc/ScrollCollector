# Chrome Web Store listing: ScrollCollector (draft)

**Kept by the 🧷 Browser-extension engineer; publishing is the owner's.** This file is the working draft of
everything the Chrome Web Store asks for: the description, one justification per permission and host
permission in `manifest.json`, the single-purpose statement, and the data-use disclosures. The seat updates
it in the same commit as any change to `manifest.json` (a permission, a host pattern, the CSP or a new remote
endpoint), so the listing never claims less than the code does. Words a user reads follow the seat that owns
them, or are flagged for the owner's read. Nothing here is submitted by a seat: submitting, publishing and
signing are owner-only (`docs/DECISIONS.md`, DEC-2); a ready draft goes to the owner as a question through
the Chief of Staff.

**State (2026-10-11, manifest 0.10.0):** every justification written from the code that uses it. **For the
owner's read before upload:** the description, the single purpose, the data-use answers and the privacy
policy (`docs/PRIVACY.md`). No seat has words for these from 💼 Sales or 🎯 Product (neither is seated), so
they are drafts in plain words.

## Package
- Upload file: `releases/ScrollCollector-<version>-store.zip`, made by `npm run package:store` (the contents of
  `dist/ext/`, `manifest.json` at the zip root, both System 1 models bundled). 0.10.0: 46 MB zipped, 84 MB
  unpacked, 114 entries.
- Version 0.10.0 (the last tag is `v0.9.0`; the store refuses an equal or lower version on any update).

## Description (draft, for the owner's read)
Manifest `description` (shown on the extensions page, 132 characters max), unchanged from 0.9.0:
> Privacy-first, zero-latency content categorization powered by on-device AI. Tracks your mindstream across social feeds in real time.

Store description (draft):
> ScrollCollector keeps the posts you scroll past. Write a prompt that says what you care about, and as you
> scroll LinkedIn, X, YouTube, Facebook, Instagram, Medium, GitHub, Hacker News or any site you add, it saves the posts that match
> and sorts them into your own tags in the side panel.
>
> The deciding happens on your computer: a small language-understanding model ships inside the extension,
> and Chrome's built-in AI (Gemini Nano) helps where your browser offers it. Your collection is stored in
> your browser and never leaves it. If you want a second opinion on uncertain posts, you can switch on one
> cloud provider (TypeSafe or OpenAI) with your own API key; it is off until you turn it on.

## Single purpose (draft, for the owner's read)
> ScrollCollector saves posts the user scrolls past on social feeds and sites they choose, decides on the
> user's device which ones match the user's own prompts and tags, and shows the matching posts in a side panel.

## Remote code
**No, I am not using remote code.** All JavaScript and WebAssembly ship in the package: Transformers.js and the
ONNX Runtime wasm are vendored into `lib/vendor/`, the System 1 model weights into `models/`, and the CSP is
`script-src 'self' 'wasm-unsafe-eval'; object-src 'self'` (`'wasm-unsafe-eval'` runs the bundled wasm only).
Nothing is fetched and run at runtime. The optional cloud providers return JSON answers, never code.

## Permissions (manifest 0.10.0)
Each line: what it grants, the code that uses it, and why a narrower option fails.

| Permission | Justification |
|---|---|
| storage | Saves the user's collection, prompts, tags and settings in `chrome.storage.local` and short-lived decision state in `chrome.storage.session` (`background.js`, `lib/bg/store.js`, `lib/decision/cache.js`). Local storage is locked to extension pages (`setAccessLevel`), so websites and content scripts cannot read it. There is no narrower way to keep data between browser sessions. |
| sidePanel | The collection is shown in Chrome's side panel next to the feed being scrolled; the toolbar button opens it (`chrome.sidePanel.setPanelBehavior` in `background.js`). |
| favicon | Shows each saved post's site icon from Chrome's local favicon cache (`chrome-extension://<id>/_favicon/` in `sidepanel.js`), so no request goes to a third-party icon service. |
| tabs | Reads the URL of the active tab so the side panel and the worker know which site the user is on and whether collection is turned on for it (`chrome.tabs.onActivated` / `onUpdated` / `get` / `query` in `background.js`, `sidepanel.js`, `lib/bg/inject.js`), and messages the page's collector (`chrome.tabs.sendMessage`). Narrower option: the host permission below already exposes tab URLs for http(s) pages, so this permission is a candidate for removal once the side panel is checked without it (not done for this release). |
| scripting | Starts the collector in tabs that were already open when the extension was installed or updated, and on sites the user adds, without asking them to reload (`chrome.scripting.executeScript` in `lib/bg/inject.js`). Declared content scripts cannot reach tabs that were open before install. |
| alarms | Wakes the service worker on a schedule to retry posts that could not be decided yet and to run the idle refinement (`chrome.alarms` in `background.js`, `lib/pipeline/refine.js`). MV3 service workers stop after 30 seconds idle, so timers in memory do not survive. |
| offscreen | Runs the bundled System 1 model (Transformers.js on WebAssembly) in one offscreen document with reason `WORKERS` (`lib/offscreen-client.js`, `offscreen/system1-host.js`). The model needs a document context and must keep running while the side panel is closed; the service worker alone cannot host it. |
| idle | Re-checks collected posts with both bundled models only while the computer is idle, so the work never slows down browsing (`chrome.idle.queryState` / `onStateChanged` in `lib/pipeline/refine.js`, `background.js`). |
| unlimitedStorage | A long collection, plus the cache of post embeddings kept in IndexedDB by the offscreen document (`offscreen/embedding-cache.js`), can outgrow the default 10 MB `storage.local` quota; without it collection would stop silently once full. Everything stays on the device. |
| host: `<all_urls>`, and `content.js` on `<all_urls>` | The collector reads the posts on the page the user is scrolling. Besides the built-in sites (Facebook, LinkedIn, X, Instagram, YouTube, Medium, GitHub, Hacker News: `DEFAULT_SITE_DOMAINS` in `lib/sites.js`), the user can add any site of their own, and each site is checked against the user's list before anything is read (`checkIfSiteEnabled` in `lib/sites.js`, `content.js`). The same access lets the optional cloud provider the user switches on be reached at the address the user enters. Narrower option: named origins for the built-in sites plus optional host permissions requested when the user adds a site; this needs a permission-request flow in the side panel and is proposed for a later release, not this one. |

**Removed in 0.10.0:** `activeTab`. No code called it, and `<all_urls>` already grants what it would.

## Data use (Privacy practices tab; draft answers for the owner's read)
The store asks for disclosure of user data the extension handles **even when it is processed or stored only on
the user's device** (Chrome Web Store User Data FAQ, read 2026-10-11). Recommended answers:

| Data type | Tick? | What and why |
|---|---|---|
| Website content | **Yes** | The text, link, site and author name of posts on sites the user enabled; stored in the browser to build the collection. |
| Web history | **Yes** (conservative) | Each saved post keeps the address of the page it was seen on. No other browsing is recorded. |
| Authentication information | **Yes** (conservative) | Only if the user enters their own TypeSafe or OpenAI API key; stored in the browser, sent only to that provider. |
| Personally identifiable information | **Yes** (conservative) | Author names that appear on saved posts. Nothing is collected about the user themself. |
| Personal communications | No | Feeds only; no messages or email are read. |
| Health, Financial and payment, Location, User activity | No | None of these is read or stored. |

Certifications (all three true of the code):
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**What leaves the device:** nothing, by default. Only when the user switches on one cloud provider and enters
its API key does the text and site of a post that System 1 was unsure about go to that provider (TypeSafe at
`api.typesafe.ai` or OpenAI at `api.openai.com`, or the address the user sets), with the user's prompt and tags.
The author name is stripped before any cloud call (`escalation.sendAuthor` is `false` and the panel has no switch
for it in 0.10.0). Providers are never chained, the idle refinement never calls the cloud, and the collection
itself is never uploaded (DEC-5). The panel's "Telemetry Overview" card counts posts on the device only;
nothing is reported anywhere.

**Privacy policy URL:** the owner hosts `docs/PRIVACY.md` publicly and pastes the URL (runbook Part B step 2).
