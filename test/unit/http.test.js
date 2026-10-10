import { describe, test, expect, vi, afterEach } from 'vitest';
import {
  fetchJson,
  DecisionHttpError,
  parseRetryAfter,
  backoffMs,
  codeForStatus,
  createCircuitBreaker,
  createCallStats,
  createCloudCore,
  readProviderSettings,
  secretFingerprint
} from '../../lib/decision/http.js';

const KEY = 'sk-proj-SECRETabcdefghijklmnop1234';

/** fetch stub answering from a queue of [status, body, headers?] (or functions / thrown errors). */
function fakeFetch(...replies) {
  const calls = [];
  const fn = vi.fn(async (url, init) => {
    calls.push({ url, init });
    const next = replies.length > 1 ? replies.shift() : replies[0];
    if (typeof next === 'function') return next(url, init);
    if (next instanceof Error) throw next;
    const [status, body, headers = {}] = next;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  });
  fn.calls = calls;
  return fn;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('fetchJson: success', () => {
  test('encodes the body, sets JSON headers and returns data, status and attempts', async () => {
    const f = fakeFetch([200, { ok: 1 }]);
    const res = await fetchJson('https://api.example/v1/x', { body: { a: 1 }, headers: { authorization: `Bearer ${KEY}` }, fetchImpl: f });
    expect(res).toMatchObject({ data: { ok: 1 }, status: 200, attempts: 1 });
    const init = f.calls[0].init;
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
    expect(init.headers).toMatchObject({ accept: 'application/json', 'content-type': 'application/json' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test('a 2xx without valid JSON is bad_response (body redacted and truncated)', async () => {
    const f = fakeFetch([200, `not json ${KEY} ${'x'.repeat(500)}`]);
    const err = await fetchJson('https://api.example', { fetchImpl: f, redactValues: [KEY] }).catch((e) => e);
    expect(err).toBeInstanceOf(DecisionHttpError);
    expect(err.code).toBe('bad_response');
    expect(err.body.length).toBeLessThanOrEqual(300);
    expect(err.body).not.toContain(KEY);
    expect(err.body).toContain('[REDACTED]');
  });
});

describe('fetchJson: typed errors', () => {
  test.each([
    [401, 'auth_error'],
    [403, 'auth_error'],
    [400, 'bad_request'],
    [422, 'bad_request'],
    [404, 'bad_request'],
    [500, 'server_error'],
    [502, 'server_error']
  ])('HTTP %i -> %s, not retried', async (status, code) => {
    const f = fakeFetch([status, { error: { message: 'nope' } }]);
    const err = await fetchJson('https://api.example', { fetchImpl: f }).catch((e) => e);
    expect(err).toMatchObject({ name: 'DecisionHttpError', code, status, attempts: 1 });
    expect(err.message).toContain(`HTTP ${status}`);
    expect(err.message).toContain('nope');
    expect(f).toHaveBeenCalledTimes(1);
  });

  test('bad_request keeps a redacted, truncated body; others keep none', async () => {
    const body = { error: { message: `bad schema for key ${KEY}`, param: 'response_format' }, pad: 'y'.repeat(800) };
    const err = await fetchJson('https://api.example', { fetchImpl: fakeFetch([422, body]), redactValues: KEY }).catch((e) => e);
    expect(err.code).toBe('bad_request');
    expect(err.body).toContain('response_format');
    expect(err.body.length).toBeLessThanOrEqual(300);
    expect(err.body).not.toContain(KEY);
    expect(err.message).not.toContain(KEY);
    const auth = await fetchJson('https://api.example', { fetchImpl: fakeFetch([401, body]), redactValues: KEY }).catch((e) => e);
    expect(auth.body).toBeNull();
  });

  test('a server that echoes the key never gets it into the message (known value, sk- and Bearer patterns)', async () => {
    const other = 'jev_live_ZZZZZZZZZZZZZZZZ9876';
    const body = { error: { message: `Incorrect API key provided: ${KEY}; header was Bearer ${other}` } };
    const err = await fetchJson('https://api.example', { fetchImpl: fakeFetch([401, body]), redactValues: [KEY] }).catch((e) => e);
    expect(err.code).toBe('auth_error');
    expect(err.message).not.toContain(KEY);
    expect(err.message).not.toContain(other);
    expect(JSON.stringify(err)).not.toContain(KEY);
    expect(String(err.stack)).not.toContain(KEY);
  });

  test('a key cut by the detail truncation is still redacted (redact first, then truncate)', async () => {
    const jev = 'jev_live_SECRET_0123456789abcdefWXYZ';
    const body = { error: { message: `${'x'.repeat(190)}${jev}` } };
    const err = await fetchJson('https://api.example', { fetchImpl: fakeFetch([401, body]), redactValues: [jev] }).catch((e) => e);
    expect(err.message).not.toContain('jev_live_S');
    expect(err.message).toContain('[REDACT');
  });

  test('a fetch TypeError is offline', async () => {
    const err = await fetchJson('https://api.example', { fetchImpl: fakeFetch(new TypeError('Failed to fetch')) }).catch((e) => e);
    expect(err).toMatchObject({ code: 'offline', status: null });
    expect(err.message).toMatch(/could not be reached/);
  });

  test('a missing fetch implementation is offline', async () => {
    const err = await fetchJson('https://api.example', { fetchImpl: /** @type {any} */ ('nope') }).catch((e) => e);
    expect(err.code).toBe('offline');
  });

  test('timeout: the per-attempt AbortController fires', async () => {
    vi.useFakeTimers();
    const f = fakeFetch((url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const p = fetchJson('https://api.example', { fetchImpl: f, timeoutMs: 1000 }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(999);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    const err = await p;
    expect(err).toMatchObject({ code: 'timeout' });
    expect(err.message).toContain('1000 ms');
  });

  test("the caller's signal cancels (aborted, not timeout) and stops retries", async () => {
    const ac = new AbortController();
    const f = fakeFetch((url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const p = fetchJson('https://api.example', { fetchImpl: f, signal: ac.signal }).catch((e) => e);
    ac.abort();
    expect(await p).toMatchObject({ code: 'aborted' });
    const already = await fetchJson('https://api.example', { fetchImpl: f, signal: ac.signal }).catch((e) => e);
    expect(already.code).toBe('aborted');
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('fetchJson: retries', () => {
  test('429 honors retry-after (seconds) before retrying', async () => {
    vi.useFakeTimers();
    const f = fakeFetch([429, { error: 'slow down' }, { 'retry-after': '3' }], [200, { ok: true }]);
    const p = fetchJson('https://api.example', { fetchImpl: f });
    await vi.advanceTimersByTimeAsync(2999);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const res = await p;
    expect(f).toHaveBeenCalledTimes(2);
    expect(res).toMatchObject({ data: { ok: true }, attempts: 2 });
  });

  test('retry-after-ms wins over retry-after', async () => {
    vi.useFakeTimers();
    const f = fakeFetch([529, {}, { 'retry-after-ms': '250', 'retry-after': '30' }], [200, { ok: true }]);
    const p = fetchJson('https://api.example', { fetchImpl: f });
    await vi.advanceTimersByTimeAsync(250);
    expect((await p).attempts).toBe(2);
  });

  test('without retry-after: exponential backoff 500, 1000 (+ jitter), then the typed error', async () => {
    vi.useFakeTimers();
    const f = fakeFetch([503, { error: { message: 'busy' } }]);
    const p = fetchJson('https://api.example', { fetchImpl: f, random: () => 0 }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(499);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f).toHaveBeenCalledTimes(3);
    const err = await p;
    expect(err).toMatchObject({ code: 'overloaded', status: 503, attempts: 3 });
  });

  test('429 after the retries is rate_limited and carries retryAfterMs', async () => {
    const sleep = vi.fn(async () => {});
    const f = fakeFetch([429, {}, { 'retry-after': '2' }]);
    const err = await fetchJson('https://api.example', { fetchImpl: f, sleep, retries: 2 }).catch((e) => e);
    expect(err).toMatchObject({ code: 'rate_limited', status: 429, retryAfterMs: 2000, attempts: 3 });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000, 2000]);
  });

  test('a retry-after longer than maxRetryWaitMs is not waited for', async () => {
    const sleep = vi.fn(async () => {});
    const f = fakeFetch([429, {}, { 'retry-after': '120' }]);
    const err = await fetchJson('https://api.example', { fetchImpl: f, sleep, maxRetryWaitMs: 20000 }).catch((e) => e);
    expect(err).toMatchObject({ code: 'rate_limited', retryAfterMs: 120000, attempts: 1 });
    expect(sleep).not.toHaveBeenCalled();
  });

  test('retries: 0 never retries', async () => {
    const f = fakeFetch([529, {}]);
    const err = await fetchJson('https://api.example', { fetchImpl: f, retries: 0 }).catch((e) => e);
    expect(err.code).toBe('overloaded');
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('helpers', () => {
  test('parseRetryAfter: seconds, ms, HTTP date, junk', () => {
    const h = (o) => new Headers(o);
    expect(parseRetryAfter(h({ 'retry-after': '5' }))).toBe(5000);
    expect(parseRetryAfter(h({ 'retry-after': '1.5' }))).toBe(1500);
    expect(parseRetryAfter(h({ 'retry-after-ms': '42' }))).toBe(42);
    const now = Date.parse('2026-10-10T00:00:00Z');
    expect(parseRetryAfter(h({ 'retry-after': 'Sat, 10 Oct 2026 00:00:10 GMT' }), now)).toBe(10000);
    expect(parseRetryAfter(h({ 'retry-after': 'soon' }))).toBeNull();
    expect(parseRetryAfter(h({}))).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });

  test('backoffMs caps at 8000 plus jitter', () => {
    expect(backoffMs(0, () => 0)).toBe(500);
    expect(backoffMs(1, () => 0)).toBe(1000);
    expect(backoffMs(10, () => 0)).toBe(8000);
    expect(backoffMs(0, () => 0.999)).toBe(749);
  });

  test('codeForStatus', () => {
    expect([401, 403, 400, 422, 429, 503, 529, 500].map(codeForStatus)).toEqual([
      'auth_error', 'auth_error', 'bad_request', 'bad_request', 'rate_limited', 'overloaded', 'overloaded', 'server_error'
    ]);
  });

  test('circuit breaker: auth until the key changes, cooldown after rate limits', () => {
    let t = 1000;
    const c = createCircuitBreaker({ now: () => t, cooldownMs: 60000 });
    const a = secretFingerprint('key-a-0123456789');
    const b = secretFingerprint('key-b-0123456789');
    expect(a).not.toContain('key-a');
    c.record({ code: 'auth_error' }, a);
    expect(c.check(a)).toEqual({ state: 'auth_error' });
    expect(c.check(b)).toBeNull();
    expect(c.check(a)).toBeNull(); // closed once a different key was seen
    c.record({ code: 'overloaded' }, a);
    expect(c.check(a)).toMatchObject({ state: 'rate_limited', code: 'overloaded', until: 61000 });
    t = 60999;
    expect(c.check(a)).not.toBeNull();
    t = 61000;
    expect(c.check(a)).toBeNull();
    c.record({ code: 'rate_limited', retryAfterMs: 300000 }, a);
    expect(c.check(a).until).toBe(361000);
    c.reset();
    expect(c.check(a)).toBeNull();
  });

  test('call stats: avg / p95 over successes, last error, cost', () => {
    const s = createCallStats({ now: () => 5 });
    for (const ms of [10, 20, 30, 40]) s.success(ms, { costUsd: 0.001 });
    s.failure('timeout', 'No response');
    expect(s.snapshot()).toEqual({
      calls: 5, errors: 1, lastLatencyMs: 40, avgMs: 25, p95Ms: 40, lastError: 'No response', lastCode: 'timeout', lastErrorAt: 5, costUsd: 0.004
    });
    s.reset();
    expect(s.snapshot()).toMatchObject({ calls: 0, avgMs: null, p95Ms: null });
    expect(s.snapshot()).not.toHaveProperty('costUsd');
  });

  test('readProviderSettings accepts a configuration or an intelligence object', () => {
    expect(readProviderSettings(null, 'jev')).toMatchObject({ enabled: false, model: 'jev-latest' });
    expect(readProviderSettings({ intelligence: { providers: { jev: { enabled: true } } } }, 'jev')).toMatchObject({ enabled: true, baseUrl: 'https://api.typesafe.ai' });
    expect(readProviderSettings({ providers: { openai: { model: 'm' } } }, 'openai')).toMatchObject({ model: 'm', enabled: false });
  });

  test('cloud core status precedence', async () => {
    let key = null;
    let cfg = { intelligence: { providers: { jev: { enabled: false } } } };
    const core = createCloudCore({ id: 'jev', label: 'TypeSafe Jev', getSecret: async () => key, getConfig: () => cfg });
    expect(core.status().state).toBe('disabled'); // key unknown before the first load
    await core.load();
    expect(core.status().state).toBe('no_key');
    key = KEY;
    await core.load();
    expect(core.status().state).toBe('disabled');
    cfg = { intelligence: { providers: { jev: { enabled: true } } } };
    await core.load();
    expect(core.status().state).toBe('ready');
    const e = core.failed(new DecisionHttpError(`bad key ${KEY}`, { code: 'auth_error', status: 401 }));
    expect(e.message).not.toContain(KEY);
    expect(core.status()).toMatchObject({ state: 'auth_error' });
    expect(JSON.stringify(core.status())).not.toContain(KEY);
    expect(() => core.guard(KEY)).toThrow(/rejected the API key/);
  });
});
