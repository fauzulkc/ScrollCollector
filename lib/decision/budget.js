/**
 * Escalation budget: a sliding one-minute window kept in memory plus a per-day counter persisted
 * through an injected store (chrome.storage.local in production), so a service-worker restart
 * cannot reset the daily cap.
 *
 * One unit = one escalated post (one provider request).
 */

const MINUTE_MS = 60_000;

/**
 * @typedef {object} BudgetStore
 * @property {() => Promise<{ date: string, count: number }|undefined|null>} get
 * @property {(day: { date: string, count: number }) => Promise<void>} set
 */

/**
 * Local calendar day of `t` as YYYY-MM-DD.
 * @param {number} t
 */
export function dayKey(t) {
  const d = new Date(t);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * Non-negative integer limit; Infinity means unlimited; anything else falls back.
 * @param {unknown} v
 * @param {number} fallback
 */
function normLimit(v, fallback) {
  if (v === Infinity) return Infinity;
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.floor(v);
  return fallback;
}

/**
 * @param {{ perMinute?: number, perDay?: number, now?: () => number, store?: BudgetStore|null }} [opts]
 */
export function createBudget({ perMinute = 30, perDay = 1000, now = Date.now, store = null } = {}) {
  let limits = { perMinute: normLimit(perMinute, 30), perDay: normLimit(perDay, 1000) };
  /** @type {number[]} timestamps of consumptions in the current minute window (ascending) */
  const minute = [];
  let day = { date: dayKey(now()), count: 0 };
  /** @type {Promise<void>|null} */
  let loading = null;
  /** @type {Promise<void>} */
  let writeChain = Promise.resolve();

  /** Loads the persisted daily counter once. */
  function ready() {
    if (!loading) {
      loading = (async () => {
        if (!store) return;
        try {
          const saved = await store.get();
          // tryConsume() awaits this load, so nothing was consumed yet; a stale day is ignored.
          if (saved && typeof saved.date === 'string' && Number.isFinite(saved.count) && saved.date === dayKey(now())) {
            day = { date: saved.date, count: Math.max(0, Math.floor(saved.count)) };
          }
        } catch {
          /* a broken store must not block decisions */
        }
      })();
    }
    return loading;
  }

  /** @param {number} t */
  function roll(t) {
    const key = dayKey(t);
    if (day.date !== key) day = { date: key, count: 0 };
    while (minute.length && minute[0] <= t - MINUTE_MS) minute.shift();
  }

  function persist() {
    if (!store) return;
    const snap = { ...day };
    writeChain = writeChain.then(() => store.set(snap)).catch(() => {});
  }

  /**
   * Consumes `n` units when both windows have room.
   * @param {number} [n]
   * @returns {Promise<boolean>}
   */
  async function tryConsume(n = 1) {
    await ready();
    // Synchronous from here on, so concurrent callers cannot overshoot.
    const t = now();
    roll(t);
    if (minute.length + n > limits.perMinute || day.count + n > limits.perDay) return false;
    for (let i = 0; i < n; i++) minute.push(t);
    day.count += n;
    persist();
    return true;
  }

  /** @param {{ perMinute?: number, perDay?: number }} next */
  function setLimits(next = {}) {
    limits = {
      perMinute: normLimit(next.perMinute, limits.perMinute),
      perDay: normLimit(next.perDay, limits.perDay)
    };
  }

  /** JSON-safe view (null = unlimited). */
  function snapshot() {
    roll(now());
    const fin = (/** @type {number} */ v) => (Number.isFinite(v) ? v : null);
    return {
      perMinute: fin(limits.perMinute),
      perDay: fin(limits.perDay),
      minuteUsed: minute.length,
      dayUsed: day.count,
      date: day.date,
      remainingMinute: fin(Math.max(0, limits.perMinute - minute.length)),
      remainingDay: fin(Math.max(0, limits.perDay - day.count))
    };
  }

  /** Waits for pending writes of the daily counter. */
  async function flush() {
    await writeChain;
  }

  return { tryConsume, setLimits, snapshot, ready, flush };
}
