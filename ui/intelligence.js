/**
 * Settings › Intelligence: System 1 (local embedding model), the primary escalation provider,
 * Gemini Nano (the browser's built-in LanguageModel), the opt-in cloud providers (TypeSafe Jev,
 * OpenAI) and the decision behaviour (strictness, when unsure, budgets, confidence floors).
 *
 * Every setting is saved with UPDATE_INTELLIGENCE_SETTINGS { patch } (whitelisted by
 * lib/storage/schema.js validateIntelligencePatch). API keys go through SET_SECRET / CLEAR_SECRET
 * and are never shown again: the panel only ever learns { set, last4 } (describeSecrets()).
 *
 * The pure helpers (payload builders, status mapping, startNanoDownload) are exported for tests;
 * mountIntelligence() renders the form into a container and returns { update, setSecrets }.
 */
import { MSG } from '../lib/messages.js';
import { MODEL_REGISTRY } from '../lib/decision/models.js';
import { resolveIntelligence } from '../lib/storage/schema.js';
import { redact } from '../lib/storage/secrets.js';
import { formatMs, isUnsupportedReply } from './util.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ESCALATION_OPTIONS = Object.freeze([
  { value: 'none', label: 'None (keep System 1’s answer)' },
  { value: 'nano', label: 'Browser built-in AI (Gemini Nano)' },
  { value: 'jev', label: 'TypeSafe Jev' },
  { value: 'openai', label: 'OpenAI' }
]);

export const CLOUD_PROVIDERS = Object.freeze({
  jev: Object.freeze({ id: 'jev', label: 'TypeSafe Jev', company: 'TypeSafe', modelPlaceholder: 'jev-latest', urlPlaceholder: 'https://api.typesafe.ai' }),
  openai: Object.freeze({ id: 'openai', label: 'OpenAI', company: 'OpenAI', modelPlaceholder: 'gpt-6-luna', urlPlaceholder: 'https://api.openai.com/v1' })
});

export const STRICTNESS_OPTIONS = Object.freeze([
  { value: 'strict', label: 'Strict', hint: 'Collect only posts that clearly match the prompt.' },
  { value: 'balanced', label: 'Balanced', hint: 'Collect posts that more likely match than not.' },
  { value: 'lenient', label: 'Lenient', hint: 'Collect anything that might match the prompt.' }
]);

export const WHEN_UNSURE_OPTIONS = Object.freeze([
  { value: 'collect', label: 'Collect the post' },
  { value: 'skip', label: 'Skip the post' }
]);

/** Limits mirror lib/storage/schema.js (escalation.perMinute / perDay). */
export const BUDGET_LIMITS = Object.freeze({ perMinute: { min: 0, max: 600 }, perDay: { min: 0, max: 100000 } });

/** Same expected inputs/outputs the service worker uses for availability() and create(). */
export const NANO_SESSION_OPTIONS = Object.freeze({
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }]
});

export const NANO_REQUIREMENTS =
  'Gemini Nano needs about 22 GB of free disk space and either 16 GB of RAM or a GPU with more than 4 GB of video memory. Chrome shows its status at chrome://on-device-internals.';

const PILLS = Object.freeze({
  ready: ['ok', 'Ready'],
  loading: ['loading', 'Loading'],
  downloading: ['loading', 'Downloading'],
  downloadable: ['muted', 'Not downloaded'],
  unavailable: ['muted', 'Unavailable'],
  no_key: ['warn', 'Needs key'],
  cloud_not_allowed: ['muted', 'Not allowed'],
  auth_error: ['error', 'Key rejected'],
  rate_limited: ['warn', 'Rate limited'],
  offline: ['warn', 'Offline'],
  error: ['error', 'Error'],
  disabled: ['muted', 'Off'],
  standby: ['muted', 'Allowed · not primary'],
  checking: ['muted', 'Checking…']
});

// ---------------------------------------------------------------------------
// Pure helpers: status mapping
// ---------------------------------------------------------------------------

/**
 * @param {string|undefined|null} state  ProviderStatus.state (or 'standby' / 'checking')
 * @param {{ progress?: number|null }} [extra]
 * @returns {{ state: string, tone: 'ok'|'warn'|'error'|'muted'|'loading', label: string }}
 */
export function statusPill(state, { progress = null } = {}) {
  const key = typeof state === 'string' && PILLS[state] ? state : 'checking';
  const [tone, base] = PILLS[key];
  let label = base;
  const p = Number(progress);
  if ((key === 'loading' || key === 'downloading') && progress !== null && progress !== undefined && Number.isFinite(p)) {
    label = `${base} ${Math.round(Math.min(1, Math.max(0, p)) * 100)}%`;
  }
  return { state: key, tone: /** @type {any} */ (tone), label };
}

/**
 * System 1 status from EngineStatus (checking until the service worker knows).
 * @param {any} engineStatus
 */
export function system1State(engineStatus) {
  if (!engineStatus || typeof engineStatus !== 'object') return { state: 'checking' };
  if (engineStatus.badge && engineStatus.badge.level === 'checking') return { state: 'checking' };
  const s1 = engineStatus.system1;
  if (!s1 || typeof s1.state !== 'string') return { state: engineStatus.badge ? 'checking' : 'unavailable' };
  return s1;
}

/**
 * Card state of a cloud provider.
 * @param {{ id: 'jev'|'openai', enabled: boolean, secret?: { set: boolean, last4?: string|null }|null, primary: string, escalation?: any }} input
 */
export function cloudCardState({ id, enabled, secret, primary, escalation }) {
  if (!enabled) return statusPill('disabled');
  if (secret && secret.set === false) return statusPill('no_key');
  if (primary !== id) return statusPill('standby');
  const st = escalation && escalation.provider === id && escalation.status && escalation.status.state;
  if (typeof st === 'string' && PILLS[st]) return statusPill(st);
  return { state: 'ready', tone: 'ok', label: 'Allowed' };
}

