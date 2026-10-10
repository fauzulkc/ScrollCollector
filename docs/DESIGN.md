# Design: ScrollCollector

**Kept by the 📐 Design seat** (`docs/team/design.md`). This register holds the numbered design rulings
and citable patterns for the side panel and its views; a ruling binds whoever builds a surface (the 🧷
Browser-extension engineer implements). Each ruling is a dated entry with the measurement and render that
forced it, its reproduction command, and the escalation outcome; a correction fixes the operative line in
place and appends the record. Only Design edits the operative text; others propose. A decision in
`docs/DECISIONS.md` outranks this file. **State (2026-10-11 01:50):** patterns P-1 to P-3, rulings D-1 to
D-5 (the prompt spec for DEC-6 as amended, the preview spec for DEC-7, the card time in the release).
Open with ⚙️ Engineering (as of 01:40): whether user-added prompts stay in tag classification (D-1), and
the measured image size (D-4). Answered: the user-prompt data (D-1) and the score's unit (D-3).
Next free numbers: **P-4, D-6**.

## How these were measured (2026-10-11, at `9bfb189`, `dist/ext` built 2026-10-10 22:24 after the last source edit)

- **Render:** `node scratchpad/design/render-panel.mjs` (the panel as it is, seeded, in Chrome for Testing
  through `e2e/helpers/launch.mjs`) and `node scratchpad/design/proto-lens.mjs` (the lens card prototype
  injected into the live panel; never shipped). Both run from the repo root in WSL after `npm run build:ext`.
  Images and `measure.json` go to `scratchpad/design/renders/` (not committed; re-run to reproduce).
- **Widths:** the panel opened as a tab at viewport widths 320, 400 and 560 px, dark and light. The real
  side panel's width range in Chrome is still UNVERIFIED; 320 is the narrowest rendered here.
- **Contrast:** computed colours composited over the resolved ancestor backgrounds, rounded to 8 bits,
  WCAG ratio. Opacity is composited by hand where noted. **Not measured:** the filter pills (their ground is
  a gradient `background-image`, which the script does not resolve; it reported 1.04 in light, a false
  reading of a proxy. The render shows them readable. Do not cite that number.)
