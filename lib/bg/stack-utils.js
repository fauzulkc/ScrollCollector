/**
 * stack-utils.js
 *
 * Pure helpers over the collected-items stack. Shared by the store (every stack commit re-derives
 * its counts here) and by the handlers / pipeline.
 *
 * Hidden items: an item that no longer matches the prompt is never deleted; it carries
 * `hiddenByPrompt: true` instead (see shouldHideByPrompt). Hidden items stay in the stack, are not
 * counted in metrics.counts (which counts what the feed shows) and still count as "using" their tag.
 */

/** Hard cap on stored items. Favourites are never evicted. */
export const MAX_STACK_ITEMS = 2000;

/** Pseudo-tag that counts sponsored items. Never offered to a classifier. */
export const ADS_TAG = 'Ads';

/** Label used when nothing matched. */
export const UNCLASSIFIED = 'Unclassified';

/**
 * Evicts the oldest non-favourite items once the stack exceeds MAX_STACK_ITEMS.
 *
 * @param {object[]} stack
 * @returns {object[]}
 */
export function pruneStack(stack) {
  if (!stack || stack.length <= MAX_STACK_ITEMS) {
    return stack || [];
  }
  const excess = stack.length - MAX_STACK_ITEMS;
  const nonFavorites = stack.filter(item => !item.isFavorite);
  if (nonFavorites.length === 0) {
    return stack;
  }
  const candidates = [...nonFavorites].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const toEvict = candidates.slice(0, excess);
  if (toEvict.length === 0) {
    return stack;
  }
  const evictSet = new Set(toEvict);
  const pruned = stack.filter(item => !evictSet.has(item));
  const droppedCount = stack.length - pruned.length;
  if (droppedCount > 0) {
    console.info(`[background] Pruned ${droppedCount} item(s) to stay within the ${MAX_STACK_ITEMS}-item cap (favourites exempt).`);
  }
  return pruned;
}

/**
 * Per-tag counts of the visible items (hidden-by-prompt items excluded), always derived from the
 * stack itself (never patched with +/-, which drifts).
 *
 * @param {object[]} stack
 * @returns {Record<string, number>}
 */
export function computeCounts(stack) {
  const counts = {};
  for (const item of stack || []) {
    if (!item || item.hiddenByPrompt) continue;
    const tag = item.assignedTag || UNCLASSIFIED;
    counts[tag] = (counts[tag] || 0) + 1;
    if (item.isAd) {
      counts[ADS_TAG] = (counts[ADS_TAG] || 0) + 1;
    }
  }
  return counts;
}

/**
 * @param {number} now
 * @returns {{ totalProcessed: number, classifiedCount: number, unclassifiedCount: number, sessionStart: number, lastProcessed: number|null }}
 */
export function emptyTelemetry(now = Date.now()) {
  return { totalProcessed: 0, classifiedCount: 0, unclassifiedCount: 0, sessionStart: now, lastProcessed: null };
}

/**
 * Telemetry after a re-decide pass: classified / unclassified recomputed from the stack;
 * totalProcessed (posts collected this session) is kept, or seeded from the stack size.
 *
 * @param {object[]} stack
 * @param {object} [previous]
 * @param {number} [now]
 */
export function telemetryFromStack(stack, previous, now = Date.now()) {
  let classifiedCount = 0;
  let unclassifiedCount = 0;
  for (const item of stack || []) {
    if (!item) continue;
    if ((item.assignedTag || UNCLASSIFIED) === UNCLASSIFIED) unclassifiedCount++;
    else classifiedCount++;
  }
  const prev = previous || {};
  return {
    ...emptyTelemetry(now),
    ...prev,
    totalProcessed: Number.isFinite(prev.totalProcessed) ? prev.totalProcessed : (stack || []).length,
    classifiedCount,
    unclassifiedCount,
    lastProcessed: now
  };
}

/**
 * True when the item carries a manual override: re-decides never change its tag or hide it.
 *
 * @param {object} item
 */
export function isManualItem(item) {
  return !!(item && ((item.matchInfo && item.matchInfo.manual) || (item.decision && item.decision.provider === 'manual')));
}

/**
 * The prompt gate filters only when it is switched on AND the prompt is non-empty.
 *
 * @param {object} configuration
 */
export function isPromptGateOn(configuration) {
  return !!(configuration && configuration.isMatchPromptEnabled && String(configuration.matchPrompt || '').trim());
}

/**
 * Whether an item is hidden by the prompt: the gate is on, the item's decision was made for the
 * CURRENT prompt version and says it does not match (collect === false, with a verdict — never an
 * 'error' path), and it is neither a favourite nor a manual override.
 *
 * @param {object} item
 * @param {object} configuration   fresh configuration
 */
export function shouldHideByPrompt(item, configuration) {
  if (!item || item.isFavorite || isManualItem(item) || !isPromptGateOn(configuration)) return false;
  const d = item.decision;
  if (!d || typeof d !== 'object' || d.collect !== false) return false;
  if (Array.isArray(d.path) && d.path.includes('error')) return false;
  const current = Number.isFinite(configuration.promptVersion) ? configuration.promptVersion : 0;
  const version = Number.isFinite(d.promptVersion) ? d.promptVersion : 0;
  return version === current;
}

/**
 * @param {object[]} stack
 * @returns {number} items with hiddenByPrompt set
 */
export function countHidden(stack) {
  let n = 0;
  for (const item of stack || []) if (item && item.hiddenByPrompt) n++;
  return n;
}

/**
 * Drops dynamic, non-sticky tags that no stored item (hidden ones included) uses as its tag.
 *
 * @param {Array<object|string>} trackedTags
 * @param {object[]} stack
 * @returns {Array<object|string>} the same array when nothing was pruned
 */
export function pruneEmptyDynamicTags(trackedTags, stack) {
  const list = Array.isArray(trackedTags) ? trackedTags : [];
  const used = new Set();
  for (const item of stack || []) if (item && item.assignedTag) used.add(item.assignedTag);
  const next = list.filter(t => !(t && typeof t === 'object' && t.isDynamic && !t.isSticky && !used.has(t.label)));
  return next.length === list.length ? list : next;
}
