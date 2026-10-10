/**
 * decision-runtime.js
 *
 * The service worker's decision layer, composed once (background.js):
 *
 *   System 1 (lib/decision/providers/local-system1.js, offscreen document)
 *     -> ONE escalation provider: Gemini Nano (browser LanguageModel) | TypeSafe Jev | OpenAI
 *     -> rules (lib/decision/providers/rules.js), plus the social-noise prefilter
 *   wired through lib/decision/cascade.js with
 *     - budget  (lib/decision/budget.js): per-minute window in memory, per-day counter persisted
 *               under storage.local `escalationBudget` (a worker restart cannot reset the daily cap)
 *     - cache   (lib/decision/cache.js): answers mirrored to storage.session `decisionCache`
 *     - status  (lib/decision/engine-status.js): EngineStatus pushed as ENGINE_STATUS, counters,
 *               badge; provider faults also raise a TOAST (fixed, key-free texts, one per fault)
 *
 * Live settings: onStorageChanged() watches configuration.intelligence and secrets, so a change from
 * any writer (UPDATE_INTELLIGENCE_SETTINGS, SET_SECRET, a seeded profile) applies at once: budget
 * limits, System 1 model switch / off (reconfigure), escalation provider status, prompt warnings.
 * A System 1 model change re-decides the whole stack; a gate policy change (strictness, when-unsure,
 * confidence floors) schedules a 'prompt' re-decide; System 1 becoming ready upgrades items the
 * rules decided (redecider.onSystem1Ready()).
 *
 * Idle refinement (lib/pipeline/refine.js): a refiner re-decides stored posts with BOTH bundled
 * System 1 models (plus Gemini Nano for what stays uncertain; never a cloud provider) while the user
 * is idle. The service worker forwards chrome.idle state changes and the REFINE_ALARM to
 * onIdleState() / onRefineAlarm(); passes yield to ingest and re-decide jobs and are cancelled when
 * the decision fingerprint (prompt, tags, model, gate policy) changes. Its state is pushed as
 * EngineStatus.refine { enabled, state: 'off'|'waiting'|'running'|'done', refined, total, done,
 * pending, lastRunAt, lastOutcome } and GET_DIAGNOSTICS.refine adds the counters. A pass that changed
 * at least one verdict raises one TOAST.
 *
 * Secrets: keys are read only by the cloud providers (getSecret). Nothing this module returns or
 * pushes carries a key: provider error texts are redacted (lib/storage/secrets.js redact) with the
 * stored key values, and the only key information is describeSecrets() ({ set, last4 }).
 */

import { MSG } from '../messages.js';
import { createCascade } from '../decision/cascade.js';
import { createEngineStatus, PROVIDER_LABELS, isSystem1Idle } from '../decision/engine-status.js';
import { createBudget } from '../decision/budget.js';
import { createDecisionCache } from '../decision/cache.js';
import { createRulesProvider } from '../decision/providers/rules.js';
import { createLocalSystem1, SYSTEM1_DISPLAY_NAME } from '../decision/providers/local-system1.js';
import { createNanoProvider } from '../decision/providers/nano.js';
import { createJevProvider } from '../decision/providers/jev.js';
import { createOpenAIProvider } from '../decision/providers/openai.js';
import { getSecret, describeSecrets, listSecretValues, redact } from '../storage/secrets.js';
import { resolveIntelligence, ESCALATION_PROVIDERS, isPlainObject } from '../storage/schema.js';
import { promptWarnings, decisionFingerprint } from '../pipeline/apply-decision.js';
import { REJECTED_LOG_KEY } from '../pipeline/ingest.js';
import { createRefiner, createIdleTrigger, refineSpec, refineProgress } from '../pipeline/refine.js';

/** storage.local key of the persisted daily escalation counter ({ date, count }). */
export const BUDGET_KEY = 'escalationBudget';
/** storage.session key mirroring the decision cache. */
export const DECISION_CACHE_KEY = 'decisionCache';
/** TEST_PROVIDER targets. */
export const TEST_PROVIDERS = Object.freeze(['system1', 'nano', 'jev', 'openai']);
/** Rejected posts returned by GET_DIAGNOSTICS (newest first). */
export const DIAGNOSTICS_REJECTED = 50;

