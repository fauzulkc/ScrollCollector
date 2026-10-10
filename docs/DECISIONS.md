# Decisions: ScrollCollector

**The owner's decision register, kept by the 🧭 CEO.** A decision here outranks every seat's
rulebook and `docs/TEAM.md`. Seats propose; the CEO records; the owner decides what only the owner
may (anything outward, any spend, anything that cannot be undone).

**How a decision is kept.**
- One row per decision, numbered `DEC-n` in order; never renumber, never delete.
- The row carries the question, the evidence (commits, files), the decision, and the owner's words
  verbatim when the owner gave them.
- A later change is a dated line appended to the row, and the operative sentence is fixed in place.
- After recording, search the docs for every line that still reads "pending", "proposed" or
  "waiting on the owner" for this question, and close each one.
- Tell every seat the decision binds (`RULED` to its inbox, or `STANDING` to all seats).

| Decision | Question | Evidence | Decided |
|---|---|---|---|
| **DEC-1** | The team method: seats, workers, tiers and the shared rulebook | `docs/TEAM.md` | ✅ 2026-10-10: the team is seated as `docs/TEAM.md`'s roster lists, set up with `team-setup` |
| **DEC-2** | Which team (Recommended/Lean/Full), what only the owner does, and should seats push on their own or ask each time? | docs/team/plan.json | ✅ 2026-10-10: seated 🧭 CEO, 🛎️ Chief of Staff, ⚙️ Engineering, 🧪 Testing, ⚖️ Bar Raiser, 📐 Design, 🧷 Browser-extension engineer. Declined: nothing. Owner's words: "Team: Recommended (7 seats). Owner-only: publishing, sending, spending and signing (default, stated). Pushing: On its own." |
| **DEC-3** | What is System 1, the first tier that decides every post? | `lib/decision/cascade.js` header; `9f3a603` (System 1 in the offscreen document); `offscreen/system1-host.js` loads weights, ORT wasm and calibration only through `runtime.getURL`; `lib/storage/schema.js` system1 default `model: 'minilm', dtype: 'q8'`; `e0c0df6` (MV3 forbids remote code) | ✅ 2026-10-11 00:27 +0600: a small q8 sentence-embedding model (MiniLM default, bge-small-en-v1.5 selectable) run with Transformers.js in the offscreen document, **weights bundled in the package, nothing downloaded at runtime**. The idle refinement averaging both bundled models (`7fcaa4c`) sits inside this ruling. Recorded, not asked: the owner gave this direction in their sessions of 2026-10-09/10 (TEAM.md §7). Owner's words: not captured verbatim; the setup summary is in `scratchpad/team/shared/setup-facts.md` ("Owner direction"). Two-way inside the ruling (which bundled model is default); one-way outward (a runtime download changes what the store reviews). |
| **DEC-4** | Which language model may the extension use? | `lib/decision/cascade.js` header ("The only LLM tier is the browser's built-in LanguageModel"); `lib/decision/providers/nano.js`; the old Qwen 0.5B WebGPU tier retired in `e0c0df6` | ✅ 2026-10-11 00:27 +0600: **the only language-model tier is the browser's built-in model** (Chrome's Gemini Nano through the `LanguageModel` Prompt API). Never add a downloaded or bundled generative model. Refused: the Qwen 0.5B WebGPU tier and any successor of its kind. Reopen condition: Chrome removes the built-in `LanguageModel` API, or the owner names a generative model by name in this row. Recorded from the owner's 2026-10-09/10 direction (same source as DEC-3); goal stated by the owner: small, cheap, fast, private. |
| **DEC-5** | When may a post leave the device for a cloud decision API (TypeSafe's Jev, OpenAI)? | `lib/storage/schema.js:36-38` (`jev`, `openai` `enabled: false`); `cascade.js` step 4 (one primary provider, no chaining, only questions System 1 answered with low confidence); `refine.js` header (refinement never calls a cloud provider) | ✅ 2026-10-11 00:27 +0600: **never by default.** Each cloud provider needs its own opt-in; only posts System 1 answered with low confidence escalate; the user picks **one** primary provider; providers are never chained; the idle refinement never calls the cloud. **The owner types API keys themselves**: no seat, worker or test stores or types a real key, and a cloud call on the owner's key is spend (DEC-2). Recorded from the owner's 2026-10-09/10 direction (same source as DEC-3). Command that checks the defaults: `sed -n 36,38p lib/storage/schema.js` (jev `enabled: false` on line 36, openai `enabled: false` on line 38). |
