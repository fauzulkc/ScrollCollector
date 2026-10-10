import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import { createLocalSystem1, system1Settings, S1_TIMEOUT } from '../../lib/decision/providers/local-system1.js';
import { hashTexts } from '../../lib/decision/system1-math.js';
import { BACKGROUND_CORPUS } from '../../lib/decision/background-corpus.js';
import { Q } from '../../lib/decision/types.js';
import { createSystem1Host } from '../../offscreen/system1-host.js';
import { createOffscreenRouter } from '../../offscreen/offscreen.js';
import { createEmbeddingCache } from '../../offscreen/embedding-cache.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const CORPUS_HASH = hashTexts([...BACKGROUND_CORPUS]);

/**
 * Fake offscreen client playing the System 1 host. Handlers can be overridden per test; the
 * client honours `timeoutMs` like lib/offscreen-client.js (rejects with code 'timeout').
 */
function fakeHost({ loadDelayMs = 5 } = {}) {
  const calls = [];
  const host = { model: null };
  const handlers = {
    async S1_LOAD(p) {
      await tick(loadDelayMs);
      host.model = p.model;
      return { ok: true, model: p.model, device: 'wasm', loadMs: 42, calibrationId: `${p.model}.q8@host`, floor: { matches_prompt: 0.7, primary_tag: 0.3 } };
    },
    async S1_UNLOAD() {
      host.model = null;
      return { ok: true };
    },
    async S1_DECIDE(p) {
      await tick(1);
      if (host.model !== p.model) return { ok: false, code: host.model ? 'model_mismatch' : 'not_loaded' };
      return {
        ok: true,
        model: p.model,
        ms: 7,
        results: p.items.map((it) => ({
          id: it.id,
          answers: { [Q.MATCHES_PROMPT]: { type: 'noul', noul: it.text.includes('food') ? 0.9 : 0.1, confidence: 0.8, source: 'system1' } },
          ms: 1
        }))
      };
    }
  };
  const client = {
    sendToOffscreen(type, payload = {}, opts = {}) {
      calls.push({ type, payload, timeoutMs: opts.timeoutMs });
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(Object.assign(new Error(`${type} timed out`), { code: 'timeout' })), opts.timeoutMs ?? 30000);
        Promise.resolve()
          .then(() => handlers[type](payload))
          .then(
            (v) => {
              clearTimeout(t);
              resolve(v);
            },
            (e) => {
              clearTimeout(t);
              reject(e);
            }
          );
      });
    }
  };
  const of = (type) => calls.filter((c) => c.type === type);
  return { client, calls, host, handlers, of };
}

function setup(over = {}) {
  const fake = fakeHost(over.host);
  const config = { intelligence: { system1: { model: 'minilm', ...(over.system1 || {}) } } };
  const statuses = [];
  const provider = createLocalSystem1({
    client: fake.client,
    getConfig: async () => config,
    onStatus: (s) => statuses.push(s),
    loadCalibration: async (model) => ({ model, corpusHash: CORPUS_HASH, floor: { matches_prompt: model === 'minilm' ? 0.7 : 0.66, primary_tag: 0.3 } }),
    batchWindowMs: 10,
    ...(over.provider || {})
  });
  return { ...fake, provider, config, statuses };
}

const req = (texts, over = {}) => ({
  items: texts.map((text, i) => ({ id: String(i), text })),
  questions: { [Q.MATCHES_PROMPT]: { type: 'noul' }, [Q.PRIMARY_TAG]: { type: 'choice' } },
  specHash: 'spec-a',
  context: { prompt: { raw: 'food posts', cleaned: 'food', expansion: '' }, tags: [{ label: 'Food', description: 'cooking' }] },
  ...over
});

describe('system1Settings', () => {
  test('reads a configuration, an intelligence block or system1 settings; unknown models fall back to the default', () => {
    expect(system1Settings(null)).toEqual({ enabled: true, model: 'minilm', device: 'wasm', dtype: 'q8' });
    expect(system1Settings({ intelligence: { system1: { model: 'bge-small' } } }).model).toBe('bge-small');
    expect(system1Settings({ system1: { enabled: false } }).enabled).toBe(false);
    expect(system1Settings({ model: 'nope' }).model).toBe('minilm');
  });
});

