/**
 * Local System 1 provider (service worker side): implements the cascade's System1Provider
 * (lib/decision/cascade.js) on top of the offscreen host (offscreen/system1-host.js) through
 * lib/offscreen-client.js.
 *
 *  - Loading: lazy. isReady() starts the load (S1_LOAD) and answers false until the host replied;
 *    waitUntilReady(ms) / ensureLoaded() wait for it. Load progress arrives as S1_STATUS pushes,
 *    which the background routes to handleStatusPush(). A failed load is retried by the cascade
 *    only after `retryAfterMs`; ensureLoaded() (user action) retries at once.
 *  - Micro-batching: decideBatch() calls are queued and flushed after `batchWindowMs` (25 ms) or as
 *    soon as `maxBatch` (16) items are waiting; each flush sends ONE S1_DECIDE per spec with at most
 *    `maxBatch` items, one at a time (the host is single-flight anyway, so a timeout measures work,
 *    not queueing). Items get internal ids, so concurrent callers with the same ids never mix.
 *  - Timeouts: an S1_DECIDE without a reply in `decideTimeoutMs` (30 s) resolves its items with
 *    error 's1_timeout'; while the model is (first) loading a flush waits up to `loadTimeoutMs`
 *    (180 s) for it. The cascade treats item errors as "System 1 did not answer" (rules fill in).
 *  - Model switch: when the configured model differs from the loaded one, the next load sends
 *    S1_UNLOAD then S1_LOAD (reconfigure() does it right away).
 *  - The offscreen document may be re-created behind our back (the client retries once on "no
 *    receiver"): a host answering 'not_loaded' / 'model_mismatch' is reloaded and the batch retried
 *    once.
 *  - calibrationId '<model>.<dtype>@<corpusHash>' and the calibration's floors are known before the
 *    model is (the calibration JSON is fetched eagerly), so the cascade's spec hash and floors do
 *    not change when the model becomes ready.
 *
 *  - Explicit model (the idle refinement pass, lib/pipeline/refine.js): decideBatch({ model }) with a
 *    model other than the configured one sends S1_DECIDE { model, secondary: true }: the host decides
 *    with that model next to the active one (loading it on first use, without unloading the active
 *    model). Such batches never change this provider's status or latency samples; release(model)
 *    frees the secondary model again. Without `model` (or with the active one) nothing changes.
 *
 * onStatus(partial) receives EngineStatus.system1 updates ({ state, model, device, progress,
 * detail, lastError, loadMs, lastLatencyMs }; absent values are null so a shallow merge clears
 * them).
 */
import { MSG } from '../../messages.js';
import { MODEL_REGISTRY, DEFAULT_MODEL_KEY } from '../models.js';
import { resolveIntelligence, DEFAULT_INTELLIGENCE } from '../../storage/schema.js';
import { BACKGROUND_CORPUS } from '../background-corpus.js';
import { hashTexts } from '../system1-math.js';
import { Q } from '../types.js';
import { isLensQuestionId } from '../lenses.js';

export const S1_TIMEOUT = 's1_timeout';
export const SYSTEM1_DISPLAY_NAME = 'System 1 (local embeddings)';
const CORPUS_HASH = hashTexts([...BACKGROUND_CORPUS]);
const SAMPLE_SIZE = 200;
const MAX_ERROR_CHARS = 200;
const UNLOAD_TIMEOUT_MS = 10000;
const TIMEOUT = Symbol('timeout');
/** Fixed synthetic post for testConnection() (never user data). */
const TEST_POST = 'Our chef just earned a Michelin star for the new seasonal tasting menu.';

/** @param {unknown} err */
function errorText(err) {
  const raw = err && typeof err === 'object' && 'message' in err ? /** @type {any} */ (err).message : err;
  return String(raw ?? 'error').replace(/\s+/g, ' ').slice(0, MAX_ERROR_CHARS);
}

/** @param {number} n */
const round1 = (n) => Math.round(n * 10) / 10;

