/**
 * lib/bg/decision-runtime.js: the service worker's composition of System 1 (real provider over a
 * fake offscreen host), Gemini Nano (no LanguageModel in node), Jev / OpenAI (fake fetch), budget,
 * cache and engine status — and the background contracts built on it (GET_ENGINE_STATUS,
 * GET_DIAGNOSTICS, TEST_PROVIDER, S1_ENSURE_LOADED, NANO_DOWNLOAD_STATE, live settings, re-decide
 * triggers, fault toasts). No reply or push may carry an API key.
 */
import { describe, test, expect } from 'vitest';
import { createFakeChrome } from '../helpers/fake-chrome.js';
import { createStore } from '../../lib/bg/store.js';
import { defaultConfiguration } from '../../lib/bg/defaults.js';
import { createDecisionRuntime, legacyEngineFields, redactDeep, BUDGET_KEY } from '../../lib/bg/decision-runtime.js';
import { REJECTED_LOG_KEY } from '../../lib/pipeline/ingest.js';
import { createHandlers } from '../../lib/bg/handlers/index.js';
import { createRouter } from '../../lib/bg/router.js';
import { MSG } from '../../lib/messages.js';
import { Q } from '../../lib/decision/types.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const JEV_KEY = 'jev-runtime-SECRET-0123456789';
const PANEL = { id: 'fake-extension-id', url: 'chrome-extension://fake-extension-id/sidepanel.html', origin: 'chrome-extension://fake-extension-id' };

async function waitFor(check, timeout = 5000) {
  const start = Date.now();
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await tick(5);
  }
}

/** Fake offscreen host answering S1_LOAD / S1_DECIDE / S1_UNLOAD. */
function fakeOffscreen() {
  const calls = [];
  let model = null;
  return {
    calls,
    client: {
      async sendToOffscreen(type, payload = {}) {
        calls.push({ type, payload });
        await tick(2);
        if (type === 'S1_LOAD') {
          model = payload.model;
          return { ok: true, model, device: 'wasm', loadMs: 12, floor: { matches_prompt: 0.7, primary_tag: 0.3 } };
        }
        if (type === 'S1_UNLOAD') {
          model = null;
          return { ok: true };
        }
        if (type === 'S1_DECIDE') {
          if (payload.model !== model) return { ok: false, code: 'not_loaded' };
          return {
            ok: true,
            ms: 3,
            results: payload.items.map((it) => ({
              id: it.id,
              answers: {
                [Q.MATCHES_PROMPT]: { type: 'noul', noul: /ramen|food/i.test(it.text) ? 0.95 : 0.03 },
                [Q.PRIMARY_TAG]: { type: 'choice', choice: null, probabilities: { none: 1 } }
              }
            }))
          };
        }
        return { ok: true };
      }
    }
  };
}

function fakeRedecider() {
  const calls = [];
  return {
    calls,
    current: null,
    start(opts) { calls.push(['start', opts]); return 'job-1'; },
    schedule(opts) { calls.push(['schedule', opts]); return Promise.resolve('job-2'); },
    onSystem1Ready() { calls.push(['onSystem1Ready']); return 'job-3'; }
  };
}

/** 401 that echoes the bearer token back (a misbehaving server). */
const echo401 = async (url, init) => new Response(JSON.stringify({ error: { message: `bad key ${init.headers.authorization}` } }), { status: 401, headers: { 'content-type': 'application/json' } });