/**
 * Gemini Nano view from the service worker's view (EngineStatus.nano) and this panel's own probe.
 * @param {any} engineNano      EngineStatus.nano
 * @param {{ api: boolean, availability: string|null, downloading: boolean, progress: number|null, error: string|null }} local
 * @returns {{ state: string, progress: number|null, canDownload: boolean, error: string|null, noApi: boolean }}
 */
export function nanoState(engineNano, local) {
  const eng = engineNano && typeof engineNano.state === 'string' ? engineNano : null;
  const fromAvailability = { available: 'ready', readily: 'ready', downloadable: 'downloadable', 'after-download': 'downloadable', downloading: 'downloading', unavailable: 'unavailable', no: 'unavailable' };
  let state = 'checking';
  let progress = null;
  const localState = local.availability && fromAvailability[local.availability] ? fromAvailability[local.availability] : null;
  // The service worker's view wins when it can see the API (that is where decisions run), except
  // an 'unavailable' that the panel's own, fresher probe contradicts: both ask the same browser, and
  // the worker may not have re-checked since it started (Chrome can make the model downloadable
  // later). Otherwise the Download button would stay hidden although the model can be downloaded.
  const engSees = !!eng && (eng.present === 'sw' || eng.present === 'offscreen');
  const engOutdated = !!eng && eng.state === 'unavailable' && !!localState && localState !== 'unavailable';
  if (local.downloading) {
    state = 'downloading';
    progress = local.progress;
  } else if (eng && !engOutdated && (engSees || eng.state === 'ready' || eng.state === 'downloading')) {
    state = eng.state;
    progress = Number.isFinite(eng.progress) ? eng.progress : null;
  } else if (localState) {
    state = localState;
  } else if (local.api === false) {
    state = 'unavailable';
  } else if (eng) {
    state = eng.state;
  }
  const error = local.error || (eng && typeof eng.lastError === 'string' ? eng.lastError : null);
  return {
    state,
    progress,
    canDownload: !!local.api && !local.downloading
      && (state === 'downloadable' || state === 'downloading' || (state === 'checking' && local.availability !== null)),
    error,
    noApi: local.api === false
  };
}

/**
 * Hint under the "uncertain posts go to" select.
 * @param {{ provider: string, intelligence: any, secrets: any, nano: { state: string } }} input
 * @returns {{ text: string, tone: 'muted'|'warn' }}
 */
export function escalationHint({ provider, intelligence, secrets, nano }) {
  if (provider === 'none') {
    return { text: 'Uncertain posts keep System 1’s answer and follow “When still unsure” below.', tone: 'muted' };
  }
  if (provider === 'nano') {
    return nano && nano.state === 'ready'
      ? { text: 'Uncertain posts are checked again by Gemini Nano, on this device.', tone: 'muted' }
      : { text: 'Gemini Nano is not ready yet (see below). Until it is, System 1’s answer is used.', tone: 'warn' };
  }
  const cloud = CLOUD_PROVIDERS[/** @type {'jev'|'openai'} */ (provider)];
  if (!cloud) return { text: '', tone: 'muted' };
  const cfg = (intelligence && intelligence.providers && intelligence.providers[provider]) || {};
  if (!cfg.enabled) {
    return { text: `${cloud.label} is selected but not allowed yet: turn on its switch below. Until then nothing is sent.`, tone: 'warn' };
  }
  const secret = secrets && secrets[provider];
  if (secret && secret.set === false) return { text: `Save a ${cloud.label} API key below to start escalating.`, tone: 'warn' };
  return { text: `Only posts System 1 is unsure about are sent to ${cloud.label}, within the budget below.`, tone: 'muted' };
}

// ---------------------------------------------------------------------------
// Pure helpers: form value -> UPDATE_INTELLIGENCE_SETTINGS patch
// ---------------------------------------------------------------------------

/** @param {string} provider */
export function providerPatch(provider) {
  return { escalation: { provider } };
}

/** @param {string} key */
export function modelPatch(key) {
  return { system1: { model: key } };
}

/**
 * @param {'jev'|'openai'} id
 * @param {boolean} enabled
 */
export function cloudEnabledPatch(id, enabled) {
  return { providers: { [id]: { enabled: !!enabled } } };
}

/**
 * @param {'jev'|'openai'} id
 * @param {'model'|'baseUrl'} field
 * @param {unknown} raw
 * @returns {{ ok: true, patch: object } | { ok: false, error: string }}
 */
export function cloudFieldPatch(id, field, raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (field === 'model') {
    if (!value || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) return { ok: false, error: 'Enter a model name (up to 100 characters).' };
    return { ok: true, patch: { providers: { [id]: { model: value } } } };
  }
  if (field === 'baseUrl') {
    let u;
    try {
      u = new URL(value);
    } catch {
      return { ok: false, error: 'Enter a full URL, e.g. https://api.example.com/v1' };
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) || u.hostname.endsWith('.localhost');
    if (u.username || u.password) return { ok: false, error: 'The URL must not contain a user name or password.' };
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return { ok: false, error: 'Use https (http only for localhost).' };
    return { ok: true, patch: { providers: { [id]: { baseUrl: value } } } };
  }
  return { ok: false, error: 'Unknown field' };
}

/** @param {boolean} enabled */
export function refinePatch(enabled) {
  return { refine: { enabled: !!enabled } };
}

/**
 * "3 min ago" style age of an epoch-ms time.
 * @param {number|null|undefined} at
 * @param {number} nowMs
 */
