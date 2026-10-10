# Prompt lenses (DEC-6), with image previews queued behind (DEC-7)

**Written by the 🧭 CEO, 2026-10-11.** The ruling is in `docs/DECISIONS.md` (DEC-6, DEC-7, DEC-8);
this file holds the argument and the scope each seat builds to. Where it and the rows disagree, the rows win.

## What the owner asked for
"I want to be able to use multiple prompts to match against and sorted according to my prompt specific
match. This will help me to get the matches that matched the prompt exactly. How does the UI show me this,
should I have multiple workspace or how would i know which item was captured for which prompt?"
Chosen: lenses now, workspaces later only if collections need keeping apart.

## What exists (measured 2026-10-11 at eb720a3)
- One match prompt is a gate: posts that do not match are hidden (`lib/pipeline/apply-decision.js:38-40`).
- Up to 10 tags, each with its own prompt (`trackedTags[].prompt`, `lib/decision/questions.js:92-109`).
  System 1 scores only the top 3 tags per post (`system1-math.js:535`), only scores >= 0.5 survive, at most 3
  (`rankTags`, `lib/decision/cascade.js:344-365`; pointer corrected 2026-10-11 after ⚙️ Engineering's objection),
  and the post is filed under one `assignedTag`.
- The side panel's tag pills count by `assignedTag` only, and the list is sorted newest first (`sidepanel.js:944`).
What is missing is a score per user prompt on every post, showing every match, and sorting by it. Corrected 2026-10-11
01:40: this line first read "a tag already is a second prompt". Lenses are scored like the match prompt instead,
because its calibration passes and the tag calibration does not (DEC-6 record; `eval/reports/2026-10-10-system1.md:40-41`).

## Scope (what "lenses done" means)
1. Every prompt's score is kept on every post, below 0.5 too (⚙️ Engineering owns the shape and the migration).
2. A post is collected when **any** prompt matches (the gate becomes "any lens").
3. Choosing a lens lists every post that matched it, sorted by that lens's score, strongest first.
4. Each card shows the prompts it matched and how strongly; "All" stays newest first.
5. Stays inside DEC-3..5: one System 1 embedding per post compared with each prompt; Nano and the cloud only for
   uncertain posts, and their cost per prompt is visible in Diagnostics.

## Open for the seats (theirs, not the CEO's)
- 📐 Design: whether the user sees "prompts" or "tags" (or both merge), the lens bar, the strength badge, and the
  card in one pass with the image preview (DEC-7). Spec in `docs/DESIGN.md`.
- ⚙️ Engineering: storing every score, the any-match gate, re-decide on prompt changes, the migration of stored posts,
  the thumbnail's fetch, shrink and byte cap (DEC-7).
- 🧷 Extension: the panel, on branch `feat/prompt-lenses`; nothing merges before the release is submitted (DEC-8).
- 🧪 Testing: what green means for lenses (sort order by score, any-match gate, migration) before the build starts.

## Not in scope
Workspaces (parked, DEC-6 reopen condition). Images before lenses land (DEC-8).
