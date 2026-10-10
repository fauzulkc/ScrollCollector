/**
 * Persistent embedding cache for the offscreen System 1 host.
 *
 * IndexedDB database 'sc-embeddings', object store 'vectors' with records
 * { key, v: Float32Array, at } and an index on `at` (last access). Keys are
 * '<model>:<dtype>:<textHash>' (embeddingKey()): every text is embedded alone (one text per model
 * call), so a text's vector never depends on what else was embedded and caching per text is exact.
 *
 *  - LRU bounded at `maxEntries` (default 5,000 ~ 7.5 MB of 384-d float32): `at` is refreshed on a
 *    hit (at most once per `touchAfterMs`), and once the store grows past the bound the oldest
 *    entries are deleted.
 *  - A small in-memory LRU sits in front of IndexedDB (corpus and label vectors are read on every
 *    new spec).
 *  - When IndexedDB is missing or fails (private profile, quota, a broken database) the cache keeps
 *    working in memory only (`maxEntries` there too) and never throws to the caller.
 */

export const DB_NAME = 'sc-embeddings';
export const STORE_NAME = 'vectors';
const DB_VERSION = 1;
export const DEFAULT_MAX_ENTRIES = 5000;
const DEFAULT_MEMORY_ENTRIES = 1000;
/** Prune once the store is this far over the bound (avoids a count/prune per write). */
const PRUNE_SLACK = 100;

/**
 * @param {string} model
 * @param {string} dtype
 * @param {string} textHash   lib/decision/state.js textHash() of the exact embedded text
 */
export function embeddingKey(model, dtype, textHash) {
  return `${model}:${dtype}:${textHash}`;
}

/**
 * @template T
 * @param {IDBRequest<T>} req
 * @returns {Promise<T>}
 */
function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** @param {IDBTransaction} tx */
function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

/** @param {unknown} v @returns {Float32Array|null} */
function asVector(v) {
  if (v instanceof Float32Array) return v;
  if (Array.isArray(v) && v.length) return Float32Array.from(v);
  return null;
}

/**
 * @param {{
 *   indexedDB?: IDBFactory|null,
 *   dbName?: string,
 *   maxEntries?: number,
 *   memoryEntries?: number,
 *   touchAfterMs?: number,
 *   now?: () => number,
 *   onError?: (err: unknown) => void
 * }} [opts]
 */
