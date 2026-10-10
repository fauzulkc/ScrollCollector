/**
 * Storage schema v2: defaults for configuration.intelligence, a deep-merge helper and the
 * whitelist validator used by UPDATE_INTELLIGENCE_SETTINGS.
 *
 * API keys never live here: they are stored under the top-level `secrets` key
 * (lib/storage/secrets.js), which is never broadcast, exported or logged.
 */
import { MODEL_REGISTRY } from '../decision/models.js';

export const SCHEMA_VERSION = 2;

/**
 * Defaults for configuration.intelligence.
 *  - Only the browser's built-in LanguageModel (Gemini Nano in Chrome) runs on-device as an LLM;
 *    no generative model is ever downloaded by the extension.
 *  - Cloud providers are opt-in per provider (enabled:false) and only see posts System 1 is
 *    uncertain about.
 *  - escalation.floor has no default on purpose: unset floors come from the System 1 calibration
 *    (lib/decision/calibration/<model>.q8.json `floor`, the floors the offline eval measured);
 *    a floor set here by the user overrides it.
 *
 * Stored configuration.intelligence holds only the user's explicit choices; readers merge these
 * defaults in with resolveIntelligence(), so changing a default reaches every user.
 */
export const DEFAULT_INTELLIGENCE = deepFreeze({
  system1: { enabled: true, model: 'minilm', device: 'wasm', dtype: 'q8', waitForReadyMs: 180000 },
  escalation: {
    provider: 'nano',
    perMinute: 30,
    perDay: 1000,
    sendAuthor: false,
    allowRedecideEscalation: false
  },
  providers: {
    nano: { enabled: true },
    jev: { enabled: false, baseUrl: 'https://api.typesafe.ai', model: 'jev-latest', timeoutMs: 8000 },
    openai: {
      enabled: false,
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-6-luna',
      api: 'chat',
      reasoningEffort: 'none',
      timeoutMs: 15000
    }
  },
  gate: { strictness: 'balanced', whenUnsure: 'collect' },
  // Idle refinement of stored posts (lib/pipeline/refine.js): second bundled embedding model,
  // then the browser built-in model (nano) for what stays uncertain. Never a cloud provider.
  refine: { enabled: true, idleSeconds: 60, nano: true },
  dynamicTags: false,
  debugAnnotate: false
});

export const ESCALATION_PROVIDERS = Object.freeze(['none', 'nano', 'jev', 'openai']);

/**
 * @template T
 * @param {T} obj
 * @returns {T}
 */
