/**
 * Decision state: the normalized text every decision provider sees, plus the stable hashes the
 * cascade uses as cache keys (`specHash:textHash`).
 *
 * Pure functions (no browser APIs beyond TextEncoder), shared by the service worker, the offscreen
 * System 1 host and the Node eval harness.
 */

/** Default cap for the text sent to any provider (the stack keeps up to 2,000 chars). */
export const DECISION_MAX_CHARS = 1500;

const ZERO_WIDTH_RE = /[​-‍⁠-⁤﻿­᠎]/g;
/** Header line prepended by content.js: "Post by: X (bio)", "Tweet by: X", "Comment by X:". */
const HEADER_RE = /^\s*(?:post|tweet|comment)\s+by\b[^\n]*(?:\n|$)/i;
/**
 * The other attribution lines content.js writes around the post text. They name people (the
 * reshared author, a Reel's author, a YouTube channel), not the topic, and the author is a separate
 * field that only reaches a cloud provider when the user opts in (escalation.sendAuthor):
 *  - LinkedIn reshare: a line "Reshared from <name>:" (or "Reshared post:") before the original text
 *  - Facebook Reel: a last line "Author: <name>"
 *  - YouTube video: "Channel: <name>" after the title, optionally followed by an "Info: ..." line
 *  - Hacker News / Medium (stored before content.js sent the author separately): a trailing
 *    byline "By: <name>", on its own last line (HN) or at the end of the one-line text (Medium)
 */
const RESHARE_LINE_RE = /^[ \t]*reshared (?:from [^\n]*|post):[ \t]*$/gim;
const TRAILING_AUTHOR_RE = /\n[ \t]*author:[^\n]*\s*$/i;
const CHANNEL_LINE_RE = /\n[ \t]*channel:[^\n]*(?=(?:\n[ \t]*info:[^\n]*)?\s*$)/i;
/** "By: <name>" at the very end; the name holds no ':' so only the last byline can match. */
const TRAILING_BYLINE_RE = /(^|\s)By:[ \t]+([^\n:]{1,60}?)\s*$/;
/** A byline names someone: a few words, not a sentence. */
const MAX_BYLINE_WORDS = 6;

/**
 * Removes a trailing "By: <name>" byline (see above). Conservative: only the capitalised marker
 * content.js wrote, at the very end, followed by a short name-like run (no ':' and at most
 * MAX_BYLINE_WORDS words), so ordinary prose ending in "by" is kept.
 *
 * @param {string} s
 * @returns {string}
 */
function stripTrailingByline(s) {
  const m = TRAILING_BYLINE_RE.exec(s);
  if (!m) return s;
  const name = m[2].trim();
  if (!name || name.split(/\s+/).length > MAX_BYLINE_WORDS || /[!?]$/.test(name)) return s;
  return s.slice(0, m.index + m[1].length);
}
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
const LNKD_RE = /\blnkd\.in\/\S*/gi;
/** Pictographs plus the joiners/modifiers that only make sense next to one. */
const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}︎️⃣]/gu;
const HASHTAG_RE = /#(?=[\p{L}\p{N}_])/gu;

/**
 * Normalizes post text for every decision provider:
 * NFKC (folds LinkedIn's math-bold letters), strips zero-width characters, the leading
 * "Post by …" / "Tweet by …" / "Comment by …" header line and the other attribution lines
 * content.js adds ("Reshared from …:", a trailing "Author: …", "Channel: …", a trailing
 * "By: …" byline), URLs and lnkd.in links, emoji, turns '#word' into 'word', collapses whitespace
 * and truncates on a word boundary.
 *
 * @param {unknown} text
 * @param {{ maxChars?: number }} [opts]
 * @returns {string}
 */
