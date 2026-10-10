/**
 * Toasts for the side panel (replace alert(), which blocks the panel and is easy to miss).
 *
 *  - One live region (aria-live="polite"); error toasts use role="alert" so screen readers
 *    announce them immediately.
 *  - `key` de-duplicates: showing a toast with the key of a visible toast replaces its text and
 *    restarts its timer instead of stacking a copy (e.g. repeated provider errors).
 *  - Text is always set with textContent.
 */

const LEVELS = new Set(['info', 'success', 'warn', 'error']);

/**
 * @typedef {object} ToastOptions
 * @property {'info'|'success'|'warn'|'error'} [level]
 * @property {string} text
 * @property {string} [key]
 * @property {number} [timeoutMs]   0 keeps the toast until dismissed
 */

/**
 * @param {{ root?: HTMLElement, doc?: Document, defaultMs?: number, errorMs?: number, max?: number }} [opts]
 */
export function createToaster({ root, doc = globalThis.document, defaultMs = 4500, errorMs = 9000, max = 4 } = {}) {
  const parent = root || doc.body;
  let region = /** @type {HTMLElement|undefined} */ ([...parent.children].find((c) => c.classList.contains('toast-region')));
  if (!region) {
    region = doc.createElement('div');
    region.className = 'toast-region';
    region.setAttribute('aria-live', 'polite');
    region.setAttribute('aria-relevant', 'additions text');
    parent.appendChild(region);
  }

  /** @type {Map<HTMLElement, ReturnType<typeof setTimeout>|null>} */
  const timers = new Map();

  /** @param {HTMLElement} el */
  function remove(el) {
    const t = timers.get(el);
    if (t) clearTimeout(t);
    timers.delete(el);
    el.remove();
  }

  /**
   * @param {HTMLElement} el
   * @param {number} ms
   */
  function arm(el, ms) {
    const prev = timers.get(el);
    if (prev) clearTimeout(prev);
    timers.set(el, ms > 0 ? setTimeout(() => remove(el), ms) : null);
  }

  /**
   * @param {ToastOptions|string} options
   * @returns {HTMLElement|null}
   */
  function show(options) {
    const opts = typeof options === 'string' ? { text: options } : (options || /** @type {any} */ ({}));
    const text = String(opts.text ?? '').trim();
    if (!text) return null;
    const level = LEVELS.has(/** @type {string} */ (opts.level)) ? opts.level : 'info';
    const ms = Number.isFinite(opts.timeoutMs) ? Math.max(0, /** @type {number} */ (opts.timeoutMs)) : (level === 'error' ? errorMs : defaultMs);

    let el = opts.key ? /** @type {HTMLElement|null} */ ([...region.children].find((c) => /** @type {HTMLElement} */ (c).dataset.key === opts.key) || null) : null;
    if (!el) {
      el = doc.createElement('div');
      const body = doc.createElement('span');
      body.className = 'toast-text';
      const close = doc.createElement('button');
      close.type = 'button';
      close.className = 'toast-close';
      close.setAttribute('aria-label', 'Dismiss notification');
      close.textContent = '×';
      close.addEventListener('click', () => remove(/** @type {HTMLElement} */ (el)));
      el.append(body, close);
      if (opts.key) el.dataset.key = opts.key;
      region.appendChild(el);
    }
    el.className = `toast toast-${level}`;
    el.setAttribute('role', level === 'error' ? 'alert' : 'status');
    /** @type {HTMLElement} */ (el.querySelector('.toast-text')).textContent = text;
    arm(el, ms);

    // Oldest toasts go first when too many are visible.
    while (region.children.length > max) remove(/** @type {HTMLElement} */ (region.firstElementChild));
    return el;
  }

  /** @param {string|HTMLElement} keyOrEl */
  function dismiss(keyOrEl) {
    const el = typeof keyOrEl === 'string'
      ? [...region.children].find((c) => /** @type {HTMLElement} */ (c).dataset.key === keyOrEl)
      : keyOrEl;
    if (el) remove(/** @type {HTMLElement} */ (el));
  }

  function clear() {
    for (const el of [...region.children]) remove(/** @type {HTMLElement} */ (el));
  }

  return { show, dismiss, clear, region };
}
