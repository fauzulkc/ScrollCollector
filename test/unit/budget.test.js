import { describe, test, expect } from 'vitest';
import { createBudget, dayKey } from '../../lib/decision/budget.js';

function memoryStore(initial) {
  let value = initial;
  const writes = [];
  return {
    writes,
    get: async () => value,
    set: async (v) => {
      value = { ...v };
      writes.push({ ...v });
    },
    peek: () => value
  };
}

describe('escalation budget', () => {
  test('sliding one-minute window', async () => {
    let t = Date.UTC(2026, 9, 10, 12, 0, 0);
    const budget = createBudget({ perMinute: 2, perDay: 100, now: () => t });
    expect(await budget.tryConsume()).toBe(true);
    t += 20_000;
    expect(await budget.tryConsume()).toBe(true);
    t += 20_000;
    expect(await budget.tryConsume()).toBe(false); // 2 in the last 60 s
    t += 20_001; // the first one is now older than 60 s
    expect(await budget.tryConsume()).toBe(true);
    expect(await budget.tryConsume()).toBe(false);
    expect(budget.snapshot()).toMatchObject({ perMinute: 2, minuteUsed: 2, dayUsed: 3, remainingMinute: 0, remainingDay: 97 });
  });

  test('daily cap and rollover at local midnight', async () => {
    let t = new Date(2026, 9, 10, 23, 59, 0).getTime();
    const budget = createBudget({ perMinute: 100, perDay: 2, now: () => t });
    expect(await budget.tryConsume()).toBe(true);
    expect(await budget.tryConsume()).toBe(true);
    expect(await budget.tryConsume()).toBe(false);
    t = new Date(2026, 9, 11, 0, 0, 30).getTime();
    expect(await budget.tryConsume()).toBe(true);
    expect(budget.snapshot()).toMatchObject({ date: '2026-10-11', dayUsed: 1 });
  });

  test('persists the daily counter and restores it after a restart', async () => {
    const t = new Date(2026, 9, 10, 9, 0, 0).getTime();
    const store = memoryStore();
    const first = createBudget({ perDay: 3, now: () => t, store });
    expect(await first.tryConsume()).toBe(true);
    expect(await first.tryConsume()).toBe(true);
    await first.flush();
    expect(store.peek()).toEqual({ date: dayKey(t), count: 2 });

    const restarted = createBudget({ perDay: 3, now: () => t, store });
    expect(await restarted.tryConsume()).toBe(true);
    expect(await restarted.tryConsume()).toBe(false);
  });

  test("ignores a persisted counter from another day and a broken store", async () => {
    const t = new Date(2026, 9, 10, 9, 0, 0).getTime();
    const stale = createBudget({ perDay: 1, now: () => t, store: memoryStore({ date: '2026-10-09', count: 50 }) });
    expect(await stale.tryConsume()).toBe(true);

    const broken = createBudget({
      perDay: 1,
      now: () => t,
      store: { get: async () => { throw new Error('quota'); }, set: async () => { throw new Error('quota'); } }
    });
    expect(await broken.tryConsume()).toBe(true);
    expect(await broken.tryConsume()).toBe(false);
    await broken.flush(); // write errors are swallowed
  });

  test('concurrent callers never overshoot', async () => {
    const budget = createBudget({ perMinute: 3, perDay: 100, now: () => 1_000 });
    const results = await Promise.all(Array.from({ length: 10 }, () => budget.tryConsume()));
    expect(results.filter(Boolean)).toHaveLength(3);
  });

  test('setLimits, zero and unlimited', async () => {
    const budget = createBudget({ perMinute: 0, perDay: 10, now: () => 1_000 });
    expect(await budget.tryConsume()).toBe(false);
    budget.setLimits({ perMinute: Infinity });
    expect(await budget.tryConsume()).toBe(true);
    expect(budget.snapshot()).toMatchObject({ perMinute: null, remainingMinute: null, perDay: 10 });
    budget.setLimits({ perMinute: 'lots', perDay: -1 }); // invalid values keep the current limits
    expect(budget.snapshot()).toMatchObject({ perMinute: null, perDay: 10 });
  });

  test('dayKey is the local calendar day', () => {
    expect(dayKey(new Date(2026, 0, 5, 1, 2, 3).getTime())).toBe('2026-01-05');
  });
});
