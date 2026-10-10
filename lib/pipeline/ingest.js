/**
 * ingest.js
 *
 * TEXT_EXTRACTED pipeline: cheap guards -> in-memory queue (mirrored to storage.session) -> batched
 * decisions OUTSIDE the state lock -> one mutateStack commit per batch against FRESH state.
 *
 * Invariants:
 *  - items are keyed by postKey; text is REPLACED (on isUpdate or when the new text is longer) and
 *    never appended, so two posts can no longer be glued into one item;
 *  - a NEW post with collect === false is never stored (the tab is told why); a stored post is never
 *    deleted: a re-send whose new text the prompt rejects keeps the item with hiddenByPrompt set,
 *    and one that matches again is un-hidden;
 *  - config changes committed while a batch is being decided survive (the commit re-reads state);
 *  - a batch is committed only for the configuration it was decided with (decisionFingerprint:
 *    gate, prompt, tags, System 1 model / gate policy). When one of those changed while the batch
 *    was being decided, its posts go back to the front of the queue and are decided again: the
 *    re-decide job that the change started took its snapshot before they were stored, so a stale
 *    verdict committed now would never be corrected (and a re-send would only hit the duplicate
 *    shortcut);
 *  - metrics.counts is derived from the stack by the store, never patched with +/-.
 */

import { MSG } from '../messages.js';
import { UNCLASSIFIED, emptyTelemetry, isManualItem, shouldHideByPrompt } from '../bg/stack-utils.js';
import {
  MAX_TEXT_LEN,
  stripMoreMarker,
  normalizePlatform,
  derivePostIdentity,
  findIgnoredKeyword,
  domainMatches,
  canonicalUrl,
  isRealPermalink
} from './normalize.js';
import {
  decideContext,
  decisionFingerprint,
  sanitizeDecision,
  fallbackDecision,
  persistedDecision,
  buildMatchInfo,
  resolveDynamicTag,
  rejectionReason
} from './apply-decision.js';
import { createAuthorCanonicalizer } from './authors.js';

/** storage.session key mirroring queued (not yet committed) posts. */
export const PENDING_QUEUE_KEY = 'pendingQueue';
/** storage.session key holding the most recent rejections (diagnostics). */
export const REJECTED_LOG_KEY = 'rejectedLog';
/**
 * How often a post is decided again because the configuration changed while it was being decided.
 * Configuration changes are user actions, so this is never reached in practice; it only guarantees
 * that the queue keeps moving if some writer changed the configuration on every batch.
 */
export const MAX_STALE_REDECIDES = 20;

/**
 * @typedef {object} IngestEntry
 * @property {string} postKey
 * @property {string} postUrl
 * @property {string} text
 * @property {string} platform
 * @property {string} authorName
 * @property {string} authorUrl
 * @property {boolean} isAd
 * @property {boolean} isUpdate
 * @property {number|null} tabId
 * @property {number} enqueuedAt
 * @property {number} [staleRedecides]  times re-queued because the configuration changed meanwhile
 */

/**
 * Whether `entry` should overwrite the stored item's text. Never appends.
 *
 * A migrated item flagged suspectMerged holds text the old append bug glued from several posts
 * (often over the 2000-character cap), so any fresh copy of the post replaces it, even a shorter
 * one; otherwise the glued text could never heal.
 *
 * @param {object} existing
 * @param {IngestEntry} entry
 */
export function shouldReplaceText(existing, entry) {
  const current = String(existing.textSnippet || '');
  if (entry.text === current) return false;
  if (existing.suspectMerged === true) return true;
  return !!entry.isUpdate || entry.text.length > current.length;
}

/**
 * Index of the stored item for `entry`: by postKey, else by permalink for legacy items (no postKey,
 * or the `url:` key the migration derives from a permalink) — only when both URLs are real
 * single-post permalinks, never company pages / profiles / feeds.
 *
 * @param {object[]} stack
 * @param {IngestEntry} entry
 */
export function findStackIndex(stack, entry) {
  const byKey = stack.findIndex(item => item && item.postKey === entry.postKey);
  if (byKey !== -1) return byKey;
  if (!isRealPermalink(entry.postUrl)) return -1;
  const target = canonicalUrl(entry.postUrl);
  return stack.findIndex(item => item
    && (!item.postKey || String(item.postKey).startsWith('url:'))
    && isRealPermalink(item.sourceUrl)
    && canonicalUrl(item.sourceUrl) === target);
}