describe('loading', () => {
  test('isReady() starts the load and turns true once S1_LOAD answered; status goes loading -> ready', async () => {
    const { provider, of, statuses } = setup();
    expect(await provider.isReady()).toBe(false);
    expect(provider.status().state).toBe('loading');
    expect(await provider.waitUntilReady(1000)).toBe(true);
    expect(await provider.isReady()).toBe(true);
    expect(of('S1_LOAD')).toHaveLength(1);
    expect(of('S1_LOAD')[0]).toMatchObject({ payload: { model: 'minilm', device: 'wasm', dtype: 'q8' }, timeoutMs: 180000 });
    expect(provider.status()).toMatchObject({ state: 'ready', model: 'minilm', device: 'wasm', loadMs: 42 });
    expect(statuses.map((s) => s.state)).toEqual(expect.arrayContaining(['loading', 'ready']));
    expect(statuses.at(-1)).toMatchObject({ state: 'ready', lastError: null, progress: null });
  });

  test('concurrent loads share one S1_LOAD', async () => {
    const { provider, of } = setup();
    const r = await Promise.all([provider.ensureLoaded(), provider.ensureLoaded(), provider.waitUntilReady(1000), provider.isReady()]);
    expect(r.slice(0, 3)).toEqual([true, true, true]);
    expect(of('S1_LOAD')).toHaveLength(1);
  });

  test('waitUntilReady gives up after its timeout while the load keeps going', async () => {
    const { provider } = setup({ host: { loadDelayMs: 200 } });
    expect(await provider.waitUntilReady(20)).toBe(false);
    expect(provider.status().state).toBe('loading');
    expect(await provider.waitUntilReady(2000)).toBe(true);
  });

  test('calibrationId and floor are known before the model is loaded and come from the host afterwards', async () => {
    const { provider } = setup();
    await tick(5);
    expect(provider.calibrationId).toBe(`minilm.q8@${CORPUS_HASH}`);
    expect(provider.floor).toEqual({ matches_prompt: 0.7, primary_tag: 0.3 });
    await provider.ensureLoaded();
    expect(provider.calibrationId).toBe('minilm.q8@host');
  });

  test('a failed load reports the error, is not retried by the cascade before the backoff, but ensureLoaded() retries', async () => {
    const { provider, handlers, of, statuses } = setup({ provider: { retryAfterMs: 60000 } });
    let fail = true;
    const realLoad = handlers.S1_LOAD;
    handlers.S1_LOAD = async (p) => (fail ? { ok: false, code: 'calibration_mismatch', error: 'System 1 calibration unusable' } : realLoad(p));
    expect(await provider.ensureLoaded()).toBe(false);
    expect(provider.status()).toMatchObject({ state: 'error', lastError: 'System 1 calibration unusable', detail: 'calibration_mismatch' });
    expect(statuses.at(-1)).toMatchObject({ state: 'error', lastError: 'System 1 calibration unusable' });
    expect(await provider.isReady()).toBe(false);
    expect(await provider.waitUntilReady(1000)).toBe(false);
    expect(of('S1_LOAD')).toHaveLength(1);
    fail = false;
    expect(await provider.ensureLoaded()).toBe(true);
    expect(provider.status()).toMatchObject({ state: 'ready' });
    expect(provider.status().lastError).toBeUndefined();
  });

  test('a load timeout is reported as s1_timeout', async () => {
    const { provider, handlers } = setup({ provider: { loadTimeoutMs: 30 } });
    handlers.S1_LOAD = () => new Promise(() => {});
    expect(await provider.ensureLoaded()).toBe(false);
    expect(provider.status()).toMatchObject({ state: 'error', detail: S1_TIMEOUT });
  });
});

