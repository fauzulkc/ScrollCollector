/**
 * redecide.js
 *
 * Re-evaluates the stored stack when the prompt, the tags or the System 1 model change. Replaces the
 * old relabel pass (and rebuildStackInference before it, which held the state lock for the whole
 * rebuild).
 *
 *  - Versioned jobs: start() / schedule() / cancel() bump a version. A running job checks it before
 *    and after every batch and again inside each commit, so a superseded job never writes.
 *  - Decisions run OUTSIDE the state lock, in batches of 32, through
 *    decideMany(items, buildDecideContext(configuration, 'redecide')). The cascade never escalates a
 *    'redecide' call (unless the user explicitly allowed re-decide escalation); this module does not
 *    override that.
 *  - Each batch is committed through store.mutateStack against the FRESH stack, matched by item id:
 *    items deleted meanwhile are skipped (never resurrected), items added meanwhile are untouched,
 *    items whose text changed meanwhile keep the decision ingest gave them.
 *  - Items are NEVER deleted. An item that no longer matches the prompt gets hiddenByPrompt = true
 *    (stack-utils shouldHideByPrompt: gate on, decision.collect === false for the current prompt
 *    version, not a favourite, not a manual override). Manual overrides keep their tag and are not
 *    re-decided. With the gate off every hidden flag is cleared, without any model call.
 *  - At the end of a job (if still current) stale hidden flags are reconciled and dynamic,
 *    non-sticky tags that no item uses any more are pruned.
 *
 * Scopes:
 *  - 'all'        every item (tags changed, diagnostics button)
 *  - 'prompt'     every item when the gate is on (prompt changed); with the gate off only the hidden
 *                 flags are cleared
 *  - 'rules-only' items without a model verdict: decided by the rules tier (decision.path ends with
 *                 'rules' or 'error' and System 1 never answered), legacy items without a decision,
 *                 and — with the gate on — items decided for an older prompt version (a job killed
 *                 with the service worker). Used once System 1 is ready (onSystem1Ready()).
 * Scopes widen when jobs supersede each other: rules-only < prompt < all.
 *
 * Progress: REDECIDE_PROGRESS { jobId, done, total, hidden, finished } (+ cancelled: true when a newer
 * job superseded this one). `hidden` is the number of hidden items in the stack after the last commit.
 *
 * Rescan: a job started or scheduled with `rescan: true` (a prompt or gate change) asks open tabs to
 * rescan (RESET_AND_RESCAN) once it FINISHED, so the posts the page re-sends meet the re-decided
 * stack: a stored post the new prompt hides is reported 'hidden_by_prompt', not as a 'collected'
 * duplicate of its stale verdict. The request carries over to the job that supersedes it.
 */

import { MSG } from '../messages.js';
import { buildDecideContext } from '../decision/cascade.js';
import { sanitizeDecision, persistedDecision, buildMatchInfo } from './apply-decision.js';
import {
  UNCLASSIFIED,
  telemetryFromStack,
  isManualItem,
  isPromptGateOn,
  shouldHideByPrompt,
  countHidden,
  pruneEmptyDynamicTags
} from '../bg/stack-utils.js';

/** Valid REDECIDE_STACK scopes, narrowest first. */
export const REDECIDE_SCOPES = Object.freeze(['rules-only', 'prompt', 'all']);

/** Items decided per decideMany call / per commit. */
export const REDECIDE_BATCH_SIZE = 32;

/** Debounce used by schedule() (UPDATE_MATCH_PROMPT fires on every keystroke). */
export const REDECIDE_DEBOUNCE_MS = 800;

/** Job results kept for wait(jobId). */
const MAX_REMEMBERED_JOBS = 8;

/**
 * @typedef {'all'|'prompt'|'rules-only'} RedecideScope
 */

/**
 * @typedef {object} RedecideResult
 * @property {string} jobId
 * @property {RedecideScope} scope
 * @property {string} reason
 * @property {number} total       items selected for the job
 * @property {number} done        items processed (decided, failed or skipped)
 * @property {number} updated     items whose decision / tag / hidden flag were rewritten
 * @property {number} hidden      hidden items in the stack after the last commit
 * @property {number} cleared     hidden flags cleared without a model call (gate off / reconcile)
 * @property {boolean} cancelled  a newer job superseded this one
 * @property {boolean} finished
 */