/**
 * Sets item.hiddenByPrompt from its (new) decision. The flag is only written when it is or was set,
 * so items that were never hidden keep their shape.
 *
 * @param {object} item     mutated
 * @param {object} config   fresh configuration
 */
function setHidden(item, config) {
  const hide = shouldHideByPrompt(item, config);
  if (hide || item.hiddenByPrompt) item.hiddenByPrompt = hide;
}

/**
 * Outcome reported for a re-send of a stored post: 'collected' (duplicate), or 'rejected' with
 * reason 'hidden_by_prompt' when the stored copy is hidden by the prompt.
 *
 * @param {IngestEntry} entry
 * @param {object} existing
 */
function duplicateResult(entry, existing) {
  if (existing.hiddenByPrompt) return { entry, status: 'rejected', reason: 'hidden_by_prompt' };
  return { entry, status: 'collected', reason: 'duplicate', tag: existing.assignedTag };
}

/** @param {string} url */
function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * @param {object} deps
 * @param {ReturnType<import('../bg/store.js').createStore>} deps.store
 * @param {import('../decision/types.js').DecideMany} deps.decideMany
 * @param {{ scheduleBroadcast: () => unknown, sendInflight?: (count: number, source?: string) => unknown }} deps.broadcast
 * @param {(tabId: number, message: object) => unknown} [deps.notifyTab]
 * @param {() => number} [deps.now]
 * @param {() => string} [deps.uuid]
 * @param {number} [deps.batchSize]
 * @param {chrome.storage.StorageArea|null} [deps.session]
 * @param {number} [deps.settleMs]    wait this long for a partial batch to fill before deciding it
 * @param {ReturnType<typeof createAuthorCanonicalizer>} [deps.authors]
 * @param {number} [deps.rejectedLogSize]
 */