function setup({ config = {}, local = {}, session = {}, fetchImpl = echo401, languageModel = null, now } = {}) {
  const fake = createFakeChrome({
    local: { configuration: { ...defaultConfiguration(), ...config }, secrets: { jev: JEV_KEY }, ...local },
    session
  });
  const store = createStore({ area: fake.storage.local });
  const sent = [];
  const broadcast = { sendRuntime: async (m) => { sent.push(JSON.parse(JSON.stringify(m))); } };
  const off = fakeOffscreen();
  const redecider = fakeRedecider();
  const runtime = createDecisionRuntime({
    store,
    broadcast,
    area: fake.storage.local,
    session: fake.storage.session,
    offscreenClient: off.client,
    languageModel,
    ...(now ? { now } : {}),
    fetchImpl,
    engineStatusDebounceMs: 1,
    system1Options: { loadCalibration: async () => null, batchWindowMs: 1 },
    redecider
  });
  fake.storage.onChanged.addListener((changes, area) => runtime.onStorageChanged(changes, area));
  return { fake, store, sent, off, redecider, runtime };
}

const ofType = (sent, type) => sent.filter((m) => m.type === type);

describe('legacy GET_ENGINE_STATUS fields', () => {
  test('tier/name/status follow System 1, then the escalator, then rules', () => {
    expect(legacyEngineFields({ badge: { level: 'ok' }, system1: { state: 'ready' } })).toEqual({ tier: 1, name: 'System 1 (local embeddings)', status: 'ready' });
    expect(legacyEngineFields({ badge: { level: 'warn' }, system1: { state: 'error' }, escalation: { provider: 'jev', status: { state: 'ready' } } }))
      .toEqual({ tier: 2, name: 'TypeSafe Jev', status: 'ready' });
    expect(legacyEngineFields({ badge: { level: 'loading' }, system1: { state: 'loading' }, escalation: { provider: 'none' } }))
      .toEqual({ tier: 3, name: 'Rule-based Classifier', status: 'loading' });
    expect(legacyEngineFields({ badge: { level: 'warn' }, system1: { state: 'unavailable' } }).status).toBe('unavailable');
  });

  test('redactDeep scrubs every string, keeps the shape', () => {
    const out = redactDeep({ a: [`x ${JEV_KEY} y`, 3], b: { c: `Bearer ${JEV_KEY}` }, d: null }, [JEV_KEY]);
    expect(JSON.stringify(out)).not.toContain(JEV_KEY);
    expect(out.a[1]).toBe(3);
    expect(out.d).toBeNull();
  });
});

