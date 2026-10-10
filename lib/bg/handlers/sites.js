/**
 * Scanned-site handlers. Content scripts learn about changes through CONTENT_CONFIG_UPDATED
 * (see ./content.js), pushed whenever the stored configuration's content-relevant part changes.
 */

import { MSG } from '../../messages.js';
import { commitConfig, lower, requireString } from './common.js';

/**
 * @param {import('./common.js').HandlerDeps} deps
 * @returns {import('./common.js').HandlerMap}
 */
export function createSiteHandlers(deps) {
  const { uuid } = deps;

  /** @param {object} cfg */
  const sitesOf = (cfg) => (Array.isArray(cfg.sites) ? cfg.sites : []);

  return {
    async [MSG.SITE_TOGGLED]({ siteId, enabled }) {
      await commitConfig(deps, (cfg) => ({
        ...cfg,
        sites: sitesOf(cfg).map(s => (s.id === siteId ? { ...s, isEnabled: !!enabled } : s))
      }));
      return { success: true };
    },

    async [MSG.SITE_ADDED]({ domain }) {
      const value = lower(requireString(domain, 'domain').trim());
      let exists = false;
      await commitConfig(deps, (cfg) => {
        exists = sitesOf(cfg).some(s => lower(s.domain) === value);
        if (exists) return null;
        return { ...cfg, sites: [...sitesOf(cfg), { id: `s_${uuid()}`, domain: value, isEnabled: true, isCustom: true }] };
      });
      return exists ? { success: false, error: 'Site already exists' } : { success: true };
    },

    async [MSG.SITE_REMOVED]({ siteId }) {
      await commitConfig(deps, (cfg) => ({ ...cfg, sites: sitesOf(cfg).filter(s => s.id !== siteId) }));
      return { success: true };
    }
  };
}
