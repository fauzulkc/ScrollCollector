/**
 * Universal Local Mindstream Analytics – Content Script
 * ─────────────────────────────────────────────────────
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
    'SVG', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'IFRAME'
  ]);

  /** Block-level containers we actively scan for text */
  const CONTENT_TAGS = new Set([
    'DIV', 'ARTICLE', 'SECTION', 'P', 'LI', 'BLOCKQUOTE',
    'TD', 'FIGCAPTION', 'MAIN', 'SPAN'
  ]);

  /** Minimum / maximum accepted text length */
  const MIN_TEXT_LEN = 60;
  const MAX_TEXT_LEN = 2000;

  /** Minimum text-to-HTML ratio */
  const MIN_TEXT_RATIO = 0.4;

  /** Debounce interval for MutationObserver (ms) */
  const DEBOUNCE_MS = 250;

  /** Attribute used to mark already-processed elements */
  const PROCESSED_ATTR = 'data-mindstream-processed';

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
      hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0; // hash * 33 + c
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
   * Walk from `element` upward / inward / sideways to find the nearest
   * relevant <a href> URL.  Falls back to the current page URL.
   *
   * @param {Element} element
   * @returns {string} Absolute URL string
   */
  function findNearestLink(element) {
    /** URLs we never want to return */
    function isUsableHref(href) {
      if (!href) return false;
      if (href.startsWith('javascript:')) return false;
      if (href === '#' || href.startsWith('#')) return false;
      return true;
    }

    /** Convert a potentially-relative href to an absolute URL */
    function toAbsolute(href) {
      try {
        return new URL(href, window.location.href).href;
      } catch {
        return href;
      }
    }

    // 1. Walk UP from element looking for an ancestor <a>
    let node = element;
    while (node && node !== document.body) {
      if (node.tagName === 'A' && isUsableHref(node.getAttribute('href'))) {
        return toAbsolute(node.getAttribute('href'));
      }
      node = node.parentElement;
    }

    // 2. Search WITHIN the element for <a> tags
    const innerLinks = element.querySelectorAll
      ? Array.from(element.querySelectorAll('a[href]'))
      : [];

    if (innerLinks.length > 0) {
      // Prefer links that look like permalinks
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

      // Otherwise take the first usable inner link
      const firstUsable = innerLinks.find(a => isUsableHref(a.getAttribute('href')));
      if (firstUsable) return toAbsolute(firstUsable.getAttribute('href'));
    }

    // 3. Check NEXT and PREVIOUS siblings for <a> tags
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

    // 4. Fallback: current page URL
    return window.location.href;
  }

  // ════════════════════════════════════════════════════════════════════════
  // §4  IPC DISPATCH
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Send extracted text to the background service worker.
   * Silently fails if the extension context has been invalidated
   * (e.g. extension update / uninstall while tab is open).
   *
   * @param {string} sanitizedText
   * @param {Element} element – the source DOM element (used for link extraction)
   */
  function dispatch(sanitizedText, element) {
    try {
      chrome.runtime.sendMessage({
        type: 'TEXT_EXTRACTED',
        payload: {
          text: sanitizedText,
          sourcePlatform: SOURCE_PLATFORM,
          sourceUrl: findNearestLink(element),
          timestamp: Date.now()
        }
      });
    } catch (err) {
      // Extension context invalidated – nothing we can do.
      // Avoid noisy console errors on every mutation.
      if (
        err.message &&
        err.message.includes('Extension context invalidated')
      ) {
        // Disconnect observer to stop further attempts
        if (observer) observer.disconnect();
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // §5  TEXT DENSITY ENGINE
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Evaluate a single element for qualifying text content.
   * If it passes all density / dedup checks, dispatch it.
   *
   * @param {Element} el
   */
  function processElement(el) {
    // Must be an Element node with one of our target tag names
    if (el.nodeType !== Node.ELEMENT_NODE) return;
    if (!CONTENT_TAGS.has(el.tagName)) return;

    // Skip noise subtrees & already-processed nodes
    if (isNoiseOrProcessed(el)) return;

    // ── Text density checks ──
    const text = el.innerText ? el.innerText.trim() : '';
    if (text.length < MIN_TEXT_LEN || text.length > MAX_TEXT_LEN) return;

    const htmlLen = el.innerHTML.length;
    if (htmlLen === 0 || text.length / htmlLen <= MIN_TEXT_RATIO) return;

    // ── Deduplication ──
    const hash = hashString(text);
    if (seenHashes.has(hash)) {
      // Mark processed even for duplicates so we don't re-evaluate
      el.setAttribute(PROCESSED_ATTR, 'true');
      return;
    }
    seenHashes.add(hash);

    // Mark as processed
    el.setAttribute(PROCESSED_ATTR, 'true');

    // ── Sanitize PII & send ──
    const clean = sanitize(text);
    dispatch(clean, el);
  }

  /**
   * Walk a subtree and process all qualifying elements.
   * Uses querySelectorAll for efficiency rather than a manual TreeWalker.
   *
   * @param {Element} root
   */
  function scanSubtree(root) {
    if (!root || !root.querySelectorAll) return;

    // Also evaluate the root itself
    processElement(root);

    const selector = Array.from(CONTENT_TAGS).join(',').toLowerCase();
    const candidates = root.querySelectorAll(selector);
    for (let i = 0; i < candidates.length; i++) {
      processElement(candidates[i]);
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // §6  MUTATION OBSERVER  (debounced 250ms)
  // ════════════════════════════════════════════════════════════════════════

  /** Collect added nodes and scan them after the debounce window. */
  let pendingNodes = [];

  /**
   * Flush pending nodes: process each one through the text density engine.
   */
  function flushPending() {
    const nodes = pendingNodes;
    pendingNodes = [];
    for (let i = 0; i < nodes.length; i++) {
      scanSubtree(nodes[i]);
    }
  }

  /**
   * MutationObserver callback.
   * Accumulates added nodes and resets the debounce timer.
   *
   * @param {MutationRecord[]} mutations
   */
  function onMutations(mutations) {
    for (let i = 0; i < mutations.length; i++) {
      const added = mutations[i].addedNodes;
      for (let j = 0; j < added.length; j++) {
        const node = added[j];
        if (node.nodeType === Node.ELEMENT_NODE) {
          pendingNodes.push(node);
        }
      }
    }

    // Debounce: reset timer on every batch of mutations
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flushPending, DEBOUNCE_MS);
  }

  /** The single MutationObserver instance */
  const observer = new MutationObserver(onMutations);

  // ════════════════════════════════════════════════════════════════════════
  // §7  BOOTSTRAP
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Initial full-page scan + observer activation.
   * Called once when the content script is injected.
   */
  function bootstrap() {
    // One-time scan of existing DOM content
    scanSubtree(document.body);

    // Begin observing future mutations
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  // Kick off once the DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    // DOM already parsed (script injected late or via manifest)
    bootstrap();
  }

})();
