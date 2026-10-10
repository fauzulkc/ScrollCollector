/**
 * retry.js
 *
 * Second-pass tagging for Unclassified items (the 'idleRetry' alarm). Up to `batchSize` items are
 * re-decided OUTSIDE the state lock; results are committed through mutateStack matched by item id,
 * so a stale stack snapshot is never written back.
 *
 * Each item is retried at most `maxAttempts` times. The counts live in storage.session, not in
 * memory: the service worker idles out between the 1-minute alarms, and an in-memory count would
 * restart at zero every time (the same newest items retried forever, older ones never). Items with
 * the fewest attempts go first, so every Unclassified item gets its turn. The counts reset when the
 * tag set changes (a new tag can fit an old post) and with the browser session.
 */

import {
  decideContext,
  decisionFingerprint,
  sanitizeDecision,
  persistedDecision,
  buildMatchInfo,
  resolveDynamicTag,
  classifiableTags
} from './apply-decision.js';
import { UNCLASSIFIED } from '../bg/stack-utils.js';
import { textHash } from '../decision/state.js';

/** storage.session key: { sig, counts: { [itemId]: attempts } }. */
export const RETRY_ATTEMPTS_KEY = 'retryAttempts';

/**
 * What a retry's answer depends on besides the post: the classifiable tags and dynamic tags.
 *
 * @param {object} configuration
 * @returns {string}
 */
export function retrySignature(configuration) {
  const cfg = configuration || {};
  const tags = classifiableTags(cfg.trackedTags).map(t => [t.label, t.prompt || '']);
  return textHash(JSON.stringify([tags, !!(cfg.intelligence && cfg.intelligence.dynamicTags === true)]));
}

/**
 * @param {object} deps
 * @param {ReturnType<import('../bg/store.js').createStore>} deps.store
 * @param {import('../decision/types.js').DecideMany} deps.decideMany
 * @param {{ scheduleBroadcast: () => unknown }} deps.broadcast
 * @param {() => boolean} [deps.isBusy]       skip the pass while ingestion is in flight
 * @param {() => number} [deps.now]
 * @param {() => string} [deps.uuid]
 * @param {number} [deps.batchSize]
 * @param {number} [deps.maxAttempts]
 * @param {chrome.storage.StorageArea|null} [deps.session]  where attempt counts survive worker restarts
 */
