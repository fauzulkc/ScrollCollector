/**
 * LRU of decision answers keyed `specHash:textHash`, optionally mirrored to an injected async store
 * (chrome.storage.session in production) so a service-worker restart keeps recent decisions.
 *
 * Values are treated as immutable: callers store fresh objects and copy what they read.
 */

export const DEFAULT_CACHE_SIZE = 2000;

/**
 * @typedef {object} CacheStore
 * @property {() => Promise<[string, any][]|undefined|null>} get   entries, least recently used first
 * @property {(entries: [string, any][]) => Promise<void>} set
 */

/**
 * @param {string} specHash
 * @param {string} textHash
 */
export function cacheKey(specHash, textHash) {
  return `${specHash}:${textHash}`;
}

/**
 * @param {{ max?: number, store?: CacheStore|null, persistDebounceMs?: number }} [opts]
 */
export function createDecisionCache({ max = DEFAULT_CACHE_SIZE, store = null, persistDebounceMs = 1000 } = {}) {
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : DEFAULT_CACHE_SIZE;
  /** @type {Map<string, any>} insertion order = recency (oldest first) */
  let map = new Map();
  /** @type {Promise<void>|null} */
  let loading = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null;
  /** @type {Promise<void>} */
  let writeChain = Promise.resolve();
  /** Lookup counters for diagnostics (GET_DIAGNOSTICS cache: { size, hits, misses }). */
  let hits = 0;
  let misses = 0;

  function evict() {
    while (map.size > limit) map.delete(map.keys().next().value);
  }

  /** Loads persisted entries once; entries set meanwhile stay the most recent. */
  function ready() {
    if (!loading) {
      loading = (async () => {
        if (!store) return;
        try {
          const saved = await store.get();
          if (!Array.isArray(saved)) return;
          const next = new Map();
          for (const entry of saved) {
            if (Array.isArray(entry) && typeof entry[0] === 'string' && entry[1] != null && !map.has(entry[0])) {
              next.set(entry[0], entry[1]);
            }
          }
          for (const [k, v] of map) next.set(k, v);
          map = next;
          evict();
        } catch {
          /* start empty */
        }
      })();
    }
    return loading;
  }

  function persistNow() {
    if (!store) return writeChain;
    const entries = [...map.entries()];
    writeChain = writeChain.then(() => store.set(entries)).catch(() => {});
    return writeChain;
  }

  function schedulePersist() {
    if (!store || timer) return;
    timer = setTimeout(() => {
      timer = null;
      persistNow();
    }, persistDebounceMs);
  }

  /**
   * @param {string} key
   * @returns {any} the cached value (refreshing its recency) or undefined
   */
  function get(key) {
    if (!map.has(key)) {
      misses += 1;
      return undefined;
    }
    hits += 1;
    const value = map.get(key);
    map.delete(key);
    map.set(key, value);
    return value;
  }

  /**
   * @param {string} key
   * @param {any} value
   */
  function set(key, value) {
    if (typeof key !== 'string' || value === undefined) return;
    map.delete(key);
    map.set(key, value);
    evict();
    schedulePersist();
  }

  /** @param {string} key */
  function remove(key) {
    if (map.delete(key)) schedulePersist();
  }

  /** Empties memory and the persisted copy. */
  async function clear() {
    map.clear();
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    await persistNow();
  }

  /** Writes pending changes now. */
  async function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      await persistNow();
    }
    await writeChain;
  }

  /** @returns {{ size: number, hits: number, misses: number }} */
  function stats() {
    return { size: map.size, hits, misses };
  }

  /** Clears the lookup counters (RESET_DIAGNOSTICS); the entries stay. */
  function resetStats() {
    hits = 0;
    misses = 0;
  }

  return { get, set, delete: remove, clear, size: () => map.size, ready, flush, stats, resetStats };
}
