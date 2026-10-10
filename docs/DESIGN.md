# Design: ScrollCollector

**Kept by the 📐 Design seat** (`docs/team/design.md`). This register holds the numbered design rulings
and citable patterns for the side panel and its views; a ruling binds whoever builds a surface (the 🧷
Browser-extension engineer implements). Each ruling is a dated entry with the measurement and render that
forced it, its reproduction command, and the escalation outcome; a correction fixes the operative line in
place and appends the record. Only Design edits the operative text; others propose. A decision in
`docs/DECISIONS.md` outranks this file. **State (2026-10-11):** patterns P-1 and P-2, rulings D-1 to D-5
(the lens spec for DEC-6 and the preview spec for DEC-7). Next free numbers: **P-3, D-6**.

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

## Rulings

### D-1 · One idea: a lens is a named prompt (2026-10-11)
**Ruling.** What the code calls a tag (`trackedTags[]`: a label and a prompt) and the match prompt are shown
to the user as **one kind of object**: a name and the prompt it matches. One object, **one noun, used the
same way in the lens bar, on the card and in Settings**. Settings lists them in one list, each row showing
its name and its prompt. No second, separate "prompt filter" control beside the list.
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

### D-2 · The lens bar and the lens view (2026-10-11)
**Ruling.** The lens bar is the existing first filter row (`.filter-pill`), not a new control. "All" comes
first and keeps newest-first order **with** the day dividers (Today, Yesterday, a date). Selecting a lens
lists every post that matched it, strongest first, and **removes the day dividers**. Each card keeps its
own relative time. Lens pill counts follow P-2.
**Measured.** In the prototype's Health view, sorted by score (92, 81, 51), the posts are from 1 day, 3 min
and 5 h ago. With day dividers kept, the list would read "Yesterday, Today, Today" with a Yesterday group
above Today, a date order the list no longer has. And the pill read **Health 2** over a list of **3** cards,
because today's count is by the one `assignedTag` (`sidepanel.js` `renderFilterPills`, counts by
`item.assignedTag`). Render: `proto-lens-dark-320.png`, `proto-lens-light-400.png`.
**Escalation test.** Order and grouping are form: taken. What "matched" means (the threshold a score must
reach) is ⚙️ Engineering's. This ruling only requires that the count, the list and the card chips use the
**same** test.

### D-3 · The strength chip (2026-10-11)
**Ruling.** Every lens a post matched is one chip in the card footer (`.tags-container`), replacing today's
primary and secondary tag labels:
- the lens's own colour as a 6 px dot, the lens name, and the score as **a whole number from 0 to 100**
  (`Math.round(score × 100)`, one function everywhere it is shown), in bold tabular figures, in
  `--text-primary`;
- under them, a **2 px bar filled to the score on an axis that starts at 0** and ends at 100. Never start
  the axis at the threshold: a bar that starts at 50 makes 51 look empty and 92 look full;
- colour is the lens's identity only. **No red, amber or green ramp by strength**: colour would then
  claim good or bad. The chip carries **no engine or provider mark** (DEC-3 to DEC-5); the path and engine
  stay in the existing decision tooltip (the ⓘ icon);
- order: in a lens view, the active lens's chip comes first, outlined in its colour; the others follow by
  score, strongest first. In "All", all chips go by score. At 320 px the chips wrap; none is dropped or
  truncated;
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
**Escalation test.** Form: taken. *Which release it rides* is queue order, 🧭 CEO's. DEC-8 ships the release
as it stands, so by default this lands with lenses on `feat/prompt-lenses`, unless the CEO pulls it in.

## Observed, not ruled (read from source 2026-10-10 at `44f04d3`; rendered 2026-10-11 at `9bfb189`)

- Theme tokens are defined in `sidepanel.css` under `[data-theme="dark"]` and `[data-theme="light"]`.
- `sidepanel.html` defaults to `data-theme="dark"`; `sidepanel.js` restores a saved theme.
- Type uses the system font stack; no web fonts are loaded.
- Cards are `[data-sig]` shells filled by `populateCardInner`, not a `.card` class. Cite `[data-sig]` when
  selecting a card in a test.
- 26 default tags (25 topics plus the `Ads` pseudo-tag) render as pills, most at count 0. The row
  scrolls sideways at every width rendered. Not ruled here; it depends on D-1's scope answer.
