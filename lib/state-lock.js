/**
 * state-lock.js
 *
 * Serializes read-modify-write cycles over persisted extension state.
 *
 * Message handlers await slow work (semantic inference) between reading the
 * stack and writing it back. Without serialization each concurrent handler
 * holds a snapshot taken *before* its await, and the last writer clobbers every
 * item added in the meantime — which silently deletes already-collected posts.
 * The failure scales with how long handlers wait, so adding an inference queue
 * turns an occasional race into a reliable one.
 *
 * Inference itself stays concurrent; only the persistence step is serialized.
 * A critical section MUST re-read whatever it mutates from inside the lock —
 * holding the lock does not make a stale snapshot fresh.
 */

/**
 * Creates an independent lock. Each lock serializes its own critical sections.
 *
 * @returns {{ run: <T>(fn: () => Promise<T>) => Promise<T> }}
 */
export function createStateLock() {
  let chain = Promise.resolve();

  return {
    /**
     * Runs `fn` after every previously queued section has settled.
     *
     * A rejecting section does not break the chain — later sections still run.
     * The rejection is still delivered to that section's own caller.
     *
     * @template T
     * @param {() => Promise<T>} fn
     * @returns {Promise<T>}
     */
    run(fn) {
      const result = chain.then(fn, fn);
      chain = result.then(() => {}, () => {});
      return result;
    }
  };
}
