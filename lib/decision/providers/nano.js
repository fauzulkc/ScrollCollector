/**
 * The browser's built-in LanguageModel (Gemini Nano in Chrome) as an on-device escalation provider,
 * plus the text/JSON generation used by lib/inference-engine.js (tag wand, prompt tags, prompt
 * expansion). It is the ONLY LLM tier: the extension never downloads a generative model.
 *
 *  - LanguageModel = globalThis.LanguageModel (exposed in the extension service worker).
 *  - The same OPTIONS (expected text in/out, English) go to availability() and create().
 *  - availability() is cached ~10 s (5 s while 'downloading'; with an onStatus listener it is polled
 *    every 5 s while downloading). 'downloadable' cannot be started here: the download needs a
 *    user click, which the side panel handles (NANO_DOWNLOAD_STATE -> noteDownload()).
 *  - Sessions: one base session per system prompt (initialPrompts), at most 2 kept (LRU, the
 *    evicted one is destroyed), created with temperature 0.2 + topK 3 together (clamped to
 *    LanguageModel.params() maxima when available; created again without them if that throws).
 *    Every call clones the base, prompts it (responseConstraint = the shared JSON schema) and
 *    destroys the clone.
 *  - QuotaExceededError (input too large): retried once with the post text halved, then code
 *    'nano_quota'.
 *  - Deadlines: an on-device prompt can stall (model service hiccup, model update) or crawl (CPU
 *    inference), and ingest decides one batch at a time. decide() / testConnection() give up after
 *    `decideTimeoutMs` (15 s), generateText() / generateJson() after `textTimeoutMs` (30 s), and
 *    availability() after NANO_AVAILABILITY_TIMEOUT_MS: the prompt is aborted, the call rejects with
 *    code 'timeout' even if the LanguageModel never settles, and a base session whose create() never
 *    finished is dropped. After a timeout isReady() answers false for `timeoutCooldownMs` (60 s), so
 *    System 1's answers stand without waiting on the model again.
 *  - decide() renders and maps answers like openai.js (lib/decision/providers/schema-builder.js).
 */
import { getBrowserModelDisplayName } from '../../inference/browser-detect.js';
import { createCallStats, readProviderSettings, providerError } from '../http.js';
import {
  DECISION_SYSTEM_PROMPT,
  buildQuestionPlan,
  renderUserPrompt,
  mapLlmAnswers,
  parseModelJson
} from './schema-builder.js';

export const NANO_ID = 'nano';
export const NANO_MAX_CONCURRENCY = 1;
export const NANO_AVAILABILITY_TTL_MS = 10000;
export const NANO_DOWNLOADING_POLL_MS = 5000;
export const NANO_MAX_SESSIONS = 2;
export const NANO_TEMPERATURE = 0.2;
export const NANO_TOP_K = 3;
/** Deadline of one decide() / testConnection() (both prompts of a quota retry included). */
export const NANO_DECIDE_TIMEOUT_MS = 15000;
/** Deadline of one generateText() / generateJson() (prompt tags, prompt expansion, tag wand). */
export const NANO_TEXT_TIMEOUT_MS = 30000;
/** Deadline of LanguageModel.availability(); a check that takes longer counts as 'unavailable'. */
export const NANO_AVAILABILITY_TIMEOUT_MS = 5000;
/** isReady() answers false this long after a timeout. */
export const NANO_TIMEOUT_COOLDOWN_MS = 60000;
const MAX_ERROR_CHARS = 200;
const MIN_HALVED_CHARS = 40;

/** Fixed synthetic post used by testConnection(). */
export const NANO_TEST_STATE = Object.freeze({ platform: 'example.com', text: 'Our neighbourhood bakery now sells sourdough croissants on weekends.' });
const NANO_TEST_QUESTIONS = Object.freeze({
  connection_test: Object.freeze({
    type: 'noul',
    instructions: 'Is this post about food?',
    criteria: Object.freeze({ true: 'The post is mainly about food.', false: 'The post is mainly about another subject.' })
  })
});

