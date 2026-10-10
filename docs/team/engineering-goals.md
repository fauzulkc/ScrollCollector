# Engineering goals: ScrollCollector

**Kept by ⚙️ Engineering.** The conditions under which Engineering may claim a product gate green. They
never reorder a decision in [DECISIONS.md](../DECISIONS.md); where a goal and a decision disagree, the decision wins.
Ids are `ENG-n`; grep for the next free number immediately before adding one. Corrections are appended with a
date, never written over.

| Goal | For decision | State |
|---|---|---|
| **ENG-1** · lenses data model | DEC-6 | ruled 2026-10-11 (wire shape below); build not started |
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

### Ruled (Engineering's; not the worker's to revisit)
1. **Field:** `decision.lenses`, an object `{ [lensKey]: score }`, scores rounded to 4 places, **every enabled lens
   present, below 0.5 too**. `lensKey` is `"prompt"` for the match prompt (when it is non-empty) and `"tag:<label>"`
   for each enabled, non-pseudo tag, the same keys the cascade already uses. Keyed by label, like the rest of the
   cascade; a rename goes through `lib/pipeline/relabel.js`, which must rename the key.
2. **Source of truth for a score:** the calibrated independent noul: `matches_prompt` for `"prompt"`, `tag:<label>`
   for a tag. An escalator's noul replaces System 1's for the lenses it answered (as today). **Never the softmax.**
3. **System 1 scores every enabled tag** (`tagNoulsTopK` = number of enabled tags, at most 10).
4. **Any-lens gate:** with the gate on, `collect` is true when **any** lens score reaches the strictness threshold.
   With the gate off, unchanged (collect everything).
5. **Additive:** `decision.tags`, `decision.tag`, `assignedTag`, `pMatch` keep their current meaning and shape;
   no current reader changes in this slice. The panel's sort reads `decision.lenses` (🧷 Extension's slice).
6. **Migration:** `SCHEMA_VERSION` 2 → 3. Stored posts without `decision.lenses` are marked for a lens backfill
   and re-scored by the existing re-decide job under the state lock, System 1 only, no escalation, no cloud.

### Rejected implementations
- Back-filling `lenses` from stored `decision.tags`: the scores below 0.5 were discarded, so the result is partial and false.
- Using `primary_tag.probabilities` as lens scores (competing softmax).
- Any second embedding call per lens; any new storage key per post for scores.
- A skipped or loosened test to get the existing suites green.

### Non-goals (each with its reopen condition)
| Not in ENG-1 | Reopen when |
|---|---|
| Escalating more than 3 tag nouls per post | the cost-per-prompt view in Diagnostics (DEC-6 item 5) shows uncertain lenses going unanswered |
| Stable tag ids instead of labels as keys | a rename is measured to lose lens scores after `relabel.js` is updated |
| Panel, lens bar, badges | never in this goal: 🧷 Extension, to 📐 Design's spec |
| Workspaces | DEC-6's reopen condition |

### Gates (Engineering may call ENG-1 green only on pasted output)
| Gate | Evidence |
|---|---|
| Every enabled lens has a score on every decided post, below 0.5 included | unit test on the cascade with 5 tags; seen failing on `topK = 3` |
| Any-lens gate: a post matching only a tag lens is collected with the gate on | unit test; seen failing against today's gate |
| Migration v2 → v3 is idempotent and a backfilled post's lenses equal a fresh decide | unit test on `migrateState` + re-decide |
| Changing one tag's prompt re-decides and changes that lens's scores | unit test on `decisionFingerprint` + re-decide |
| No regression | `npm test` and `npm run test:e2e` green uncached, counts in the commit |
| Decision core unchanged in quality | `npm run test:eval` re-run; report compared with `eval/reports/2026-10-10-system1.md` |
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
   160 px longest edge, encodes WebP (JPEG fallback), and lowers quality until it fits the cap.
2. **Cap, proposed: 12 KB per thumbnail**, so at most about 24 MB for a full 2,000-post stack. Over the cap at the
   lowest quality: no thumbnail.
3. Stored **outside the stack** (IndexedDB, keyed by item id), so the locked stack write does not grow; deleted with
   its post and on eviction.
4. Failure of any step leaves the post without an image; never retried against an expired link.

**To measure before ruling:** the size distribution of real LinkedIn/X thumbnails at 160 px; whether service-worker
`fetch` of the CDN images works without the page's cookies; fetch-to-store time per image.
