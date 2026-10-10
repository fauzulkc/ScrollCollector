/**
 * Small helpers shared by the side panel modules (ui/*.js and sidepanel.js).
 * Pure functions except sendMessage(), which wraps chrome.runtime.sendMessage.
 */

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Escapes text for HTML element content and quoted attribute values.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHTML(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/**
 * Returns `url` when it is an absolute http(s) URL, else ''. Used before putting collected URLs
 * into hrefs or window.open (a page could hand us `javascript:` or `data:` links).
 * @param {unknown} url
 * @returns {string}
 */
export function safeHttpUrl(url) {
  if (typeof url !== 'string' || !url) return '';
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
  } catch {
    return '';
  }
}

/**
 * Sends a runtime message and resolves with the reply, or null when there is no receiver or the
 * call throws. Never rejects.
 *
 * @param {string} type
 * @param {object} [payload]
 * @param {{ runtime?: { sendMessage: Function } }} [opts]
 * @returns {Promise<any>}
 */
export async function sendMessage(type, payload, { runtime = globalThis.chrome?.runtime } = {}) {
  if (!runtime || typeof runtime.sendMessage !== 'function') return null;
  const message = payload === undefined ? { type } : { type, payload };
  try {
    const reply = await runtime.sendMessage(message);
    return reply === undefined ? null : reply;
  } catch {
    return null;
  }
}

/**
 * True for the router's reply to a message type it does not know (a background without that
 * handler yet): { success: false, error: 'Unknown message type' }.
 * @param {any} reply
 */
export function isUnsupportedReply(reply) {
  return !!reply && reply.success === false && reply.error === 'Unknown message type';
}

/**
 * @param {unknown} ms
 * @returns {string} '12 ms', '1.4 s' or '—'
 */
export function formatMs(ms) {
  const n = Number(ms);
  if (ms === null || ms === undefined || ms === '' || !Number.isFinite(n) || n < 0) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)} s`;
  return `${Math.round(n)} ms`;
}

/**
 * @param {unknown} fraction  0..1
 * @param {number} [digits]
 * @returns {string} '84%' or '—'
 */
export function formatPct(fraction, digits = 0) {
  const n = Number(fraction);
  if (fraction === null || fraction === undefined || fraction === '' || !Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(digits)}%`;
}

/**
 * @param {unknown} p  probability 0..1
 * @returns {string} '0.92' or '—'
 */
export function formatProb(p) {
  const n = Number(p);
  if (p === null || p === undefined || p === '' || !Number.isFinite(n)) return '—';
  return n.toFixed(2);
}

/**
 * @param {unknown} usd
 * @returns {string} '$0.0012' or '—'
 */
export function formatUsd(usd) {
  const n = Number(usd);
  if (usd === null || usd === undefined || usd === '' || !Number.isFinite(n)) return '—';
  if (n === 0) return '$0';
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

/**
 * Trailing-edge debounce with cancel/flush/pending.
 * @template {(...args: any[]) => any} F
 * @param {F} fn
 * @param {number} ms
 */
export function debounce(fn, ms) {
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null;
  /** @type {any[]|null} */
  let lastArgs = null;
  const debounced = (...args) => {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const a = lastArgs;
      lastArgs = null;
      fn(...a);
    }, ms);
  };
  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };
  debounced.flush = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    const a = lastArgs;
    lastArgs = null;
    fn(...a);
  };
  debounced.pending = () => timer !== null;
  return debounced;
}

/**
 * True when `el` is a text-entry control (typing there must not trigger panel shortcuts or be
 * overwritten by re-renders).
 * @param {Element|null|undefined} el
 */
export function isTextEntry(el) {
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const type = String(/** @type {HTMLInputElement} */ (el).type || 'text').toLowerCase();
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type);
  }
  return !!(/** @type {HTMLElement} */ (el).isContentEditable);
}