/**
 * @param {unknown} scope
 * @returns {RedecideScope|null} the scope, or null when it is not a known one
 */
export function parseScope(scope) {
  return typeof scope === 'string' && REDECIDE_SCOPES.includes(scope) ? /** @type {RedecideScope} */ (scope) : null;
}

/**
 * The wider of two scopes (rules-only < prompt < all). A missing scope loses.
 *
 * @param {RedecideScope|null|undefined} a
 * @param {RedecideScope|null|undefined} b
 * @returns {RedecideScope}
 */
export function widerScope(a, b) {
  const ra = REDECIDE_SCOPES.indexOf(/** @type {any} */ (a));
  const rb = REDECIDE_SCOPES.indexOf(/** @type {any} */ (b));
  if (ra === -1 && rb === -1) return 'all';
  return /** @type {RedecideScope} */ (REDECIDE_SCOPES[Math.max(ra, rb)]);
}

/**
 * True when an item has no model verdict yet: no decision (legacy item), a decision without a path,
 * or a path that ends with the rules tier / an error and on which System 1 never answered.
 *
 * @param {object} item
 */
export function isRulesDecided(item) {
  const d = item && item.decision;
  if (!d || typeof d !== 'object') return true;
  if (!Array.isArray(d.path)) return true;
  const path = d.path.filter(p => p !== 'cache');
  if (path.length === 0) return false;
  if (path.includes('system1')) return false;
  const last = path[path.length - 1];
  return last === 'rules' || last === 'error';
}

/**
 * Whether `item` is re-decided by a job of `scope` (manual overrides and items without text never are).
 *
 * @param {object} item
 * @param {RedecideScope} scope
 * @param {object} configuration
 */
export function isRedecideTarget(item, scope, configuration) {
  if (!item || !item.id || typeof item.textSnippet !== 'string' || !item.textSnippet) return false;
  if (isManualItem(item)) return false;
  if (scope !== 'rules-only') return true;
  if (isRulesDecided(item)) return true;
  // Decided for an older prompt (e.g. a 'prompt' job cut short by a service-worker restart).
  if (isPromptGateOn(configuration)) {
    const current = Number.isFinite(configuration.promptVersion) ? configuration.promptVersion : 0;
    const version = Number.isFinite(item.decision.promptVersion) ? item.decision.promptVersion : 0;
    if (version !== current) return true;
  }
  return false;
}

/**
 * Clears every hidden flag that no longer applies (all of them when the gate is off). No model call.
 *
 * @param {{ mutateStack: ReturnType<import('../bg/store.js').createStore>['mutateStack'] }} store
 * @param {() => boolean} [isCurrent]   commit only while this returns true
 * @returns {Promise<{ cleared: number, hidden: number }>}
 */
export async function clearStaleHiddenFlags(store, isCurrent = () => true) {
  let cleared = 0;
  let hidden = 0;
  await store.mutateStack((fresh, state) => {
    if (!isCurrent()) return null;
    const cfg = state.configuration || {};
    cleared = 0;
    const next = fresh.map(item => {
      if (!item || !item.hiddenByPrompt || shouldHideByPrompt(item, cfg)) return item;
      cleared++;
      return { ...item, hiddenByPrompt: false };
    });
    hidden = countHidden(next);
    return cleared > 0 ? { stack: next } : null;
  });
  return { cleared, hidden };
}

/**
 * The re-decide interface the background handlers use, from handler deps: `deps.redecide` (a
 * createRedecider() instance), else `deps.relabel` (createRelabeler(), or a legacy { trigger }
 * stub, in which case start/schedule fall back to trigger() and clearHidden runs directly on the
 * store).
 *
 * @param {{ redecide?: any, relabel?: any, store?: any }} deps
 * @returns {{
 *   start: (opts?: { scope?: RedecideScope, reason?: string, rescan?: boolean }) => string|null,
 *   schedule: (opts?: { scope?: RedecideScope, reason?: string, delayMs?: number, rescan?: boolean }) => Promise<string|null>,
 *   clearHidden: () => Promise<{ cleared: number, hidden: number }>
 * }}
 */
