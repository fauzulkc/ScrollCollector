/**
 * defaults.js
 *
 * Default state and the idempotent startup upgrade that used to live in ensureInitialized() and the
 * onInstalled handler. Runs on every service-worker start (cheap after the first run), before the
 * schema migration in lib/storage/migrations.js.
 */

import { emptyTelemetry, ADS_TAG } from './stack-utils.js';
import { toTagStrings } from '../pipeline/normalize.js';

/**
 * Kept free of heavy imports (no inference engine) so other modules can import defaultPrompts;
 * the author migration is injected (lib/pipeline/authors.js migrateCanonicalAuthors).
 *
 * @typedef {(stack: object[]) => boolean} AuthorMigration
 */

/** Tag descriptions; also the label descriptions used by the decision layer. */
export const defaultPrompts = Object.freeze({
  'Health': 'Identify posts related to health, medicine, doctors, hospitals, fitness, wellness, or nutrition.',
  'Jobs': 'Identify posts related to job postings, career opportunities, hiring, recruitment, resumes, or interviews.',
  'Politics': 'Identify posts related to government, elections, political parties, public policy, or legislation.',
  'Tech/AI': 'Identify posts related to software, technology, programming, developer tools, artificial intelligence, or machine learning.',
  'Weather': 'Identify posts related to weather forecasts, storms, climate, temperatures, sunny, rain, or snow.',
  'Ad': 'Identify advertisements, sponsored content, products for sale, or promotional codes.',
  'News': 'Identify breaking news updates, media reports, journalism, headlines, or press coverage.',
  'Entertainment': 'Identify posts related to movies, television, music, concerts, gaming, or celebrity culture.',
  'Promotion': 'Identify giveaways, special offers, discounts, brand campaigns, or sales promotions.',
  'Personal Opinion': 'Identify personal viewpoints, personal updates, opinions, thoughts, or editorial reflections.',
  'Portfolio': 'Identify project showcases, personal portfolios, designs, case studies, or displays of professional work.',
  'Product Showcase': 'Identify product launches, demonstrations, features, release highlights, or new tools.',
  'Immigration': 'Identify posts related to immigration processes, visas, passports, citizenship, or green cards.',
  'Migration': 'Identify posts related to relocation, moving to another region or country, expats, or emigration.',
  'Study': 'Identify posts related to academic studies, university, learning resources, college courses, or scholarships.',
  'International News': 'Identify news about international events, global affairs, foreign relations, or world news.',
  'Sports': 'Identify posts related to athletic sports, games, leagues, matches, players, championships, or coaches.',
  'Events': 'Identify posts related to upcoming events, conferences, webinars, meetups, festivals, or workshops.',
  'Blog': 'Identify references to blog articles, long-form posts, reading materials, or updates for written sites.',
  'Vlog': 'Identify video logs, YouTube clips, vlog updates, or video content updates.',
  'Culture': 'Identify posts related to cultural heritage, traditions, societal customs, art, or historical celebrations.',
  'NGO': 'Identify posts related to non-governmental organizations, charities, volunteering, non-profits, or donations.',
  'Policy': 'Identify posts related to policy changes, company guidelines, compliance rules, or regulatory frameworks.',
  'Release': 'Identify software releases, product versions, changelogs, updates, or patch notes.',
  'History': 'Identify posts related to historical events, ancient civilizations, timelines, archives, or heritage.'
});

/** Default tag order (ids t1..t25 are kept stable for existing installs). */
export const DEFAULT_TAG_LABELS = Object.freeze([
  'Health', 'Jobs', 'Politics', 'Tech/AI', 'Weather', 'Ad', 'News', 'Entertainment', 'Promotion',
  'Personal Opinion', 'Portfolio', 'Product Showcase', 'Immigration', 'Migration', 'Study',
  'International News', 'Sports', 'Events', 'Blog', 'Vlog', 'Culture', 'NGO', 'Policy', 'Release', 'History'
]);

/** @returns {object[]} */
export function defaultTrackedTags() {
  return DEFAULT_TAG_LABELS.map((label, i) => ({
    id: `t${i + 1}`,
    label,
    isEnabled: true,
    prompt: defaultPrompts[label]
  }));
}