- **Font:** system stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, …`); no web font to check.

## Patterns (cite as "per the register's P-n")

### P-1 · A claim is never faded (2026-10-11)
Any element that says what the system decided (a matched lens, a score, the time the "All" list is sorted
by) is set at **at least 4.5:1** resolved contrast against its actual ground, in both themes. Strength or
rank is shown by the number and the bar (D-3), **never by opacity, scale, a dashed border or a lighter
token**. A faded claim reads as "probably not", which is a claim the system did not make.
*Pin:* a real-browser test that resolves the colour (opacity included) and asserts the ratio. Weak pin: a
test that reads the stylesheet for `opacity`.

### P-2 · A count is the list it opens (2026-10-11)
A number on a filter pill equals **exactly** the number of cards shown when that pill is selected, under
the same search and site and author filters. Counts across lenses may sum to more than "All" (a post sits in
every lens it matched); no form may suggest they partition it (no stacked bar, no "of total", no percentages
of All).

### P-3 · A number is compared only where the system says it compares (2026-10-11)
Order, a shared axis, and side-by-side bars all invite the eye to compare. **Use them only between numbers
the system says are comparable.** For prompt scores, that means **within one prompt** (one prompt's score
across posts). It does **not** mean across prompts (two prompts' scores on one post).
**Measured.** `eval/reports/2026-10-10-system1.md`, Notes (line 282 at `562d77a`): one calibration
"transfers across prompts in ranking (AUROC near 1 everywhere) but not always in level". In its per-prompt
table, the held-out `climate` prompt has AUROC 1.00 but recall 0.00 at 0.5. ⚙️ Engineering relayed this
(inbox, 2026-10-11) and Design re-read it. Reopen if Engineering reports a calibration whose level
transfers across prompts.
*Pin:* on a card, the chips' order does not depend on their scores. Weak pin: checking that bars exist.

## Rulings

### D-1 · Two kinds, kept apart: prompts the user writes, and built-in tags (2026-10-11, amended 01:20)
**Ruling.** The user sees **two kinds of object, and never one dressed as the other.**
- **Prompts:** what the user writes. Each has a name and its text. Only prompts decide what is collected
  and only prompts are lenses (DEC-6 as amended). The noun is **"prompts"** everywhere the user reads it;
  "lens" is internal only.
- **Tags:** the built-in topic labels (25 by default). They label and filter. They carry no score on the
  card and never sit in the prompt row.
Settings shows the prompts as one list, each row with its name and its text. No second "Prompt filter"
control sits beside that list. The tags keep their own list.
**A prompt with no name** is shown by its own text, cut with an ellipsis at the pill's maximum width, with
the full text in its title. No invented name and no "Untitled".
**A prompt the user added as a tag (`isLens`) appears only as a prompt** (the prompt row, the prompt
chips, the prompts list in Settings). It never appears as a pill in the tag row or as a label in the card
footer, even when the code files a post under it as `assignedTag`. (Added 2026-10-11 01:40.)
**Measured.** Today the same idea appears under three names: the search placeholder says "tags", Settings
says "Prompt filter" (`sidepanel.html:244`) and "Add custom tag…" (`:279`), and each of the 25 default tags
already carries a prompt ("Identify posts related to …", `scratchpad/design/renders/tags.json`). The owner's
question was "how would I know which item was captured for which prompt".
**Escalation test.** The structure is form: taken here. **Two halves handed up, not taken:**
(1) *the noun the user reads* is words. No copy seat is seated, so it goes to 🧭 CEO. Design's
recommendation: **"prompts"**, the owner's own word, with each lens shown by its name. (2) *Which objects
gate collection* is scope. If all 25 default topic tags become lenses under DEC-6's "any prompt matches",
almost every post is collected. Whether the defaults gate collection, only classify, or start switched off
is for 🧭 CEO and ⚙️ Engineering. D-2 to D-4 hold whichever way that is answered.
**Record, 2026-10-11 01:20.** 🧭 CEO ruled both halves (DEC-6 addendum, `da92dc5`). The noun is
"prompts". Only prompts the user writes gate collection and act as lenses; the built-in tags label and
filter only. The operative text above was rewritten from "one kind of object" to "two kinds, kept apart".
The earlier text merged tags and the match prompt into one object, and it no longer binds.
**Open, handed to ⚙️ Engineering (and noted to 🧭 CEO):** ENG-1 rules 1 and 4 key every enabled tag as a
lens (`tag:<label>`) and collect a post when *any* lens reaches the threshold. That makes the built-in tags
gate collection, against the amended DEC-6. ENG-1 also has no field marking which tags the user wrote. It
gives the match prompt no name, and it has only one match prompt. This ruling needs, from the data, a set
of user prompts, each with an optional name. Their shape is Engineering's.
**Record, 2026-10-11 01:40. Closed** by ENG-1 as amended (`562d77a`, rules 1–5). A lens is the match
prompt (id `main`, no name, so it is shown by its text per this ruling) plus each tag the user added
(`isLens: true`, named by its label). The built-in tags are never lenses and never gate; a unit gate covers
this. **New, from the same re-read:** ENG-1 rule 7 leaves `assignedTag` and `decision.tags` unchanged, so an
`isLens` tag can still be a post's tag. That would show one object as both kinds. The form half is taken
above (the `isLens` paragraph). Whether lens tags should stay in tag classification is ⚙️ Engineering's,
and it is sent to them.

### D-2 · The prompt row and the prompt view (2026-10-11, amended 01:20)
**Ruling.** The prompts get **their own row, above the tag row** (`#filter-pills`). It holds one pill per
user prompt:
- one pill per **enabled** user prompt; a disabled prompt has no pill and no chips;
- each pill carries the prompt's colour dot, its name (D-1), and its count (P-2). A user-added prompt
  keeps its tag colour. The match prompt (`main`) has none, so it uses `--accent`;
- pills are outlined, not filled, so they never read as the tag row's selected "All";
- `max-width` is 160 px; when there are more pills than fit, the row scrolls sideways like the rows below;
- **no prompts, no row:** no empty box and no placeholder;
- **at most one prompt is selected.** The pill is a toggle (`aria-pressed`): selecting it again clears it.
With **no prompt selected**, the list is newest first **with** the day dividers (Today, Yesterday, a date).
This is the view the panel opens on. **Selecting a prompt** lists every post that matched it, strongest
first, and **removes the day dividers**. Each card keeps its own relative time. The tag, site and author
rows still narrow the list in either view, and every count follows P-2 under all active filters. The tag
row keeps its present form and order. Its zero-count clutter is not ruled here.
**Measured.** In the prototype's Health view, sorted by score (92, 81, 51), the posts are from 1 day, 3 min
and 5 h ago. With day dividers kept, the list would read "Yesterday, Today, Today" with a Yesterday group
above Today, a date order the list no longer has. And the pill read **Health 2** over a list of **3** cards,
because today's count is by the one `assignedTag` (`sidepanel.js` `renderFilterPills`, counts by
`item.assignedTag`). Render: `proto-lens-dark-320.png`, `proto-lens-light-400.png`.
**Escalation test.** Order and grouping are form: taken. What "matched" means (the threshold a score must
reach) is ⚙️ Engineering's. This ruling only requires that the count, the list and the card chips use the
**same** test.
**Record, 2026-10-11 01:20.** The earlier text made the existing tag row the lens bar. After the CEO's
scope ruling, the tags are not lenses, so the operative text now gives prompts their own row. Render:
`proto-prompts-dark-320.png` and `proto-prompts-light-400.png` (`node scratchpad/design/proto-prompts.mjs`),
with two user prompts, three posts, and the view sorted by "AI coding tools" (92, 74, 61). At 320 px and
400 px the row holds two pills inside its width (`scrollWidth` 296/296 and 376/376). The outlined
selected prompt and the filled selected "All" read as two different controls.