describe('decideBatch', () => {
  test('micro-batches concurrent calls into one S1_DECIDE and maps results back to each caller', async () => {
    const { provider, of } = setup();
    await provider.ensureLoaded();
    const [a, b, c] = await Promise.all([
      provider.decideBatch(req(['food one', 'news one'])),
      provider.decideBatch(req(['news two', 'food two'])),
      provider.decideBatch(req(['food three']))
    ]);
    expect(of('S1_DECIDE')).toHaveLength(1);
    const sent = of('S1_DECIDE')[0];
    expect(sent.timeoutMs).toBe(30000);
    expect(sent.payload.items).toHaveLength(5);
    expect(new Set(sent.payload.items.map((i) => i.id)).size).toBe(5);
    expect(sent.payload.model).toBe('minilm');
    expect(sent.payload.spec).toEqual({
      specHash: 'spec-a',
      prompt: { raw: 'food posts', cleaned: 'food', expansion: '' },
      tags: [{ label: 'Food', description: 'cooking' }],
      questions: [Q.MATCHES_PROMPT, Q.PRIMARY_TAG]
    });
    expect(a.results.map((r) => [r.id, r.answers[Q.MATCHES_PROMPT].noul])).toEqual([['0', 0.9], ['1', 0.1]]);
    expect(b.results.map((r) => [r.id, r.answers[Q.MATCHES_PROMPT].noul])).toEqual([['0', 0.1], ['1', 0.9]]);
    expect(c.results).toEqual([{ id: '0', answers: { [Q.MATCHES_PROMPT]: expect.objectContaining({ noul: 0.9 }) }, ms: 1 }]);
  });

  test('flushes at 16 items without waiting for the window and sends one S1_DECIDE at a time', async () => {
    const { provider, of, handlers } = setup({ provider: { batchWindowMs: 5000 } });
    await provider.ensureLoaded();
    let inFlight = 0;
    let maxInFlight = 0;
    const real = handlers.S1_DECIDE;
    handlers.S1_DECIDE = async (p) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return await real(p);
      } finally {
        inFlight -= 1;
      }
    };
    const started = Date.now();
    const texts = Array.from({ length: 20 }, (_, i) => `post ${i} food`);
    const { results } = await Promise.race([provider.decideBatch(req(texts)), tick(3000).then(() => ({ results: [] }))]);
    expect(Date.now() - started).toBeLessThan(2500);
    expect(results).toHaveLength(20);
    expect(results.map((r) => r.id)).toEqual(texts.map((_, i) => String(i)));
    expect(of('S1_DECIDE').map((c) => c.payload.items.length)).toEqual([16, 4]);
    expect(maxInFlight).toBe(1);
  });

  test('items of different specs never share an S1_DECIDE', async () => {
    const { provider, of } = setup();
    await provider.ensureLoaded();
    await Promise.all([provider.decideBatch(req(['food a'])), provider.decideBatch(req(['food b'], { specHash: 'spec-b' })), provider.decideBatch(req(['food c']))]);
    const sent = of('S1_DECIDE').map((c) => [c.payload.spec.specHash, c.payload.items.length]);
    expect(sent).toEqual([['spec-a', 2], ['spec-b', 1]]);
  });

  test('a decide without a reply in time resolves its items with s1_timeout', async () => {
    const { provider, handlers } = setup({ provider: { decideTimeoutMs: 30 } });
    await provider.ensureLoaded();
    handlers.S1_DECIDE = () => new Promise(() => {});
    const { results } = await provider.decideBatch(req(['food', 'news']));
    expect(results).toEqual([{ id: '0', error: S1_TIMEOUT }, { id: '1', error: S1_TIMEOUT }]);
    expect(provider.diagnostics()).toMatchObject({ timeouts: 1, errors: 1 });
    expect(provider.diagnostics().lastError).toMatch(/did not answer/);
    expect(provider.status().state).toBe('ready');
  });

  test('while the model is still loading a flush waits up to loadTimeoutMs, then fails with s1_timeout', async () => {
    const { provider, handlers, of } = setup({ provider: { loadTimeoutMs: 40 } });
    handlers.S1_LOAD = () => new Promise(() => {});
    const { results } = await provider.decideBatch(req(['food']));
    expect(results).toEqual([{ id: '0', error: S1_TIMEOUT }]);
    expect(of('S1_DECIDE')).toHaveLength(0);
  });

  test('loads on demand: the first decide waits for the model and then decides', async () => {
    const { provider, of } = setup();
    const { results } = await provider.decideBatch(req(['food']));
    expect(results[0].answers[Q.MATCHES_PROMPT].noul).toBe(0.9);
    expect(of('S1_LOAD')).toHaveLength(1);
  });

  test('a host that lost its model (re-created document) is reloaded and the batch retried once', async () => {
    const { provider, host, of } = setup();
    await provider.ensureLoaded();
    host.model = null; // the offscreen document was re-created
    const { results } = await provider.decideBatch(req(['food']));
    expect(results[0].answers[Q.MATCHES_PROMPT].noul).toBe(0.9);
    expect(of('S1_LOAD')).toHaveLength(2);
    expect(of('S1_DECIDE')).toHaveLength(2);
  });

  test('host errors become item errors; decideBatch never rejects', async () => {
    const { provider, handlers } = setup();
    await provider.ensureLoaded();
    handlers.S1_DECIDE = async () => {
      throw new Error('kaput');
    };
    await expect(provider.decideBatch(req(['food']))).resolves.toEqual({ results: [{ id: '0', error: 's1_error' }] });
    expect(provider.diagnostics().lastError).toBe('kaput');
    handlers.S1_DECIDE = async (p) => ({ ok: true, results: [{ id: p.items[0].id, error: 'empty_text', ms: 0 }] });
    await expect(provider.decideBatch(req(['']))).resolves.toEqual({ results: [{ id: '0', error: 'empty_text', ms: 0 }] });
    expect(await provider.decideBatch({ items: [] })).toEqual({ results: [] });
  });

  test('turned off: s1_disabled, no load', async () => {
    const { provider, of } = setup({ system1: { enabled: false } });
    expect(await provider.isReady()).toBe(false);
    expect(await provider.waitUntilReady(100)).toBe(false);
    expect(await provider.decideBatch(req(['food']))).toEqual({ results: [{ id: '0', error: 's1_disabled' }] });
    expect(of('S1_LOAD')).toHaveLength(0);
    expect(provider.status().state).toBe('disabled');
  });
});