describe('decision runtime', () => {
  test('start does not load System 1; the panel asking for the status does: checking -> loading -> ok, and ready upgrades rules-decided items', async () => {
    const { sent, off, redecider, runtime } = setup({ config: { intelligence: { escalation: { provider: 'none' } } } });
    await runtime.start();
    // The worker wakes for every page and the idle-retry alarm: no model is loaded for that.
    await tick(30);
    expect(off.calls.filter((c) => c.type === 'S1_LOAD')).toEqual([]);
    expect(runtime.engineStatusReply({}).badge.level).toBe('checking');
    await waitFor(() => runtime.system1.status().state === 'ready');
    await waitFor(() => redecider.calls.some((c) => c[0] === 'onSystem1Ready'));
    expect(off.calls.some((c) => c.type === 'S1_LOAD' && c.payload.model === 'minilm')).toBe(true);
    await waitFor(() => ofType(sent, MSG.ENGINE_STATUS).some((m) => m.payload.badge.level === 'ok'));
    const levels = ofType(sent, MSG.ENGINE_STATUS).map((m) => m.payload.badge.level);
    expect(levels).toContain('ok');
    const reply = runtime.engineStatusReply({ isMatchPromptEnabled: true, matchPrompt: '' });
    expect(reply).toMatchObject({ badge: { level: 'ok' }, tier: 1, status: 'ready', warnings: ['empty_prompt'], system1: { state: 'ready', model: 'minilm' } });
    expect(reply.nano).toMatchObject({ present: 'none', state: 'unavailable' });
    expect(reply.escalation).toMatchObject({ provider: 'none', status: { state: 'disabled' } });
  });

  test('decideMany: System 1 answers through the offscreen host; uncertain posts do not leave the device without a provider', async () => {
    const { runtime, store } = setup({ config: { isMatchPromptEnabled: true, matchPrompt: 'ramen shops', intelligence: { escalation: { provider: 'jev' } } } });
    await runtime.start();
    // Jev is the escalator but not allowed (providers.jev.enabled is false): nothing is sent.
    const cfg = (await store.get('configuration')).configuration;
    const [yes, no] = await runtime.decideMany(
      [{ id: 'a', text: 'The best ramen in town opened on our street today.', platform: 'x.com' }, { id: 'b', text: 'Quarterly revenue grew faster than the analysts expected.', platform: 'x.com' }],
      { configuration: cfg, purpose: 'ingest' }
    );
    expect(yes).toMatchObject({ collect: true, path: ['system1'], provider: 'system1', escalated: false });
    expect(no).toMatchObject({ collect: false, provider: 'system1' });
    const diag = await runtime.diagnostics();
    expect(diag.engineStatus.counters.decided).toBe(2);
    expect(diag.providers.system1.calls).toBeGreaterThanOrEqual(1);
    expect(diag.cache).toMatchObject({ size: 2, misses: 2, hits: 0 });
    // the same posts again: answered from the cache
    await runtime.decideMany([{ id: 'a', text: 'The best ramen in town opened on our street today.', platform: 'x.com' }], { configuration: cfg, purpose: 'ingest' });
    expect(runtime.cache.stats().hits).toBe(1);
  });

  test('live settings: model switch reloads System 1 and re-decides everything; gate policy schedules a prompt re-decide; budgets apply', async () => {
    const { fake, store, off, redecider, runtime } = setup();
    await runtime.start();
    await runtime.ensureSystem1Loaded();
    await waitFor(() => runtime.system1.status().state === 'ready');
    redecider.calls.length = 0;

    await store.mutateConfig((cfg) => ({ ...cfg, intelligence: { system1: { model: 'bge-small' } } }));
    await waitFor(() => off.calls.some((c) => c.type === 'S1_LOAD' && c.payload.model === 'bge-small'));
    expect(off.calls.some((c) => c.type === 'S1_UNLOAD')).toBe(true);
    // Open tabs rescan once the stack is re-decided (posts the old verdicts rejected are offered again).
    expect(redecider.calls).toContainEqual(['start', { scope: 'all', reason: 'model_changed', rescan: true }]);

    await store.mutateConfig((cfg) => ({ ...cfg, intelligence: { ...cfg.intelligence, gate: { strictness: 'strict' }, escalation: { perMinute: 2, perDay: 5 } } }));
    await waitFor(() => redecider.calls.some((c) => c[0] === 'schedule'));
    expect(redecider.calls).toContainEqual(['schedule', { scope: 'prompt', reason: 'gate_policy', rescan: true }]);
    expect(runtime.budget.snapshot()).toMatchObject({ perMinute: 2, perDay: 5 });

    // System 1 switched off: unloaded, badge no longer green.
    await store.mutateConfig((cfg) => ({ ...cfg, intelligence: { ...cfg.intelligence, system1: { enabled: false } } }));
    await waitFor(() => runtime.system1.status().state === 'disabled');
    expect(runtime.engineStatusReply({}).badge.level).toBe('warn');
    expect(fake.storage.local.peek(BUDGET_KEY)).toBeUndefined(); // nothing escalated yet
  });

  test('a cloud provider fault: one TOAST with a fixed, key-free text; the badge degrades; the key is never echoed', async () => {
    const { sent, runtime, store } = setup({
      config: { isMatchPromptEnabled: true, matchPrompt: 'ramen shops', intelligence: { escalation: { provider: 'jev' }, providers: { jev: { enabled: true } } } }
    });
    await runtime.start();
    await runtime.ensureSystem1Loaded();
    await waitFor(() => runtime.system1.status().state === 'ready');
    const cfg = (await store.get('configuration')).configuration;
    // Force uncertainty: a post System 1 scores near 0.5 does not exist in the fake host, so use a floor of 1.
    const unsure = { ...cfg, intelligence: { ...cfg.intelligence, escalation: { ...cfg.intelligence.escalation, floor: { matches_prompt: 1 } } } };
    for (let i = 0; i < 2; i++) {
      await runtime.decideMany([{ id: `p${i}`, text: `Post ${i} about quarterly revenue and analyst expectations this year.`, platform: 'x.com' }], { configuration: unsure, purpose: 'ingest' });
    }
    await waitFor(() => ofType(sent, MSG.TOAST).length > 0);
    await tick(20);
    const toasts = ofType(sent, MSG.TOAST);
    expect(toasts).toHaveLength(1);
    expect(toasts[0].payload).toMatchObject({ level: 'warn', key: 'jev' });
    expect(toasts[0].payload.text).toMatch(/rejected the API key/);
    const snap = runtime.engineStatus.snapshot();
    expect(snap.escalation).toMatchObject({ provider: 'jev', status: { state: 'auth_error' } });
    expect(snap.badge.level).toBe('warn');
    expect(JSON.stringify(sent)).not.toContain(JEV_KEY);

    const diag = await runtime.diagnostics();
    expect(diag.providers.jev).toMatchObject({ state: 'auth_error', errors: 1 });
    expect(JSON.stringify(diag)).not.toContain(JEV_KEY);
    expect(diag.secrets).toEqual({ jev: { set: true, last4: '6789' }, openai: { set: false, last4: null } });

    // A new key re-opens the circuit (storage change -> refresh).
    await store.area.set({ secrets: { jev: 'jev-runtime-OTHER-key-9876543210' } });
    await waitFor(() => runtime.engineStatus.snapshot().escalation.status.state === 'ready');
  });

  test('TEST_PROVIDER: synthetic post only, error text redacted; unknown ids refused', async () => {
    let body = null;
    const { runtime } = setup({
      fetchImpl: async (url, init) => { body = init.body; return echo401(url, init); }
    });
    expect(await runtime.testProvider('claude')).toMatchObject({ success: false, code: 'bad_request' });
    const res = await runtime.testProvider('jev');
    expect(res).toMatchObject({ success: true, ok: false, code: 'auth_error' });
    expect(JSON.stringify(res)).not.toContain(JEV_KEY);
    expect(String(body)).toContain('sourdough'); // the fixed synthetic post, never user data
    expect(await runtime.testProvider('nano')).toMatchObject({ success: true, ok: false, code: 'unavailable' });
    expect(await runtime.testProvider('system1')).toMatchObject({ success: true, ok: true, model: 'minilm' });
  });

  test('GET_ENGINE_STATUS re-checks a stale Gemini Nano availability (not awaited, once per TTL) and pushes the change', async () => {
    let clock = 1_000_000;
    let availability = 'unavailable';
    let checks = 0;
    const lm = { availability: async () => { checks += 1; return availability; }, create: async () => ({}) };
    const { sent, runtime } = setup({ config: { intelligence: { escalation: { provider: 'nano' } } }, languageModel: lm, now: () => clock });
    await runtime.start();
    await waitFor(() => runtime.engineStatus.snapshot().nano.state === 'unavailable');
    // Chrome makes the model downloadable later (e.g. after disk space was freed).
    availability = 'downloadable';

    // Within the availability TTL the cached status stands: no availability() call per request.
    const before = checks;
    expect(runtime.engineStatusReply({}).nano.state).toBe('unavailable');
    await tick(10);
    expect(checks).toBe(before);

    // Later, an open panel asking for the status triggers one re-check; the reply does not wait for it.
    clock += 11_000;
    expect(runtime.engineStatusReply({}).nano.state).toBe('unavailable');
    expect(runtime.engineStatusReply({}).nano.state).toBe('unavailable');
    await waitFor(() => runtime.engineStatus.snapshot().nano.state === 'downloadable');
    expect(checks).toBe(before + 1);
    expect(runtime.engineStatus.snapshot().escalation).toMatchObject({ provider: 'nano', status: { state: 'downloadable' } });
    await waitFor(() => ofType(sent, MSG.ENGINE_STATUS).some((m) => m.payload.nano.state === 'downloadable'));
  });

  test('a model the host unloaded while idle: the offscreen document is closed and the badge says Idle; the next post loads it again', async () => {
    const { off, runtime, store } = setup({ config: { isMatchPromptEnabled: true, matchPrompt: 'ramen shops', intelligence: { escalation: { provider: 'none' } } } });
    let closed = 0;
    off.client.closeOffscreenDocument = async () => { closed += 1; };
    await runtime.start();
    await runtime.ensureSystem1Loaded();
    await waitFor(() => runtime.system1.status().state === 'ready');

    // Another status push (not idle) never closes the document.
    runtime.handleS1Status({ status: 'loading', model: 'minilm', progress: 0.5 });
    expect(closed).toBe(0);

    expect(runtime.handleS1Status({ status: 'unloaded', model: 'minilm', detail: 'idle' })).toBe(true);
    await waitFor(() => closed === 1);
    expect(runtime.system1.status()).toMatchObject({ state: 'unavailable', detail: 'not_loaded' });
    await waitFor(() => runtime.engineStatus.snapshot().badge.label === 'Idle');
    expect(runtime.engineStatus.snapshot().badge.level).toBe('ok');

    const loads = off.calls.filter((c) => c.type === 'S1_LOAD').length;
    const cfg = (await store.get('configuration')).configuration;
    const [d] = await runtime.decideMany([{ id: 'a', text: 'The best ramen in town opened on our street today.', platform: 'x.com' }], { configuration: cfg, purpose: 'ingest' });
    expect(d).toMatchObject({ path: ['system1'], collect: true });
    expect(off.calls.filter((c) => c.type === 'S1_LOAD').length).toBe(loads + 1);
  });

  test('an idle unload while a new load is starting keeps the document', async () => {
    const { off, runtime } = setup();
    let closed = 0;
    off.client.closeOffscreenDocument = async () => { closed += 1; };
    const send = off.client.sendToOffscreen;
    off.client.sendToOffscreen = async (type, payload) => {
      if (type === 'S1_LOAD') await tick(100);
      return send(type, payload);
    };
    const loading = runtime.ensureSystem1Loaded();
    await waitFor(() => runtime.system1.status().state === 'loading');
    runtime.handleS1Status({ status: 'unloaded', model: 'minilm', detail: 'idle' });
    await loading;
    await tick(20);
    expect(closed).toBe(0);
  });

  test('S1_ENSURE_LOADED replies at once with the status; NANO_DOWNLOAD_STATE updates nano', async () => {
    const { runtime } = setup();
    const reply = await runtime.ensureSystem1Loaded();
    expect(reply.success).toBe(true);
    expect(['loading', 'ready']).toContain(reply.status.state);
    expect(runtime.noteNanoDownload({ phase: 'bogus' })).toMatchObject({ success: false, code: 'bad_request' });
    const s = runtime.noteNanoDownload({ phase: 'progress', loaded: 0.25 });
    expect(s.success).toBe(true);
    expect(runtime.engineStatus.snapshot().nano).toHaveProperty('state');
  });

  test('GET_DIAGNOSTICS: newest rejections first (50 max), budget and RESET_DIAGNOSTICS', async () => {
    const log = Array.from({ length: 60 }, (_, i) => ({ postKey: `k${i}`, platform: 'x.com', snippet: `post ${i} ${JEV_KEY}`, pMatch: 0.1, path: ['system1'], reason: 'system1_no_match', at: i }));
    const { runtime } = setup({ session: { [REJECTED_LOG_KEY]: log } });
    const diag = await runtime.diagnostics();
    expect(diag.rejected).toHaveLength(50);
    expect(diag.rejected[0]).toMatchObject({ at: 59, platform: 'x.com', pMatch: 0.1, path: ['system1'], reason: 'system1_no_match' });
    expect(JSON.stringify(diag)).not.toContain(JEV_KEY);
    expect(diag.budget).toMatchObject({ perMinute: 30, perDay: 1000, dayUsed: 0 });
    runtime.cache.get('nope');
    expect(runtime.cache.stats().misses).toBe(1);
    expect(runtime.resetDiagnostics()).toEqual({ success: true });
    expect(runtime.cache.stats().misses).toBe(0);
    expect(runtime.engineStatus.snapshot().counters.decided).toBe(0);
  });
});

