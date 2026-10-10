# 🧭 CEO: the project brief for ScrollCollector

**This seat's rulebook is `.claude/skills/seat-ceo/SKILL.md` in this project** (how the role thinks
and works). **This file is what the role needs to know about ScrollCollector**: what it owns here, the
decisions that bind it, and the traps it has paid for. The seat reads it right after `docs/TEAM.md`,
every time it starts. A decision in [DECISIONS.md](../DECISIONS.md) outranks both.

## Owns here
- **Register:** docs/DECISIONS.md (the decision register, the queue, milestones)
- **Paths:** `docs/DECISIONS.md` (rows, the queue, milestones); long reasoning behind a ruling goes in one dated
  file under `docs/briefs/` (indexed by `docs/briefs/README.md`;
  Bar Raiser findings share the folder). Landing commits and pushing under DEC-2's push rule.

## Does not own here
- `docs/team/tracker.md`, `docs/team/owner-questions.md`: 🛎️ Chief of Staff (it relays the owner's words; you rule).
- `docs/TEAM.md` roster and `.claude/agents/`: changed only through the `team-reevaluate` skill, never by hand.
- What lands in code, engineering goals and gates: ⚙️ Engineering. What counts as green (`docs/TEST-STANDARD.md`): 🧪 Testing. Design rulings (`docs/DESIGN.md`): 📐 Design.
- The extension code, manifest permissions and the store-listing draft (`docs/STORE-LISTING.md`):
  🧷 Browser-extension engineer. The listing's publication, any release, any spend: the owner.
- `README.md` / `BUILD.md` wording: no seat named at setup; route a change to the seat whose code the line
  describes (UNVERIFIED owner of these two files).

## Reports to
the owner

## Decisions that bind this seat
- **DEC-1** (the team method): the team is the seven seats in `docs/TEAM.md`'s roster; seats, workers and tiers work
  as TEAM.md says. You change the team only through `team-reevaluate`.
- **DEC-2** (team, owner-only acts, push rule): owner-only = publishing, sending, spending and signing (Chrome Web
  Store, GitHub releases). Seats push their own landed work once the checks pass and a reviewing seat has passed it,
  and report the push after; your push still runs §3e's checks (fast-forward only, no oversized blob, credential scan).
- **DEC-3, DEC-4, DEC-5** (the owner's AI direction of 2026-10-09/10, recorded 2026-10-11 00:27 +0600; the rows win):
  System 1 = small q8 sentence-embedding model (MiniLM / bge-small) via Transformers.js in the offscreen document,
  weights bundled, nothing downloaded at runtime; the only LLM tier is the browser's built-in model (Gemini Nano,
  `LanguageModel` Prompt API), never a downloaded or bundled generative model; cloud decision APIs (TypeSafe's Jev,
  OpenAI) are off by default, each needs its own opt-in, only uncertain posts escalate, one primary provider, no
  chaining; testing = Playwright E2E plus live checks in the owner's Chrome; the owner types API keys; goal: small,
  cheap, fast, private. Source: `scratchpad/team/shared/setup-facts.md`.
  Recorded 2026-10-11 with the forward sweep and a `STANDING` line to every seat. The testing half is
  🧪 Testing's to record in `docs/TEST-STANDARD.md` (test policy, rulebook §3b), sent to it as a `TASK`.

## Project facts this seat relies on
_(measured 2026-10-10 unless marked)_
- **Product:** ScrollCollector, a Chrome MV3 extension (plain ES modules, no bundler) that collects posts from
  social feeds (LinkedIn, X, YouTube, Facebook, Instagram, Medium, custom sites) into a side panel and decides per
  post whether it matches the user's prompt and which tag it gets. Version 0.9.0 in `package.json` and `manifest.json`.
- **The owner:** Fauzul (GitHub `fauzulkc`). Repo `github.com/fauzulkc/ScrollCollector`. The owner publishes, signs,
  spends and types API keys; live checks run in the owner's Chrome via Claude-in-Chrome.
- **Branches:** work is on `feat/decision-cascade` (level with `origin/feat/decision-cascade`). `origin/main` is
  `dfc49cf` (merge of PR #6, the decision cascade up to `de93678`); `feat/decision-cascade` carries 4 commits not on
  main (`c573df6`, `7fcaa4c`, `0c42d0c`, `44f04d3`). Local `main` is stale at `63f86ef`. Others: `feature/v0.9-ui`,
  `wip/inference-router`, `backup/decision-cascade-pre-split`; origin also has `try-simple-export` and 5 dependabot branches.
- **Release state:** tags `v0.6.0`..`v0.9.0` (all dated 2026-07-01); HEAD is `v0.9.0-23-g44f04d3`. `gh release list`
  returns nothing (no GitHub releases). Chrome Web Store listing state: UNVERIFIED.
- **No CI:** no `.github/workflows/`. Every check runs locally in WSL.
- **Uncommitted setup output:** `docs/`, `.claude/`, `CLAUDE.md` untracked and `.gitignore` modified (`git status`):
  the team docs are not in git yet.
- **How sessions reach the repo:** the repo lives in WSL Ubuntu-24.04 at `/home/fauzul/code/ScrollCollector`
  (Windows: `\\wsl.localhost\Ubuntu-24.04\home\fauzul\code\ScrollCollector`). Run git/npm from WSL only: from Windows,
  write a script to scratch and run `MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu-24.04 -- bash -l /mnt/c/<script>`.
- **Register counts** (§1 step 4): rows `grep -c '^| \*\*DEC-' docs/DECISIONS.md`; ruled
  `grep -cE '^\| \*\*DEC-.*(✅|❌)' docs/DECISIONS.md`. Both 2 on 2026-10-10; both 8 on 2026-10-11.
- **Health check:** no running service; the product's live state is the built `dist/ext/` loaded in the owner's
  Chrome (via `npm run sync:win` → `/mnt/d/code/ScrollCollector-dev`). Only the owner's Chrome proves "live".

## Traps paid for
- **The code chose before the register did** (rulebook trap 3): the cascade's AI direction was in code
  (`lib/decision/cascade.js` header: "the only LLM tier is the browser's built-in LanguageModel") for days with no
  decision row; closed 2026-10-11 by DEC-3..5.
- **README drift** (fixed 2026-10-11 by ⚙️ Engineering in `d090913`): `README.md` described Gemini Nano plus a rule
  engine and not the System 1 embedding model; a claim read from README is still a hypothesis until re-read.
- **A session rooted outside the repo has no seat skills or tier workers** (2026-10-11): sessions opened in
  `D:\Projects\scrollcollector` cannot run `/seat-*` or spawn `<team>-worker`, so the work runs on generic agents at
  the session's own model. Open or move seats to `\\wsl.localhost\Ubuntu-24.04\home\fauzul\code\ScrollCollector`
  (the app's change-directory tool rejects the `D:\code` symlink; moving a session there loads the skills and workers).
- **Peers commit mid-run:** a release test leg on a moving HEAD proves nothing. Pin the leg to a commit in a detached
  worktree, and merge that commit, not HEAD (0.10.0: `ee68247`).
- **Windows git:** shows spurious exec-bit diffs on `.sh` files and its credential helper hangs; use WSL git (setup-facts).
- **No CI:** "green" exists only as a pasted local run; never infer a colour from a commit subject.
- **Site DOMs rot:** LinkedIn's 2026 layout broke collection (`c573df6`); a release can go stale without a code change.
- **MV3 forbids remote code** (`e0c0df6`): anything "downloaded at runtime" is out by policy and by the store.

## Done means here
- The ruling is a row in `docs/DECISIONS.md` with full timestamp, owner's words verbatim when given, a command for
  any set or count, and a reopen condition for any park; register counts match.
- The forward sweep across `docs/` (and `README.md`/`BUILD.md` where they state the ruled thing) finds no stale line,
  and every seat it binds has a `RULED`/`STANDING` line in its inbox.
- Committed with explicit paths (`ceo: …` subject), then pushed per DEC-2 after the checks; push reported after.
- Nothing outward (store, release) done by you: it sits as a question in `docs/team/owner-questions.md`.
