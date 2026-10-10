/**
 * ScrollCollector – Content Script
 * ────────────────────────────────
 * Platform-aware post extraction with:
 *   • Stable post identity (postKey + canonical permalink per platform, text hash elsewhere)
 *   • Outermost post boundaries only (reshares, quotes and comments belong to their post)
 *   • MutationObserver (debounced 250ms) + "…more" expansion re-dispatch (isUpdate)
 *   • Inline PII sanitization (email, phone, credit card w/ Luhn)
 *   • Configuration fetched from the service worker by message: storage.local is
 *     TRUSTED_CONTEXTS-only, so content scripts cannot read it
 *   • Decisions kept in this isolated world; written onto post elements (data-sc-status /
 *     data-sc-reason / data-sc-tag / data-sc-pmatch + a badge) only in the opt-in debug mode,
 *     because the page's own scripts can read its DOM
 *
 * Classic script (content scripts can't import ES modules); message names mirror lib/messages.js.
 * No external dependencies.  Designed to be lightweight.
 */

(function () {
  'use strict';

  // Double-injection guard. The marker is an object so a fresh injection can retire an
  // orphaned instance whose extension context died (extension reload / update).
  const previousInstance = window.__scrollCollectorLoaded;
  if (previousInstance) {
    const alive = typeof previousInstance.isAlive !== 'function' || previousInstance.isAlive();
    if (alive) return;
    try { previousInstance.teardown(); } catch { /* already gone */ }
  }

  // ════════════════════════════════════════════════════════════════════════
  // §1  PII SANITIZER  (inlined – content scripts can't import ES modules)
  // ════════════════════════════════════════════════════════════════════════

  const EMAIL_RE     = /\b[\w.-]+@[\w.-]+\.\w{2,}\b/g;
  const PHONE_RE     =
    /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b|\+\d{1,3}\s\d{3}\s\d{4}\s\d{4}/g;
  const CC_CANDIDATE = /\b(?:\d[ -]*?){13,19}\b/g;

  /**
   * Luhn (mod-10) checksum validation.
   * @param {string} digits – digits-only string
   * @returns {boolean}
   */
  function passesLuhn(digits) {
    let sum = 0;
    let alt = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let n = parseInt(digits[i], 10);
      if (alt) { n *= 2; if (n > 9) n -= 9; }
      sum += n;
      alt = !alt;
    }
    return sum % 10 === 0;
  }

  /**
   * Replace PII tokens in text.
   * Order: credit cards → phones → emails.
   * @param {string} text
   * @returns {string}
   */
  function sanitize(text) {
    if (typeof text !== 'string') return text;

    let s = text;

    // Credit cards (Luhn-validated first to avoid phone overlap)
    s = s.replace(CC_CANDIDATE, function (m) {
      const d = m.replace(/[\s-]/g, '');
      return d.length >= 13 && d.length <= 19 && passesLuhn(d)
        ? '[REDACTED_CC]'
        : m;
    });

    s = s.replace(PHONE_RE, '[REDACTED_PHONE]');
    s = s.replace(EMAIL_RE, '[REDACTED_EMAIL]');

    return s;
  }

// ════════════════════════════════════════════════════════════════════════
// §2  CONSTANTS & STATE
// ════════════════════════════════════════════════════════════════════════

/** Message types (mirror of lib/messages.js) */
const MSG = Object.freeze({
  TEXT_EXTRACTED: 'TEXT_EXTRACTED',
  GET_CONTENT_CONFIG: 'GET_CONTENT_CONFIG',
  PING: 'PING',
  RESET_AND_RESCAN: 'RESET_AND_RESCAN',
  DECISION_RESULT: 'DECISION_RESULT',
  CONTENT_CONFIG_UPDATED: 'CONTENT_CONFIG_UPDATED'
});

/** Tags whose subtrees should never be extracted */
const NOISE_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'NAV', 'FOOTER', 'HEADER',
  'SVG', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'IFRAME', 'A'
]);

/** Block-level containers we scan for generic text fallback */
const CONTENT_TAGS = new Set([
  'DIV', 'ARTICLE', 'SECTION', 'P', 'LI', 'BLOCKQUOTE',
  'TD', 'FIGCAPTION', 'MAIN', 'SPAN'
]);

/** Platform hostname (sent as sourcePlatform) */
const SOURCE_PLATFORM = window.location.hostname;
const HOST = SOURCE_PLATFORM.toLowerCase();

function hostIs(domain) {
  return HOST === domain || HOST.endsWith('.' + domain);
}

/** Extraction / identity strategy for this page */
const PLATFORM =
  hostIs('linkedin.com') ? 'linkedin' :
  (hostIs('x.com') || hostIs('twitter.com')) ? 'x' :
  hostIs('youtube.com') ? 'youtube' :
  hostIs('facebook.com') ? 'facebook' :
  hostIs('instagram.com') ? 'instagram' :
  hostIs('medium.com') ? 'medium' :
  hostIs('github.com') ? 'github' :
  hostIs('news.ycombinator.com') ? 'hn' :
  'generic';

const IS_PREDEFINED = PLATFORM !== 'generic';

/**
 * Post boundaries per platform. On a known platform these always win over the generic
 * selectors below, and the OUTERMOST match is the post (reshares, quotes, comments and
 * per-post wrappers all collapse into it).
 */
const PLATFORM_BOUNDARY_SELECTORS = {
  linkedin: [
    // 2026 feed (/feed/foryou/): obfuscated classes, one listitem card per post
    '[role="listitem"][componentkey^="update-card"]',
    '[data-testid="JobsHomeFeedModuleListCollection"] a[componentkey][href*="/jobs/"]',
    'a[componentkey][href*="currentJobId="]',
    'div.feed-shared-update-v2', 'div.occludable-update',
    '[data-urn*="urn:li:activity:"]', '[data-urn*="urn:li:share:"]', '[data-urn*="urn:li:ugcPost:"]',
    '[data-id*="urn:li:activity:"]',
    '.job-card-container', '.jobs-search-results__list-item', '.job-card-list' // LinkedIn Jobs
  ],
  x: ['article[data-testid="tweet"]'],
  facebook: [
    'div[data-pagelet^="FeedUnit_"]', 'div[data-pagelet^="ReelsConsumerVideoSheet"]', 'div[data-pagelet^="ReelsUnit"]', 'div[data-pagelet^="Reel_"]',
    '[data-testid="key__feed_story"]', 'div[data-testid="fbfeed_story"]', '[role="article"]'
  ],
  youtube: [
    'ytd-rich-item-renderer', 'ytd-video-renderer', 'ytd-compact-video-renderer', 'ytd-grid-video-renderer', 'ytd-reel-video-renderer',
    'ytd-comment-thread-renderer'
  ],
  hn: ['tr.athing']
};

/** Generic boundaries. "Strong" ones are whole posts; class-based ones often match parts of a post. */
const GENERIC_STRONG_SELECTORS = ['article', '[role="article"]', 'div.postArticle'];
const GENERIC_WEAK_SELECTORS = ['[class*="post-"]', '[class*="article-"]'];

const PLATFORM_BOUNDARY_SEL = (PLATFORM_BOUNDARY_SELECTORS[PLATFORM] || []).join(', ');
const GENERIC_STRONG_SEL = GENERIC_STRONG_SELECTORS.join(', ');
const GENERIC_BOUNDARY_SEL = GENERIC_STRONG_SELECTORS.concat(GENERIC_WEAK_SELECTORS).join(', ');

/** Minimum / maximum accepted text length */
const MIN_TEXT_LEN = 60;
const MAX_TEXT_LEN = 2000;

/** Minimum text-to-HTML ratio for generic scanning */
const MIN_TEXT_RATIO = 0.4;

/** Debounce interval for MutationObserver (ms) */
const DEBOUNCE_MS = 250;

/** "…more" expansion: wait for the DOM to settle, re-dispatch only when the text grew by more than this */
const EXPANSION_DEBOUNCE_MS = 400;
const EXPANSION_MAX_WAIT_MS = 1200;
const EXPANSION_MIN_GROWTH = 20;

/** GET_CONTENT_CONFIG retry backoff while the service worker starts up */
const CONFIG_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000];

/** Attribute used to mark already-processed elements */
const PROCESSED_ATTR = 'data-scrollcollector-processed';
/** postKey of a processed post element (DECISION_RESULT finds the element by it) */
const KEY_ATTR = 'data-sc-key';
/** Marks the debug badge so extraction and the observer ignore it */
const BADGE_ATTR = 'data-sc-badge';
const ANNOTATION_ATTRS = ['data-sc-status', 'data-sc-reason', 'data-sc-tag', 'data-sc-pmatch'];

/** Upper bound for the per-key memory below */
const MAX_REMEMBERED_KEYS = 5000;

/** postKey -> length of the text last dispatched for it */
const sentLengths = new Map();

/** postKey -> last DECISION_RESULT (re-applied when the platform re-renders the post) */
const decisions = new Map();

/** Elements collected by the density fallback (re-read the same way on expansion) */
const blockElements = new WeakSet();

/** Configuration from the service worker; null until it answers (nothing is dispatched before) */
let contentConfig = null;
let isSiteEnabled = false;
let isPaused = false;
let tornDown = false;

/** True once platform-specific post markup was seen; generic selectors then stay off */
let platformMarkupSeen = false;

/** Debounce timer id */
let debounceTimer = null;
let recheckTimer = null;
let recheckFirstAt = 0;
let configRetryTimer = null;

// ════════════════════════════════════════════════════════════════════════
// §3  UTILITY HELPERS
// ════════════════════════════════════════════════════════════════════════

/**
 * Fast, simple string hash (djb2).
 * @param {string} str
 * @returns {number}
 */
function hashString(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * Second, independent 32-bit hash (FNV-1a) so text-hash keys don't rely on djb2 alone.
 * @param {string} str
 * @returns {number}
 */
function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash;
}

/** Collapses whitespace runs while keeping line / paragraph breaks. */
function cleanWhitespace(s) {
  return String(s || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const BLOCK_TEXT_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIGCAPTION', 'FIGURE',
  'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'OL', 'P', 'PRE',
  'SECTION', 'TABLE', 'TR', 'UL'
]);
const SKIP_TEXT_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'BUTTON', 'SVG', 'IFRAME', 'INPUT', 'TEXTAREA',
  'SELECT', 'IMG', 'VIDEO', 'AUDIO', 'CANVAS'
]);
/** Screen-reader-only duplicates (LinkedIn renders names and "hashtag" labels twice) */
const HIDDEN_CLASS_RE = /(?:^|\s)(?:visually-hidden|a11y-text|sr-only|screen-reader-text)(?:\s|$)/;

