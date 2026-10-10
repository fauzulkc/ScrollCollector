/**
 * API keys for the opt-in cloud decision providers (TypeSafe Jev, OpenAI).
 *
 * Keys live under the top-level `secrets` key of chrome.storage.local (lib/messages.js
 * SECRETS_KEY), which the service worker restricts to trusted contexts and never broadcasts,
 * exports or logs. Callers pass the storage area so these helpers stay testable.
 * Errors thrown here never contain the key value.
 */
import { SECRETS_KEY } from '../messages.js';

export const SECRET_PROVIDERS = Object.freeze(['jev', 'openai']);
const MAX_SECRET_CHARS = 512;
/** Shorter keys show no suffix at all. */
const MIN_CHARS_FOR_LAST4 = 12;
/** Known secrets shorter than this are not redacted (they would match ordinary text). */
const MIN_REDACT_CHARS = 6;
const REDACTED = '[REDACTED]';

/**
 * @typedef {object} StorageAreaLike
 * @property {(keys: string|string[]|null) => Promise<Record<string, any>>} get
 * @property {(items: Record<string, any>) => Promise<void>} set
 */

/**
 * @param {string} message
 * @param {string} code
 */
function secretError(message, code) {
  return Object.assign(new Error(message), { code });
}

/** @param {unknown} provider */
function assertProvider(provider) {
  if (!SECRET_PROVIDERS.includes(/** @type {string} */ (provider))) {
    throw secretError(`Unknown secret provider: ${String(provider).slice(0, 20)}`, 'bad_request');
  }
}

/**
 * @param {StorageAreaLike} area
 * @returns {Promise<Record<string, string>>}
 */
async function readAll(area) {
  const got = await area.get(SECRETS_KEY);
  const value = got?.[SECRETS_KEY];
  /** @type {Record<string, string>} */
  const out = {};
  if (value && typeof value === 'object') {
    for (const p of SECRET_PROVIDERS) if (typeof value[p] === 'string' && value[p]) out[p] = value[p];
  }
  return out;
}

/**
 * @param {Record<string, string>} all
 * @returns {Record<string, { set: boolean, last4: string|null }>}
 */
function describeFrom(all) {
  /** @type {Record<string, { set: boolean, last4: string|null }>} */
  const out = {};
  for (const p of SECRET_PROVIDERS) {
    const v = all[p];
    out[p] = { set: !!v, last4: v && v.length >= MIN_CHARS_FOR_LAST4 ? v.slice(-4) : null };
  }
  return out;
}

/**
 * @param {StorageAreaLike} area
 * @param {'jev'|'openai'} provider
 * @param {string} value
 * @returns {Promise<Record<string, { set: boolean, last4: string|null }>>} describeSecrets() after the write
 */
export async function setSecret(area, provider, value) {
  assertProvider(provider);
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) throw secretError('The key is empty.', 'bad_request');
  if (v.length > MAX_SECRET_CHARS || /\s/.test(v)) throw secretError('The key has an invalid format.', 'bad_request');
  const all = await readAll(area);
  all[provider] = v;
  await area.set({ [SECRETS_KEY]: all });
  return describeFrom(all);
}

/**
 * @param {StorageAreaLike} area
 * @param {'jev'|'openai'} provider
 * @returns {Promise<string|null>}
 */
export async function getSecret(area, provider) {
  assertProvider(provider);
  const all = await readAll(area);
  return all[provider] || null;
}

/**
 * @param {StorageAreaLike} area
 * @param {'jev'|'openai'} provider
 * @returns {Promise<Record<string, { set: boolean, last4: string|null }>>}
 */
export async function clearSecret(area, provider) {
  assertProvider(provider);
  const all = await readAll(area);
  delete all[provider];
  await area.set({ [SECRETS_KEY]: all });
  return describeFrom(all);
}

/**
 * Safe summary for the UI: whether each key is set and its last 4 chars (long keys only).
 * @param {StorageAreaLike} area
 * @returns {Promise<{ jev: { set: boolean, last4: string|null }, openai: { set: boolean, last4: string|null } }>}
 */
export async function describeSecrets(area) {
  return /** @type {any} */ (describeFrom(await readAll(area)));
}

/**
 * All stored key values, for redact().
 * @param {StorageAreaLike} area
 * @returns {Promise<string[]>}
 */
export async function listSecretValues(area) {
  return Object.values(await readAll(area));
}

/**
 * Removes secrets from a string (error messages, diagnostics, logs): every known secret value,
 * OpenAI-style `sk-…` keys, `Bearer <token>` and `api_key=…`-style assignments.
 *
 * @param {unknown} input
 * @param {string[]|string} [knownSecrets]
 * @returns {string}
 */
export function redact(input, knownSecrets = []) {
  if (input === undefined || input === null) return '';
  let out = typeof input === 'string' ? input : String(input);
  const secrets = (Array.isArray(knownSecrets) ? knownSecrets : [knownSecrets])
    .filter((s) => typeof s === 'string' && s.length >= MIN_REDACT_CHARS)
    .sort((a, b) => b.length - a.length);
  for (const s of secrets) out = out.split(s).join(REDACTED);
  out = out.replace(/\bBearer\s+(?!\[REDACTED\])[^\s"',;]+/gi, `Bearer ${REDACTED}`);
  out = out.replace(/\bsk-[\w-]{8,}/g, REDACTED);
  out = out.replace(/\b((?:x-)?api[_-]?key["']?\s*[:=]\s*["']?)(?!\[REDACTED\])[^\s"',;&]{8,}/gi, `$1${REDACTED}`);
  return out;
}