export function agoText(at, nowMs) {
  if (!Number.isFinite(at)) return '';
  const s = Math.max(0, Math.round((nowMs - /** @type {number} */ (at)) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/**
 * Status line of the idle refinement (EngineStatus.refine, see lib/bg/decision-runtime.js).
 * @param {any} refine
 * @param {{ enabled?: boolean, now?: number }} [opts]   enabled: the stored setting
 * @returns {string}
 */
export function refineStatusText(refine, { enabled = true, now = Date.now() } = {}) {
  const r = refine && typeof refine === 'object' ? refine : {};
  if (!enabled || r.enabled === false) return 'Off';
  if (r.state === 'running') {
    return Number.isFinite(r.pending) && r.pending > 0 ? `Running… ${r.done || 0} of ${r.pending}` : 'Running…';
  }
  if (!Number.isFinite(r.total)) return 'Waiting for idle';
  if (r.total === 0) return 'Nothing to refine yet';
  const parts = [`Refined ${r.refined || 0} of ${r.total}`];
  if (Number.isFinite(r.lastRunAt)) parts.push(`last run ${agoText(r.lastRunAt, now)}`);
  if ((r.refined || 0) < r.total) parts.push('Waiting for idle');
  return parts.join(' · ');
}

/**
 * @param {'strictness'|'whenUnsure'} field
 * @param {string} value
 */
export function gatePatch(field, value) {
  return { gate: { [field]: value } };
}

/**
 * @param {'perMinute'|'perDay'} field
 * @param {unknown} raw
 * @returns {{ ok: true, patch: object } | { ok: false, error: string }}
 */
export function budgetPatch(field, raw) {
  const limits = BUDGET_LIMITS[field];
  if (!limits) return { ok: false, error: 'Unknown budget' };
  const s = typeof raw === 'string' ? raw.trim() : String(raw ?? '');
  const n = Number(s);
  if (!s || !Number.isInteger(n) || n < limits.min || n > limits.max) {
    return { ok: false, error: `Enter a whole number from ${limits.min} to ${limits.max}.` };
  }
  return { ok: true, patch: { escalation: { [field]: n } } };
}

/**
 * A blank floor means "use the calibrated default" and is sent as null.
 * @param {'matches_prompt'|'primary_tag'} id
 * @param {unknown} raw
 * @returns {{ ok: true, patch: object } | { ok: false, error: string }}
 */
export function floorPatch(id, raw) {
  const s = typeof raw === 'string' ? raw.trim() : String(raw ?? '');
  if (!s) return { ok: true, patch: { escalation: { floor: { [id]: null } } } };
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || n > 1) return { ok: false, error: 'Enter a number from 0 to 1, or leave it blank for the default.' };
  return { ok: true, patch: { escalation: { floor: { [id]: n } } } };
}

/**
 * @param {'jev'|'openai'} provider
 * @param {unknown} raw
 * @returns {{ ok: true, payload: { provider: string, value: string } } | { ok: false, error: string }}
 */
export function secretPayload(provider, raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { ok: false, error: 'Paste an API key first.' };
  if (/\s/.test(value) || value.length > 512) return { ok: false, error: 'That does not look like an API key.' };
  return { ok: true, payload: { provider, value } };
}

/**
 * @param {{ set?: boolean, last4?: string|null }|null|undefined} secret
 * @returns {string}
 */
export function secretStatusText(secret) {
  if (!secret || typeof secret.set !== 'boolean') return '';
  if (!secret.set) return 'No key saved';
  return secret.last4 ? `Key saved ••${secret.last4}` : 'Key saved';
}

/**
 * @param {any} reply  TEST_PROVIDER reply
 * @returns {{ tone: 'ok'|'error'|'muted', text: string }}
 */
export function testResultText(reply) {
  if (!reply) return { tone: 'error', text: 'No answer from the extension.' };
  if (isUnsupportedReply(reply)) return { tone: 'muted', text: 'Testing is not available in this version yet.' };
  if (reply.ok) {
    const parts = ['Connected', formatMs(reply.latencyMs)];
    if (typeof reply.model === 'string' && reply.model) parts.push(reply.model);
    return { tone: 'ok', text: parts.filter((p) => p && p !== '—').join(' · ') };
  }
  const err = redact(typeof reply.error === 'string' && reply.error ? reply.error : 'Failed').slice(0, 200);
  return { tone: 'error', text: `Failed: ${err}${reply.code ? ` (${reply.code})` : ''}` };
}

// ---------------------------------------------------------------------------
// Gemini Nano download (must start inside the click handler: user activation)
// ---------------------------------------------------------------------------

/** @param {any} e downloadprogress event */
function progressFraction(e) {
  const loaded = Number(e && e.loaded);
  const total = Number(e && e.total);
  if (!Number.isFinite(loaded)) return 0;
  const f = Number.isFinite(total) && total > 1 ? loaded / total : loaded;
  return Math.min(1, Math.max(0, f));
}

/** @param {unknown} err */
function errorText(err) {
  const e = /** @type {any} */ (err);
  const name = e && typeof e.name === 'string' && e.name !== 'Error' ? `${e.name}: ` : '';
  const msg = e && typeof e.message === 'string' ? e.message : String(err ?? 'error');
  return redact(`${name}${msg}`).slice(0, 200);
}

/**
 * Calls LanguageModel.create() synchronously (so the click's user activation reaches it), relays
 * NANO_DOWNLOAD_STATE start/progress/done/error to the service worker and destroys the session.
 *
 * @param {{ LanguageModel: any, send: (type: string, payload: object) => unknown, onUpdate?: (u: { phase: string, loaded?: number, error?: string }) => void }} opts
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export function startNanoDownload({ LanguageModel, send, onUpdate = () => {} }) {
  const relay = (/** @type {string} */ phase, extra = {}) => {
    try {
      const r = send(MSG.NANO_DOWNLOAD_STATE, { phase, ...extra });
      if (r && typeof (/** @type {any} */ (r).catch) === 'function') /** @type {any} */ (r).catch(() => {});
    } catch {
      /* the service worker may be restarting; the download itself goes on */
    }
  };
  if (!LanguageModel || typeof LanguageModel.create !== 'function') {
    const error = 'This browser does not offer its built-in AI to extensions.';
    onUpdate({ phase: 'error', error });
    return Promise.resolve({ ok: false, error });
  }
  let lastPct = -1;
  let pending;
  try {
    pending = LanguageModel.create({
      expectedInputs: NANO_SESSION_OPTIONS.expectedInputs.map((x) => ({ ...x, languages: [...x.languages] })),
      expectedOutputs: NANO_SESSION_OPTIONS.expectedOutputs.map((x) => ({ ...x, languages: [...x.languages] })),
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          const loaded = progressFraction(e);
          onUpdate({ phase: 'progress', loaded });
          const pct = Math.floor(loaded * 100);
          if (pct !== lastPct) {
            lastPct = pct;
            relay('progress', { loaded });
          }
        });
      }
    });
  } catch (err) {
    const error = errorText(err);
    relay('error', { error });
    onUpdate({ phase: 'error', error });
    return Promise.resolve({ ok: false, error });
  }
  relay('start');
  onUpdate({ phase: 'start' });
  return Promise.resolve(pending).then(
    (session) => {
      try {
        if (session && typeof session.destroy === 'function') session.destroy();
      } catch {
        /* ignore */
      }
      relay('done');
      onUpdate({ phase: 'done' });
      return { ok: true };
    },
    (err) => {
      const error = errorText(err);
      relay('error', { error });
      onUpdate({ phase: 'error', error });
      return { ok: false, error };
    }
  );
}

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

