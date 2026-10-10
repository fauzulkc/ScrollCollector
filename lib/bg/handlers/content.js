/**
 * Content-script facing handlers.
 *
 * storage.local is restricted to trusted contexts, so content scripts get their configuration by
 * message (GET_CONTENT_CONFIG) and are pushed CONTENT_CONFIG_UPDATED whenever the content-relevant
 * part of the stored configuration changes (sites, pause, ignored domains, debug annotations).
 */

import { MSG } from '../../messages.js';

/**
 * @param {object} configuration
 * @returns {{ isTrackingPaused: boolean, sites: object[], ignoredDomains: string[], debugAnnotate: boolean }}
 */
export function contentConfigOf(configuration) {
  const cfg = configuration || {};
  return {
    isTrackingPaused: !!cfg.isTrackingPaused,
    sites: Array.isArray(cfg.sites) ? cfg.sites : [],
    ignoredDomains: Array.isArray(cfg.ignoredDomains) ? cfg.ignoredDomains : [],
    debugAnnotate: !!(cfg.intelligence && cfg.intelligence.debugAnnotate)
  };
}

/**
 * chrome.storage.onChanged listener that pushes CONTENT_CONFIG_UPDATED to every tab when needed.
 *
 * @param {{ broadcastToAllTabs: (message: object) => unknown }} broadcast
 * @returns {(changes: Record<string, { oldValue?: any, newValue?: any }>, areaName: string) => boolean}
 */
export function createContentConfigWatcher(broadcast) {
  return function onStorageChanged(changes, areaName) {
    if (areaName !== 'local' || !changes || !changes.configuration) return false;
    const before = contentConfigOf(changes.configuration.oldValue);
    const after = contentConfigOf(changes.configuration.newValue);
    if (JSON.stringify(before) === JSON.stringify(after)) return false;
    broadcast.broadcastToAllTabs({ type: MSG.CONTENT_CONFIG_UPDATED, payload: after });
    return true;
  };
}

/**
 * @param {import('./common.js').HandlerDeps} deps
 * @returns {import('./common.js').HandlerMap}
 */
export function createContentHandlers(deps) {
  const { store, ingest } = deps;

  return {
    /** -> { success, status: 'queued'|'ignored', postKey, reason? }; the verdict follows as DECISION_RESULT. */
    async [MSG.TEXT_EXTRACTED](payload, sender) {
      const result = await ingest.enqueue(payload, sender);
      return { success: true, ...result };
    },

    async [MSG.GET_CONTENT_CONFIG]() {
      const { configuration } = (await store.get('configuration')) || {};
      return { success: true, ...contentConfigOf(configuration) };
    }
  };
}