const ESCALATOR_IDS = Object.freeze(['nano', 'jev', 'openai']);
const RULES_NAME = 'Rule-based Classifier';
/** The same fault toast is not repeated within this window (unless the provider recovered meanwhile). */
const TOAST_REPEAT_MS = 5 * 60_000;
/** How long S1_ENSURE_LOADED waits for the load to start before replying with the status. */
const ENSURE_REPLY_WAIT_MS = 100;
/** GET_ENGINE_STATUS recounts refined posts at most this often. */
const REFINE_COUNT_MIN_MS = 5000;

/** Fixed toast texts per fault (never a provider message: those may echo request data). */
const FAULT_TOASTS = Object.freeze({
  auth_error: (label) => `${label} rejected the API key. Uncertain posts keep System 1’s answer until you save a new key.`,
  rate_limited: (label) => `${label} is rate limiting requests. Escalation pauses for a minute; System 1 keeps deciding.`,
  overloaded: (label) => `${label} is overloaded. Escalation pauses for a minute; System 1 keeps deciding.`,
  offline: (label) => `${label} could not be reached. Uncertain posts keep System 1’s answer.`,
  budget_exceeded: () => 'The escalation budget is used up. Uncertain posts keep System 1’s answer until it resets.'
});

/** @param {unknown} v */
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Legacy GET_ENGINE_STATUS fields { tier, name, status } derived from an EngineStatus, kept while
 * older panels read them: tier 1 = System 1 ready, 2 = the escalation provider decides, 3 = rules.
 *
 * @param {any} snapshot   EngineStatus
 * @returns {{ tier: 1|2|3, name: string, status: string }}
 */
export function legacyEngineFields(snapshot) {
  const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const level = s.badge && s.badge.level;
  // An idle (unloaded) System 1 loads on the next post: still the deciding tier.
  const s1Ready = !!s.system1 && (s.system1.state === 'ready' || isSystem1Idle(s.system1));
  const escId = s.escalation && s.escalation.provider;
  const escReady = !!escId && escId !== 'none' && s.escalation.status && s.escalation.status.state === 'ready';
  const tier = s1Ready ? 1 : escReady ? 2 : 3;
  const name = s1Ready ? SYSTEM1_DISPLAY_NAME : escReady ? (PROVIDER_LABELS[escId] || escId) : RULES_NAME;
  let status;
  if (level === 'ok') status = 'ready';
  else if (level === 'loading') status = 'loading';
  else if (level === 'checking') status = 'checking';
  else if (level === 'error') status = 'error';
  else status = tier === 3 ? 'unavailable' : 'ready';
  return { tier, name, status };
}

/**
 * Deep copy of `value` with every string passed through redact(·, known).
 *
 * @param {any} value
 * @param {string[]} known
 * @returns {any}
 */
export function redactDeep(value, known) {
  if (typeof value === 'string') return redact(value, known);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, known));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, known);
    return out;
  }
  return value;
}

