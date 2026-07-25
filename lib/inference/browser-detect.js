/**
 * Detect Chromium browser variant for on-device model display names.
 */

/**
 * @returns {'chrome' | 'edge' | 'brave' | 'other'}
 */
export function detectBrowserVariant() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/Edg\//.test(ua)) return 'edge';
  if (/Brave\//.test(ua) || (navigator.brave && typeof navigator.brave.isBrave === 'function')) return 'brave';
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