export function createIngest({
  store,
  decideMany,
  broadcast,
  notifyTab = () => {},
  now = Date.now,
  uuid = () => crypto.randomUUID(),
  batchSize = 8,
  session = globalThis.chrome?.storage?.session ?? null,
  settleMs = 15,
  authors = createAuthorCanonicalizer(),
  rejectedLogSize = 200
}) {
  /** @type {IngestEntry[]} queued, not yet taken by a batch */
  const queue = [];
  /** @type {IngestEntry[]} the batch being decided/committed */
  let active = [];
  /** @type {Promise<void>|null} */
  let draining = null;
  let lastInflight = -1;
  let persistChain = Promise.resolve();
  let persistScheduled = false;
  let logChain = Promise.resolve();

  function pendingCount() {
    return queue.length + active.length;
  }

  function reportInflight() {
    const count = pendingCount();
    if (count === lastInflight || !broadcast.sendInflight) return;
    lastInflight = count;
    try {
      Promise.resolve(broadcast.sendInflight(count, 'ingest')).catch(() => {});
    } catch {
      // best effort
    }
  }

  /**
   * @param {number|null} tabId
   * @param {object} payload
   */
  function notify(tabId, payload) {
    if (tabId == null) return;
    try {
      Promise.resolve(notifyTab(tabId, { type: MSG.DECISION_RESULT, payload })).catch(() => {});
    } catch {
      // the tab may be gone
    }
  }

  /** Mirrors the pending posts to storage.session (coalesced, best effort). */
  function persistQueue() {
    if (!session) return persistChain;
    if (persistScheduled) return persistChain;
    persistScheduled = true;
    persistChain = persistChain.then(async () => {
      persistScheduled = false;
      try {
        await session.set({ [PENDING_QUEUE_KEY]: [...active, ...queue] });
      } catch (err) {
        console.warn('[ingest] could not mirror the queue to storage.session:', err);
      }
    });
    return persistChain;
  }

  /** @param {object[]} entries */
  function appendRejectedLog(entries) {
    if (!session || entries.length === 0) return logChain;
    logChain = logChain.then(async () => {
      try {
        const stored = await session.get(REJECTED_LOG_KEY);
        const log = Array.isArray(stored && stored[REJECTED_LOG_KEY]) ? stored[REJECTED_LOG_KEY] : [];
        await session.set({ [REJECTED_LOG_KEY]: log.concat(entries).slice(-rejectedLogSize) });
      } catch (err) {
        console.warn('[ingest] could not record rejections:', err);
      }
    });
    return logChain;
  }

  /**
   * @param {string} postKey
   * @param {string} reason
   * @param {number|null} tabId
   */
  function ignored(postKey, reason, tabId) {
    notify(tabId, { postKey, status: 'ignored', reason });
    return { status: 'ignored', postKey, reason };
  }

  /**
   * Merges `other` (another copy of the same post) into the queued entry `target`. The text is
   * replaced only by an update or a longer copy (never appended).
   *
   * @param {IngestEntry} target   mutated
   * @param {IngestEntry} other
   * @param {number|null} tabId    tab that gets the outcome
   */
  function coalesce(target, other, tabId) {
    if (shouldReplaceText({ textSnippet: target.text }, other)) {
      target.text = other.text;
      target.isUpdate = target.isUpdate || other.isUpdate;
    }
    target.postUrl = target.postUrl || other.postUrl;
    target.authorName = target.authorName || other.authorName;
    target.authorUrl = target.authorUrl || other.authorUrl;
    target.isAd = target.isAd || other.isAd;
    target.tabId = tabId;
    target.staleRedecides = Math.max(target.staleRedecides || 0, other.staleRedecides || 0);
  }

  /**
   * Puts posts decided for an outdated configuration back at the front of the queue. A newer copy
   * queued meanwhile absorbs the old one (and keeps its own tab).
   *
   * @param {IngestEntry[]} entries
   */
  function requeue(entries) {
    const back = [];
    for (const entry of entries) {
      entry.staleRedecides = (entry.staleRedecides || 0) + 1;
      const queued = queue.find(e => e.postKey === entry.postKey);
      if (queued) coalesce(queued, entry, queued.tabId ?? entry.tabId);
      else back.push(entry);
    }
    queue.unshift(...back);
  }

  /**
   * Validates, guards and queues one extracted post. Never runs a model.
   *
   * @param {object} payload   TEXT_EXTRACTED payload (new or legacy shape)
   * @param {chrome.runtime.MessageSender} [sender]
   * @returns {Promise<{ status: 'queued'|'ignored', postKey: string, reason?: string }>}
   */
  async function enqueue(payload, sender) {
    const p = payload || {};
    const tabId = sender && sender.tab && sender.tab.id != null ? sender.tab.id : null;
    const platform = normalizePlatform(p.sourcePlatform || hostOf(p.pageUrl || p.postUrl || p.sourceUrl || ''));
    const text = stripMoreMarker(typeof p.text === 'string' ? p.text : '').slice(0, MAX_TEXT_LEN);
    const { postKey, postUrl } = derivePostIdentity(p, platform, text);

    if (!text) return ignored(postKey, 'empty_text', tabId);

    const { configuration: cfg = {} } = (await store.get('configuration')) || {};
    if (cfg.isTrackingPaused) return ignored(postKey, 'paused', tabId);
    if (findIgnoredKeyword(text, cfg.ignoredKeywords)) return ignored(postKey, 'ignored_keyword', tabId);

    const ignoredLinks = Array.isArray(cfg.ignoredLinks) ? cfg.ignoredLinks : [];
    if (ignoredLinks.length > 0) {
      const links = new Set(ignoredLinks.flatMap(l => [l, canonicalUrl(l)]));
      const candidates = [postUrl, p.sourceUrl].filter(u => typeof u === 'string' && u);
      if (candidates.some(u => links.has(u) || links.has(canonicalUrl(u)))) return ignored(postKey, 'ignored_link', tabId);
    }

    const ignoredDomains = Array.isArray(cfg.ignoredDomains) ? cfg.ignoredDomains : [];
    const postHost = hostOf(postUrl);
    if (ignoredDomains.some(d => domainMatches(platform, d) || (postHost && domainMatches(postHost, d)))) {
      return ignored(postKey, 'ignored_domain', tabId);
    }

    /** @type {IngestEntry} */
    const entry = {
      postKey,
      postUrl,
      text,
      platform,
      authorName: typeof p.authorName === 'string' ? p.authorName.trim() : '',
      authorUrl: typeof p.authorUrl === 'string' ? p.authorUrl : '',
      isAd: !!p.isAd,
      isUpdate: !!p.isUpdate,
      tabId,
      enqueuedAt: now()
    };

    // Coalesce with a still-queued copy of the same post (e.g. truncated + expanded in one burst).
    const queued = queue.find(e => e.postKey === postKey);
    if (queued) {
      coalesce(queued, entry, entry.tabId ?? queued.tabId);
    } else {
      queue.push(entry);
    }

    persistQueue();
    reportInflight();
    drain().catch(err => console.error('[ingest] drain failed:', err));
    return { status: 'queued', postKey };
  }

  /**
   * Applies one batch's decisions to the FRESH stack. Synchronous (runs inside the state lock).
   *
   * @param {object[]} freshStack
   * @param {object} state
   * @param {IngestEntry[]} entries
   * @param {object[]} decisions   sanitised, same order as entries
   * @param {import('../decision/types.js').DecideContext} ctx
   * @param {object[]} results     outcome per entry (filled here)
   */
  function commitBatch(freshStack, state, entries, decisions, ctx, results) {
    const config = state.configuration || {};
    const stack = freshStack.slice();
    const telemetry = { ...emptyTelemetry(now()), ...(state.telemetry || {}) };
    const ignoredTags = new Set((Array.isArray(config.ignoredTags) ? config.ignoredTags : []).map(t => String(t).toLowerCase()));
    let trackedTags = Array.isArray(config.trackedTags) ? config.trackedTags : [];
    let tagsChanged = false;
    let stackChanged = false;

    entries.forEach((entry, i) => {
      const d = decisions[i];
      const idx = findStackIndex(stack, entry);
      const existing = idx !== -1 ? stack[idx] : null;

      if (existing && !shouldReplaceText(existing, entry)) {
        results.push(duplicateResult(entry, existing));
        return;
      }

      if (!d.collect) {
        // A new post is not stored. A stored one (e.g. its "…more" text expanded) is never deleted:
        // it keeps its place with the new text and verdict, hidden when the prompt rejects it.
        if (existing) {
          const updated = {
            ...existing,
            postKey: entry.postKey,
            sourceUrl: entry.postUrl || existing.sourceUrl || '',
            textSnippet: entry.text,
            authorName: entry.authorName || existing.authorName || '',
            authorUrl: entry.authorUrl || existing.authorUrl || '',
            isAd: !!existing.isAd || entry.isAd
          };
          delete updated.legacy;
          delete updated.suspectMerged;
          if (!isManualItem(existing)) {
            updated.decision = persistedDecision(d);
            updated.matchInfo = buildMatchInfo(d, config, ctx.gateOn);
          }
          setHidden(updated, config);
          stack[idx] = updated;
          stackChanged = true;
        }
        results.push({ entry, status: 'rejected', reason: rejectionReason(d), detail: d.reason || null, decision: d });
        return;
      }

      const { tag, newTag } = resolveDynamicTag(trackedTags, d, config, ctx.gateOn, () => `dt_${uuid()}`);
      if (ignoredTags.has(String(tag).toLowerCase())) {
        results.push({ entry, status: 'ignored', reason: 'ignored_tag', tag });
        return;
      }
      if (newTag) {
        trackedTags = [...trackedTags, newTag];
        tagsChanged = true;
      }

      const decision = persistedDecision({ ...d, tag });
      const itemTags = tag !== UNCLASSIFIED && d.tags.length === 0 ? [{ name: tag, score: 1 }] : d.tags;
      const matchInfo = buildMatchInfo(d, config, ctx.gateOn);

      if (existing) {
        const manual = !!(existing.matchInfo && existing.matchInfo.manual);
        const updated = {
          ...existing,
          postKey: entry.postKey,
          sourceUrl: entry.postUrl || existing.sourceUrl || '',
          textSnippet: entry.text,
          authorName: entry.authorName || existing.authorName || '',
          authorUrl: entry.authorUrl || existing.authorUrl || '',
          isAd: !!existing.isAd || entry.isAd,
          decision
        };
        // Clean text + a fresh decision: the migration's legacy / glued-text flags no longer apply.
        delete updated.legacy;
        delete updated.suspectMerged;
        if (!updated.canonicalAuthorName && updated.authorName) {
          updated.canonicalAuthorName = authors.canonicalize(
            { name: updated.authorName, platform: entry.platform, url: updated.authorUrl }, stack);
        }
        if (!manual) {
          updated.assignedTag = tag;
          updated.tags = itemTags;
          updated.matchInfo = matchInfo;
        }
        // Collected again (e.g. the expanded text now matches the prompt): visible again.
        setHidden(updated, config);
        const wasUnclassified = (existing.assignedTag || UNCLASSIFIED) === UNCLASSIFIED;
        const isUnclassified = (updated.assignedTag || UNCLASSIFIED) === UNCLASSIFIED;
        if (wasUnclassified !== isUnclassified) {
          telemetry.unclassifiedCount = Math.max(0, (telemetry.unclassifiedCount || 0) + (isUnclassified ? 1 : -1));
          telemetry.classifiedCount = Math.max(0, (telemetry.classifiedCount || 0) + (isUnclassified ? -1 : 1));
        }
        stack.splice(idx, 1);
        stack.unshift(updated);
        results.push({ entry, status: 'collected', tag: updated.assignedTag, decision, updated: true });
      } else {
        const item = {
          id: uuid(),
          postKey: entry.postKey,
          timestamp: now(),
          sourcePlatform: entry.platform,
          sourceUrl: entry.postUrl || '',
          authorName: entry.authorName,
          authorUrl: entry.authorUrl,
          canonicalAuthorName: entry.authorName
            ? authors.canonicalize({ name: entry.authorName, platform: entry.platform, url: entry.authorUrl }, stack)
            : '',
          textSnippet: entry.text,
          assignedTag: tag,
          tags: itemTags,
          isFavorite: false,
          favoritedAt: null,
          isAd: entry.isAd,
          decision,
          matchInfo
        };
        stack.unshift(item);
        telemetry.totalProcessed = (telemetry.totalProcessed || 0) + 1;
        if (tag === UNCLASSIFIED) telemetry.unclassifiedCount = (telemetry.unclassifiedCount || 0) + 1;
        else telemetry.classifiedCount = (telemetry.classifiedCount || 0) + 1;
        results.push({ entry, status: 'collected', tag, decision });
      }
      stackChanged = true;
    });

    if (!stackChanged && !tagsChanged) return null;
    telemetry.lastProcessed = now();
    const commit = { stack, telemetry };
    if (tagsChanged) commit.configuration = { ...config, trackedTags };
    return commit;
  }

  /** @param {IngestEntry[]} batch */
  async function processBatch(batch) {
    const snapshot = (await store.get(['configuration', 'stack'])) || {};
    const ctx = decideContext(snapshot.configuration || {}, 'ingest');
    const fingerprint = decisionFingerprint(snapshot.configuration || {});
    const stack = Array.isArray(snapshot.stack) ? snapshot.stack : [];

    // Exact re-sends of stored posts need no decision.
    const toDecide = [];
    const results = [];
    for (const entry of batch) {
      const idx = findStackIndex(stack, entry);
      if (idx !== -1 && !shouldReplaceText(stack[idx], entry)) {
        results.push(duplicateResult(entry, stack[idx]));
      } else {
        toDecide.push(entry);
      }
    }

    let decisions = [];
    if (toDecide.length > 0) {
      try {
        const out = await decideMany(
          toDecide.map(e => ({ id: e.postKey, text: e.text, platform: e.platform, author: e.authorName || undefined })),
          ctx
        );
        decisions = toDecide.map((_, i) => sanitizeDecision(Array.isArray(out) ? out[i] : null, ctx, now()));
      } catch (err) {
        console.warn('[ingest] decideMany failed; storing without a verdict where no gate filters:', err);
        decisions = toDecide.map(() => fallbackDecision(ctx, 'decide_error', now()));
      }

      // The prompt, the gate, the tags or the model changed while these posts were being decided:
      // decide them again for the new configuration instead of storing a verdict for the old one.
      const mayRequeue = toDecide.some(e => (e.staleRedecides || 0) < MAX_STALE_REDECIDES);
      let stale = false;
      await store.mutateStack((freshStack, state) => {
        if (mayRequeue && decisionFingerprint(state.configuration || {}) !== fingerprint) {
          stale = true;
          return null;
        }
        return commitBatch(freshStack, state, toDecide, decisions, ctx, results);
      });
      if (stale) {
        console.info(`[ingest] The configuration changed while ${toDecide.length} post(s) were being decided; deciding them again.`);
        requeue(toDecide);
      }
    }

    const rejected = [];
    for (const r of results) {
      const payload = { postKey: r.entry.postKey, status: r.status };
      if (r.reason) payload.reason = r.reason;
      if (r.tag) payload.tag = r.tag;
      if (r.decision && r.decision.pMatch != null) payload.pMatch = r.decision.pMatch;
      notify(r.entry.tabId, payload);
      if (r.status === 'rejected' && r.decision) {
        rejected.push({
          postKey: r.entry.postKey,
          postUrl: r.entry.postUrl,
          platform: r.entry.platform,
          reason: payload.reason,
          detail: r.detail ?? null,
          pMatch: r.decision.pMatch,
          path: r.decision.path,
          provider: r.decision.provider,
          snippet: r.entry.text.slice(0, 140),
          at: now()
        });
      }
    }
    await appendRejectedLog(rejected);
    broadcast.scheduleBroadcast();
  }

  /**
   * Processes the queue until it is empty (including posts queued meanwhile).
   *
   * While `draining` is set, enqueue() only joins this run, so the queue is re-checked after every
   * await, including the final mirror write: a post queued during that write is processed here
   * instead of waiting for the next post or a service-worker restart.
   *
   * @returns {Promise<void>}
   */
  function drain() {
    if (draining) return draining;
    draining = (async () => {
      try {
        do {
          while (queue.length > 0) {
            if (settleMs > 0 && queue.length < batchSize) {
              await new Promise(resolve => setTimeout(resolve, settleMs));
            }
            active = queue.splice(0, batchSize);
            try {
              await processBatch(active);
            } catch (err) {
              console.error('[ingest] batch failed:', err);
            } finally {
              active = [];
              persistQueue();
              reportInflight();
            }
          }
          await persistChain;
        } while (queue.length > 0);
      } finally {
        draining = null;
      }
    })();
    return draining;
  }

  /**
   * Re-queues posts mirrored by a previous service-worker instance and drains them.
   *
   * @returns {Promise<number>} number of restored posts
   */
  async function restore() {
    if (!session) return 0;
    let saved = [];
    try {
      const stored = await session.get(PENDING_QUEUE_KEY);
      saved = Array.isArray(stored && stored[PENDING_QUEUE_KEY]) ? stored[PENDING_QUEUE_KEY] : [];
    } catch (err) {
      console.warn('[ingest] could not read the mirrored queue:', err);
      return 0;
    }
    let added = 0;
    for (const e of saved) {
      if (!e || typeof e.postKey !== 'string' || typeof e.text !== 'string' || !e.text) continue;
      if (queue.some(q => q.postKey === e.postKey) || active.some(a => a.postKey === e.postKey)) continue;
      queue.push({
        postKey: e.postKey,
        postUrl: typeof e.postUrl === 'string' ? e.postUrl : '',
        text: e.text.slice(0, MAX_TEXT_LEN),
        platform: normalizePlatform(e.platform),
        authorName: typeof e.authorName === 'string' ? e.authorName : '',
        authorUrl: typeof e.authorUrl === 'string' ? e.authorUrl : '',
        isAd: !!e.isAd,
        isUpdate: !!e.isUpdate,
        tabId: Number.isInteger(e.tabId) ? e.tabId : null,
        enqueuedAt: Number.isFinite(e.enqueuedAt) ? e.enqueuedAt : now()
      });
      added++;
    }
    if (added > 0) {
      console.info(`[ingest] restored ${added} queued post(s) from the previous service worker.`);
      reportInflight();
      drain().catch(err => console.error('[ingest] drain failed:', err));
    }
    return added;
  }

  return { enqueue, drain, restore, pendingCount };
}
