# Test standard: ScrollCollector

**Kept by the 🧪 Testing seat** (`docs/team/testing.md`). This register says what counts as green: the
probe depth of each suite, the numbered testing rulings, and the quarantine ledgers. Only Testing edits
its operative text; other seats propose changes as `PROPOSAL` lines in Testing's inbox. A ruling is
appended with a date and the measurement that forced it; a correction fixes the operative line in place
and appends the record. A decision in `docs/DECISIONS.md` outranks this file. No rulings are recorded yet.

## Baseline: suites as measured 2026-10-10

At `44f04d3` on `feat/decision-cascade`, WSL Ubuntu-24.04, Node v24.14.0, one uncached run each.

| Suite | Command | Result | Note |
|---|---|---|---|
| Legacy logic | `node test.mjs` | 18 pass, 0 fail, 0 skipped (exit 0) | node:test |
| Unit (vitest) | `npm run test:unit` | **red**: 706 pass, 1 fail, 0 skipped of 707, in 40 files (exit 1) | fail: `test/unit/content-identity.test.js` › "a new post appended to the feed is picked up by the observer" (`waitFor timed out`); defect vs timing UNVERIFIED |
| E2E | `npm run test:e2e` | UNVERIFIED (not run) | Chrome for Testing in WSL; needs `npm run build:ext` |
| System 1 eval | `npm run test:eval` | UNVERIFIED (not re-run) | private golden set is gitignored |
