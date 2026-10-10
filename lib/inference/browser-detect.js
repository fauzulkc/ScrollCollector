/**
 * Detect the Chromium browser variant, for the display name of its built-in on-device model
 * (lib/decision/providers/nano.js). The rest of the former lib/inference/ router (router.js,
 * providers/browser-prompt.js, cloud.js, keyword-status.js, types.js) was retired in Phase 5:
 * decisions go through lib/decision/cascade.js and its providers.
 */

/**
 * @returns {'chrome' | 'edge' | 'brave' | 'other'}
 */
export function detectBrowserVariant() {
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  const ua = nav && typeof nav.userAgent === 'string' ? nav.userAgent : '';
  if (/Edg\//.test(ua)) return 'edge';
  if (/Brave\//.test(ua) || (nav && /** @type {any} */ (nav).brave && typeof /** @type {any} */ (nav).brave.isBrave === 'function')) return 'brave';
  if (/Chrome\//.test(ua)) return 'chrome';
  return 'other';
}

/**
 * Human-readable name for the browser's built-in on-device model.
 *
 * @returns {string}
 */
export function getBrowserModelDisplayName() {
  switch (detectBrowserVariant()) {
    case 'edge': return 'Phi-4-mini';
    case 'chrome': return 'Gemini Nano';
    case 'brave': return 'Browser SLM';
    default: return 'Browser SLM';
  }
}

/**
 * Generic label while model is downloading.
 *
 * @returns {string}
 */
export function getBrowserModelDownloadingLabel() {
  return `${getBrowserModelDisplayName()} (downloading…)`;
}