export function createEmbeddingCache({
  indexedDB = globalThis.indexedDB ?? null,
  dbName = DB_NAME,
  maxEntries = DEFAULT_MAX_ENTRIES,
  memoryEntries = DEFAULT_MEMORY_ENTRIES,
  touchAfterMs = 60000,
  now = Date.now,
  onError = (err) => console.warn('[embedding-cache] IndexedDB unavailable, caching in memory only:', err)
} = {}) {
  const max = Math.max(1, maxEntries);
  /** @type {Map<string, Float32Array>} insertion order = LRU order */
  const memory = new Map();
  /** @type {Promise<IDBDatabase|null>|null} */
  let dbPromise = null;
  let failed = !indexedDB;
  /** Entries written since the last exact count (upper bound of the store size). */
  let approxSize = 0;
  const counters = { hits: 0, misses: 0, writes: 0, pruned: 0 };

  const memoryCap = () => (failed ? max : Math.min(max, Math.max(1, memoryEntries)));

  /** @param {string} key @param {Float32Array} v */
  function remember(key, v) {
    memory.delete(key);
    memory.set(key, v);
    const cap = memoryCap();
    while (memory.size > cap) memory.delete(memory.keys().next().value);
  }

  /** @param {unknown} err */
  function fail(err) {
    if (!failed) {
      failed = true;
      try {
        onError(err);
      } catch {
        /* logging only */
      }
    }
    return null;
  }

  /** @returns {Promise<IDBDatabase|null>} */
  function open() {
    if (failed || !indexedDB) return Promise.resolve(null);
    if (!dbPromise) {
      dbPromise = (async () => {
        const req = indexedDB.open(dbName, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
            store.createIndex('at', 'at');
          }
        };
        const db = await request(req);
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        approxSize = await request(db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).count());
        return db;
      })().catch(fail);
    }
    return dbPromise;
  }

  /**
   * Vectors for keys, null where missing. Never rejects.
   * @param {string[]} keys
   * @returns {Promise<(Float32Array|null)[]>}
   */
  async function getMany(keys) {
    const list = Array.isArray(keys) ? keys.map(String) : [];
    /** @type {(Float32Array|null)[]} */
    const out = list.map(() => null);
    /** @type {number[]} */
    const missing = [];
    list.forEach((key, i) => {
      const v = memory.get(key);
      if (v) {
        remember(key, v);
        out[i] = v;
      } else {
        missing.push(i);
      }
    });
    if (missing.length) {
      const db = await open();
      if (db) {
        try {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          const store = tx.objectStore(STORE_NAME);
          const t = now();
          await Promise.all(
            missing.map(async (i) => {
              const rec = await request(store.get(list[i]));
              const v = asVector(rec?.v);
              if (!v) return;
              out[i] = v;
              remember(list[i], v);
              if (!(t - (rec.at || 0) < touchAfterMs)) store.put({ ...rec, at: t });
            })
          );
          await done(tx);
        } catch (err) {
          fail(err);
        }
      }
    }
    for (const v of out) {
      if (v) counters.hits += 1;
      else counters.misses += 1;
    }
    return out;
  }

  /**
   * Stores vectors. Never rejects.
   * @param {{ key: string, vector: Float32Array|number[] }[]} entries
   */
  async function setMany(entries) {
    const list = (Array.isArray(entries) ? entries : [])
      .map((e) => ({ key: String(e?.key ?? ''), v: asVector(e?.vector) }))
      .filter((e) => e.key && e.v);
    if (!list.length) return;
    for (const e of list) remember(e.key, /** @type {Float32Array} */ (e.v));
    counters.writes += list.length;
    const db = await open();
    if (!db) return;
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const t = now();
      for (const e of list) store.put({ key: e.key, v: e.v, at: t });
      await done(tx);
      approxSize += list.length;
      if (approxSize > max + PRUNE_SLACK) await prune();
    } catch (err) {
      fail(err);
    }
  }

  /** Deletes the least recently used entries beyond `maxEntries`. */
  async function prune() {
    const db = await open();
    if (!db) return;
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const count = await request(store.count());
      let excess = count - max;
      if (excess > 0) {
        await new Promise((resolve, reject) => {
          const cursorReq = store.index('at').openCursor();
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (!cursor || excess <= 0) {
              resolve(undefined);
              return;
            }
            memory.delete(cursor.primaryKey);
            cursor.delete();
            counters.pruned += 1;
            excess -= 1;
            cursor.continue();
          };
          cursorReq.onerror = () => reject(cursorReq.error);
        });
      }
      await done(tx);
      approxSize = Math.min(count, max);
    } catch (err) {
      fail(err);
    }
  }

  /** Removes every cached vector. Never rejects. */
  async function clear() {
    memory.clear();
    const db = await open();
    if (!db) return;
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      await done(tx);
      approxSize = 0;
    } catch (err) {
      fail(err);
    }
  }

  /** Number of stored vectors (IndexedDB count, or the memory size without IndexedDB). */
  async function size() {
    const db = await open();
    if (!db) return memory.size;
    try {
      return await request(db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).count());
    } catch (err) {
      fail(err);
      return memory.size;
    }
  }

  async function close() {
    const db = dbPromise ? await dbPromise : null;
    dbPromise = null;
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }

  return {
    getMany,
    setMany,
    prune,
    clear,
    size,
    close,
    stats: () => ({ backend: failed ? 'memory' : 'indexeddb', ...counters, memoryEntries: memory.size })
  };
}
