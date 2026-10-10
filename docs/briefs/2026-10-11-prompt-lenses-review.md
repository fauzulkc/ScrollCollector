# Review: feat/prompt-lenses for merge readiness (2026-10-11)

**Verdict: PASS, with one fix required before merge (F1).** By the ⚖️ Bar Raiser team (called by 🧭 CEO, seat away; a PROPOSAL until the seat confirms).
Branch head `4f9eca6` (commits 5090b29, 1b9bdfd, 3a8801c, d68d5c0, 2da7ff5, 4f9eca6 over `feat/decision-cascade`). Review only: merge waits on the owner's store submission (DEC-8). D-6 is a PROPOSAL not yet adopted by 📐 Design; the build was reviewed against it on that footing. Run log: `scratchpad/team/runs/bar-raiser/2026-10-11-lenses-review.md`.

## Legs run (fresh detached worktrees at 4f9eca6, node v24.14.0, uncached, removed afterwards)
- `npm test`: node test.mjs `pass 18`; vitest `Test Files 44 passed (44)`, `Tests 836 passed (836)`.
- `npm run build:ext` then `npm run test:e2e`: `42 passed (12.8m)`, exit 0 (includes `lenses-collect.spec.mjs` 4 tests and `migration.spec.mjs`).
- Not run: `test:eval`, the owner's Chrome, any real site.

## 1. Behaviour against DEC-6: holds
- Collect on collects, off labels only: `lib/decision/lenses.js` sets `collects: tag.collects !== false`; `collectingLenses` filters on it; `cascade.js` finalize builds the verdict from `spec.lenses.filter(l => l.collects)` only. e2e `lenses-collect.spec.mjs` tests 19-22 pass: master off plus one collecting prompt filters the feed; the only prompt with collects off filters nothing and still labels; a sort-only prompt's match is not collected; the CONTROL with collects on is.
- Built-in tags never lens or gate: a lens needs `isLens === true`, set only by TAG_ADDED (`lib/bg/handlers/tags.js:67`) and by the migration for non-built-in labels. Measured on a v2 profile with the 25 defaults: `built-ins with isLens: 0 of 25`; built-ins only: `lenses 0 gate false`.
- Filtering on iff some prompt collects: `isLensGateOn = collectingLenses(cfg).length > 0`, used by `isGateOn`, `isPromptGateOn`, `buildDecideContext`. Probe: master off, user tags collect=false gives `gateOn false`; master on gives `gateOn true collecting main,t_u1,t_u2`.
- Migration v2 to v3, probe (4-post stack, master on and off): master on gives `Cats,true,true Chess,true,true`; master off gives `Cats,true,false Chess,true,false`; second run `changed2(idempotent) false`; `input untouched true`.

## 2. DEC-3/4/5: hold
- `git diff feat/decision-cascade...HEAD` (code only; tests and eval reports excluded) added lines matching `fetch(|XMLHttpRequest|WebSocket|importScripts|https?://|new URL|sendBeacon|EventSource`: **none**. Control: the same pattern finds pre-existing hits in the tree (`sidepanel.js:1983`, `:3112`). `manifest.json`, `offscreen/`, `vendor/`, `scripts/` have no diff. No new network destination, no runtime download.
- Cloud still opt-in: the `schema.js` change is `SCHEMA_VERSION` 2 to 3 only; `escalationGate` gained an early return (`ctx.noEscalation`: the backfill is System 1 alone) and nothing that loosens it; the idle refinement still has no cloud path.

## 3. Strings
- Every string in the extension team's list (`scratchpad/team/runs/extension/2026-10-11-lenses-panel.md`, 13 items) was matched to its site in the diff. None claims tag accuracy: grep of the `sidepanel.js` and `sidepanel.html` diff for `accura|confiden|%|reliab` finds no new user string (DEC-9 bind holds).
- **F1 (false string, fix before merge).** `ui/decision-info.js:203` pushes `Prompt filter: off` whenever `pMatch` is null. With the master switch off and a collecting prompt, filtering is on and `pMatch` is null. Measured: `decisionTooltip` on `{provider:"system1", pMatch:null, collect:true, lenses:{t_u1:0.9}}` prints `Prompt filter: off`. DEC-6 02:58 binds the build to show where filtering applies; this hover says the opposite. Owner seat: 🧷 Extension (`ui/`), wording for 🧭 CEO or the owner. Blast radius: the card's hover text only, no data. Blocks the merge, not the owner's trial.
- **Needs the owner's read (true but loose):** (a) "Collecting posts that match: ..." (Stream and Settings): a post whose answer was unsure is collected under `whenUnsure: collect` without matching, as under the old filter. (b) "Off: it only labels and sorts": the footer label comes from tag classification and the chip from the prompt score; D-6 says they can disagree on one card. (c) Master help "Posts that stop matching after you edit it are hidden": with another collecting prompt matching, it stays collected. (d) "Match score n out of 100": a calibrated probability shown as a score; not an accuracy claim.

## 4/5. Guards seen red by sabotage (separate fresh worktree, restored; control 70/70 green after)
- `lib/storage/migrations.js` `tag.collects = wasGateOn` changed to `true`: `migrations.test.js` FAIL "master switch false: every user tag gets isLens and collects = false (an upgrade changes no feed)": `expected [[true,true],[true,true]] to deeply equal [[true,false],[true,false]]`.
- `sidepanel.js:1345` `const on = isLensGateOn(...)` changed to `true`: `ui-sidepanel.test.js` 2 FAIL, "no prompt collects: no line ..." and "the Collect switch ... sends TAG_COLLECTS_TOGGLED ...", `Tests 2 failed | 31 passed (33)`.

## 6. Data safety: holds
Probe: a v2 profile with a favourite (`isFavorite`), a legacy `favorite`, a manual override (`matchInfo.manual`), a hidden post and a decision-less post gives `stack len 4 ids abcd`, favourites kept, `manual kept {"manual":true}`, `hiddenByPrompt` and `decision.collect` kept. The migration only adds `lensBackfill` marks (`1110`); the re-decide then adds `decision.lenses` and changes nothing else on an item that already has a System 1 verdict (`lib/pipeline/redecide.js` backfill branch). `migrations.test.js` and `e2e/migration.spec.mjs` pass.

## Other findings (non-blocking)
- **F2 (⚙️ Engineering, comments):** `lib/decision/types.js` `DecideContext.gateOn` and the `isGateOn` JSDoc in `lib/pipeline/apply-decision.js` still say the gate needs `isMatchPromptEnabled`; the code (DEC-6 02:58) does not. A reader trusting the comment gets the old rule.
- **F3 (question to 🧭 CEO):** DEC-6 02:58 gives as its reason that nobody's feed changes on upgrade, and its rule sets a migrated tag's collect to the old master state. For a user with the master ON and tags, every tag then collects, so posts only a tag matches, hidden before, are collected after the re-decide (probe, master on: `gateOn true collecting main,t_u1,t_u2`). Is that widening intended, or should migrated tags start labels-only when the master was on? Not a defect against the ruling as written.
- **F4 (⚙️ Engineering, harmless):** a manual-override item also gets `lensBackfill: true` (probe marks `1110` include it) and `isRedecideTarget` skips manual items, so the mark stays forever; no effect on the item.

## Not verified
Live panel in the owner's Chrome and on a real feed; D-6 contrast and the 320/400/560 px layout (taken from the extension team's log); what a cloud provider is sent for a lens question when one is opted in (the code limits it to collecting prompts, at most 10 per post, on an uncertain post; no network capture); `test:eval`; the extension team's `dist/ext` trial copy.