/** @param {string} id */
function pillHtml(id) {
  return `<span class="status-pill" id="${id}" data-tone="muted"><span class="status-pill-dot"></span><span class="status-pill-text">Checking…</span></span>`;
}

/** @param {'jev'|'openai'} id */
function cloudCardHtml(id) {
  const p = CLOUD_PROVIDERS[id];
  return `
  <section class="intel-card" id="intel-${id}" data-provider="${id}" aria-labelledby="intel-${id}-name">
    <div class="intel-card-head">
      <div class="intel-card-title">
        <span class="intel-name" id="intel-${id}-name">${p.label}</span>
        <span class="intel-sub">Cloud · off unless you allow it</span>
      </div>
      ${pillHtml(`${id}-pill`)}
    </div>
    <label class="switch-row" for="${id}-enabled">
      <span class="switch-text">
        <span class="switch-title">Allow sending uncertain posts to ${p.label}</span>
        <span class="intel-hint">Only posts System 1 is unsure about leave your device: their text is sent to ${p.company}’s servers. Everything else stays here.</span>
      </span>
      <span class="tag-toggle"><input type="checkbox" id="${id}-enabled"><span class="toggle-track"></span></span>
    </label>
    <div class="field">
      <label class="field-label" for="${id}-key">API key</label>
      <div class="input-row">
        <input type="password" class="text-input" id="${id}-key" autocomplete="off" spellcheck="false" placeholder="Paste your ${p.label} API key">
        <button type="button" class="btn-sm primary" id="${id}-key-save">Save</button>
        <button type="button" class="btn-sm ghost" id="${id}-key-clear">Clear</button>
      </div>
      <span class="key-status" id="${id}-key-status"></span>
    </div>
    <div class="field">
      <label class="field-label" for="${id}-model">Model</label>
      <input type="text" class="text-input" id="${id}-model" autocomplete="off" spellcheck="false" placeholder="${p.modelPlaceholder}">
    </div>
    <details class="intel-advanced">
      <summary>Advanced</summary>
      <div class="field">
        <label class="field-label" for="${id}-baseurl">Base URL</label>
        <input type="url" class="text-input" id="${id}-baseurl" autocomplete="off" spellcheck="false" placeholder="${p.urlPlaceholder}">
      </div>
    </details>
    <div class="intel-actions">
      <button type="button" class="btn-sm" id="${id}-test">Test connection</button>
      <span class="test-result" id="${id}-test-result" aria-live="polite"></span>
    </div>
  </section>`;
}