export function normalizeForDecision(text, { maxChars = DECISION_MAX_CHARS } = {}) {
  let s = typeof text === 'string' ? text : text == null ? '' : String(text);
  s = s.normalize('NFKC').replace(ZERO_WIDTH_RE, '').replace(/\r\n?/g, '\n');
  s = s.replace(HEADER_RE, '');
  s = s.replace(RESHARE_LINE_RE, '').replace(TRAILING_AUTHOR_RE, '').replace(CHANNEL_LINE_RE, '');
  s = stripTrailingByline(s.trimEnd());
  s = s.replace(URL_RE, ' ').replace(LNKD_RE, ' ');
  s = s.replace(EMOJI_RE, '');
  s = s.replace(HASHTAG_RE, '');
  s = s.replace(/\s+/g, ' ').trim();
  return truncateOnWord(s, maxChars);
}

/**
 * @param {string} s
 * @param {number} max
 */
function truncateOnWord(s, max) {
  if (!Number.isFinite(max) || max <= 0 || s.length <= max) return s;
  let cut = s.slice(0, max);
  if (s[max] !== ' ') {
    const lastSpace = cut.lastIndexOf(' ');
    // Only back off to a word boundary when that keeps most of the text.
    if (lastSpace >= max * 0.6) cut = cut.slice(0, lastSpace);
  }
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1); // never end on half a surrogate pair
  return cut.trimEnd();
}

const encoder = new TextEncoder();

/**
 * FNV-1a 64-bit over the UTF-8 bytes, as 16 hex chars. Implemented with four 16-bit limbs so it
 * stays fast without BigInt (prime = 2^40 + 0x1b3).
 *
 * @param {unknown} text
 * @returns {string}
 */
export function textHash(text) {
  const bytes = encoder.encode(typeof text === 'string' ? text : text == null ? '' : String(text));
  // offset basis 0xcbf29ce484222325, lowest limb first
  let h0 = 0x2325;
  let h1 = 0x8422;
  let h2 = 0x9ce4;
  let h3 = 0xcbf2;
  for (let i = 0; i < bytes.length; i++) {
    h0 ^= bytes[i];
    const t0 = h0 * 0x1b3;
    const t1 = h1 * 0x1b3 + (t0 >>> 16);
    const t2 = h2 * 0x1b3 + ((h0 & 0xff) << 8) + (t1 >>> 16);
    const t3 = h3 * 0x1b3 + ((h0 >>> 8) | ((h1 & 0xff) << 8)) + (t2 >>> 16);
    h0 = t0 & 0xffff;
    h1 = t1 & 0xffff;
    h2 = t2 & 0xffff;
    h3 = t3 & 0xffff;
  }
  return [h3, h2, h1, h0].map((h) => h.toString(16).padStart(4, '0')).join('');
}

/**
 * JSON with object keys sorted at every level, so equal specs hash equally whatever the key order.
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    const json = JSON.stringify(value);
    return json === undefined ? 'null' : json;
  }
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined && typeof value[k] !== 'function')
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * Hash of everything that changes what the questions mean for System 1: prompt, expansion, tag
 * labels/descriptions, model, dtype and calibration ids.
 *
 * @param {object} ctxParts
 * @returns {string}
 */
export function specHash(ctxParts) {
  return textHash(stableStringify(ctxParts ?? null));
}

/**
 * @param {{ text?: string, textSnippet?: string, platform?: string, sourcePlatform?: string, author?: string, authorName?: string }} item
 * @param {{ maxChars?: number }} [opts]
 * @returns {import('./types.js').DecisionState}
 */
export function buildDecisionState(item, opts) {
  const raw = item?.text ?? item?.textSnippet ?? '';
  const text = normalizeForDecision(raw, opts);
  /** @type {import('./types.js').DecisionState} */
  const state = {
    text,
    textHash: textHash(text),
    platform: String(item?.platform || item?.sourcePlatform || '')
  };
  const author = item?.author ?? item?.authorName;
  if (typeof author === 'string' && author.trim()) state.author = author.trim();
  return state;
}