/**
 * The options passed identically to LanguageModel.availability() and create(). A fresh copy per
 * call, so the API can never see a mutated object.
 */
export function nanoOptions() {
  return {
    expectedInputs: [{ type: 'text', languages: ['en'] }],
    expectedOutputs: [{ type: 'text', languages: ['en'] }]
  };
}

/**
 * Current and legacy availability strings -> available | downloadable | downloading | unavailable.
 * @param {unknown} value
 */
export function normalizeAvailability(value) {
  switch (value) {
    case 'available':
    case 'readily':
      return 'available';
    case 'downloadable':
    case 'after-download':
      return 'downloadable';
    case 'downloading':
      return 'downloading';
    default:
      return 'unavailable';
  }
}

/** @param {unknown} err */
function isQuotaError(err) {
  const e = /** @type {any} */ (err);
  return e?.name === 'QuotaExceededError' || e?.code === 'nano_quota' || /quota/i.test(String(e?.message || ''));
}

/** @param {unknown} err */
function isAbortError(err) {
  const e = /** @type {any} */ (err);
  return e?.name === 'AbortError' || e?.name === 'TimeoutError';
}

/** Errors after which a cached base session is not reused. @param {unknown} err */
function isDeadSessionError(err) {
  const e = /** @type {any} */ (err);
  return e?.name === 'InvalidStateError' || /destroyed|invalid state|session/i.test(String(e?.message || ''));
}

/** @param {unknown} err */
function errorText(err) {
  const e = /** @type {any} */ (err);
  return String((e && typeof e.message === 'string' && e.message) || e || 'error').slice(0, MAX_ERROR_CHARS);
}

/**
 * Coded Error for anything the LanguageModel threw.
 * @param {unknown} err
 * @returns {Error & { code: string }}
 */
function toNanoError(err) {
  const e = /** @type {any} */ (err);
  if (e instanceof Error && typeof e.code === 'string' && e.code) return /** @type {any} */ (e);
  let code = 'error';
  if (isAbortError(e)) code = 'aborted';
  else if (isQuotaError(e)) code = 'nano_quota';
  else if (e?.name === 'NotSupportedError') code = 'unavailable';
  else if (e?.name === 'NotAllowedError') code = 'downloadable';
  return providerError(code, errorText(e));
}

/**
 * About half of `text`, cut on a word boundary when that keeps most of it.
 * @param {string} text
 */
function halve(text) {
  const s = String(text || '');
  const target = Math.max(MIN_HALVED_CHARS, Math.floor(s.length / 2));
  if (s.length <= target) return s.slice(0, Math.floor(s.length / 2));
  const cut = s.slice(0, target);
  const space = cut.lastIndexOf(' ');
  return (space >= target * 0.7 ? cut.slice(0, space) : cut).trimEnd();
}

/**
 * @param {{
 *   getConfig?: (() => unknown)|null,
 *   now?: () => number,
 *   languageModel?: any,
 *   onStatus?: ((status: object) => void)|null,
 *   context?: 'sw'|'offscreen'|'page',
 *   setTimer?: typeof setTimeout,
 *   clearTimer?: typeof clearTimeout,
 *   decideTimeoutMs?: number,
 *   textTimeoutMs?: number,
 *   availabilityTimeoutMs?: number,
 *   timeoutCooldownMs?: number
 * }} [deps]
 *   getConfig returns the stored `configuration` (or an `intelligence` object); providers.nano.enabled
 *   === false switches the provider (and the text helpers) off.
 *   languageModel overrides globalThis.LanguageModel (tests).
 *   onStatus is called whenever status() changes after an availability check or a download update.
 */