describe('configuration changes', () => {
  test('a different model in the configuration unloads the old one and loads the new one', async () => {
    const { provider, config, of, calls } = setup();
    await provider.ensureLoaded();
    expect(provider.calibrationId).toBe('minilm.q8@host');
    config.intelligence.system1.model = 'bge-small';
    expect(await provider.isReady()).toBe(false);
    expect(await provider.waitUntilReady(1000)).toBe(true);
    const types = calls.map((c) => c.type);
    expect(types.indexOf('S1_UNLOAD')).toBeGreaterThan(types.indexOf('S1_LOAD'));
    expect(of('S1_LOAD').map((c) => c.payload.model)).toEqual(['minilm', 'bge-small']);
    expect(provider.calibrationId).toBe('bge-small.q8@host');
    expect(provider.status().model).toBe('bge-small');
    const { results } = await provider.decideBatch(req(['food']));
    expect(of('S1_DECIDE')[0].payload.model).toBe('bge-small');
    expect(results[0].answers).toBeDefined();
  });

  test('reconfigure() switches models right away and unloads when System 1 is turned off', async () => {
    const { provider, config, of } = setup();
    await provider.ensureLoaded();
    config.intelligence.system1.model = 'bge-small';
    await provider.reconfigure();
    expect(of('S1_LOAD').map((c) => c.payload.model)).toEqual(['minilm', 'bge-small']);
    config.intelligence.system1.enabled = false;
    const s = await provider.reconfigure();
    expect(s.state).toBe('disabled');
    expect(of('S1_UNLOAD').length).toBeGreaterThanOrEqual(2);
    expect(await provider.isReady()).toBe(false);
  });
});