export function createIdleRetry({
  store,
  decideMany,
  broadcast,
  isBusy = () => false,
  now = Date.now,
  uuid = () => crypto.randomUUID(),
  batchSize = 5,
  maxAttempts = 3,
  session = globalThis.chrome?.storage?.session ?? null
}) {
  /** Used when storage.session is unavailable (or fails): this worker's lifetime only. */
  let memory = { sig: '', counts: {} };
  let running = false;

  /** @returns {Promise<{ sig: string, counts: Record<string, number> }>} */
  async function loadAttempts() {
    if (!session) return memory;
    try {
      const stored = await session.get(RETRY_ATTEMPTS_KEY);
      const rec = stored && stored[RETRY_ATTEMPTS_KEY];
      if (rec && typeof rec === 'object' && rec.counts && typeof rec.counts === 'object') {
        return { sig: String(rec.sig || ''), counts: { ...rec.counts } };
      }
      return { sig: '', counts: {} };
    } catch (err) {
      console.warn('[background] could not read the retry attempts:', err);
      return memory;
    }
  }

  /** @param {{ sig: string, counts: Record<string, number> }} rec */
  async function saveAttempts(rec) {
    memory = rec;
    if (!session) return;
    try {
      await session.set({ [RETRY_ATTEMPTS_KEY]: rec });
    } catch (err) {
      console.warn('[background] could not record the retry attempts:', err);
    }
  }

  /**
   * @returns {Promise<{ tried: number, updated: number }>}
   */
  async function run() {
    if (running || isBusy()) return { tried: 0, updated: 0 };
    running = true;
    try {
      const { configuration = {}, stack = [] } = (await store.get(['configuration', 'stack'])) || {};
      const sig = retrySignature(configuration);
      const saved = await loadAttempts();
      const counts = saved.sig === sig ? saved.counts : {};
      const attemptsOf = item => (Number.isFinite(counts[item.id]) ? counts[item.id] : 0);

      const eligible = (Array.isArray(stack) ? stack : [])
        .filter(item => item && item.id && item.textSnippet
          && (item.assignedTag || UNCLASSIFIED) === UNCLASSIFIED
          && !(item.matchInfo && item.matchInfo.manual));
      const candidates = eligible
        .filter(item => attemptsOf(item) < maxAttempts)
        .sort((a, b) => attemptsOf(a) - attemptsOf(b))
        .slice(0, batchSize);
      if (candidates.length === 0) return { tried: 0, updated: 0 };

      console.info(`[background] 2nd pass evaluation: processing ${candidates.length} items`);
      // Counted before deciding, so a worker killed mid-pass still uses up the attempt. Only ids
      // still eligible are kept, so the record stays as small as the Unclassified part of the stack.
      const nextCounts = {};
      for (const item of eligible) if (attemptsOf(item) > 0) nextCounts[item.id] = attemptsOf(item);
      for (const item of candidates) nextCounts[item.id] = attemptsOf(item) + 1;
      await saveAttempts({ sig, counts: nextCounts });

      const ctx = decideContext(configuration, 'retry');
      const inputs = candidates.map(item => ({ id: item.id, text: item.textSnippet, platform: item.sourcePlatform || '', author: item.authorName || undefined }));
      let decisions;
      try {
        const out = await decideMany(inputs, ctx);
        decisions = inputs.map((_, i) => sanitizeDecision(Array.isArray(out) ? out[i] : null, ctx, now()));
      } catch (err) {
        console.warn('[background] Retry classification failed:', err);
        return { tried: inputs.length, updated: 0 };
      }

      const byId = new Map(inputs.map((input, i) => [input.id, { text: input.text, d: decisions[i] }]));
      const fingerprint = decisionFingerprint(configuration);
      let updated = 0;
      await store.mutateStack((fresh, state) => {
        const config = state.configuration || {};
        // The tags, prompt or model changed while deciding: these answers are for the old ones (a
        // removed tag must not be assigned). The next pass retries with the new configuration.
        if (decisionFingerprint(config) !== fingerprint) return null;
        let trackedTags = Array.isArray(config.trackedTags) ? config.trackedTags : [];
        let tagsChanged = false;
        const telemetry = state.telemetry ? { ...state.telemetry } : null;
        const next = fresh.map(item => {
          const hit = item && byId.get(item.id);
          // Only still-Unclassified, unchanged, non-manual items are touched.
          if (!hit || item.textSnippet !== hit.text || (item.matchInfo && item.matchInfo.manual)
            || (item.assignedTag || UNCLASSIFIED) !== UNCLASSIFIED) return item;
          const { tag, newTag } = resolveDynamicTag(trackedTags, hit.d, config, false, () => `dt_${uuid()}`);
          if (tag === UNCLASSIFIED) return item;
          if (newTag) {
            trackedTags = [...trackedTags, newTag];
            tagsChanged = true;
          }
          updated++;
          if (telemetry) {
            telemetry.unclassifiedCount = Math.max(0, (telemetry.unclassifiedCount || 0) - 1);
            telemetry.classifiedCount = (telemetry.classifiedCount || 0) + 1;
          }
          return {
            ...item,
            assignedTag: tag,
            tags: hit.d.tags.length > 0 ? hit.d.tags : [{ name: tag, score: 1 }],
            decision: persistedDecision({ ...hit.d, tag }),
            matchInfo: { ...(item.matchInfo || {}), ...buildMatchInfo(hit.d, config, false) }
          };
        });
        if (updated === 0) return null;
        const commit = { stack: next };
        if (telemetry) commit.telemetry = telemetry;
        if (tagsChanged) commit.configuration = { ...config, trackedTags };
        return commit;
      });
      if (updated > 0) broadcast.scheduleBroadcast();
      return { tried: inputs.length, updated };
    } finally {
      running = false;
    }
  }

  return { run };
}
