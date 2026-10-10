# Chrome Web Store listing: ScrollCollector (draft)

**Kept by the 🧷 Browser-extension engineer; publishing is the owner's.** This file is the working draft of
everything the Chrome Web Store asks for: the description, one justification per permission and host
permission in `manifest.json`, the single-purpose statement, and the data-use disclosures. The seat updates
it in the same commit as any change to `manifest.json` (a permission, a host pattern, the CSP or a new remote
endpoint), so the listing never claims less than the code does. Words a user reads follow the seat that owns
them, or are flagged for the owner's read. Nothing here is submitted by a seat: submitting, publishing and
signing are owner-only (`docs/DECISIONS.md`, DEC-2); a ready draft goes to the owner as a question through
the Chief of Staff.

## Permissions to justify (from `manifest.json` 0.9.0, 2026-10-10)
Justifications not yet written: each needs the code that uses it and why a narrower option fails.

| Permission | Justification |
|---|---|
| storage | _to write_ |
| activeTab | _to write_ |
| sidePanel | _to write_ |
| favicon | _to write_ |
| tabs | _to write_ |
| scripting | _to write_ |
| alarms | _to write_ |
| offscreen | _to write_ |
| idle | _to write_ |
| unlimitedStorage | _to write_ |
| host: `<all_urls>` (and content scripts on `<all_urls>`) | _to write; broad host access lengthens review_ |
