/**
 * Shared HTTP client for the opt-in cloud decision providers (TypeSafe Jev, OpenAI), plus the small
 * pieces of provider plumbing every escalator shares: call statistics, a circuit breaker and the
 * cloud-provider core (key, settings, status) used by lib/decision/providers/{jev,openai}.js.
 *
 * fetchJson():
 *  - one AbortController timeout per attempt (the response body is read inside the window);
 *  - retries 429 / 503 / 529 up to `retries` times, honoring `retry-after-ms` / `retry-after`
 *    (seconds or an HTTP date); without either it backs off min(8000, 500 * 2^n) ms plus jitter.
 *    A server asking for a longer wait than `maxRetryWaitMs` is not retried (the caller's circuit
 *    breaker cools down instead);
 *  - typed errors (DecisionHttpError.code): auth_error (401/403), bad_request (400/422 and other
 *    4xx; keeps a redacted, truncated body), rate_limited (429), overloaded (503/529), server_error
 *    (other 5xx), timeout, offline (fetch failure), bad_response (2xx without valid JSON), aborted
 *    (the caller's signal);
 *  - every message and body passes through redact() (lib/storage/secrets.js) with the request's
 *    secrets, so an API key never appears in an error, a status or a log line, even when the server
 *    echoes it back. Errors never carry the request (headers) or the raw fetch error.
 */
import { redact } from '../storage/secrets.js';
import { resolveIntelligence } from '../storage/schema.js';
import { textHash } from './state.js';

/** Statuses retried before giving up. */
export const RETRY_STATUSES = Object.freeze([429, 503, 529]);
const RETRY_SET = new Set(RETRY_STATUSES);
const MAX_MESSAGE_CHARS = 300;
const MAX_BODY_CHARS = 300;
const MAX_DETAIL_CHARS = 200;
const MAX_BACKOFF_MS = 8000;
const BASE_BACKOFF_MS = 500;
const JITTER_MS = 250;
/** Longest cooldown a server's retry-after can impose on the circuit breaker. */
const MAX_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * @typedef {'auth_error'|'bad_request'|'rate_limited'|'overloaded'|'timeout'|'offline'|'server_error'|'bad_response'|'aborted'} HttpErrorCode
 */

export class DecisionHttpError extends Error {
  /**
   * @param {string} message   must already be redacted
   * @param {{ code: string, status?: number|null, retryAfterMs?: number|null, body?: string|null, attempts?: number }} info
   */
  constructor(message, { code, status = null, retryAfterMs = null, body = null, attempts = 1 }) {
    super(message);
    this.name = 'DecisionHttpError';
    /** @type {string} */
    this.code = code;
    /** @type {number|null} */
    this.status = status;
    /** @type {number|null} */
    this.retryAfterMs = retryAfterMs;
    /** @type {string|null} redacted and truncated response body (bad_request / bad_response only) */
    this.body = body;
    /** @type {number} */
    this.attempts = attempts;
  }
}

/**
 * @param {{ get?: (name: string) => string|null }|null|undefined} headers
 * @param {string} name
 * @returns {string|null}
 */
