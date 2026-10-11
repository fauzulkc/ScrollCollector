# Engineering goals: ScrollCollector

**Kept by ⚙️ Engineering.** The conditions under which Engineering may claim a product gate green. They
never reorder a decision in [DECISIONS.md](../DECISIONS.md); where a goal and a decision disagree, the decision wins.
Ids are `ENG-n`; grep for the next free number immediately before adding one. Corrections are appended with a
date, never written over.

| Goal | For decision | State |
|---|---|---|
| **ENG-1** · lenses data model | DEC-6 | **shipped in 0.11.0** (tag `v0.11.0`, origin/main `dad4faa`): merged leg 842/842 unit, 42/42 e2e (🧭 CEO's run) |
| **ENG-2** · thumbnail fetch, shrink and byte cap | DEC-7 | trial built: `0ea9017` + `b13a446` on `feat/image-previews`, synced to `D:deScrollCollector-previews-dev`; M1/M2 await the owner's feed |
| **ENG-3** · meet the System 1 tag gates honestly | DEC-9 | parked 2026-10-11: probe + pre-registered genre cues failed; gates stay red (see Record) |

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
4. **Any-collecting-prompt gate** (DEC-6, owner 02:27): each `isLens` tag carries **`collects`** (boolean; absent =
   `true`). A *collecting* lens is `main` while `isMatchPromptEnabled` is on and the prompt is non-empty, or an
   `isLens` tag with `collects !== false`. The gate is on when at least one collecting lens exists; then `collect` is
   true when **any collecting** lens reaches `STRICTNESS_THRESHOLDS[gate.strictness]`. A non-collecting lens is still
   scored (it sorts) but never collects. No collecting lens: gate off, collect everything.
5. **"Matched" is one test, one function:** a lens matched a post when its score ≥ that same threshold.
   `lib/decision/lenses.js` exports it (`isLensMatch(score, configuration)`), plus `userLenses(configuration)`,
   `lensThreshold(configuration)`, `matchedLenses(decision, configuration)` and `lensScoreLabel(score)` =
   `Math.round(score × 100)` (📐 D-3's one function). The panel's pill count, list and chips all use it (P-2).
6. **Escalation:** a lens question below its floor is uncertain like `matches_prompt` today; one post's
   uncertain lens questions go in its **one** call to the **one** primary provider (DEC-5), at most 10 lenses.
7. **A user tag is both a lens and a label** (DEC-6, owner 02:27, superseding this rule as built in `5090b29`):
   `isLens` tags stay in tag classification exactly as before ENG-1 (tag questions, `primary_tag`, tag nouls,
   `rankTags`, `decision.tags`, `assignedTag`, dynamic-tag matching), whatever their `collects`. Built-in and dynamic
   tags unchanged. `pMatch` = the `main` lens's score. Manual overrides keep their tag
   (`lib/pipeline/redecide.js:19,134`). Known: a post's label comes from tag classification and its chip from the lens
   score, two signals that can disagree (sent to 📐 Design).
8. **Migration:** `SCHEMA_VERSION` 2 → 3. Configuration: existing user-added tags get `isLens: true` (rule 1:
   not a built-in label, not dynamic, not pseudo, not Ads) and **`collects: false`** (labels only): before lenses a
   tag never collected, so every collected set is unchanged, master on or off (DEC-6 `cdd1490`, Bar Raiser F3). New
   tags from `TAG_ADDED` get `collects: true` (the owner's default). Manual overrides are never marked for backfill. Stack: posts without `decision.lenses` are marked
   for a lens backfill and re-scored by the existing re-decide job under the state lock, System 1 only, no
   escalation, no cloud. Idempotent.
9. **Re-decide on prompt change:** adding, removing, enabling, renaming or editing a lens's prompt changes
   `decisionFingerprint` and re-decides, as the match prompt does today.
10. **`userLenses(configuration)`** returns one ordered array: `main` first (when the match prompt is non-empty),
   then enabled `isLens` tags in configured order, each `{ id, label, text, collects }` (`label` null for `main`;
   `text` the prompt, a blank tag prompt being the stored default "Find posts related to <label>."; `collects` true
   when that lens is collecting per rule 4). A new message sets one tag's `collects` (🧷 Extension wires the switch). No colour is stored: the
   panel derives it (`getTagColor`, `sidepanel.js:1775`). 📐 D-1's Settings list and D-2's row read this.

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
| A lens with `collects: false` is scored and labels but never collects; flipping it re-decides | unit tests; seen failing on `5090b29` |
| User tags label as before ENG-1 (assignedTag / decision.tags), whatever `collects` | unit test; `e2e/tags.spec.mjs:25` result reported |
| Migration sets `collects` from the master gate; an upgrade newly refuses nothing | unit test + the grid's "newly refused" column |
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

## ENG-3 · Meet the System 1 tag gates without fitting to them (DEC-9)

### Opening (🧪 Testing's measurement at `ee68247`, not re-run by Engineering yet)
`scratchpad/team/runs/testing/2026-10-11-release-leg.md:139-160`, `test:eval --assert --check-calibration`, exit 1
on tag gates only; same values as `eval/reports/2026-10-10-system1.md`:

| Gate (`eval/run-eval.mjs`) | Target | minilm | bge-small |
|---|---|---|---|
| tag top-1 | ≥ 0.70 | 0.675 FAIL | 0.636 FAIL |
| tag top-3 | ≥ 0.90 | 0.896 FAIL | 0.870 FAIL |
| tag ECE (5-fold CV) | ≤ 0.08 | 0.067 pass | 0.083 FAIL |

Every collection (`matches_prompt`) gate passes on both models. The report already names one suspect: the food and
false-friend posts carry genre labels (News / Personal Opinion / Blog) that are judgement calls (report line 46).

### Method
1. **Probe first (research tier, read-only):** a per-tag confusion table for both models, which built-in tags the misses
   fall on, and how many misses sit between genre tags. Re-run the eval in a clean worktree at HEAD before citing it.
2. Fix only what moves real accuracy: tag descriptions in `lib/bg/defaults.js`'s prompt text, the tag score recipe or
   label aggregation (`tag.score`, `tag.agg` in the calibration), lexical boost. Each change evaluated by the existing
   5-fold cross-validation; never chosen by looking at the gate's own fold.

### Non-goals and refusals
| Not in ENG-3 | Reopen when |
|---|---|
| Lowering a gate or dropping posts from the gate set | never by Engineering: a re-measured gate goes through 🧪 Testing's register (DEC-9) |
| Refitting on the full set and reporting the in-sample number | never: that is fitting to the gate |
| Counting Gemini Nano's re-asks as System 1 accuracy | never: the gate measures System 1 |
| Any outward sentence about tag accuracy | the gates are green (DEC-9 binds the listing, README and store) |

### Gates
| Gate | Evidence |
|---|---|
| All three tag gates green on both models | `npm run test:eval -- --assert --check-calibration` exit 0 in a clean worktree, output pasted |
| No collection gate regresses | the same run; matches_prompt rows compared with the 2026-10-10 report |
| A new report, the old one kept | `eval/reports/<date>-system1.md`; 2026-10-10 left as written |

---

## Record (appended, never edited over)
- 2026-10-11 01:30 +0600 · ENG-1 amended after DEC-6's addendum (CEO, `da92dc5`): lenses are user-written prompts
  only. ~~Lens keys `"prompt"` / `"tag:<label>"`, scored by the tag noul, System 1 scoring every enabled tag~~ →
  keys by id (`main`, user tag id), scored by the match question and match calibration (eval ECE, rule 3);
  built-in tags untouched. Answers 📐 Design's D-2/D-3 questions (rules 4-5, non-goal on "%").
- 2026-10-11 01:30 +0600 · ENG-2 working size revised: 📐 D-4 grows to 240 CSS px (about 480 px at 2×), so the
  draft's 160 px / 12 KB is too small for a sharp grown view. Measure WebP at 320 and 480 px before ruling; the cap
  keeps a full 2,000-post stack under 64 MB.
- 2026-10-11 01:55 +0600 · ENG-1 rule 7 changed on 📐 Design's ask (D-1 record 01:40): ~~"Additive: `decision.tags`,
  `decision.tag`, `assignedTag` keep their meaning … No current reader changes in this slice."~~ → lens tags leave tag
  classification, so a post is never filed under a prompt and shown with no footer tag. Rule 10 added (`userLenses`
  shape). The build worker was steered with the change mid-run.
- 2026-10-11 02:40 +0600 · ENG-3 probe (research tier, read-only; log `scratchpad/team/runs/engineering/2026-10-11-eng3-probe.md`,
  per-post dumps of ids and labels only in `…/engineering/eng3/`). Its own eval re-run at `14cfa23` reproduces Testing's
  opening exactly (minilm top-1 52/77, top-3 69/77; calibrations identical). Short by 2 / 1 posts (minilm) and 5 / 3
  (bge-small). **Cause:** 22 of 77 gate posts have a genre primary (News, Ad, Opinion…): top-1 0.455 on both models
  there, against 0.764 / 0.709 on the 55 subject-primary posts. The embedding ranks what a post is about, not what kind
  of post it is. **Tried under the same 5 folds, none moves top-3:** config chosen on topic posts, cue-style descriptions
  for the 5 worst genre tags, fold-trained prototypes, no lexical boost. Fitting `none` on prefilter-passing posts: +2
  top-1 each, top-3 flat, minilm ECE 0.087 FAIL; refused alone (premise holds only with the gate on, `cascade.js:679`).
  **Next, untested:** a genre cue signal outside the embedding, cues committed before any run, weight chosen inside each
  training fold, also tested on a fresh tag-coverage set by another author; refused if cues come from golden post text.
  **For Testing (findings, not softening):** strict top-1 marks a listed second tag wrong with no written primary rule;
  one post = 1.3 points and the 95 % interval is ±0.105 (checked: `sqrt(.675·.325/77)·1.96`), so the gate cannot tell a
  2-3 point gain from fold noise. DEC-9 stands: the gates stay red and nothing outward claims tag accuracy.
- 2026-10-11 02:45 +0600 · ENG-1 amended for the owner's per-prompt collect switch (DEC-6, `591499d`). Rule 4: the gate
  counts only *collecting* lenses (`collects`, absent = true; `main` collects while its switch is on). Rule 7 as built
  in `5090b29` ~~"`isLens` tags leave tag classification"~~ → user tags label exactly as before ENG-1. Rule 8: migration
  sets `collects` from the master gate so an upgrade starts no filtering (for CEO/owner review); new tags default on.
  Rule 10: `userLenses` entries carry `collects`. Gates added.
- 2026-10-11 03:00 +0600 · 🧭 CEO ruled (DEC-6 02:58 addendum): the collect switch stays as built in `1b9bdfd`. A
  collecting tag filters with the master switch off (the master prompt is one prompt with one switch); migration keeps
  `collects` = the old gate state. Reopens if the owner's local trial surprises them.
- 2026-10-11 03:50 +0600 · **ENG-3 defect: label and lens score contradict on a user prompt** (seen in the owner trial
  build, `d68d5c0`, Chrome for Testing, real System 1; log `scratchpad/team/runs/engineering/2026-10-11-owner-trial-build.md`).
  A user tag "Food" with prompt "restaurant and fine dining posts": synthetic posts food-02 and food-17 were **labelled
  Food** by the tag classifier (`assignedTag`) while the Food lens scored them **0.09 / 0.08**; switching Food to
  collect then hid them (any-collecting-prompt gate, threshold 0.5). Same text as the master prompt (the 0.10.0 path)
  scores 0.09 / 0.08 too, so the lens path is not at fault; the two signals come from different calibrations (ENG-1
  rule 3 vs the tag softmax), as rule 7 predicted. **Question for evidence (CEO, DEC-6 if users see a change):** should
  a user prompt that is also a tag label from its own lens score (label when score ≥ the shared threshold) instead of
  the tag softmax? **Measurement, fixed before running:** the 5 eval prompts (restaurant, coding, jobs, immigration,
  climate) each added as a user tag beside the 25 built-ins; on the golden posts with that prompt's yes/no labels
  (borderline excluded, as the eval does), compare (a) tag classifier assigns that tag vs (b) lens score ≥ 0.5, by
  precision, recall and disagreement rate, both models, leave-one-prompt-out as the eval's match numbers are. No
  calibration refit; no prompt wording tuned on the result.
- 2026-10-11 04:30 +0600 · **Result of the pre-registered label-vs-lens measurement** (research tier; log
  `scratchpad/team/runs/engineering/2026-10-11-eng3-label-vs-lens.md`; pooled totals re-derived by me from its saved
  results with its `analyze.py`: n = 701 post × prompt pairs, 52 yes, minilm disagreements 31, label right 17, lens 14).
  Proxy: golden yes/no, synthetic + 7 held-out posts, borderline excluded, System 1 only.
  | Model | Label path (tag classifier) P/R/F1 | Lens path (≥ 0.5) P/R/F1 |
  |---|---|---|
  | minilm | 0.71 / 0.90 / **0.80** | 0.76 / 0.71 / **0.73** (deployed = LOPO) |
  | bge-small | 0.76 / 0.92 / **0.83** | 0.77 / 0.69 / **0.73** deployed; 0.66 / 0.67 / 0.67 LOPO |
  **Ruling: labels stay with the tag classifier** (no change to what users see). The trial's Food posts are restaurant
  = yes: the label was right and the lens wrong. **The real defect is lens recall under prompt wording:** the same two
  posts score 0.09 / 0.08 with "restaurant and fine dining posts" and 0.9995 / 0.9886 with the eval's restaurant prompt,
  and the lens path recalls 0.69-0.71 against the label's 0.90-0.92, so a briefly worded *collecting* prompt hides
  relevant posts. Caveat: the tag calibration was fitted on these synthetic posts (built-in tags only), so the label
  path may be flattered; 7-8 yes posts per prompt except restaurant (23); no intervals.
  **Candidates (each to be pre-registered before any run; each changes what users see, so 🧭 CEO's under DEC-6):**
  (1) a collecting prompt also collects posts the tag classifier files under it (gate = lens OR label); (2) expand each
  user prompt like the master prompt's `matchPromptExpansion` (eval recipe D, best when an expansion exists) via the
  built-in model only (DEC-4); (3) prompt-writing guidance in the panel (words: CEO, form: Design).
- 2026-10-11 04:50 +0600 · **PRE-REGISTERED (🧭 CEO ruling 04:45): candidates (1) gate = lens OR label and (2) auto-expanded
  user prompts. Written before any data exists; not to be moved after a run.**
  - **Data:** only posts no calibration has seen: 🧪 Testing's second-author set, labelled yes / no / borderline against
    user prompts (borderline excluded), each prompt with a stand-in expansion written by the same author **before any
    scoring** (the eval's stand-ins exist only for its own 5 prompts, `eval/run-eval.mjs:875`). Nothing from
    `eval/golden/posts.*` is used for judging. Minimum: **≥ 40 yes and ≥ 40 no posts pooled**; below that the result is
    reported as **inconclusive** and nothing is adopted.
  - **Fixed settings:** committed calibration files; strictness balanced (0.5); both models; System 1 only (no
    escalation). Candidate (2) uses recipe D with its (a, b) fitted **only on `eval/golden/posts.synthetic.jsonl`** with
    the eval's own stand-in expansions, before the fresh set is opened.
  - **Baseline:** the current gate (a collecting user prompt collects when its lens ≥ 0.5), on the same posts.
  - **Rule, per candidate, judged separately:** adopt only if, on **both** models, pooled recall rises **≥ 0.10**
    (absolute) over the baseline **and** pooled precision falls **≤ 0.05** (absolute). Counts (TP / FP / FN) reported
    with every rate. For (2) also: with the expansion missing (no built-in model) the result must **equal the
    baseline**, post for post; any difference fails (2).
  - **Stated limits, in advance:** (2) measures hand-written stand-ins, not Gemini Nano's text; real Nano expansions stay
    unverified until measured on a machine that has the Prompt API. The label path in (1) uses the tag calibration,
    which never saw the fresh posts, so (1) is judged out of sample.
- 2026-10-11 05:20 +0600 · **Candidate (2) calibration FROZEN before the held-out set is opened** (research tier, log
  `scratchpad/team/runs/engineering/2026-10-11-eng3-recipe-d-freeze.md`; file
  `scratchpad/team/runs/engineering/eng3-gate/recipe-d-frozen.json`, sha256
  `bb9dcaf1127f94fa4b751155d296b194637e095e767cc6f3114314b875a42042`, hash checked by me). Recipe D, all 5 eval prompts,
  `posts.synthetic.jsonl` only (sha256 `a22f06d7…7598`), 667 pairs / 52 yes, the harness's own `fitMatch`/`floorFor`:
  minilm a = 0.918432590450233, b = −6.2258135455003325, floor 0.68; bge-small a = 1.2679051603436795,
  b = −7.761974399915981, floor 0.58. Sanity: recipe tables identical to `2026-10-10-system1.md`. Finding (not acted on):
  bge-small `jobs` held out under D has ECE 0.103 (> 0.08). **Fixed now, before opening the held-out set:** the gate
  label in (1) is `assignedTag` (the classifier *files* the post under the prompt); "in `decision.tags`" is reported
  beside it and does not decide. (2) is judged with the calibration switching by expansion presence (D when the
  expansion exists, the deployed B when it is missing, equal to the baseline by construction); "D calibration
  everywhere" is reported beside it and does not decide.
- 2026-10-11 (commit `0833c13`, 04:08:05 +0600) · **Correction to this Record's times:** the clock times written on the
  Record lines from "01:30" onward were typed by hand and ran ahead of the real clock (the "05:20" freeze line was
  committed at 04:08:05). **The commit timestamps are authoritative** (`git log --format='%h %cI %s' --
  docs/team/engineering-goals.md`). In particular, the candidate (2) freeze is `0833c13` at 04:08:05 +0600, and the
  held-out set is opened only after it. Lines left as written; this line corrects them.
- 2026-10-11 (after `22ec658`) · **RESULT of the pre-registered gate measurement: neither candidate adopted.**
  Held-out set (🧪 Testing team, second author): 7 user prompts (5 short), 113 posts, 769 pairs per model after
  22 borderline excluded, 67 yes / 702 no. sha256 re-checked by me, full match with Testing's log (genre `38aedfac…76c8`,
  labels `ceb6372e…71fd`, posts `650930fc…9eb4`, prompts `7cbb850b…60cc`). Measurement by the research tier (log
  `scratchpad/team/runs/engineering/2026-10-11-eng3-gate-measurement.md`); the pooled table re-derived by me from its
  per-pair rows with my own script. Proxy: second-author yes/no, System 1 only, strictness balanced.
  | Model | Baseline (lens ≥ 0.5) TP/FP/FN · P · R | (1) lens OR label | (2) recipe D (frozen) |
  |---|---|---|---|
  | minilm | 26/3/41 · 0.897 · 0.388 | 58/22/9 · 0.725 · 0.866 | 30/3/37 · 0.909 · 0.448 |
  | bge-small | 25/0/42 · 1.000 · 0.373 | 55/13/12 · 0.809 · 0.821 | 24/0/43 · 1.000 · 0.358 |
  (1): recall +0.478 / +0.448, precision −0.172 / −0.191 → **fails** the ≤ 0.05 precision limit. (2): recall +0.060 /
  −0.015 → **fails** the +0.10 recall bar; expansion missing equals the baseline on 0 of 769 differing verdicts. The rule
  is not moved. **Outside the rule, deciding nothing:** on user-style prompts the lens alone recalls ~0.38 (0.71 / 0.69 on
  the eval's own prompts); the shipped cascade's `whenUnsure: collect` adds 28-29 pairs (P 0.776 / 0.906, R 0.672 /
  0.716). The shipped cascade never passes a user prompt's expansion (`cascade.js:253-254`); (2) was simulated in the
  harness.
- 2026-10-11 (after `dac2b55`) · **Prompt shape evidence for candidate (3), for 📐 Design** (descriptive, not pre-registered,
  decides nothing; from the held-out per-pair rows, prompt ids only because the set is private). Lens-only recall
  (≥ 0.5) per held-out prompt, minilm / bge-small, with word count: invest 3w 0.12 / 0.12 · space 2w 0.20 / 0.60 ·
  ev 5w 0.33 / 0.22 · cycling 4w 0.36 / 0.55 · burnout 4w 0.50 / 0.40 · housing 7w 0.90 / 0.50 · **languages 13w
  0.22 / 0.11**. Eval prompts (in-sample for the calibration): jobs 4w and coding 6w worked; restaurant 16w worked.
  **Finding: length does not predict recall here.** The longest held-out prompt is among the worst; short prompts span
  0.12-0.60. ~~"0.09 short versus 0.99 full" as a general rule~~: one prompt (restaurant), not a pattern. What the data
  does support: recall varies by prompt from 0.11 to 0.90 and cannot be predicted from length, so a user needs to
  **see how a prompt is doing** (e.g. how many posts it matched, or a near-miss count just under the line), not only
  a writing rule. Limits: 7 prompts, 8-11 yes posts each, one author.
- 2026-10-11 (before opening `holdout-2026-10-11.genre.private.jsonl`) · **PRE-REGISTERED: genre cues for the tag gates
  (ENG-3 hypothesis 1).** Written by ⚙️ Engineering from general knowledge of how each genre is worded, **without reading
  any golden or held-out post text**; committed before the genre set is opened. Not to be edited after a run.
  - **Genre tags** (the probe's definition): News, Personal Opinion, Blog, Vlog, Release, Promotion, Ad, Product
    Showcase, Portfolio, Events. Every other tag is untouched.
  - **Cue words** (single words; the shipped `lexTerms` stems them and drops its stop words):
    News: breaking, report, reported, according, announced, official, officials, statement, sources, confirmed, press ·
    Personal Opinion: opinion, think, believe, unpopular, honestly, disagree, agree, feel, perspective, imho ·
    Blog: blog, article, wrote, writing, read, medium, substack, newsletter ·
    Vlog: vlog, video, watch, youtube, episode, subscribe, channel, filmed ·
    Release: release, released, version, changelog, available, launch, launched, rollout, beta ·
    Promotion: discount, offer, sale, code, deal, coupon, giveaway, free, save, limited ·
    Ad: promoted, sponsored, shop, buy, order, enroll, trial ·
    Product Showcase: introducing, meet, features, demo, showcase, prototype, built ·
    Portfolio: portfolio, project, client, dribbble, behance, selected, casestudy ·
    Events: event, conference, webinar, register, join, venue, tickets, rsvp, summit, meetup.
  - **Mechanism:** the cue words are appended to those ten tags' lexical terms (`labelLexTerms`), so they enter the
    existing `lexicalOverlap` bonus; β (and cap 3) selected by the harness's own procedure **inside each training fold**;
    no other change (no description edits, no recipe change, no refit of anything else).
  - **Evaluation:** (A) the golden tag-coverage set under the eval's own 5-fold CV (the numbers DEC-9's gates read);
    (B) the genre set (37 posts) out of sample, **nothing chosen on it**. Truth on (B) = the tag the set's author marked
    primary (strict top-1, as the gates); "any listed tag" reported beside, not deciding.
  - **Adopt iff, on BOTH models:** (B) strict top-1 rises by ≥ 4 posts of 37 (≈ 0.11) over the current code and top-3
    does not fall; (A) top-1 and top-3 do not fall and tag ECE rises by no more than 0.01; every match gate row is
    unchanged. Otherwise not adopted. Whether DEC-9's gates turn green is reported separately and is **not** the adoption
    bar. Re-hash the genre set (`38aedfac470c8e655607da1d21633a70dcf60795fdf1e81d6998d0252ade76c8`) before reading it.
- 2026-10-11 (after `5293ccc`) · **RESULT, genre cues (hypothesis 1): NOT ADOPTED.** Research tier, log
  `scratchpad/team/runs/engineering/2026-10-11-eng3-genre-cues.md`; I re-hashed the genre set (`38aedfac…76c8`, match),
  recounted (B) from the per-post rows and read (A) from the saved gate outputs: both match. Baseline reproduced the
  2026-10-10 report exactly.
  | Model | (A) golden 5-fold CV top-1 / top-3 / tag ECE, before → after | (B) genre set top-1 / top-3 of 37, before → after |
  |---|---|---|
  | minilm | 52 → 55 / 69 → 70 / 0.067 → **0.082** | 22 → 23 / 34 → 33 |
  | bge-small | 49 → 46 / 67 → 66 / 0.083 → **0.114** | 20 → 19 / 33 → 34 |
  Fails on both models: (B) needs +4, got +1 / −1; minilm ECE +0.015 (limit +0.01); bge falls on (A). Match rows
  unchanged. Under the cues minilm would pass top-1 and top-3 but fail ECE; bge fails all three. β chosen per fold
  (full-set β halved on both: 0.1945 → 0.0973, 0.0543 → 0.0271). Deviation, recorded: the run copied
  `posts.private.jsonl` so the "private max p" match row could reproduce; it feeds no tag number.
  **State of ENG-3's tag gates:** four honest System 1 variants and one pre-registered cue list have failed; the minilm
  gain (3 posts) sits inside the ±0.105 band at n = 77. Remaining levers are outside the embedding (Nano's re-ask of
  uncertain tags, unmeasured here without the Prompt API) or the gate's definition (Testing's register: the "any
  listed tag" row already reads 0.792 / 0.779). Parked pending 🧭 CEO.
- 2026-10-11 (commit `3c4fac1` on `feat/prompt-lenses`) · **Rule 8 corrected** on ⚖️ Bar Raiser finding F3 and 🧭 CEO
  `cdd1490`: ~~"`collects` = whether the master gate was on … an upgrade never starts filtering"~~. Its premise missed
  *widening*: with the master on, every migrated tag collected, so tag-only posts hidden before were collected after.
  Now `collects: false` for every migrated tag. Guard `test/unit/lenses-migration-guard.test.js` (post-migration
  collected set = pre-migration set) fails 3 of 5 on `4f9eca6`, passes 5 of 5 on `3c4fac1`; unit 842/842,
  e2e migration + lenses-collect 5/5 (my runs). F2 (three stale gate comments) and F4 (manual items never marked)
  fixed in the same commit.
- 2026-10-11 (after `8830d84`) · **ENG-2 started; PRE-REGISTERED before any measurement or code.** Base: a branch off
  origin/main `10e744a`. Form: DESIGN.md D-4 (48 × 48 px thumbnail, grows to `min(240px, panel − 48px)`, shows only
  the stored image, no image = no box). Split by file: capture (`content.js`, `lib/content/`) is 🧷 Extension's team,
  called once the data shape below is fixed; fetch, shrink, store, delete and the pipeline are Engineering's.
  - **Data shape (fixed now):** the content script sends at most one image URL per post (`imageUrl`, the post's own
    first content image, never an avatar, logo or favicon; http(s) only). The background fetches it once, at capture
    time, `credentials: 'omit'`, no referrer, with a deadline; decodes with `createImageBitmap`; shrinks on an
    `OffscreenCanvas` to the edge chosen below; encodes WebP; stores the bytes in IndexedDB keyed by item id, **outside
    the locked stack**; sets `item.thumb = { key, w, h, bytes }`. Deleted with its post and on eviction. Never sent to
    any provider (DEC-5): it never enters a decision request. Any failure: no `thumb`, the post is unchanged. The fetch
    queue is bounded (trap `6dcd335`).
  - **M1 · size (decides edge and quality):** on a corpus of photo-like post images (source to be approved by the owner
    before download; never golden or private data), WebP byte size at longest edge **480 px and 320 px**, quality
    ladder 0.8 / 0.7 / 0.6 / 0.5 / 0.4, in Chrome for Testing's own encoder. Report p50 / p95 / p99 per cell.
  - **Byte-cap rule (fixed now):** storage budget 64 MB for a full 2,000-post stack ⇒ hard ceiling **32 KB**.
    Choose **480 px** if some quality ≥ 0.5 has p95 ≤ 24 KB, else 320 px under the same test, else 320 px at 0.4.
    Take the highest such quality. **Cap = min(32 KB, p99 at the chosen setting rounded up to the next KB).** At capture,
    an image over the cap is re-encoded down the ladder; still over at 0.4 ⇒ no thumbnail. Not moved after M1 runs.
  - **M2 · fetch works without the page's cookies:** measured only on live feeds (LinkedIn, X, YouTube) in the owner's
    Chrome after the build, by success rate per site. Below 80 % on a site: report to 🧭 CEO, no workaround that sends
    cookies.
  - **M3 · cost:** fetch → decode → encode → store, per image, in Chrome for Testing on served fixture images; p95 ≤
    150 ms and never on the content script's thread; else the queue is throttled, not the cap moved.
  - **Listing (DEC-2):** no new manifest permission (`<all_urls>` and `unlimitedStorage` already cover it), but the
    host-access justification gains "fetches the post's preview image from the site's own image server", the
    `unlimitedStorage` line gains thumbnails, and the data-use "Website content" row gains "a small preview image".
    That widens what the listing says ⇒ 🧭 CEO before it lands; edited in `docs/STORE-LISTING.md` in the same commit.
- 2026-10-11 (after `54c1d6b`) · **ENG-2 M1 amended by 🧭 CEO ruling** (the owner had approved a download; the CEO ruled
  none, and the owner was told). ~~"a corpus of photo-like post images (source to be approved by the owner before
  download)"~~ → **M1 runs with M2 on the trial build in the owner's Chrome, from feed images the browser loads
  anyway.** For every captured image the trial records, on the device, the WebP bytes at **480 px and 320 px** for each
  ladder quality (0.8 … 0.4), plus the site host and source dimensions (no image bytes, no URL path). The edge and
  quality are then chosen by the **unchanged** byte-cap rule. Until then the trial stores 480 px, walking the ladder
  down, then 320 px, under the **hard 32 KB ceiling**; over it at 320 / 0.4 ⇒ no thumbnail. Unit tests use synthetic
  images generated locally (no network). Listing widening approved by the CEO as worded (+ the same sentence in
  PRIVACY.md), landing only in the release that ships previews, on that release's branch: `docs/STORE-LISTING.md` and
  `docs/PRIVACY.md` on main stay as 0.11.0 ships.
- 2026-10-11 (commits `0ea9017`, `b13a446` on `feat/image-previews`) · **ENG-2 trial built.** Unit 990/990 uncached,
  test.mjs 18/0, build 99 files, e2e 42/42 (my runs, node v24.14.0). Probe in Chrome for Testing (served LinkedIn-style
  feed, photo from a real local HTTP server): 2 of 2 photo posts got a 480 × 320 WebP of 28,736 B, the photo-less post
  none; the extension's fetches carried no Cookie or Referer; the panel showed two 48 px thumbs from `blob:` URLs and the
  D-4 grow on hover. **M3 (CfT, synthetic):** p95 175 ms > 150 ms ⇒ concurrency 1 (rule: throttle, never move the cap).
  Rulings during the build: orphan sweep at startup (`listThumbKeys`); a post sent before its image loads is re-sent once
  and fetched at most once (`thumbAttempted`). Known gaps: a worker killed mid-fetch may retry a post once. For 📐 Design:
  the grown view also closes on scroll (not in D-4). Next: the owner browses LinkedIn / X / YouTube on the trial; M1
  (sizes at 480/320 per quality) and M2 (fetch success per site) are read from `THUMB_MEASUREMENTS_GET`, and the cap is
  set by the pre-registered rule.
