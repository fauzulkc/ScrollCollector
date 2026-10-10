# 🧪 Testing: the project brief for ScrollCollector

**This seat's rulebook is `.claude/skills/seat-testing/SKILL.md` in this project** (how the role thinks
and works). **This file is what the role needs to know about ScrollCollector**: what it owns here, the
decisions that bind it, and the traps it has paid for. The seat reads it right after `docs/TEAM.md`,
every time it starts. A decision in [DECISIONS.md](../DECISIONS.md) outranks both.

## Owns here
- **Register:** docs/TEST-STANDARD.md (what counts as green)
- **Paths:** `docs/TEST-STANDARD.md`; `test/` (`test/unit/`, `test/integration.test.js`,
  `test/helpers/fake-chrome.js`, `test/fixtures/` with `linkedin-feed.html` and `x-feed.html`);
  `e2e/` (the 18 `*.spec.mjs`, `e2e/helpers/` `ext.mjs` `feeds.mjs` `launch.mjs`,
  `e2e/mock-decision-server.mjs`); `test.mjs`; `vitest.config.mjs`; `playwright.config.mjs`;
  `mocks/` (old per-site mock pages); this brief. A test deletion carries its reason in the commit body.

## Does not own here
- **The code under test** is not this seat's: background and decision core (`background.js`, `lib/bg/`
  except `inject.js`, `lib/decision/`, `lib/pipeline/`, `lib/storage/`, `lib/sanitizer.js`,
  `lib/state-lock.js`, `lib/messages.js`, `offscreen/`, `lib/offscreen-client.js`) is ⚙️ Engineering's;
  `content.js`, `lib/content/`, `lib/sites.js`, `lib/bg/inject.js`, `manifest.json`, `sidepanel.*`,
  `ui/` and the build scripts are the 🧷 Browser-extension engineer's. A red test is reported to the
  owner of the code, never fixed by editing product code here.
- **The eval harness code** (`eval/run-eval.mjs`, `eval/lib/`) and its gate thresholds are ⚙️
  Engineering's; this seat rules only on what an eval run's green means. Never fit a threshold against a gate.
- **`scripts/build-ext.mjs`** (which builds the `dist/ext/` the E2E suite loads) is the 🧷 extension
  seat's; `npm run fetch:models` (`scripts/fetch-models.mjs`) is ⚙️ Engineering's.
- **Challenging finished work** before it ships is ⚖️ Bar Raiser's; visual rulings (what a surface
  should look like) are 📐 Design's, though a contrast pin on a ruling lands in this seat's tests.
- **Decisions** are the 🧭 CEO's (`docs/DECISIONS.md`).

## Reports to
CEO

## Decisions that bind this seat
- **DEC-1:** the team method in `docs/TEAM.md`: work through `testing-worker` and the shared tiers; commit by explicit path.
- **DEC-2:** publishing, sending, spending and signing are owner-only (a Chrome Web Store upload or a
  release is never this seat's act); pushing is "on its own": a seat pushes its landed work once the
  checks pass and a reviewing seat has passed it, and reports the push after.
- **Owner's testing and AI direction (2026-10-09/10, not yet a decision row; the CEO is to record it):**
  testing = Playwright E2E on Chrome for Testing in WSL **plus** live checks in the owner's Chrome via
  Claude-in-Chrome; the owner types API keys themselves (no test ever stores or types a real key).
  System 1 is a bundled sentence-embedding model (bge-small-en-v1.5 / MiniLM, q8) in the offscreen
  document, nothing downloaded at runtime; the only LLM tier is the browser's built-in model (Gemini
  Nano, `LanguageModel`); Jev and OpenAI are opt-in only, never on by default, one primary provider,
  no chaining. A test that would assert otherwise needs a decision first.

## Project facts this seat relies on
- **Repo:** WSL Ubuntu-24.04 `/home/fauzul/code/ScrollCollector`; branch `feat/decision-cascade`; HEAD
  `44f04d3` (measured 2026-10-10). Run git / npm / node from WSL only (from Windows: a script run via
  `MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu-24.04 -- bash -l /mnt/c/<script>`). Node v24.14.0 in WSL.
- **No CI** (no `.github/workflows/`) and **no cadence script yet**: every green is a local run. The
  rulebook's cadence on committed HEAD does not exist here; building it is open work for this seat.