describe('background handlers backed by the runtime (through the router)', () => {
  test('replies follow the side panel contract; content scripts are refused', async () => {
    const { fake, store, runtime } = setup();
    const handlers = createHandlers({
      store,
      broadcast: { scheduleBroadcast() {}, getInflightCount: () => 0, sendRuntime: async () => {}, broadcastToAllTabs: async () => {} },
      ingest: { enqueue: async () => ({ status: 'queued' }) },
      decision: runtime,
      engine: {},
      extensionOrigin: 'chrome-extension://fake-extension-id'
    });
    const listener = createRouter(handlers, { extensionOrigin: 'chrome-extension://fake-extension-id' });
    const send = (type, payload, sender = PANEL) => new Promise((resolve) => {
      const open = listener({ type, payload }, sender, resolve);
      if (open !== true) setTimeout(() => resolve(undefined), 20);
    });
    const page = { tab: { id: 3 }, url: 'https://www.linkedin.com/feed/', origin: 'https://www.linkedin.com' };

    expect(await send(MSG.GET_ENGINE_STATUS, {})).toMatchObject({ badge: expect.any(Object), tier: expect.any(Number), warnings: [] });
    const diag = await send(MSG.GET_DIAGNOSTICS, {});
    expect(diag).toMatchObject({ success: true, secrets: { jev: { set: true, last4: '6789' } } });
    expect(JSON.stringify(diag)).not.toContain(JEV_KEY);
    expect(await send(MSG.S1_ENSURE_LOADED, {})).toMatchObject({ success: true, status: { model: 'minilm' } });
    expect(await send(MSG.TEST_PROVIDER, { provider: 'openai' })).toMatchObject({ success: true, ok: false });
    expect(await send(MSG.RESET_DIAGNOSTICS, {})).toEqual({ success: true });
    expect(await send(MSG.NANO_DOWNLOAD_STATE, { phase: 'start' })).toMatchObject({ success: true });
    expect(await send(MSG.S1_STATUS, { status: 'loading', model: 'minilm', progress: 0.3 }, { url: 'chrome-extension://fake-extension-id/offscreen/offscreen.html' }))
      .toMatchObject({ success: true });
    for (const type of [MSG.GET_DIAGNOSTICS, MSG.TEST_PROVIDER, MSG.S1_ENSURE_LOADED, MSG.S1_STATUS, MSG.NANO_DOWNLOAD_STATE, MSG.RESET_DIAGNOSTICS]) {
      expect(await send(type, {}, page)).toMatchObject({ success: false, code: 'forbidden' });
    }

    // A cleared confidence floor (null) removes the explicit value.
    await send(MSG.UPDATE_INTELLIGENCE_SETTINGS, { patch: { escalation: { floor: { matches_prompt: 0.8 } } } });
    expect(fake.storage.local.peek('configuration').intelligence).toEqual({ escalation: { floor: { matches_prompt: 0.8 } } });
    const cleared = await send(MSG.UPDATE_INTELLIGENCE_SETTINGS, { patch: { escalation: { floor: { matches_prompt: null } } } });
    expect(cleared.success).toBe(true);
    expect(fake.storage.local.peek('configuration')).not.toHaveProperty('intelligence');
    expect(cleared.intelligence.escalation.floor).toBeUndefined();
  });
});