describe('status pushes (S1_STATUS)', () => {
  test('progress and errors from the host reach onStatus; pushes for another model are ignored', async () => {
    const { provider, statuses } = setup();
    await tick(5);
    expect(provider.handleStatusPush({ type: 'S1_STATUS', payload: { status: 'loading', model: 'minilm', progress: 0.42, detail: 'loading weights' } })).toBe(true);
    expect(statuses.at(-1)).toMatchObject({ state: 'loading', progress: 0.42, detail: 'loading weights', model: 'minilm' });
    expect(provider.status()).toMatchObject({ state: 'loading', progress: 0.42 });
    expect(provider.handleStatusPush({ status: 'loading', model: 'bge-small', progress: 0.9 })).toBe(false);
    expect(provider.status().progress).toBe(0.42);
    expect(provider.handleStatusPush({ status: 'error', model: 'minilm', error: 'wasm failed', detail: 's1_load_error' })).toBe(true);
    expect(provider.status()).toMatchObject({ state: 'error', lastError: 'wasm failed' });
    expect(provider.handleStatusPush({ nonsense: true })).toBe(false);
  });

  test('a ready host we were not waiting for is picked up; an unload elsewhere makes us unavailable', async () => {
    const { provider, of } = setup();
    await tick(5);
    expect(provider.handleStatusPush({ status: 'ready', model: 'minilm' })).toBe(true);
    expect(await provider.waitUntilReady(1000)).toBe(true);
    expect(of('S1_LOAD')).toHaveLength(1);
    expect(provider.handleStatusPush({ status: 'unloaded', model: 'minilm' })).toBe(true);
    expect(provider.status().state).toBe('unavailable');
    expect(await provider.waitUntilReady(1000)).toBe(true);
  });
});

describe('diagnostics', () => {
  test('counts calls and latency; resetStats() clears them', async () => {
    const { provider } = setup();
    await provider.decideBatch(req(['food']));
    await provider.decideBatch(req(['news'], { specHash: 'spec-b' }));
    expect(provider.diagnostics()).toMatchObject({ model: 'minilm', device: 'wasm', loadMs: 42, calls: 2, items: 2, avgMs: 7, p95Ms: 7, lastLatencyMs: 7, errors: 0, lastError: null });
    provider.resetStats();
    expect(provider.diagnostics()).toMatchObject({ calls: 0, avgMs: null, lastLatencyMs: null });
  });

  test('testConnection() decides one synthetic post', async () => {
    const { provider, of } = setup();
    const r = await provider.testConnection();
    expect(r).toMatchObject({ ok: true, model: 'minilm' });
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(of('S1_DECIDE')[0].payload.spec.questions).toEqual([Q.MATCHES_PROMPT]);
  });

  test('exposes the provider identity used by the cascade', () => {
    const { provider } = setup();
    expect(provider).toMatchObject({ id: 'system1', isCloud: false });
    expect(typeof provider.decideBatch).toBe('function');
  });
});

// ---------------------------------------------------------------------------------------------
// Contract: the real provider talking to the real offscreen router + host (offscreen/*.js) with
// a fake Transformers.js model (deterministic 384-d vectors) and the bundled calibrations.
// ---------------------------------------------------------------------------------------------

/** Deterministic 384-d unit vector per text with a "food" direction. */
function vec384(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  let s = h || 1;
  const food = /restaurant|chef|michelin|food|dining|menu|cooking/i.test(text) ? 1 : 0;
  const v = Array.from({ length: 384 }, (_, i) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296 - 0.5 + (i === 0 ? 4 * food : 0);
  });
  const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0));
  return v.map((x) => x / n);
}

const CALIBRATIONS = Object.fromEntries(
  ['minilm', 'bge-small'].map((k) => [k, JSON.parse(fs.readFileSync(new URL(`../../lib/decision/calibration/${k}.q8.json`, import.meta.url), 'utf8'))])
);