/**
 * Reads the visible text of an element without innerText on every descendant: <br> and
 * block elements become line breaks; buttons ("…more"), screen-reader duplicates and our
 * own badge are skipped.
 * @param {Element} root
 * @param {boolean} [isBody] post bodies honour `white-space: pre*` line breaks
 * @returns {string}
 */
function readText(root, isBody = false) {
  if (!root) return '';
  let preserve = false;
  if (isBody) {
    try {
      preserve = /^pre/.test(window.getComputedStyle(root).whiteSpace || '');
    } catch {
      // detached / no styles: treat whitespace as collapsible
    }
  }
  const out = [];
  const walk = (node) => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3) {
        out.push(preserve ? child.data : child.data.replace(/[ \t\n\r\f]+/g, ' '));
        continue;
      }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName.toUpperCase();
      if (tag === 'BR') { out.push('\n'); continue; }
      if (SKIP_TEXT_TAGS.has(tag) || child.hidden) continue;
      if (child.getAttribute('role') === 'button' || child.hasAttribute(BADGE_ATTR)) continue;
      if (HIDDEN_CLASS_RE.test(child.getAttribute('class') || '')) continue;
      const block = BLOCK_TEXT_TAGS.has(tag);
      if (block) out.push('\n');
      walk(child);
      if (block) out.push('\n');
    }
  };
  walk(root);
  return cleanWhitespace(out.join(''));
}

/** Trailing "…more" / "...more" / "See more" / "Show more" / "Read more" (and "See less"). */
const MORE_MARKER_RE = /(?:\s*(?:…|\.{3})\s*(?:(?:see|show|read)\s+)?more|(?:^|\s+)(?:see|show|read)\s+(?:more|less))\s*$/i;

/**
 * Strips expander labels left at the end of truncated post text.
 * @param {string} text
 * @returns {string}
 */
function stripMoreMarkers(text) {
  let s = String(text || '').trim();
  for (let i = 0; i < 3; i++) {
    const next = s.replace(MORE_MARKER_RE, '').trim();
    if (next === s) break;
    s = next;
  }
  return s;
}

/** Shortens text to `max` chars at a word boundary, ending with an ellipsis. */
function truncateText(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const atWord = cut.replace(/\s+\S*$/, '');
  return (atWord.length > max * 0.8 ? atWord : cut) + '…';
}

/** Basis for text-hash post keys: NFKC, case- and whitespace-insensitive, first 400 chars. */
function normalizeForKey(text) {
  let s = String(text || '');
  try { s = s.normalize('NFKC'); } catch { /* keep as is */ }
  return s.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 400);
}

/**
 * Parses an href into an absolute http(s) URL, or null.
 * @param {string|null} href
 * @returns {URL|null}
 */
