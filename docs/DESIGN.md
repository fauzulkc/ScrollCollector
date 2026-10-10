# Design: ScrollCollector

**Kept by the 📐 Design seat** (`docs/team/design.md`). This register holds the numbered design rulings
and citable patterns for the side panel and its views; a ruling binds whoever builds a surface (the 🧷
Browser-extension engineer implements). Each ruling is a dated entry with the measurement and render that
forced it, its reproduction command, and the escalation outcome; a correction fixes the operative line in
place and appends the record. Only Design edits the operative text; others propose. A decision in
`docs/DECISIONS.md` outranks this file. No rulings or patterns are recorded yet.

## Observed, not ruled (read from source 2026-10-10 at `44f04d3`, not rendered)

- Theme tokens are defined in `sidepanel.css` under `[data-theme="dark"]` and `[data-theme="light"]`.
- `sidepanel.html` defaults to `data-theme="dark"`; `sidepanel.js` restores a saved theme.
- Type uses the system font stack; no web fonts are loaded.
