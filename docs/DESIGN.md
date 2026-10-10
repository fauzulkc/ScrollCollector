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
Next free numbers: **P-4, D-8** (D-6 is the Design team's draft, awaiting adoption; D-7, the wide panel,
was ruled 2026-10-11).

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

**Record, 2026-10-11 (Design team, DRAFT).** The `isLens` paragraph above is superseded by the owner's
collect switch (DEC-6 02:27): user tags label again. See D-6 (draft); the seat is to fix the operative
paragraph in place when it adopts D-6.

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

### D-6 · The collect switch (DEC-6, owner 02:27 and 02:58) (2026-10-11 DRAFT, PROPOSAL: written by the 📐 Design team while Design is away; not binding until the seat adopts it)
**Ruling (draft).**
1. **Where it lives: Settings only, on the prompt's own row; never in the prompt bar.** Each user prompt
   (an `isLens` tag) is a `.tag-row` in `#tag-list` (Settings, "Tracked Categories"). Its row header gets a
   second switch beside the existing "Track" toggle: a visible text label **"Collect"** (the owner's own
   word), then the same `.tag-toggle` / `.toggle-track` control and an On/Off state in the `.filter-state`
   pattern of `#match-prompt-state`. On by default; sends `MSG.TAG_COLLECTS_TOGGLED { tag, collects }`. It is
   **not** hidden inside the collapsed editor (`.tag-prompt-container`): the state is a claim and is read
   without opening anything. Built-in tags (D-1) get **no** collect switch. The prompt bar's pills (D-2)
   stay toggles for *selecting*; a second meaning on the same control would let one stray tap change what
   is collected. When "Track" is off the prompt is no lens (no pill, no chip) and its collect switch is
   `disabled` with its value kept; its On/Off text keeps full contrast (P-1), no opacity. **The master
   prompt is one prompt like the others** (DEC-6, 02:58): its existing `#match-prompt-toggle` is its collect
   switch, same On/Off pattern; it is the only one whose row is the "Prompt filter" section, and its label
   wording is for the owner (below).