### D-3 · The strength chip (2026-10-11)
**Ruling (amended 01:20).** Every **user prompt** a post matched is one chip, in a row of its own between
the card body and the footer. The built-in tags stay where they are today, as labels in the footer
(`.tags-container`), with no number and no bar. The tag labels lose their fading too (P-1): "labelled
Jobs" is a claim. Each prompt chip carries:
- the lens's own colour as a 6 px dot, the lens name, and the score as **a whole number from 0 to 100**
  (`Math.round(score × 100)`, one function everywhere it is shown), in bold tabular figures, in
  `--text-primary`;
- **only on the selected prompt's chip** (amended 01:50, P-3), a **2 px bar under the name, filled to the
  score on an axis that starts at 0** and ends at 100. Down the list, these bars compare one prompt's
  scores, which is sound. The other chips show the name and number with no bar, and with no prompt
  selected no chip has a bar. Never start the axis at the threshold: a bar that starts at 50 makes 51 look
  empty and 92 look full;
- colour is the lens's identity only. **No red, amber or green ramp by strength**: colour would then
  claim good or bad. The chip carries **no engine or provider mark** (DEC-3 to DEC-5); the path and engine
  stay in the existing decision tooltip (the ⓘ icon);
- order (amended 01:50, P-3): with a prompt selected, its chip comes first, outlined in its colour. The
  others follow in **the user's prompt-list order (Settings), never by score**, and so does every chip when
  none is selected. At 320 px the chips wrap; none is dropped or truncated;
- a post that matched no user prompt (collected with the gate off) has no chip row: no empty row and no
  "0".
- every chip follows P-1: no opacity, scale or dashed border by rank.
- Sorting uses the raw score. Two cards that both show "50" may appear in either order, and that is
  acceptable.
**Measured.** Today a 0.92 match and a 0.51 match look the same on a card. The primary label shows no
score at all, and secondary labels show theirs only in a hover title (`sidepanel.js` `populateCardInner`,
`Confidence: n%`). Secondary labels are set at `opacity: 0.7; transform: scale(0.9)`
(`sidepanel.css` `.card-category-label.secondary`). Composited, that gives **4.12:1 dark
(rgb 118,118,126 on 19,19,22) and 2.73:1 light (156,156,162 on 255,255,255)**, below 4.5:1 for 10 px text
scaled to 9 px. The prototype chip measured **16.87:1 dark and 19.90:1 light** for both name and number.
Render: `card-dark-320.png` (as is), `proto-lens-dark-320.png` (proposed).
**Escalation test.** The form is taken here. **Handed to ⚙️ Engineering:** what the score means and so how
it is labelled. Is it shown with "%"? Is the hover wording "Confidence", "match" or something else? Is the
System 1 score calibrated enough to read as a percentage? Until Engineering answers, the chip shows the bare
number and no unit. The shipped tooltip's "Confidence: n%" is not reused on the chip.
**Record, 2026-10-11 01:20.** The chips were moved off the tags and onto user prompts, following the
CEO's scope ruling; the operative text was fixed in place. ENG-1 states that a lens score is a calibrated,
independent sigmoid score, not the competing softmax. That supports a 0–100 reading, but it does not yet
answer the unit or the hover wording, which stay open with Engineering.
**Record, 2026-10-11 01:40. Answered** by ENG-1 as amended (`562d77a`, rule 5 and its non-goals). The
number is `lensScoreLabel(score)` = `Math.round(score × 100)`, shown bare with **no "%"**. "Matched" is
`isLensMatch` (score at or above the strictness threshold), the one test behind the chips, the list and
the count. Lens scores use the match-prompt calibration (rule 3). The chip's hover wording is words: it is
the 🧷 extension seat's, under D-3's constraint that it does not say "Confidence" or "%". Note: a looser
strictness setting lowers the threshold, so chips can appear at scores near 30. Those are true numbers and
are shown as they are.
**Record, 2026-10-11 01:50.** Engineering's reply says the number is a 0–100 match score, not a percent,
and suggests "Match score" as the hover word. That wording is the 🧷 extension seat's to adopt. Engineering
also reported that the score's level does not transfer across prompts (P-3, re-read by Design in the eval
report). The earlier text ordered every chip by score and gave every chip a bar on one shared axis. That
told the eye that "AI coding tools 92" fits better than "Remote ML jobs 61", a claim the system does not
make. The operative text was fixed in place: list order, and a bar only on the selected prompt.
`proto-prompts-*.png` still shows the earlier form; re-render once it is built.

