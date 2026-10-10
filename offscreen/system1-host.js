/**
 * Local System 1 host (runs in the offscreen document).
 *
 * Loads a bundled q8 sentence-embedding model with Transformers.js on the WASM backend (the
 * document is cross-origin isolated, so ONNX Runtime runs multi-threaded) and answers the
 * decision questions through lib/decision/system1-scorer.js, the same code the Node eval
 * (eval/run-eval.mjs) measured the calibration with.
 *
 *  - Weights, tokenizer and ORT wasm are bundled (dist/ext/models, dist/ext/lib/vendor): remote
 *    models are disabled and nothing is fetched from the network. Transformers.js 3.4 does not
 *    prefix env.localModelPath onto local paths, so the model id is the root-relative bundled path
 *    '/models/<repo id>' (fetch resolves it against chrome-extension://<id>/).
 *  - One text per model call: q8 quantizes activations per call, so a vector depends on whatever it
 *    is batched with; the calibration and the parity reference vectors use single-text calls too.
 *  - Vectors are cached per exact text in IndexedDB (offscreen/embedding-cache.js).
 *  - All model work (load, unload, decide, embed, cache clear) runs one call at a time; OFFSCREEN_PING
 *    and status never wait for it.
 *  - Load progress is pushed to the service worker as S1_STATUS { status, model, progress, ... }.
 *  - Idle eviction: after `idleUnloadMs` (10 min) without a load, decide or embed call the model is
 *    disposed and S1_STATUS { status: 'unloaded', detail: 'idle' } is pushed; the service worker
 *    then closes this document, which frees the WASM heap and its worker threads (a WebAssembly
 *    memory never shrinks while the document lives). The next post loads the model again.
 */
import { MSG, TARGET } from '../lib/messages.js';
import { MODEL_REGISTRY } from '../lib/decision/models.js';
import { createSystem1Scorer, validateCalibration } from '../lib/decision/system1-scorer.js';
import { textHash } from '../lib/decision/state.js';
import { createEmbeddingCache, embeddingKey } from './embedding-cache.js';

/** Relative to this module (offscreen/), i.e. dist/ext/lib/vendor/transformers.min.js. */
const TRANSFORMERS_MODULE = '../lib/vendor/transformers.min.js';
const ORT_MJS = 'lib/vendor/ort-wasm-simd-threaded.jsep.mjs';
const ORT_WASM = 'lib/vendor/ort-wasm-simd-threaded.jsep.wasm';
const MAX_ERROR_CHARS = 300;
/** Share of the progress bar for fetching weights; the rest is warm-up and corpus vectors. */
const DOWNLOAD_SHARE = 0.85;
const PROGRESS_PUSH_MS = 250;
const MAX_ITEMS_PER_DECIDE = 256;
const MAX_TEXT_CHARS = 20000;
const MAX_EMBED_TEXTS = 64;
/** The model is disposed after this long without a load / decide / embed call (0 = never). */
export const S1_IDLE_UNLOAD_MS = 10 * 60 * 1000;
/** Timers may fire a little early: a call within this margin of the deadline still counts as idle. */
const IDLE_SLACK_MS = 1000;

/** @param {number} ms */
const round1 = (ms) => Math.round(ms * 10) / 10;

/** @param {unknown} err */
function errorText(err) {
  const raw = err && typeof err === 'object' && 'message' in err ? /** @type {any} */ (err).message : err;
  return String(raw ?? 'error').replace(/\s+/g, ' ').slice(0, MAX_ERROR_CHARS);
}

/** @param {unknown} err @param {string} fallback */
function errorCode(err, fallback) {
  const c = /** @type {any} */ (err)?.code;
  return typeof c === 'string' && c ? c : fallback;
}

/**
 * @param {{
 *   importTransformers?: () => Promise<any>,
 *   runtime?: any,
 *   fetchJson?: (url: string) => Promise<any>,
 *   cache?: ReturnType<typeof createEmbeddingCache>,
 *   push?: ((payload: object) => void)|null,
 *   now?: () => number,
 *   globals?: { crossOriginIsolated?: boolean, navigator?: any },
 *   idleUnloadMs?: number,
 *   setTimer?: typeof setTimeout,
 *   clearTimer?: typeof clearTimeout
 * }} [deps]
 */
