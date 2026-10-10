/**
 * Storage migrations to schema v2. Pure and idempotent: migrateState() never mutates its input,
 * checks every field instead of trusting `schemaVersion` (so it is safe to run on every service
 * worker start, before or after the default seeding) and a second run reports `changed: false`.
 *
 * v1 -> v2:
 *  - configuration.intelligence holds only the user's explicit choices: defaults are NOT copied in
 *    (resolveIntelligence() fills them on read, so a later release can still change a default);
 *    a non-object value, or an untouched copy of the defaults an earlier build of this migration
 *    wrote, is removed
 *  - configuration.promptVersion (default 0)
 *  - configuration.matchPromptTags: v0.9 {name, weight} objects -> strings
 *  - the 'Ads' tracked tag is a pseudo-tag (filter pill, never a classification target)
 *  - stack: unique item ids, postKey from real permalinks only, `legacy` on items decided by the
 *    old pipeline, `suspectMerged` on items the old append bug glued together
 */
import { SCHEMA_VERSION, isPlainObject, cloneData } from './schema.js';

const ADS_TAG = 'Ads';
/**
 * configuration.intelligence exactly as the first build of this migration wrote it: a copy of the
 * defaults of the time, placeholder floors included. Equal means never edited, so it is dropped
 * and the current defaults (and the calibrated floors) apply.
 */