export function redeciderFrom(deps) {
  const r = (deps && (deps.redecide || deps.relabel)) || null;
  const trigger = (opts) => {
    try {
      if (r && typeof r.trigger === 'function') r.trigger();
    } catch (err) {
      console.warn('[background] re-decide trigger failed:', err);
    }
    // A legacy trigger cannot rescan after its job: ask the tabs right away.
    if (opts && opts.rescan && deps && deps.broadcast && typeof deps.broadcast.broadcastToAllTabs === 'function') {
      Promise.resolve(deps.broadcast.broadcastToAllTabs({ type: MSG.RESET_AND_RESCAN })).catch(() => {});
    }
  };
  return {
    start(opts) {
      if (r && typeof r.start === 'function') return r.start(opts);
      trigger(opts);
      return null;
    },
    schedule(opts) {
      if (r && typeof r.schedule === 'function') return r.schedule(opts);
      trigger(opts);
      return Promise.resolve(null);
    },
    clearHidden() {
      if (r && typeof r.clearHidden === 'function') return r.clearHidden();
      if (deps && deps.store && typeof deps.store.mutateStack === 'function') return clearStaleHiddenFlags(deps.store);
      return Promise.resolve({ cleared: 0, hidden: 0 });
    }
  };
}

/**
 * @param {object} deps
 * @param {ReturnType<import('../bg/store.js').createStore>} deps.store
 * @param {import('../decision/types.js').DecideMany} deps.decideMany
 * @param {{ scheduleBroadcast?: () => unknown, sendInflight?: (count: number, source?: string) => unknown, sendRuntime?: (message: object) => unknown }|null} [deps.broadcast]
 * @param {((payload: { jobId: string, done: number, total: number, hidden: number, finished: boolean, cancelled?: boolean }) => unknown)|null} [deps.sendProgress]
 *        default: broadcast.sendRuntime({ type: MSG.REDECIDE_PROGRESS, payload })
 * @param {(() => unknown)|null} [deps.requestRescan]  asks open tabs to rescan after a `rescan` job
 *        default: broadcast.broadcastToAllTabs({ type: MSG.RESET_AND_RESCAN })
 * @param {() => number} [deps.now]
 * @param {number} [deps.batchSize]
 * @param {number} [deps.debounceMs]   default delay of schedule()
 * @param {(fn: () => void, ms: number) => any} [deps.setTimer]
 * @param {(handle: any) => void} [deps.clearTimer]
 */
