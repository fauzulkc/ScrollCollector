/**
 * ScrollCollector – Content Script
 * ────────────────────────────────
 * Platform-agnostic heuristic text extraction with:
 *   • MutationObserver (debounced 250ms)
 *   • Text-density filtering
 *   • Deduplication via string hashing
 *   • Inline PII sanitization (email, phone, credit card w/ Luhn)
 *   • IPC dispatch to background service worker
 *
 * No external dependencies.  Designed to be lightweight.
 */

(function () {
  'use strict';

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

/** Boundary selectors for posts/articles on specific platforms */
const BOUNDARY_SELECTORS = [
  'div.feed-shared-update-v2', 'div.occludable-update', // LinkedIn legacy
  '[data-urn*="urn:li:activity:"]', '[data-urn*="urn:li:share:"]', '[data-urn*="urn:li:ugcPost:"]', // LinkedIn modern
  'article[data-testid="tweet"]',                      // Twitter/X
  '[role="article"]', 'div[data-pagelet^="FeedUnit_"]', 'div[data-pagelet^="ReelsConsumerVideoSheet"]', 'div[data-pagelet^="ReelsUnit"]', 'div[data-pagelet^="Reel_"]', '[data-testid="key__feed_story"]', 'div[data-testid="fbfeed_story"]', // Facebook modern & Reels
  'ytd-rich-item-renderer', 'ytd-video-renderer', 'ytd-compact-video-renderer', 'ytd-grid-video-renderer', 'ytd-reel-video-renderer', // YouTube videos
  'ytd-comment-thread-renderer', // YouTube comments
  'article', 'div.postArticle', '[class*="post-"]', '[class*="article-"]' // Medium & Generic Articles
];

/** Minimum / maximum accepted text length */
const MIN_TEXT_LEN = 60;
const MAX_TEXT_LEN = 2000;

/** Minimum text-to-HTML ratio for generic scanning */
const MIN_TEXT_RATIO = 0.4;

/** Debounce interval for MutationObserver (ms) */
const DEBOUNCE_MS = 250;

/** Attribute used to mark already-processed elements */
const PROCESSED_ATTR = 'data-scrollcollector-processed';

/** Platform hostname */
const SOURCE_PLATFORM = window.location.hostname;

/** Set of seen text hashes (deduplication) */
const seenHashes = new Set();

/** Debounce timer id */
let debounceTimer = null;

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
 * Checks if a hostname matches any enabled site configurations.
 */
function checkIfSiteEnabled(hostname, sites) {
  if (!sites || sites.length === 0) return true; // fallback to true
  const lowerHost = hostname.toLowerCase();
  return sites.some(s => {
    if (!s.isEnabled) return false;
    const domain = s.domain.toLowerCase();
    return lowerHost === domain || lowerHost.endsWith('.' + domain);
  });
}

/**
 * Walk from `element` upward / inward / sideways to find the nearest
 * relevant <a href> URL.  Falls back to the current page URL.
 *
 * @param {Element} element
 * @returns {string} Absolute URL string
 */
function findNearestLink(element) {
  function isUsableHref(href) {
    if (!href) return false;
    if (href.startsWith('javascript:')) return false;
    if (href === '#' || href.startsWith('#')) return false;
    return true;
  }

  function toAbsolute(href) {
    try {
      return new URL(href, window.location.href).href;
    } catch {
      return href;
    }
  }

  let node = element;
  while (node && node !== document.body) {
    if (node.tagName === 'A' && isUsableHref(node.getAttribute('href'))) {
      return toAbsolute(node.getAttribute('href'));
    }
    node = node.parentElement;
  }

  const innerLinks = element.querySelectorAll
    ? Array.from(element.querySelectorAll('a[href]'))
    : [];

  if (innerLinks.length > 0) {
    const permalinkPatterns = [
      '/post', '/status', '/p/', '/watch',
      '/video', '/articles', '/pulse', '/reel'
    ];

    const permalink = innerLinks.find(a => {
      const href = a.getAttribute('href') || '';
      return isUsableHref(href) &&
        permalinkPatterns.some(pat => href.includes(pat));
    });

    if (permalink) return toAbsolute(permalink.getAttribute('href'));

    const firstUsable = innerLinks.find(a => isUsableHref(a.getAttribute('href')));
    if (firstUsable) return toAbsolute(firstUsable.getAttribute('href'));
  }

  for (const sibling of [element.previousElementSibling, element.nextElementSibling]) {
    if (!sibling) continue;
    if (sibling.tagName === 'A' && isUsableHref(sibling.getAttribute('href'))) {
      return toAbsolute(sibling.getAttribute('href'));
    }
    const siblingLink = sibling.querySelector && sibling.querySelector('a[href]');
    if (siblingLink && isUsableHref(siblingLink.getAttribute('href'))) {
      return toAbsolute(siblingLink.getAttribute('href'));
    }
  }

  return window.location.href;
}

// ════════════════════════════════════════════════════════════════════════
// §4  IPC DISPATCH
// ════════════════════════════════════════════════════════════════════════

/**
 * Send extracted text to the background service worker.
 *
 * @param {string} sanitizedText
 * @param {Element} element – the source DOM element
 * @param {boolean} isAd – whether this card was flagged as sponsored/promoted
 */
function dispatch(sanitizedText, element, isAd = false) {
  try {
    chrome.runtime.sendMessage({
      type: 'TEXT_EXTRACTED',
      payload: {
        text: sanitizedText,
        sourcePlatform: SOURCE_PLATFORM,
        sourceUrl: findNearestLink(element),
        timestamp: Date.now(),
        isAd
      }
    });
  } catch (err) {
    if (
      err.message &&
      err.message.includes('Extension context invalidated')
    ) {
      if (observer) observer.disconnect();
    }
  }
}

// ════════════════════════════════════════════════════════════════════════
// §5  BOUNDARY DETECTION & TEXT EXTRACTION ENGINE
// ════════════════════════════════════════════════════════════════════════

/**
 * Identifies the closest post or article container boundaries for an element.
 */
function findBoundaryContainer(element) {
  if (!element || element === document.body) return null;

  // 1. Matches predefined selectors
  for (const selector of BOUNDARY_SELECTORS) {
    if (element.matches && element.matches(selector)) {
      return element;
    }
    const closest = element.closest && element.closest(selector);
    if (closest && closest !== document.body) {
      return closest;
    }
  }

  // 2. Matches general custom containers
  let current = element;
  while (current && current !== document.body) {
    const tag = current.tagName;
    if (tag === 'ARTICLE') {
      return current;
    }
    const classes = current.className || '';
    if (typeof classes === 'string' && /\b(post|tweet|article|card|feed-item|story)\b/i.test(classes)) {
      // Exclude layouts, list containers, and wrapping frameworks
      if (!/(container|list|grid|deck|wrapper|feed|group|scroller|tray|stream|holder|body|page|app|main)/i.test(classes)) {
        return current;
      }
    }
    current = current.parentElement;
  }

  return null;
}

/**
 * Clones a container, strips noisy UI elements, and retrieves text.
 */
function extractTextFromContainer(container) {
  if (!container) return '';
  
  // YouTube site-specific custom text extraction
  const tagName = container.tagName.toLowerCase();
  const isYouTubeVideo = tagName.startsWith('ytd-') && tagName.includes('video-renderer') || tagName === 'ytd-rich-item-renderer' || tagName === 'ytd-reel-video-renderer';
  
  if (isYouTubeVideo) {
    const titleEl = container.querySelector('#video-title, #video-title-link, #title, yt-formatted-string.title, .title, .ytd-reel-player-header-renderer');
    const channelEl = container.querySelector('ytd-channel-name, #channel-name, #byline-container, .channel-name, #channel-name-container');
    const metaEl = container.querySelector('#metadata-line');
    
    if (titleEl) {
      const title = titleEl.innerText.trim();
      const channel = channelEl ? channelEl.innerText.trim() : '';
      const meta = metaEl ? metaEl.innerText.trim().replace(/\s+/g, ' ').replace(/\n/g, ' • ') : '';
      
      return `${title}\nChannel: ${channel}\nInfo: ${meta}`;
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

  // Facebook site-specific custom text extraction
  if (location.hostname.includes('facebook.com')) {
    const authorEl = container.querySelector('h2 a[role="link"], h3 a[role="link"], h4 a[role="link"], strong a[role="link"], a[role="link"] strong, span > a[role="link"]');
    const captionEl = container.querySelector('div[data-ad-preview="message"], div[dir="auto"] span[dir="auto"], div[dir="auto"]');
    if (authorEl || captionEl) {
      const author = authorEl ? authorEl.innerText.trim() : 'Facebook User/Page';
      const caption = captionEl ? captionEl.innerText.trim() : '';
      
      if (caption && caption !== author) {
        let cleanCaption = caption;
        if (cleanCaption.endsWith('Follow')) cleanCaption = cleanCaption.slice(0, -6).trim();
        return `${cleanCaption}\nAuthor: ${author}`;
      }
    }
  }

  // Fallback to default generic extraction
  try {
    const clone = container.cloneNode(true);
    const noiseSelector = Array.from(NOISE_TAGS).join(',').toLowerCase();
    const noise = clone.querySelectorAll(noiseSelector);
    noise.forEach(n => n.remove());
    return (clone.innerText || clone.textContent || '').trim().replace(/\s+/g, ' ');
  } catch {
    return (container.innerText || '').trim().replace(/\s+/g, ' ');
  }
}

/**
 * Scans a boundary container for sponsored or promoted visual elements.
 */
function detectAd(container) {
  const text = (container.innerText || '').toLowerCase();
  
  // 1. Platform text signatures
  if (text.includes('sponsored') || text.includes('promoted') || text.includes('advertisement')) {
    // Check specific elements to filter out false positives
    const elements = container.querySelectorAll('*');
    for (const el of elements) {
      const elText = (el.innerText || '').trim().toLowerCase();
      // Check for standalone badges
      if (elText === 'sponsored' || elText === 'promoted' || elText === 'ad' || elText === 'advertisement') {
        return true;
      }
      
      // Facebook hides letters inside spans or uses CSS order obfuscation
      // Checking for attributes commonly associated with ads:
      const classAttr = el.getAttribute('class') || '';
      if (typeof classAttr === 'string' && (classAttr.includes('sponsored') || classAttr.includes('promoted'))) {
        return true;
      }
    }
  }

  // 2. Class check
  const classes = typeof container.className === 'string' ? container.className.toLowerCase() : '';
  if (classes.includes('ad-container') || classes.includes('sponsored-post') || classes.includes('promoted-tweet')) {
    return true;
  }

  return false;
}

/**
 * Evaluates a boundary container.
 */
function processBoundaryContainer(el) {
  if (el.hasAttribute(PROCESSED_ATTR)) return;
  el.setAttribute(PROCESSED_ATTR, 'true');

  const text = extractTextFromContainer(el);
  if (text.length < MIN_TEXT_LEN || text.length > MAX_TEXT_LEN) return;

  const hash = hashString(text);
  if (seenHashes.has(hash)) return;
  seenHashes.add(hash);

  const isAd = detectAd(el);
  const clean = sanitize(text);
  dispatch(clean, el, isAd);
}

/**
 * Fallback parser for generic elements when no boundaries are detected.
 */
function processGenericContent(el) {
  if (el.nodeType !== Node.ELEMENT_NODE) return;
  if (!CONTENT_TAGS.has(el.tagName)) return;
  if (isNoiseOrProcessed(el)) return;

  const text = el.innerText ? el.innerText.trim() : '';
  if (text.length < MIN_TEXT_LEN || text.length > MAX_TEXT_LEN) return;

  const htmlLen = el.innerHTML.length;
  if (htmlLen === 0 || text.length / htmlLen <= MIN_TEXT_RATIO) return;

  const hash = hashString(text);
  if (seenHashes.has(hash)) {
    el.setAttribute(PROCESSED_ATTR, 'true');
    return;
  }
  seenHashes.add(hash);

  el.setAttribute(PROCESSED_ATTR, 'true');

  const isAd = detectAd(el);
  const clean = sanitize(text);
  dispatch(clean, el, isAd);
}

/**
 * Scans a subtree for boundary containers, falling back to density blocks.
 */
function scanSubtree(root) {
  if (!root || isPaused || !isSiteEnabled) return;

  const boundaryElements = [];

  // Check if root is a boundary
  const rootBoundary = findBoundaryContainer(root);
  if (rootBoundary) {
    boundaryElements.push(rootBoundary);
  }

  // Find other boundaries
  if (root.querySelectorAll) {
    BOUNDARY_SELECTORS.forEach(selector => {
      const matches = root.querySelectorAll(selector);
      matches.forEach(m => {
        if (m !== root && !boundaryElements.includes(m)) {
          boundaryElements.push(m);
        }
      });
    });
  }

  if (boundaryElements.length === 0) {
    // Fall back to scanning individual text tags
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
// §6  MUTATION OBSERVER (debounced 250ms)
// ════════════════════════════════════════════════════════════════════════

let pendingNodes = [];

function flushPending() {
  const nodes = pendingNodes;
  pendingNodes = [];
  for (let i = 0; i < nodes.length; i++) {
    scanSubtree(nodes[i]);
  }
}

function onMutations(mutations) {
  if (isPaused || !isSiteEnabled) return;

  for (let i = 0; i < mutations.length; i++) {
    const added = mutations[i].addedNodes;
    for (let j = 0; j < added.length; j++) {
      const node = added[j];
      if (node.nodeType === Node.ELEMENT_NODE) {
        pendingNodes.push(node);
      }
    }
  }

  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flushPending, DEBOUNCE_MS);
}

const observer = new MutationObserver(onMutations);

// ════════════════════════════════════════════════════════════════════════
// §7  BOOTSTRAP
// ════════════════════════════════════════════════════════════════════════

let isObserverActive = false;
let isSiteEnabled = true;
let isPaused = false;

function startObserver() {
  if (isObserverActive) return;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      if (isObserverActive) return;
      scanSubtree(document.body);
      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
      isObserverActive = true;
      console.info('[ScrollCollector] Tracking observer started.');
    });
  } else {
    scanSubtree(document.body);
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
    isObserverActive = true;
    console.info('[ScrollCollector] Tracking observer started.');
  }
}

function stopObserver() {
  if (!isObserverActive) return;
  observer.disconnect();
  isObserverActive = false;
  console.info('[ScrollCollector] Tracking observer stopped (paused).');
}

function handleStateChange(config) {
  const sites = config ? (config.sites || []) : [];
  isPaused = config ? !!config.isTrackingPaused : false;
  
  isSiteEnabled = checkIfSiteEnabled(SOURCE_PLATFORM, sites);
  
  if (isSiteEnabled && !isPaused) {
    startObserver();
  } else {
    stopObserver();
  }
}

// Check configuration to guard domain scanning on start
if (chrome?.storage?.local) {
  chrome.storage.local.get('configuration', (data) => {
    const config = data ? data.configuration : null;
    handleStateChange(config);
  });
  
  // Listen for configuration updates dynamically
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.configuration) {
      handleStateChange(changes.configuration.newValue);
    }
  });
} else {
  startObserver();
}

})();