### D-4 · The image preview (DEC-7) (2026-10-11)
**Ruling.**
- A **48 × 48 px** thumbnail, `object-fit: cover`, 4 px radius, 1 px `--border`, at the top right of the
  card summary; the title wraps beside it.
- It shows **only the image stored on the device** (`data:` or `blob:`). **Never the site's image URL**:
  those links expire (DEC-7), loading them leaks the view to the site, and MV3 forbids remote code paths
  (e0c0df6).
- **No stored image, no box:** no placeholder and no empty frame. The card is the same card it is today.
- It grows on **pointer hover and keyboard focus** (the thumbnail is a focusable button). It grows to
  `min(240px, panel width − 48px)` wide, in a layer above the list, anchored to the thumbnail. It closes on
  pointer leave, blur and Esc. It is never open by default and never shifts the layout.
**Measured.** At 320 px the thumbnail leaves the title about 214 px. The title wrapped to 4 lines and the
chips stayed on their row (`proto-lens-dark-320.png`). Grown, at 320 px, it covers the card's own chips
(`proto-thumb-hover-dark-320.png`). That is acceptable only because the user called it up and it closes
on leave. Hence the rule that it is never open by default. (The prototype's non-hover renders also show it
grown: a defect of the mock, which left out the hover rule, not of the ruling.)
**Escalation test.** Size, place and behaviour are form: taken. **Handed to ⚙️ Engineering:** the stored
image's pixel size and byte cap. The grown view is 240 CSS px wide, so a sharp image on a 2× screen needs
about 480 px. Below that it upscales soft. That trade-off is theirs (DEC-7). **Handed to the 🧷 extension
seat:** the thumbnail's accessible name (words).

### D-5 · The card time is readable (2026-10-11)
**Ruling.** `.card-time` moves from `--text-muted` to `--text-secondary` (P-1: in "All" it is the sort key).
**Measured.** `--text-muted` gives **2.40:1 dark (rgb 82,82,91 on 19,19,22) and 2.56:1 light (161,161,170
on 255,255,255)**. `--text-secondary` measured **7.24:1 dark and 4.83:1 light** in the prototype.
**Escalation test.** Form: taken. Which release it rides is queue order, so it went to 🧭 CEO.
**Record, 2026-10-11 01:20.** The CEO pulled it into the store release (DEC-8 addendum, `da92dc5`), on
the condition that it lands before 🧪 Testing's release run starts; otherwise it rides with lenses. The 🧷
extension seat lands it now. **Done when** the built `dist/ext` panel re-renders `.card-time` at 4.5:1 or
better in both themes.
**Record, 2026-10-11 01:25. Render PASS** on `8026f7b` (the 🧷 extension seat's commit; `dist/ext/sidepanel.css`
matches the source). Re-measured by Design with `node scratchpad/design/render-panel.mjs`: `.card-time`
measured **7.24:1 dark (161,161,170 on 19,19,22) and 4.83:1 light (113,113,122 on 255,255,255)** at 320, 400
and 560 px. The image was read: `card-light-320.png` shows the time at body-text weight. **Still open:** the
real-browser pin, which 🧪 Testing owns, and the live look in the owner's Chrome.

## Observed, not ruled (read from source 2026-10-10 at `44f04d3`; rendered 2026-10-11 at `9bfb189`)

- Theme tokens are defined in `sidepanel.css` under `[data-theme="dark"]` and `[data-theme="light"]`.
- `sidepanel.html` defaults to `data-theme="dark"`; `sidepanel.js` restores a saved theme.
- Type uses the system font stack; no web fonts are loaded.
- Cards are `[data-sig]` shells filled by `populateCardInner`, not a `.card` class. Cite `[data-sig]` when
  selecting a card in a test.
- 26 default tags (25 topics plus the `Ads` pseudo-tag) render as pills, most at count 0. The row
  scrolls sideways at every width rendered. **Closed 2026-10-11 01:20** against the CEO's scope answer:
  the tags are not lenses, the prompts have their own row (D-2), and the tag row stays as it is. Its
  zero-count clutter is a separate question and is not ruled.
