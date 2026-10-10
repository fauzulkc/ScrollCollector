/**
 * Prompt lenses (ENG-1, DEC-6): the prompts the USER wrote, each scored on every decided post.
 *
 * A lens is
 *  - the match prompt, id `main`, when it is non-empty, and
 *  - every enabled tag the user added (`isLens: true`, set by TAG_ADDED and by the v3 migration);
 *    its lens id is the tag's `id`, so a rename keeps its scores.
 * userLenses() lists them all. `main` is SCORED, fingerprinted and collects only while the match-prompt
 * switch is on (scoredLenses()): a gate-off configuration ignores its match prompt entirely, and
 * test/unit/ingest-config-race.test.js pins that its fingerprint does not move with the prompt.
 * Never a lens: the 25 built-in topic tags, dynamic tags, pseudo tags, the Ads tag. They label and
 * filter; they never gate (DEC-6, 01:05 addendum).
 *
 * Each lens either COLLECTS or only sorts (DEC-6, owner 02:27): `main` collects while its switch is on;
 * an `isLens` tag collects unless `collects === false` (absent = true). Every lens is scored; the gate
 * is on when at least one lens collects and a post is collected when ANY collecting lens matches. With
 * no collecting lens nothing is filtered.
 *
 * A lens tag is also still a label: tag classification (questions.js) treats it like any other tag.
 *
 * `decision.lenses = { [lensId]: score }`, 0..1 rounded to 4 places, every enabled lens on every
 * decided post (below 0.5 too). A score is the calibrated `matches_prompt` probability of that
 * prompt (same question, same `calibration.match`), so for `main` it equals `decision.pMatch`.
 *
 * "Matched" is ONE test and ONE function (isLensMatch): the lens score reaches the strictness
 * threshold. The cascade's gate, the idle refinement, the side panel's pill count, its list and its
 * chips all use it (docs/DESIGN.md P-2); the score label is lensScoreLabel() (D-3).
 *
 * Pure: no chrome APIs, no imports; importable by the service worker, the offscreen document and
 * the side panel.
 */

export const STRICTNESS_THRESHOLDS = Object.freeze({ strict: 0.7, balanced: 0.5, lenient: 0.3 });
export const DEFAULT_STRICTNESS = 'balanced';
/** Lens id of the match prompt. */
export const LENS_MAIN_ID = 'main';
/** Question id prefix of a lens question (`lens:<lensId>`). */
export const LENS_QUESTION_PREFIX = 'lens:';
/** Most lens questions one post sends to its one escalation provider. */
export const MAX_ESCALATED_LENSES = 10;

/** Labels that are filters in the UI, never lenses (same set as lib/decision/questions.js). */
const NON_LENS_LABELS = new Set(['Ads', 'All', 'Favorites', 'Unclassified']);

/**
 * @typedef {object} LensDef
 * @property {string} id            `main` or the tag's id
 * @property {string|null} label    the tag's label; null for `main` (the panel names it)
 * @property {string} text          what the user wrote: the prompt (a tag with a blank prompt: the stored
 *                                  default "Find posts related to <label>.")
 * @property {boolean} collects     whether a match on this lens collects the post (see the module comment)
 */

/** @param {unknown} v */
function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * True for a tag the user added (not a built-in label, not dynamic, not pseudo, not Ads). Used by the
 * v3 migration to set `isLens`; `built-in` is decided by the caller's label list
 * (lib/bg/defaults.js DEFAULT_TAG_LABELS) so this module needs no import.
 *
 * @param {any} tag
 * @param {Iterable<string>} builtInLabels   labels of the built-in tags (compared case-insensitively)
 */
export function isUserAddedTag(tag, builtInLabels = []) {
  if (!tag || typeof tag !== 'object') return false;
  const label = str(tag.label);
  if (!label || NON_LENS_LABELS.has(label)) return false;
  if (tag.isDynamic === true || tag.isPseudo === true) return false;
  const lower = label.toLowerCase();
  for (const builtIn of builtInLabels) if (String(builtIn).toLowerCase() === lower) return false;
  return true;
}

/** The text a tag without a prompt of its own is scored with (what TAG_ADDED stores by default). */
export function defaultLensText(label) {
  return `Find posts related to ${label}.`;
}

/**
 * The lenses of a configuration as ONE ordered array: `main` first (when the match prompt is
 * non-empty), then every enabled `isLens` tag in configured order. The panel derives colour.
 *
 * Whether `main` is also SCORED and gates depends on the match-prompt switch: see scoredLenses().
 *
 * @param {any} configuration
 * @returns {LensDef[]}
 */
export function userLenses(configuration) {
  const cfg = configuration && typeof configuration === 'object' ? configuration : {};
  /** @type {LensDef[]} */
  const out = [];
  const main = str(cfg.matchPrompt);
  if (main) out.push({ id: LENS_MAIN_ID, label: null, text: main, collects: !!cfg.isMatchPromptEnabled });
  const seen = new Set([LENS_MAIN_ID]);
  for (const tag of Array.isArray(cfg.trackedTags) ? cfg.trackedTags : []) {
    if (!tag || typeof tag !== 'object' || tag.isLens !== true) continue;
    const id = str(tag.id);
    const label = str(tag.label);
    if (!id || !label || seen.has(id)) continue;
    if (tag.isEnabled === false || tag.isDynamic === true || tag.isPseudo === true || NON_LENS_LABELS.has(label)) continue;
    seen.add(id);
    out.push({ id, label, text: str(tag.prompt) || defaultLensText(label), collects: tag.collects !== false });
  }
  return out;
}