2. **How a non-collecting prompt reads.** One mark, in two places, nothing else differs: the pill and the
   chip of a user prompt whose collect is Off carry a trailing text marker (recommended wording **"labels
   only"**). A prompt that collects carries none, because collecting is the default and only the exception
   is marked. Everything else is identical: same dot, name, count (D-2), score and bar (D-3), outline and
   position (list order, P-3). The marker is `--text-secondary` or darker at **at least 4.5:1** on its
   actual ground in both themes (P-1: no opacity, no dashed border, no lighter token to say "weaker"); it
   does not shrink or truncate, so at 320 px the **name** gives way first (ellipsis, full text in the title,
   D-1); its full sentence goes in the element title. A selected non-collecting prompt sorts by its score
   like any other (DEC-6). Its count is P-2 as ever, the posts in the list it opens; those are posts
   collected by other prompts (or by the gate-off state) that it also matched, so it can read 0, and the 0 is
   shown (the pill is neither hidden nor disabled). **The master prompt never carries the marker**: while
   its switch is Off it is not scored (`scoredLenses`), so it has no pill and no chip, like a disabled prompt
   (the "main prompt with no score while the match switch is off" empty state). A post with no
   `decision.lenses` (manual override, or awaiting the backfill) has no chip row and is counted by no prompt
   pill (D-3 already; no "0", no placeholder).
   **Which prompts are collecting, shown wherever filtering applies (CEO 02:58).** Filtering is on whenever
   at least one prompt collects, even with the master switch Off, so a user who adds a tag and sees the feed
   narrow must be able to see why. Two places, one rule: (i) **Stream**, a single status line
   (`#collect-summary`, `role="status"`) directly under the prompt row, shown **only while filtering is
   on**, listing the collecting prompts by name (the master by its text cut per D-1), `--text-secondary` or
   darker at 4.5:1, wrapping, with no pills or colours so it cannot be mistaken for a control; (ii)
   **Settings**, the same list in the existing `.prompt-hint` (`role="status"`) above the prompts. The
   list is `userLenses(cfg)` filtered to `collects`; one function feeds both and the pill markers, so they
   cannot disagree. With no collecting prompt the line is absent in Stream (nothing is filtered) and the
   Settings line takes the all-off form in 3.
   **User tags label again (supersedes D-1's `isLens` paragraph; ⚙️ Engineering's FYI of the same day).** A
   user prompt is one object in two roles: as a **tag** it can be a post's footer label and a tag-row pill
   (classification, no number); as a **prompt** it is a pill in the prompt row and a chip (matched by
   score). The two can disagree on one card (filed under Food, no Food chip, or the reverse). Both are true
   answers to different questions; **neither is hidden to look consistent** (a hidden claim is a deleted
   one), and the footer label never carries a number or the marker.
3. **Every collect Off, master included.** With no collecting prompt nothing is filtered
   (`lib/decision/lenses.js`), so **every post is collected**, as today with no prompt. The prompt pills
   stay (each enabled user prompt, each marked "labels only") with their P-2 counts; "All" is the whole
   collection, newest first with day dividers (D-2); "Hidden by prompt" is absent at count 0 (existing).
   **The empty states do not change**: `emptyFeedMessage()` ("No items collected yet. Start scrolling
   feeds!" for an empty collection; "No posts match these filters." when filters empty a list) are both
   true here; a selected pill with 0 shows the second. **One new line in Settings** (the `.prompt-hint`
   above) in this state only: no prompt is set to collect, so every post is collected, because "off" is
   otherwise read as "collects nothing", the opposite of what happens. Wording is words (below).
**Measured / checked.** At `1b9bdfd` of `feat/prompt-lenses`: `sidepanel.html:244-253` is the master
switch (label "Prompt filter", `#match-prompt-toggle`, help "When the filter is on, only posts that match
this prompt are collected."); user-prompt rows are built in `sidepanel.js` (`.tag-row` template near lines
2170-2215: dot, `.tag-label`, `.btn-expand-prompt`, one `.tag-toggle` "Tracking", delete); the panel has
**no prompt row or chips yet** (the extension seat's slice), so nothing here is rendered.
`lib/decision/lenses.js`: entries carry `collects`; an `isLens` tag collects unless `collects === false`;
`main` collects, and is scored, only while its switch is on; with no collecting lens nothing is filtered.
`--text-secondary` on the card measured 7.24:1 dark and 4.83:1 light (D-5), a floor for the marker on the
card; its ratio on the pill's ground is **UNVERIFIED** (gradient ground, see "How these were measured").
**No render was made for this draft.**
**Defect found in passing (⚙️/🧷, not Design's to fix):** `sidepanel.js` ~2452-2453 `gate_off_with_prompt`
says "The filter is off, so every post is collected." With a collecting user prompt the gate is on while the
master switch is off, so that sentence is false; the master help line "only posts that match this prompt
are collected" is also wrong for any-prompt collection. Both need re-wording.
**Escalation test.** Placement, marker form, ordering, contrast, the summary line's form and the
empty-state behaviour are form: taken. **Not taken, handed up:** (a) *the words*: "Collect" is the owner's
word and recommended; **"labels only"**, the marker's title sentence, the switch's accessible name, the
Stream and Settings collecting-line wording, the all-off line and the re-worded master label/help/hint are
words for 🧭 CEO / the owner (no copy seat is seated), PROPOSAL; D-1 says users read "prompts". (b) Whether
the master switch should override collecting tags is the owner's open review in the CEO's inbox
(`1b9bdfd`); this draft follows `lenses.js` as built and holds either way except that the master's row
wording changes. (c) Whether posts hidden by an earlier gate return when the gate turns off is ⚙️
Engineering's re-decide.
**Pin (for 🧪 Testing, real browser).** On the built panel: a user prompt with `collects: false` shows the
marker on its pill and chip, one with `collects !== false` none; the marker resolves to at least 4.5:1 in
both themes; a labels-only pill's count equals the cards listed when selected (P-2), including 0;
`#collect-summary` is present exactly when at least one prompt collects and lists exactly those prompts;
with every collect Off and the master Off, "All" equals the collection size and the all-off line shows,
and it is gone once any switch is On. Weak pin: a test that reads the stylesheet for the marker, or checks
only that the switch exists.
**Done when** the built `dist/ext` panel is rendered at 320, 400 and 560 px in both themes with one
collecting and one labels-only prompt, the image read, and the marker's contrast measured on both grounds.

### D-7 · The panel fills any width it is given (2026-10-11, owner's ask)
**Ruling.**
1. **The panel uses the whole width Chrome gives it.** Lift `body { max-width: 500px }` (`sidepanel.css`
   `body`; keep `min-width: 280px`). The header, tabs, search, filter rows and footer span the full width.
2. **The stream becomes a grid of cards** (`#stream-list`): `grid-template-columns:
   repeat(auto-fill, minmax(min(300px, 100%), 1fr))`, `gap: 12px`, `align-items: start`. At most widths
   that keeps cards between 300 and about 480 px wide. Measured columns: 2 at 640 px, 3 at 1100, 4 at 1500.
   Below about 636 px it stays one column, as today.
3. **Reading order is left to right, then down (row by row), never column by column.** In a selected
   prompt's view the list is a ranking (D-2), and in "All" it is newest first. A masonry or CSS-columns
   flow would read ranks and times out of order. Short cards leave a gap below them, and that is accepted
   (`align-items: start`).
4. **Anything in the list that is not a card spans the full row** (`grid-column: 1 / -1`): the day
   dividers, empty states and status lines (D-6's `#collect-summary` included). A divider never sits in
   one cell beside cards.
5. **Settings and Export do not stretch.** Their content is held at `max-width: 560px`, left-aligned under
   the tabs. Forms and help text stay at the width they were written for.
6. **Nothing else changes with width:** no type sizes by breakpoint, no hidden controls, and no horizontal
   page scroll at any width. The filter rows keep scrolling sideways and show more pills as width grows.
   D-4's grown preview stays `min(240px, panel width − 48px)`, anchored to its card.
**Measured.** The owner's screenshot (2026-10-11) shows a panel about 770 px wide, with content ending
near 500 px and an empty band to its right. Reproduced with `node scratchpad/design/proto-wide.mjs` (8
seeded posts, Chrome for Testing, dark). **As is:** the body is 500 px at both 770 and 1100 px, one column
of 476 px cards, about 84 characters per line. **Prototype** (this ruling's CSS injected): the body fills
the panel; 640 px → 2 columns of 302 px (51 characters per line); 770 → 2 of 367 (63); 1100 → 3 of 351
(60); 1500 → 4 of 360 (62); `scrollWidth` equals the viewport at every width. Renders:
`wide-asis-770.png`, `wide-wide-770.png`, `wide-wide-1100.png` (stream, read: time order 1m, 8m, 15m, 22m,
29m runs left to right; the day divider spans the row) and `wide-settings-770.png` (Settings held at
560 px). **Not measured:** the widest single-column card, at just under 636 px, is about 600 px, which
works out to about 105 characters per line from the measured rate. That narrow band is accepted. Light
theme not rendered: this ruling changes no colour.
**Escalation test.** Form: taken. **Handed to 🧭 CEO:** which branch and release this rides is queue
order. The store release ships as it stands (DEC-8), so by default it lands with prompts on
`feat/prompt-lenses`. A separate "open in a full tab" mode would be new scope and is not ruled here. With
this ruling, the page already works at any width if it is opened in a tab. **Handed to the 🧷 extension
seat (clear it with ⚙️ Engineering):** the list virtualiser (`initVirtualizer`, `is-virtualized` with a
`minHeight`) must keep each card in its grid cell. A card that drops out of view must not reflow its row.
**Pin (for 🧪 Testing, real browser).** At 1100 px the body width equals the viewport, there are 3 card
columns, the first three cards' `top` values are equal and their `left` values increase, a day divider
spans the full row, and `scrollWidth` equals the viewport. At 400 px there is one column. Weak pin: a test
that reads the stylesheet for `max-width`.
**Done when** the built `dist/ext` panel is re-rendered at 400, 770 and 1100 px with the image read, the
pin is green, and the owner sees it fill the panel in their own Chrome.

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