export function createSystem1Host({
  importTransformers = () => import(TRANSFORMERS_MODULE),
  runtime = globalThis.chrome?.runtime,
  fetchJson = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} for ${url.split('/').slice(-1)[0]}`), { code: 'calibration_missing' });
    return res.json();
  },
  cache = createEmbeddingCache(),
  push = null,
  now = () => performance.now(),
  globals = globalThis,
  idleUnloadMs = S1_IDLE_UNLOAD_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  const sendStatus =
    push ||
    ((payload) => {
      try {
        const p = runtime?.sendMessage?.({ type: MSG.S1_STATUS, target: TARGET.BACKGROUND, payload });
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch {
        /* no receiver: the service worker reads the state on its next S1_LOAD */
      }
    });

  /** @type {Promise<any>|null} */
  let tfPromise = null;
  /** @type {any} Transformers.js env once imported */
  let tfEnv = null;
  /**
   * @type {null|{ key: string, spec: import('../lib/decision/models.js').EmbeddingModelSpec, extractor: any,
   *   scorer: ReturnType<typeof createSystem1Scorer>, device: string, loadMs: number, pipelineMs: number, warmupMs: number, calibrateMs: number }}
   */
  let current = null;
  /** @type {null|{ key: string, promise: Promise<object> }} */
  let loading = null;
  /** @type {{ status: string, model: string|null, progress?: number|null, detail?: string|null, error?: string|null }} */
  let lastStatus = { status: 'idle', model: null };
  const counters = { decideCalls: 0, decidedItems: 0, embedCalls: 0, modelCalls: 0, modelMs: 0, lastDecideMs: null, lastModelMs: null };

  /** Serial queue for every call that touches the model. */
  let chain = Promise.resolve();
  /**
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  function run(fn) {
    const p = chain.then(() => fn());
    chain = p.then(
      () => undefined,
      () => undefined
    );
    return p;
  }

  /** @param {object} payload */
  function status(payload) {
    lastStatus = { ...payload };
    sendStatus(payload);
  }

  // -------------------------------------------------------------------------------------------
  // Idle eviction
  // -------------------------------------------------------------------------------------------

  /** @type {ReturnType<typeof setTimeout>|null} */
  let idleTimer = null;
  let lastUsed = now();

  function clearIdle() {
    if (idleTimer !== null) clearTimer(idleTimer);
    idleTimer = null;
  }

  /** Records a model call (at its start and its end) and restarts the idle countdown. */
  function touch() {
    lastUsed = now();
    if (!(idleUnloadMs > 0)) return;
    clearIdle();
    idleTimer = setTimer(onIdle, idleUnloadMs);
    // Node (tests, the eval): never keep the process alive for this.
    /** @type {any} */ (idleTimer)?.unref?.();
  }

  function onIdle() {
    idleTimer = null;
    if (!current || loading) return;
    run(async () => {
      // Used (and so re-armed), reloading or unloaded while this waited for the queue.
      if (!current || loading || now() - lastUsed < idleUnloadMs - IDLE_SLACK_MS) return;
      const had = current.key;
      await disposeCurrent();
      status({ status: 'unloaded', model: had, detail: 'idle' });
    }).catch(() => {});
  }

  /**
   * @template T
   * @param {Promise<T>} promise
   * @returns {Promise<T>}
   */
  function touching(promise) {
    touch();
    return promise.finally(touch);
  }

  /** ORT's wasm thread count: the configured value once known, else ORT's default for this document. */
  function threads() {
    const configured = tfEnv?.backends?.onnx?.wasm?.numThreads;
    if (Number.isFinite(configured) && configured > 0) return configured;
    const hc = globals?.navigator?.hardwareConcurrency || 1;
    return globals?.crossOriginIsolated ? Math.min(4, Math.ceil(hc / 2)) : 1;
  }

  function caps() {
    return {
      crossOriginIsolated: !!globals?.crossOriginIsolated,
      webgpu: !!globals?.navigator?.gpu,
      threads: threads(),
      hardwareConcurrency: globals?.navigator?.hardwareConcurrency || null
    };
  }

  function describe() {
    return {
      state: current ? 'ready' : loading ? 'loading' : lastStatus.status === 'error' ? 'error' : 'idle',
      model: current?.key ?? loading?.key ?? lastStatus.model ?? null,
      device: current?.device ?? null,
      loadMs: current?.loadMs ?? null,
      ...(lastStatus.status === 'loading' && Number.isFinite(lastStatus.progress) ? { progress: lastStatus.progress } : {}),
      ...(lastStatus.status === 'error' && lastStatus.error ? { error: lastStatus.error } : {})
    };
  }

  async function transformers() {
    if (!tfPromise) {
      tfPromise = Promise.resolve()
        .then(() => importTransformers())
        .then((mod) => {
          const env = mod.env;
          env.allowRemoteModels = false;
          env.allowLocalModels = true;
          // Kept for documentation: 3.4 ignores it for local paths (see the module comment).
          env.localModelPath = '/models/';
          env.useBrowserCache = false;
          env.backends.onnx.wasm.wasmPaths = { mjs: runtime.getURL(ORT_MJS), wasm: runtime.getURL(ORT_WASM) };
          tfEnv = env;
          return mod;
        })
        .catch((err) => {
          tfPromise = null;
          throw err;
        });
    }
    return tfPromise;
  }

  /**
   * One model call for one text.
   * @param {any} extractor
   * @param {import('../lib/decision/models.js').EmbeddingModelSpec} spec
   * @param {string} text
   */
  async function embedOne(extractor, spec, text) {
    const t0 = now();
    const out = await extractor(text, { pooling: spec.pooling, normalize: true });
    const v = Float32Array.from(out.data);
    try {
      out.dispose?.();
    } catch {
      /* tensors of the wasm backend live in JS memory */
    }
    const ms = now() - t0;
    counters.modelCalls += 1;
    counters.modelMs = round1(counters.modelMs + ms);
    counters.lastModelMs = round1(ms);
    return v;
  }

  /**
   * Cached embed function for the scorer (and S1_EMBED).
   * @param {string} key
   * @param {import('../lib/decision/models.js').EmbeddingModelSpec} spec
   * @param {any} extractor
   */
  function makeEmbed(key, spec, extractor) {
    /**
     * @param {string[]} texts
     * @param {{ isQuery?: boolean, useCache?: boolean }} [opts]
     */
    return async (texts, { useCache = true } = {}) => {
      const keys = texts.map((t) => embeddingKey(key, spec.dtype, textHash(t)));
      const hits = useCache ? await cache.getMany(keys) : texts.map(() => null);
      /** @type {Float32Array[]} */
      const out = new Array(texts.length);
      const fresh = [];
      for (let i = 0; i < texts.length; i++) {
        if (hits[i]) {
          out[i] = /** @type {Float32Array} */ (hits[i]);
          continue;
        }
        out[i] = await embedOne(extractor, spec, texts[i]);
        fresh.push({ key: keys[i], vector: out[i] });
      }
      if (useCache && fresh.length) await cache.setMany(fresh);
      return out;
    };
  }

  async function disposeCurrent() {
    const cur = current;
    current = null;
    if (!cur) return;
    try {
      await cur.extractor?.dispose?.();
    } catch {
      /* best effort */
    }
  }

  /**
   * @param {string} key
   * @returns {Promise<object>}
   */
  async function doLoad(key) {
    const spec = MODEL_REGISTRY[key];
    // A queued load whose model got loaded meanwhile (A, B, A requested quickly) has nothing to do.
    if (current?.key === key) return readyReply(true);
    const started = now();
    /** @type {any} */
    let extractor = null;
    try {
      await disposeCurrent();
      status({ status: 'loading', model: key, progress: 0, detail: 'starting' });

      const calibration = await fetchJson(runtime.getURL(`lib/decision/calibration/${key}.${spec.dtype}.json`));
      validateCalibration(calibration, { modelSpec: spec });

      const tf = await transformers();
      /** file -> { loaded, total } */
      const files = new Map();
      let lastPush = 0;
      let lastProgress = 0;
      const progress_callback = (/** @type {any} */ e) => {
        if (!e || typeof e !== 'object' || !e.file) return;
        const f = files.get(e.file) || { loaded: 0, total: 0 };
        if (Number.isFinite(e.total) && e.total > 0) f.total = e.total;
        if (Number.isFinite(e.loaded)) f.loaded = e.loaded;
        if (e.status === 'done' && f.total) f.loaded = f.total;
        files.set(e.file, f);
        let loaded = 0;
        let total = 0;
        for (const x of files.values()) {
          loaded += x.loaded;
          total += x.total;
        }
        const p = total > 0 ? Math.min(1, loaded / total) * DOWNLOAD_SHARE : 0;
        const t = now();
        if (p > lastProgress && (t - lastPush >= PROGRESS_PUSH_MS || p - lastProgress >= 0.1)) {
          lastPush = t;
          lastProgress = p;
          status({ status: 'loading', model: key, progress: Math.round(p * 1000) / 1000, detail: 'loading weights' });
        }
      };
      extractor = await tf.pipeline('feature-extraction', `/models/${spec.id}`, { dtype: spec.dtype, device: 'wasm', progress_callback });
      const loadMs = round1(now() - started);

      status({ status: 'loading', model: key, progress: DOWNLOAD_SHARE, detail: 'warming up' });
      const tw = now();
      await embedOne(extractor, spec, 'Warming up the local decision model.');
      const warmupMs = round1(now() - tw);

      const scorer = createSystem1Scorer({ embed: makeEmbed(key, spec, extractor), calibration, modelSpec: spec });
      status({ status: 'loading', model: key, progress: 0.9, detail: 'background corpus' });
      const tc = now();
      await scorer.warm();
      const calibrateMs = round1(now() - tc);

      const totalMs = round1(now() - started);
      current = { key, spec, extractor, scorer, device: 'wasm', loadMs: totalMs, pipelineMs: loadMs, warmupMs, calibrateMs };
      status({ status: 'ready', model: key, device: 'wasm', loadMs: totalMs });
      return { ...readyReply(false), pipelineMs: loadMs, warmupMs, calibrateMs };
    } catch (err) {
      try {
        await extractor?.dispose?.();
      } catch {
        /* best effort */
      }
      current = null;
      const error = errorText(err);
      const code = errorCode(err, 's1_load_error');
      status({ status: 'error', model: key, error, detail: code });
      return { ok: false, model: key, error, code };
    }
  }

  /**
   * Reply for the loaded model.
   * @param {boolean} [alreadyLoaded]
   */
  function readyReply(alreadyLoaded = false) {
    const cur = /** @type {NonNullable<typeof current>} */ (current);
    return {
      ok: true,
      model: cur.key,
      device: cur.device,
      dtype: cur.spec.dtype,
      loadMs: cur.loadMs,
      cached: alreadyLoaded,
      calibrationId: cur.scorer.calibrationId,
      floor: cur.scorer.floor,
      caps: caps()
    };
  }

  /**
   * S1_LOAD { model, device, dtype } -> { ok, model, device, loadMs, calibrationId, floor, error?, code? }.
   * Idempotent: the loaded model answers at once, a load in progress is joined, another model
   * replaces the loaded one (unload + load).
   * @param {{ model?: string, device?: string, dtype?: string }} [payload]
   */
  function load(payload = {}) {
    const key = payload?.model;
    if (typeof key !== 'string' || !MODEL_REGISTRY[key]) {
      return Promise.resolve({ ok: false, code: 'unknown_model', error: `Unknown System 1 model: ${String(key).slice(0, 40)}` });
    }
    if (current?.key === key && !loading) return touching(Promise.resolve(readyReply(true)));
    if (loading?.key === key) return loading.promise;
    const entry = { key, promise: /** @type {Promise<object>} */ (Promise.resolve({})) };
    entry.promise = touching(run(() => doLoad(key)).finally(() => {
      if (loading === entry) loading = null;
    }));
    loading = entry;
    return entry.promise;
  }

  /**
   * Checks that `model` is (or is about to be) loaded.
   * @param {string|undefined} model
   * @returns {object|null}  an error reply, or null when the call may proceed
   */
  function refuse(model) {
    const target = loading?.key ?? current?.key ?? null;
    if (!target) return { ok: false, code: 'not_loaded', error: 'The System 1 model is not loaded.' };
    if (model && model !== target) return { ok: false, code: 'model_mismatch', error: `Loaded model is ${target}, not ${String(model).slice(0, 40)}.`, model: target };
    return null;
  }

  /**
   * S1_DECIDE { model, items:[{id,text}], spec } -> { ok, model, results:[{ id, answers, ms } | { id, error }], ms }
   * @param {{ model?: string, items?: { id: string, text: string }[], spec?: object }} [payload]
   */
  function decide(payload = {}) {
    const refused = refuse(payload?.model);
    if (refused) return Promise.resolve(refused);
    const items = (Array.isArray(payload?.items) ? payload.items : []).slice(0, MAX_ITEMS_PER_DECIDE).map((it) => ({
      id: String(it?.id ?? ''),
      text: String(it?.text ?? '').slice(0, MAX_TEXT_CHARS)
    }));
    return touching(run(async () => {
      const cur = current;
      if (!cur || (payload?.model && cur.key !== payload.model)) {
        return { ok: false, code: 'not_loaded', error: 'The System 1 model is not loaded.' };
      }
      const t0 = now();
      try {
        const spec = payload?.spec && typeof payload.spec === 'object' ? payload.spec : {};
        const results = await cur.scorer.decideItems(items, /** @type {any} */ (spec));
        const ms = round1(now() - t0);
        counters.decideCalls += 1;
        counters.decidedItems += items.length;
        counters.lastDecideMs = ms;
        return { ok: true, model: cur.key, results, ms, calibrationId: cur.scorer.calibrationId };
      } catch (err) {
        return { ok: false, model: cur.key, code: errorCode(err, 's1_error'), error: errorText(err), ms: round1(now() - t0) };
      }
    }));
  }

  /**
   * S1_EMBED { texts, isQuery, model?, cache? } -> { ok, model, vectors: number[][], ms }
   * Diagnostics and the browser/Node parity test: texts are embedded exactly as given.
   * @param {{ texts?: string[], isQuery?: boolean, model?: string, cache?: boolean }} [payload]
   */
  function embed(payload = {}) {
    const refused = refuse(payload?.model);
    if (refused) return Promise.resolve(refused);
    const texts = (Array.isArray(payload?.texts) ? payload.texts : []).slice(0, MAX_EMBED_TEXTS).map((t) => String(t ?? '').slice(0, MAX_TEXT_CHARS));
    return touching(run(async () => {
      const cur = current;
      if (!cur) return { ok: false, code: 'not_loaded', error: 'The System 1 model is not loaded.' };
      const t0 = now();
      try {
        const fn = makeEmbed(cur.key, cur.spec, cur.extractor);
        const vecs = await fn(texts, { isQuery: !!payload?.isQuery, useCache: payload?.cache !== false });
        counters.embedCalls += 1;
        return { ok: true, model: cur.key, vectors: vecs.map((v) => Array.from(v)), ms: round1(now() - t0) };
      } catch (err) {
        return { ok: false, model: cur.key, code: errorCode(err, 's1_error'), error: errorText(err) };
      }
    }));
  }

  /** S1_CLEAR_CACHE -> { ok } (persistent vectors only; the loaded model's prepared specs stay valid). */
  function clearCache() {
    return run(async () => {
      await cache.clear();
      return { ok: true };
    });
  }

  /** S1_UNLOAD -> { ok } */
  function unload() {
    return run(async () => {
      const had = current?.key ?? null;
      await disposeCurrent();
      clearIdle();
      status({ status: 'unloaded', model: had });
      return { ok: true, model: had };
    });
  }

  /** OFFSCREEN_PING -> { ok, caps, s1, stats } (never waits for the model). */
  function ping() {
    return { ok: true, caps: caps(), s1: describe(), stats: { ...counters, cache: cache.stats() } };
  }

  return {
    load,
    decide,
    embed,
    clearCache,
    unload,
    ping,
    describe,
    stats: () => ({ ...counters, cache: cache.stats(), scorer: current?.scorer.stats() ?? null })
  };
}
