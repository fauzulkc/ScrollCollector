# 🧷 Browser-extension engineer: the project brief for ScrollCollector

**This seat's rulebook is `.claude/skills/seat-extension/SKILL.md` in this project** (how the role thinks
and works). **This file is what the role needs to know about ScrollCollector**: what it owns here, the
decisions that bind it, and the traps it has paid for. The seat reads it right after `docs/TEAM.md`,
every time it starts. A decision in [DECISIONS.md](../DECISIONS.md) outranks both.

## Owns here
- **Register:** the extension code, manifest and store listing. The listing draft is
  [docs/STORE-LISTING.md](../STORE-LISTING.md) (created 2026-10-10); publishing it is the owner's.
- **Scope:** the browser extension: permissions and store review decide what ships
- **Paths** (all checked to exist 2026-10-10, except where marked):
  - `manifest.json` (permissions, host permissions, content-script matches and worlds, CSP, version)
  - `content.js` (per-site post extraction), `lib/sites.js`, `lib/content/` (today: `linkedin-urn-bridge.js`, MAIN world)
  - `lib/bg/inject.js` (injects content scripts into open tabs; the only file of `lib/bg/` that is this seat's)
  - side panel and UI: `sidepanel.html`, `sidepanel.js`, `sidepanel.css`, `ui/` (incl. `ui/diagnostics.js`)
  - `icons/`
  - build and packaging: `scripts/build-ext.mjs`, `scripts/sync-win.sh`, `build-installer.sh`,
    `build-pkg.sh`, `package-release.sh`, `bump-version.js`, `installer/`, `companion/`
  - `docs/STORE-LISTING.md`
  - Note: setup-facts and `scripts/build-ext.mjs` RUNTIME_ENTRIES name root `diagnostics.html` /
    `diagnostics.js`; **neither exists** (2026-10-10). The build skips missing entries; diagnostics lives in
    `ui/diagnostics.js`, mounted from the side panel.

## Does not own here
- `background.js`, `lib/bg/` (except `inject.js`), `lib/messages.js` (message contracts), `lib/state-lock.js`:
  ⚙️ Engineering. Content scripts talk to the worker only through those contracts; a new message is an ASK.
- `lib/decision/`, `lib/pipeline/`, `lib/storage/` (schema, migrations, secrets), `lib/sanitizer.js`,
  legacy `lib/inference*` and `lib/prompt-builder.js`: ⚙️ Engineering.
- `offscreen/` and `lib/offscreen-client.js` (System 1 embeddings, model fetch), `scripts/fetch-models.mjs`,
  `eval/` code, `package.json` dependencies: ⚙️ Engineering. The build vendors their output; changing what
  is vendored is a HANDOFF with Engineering.
- `test/`, `e2e/`, `test.mjs`, `vitest.config.mjs`, `playwright.config.mjs`, `mocks/`, `test/fixtures/`
  (incl. `linkedin-feed.html`, `x-feed.html`) and `docs/TEST-STANDARD.md`:
  🧪 Testing. A fixture captured from a live site goes to Testing to land, or lands with its go.
- `docs/DESIGN.md`: 📐 Design specs side panel and diagnostics form; you build it.
- `docs/briefs/` (Bar Raiser findings), `docs/DECISIONS.md` (CEO), `docs/team/tracker.md` and
  `docs/team/owner-questions.md` (Chief of Staff).
- Publishing to the Chrome Web Store, releases, signing: the owner (DEC-2).

## Reports to
Engineering

## Decisions that bind this seat
- **DEC-2:** owner-only acts are publishing, sending, spending and signing: you never submit to the Chrome
  Web Store or cut a public release; prepare it and ask through the Chief of Staff. Pushing: a seat pushes
  its landed work once the checks pass and a reviewing seat has passed it, and reports the push after.
- **DEC-3, DEC-4, DEC-5** (owner direction 2026-10-09/10, recorded 2026-10-11; the rows win; the testing line below is 🧪 Testing's to record):
  - System 1 is a small sentence-embedding model (bge-small-en-v1.5 / MiniLM, q8) via Transformers.js in the
    offscreen document; **weights bundled, nothing downloaded at runtime** (the build must keep bundling them).
  - The only LLM tier is the browser's built-in model (Gemini Nano via the `LanguageModel` Prompt API).
    **Never add a downloaded or bundled generative model.**
  - Cloud decision APIs (Jev at `api.typesafe.ai`, OpenAI) are **never on by default**: each needs its own
    opt-in in the UI; only uncertain posts escalate; one primary provider, no chaining.
  - Testing is Playwright E2E (Chrome for Testing in WSL) plus live checks in the owner's Chrome via
    Claude-in-Chrome. **The owner types API keys themselves.**
  - Goal: small, cheap, fast, private (weighs every permission and every byte in the package).

## Project facts this seat relies on
Measured 2026-10-10 unless marked.
- Repo: WSL Ubuntu-24.04 `/home/fauzul/code/ScrollCollector` (= `\\wsl.localhost\Ubuntu-24.04\home\fauzul\code\ScrollCollector`;
  `D:\code\ScrollCollector` is a symlink to it). Branch in work `feat/decision-cascade`. No CI (no `.github/workflows/`).
- Run git / npm / node from WSL, never Windows git. From Windows: write a script to the scratchpad and run
  `MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu-24.04 -- bash -l /mnt/c/<path>`. Node v24.14.0 via fnm under `bash -l`.
- Stack: Chrome MV3, plain ES modules, no bundler or framework; version 0.10.0 (2026-10-11); dep `@huggingface/transformers` ^3.4.0.
- Manifest (0.10.0, 2026-10-11): permissions storage, sidePanel, favicon, tabs, scripting, alarms, offscreen,
  idle, unlimitedStorage (`activeTab` removed in 0.10.0: no caller); each justified in `docs/STORE-LISTING.md`; host_permissions `<all_urls>`; `content.js` on `<all_urls>` at document_idle;
  `lib/content/linkedin-urn-bridge.js` in MAIN world on `https://www.linkedin.com/*` at document_start; CSP
  `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`; COEP require-corp, COOP same-origin; module
  service worker `background.js`; side panel `sidepanel.html`. `<all_urls>` lengthens store review.
- Default sites (`DEFAULT_SITE_DOMAINS`, `lib/sites.js`, 2026-10-11): Facebook, LinkedIn, X, Instagram, YouTube,
  Medium, GitHub, Hacker News; plus heuristic custom sites the user adds.
- Commands: `npm test` (= `node test.mjs && vitest run`); `npm run test:unit`; `npm run test:e2e`
  (Playwright, 18 specs in `e2e/`, 1 worker, 180 s timeout, Chrome for Testing in WSL; `e2e/ui.spec.mjs`,
  `security.spec.mjs`, `startup.spec.mjs` look closest to this seat, by name only: UNVERIFIED); `npm run build:ext` → `dist/ext/` (copies
  runtime sources, vendors Transformers.js + ORT wasm, bundles model weights; run `npm run fetch:models`
  first or pass `--no-models`); `npm run sync:win` mirrors `dist/ext/` to `/mnt/d/code/ScrollCollector-dev`
  (= `D:\code\ScrollCollector-dev`, exists, held 0.9.0 on 2026-10-10).
- Live check: in the owner's Chrome, `chrome://extensions` → Load unpacked / reload from
  `D:\code\ScrollCollector-dev` (Chrome is flaky loading from `\\wsl.localhost`), then reload the site tab.
- **Store package** (2026-10-11): `npm run package:store` (`scripts/package-store.sh`) →
  `releases/ScrollCollector-<version>-store.zip`, the contents of `dist/ext/`, with guards (versions agree, every
  manifest-named and model file present). 0.10.0: 46 MB zipped. Privacy policy draft: `docs/PRIVACY.md`.
- Packaging (older, Go): `build-installer.sh` (zips `dist/ext/` since 2026-10-11; before, it zipped source files
  with no models and no `ui/`), `build-pkg.sh`, `package-release.sh`, `bump-version.js` (commits and tags on its
  own: not for a release bump, the tag is the CEO's), `installer/`, `companion/`; documented in `BUILD.md`.
  Whether the Go installers still compile and install: UNVERIFIED.
- Chrome Web Store: no listing is known to exist; listing state and any store account: UNVERIFIED.

## Traps paid for
- **Concurrent parses deleted already-collected items** (c4c368b, 2026-07-25); fixed with a locked store
  (103b6a8, `lib/state-lock.js`). Never write the store from a content script around the lock.
- **Unstable post identity and glued posts** (1c94c23): an item's key must be stable before it is collected.
- **LinkedIn duplicates when a post is opened on its own page** (44f04d3); permalinks are resolved from React
  props via a MAIN-world bridge (0c42d0c, `lib/content/linkedin-urn-bridge.js`): treat its output as untrusted.
- **LinkedIn's 2026 feed and jobs layout broke collection** (c573df6): site DOMs change; selectors rot.
  Capture the new markup as a fixture before fixing.
- **Substring classification, unbounded queue, stack growth** (6dcd335, 2026-07-25): word boundaries, a
  bounded queue and a stack cap.
- **MV3 forbids remote code** (e0c0df6 retired the legacy inference router): no CDN; vendor everything.
- **Windows git** shows spurious exec-bit diffs on `.sh` files and its credential helper hangs; use WSL git.
- **Chrome loading from `\\wsl.localhost` is flaky:** always `build:ext` then `sync:win`, load from `D:\code\ScrollCollector-dev`.
- **`build-ext.mjs` silently skips missing runtime entries** (root `diagnostics.*`, 2026-10-10): a renamed
  file drops out of the package with no error; check `dist/ext/` after a move.

## Done means here
1. `npm test` green (integration + unit), counts pasted; `npm run test:e2e` green for every spec your change
   touches, the whole E2E leg when `manifest.json`, `content.js` or `lib/bg/inject.js` changed; counts pasted.
2. Every new guard seen red by the right sabotage (Testing's standard).
3. `npm run build:ext` then `npm run sync:win`; reload in `chrome://extensions`; the version shown matches;
   no error on the extensions page, the service-worker console or the page console.
4. Live check in the owner's Chrome (Claude-in-Chrome) on each site the change touches: posts collected,
   no duplicates, no glued posts; side-panel changes read at the panel's real width.
5. A permission or CSP change is justified in `docs/STORE-LISTING.md` in the same commit.
6. Review: 📐 Design for any side-panel or diagnostics surface; ⚙️ Engineering for code that lands
   (it rules what lands); then push per DEC-2 and report the push.