/**
 * System 1 settings from whatever getConfig() returns: a configuration, a resolved
 * configuration.intelligence, its `system1` block, or nothing (defaults).
 * @param {any} raw
 * @returns {{ enabled: boolean, model: string, device: string, dtype: string }}
 */
export function system1Settings(raw) {
  /** @type {any} */
  let s1;
  if (raw && typeof raw === 'object' && 'intelligence' in raw) s1 = resolveIntelligence(raw).system1;
  else if (raw && typeof raw === 'object' && raw.system1 && typeof raw.system1 === 'object') s1 = { ...DEFAULT_INTELLIGENCE.system1, ...raw.system1 };
  else if (raw && typeof raw === 'object' && ('model' in raw || 'enabled' in raw)) s1 = { ...DEFAULT_INTELLIGENCE.system1, ...raw };
  else s1 = { ...DEFAULT_INTELLIGENCE.system1 };
  const model = MODEL_REGISTRY[s1.model] ? s1.model : DEFAULT_MODEL_KEY;
  return {
    enabled: s1.enabled !== false,
    model,
    device: typeof s1.device === 'string' ? s1.device : 'wasm',
    dtype: MODEL_REGISTRY[model].dtype
  };
}

/**
 * Default calibration loader: the bundled JSON (fetch works for extension URLs in the service worker).
 * @param {string} model
 * @param {string} dtype
 */
async function fetchCalibration(model, dtype) {
  const url = globalThis.chrome?.runtime?.getURL?.(`lib/decision/calibration/${model}.${dtype}.json`);
  if (!url || typeof fetch !== 'function') return null;
  const res = await fetch(url);
  return res.ok ? res.json() : null;
}

/**
 * @param {{
 *   client: { sendToOffscreen: (type: string, payload?: object, opts?: { timeoutMs?: number }) => Promise<any> },
 *   getConfig?: () => any,
 *   onStatus?: ((partial: Record<string, any>) => void)|null,
 *   now?: () => number,
 *   loadCalibration?: (model: string, dtype: string) => Promise<any>,
 *   setTimer?: typeof setTimeout,
 *   clearTimer?: typeof clearTimeout,
 *   batchWindowMs?: number,
 *   maxBatch?: number,
 *   decideTimeoutMs?: number,
 *   loadTimeoutMs?: number,
 *   retryAfterMs?: number
 * }} deps
 */
