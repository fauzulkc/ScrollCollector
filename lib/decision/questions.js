/**
 * Question builders. Every provider (System 1, the browser's built-in LanguageModel, Jev, OpenAI,
 * rules) answers these same Jev-style primitives (lib/decision/types.js):
 *  - matches_prompt : noul built from the user's RAW prompt (plus a cleaned topic phrase)
 *  - primary_tag    : choice over the enabled, non-pseudo tags plus 'none'; option order is rotated
 *                     per post to counter first-option bias
 *  - tag:<label>    : optional per-tag nouls (multi-label)
 *
 * Instructions are literal and positive (no negations), see lintInstructions().
 */
import { Q } from './types.js';

export const NONE_OPTION = 'none';
export const NONE_DESCRIPTION = 'None of these categories fits the post';
/** Jev's limit on choice options (including 'none'). */
export const MAX_CHOICE_OPTIONS = 255;
export const MATCH_INSTRUCTIONS = 'Is the main subject of this post something the reader asked for?';
export const PRIMARY_TAG_INSTRUCTIONS = 'Which category best describes the main subject of this post?';
export const OTHER_SUBJECT = 'The post is mainly about another subject.';

/** Labels that are filters in the UI, never classification targets. */
const PSEUDO_TAG_LABELS = new Set(['Ads', 'All', 'Favorites', 'Unclassified']);
const MAX_PROMPT_CHARS = 600;
const MAX_DESCRIPTION_CHARS = 300;