export function createRedecider({
  store,
  decideMany,
  broadcast = null,
  sendProgress = null,
  requestRescan = null,
  now = Date.now,
  batchSize = REDECIDE_BATCH_SIZE,
  debounceMs = REDECIDE_DEBOUNCE_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle)
}) {
  const size = Math.max(1, Math.floor(batchSize) || REDECIDE_BATCH_SIZE);
  let version = 0;
  let seq = 0;
  /**
   * @typedef {{ jobId: string, scope: RedecideScope, reason: string, rescan: boolean, version: number, finished: boolean, promise: Promise<RedecideResult> }} Job
   */
  /** @type {Job|null} the newest started job (while it runs) */
  let running = null;
  /** @type {{ scope: RedecideScope, reason: string, rescan: boolean, timer: any, promise: Promise<string|null>, resolve: (id: string|null) => void }|null} */
  let pending = null;
  /** @type {Map<string, Promise<RedecideResult>>} */
  const jobs = new Map();

  /** @param {object} payload */
  function progress(payload) {
    try {
      const out = typeof sendProgress === 'function'
        ? sendProgress(payload)
        : broadcast && typeof broadcast.sendRuntime === 'function'
          ? broadcast.sendRuntime({ type: MSG.REDECIDE_PROGRESS, payload })
          : null;
      if (out && typeof out.then === 'function') out.then(undefined, () => {});
    } catch {
      // best effort
    }
  }

  /** Last in-flight count pushed (no message when it does not change). */
  let lastInflight = 0;

  /** @param {number} count */
  function setInflight(count) {
    if (count === lastInflight) return;
    lastInflight = count;
    try {
      if (broadcast && typeof broadcast.sendInflight === 'function') {
        Promise.resolve(broadcast.sendInflight(count, 'redecide')).catch(() => {});
      }
    } catch {
      // best effort
    }
  }

  function scheduleBroadcast() {
    try {
      if (broadcast && typeof broadcast.scheduleBroadcast === 'function') {
        Promise.resolve(broadcast.scheduleBroadcast()).catch(() => {});
      }
    } catch {
      // best effort
    }
  }

  /** Open tabs re-send their posts (after a `rescan` job committed everything). */
  function rescanTabs() {
    try {
      const out = typeof requestRescan === 'function'
        ? requestRescan()
        : broadcast && typeof broadcast.broadcastToAllTabs === 'function'
          ? broadcast.broadcastToAllTabs({ type: MSG.RESET_AND_RESCAN })
          : null;
      if (out && typeof out.then === 'function') out.then(undefined, () => {});
    } catch {
      // best effort
    }
  }

  /** Whether the running job (still current) asked for a rescan. */
  function runningWantsRescan() {
    return !!(running && !running.finished && running.version === version && running.rescan);
  }

  function makeJobId() {
    seq += 1;
    return `rd-${Number(now()).toString(36)}-${seq}`;
  }

  /**
   * One job. Never throws for a failed batch (the batch keeps its labels).
   *
   * @param {Job} job
   * @returns {Promise<RedecideResult>}
   */
  async function runJob(job) {
    const isCurrent = () => job.version === version;
    /** @type {RedecideResult} */
    const result = {
      jobId: job.jobId,
      scope: job.scope,
      reason: job.reason,
      total: 0,
      done: 0,
      updated: 0,
      hidden: 0,
      cleared: 0,
      cancelled: false,
      finished: false
    };
    const report = () => progress({
      jobId: job.jobId,
      done: result.done,
      total: result.total,
      hidden: result.hidden,
      finished: result.finished,
      ...(result.cancelled ? { cancelled: true } : {})
    });
    const finish = (cancelled) => {
      result.cancelled = cancelled;
      result.finished = true;
      report();
      return result;
    };

    try {
      // Ordered after every commit queued so far (e.g. the prompt edit that triggered this job).
      const { configuration = {}, stack = [] } = (await store.snapshot(['configuration', 'stack'])) || {};
      if (!isCurrent()) return finish(true);
      const ctx = buildDecideContext(configuration, 'redecide');
      const all = Array.isArray(stack) ? stack : [];
      result.hidden = countHidden(all);

      // Gate off: nothing may stay hidden (checked against the fresh configuration inside the lock).
      if (!ctx.gateOn && result.hidden > 0) {
        const { cleared, hidden } = await clearStaleHiddenFlags(store, isCurrent);
        result.cleared += cleared;
        result.hidden = hidden;
        if (cleared > 0) scheduleBroadcast();
        if (!isCurrent()) return finish(true);
      }

      // With the gate off the prompt does not affect any decision: clearing the flags was the job.
      const targets = job.scope === 'prompt' && !ctx.gateOn
        ? []
        : all.filter(item => isRedecideTarget(item, job.scope, configuration));
      result.total = targets.length;
      if (targets.length > 0) {
        console.info(`[background] Re-deciding ${targets.length} item(s) (${job.scope}, ${job.reason})...`);
      }
      report();

      for (let start = 0; start < targets.length; start += size) {
        if (!isCurrent()) return finish(true);
        const chunk = targets.slice(start, start + size);
        setInflight(targets.length - start);

        const inputs = chunk.map(item => ({
          id: item.id,
          text: item.textSnippet,
          platform: item.sourcePlatform || '',
          author: item.authorName || undefined
        }));
        /** @type {object[]|null} */
        let decisions = null;
        try {
          const out = await decideMany(inputs, ctx);
          decisions = inputs.map((_, i) => sanitizeDecision(Array.isArray(out) ? out[i] : null, ctx, now()));
        } catch (err) {
          console.warn('[background] Re-decide batch failed; keeping the current labels:', err);
        }
        if (!isCurrent()) return finish(true);

        if (decisions) {
          const byId = new Map(chunk.map((item, i) => [item.id, { text: item.textSnippet, d: decisions[i] }]));
          let superseded = false;
          await store.mutateStack((fresh, state) => {
            if (!isCurrent()) {
              superseded = true;
              return null;
            }
            const cfg = state.configuration || {};
            let changed = 0;
            const next = fresh.map(item => {
              const hit = item && byId.get(item.id);
              // Deleted items are simply absent; new items have no hit; edited text keeps ingest's decision.
              if (!hit || item.textSnippet !== hit.text) return item;
              // Became a manual override meanwhile: keep its tag; manual items are never hidden.
              if (isManualItem(item)) {
                if (!item.hiddenByPrompt) return item;
                changed++;
                return { ...item, hiddenByPrompt: false };
              }
              // Path 'error' means no verdict: keep what the item has.
              if (hit.d.path.includes('error')) return item;
              const tag = hit.d.tag || UNCLASSIFIED;
              const updated = {
                ...item,
                assignedTag: tag,
                tags: tag !== UNCLASSIFIED && hit.d.tags.length === 0 ? [{ name: tag, score: 1 }] : hit.d.tags,
                decision: persistedDecision(hit.d),
                matchInfo: buildMatchInfo(hit.d, cfg, ctx.gateOn)
              };
              updated.hiddenByPrompt = shouldHideByPrompt(updated, cfg);
              changed++;
              return updated;
            });
            result.hidden = countHidden(next);
            if (changed === 0) return null;
            result.updated += changed;
            return { stack: next, telemetry: telemetryFromStack(next, state.telemetry, now()) };
          });
          if (superseded) return finish(true);
          scheduleBroadcast();
        }
        result.done += chunk.length;
        if (result.done < result.total) report();
      }

      // Reconcile flags that no longer hold and drop dynamic tags nobody uses any more.
      if (!isCurrent()) return finish(true);
      let superseded = false;
      let wrote = false;
      await store.mutateStack((fresh, state) => {
        if (!isCurrent()) {
          superseded = true;
          return null;
        }
        const cfg = state.configuration || {};
        let cleared = 0;
        const next = fresh.map(item => {
          if (!item || !item.hiddenByPrompt || shouldHideByPrompt(item, cfg)) return item;
          cleared++;
          return { ...item, hiddenByPrompt: false };
        });
        result.hidden = countHidden(next);
        const tags = Array.isArray(cfg.trackedTags) ? cfg.trackedTags : null;
        const pruned = tags ? pruneEmptyDynamicTags(tags, next) : null;
        if (cleared === 0 && pruned === tags) return null;
        result.cleared += cleared;
        wrote = true;
        const commit = { stack: next };
        if (pruned !== tags) commit.configuration = { ...cfg, trackedTags: pruned };
        return commit;
      });
      if (superseded) return finish(true);
      if (wrote) scheduleBroadcast();
    } finally {
      // A superseding start() already owns the in-flight count; otherwise this job releases it.
      if (running === job || running === null) setInflight(0);
    }

    if (result.total > 0) {
      console.info(`[background] Re-decide complete: ${result.updated} item(s) updated, ${result.hidden} hidden.`);
    }
    const done = finish(false);
    if (job.rescan) rescanTabs();
    return done;
  }

  /**
   * Starts a job now. A newer job supersedes (cancels) a running one and a pending schedule(); the
   * new job's scope is widened to cover whatever those would have done.
   *
   * @param {{ scope?: RedecideScope, reason?: string, rescan?: boolean }} [opts]
   *   rescan: ask open tabs to rescan once the job finished (inherited by a job that supersedes it)
   * @returns {string} jobId
   */
  function start({ scope = 'all', reason = 'manual', rescan = false } = {}) {
    let s = parseScope(scope) || 'all';
    let wantsRescan = !!rescan || runningWantsRescan();
    if (pending) {
      s = widerScope(s, pending.scope);
      wantsRescan = wantsRescan || pending.rescan;
      clearTimer(pending.timer);
    }
    const previous = pending;
    pending = null;
    if (running && !running.finished && running.version === version) s = widerScope(s, running.scope);
    version += 1;
    /** @type {Job} */
    const job = {
      jobId: makeJobId(),
      scope: s,
      reason: typeof reason === 'string' && reason ? reason : 'manual',
      rescan: wantsRescan,
      version,
      finished: false,
      promise: /** @type {any} */ (null)
    };
    running = job;
    job.promise = runJob(job)
      .catch(err => {
        console.error('[background] Error re-deciding the stack:', err);
        const cancelled = job.version !== version;
        progress({ jobId: job.jobId, done: 0, total: 0, hidden: 0, finished: true, ...(cancelled ? { cancelled: true } : {}) });
        // Whatever was committed stays; the page still gets its rescan.
        if (!cancelled && job.rescan) rescanTabs();
        return /** @type {RedecideResult} */ ({
          jobId: job.jobId, scope: job.scope, reason: job.reason, total: 0, done: 0, updated: 0, hidden: 0, cleared: 0,
          cancelled, finished: true
        });
      })
      .finally(() => {
        job.finished = true;
        if (running === job) running = null;
      });
    jobs.set(job.jobId, job.promise);
    while (jobs.size > MAX_REMEMBERED_JOBS) jobs.delete(jobs.keys().next().value);
    if (previous) previous.resolve(job.jobId);
    return job.jobId;
  }

  /**
   * Debounced start (bursts of prompt keystrokes / tag edits cause one job). Supersedes the running
   * job right away (its remaining batches would use outdated settings); the scope widens to cover it.
   *
   * @param {{ scope?: RedecideScope, reason?: string, delayMs?: number, rescan?: boolean }} [opts]
   * @returns {Promise<string|null>} the jobId once the job starts (null if cancelled first)
   */
  function schedule({ scope = 'all', reason = 'scheduled', delayMs = debounceMs, rescan = false } = {}) {
    let s = parseScope(scope) || 'all';
    let wantsRescan = !!rescan || runningWantsRescan();
    if (pending) {
      s = widerScope(s, pending.scope);
      wantsRescan = wantsRescan || pending.rescan;
      clearTimer(pending.timer);
    }
    if (running && !running.finished && running.version === version) s = widerScope(s, running.scope);
    version += 1;
    if (!pending) {
      let resolve;
      const promise = new Promise(r => { resolve = r; });
      pending = { scope: s, reason, rescan: false, timer: null, promise, resolve: /** @type {any} */ (resolve) };
    }
    const entry = pending;
    entry.scope = s;
    entry.rescan = wantsRescan;
    entry.reason = typeof reason === 'string' && reason ? reason : 'scheduled';
    entry.timer = setTimer(() => {
      if (pending !== entry) return;
      start({ scope: entry.scope, reason: entry.reason, rescan: entry.rescan });
    }, Math.max(0, Number(delayMs) || 0));
    return entry.promise;
  }

  /** Cancels the running job (at its next check) and any pending schedule(). */
  function cancel() {
    version += 1;
    if (pending) {
      clearTimer(pending.timer);
      const p = pending;
      pending = null;
      p.resolve(null);
    }
  }

  /**
   * Clears hidden flags that no longer apply (every flag when the gate is off). No model call and no
   * job: a running job keeps going and, with the gate off, hides nothing.
   *
   * @returns {Promise<{ cleared: number, hidden: number }>}
   */
  async function clearHidden() {
    const out = await clearStaleHiddenFlags(store);
    if (out.cleared > 0) scheduleBroadcast();
    return out;
  }

  /**
   * Hook for the integrator: call once System 1 becomes ready, so items decided without a model
   * (rules tier, legacy items) get a System 1 verdict.
   *
   * @returns {string} jobId
   */
  function onSystem1Ready() {
    return start({ scope: 'rules-only', reason: 'system1_ready' });
  }

  /**
   * @param {string} jobId
   * @returns {Promise<RedecideResult|null>}
   */
  function wait(jobId) {
    return jobs.get(jobId) || Promise.resolve(null);
  }

  /** Resolves once no job is running or scheduled. */
  async function idle() {
    for (;;) {
      if (pending) {
        await pending.promise;
        continue;
      }
      if (running) {
        await running.promise;
        continue;
      }
      return;
    }
  }

  return {
    start,
    schedule,
    cancel,
    clearHidden,
    onSystem1Ready,
    wait,
    idle,
    /** @returns {{ jobId: string, scope: RedecideScope }|null} */
    get current() {
      return running && !running.finished ? { jobId: running.jobId, scope: running.scope } : null;
    },
    get isScheduled() {
      return pending !== null;
    }
  };
}
