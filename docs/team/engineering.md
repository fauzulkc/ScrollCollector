# ⚙️ Engineering: the project brief for ScrollCollector

**This seat's rulebook is `.claude/skills/seat-engineering/SKILL.md` in this project** (how the role thinks
and works). **This file is what the role needs to know about ScrollCollector**: what it owns here, the
decisions that bind it, and the traps it has paid for. The seat reads it right after `docs/TEAM.md`,
every time it starts. A decision in [DECISIONS.md](../DECISIONS.md) outranks both.

## Owns here
- **Register:** engineering goals; what lands in code. No goals file exists yet and the rulebook names none
  (measured 2026-10-10); "what lands in code" is the git history on the paths below, commit subjects `engineering: …`.
- **Paths:** the background and decision core: `background.js`; `lib/bg/` (except `lib/bg/inject.js`);
  `lib/messages.js`; `lib/state-lock.js`; `lib/decision/` (incl. `providers/`, `calibration/`, `models.js`);
  `lib/pipeline/`; `lib/storage/`; `lib/sanitizer.js`; `offscreen/`; `lib/offscreen-client.js`;
  `scripts/fetch-models.mjs`; `eval/` (code: `eval/run-eval.mjs`, `eval/lib/`, `eval/reports/`); the dependencies in
  `package.json`; the legacy `lib/inference-engine.js`, `lib/inference/`, `lib/prompt-builder.js`.
  Rules whether any worker's output lands in code. The 🧷 Browser-extension engineer reports to you.

## Does not own here
- `manifest.json` (permissions, CSP), `content.js`, `lib/content/`, `lib/sites.js`, `lib/bg/inject.js`, the side panel
  and UI (`sidepanel.html`/`.js`/`.css`, `ui/` incl. `ui/diagnostics.js`; setup-facts' root `diagnostics.*` does not
  exist, measured 2026-10-10), `icons/`, and the build/packaging scripts (`scripts/build-ext.mjs`,
  `scripts/sync-win.sh`, `build-installer.sh`, `build-pkg.sh`, `package-release.sh`, `bump-version.js`, `installer/`,
  `companion/`): 🧷 Browser-extension engineer (you set its scope and queue). Near-miss: `scripts/build-ext.mjs`
  bundles the models listed in your `lib/decision/models.js` `MODEL_REGISTRY`; a model change is yours, the copy step is theirs.
- `test/`, `e2e/`, `test.mjs`, `vitest.config.mjs`, `playwright.config.mjs`, `mocks/`, `test/fixtures/`, and what
  counts as green (`docs/TEST-STANDARD.md`): 🧪 Testing. You apply the standard; legacy tests in
  `test.mjs` that import your legacy modules are still Testing's file.
- Side panel / diagnostics UX rulings (`docs/DESIGN.md`): 📐 Design.
- Findings on your work (`docs/briefs/`): ⚖️ Bar Raiser. Decisions and queue: 🧭 CEO.
- The golden set `eval/golden/posts.private.jsonl` is gitignored private data; the reports are yours, the data is not to be committed.

## Reports to
CEO

