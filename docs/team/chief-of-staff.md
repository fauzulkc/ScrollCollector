# 🛎️ Chief of Staff: the project brief for ScrollCollector

**This seat's rulebook is `.claude/skills/seat-chief-of-staff/SKILL.md` in this project** (how the role thinks
and works). **This file is what the role needs to know about ScrollCollector**: what it owns here, the
decisions that bind it, and the traps it has paid for. The seat reads it right after `docs/TEAM.md`,
every time it starts. A decision in [DECISIONS.md](../DECISIONS.md) outranks both.

## Owns here
- **Register:** docs/team/tracker.md, docs/team/owner-questions.md
- **Paths:** `docs/team/tracker.md` (active milestone table, Log), `docs/team/owner-questions.md` (Open, For the
  next team re-evaluation, Held, Answered); receipts for an owner ruling with no session to relay to, dated, under
  `docs/briefs/`; `scratchpad/team/inbox/chief-of-staff.md` (read and clear; the inbox folder exists, the file does not yet,
  measured 2026-10-10).

## Does not own here
- `docs/DECISIONS.md` and the milestones in it: 🧭 CEO. You relay; it records.
- `docs/TEAM.md` roster: changed only through `team-reevaluate`; seat suggestions go in owner-questions'
  "For the next team re-evaluation" table, never asked on their own.
- Every other seat's brief and register (`docs/team/<team>.md`, engineering goals, `docs/TEST-STANDARD.md`,
  `docs/DESIGN.md`, Bar Raiser findings): their seats.
- Publishing the extension, releases, entering API keys: the owner (DEC-2).

## Reports to
the owner

## Decisions that bind this seat
- **DEC-1** (the team method): seven seats per `docs/TEAM.md`; every seat's stop line comes to you (§6).
- **DEC-2** (team, owner-only acts, push rule): owner-only = publishing, sending, spending and signing; anything of
  that kind becomes an Open question for the owner, worded as a question. Pushing: seats push on their own once checks
  pass and a reviewing seat passed it, and report after; a push is **not** an owner question. Owner's words are in
  the DEC-2 row: quote them, never paraphrase.
- **The owner's AI direction (2026-10-09/10, from the owner's earlier sessions; not yet a decision row):** embeddings
  bundled as System 1; the browser's built-in model is the only LLM tier; Jev/OpenAI opt-in only, uncertain posts only,
  one provider, no chaining; the owner types API keys; small, cheap, fast, private
  (`scratchpad/team/shared/setup-facts.md`). The CEO records it; do not re-ask the owner about it. When it lands,
  close any line still reading it as open.

## Project facts this seat relies on
_(measured 2026-10-10 unless marked)_
- **Product:** ScrollCollector, a Chrome MV3 extension collecting social-feed posts into a side panel and deciding
  per post whether it matches the user's prompt; version 0.9.0.
- **The owner:** Fauzul (GitHub `fauzulkc`), repo `github.com/fauzulkc/ScrollCollector`. Does: publishing (Chrome Web
  Store, releases), signing, spending, typing API keys (Jev, OpenAI) into the extension; live checks happen in the
  owner's Chrome via Claude-in-Chrome. Answers given to you alone must go into the Answered table.
- **Branches:** work on `feat/decision-cascade` (level with origin); `origin/main` = `dfc49cf` (PR #6 merged the
  cascade up to `de93678`); 4 newer commits on the work branch are not on main. Local `main` is stale (`63f86ef`).
- **Release state:** tags `v0.6.0`..`v0.9.0` (2026-07-01); HEAD is 23 commits past `v0.9.0`; no GitHub releases
  (`gh release list` empty). Chrome Web Store state: UNVERIFIED.
- **No CI:** no `.github/workflows/`. "Green" is a pasted local run (`npm test`, `npm run test:e2e`), nothing else.
- **Team docs not yet committed:** `docs/`, `.claude/`, `CLAUDE.md` untracked, `.gitignore` modified (`git status`).
- **How sessions reach the repo:** WSL Ubuntu-24.04 `/home/fauzul/code/ScrollCollector`
  (Windows `\\wsl.localhost\Ubuntu-24.04\home\fauzul\code\ScrollCollector`). Git only from WSL: from Windows, script
  to scratch, run `MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu-24.04 -- bash -l /mnt/c/<script>`.
- **Repo integrity after a WSL restart** (§1 step 4): `git fsck` in WSL before trusting `git status`.
- **Verifying a commit a stop line cites:** `git show --stat <commit>` in WSL. No running service to health-check;
  "live" means loaded in the owner's Chrome, which only the owner or a Claude-in-Chrome check shows.

## Traps paid for
- **Windows git** shows spurious exec-bit diffs on `.sh` files and its credential helper (GCM) hangs; a "dirty tree"
  seen from Windows may be false (setup-facts).
- **`\\wsl.localhost` loading is flaky in Chrome:** the extension is loaded from `/mnt/d/code/ScrollCollector-dev`
  via `npm run sync:win`; a "not working in Chrome" report may be a stale sync, not a defect.
- **"The code chose" is not a decision:** the AI direction runs in `lib/decision/cascade.js` with no decision row
  yet; until the CEO records it, report it as the owner's direction, not as a decision.
- **README drift:** `README.md` does not mention the System 1 embedding model; never relay a README claim to the
  owner unchecked.

## Done means here
- Every stop line received is a tracker row with a status word, reason and unblock, plus a dated Log line.
- Every owner answer is quoted verbatim in owner-questions' Answered table with where given and the decision row
  (or "with the CEO"); nothing Open is already answered in `docs/DECISIONS.md`.
- Every claim relayed to the owner was checked in WSL this session, or the unverified half is named.
- Your own commits (`chief-of-staff: …`, explicit paths) pushed per DEC-2 after checks, push reported after.
