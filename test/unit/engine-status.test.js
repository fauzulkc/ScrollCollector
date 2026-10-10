import { describe, test, expect, vi, afterEach } from 'vitest';
import { createEngineStatus } from '../../lib/decision/engine-status.js';

afterEach(() => {
  vi.useRealTimers();
});

/** Minimal ItemDecision for counting. */
function decision(overrides = {}) {
  return { provider: 'system1', path: ['system1'], escalated: false, latencyMs: 10, collect: true, ...overrides };
}

describe('engine status badge', () => {
  test('checking (grey) until the System 1 status is known', () => {
    const status = createEngineStatus();
    expect(status.snapshot().badge.level).toBe('checking');
    status.update({ nano: { state: 'ready', present: 'sw' } });
    expect(status.snapshot().badge.level).toBe('checking');
    // Loading is its own (amber) level once System 1 reports it.
    status.update({ system1: { state: 'loading', progress: 0.4 } });
    expect(status.snapshot().badge).toMatchObject({ level: 'loading', label: 'Loading 40%' });
  });

  test("System 1 unloaded while idle is 'Idle' (ok, it loads on the next post), not 'Rules only'", () => {
    const status = createEngineStatus();
    const snap = status.update({ system1: { state: 'unavailable', detail: 'not_loaded', model: 'minilm', device: 'wasm' }, escalation: { provider: 'nano', status: { state: 'ready' } } });
    expect(snap.badge).toMatchObject({ level: 'ok', label: 'Idle' });
    expect(snap.badge.title).toMatch(/unloaded while idle/);
    // A degraded escalation provider still shows.
    status.update({ escalation: { provider: 'jev', status: { state: 'auth_error' } } });
    expect(status.snapshot().badge.level).toBe('warn');
    // Unavailable for another reason stays a warning.
    const other = createEngineStatus();
    expect(other.update({ system1: { state: 'unavailable', detail: 's1_unavailable' } }).badge.label).toBe('Rules only');
  });

  test('ok when System 1 is ready', () => {
    const status = createEngineStatus();
    const snap = status.update({ system1: { state: 'ready', model: 'bge-small', device: 'wasm' }, escalation: { provider: 'nano', status: { state: 'ready' } } });
    expect(snap.badge.level).toBe('ok');
    expect(snap.badge.title).toContain('bge-small');
    expect(snap.badge.title).toContain('Gemini Nano');
  });

  test('warn when the escalation provider is degraded', () => {
    const status = createEngineStatus();
    status.update({ system1: { state: 'ready' }, escalation: { provider: 'jev', status: { state: 'ready' } } });
    status.error('jev', Object.assign(new Error('401 Unauthorized'), { code: 'auth_error' }));
    const snap = status.snapshot();
    expect(snap.badge.level).toBe('warn');
    expect(snap.escalation.status).toMatchObject({ state: 'auth_error', lastError: '401 Unauthorized', detail: 'auth_error' });
    expect(snap.providers.jev).toMatchObject({ errors: 1, lastCode: 'auth_error' });

    // rate limits and offline too; a timeout is only recorded
    const s2 = createEngineStatus();
    s2.update({ system1: { state: 'ready' }, escalation: { provider: 'openai', status: { state: 'ready' } } });
    s2.error('openai', Object.assign(new Error('timeout'), { code: 'timeout' }));
    expect(s2.snapshot().badge.level).toBe('ok');
    s2.error('openai', Object.assign(new Error('529'), { code: 'overloaded' }));
    expect(s2.snapshot().escalation.status.state).toBe('rate_limited');
    expect(s2.snapshot().badge.level).toBe('warn');
  });

  test('a successful escalation clears a degraded escalation state', () => {
    const status = createEngineStatus();
    status.update({ system1: { state: 'ready' }, escalation: { provider: 'jev', status: { state: 'ready' } } });
    status.error('jev', { code: 'rate_limited', message: 'slow down' });
    expect(status.snapshot().badge.level).toBe('warn');
    status.count(decision({ provider: 'jev', path: ['system1', 'jev'], escalated: true }));
    expect(status.snapshot().escalation.status.state).toBe('ready');
    expect(status.snapshot().badge.level).toBe('ok');
  });

  test('warn when System 1 is unavailable but rules (or an escalator) keep working', () => {
    const status = createEngineStatus();
    status.update({ system1: { state: 'unavailable' } });
    expect(status.snapshot().badge).toMatchObject({ level: 'warn', label: 'Rules only' });
    status.update({ escalation: { provider: 'nano', status: { state: 'ready' } } });
    expect(status.snapshot().badge).toMatchObject({ level: 'warn', label: 'Using Gemini Nano' });
    status.update({ system1: { state: 'error', lastError: 'wasm failed' } });
    expect(status.snapshot().badge.level).toBe('warn'); // error, but an escalator takes over
  });

  test('error when System 1 failed and no escalator can take over', () => {
    const status = createEngineStatus();
    status.update({ system1: { state: 'error', lastError: 'wasm failed' }, escalation: { provider: 'none' } });
    expect(status.snapshot().badge).toMatchObject({ level: 'error' });
    expect(status.snapshot().badge.title).toContain('wasm failed');
    status.update({ escalation: { provider: 'jev', status: { state: 'no_key' } } });
    expect(status.snapshot().badge.level).toBe('error');
  });

  test('system1 errors from the cascade are recorded without changing its state', () => {
    const status = createEngineStatus();
    status.update({ system1: { state: 'ready' } });
    status.error('system1', Object.assign(new Error('offscreen timed out'), { code: 's1_timeout' }));
    const snap = status.snapshot();
    expect(snap.system1).toMatchObject({ state: 'ready', lastError: 'offscreen timed out' });
    expect(snap.providers.system1).toMatchObject({ errors: 1, lastCode: 's1_timeout' });
  });
});