- **Commands** (package.json, measured 2026-10-10):
  - `npm test` = `node test.mjs && vitest run`.
  - `node test.mjs`: node:test, 18 tests, mostly pure logic over the legacy `lib/inference-engine.js`,
    `lib/prompt-builder.js`, the sanitizer and `lib/state-lock.js`. Probe depth: unit.
  - `npm run test:unit` = `vitest run` over `test/**/*.test.{js,mjs}` (40 files: 39 in `test/unit/` +
    `test/integration.test.js`); happy-dom, fake-indexeddb, fake chrome in `test/helpers/fake-chrome.js`.
    Probe depth: unit for pure logic; `content-identity`, `ui-*` and `integration-seams` run real
    modules together in happy-dom, so integration at most (no real layout, no real Chrome).
  - `npm run test:e2e` = Playwright, `e2e/*.spec.mjs`, 1 worker, 180 s timeout, list reporter, trace
    retained on failure. Needs `npm run build:ext` first (`e2e/helpers/launch.mjs` throws if
    `dist/ext/manifest.json` is missing). Runs on Chrome for Testing (Playwright `channel: 'chromium'`)
    because branded Chrome ignores `--load-extension` since 137. Headless unless `HEADED=1`.
    Cloud providers answer from `e2e/mock-decision-server.mjs`; `e2e/nano.spec.mjs` injects a **fake**
    `LanguageModel`, so E2E never exercises real Gemini Nano. Probe depth: integration in a real browser.
  - `npm run test:eval` = `node eval/run-eval.mjs`: offline System 1 eval; needs weights from
    `npm run fetch:models` in `eval/.cache/models` (gitignored). Last report: `eval/reports/2026-10-10-system1.md`.
  - **Live depth** = the owner's Chrome via Claude-in-Chrome, loading `dist/ext` mirrored by
    `npm run sync:win` to `/mnt/d/code/ScrollCollector-dev` (Chrome is flaky loading from `\\wsl.localhost`).
    The only place real Nano, real site DOMs and real provider keys meet. The owner types keys.
  - **Production depth:** none measured; the extension's store status is UNVERIFIED.
- **Data sources:** `eval/golden/posts.synthetic.jsonl` (tracked), `prompts.json`, `tags.json`;
  `eval/golden/posts.private.jsonl` is the owner's private export, **gitignored**
  (`eval/golden/*.private.*`): never commit it, never print its contents; a fresh checkout lacks it, so
  any eval leg that reads it is a listed skip there, not a pass.
- **Measured 2026-10-10 at `44f04d3`** (tree: `.gitignore` modified, team docs untracked; no product
  file changed), one uncached run each, in WSL:
  - `node test.mjs`: **18 pass, 0 fail, 0 skipped**, exit 0.
  - `npm run test:unit` (vitest): **RED, exit 1. 707 tests in 40 files: 706 pass, 1 fail, 0 skipped.**
    Failing: `test/unit/content-identity.test.js` › "content.js identity on a LinkedIn feed › a new
    post appended to the feed is picked up by the observer": `waitFor timed out` after 12328 ms. One
    run only: whether it is a defect or load-sensitive timing is UNVERIFIED (the test's own comment
    names a slow observer debounce on a loaded machine). A finding first; no ledger exists yet.
  - `npm run test:e2e`: **UNVERIFIED** (not run). `grep` finds no `test.skip` in `e2e/`; runtime skips UNVERIFIED.
  - `npm run test:eval`: UNVERIFIED (not run); the committed 2026-10-10 report is a document, not a re-run.

## Traps paid for
- **Concurrent parses deleted already-collected items** (c4c368b; fixed by the locked store in
  103b6a8, `lib/state-lock.js`): guarded by `test.mjs` "State lock - concurrent parses must not
  delete collected items". Sabotage record: none yet.
- **Unstable post identity and glued posts** (1c94c23), **LinkedIn duplicates when a post is opened on
  its own page** (44f04d3, 0c42d0c; permalinks from React props via `lib/content/linkedin-urn-bridge.js`
  in the MAIN world): guarded by `test/unit/content-identity.test.js` over `test/fixtures/linkedin-feed.html`.
- **Site DOMs rot** (c573df6: LinkedIn's 2026 feed and jobs layout broke collection): a fixture-green
  extractor proves only the fixture; collection needs the live check on the real site.
- **Substring classification, unbounded queue, stack growth** (6dcd335): word-boundary guard in
  `test.mjs` "Requirement 7 — Substring match and weak keyword fallback tests".
- **The legacy inference router was retired** (e0c0df6), yet `test.mjs` still imports
  `lib/inference-engine.js` and `lib/prompt-builder.js`: a green there may be testing legacy code,
  not the shipping cascade. Name which path a test covers.
- **MV3 forbids remote code** (e0c0df6): everything is vendored into `dist/ext`; a test that passes
  with a CDN or a runtime download proves the wrong build.
- **Branded Chrome ignores `--load-extension` since 137** (`e2e/helpers/launch.mjs`; 77190f4): E2E is
  Chrome for Testing only; a green E2E run says nothing about the owner's Chrome.
- **Windows git** shows spurious exec-bit diffs on `.sh` files and its credential helper hangs; Chrome
  loading from `\\wsl.localhost` is flaky (setup-facts 2026-10-10).
- **2026-10-10:** first measured run of the unit suite is red (content-identity observer test, above).

## Done means here
A suite claim names the command, the commit, the configuration (WSL, Node v24.14.0, with or without
`eval/golden/posts.private.jsonl`, with or without a fresh `dist/ext`) and passed / skipped / failed /
did-not-run per leg: `node test.mjs`, `vitest run`, `playwright test` and, when the AI path changed,
`node eval/run-eval.mjs`. With no CI, "green" means those local legs re-run uncached at that commit,
any red written into `docs/TEST-STANDARD.md` as a finding before it becomes a task, quarantined tests
listed by name. Anything touching collection, the side panel, Nano or a cloud provider is called
proven only after the live check in the owner's Chrome via Claude-in-Chrome on a `dist/ext` built from
that commit, with the owner typing any key. A guard counts once it has a sabotage record.
