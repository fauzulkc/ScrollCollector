import { describe, test, expect, vi, afterEach } from 'vitest';
import { createDecisionCache, cacheKey, DEFAULT_CACHE_SIZE } from '../../lib/decision/cache.js';

function memoryStore(initial) {
  let value = initial;
  return {
    get: vi.fn(async () => value),
    set: vi.fn(async (v) => {
      value = v;
    }),
    peek: () => value
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('decision cache', () => {
  test('keys are specHash:textHash', () => {
    expect(cacheKey('aaaa', 'bbbb')).toBe('aaaa:bbbb');
  });

  test('LRU eviction keeps the most recently used entries', () => {
    const cache = createDecisionCache({ max: 3 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.get('a')).toBe(1); // a becomes most recent
    cache.set('d', 4); // evicts b
    expect(cache.size()).toBe(3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    cache.set('c', 33); // overwrite refreshes recency
    cache.set('e', 5); // evicts d
    expect(cache.get('d')).toBeUndefined();
    expect(cache.get('c')).toBe(33);
  });

  test('defaults to 2000 entries; ignores undefined values', () => {
    expect(DEFAULT_CACHE_SIZE).toBe(2000);
    const cache = createDecisionCache();
    for (let i = 0; i < 2100; i++) cache.set(`k${i}`, i);
    expect(cache.size()).toBe(2000);
    expect(cache.get('k99')).toBeUndefined();
    expect(cache.get('k100')).toBe(100);
    cache.set('x', undefined);
    expect(cache.get('x')).toBeUndefined();
  });

  test('delete and clear', async () => {
    const cache = createDecisionCache();
    cache.set('a', 1);
    cache.set('b', 2);
    cache.delete('a');
    expect(cache.size()).toBe(1);
    await cache.clear();
    expect(cache.size()).toBe(0);
  });

  test('persists with a debounce and restores in LRU order', async () => {
    vi.useFakeTimers();
    const store = memoryStore();
    const cache = createDecisionCache({ max: 3, store, persistDebounceMs: 500 });
    await cache.ready();
    cache.set('a', { v: 1 });
    cache.set('b', { v: 2 });
    expect(store.set).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    await cache.flush(); // nothing pending: just waits for the write
    expect(store.set).toHaveBeenCalledTimes(1);
    expect(store.peek()).toEqual([['a', { v: 1 }], ['b', { v: 2 }]]);

    const restored = createDecisionCache({ max: 3, store });
    restored.set('c', { v: 3 }); // set before the load finished stays most recent
    await restored.ready();
    expect(restored.size()).toBe(3);
    restored.set('d', { v: 4 }); // evicts the oldest restored entry (a)
    expect(restored.get('a')).toBeUndefined();
    expect(restored.get('b')).toEqual({ v: 2 });
    expect(restored.get('c')).toEqual({ v: 3 });
  });

  test('flush writes immediately; clear empties the store', async () => {
    const store = memoryStore();
    const cache = createDecisionCache({ store, persistDebounceMs: 60_000 });
    cache.set('a', 1);
    await cache.flush();
    expect(store.peek()).toEqual([['a', 1]]);
    await cache.clear();
    expect(store.peek()).toEqual([]);
  });

  test('a broken store never throws', async () => {
    const store = { get: async () => { throw new Error('nope'); }, set: async () => { throw new Error('nope'); } };
    const cache = createDecisionCache({ store, persistDebounceMs: 0 });
    await cache.ready();
    cache.set('a', 1);
    await cache.flush();
    expect(cache.get('a')).toBe(1);
  });

  test('ignores malformed persisted entries', async () => {
    const store = memoryStore([['ok', 1], 'junk', [42, 2], ['nullish', null]]);
    const cache = createDecisionCache({ store });
    await cache.ready();
    expect(cache.size()).toBe(1);
    expect(cache.get('ok')).toBe(1);
  });
});