describe('engine status counters', () => {
  test('decided, bySource, escalated, escalationRate, cacheHits', () => {
    const status = createEngineStatus();
    status.count(decision());
    status.count(decision({ provider: 'nano', path: ['system1', 'nano'], escalated: true }));
    status.count(decision({ path: ['system1', 'cache'] }));
    status.count(decision({ provider: 'prefilter', path: ['prefilter'] }));
    const c = status.snapshot().counters;
    expect(c).toMatchObject({ decided: 4, escalated: 1, escalationRate: 0.25, cacheHits: 1 });
    expect(c.bySource).toEqual({ system1: 2, nano: 1, prefilter: 1 });
    expect(status.snapshot().providers.system1.calls).toBe(3);
  });

  test('avgMs and p95Ms over a 200-sample ring', () => {
    const status = createEngineStatus();
    for (let i = 1; i <= 100; i++) status.count(decision({ latencyMs: i }));
    let c = status.snapshot().counters;
    expect(c.avgMs).toBe(50.5);
    expect(c.p95Ms).toBe(95);
    // 200 more samples of 1000 ms push the old ones out of the ring
    for (let i = 0; i < 200; i++) status.count(decision({ latencyMs: 1000 }));
    c = status.snapshot().counters;
    expect(c.avgMs).toBe(1000);
    expect(c.p95Ms).toBe(1000);
    expect(c.decided).toBe(300);
  });

  test('resetCounters clears counters and provider stats', () => {
    const status = createEngineStatus();
    status.count(decision());
    status.error('jev', { code: 'auth_error', message: 'x' });
    status.resetCounters();
    const snap = status.snapshot();
    expect(snap.counters).toMatchObject({ decided: 0, escalated: 0, avgMs: 0, p95Ms: 0 });
    expect(snap.providers).toEqual({});
  });
});

describe('engine status push', () => {
  test('throttled push carries the latest snapshot', async () => {
    vi.useFakeTimers();
    const push = vi.fn();
    const status = createEngineStatus({ push, debounceMs: 250 });
    status.update({ system1: { state: 'ready' } });
    for (let i = 0; i < 20; i++) status.count(decision());
    expect(push).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0].counters.decided).toBe(20);
    expect(push.mock.calls[0][0].badge.level).toBe('ok');
    status.count(decision());
    await vi.advanceTimersByTimeAsync(250);
    expect(push).toHaveBeenCalledTimes(2);
  });

  test('flush pushes now; a throwing or rejecting push is swallowed', async () => {
    const push = vi.fn(() => Promise.reject(new Error('no receiver')));
    const status = createEngineStatus({ push, debounceMs: 10_000 });
    status.update({ warnings: ['empty_prompt', 3] });
    status.flush();
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0].warnings).toEqual(['empty_prompt']);
    const throwing = createEngineStatus({ push: () => { throw new Error('boom'); } });
    expect(() => throwing.flush()).not.toThrow();
    status.dispose();
  });

  test('snapshots are copies', () => {
    const status = createEngineStatus();
    const snap = status.snapshot();
    snap.counters.decided = 99;
    expect(status.snapshot().counters.decided).toBe(0);
    expect(typeof snap.updatedAt).toBe('number');
  });
});