function hostSetup({ calibrations = CALIBRATIONS, pipelineDelayMs = 10, idleUnloadMs } = {}) {
  const pushes = [];
  /** S1_STATUS relay (the background routes pushes to the provider). */
  const wire = { relay: null };
  const model = { calls: 0, active: 0, maxActive: 0, pipelines: [] };
  const fakeTf = {
    env: { backends: { onnx: { wasm: {} } } },
    async pipeline(task, id, opts) {
      model.pipelines.push({ task, id, dtype: opts.dtype, device: opts.device });
      opts.progress_callback?.({ status: 'progress', file: 'onnx/model_quantized.onnx', loaded: 50, total: 100 });
      await tick(pipelineDelayMs);
      opts.progress_callback?.({ status: 'done', file: 'onnx/model_quantized.onnx' });
      const extractor = async (text, { pooling, normalize }) => {
        expect(typeof text).toBe('string'); // one text per model call
        expect(normalize).toBe(true);
        expect(pooling).toBe(id.includes('bge') ? 'cls' : 'mean');
        model.calls += 1;
        model.active += 1;
        model.maxActive = Math.max(model.maxActive, model.active);
        await tick(0);
        model.active -= 1;
        return { data: Float32Array.from(vec384(text)), dispose() {} };
      };
      extractor.dispose = async () => {};
      return extractor;
    }
  };
  const runtime = { getURL: (p) => `chrome-extension://test/${p}` };
  const host = createSystem1Host({
    importTransformers: async () => fakeTf,
    runtime,
    fetchJson: async (url) => {
      const key = url.match(/calibration\/(.+)\.q8\.json$/)?.[1];
      if (!calibrations[key]) throw Object.assign(new Error('HTTP 404'), { code: 'calibration_missing' });
      return JSON.parse(JSON.stringify(calibrations[key]));
    },
    cache: createEmbeddingCache({ indexedDB: null }),
    push: (payload) => {
      pushes.push(payload);
      wire.relay?.({ type: 'S1_STATUS', target: 'background', payload });
    },
    globals: { crossOriginIsolated: true, navigator: { hardwareConcurrency: 8, gpu: {} } },
    ...(idleUnloadMs !== undefined ? { idleUnloadMs, now: () => Date.now() } : {})
  });
  const route = createOffscreenRouter(host);
  const send = (type, payload = {}, sender = { url: 'chrome-extension://test/background.js' }) =>
    new Promise((resolve) => {
      route({ type, target: 'offscreen', requestId: 'r1', payload }, sender, resolve);
    });
  const client = { sendToOffscreen: (type, payload) => send(type, payload) };
  return { host, send, client, pushes, model, fakeTf, wire };
}

const PROMPT = 'find me restaurant and 5 star quality food posts. I am fascinated by michelin star cooking';
const contextReq = (texts) => ({
  items: texts.map((text, i) => ({ id: String(i), text })),
  questions: { [Q.MATCHES_PROMPT]: {}, [Q.PRIMARY_TAG]: {} },
  specHash: 'contract-spec',
  context: { prompt: { raw: PROMPT, cleaned: 'restaurant and 5 star quality food; michelin star cooking', expansion: '' }, tags: [{ label: 'Jobs', description: 'job postings, hiring' }, { label: 'Health', description: 'health, fitness' }] }
});

