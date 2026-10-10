# Engineering goals: ScrollCollector

**Kept by ⚙️ Engineering.** The conditions under which Engineering may claim a product gate green. They
never reorder a decision in [DECISIONS.md](../DECISIONS.md); where a goal and a decision disagree, the decision wins.
Ids are `ENG-n`; grep for the next free number immediately before adding one. Corrections are appended with a
date, never written over.

| Goal | For decision | State |
|---|---|---|
| **ENG-1** · lenses data model | DEC-6 | ruled 2026-10-11, amended 01:30 for the user-prompts-only addendum; build dispatched |
| **ENG-2** · thumbnail fetch, shrink and byte cap | DEC-7 | draft plan; queued after ENG-1 (DEC-8) |

---

## ENG-1 · Lenses data model (DEC-6)

### Measured opening (2026-10-11, at `d090913`, read from source)
- **The ≥ 0.5 filter is in `rankTags`, `lib/decision/cascade.js:347`**, then `slice(0, MAX_TAGS)` with
  `MAX_TAGS = 3` (`:54`, `:365`). `lib/pipeline/apply-decision.js:159-161` (named in DEC-6's evidence) only drops the
  Ads tag and defaults the score. The ruling stands; its pointer is corrected here and sent to the CEO.
- **System 1 emits an independent per-tag score for the top 3 tags only:** `decideFromEmbeddings`,
  `lib/decision/system1-math.js:535` (`tagNoulsTopK ?? 3`) and `:565-571` (`tag:<label>` noul = calibrated
  `sigmoid(multi.a·z + multi.b)`, only when calibration has `tag.multi`). Both shipped calibrations have `multi`
  (`lib/decision/calibration/minilm.q8.json`, `bge-small.q8.json`). Every enabled tag's raw similarity is already
  computed in `scores.tags`; only the noul is capped, so scoring all tags costs no extra embedding.
- **`primary_tag.probabilities` is a softmax across tags** (`choiceFromSims`): scores compete and sum to 1. It
  cannot answer "does this post match prompt X" on its own; it is not a lens score.
- The match prompt's score is the `matches_prompt` noul (`decision.pMatch`), gated at the strictness threshold
  (`STRICTNESS_THRESHOLDS`, `cascade.js:47`: 0.7 / 0.5 / 0.3).
- A tag prompt change already changes the re-decide fingerprint: `selectQuestionTags` derives `description` from
  `tag.prompt` (`questions.js`, `describeTag`), and `decisionFingerprint` hashes `[label, description]`
  (`apply-decision.js:89`). Not yet verified by a test.
- Escalation asks at most `MAX_ESCALATION_TAG_NOULS = 3` tag nouls per post (`cascade.js:55`).

### Ruled (Engineering's; not the worker's to revisit), amended 2026-10-11 01:30 +0600 for DEC-6's addendum
1. **What a lens is:** a prompt the user wrote. (a) The match prompt, when non-empty: lens id **`main`**.
   (b) Each enabled tag the user added (`MSG.TAG_ADDED`, `lib/bg/handlers/tags.js:57`, id `t_<uuid>`): lens id =
   the tag's `id`. New tags get **`isLens: true`** at `TAG_ADDED`. **Never a lens:** the built-in topic tags
   (`defaultTrackedTags()`, 25, ids `t1`..`t25`), dynamic tags, pseudo tags, the Ads tag. Built-in tags keep
   their current behaviour exactly (label and filter, never gate).
2. **Field:** `decision.lenses`, an object `{ [lensId]: score }`, scores 0..1 rounded to 4 places, **every
   enabled lens present on every decided post, below 0.5 too**. Keyed by id, so a rename keeps its scores.
3. **How a lens is scored:** with the **match-prompt question and the match calibration** (`calibration.match`,
   the `matches_prompt` recipe), one question per lens, id `lens:<lensId>`; never with the tag noul or the tag
   softmax. Reason, measured in `eval/reports/2026-10-10-system1.md`: match ECE 0.019 / 0.031 leave-one-prompt-out
   (PASS) against tag ECE 0.067 / 0.083 (bge-small FAIL, fitted on the 25 built-in topics); lenses are user prompts.
   Same post vector; one prompt vector per lens (cached with the spec).
4. **Any-lens gate:** the gate is on when `isMatchPromptEnabled` is true and at least one lens exists; then
   `collect` is true when **any** lens score reaches `STRICTNESS_THRESHOLDS[gate.strictness]`. Gate off:
   unchanged (collect everything).
5. **"Matched" is one test, one function:** a lens matched a post when its score ≥ that same threshold.
   `lib/decision/lenses.js` exports it (`isLensMatch(score, configuration)`), plus `userLenses(configuration)`,
   `lensThreshold(configuration)`, `matchedLenses(decision, configuration)` and `lensScoreLabel(score)` =
   `Math.round(score × 100)` (📐 D-3's one function). The panel's pill count, list and chips all use it (P-2).
6. **Escalation:** a lens question below its floor is uncertain like `matches_prompt` today; one post's
   uncertain lens questions go in its **one** call to the **one** primary provider (DEC-5), at most 10 lenses.
7. **Additive:** `decision.tags`, `decision.tag`, `assignedTag` keep their meaning; `pMatch` = the `main`
   lens's score (unchanged meaning). No current reader changes in this slice.
8. **Migration:** `SCHEMA_VERSION` 2 → 3. Configuration: existing user-added tags get `isLens: true` (rule 1:
   not a built-in label, not dynamic, not pseudo, not Ads). Stack: posts without `decision.lenses` are marked
   for a lens backfill and re-scored by the existing re-decide job under the state lock, System 1 only, no
   escalation, no cloud. Idempotent.
9. **Re-decide on prompt change:** adding, removing, enabling, renaming or editing a lens's prompt changes
   `decisionFingerprint` and re-decides, as the match prompt does today.

### Rejected implementations
- Back-filling `lenses` from stored `decision.tags`: the scores below 0.5 were discarded, so the result is partial and false.
- Scoring a lens with `primary_tag.probabilities` (competing softmax) or with the tag noul (tag calibration).
- Making any built-in tag a lens, or changing how built-in tags label, filter or rank.
- A second post embedding per lens; a new storage key per post for scores.
- A skipped or loosened test to get the existing suites green.

### Non-goals (each with its reopen condition)
| Not in ENG-1 | Reopen when |
|---|---|
| Showing the score with "%" or calling it a probability | the eval shows the match calibration's *level* transfers across prompts (report line 282 says it does not always) |
| The cost-per-prompt view in Diagnostics (DEC-6 item 5) | ENG-1 lands; it is the next engineering slice for lenses |
| Merging the match prompt into the tag list in storage | 📐 D-1's Settings list needs it and the panel cannot map `main` |
| Panel, lens bar, chips | never in this goal: 🧷 Extension, to 📐 Design's spec |
| Workspaces | DEC-6's reopen condition |

### Gates (Engineering may call ENG-1 green only on pasted output)
| Gate | Evidence |
|---|---|
| Every enabled lens has a score on every decided post, below 0.5 included | unit test, 3 lenses + built-in tags; seen failing on the parent commit |
| Any-lens gate: a post matching only a user tag lens is collected with the gate on | unit test; seen failing on the parent commit |
| Built-in tags never gate: a post matching only a built-in tag is not collected with the gate on | unit test |
| Lens scores use the match calibration | unit test: a lens score equals `matches_prompt` for the same prompt text |
| Migration v2 → v3: idempotent, flags only user tags, a backfilled post's lenses equal a fresh decide | unit tests on `migrateState` + re-decide |
| Editing one lens's prompt re-decides and changes that lens's score | unit test on `decisionFingerprint` + re-decide |
| No regression | `npm test` and `npm run test:e2e` green uncached, counts in the commit |
| Decision core quality | `npm run test:eval` re-run (needs the private golden set); report compared with `2026-10-10-system1.md` |
| What green means for lenses | 🧪 Testing's standard; until it is published, tests are drafted "for Testing review" |

Branch `feat/prompt-lenses`, in its own worktree; nothing merges before the store submission (DEC-8).

---

## ENG-2 · Thumbnail fetch, shrink and byte cap (DEC-7), draft plan

Queued after ENG-1 (DEC-8). Constraints from DEC-7: made at capture time, stored on the device, small with a fixed
byte cap, never sent to any cloud provider, the post works with no image.

**Measured:** `manifest.json` grants `unlimitedStorage` and `<all_urls>` host access; the stack caps at
`MAX_STACK_ITEMS = 2000` (`lib/bg/stack-utils.js:13`). No image is captured today.

**Draft (to measure before ruling):**
1. The content script (🧷 Extension) sends the post's first image URL with the post; Engineering's background fetches it
   (host permission, no page cookies), decodes with `createImageBitmap`, shrinks on an `OffscreenCanvas` to a
   320 or 480 px longest edge (measured first; see the record), encodes WebP (JPEG fallback), and lowers quality until it fits the cap.
2. **Cap: set after measuring** (the 12 KB draft was too small for 📐 D-4; see the record); a full 2,000-post stack stays under 64 MB. Over the cap at the
   lowest quality: no thumbnail.
3. Stored **outside the stack** (IndexedDB, keyed by item id), so the locked stack write does not grow; deleted with
   its post and on eviction.
4. Failure of any step leaves the post without an image; never retried against an expired link.

**To measure before ruling:** the size distribution of real LinkedIn/X thumbnails at 160 px; whether service-worker
`fetch` of the CDN images works without the page's cookies; fetch-to-store time per image.

---

## Record (appended, never edited over)
- 2026-10-11 01:30 +0600 · ENG-1 amended after DEC-6's addendum (CEO, `da92dc5`): lenses are user-written prompts
  only. ~~Lens keys `"prompt"` / `"tag:<label>"`, scored by the tag noul, System 1 scoring every enabled tag~~ →
  keys by id (`main`, user tag id), scored by the match question and match calibration (eval ECE, rule 3);
  built-in tags untouched. Answers 📐 Design's D-2/D-3 questions (rules 4-5, non-goal on "%").
- 2026-10-11 01:30 +0600 · ENG-2 working size revised: 📐 D-4 grows to 240 CSS px (about 480 px at 2×), so the
  draft's 160 px / 12 KB is too small for a sharp grown view. Measure WebP at 320 and 480 px before ruling; the cap
  keeps a full 2,000-post stack under 64 MB.
