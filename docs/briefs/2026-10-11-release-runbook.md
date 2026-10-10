# Release runbook: the decision cascade on the Chrome Web Store (DEC-8)

**Written by the 🧭 CEO, 2026-10-11.** Part A is the seats' preparation; Part B is the owner's (DEC-2:
submitting, publishing, signing and spending are owner-only). Facts about the store marked _check_ were not
re-verified against the store's current pages when written; the extension seat confirms them in Part A.

## Part A · Seats prepare (in this order)
| # | task | seat | done when |
|---|---|---|---|
| 1 | Version bump past 0.9.0 (tag `v0.9.0` exists) in `manifest.json` and `package.json` | 🧷 Extension | both files agree |
| 2 | A store-zip step: `npm run build:ext`, then zip the **contents** of `dist/ext/` (manifest.json at the zip root, bundled models included). `package-release.sh` and `BUILD.md` build the old installer from source files without the models: fix or mark them | 🧷 Extension | the zip loads unpacked in Chrome and System 1 reaches ready |
| 3 | `docs/STORE-LISTING.md`: one justification per permission (all 10 plus `<all_urls>`), the single-purpose sentence, the data-use answers, "no remote code" | 🧷 Extension | no "_to write_" left |
| 4 | A privacy policy draft: what is stored (on the device only), what leaves it (post text to TypeSafe or OpenAI only when the user opts in, DEC-5), no selling or sharing | 🧷 Extension drafts; owner approves the words | draft in `docs/`, flagged for the owner's read |
| 5 | Full run on the release commit: `npm test`, `npm run test:e2e` (and `npm run test:eval` if calibration changed) | 🧪 Testing | output pasted in its run log |
| 6 | Review of the release commit and the listing | ⚖️ Bar Raiser | PASS in `docs/briefs/` |
| 7 | Merge `feat/decision-cascade` into `main`, push, tag the version | 🧭 CEO | origin/main at the release commit |

## Part B · The owner (after Part A)
1. **Developer account** (one time): sign in at the Chrome Web Store developer dashboard
   (`chrome.google.com/webstore/devconsole`), pay the one-time registration fee (_check_ the amount), verify
   your email. This is spend: yours.
2. **Host the privacy policy** at a public URL (e.g. a GitHub Pages page or a page on your site).
3. **New item → upload** the zip from Part A step 2.
4. **Store listing tab**: description (from `docs/STORE-LISTING.md`), category, language, the 128×128 icon,
   at least one screenshot (1280×800 or 640×400, _check_), small promo tile 440×280 (_check_).
5. **Privacy tab**: paste the single purpose, each permission justification, "No, I am not using remote code",
   the data-use checkboxes, and the privacy policy URL.
6. **Distribution**: choose visibility. Recommendation: **Unlisted** first (only people with the link can install),
   then switch to Public once you've used the store build for a few days.
7. **Submit for review.** Broad host access (`<all_urls>`) usually means a longer review (_check_ current times).
   If rejected, forward the reason to the 🛎️ Chief of Staff; the extension seat fixes and you resubmit.
8. After approval: tell the CEO, who records the release and lets lenses merge.