function header(headers, name) {
  try {
    const v = headers && typeof headers.get === 'function' ? headers.get(name) : null;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Milliseconds the server asked us to wait: `retry-after-ms`, else `retry-after` in seconds or as
 * an HTTP date. null when absent or unparseable.
 *
 * @param {{ get?: (name: string) => string|null }|null|undefined} headers
 * @param {number} [nowMs]
 * @returns {number|null}
 */
export function parseRetryAfter(headers, nowMs = Date.now()) {
  const ms = header(headers, 'retry-after-ms');
  if (ms !== null && ms.trim() !== '') {
    const n = Number(ms.trim());
    if (Number.isFinite(n) && n >= 0) return Math.round(n);
  }
  const ra = header(headers, 'retry-after');
  if (ra === null || ra.trim() === '') return null;
  const s = ra.trim();
  if (/^\d+(?:\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const at = Date.parse(s);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

/**
 * Exponential backoff without a retry-after: min(8000, 500 * 2^attempt) + up to 250 ms of jitter.
 * @param {number} attempt   0 for the first retry
 * @param {() => number} [random]
 */
export function backoffMs(attempt, random = Math.random) {
  const jitter = Math.floor(Math.max(0, Math.min(1, Number(random()) || 0)) * JITTER_MS);
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempt)) + jitter;
}

/**
 * @param {number} status
 * @returns {HttpErrorCode}
 */
export function codeForStatus(status) {
  if (status === 401 || status === 403) return 'auth_error';
  if (status === 429) return 'rate_limited';
  if (status === 503 || status === 529) return 'overloaded';
  if (status >= 500) return 'server_error';
  return 'bad_request';
}

/**
 * Human message for a failed HTTP status.
 * @param {HttpErrorCode} code
 * @param {number} status
 * @param {string} detail
 */
function statusMessage(code, status, detail) {
  const tail = detail ? `: ${detail}` : '.';
  switch (code) {
    case 'auth_error':
      return `The API key was rejected (HTTP ${status})${tail}`;
    case 'rate_limited':
      return `Rate limited by the provider (HTTP ${status})${tail}`;
    case 'overloaded':
      return `The provider is overloaded (HTTP ${status})${tail}`;
    case 'server_error':
      return `The provider failed (HTTP ${status})${tail}`;
    default:
      return `The provider rejected the request (HTTP ${status})${tail}`;
  }
}

/**
 * The provider's own error message from a JSON error body ({error:{message}}, {error}, {message},
 * {detail}), else the start of the raw body.
 * @param {string} text
 */
function errorDetail(text) {
  if (!text) return '';
  let detail = '';
  try {
    const j = JSON.parse(text);
    const e = j && typeof j === 'object' ? j.error : null;
    if (e && typeof e === 'object' && typeof e.message === 'string') detail = e.message;
    else if (typeof e === 'string') detail = e;
    else if (j && typeof j.message === 'string') detail = j.message;
    else if (j && typeof j.detail === 'string') detail = j.detail;
    else if (j && Array.isArray(j.detail)) detail = JSON.stringify(j.detail);
  } catch {
    detail = text;
  }
  return detail.replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL_CHARS);
}

/**
 * Promise that resolves after `ms`, or rejects with an AbortError when `signal` aborts.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/** @param {Record<string, string>} headers @param {string} name */
function hasHeader(headers, name) {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

/**
 * @typedef {object} FetchJsonOptions
 * @property {string} [method]                  default 'POST'
 * @property {Record<string, string>} [headers]
 * @property {unknown} [body]                    objects are JSON-encoded (content-type added)
 * @property {number} [timeoutMs]               per attempt, default 15000
 * @property {number} [retries]                 retries of 429/503/529, default 2
 * @property {typeof fetch} [fetchImpl]
 * @property {AbortSignal} [signal]             the caller's cancel signal
 * @property {string[]|string} [redactValues]  secrets to scrub from every message and body
 * @property {number} [maxRetryWaitMs]          longest wait honored before a retry, default 20000
 * @property {(ms: number, signal?: AbortSignal) => Promise<void>} [sleep]
 * @property {() => number} [random]
 * @property {() => number} [now]
 */

/**
 * @typedef {object} FetchJsonResult
 * @property {any} data
 * @property {number} status
 * @property {Headers|any} headers
 * @property {number} latencyMs                 of the successful attempt
 * @property {number} attempts
 */

/**
 * JSON request with timeout, retries and typed, redacted errors.
 *
 * @param {string} url
 * @param {FetchJsonOptions} [opts]
 * @returns {Promise<FetchJsonResult>}
 * @throws {DecisionHttpError}
 */
export async function fetchJson(url, opts = {}) {
  const {
    method = 'POST',
    headers = {},
    body,
    timeoutMs = 15000,
    retries = 2,
    fetchImpl = globalThis.fetch,
    signal,
    redactValues = [],
    maxRetryWaitMs = 20000,
    sleep = defaultSleep,
    random = Math.random,
    now = Date.now
  } = opts;
  const secrets = (Array.isArray(redactValues) ? redactValues : [redactValues]).filter((s) => typeof s === 'string' && s);
  const clean = (s) => redact(String(s ?? ''), secrets);
  /**
   * @param {string} message
   * @param {{ code: string, status?: number|null, retryAfterMs?: number|null, body?: string|null, attempts?: number }} info
   */
  const fail = (message, info) =>
    new DecisionHttpError(clean(message).slice(0, MAX_MESSAGE_CHARS), {
      ...info,
      body: typeof info.body === 'string' ? clean(info.body).slice(0, MAX_BODY_CHARS) : null
    });

  if (typeof fetchImpl !== 'function') throw fail('No fetch implementation is available.', { code: 'offline' });

  /** @type {Record<string, string>} */
  const reqHeaders = { accept: 'application/json', ...headers };
  let payload = body;
  if (body !== undefined && body !== null && typeof body !== 'string') {
    payload = JSON.stringify(body);
    if (!hasHeader(reqHeaders, 'content-type')) reqHeaders['content-type'] = 'application/json';
  }
  const maxRetries = Math.max(0, Math.floor(Number.isFinite(retries) ? retries : 0));
  const limit = Math.max(1, Number.isFinite(timeoutMs) ? timeoutMs : 15000);

  for (let attempt = 0; ; attempt++) {
    const attempts = attempt + 1;
    if (signal?.aborted) throw fail('The request was cancelled.', { code: 'aborted', attempts });
    const started = now();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, limit);
    const onAbort = () => controller.abort();
    signal?.addEventListener?.('abort', onAbort, { once: true });

    let res;
    let text = '';
    try {
      res = await fetchImpl(url, { method, headers: reqHeaders, body: payload, signal: controller.signal });
      text = typeof res?.text === 'function' ? await res.text() : '';
    } catch (err) {
      if (timedOut) throw fail(`No response within ${limit} ms.`, { code: 'timeout', attempts });
      if (signal?.aborted) throw fail('The request was cancelled.', { code: 'aborted', attempts });
      const e = /** @type {any} */ (err);
      if (e?.name === 'AbortError') throw fail('The request was cancelled.', { code: 'aborted', attempts });
      // Redact before truncating: a key cut in half would no longer match its known value.
      const why = typeof e?.message === 'string' && e.message ? ` (${clean(e.message).slice(0, 80)})` : '';
      throw fail(`Network error: the provider could not be reached${why}.`, { code: 'offline', attempts });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }

    const status = Number(res?.status) || 0;
    if (status >= 200 && status < 300) {
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw fail('The provider returned a response that is not valid JSON.', { code: 'bad_response', status, body: text, attempts });
      }
      return { data, status, headers: res.headers, latencyMs: Math.max(0, now() - started), attempts };
    }

    const code = codeForStatus(status);
    const retryAfterMs = parseRetryAfter(res.headers, now());
    if (RETRY_SET.has(status) && attempt < maxRetries) {
      const wait = retryAfterMs ?? backoffMs(attempt, random);
      if (wait <= maxRetryWaitMs) {
        try {
          await sleep(wait, signal);
        } catch {
          throw fail('The request was cancelled.', { code: 'aborted', attempts });
        }
        continue;
      }
    }
    // Redact the body before errorDetail() truncates it (a half key would escape redaction).
    throw fail(statusMessage(code, status, errorDetail(clean(text))), {
      code,
      status,
      retryAfterMs,
      body: code === 'bad_request' ? text : null,
      attempts
    });
  }
}

// ---------------------------------------------------------------------------
// Provider plumbing shared by the escalators
// ---------------------------------------------------------------------------

/** @param {number[]} sorted @param {number} q */
function quantile(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

/** @param {number} n */
function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * Per-provider call statistics for GET_DIAGNOSTICS: calls (successes + failures), errors, latency
 * of successful calls (last, average, p95 over the last `sampleSize`), last error and, when the
 * provider reports it, the estimated cost.
 *
 * @param {{ sampleSize?: number, now?: () => number }} [opts]
 */
export function createCallStats({ sampleSize = 200, now = Date.now } = {}) {
  let calls = 0;
  let errors = 0;
  /** @type {number|null} */
  let lastLatencyMs = null;
  /** @type {string|null} */
  let lastError = null;
  /** @type {string|null} */
  let lastCode = null;
  /** @type {number|null} */
  let lastErrorAt = null;
  let costUsd = 0;
  let hasCost = false;
  /** @type {number[]} */
  const samples = [];
  let cursor = 0;

  return {
    /** @param {number} ms @param {{ costUsd?: number }} [extra] */
    success(ms, extra = {}) {
      calls += 1;
      const v = Math.max(0, Math.round(Number(ms) || 0));
      lastLatencyMs = v;
      if (samples.length < sampleSize) samples.push(v);
      else samples[cursor] = v;
      cursor = (cursor + 1) % sampleSize;
      if (typeof extra.costUsd === 'number' && Number.isFinite(extra.costUsd)) {
        costUsd += extra.costUsd;
        hasCost = true;
      }
    },
    /** @param {string} code @param {string} message  already redacted */
    failure(code, message) {
      calls += 1;
      errors += 1;
      lastCode = code || 'error';
      lastError = String(message || code || 'error').slice(0, MAX_MESSAGE_CHARS);
      lastErrorAt = now();
    },
    snapshot() {
      const sorted = [...samples].sort((a, b) => a - b);
      const avg = sorted.length ? round1(sorted.reduce((a, b) => a + b, 0) / sorted.length) : null;
      return {
        calls,
        errors,
        lastLatencyMs,
        avgMs: avg,
        p95Ms: quantile(sorted, 0.95),
        lastError,
        lastCode,
        lastErrorAt,
        ...(hasCost ? { costUsd: Math.round(costUsd * 1e9) / 1e9 } : {})
      };
    },
    reset() {
      calls = 0;
      errors = 0;
      lastLatencyMs = null;
      lastError = null;
      lastCode = null;
      lastErrorAt = null;
      costUsd = 0;
      hasCost = false;
      samples.length = 0;
      cursor = 0;
    }
  };
}

/**
 * Circuit breaker for a keyed cloud provider:
 *  - auth_error : no more calls with the rejected key; a different key closes the circuit;
 *  - rate_limited / overloaded : no calls for max(cooldownMs, the server's retry-after) (capped at
 *    one hour).
 * Only a fingerprint of the key is kept.
 *
 * @param {{ now?: () => number, cooldownMs?: number }} [opts]
 */
export function createCircuitBreaker({ now = Date.now, cooldownMs = 60000 } = {}) {
  /** @type {string|null} fingerprint of the rejected key */
  let rejectedKey = null;
  let cooldownUntil = 0;
  /** @type {string|null} */
  let cooldownCode = null;

  return {
    /**
     * @param {string|null} keyFingerprint
     * @returns {{ state: 'auth_error' }|{ state: 'rate_limited', code: string, until: number }|null}
     */
    check(keyFingerprint) {
      if (rejectedKey !== null) {
        if (rejectedKey === keyFingerprint) return { state: 'auth_error' };
        if (keyFingerprint) rejectedKey = null; // the key changed: try again
      }
      if (now() < cooldownUntil) return { state: 'rate_limited', code: cooldownCode || 'rate_limited', until: cooldownUntil };
      return null;
    },
    /** @param {{ code?: string, retryAfterMs?: number|null }|null|undefined} err @param {string|null} keyFingerprint */
    record(err, keyFingerprint) {
      const code = err?.code;
      if (code === 'auth_error') {
        rejectedKey = keyFingerprint || 'unknown';
      } else if (code === 'rate_limited' || code === 'overloaded') {
        const asked = typeof err?.retryAfterMs === 'number' && Number.isFinite(err.retryAfterMs) ? err.retryAfterMs : 0;
        cooldownUntil = now() + Math.min(MAX_COOLDOWN_MS, Math.max(cooldownMs, asked));
        cooldownCode = code;
      }
    },
    reset() {
      rejectedKey = null;
      cooldownUntil = 0;
      cooldownCode = null;
    }
  };
}

/**
 * Stable fingerprint of a secret (never the secret itself).
 * @param {string|null|undefined} secret
 */
export function secretFingerprint(secret) {
  return typeof secret === 'string' && secret ? textHash(`sc-key:${secret}`) : null;
}

/**
 * configuration.intelligence.providers[id] with defaults. `config` may be the stored
 * `configuration` (preferred) or an `intelligence` object.
 *
 * @param {unknown} config
 * @param {'nano'|'jev'|'openai'} id
 * @returns {Record<string, any>}
 */
export function readProviderSettings(config, id) {
  const c = /** @type {any} */ (config);
  let intel;
  if (c && typeof c === 'object' && c.intelligence && typeof c.intelligence === 'object') intel = resolveIntelligence(c);
  else if (c && typeof c === 'object' && (c.providers || c.escalation || c.system1)) intel = resolveIntelligence({ intelligence: c });
  else intel = resolveIntelligence(null);
  return { ...(intel.providers?.[id] || {}) };
}

/**
 * An Error with a code, its message redacted.
 * @param {string} code
 * @param {string} message
 * @param {string[]} [secrets]
 * @returns {Error & { code: string }}
 */
export function providerError(code, message, secrets = []) {
  return Object.assign(new Error(redact(message, secrets).slice(0, MAX_MESSAGE_CHARS)), { code });
}

/**
 * Normalizes anything thrown into an Error with a string code and a redacted message.
 * @param {unknown} err
 * @param {string[]} [secrets]
 * @returns {Error & { code: string, status?: number|null, retryAfterMs?: number|null }}
 */
export function toProviderError(err, secrets = []) {
  const e = /** @type {any} */ (err);
  if (e instanceof DecisionHttpError) {
    // Already redacted with the request's key; scrub again in case the key changed meanwhile.
    e.message = redact(e.message, secrets);
    if (typeof e.body === 'string') e.body = redact(e.body, secrets);
    return e;
  }
  const code = typeof e?.code === 'string' && e.code ? e.code : e?.name === 'AbortError' ? 'aborted' : 'error';
  const message = typeof e?.message === 'string' && e.message ? e.message : String(e ?? 'error');
  const out = providerError(code, message, secrets);
  if (e && typeof e.status === 'number') /** @type {any} */ (out).status = e.status;
  if (e && typeof e.retryAfterMs === 'number') /** @type {any} */ (out).retryAfterMs = e.retryAfterMs;
  return out;
}

/**
 * Key, settings, circuit breaker, statistics and status shared by the keyed cloud providers.
 *
 * status() precedence: no_key -> disabled (providers[id].enabled !== true) -> auth_error (until
 * the key changes) -> rate_limited (cooldown) -> offline (the last call could not reach the
 * provider; calls are still allowed so the next one re-probes) -> ready. Before the first
 * refresh() the key is unknown and only the settings are judged.
 *
 * @param {{
 *   id: 'jev'|'openai',
 *   label: string,
 *   getSecret?: ((provider: string) => string|null|Promise<string|null>)|null,
 *   getConfig?: (() => unknown)|null,
 *   now?: () => number,
 *   cooldownMs?: number
 * }} opts
 */
export function createCloudCore({ id, label, getSecret = null, getConfig = null, now = Date.now, cooldownMs = 60000 }) {
  const stats = createCallStats({ now });
  const circuit = createCircuitBreaker({ now, cooldownMs });
  /** @type {boolean|null} null until the key was read once */
  let keySet = null;
  /** @type {string|null} */
  let keyFp = null;
  /** @type {string[]} last read key, kept only to redact messages */
  let redactList = [];
  let settings = readProviderSettings(null, id);
  /** @type {string|null} */
  let lastError = null;
  /** @type {string|null} */
  let lastCode = null;

  /** Reads settings and the key. @returns {Promise<{ key: string|null, settings: Record<string, any> }>} */
  async function load() {
    let cfg = null;
    try {
      cfg = typeof getConfig === 'function' ? await getConfig() : null;
    } catch {
      cfg = null;
    }
    settings = readProviderSettings(cfg, id);
    let key = null;
    try {
      key = typeof getSecret === 'function' ? await getSecret(id) : null;
    } catch {
      key = null;
    }
    key = typeof key === 'string' && key.trim() ? key.trim() : null;
    keySet = !!key;
    keyFp = secretFingerprint(key);
    redactList = key ? [key] : [];
    return { key, settings };
  }

  /** @returns {import('./types.js').ProviderStatus & Record<string, any>} */
  function status() {
    const model = typeof settings.model === 'string' ? settings.model : undefined;
    const base = { ...(model ? { model } : {}), ...(lastError ? { lastError } : {}) };
    if (keySet === false) return { ...base, state: 'no_key', detail: `No ${label} API key is set.` };
    if (settings.enabled !== true) {
      return { ...base, state: 'disabled', detail: `Sending uncertain posts to ${label} is switched off.` };
    }
    const blocked = circuit.check(keyFp);
    if (blocked?.state === 'auth_error') {
      return { ...base, state: 'auth_error', detail: `${label} rejected the API key; save a new key to try again.` };
    }
    if (blocked?.state === 'rate_limited') {
      const what = blocked.code === 'overloaded' ? 'overloaded' : 'rate limited';
      return { ...base, state: 'rate_limited', detail: `${label} is ${what}; paused until ${new Date(blocked.until).toISOString()}.`, retryAt: blocked.until };
    }
    if (lastCode === 'offline') return { ...base, state: 'offline', detail: `${label} could not be reached.` };
    return { ...base, state: 'ready' };
  }

  /**
   * Throws the reason a call cannot go out (no key, switched off, circuit open).
   * @param {string|null} key
   * @param {{ allowDisabled?: boolean, ignoreCircuit?: boolean }} [opts]
   */
  function guard(key, { allowDisabled = false, ignoreCircuit = false } = {}) {
    if (!key) throw providerError('no_key', `No ${label} API key is set.`);
    if (!allowDisabled && settings.enabled !== true) throw providerError('disabled', `Sending posts to ${label} is switched off.`);
    if (ignoreCircuit) return;
    const blocked = circuit.check(keyFp);
    if (blocked?.state === 'auth_error') throw providerError('auth_error', `${label} rejected the API key; save a new key to try again.`);
    if (blocked?.state === 'rate_limited') {
      throw Object.assign(providerError('rate_limited', `${label} is cooling down after a rate limit or overload.`), { retryAfterMs: Math.max(0, blocked.until - now()) });
    }
  }

  /** @param {number} latencyMs @param {{ costUsd?: number }} [extra] */
  function succeeded(latencyMs, extra) {
    stats.success(latencyMs, extra);
    lastError = null;
    lastCode = null;
  }

  /**
   * Records a failed call and returns the normalized, redacted error.
   * @param {unknown} err
   * @param {{ circuit?: boolean }} [opts]
   */
  function failed(err, { circuit: trip = true } = {}) {
    const e = toProviderError(err, redactList);
    if (trip) circuit.record(e, keyFp);
    stats.failure(e.code, e.message);
    lastError = e.message;
    lastCode = e.code;
    return e;
  }

  return {
    load,
    status,
    guard,
    succeeded,
    failed,
    /** Closes the circuit (a successful connection test). */
    resetCircuit() {
      circuit.reset();
      lastError = null;
      lastCode = null;
    },
    stats: () => stats.snapshot(),
    resetStats: () => stats.reset(),
    get settings() {
      return settings;
    },
    get secrets() {
      return redactList;
    }
  };
}

/**
 * Joins a provider base URL and an endpoint path ('https://x/v1' + '/chat/completions').
 * @param {string} baseUrl
 * @param {string} path
 */
export function joinUrl(baseUrl, path) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`;
}