/** @returns {object[]} */
export function defaultSites() {
  return [
    { id: 's_all', domain: '*', isEnabled: false, isCustom: false },
    { id: 's1', domain: 'facebook.com', isEnabled: true, isCustom: false },
    { id: 's2', domain: 'linkedin.com', isEnabled: true, isCustom: false },
    { id: 's4', domain: 'x.com', isEnabled: true, isCustom: false },
    { id: 's5', domain: 'instagram.com', isEnabled: true, isCustom: false },
    { id: 's6', domain: 'youtube.com', isEnabled: true, isCustom: false },
    { id: 's7', domain: 'medium.com', isEnabled: true, isCustom: false },
    { id: 's8', domain: 'github.com', isEnabled: true, isCustom: false },
    { id: 's9', domain: 'news.ycombinator.com', isEnabled: true, isCustom: false }
  ];
}

/** @returns {object} */
export function defaultConfiguration() {
  return {
    trackedTags: defaultTrackedTags(),
    sites: defaultSites(),
    ignoredKeywords: [],
    ignoredTags: [],
    ignoredLinks: [],
    ignoredDomains: [],
    isTrackingPaused: false,
    trackingPausedAt: null,
    matchPrompt: '',
    matchPromptEnhanced: '',
    matchPromptExpansion: '',
    matchPromptTags: [],
    isMatchPromptEnabled: false,
    matchPromptUserDisabled: false,
    promptVersion: 0
  };
}

/**
 * @param {number} [now]
 * @returns {{ configuration: object, metrics: object, stack: object[], telemetry: object }}
 */
export function createDefaultState(now = Date.now()) {
  return {
    configuration: defaultConfiguration(),
    metrics: { counts: {} },
    stack: [],
    telemetry: emptyTelemetry(now)
  };
}

/**
 * Seeds missing state and applies the legacy upgrades (sites list, Ads pseudo-tag, ignore lists,
 * prompt fields, favourites, canonical authors). Idempotent. Mutates and returns `state`.
 *
 * Unlike the old ensureInitialized(), an empty tag list re-seeds only the tags — it never wipes the
 * collected stack.
 *
 * @param {object} state  full storage snapshot
 * @param {number} [now]
 * @param {{ migrateAuthors?: AuthorMigration }} [options]
 * @returns {{ state: object, changedKeys: Set<string> }}
 */
