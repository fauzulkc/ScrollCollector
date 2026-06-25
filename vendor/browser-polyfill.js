/**
 * Minimal browser-polyfill shim for Chromium-only builds.
 * Provides the `browser` namespace as an alias for `chrome`.
 * Replace with mozilla/webextension-polyfill for cross-browser support.
 */
if (typeof globalThis.browser === 'undefined') {
  globalThis.browser = globalThis.chrome;
}
