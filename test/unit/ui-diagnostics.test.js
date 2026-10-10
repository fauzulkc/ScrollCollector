// @vitest-environment happy-dom
/**
 * ui/diagnostics.js: GET_DIAGNOSTICS rendering, copy without secrets, re-decide progress,
 * reset, and graceful handling of a background without these handlers.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { diagnosticsStats, providerRows, rejectedRows, diagnosticsForCopy, redecideText, mountDiagnostics } from '../../ui/diagnostics.js';
import { MSG } from '../../lib/messages.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

function diag(overrides = {}) {
  return {
    success: true,
    engineStatus: {
      badge: { level: 'ok', label: 'Ready', title: '' },
      system1: { state: 'ready', model: 'minilm' },
      nano: { state: 'downloadable', present: 'sw' },
      escalation: { provider: 'jev', status: { state: 'rate_limited' } },
      counters: { decided: 120, escalated: 12, escalationRate: 0.1, avgMs: 8.4, p95Ms: 31, cacheHits: 4 }
    },
    rejected: [
      { at: 1, platform: 'linkedin.com', snippet: 'Michelin tyres are great for winter driving', pMatch: 0.12, path: ['system1'], reason: null },
      { at: 2, platform: 'x.com', snippet: '<b>bold</b>', pMatch: 0.4, path: ['system1', 'jev'], reason: 'budget_exceeded' }
    ],
    budget: { perMinute: 30, perDay: 1000, minuteUsed: 1, dayUsed: 42, remainingDay: 958 },
    cache: { size: 10, hits: 30, misses: 10 },
    providers: {
      system1: { model: 'minilm', device: 'wasm', loadMs: 2100, lastLatencyMs: 6, calls: 120, avgMs: 7.5, p95Ms: 20, lastError: null },
      nano: { calls: 0 },
      jev: { calls: 12, avgMs: 300, p95Ms: 650, costUsd: 0.000123, lastError: 'HTTP 429 Bearer abcdefghijklmnopqr' },
      openai: { calls: 0, costUsd: 0.5 }
    },
    secrets: { jev: { set: true, last4: 'wxyz' }, openai: { set: false, last4: null } },
    ...overrides
  };
}

describe('pure views', () => {
  test('stats tiles', () => {
    const stats = Object.fromEntries(diagnosticsStats(diag()).map((s) => [s.label, s.value]));
    expect(stats).toMatchObject({
      Decided: '120',
      Escalated: '10.0% (12)',
      'Cache hits': '75% of 40',
      'Avg / p95': '8 ms / 31 ms',
      'Escalations today': '42 / 1000',
      'Est. cost': '$0.50'
    });
    expect(diagnosticsStats(null).every((s) => s.value === '—')).toBe(true);
  });

  test('provider rows with status, latency, cost and redacted errors', () => {
    const rows = providerRows(diag());
    expect(rows.map((r) => r.id)).toEqual(['system1', 'nano', 'jev', 'openai']);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId.system1).toMatchObject({ status: 'Ready', tone: 'ok', calls: 120, avgMs: 7.5, model: 'minilm' });
    expect(byId.nano.status).toBe('Not downloaded');
    expect(byId.jev).toMatchObject({ status: 'Rate limited', tone: 'warn', costUsd: 0.000123 });
    expect(byId.jev.lastError).not.toContain('abcdefghijklmnopqr');
    expect(byId.openai.status).toBe('Off');
  });

  test('rejected rows: snippet <= 140, p, path labels, reason text', () => {
    const rows = rejectedRows(diag({ rejected: [{ snippet: 'x'.repeat(300), pMatch: 0.123, path: ['system1', 'openai'], reason: 'cloud_not_allowed', platform: 'linkedin.com' }] }));
    expect(rows[0].snippet).toHaveLength(140);
    expect(rows[0]).toMatchObject({ p: '0.12', path: 'System 1 → OpenAI', reason: 'cloud provider not allowed' });
    expect(rejectedRows({ rejected: Array.from({ length: 80 }, () => ({})) })).toHaveLength(50);
  });

  test('copy JSON has no key material', () => {
    const text = diagnosticsForCopy(diag(), { version: '0.9.0', intelligence: { escalation: { provider: 'jev' } }, now: 0 });
    const parsed = JSON.parse(text);
    expect(parsed.secrets).toEqual({ jev: { set: true }, openai: { set: false } });
    expect(text).not.toContain('wxyz');
    expect(text).not.toContain('abcdefghijklmnopqr');
    expect(parsed).toMatchObject({ kind: 'scrollcollector.diagnostics/v1', version: '0.9.0', generatedAt: '1970-01-01T00:00:00.000Z' });
    expect(parsed.success).toBeUndefined();
  });

  test('redecideText', () => {
    expect(redecideText({ done: 3, total: 10, hidden: 1 })).toBe('Re-checking 3 of 10 · 1 hidden…');
    expect(redecideText({ done: 10, total: 10, hidden: 2, finished: true })).toBe('Re-check finished: 10 posts, 2 hidden by the prompt.');
  });
});

describe('mountDiagnostics', () => {
  let root;
  let sent;
  let toasts;
  let replies;

  function mount(extra = {}) {
    document.body.innerHTML = '<div id="root"></div>';
    root = document.getElementById('root');
    sent = [];
    toasts = [];
    const send = vi.fn(async (type, payload) => {
      sent.push({ type, payload });
      const r = replies[type];
      return typeof r === 'function' ? r(payload) : r;
    });
    return mountDiagnostics(root, { send, toast: { show: (o) => toasts.push(o) }, refreshMs: 0, ...extra });
  }

  beforeEach(() => {
    replies = {
      [MSG.GET_DIAGNOSTICS]: diag(),
      [MSG.REDECIDE_STACK]: { success: true, jobId: 'job-1' },
      [MSG.RESET_DIAGNOSTICS]: { success: true }
    };
  });

  test('refresh renders providers and rejected posts as text', async () => {
    const onDiagnostics = vi.fn();
    const ui = mount({ onDiagnostics });
    const reply = await ui.refresh();
    expect(reply.secrets.jev.set).toBe(true);
    expect(onDiagnostics).toHaveBeenCalledTimes(1);
    expect(root.querySelectorAll('.diag-provider')).toHaveLength(4);
    expect(root.querySelectorAll('.diag-rejected-row')).toHaveLength(2);
    expect(root.querySelector('#diag-rejected').querySelector('b')).toBeNull();
    expect(root.textContent).toContain('<b>bold</b>');
    expect(root.querySelector('#diag-unavailable').classList.contains('hidden')).toBe(true);
  });

  test('a background without GET_DIAGNOSTICS shows a note instead of failing', async () => {
    replies[MSG.GET_DIAGNOSTICS] = { success: false, error: 'Unknown message type' };
    const ui = mount();
    expect(await ui.refresh()).toBeNull();
    expect(root.querySelector('#diag-unavailable').classList.contains('hidden')).toBe(false);
  });

  test('Re-decide stack sends { scope: "all" } and follows REDECIDE_PROGRESS', async () => {
    const ui = mount();
    const btn = root.querySelector('#diag-redecide');
    btn.click();
    await flush();
    expect(sent).toContainEqual({ type: MSG.REDECIDE_STACK, payload: { scope: 'all' } });
    expect(btn.disabled).toBe(true);
    ui.onRedecideProgress({ jobId: 'job-1', done: 5, total: 20, hidden: 1, finished: false });
    expect(root.querySelector('#diag-redecide-progress .progress-fill').style.width).toBe('25%');
    expect(root.querySelector('#diag-redecide-text').textContent).toBe('Re-checking 5 of 20 · 1 hidden…');
    ui.onRedecideProgress({ jobId: 'job-1', done: 20, total: 20, hidden: 3, finished: true });
    expect(btn.disabled).toBe(false);
    expect(root.querySelector('#diag-redecide-progress').classList.contains('hidden')).toBe(true);
  });

  test('Reset counters sends RESET_DIAGNOSTICS and refreshes', async () => {
    mount();
    root.querySelector('#diag-reset').click();
    await flush();
    await flush();
    expect(sent.map((s) => s.type)).toEqual([MSG.RESET_DIAGNOSTICS, MSG.GET_DIAGNOSTICS]);
  });

  test('Copy diagnostics writes JSON without secrets to the clipboard', async () => {
    const writeText = vi.fn(async () => {});
    const original = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard');
    Object.defineProperty(globalThis.navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      mount({ getContext: () => ({ version: '0.9.0', intelligence: {} }) });
      root.querySelector('#diag-copy').click();
      await flush();
      await flush();
      expect(writeText).toHaveBeenCalledTimes(1);
      const text = writeText.mock.calls[0][0];
      expect(text).not.toContain('wxyz');
      expect(JSON.parse(text).providers.jev.calls).toBe(12);
      expect(toasts.at(-1)).toMatchObject({ level: 'success' });
    } finally {
      if (original) Object.defineProperty(globalThis.navigator, 'clipboard', original);
      else delete globalThis.navigator.clipboard;
    }
  });
});
