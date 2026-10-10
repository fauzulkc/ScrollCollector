/**
 * Ignore-list handlers (keywords, tags, domains, links).
 * Keywords are stored as typed; ingest matches them normalised and on word boundaries.
 */

import { MSG } from '../../messages.js';
import { commitConfig, lower, requireString } from './common.js';

/**
 * @param {import('./common.js').HandlerDeps} deps
 * @param {string} key                       configuration list key
 * @param {(a: string, b: string) => boolean} same
 * @param {string} duplicateError
 */
function listHandlers(deps, key, same, duplicateError) {
  return {
    async add(value) {
      let exists = false;
      await commitConfig(deps, (cfg) => {
        const list = Array.isArray(cfg[key]) ? cfg[key] : [];
        exists = list.some(v => same(v, value));
        if (exists) return null;
        return { ...cfg, [key]: [...list, value] };
      });
      return exists ? { success: false, error: duplicateError } : { success: true };
    },
    async remove(value, matches = same) {
      await commitConfig(deps, (cfg) => {
        const list = Array.isArray(cfg[key]) ? cfg[key] : [];
        const filtered = list.filter(v => !matches(v, value));
        return filtered.length === list.length ? null : { ...cfg, [key]: filtered };
      });
      return { success: true };
    }
  };
}

/**
 * @param {import('./common.js').HandlerDeps} deps
 * @returns {import('./common.js').HandlerMap}
 */
export function createIgnoreHandlers(deps) {
  const caseless = (a, b) => lower(a) === lower(b);
  const exact = (a, b) => a === b;

  const keywords = listHandlers(deps, 'ignoredKeywords', caseless, 'Keyword already exists');
  const tags = listHandlers(deps, 'ignoredTags', caseless, 'Tag already ignored');
  const domains = listHandlers(deps, 'ignoredDomains', caseless, 'Domain already ignored');
  const links = listHandlers(deps, 'ignoredLinks', exact, 'Link already ignored');

  return {
    [MSG.KEYWORD_ADDED]: ({ keyword }) => keywords.add(requireString(keyword, 'keyword')),
    [MSG.KEYWORD_REMOVED]: ({ keyword }) => keywords.remove(keyword, exact),
    [MSG.IGNORE_TAG_ADDED]: ({ tag }) => tags.add(requireString(tag, 'tag')),
    [MSG.IGNORE_TAG_REMOVED]: ({ tag }) => tags.remove(tag),
    [MSG.IGNORE_DOMAIN_ADDED]: ({ domain }) => domains.add(requireString(domain, 'domain')),
    [MSG.IGNORE_DOMAIN_REMOVED]: ({ domain }) => domains.remove(domain),
    [MSG.IGNORE_LINK_ADDED]: ({ url }) => links.add(requireString(url, 'url')),
    [MSG.IGNORE_LINK_REMOVED]: ({ url }) => links.remove(url)
  };
}
