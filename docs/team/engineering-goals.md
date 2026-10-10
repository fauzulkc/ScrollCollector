# Engineering goals: ScrollCollector

**Kept by ⚙️ Engineering.** The conditions under which Engineering may claim a product gate green. They
never reorder a decision in [DECISIONS.md](../DECISIONS.md); where a goal and a decision disagree, the decision wins.
Ids are `ENG-n`; grep for the next free number immediately before adding one. Corrections are appended with a
date, never written over.

| Goal | For decision | State |
|---|---|---|
| **ENG-1** · lenses data model | DEC-6 | green 2026-10-11: `5090b29` + `1b9bdfd` + `2da7ff5` (schema v3) on `feat/prompt-lenses`, unit 836/836, e2e 42/42 (my runs); awaits ⚖️ Bar Raiser; merge after the store submission |
| **ENG-2** · thumbnail fetch, shrink and byte cap | DEC-7 | draft plan; queued after ENG-1 (DEC-8) |
| **ENG-3** · meet the System 1 tag gates honestly | DEC-9 | probe done 2026-10-11: gates hold red; no honest change found yet (see Record) |

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
   not a built-in label, not dynamic, not pseudo, not Ads) and **`collects` = whether the master gate was on**
   (`isGateOn` at migration time): an upgrade never starts filtering for a user who was collecting everything. New
   tags from `TAG_ADDED` get `collects: true` (the owner's default). Ruled as built: DEC-6 02:58 addendum. Stack: posts without `decision.lenses` are marked
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