/**
 * The lenses that are scored, fingerprinted and gate: userLenses() minus `main` while the match-prompt
 * switch is off (a gate-off configuration ignores the match prompt entirely, as it always has).
 * @param {any} configuration
 * @returns {LensDef[]}
 */
export function scoredLenses(configuration) {
  const on = !!(configuration && configuration.isMatchPromptEnabled);
  return userLenses(configuration).filter((l) => l.id !== LENS_MAIN_ID || on);
}

/**
 * The lenses whose match collects a post: `main` while the switch is on, and every lens tag with
 * `collects !== false`.
 * @param {any} configuration
 * @returns {LensDef[]}
 */
export function collectingLenses(configuration) {
  return scoredLenses(configuration).filter((l) => l.collects);
}

/**
 * The collection gate: at least one lens collects. With none, everything is collected.
 * @param {any} configuration
 */
export function isLensGateOn(configuration) {
  return collectingLenses(configuration).length > 0;
}

/**
 * Score a lens needs to count as matched: STRICTNESS_THRESHOLDS[intelligence.gate.strictness]
 * ('balanced' when unset or unknown).
 * @param {any} configuration
 */
export function lensThreshold(configuration) {
  const s = configuration && configuration.intelligence && configuration.intelligence.gate && configuration.intelligence.gate.strictness;
  return STRICTNESS_THRESHOLDS[Object.prototype.hasOwnProperty.call(STRICTNESS_THRESHOLDS, s) ? s : DEFAULT_STRICTNESS];
}

/**
 * The one "matched" test.
 * @param {unknown} score
 * @param {any} configuration
 */
export function isLensMatch(score, configuration) {
  return typeof score === 'number' && Number.isFinite(score) && score >= lensThreshold(configuration);
}

/**
 * The lenses of `configuration` that `decision` matched, best first. Scores of lenses that no
 * longer exist are ignored; a lens the decision has no score for is not matched.
 *
 * @param {any} decision   an item's decision
 * @param {any} configuration
 * @returns {{ id: string, label: string|null, score: number }[]}
 */
export function matchedLenses(decision, configuration) {
  const scores = decision && decision.lenses && typeof decision.lenses === 'object' ? decision.lenses : null;
  if (!scores) return [];
  return scoredLenses(configuration)
    .filter((l) => Object.prototype.hasOwnProperty.call(scores, l.id) && isLensMatch(scores[l.id], configuration))
    .map((l) => ({ id: l.id, label: l.label, score: scores[l.id] }))
    .sort((a, b) => b.score - a.score);
}

/**
 * The number shown next to a prompt (DESIGN.md D-3): the score as a whole number 0..100, no "%".
 * @param {unknown} score
 * @returns {number|null}
 */
export function lensScoreLabel(score) {
  return typeof score === 'number' && Number.isFinite(score) ? Math.round(score * 100) : null;
}

/** @param {string} lensId */
export function lensQuestionId(lensId) {
  return `${LENS_QUESTION_PREFIX}${lensId}`;
}

/** @param {string} questionId */
export function isLensQuestionId(questionId) {
  return typeof questionId === 'string' && questionId.startsWith(LENS_QUESTION_PREFIX);
}

/**
 * What a stored verdict depends on besides the post, for the lens part of decisionFingerprint:
 * adding, removing, enabling, renaming a lens or editing its prompt changes it.
 * @param {any} configuration
 * @returns {string[][]}
 */
export function lensFingerprintParts(configuration) {
  return scoredLenses(configuration).map((l) => [l.id, l.label ?? '', l.text, l.collects]);
}

/**
 * The collection verdict over a post's lenses (the cascade and the idle refinement share it).
 *
 * Per lens: `decisive` is true when its score is a settled answer (a confident model answer, an
 * escalator's answer, or a rules answer); an undecisive score is "unsure". The post is collected
 * when any decisive lens reaches the threshold; otherwise, if any lens is unsure or has no score,
 * `whenUnsure` decides; otherwise it is rejected. With one lens this is exactly the old
 * single-prompt gate.
 *
 * `settled` is stricter than `decisive` (a rules answer is decisive for the verdict but never
 * confident): the post is certain when some settled lens matched or every lens is settled.
 *
 * @param {{ noul: number|null, decisive: boolean, settled: boolean }[]} entries
 * @param {{ threshold: number, whenUnsure: 'collect'|'skip' }} policy
 * @returns {{ collect: boolean, uncertain: boolean }}
 */
export function lensGateVerdict(entries, { threshold, whenUnsure }) {
  const list = Array.isArray(entries) ? entries : [];
  const hit = (e) => typeof e.noul === 'number' && e.noul >= threshold;
  const yes = list.some((e) => e.decisive && hit(e));
  const unsure = list.some((e) => typeof e.noul !== 'number' || !e.decisive);
  const collect = yes ? true : unsure || !list.length ? whenUnsure !== 'skip' : false;
  const certain = list.some((e) => e.settled && hit(e)) || (list.length > 0 && list.every((e) => e.settled));
  return { collect, uncertain: !certain };
}