## Decisions that bind this seat
- **DEC-1** (the team method): you are the director over code; workers via `engineering-worker` and the shared tiers.
- **DEC-2** (owner-only acts, push rule): you push your landed work once the checks pass and a reviewing seat (⚖️ Bar
  Raiser) has passed it, and report the push after. Never publish to the Chrome Web Store, cut a release, or spend
  (cloud API calls on the owner's keys count as spend): the owner's.
- **DEC-3, DEC-4, DEC-5** (the owner's AI direction of 2026-10-09/10, recorded 2026-10-11; the rows win):
  System 1 = small q8 sentence-embedding model (MiniLM default, bge-small selectable) via Transformers.js
  in the offscreen document, weights bundled, nothing fetched at runtime; the only LLM tier is the browser's built-in
  `LanguageModel` (Gemini Nano): never add a downloaded or bundled generative model (the old Qwen 0.5B WebGPU tier is
  retired); Jev (TypeSafe, `POST https://api.typesafe.ai/v1/systemone`) and OpenAI are off by default, each with its
  own opt-in, only uncertain posts escalate, one primary provider, no chaining; the owner types API keys; small,
  cheap, fast, private. A change against any of these is a CEO question, not an engineering trade-off.

## Project facts this seat relies on
_(measured 2026-10-10 from `package.json`, the tree and the code)_
- **Stack:** Chrome MV3 extension, plain ES modules, no bundler/framework, v0.9.0. Runtime dep `@huggingface/transformers`
  ^3.4.0; dev: vitest, @playwright/test, happy-dom, fake-indexeddb. Run everything in WSL Ubuntu-24.04 at
  `/home/fauzul/code/ScrollCollector` (from Windows: script to scratch, `MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu-24.04 -- bash -l /mnt/c/<script>`).
- **Commands:**
  - `npm test` = `node test.mjs && vitest run` (legacy integration + 39 unit files in `test/unit/`).
  - `npm run test:unit` = `vitest run` only.
  - `npm run test:e2e` = Playwright, 17 specs in `e2e/*.spec.mjs`, 1 worker, 180 s timeout, Chrome for Testing in WSL;
    helpers `e2e/helpers/`, mock decision server `e2e/mock-decision-server.mjs`. (setup-facts says 18; 17 counted.)
  - `npm run test:eval` = `node eval/run-eval.mjs`: offline System 1 eval, needs the gitignored golden set; reports in
    `eval/reports/` (latest `2026-10-10-system1.md`: MiniLM and bge-small, leave-one-prompt-out, 137 synthetic + 7 held-out posts).
  - `npm run fetch:models`: downloads q8 weights to `eval/.cache/models` (dev time only, gitignored).
  - `npm run build:ext` (alias `vendor:ai`): `dist/ext/` with runtime sources, vendored Transformers.js + ORT wasm,
    bundled model weights and `models/manifest.json` (byte sizes served as Content-Length by `offscreen/model-fetch.js`);
    `--no-models` / `--models minilm,bge-small` flags. Fails without `fetch:models` first.
  - `npm run sync:win`: mirrors `dist/ext` to `/mnt/d/code/ScrollCollector-dev` for Chrome "Load unpacked".
- **Environments:** no CI (no `.github/workflows/`); no server to health-check. Live = `dist/ext` loaded in the owner's
  Chrome, checked via Claude-in-Chrome; Nano exists only in a Chrome with the Prompt API (E2E uses `e2e/nano.spec.mjs`
  and the mock server; real Nano behaviour UNVERIFIED here).
- **Data sources:** posts from the content script (`content.js`, extension seat's); cloud providers only when opted in;
  storage in `chrome.storage.local` (`lib/storage/schema.js`, `migrations.js`; keys in `secrets.js`); PII scrubbed by `lib/sanitizer.js`.
- **The cascade** (`lib/decision/cascade.js`): cache (`specHash:textHash`) → noise prefilter → System 1, one batched
  call (`lib/decision/system1-scorer.js`, offscreen host `offscreen/system1-host.js` via `lib/offscreen-client.js`) →
  escalation of posts below the confidence floor to ONE primary provider (`providers/nano.js`, `jev.js`, `openai.js`)
  with deadline and budget (`budget.js`), errors and timeouts keep System 1's answer → rules (`providers/rules.js`)
  fill gaps → finalize (gate, tag, cache, `engine-status.js`). Calibration in `lib/decision/calibration/`. Wired by
  `lib/bg/decision-runtime.js`; the pipeline (`lib/pipeline/` ingest → normalize → apply-decision, redecide, refine,
  relabel, retry) runs under the locked store (`lib/state-lock.js`, `lib/bg/store.js`).
- **Model bundling:** `lib/decision/models.js` `MODEL_REGISTRY`: `minilm` = `Xenova/all-MiniLM-L6-v2` (default),
  `bge-small` = `Xenova/bge-small-en-v1.5`, both q8 ONNX on the WASM backend, one text per call (deterministic).
  Weights ship under `models/<id>/` in `dist/ext`; nothing downloads at runtime. CSP `script-src 'self' 'wasm-unsafe-eval'`.
- **Legacy still present:** `lib/inference-engine.js` (still imported by `background.js` and `lib/pipeline/authors.js`
  for rule helpers and `heuristicAuthorMatch`), `lib/inference/browser-detect.js` (the router itself retired in
  `e0c0df6`), `lib/prompt-builder.js` (imported by `test.mjs`). Removing any of them changes Testing's `test.mjs`.

## Traps paid for
- `c4c368b`: concurrent parses deleted already-collected items; fixed by the locked store and ingest queue in `103b6a8`
  (`lib/state-lock.js`). Any new writer goes through the lock.
- `6dcd335`: substring classification, unbounded queue, stack growth; fixed with word-boundary matching, a bounded queue
  and a stack cap. Keep every queue bounded.
- `1c94c23`: unstable post identity and glued posts broke dedupe; `44f04d3` / `0c42d0c`: LinkedIn duplicates when a post
  is opened on its own page, fixed by resolving permalinks from React props via a MAIN-world bridge. Identity feeds your cache key.
- `c573df6`: LinkedIn's 2026 feed and jobs layout broke collection: upstream DOM rot shows up as "the cascade decided nothing".
- `e0c0df6`: legacy inference router retired; MV3 forbids remote code, so no CDN: vendor everything through `build:ext`.
- Windows git (exec-bit noise, GCM hangs) and Chrome loading from `\\wsl.localhost` are unreliable: WSL git, `sync:win`.
- `README.md` does not describe System 1 (no "embedding"/"MiniLM" in it): README is not a source for the cascade.

## Done means here
- The slice names its row; `npm test` green uncached, counts in the commit message; `npm run test:e2e` green for any
  change under `lib/decision/`, `lib/pipeline/`, `lib/bg/`, `offscreen/` or `background.js`; `npm run test:eval` re-run
  and the report compared when the decision core (`lib/decision/`, System 1, calibration, models) changed.
- `npm run build:ext` succeeds (with models) and, when behaviour is user-visible, `npm run sync:win` and a live check in
  the owner's Chrome; "landed, not loaded" is a stop reason.
- Every new guard seen failing; ⚖️ Bar Raiser has passed the change; committed with explicit paths (`engineering: …`),
  then pushed per DEC-2 and the push reported after.