export function seedAndUpgrade(state, now = Date.now(), { migrateAuthors } = {}) {
  const changedKeys = new Set();
  const mark = (key) => changedKeys.add(key);

  if (!state.configuration || typeof state.configuration !== 'object') {
    state.configuration = defaultConfiguration();
    mark('configuration');
    console.info('[background] Default state initialized.');
  }
  const config = state.configuration;

  if (!Array.isArray(config.trackedTags) || config.trackedTags.length === 0) {
    config.trackedTags = defaultTrackedTags();
    mark('configuration');
  }

  // Every tag carries a description prompt.
  for (const tag of config.trackedTags) {
    if (tag && (tag.prompt === undefined || tag.prompt === null) && tag.label !== ADS_TAG) {
      tag.prompt = defaultPrompts[tag.label] || `Identify posts related to ${tag.label}.`;
      mark('configuration');
    }
  }

  // Sites list (incl. the '*' entry, twitter.com -> x.com, GitHub and HN).
  if (!Array.isArray(config.sites)) {
    config.sites = defaultSites();
    mark('configuration');
  } else {
    if (!config.sites.some(s => s.domain === '*')) {
      config.sites.unshift({ id: 's_all', domain: '*', isEnabled: false, isCustom: false });
      mark('configuration');
    }
    if (config.sites.some(s => s.domain === 'twitter.com')) {
      config.sites = config.sites.filter(s => s.domain !== 'twitter.com');
      if (!config.sites.some(s => s.domain === 'x.com')) {
        config.sites.push({ id: 's4', domain: 'x.com', isEnabled: true, isCustom: false });
      }
      mark('configuration');
    }
    if (!config.sites.some(s => s.domain === 'github.com')) {
      config.sites.push({ id: 's8', domain: 'github.com', isEnabled: true, isCustom: false });
      mark('configuration');
    }
    if (!config.sites.some(s => s.domain === 'news.ycombinator.com')) {
      config.sites.push({ id: 's9', domain: 'news.ycombinator.com', isEnabled: true, isCustom: false });
      mark('configuration');
    }
  }

  // The 'Ads' pseudo-tag (filter pill for sponsored items; never a classification target).
  if (!config.trackedTags.some(t => t && t.label === ADS_TAG)) {
    config.trackedTags.push({ id: 't_ads', label: ADS_TAG, isEnabled: true });
    mark('configuration');
  }

  for (const key of ['ignoredKeywords', 'ignoredTags', 'ignoredLinks', 'ignoredDomains']) {
    if (!Array.isArray(config[key])) {
      config[key] = [];
      mark('configuration');
    }
  }

  if (typeof config.isTrackingPaused !== 'boolean') {
    config.isTrackingPaused = !!config.isTrackingPaused;
    mark('configuration');
  }
  if (config.trackingPausedAt === undefined) {
    config.trackingPausedAt = null;
    mark('configuration');
  }

  if (config.isMatchPromptEnabled === undefined) {
    config.isMatchPromptEnabled = false;
    config.matchPrompt = config.matchPrompt || '';
    config.matchPromptTags = [];
    config.matchPromptEnhanced = '';
    mark('configuration');
  }
  if (typeof config.matchPrompt !== 'string') {
    config.matchPrompt = '';
    mark('configuration');
  }
  if (typeof config.matchPromptEnhanced !== 'string') {
    config.matchPromptEnhanced = '';
    mark('configuration');
  }
  // v0.9 stored {name, weight} objects; the gate now takes plain strings.
  if (!Array.isArray(config.matchPromptTags) || config.matchPromptTags.some(t => typeof t !== 'string')) {
    config.matchPromptTags = toTagStrings(config.matchPromptTags);
    mark('configuration');
  }
  if (!Number.isFinite(config.promptVersion)) {
    config.promptVersion = 0;
    mark('configuration');
  }
  if (typeof config.matchPromptUserDisabled !== 'boolean') {
    config.matchPromptUserDisabled = false;
    mark('configuration');
  }

  if (!state.metrics || typeof state.metrics !== 'object' || !state.metrics.counts) {
    state.metrics = { ...(state.metrics || {}), counts: {} };
    mark('metrics');
  }
  if (!state.telemetry || typeof state.telemetry !== 'object') {
    state.telemetry = emptyTelemetry(now);
    mark('telemetry');
  }

  if (!Array.isArray(state.stack)) {
    state.stack = [];
    mark('stack');
  } else {
    // isPinned -> isFavorite
    for (const item of state.stack) {
      if (item && item.isPinned !== undefined) {
        item.isFavorite = item.isPinned;
        item.favoritedAt = item.isPinned ? (item.favoritedAt || item.timestamp) : null;
        delete item.isPinned;
        mark('stack');
      }
    }
    if (typeof migrateAuthors === 'function' && migrateAuthors(state.stack)) mark('stack');
  }

  return { state, changedKeys };
}

/**
 * Startup initialisation: seed + legacy upgrades + schema migration, committed atomically.
 *
 * @param {{
 *   store: ReturnType<import('./store.js').createStore>,
 *   migrateState?: (s: object) => { state: object, changed: boolean },
 *   migrateAuthors?: AuthorMigration,
 *   now?: () => number
 * }} deps
 */
export async function initializeState({ store, migrateState, migrateAuthors, now = Date.now }) {
  await store.mutate(null, (fresh) => {
    const { state, changedKeys } = seedAndUpgrade(fresh, now(), { migrateAuthors });
    let result = state;
    let migrated = false;
    if (typeof migrateState === 'function') {
      try {
        const out = migrateState(state);
        if (out && out.state) {
          result = out.state;
          migrated = !!out.changed;
        }
      } catch (err) {
        console.error('[background] State migration failed; continuing with the un-migrated state:', err);
      }
    }
    if (migrated) {
      // The migration may touch any key; write the whole migrated snapshot once.
      return { ...result };
    }
    if (changedKeys.size === 0) return null;
    const patch = {};
    for (const key of changedKeys) patch[key] = result[key];
    return patch;
  });
}