const LEAD_PLEASE_RE = /^(?:please|pls|kindly)\b[\s,]*/i;
const LEAD_REQUEST_RE = /^(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?(?:find|show|collect|get|give|gather|surface|fetch|bring)\b(?:\s+me)?(?:\s+all)?(?:\s+(?:the|any))?(?:\s+(?:posts?|content|articles|updates|stuff))?(?:\s+(?:about|on|regarding|related\s+to|of))?\s*/i;
const LEAD_INTEREST_RE = /^(?:i\s+am|i'm|im)\s+(?:really\s+|very\s+|so\s+|deeply\s+)?(?:fascinated|interested|curious|passionate)\s+(?:by|in|about)\s+/i;
const LEAD_WANT_RE = /^i(?:'d\s+like|\s+(?:want|would\s+like|love|like|enjoy))(?:\s+to\s+(?:see|read|find))?(?:\s+(?:more\s+)?(?:posts?|content|stuff))?(?:\s+(?:about|on|regarding|related\s+to))?\s+/i;
const TRAILING_NOUN_RE = /\s+(?:posts?|content|updates)$/i;

/** @param {unknown} s */
function oneLine(s) {
  return typeof s === 'string' ? s.normalize('NFKC').replace(/\s+/g, ' ').trim() : '';
}

/** @param {string} s */
function stripEndPunct(s) {
  return s.replace(/[\s.,;:!?]+$/, '');
}

/**
 * Strips request boilerplate from a prompt so the remainder names the topic:
 * "find me restaurant and 5 star quality food posts. I am fascinated by michelin star cooking"
 * -> "restaurant and 5 star quality food; michelin star cooking".
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function cleanPrompt(raw) {
  const text = oneLine(raw);
  if (!text) return '';
  const fragments = text
    .split(/(?<=[.!?;])\s+/)
    .map((fragment) => {
      let f = stripEndPunct(fragment.trim());
      for (let i = 0; i < 4; i++) {
        const before = f;
        f = f.replace(LEAD_PLEASE_RE, '').replace(LEAD_REQUEST_RE, '').replace(LEAD_INTEREST_RE, '').replace(LEAD_WANT_RE, '');
        if (f === before) break;
      }
      return stripEndPunct(f.replace(TRAILING_NOUN_RE, '').trim());
    })
    .filter(Boolean);
  return fragments.join('; ');
}

/**
 * Tag description from its classification prompt ("Identify posts related to health, …" ->
 * "health, …").
 *
 * @param {unknown} prompt
 * @returns {string|null}
 */
export function describeTag(prompt) {
  let s = oneLine(prompt);
  if (!s) return null;
  s = s.replace(/^identify\s+(?:(?:any\s+)?posts?\s+(?:that\s+(?:are|is)\s+)?(?:related\s+to|relating\s+to|about|on|regarding|covering)\s+)?/i, '');
  s = s.replace(/^references\s+to\s+/i, '');
  s = stripEndPunct(s).slice(0, MAX_DESCRIPTION_CHARS);
  return s || null;
}

/**
 * Enabled, non-pseudo, de-duplicated tags with their descriptions, in configured order.
 * Accepts trackedTags objects ({label, prompt, isEnabled, isPseudo}), {label, description}
 * entries or plain label strings.
 *
 * @param {unknown} tags
 * @returns {{ label: string, description: string|null }[]}
 */
export function selectQuestionTags(tags) {
  /** @type {{ label: string, description: string|null }[]} */
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(tags) ? tags : []) {
    const tag = typeof raw === 'string' ? { label: raw } : raw;
    if (!tag || typeof tag !== 'object') continue;
    const label = oneLine(tag.label ?? tag.name);
    if (!label) continue;
    // isLens tags are prompts scored by the match recipe (lib/decision/lenses.js), not categories.
    if (tag.isEnabled === false || tag.isPseudo === true || tag.isLens === true || PSEUDO_TAG_LABELS.has(label)) continue;
    const key = label.toLowerCase();
    if (key === NONE_OPTION || seen.has(key)) continue;
    seen.add(key);
    const description = 'description' in tag
      ? (oneLine(tag.description).slice(0, MAX_DESCRIPTION_CHARS) || null)
      : describeTag(tag.prompt);
    out.push({ label, description });
  }
  return out;
}

/**
 * Deterministic rotation offset in [0, n) for a numeric or string seed.
 * @param {number|string} seed
 * @param {number} n
 */
export function rotationOffset(seed, n) {
  if (!(n > 1)) return 0;
  let s;
  if (typeof seed === 'number' && Number.isFinite(seed)) {
    s = Math.abs(Math.floor(seed));
  } else {
    // FNV-1a 32-bit over the string form
    let h = 0x811c9dc5;
    const str = String(seed ?? '');
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    s = h >>> 0;
  }
  return s % n;
}

/**
 * matches_prompt question. Returns null for an empty prompt.
 *
 * @param {string} rawPrompt     the user's prompt, verbatim
 * @param {string} [expansion]   optional short topic phrase (e.g. generated by the browser's LanguageModel)
 * @returns {import('./types.js').NoulQuestion|null}
 */
export function buildMatchQuestion(rawPrompt, expansion) {
  const raw = oneLine(rawPrompt).replace(/"/g, "'").slice(0, MAX_PROMPT_CHARS);
  if (!raw) return null;
  const topic = stripEndPunct(oneLine(expansion) || cleanPrompt(raw) || raw);
  return {
    type: 'noul',
    instructions: `${MATCH_INSTRUCTIONS} Reader request: "${raw}"`,
    criteria: {
      true: `The post is mainly about ${topic}.`,
      false: OTHER_SUBJECT
    }
  };
}

/**
 * primary_tag question over the enabled, non-pseudo tags plus 'none' (always last). The tag
 * options are rotated by `seed`, so the same post always sees the same order while the first
 * position is spread across tags. Returns null when no tag qualifies.
 *
 * @param {unknown} tags   trackedTags (or selectQuestionTags() output)
 * @param {number|string} [seed]
 * @returns {import('./types.js').ChoiceQuestion|null}
 */
export function buildPrimaryTagQuestion(tags, seed = 0) {
  const entries = selectQuestionTags(tags).slice(0, MAX_CHOICE_OPTIONS - 1);
  if (!entries.length) return null;
  const offset = rotationOffset(seed, entries.length);
  const rotated = entries.slice(offset).concat(entries.slice(0, offset));
  /** @type {Record<string, string|null>} */
  const criteria = {};
  for (const { label, description } of rotated) criteria[label] = description;
  criteria[NONE_OPTION] = NONE_DESCRIPTION;
  return { type: 'choice', instructions: PRIMARY_TAG_INSTRUCTIONS, criteria };
}

/**
 * Per-tag yes/no questions keyed `tag:<label>`.
 *
 * @param {(string|{ label: string, description?: string|null })[]} labels
 * @param {Record<string, string|null>} [descriptions]  label -> description
 * @returns {Record<string, import('./types.js').NoulQuestion>}
 */
export function buildTagNouls(labels, descriptions = {}) {
  /** @type {Record<string, import('./types.js').NoulQuestion>} */
  const out = {};
  for (const raw of Array.isArray(labels) ? labels : []) {
    const label = oneLine(typeof raw === 'string' ? raw : raw?.label);
    if (!label || label.toLowerCase() === NONE_OPTION) continue;
    const desc = oneLine((typeof raw === 'object' && raw?.description) || descriptions?.[label] || '') || label;
    out[`${Q.TAG_PREFIX}${label}`] = {
      type: 'noul',
      instructions: `Does this post belong to the category "${label}"?`,
      criteria: {
        true: `The post is mainly about ${stripEndPunct(desc)}.`,
        false: OTHER_SUBJECT
      }
    };
  }
  return out;
}

const NEGATION_RE = /\bnot\b|n't|\bnever\b/i;

/**
 * Rejects negations in question instructions (models follow positive, literal conditions more
 * reliably). Quoted text (the user's own request, labels) is ignored.
 *
 * @param {string|import('./types.js').Question|Record<string, import('./types.js').Question>} questions
 * @returns {{ ok: boolean, issues: { id: string, text: string }[] }}
 */
export function lintInstructions(questions) {
  /** @type {[string, string][]} */
  let entries;
  if (typeof questions === 'string') entries = [['text', questions]];
  else if (questions && typeof questions === 'object' && typeof questions.instructions === 'string') entries = [['question', questions.instructions]];
  else entries = Object.entries(questions || {}).map(([id, q]) => [id, q?.instructions ?? '']);
  const issues = [];
  for (const [id, text] of entries) {
    const unquoted = String(text).replace(/"[^"]*"/g, '""');
    if (NEGATION_RE.test(unquoted)) issues.push({ id, text: String(text) });
  }
  return { ok: issues.length === 0, issues };
}