function toUrl(href) {
  const h = (href || '').trim();
  if (!h || h.startsWith('#') || /^(?:javascript|mailto|tel|data):/i.test(h)) return null;
  try {
    const url = new URL(h, window.location.href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** Absolute URL string for an href ('' when unusable). */
function toAbsolute(href) {
  const url = toUrl(href);
  return url ? url.href : '';
}

function baseHost(hostname) {
  return String(hostname || '').toLowerCase().replace(/^www\./, '');
}

function isSameSite(hostname) {
  const a = baseHost(hostname);
  const b = baseHost(HOST);
  return a === b || a.endsWith('.' + b) || b.endsWith('.' + a);
}

/** Remembers the dispatched text length for a key (bounded, oldest first out). */
function rememberSent(postKey, length) {
  sentLengths.delete(postKey);
  sentLengths.set(postKey, length);
  if (sentLengths.size > MAX_REMEMBERED_KEYS) {
    sentLengths.delete(sentLengths.keys().next().value);
  }
}

/**
 * Checks whether an element or any of its ancestors is a noise tag or
 * has already been processed.
 * @param {Element} el
 * @returns {boolean} true if the element should be skipped
 */
function isNoiseOrProcessed(el) {
  let node = el;
  while (node && node !== document.body) {
    if (NOISE_TAGS.has(node.tagName)) return true;
    if (node.hasAttribute && node.hasAttribute(PROCESSED_ATTR)) return true;
    node = node.parentElement;
  }
  return false;
}

/**
 * Normalizes a stored site/ignore domain: tolerates schemes, "www.", paths, ports and
 * trailing slashes. twitter.com is folded into x.com (as the background does).
 * Copy of lib/sites.js normalizeDomain (a classic script cannot import it); change both together.
 * @param {string} value
 * @returns {string}
 */
function normalizeDomain(value) {
  let d = String(value || '').trim().toLowerCase();
  if (d === '*') return d;
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  d = d.replace(/^\*\./, '');
  d = d.split(/[/?#]/)[0];
  d = d.replace(/:\d+$/, '').replace(/\.+$/, '');
  d = d.replace(/^www\./, '');
  if (d === 'twitter.com' || d.endsWith('.twitter.com')) d = 'x.com';
  return d;
}

/**
 * Checks if a hostname matches any enabled site configurations.
 * A '*' entry enables every site; otherwise the first exact / subdomain match decides,
 * and well-known feeds are enabled unless explicitly disabled.
 */
function checkIfSiteEnabled(hostname, sites) {
  const lowerHost = normalizeDomain(hostname);
  const defaultSites = ['facebook.com', 'linkedin.com', 'x.com', 'instagram.com', 'youtube.com', 'medium.com', 'github.com', 'news.ycombinator.com'];

  if (sites && sites.length > 0) {
    const anySite = sites.find(s => s && s.domain === '*');
    if (anySite && anySite.isEnabled) {
      return true;
    }

    const match = sites.find(s => {
      if (!s || s.domain === '*') return false;
      const domain = normalizeDomain(s.domain);
      return !!domain && (lowerHost === domain || lowerHost.endsWith('.' + domain));
    });
    if (match) {
      return match.isEnabled !== false;
    }
  }

  // Default sites are enabled unless explicitly disabled in config
  return defaultSites.some(d => lowerHost === d || lowerHost.endsWith('.' + d));
}

/** True when the host is on the ignored-domains list (the background would drop its posts). */
function isIgnoredHost(hostname, ignoredDomains) {
  const host = normalizeDomain(hostname);
  return (ignoredDomains || []).some(entry => {
    const d = normalizeDomain(entry);
    return !!d && d !== '*' && (host === d || host.endsWith('.' + d));
  });
}

// ════════════════════════════════════════════════════════════════════════
// §4  POST IDENTITY & LINKS
// ════════════════════════════════════════════════════════════════════════

/** Paths that are never a post: profiles, company pages, listings, hashtags, search. */
const NON_POST_PATH_RES = [
  /^\/(?:company|in|school|showcase)(?:\/|$)/i,
  /^\/groups\/[^/]+\/?$/i,
  /\/posts\/?$/i,
  /^\/feed\/?$/i,
  /\/hashtag(?:\/|$)/i,
  /\/search(?:\/|$)/i,
  /^\/@[^/]+\/?$/,
  /^\/(?:channel|user|c)\/[^/]+\/?$/i,
  /^\/jobs\/?$/i
];

/** Path/query fragments that identify a single post, video, issue, job… */
const PERMALINK_RE = /\/feed\/update\/|\/posts\/|\/status\/|\/p\/|\/watch|\/shorts\/|\/videos?\/|\/articles?\/|\/pulse\/|\/reels?\/|\/jobs\/view\/|\/item\?id=|\/permalink|story_fbid=|\/issues\/\d|\/pull\/\d|\/discussions\/\d/i;

function isNonPostUrl(url) {
  return NON_POST_PATH_RES.some(re => re.test(url.pathname));
}

function isCurrentPage(url) {
  return url.href.split('#')[0] === String(window.location.href).split('#')[0];
}

/**
 * Finds the post's own link. Searches ONLY inside the container (walking out of a post is
 * how other posts' permalinks and company pages ended up as source URLs), rejects
 * profile/company/listing/hashtag/search URLs and never falls back to the page URL.
 *
 * @param {Element} container
 * @returns {string} Absolute URL string, or '' when the post has no usable link
 */
function findNearestLink(container) {
  if (!container || !container.querySelectorAll) return '';
  const anchors = Array.from(container.querySelectorAll('a[href]'));
  if (container.matches && container.matches('a[href]')) anchors.unshift(container);

  let fallback = '';
  for (const a of anchors) {
    const url = toUrl(a.getAttribute('href'));
    if (!url || isCurrentPage(url) || isNonPostUrl(url)) continue;
    if (IS_PREDEFINED && !isSameSite(url.hostname)) continue;
    if (PERMALINK_RE.test(url.pathname + url.search)) return url.href;
    if (!fallback && !IS_PREDEFINED) fallback = url.href;
  }
  return fallback;
}

// --- LinkedIn ---

const LI_URN_SEL = '[data-urn*="urn:li:activity"], [data-urn*="urn:li:share"], [data-urn*="urn:li:ugcPost"], [data-id*="urn:li:activity"]';
const LI_URN_RE = /urn:li:(?:activity|share|ugcPost):[A-Za-z0-9_-]+/;
/** Embedded original post of a reshare */
const LI_NESTED_SEL = '.update-components-mini-update-v2, .feed-shared-mini-update-v2, .update-components-reshare, .feed-shared-update-v2__reshare';
/** Parts of a post that are not the post: comments and social counts */
const LI_EXCLUDED_SEL = '[class*="comments-"], .social-details-social-counts, .feed-shared-social-action-bar';
const LI_TEXT_SEL = '.update-components-text, .feed-shared-update-v2__commentary, .feed-shared-text';
const LI_ATTACHMENT_SEL = '.update-components-article__title, .update-components-article__subtitle, .feed-shared-article__title';
/** Actor selectors, tried in priority order (the title also holds the "• 2nd" degree label) */
const LI_ACTOR_NAME_SELS = [
  '.update-components-actor__title span[aria-hidden="true"]',
  '.update-components-actor__name span[aria-hidden="true"]',
  '.update-components-actor__name'
];
const LI_ACTOR_LINK_SELS = [
  'a.update-components-actor__meta-link',
  '.update-components-actor a[href*="/in/"], .update-components-actor a[href*="/company/"]'
];
const LI_ACTOR_BIO_SEL = '.update-components-actor__description';

/** Canonical activity/share/ugcPost URN carried by an element (comment URNs excluded). */
function linkedInUrnOf(el) {
  if (!el || !el.getAttribute) return null;
  for (const attr of ['data-urn', 'data-id']) {
    const value = el.getAttribute(attr);
    if (!value || value.startsWith('urn:li:comment')) continue;
    const m = LI_URN_RE.exec(value);
    if (m) return m[0];
  }
  return null;
}

/** URN encoded in a LinkedIn permalink (/feed/update/<urn>/ or /posts/<slug>-activity-<id>-…). */
function linkedInUrnFromHref(href) {
  let h = href || '';
  try { h = decodeURIComponent(h); } catch { /* keep raw */ }
  const direct = /\/feed\/update\/(urn:li:(?:activity|share|ugcPost):[A-Za-z0-9_-]+)/.exec(h);
  if (direct) return direct[1];
  const slug = /\/posts\/[^/?#]*-(activity|share|ugcPost)-(\d+)/.exec(h);
  return slug ? 'urn:li:' + slug[1] + ':' + slug[2] : null;
}

/**
 * 2026 LinkedIn feed card: `[role=listitem][componentkey="update-card-focus<token>FeedType_…"]`.
 * Classes are obfuscated and there is no data-urn; the body lives in
 * [data-testid="expandable-text-box"] and the author only in "Hide post by <name>" labels.
 */
const LI_CARD_SEL = '[role="listitem"][componentkey^="update-card"]';
const LI_CARD_TEXT_SEL = '[data-testid="expandable-text-box"]';
const LI_CARD_AUTHOR_LABEL_RE = /^(?:Hide post by|Open control menu for post by)\s+(.+?)\s*$/;

function linkedInCardOf(container) {
  if (!container || !container.closest) return null;
  return container.closest(LI_CARD_SEL);
}

function linkedInCardIdentity(card) {
  const key = card.getAttribute('componentkey') || '';
  const m = /^update-card-(?:focus)?(.+?)(?:FeedType_.*)?$/.exec(key);
  if (!m || !m[1]) return null;
  // The post URN only lives in React props: ask the main-world bridge
  // (lib/content/linkedin-urn-bridge.js). dispatchEvent is synchronous across worlds.
  let urn = null;
  try {
    card.dispatchEvent(new CustomEvent('sc:urn-request', { bubbles: true }));
    const bridged = card.getAttribute('data-sc-urn');
    card.removeAttribute('data-sc-urn');
    const found = bridged ? LI_URN_RE.exec(bridged) : null;
    if (found) urn = found[0];
  } catch { /* bridge missing: fall back to an in-card permalink */ }
  if (!urn && /FeedType_FEED_DETAIL/.test(key)) {
    // The post's own page (/feed/update/<urn>/): the detail card IS that post.
    urn = linkedInUrnFromHref(window.location.pathname);
  }
  if (!urn) {
    const link = card.querySelector('a[href*="/feed/update/urn:li:"]');
    urn = link ? linkedInUrnFromHref(link.getAttribute('href')) : null;
  }
  // The URN is stable across page loads (the card token may not be) and matches classic-layout keys.
  return urn
    ? { postKey: 'li:' + urn, postUrl: 'https://www.linkedin.com/feed/update/' + urn + '/' }
    : { postKey: 'li:card:' + m[1], postUrl: '' };
}

function linkedInCardAuthor(card) {
  let name = '';
  for (const el of card.querySelectorAll('[aria-label]')) {
    const m = LI_CARD_AUTHOR_LABEL_RE.exec(el.getAttribute('aria-label') || '');
    if (m) { name = m[1]; break; }
  }
  let url = '';
  if (name) {
    for (const a of card.querySelectorAll('a[href*="/in/"], a[href*="/company/"]')) {
      if ((a.textContent || '').trim() === name) {
        url = normalizeLinkedInAuthorUrl(a.getAttribute('href'));
        break;
      }
    }
  }
  return { name, url };
}

/** 2026 jobs home: each job is a link card `<a componentkey=…>` (title, company, location, age). */
const LI_JOB_CARD_SEL = '[data-testid="JobsHomeFeedModuleListCollection"] a[componentkey][href*="/jobs/"], a[componentkey][href*="currentJobId="]';

function linkedInJobCardOf(container) {
  if (!container || !container.matches) return null;
  if (container.matches(LI_JOB_CARD_SEL)) return container;
  return container.closest ? container.closest(LI_JOB_CARD_SEL) : null;
}

function linkedInJobIdFromHref(href) {
  const m = /[?&]currentJobId=(\d+)/.exec(href || '') || /\/jobs\/view\/(\d+)/.exec(href || '');
  return m ? m[1] : '';
}

function extractLinkedInText(container, ownUrn) {
  const jobCard = linkedInJobCardOf(container);
  if (jobCard) {
    const text = readText(jobCard, true).replace(/\n{2,}/g, '\n').trim();
    return text ? `Job posting:\n${text}` : '';
  }
  return extractLinkedInPostText(container, ownUrn);
}

function extractLinkedInCardText(card) {
  const box = card.querySelector(LI_CARD_TEXT_SEL);
  const body = box ? stripMoreMarkers(readText(box, true)) : '';
  if (!body) return '';
  const { name } = linkedInCardAuthor(card);
  return name ? `Post by: ${name}\n\n${body}` : body;
}

function linkedInIdentity(container) {
  const jobCard = linkedInJobCardOf(container);
  if (jobCard) {
    const jobId = linkedInJobIdFromHref(jobCard.getAttribute('href'));
    if (jobId) return { postKey: 'li:job:' + jobId, postUrl: 'https://www.linkedin.com/jobs/view/' + jobId + '/' };
  }

  const card = linkedInCardOf(container);
  if (card) {
    const cardIdentity = linkedInCardIdentity(card);
    if (cardIdentity) return cardIdentity;
  }

  let urn = linkedInUrnOf(container.closest(LI_URN_SEL));
  if (!urn) {
    for (const el of container.querySelectorAll(LI_URN_SEL)) {
      urn = linkedInUrnOf(el);
      if (urn) break;
    }
  }
  if (!urn) {
    for (const a of container.querySelectorAll('a[href*="/feed/update/"], a[href*="/posts/"]')) {
      urn = linkedInUrnFromHref(a.getAttribute('href'));
      if (urn) break;
    }
  }
  if (urn) {
    return { postKey: 'li:' + urn, postUrl: 'https://www.linkedin.com/feed/update/' + urn + '/' };
  }

  // Job cards
  let jobId = container.getAttribute('data-job-id') || '';
  if (!jobId) {
    const holder = container.querySelector('[data-job-id]');
    jobId = holder ? holder.getAttribute('data-job-id') : '';
  }
  if (!/^\d+$/.test(jobId)) {
    const jobLink = container.querySelector('a[href*="/jobs/view/"]');
    const m = jobLink ? /\/jobs\/view\/(\d+)/.exec(jobLink.getAttribute('href') || '') : null;
    jobId = m ? m[1] : '';
  }
  if (/^\d+$/.test(jobId)) {
    return { postKey: 'li:job:' + jobId, postUrl: 'https://www.linkedin.com/jobs/view/' + jobId + '/' };
  }
  return null;
}

/** The URN a LinkedIn post key was derived from (null for job / text-hash keys). */
function ownUrnOf(identity) {
  return identity && identity.postKey.startsWith('li:urn:') ? identity.postKey.slice(3) : null;
}

/**
 * Where an element sits inside a LinkedIn post: the post itself ('own'), the embedded
 * original of a reshare ('nested'), or comments / social counts ('excluded').
 */
function linkedInRegion(el, container, ownUrn) {
  let region = 'own';
  for (let node = el; node && node !== container; node = node.parentElement) {
    if (node.matches(LI_EXCLUDED_SEL)) return 'excluded';
    if (region === 'own') {
      if (node.matches(LI_NESTED_SEL)) {
        region = 'nested';
      } else {
        const urn = linkedInUrnOf(node);
        if (urn && urn !== ownUrn) region = 'nested';
      }
    }
  }
  return region;
}

/** First element in `region` matching the selector(s); an array is tried in priority order. */
function firstInRegion(container, selectors, ownUrn, region) {
  for (const selector of Array.isArray(selectors) ? selectors : [selectors]) {
    for (const el of container.querySelectorAll(selector)) {
      if (linkedInRegion(el, container, ownUrn) === region) return el;
    }
  }
  return null;
}

/** Actor profile / company page, without tracking params or the /posts/ listing suffix. */
function normalizeLinkedInAuthorUrl(href) {
  const url = toUrl(href);
  if (!url) return '';
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/(?:posts|recent-activity)(?:\/.*)?$/i, '/');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

/** Actor (author) of the post, or of the reshared original when region === 'nested'. */
function linkedInActor(container, ownUrn, region) {
  const nameEl = firstInRegion(container, LI_ACTOR_NAME_SELS, ownUrn, region);
  const linkEl = firstInRegion(container, LI_ACTOR_LINK_SELS, ownUrn, region);
  const bioEl = firstInRegion(container, LI_ACTOR_BIO_SEL, ownUrn, region);
  let name = nameEl ? readText(nameEl).split('\n')[0].trim() : '';
  if (!name && linkEl) name = readText(linkEl).split('\n')[0].trim();
  return {
    name,
    url: linkEl ? normalizeLinkedInAuthorUrl(linkEl.getAttribute('href')) : '',
    bio: bioEl ? readText(bioEl).replace(/\s+/g, ' ') : ''
  };
}

// --- Other platforms ---

function xIdentity(container) {
  const anchors = [];
  container.querySelectorAll('time').forEach(t => {
    const a = t.closest('a[href*="/status/"]');
    if (a && container.contains(a)) anchors.push(a);
  });
  container.querySelectorAll('a[href*="/status/"]').forEach(a => anchors.push(a));
  for (const a of anchors) {
    const url = toUrl(a.getAttribute('href'));
    if (!url || !/(^|\.)(x|twitter)\.com$/i.test(url.hostname)) continue;
    const m = /^\/([A-Za-z0-9_]{1,30})\/status\/(\d+)/.exec(url.pathname);
    if (m) return { postKey: 'x:' + m[2], postUrl: 'https://x.com/' + m[1] + '/status/' + m[2] };
  }
  return null;
}

function youTubeIdentity(container) {
  const isComment = container.tagName === 'YTD-COMMENT-THREAD-RENDERER';
  for (const a of container.querySelectorAll('a[href*="watch?v="], a[href*="/shorts/"]')) {
    const url = toUrl(a.getAttribute('href'));
    if (!url) continue;
    const v = url.searchParams.get('v');
    if (isComment) {
      const lc = url.searchParams.get('lc');
      if (v && lc) return { postKey: 'yt:c:' + lc, postUrl: 'https://www.youtube.com/watch?v=' + encodeURIComponent(v) + '&lc=' + encodeURIComponent(lc) };
      continue;
    }
    if (v && /^[\w-]{1,64}$/.test(v)) {
      return { postKey: 'yt:' + v, postUrl: 'https://www.youtube.com/watch?v=' + v };
    }
    const short = /^\/shorts\/([\w-]{1,64})/.exec(url.pathname);
    if (short) return { postKey: 'yt:' + short[1], postUrl: 'https://www.youtube.com/shorts/' + short[1] };
  }
  return null;
}

function hackerNewsIdentity(container) {
  const row = container.matches('tr.athing') ? container : container.closest('tr.athing');
  const id = row ? row.getAttribute('id') : '';
  return id && /^\d+$/.test(id)
    ? { postKey: 'hn:' + id, postUrl: 'https://news.ycombinator.com/item?id=' + id }
    : null;
}

const FB_ID_RES = [
  /\/posts\/(?:[^/?#]+\/)?(pfbid\w+|\d+)/,
  /\/videos\/(?:[^/?#]+\/)?(\d+)/,
  /\/reel\/(\d+)/,
  /\/permalink\/(\d+)/,
  /[?&]story_fbid=(pfbid\w+|\d+)/,
  /[?&]fbid=(\d+)/,
  /\/watch\/?\?(?:.*&)?v=(\d+)/
];
const FB_KEEP_PARAMS = ['story_fbid', 'id', 'fbid', 'v'];

function facebookIdentity(container) {
  for (const a of container.querySelectorAll('a[href]')) {
    const url = toUrl(a.getAttribute('href'));
    if (!url || !isSameSite(url.hostname)) continue;
    const pathAndQuery = url.pathname + url.search;
    for (const re of FB_ID_RES) {
      const m = re.exec(pathAndQuery);
      if (!m) continue;
      const clean = new URL(url.origin + url.pathname);
      FB_KEEP_PARAMS.forEach(p => { if (url.searchParams.has(p)) clean.searchParams.set(p, url.searchParams.get(p)); });
      return { postKey: 'fb:' + m[1], postUrl: clean.href };
    }
  }
  return null;
}

const GITHUB_RESERVED = new Set([
  'about', 'collections', 'dashboard', 'enterprise', 'explore', 'features', 'login', 'marketplace',
  'new', 'notifications', 'orgs', 'organizations', 'pricing', 'pulls', 'issues', 'search',
  'settings', 'signup', 'sponsors', 'topics', 'trending', 'codespaces', 'site', 'security'
]);

function gitHubIdentity(container) {
  let repo = null;
  for (const a of container.querySelectorAll('a[href]')) {
    const url = toUrl(a.getAttribute('href'));
    if (!url || !isSameSite(url.hostname)) continue;
    const m = /^\/([\w.-]+)\/([\w.-]+)(\/(?:issues|pull|discussions)\/\d+)?\/?$/.exec(url.pathname);
    if (!m || GITHUB_RESERVED.has(m[1].toLowerCase())) continue;
    const path = '/' + m[1] + '/' + m[2] + (m[3] || '');
    if (m[3]) return { postKey: 'gh:' + path.toLowerCase(), postUrl: 'https://github.com' + path };
    if (!repo) repo = path;
  }
  return repo ? { postKey: 'gh:' + repo.toLowerCase(), postUrl: 'https://github.com' + repo } : null;
}

function instagramIdentity(container) {
  for (const a of container.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')) {
    const url = toUrl(a.getAttribute('href'));
    const m = url ? /\/(p|reel)\/([\w-]+)/.exec(url.pathname) : null;
    if (m) return { postKey: 'ig:' + m[2], postUrl: 'https://www.instagram.com/' + m[1] + '/' + m[2] + '/' };
  }
  return null;
}

function mediumIdentity(container) {
  for (const a of container.querySelectorAll('a[href]')) {
    const url = toUrl(a.getAttribute('href'));
    const m = url ? /-([0-9a-f]{10,12})\/?$/.exec(url.pathname) : null;
    if (m) return { postKey: 'md:' + m[1], postUrl: url.origin + url.pathname };
  }
  return null;
}

/** Identity from platform markup (URN, status id, video id…), or null. */
function derivePlatformIdentity(container) {
  if (!container || !container.querySelectorAll) return null;
  switch (PLATFORM) {
    case 'linkedin': return linkedInIdentity(container);
    case 'x': return xIdentity(container);
    case 'youtube': return youTubeIdentity(container);
    case 'hn': return hackerNewsIdentity(container);
    case 'facebook': return facebookIdentity(container);
    case 'github': return gitHubIdentity(container);
    case 'instagram': return instagramIdentity(container);
    case 'medium': return mediumIdentity(container);
    default: return null;
  }
}

/** Text-hash identity; the URL only ever comes from a link inside the post. */
function genericIdentity(container, text) {
  const basis = normalizeForKey(text != null ? text : (container.textContent || ''));
  const key = (hashString(basis) >>> 0).toString(36) + (fnv1a(basis) >>> 0).toString(36);
  return { postKey: 't:' + key, postUrl: findNearestLink(container) };
}

/**
 * Stable identity of a post: postKey dedupes re-renders and "…more" updates in the
 * background; postUrl is the post's canonical permalink ('' when it has none).
 *
 * @param {Element} container
 * @param {string} [text] extracted text (generic keys hash its first 400 normalized chars)
 * @returns {{ postKey: string, postUrl: string }}
 */
function derivePostIdentity(container, text) {
  return derivePlatformIdentity(container) || genericIdentity(container, text);
}

// ════════════════════════════════════════════════════════════════════════
// §5  IPC DISPATCH
// ════════════════════════════════════════════════════════════════════════

function extensionContextAlive() {
  try {
    return typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);
  } catch {
    return false;
  }
}

function onSendError(err) {
  const message = err && err.message ? err.message : String(err || '');
  if (message.includes('Extension context invalidated')) teardown();
  return undefined;
}

/**
 * chrome.runtime.sendMessage that never throws or rejects (resolves undefined on failure).
 * @param {object} message
 * @returns {Promise<any>}
 */
function sendToBackground(message) {
  try {
    const result = chrome.runtime.sendMessage(message);
    if (result && typeof result.then === 'function') return result.catch(onSendError);
    return Promise.resolve(undefined);
  } catch (err) {
    onSendError(err);
    return Promise.resolve(undefined);
  }
}

/**
 * Send extracted text to the background service worker (TEXT_EXTRACTED, lib/messages.js).
 *
 * @param {string} sanitizedText
 * @param {{ postKey: string, postUrl: string }} identity
 * @param {{ authorName?: string, authorUrl?: string }} meta
 * @param {boolean} isAd – whether this card was flagged as sponsored/promoted
 * @param {boolean} isUpdate – the post was sent before and its text grew ("…more" expanded)
 */
function dispatch(sanitizedText, identity, meta, isAd, isUpdate) {
  if (!isActive()) return;
  const postKey = identity.postKey;
  sendToBackground({
    type: MSG.TEXT_EXTRACTED,
    payload: {
      text: sanitizedText,
      postKey,
      postUrl: identity.postUrl || '',
      sourceUrl: identity.postUrl || '',
      pageUrl: window.location.href,
      sourcePlatform: SOURCE_PLATFORM,
      authorName: meta.authorName || '',
      authorUrl: meta.authorUrl || '',
      isAd: !!isAd,
      isUpdate: !!isUpdate,
      timestamp: Date.now()
    }
  }).then(reply => {
    if (reply && reply.status === 'ignored') {
      annotate(postKey, { status: 'ignored', reason: typeof reply.reason === 'string' ? reply.reason : '', tag: '', pMatch: null });
    }
  });
}

/**
 * Marks an element as the post `identity.postKey` and dispatches its text unless the same
 * key was already sent with (nearly) the same text, e.g. a post the platform re-rendered.
 */
function emitPost(el, text, identity, meta, isAd) {
  el.setAttribute(PROCESSED_ATTR, 'true');
  el.setAttribute(KEY_ATTR, identity.postKey);

  const previousLength = sentLengths.get(identity.postKey);
  if (previousLength !== undefined && text.length <= previousLength + EXPANSION_MIN_GROWTH) {
    const known = decisions.get(identity.postKey);
    if (known) applyAnnotation(el, known);
    return;
  }
  rememberSent(identity.postKey, text.length);
  dispatch(sanitize(text), identity, meta, isAd, previousLength !== undefined);
}

// ════════════════════════════════════════════════════════════════════════
// §6  BOUNDARY DETECTION & TEXT EXTRACTION ENGINE
// ════════════════════════════════════════════════════════════════════════

function findCustomCardBoundary(element) {
  if (!element || element === document.body) return null;

  // Walk up from the mutated element to find the closest candidate container
  let current = element;
  while (current && current !== document.body) {
    const tag = current.tagName;
    if (tag === 'DIV' || tag === 'ARTICLE' || tag === 'SECTION' || tag === 'LI') {
      if (isValidCustomCard(current)) {
        return current;
      }
    }
    current = current.parentElement;
  }
  return null;
}

function isValidCustomCard(el) {
  if (el.tagName === 'BODY' || el.tagName === 'HTML' || el.tagName === 'HEADER' || el.tagName === 'FOOTER' || el.tagName === 'NAV') {
    return false;
  }

  const links = Array.from(el.querySelectorAll('a[href]'));
  const titleLink = links.find(a => {
    const href = a.getAttribute('href') || '';
    if (href.startsWith('#') || href.startsWith('javascript:') || href === '/' || href.includes('search') || href.includes('tag')) {
      return false;
    }
    const text = a.innerText.trim();
    return text.length >= 20 && text.length <= 180;
  });

  if (!titleLink) return false;

  try {
    const clone = el.cloneNode(true);
    const cloneLinks = Array.from(clone.querySelectorAll('a[href]'));
    cloneLinks.forEach(a => a.remove());
    clone.querySelectorAll('button, form, script, style, time, .meta, .comments').forEach(n => n.remove());

    const descText = clone.innerText.trim().replace(/\s+/g, ' ');
    return descText.length >= 15 && descText.length <= 600;
  } catch {
    return false;
  }
}

function isPlatformBoundary(el) {
  return !!PLATFORM_BOUNDARY_SEL && el.matches(PLATFORM_BOUNDARY_SEL);
}

/** Climbs to the outermost element matching `selector` (the post that holds a reshare/quote). */
function promoteToOutermost(el, selector) {
  let current = el;
  for (;;) {
    const parent = current.parentElement && current.parentElement.closest(selector);
    if (!parent || parent === document.body || parent === document.documentElement) return current;
    current = parent;
  }
}

/** Nearest platform post around `element`, promoted to the enclosing post when nested. */
function findPlatformBoundary(element) {
  if (!PLATFORM_BOUNDARY_SEL) return null;
  const nearest = element.closest(PLATFORM_BOUNDARY_SEL);
  if (!nearest || nearest === document.body || nearest === document.documentElement) return null;
  platformMarkupSeen = true;
  return promoteToOutermost(nearest, PLATFORM_BOUNDARY_SEL);
}

/**
 * Probes the document for platform-specific post markup (once per scan batch, not per
 * mutated node). Once seen, generic selectors stay off on this page.
 */
function refreshPlatformMarkup() {
  if (!platformMarkupSeen && PLATFORM_BOUNDARY_SEL) {
    platformMarkupSeen = !!document.querySelector(PLATFORM_BOUNDARY_SEL);
  }
}

function hasPlatformMarkup() {
  return platformMarkupSeen;
}

/** Generic boundaries directly below `el` (not nested in another generic boundary). */
function topLevelGenericChildren(el) {
  return Array.from(el.querySelectorAll(GENERIC_BOUNDARY_SEL))
    .filter(c => c.parentElement && c.parentElement.closest(GENERIC_BOUNDARY_SEL) === el);
}

function visibleLength(el) {
  return (el.textContent || '').replace(/\s+/g, '').length;
}

/**
 * A generic boundary that is really a list of posts: it holds 2+ repeated boundaries
 * (several articles, or same-class cards) and little text of its own. A post-container
 * around post-header + post-body is not a list; neither is an article followed by its
 * comment articles (the article has text of its own).
 */
function isListLike(el, cache) {
  if (cache && cache.has(el)) return cache.get(el);
  let result = false;
  const children = topLevelGenericChildren(el);
  if (children.length >= 2) {
    const signatures = new Map();
    let strong = 0;
    for (const c of children) {
      if (c.matches(GENERIC_STRONG_SEL)) strong++;
      const signature = c.tagName + '.' + (typeof c.className === 'string' ? c.className.trim() : '');
      signatures.set(signature, (signatures.get(signature) || 0) + 1);
    }
    const repeated = strong >= 2 || Math.max(...signatures.values()) >= 2;
    if (repeated) {
      const total = visibleLength(el);
      const inChildren = children.reduce((sum, c) => sum + visibleLength(c), 0);
      result = total - inChildren < Math.max(200, total * 0.2);
    }
  }
  if (cache) cache.set(el, result);
  return result;
}

/** Nearest generic boundary, promoted through enclosing boundaries that are not lists. */
function findGenericBoundary(element, cache) {
  const nearest = element.closest(GENERIC_BOUNDARY_SEL);
  if (!nearest || nearest === document.body || nearest === document.documentElement) return null;
  if (isListLike(nearest, cache)) return null;
  let current = nearest;
  for (;;) {
    const parent = current.parentElement && current.parentElement.closest(GENERIC_BOUNDARY_SEL);
    if (!parent || parent === document.body || parent === document.documentElement || isListLike(parent, cache)) {
      return current;
    }
    current = parent;
  }
}

/** Class-name and custom-card heuristics for sites without known markup. */
function findHeuristicBoundary(element) {
  let current = element;
  while (current && current !== document.body) {
    const classes = current.className || '';
    if (typeof classes === 'string' && /\b(post|tweet|article|card|feed-item|story)\b/i.test(classes)) {
      // Exclude layouts, list containers, and wrapping frameworks
      if (!/(container|list|grid|deck|wrapper|feed|group|scroller|tray|stream|holder|body|page|app|main)/i.test(classes)) {
        return current;
      }
    }
    current = current.parentElement;
  }
  return findCustomCardBoundary(element);
}

/**
 * Identifies the post container around an element: the NEAREST matching ancestor
 * (element.closest over the joined selectors, not "first selector in priority order"),
 * promoted to the enclosing post when that match is nested inside one. Platform
 * selectors win on known platforms; once a page has shown platform markup, generic
 * selectors (article, [class*="post-"]) are not used there at all.
 */
function findBoundaryContainer(element, cache) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) return null;
  if (element === document.body || element === document.documentElement) return null;

  const platform = findPlatformBoundary(element);
  if (platform) return platform;
  if (hasPlatformMarkup()) return null;

  const generic = findGenericBoundary(element, cache);
  if (generic) return generic;

  return IS_PREDEFINED ? null : findHeuristicBoundary(element);
}

/** Outermost post boundaries in a subtree (each post once). */
function collectBoundaries(root) {
  const found = [];
  const seen = new Set();
  const add = (el) => {
    if (el && !seen.has(el)) {
      seen.add(el);
      found.push(el);
    }
  };
  const cache = new Map();

  // Root inside (or itself) a post: everything below belongs to that post.
  add(findBoundaryContainer(root, cache));
  if (found.length > 0 || !root.querySelectorAll) return found;

  if (PLATFORM_BOUNDARY_SEL) {
    root.querySelectorAll(PLATFORM_BOUNDARY_SEL).forEach(m => add(promoteToOutermost(m, PLATFORM_BOUNDARY_SEL)));
    if (found.length > 0) {
      platformMarkupSeen = true;
      return found;
    }
    if (hasPlatformMarkup()) return found;
  }

  root.querySelectorAll(GENERIC_BOUNDARY_SEL).forEach(m => add(findGenericBoundary(m, cache)));
  return found;
}

/**
 * LinkedIn post text: the post's own commentary plus, for a reshare, the embedded
 * original — never comments, never another post. Returns '' when the container has
 * no LinkedIn update markup (the generic extraction then applies).
 */
function extractLinkedInPostText(container, ownUrn) {
  const card = linkedInCardOf(container);
  if (card) return extractLinkedInCardText(card);

  const ownTextEl = firstInRegion(container, LI_TEXT_SEL, ownUrn, 'own');
  const nestedTextEl = firstInRegion(container, LI_TEXT_SEL, ownUrn, 'nested');
  let body = ownTextEl ? stripMoreMarkers(readText(ownTextEl, true)) : '';
  const reshared = nestedTextEl ? stripMoreMarkers(readText(nestedTextEl, true)) : '';

  if (!body && !reshared) {
    const attachment = firstInRegion(container, LI_ATTACHMENT_SEL, ownUrn, 'own');
    body = attachment ? readText(attachment) : '';
  }
  if (!body && !reshared) {
    return ownUrn ? linkedInFallbackText(container) : '';
  }

  const parts = [];
  const actor = linkedInActor(container, ownUrn, 'own');
  if (actor.name) parts.push(actor.bio ? `Post by: ${actor.name} (${actor.bio})` : `Post by: ${actor.name}`);
  if (body) parts.push(body);
  if (reshared) {
    const original = linkedInActor(container, ownUrn, 'nested');
    parts.push((original.name ? `Reshared from ${original.name}:` : 'Reshared post:') + '\n' + reshared);
  }
  return parts.join('\n\n');
}

/** Last resort for a LinkedIn update without known text markup: its text minus chrome. */
function linkedInFallbackText(container) {
  try {
    const clone = container.cloneNode(true);
    clone.querySelectorAll(
      LI_EXCLUDED_SEL + ', .update-components-actor, .update-components-header, button, [role="button"], ' +
      '[' + BADGE_ATTR + '], script, style, svg'
    ).forEach(n => n.remove());
    clone.querySelectorAll('.visually-hidden').forEach(n => n.remove());
    return cleanWhitespace(clone.textContent || '');
  } catch {
    return '';
  }
}

/**
 * Clones a container, strips noisy UI elements, and retrieves text.
 */
function extractTextFromContainer(container, identity) {
  if (!container) return '';

  const tagName = container.tagName.toLowerCase();

  // Custom site card text extraction
  if (!IS_PREDEFINED) {
    const links = Array.from(container.querySelectorAll('a[href]'));
    const titleLink = links.find(a => {
      const href = a.getAttribute('href') || '';
      if (href.startsWith('#') || href.startsWith('javascript:') || href === '/' || href.includes('search') || href.includes('tag')) {
        return false;
      }
      const text = a.innerText.trim();
      return text.length >= 20 && text.length <= 180;
    });

    const titleText = titleLink ? titleLink.innerText.trim() : '';

    let descText = '';
    try {
      const clone = container.cloneNode(true);
      clone.querySelectorAll('a[href]').forEach(a => a.remove());
      clone.querySelectorAll('button, form, script, style, time, .meta, .comments, [' + BADGE_ATTR + ']').forEach(n => n.remove());
      descText = clone.innerText.trim().replace(/\s+/g, ' ');
    } catch {
      // fallback
    }

    if (titleText && descText && descText.length >= 15) {
      return `${titleText}\n\n${descText}`;
    }
  }

  const isInstagram = PLATFORM === 'instagram' && tagName === 'article';

  if (isInstagram) {
    // 1. Try to find the username link to identify the author
    const profileLinks = Array.from(container.querySelectorAll('a[href]'));
    const profileLink = profileLinks.find(a => {
      const href = a.getAttribute('href');
      return /^\/[a-zA-Z0-9_\.]+\/?$/.test(href) && href !== '/explore/' && href !== '/reels/' && href !== '/direct/';
    });
    const username = profileLink ? profileLink.innerText.trim() : '';

    if (username) {
      // 2. Search for the element that contains the username link followed by the caption
      const candidateElements = Array.from(container.querySelectorAll('span, div, h1, h2, h3'));
      const captionEl = candidateElements.find(el => {
        if (el.children.length > 15) return false;

        // Exclude header elements to avoid matching username + suggested/follow badges in the header
        if (el.closest('header') || el.closest('[class*="header"]') || el.closest('[class*="head"]')) {
          return false;
        }

        const firstLink = el.querySelector('a[href]');
        if (firstLink) {
          const href = firstLink.getAttribute('href');
          if (/^\/[a-zA-Z0-9_\.]+\/?$/.test(href) && href !== '/explore/' && href !== '/reels/') {
            const text = el.innerText.trim();
            return text.startsWith(username) && text.length > username.length + 4;
          }
        }
        return false;
      });

      if (captionEl) {
        const fullText = captionEl.innerText.trim();
        if (fullText.startsWith(username)) {
          return fullText.slice(username.length).trim();
        }
        return fullText;
      }
    }

    // 3. Fallback: Clean cloned node from Follow and Suggested noise
    try {
      const clone = container.cloneNode(true);

      const noiseSelectors = [
        'header',
        'button',
        'span[role="button"]',
        'ul',
        'a[href*="/liked_by/"]',
        'a[href*="/likers/"]',
        '[' + BADGE_ATTR + ']'
      ];
      noiseSelectors.forEach(sel => {
        clone.querySelectorAll(sel).forEach(el => el.remove());
      });

      const allElements = Array.from(clone.querySelectorAll('*'));
      allElements.forEach(el => {
        const txt = (el.textContent || '').trim();
        if (txt.includes('Suggested for you') || txt === 'Follow' || /^\d+ likes?$/i.test(txt)) {
          el.remove();
        }
      });

      const defaultNoise = Array.from(NOISE_TAGS).join(',').toLowerCase();
      clone.querySelectorAll(defaultNoise).forEach(n => n.remove());

      return (clone.innerText || clone.textContent || '').trim().replace(/\s+/g, ' ');
    } catch {
      return (container.innerText || '').trim().replace(/\s+/g, ' ');
    }
  }

  // Medium and Hacker News: the author travels as authorName (extractAuthor), never inside the
  // text, so a cloud provider only sees it when the user allowed sending authors.
  if (isMediumPage() && (tagName === 'article' || container.classList.contains('postArticle'))) {
    const titleEl = container.querySelector('h2, h3, [data-testid="post-title"]');
    const title = titleEl ? titleEl.innerText.trim() : (container.getAttribute('aria-label') || '');

    let subtitle = '';
    if (titleEl) {
      const nextPara = titleEl.closest('a')?.nextElementSibling || titleEl.nextElementSibling;
      if (nextPara && (nextPara.tagName === 'P' || nextPara.tagName === 'H3' || nextPara.tagName === 'DIV')) {
        subtitle = nextPara.innerText.trim();
      }
    }

    if (title) {
      return `${title}\n${subtitle}`.trim().replace(/\s+/g, ' ');
    }
  }

  // Hacker News custom text extraction
  if (PLATFORM === 'hn') {
    const titleEl = container.querySelector('.titleline');
    if (titleEl) {
      return titleEl.innerText.trim();
    }
  }

  // GitHub custom text extraction
  if (PLATFORM === 'github') {
    if (tagName === 'article') {
      const repoLink = container.querySelector('h1 a, h2 a, h3 a, a[data-hydro-click*="explore"]');
      const descEl = container.querySelector('p');
      const descText = descEl ? descEl.innerText.trim() : '';
      const repoName = repoLink ? repoLink.innerText.trim() : '';
      if (repoName) {
        return descText ? `${repoName}\n\n${descText}` : repoName;
      }
    }
  }

  // LinkedIn: own commentary (+ reshared original), never comments or neighbouring posts
  if (PLATFORM === 'linkedin') {
    const linkedInText = extractLinkedInText(container, ownUrnOf(identity));
    if (linkedInText) return linkedInText;
  }

  // Twitter/X custom text extraction
  if (PLATFORM === 'x') {
    const userEl = container.querySelector('[data-testid="User-Name"]');
    const textEl = container.querySelector('[data-testid="tweetText"]');

    if (textEl) {
      const tweetText = readText(textEl, true);
      let authorLine = '';
      if (userEl) {
        const fullUser = readText(userEl).replace(/\s+/g, ' ');
        const parts = fullUser.split('·');
        authorLine = parts[0].trim();
      }

      if (tweetText) {
        return authorLine ? `Tweet by: ${authorLine}\n\n${tweetText}` : tweetText;
      }
    }
  }

  // Facebook custom text extraction
  if (PLATFORM === 'facebook') {
    const isReel = (container.getAttribute('data-pagelet') || '').includes('ReelsConsumerVideoSheet') ||
                   (container.getAttribute('data-pagelet') || '').includes('ReelsUnit') ||
                   (container.getAttribute('data-pagelet') || '').includes('Reel_');
    if (isReel) {
      const authorEl = container.querySelector('h2 a[role="link"], h3 a[role="link"], h4 a[role="link"], strong a[role="link"], a[role="link"] strong, span > a[role="link"]');
      const spans = Array.from(container.querySelectorAll('span[dir="auto"], div[dir="auto"]'));
      let caption = '';
      const author = authorEl ? authorEl.innerText.trim() : 'Facebook Reel';

      for (const span of spans) {
        const text = span.innerText.trim();
        if (text && text !== author && text.length > caption.length && !text.includes('Follow') && !text.includes('Like') && !text.includes('Comment') && !text.includes('Share')) {
          caption = text;
        }
      }

      if (caption) {
        return `${caption}\n\nAuthor: ${author}`;
      }
    } else {
      const authorEl = container.querySelector('h2 strong, h3 strong, h4 strong, span strong, a strong, h2 a[role="link"], h3 a[role="link"], h4 a[role="link"]');
      const author = authorEl ? authorEl.innerText.trim() : '';

      const bodyElements = Array.from(container.querySelectorAll('div[dir="auto"], span[dir="auto"], p'));
      let bodyText = '';
      for (const el of bodyElements) {
        if (el.closest('h2') || el.closest('h3') || el.closest('h4') || el.closest('[role="button"]') || el.closest('a')) {
          continue;
        }
        const text = el.innerText.trim();
        if (text && text.length > bodyText.length && !text.includes('Follow') && !text.includes('Like') && !text.includes('Comment') && !text.includes('Share')) {
          bodyText = text;
        }
      }

      if (author && bodyText && bodyText.length > 10) {
        return `Post by: ${author}\n\n${bodyText}`;
      }
    }
  }

  // YouTube site-specific custom text extraction
  const isYouTubeVideo = tagName.startsWith('ytd-') && tagName.includes('video-renderer') || tagName === 'ytd-rich-item-renderer' || tagName === 'ytd-reel-video-renderer';

  if (isYouTubeVideo) {
    let titleEl = container.querySelector('#video-title, #video-title-link, #title, yt-formatted-string.title, .title, .ytd-reel-player-header-renderer');
    if (titleEl) {
      const text = titleEl.innerText.trim();
      if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(text)) {
        titleEl = null;
      }
    }
    if (!titleEl) {
      const watchLinks = Array.from(container.querySelectorAll('a[href*="watch?v="]'));
      titleEl = watchLinks.find(a => {
        const text = a.innerText.trim();
        if (text.length === 0) return false;

        // Exclude thumbnail links
        const id = a.getAttribute('id') || '';
        const cls = a.getAttribute('class') || '';
        if (id.includes('thumbnail') || cls.includes('thumbnail')) return false;
        if (a.querySelector('img, ytd-thumbnail, yt-img-shadow')) return false;

        // Exclude duration badges (e.g. "10:23", "1:28:45")
        if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(text)) return false;

        return true;
      });
    }

    let channelEl = container.querySelector('ytd-channel-name, #channel-name, #byline-container, .channel-name, #channel-name-container');
    if (!channelEl) {
      const channelLinks = Array.from(container.querySelectorAll('a[href*="/@"], a[href*="/user/"], a[href*="/channel/"]'));
      channelEl = channelLinks.find(a => a.innerText.trim().length > 0);
    }

    const metaEl = container.querySelector('#metadata-line, ytd-video-meta-block, .metadata-line, #metadata');

    if (titleEl) {
      const title = titleEl.innerText.trim();
      const channel = channelEl ? channelEl.innerText.trim() : '';
      const meta = metaEl ? metaEl.innerText.trim().replace(/\s+/g, ' ').replace(/\n/g, ' • ') : '';

      if (title.length > 0) {
        let result = title;
        if (channel) result += `\nChannel: ${channel}`;
        if (meta) result += `\nInfo: ${meta}`;
        return result;
      }
    }
  }

  if (tagName === 'ytd-comment-thread-renderer') {
    const authorEl = container.querySelector('#author-text');
    const textEl = container.querySelector('#content-text');
    if (textEl) {
      const text = textEl.innerText.trim();
      const author = authorEl ? authorEl.innerText.trim() : '';
      return `Comment by ${author}:\n${text}`;
    }
  }

  // Fallback to default generic extraction
  try {
    const clone = container.cloneNode(true);
    const noiseSelector = Array.from(NOISE_TAGS).join(',').toLowerCase() + ', [' + BADGE_ATTR + ']';
    const noise = clone.querySelectorAll(noiseSelector);
    noise.forEach(n => n.remove());
    return (clone.innerText || clone.textContent || '').trim().replace(/\s+/g, ' ');
  } catch {
    return (container.innerText || '').trim().replace(/\s+/g, ' ');
  }
}

/**
 * True when one of the first `limit` elements matching `selector` has exactly a label's
 * text (e.g. "Promoted", "Promoted by Acme", "Sponsored"). Uses textContent on a bounded
 * set of elements instead of innerText on every descendant.
 */
function hasExactLabel(container, labels, selector, limit, excludeSel) {
  const els = container.querySelectorAll(selector);
  const n = Math.min(els.length, limit);
  for (let i = 0; i < n; i++) {
    const el = els[i];
    if (el.childElementCount > 2) continue;
    const text = (el.textContent || '').trim().toLowerCase();
    if (!text || text.length > 40) continue;
    if (excludeSel && el.closest(excludeSel)) continue;
    for (const label of labels) {
      if (text === label || text.startsWith(label + ' by ') || text.startsWith(label + ' ·')) return true;
    }
  }
  return false;
}

/**
 * Scans a boundary container for sponsored or promoted visual elements.
 */
function detectAd(container) {
  try {
    // X marks ads with a lone "Ad" label in the tweet header
    if (PLATFORM === 'x' && hasExactLabel(container, ['ad'], 'span', 80, '[data-testid="tweetText"]')) {
      return true;
    }

    // LinkedIn "Promoted", Facebook "Sponsored", generic labels
    const text = (container.textContent || '').toLowerCase();
    if (text.includes('sponsored') || text.includes('promoted') || text.includes('advertisement')) {
      if (hasExactLabel(container, ['sponsored', 'promoted', 'advertisement'], 'span, a, div, p, small, strong, b', 400)) {
        return true;
      }
      if (container.querySelector('[class*="sponsored"], [class*="promoted"]')) return true;
    }

    // Class check
    const classes = typeof container.className === 'string' ? container.className.toLowerCase() : '';
    return classes.includes('ad-container') || classes.includes('sponsored-post') || classes.includes('promoted-tweet');
  } catch {
    return false;
  }
}

/**
 * Author of a post. The author URL is the actor's profile / company / channel link and is
 * never used as the post URL.
 */
function extractAuthor(container, identity) {
  let authorUrl = '';
  let authorName = '';

  if (PLATFORM === 'linkedin') {
    const card = linkedInCardOf(container);
    if (card) {
      const author = linkedInCardAuthor(card);
      return { authorName: author.name, authorUrl: author.url };
    }
    const actor = linkedInActor(container, ownUrnOf(identity), 'own');
    return { authorName: actor.name, authorUrl: actor.url };
  }

  if (PLATFORM === 'x') {
    const userEl = container.querySelector('[data-testid="User-Name"]');
    if (userEl) {
      const authorLink = userEl.querySelector('a[href]');
      if (authorLink) {
        authorUrl = authorLink.getAttribute('href');
        authorName = readText(userEl).split('\n')[0].trim();
      }
    }
  } else if (PLATFORM === 'youtube') {
    const nameLink = container.querySelector('ytd-channel-name a, #channel-name a, a#author-text');
    if (nameLink && nameLink.textContent.trim()) {
      authorName = nameLink.textContent.trim();
      authorUrl = nameLink.getAttribute('href');
    } else {
      const channelLinks = Array.from(container.querySelectorAll('a[href*="/@"], a[href*="/user/"], a[href*="/channel/"]'));
      const textual = channelLinks.find(a => a.textContent.trim() && !a.querySelector('img, yt-img-shadow'));
      if (textual) {
        authorName = textual.textContent.trim();
        authorUrl = textual.getAttribute('href');
      } else if (channelLinks.length > 0) {
        authorUrl = channelLinks[0].getAttribute('href');
      }
    }
  } else if (PLATFORM === 'facebook') {
    const authorEl = container.querySelector('h2 strong, h3 strong, h4 strong, span strong, a strong, h2 a[role="link"], h3 a[role="link"], h4 a[role="link"]');
    if (authorEl) {
      authorName = authorEl.innerText.trim();
      const a = authorEl.closest('a');
      if (a && a.hasAttribute('href')) authorUrl = a.getAttribute('href');
    }
  } else if (PLATFORM === 'github') {
    const repoLink = Array.from(container.querySelectorAll('a[href]')).find(a => {
      const url = toUrl(a.getAttribute('href'));
      if (!url || !isSameSite(url.hostname)) return false;
      return url.pathname.split('/').filter(Boolean).length === 2;
    });
    if (repoLink) {
      const parts = repoLink.innerText.trim().split('/');
      if (parts.length > 0 && parts[0].trim()) {
        authorName = parts[0].trim();
        authorUrl = '/' + authorName;
      }
    }
  } else if (PLATFORM === 'hn') {
    const nextRow = container.nextElementSibling;
    const actorLink = nextRow ? nextRow.querySelector('a.hnuser') : null;
    if (actorLink) {
      authorUrl = actorLink.getAttribute('href');
      authorName = actorLink.innerText.trim();
    }
  } else if (isMediumPage()) {
    const authorEl = Array.from(container.querySelectorAll('a[href*="/@"]')).find(a => a.innerText.trim().length > 0);
    if (authorEl) {
      authorName = authorEl.innerText.trim();
      authorUrl = authorEl.getAttribute('href');
    }
  }

  return { authorName, authorUrl: toAbsolute(authorUrl) };
}

/** medium.com, or a publication on its own domain served by Medium. */
function isMediumPage() {
  return PLATFORM === 'medium' ||
    !!document.querySelector('meta[property="al:ios:app_name"][content="Medium"]') ||
    !!document.querySelector('link[title="Medium"]');
}

/**
 * Extracts structured text and author metadata from a post container.
 */
function extractContentInfo(container, identity) {
  const text = stripMoreMarkers(extractTextFromContainer(container, identity));
  return { text, ...extractAuthor(container, identity) };
}

/** Applies the length rules; oversize text is trimmed for identified posts, dropped otherwise. */
function fitText(text, hasPlatformIdentity) {
  if (text.length <= MAX_TEXT_LEN) return text;
  // An unidentified block this long is usually several posts glued together.
  return hasPlatformIdentity ? truncateText(text, MAX_TEXT_LEN) : '';
}

/**
 * Evaluates a boundary container.
 */
function processBoundaryContainer(el) {
  if (!el || !el.isConnected || el.hasAttribute(PROCESSED_ATTR)) return;

  // Inside a post we already sent: that post owns this element.
  const enclosing = el.parentElement && el.parentElement.closest('[' + KEY_ATTR + ']');
  if (enclosing) {
    scheduleRecheck(enclosing);
    return;
  }
  // A generic wrapper around posts we already sent is a list, not a post.
  if (!isPlatformBoundary(el) && el.querySelector('[' + KEY_ATTR + ']')) return;

  const platformIdentity = derivePlatformIdentity(el);
  const info = extractContentInfo(el, platformIdentity);
  const minLen = IS_PREDEFINED ? 20 : MIN_TEXT_LEN;
  if (info.text.length < minLen) return; // not marked: the post may still be rendering

  const text = fitText(info.text, !!platformIdentity);
  if (!text) return;

  const identity = platformIdentity || genericIdentity(el, text);
  emitPost(el, text, identity, info, detectAd(el));
}

/**
 * Fallback parser for generic elements when no boundaries are detected.
 */
function readBlockText(el) {
  return stripMoreMarkers(el.innerText ? el.innerText.trim() : '');
}

function processGenericContent(el) {
  if (el.nodeType !== Node.ELEMENT_NODE) return;
  if (!CONTENT_TAGS.has(el.tagName)) return;
  if (isNoiseOrProcessed(el)) return;
  if (el.querySelector('[' + KEY_ATTR + ']')) return; // wraps blocks we already sent

  const raw = el.innerText ? el.innerText.trim() : '';
  if (raw.length < MIN_TEXT_LEN || raw.length > MAX_TEXT_LEN) return;

  const htmlLen = el.innerHTML.length;
  if (htmlLen === 0 || raw.length / htmlLen <= MIN_TEXT_RATIO) return;

  const text = readBlockText(el);
  blockElements.add(el);
  emitPost(el, text, genericIdentity(el, text), { authorName: '', authorUrl: '' }, detectAd(el));
}

/**
 * Scans a subtree for boundary containers, falling back to density blocks.
 */
function scanSubtree(root) {
  if (!root || root.nodeType !== Node.ELEMENT_NODE || !root.isConnected || !isActive()) return;
  if (root === document.body) refreshPlatformMarkup();

  const boundaryElements = collectBoundaries(root);

  if (boundaryElements.length === 0) {
    // Density fallback only on unknown sites: on social platforms it picks up chat
    // bubbles, notifications and sidebars instead of posts.
    if (IS_PREDEFINED) return;
    const selector = Array.from(CONTENT_TAGS).join(',').toLowerCase();
    const candidates = root.querySelectorAll ? root.querySelectorAll(selector) : [];
    for (let i = 0; i < candidates.length; i++) {
      processGenericContent(candidates[i]);
    }
  } else {
    // Process identified posts/articles
    boundaryElements.forEach(el => processBoundaryContainer(el));
  }
}

// ════════════════════════════════════════════════════════════════════════
// §7  "…MORE" EXPANSION
// ════════════════════════════════════════════════════════════════════════

const recheckQueue = new Set();

/** Queues a processed post for a text re-read once its DOM settles (debounced, capped). */
function scheduleRecheck(el) {
  recheckQueue.add(el);
  const now = Date.now();
  if (recheckTimer === null) {
    recheckFirstAt = now;
  } else if (now - recheckFirstAt < EXPANSION_MAX_WAIT_MS) {
    clearTimeout(recheckTimer);
  } else {
    return; // keep the pending timer so a busy post can't postpone the re-read forever
  }
  recheckTimer = setTimeout(flushRechecks, EXPANSION_DEBOUNCE_MS);
}

function flushRechecks() {
  recheckTimer = null;
  const els = Array.from(recheckQueue);
  recheckQueue.clear();
  els.forEach(recheckProcessed);
}

function clearPostMarks(el) {
  el.removeAttribute(PROCESSED_ATTR);
  el.removeAttribute(KEY_ATTR);
  ANNOTATION_ATTRS.forEach(attr => el.removeAttribute(attr));
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
    if (c.hasAttribute(BADGE_ATTR)) { c.remove(); break; }
  }
}

/**
 * Re-reads a processed post; when its text grew by more than EXPANSION_MIN_GROWTH chars
 * ("…more" expanded) the full text is re-dispatched with isUpdate and the SAME postKey.
 */
function recheckProcessed(el) {
  if (!el.isConnected || !isActive()) return;
  const postKey = el.getAttribute(KEY_ATTR);
  if (!postKey) return;

  if (blockElements.has(el)) {
    const blockText = fitText(readBlockText(el), false);
    if (blockText) sendExpansion(el, postKey, blockText, { postUrl: findNearestLink(el) }, { authorName: '', authorUrl: '' });
    return;
  }

  // A generic boundary that turned out to hold several posts: re-scan its children.
  if (!isPlatformBoundary(el) && isListLike(el)) {
    clearPostMarks(el);
    scanSubtree(el);
    return;
  }

  const platformIdentity = derivePlatformIdentity(el);
  // A recycled element now rendering a different post is a new post, not an update.
  if (platformIdentity && platformIdentity.postKey !== postKey) {
    clearPostMarks(el);
    processBoundaryContainer(el);
    return;
  }

  const info = extractContentInfo(el, platformIdentity);
  const text = fitText(info.text, !!platformIdentity);
  if (!text) return;
  const postUrl = platformIdentity ? platformIdentity.postUrl : findNearestLink(el);
  sendExpansion(el, postKey, text, { postUrl }, info);
}

function sendExpansion(el, postKey, text, urlInfo, meta) {
  const previousLength = sentLengths.get(postKey) || 0;
  if (text.length <= previousLength + EXPANSION_MIN_GROWTH) return;
  rememberSent(postKey, text.length);
  dispatch(sanitize(text), { postKey, postUrl: urlInfo.postUrl || '' }, meta, detectAd(el), true);
}

// ════════════════════════════════════════════════════════════════════════
// §8  MUTATION OBSERVER (debounced 250ms)
// ════════════════════════════════════════════════════════════════════════

const pendingNodes = new Set();

function flushPending() {
  debounceTimer = null;
  const nodes = Array.from(pendingNodes);
  pendingNodes.clear();
  refreshPlatformMarkup();
  for (let i = 0; i < nodes.length; i++) {
    scanSubtree(nodes[i]);
  }
}

function isBadge(node) {
  return node.nodeType === Node.ELEMENT_NODE && node.hasAttribute(BADGE_ATTR);
}

/** Our own badge being inserted / updated must not look like a post change. */
function isBadgeMutation(mutation, target) {
  if (target.closest('[' + BADGE_ATTR + ']')) return true;
  if (mutation.type !== 'childList') return false;
  const nodes = Array.from(mutation.addedNodes).concat(Array.from(mutation.removedNodes));
  return nodes.length > 0 && nodes.every(isBadge);
}

function onMutations(mutations) {
  if (!isActive()) return;

  let queued = false;
  for (let i = 0; i < mutations.length; i++) {
    const mutation = mutations[i];
    const target = mutation.target.nodeType === Node.ELEMENT_NODE ? mutation.target : mutation.target.parentElement;
    if (!target || isBadgeMutation(mutation, target)) continue;

    // Changes under a post we already sent ("…more", lazy text): re-read that post.
    const owner = target.closest('[' + KEY_ATTR + ']');
    if (owner) {
      scheduleRecheck(owner);
      continue;
    }

    if (mutation.type === 'characterData') {
      pendingNodes.add(target);
      queued = true;
      continue;
    }

    const added = mutation.addedNodes;
    for (let j = 0; j < added.length; j++) {
      const node = added[j];
      if (node.nodeType === Node.ELEMENT_NODE && !isBadge(node)) {
        pendingNodes.add(node);
        queued = true;
      }
    }
  }

  if (!queued) return;
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flushPending, DEBOUNCE_MS);
}

const observer = new MutationObserver(onMutations);
const OBSERVER_OPTIONS = { childList: true, subtree: true, characterData: true };

// ════════════════════════════════════════════════════════════════════════
// §9  DECISION ANNOTATIONS
// ════════════════════════════════════════════════════════════════════════

const BADGE_COLORS = { collected: '#0a7d33', rejected: '#6b7280', ignored: '#6b7280', pending: '#b7791f' };
const BADGE_SYMBOLS = { collected: '✓', rejected: '✗', ignored: '–', pending: '…' };

function shortString(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function elementsForKey(postKey) {
  try {
    return document.querySelectorAll('[' + KEY_ATTR + '="' + postKey.replace(/["\\]/g, '\\$&') + '"]');
  } catch {
    return [];
  }
}

/** Small, unobtrusive badge (DOM APIs + CSSOM only, so strict page CSPs don't block it). */
function renderBadge(el, decision) {
  const host = el.tagName === 'TR' ? (el.firstElementChild || el) : el;
  let badge = null;
  for (let c = host.firstElementChild; c; c = c.nextElementSibling) {
    if (c.hasAttribute(BADGE_ATTR)) { badge = c; break; }
  }
  if (!badge) {
    badge = document.createElement('span');
    badge.setAttribute(BADGE_ATTR, '');
    badge.setAttribute('aria-hidden', 'true');
    const s = badge.style;
    s.display = 'inline-block';
    s.margin = '2px 4px';
    s.padding = '0 6px';
    s.borderRadius = '8px';
    s.font = '600 10px/16px system-ui, sans-serif';
    s.color = '#fff';
    s.opacity = '0.85';
    s.pointerEvents = 'none';
    s.position = 'relative';
    s.zIndex = '1';
    host.insertBefore(badge, host.firstChild);
  }
  badge.style.background = BADGE_COLORS[decision.status] || '#555';
  const parts = ['SC', (BADGE_SYMBOLS[decision.status] || '') + ' ' + decision.status];
  if (decision.tag) parts.push(decision.tag);
  if (decision.pMatch !== null) parts.push('p=' + decision.pMatch.toFixed(2));
  if (decision.reason) parts.push(decision.reason);
  badge.textContent = parts.join(' · ');
}

function removeBadges() {
  document.querySelectorAll('[' + BADGE_ATTR + ']').forEach(b => b.remove());
}

function setOrRemove(el, attr, value) {
  if (value === '' || value === null || value === undefined) el.removeAttribute(attr);
  else el.setAttribute(attr, String(value));
}

function removeAnnotationAttributes() {
  document.querySelectorAll(ANNOTATION_ATTRS.map(a => '[' + a + ']').join(', '))
    .forEach(el => ANNOTATION_ATTRS.forEach(attr => el.removeAttribute(attr)));
}

/**
 * Shows a decision on a post element. Decisions are private (they reveal the user's prompt match,
 * tags and providers) and the page's own scripts, analytics and session-replay tools can read
 * the DOM, so by default NOTHING is written: the decision stays in this isolated world
 * (`decisions`). Only the opt-in debug mode (debugAnnotate) writes the data-sc-* attributes and the
 * visible badge, and switching it off removes them.
 */
function applyAnnotation(el, decision) {
  if (!contentConfig || !contentConfig.debugAnnotate) return;
  el.setAttribute('data-sc-status', decision.status);
  setOrRemove(el, 'data-sc-reason', decision.reason);
  setOrRemove(el, 'data-sc-tag', decision.tag);
  setOrRemove(el, 'data-sc-pmatch', decision.pMatch === null ? '' : decision.pMatch.toFixed(3));
  renderBadge(el, decision);
}

/** Records a decision for a post and annotates every element rendering it. */
function annotate(postKey, decision) {
  decisions.delete(postKey);
  decisions.set(postKey, decision);
  if (decisions.size > MAX_REMEMBERED_KEYS) decisions.delete(decisions.keys().next().value);
  elementsForKey(postKey).forEach(el => applyAnnotation(el, decision));
}

/** DECISION_RESULT payload: { postKey, status, reason?, tag?, pMatch? } */
function handleDecisionResult(payload) {
  if (!payload || typeof payload.postKey !== 'string' || !payload.postKey) return false;
  if (typeof payload.status !== 'string' || !/^[a-z_-]{1,32}$/.test(payload.status)) return false;
  const pMatch = typeof payload.pMatch === 'number' && isFinite(payload.pMatch) ? payload.pMatch : null;
  annotate(payload.postKey, {
    status: payload.status,
    reason: shortString(payload.reason, 200),
    tag: shortString(payload.tag, 100),
    pMatch
  });
  return true;
}

// ════════════════════════════════════════════════════════════════════════
// §10  CONFIGURATION & BOOTSTRAP
// ════════════════════════════════════════════════════════════════════════

let isObserverActive = false;

function isActive() {
  return !tornDown && contentConfig !== null && isSiteEnabled && !isPaused;
}

function startObserver() {
  if (isObserverActive || tornDown) return;

  const begin = () => {
    if (isObserverActive || !isActive() || !document.body) return;
    isObserverActive = true;
    scanSubtree(document.body);
    observer.observe(document.body, OBSERVER_OPTIONS);
    console.info('[ScrollCollector] Tracking observer started.');
  };

  if (document.readyState === 'loading' || !document.body) {
    document.addEventListener('DOMContentLoaded', begin, { once: true });
  } else {
    begin();
  }
}

function stopObserver() {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  if (recheckTimer !== null) clearTimeout(recheckTimer);
  debounceTimer = null;
  recheckTimer = null;
  pendingNodes.clear();
  recheckQueue.clear();
  if (!isObserverActive) return;
  observer.disconnect();
  isObserverActive = false;
  console.info('[ScrollCollector] Tracking observer stopped (paused).');
}

/**
 * Accepts the GET_CONTENT_CONFIG reply / CONTENT_CONFIG_UPDATED payload:
 * { isTrackingPaused, sites:[{domain,isEnabled}], ignoredDomains:[], debugAnnotate }.
 * @returns {object|null} normalized config, or null when the reply is not a config
 */
function normalizeContentConfig(raw) {
  if (!raw || typeof raw !== 'object' || raw.success === false) return null;
  const src = raw.config && typeof raw.config === 'object' ? raw.config : raw;
  if (!('isTrackingPaused' in src) && !Array.isArray(src.sites)) return null;
  return {
    isTrackingPaused: !!src.isTrackingPaused,
    sites: Array.isArray(src.sites) ? src.sites.filter(s => s && typeof s.domain === 'string') : [],
    ignoredDomains: Array.isArray(src.ignoredDomains) ? src.ignoredDomains.filter(d => typeof d === 'string') : [],
    debugAnnotate: !!src.debugAnnotate
  };
}

function applyContentConfig(raw) {
  const config = normalizeContentConfig(raw);
  if (!config || tornDown) return false;

  contentConfig = config;
  isPaused = config.isTrackingPaused;
  isSiteEnabled = checkIfSiteEnabled(SOURCE_PLATFORM, config.sites) &&
                  !isIgnoredHost(SOURCE_PLATFORM, config.ignoredDomains);

  if (config.debugAnnotate) {
    decisions.forEach((decision, postKey) => elementsForKey(postKey).forEach(el => applyAnnotation(el, decision)));
  } else {
    removeBadges();
    removeAnnotationAttributes();
  }

  if (isSiteEnabled && !isPaused) {
    startObserver();
  } else {
    stopObserver();
  }
  return true;
}

/**
 * Asks the service worker for the content configuration, retrying with backoff while it
 * starts up. Nothing is scanned or dispatched before a configuration arrives.
 */
function requestContentConfig(attempt) {
  configRetryTimer = null;
  if (tornDown || contentConfig) return;
  sendToBackground({ type: MSG.GET_CONTENT_CONFIG }).then(reply => {
    // A CONTENT_CONFIG_UPDATED push that arrived first is newer than this reply.
    if (tornDown || contentConfig) return;
    if (applyContentConfig(reply)) return;
    if (attempt < CONFIG_RETRY_DELAYS_MS.length) {
      configRetryTimer = setTimeout(() => requestContentConfig(attempt + 1), CONFIG_RETRY_DELAYS_MS[attempt]);
    } else {
      console.info('[ScrollCollector] No configuration from the service worker yet; waiting for CONTENT_CONFIG_UPDATED.');
    }
  });
}

function resetAndRescan() {
  sentLengths.clear();
  decisions.clear();
  document.querySelectorAll('[' + PROCESSED_ATTR + '], [' + KEY_ATTR + ']').forEach(clearPostMarks);
  removeBadges();
  if (isActive()) scanSubtree(document.body);
}

/**
 * Handles background -> content messages. Returns false for messages it does not handle
 * (and after synchronous replies) so other listeners and senders are not kept waiting.
 */
function onRuntimeMessage(message, _sender, sendResponse) {
  if (!message || typeof message.type !== 'string' || tornDown) return false;

  switch (message.type) {
    case MSG.PING:
      sendResponse({ alive: true });
      return false;
    case MSG.RESET_AND_RESCAN:
      // Reset local duplicate cache and processed marks, then rescan the page
      resetAndRescan();
      sendResponse({ success: true });
      return false;
    case MSG.DECISION_RESULT:
      sendResponse({ success: handleDecisionResult(message.payload || message) });
      return false;
    case MSG.CONTENT_CONFIG_UPDATED:
      sendResponse({ success: applyContentConfig(message.payload || message) });
      return false;
    default:
      return false;
  }
}

/** Stops everything (extension context invalidated, or replaced by a fresh injection). */
function teardown() {
  if (tornDown) return;
  tornDown = true;
  stopObserver();
  if (configRetryTimer !== null) clearTimeout(configRetryTimer);
  configRetryTimer = null;
  try {
    chrome.runtime.onMessage.removeListener(onRuntimeMessage);
  } catch {
    // context already gone
  }
  if (window.__scrollCollectorLoaded === instance) {
    try { delete window.__scrollCollectorLoaded; } catch { window.__scrollCollectorLoaded = undefined; }
  }
}

const instance = {
  isAlive: () => !tornDown && extensionContextAlive(),
  teardown,
  /**
   * The last decision for a post: { status, reason, tag, pMatch } or null. This object lives in the
   * content script's isolated world (the page's scripts cannot see it); tests read decisions here
   * instead of from page-visible attributes.
   */
  annotation: (postKey) => {
    const d = decisions.get(String(postKey));
    return d ? { status: d.status, reason: d.reason || null, tag: d.tag || null, pMatch: d.pMatch } : null;
  }
};
window.__scrollCollectorLoaded = instance;

// Handle IPC messages from background script
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
}

// Configuration comes from the service worker (content scripts cannot read storage.local)
if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
  requestContentConfig(0);
}
})();
