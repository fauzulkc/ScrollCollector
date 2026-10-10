/**
 * Engine status holder: keeps the EngineStatus pushed to the side panel as ENGINE_STATUS
 * (lib/decision/types.js), maintains decision counters and computes the badge.
 *
 * Badge:
 *  - checking : System 1 status not known yet (grey)
 *  - loading  : the System 1 model is loading (amber, with progress)
 *  - ok       : System 1 ready and the escalation provider (if any) healthy; or System 1 unloaded
 *               while idle ('Idle': it loads again on the next post)
 *  - warn     : degraded — escalation auth_error / rate_limited / offline, or System 1
 *               unavailable while rules (or an escalator) keep deciding
 *  - error    : System 1 failed and no escalator can take over
 *
 * Pushes are throttled: the first change schedules one push `debounceMs` later carrying the
 * latest snapshot.
 */

const SAMPLE_SIZE = 200;
const MAX_ERROR_CHARS = 200;

/** Escalation states that degrade the badge to warn. */
const ESCALATION_DEGRADED = new Set(['auth_error', 'rate_limited', 'offline']);
/** Escalation states in which the escalator cannot take over from System 1. */
const ESCALATION_UNUSABLE = new Set([
  'auth_error', 'rate_limited', 'offline', 'error', 'unavailable', 'no_key', 'cloud_not_allowed', 'disabled',
  'downloadable', 'downloading', 'loading'
]);
/** Error codes that change the escalation provider state (others are only recorded). */
const CODE_TO_STATE = Object.freeze({
  auth_error: 'auth_error',
  rate_limited: 'rate_limited',
  overloaded: 'rate_limited',
  offline: 'offline',
  no_key: 'no_key'
});

export const PROVIDER_LABELS = Object.freeze({
  system1: 'System 1',
  nano: 'Gemini Nano',
  jev: 'TypeSafe Jev',
  openai: 'OpenAI',
  rules: 'Rules'
});

/**
 * True when System 1 is simply not loaded (unloaded while idle, or not needed yet): it loads on
 * demand, so nothing is degraded.
 * @param {any} s1   EngineStatus.system1
 */
export function isSystem1Idle(s1) {
  return !!s1 && s1.state === 'unavailable' && s1.detail === 'not_loaded';
}

/** @param {number} n @param {number} [digits] */
function round(n, digits = 1) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** @param {unknown} err */
function errorMessage(err) {
  const raw = err && typeof err === 'object' && 'message' in err ? /** @type {any} */ (err).message : err;
  return String(raw ?? 'error').slice(0, MAX_ERROR_CHARS);
}

/** @param {unknown} err */
function errorCode(err) {
  const e = /** @type {any} */ (err);
  if (e && typeof e.code === 'string' && e.code) return e.code;
  if (e && e.name === 'AbortError') return 'timeout';
  return 'error';
}

/** @returns {import('./types.js').EngineStatus & Record<string, any>} */
function initialStatus() {
  return {
    badge: { level: 'checking', label: 'Checking…', title: 'Checking the local decision model…' },
    system1: { state: 'loading', detail: 'checking' },
    nano: { state: 'unavailable', present: 'none' },
    escalation: { provider: 'none', status: { state: 'disabled' } },
    counters: { decided: 0, bySource: {}, escalated: 0, escalationRate: 0, avgMs: 0, p95Ms: 0, cacheHits: 0 },
    providers: {},
    warnings: []
  };
}

/**
 * @param {{ push?: ((status: object) => unknown)|null, debounceMs?: number, now?: () => number, sampleSize?: number }} [opts]
 */
