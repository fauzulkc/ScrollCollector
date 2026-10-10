/**
 * normalize.js
 *
 * Pure normalisation helpers for the ingest pipeline: post identity, ignore-list matching and
 * text hygiene. No chrome APIs.
 */

import { hostMatchesDomain } from '../sites.js';

/** Content scripts never send more than this; enforced again here so no stored item exceeds it. */
export const MAX_TEXT_LEN = 2000;

/**
 * Accepts the v0.9 `{ name, weight }` objects as well as plain strings; returns trimmed, de-duplicated strings.
 *
 * @param {unknown} list
 * @returns {string[]}
 */
export function toTagStrings(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const t of list) {
    let name = '';
    if (typeof t === 'string') name = t;
    else if (t && typeof t === 'object') name = typeof t.name === 'string' ? t.name : (typeof t.label === 'string' ? t.label : '');
    name = name.trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}

/**
 * NFKC (folds LinkedIn's math-bold letters), lower-case, collapsed whitespace.
 *
 * @param {string} s
 */
export function normalizeForMatch(s) {
  return String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** @param {string} s */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whole-word / whole-phrase match on normalised text: 'ai' matches "AI tools" but not "said".
 *
 * @param {string} normalizedText  output of normalizeForMatch()
 * @param {string} keyword         raw keyword as the user typed it
 */
export function containsKeyword(normalizedText, keyword) {
  const kw = normalizeForMatch(keyword);
  if (!kw || !normalizedText) return false;
  const body = kw.split(' ').map(escapeRegExp).join('\\s+');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${body}(?:$|[^\\p{L}\\p{N}_])`, 'u').test(normalizedText);
}

/**
 * @param {string} text
 * @param {string[]} keywords
 * @returns {string|null} the first matching keyword
 */
export function findIgnoredKeyword(text, keywords) {
  if (!Array.isArray(keywords) || keywords.length === 0) return null;
  const normalized = normalizeForMatch(text);
  for (const kw of keywords) {
    if (typeof kw === 'string' && containsKeyword(normalized, kw)) return kw;
  }
  return null;
}

/** @param {string} platform */
export function normalizePlatform(platform) {
  let p = String(platform || '').trim().toLowerCase().replace(/^www\./, '');
  if (p === 'twitter.com' || p.endsWith('.twitter.com')) p = 'x.com';
  return p;
}

/**
 * Host vs. an ignore-list entry, with the same normalization as content.js (scheme, path, port,
 * 'www.' and '*.' are tolerated; twitter.com is x.com on both sides).
 *
 * @param {string} host
 * @param {string} domain
 */
export function domainMatches(host, domain) {
  return hostMatchesDomain(host, domain);
}

/** @param {string} url */
function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** URL shapes that identify ONE post (not a profile, company page, feed or the page itself). */
const PERMALINK_PATTERNS = [
  /linkedin\.com\/feed\/update\/[^/?#]+/i,
  /linkedin\.com\/posts\/[^/?#]+/i,
  /linkedin\.com\/pulse\/[^/?#]+/i,
  /\/status(?:es)?\/\d+/i,
  /youtube\.com\/watch\?(?:[^#]*&)?v=[\w-]+/i,
  /youtube\.com\/shorts\/[\w-]+/i,
  /youtu\.be\/[\w-]+/i,
  /news\.ycombinator\.com\/item\?(?:[^#]*&)?id=\d+/i,
  /facebook\.com\/.+\/(?:posts|videos|photos|permalink)\/[\w.-]+/i,
  /facebook\.com\/(?:permalink|story)\.php\?/i,
  /facebook\.com\/(?:reel|watch)\/?[?\w]/i,
  /instagram\.com\/(?:p|reel|tv)\/[\w-]+/i,
  /medium\.com\/.+-[0-9a-f]{8,}(?:[?#]|$)/i,
  /github\.com\/[^/]+\/[^/]+\/(?:issues|pull|discussions|releases|commit)\/[^/?#]+/i
];

/**
 * True only for URLs that are certainly a single post's permalink. Legacy items were stored with
 * company-page / profile / page URLs, so URL-based de-duplication is only safe for these.
 *
 * @param {unknown} url
 */
export function isRealPermalink(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
  if (!hostOf(url)) return false;
  return PERMALINK_PATTERNS.some(re => re.test(url));
}

/** @param {string} url */
export function canonicalUrl(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    return String(url || '');
  }
}

/**
 * FNV-1a 32-bit over the string, plus its length (stable fallback key for posts without identity).
 *
 * @param {string} s
 */
export function hashText(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${s.length.toString(36)}${(h >>> 0).toString(36)}`;
}

/** Trailing "…more" / "... see more" expander markers left by truncated feed cards. */
const MORE_MARKER_RE = /\s*(?:…|\.{3})\s*(?:see\s+)?more\s*$/i;

/** @param {string} text */
export function stripMoreMarker(text) {
  return String(text || '').replace(MORE_MARKER_RE, '').trim();
}

/**
 * Post identity for a TEXT_EXTRACTED payload. New content scripts send postKey/postUrl; legacy
 * payloads only had sourceUrl, which is trusted only when it is a real permalink.
 *
 * @param {{ postKey?: string, postUrl?: string, sourceUrl?: string }} payload
 * @param {string} platform
 * @param {string} text
 * @returns {{ postKey: string, postUrl: string }}
 */
export function derivePostIdentity(payload, platform, text) {
  const rawUrl = typeof payload.postUrl === 'string' && payload.postUrl
    ? payload.postUrl
    : (typeof payload.sourceUrl === 'string' ? payload.sourceUrl : '');
  const postUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : '';
  if (typeof payload.postKey === 'string' && payload.postKey.trim()) {
    return { postKey: payload.postKey.trim(), postUrl };
  }
  if (isRealPermalink(postUrl)) {
    return { postKey: `url:${canonicalUrl(postUrl)}`, postUrl };
  }
  return { postKey: `h:${platform}:${hashText(normalizeForMatch(text))}`, postUrl };
}