function templateHtml() {
  const modelOptions = Object.values(MODEL_REGISTRY)
    .map((m) => `<option value="${m.key}">${m.label}</option>`)
    .join('');
  const escOptions = ESCALATION_OPTIONS.map((o) => `<option value="${o.value}">${o.label}</option>`).join('');
  const strictness = STRICTNESS_OPTIONS.map((o) => `
        <label class="seg-option"><input type="radio" name="intel-strictness" value="${o.value}"><span>${o.label}</span></label>`).join('');
  const unsure = WHEN_UNSURE_OPTIONS.map((o) => `<option value="${o.value}">${o.label}</option>`).join('');
  return `
  <div class="intel">
    <section class="intel-card" id="intel-s1" aria-labelledby="intel-s1-name">
      <div class="intel-card-head">
        <div class="intel-card-title">
          <span class="intel-name" id="intel-s1-name">System 1</span>
          <span class="intel-sub">Local model · decides every post</span>
        </div>
        ${pillHtml('s1-pill')}
      </div>
      <p class="intel-desc">Runs inside your browser and decides whether each post matches your prompt and which tag it gets. Post text stays on this device.</p>
      <div class="field">
        <label class="field-label" for="s1-model">Model</label>
        <select class="select-input" id="s1-model">${modelOptions}</select>
      </div>
      <div class="progress hidden" id="s1-progress" role="progressbar" aria-label="System 1 loading" aria-valuemin="0" aria-valuemax="100"><div class="progress-fill"></div></div>
      <div class="intel-meta" id="s1-meta"></div>
      <div class="intel-error hidden" id="s1-error"></div>
      <div class="intel-actions">
        <button type="button" class="btn-sm" id="s1-load">Load model</button>
        <button type="button" class="btn-sm ghost" id="s1-test">Test</button>
        <span class="test-result" id="s1-test-result" aria-live="polite"></span>
      </div>
    </section>

    <div class="intel-block">
      <label class="field-label" for="esc-provider">When System 1 is unsure, ask</label>
      <select class="select-input" id="esc-provider">${escOptions}</select>
      <p class="intel-hint" id="esc-hint"></p>
    </div>

    <section class="intel-card" id="intel-nano" aria-labelledby="intel-nano-name">
      <div class="intel-card-head">
        <div class="intel-card-title">
          <span class="intel-name" id="intel-nano-name">Gemini Nano</span>
          <span class="intel-sub">Browser built-in AI · on this device</span>
        </div>
        ${pillHtml('nano-pill')}
      </div>
      <p class="intel-desc">Chrome’s built-in model. It runs on this device, so post text never leaves it.</p>
      <div class="progress hidden" id="nano-progress" role="progressbar" aria-label="Gemini Nano download" aria-valuemin="0" aria-valuemax="100"><div class="progress-fill"></div></div>
      <p class="intel-hint hidden" id="nano-requirements"></p>
      <div class="intel-error hidden" id="nano-error"></div>
      <div class="intel-actions">
        <button type="button" class="btn-sm primary hidden" id="nano-download">Download / enable</button>
        <button type="button" class="btn-sm ghost" id="nano-test">Test</button>
        <span class="test-result" id="nano-test-result" aria-live="polite"></span>
      </div>
    </section>

    ${cloudCardHtml('jev')}
    ${cloudCardHtml('openai')}

    <section class="intel-card" id="intel-refine" aria-labelledby="refine-title">
      <label class="switch-row" for="refine-enabled">
        <span class="switch-text">
          <span class="switch-title" id="refine-title">Refine collected posts when idle (second model + on-device AI)</span>
          <span class="intel-hint">While you are away, posts you already collected are checked again by the second local model; posts it is still unsure about go to Gemini Nano on this device. Nothing is sent to the cloud.</span>
        </span>
        <span class="tag-toggle"><input type="checkbox" id="refine-enabled"><span class="toggle-track"></span></span>
      </label>
      <div class="intel-actions">
        <span class="intel-meta" id="refine-status" aria-live="polite">Waiting for idle</span>
        <button type="button" class="btn-sm ghost" id="refine-now">Refine now</button>
      </div>
    </section>

    <div class="intel-block">
      <span class="field-label" id="intel-strictness-label">Strictness</span>
      <div class="segmented" role="radiogroup" aria-labelledby="intel-strictness-label" id="intel-strictness">${strictness}
      </div>
      <p class="intel-hint" id="strictness-hint"></p>
      <div class="field">
        <label class="field-label" for="gate-unsure">When still unsure</label>
        <select class="select-input" id="gate-unsure">${unsure}</select>
      </div>
      <div class="field-grid">
        <div class="field">
          <label class="field-label" for="budget-minute">Escalations / minute</label>
          <input type="number" class="text-input" id="budget-minute" min="${BUDGET_LIMITS.perMinute.min}" max="${BUDGET_LIMITS.perMinute.max}" step="1" inputmode="numeric">
        </div>
        <div class="field">
          <label class="field-label" for="budget-day">Escalations / day</label>
          <input type="number" class="text-input" id="budget-day" min="${BUDGET_LIMITS.perDay.min}" max="${BUDGET_LIMITS.perDay.max}" step="1" inputmode="numeric">
        </div>
      </div>
      <details class="intel-advanced">
        <summary>Confidence floors</summary>
        <p class="intel-hint">Answers below these confidences count as unsure and go to the provider above. Leave blank to use the calibrated default.</p>
        <div class="field-grid">
          <div class="field">
            <label class="field-label" for="floor-match">Prompt match</label>
            <input type="number" class="text-input" id="floor-match" min="0" max="1" step="0.05" inputmode="decimal">
          </div>
          <div class="field">
            <label class="field-label" for="floor-tag">Tag</label>
            <input type="number" class="text-input" id="floor-tag" min="0" max="1" step="0.05" inputmode="decimal">
          </div>
        </div>
      </details>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

/**
 * @typedef {object} IntelligenceDeps
 * @property {(type: string, payload?: object) => Promise<any>} send
 * @property {{ show: (o: { level?: string, text: string, key?: string }) => unknown }} toast
 * @property {() => any} [getLanguageModel]          the panel's LanguageModel global (or undefined)
 * @property {(modelKey: string) => Promise<{ floor?: Record<string, number> }|null>} [loadCalibration]
 * @property {Document} [doc]
 */

/**
 * @param {HTMLElement} root
 * @param {IntelligenceDeps} deps
 */
export function mountIntelligence(root, deps) {
  const { send, toast } = deps;
  const doc = deps.doc || root.ownerDocument || globalThis.document;
  const getLM = deps.getLanguageModel || (() => globalThis.LanguageModel);
  root.innerHTML = templateHtml();

  /** @param {string} id @returns {any} */
  const $ = (id) => root.querySelector(`#${id}`);

  const model = {
    /** explicit configuration.intelligence (as stored) */
    intelligence: resolveIntelligence({}),
    /** @type {any} */ engineStatus: null,
    /** @type {any} */ secrets: null,
    /** @type {any} */ diagnostics: null,
    /** @type {any} EngineStatus.refine from a REFINE_NOW reply (until the next push) */ refine: null,
    /** @type {Record<string, any>} */ calibration: {},
    s1Override: /** @type {any} */ (null),
    nanoLocal: { api: false, availability: /** @type {string|null} */ (null), downloading: false, progress: /** @type {number|null} */ (null), error: /** @type {string|null} */ (null) }
  };
  /** @type {Map<string, unknown>} control id -> value saved but not confirmed yet */
  const pending = new Map();

  const LM = getLM();
  model.nanoLocal.api = !!(LM && typeof LM.create === 'function');

  /** @param {Element} el */
  const isFocused = (el) => doc.activeElement === el || (el && el.contains && el.contains(doc.activeElement));

  /**
   * Sets a control's value unless the user is on it or a save is in flight.
   * @param {HTMLInputElement|HTMLSelectElement} el
   * @param {unknown} value
   */
  function setControl(el, value) {
    if (!el || isFocused(el) || pending.has(el.id)) return;
    const v = value === null || value === undefined ? '' : String(value);
    if (el.value !== v) el.value = v;
  }

  /**
   * @param {HTMLElement} el
   * @param {{ tone: string, label: string }} pill
   */
  function setPill(el, pill) {
    el.dataset.tone = pill.tone;
    el.querySelector('.status-pill-text').textContent = pill.label;
  }

  /**
   * @param {HTMLElement} el
   * @param {number|null} fraction
   * @param {boolean} visible
   */
  function setProgress(el, fraction, visible) {
    el.classList.toggle('hidden', !visible);
    const indeterminate = !(Number.isFinite(fraction));
    el.classList.toggle('indeterminate', visible && indeterminate);
    const pct = indeterminate ? 0 : Math.round(Math.min(1, Math.max(0, /** @type {number} */ (fraction))) * 100);
    /** @type {HTMLElement} */ (el.querySelector('.progress-fill')).style.width = indeterminate ? '' : `${pct}%`;
    if (indeterminate) el.removeAttribute('aria-valuenow');
    else el.setAttribute('aria-valuenow', String(pct));
  }

  /**
   * @param {HTMLElement} el
   * @param {string} text
   */
  function setText(el, text) {
    el.textContent = text || '';
    el.classList.toggle('hidden', !text);
  }

  /**
   * Saves a patch; reverts the controls (re-render) when the service worker refuses it.
   * @param {object} patch
   * @param {string} [controlId]
   * @param {unknown} [value]
   */
  async function apply(patch, controlId, value) {
    if (controlId) pending.set(controlId, value);
    const reply = await send(MSG.UPDATE_INTELLIGENCE_SETTINGS, { patch });
    if (controlId) pending.delete(controlId);
    if (!reply || reply.success === false) {
      const why = reply && typeof reply.error === 'string' ? reply.error : 'the extension did not answer';
      toast.show({ level: 'error', text: `Could not save the setting: ${why}`, key: 'intel-save' });
      render();
      return false;
    }
    if (reply.intelligence && typeof reply.intelligence === 'object') model.intelligence = reply.intelligence;
    render();
    return true;
  }

  // ----- System 1 -----
  $('s1-model').addEventListener('change', (e) => {
    const v = e.target.value;
    apply(modelPatch(v), 's1-model', v);
    loadFloors(v);
  });

  $('s1-load').addEventListener('click', async () => {
    const btn = $('s1-load');
    btn.disabled = true;
    const reply = await send(MSG.S1_ENSURE_LOADED, {});
    btn.disabled = false;
    if (isUnsupportedReply(reply)) {
      toast.show({ level: 'info', text: 'Loading the local model on demand is not available in this version yet.', key: 's1-load' });
    } else if (!reply || reply.success === false) {
      toast.show({ level: 'error', text: `Could not load the local model: ${redact(reply?.error || 'no answer')}`, key: 's1-load' });
    } else if (reply.status && typeof reply.status === 'object') {
      model.s1Override = reply.status.system1 || reply.status;
    }
    render();
  });

  /**
   * @param {string} provider
   * @param {string} buttonId
   * @param {string} resultId
   */
  function wireTest(provider, buttonId, resultId) {
    $(buttonId).addEventListener('click', async () => {
      const btn = $(buttonId);
      const out = $(resultId);
      btn.disabled = true;
      out.dataset.tone = 'muted';
      out.textContent = 'Testing…';
      const reply = await send(MSG.TEST_PROVIDER, { provider });
      btn.disabled = false;
      const res = testResultText(reply);
      out.dataset.tone = res.tone;
      out.textContent = res.text;
    });
  }
  wireTest('system1', 's1-test', 's1-test-result');
  wireTest('nano', 'nano-test', 'nano-test-result');

  // ----- Escalation provider -----
  $('esc-provider').addEventListener('change', (e) => {
    const v = e.target.value;
    apply(providerPatch(v), 'esc-provider', v);
  });

  // ----- Nano -----
  async function probeNano() {
    const api = getLM();
    model.nanoLocal.api = !!(api && typeof api.create === 'function');
    if (!api || typeof api.availability !== 'function') {
      if (api) model.nanoLocal.availability = 'unknown';
      render();
      return;
    }
    try {
      model.nanoLocal.availability = String(await api.availability({ ...NANO_SESSION_OPTIONS }));
    } catch {
      model.nanoLocal.availability = 'unavailable';
    }
    render();
  }

  $('nano-download').addEventListener('click', () => {
    // No await before create(): the download needs this click's user activation.
    model.nanoLocal.error = null;
    const result = startNanoDownload({
      LanguageModel: getLM(),
      send: (type, payload) => send(type, payload),
      onUpdate: (u) => {
        if (u.phase === 'start') {
          model.nanoLocal.downloading = true;
          model.nanoLocal.progress = null;
        } else if (u.phase === 'progress') {
          model.nanoLocal.downloading = true;
          model.nanoLocal.progress = Number.isFinite(u.loaded) ? /** @type {number} */ (u.loaded) : null;
        } else if (u.phase === 'done') {
          model.nanoLocal.downloading = false;
          model.nanoLocal.availability = 'available';
        } else if (u.phase === 'error') {
          model.nanoLocal.downloading = false;
          model.nanoLocal.error = u.error || 'error';
        }
        render();
      }
    });
    result.then((r) => {
      if (r.ok) toast.show({ level: 'success', text: 'Gemini Nano is ready.', key: 'nano' });
      else toast.show({ level: 'error', text: `Gemini Nano could not be enabled: ${r.error}`, key: 'nano' });
      probeNano();
    });
  });

  // ----- Cloud providers -----
  for (const id of /** @type {('jev'|'openai')[]} */ (Object.keys(CLOUD_PROVIDERS))) {
    const label = CLOUD_PROVIDERS[id].label;
    $(`${id}-enabled`).addEventListener('change', (e) => {
      const on = !!e.target.checked;
      apply(cloudEnabledPatch(id, on), `${id}-enabled`, on);
    });

    const saveKey = async () => {
      const input = $(`${id}-key`);
      const check = secretPayload(id, input.value);
      if (!check.ok) {
        toast.show({ level: 'warn', text: check.error, key: `${id}-key` });
        return;
      }
      const typed = check.payload.value;
      // The field is cleared before the reply: the key is never kept or shown by the panel.
      input.value = '';
      const reply = await send(MSG.SET_SECRET, check.payload);
      if (reply && reply.success && reply.secrets) {
        setSecrets(reply.secrets);
        toast.show({ level: 'success', text: `${label} key saved.`, key: `${id}-key` });
      } else {
        const why = redact(reply && reply.error ? reply.error : 'the extension did not answer', [typed]);
        toast.show({ level: 'error', text: `Could not save the ${label} key: ${why}`, key: `${id}-key` });
      }
    };
    $(`${id}-key-save`).addEventListener('click', saveKey);
    $(`${id}-key`).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveKey();
      }
    });
    $(`${id}-key-clear`).addEventListener('click', async () => {
      $(`${id}-key`).value = '';
      const reply = await send(MSG.CLEAR_SECRET, { provider: id });
      if (reply && reply.success && reply.secrets) {
        setSecrets(reply.secrets);
        toast.show({ level: 'info', text: `${label} key removed.`, key: `${id}-key` });
      } else {
        toast.show({ level: 'error', text: `Could not remove the ${label} key: ${redact(reply?.error || 'no answer')}`, key: `${id}-key` });
      }
    });

    for (const [field, control] of /** @type {const} */ ([['model', `${id}-model`], ['baseUrl', `${id}-baseurl`]])) {
      $(control).addEventListener('change', (e) => {
        const res = cloudFieldPatch(id, field, e.target.value);
        if (!res.ok) {
          toast.show({ level: 'warn', text: `${label}: ${res.error}`, key: control });
          e.target.blur();
          render();
          return;
        }
        apply(res.patch, control, e.target.value.trim());
      });
    }
    wireTest(id, `${id}-test`, `${id}-test-result`);
  }

  // ----- Idle refinement -----
  $('refine-enabled').addEventListener('change', (e) => {
    const on = !!e.target.checked;
    apply(refinePatch(on), 'refine-enabled', on);
  });
  $('refine-now').addEventListener('click', async () => {
    const btn = $('refine-now');
    btn.disabled = true;
    const reply = await send(MSG.REFINE_NOW, {});
    btn.disabled = false;
    if (isUnsupportedReply(reply) || !reply || reply.success === false) {
      toast.show({ level: 'error', text: `Could not start refining: ${redact((reply && reply.error) || 'no answer')}`, key: 'refine' });
      return;
    }
    if (reply.refine && typeof reply.refine === 'object') model.refine = reply.refine;
    render();
  });

  // ----- Behaviour -----
  $('intel-strictness').addEventListener('change', (e) => {
    const v = e.target.value;
    apply(gatePatch('strictness', v), 'intel-strictness', v);
  });
  $('gate-unsure').addEventListener('change', (e) => {
    const v = e.target.value;
    apply(gatePatch('whenUnsure', v), 'gate-unsure', v);
  });
  for (const [field, control] of /** @type {const} */ ([['perMinute', 'budget-minute'], ['perDay', 'budget-day']])) {
    $(control).addEventListener('change', (e) => {
      const res = budgetPatch(field, e.target.value);
      if (!res.ok) {
        toast.show({ level: 'warn', text: res.error, key: control });
        e.target.blur();
        render();
        return;
      }
      apply(res.patch, control, e.target.value.trim());
    });
  }
  for (const [qid, control] of /** @type {const} */ ([['matches_prompt', 'floor-match'], ['primary_tag', 'floor-tag']])) {
    $(control).addEventListener('change', (e) => {
      const res = floorPatch(qid, e.target.value);
      if (!res.ok) {
        toast.show({ level: 'warn', text: res.error, key: control });
        e.target.blur();
        render();
        return;
      }
      apply(res.patch, control, e.target.value.trim());
    });
  }

  /** @param {string} modelKey */
  async function loadFloors(modelKey) {
    if (!deps.loadCalibration || model.calibration[modelKey]) {
      render();
      return;
    }
    try {
      const cal = await deps.loadCalibration(modelKey);
      if (cal && cal.floor) model.calibration[modelKey] = cal.floor;
    } catch {
      /* placeholders just stay generic */
    }
    render();
  }

  // ----- Render -----
  function render() {
    const intel = model.intelligence;
    const es = model.engineStatus;

    // System 1
    const s1 = model.s1Override && (!es || !es.system1 || es.system1.state !== 'ready') ? { ...system1State(es), ...model.s1Override } : system1State(es);
    const s1Pill = statusPill(s1.state, { progress: s1.progress });
    setPill($('s1-pill'), s1Pill);
    setControl($('s1-model'), intel.system1 && intel.system1.model);
    const loading = s1.state === 'loading' || s1.state === 'downloading';
    setProgress($('s1-progress'), Number.isFinite(s1.progress) ? s1.progress : null, loading);
    const diagS1 = (model.diagnostics && model.diagnostics.providers && model.diagnostics.providers.system1) || {};
    const meta = [];
    const device = s1.device || diagS1.device || (intel.system1 && intel.system1.device);
    if (device) meta.push(device === 'wasm' ? 'CPU (WASM)' : device === 'webgpu' ? 'GPU (WebGPU)' : String(device));
    const avg = Number.isFinite(diagS1.avgMs) ? diagS1.avgMs : s1.lastLatencyMs;
    if (Number.isFinite(avg)) meta.push(`avg ${formatMs(avg)} per post`);
    if (Number.isFinite(diagS1.loadMs)) meta.push(`loaded in ${formatMs(diagS1.loadMs)}`);
    $('s1-meta').textContent = meta.join(' · ');
    setText($('s1-error'), s1.state === 'error' || s1.state === 'unavailable' ? redact(s1.lastError || diagS1.lastError || '') : '');
    const loadBtn = $('s1-load');
    loadBtn.classList.toggle('hidden', s1.state === 'ready');
    loadBtn.textContent = s1.state === 'error' ? 'Retry' : loading ? 'Loading…' : 'Load model';
    loadBtn.disabled = loading;

    // Escalation provider
    const provider = (intel.escalation && intel.escalation.provider) || 'none';
    setControl($('esc-provider'), provider);
    const nano = nanoState(es && es.nano, model.nanoLocal);
    const hint = escalationHint({ provider: pending.has('esc-provider') ? String(pending.get('esc-provider')) : provider, intelligence: intel, secrets: model.secrets, nano });
    $('esc-hint').textContent = hint.text;
    $('esc-hint').dataset.tone = hint.tone;

    // Nano
    setPill($('nano-pill'), statusPill(nano.state, { progress: nano.progress }));
    setProgress($('nano-progress'), nano.progress, nano.state === 'downloading');
    const req = $('nano-requirements');
    const showReq = nano.state === 'unavailable' || nano.state === 'downloadable';
    req.textContent = nano.noApi
      ? 'This browser does not offer its built-in AI to extensions. Use Chrome 138 or newer on a supported computer.'
      : NANO_REQUIREMENTS;
    req.classList.toggle('hidden', !(showReq || nano.noApi));
    setText($('nano-error'), nano.error ? `Last error: ${nano.error}` : '');
    const dl = $('nano-download');
    dl.classList.toggle('hidden', !(nano.canDownload || (model.nanoLocal.downloading)));
    dl.disabled = model.nanoLocal.downloading;
    dl.textContent = model.nanoLocal.downloading ? 'Downloading…' : 'Download / enable';

    // Cloud cards
    for (const id of /** @type {('jev'|'openai')[]} */ (Object.keys(CLOUD_PROVIDERS))) {
      const cfg = (intel.providers && intel.providers[id]) || {};
      const enabledEl = $(`${id}-enabled`);
      if (!pending.has(enabledEl.id) && enabledEl.checked !== !!cfg.enabled) enabledEl.checked = !!cfg.enabled;
      const secret = model.secrets ? model.secrets[id] : null;
      setPill($(`${id}-pill`), cloudCardState({ id, enabled: !!cfg.enabled, secret, primary: provider, escalation: es && es.escalation }));
      $(`${id}-key-status`).textContent = secretStatusText(secret);
      $(`${id}-key-clear`).disabled = !!secret && secret.set === false;
      setControl($(`${id}-model`), cfg.model);
      setControl($(`${id}-baseurl`), cfg.baseUrl);
      $(`intel-${id}`).classList.toggle('is-primary', provider === id);
    }
    $('intel-nano').classList.toggle('is-primary', provider === 'nano');

    // Idle refinement
    const refineCfg = intel.refine || {};
    const refineEl = $('refine-enabled');
    if (!pending.has(refineEl.id) && refineEl.checked !== (refineCfg.enabled !== false)) refineEl.checked = refineCfg.enabled !== false;
    const refineState = (es && es.refine) || model.refine || (model.diagnostics && model.diagnostics.refine) || null;
    const refineOn = (pending.has(refineEl.id) ? pending.get(refineEl.id) : refineCfg.enabled) !== false && !(intel.system1 && intel.system1.enabled === false);
    $('refine-status').textContent = refineStatusText(refineState, { enabled: refineOn });
    $('refine-now').disabled = !refineOn || (refineState && refineState.state === 'running');

    // Behaviour
    const gate = intel.gate || {};
    const group = $('intel-strictness');
    if (!isFocused(group) && !pending.has('intel-strictness')) {
      for (const input of group.querySelectorAll('input[type="radio"]')) input.checked = input.value === gate.strictness;
    }
    const sHint = STRICTNESS_OPTIONS.find((o) => o.value === (pending.get('intel-strictness') || gate.strictness));
    $('strictness-hint').textContent = sHint ? sHint.hint : '';
    setControl($('gate-unsure'), gate.whenUnsure);
    const esc = intel.escalation || {};
    setControl($('budget-minute'), esc.perMinute);
    setControl($('budget-day'), esc.perDay);
    const floor = esc.floor || {};
    const cal = model.calibration[(intel.system1 && intel.system1.model) || ''] || {};
    setControl($('floor-match'), Number.isFinite(floor.matches_prompt) ? floor.matches_prompt : '');
    setControl($('floor-tag'), Number.isFinite(floor.primary_tag) ? floor.primary_tag : '');
    $('floor-match').placeholder = Number.isFinite(cal.matches_prompt) ? `default ${cal.matches_prompt}` : 'default';
    $('floor-tag').placeholder = Number.isFinite(cal.primary_tag) ? `default ${cal.primary_tag}` : 'default';
  }

  /** @param {any} secrets  describeSecrets() result */
  function setSecrets(secrets) {
    if (secrets && typeof secrets === 'object') {
      const clean = {};
      for (const id of Object.keys(CLOUD_PROVIDERS)) {
        const s = secrets[id];
        if (s && typeof s.set === 'boolean') clean[id] = { set: s.set, last4: typeof s.last4 === 'string' ? s.last4.slice(-4) : null };
      }
      model.secrets = clean;
    }
    render();
  }

  /**
   * @param {{ configuration?: any, engineStatus?: any, diagnostics?: any }} input
   */
  function update({ configuration, engineStatus, diagnostics } = {}) {
    if (configuration !== undefined) {
      const prevModel = model.intelligence.system1 && model.intelligence.system1.model;
      model.intelligence = resolveIntelligence(configuration || {});
      const nextModel = model.intelligence.system1 && model.intelligence.system1.model;
      if (nextModel && nextModel !== prevModel) loadFloors(nextModel);
    }
    if (engineStatus !== undefined) {
      model.engineStatus = engineStatus;
      if (engineStatus && engineStatus.refine) model.refine = null;
      if (engineStatus && engineStatus.system1 && engineStatus.system1.state) model.s1Override = null;
    }
    if (diagnostics !== undefined) {
      model.diagnostics = diagnostics;
      if (diagnostics && diagnostics.secrets) {
        setSecrets(diagnostics.secrets);
        return;
      }
    }
    render();
  }

  render();
  probeNano();
  loadFloors((model.intelligence.system1 && model.intelligence.system1.model) || '');

  return { update, setSecrets, render, root };
}