const SEEDED_V2_INTELLIGENCE = Object.freeze({
  system1: { enabled: true, model: 'bge-small', device: 'wasm', dtype: 'q8', waitForReadyMs: 180000 },
  escalation: {
    provider: 'nano',
    floor: { matches_prompt: 0.5, primary_tag: 0.35 },
    perMinute: 30,
    perDay: 1000,
    sendAuthor: false,
    allowRedecideEscalation: false
  },
  providers: {
    nano: { enabled: true },
    jev: { enabled: false, baseUrl: 'https://api.typesafe.ai', model: 'jev-latest', timeoutMs: 8000 },
    openai: { enabled: false, baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-luna', api: 'chat', reasoningEffort: 'none', timeoutMs: 15000 }
  },
  gate: { strictness: 'balanced', whenUnsure: 'collect' },
  dynamicTags: false,
  debugAnnotate: false
});
/** Items longer than this were produced by the old "append into the existing item" bug. */
const SUSPECT_TEXT_CHARS = 2000;
const COMPANY_POSTS_RE = /\/company\/[^/?#]+\/posts\/?(?:[?#].*)?$/i;

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return Number.isNaN(a) && Number.isNaN(b);
}

/**
 * v0.9 stored prompt tags as {name, weight}; now plain, trimmed, de-duplicated strings.
 * @param {unknown} list
 * @returns {string[]}
 */
export function toTagStringList(list) {
  const out = [];
  const seen = new Set();
  for (const t of Array.isArray(list) ? list : []) {
    const raw = typeof t === 'string' ? t : t && typeof t === 'object' ? (t.name ?? t.label ?? t.tag) : '';
    const label = typeof raw === 'string' ? raw.trim() : '';
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    out.push(label);
  }
  return out;
}

/** `${origin}${path without trailing slashes}${search}`, matching lib/pipeline/normalize.js canonicalUrl(). */
function canonicalUrl(u) {
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}${u.search}`;
}

/**
 * True for URLs that certainly identify ONE post: LinkedIn /feed/update/urn:li:…, X/Twitter
 * /status/<id>, YouTube watch?v= / shorts / youtu.be, HN item?id=.
 * Company pages, profiles and feeds are rejected.
 *
 * @param {unknown} url
 * @returns {URL|null}
 */
export function parsePermalink(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^(?:www\.|m\.|mobile\.)/, '');
  let path = u.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    /* keep the raw path */
  }
  if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) {
    return /^\/feed\/update\/urn:li:(?:activity|share|ugcPost):\d+/i.test(path) ? u : null;
  }
  if (host === 'x.com' || host === 'twitter.com') {
    return /^\/[^/]+\/status(?:es)?\/\d+/.test(path) ? u : null;
  }
  if (host === 'youtube.com' || host === 'music.youtube.com') {
    if (path === '/watch' && /^[\w-]{6,}$/.test(u.searchParams.get('v') || '')) return u;
    return /^\/shorts\/[\w-]{6,}/.test(path) ? u : null;
  }
  if (host === 'youtu.be') return /^\/[\w-]{6,}/.test(path) ? u : null;
  if (host === 'news.ycombinator.com') {
    return path === '/item' && /^\d+$/.test(u.searchParams.get('id') || '') ? u : null;
  }
  return null;
}

/**
 * postKey for a legacy item, or null when its sourceUrl is not a real permalink.
 * Same `url:<canonical>` shape as the ingest pipeline's derivePostIdentity().
 * @param {unknown} url
 * @returns {string|null}
 */
export function postKeyFromUrl(url) {
  const u = parsePermalink(url);
  return u ? `url:${canonicalUrl(u)}` : null;
}

/**
 * @param {Record<string, any>} cfg  mutated in place (it is already a private clone)
 * @returns {boolean} changed
 */
function migrateConfiguration(cfg) {
  let changed = false;

  if ((cfg.intelligence !== undefined && !isPlainObject(cfg.intelligence)) || deepEqual(cfg.intelligence, SEEDED_V2_INTELLIGENCE)) {
    delete cfg.intelligence;
    changed = true;
  }

  if (!Number.isFinite(cfg.promptVersion)) {
    cfg.promptVersion = 0;
    changed = true;
  }

  if (cfg.matchPromptTags !== undefined) {
    const tags = toTagStringList(cfg.matchPromptTags);
    if (!deepEqual(tags, cfg.matchPromptTags)) {
      cfg.matchPromptTags = tags;
      changed = true;
    }
  }

  if (Array.isArray(cfg.trackedTags)) {
    for (const tag of cfg.trackedTags) {
      if (isPlainObject(tag) && tag.label === ADS_TAG && tag.isPseudo !== true) {
        tag.isPseudo = true;
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * @param {any[]} stack  mutated in place (already a private clone)
 * @returns {boolean} changed
 */
function migrateStack(stack) {
  let changed = false;
  const allIds = new Set(stack.map((item) => (isPlainObject(item) && typeof item.id === 'string' ? item.id : null)).filter(Boolean));
  const used = new Set();

  stack.forEach((item, index) => {
    if (!isPlainObject(item)) return;

    // Unique ids: the first occurrence keeps its id, later duplicates get a deterministic suffix.
    let id = typeof item.id === 'string' && item.id ? item.id : null;
    if (!id || used.has(id)) {
      const base = id || `item_legacy_${index}`;
      let n = 1;
      let candidate = id ? `${base}_${++n}` : base;
      while (used.has(candidate) || allIds.has(candidate)) candidate = `${base}_${++n}`;
      id = candidate;
      item.id = id;
      changed = true;
    }
    used.add(id);

    if (!item.postKey) {
      const key = postKeyFromUrl(item.sourceUrl);
      if (key) {
        item.postKey = key;
        changed = true;
      }
    }

    if (!item.decision && item.legacy !== true) {
      item.legacy = true;
      changed = true;
    }

    const suspect =
      (typeof item.textSnippet === 'string' && item.textSnippet.length > SUSPECT_TEXT_CHARS) ||
      (typeof item.sourceUrl === 'string' && COMPANY_POSTS_RE.test(item.sourceUrl));
    if (suspect && item.suspectMerged !== true) {
      item.suspectMerged = true;
      changed = true;
    }
  });
  return changed;
}

/**
 * Migrates a full chrome.storage.local snapshot to schema v2.
 *
 * @param {Record<string, any>} input
 * @returns {{ state: Record<string, any>, changed: boolean }}
 */
export function migrateState(input) {
  const state = isPlainObject(input) ? cloneData(input) : {};
  // A newer schema written by a newer build: leave it alone.
  if (Number.isFinite(state.schemaVersion) && state.schemaVersion > SCHEMA_VERSION) {
    return { state, changed: false };
  }
  let changed = false;
  if (isPlainObject(state.configuration)) changed = migrateConfiguration(state.configuration) || changed;
  if (Array.isArray(state.stack)) changed = migrateStack(state.stack) || changed;
  if (state.schemaVersion !== SCHEMA_VERSION) {
    state.schemaVersion = SCHEMA_VERSION;
    changed = true;
  }
  return { state, changed };
}