/** @param {any} a @param {any} b */
function same(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * @param {{
 *   store: ReturnType<import('./store.js').createStore>,
 *   broadcast: { sendRuntime: (message: object) => unknown },
 *   area?: chrome.storage.StorageArea,
 *   session?: chrome.storage.StorageArea|null,
 *   offscreenClient?: { sendToOffscreen: (type: string, payload?: object, opts?: object) => Promise<any> }|null,
 *   now?: () => number,
 *   languageModel?: any,
 *   fetchImpl?: typeof fetch,
 *   engineStatusDebounceMs?: number,
 *   system1Options?: Record<string, any>,
 *   providers?: Partial<{ system1: any, nano: any, jev: any, openai: any, rules: any }>,
 *   redecider?: { start: Function, schedule: Function, onSystem1Ready: Function, current?: any }|null,
 *   idleApi?: any,
 *   alarmsApi?: any,
 *   isIngestBusy?: () => boolean,
 *   refineOptions?: Record<string, any>
 * }} deps
 *   providers: injected provider instances (tests); the real ones are built otherwise.
 *   redecider: may also be attached later with setRedecider() (it needs decideMany first).
 *   idleApi / alarmsApi: chrome.idle / chrome.alarms (fakes in tests).
 *   isIngestBusy: ingest batches in flight (default: broadcast.getInflightCount() > 0).
 */
export function createDecisionRuntime({
  store,
  broadcast,
  area = globalThis.chrome?.storage?.local,
  session = globalThis.chrome?.storage?.session ?? null,
  offscreenClient = null,
  now = Date.now,
  languageModel = undefined,
  fetchImpl = undefined,
  engineStatusDebounceMs = 250,
  system1Options = {},
  providers: injected = {},
  redecider = null,
  idleApi = globalThis.chrome?.idle ?? null,
  alarmsApi = globalThis.chrome?.alarms ?? null,
  isIngestBusy = null,
  refineOptions = {}
}) {
  /** @type {any} */
  let redecide = redecider;
  /** Last configuration this runtime acted on (diffed by onStorageChanged). */
  let lastConfiguration = null;
  /** The configured escalation provider ('none' | 'nano' | 'jev' | 'openai'). */
  let escalationId = 'none';
  /** System 1 state seen last (transition to 'ready' triggers the rules-only re-decide). */
  let system1State = null;
  /** key -> { code, at } of the last fault toast */
  const lastToast = new Map();

  const getConfig = async () => {
    const got = await store.get('configuration');
    return got && got.configuration;
  };
  const readSecret = (provider) => getSecret(area, provider);
  const knownSecrets = async () => {
    try {
      return await listSecretValues(area);
    } catch {
      return [];
    }
  };

  const engineStatus = createEngineStatus({
    push: (payload) => broadcast.sendRuntime({ type: MSG.ENGINE_STATUS, payload }),
    debounceMs: engineStatusDebounceMs,
    now
  });

  // ---------------------------------------------------------------------------------------------
  // Providers
  // ---------------------------------------------------------------------------------------------

  const nano = injected.nano || createNanoProvider({
    getConfig,
    now,
    ...(languageModel !== undefined ? { languageModel } : {}),
    onStatus: (s) => {
      engineStatus.update({ nano: s, ...(escalationId === 'nano' ? { escalation: { status: s } } : {}) });
    }
  });
  const jev = injected.jev || createJevProvider({ getConfig, getSecret: readSecret, fetchImpl, now });
  const openai = injected.openai || createOpenAIProvider({ getConfig, getSecret: readSecret, fetchImpl, now });
  /** @type {Record<string, any>} */
  const escalators = { nano, jev, openai };
  const rules = injected.rules || createRulesProvider();

  const system1 = injected.system1 || createLocalSystem1({
    client: offscreenClient || { sendToOffscreen: () => Promise.reject(Object.assign(new Error('No offscreen client'), { code: 'offscreen_unavailable' })) },
    getConfig,
    now,
    onStatus: onSystem1Status,
    ...system1Options
  });

  /** @param {Record<string, any>} s */
  function onSystem1Status(s) {
    engineStatus.update({ system1: s });
    const was = system1State;
    system1State = s && s.state;
    if (system1State === 'ready' && was !== 'ready') {
      // Outside the status callback: the redecider reads storage and calls decideMany.
      setTimeout(system1BecameReady, 0);
    }
  }

  /** Items decided without a model (rules, legacy) get a System 1 verdict. */
  function system1BecameReady() {
    if (!redecide || typeof redecide.onSystem1Ready !== 'function') return;
    try {
      // A running 'all' job already re-decides every item with System 1.
      const current = redecide.current;
      if (current && current.scope === 'all') return;
      redecide.onSystem1Ready();
    } catch (err) {
      console.warn('[background] Could not start the System 1 re-decide:', err);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Budget, cache, status sink
  // ---------------------------------------------------------------------------------------------

  const budget = createBudget({
    now,
    store: area
      ? {
        get: async () => (await area.get(BUDGET_KEY))?.[BUDGET_KEY],
        set: (day) => area.set({ [BUDGET_KEY]: day })
      }
      : null
  });

  const cache = createDecisionCache({
    store: session
      ? {
        get: async () => (await session.get(DECISION_CACHE_KEY))?.[DECISION_CACHE_KEY],
        set: (entries) => session.set({ [DECISION_CACHE_KEY]: entries })
      }
      : null
  });

  /** @param {string} id */
  function escalationStatusOf(id) {
    if (!id || id === 'none') return { state: 'disabled', detail: 'No escalation provider is selected.' };
    const p = escalators[id];
    if (!p || typeof p.status !== 'function') return { state: 'unavailable' };
    try {
      return p.status();
    } catch {
      return { state: 'error' };
    }
  }

  /**
   * One toast per fault; repeated only after TOAST_REPEAT_MS or once the provider recovered.
   * @param {string} key
   * @param {string} code
   */
  function faultToast(key, code) {
    const make = FAULT_TOASTS[/** @type {keyof typeof FAULT_TOASTS} */ (code)];
    if (!make) return;
    const t = now();
    const prev = lastToast.get(key);
    if (prev && prev.code === code && t - prev.at < TOAST_REPEAT_MS) return;
    lastToast.set(key, { code, at: t });
    const label = PROVIDER_LABELS[key] || key;
    try {
      Promise.resolve(broadcast.sendRuntime({ type: MSG.TOAST, payload: { level: code === 'budget_exceeded' ? 'info' : 'warn', text: make(label), key } })).catch(() => {});
    } catch {
      /* best effort */
    }
  }

  /** The cascade's status sink: engine status + fault toasts. */
  const statusSink = {
    /** @param {any} decision */
    count(decision) {
      engineStatus.count(decision);
      if (!decision) return;
      if (decision.escalated) lastToast.delete(decision.provider);
      if (decision.reason === 'budget_exceeded') faultToast('budget', 'budget_exceeded');
    },
    /** @param {string} id @param {any} err */
    error(id, err) {
      engineStatus.error(id, err);
      const code = err && typeof err.code === 'string' ? err.code : '';
      if (ESCALATOR_IDS.includes(id) && id === escalationId) faultToast(id, code);
    },
    /** @param {Record<string, any>} partial */
    update(partial) {
      const p = { ...(partial || {}) };
      if (p.escalation && typeof p.escalation === 'object') {
        const id = ESCALATION_PROVIDERS.includes(p.escalation.provider) ? p.escalation.provider : escalationId;
        escalationId = id;
        p.escalation = { ...p.escalation, provider: id, status: escalationStatusOf(id) };
      }
      engineStatus.update(p);
    }
  };

  const cascade = createCascade({ system1, escalators, rules, budget, cache, status: statusSink, now });

  // ---------------------------------------------------------------------------------------------
  // Idle refinement (second model + Gemini Nano; never a cloud provider)
  // ---------------------------------------------------------------------------------------------

  const redecideActive = () => !!(redecide && (redecide.current || redecide.isScheduled));
  const ingestBusy = typeof isIngestBusy === 'function'
    ? isIngestBusy
    : () => {
      try {
        return typeof (/** @type {any} */ (broadcast).getInflightCount) === 'function' && /** @type {any} */ (broadcast).getInflightCount() > 0;
      } catch {
        return false;
      }
    };

  /** EngineStatus.refine */
  let refineView = { enabled: true, state: 'waiting', refined: null, total: null, done: null, pending: null, lastRunAt: null, lastOutcome: null };
  let refineCountedAt = -Infinity;

  /** @param {Record<string, any>} partial */
  function pushRefine(partial) {
    refineView = { ...refineView, ...partial };
    engineStatus.update({ refine: refineView });
  }

  /** Recounts refined / eligible posts of the stored stack (no model call). */
  async function refreshRefineCounts() {
    refineCountedAt = now();
    try {
      const { configuration = {}, stack = [] } = (await store.snapshot(['configuration', 'stack'])) || {};
      const intel = resolveIntelligence(configuration);
      const r = refineSpec(configuration, system1);
      const { refined, total } = Object.keys(r.spec.questions).length ? refineProgress(stack, r.spec.specHash, r.models) : { refined: 0, total: 0 };
      const enabled = intel.refine.enabled !== false && intel.system1.enabled !== false;
      const state = !enabled ? 'off' : refiner.running ? 'running' : refined >= total ? 'done' : 'waiting';
      pushRefine({ enabled, state, refined, total, models: r.models });
    } catch (err) {
      console.warn('[background] Could not count refined posts:', err);
    }
    return refineView;
  }

  /** @param {any} p  refiner progress */
  function onRefineProgress(p) {
    if (!p || typeof p !== 'object') return;
    if (!p.finished) {
      pushRefine({ state: 'running', done: p.done, pending: p.total });
      return;
    }
    pushRefine({ state: 'waiting', done: null, pending: null, lastRunAt: now(), lastOutcome: p.skipped || p.outcome, lastRefined: p.refined, lastChanged: p.changedVerdicts });
    refreshRefineCounts().catch(() => {});
    if (p.changedVerdicts >= 1) {
      const n = p.refined;
      const changed = p.changedVerdicts;
      const text = `Refined ${n} post${n === 1 ? '' : 's'} with a second model: ${changed} verdict${changed === 1 ? '' : 's'} changed.`;
      try {
        Promise.resolve(broadcast.sendRuntime({ type: MSG.TOAST, payload: { level: 'info', text, key: 'refine' } })).catch(() => {});
      } catch {
        /* best effort */
      }
    }
  }

  const refiner = injected.refiner || createRefiner({
    store,
    system1,
    nano,
    broadcast: /** @type {any} */ (broadcast),
    now,
    isBusy: () => ingestBusy() || redecideActive(),
    isSuperseded: redecideActive,
    onProgress: onRefineProgress,
    ...refineOptions
  });

  const idleTrigger = createIdleTrigger({
    refiner,
    idle: idleApi,
    alarms: alarmsApi,
    getSettings: async () => resolveIntelligence(await getConfig()).refine,
    // Never while System 1 is switched off or failed (a loading or unloaded model is fine: the pass waits for it).
    canRun: () => {
      try {
        const st = system1.status().state;
        return st !== 'disabled' && st !== 'error';
      } catch {
        return false;
      }
    }
  });

  /** REFINE_NOW: starts a pass right away, idle or not (not awaited) -> { success, running, refine } */
  async function refineNow() {
    const pass = Promise.resolve(idleTrigger.runNow()).catch(() => null);
    // Give the pass a moment to start (or to finish when there is nothing to do).
    await Promise.race([pass, new Promise((r) => setTimeout(r, ENSURE_REPLY_WAIT_MS))]);
    return { success: true, running: refiner.running, refine: refineView };
  }

  // ---------------------------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------------------------

  /**
   * Pushes the escalation provider's status (after re-reading its settings / key).
   * @param {any} configuration
   */
  async function refreshEscalation(configuration) {
    const intel = resolveIntelligence(configuration);
    const id = ESCALATION_PROVIDERS.includes(intel.escalation.provider) ? intel.escalation.provider : 'none';
    escalationId = id;
    const p = escalators[id];
    if (p && typeof p.refresh === 'function') {
      try {
        await p.refresh();
      } catch {
        /* status() reports it */
      }
    }
    engineStatus.update({ escalation: { provider: id, status: escalationStatusOf(id), budget: budget.snapshot() } });
  }

  async function refreshNano() {
    try {
      const s = typeof nano.refresh === 'function' ? await nano.refresh() : nano.status();
      engineStatus.update({ nano: s, ...(escalationId === 'nano' ? { escalation: { status: s } } : {}) });
    } catch {
      /* best effort */
    }
  }

  /**
   * Applies a configuration change live (see the module header). Returns what changed.
   * @param {any} next
   * @param {any} prev
   * @returns {string[]}
   */
  function applyConfiguration(next, prev) {
    const changed = [];
    lastConfiguration = next || null;
    const warnings = promptWarnings(next);
    // Most configuration writes (tags, sites, ...) change nothing here: no push for them.
    if (!same(warnings, engineStatus.snapshot().warnings)) engineStatus.update({ warnings });
    const a = resolveIntelligence(isPlainObject(prev) ? prev : null);
    const b = resolveIntelligence(isPlainObject(next) ? next : null);
    budget.setLimits({ perMinute: b.escalation.perMinute, perDay: b.escalation.perDay });

    if (a.system1.model !== b.system1.model || a.system1.enabled !== b.system1.enabled) {
      Promise.resolve(system1.reconfigure ? system1.reconfigure() : null).catch(() => {});
      if (a.system1.model !== b.system1.model) changed.push('system1_model');
      if (a.system1.enabled !== b.system1.enabled) changed.push('system1_enabled');
    }
    if (a.escalation.provider !== b.escalation.provider || !same(a.providers, b.providers)) {
      changed.push('escalation');
      if (!same(a.providers.nano, b.providers.nano)) refreshNano();
      refreshEscalation(next).catch(() => {});
    }
    if (a.gate.strictness !== b.gate.strictness || a.gate.whenUnsure !== b.gate.whenUnsure || !same(a.escalation.floor, b.escalation.floor)) {
      changed.push('gate_policy');
    }
    // A refinement pass decided for the old prompt / tags / model / policy: drop it (the next idle
    // pass recomputes its candidates for the new spec).
    if (decisionFingerprint(isPlainObject(prev) ? prev : {}) !== decisionFingerprint(isPlainObject(next) ? next : {})) {
      refiner.cancel();
      changed.push('decision_spec');
    }
    if (!same(a.refine, b.refine)) {
      changed.push('refine');
      idleTrigger.applySettings(b.refine);
      if (b.refine.enabled === false) refiner.cancel();
    }
    if (changed.includes('decision_spec') || changed.includes('refine') || changed.includes('system1_enabled')) {
      refreshRefineCounts().catch(() => {});
    }

    if (redecide) {
      try {
        // Both change which posts pass the gate: open tabs rescan once the stack is re-decided, so
        // posts the old verdicts rejected are offered again.
        if (changed.includes('system1_model') && b.system1.enabled) {
          // Every verdict came from the old model: re-decide everything (waits for the new model).
          redecide.start({ scope: 'all', reason: 'model_changed', rescan: true });
        } else if (changed.includes('gate_policy')) {
          Promise.resolve(redecide.schedule({ scope: 'prompt', reason: 'gate_policy', rescan: true })).catch(() => {});
        }
      } catch (err) {
        console.warn('[background] Could not start a re-decide:', err);
      }
    }
    return changed;
  }

  /** Keys changed: re-read them, reset the auth circuit, push the escalation status. */
  async function onSecretsChanged() {
    lastToast.delete('jev');
    lastToast.delete('openai');
    await Promise.all([jev, openai].map(async (p) => {
      try {
        if (typeof p.refresh === 'function') await p.refresh();
      } catch {
        /* status() reports it */
      }
    }));
    engineStatus.update({ escalation: { provider: escalationId, status: escalationStatusOf(escalationId) } });
  }

  /**
   * chrome.storage.onChanged listener body.
   * @param {Record<string, chrome.storage.StorageChange>} changes
   * @param {string} areaName
   */
  function onStorageChanged(changes, areaName) {
    if (areaName !== 'local' || !changes) return;
    if (changes.configuration) {
      const next = changes.configuration.newValue;
      // Diff against what this runtime last applied (oldValue may predate start()).
      const prev = lastConfiguration ?? changes.configuration.oldValue;
      try {
        applyConfiguration(next, prev);
      } catch (err) {
        console.warn('[background] Could not apply the configuration change:', err);
      }
    }
    if (changes.secrets) onSecretsChanged().catch(() => {});
  }

  /**
   * Service-worker start: status of every provider and the prompt warnings.
   *
   * System 1 is NOT loaded here. The worker wakes for every page's content script and for the
   * one-minute idle-retry alarm, so loading at start would keep the offscreen document (ONNX
   * Runtime's WASM heap and worker threads) resident for the whole browser session even when no
   * feed is ever opened. It loads when it is needed: the first decision (the cascade waits for it),
   * the side panel asking for the engine status, S1_ENSURE_LOADED or TEST_PROVIDER. The host
   * unloads it again after a while without use (offscreen/system1-host.js) and this runtime then
   * closes the document (handleS1Status).
   */
  async function start() {
    let configuration = null;
    try {
      configuration = await getConfig();
    } catch {
      configuration = null;
    }
    lastConfiguration = configuration || null;
    engineStatus.update({ warnings: promptWarnings(configuration) });
    const intel = resolveIntelligence(configuration);
    budget.setLimits({ perMinute: intel.escalation.perMinute, perDay: intel.escalation.perDay });
    escalationId = ESCALATION_PROVIDERS.includes(intel.escalation.provider) ? intel.escalation.provider : 'none';
    await Promise.all([refreshNano(), refreshEscalation(configuration).catch(() => {}), idleTrigger.start().catch(() => {})]);
  }

  /** Starts loading System 1 unless it is loaded, loading, off or backing off after a failure. */
  function warmSystem1() {
    try {
      const p = typeof system1.isReady === 'function' ? system1.isReady() : null;
      Promise.resolve(p).catch(() => {});
    } catch {
      /* status shows it */
    }
  }

  /**
   * The host unloaded an idle model: close the offscreen document too (only the document's end
   * frees the WASM heap). Not while a load is starting: that load needs the document.
   */
  function closeIdleOffscreenDocument() {
    if (!offscreenClient || typeof (/** @type {any} */ (offscreenClient).closeOffscreenDocument) !== 'function') return;
    let state = null;
    try {
      state = system1.status().state;
    } catch {
      state = null;
    }
    if (state === 'loading' || state === 'ready') return;
    Promise.resolve(/** @type {any} */ (offscreenClient).closeOffscreenDocument()).catch(() => {});
  }

  // ---------------------------------------------------------------------------------------------
  // Message handler bodies
  // ---------------------------------------------------------------------------------------------

  /** S1_STATUS push from the offscreen host. */
  function handleS1Status(payload) {
    let changed = false;
    try {
      changed = system1.handleStatusPush ? system1.handleStatusPush(payload) === true : false;
    } catch {
      changed = false;
    }
    const p = payload && typeof payload === 'object' && payload.payload && typeof payload.payload === 'object' ? payload.payload : payload;
    if (p && p.status === 'unloaded' && p.detail === 'idle') closeIdleOffscreenDocument();
    return changed;
  }

  /** S1_ENSURE_LOADED -> { success, status } (the load is not awaited). */
  async function ensureSystem1Loaded() {
    const loading = Promise.resolve(system1.ensureLoaded ? system1.ensureLoaded() : false).catch(() => false);
    await Promise.race([loading, new Promise((r) => setTimeout(r, ENSURE_REPLY_WAIT_MS))]);
    return { success: true, status: system1.status() };
  }

  /**
   * TEST_PROVIDER -> { success, ok, latencyMs, model, error?, code? }. Cloud tests send one fixed
   * synthetic post (never user data); error texts are redacted.
   * @param {unknown} id
   */
  async function testProvider(id) {
    if (typeof id !== 'string' || !TEST_PROVIDERS.includes(id)) {
      return { success: false, error: `provider must be one of: ${TEST_PROVIDERS.join(', ')}`, code: 'bad_request' };
    }
    const p = id === 'system1' ? system1 : escalators[id];
    /** @type {any} */
    let result;
    try {
      result = await p.testConnection();
    } catch (err) {
      const e = /** @type {any} */ (err);
      result = { ok: false, latencyMs: 0, model: '', error: e && e.message ? e.message : 'The test failed.', code: (e && e.code) || 'error' };
    }
    const out = {
      success: true,
      ok: !!(result && result.ok),
      latencyMs: finite(result && result.latencyMs) ?? 0,
      model: typeof result?.model === 'string' ? result.model : ''
    };
    if (!out.ok) {
      const known = await knownSecrets();
      out.error = redact(String(result?.error || 'The test failed.'), known).slice(0, 300);
      out.code = typeof result?.code === 'string' && result.code ? result.code : 'error';
    }
    if (id === 'nano') engineStatus.update({ nano: nano.status() });
    if (id === escalationId) engineStatus.update({ escalation: { provider: escalationId, status: escalationStatusOf(escalationId) } });
    if (out.ok) lastToast.delete(id);
    return out;
  }

  /**
   * NANO_DOWNLOAD_STATE from the side panel (it starts the download from a user click).
   * @param {any} payload
   */
  function noteNanoDownload(payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    if (!['start', 'progress', 'done', 'error'].includes(p.phase)) {
      return { success: false, error: 'phase must be one of: start, progress, done, error', code: 'bad_request' };
    }
    const status = nano.noteDownload({
      phase: p.phase,
      loaded: finite(p.loaded) ?? undefined,
      error: typeof p.error === 'string' ? p.error.slice(0, 200) : undefined
    });
    engineStatus.update({ nano: status, ...(escalationId === 'nano' ? { escalation: { status } } : {}) });
    return { success: true, status };
  }

  /** @param {any} p */
  function stateOf(p) {
    try {
      const s = p.status();
      return s && typeof s.state === 'string' ? { state: s.state } : {};
    } catch {
      return {};
    }
  }

  /** @param {any} p */
  function statsOf(p) {
    try {
      return typeof p.stats === 'function' ? p.stats() : {};
    } catch {
      return {};
    }
  }

  /** GET_DIAGNOSTICS (see lib/messages.js). Strings are redacted with the stored key values. */
  async function diagnostics() {
    /** @type {any[]} */
    let rejected = [];
    if (session) {
      try {
        const got = await session.get(REJECTED_LOG_KEY);
        const log = Array.isArray(got && got[REJECTED_LOG_KEY]) ? got[REJECTED_LOG_KEY] : [];
        rejected = log.slice(-DIAGNOSTICS_REJECTED).reverse().map((r) => ({
          at: finite(r && r.at),
          platform: String((r && r.platform) || ''),
          snippet: String((r && r.snippet) || '').slice(0, 140),
          pMatch: finite(r && r.pMatch),
          path: Array.isArray(r && r.path) ? r.path.filter((x) => typeof x === 'string') : [],
          reason: typeof r?.reason === 'string' ? r.reason : null,
          provider: typeof r?.provider === 'string' ? r.provider : null
        }));
      } catch {
        rejected = [];
      }
    }
    let secrets;
    try {
      secrets = await describeSecrets(area);
    } catch {
      secrets = { jev: { set: false, last4: null }, openai: { set: false, last4: null } };
    }
    const reply = {
      success: true,
      engineStatus: engineStatus.snapshot(),
      rejected,
      budget: budget.snapshot(),
      cache: cache.stats(),
      providers: {
        system1: system1.diagnostics ? system1.diagnostics() : {},
        nano: { ...statsOf(nano), ...stateOf(nano) },
        jev: { ...statsOf(jev), ...stateOf(jev) },
        openai: { ...statsOf(openai), ...stateOf(openai) }
      },
      refine: { ...(await refreshRefineCounts()), counters: refiner.stats() }
    };
    return { ...redactDeep(reply, await knownSecrets()), secrets };
  }

  /** RESET_DIAGNOSTICS: decision counters, provider statistics, cache counters. */
  function resetDiagnostics() {
    engineStatus.resetCounters();
    for (const p of [system1, nano, jev, openai]) {
      try {
        if (typeof p.resetStats === 'function') p.resetStats();
      } catch {
        /* ignore */
      }
    }
    cache.resetStats();
    try {
      refiner.resetStats();
    } catch {
      /* ignore */
    }
    lastToast.clear();
    return { success: true };
  }

  /**
   * GET_ENGINE_STATUS: EngineStatus + prompt warnings + legacy { tier, name, status }.
   *
   * Gemini Nano's availability is otherwise re-checked only when a post escalates to it, a setting
   * changes or the panel relays a download: without traffic the status from the worker's start
   * would stay (e.g. 'unavailable' while Chrome has since made the model downloadable, which hides
   * the panel's Download button). An open panel asks for the status, so it re-checks here: not
   * awaited (handlers never wait on LanguageModel.availability()), at most once per availability
   * TTL, and a change is pushed as ENGINE_STATUS through the provider's onStatus.
   *
   * Only extension pages may ask (the side panel): an open panel is when the user wants System 1,
   * so this also starts loading it (not awaited) when it is not loaded yet.
   * @param {any} configuration
   */
  function engineStatusReply(configuration) {
    warmSystem1();
    if (typeof nano.checkAvailability === 'function') {
      try {
        Promise.resolve(nano.checkAvailability()).catch(() => {});
      } catch {
        /* best effort */
      }
    }
    if (now() - refineCountedAt >= REFINE_COUNT_MIN_MS) refreshRefineCounts().catch(() => {});
    const snapshot = engineStatus.snapshot();
    return { ...snapshot, warnings: promptWarnings(configuration), ...legacyEngineFields(snapshot) };
  }

  return {
    decideMany: cascade.decideMany,
    engineStatus,
    system1,
    escalators,
    nano,
    jev,
    openai,
    rules,
    budget,
    cache,
    start,
    onStorageChanged,
    applyConfiguration,
    handleS1Status,
    ensureSystem1Loaded,
    testProvider,
    noteNanoDownload,
    diagnostics,
    resetDiagnostics,
    engineStatusReply,
    refiner,
    idleTrigger,
    refineNow,
    refreshRefineCounts,
    /** chrome.idle.onStateChanged (forwarded by the service worker) @param {string} state */
    onIdleState: (state) => idleTrigger.onIdleState(state),
    /** chrome.alarms REFINE_ALARM (forwarded by the service worker) */
    onRefineAlarm: () => idleTrigger.onAlarm(),
    /** @param {any} r  the redecider (lib/pipeline/redecide.js), created after decideMany */
    setRedecider(r) {
      redecide = r || null;
    }
  };
}
