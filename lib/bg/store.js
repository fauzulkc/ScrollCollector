/**
 * store.js
 *
 * The only write path for persisted extension state (configuration / stack / metrics / telemetry).
 *
 * Every mutation re-reads what it changes INSIDE the state lock and hands that fresh snapshot to a
 * synchronous callback, so a commit can never write back a snapshot taken before some other
 * handler's await. Slow work (model calls) happens before calling mutate*, never inside it.
 */

import { createStateLock } from '../state-lock.js';
import { pruneStack, computeCounts } from './stack-utils.js';

/** Keys read by stack commits. */
export const STACK_KEYS = Object.freeze(['configuration', 'metrics', 'stack', 'telemetry']);

/**
 * @typedef {object} StackCommit
 * @property {object[]} [stack]           new stack (defaults to the fresh one)
 * @property {object} [telemetry]         written in the same commit
 * @property {object} [configuration]     written in the same commit (must be derived from the fresh state)
 */

/**
 * @param {{ area?: chrome.storage.StorageArea, lock?: { run: <T>(fn: () => Promise<T>) => Promise<T> } }} [options]
 */
export function createStore({ area = globalThis.chrome?.storage?.local, lock = createStateLock() } = {}) {
  if (!area) throw new Error('createStore: no storage area');

  /**
   * Runs `fn` on a fresh snapshot inside the lock and writes the patch it returns.
   *
   * @param {string|string[]|null} keys   keys to read (null = everything)
   * @param {(fresh: object) => object|null} fn   synchronous; returns a patch or null for no write
   * @returns {Promise<object|null>} the patch that was written
   */
  function mutate(keys, fn) {
    return lock.run(async () => {
      const fresh = (await area.get(keys)) || {};
      const patch = fn(fresh);
      if (patch && typeof patch.then === 'function') {
        throw new TypeError('store.mutate callbacks must be synchronous (no awaits inside the state lock)');
      }
      if (!patch || Object.keys(patch).length === 0) return null;
      await area.set(patch);
      return patch;
    });
  }

  return {
    area,
    lock,

    /** Plain read (no ordering guarantee against queued commits). */
    get(keys) {
      return area.get(keys);
    },

    /** Read ordered after every commit queued so far. */
    snapshot(keys) {
      return lock.run(() => area.get(keys));
    },

    mutate,

    /**
     * @param {(cfg: object) => object|null} fn   receives the fresh configuration; returns the new one or null
     * @returns {Promise<object|null>} the configuration written, or null when nothing changed
     */
    async mutateConfig(fn) {
      let written = null;
      await mutate(['configuration'], (fresh) => {
        const next = fn(fresh.configuration || {});
        if (!next) return null;
        written = next;
        return { configuration: next };
      });
      return written;
    },

    /**
     * Stack commit. metrics.counts is recomputed from the resulting stack and the stack cap applied.
     *
     * @param {(stack: object[], state: object) => object[]|StackCommit|null} fn
     * @returns {Promise<object|null>} the patch written
     */
    mutateStack(fn) {
      return mutate([...STACK_KEYS], (fresh) => {
        const stack = Array.isArray(fresh.stack) ? fresh.stack : [];
        const out = fn(stack, fresh);
        if (!out) return null;
        const commit = Array.isArray(out) ? { stack: out } : out;
        const nextStack = pruneStack(Array.isArray(commit.stack) ? commit.stack : stack);
        const patch = {
          stack: nextStack,
          metrics: { ...(fresh.metrics || {}), counts: computeCounts(nextStack) }
        };
        if (commit.telemetry) patch.telemetry = commit.telemetry;
        if (commit.configuration) patch.configuration = commit.configuration;
        return patch;
      });
    }
  };
}
