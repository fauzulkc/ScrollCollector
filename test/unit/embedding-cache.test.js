import { describe, test, expect, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createEmbeddingCache, embeddingKey, DB_NAME } from '../../offscreen/embedding-cache.js';

const vec = (seed, n = 8) => Float32Array.from({ length: n }, (_, i) => Math.sin(seed * 31 + i));

/** Monotonic fake clock. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, tick: (ms = 1) => (t += ms) };
}

describe('embeddingKey', () => {
  test('is <model>:<dtype>:<textHash>', () => {
    expect(embeddingKey('minilm', 'q8', 'abcd')).toBe('minilm:q8:abcd');
  });
});

describe('createEmbeddingCache (IndexedDB)', () => {
  test('stores and returns Float32Array vectors; misses are null', async () => {
    const idb = new IDBFactory();
    const cache = createEmbeddingCache({ indexedDB: idb });
    await cache.setMany([
      { key: 'k1', vector: vec(1) },
      { key: 'k2', vector: Array.from(vec(2)) }
    ]);
    const [a, b, c] = await cache.getMany(['k1', 'k2', 'nope']);
    expect(a).toBeInstanceOf(Float32Array);
    expect(Array.from(a)).toEqual(Array.from(vec(1)));
    expect(Array.from(b)).toEqual(Array.from(vec(2)));
    expect(c).toBeNull();
    expect(await cache.size()).toBe(2);
    expect(cache.stats()).toMatchObject({ backend: 'indexeddb', hits: 2, misses: 1, writes: 2 });
    await cache.close();
  });

  test('persists across instances of the same database (a re-created offscreen document)', async () => {
    const idb = new IDBFactory();
    const first = createEmbeddingCache({ indexedDB: idb });
    await first.setMany([{ key: 'minilm:q8:aa', vector: vec(3) }]);
    await first.close();
    const second = createEmbeddingCache({ indexedDB: idb, memoryEntries: 1 });
    const [v] = await second.getMany(['minilm:q8:aa']);
    expect(Array.from(v)).toEqual(Array.from(vec(3)));
    await second.close();
    // Same database name as the host uses.
    const third = createEmbeddingCache({ indexedDB: idb, dbName: DB_NAME });
    expect(await third.size()).toBe(1);
    await third.close();
  });

  test('evicts the least recently used entries beyond maxEntries (a hit refreshes an entry)', async () => {
    const c = clock();
    const cache = createEmbeddingCache({ indexedDB: new IDBFactory(), maxEntries: 10, memoryEntries: 1, touchAfterMs: 0, now: c.now });
    for (let i = 0; i < 20; i++) {
      c.tick();
      await cache.setMany([{ key: `k${i}`, vector: vec(i) }]);
    }
    // Read the two oldest so they become the most recently used.
    c.tick();
    await cache.getMany(['k0']);
    c.tick();
    await cache.getMany(['k1']);
    await cache.prune();
    expect(await cache.size()).toBe(10);
    const keys = Array.from({ length: 20 }, (_, i) => `k${i}`);
    const got = await cache.getMany(keys);
    const present = keys.filter((_, i) => got[i]);
    expect(present.sort()).toEqual(['k0', 'k1', 'k12', 'k13', 'k14', 'k15', 'k16', 'k17', 'k18', 'k19'].sort());
    expect(cache.stats().pruned).toBe(10);
    await cache.close();
  });

  test('prunes automatically once the store grows past maxEntries plus a small slack', async () => {
    const c = clock();
    const cache = createEmbeddingCache({ indexedDB: new IDBFactory(), maxEntries: 10, memoryEntries: 1, now: c.now });
    for (let i = 0; i < 111; i++) {
      c.tick();
      await cache.setMany([{ key: `k${i}`, vector: vec(i) }]);
    }
    expect(await cache.size()).toBe(10);
    const [newest, oldest] = await cache.getMany(['k110', 'k0']);
    expect(newest).not.toBeNull();
    expect(oldest).toBeNull();
    await cache.close();
  });

  test('clear() empties memory and IndexedDB', async () => {
    const cache = createEmbeddingCache({ indexedDB: new IDBFactory() });
    await cache.setMany([{ key: 'k', vector: vec(1) }]);
    await cache.clear();
    expect(await cache.getMany(['k'])).toEqual([null]);
    expect(await cache.size()).toBe(0);
    await cache.close();
  });

  test('ignores malformed entries', async () => {
    const cache = createEmbeddingCache({ indexedDB: new IDBFactory() });
    await cache.setMany([{ key: '', vector: vec(1) }, { key: 'x', vector: null }, null, { key: 'ok', vector: vec(2) }]);
    expect(await cache.size()).toBe(1);
    await cache.close();
  });
});

describe('createEmbeddingCache (memory fallback)', () => {
  test('works without IndexedDB and stays bounded at maxEntries', async () => {
    const cache = createEmbeddingCache({ indexedDB: null, maxEntries: 3 });
    await cache.setMany([1, 2, 3, 4].map((i) => ({ key: `k${i}`, vector: vec(i) })));
    const got = await cache.getMany(['k1', 'k2', 'k3', 'k4']);
    expect(got[0]).toBeNull();
    expect(got.slice(1).every(Boolean)).toBe(true);
    expect(await cache.size()).toBe(3);
    expect(cache.stats().backend).toBe('memory');
  });

  test('falls back to memory when IndexedDB fails, reporting the error once and never throwing', async () => {
    const onError = vi.fn();
    const broken = { open: () => { throw new Error('blocked'); } };
    const cache = createEmbeddingCache({ indexedDB: /** @type {any} */ (broken), onError });
    await cache.setMany([{ key: 'k', vector: vec(1) }]);
    const [v] = await cache.getMany(['k']);
    expect(Array.from(v)).toEqual(Array.from(vec(1)));
    await cache.clear();
    expect(await cache.size()).toBe(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(cache.stats().backend).toBe('memory');
  });
});
