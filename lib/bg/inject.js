/**
 * inject.js
 *
 * Content-script (re-)injection for tabs that were open before install/update or whose script died.
 * The manifest already injects content.js into new pages; this only covers existing tabs.
 */

import { DEFAULT_SITE_DOMAINS, checkIfSiteEnabled, normalizeDomain } from '../sites.js';

export { checkIfSiteEnabled };

/**
 * @param {number} tabId
 * @param {{ scripting?: typeof chrome.scripting }} env
 */
async function injectContentScript(tabId, { scripting }) {
  await scripting.executeScript({ target: { tabId }, files: ['content.js'] });
}

/**
 * Injects content.js into `tabId` when its site is enabled and the tab does not answer PING.
 *
 * @param {number} tabId
 * @param {string} url
 * @param {{ store: { get: (k: any) => Promise<any> }, tabs?: typeof chrome.tabs, scripting?: typeof chrome.scripting }} env
 */
export async function ensureContentScriptInjected(tabId, url, { store, tabs = globalThis.chrome?.tabs, scripting = globalThis.chrome?.scripting }) {
  if (!tabId || !url || !scripting || !tabs) return;
  if (!url.startsWith('http://') && !url.startsWith('https://')) return;

  let hostname;
  try {
    hostname = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return;
  }

  const { configuration = {} } = (await store.get('configuration')) || {};
  if (!checkIfSiteEnabled(hostname, configuration.sites || [])) return;

  try {
    await tabs.sendMessage(tabId, { type: 'PING' });
    return; // content script alive
  } catch {
    // no receiver: inject below
  }
  try {
    await injectContentScript(tabId, { scripting });
    console.info(`[background] Injected content script successfully on tab ${tabId}`);
  } catch (err) {
    console.warn(`[background] Failed to inject content script on tab ${tabId}:`, err);
  }
}

/**
 * After install/update: inject into already-open tabs of default and custom sites.
 *
 * @param {{ store: { get: (k: any) => Promise<any> }, tabs?: typeof chrome.tabs, scripting?: typeof chrome.scripting }} env
 */
export async function injectIntoOpenTabs({ store, tabs = globalThis.chrome?.tabs, scripting = globalThis.chrome?.scripting }) {
  if (!scripting || !tabs) return;
  try {
    const { configuration = {} } = (await store.get('configuration')) || {};
    // Normalized so an entry typed as a URL ("https://example.com/") still forms a valid match pattern.
    const customSites = (configuration.sites || [])
      .filter(s => s && s.isCustom && s.domain !== '*')
      .map(s => normalizeDomain(s.domain))
      .filter(d => /^[a-z0-9.-]+$/.test(d));
    const uniqueDomains = Array.from(new Set([...DEFAULT_SITE_DOMAINS, 'twitter.com', ...customSites]));
    const queryUrls = uniqueDomains.flatMap(d => [`*://${d}/*`, `*://*.${d}/*`]);
    const openTabs = await tabs.query({ url: queryUrls });
    for (const tab of openTabs) {
      if (!tab.id || !tab.url) continue;
      await injectContentScript(tab.id, { scripting }).catch(() => {});
    }
    console.info('[background] Programmatic content script auto-injection complete.');
  } catch (err) {
    console.warn('[background] Content script auto-injection failed:', err);
  }
}