export function createLocalSystem1({
  client,
  getConfig = () => null,
  onStatus = null,
  now = Date.now,
  loadCalibration = fetchCalibration,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  batchWindowMs = 25,
  maxBatch = 16,
  decideTimeoutMs = 30000,
  loadTimeoutMs = 180000,
  retryAfterMs = 30000
}) {
  if (!client || typeof client.sendToOffscreen !== 'function') throw new TypeError('createLocalSystem1: client.sendToOffscreen is required');
  const batchMax = Math.max(1, maxBatch);

  /** Last settings read from getConfig(). */
  let desired = system1Settings(null);
  /** @type {null|{ model: string, device: string, dtype: string, loadMs: number|null, calibrationId: string|null, floor: Record<string, number>|null }} */
  let loaded = null;
  /** @type {'idle'|'loading'|'ready'|'error'|'disabled'} */
  let state = 'idle';
  /** @type {number|null} */
  let progress = null;
  /** @type {string|null} */
  let detail = null;
  /** @type {string|null} */
  let lastError = null;
  let lastErrorAt = 0;
  /** @type {Promise<boolean>|null} */
  let loadPromise = null;
  /** @type {string|null} */
  let loadingModel = null;
  let loadGen = 0;
  /** model -> calibration JSON (or a pending fetch) */
  const calibrations = new Map();
  /** @type {Set<string>} */
  const calibrationFetches = new Set();

  const stats = { calls: 0, items: 0, errors: 0, timeouts: 0, secondaryCalls: 0, secondaryItems: 0, secondaryErrors: 0, /** @type {number|null} */ lastLatencyMs: null, /** @type {number[]} */ samples: [], cursor: 0 };

  /** @type {{ job: any, index: number, id: any, uid: string, text: string }[]} */
  let pending = [];
  /** @type {ReturnType<typeof setTimeout>|null} */
  let flushTimer = null;
  let draining = false;
  let uidSeq = 0;

  // ---------------------------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------------------------

  function publicState() {
    return state === 'idle' ? 'unavailable' : state;
  }

  function statusPartial() {
    return {
      state: publicState(),
      model: loaded?.model ?? desired.model,
      device: loaded?.device ?? desired.device,
      progress: state === 'loading' && Number.isFinite(progress) ? progress : null,
      detail: state === 'idle' ? 'not_loaded' : detail,
      lastError,
      loadMs: loaded?.loadMs ?? null,
      lastLatencyMs: stats.lastLatencyMs
    };
  }

  function emit() {
    if (typeof onStatus !== 'function') return;
    try {
      onStatus(statusPartial());
    } catch {
      /* status is best effort */
    }
  }

  /**
   * @param {'idle'|'loading'|'ready'|'error'|'disabled'} next
   * @param {{ progress?: number|null, detail?: string|null }} [extra]
   */
  function setState(next, extra = {}) {
    state = next;
    progress = next === 'loading' ? (Number.isFinite(extra.progress) ? /** @type {number} */ (extra.progress) : progress) : null;
    if ('detail' in extra) detail = extra.detail ?? null;
    else if (next !== 'loading') detail = null;
    emit();
  }

  // ---------------------------------------------------------------------------------------------
  // Configuration and calibration
  // ---------------------------------------------------------------------------------------------

  /** @param {string} model */
  function ensureCalibration(model) {
    if (calibrations.has(model) || calibrationFetches.has(model)) return;
    calibrationFetches.add(model);
    Promise.resolve()
      .then(() => loadCalibration(model, MODEL_REGISTRY[model]?.dtype || 'q8'))
      .then((cal) => {
        if (cal && typeof cal === 'object' && (!cal.model || cal.model === model)) calibrations.set(model, cal);
      })
      .catch(() => {})
      .finally(() => calibrationFetches.delete(model));
  }

  async function refreshConfig() {
    let raw = null;
    try {
      raw = await getConfig();
    } catch {
      raw = null;
    }
    desired = system1Settings(raw);
    ensureCalibration(desired.model);
    if (!desired.enabled && state !== 'disabled') setState('disabled');
    else if (desired.enabled && state === 'disabled') setState('idle');
    return desired;
  }

  function currentCalibrationId() {
    const model = desired.model;
    if (loaded && loaded.model === model && loaded.calibrationId) return loaded.calibrationId;
    const cal = calibrations.get(model);
    return `${model}.${MODEL_REGISTRY[model]?.dtype || 'q8'}@${cal?.corpusHash || CORPUS_HASH}`;
  }

  function currentFloor() {
    const model = desired.model;
    if (loaded && loaded.model === model && loaded.floor) return { ...loaded.floor };
    const floor = calibrations.get(model)?.floor;
    return floor && typeof floor === 'object' ? { ...floor } : null;
  }

  // ---------------------------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------------------------

  /** @param {{ model: string, device: string, dtype: string }} cfg */
  async function doLoad(cfg) {
    const gen = ++loadGen;
    setState('loading', { progress: 0, detail: 'starting' });
    try {
      if (loaded && loaded.model !== cfg.model) {
        // Model switch: free the old model first.
        loaded = null;
        await client.sendToOffscreen(MSG.S1_UNLOAD, {}, { timeoutMs: UNLOAD_TIMEOUT_MS }).catch(() => {});
      }
      const t0 = now();
      const reply = await client.sendToOffscreen(MSG.S1_LOAD, { model: cfg.model, device: cfg.device, dtype: cfg.dtype }, { timeoutMs: loadTimeoutMs });
      if (gen !== loadGen) return false;
      if (!reply || reply.ok !== true) {
        throw Object.assign(new Error(reply?.error || 'The local System 1 model failed to load.'), { code: reply?.code || 's1_load_error' });
      }
      if (reply.model && reply.model !== cfg.model) throw Object.assign(new Error(`The host loaded ${reply.model}`), { code: 'model_mismatch' });
      loaded = {
        model: cfg.model,
        device: typeof reply.device === 'string' ? reply.device : 'wasm',
        dtype: cfg.dtype,
        loadMs: Number.isFinite(reply.loadMs) ? reply.loadMs : round1(now() - t0),
        calibrationId: typeof reply.calibrationId === 'string' ? reply.calibrationId : null,
        floor: reply.floor && typeof reply.floor === 'object' ? reply.floor : null
      };
      lastError = null;
      setState('ready');
      return true;
    } catch (err) {
      if (gen !== loadGen) return false;
      loaded = null;
      lastError = errorText(err);
      lastErrorAt = now();
      const code = /** @type {any} */ (err)?.code === 'timeout' ? S1_TIMEOUT : /** @type {any} */ (err)?.code || 's1_load_error';
      setState('error', { detail: code });
      return false;
    } finally {
      if (gen === loadGen) {
        loadPromise = null;
        loadingModel = null;
      }
    }
  }

  /**
   * Single-flight load of `cfg.model` (synchronously marks the provider as loading).
   * @param {{ model: string, device: string, dtype: string }} cfg
   * @returns {Promise<boolean>}
   */
  function loadWith(cfg) {
    if (state === 'ready' && loaded?.model === cfg.model) return Promise.resolve(true);
    if (loadPromise && loadingModel === cfg.model) return loadPromise;
    loadingModel = cfg.model;
    loadPromise = doLoad(cfg);
    return loadPromise;
  }

  /**
   * Loads the configured model now (single flight; also after an error).
   * @returns {Promise<boolean>}  true when ready
   */
  async function ensureLoaded() {
    const cfg = await refreshConfig();
    if (!cfg.enabled) return false;
    return loadWith(cfg);
  }

  function inBackoff() {
    return state === 'error' && now() - lastErrorAt < retryAfterMs;
  }

  /** @returns {Promise<boolean>} */
  async function isReady() {
    const cfg = await refreshConfig();
    if (!cfg.enabled) return false;
    if (state === 'ready' && loaded?.model === cfg.model) return true;
    if (!inBackoff()) loadWith(cfg).catch(() => {});
    return false;
  }

  /**
   * @template T
   * @param {Promise<T>} promise
   * @param {number} ms
   * @returns {Promise<T|typeof TIMEOUT>}
   */
  function within(promise, ms) {
    return new Promise((resolve, reject) => {
      const t = setTimer(() => resolve(TIMEOUT), Math.max(0, ms));
      promise.then(
        (v) => {
          clearTimer(t);
          resolve(v);
        },
        (e) => {
          clearTimer(t);
          reject(e);
        }
      );
    });
  }

  /**
   * @param {number} timeoutMs
   * @returns {Promise<boolean>}
   */
  async function waitUntilReady(timeoutMs) {
    if (await isReady()) return true;
    if (!desired.enabled || inBackoff()) return false;
    const ok = await within(ensureLoaded(), Number.isFinite(timeoutMs) ? timeoutMs : loadTimeoutMs);
    return ok === true && state === 'ready';
  }

  /** Unloads the model in the offscreen document. */
  async function unload() {
    loadGen += 1;
    loadPromise = null;
    loadingModel = null;
    const had = loaded;
    loaded = null;
    try {
      await client.sendToOffscreen(MSG.S1_UNLOAD, {}, { timeoutMs: UNLOAD_TIMEOUT_MS });
    } catch {
      /* the document may be gone already */
    }
    setState(desired.enabled ? 'idle' : 'disabled');
    return !!had;
  }

  /**
   * Re-reads the configuration: unloads when System 1 was turned off, switches the model when it
   * changed (unload + load) and otherwise makes sure it is loading.
   */
  async function reconfigure() {
    const before = loaded?.model ?? loadingModel;
    const cfg = await refreshConfig();
    if (!cfg.enabled) {
      if (loaded || loadPromise) await unload();
      else setState('disabled');
      return status();
    }
    if (before && before !== cfg.model) await ensureLoaded();
    else if (state !== 'ready' && !loadPromise) ensureLoaded().catch(() => {});
    return status();
  }

  // ---------------------------------------------------------------------------------------------
  // Status pushes (S1_STATUS from the offscreen host)
  // ---------------------------------------------------------------------------------------------

  /**
   * @param {any} msg  the S1_STATUS message or its payload { status, model, progress, detail, device, loadMs, error }
   * @returns {boolean} whether the push changed anything
   */
  function handleStatusPush(msg) {
    const p = msg && typeof msg === 'object' && msg.payload && typeof msg.payload === 'object' ? msg.payload : msg;
    if (!p || typeof p !== 'object' || typeof p.status !== 'string') return false;
    if (p.model && p.model !== desired.model) return false; // a model we no longer want
    switch (p.status) {
      case 'loading':
        if (state === 'ready' && loaded?.model === p.model) return false;
        setState('loading', {
          progress: Number.isFinite(p.progress) ? Math.min(1, Math.max(0, p.progress)) : progress,
          detail: typeof p.detail === 'string' ? p.detail.slice(0, 60) : detail
        });
        return true;
      case 'ready':
        // The S1_LOAD reply is authoritative (it carries the calibration); a ready host we are not
        // waiting for (e.g. after a service-worker restart) is picked up by asking it.
        if (state !== 'ready' && !loadPromise) {
          ensureLoaded().catch(() => {});
          return true;
        }
        return false;
      case 'error':
        if (loadPromise) return false; // the S1_LOAD reply reports it
        loaded = null;
        lastError = typeof p.error === 'string' ? p.error.slice(0, MAX_ERROR_CHARS) : 'System 1 error';
        lastErrorAt = now();
        setState('error', { detail: typeof p.detail === 'string' ? p.detail.slice(0, 60) : 's1_load_error' });
        return true;
      case 'unloaded':
        if (!loaded || loadPromise) return false;
        loaded = null;
        setState(desired.enabled ? 'idle' : 'disabled');
        return true;
      default:
        return false;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Deciding (micro-batched)
  // ---------------------------------------------------------------------------------------------

  /** @param {number} ms */
  function recordLatency(ms) {
    stats.lastLatencyMs = round1(ms);
    if (stats.samples.length < SAMPLE_SIZE) stats.samples.push(ms);
    else stats.samples[stats.cursor] = ms;
    stats.cursor = (stats.cursor + 1) % SAMPLE_SIZE;
  }

  /**
   * @param {{ job: any, index: number, id: any }} e
   * @param {object} result
   */
  function settle(e, result) {
    const job = e.job;
    if (job.results[e.index] !== undefined) return;
    job.results[e.index] = result;
    job.remaining -= 1;
    if (job.remaining === 0) job.resolve({ results: job.results });
  }

  /** @param {{ job: any, index: number, id: any }[]} batch @param {string} code */
  function failAll(batch, code) {
    for (const e of batch) settle(e, { id: e.id, error: code });
  }

  /** @returns {Promise<{ ok: true }|{ ok: false, code: string }>} */
  async function readyForDecide() {
    const cfg = await refreshConfig();
    if (!cfg.enabled) return { ok: false, code: 's1_disabled' };
    if (state === 'ready' && loaded?.model === cfg.model) return { ok: true };
    const ok = await within(ensureLoaded(), loadTimeoutMs);
    if (ok === TIMEOUT) return { ok: false, code: S1_TIMEOUT };
    return ok === true && state === 'ready' ? { ok: true } : { ok: false, code: 's1_unavailable' };
  }

  /** @param {{ uid: string, text: string, job: any }[]} batch */
  function sendDecide(batch) {
    const spec = batch[0].job.spec;
    return client.sendToOffscreen(
      MSG.S1_DECIDE,
      { model: loaded?.model ?? desired.model, items: batch.map((e) => ({ id: e.uid, text: e.text })), spec },
      { timeoutMs: decideTimeoutMs }
    );
  }

  /**
   * A batch for an explicit model that is not the active one (S1_DECIDE { secondary: true }).
   * @param {{ job: any, index: number, id: any, uid: string, text: string }[]} batch
   * @param {string} model
   */
  async function sendSecondary(batch, model) {
    try {
      const reply = await client.sendToOffscreen(
        MSG.S1_DECIDE,
        { model, secondary: true, items: batch.map((e) => ({ id: e.uid, text: e.text })), spec: batch[0].job.spec },
        // The first call loads the secondary model.
        { timeoutMs: loadTimeoutMs }
      );
      if (!reply || reply.ok !== true) {
        throw Object.assign(new Error(reply?.error || 'System 1 could not decide with the second model.'), { code: reply?.code || 's1_error' });
      }
      const byUid = new Map();
      for (const r of Array.isArray(reply.results) ? reply.results : []) if (r && r.id !== undefined) byUid.set(String(r.id), r);
      for (const e of batch) {
        const r = byUid.get(e.uid);
        if (r && r.answers && typeof r.answers === 'object') settle(e, { id: e.id, answers: r.answers, ms: r.ms });
        else settle(e, { id: e.id, error: (r && typeof r.error === 'string' && r.error) || 's1_missing' });
      }
      stats.secondaryCalls += 1;
      stats.secondaryItems += batch.length;
    } catch (err) {
      const raw = /** @type {any} */ (err)?.code;
      stats.secondaryErrors += 1;
      failAll(batch, raw === 'timeout' ? S1_TIMEOUT : typeof raw === 'string' && raw ? raw : 's1_error');
    }
  }

  /** @param {{ job: any, index: number, id: any, uid: string, text: string }[]} batch */
  async function sendBatch(batch) {
    const t0 = now();
    const explicit = batch[0].job.model;
    if (explicit) {
      const cfg = await refreshConfig();
      if (!cfg.enabled) {
        failAll(batch, 's1_disabled');
        return;
      }
      if (explicit !== cfg.model) {
        await sendSecondary(batch, explicit);
        return;
      }
    }
    try {
      let ready = await readyForDecide();
      if (!ready.ok) {
        failAll(batch, ready.code);
        return;
      }
      let reply = await sendDecide(batch);
      if (reply && reply.ok === false && (reply.code === 'not_loaded' || reply.code === 'model_mismatch')) {
        // The document was re-created (or another model was loaded): reload once and retry.
        loaded = null;
        setState('loading', { progress: 0, detail: 'reloading' });
        ready = await readyForDecide();
        if (!ready.ok) {
          failAll(batch, ready.code);
          return;
        }
        reply = await sendDecide(batch);
      }
      if (!reply || reply.ok !== true) {
        throw Object.assign(new Error(reply?.error || 'System 1 could not decide.'), { code: reply?.code || 's1_error' });
      }
      const byUid = new Map();
      for (const r of Array.isArray(reply.results) ? reply.results : []) if (r && r.id !== undefined) byUid.set(String(r.id), r);
      for (const e of batch) {
        const r = byUid.get(e.uid);
        if (r && r.answers && typeof r.answers === 'object') settle(e, { id: e.id, answers: r.answers, ms: r.ms });
        else settle(e, { id: e.id, error: (r && typeof r.error === 'string' && r.error) || 's1_missing', ...(r && Number.isFinite(r.ms) ? { ms: r.ms } : {}) });
      }
      stats.calls += 1;
      stats.items += batch.length;
      recordLatency(Number.isFinite(reply.ms) ? reply.ms : now() - t0);
      emit();
    } catch (err) {
      const raw = /** @type {any} */ (err)?.code;
      const code = raw === 'timeout' ? S1_TIMEOUT : typeof raw === 'string' && raw ? raw : 's1_error';
      stats.errors += 1;
      if (code === S1_TIMEOUT) stats.timeouts += 1;
      lastError = code === S1_TIMEOUT ? `System 1 did not answer within ${Math.round(decideTimeoutMs / 1000)} s` : errorText(err);
      lastErrorAt = now();
      emit();
      failAll(batch, code);
    }
  }

  /** Sends queued items, one S1_DECIDE (<= maxBatch items, one spec) at a time. */
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (pending.length) {
        const key = pending[0].job.key;
        const batch = [];
        const rest = [];
        for (const e of pending) {
          if (batch.length < batchMax && e.job.key === key) batch.push(e);
          else rest.push(e);
        }
        pending = rest;
        await sendBatch(batch);
      }
    } finally {
      draining = false;
    }
  }

  /** @param {number} delay */
  function scheduleFlush(delay) {
    if (flushTimer && delay > 0) return;
    if (flushTimer) clearTimer(flushTimer);
    flushTimer = setTimer(() => {
      flushTimer = null;
      drain().catch(() => {});
    }, delay);
  }

  /**
   * @param {unknown} questions
   * @returns {string[]|undefined}
   */
  function questionIds(questions) {
    if (!questions || typeof questions !== 'object') return undefined;
    const ids = Array.isArray(questions) ? questions.map(String) : Object.keys(questions);
    return ids.filter((id) => id === Q.MATCHES_PROMPT || id === Q.PRIMARY_TAG || isLensQuestionId(id));
  }

  /**
   * System1Provider.decideBatch (lib/decision/cascade.js). Never rejects: failures become per-item
   * `error` codes ('s1_timeout', 's1_unavailable', 's1_disabled', 's1_error', ...).
   *
   * @param {{
   *   items: { id: string, text: string }[],
   *   questions?: Record<string, unknown>,
   *   specHash?: string,
   *   context?: { prompt?: { raw: string, cleaned: string, expansion: string }, tags?: { label: string, description: string|null }[], lenses?: { id: string, qid: string, prompt: { raw: string, cleaned: string, expansion: string } }[] },
   *   model?: string
   * }} req   model: decide with this registry model (default: the configured one)
   * @returns {Promise<{ results: { id: string, answers?: Record<string, any>, ms?: number, error?: string }[] }>}
   */
  function decideBatch(req) {
    const items = Array.isArray(req?.items) ? req.items : [];
    if (!items.length) return Promise.resolve({ results: [] });
    const spec = {
      specHash: typeof req?.specHash === 'string' ? req.specHash : undefined,
      prompt: req?.context?.prompt || { raw: '', cleaned: '', expansion: '' },
      tags: Array.isArray(req?.context?.tags) ? req.context.tags : [],
      questions: questionIds(req?.questions),
      // Prompts of the lens:<id> questions (ENG-1); absent without lenses, so the host's spec is unchanged.
      ...(Array.isArray(req?.context?.lenses) && req.context.lenses.length ? { lenses: req.context.lenses } : {})
    };
    const model = typeof req?.model === 'string' && MODEL_REGISTRY[req.model] ? req.model : null;
    if (typeof req?.model === 'string' && !model) {
      return Promise.resolve({ results: items.map((it) => ({ id: it?.id, error: 'unknown_model' })) });
    }
    const key = `${model || ''}|${spec.specHash || JSON.stringify([spec.prompt, spec.tags, spec.questions])}`;
    return new Promise((resolve) => {
      const job = { spec, key, model, results: new Array(items.length), remaining: items.length, resolve };
      items.forEach((it, index) => {
        pending.push({ job, index, id: it?.id, uid: `s${++uidSeq}`, text: String(it?.text ?? '') });
      });
      scheduleFlush(pending.length >= batchMax ? 0 : batchWindowMs);
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Diagnostics
  // ---------------------------------------------------------------------------------------------

  /** ProviderStatus plus model details. */
  function status() {
    const s = statusPartial();
    /** @type {Record<string, any>} */
    const out = { state: s.state, model: s.model, device: s.device };
    if (s.detail) out.detail = s.detail;
    if (s.lastError) out.lastError = s.lastError;
    if (s.progress !== null) out.progress = s.progress;
    if (s.loadMs !== null) out.loadMs = s.loadMs;
    if (s.lastLatencyMs !== null) out.lastLatencyMs = s.lastLatencyMs;
    return out;
  }

  /** GET_DIAGNOSTICS providers.system1. */
  function diagnostics() {
    const sorted = [...stats.samples].sort((a, b) => a - b);
    const avg = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null;
    const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)] : null;
    return {
      model: loaded?.model ?? desired.model,
      device: loaded?.device ?? desired.device,
      state: publicState(),
      loadMs: loaded?.loadMs ?? null,
      lastLatencyMs: stats.lastLatencyMs,
      calls: stats.calls,
      items: stats.items,
      avgMs: avg === null ? null : round1(avg),
      p95Ms: p95 === null ? null : round1(p95),
      errors: stats.errors,
      timeouts: stats.timeouts,
      lastError,
      calibrationId: currentCalibrationId(),
      secondaryCalls: stats.secondaryCalls,
      secondaryItems: stats.secondaryItems,
      secondaryErrors: stats.secondaryErrors
    };
  }

  function resetStats() {
    stats.calls = 0;
    stats.items = 0;
    stats.errors = 0;
    stats.timeouts = 0;
    stats.secondaryCalls = 0;
    stats.secondaryItems = 0;
    stats.secondaryErrors = 0;
    stats.lastLatencyMs = null;
    stats.samples = [];
    stats.cursor = 0;
  }

  /**
   * Frees a secondary model loaded by decideBatch({ model }) (never the active model).
   * @param {string} model
   * @returns {Promise<boolean>}
   */
  async function release(model) {
    if (typeof model !== 'string' || !MODEL_REGISTRY[model]) return false;
    const cfg = await refreshConfig();
    if (model === cfg.model || model === loaded?.model || model === loadingModel) return false;
    try {
      const reply = await client.sendToOffscreen(MSG.S1_UNLOAD, { model }, { timeoutMs: UNLOAD_TIMEOUT_MS });
      return !!(reply && reply.ok && reply.released);
    } catch {
      return false;
    }
  }

  /**
   * TEST_PROVIDER 'system1': loads the model and decides one fixed synthetic post.
   * @returns {Promise<{ ok: boolean, latencyMs: number, model: string, error?: string, code?: string }>}
   */
  async function testConnection() {
    const t0 = now();
    const ready = await ensureLoaded();
    if (!ready) {
      return { ok: false, latencyMs: round1(now() - t0), model: desired.model, error: lastError || 'System 1 is not available.', code: desired.enabled ? 's1_unavailable' : 's1_disabled' };
    }
    const t1 = now();
    const { results } = await decideBatch({
      items: [{ id: 'test', text: TEST_POST }],
      questions: { [Q.MATCHES_PROMPT]: true },
      context: { prompt: { raw: 'restaurant and fine dining posts', cleaned: 'restaurant and fine dining', expansion: '' }, tags: [] }
    });
    const r = results[0];
    if (!r?.answers) return { ok: false, latencyMs: round1(now() - t1), model: desired.model, error: 'System 1 did not answer.', code: r?.error || 's1_error' };
    return { ok: true, latencyMs: round1(now() - t1), model: desired.model };
  }

  // Fetch the default calibration right away so floors and calibrationId are known early.
  ensureCalibration(desired.model);
  refreshConfig().catch(() => {});

  return {
    id: 'system1',
    displayName: SYSTEM1_DISPLAY_NAME,
    isCloud: false,
    get calibrationId() {
      return currentCalibrationId();
    },
    get floor() {
      return currentFloor();
    },
    isReady,
    waitUntilReady,
    ensureLoaded,
    decideBatch,
    status,
    diagnostics,
    resetStats,
    reconfigure,
    unload,
    release,
    handleStatusPush,
    testConnection
  };
}