export function createNanoProvider({
  getConfig = null,
  now = Date.now,
  languageModel = undefined,
  onStatus = null,
  context = 'sw',
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  decideTimeoutMs = NANO_DECIDE_TIMEOUT_MS,
  textTimeoutMs = NANO_TEXT_TIMEOUT_MS,
  availabilityTimeoutMs = NANO_AVAILABILITY_TIMEOUT_MS,
  timeoutCooldownMs = NANO_TIMEOUT_COOLDOWN_MS
} = {}) {
  const displayName = getBrowserModelDisplayName();
  const stats = createCallStats({ now });
  let settings = readProviderSettings(null, NANO_ID);
  /** @type {'available'|'downloadable'|'downloading'|'unavailable'|null} */
  let availability = null;
  let checkedAt = -Infinity;
  /** @type {Promise<string>|null} */
  let pending = null;
  /** @type {number|null} 0..1 while the side panel reports a download */
  let progress = null;
  /** @type {string|null} */
  let lastError = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let pollTimer = null;
  let lastNotified = '';
  /** @type {Map<string, Promise<any>>} system prompt -> base session; Map order = LRU order */
  const sessions = new Map();
  /** @type {{ temperature: number, topK: number }|null|undefined} undefined until computed */
  let sampling;
  let samplingRejected = false;
  /** isReady() is false until then (set by a timeout) */
  let coolUntil = -Infinity;

  /** @returns {any} */
  function api() {
    return languageModel !== undefined ? languageModel : globalThis.LanguageModel;
  }

  /** @param {number} ms */
  function seconds(ms) {
    return Math.max(1, Math.round(ms / 1000));
  }

  function coolingDown() {
    return now() < coolUntil;
  }

  /**
   * Runs `work(signal)` with a deadline. After `timeoutMs` the signal aborts (the prompt is
   * cancelled) and the call rejects with code 'timeout', whether or not the LanguageModel ever
   * settles. The caller's `signal` cancels it too (code 'aborted').
   *
   * @template T
   * @param {(signal: AbortSignal) => Promise<T>} work
   * @param {{ signal?: AbortSignal, timeoutMs: number, what: string }} opts
   * @returns {Promise<T>}
   */
  function withDeadline(work, { signal, timeoutMs, what }) {
    const limit = Math.max(1, Number.isFinite(timeoutMs) ? timeoutMs : NANO_DECIDE_TIMEOUT_MS);
    const controller = new AbortController();
    return new Promise((resolve, reject) => {
      let settled = false;
      /** @type {ReturnType<typeof setTimeout>|null} */
      let timer = null;
      const onAbort = () => {
        controller.abort();
        finish(reject, providerError('aborted', `The ${what} was cancelled.`));
      };
      /** @param {(v: any) => void} fn @param {any} value */
      function finish(fn, value) {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimer(timer);
        signal?.removeEventListener?.('abort', onAbort);
        fn(value);
      }
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener?.('abort', onAbort, { once: true });
      timer = setTimer(() => {
        const err = providerError('timeout', `${displayName} did not finish the ${what} within ${seconds(limit)} s.`);
        controller.abort();
        finish(reject, err);
      }, limit);
      Promise.resolve()
        .then(() => work(controller.signal))
        .then((v) => finish(resolve, v), (e) => finish(reject, e));
    });
  }

  /**
   * Resolves with `promise`, or rejects once `signal` aborts (the promise itself may never settle).
   * @template T
   * @param {Promise<T>} promise
   * @param {AbortSignal} [signal]
   * @returns {Promise<T>}
   */
  function untilAborted(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (v) => {
          signal.removeEventListener('abort', onAbort);
          resolve(v);
        },
        (e) => {
          signal.removeEventListener('abort', onAbort);
          reject(e);
        }
      );
    });
  }

  /** A timeout: pause escalation to the model for a while and report it. */
  function noteTimeout(message) {
    lastError = message;
    coolUntil = now() + Math.max(0, timeoutCooldownMs);
    notify();
  }

  async function loadSettings() {
    let cfg = null;
    try {
      cfg = typeof getConfig === 'function' ? await getConfig() : null;
    } catch {
      cfg = null;
    }
    settings = readProviderSettings(cfg, NANO_ID);
    return settings;
  }

  /** @returns {import('../types.js').ProviderStatus & { present: string, availability?: string }} */
  function status() {
    const lm = api();
    const base = { present: lm ? context : 'none', ...(availability ? { availability } : {}), model: displayName };
    if (settings.enabled === false) return { ...base, state: 'disabled', detail: `${displayName} is switched off in Settings.` };
    if (!lm || typeof lm.availability !== 'function') {
      return { ...base, state: 'unavailable', detail: 'This browser does not expose the built-in LanguageModel (Prompt API).' };
    }
    const err = lastError ? { lastError } : {};
    switch (availability) {
      case null:
        return { ...base, state: 'loading', detail: `Checking whether ${displayName} is available…` };
      case 'available':
        // After a timeout the model is skipped for a while (isReady() is false): System 1 decides.
        if (coolingDown()) {
          return {
            ...base,
            ...err,
            state: 'ready',
            paused: 'timeout',
            detail: `${displayName} did not answer in time; uncertain posts keep System 1’s answer for a minute.`
          };
        }
        return { ...base, ...err, state: 'ready' };
      case 'downloadable':
        return {
          ...base,
          ...err,
          state: 'downloadable',
          detail: `${displayName} has to be downloaded first. The download needs a click: use Download/Enable in Settings > Intelligence.`
        };
      case 'downloading':
        return {
          ...base,
          ...err,
          state: 'downloading',
          detail: `${displayName} is downloading…`,
          ...(progress !== null ? { progress } : {})
        };
      default:
        return {
          ...base,
          ...err,
          state: 'unavailable',
          detail: `${displayName} is not available on this device (see chrome://on-device-internals).`
        };
    }
  }

  function notify() {
    if (typeof onStatus !== 'function') return;
    const s = status();
    const sig = JSON.stringify(s);
    if (sig === lastNotified) return;
    lastNotified = sig;
    try {
      onStatus(s);
    } catch {
      /* a listener failure must not break availability checks */
    }
  }

  function schedulePoll() {
    if (typeof onStatus !== 'function') return;
    if (availability !== 'downloading') {
      if (pollTimer) clearTimer(pollTimer);
      pollTimer = null;
      return;
    }
    if (pollTimer) return;
    pollTimer = setTimer(() => {
      pollTimer = null;
      checkAvailability({ force: true }).catch(() => {});
    }, NANO_DOWNLOADING_POLL_MS);
  }

  /**
   * LanguageModel.availability(OPTIONS), cached (10 s; 5 s while downloading).
   * @param {{ force?: boolean }} [opts]
   * @returns {Promise<'available'|'downloadable'|'downloading'|'unavailable'>}
   */
  async function checkAvailability({ force = false } = {}) {
    const lm = api();
    if (!lm || typeof lm.availability !== 'function') {
      availability = 'unavailable';
      checkedAt = now();
      notify();
      return 'unavailable';
    }
    const ttl = availability === 'downloading' ? NANO_DOWNLOADING_POLL_MS : NANO_AVAILABILITY_TTL_MS;
    if (!force && availability !== null && now() - checkedAt < ttl) return availability;
    if (pending) return /** @type {any} */ (pending);
    pending = (async () => {
      try {
        // A hung availability() must not hold up isReady() (and with it every escalation).
        const next = normalizeAvailability(await withDeadline(
          () => Promise.resolve(lm.availability(nanoOptions())),
          { timeoutMs: availabilityTimeoutMs, what: 'availability check' }
        ));
        if (next !== 'downloading') progress = null;
        if (next === 'available') lastError = null;
        availability = next;
      } catch (err) {
        availability = 'unavailable';
        lastError = errorText(err);
      }
      checkedAt = now();
      return availability;
    })();
    try {
      return /** @type {any} */ (await pending);
    } finally {
      pending = null;
      schedulePoll();
      notify();
    }
  }

  /** temperature / topK, clamped to LanguageModel.params() maxima when the API offers them. */
  async function samplingOptions(lm) {
    if (sampling !== undefined) return sampling;
    let temperature = NANO_TEMPERATURE;
    let topK = NANO_TOP_K;
    if (typeof lm.params === 'function') {
      try {
        const p = await lm.params();
        if (p && Number.isFinite(p.maxTemperature)) temperature = Math.min(temperature, p.maxTemperature);
        if (p && Number.isFinite(p.maxTopK)) topK = Math.max(1, Math.min(topK, Math.floor(p.maxTopK)));
      } catch {
        /* params() is optional */
      }
    }
    sampling = { temperature, topK };
    return sampling;
  }

  /**
   * A new session with `system` as its system prompt; temperature and topK together, or neither.
   * @param {any} lm
   * @param {string} system
   */
  async function createSession(lm, system) {
    const options = { ...nanoOptions(), initialPrompts: [{ role: 'system', content: system }] };
    if (samplingRejected) return lm.create(options);
    const s = await samplingOptions(lm);
    try {
      return await lm.create({ ...options, temperature: s.temperature, topK: s.topK });
    } catch (err) {
      if (isAbortError(err) || isQuotaError(err)) throw err;
      samplingRejected = true;
      return lm.create(options);
    }
  }

  /** @param {Promise<any>} entry */
  function destroyLater(entry) {
    entry.then((s) => {
      try {
        s?.destroy?.();
      } catch {
        /* ignore */
      }
    }, () => {});
  }

  /** Base session for `system` (LRU of NANO_MAX_SESSIONS). */
  function baseSession(lm, system) {
    const hit = sessions.get(system);
    if (hit) {
      sessions.delete(system);
      sessions.set(system, hit);
      return hit;
    }
    const entry = createSession(lm, system).catch((err) => {
      if (sessions.get(system) === entry) sessions.delete(system);
      throw err;
    });
    sessions.set(system, entry);
    while (sessions.size > NANO_MAX_SESSIONS) {
      const [oldest, old] = sessions.entries().next().value;
      sessions.delete(oldest);
      destroyLater(old);
    }
    return entry;
  }

  /** @param {string} system */
  function evict(system) {
    const entry = sessions.get(system);
    if (!entry) return;
    sessions.delete(system);
    destroyLater(entry);
  }

  /**
   * One prompt on a clone of the base session for `system`.
   * @param {string} system
   * @param {string} user
   * @param {{ schema?: object|null, signal?: AbortSignal }} [opts]
   * @returns {Promise<string>}
   */
  async function promptOnce(system, user, { schema = null, signal } = {}) {
    const lm = api();
    const entry = baseSession(lm, system);
    let base;
    try {
      base = await untilAborted(entry, signal);
    } catch (err) {
      // A create() that never finished would hold up every later prompt with this system prompt.
      if (signal?.aborted && sessions.get(system) === entry) evict(system);
      throw err;
    }
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    let session;
    try {
      session = typeof base?.clone === 'function' ? await base.clone(signal ? { signal } : undefined) : await createSession(lm, system);
    } catch (err) {
      if (isDeadSessionError(err)) evict(system);
      throw err;
    }
    try {
      /** @type {Record<string, any>} */
      const options = {};
      if (schema) options.responseConstraint = schema;
      if (signal) options.signal = signal;
      const out = await session.prompt(user, options);
      return typeof out === 'string' ? out : String(out ?? '');
    } catch (err) {
      if (isDeadSessionError(err) && !isQuotaError(err)) evict(system);
      throw err;
    } finally {
      try {
        session?.destroy?.();
      } catch {
        /* ignore */
      }
    }
  }

  /** Throws a coded error unless the model can be prompted now. */
  async function ensureReady() {
    await loadSettings();
    if (settings.enabled === false) throw providerError('disabled', `${displayName} is switched off in Settings.`);
    const lm = api();
    if (!lm || typeof lm.create !== 'function') throw providerError('unavailable', 'The built-in LanguageModel is not available.');
    const a = await checkAvailability();
    if (a !== 'available') throw providerError(a, String(status().detail || `${displayName} is ${a}.`));
  }

  /**
   * decide() body: one prompt, retried once with the post text halved on a quota error.
   * @param {{ text?: string, platform?: string, author?: string }} state
   * @param {Record<string, import('../types.js').Question>} questions
   * @param {AbortSignal} [signal]
   */
  async function answer(state, questions, signal) {
    const plan = buildQuestionPlan(questions);
    if (!plan.entries.length) throw providerError('bad_request', `No question ${displayName} can answer.`);
    const render = (text) => renderUserPrompt({ state: { ...state, text }, plan });
    const text = String(state?.text || '');
    let raw;
    try {
      raw = await promptOnce(DECISION_SYSTEM_PROMPT, render(text), { schema: plan.schema, signal });
    } catch (err) {
      if (!isQuotaError(err)) throw err;
      try {
        raw = await promptOnce(DECISION_SYSTEM_PROMPT, render(halve(text)), { schema: plan.schema, signal });
      } catch (err2) {
        if (isQuotaError(err2)) throw providerError('nano_quota', `The post is too long for ${displayName}, even halved.`);
        throw err2;
      }
    }
    const answers = mapLlmAnswers(parseModelJson(raw), plan, NANO_ID);
    if (!Object.keys(answers).length) throw providerError('bad_response', `${displayName} returned no usable answers.`);
    return answers;
  }

  /** @type {import('../types.js').DecisionProvider['decide']} */
  async function decide({ state, questions, signal } = /** @type {any} */ ({})) {
    /** @type {number|null} set once the model is ready and the prompt starts */
    let started = null;
    try {
      const answers = await withDeadline(async (sig) => {
        await ensureReady();
        started = now();
        return answer(state || {}, questions, sig);
      }, { signal, timeoutMs: decideTimeoutMs, what: 'decision' });
      const latencyMs = Math.max(0, now() - /** @type {number} */ (started));
      stats.success(latencyMs);
      lastError = null;
      return { answers, provider: NANO_ID, model: displayName, latencyMs };
    } catch (err) {
      const e = toNanoError(err);
      // Not ready (switched off, unavailable, ...): reported as before, not counted as a failed call.
      if (started === null && e.code !== 'timeout') throw e;
      stats.failure(e.code, e.message);
      lastError = e.message;
      if (e.code === 'timeout') noteTimeout(e.message);
      throw e;
    }
  }

  /**
   * Free text from the built-in model (config helpers). Retried once with the user prompt halved on
   * a quota error.
   * @param {string} system
   * @param {string} user
   * @param {{ schema?: object|null, signal?: AbortSignal }} [opts]
   * @returns {Promise<string>}
   */
  async function generateText(system, user, { schema = null, signal } = {}) {
    let ready = false;
    try {
      return await withDeadline(async (sig) => {
        await ensureReady();
        ready = true;
        try {
          return await promptOnce(String(system || ''), String(user || ''), { schema, signal: sig });
        } catch (err) {
          if (!isQuotaError(err)) throw err;
          return await promptOnce(String(system || ''), halve(String(user || '')), { schema, signal: sig });
        }
      }, { signal, timeoutMs: textTimeoutMs, what: 'text generation' });
    } catch (err) {
      const e = toNanoError(err);
      if (!ready && e.code !== 'timeout') throw e;
      lastError = e.message;
      if (e.code === 'timeout') noteTimeout(e.message);
      throw e;
    }
  }

  /**
   * JSON from the built-in model (responseConstraint = `schema` when given); null when the reply
   * is not a JSON object.
   * @param {string} system
   * @param {string} user
   * @param {{ schema?: object|null, signal?: AbortSignal }} [opts]
   * @returns {Promise<any>}
   */
  async function generateJson(system, user, { schema = null, signal } = {}) {
    const parsed = parseModelJson(await generateText(system, user, { schema, signal }));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  }

  /**
   * TEST_PROVIDER: availability plus one fixed synthetic prompt. Allowed while switched off.
   * @returns {Promise<{ ok: boolean, latencyMs: number, model: string, error?: string, code?: string }>}
   */
  async function testConnection({ signal } = {}) {
    const started = now();
    const lm = api();
    if (!lm || typeof lm.create !== 'function') {
      return { ok: false, latencyMs: 0, model: displayName, error: 'The built-in LanguageModel is not available in this browser.', code: 'unavailable' };
    }
    const a = await checkAvailability({ force: true });
    if (a !== 'available') return { ok: false, latencyMs: 0, model: displayName, error: String(status().detail || a), code: a };
    try {
      const answers = await withDeadline(
        (sig) => answer({ ...NANO_TEST_STATE }, /** @type {any} */ (NANO_TEST_QUESTIONS), sig),
        { signal, timeoutMs: decideTimeoutMs, what: 'test prompt' }
      );
      if (!answers.connection_test) throw providerError('bad_response', `${displayName} answered in an unexpected format.`);
      coolUntil = -Infinity; // it answers again: no need to keep skipping it
      return { ok: true, latencyMs: Math.max(0, now() - started), model: displayName };
    } catch (err) {
      const e = toNanoError(err);
      return { ok: false, latencyMs: Math.max(0, now() - started), model: displayName, error: e.message, code: e.code };
    }
  }

  /**
   * Download progress relayed from the side panel (NANO_DOWNLOAD_STATE), which starts the download
   * from a user click.
   * @param {{ phase?: 'start'|'progress'|'done'|'error', loaded?: number, error?: unknown }} [payload]
   */
  function noteDownload({ phase, loaded, error } = {}) {
    if (phase === 'start' || phase === 'progress') {
      availability = 'downloading';
      checkedAt = now();
      const p = Number(loaded);
      progress = Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : phase === 'start' ? 0 : progress;
      schedulePoll();
      notify();
    } else if (phase === 'done') {
      progress = null;
      lastError = null;
      checkAvailability({ force: true }).catch(() => {});
    } else if (phase === 'error') {
      progress = null;
      lastError = errorText(error ?? 'The download failed.');
      checkAvailability({ force: true }).catch(() => {});
    }
    return status();
  }

  /** Destroys every cached session (e.g. after a model update). */
  function resetSessions() {
    for (const system of [...sessions.keys()]) evict(system);
  }

  return {
    id: NANO_ID,
    displayName,
    isCloud: false,
    maxConcurrency: NANO_MAX_CONCURRENCY,
    /** Longest a decide() takes before it rejects with 'timeout' (the cascade's backstop uses it). */
    timeoutMs: decideTimeoutMs,
    async isReady() {
      await loadSettings();
      if (settings.enabled === false) return false;
      if ((await checkAvailability()) !== 'available') return false;
      return !coolingDown();
    },
    status,
    /** Re-reads settings and availability (forced); returns status(). */
    async refresh() {
      await loadSettings();
      await checkAvailability({ force: true });
      return status();
    },
    checkAvailability,
    decide,
    generateText,
    generateJson,
    testConnection,
    noteDownload,
    resetSessions,
    stats: () => ({ model: displayName, ...stats.snapshot() }),
    resetStats: () => stats.reset(),
    dispose() {
      if (pollTimer) clearTimer(pollTimer);
      pollTimer = null;
      resetSessions();
    }
  };
}