function deepFreeze(obj) {
  for (const v of Object.values(obj)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(obj);
}

/** @param {unknown} v @returns {v is Record<string, any>} */
export function isPlainObject(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep copy of plain objects/arrays (JSON-like data).
 * @template T
 * @param {T} v
 * @returns {T}
 */
export function cloneData(v) {
  if (Array.isArray(v)) return /** @type {any} */ (v.map(cloneData));
  if (isPlainObject(v)) {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = cloneData(val);
    return /** @type {any} */ (out);
  }
  return v;
}

/**
 * Returns a new object: `base` deep-cloned with `patch` applied on top. Plain objects merge
 * recursively; arrays and primitives in `patch` replace; `undefined` in `patch` is skipped.
 * Neither input is mutated.
 *
 * @param {object} base
 * @param {object} [patch]
 * @returns {object}
 */
export function deepMerge(base, patch) {
  const out = isPlainObject(base) ? cloneData(base) : {};
  if (!isPlainObject(patch)) return out;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : cloneData(v);
  }
  return out;
}

/** @returns {typeof DEFAULT_INTELLIGENCE} */
export function defaultIntelligence() {
  return cloneData(DEFAULT_INTELLIGENCE);
}

/**
 * configuration.intelligence with defaults filled in (user values win).
 * @param {{ intelligence?: object }|null|undefined} configuration
 */
export function resolveIntelligence(configuration) {
  return /** @type {typeof DEFAULT_INTELLIGENCE} */ (deepMerge(DEFAULT_INTELLIGENCE, configuration?.intelligence));
}

// ---------------------------------------------------------------------------
// Patch validation (whitelist)
// ---------------------------------------------------------------------------

const bool = { kind: 'boolean' };
/** @param {readonly string[]} values */
const oneOf = (values) => ({ kind: 'enum', values });
/** @param {number} min @param {number} max */
const int = (min, max) => ({ kind: 'int', min, max });
/** @param {number} min @param {number} max */
const num = (min, max) => ({ kind: 'number', min, max });
/**
 * A leaf that also accepts null: "remove my explicit value" (the default applies again).
 * @param {object} rule
 */
const nullable = (rule) => ({ ...rule, nullable: true });
const url = { kind: 'url' };
/** @param {number} max */
const str = (max) => ({ kind: 'string', max });

const INTELLIGENCE_RULES = {
  system1: {
    enabled: bool,
    model: oneOf(Object.keys(MODEL_REGISTRY)),
    device: oneOf(['wasm', 'webgpu']),
    dtype: oneOf(['q8']),
    waitForReadyMs: int(0, 600000)
  },
  escalation: {
    provider: oneOf(ESCALATION_PROVIDERS),
    // null clears the user's floor: the System 1 calibration's floor applies again.
    floor: { matches_prompt: nullable(num(0, 1)), primary_tag: nullable(num(0, 1)) },
    perMinute: int(0, 600),
    perDay: int(0, 100000),
    sendAuthor: bool,
    allowRedecideEscalation: bool
  },
  providers: {
    nano: { enabled: bool },
    jev: { enabled: bool, baseUrl: url, model: str(100), timeoutMs: int(1000, 120000) },
    openai: {
      enabled: bool,
      baseUrl: url,
      model: str(100),
      api: oneOf(['chat', 'responses']),
      reasoningEffort: oneOf(['none', 'minimal', 'low', 'medium', 'high']),
      timeoutMs: int(1000, 120000)
    }
  },
  gate: { strictness: oneOf(['strict', 'balanced', 'lenient']), whenUnsure: oneOf(['collect', 'skip']) },
  refine: { enabled: bool, idleSeconds: int(15, 3600), nano: bool },
  dynamicTags: bool,
  debugAnnotate: bool
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * https URLs, or http only for a local server (mock server, Ollama). Returns the URL without a
 * trailing slash, or null.
 * @param {unknown} v
 */
function normalizeBaseUrl(v) {
  if (typeof v !== 'string' || v.length > 300) return null;
  let u;
  try {
    u = new URL(v.trim());
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  const local = LOCAL_HOSTS.has(u.hostname) || u.hostname.endsWith('.localhost');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/**
 * @param {any} rule
 * @param {unknown} value
 * @returns {{ ok: true, value: unknown } | { ok: false, error: string }}
 */
function checkLeaf(rule, value) {
  switch (rule.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true, value } : { ok: false, error: 'expected a boolean' };
    case 'enum':
      return rule.values.includes(value) ? { ok: true, value } : { ok: false, error: `expected one of ${rule.values.join(', ')}` };
    case 'int':
      return Number.isInteger(value) && value >= rule.min && value <= rule.max
        ? { ok: true, value }
        : { ok: false, error: `expected an integer in [${rule.min}, ${rule.max}]` };
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) && value >= rule.min && value <= rule.max
        ? { ok: true, value }
        : { ok: false, error: `expected a number in [${rule.min}, ${rule.max}]` };
    case 'url': {
      const normalized = normalizeBaseUrl(value);
      return normalized ? { ok: true, value: normalized } : { ok: false, error: 'expected an https URL (http only for localhost)' };
    }
    case 'string': {
      const s = typeof value === 'string' ? value.trim() : '';
      // eslint-disable-next-line no-control-regex
      return s && s.length <= rule.max && !/[\u0000-\u001f\u007f]/.test(s)
        ? { ok: true, value: s }
        : { ok: false, error: `expected a non-empty string of at most ${rule.max} chars` };
    }
    default:
      return { ok: false, error: 'unsupported' };
  }
}

/**
 * @param {Record<string, any>} rules
 * @param {unknown} patch
 * @param {string} path
 * @param {string[]} errors
 * @returns {Record<string, unknown>}
 */
function validateGroup(rules, patch, path, errors) {
  const out = {};
  if (!isPlainObject(patch)) {
    errors.push(`${path || 'patch'}: expected an object`);
    return out;
  }
  for (const [key, value] of Object.entries(patch)) {
    const at = path ? `${path}.${key}` : key;
    if (!Object.prototype.hasOwnProperty.call(rules, key)) {
      errors.push(`${at}: unknown key`);
      continue;
    }
    if (value === undefined) continue;
    const rule = rules[key];
    if (value === null && rule.nullable === true) {
      out[key] = null;
      continue;
    }
    if (typeof rule.kind === 'string') {
      const res = checkLeaf(rule, value);
      if (res.ok) out[key] = res.value;
      else errors.push(`${at}: ${res.error}`);
    } else {
      const sub = validateGroup(rule, value, at, errors);
      if (Object.keys(sub).length) out[key] = sub;
    }
  }
  return out;
}

/**
 * Copy of `obj` without null leaves, and without objects left empty by that (null in a validated
 * patch means "delete my explicit value").
 *
 * @param {Record<string, any>} obj
 * @returns {Record<string, any>}
 */
export function pruneNulls(obj) {
  const out = {};
  if (!isPlainObject(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (isPlainObject(v)) {
      const sub = pruneNulls(v);
      if (Object.keys(sub).length) out[k] = sub;
    } else {
      out[k] = cloneData(v);
    }
  }
  return out;
}

/**
 * Whitelists a configuration.intelligence patch. Unknown keys (including anything that looks like
 * an API key) and wrongly typed values are dropped and reported. Leaves marked nullable
 * (escalation.floor.*) accept null, which deletes the explicit value (see pruneNulls).
 *
 * @param {unknown} patch
 * @returns {{ ok: boolean, patch: Record<string, unknown>, errors: string[] }}
 */
export function validateIntelligencePatch(patch) {
  /** @type {string[]} */
  const errors = [];
  const clean = validateGroup(INTELLIGENCE_RULES, patch, '', errors);
  return { ok: errors.length === 0, patch: clean, errors };
}
