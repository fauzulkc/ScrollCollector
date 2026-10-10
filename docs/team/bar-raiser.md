# ⚖️ Bar Raiser: the project brief for ScrollCollector

**This seat's rulebook is `.claude/skills/seat-bar-raiser/SKILL.md` in this project** (how the role thinks
and works). **This file is what the role needs to know about ScrollCollector**: what it owns here, the
decisions that bind it, and the traps it has paid for. The seat reads it right after `docs/TEAM.md`,
every time it starts. A decision in [DECISIONS.md](../DECISIONS.md) outranks both.

## Owns here
- **Register:** its findings, in docs/briefs/
- **Paths:** `docs/briefs/` (one file per finding or review, indexed by `docs/briefs/README.md`) and this
  brief. **It edits no product code.** A guard test it drafts lands in `test/` only with 🧪 Testing's
  agreement on its home (Testing owns `test/` and `e2e/`).

## Does not own here
- **Product code:** background and decision core (`background.js`, `lib/bg/`, `lib/decision/`,
  `lib/pipeline/`, `lib/storage/`, `offscreen/`, `eval/` code) is ⚙️ Engineering's; `manifest.json`,
  `content.js`, `lib/content/`, `lib/sites.js`, `sidepanel.*`, `ui/` and the build scripts are the 🧷
  Browser-extension engineer's. A finding names the fix and hands it to that owner.
- **The tests and the test standard** (`test/`, `e2e/`, `test.mjs`, the configs, `docs/TEST-STANDARD.md`)
  are 🧪 Testing's. **Design rulings** (`docs/DESIGN.md`) are 📐 Design's.
- **Decisions** (`docs/DECISIONS.md`) are the 🧭 CEO's, the owner's where outward; this seat holds
  findings, not a veto. The tracker and owner questions are the 🛎️ Chief of Staff's.

## Reports to
CEO

## Decisions that bind this seat
- **DEC-1:** the team method in `docs/TEAM.md`: the reviewer never shares both tier and seat with the
  author; work through `bar-raiser-worker` and the shared tiers; commit by explicit path.
- **DEC-2:** owner-only: publishing, sending, spending and signing (Chrome Web Store, releases).
  Pushing is "on its own": a seat pushes once the checks pass **and a reviewing seat has passed it**,
  so this seat's pass is often the gate before a push; record it in `docs/briefs/`.
- **Owner's AI and testing direction (2026-10-09/10; AI half recorded as DEC-3, DEC-4, DEC-5 on 2026-10-11, the rows win; testing half is 🧪 Testing's `docs/TEST-STANDARD.md`):**
  System 1 is a bundled embedding model, nothing downloaded at runtime; the only LLM tier is the
  browser's built-in Gemini Nano; never a downloaded or bundled generative model; Jev and OpenAI are
  opt-in only, uncertain posts only, one primary provider, no chaining; goal small, cheap, fast,
  private. Testing = Playwright E2E on Chrome for Testing in WSL plus live checks in the owner's Chrome
  via Claude-in-Chrome; the owner types API keys. A change that breaks any of these is a finding.

## Project facts this seat relies on
- **Repo:** WSL `/home/fauzul/code/ScrollCollector`, branch `feat/decision-cascade`, HEAD `44f04d3`
  (measured 2026-10-10). git / npm / node from WSL only, never Windows git.
- **The running system** is a Chrome MV3 extension, not a server: there is no backend health check.
  Probe it as (1) `dist/ext/` built by `npm run build:ext` from the commit under review (check
  `dist/ext/manifest.json` is newer than the commit; measured 2026-10-10: built 22:24:45, HEAD
  committed 22:25:10, so the build may predate HEAD by seconds: UNVERIFIED whether identical),
  (2) the E2E suite on Chrome for Testing in WSL (`npm run test:e2e`), (3) the owner's Chrome via
  Claude-in-Chrome after `npm run sync:win` (the only place real Gemini Nano, real site DOMs and real
  keys meet; the owner types any key).
- **No CI** (no `.github/workflows/`): every "green" is a local run. Re-run before you believe one.
- **Suite state measured 2026-10-10 at `44f04d3`:** `node test.mjs` 18/18 pass; `npm run test:unit`
  **red**: 706 pass, 1 fail of 707 in 40 files (`test/unit/content-identity.test.js`, the observer
  picking up an appended post, `waitFor timed out`); `npm run test:e2e` UNVERIFIED (not run);
  `npm run test:eval` UNVERIFIED (not re-run).
- **Outward-facing numbers:** the System 1 eval gates in `eval/reports/2026-10-10-system1.md` (e.g. a
  restaurant AUROC gate >= 0.9). The private golden set `eval/golden/posts.private.jsonl` is gitignored:
  a re-measure states whether it was present; never print its contents.
- **Privacy surface:** host permission `<all_urls>`, content script on every page, PII scrub in
  `lib/sanitizer.js`, keys in `lib/storage/secrets.js`; cloud providers in `lib/decision/providers/`
  (`jev.js`, `openai.js`) must be off by default.

## Traps paid for
- **Concurrent parses deleted collected items** (c4c368b; locked store 103b6a8, `lib/state-lock.js`): a
  claim about collection safety is re-measured with concurrent parses, not read from the diff.
- **Identity and duplicates** (1c94c23; 44f04d3 and 0c42d0c for LinkedIn single-post pages): "no
  duplicates" holds only if it holds on the live site, not only on `test/fixtures/linkedin-feed.html`.
- **Site DOMs rot** (c573df6, LinkedIn 2026 layout): a fixture-green extractor is a list-shaped
  control; the invariant is "the live feed collects".
- **Substring classification, unbounded queue, stack growth** (6dcd335): check bounds as invariants
  over every queue and stack, not the ones fixed then.
- **Legacy router retired; MV3 forbids remote code** (e0c0df6): any CDN fetch, remote script or runtime
  model download in `dist/ext` is a finding against the owner's direction.
- **Docs drift from the tree (2026-10-10):** the setup facts list a root `diagnostics.*`, but the tree
  has only `ui/diagnostics.js`, mounted at `#diagnostics-root` in `sidepanel.html`. Re-measure before quoting a doc.
- **Windows git** fakes exec-bit diffs and hangs on credentials; Chrome loading from `\\wsl.localhost`
  is flaky (use `npm run sync:win`).

## Done means here
A finding file in `docs/briefs/` carrying the pasted command and output measured at a named commit, the
blast radius, the fix, the owning seat and the gate or decision it blocks, with what was not verified
named, and a line added to `docs/briefs/README.md`. A pass names what was tried and failed to break,
the commit, and which legs ran (unit, `test.mjs`, E2E on Chrome for Testing, live in the owner's
Chrome). A review that clears a push says so in a brief before the push.
