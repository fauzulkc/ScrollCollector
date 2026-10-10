# 📐 Design: the project brief for ScrollCollector

**This seat's rulebook is `.claude/skills/seat-design/SKILL.md` in this project** (how the role thinks
and works). **This file is what the role needs to know about ScrollCollector**: what it owns here, the
decisions that bind it, and the traps it has paid for. The seat reads it right after `docs/TEAM.md`,
every time it starts. A decision in [DECISIONS.md](../DECISIONS.md) outranks both.

## Owns here
- **Register:** docs/DESIGN.md (design rulings and patterns)
- **Paths:** `docs/DESIGN.md` (rulings, patterns, tokens as ruled) and this brief. Renders and
  screenshots go to `scratchpad/` (never committed). This seat **specs** the side panel, its settings
  and the diagnostics view; it does not edit their code.

## Does not own here
- **Side panel and UI code:** `sidepanel.html`, `sidepanel.css`, `sidepanel.js`, `ui/` (including
  `ui/diagnostics.js`), `icons/`, `install-guide.html` belong to the 🧷 Browser-extension engineer, who
  implements a ruling. Work offered there carries "clear it with Engineering" (the extension seat
  reports to ⚙️ Engineering).
- **The store listing's words and its publication:** the listing draft is the 🧷 extension seat's;
  publishing is the owner's (DEC-2).
- **What a decision, score or confidence means** (the cascade's verdicts, System 1 probabilities, the
  engine badge's states): ⚙️ Engineering's in `lib/decision/`; Design rules only how it reads.
- **Tests:** a contrast or form pin lands in `test/` or `e2e/` through 🧪 Testing.
- **Challenging finished work:** ⚖️ Bar Raiser. **Decisions, scope, queue:** 🧭 CEO.

## Reports to
CEO

## Decisions that bind this seat
- **DEC-1:** the team method in `docs/TEAM.md`; work through `design-worker` and the shared tiers.
- **DEC-2:** owner-only: publishing, sending, spending and signing (store listing, screenshots shipped
  to the store). Pushing is "on its own" once the checks pass and a reviewing seat has passed it.
- **Owner's AI direction (2026-10-09/10, not yet a decision row; the CEO is to record it):** small,
  cheap, fast, private; System 1 bundled locally; the only LLM is the browser's built-in Gemini Nano;
  Jev and OpenAI opt-in only, never on by default. Form must not imply a cloud provider is active, or
  a local answer is a model's, when the system does not say so.
- **Owner's testing direction (same status):** checks run in Chrome for Testing in WSL (Playwright)
  and live in the owner's Chrome via Claude-in-Chrome; the owner types API keys.

## Project facts this seat relies on
- **Repo:** WSL `/home/fauzul/code/ScrollCollector`, branch `feat/decision-cascade`, HEAD `44f04d3`
  (measured 2026-10-10). git / npm / node from WSL only.
- **Surfaces** (measured 2026-10-10): the Chrome side panel `sidepanel.html` (+ `sidepanel.css`, 58 KB,
  and `sidepanel.js`), with UI modules in `ui/` (`decision-info.js`, `diagnostics.js`,
  `engine-badge.js`, `export.js`, `intelligence.js`, `toast.js`, `util.js`). Diagnostics is not a
  separate page: `ui/diagnostics.js` mounts into `#diagnostics-root` inside the side panel's
  Intelligence settings. Also `install-guide.html` and `icons/` (16, 48, 128 px PNG, `.ico`).
- **Observed visual facts** (from source, not rendered; 2026-10-10): theme tokens under
  `[data-theme="dark"]` and `[data-theme="light"]` at the top of `sidepanel.css`; `sidepanel.html`
  defaults to `data-theme="dark"` and `sidepanel.js` (around line 168) restores the saved theme; system
  font stack, no web fonts, no `prefers-color-scheme` query. The stylesheet's header calls itself a
  "design system": no ruling backs that yet.
- **How to see it:** `npm run build:ext` then either the E2E harness on Chrome for Testing
  (`e2e/ui.spec.mjs`, `e2e/helpers/launch.mjs`; `HEADED=1` to watch) or the owner's Chrome via
  Claude-in-Chrome after `npm run sync:win`. The side panel's rendered widths are UNVERIFIED.
- **Tests that touch form:** `test/unit/ui-*.test.js` run in happy-dom (no real layout or cascade
  resolution); `e2e/ui.spec.mjs` and `e2e/badge.spec.mjs` run in a real browser. Suite state
  measured 2026-10-10: unit 706/707 pass (1 fail, content identity, not UI); E2E UNVERIFIED.
- **No rendered screenshot or contrast measurement exists yet:** every visual claim is UNVERIFIED until rendered.

## Traps paid for
- **The side panel has been reworked many times without a register** (b963f09 settings, engine badge,
  diagnostics; c573df6 explicit prompt save; 7fcaa4c refine; 2f41c54, 586033d, d73f1dc earlier
  animation, chip and modal changes): no ruling survived any of them. Record rulings before specs.
- **Docs drift from the tree (2026-10-10):** the setup facts named a root `diagnostics.*`; the tree has
  only `ui/diagnostics.js`. Re-measure a surface's location before citing it.
- **happy-dom is not a renderer** (the rulebook's jsdom trap applies): a `ui-*` unit test cannot show
  contrast or layout; pin those in a real browser.
- **Branded Chrome ignores `--load-extension` since 137** (`e2e/helpers/launch.mjs`): renders come from
  Chrome for Testing or the owner's Chrome; Chrome loading from `\\wsl.localhost` is flaky (use `sync:win`).
- **MV3 forbids remote code** (e0c0df6): no CDN fonts, icon fonts or remote images in a spec; vendor everything.

## Done means here
A ruling in `docs/DESIGN.md` carrying the measurement that forced it, a render of the surface in Chrome
for Testing at the side panel's real width (read, not only measured), the escalation outcome, and the
🧷 extension seat told in its inbox. A spec the extension seat builds is done when the built
`dist/ext` side panel is re-rendered and matches the ruling, the pin (through 🧪 Testing) is green, and
the live look in the owner's Chrome via Claude-in-Chrome agrees.
