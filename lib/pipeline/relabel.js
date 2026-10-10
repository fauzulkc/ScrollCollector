/**
 * relabel.js
 *
 * Deprecated thin wrapper over lib/pipeline/redecide.js (background.js uses createRedecider()
 * directly and passes it to the handlers as `redecide`); kept for callers of the old relabel
 * interface. The re-decide pass itself — versioned jobs, batches of 32 decided outside the lock,
 * commits by item id, hiddenByPrompt instead of deletion — lives in redecide.js.
 *
 * The returned object is a full redecider (start / schedule / cancel / clearHidden /
 * onSystem1Ready / wait / idle) plus the old interface:
 *  - trigger()  debounced re-decide of every item (scope 'all')
 *  - run()      immediate re-decide of every item; resolves { cancelled, updated }
 */

import { createRedecider } from './redecide.js';

/**
 * @param {Parameters<typeof createRedecider>[0] & { chunkSize?: number }} deps
 *        `chunkSize` is the old name of `batchSize`; `debounceMs` defaults to the redecider's (800 ms)
 */
export function createRelabeler({ chunkSize, ...deps }) {
  const redecider = createRedecider({ ...deps, ...(Number.isFinite(chunkSize) ? { batchSize: chunkSize } : {}) });

  return {
    start: redecider.start,
    schedule: redecider.schedule,
    cancel: redecider.cancel,
    clearHidden: redecider.clearHidden,
    onSystem1Ready: redecider.onSystem1Ready,
    wait: redecider.wait,
    idle: redecider.idle,
    get current() {
      return redecider.current;
    },
    get isScheduled() {
      return redecider.isScheduled;
    },

    /** Debounced trigger (bursts of config edits cause one pass). */
    trigger() {
      redecider.schedule({ scope: 'all', reason: 'relabel' }).catch(() => {});
    },

    /**
     * @returns {Promise<{ cancelled: boolean, updated: number }>}
     */
    async run() {
      const jobId = redecider.start({ scope: 'all', reason: 'relabel' });
      const result = await redecider.wait(jobId);
      return { cancelled: !!(result && result.cancelled), updated: (result && result.updated) || 0 };
    }
  };
}