export function createEngineStatus({ push = null, debounceMs = 250, now = Date.now, sampleSize = SAMPLE_SIZE } = {}) {
  const state = initialStatus();
  let system1Known = false;
  /** @type {number[]} latency ring buffer */
  const samples = [];
  let sampleCursor = 0;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null;

  function snapshot() {
    return JSON.parse(JSON.stringify({ ...state, updatedAt: now() }));
  }

  function emit() {
    if (!push) return;
    try {
      const r = push(snapshot());
      if (r && typeof (/** @type {any} */ (r).catch) === 'function') /** @type {any} */ (r).catch(() => {});
    } catch {
      /* a failing push (e.g. no receiver) must not break decisions */
    }
  }

  function schedule() {
    if (!push || timer) return;
    timer = setTimeout(() => {
      timer = null;
      emit();
    }, debounceMs);
  }

  function providerStats(id) {
    if (!state.providers[id]) state.providers[id] = { calls: 0, errors: 0, lastError: null, lastCode: null, lastErrorAt: null };
    return state.providers[id];
  }

  function computeBadge() {
    const s1 = state.system1 || {};
    const esc = state.escalation || {};
    const escState = esc.status?.state;
    const escConfigured = !!esc.provider && esc.provider !== 'none';
    const escName = PROVIDER_LABELS[esc.provider] || esc.provider;
    const escUsable = escConfigured && !ESCALATION_UNUSABLE.has(escState);
    const escDegraded = escConfigured && ESCALATION_DEGRADED.has(escState);
    const model = s1.model ? ` (${s1.model}${s1.device ? `, ${s1.device}` : ''})` : '';

    if (!system1Known) {
      return { level: 'checking', label: 'Checking…', title: 'Checking the local decision model…' };
    }
    if (s1.state === 'loading' || s1.state === 'downloading') {
      const pct = Number.isFinite(s1.progress) ? ` ${Math.round(s1.progress * 100)}%` : '';
      return { level: 'loading', label: `Loading${pct}`, title: `Loading the local decision model${model}…` };
    }
    // Idle: unloaded to free memory, it loads again for the next post; nothing is degraded.
    const idle = isSystem1Idle(s1);
    if (s1.state === 'ready' || idle) {
      if (escDegraded) {
        const what = escState === 'auth_error' ? 'key rejected' : escState === 'rate_limited' ? 'rate limited' : 'offline';
        return {
          level: 'warn',
          label: `${escName}: ${what}`,
          title: `System 1 is deciding${model}; ${escName} is ${what}${esc.status?.lastError ? ` (${esc.status.lastError})` : ''}.`
        };
      }
      if (idle) {
        return {
          level: 'ok',
          label: 'Idle',
          title: `The local decision model${model} was unloaded while idle to free memory; it loads again for the next post.`
        };
      }
      return {
        level: 'ok',
        label: 'Ready',
        title: `System 1 ready${model}${escConfigured ? `; uncertain posts go to ${escName}` : ''}.`
      };
    }
    if (s1.state === 'error' && !escUsable) {
      return {
        level: 'error',
        label: 'Model error',
        title: `The local decision model failed${s1.lastError ? `: ${s1.lastError}` : ''}. Posts are decided by rules only.`
      };
    }
    const fallback = escUsable ? escName : 'rules only';
    return {
      level: 'warn',
      label: escUsable ? `Using ${escName}` : 'Rules only',
      title: `System 1 is ${s1.state === 'disabled' ? 'turned off' : 'unavailable'}${s1.lastError ? ` (${s1.lastError})` : ''}; deciding with ${fallback}.`
    };
  }

  function refresh() {
    state.badge = computeBadge();
    schedule();
  }

  /**
   * Shallow-merges `partial` per top-level key (system1, nano, escalation are merged one level
   * deep; counters cannot be overwritten).
   * @param {Record<string, any>} partial
   */
  function update(partial = {}) {
    for (const [key, value] of Object.entries(partial || {})) {
      if (value === undefined || key === 'counters' || key === 'badge') continue;
      if (key === 'system1' || key === 'nano' || key === 'escalation') {
        state[key] = { ...(state[key] || {}), ...(value || {}) };
        if (key === 'system1' && value && typeof value.state === 'string') system1Known = true;
      } else if (key === 'warnings') {
        state.warnings = Array.isArray(value) ? value.filter((w) => typeof w === 'string') : [];
      } else {
        state[key] = value;
      }
    }
    refresh();
    return snapshot();
  }

  /**
   * Records a provider failure. Escalator auth/rate/offline errors degrade the escalation state;
   * System 1 failures are only recorded (its state comes from S1_STATUS pushes).
   * @param {string} providerId
   * @param {unknown} err
   */
  function error(providerId, err) {
    const id = String(providerId || 'unknown');
    const code = errorCode(err);
    const message = errorMessage(err);
    const stats = providerStats(id);
    stats.errors += 1;
    stats.lastError = message;
    stats.lastCode = code;
    stats.lastErrorAt = now();
    if (id === 'system1') {
      state.system1 = { ...state.system1, lastError: message };
    } else {
      if (id === 'nano') state.nano = { ...state.nano, lastError: message };
      if (state.escalation?.provider === id) {
        const next = CODE_TO_STATE[code];
        state.escalation = {
          ...state.escalation,
          status: { ...(state.escalation.status || {}), ...(next ? { state: next } : {}), lastError: message, detail: code }
        };
      }
    }
    refresh();
  }

  /** @param {number} ms */
  function addSample(ms) {
    if (samples.length < sampleSize) samples.push(ms);
    else samples[sampleCursor] = ms;
    sampleCursor = (sampleCursor + 1) % sampleSize;
    const sorted = [...samples].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    state.counters.avgMs = round(sum / sorted.length);
    state.counters.p95Ms = round(sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)]);
  }

  /**
   * Counts one final decision.
   * @param {import('./types.js').ItemDecision} decision
   */
  function count(decision) {
    if (!decision || typeof decision !== 'object') return;
    const c = state.counters;
    c.decided += 1;
    const source = decision.provider || 'unknown';
    c.bySource[source] = (c.bySource[source] || 0) + 1;
    if (decision.escalated) c.escalated += 1;
    c.escalationRate = round(c.escalated / c.decided, 4);
    const path = Array.isArray(decision.path) ? decision.path : [];
    if (path.includes('cache')) c.cacheHits += 1;
    for (const p of new Set(path)) if (p !== 'cache') providerStats(p).calls += 1;
    if (Number.isFinite(decision.latencyMs) && decision.latencyMs >= 0) addSample(decision.latencyMs);

    // A successful escalation proves the provider works again.
    const esc = state.escalation;
    if (decision.escalated && esc?.provider === decision.provider && ESCALATION_DEGRADED.has(esc.status?.state)) {
      state.escalation = { ...esc, status: { ...esc.status, state: 'ready' } };
    }
    refresh();
  }

  /** Clears counters and latency samples (RESET_DIAGNOSTICS). */
  function resetCounters() {
    state.counters = initialStatus().counters;
    state.providers = {};
    samples.length = 0;
    sampleCursor = 0;
    refresh();
  }

  /** Pushes immediately (cancelling a pending throttled push). */
  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    emit();
  }

  function dispose() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return { update, error, count, snapshot, resetCounters, flush, dispose };
}