describe('provider + offscreen host contract', () => {
  test('loads, relays progress, decides through the shared scorer and never blocks OFFSCREEN_PING', async () => {
    const { client, send, pushes, model, fakeTf, wire } = hostSetup({ pipelineDelayMs: 30 });
    const statuses = [];
    const provider = createLocalSystem1({ client, getConfig: () => ({ system1: { model: 'minilm' } }), onStatus: (s) => statuses.push(s), batchWindowMs: 1 });
    wire.relay = (msg) => provider.handleStatusPush(msg);
    const loading = provider.ensureLoaded();
    await tick(5);
    const ping = await send('OFFSCREEN_PING');
    expect(ping).toMatchObject({ ok: true, requestId: 'r1', caps: { crossOriginIsolated: true, webgpu: true, threads: 4 }, s1: { state: 'loading', model: 'minilm' } });
    expect(await loading).toBe(true);
    expect(statuses.some((s) => s.state === 'loading' && s.progress > 0 && s.detail === 'loading weights')).toBe(true);
    expect(statuses.at(-1)).toMatchObject({ state: 'ready', model: 'minilm', device: 'wasm' });
    expect(pushes.at(-1)).toMatchObject({ status: 'ready', model: 'minilm', device: 'wasm' });
    expect(model.pipelines).toEqual([{ task: 'feature-extraction', id: '/models/Xenova/all-MiniLM-L6-v2', dtype: 'q8', device: 'wasm' }]);
    expect(fakeTf.env.allowRemoteModels).toBe(false);
    expect(fakeTf.env.useBrowserCache).toBe(false);
    expect(fakeTf.env.backends.onnx.wasm.wasmPaths).toEqual({
      mjs: 'chrome-extension://test/lib/vendor/ort-wasm-simd-threaded.jsep.mjs',
      wasm: 'chrome-extension://test/lib/vendor/ort-wasm-simd-threaded.jsep.wasm'
    });
    expect(provider.calibrationId).toBe(`minilm.q8@${CALIBRATIONS.minilm.corpusHash}`);
    expect(provider.floor).toEqual(CALIBRATIONS.minilm.floor);

    const { results } = await provider.decideBatch(contextReq(['Our chef earned a Michelin star for the tasting menu.', 'We are hiring a backend engineer.']));
    expect(results.map((r) => r.id)).toEqual(['0', '1']);
    for (const r of results) {
      expect(r.answers[Q.MATCHES_PROMPT]).toMatchObject({ type: 'noul', source: 'system1' });
      expect(r.answers[Q.PRIMARY_TAG]).toMatchObject({ type: 'choice', source: 'system1' });
    }
    expect(results[0].answers[Q.MATCHES_PROMPT].noul).toBeGreaterThan(results[1].answers[Q.MATCHES_PROMPT].noul);
    expect(model.maxActive).toBe(1);
  });

  test('model calls stay one at a time across concurrent decides; vectors are cached per text', async () => {
    const { client, send, model } = hostSetup();
    expect(await send('S1_LOAD', { model: 'minilm' })).toMatchObject({ ok: true, model: 'minilm', device: 'wasm' });
    const callsAfterLoad = model.calls;
    const spec = { specHash: 's', prompt: { raw: PROMPT }, tags: [], questions: [Q.MATCHES_PROMPT] };
    const [a, b] = await Promise.all([
      send('S1_DECIDE', { model: 'minilm', items: [{ id: 'a', text: 'Fine dining menu' }], spec }),
      send('S1_DECIDE', { model: 'minilm', items: [{ id: 'b', text: 'Fine dining menu' }, { id: 'c', text: 'Quarterly earnings' }], spec })
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(b.results.map((r) => r.id)).toEqual(['b', 'c']);
    expect(b.results[0].answers[Q.MATCHES_PROMPT].noul).toBe(a.results[0].answers[Q.MATCHES_PROMPT].noul);
    expect(model.maxActive).toBe(1);
    // 2 query texts (raw + cleaned) + 2 distinct posts; the repeated post came from the cache.
    expect(model.calls - callsAfterLoad).toBe(4);
    const embedded = await send('S1_EMBED', { model: 'minilm', texts: ['Fine dining menu'] });
    expect(embedded.vectors[0]).toHaveLength(384);
    expect(Array.isArray(embedded.vectors[0])).toBe(true);
    expect(model.calls - callsAfterLoad).toBe(4);
    await send('S1_EMBED', { model: 'minilm', texts: ['Fine dining menu'], cache: false });
    expect(model.calls - callsAfterLoad).toBe(5);
    expect(await send('S1_CLEAR_CACHE')).toMatchObject({ ok: true });
    await send('S1_EMBED', { model: 'minilm', texts: ['Fine dining menu'] });
    expect(model.calls - callsAfterLoad).toBe(6);
  });

  test('refuses work without a model or for another model; switches models on S1_LOAD', async () => {
    const { send, model } = hostSetup();
    expect(await send('S1_DECIDE', { model: 'minilm', items: [], spec: {} })).toMatchObject({ ok: false, code: 'not_loaded' });
    expect(await send('S1_EMBED', { texts: ['x'] })).toMatchObject({ ok: false, code: 'not_loaded' });
    expect(await send('S1_LOAD', { model: 'gpt' })).toMatchObject({ ok: false, code: 'unknown_model' });
    await send('S1_LOAD', { model: 'minilm' });
    expect(await send('S1_DECIDE', { model: 'bge-small', items: [], spec: {} })).toMatchObject({ ok: false, code: 'model_mismatch', model: 'minilm' });
    expect(await send('S1_LOAD', { model: 'minilm' })).toMatchObject({ ok: true, cached: true });
    const switched = await send('S1_LOAD', { model: 'bge-small' });
    expect(switched).toMatchObject({ ok: true, model: 'bge-small', calibrationId: `bge-small.q8@${CALIBRATIONS['bge-small'].corpusHash}` });
    expect(model.pipelines.map((p) => p.id)).toEqual(['/models/Xenova/all-MiniLM-L6-v2', '/models/Xenova/bge-small-en-v1.5']);
    expect(await send('S1_UNLOAD')).toMatchObject({ ok: true, model: 'bge-small' });
    expect((await send('OFFSCREEN_PING')).s1.state).toBe('idle');
  });

  test('idle eviction: the host unloads a model nobody used for idleUnloadMs and says so; use keeps it; the next decide reloads it', async () => {
    const { client, send, pushes, model, wire } = hostSetup({ idleUnloadMs: 2000 });
    const provider = createLocalSystem1({ client, getConfig: () => ({ system1: { model: 'minilm' } }), batchWindowMs: 1 });
    wire.relay = (msg) => provider.handleStatusPush(msg);
    expect(await provider.ensureLoaded()).toBe(true);

    // Decisions keep it loaded.
    for (let i = 0; i < 5; i++) {
      await tick(300);
      const { results } = await provider.decideBatch(contextReq([`Our chef earned a Michelin star, take ${i}.`]));
      expect(results[0].answers).toBeTruthy();
    }
    expect(pushes.some((p) => p.status === 'unloaded')).toBe(false);

    // Then nothing for longer than idleUnloadMs: disposed, pushed, the provider is idle (not an error).
    for (let waited = 0; waited < 8000 && !pushes.some((p) => p.status === 'unloaded'); waited += 50) await tick(50);
    expect(pushes.at(-1)).toEqual({ status: 'unloaded', model: 'minilm', detail: 'idle' });
    expect((await send('OFFSCREEN_PING')).s1.state).toBe('idle');
    expect(provider.status()).toMatchObject({ state: 'unavailable', detail: 'not_loaded' });

    // The next post loads it again and is decided.
    const pipelines = model.pipelines.length;
    const { results } = await provider.decideBatch(contextReq(['Our chef earned a Michelin star for the tasting menu.']));
    expect(results[0].answers[Q.MATCHES_PROMPT]).toMatchObject({ type: 'noul', source: 'system1' });
    expect(model.pipelines.length).toBe(pipelines + 1);
    expect(provider.status().state).toBe('ready');
    expect(await send('S1_UNLOAD')).toMatchObject({ ok: true });
  }, 20000);

  test('a stale calibration fails the load with calibration_mismatch, reported to the provider', async () => {
    const stale = { ...CALIBRATIONS, minilm: { ...CALIBRATIONS.minilm, corpusHash: 'deadbeef' } };
    const { client, pushes } = hostSetup({ calibrations: stale });
    const provider = createLocalSystem1({ client, getConfig: () => ({ model: 'minilm' }) });
    expect(await provider.ensureLoaded()).toBe(false);
    expect(provider.status()).toMatchObject({ state: 'error', detail: 'calibration_mismatch' });
    expect(provider.status().lastError).toMatch(/background corpus changed/);
    expect(pushes.at(-1)).toMatchObject({ status: 'error', model: 'minilm', detail: 'calibration_mismatch' });
  });

  test('the router ignores other targets and refuses web-page senders and unknown types', async () => {
    const { host } = hostSetup();
    const route = createOffscreenRouter(host);
    let reply;
    expect(route({ type: 'STATE_UPDATED', payload: {} }, {}, (r) => (reply = r))).toBe(false);
    expect(reply).toBeUndefined();
    expect(route({ type: 'S1_LOAD', target: 'offscreen' }, { tab: { id: 1 }, url: 'https://www.linkedin.com/feed/' }, (r) => (reply = r))).toBe(false);
    expect(reply).toMatchObject({ ok: false, code: 'forbidden' });
    expect(route({ type: 'NOPE', target: 'offscreen' }, {}, (r) => (reply = r))).toBe(false);
    expect(reply).toMatchObject({ ok: false, code: 'unsupported' });
    expect(route({ type: 'S1_LOAD', target: 'offscreen', payload: { model: 'minilm' } }, {}, () => {})).toBe(true);
  });
});
