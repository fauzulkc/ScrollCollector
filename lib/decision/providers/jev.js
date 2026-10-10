/**
 * TypeSafe Jev escalation provider (opt-in cloud; https://docs.typesafe.ai).
 *
 * One POST <baseUrl>/v1/systemone per uncertain post:
 *   { model, state: { platform, post, author? }, questions }   Authorization: Bearer <key>
 * Our questions are Jev's own primitives, so they map 1:1 (noul -> {type, instructions, criteria?},
 * choice -> {type, instructions, criteria}) under safe JSON keys ('tag:Tech/AI' -> 'tag_Tech_AI',
 * mapped back on the way in); the options of a choice are rotated by a seed from
 * state.textHash ('none' stays last) to counter first-option bias. Answers come back as
 * { noul } / { choice, probabilities, confidence } and are mapped to typed answers ('none' ->
 * null). usage.input_tokens gives the cost estimate ($0.042 per million input tokens).
 *
 * The cascade only calls decide() for posts System 1 was unsure about and only when the user turned
 * the provider on; decide() refuses as well when providers.jev.enabled !== true, so no post leaves
 * the device by accident. The author is sent only when the cascade passes one (escalation.sendAuthor).
 *
 * Status / circuit breaker (lib/decision/http.js createCloudCore): no_key, disabled, auth_error
 * (no calls until the key changes), rate_limited (60 s cooldown after a 429/503/529 that survived
 * the retries), offline. The key is never logged, broadcast or put in an error message.
 */
import { fetchJson, createCloudCore, providerError, joinUrl } from '../http.js';
import { rotationOffset, NONE_OPTION } from '../questions.js';
import { noulAnswer } from '../types.js';
import { clamp01, choiceConfidence, normalizeDistribution, argmax } from '../confidence.js';
import { choiceOptions, matchOption, readProbability, questionKeyMap } from './schema-builder.js';

export const JEV_ID = 'jev';
export const JEV_LABEL = 'TypeSafe Jev';
/** $0.042 per million input tokens. */
export const JEV_USD_PER_INPUT_TOKEN = 0.042e-6;
export const JEV_MAX_CONCURRENCY = 4;
/** Jev's limits on choice options and on criteria text. */
const MAX_OPTIONS = 255;
const MAX_CRITERION_CHARS = 255;
const MAX_INSTRUCTION_CHARS = 2000;

/** Fixed synthetic request used by testConnection(): never user data. */
export const JEV_TEST_STATE = Object.freeze({ platform: 'example.com', post: 'Our neighbourhood bakery now sells sourdough croissants on weekends.' });
export const JEV_TEST_QUESTIONS = Object.freeze({
  connection_test: Object.freeze({
    type: 'noul',
    instructions: 'Is this post about food?',
    criteria: Object.freeze({ true: 'The post is mainly about food.', false: 'The post is mainly about another subject.' })
  })
});

/** @param {unknown} s @param {number} max */
function text(s, max) {
  return typeof s === 'string' ? s.slice(0, max) : '';
}

/**
 * Jev endpoint for a base URL ('https://api.typesafe.ai' or one already ending in /v1).
 * @param {string} baseUrl
 */
export function jevEndpoint(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return /\/v1$/i.test(base) ? joinUrl(base, 'systemone') : joinUrl(base, 'v1/systemone');
}

/**
 * Choice options rotated by `seed` (deterministic per post), 'none' last.
 * @param {import('../types.js').Question} question
 * @param {string|number} seed
 * @returns {string[]}
 */
export function rotatedOptions(question, seed) {
  const opts = choiceOptions(question).filter((o) => o !== NONE_OPTION).slice(0, MAX_OPTIONS - 1);
  const offset = rotationOffset(seed, opts.length);
  return [...opts.slice(offset), ...opts.slice(0, offset), NONE_OPTION];
}

/**
 * One of our questions in Jev's request shape.
 * @param {import('../types.js').Question} q
 * @param {string|number} seed
 * @returns {object|null}
 */
export function toJevQuestion(q, seed) {
  const any = /** @type {any} */ (q);
  if (!any || typeof any !== 'object') return null;
  const instructions = text(any.instructions, MAX_INSTRUCTION_CHARS);
  if (any.type === 'noul') {
    const out = { type: 'noul', instructions };
    if (any.criteria && typeof any.criteria === 'object') {
      const criteria = {};
      if (typeof any.criteria.true === 'string') criteria.true = text(any.criteria.true, MAX_CRITERION_CHARS);
      if (typeof any.criteria.false === 'string') criteria.false = text(any.criteria.false, MAX_CRITERION_CHARS);
      if (Object.keys(criteria).length) out.criteria = criteria;
    }
    return out;
  }
  if (any.type === 'choice') {
    /** @type {Record<string, string|null>} */
    const criteria = {};
    for (const o of rotatedOptions(q, seed)) {
      const d = any.criteria?.[o];
      criteria[o] = typeof d === 'string' && d ? text(d, MAX_CRITERION_CHARS) : null;
    }
    return { type: 'choice', instructions, criteria };
  }
  if (any.type === 'score' && Array.isArray(any.criteria)) {
    return { type: 'score', instructions, criteria: any.criteria.map((c) => text(c, MAX_CRITERION_CHARS)) };
  }
  return null;
}

/**
 * The request body for one post. Question ids go out as safe keys ('tag:Tech/AI' ->
 * 'tag_Tech_AI', see questionKeyMap) and mapJevAnswers() maps them back. The seed for option
 * rotation is the post's textHash.
 *
 * @param {import('../types.js').DecisionState|{ text?: string, platform?: string, author?: string, textHash?: string }} state
 * @param {Record<string, import('../types.js').Question>} questions
 * @param {string} model
 */
export function buildJevRequest(state, questions, model) {
  const seed = state?.textHash || String(state?.text || '');
  const keys = questionKeyMap(questions);
  /** @type {Record<string, object>} */
  const qs = {};
  for (const [id, q] of Object.entries(questions || {})) {
    const jq = toJevQuestion(q, seed);
    if (jq) qs[/** @type {string} */ (keys.get(id))] = jq;
  }
  const s = { platform: String(state?.platform || ''), post: String(state?.text || '') };
  if (typeof state?.author === 'string' && state.author.trim()) s.author = state.author.trim();
  return { model, state: s, questions: qs };
}

/**
 * @param {unknown} a
 * @param {import('../types.js').Question} q
 * @returns {import('../types.js').Answer|null}
 */
function mapJevAnswer(a, q) {
  if (a === null || a === undefined) return null;
  const obj = typeof a === 'object' ? /** @type {any} */ (a) : null;
  if (q.type === 'noul') {
    const p = readProbability(obj ? obj.noul ?? obj.probability ?? obj.p : a);
    return p === null ? null : noulAnswer(p, JEV_ID);
  }
  if (q.type === 'choice') {
    const options = choiceOptions(q);
    /** @type {Record<string, number>|null} */
    let probabilities = null;
    if (obj && obj.probabilities && typeof obj.probabilities === 'object') {
      /** @type {Record<string, number>} */
      const weights = {};
      for (const [k, v] of Object.entries(obj.probabilities)) {
        const o = matchOption(k, options);
        if (o && typeof v === 'number' && Number.isFinite(v)) weights[o] = (weights[o] || 0) + Math.max(0, v);
      }
      if (Object.values(weights).some((w) => w > 0)) {
        for (const o of options) if (!(o in weights)) weights[o] = 0;
        probabilities = normalizeDistribution(weights);
      }
    }
    let choice = matchOption(obj ? obj.choice : a, options);
    if (!choice && probabilities) choice = argmax(probabilities);
    if (!choice) return null;
    const reported = obj ? readProbability(obj.confidence) : null;
    if (!probabilities) {
      // Rebuild a distribution from Jev's confidence = (pmax - 1/n) / (1 - 1/n).
      const n = options.length;
      const pmax = n > 1 ? clamp01(reported ?? 1) * (1 - 1 / n) + 1 / n : 1;
      probabilities = { [choice]: pmax };
      for (const o of options) if (o !== choice) probabilities[o] = (1 - pmax) / (n - 1);
    }
    return {
      type: 'choice',
      choice: choice === NONE_OPTION ? null : choice,
      probabilities,
      confidence: reported ?? choiceConfidence(probabilities),
      source: JEV_ID
    };
  }
  if (q.type === 'score' && obj && typeof obj.score === 'number' && Number.isFinite(obj.score)) {
    return {
      type: 'score',
      score: obj.score,
      probabilities: obj.probabilities && typeof obj.probabilities === 'object' ? { ...obj.probabilities } : {},
      confidence: clamp01(Number(obj.confidence) || 0),
      source: JEV_ID
    };
  }
  return null;
}

/**
 * Typed answers from a Jev response ({ answers: { key: {...} } }; `results` / `outputs`
 * accepted), keyed by our question ids again.
 *
 * @param {any} data
 * @param {Record<string, import('../types.js').Question>} questions
 * @returns {Record<string, import('../types.js').Answer>}
 */
export function mapJevAnswers(data, questions) {
  /** @type {Record<string, import('../types.js').Answer>} */
  const out = {};
  const answers = data && typeof data === 'object' ? data.answers ?? data.results ?? data.outputs : null;
  if (!answers || typeof answers !== 'object') return out;
  const keys = questionKeyMap(questions);
  for (const [id, q] of Object.entries(questions || {})) {
    const key = /** @type {string} */ (keys.get(id));
    const a = mapJevAnswer(answers[key] !== undefined ? answers[key] : answers[id], q);
    if (a) out[id] = a;
  }
  return out;
}

/**
 * @param {any} usage
 * @returns {{ input_tokens?: number, output_tokens?: number, costUsd?: number }}
 */
export function jevUsage(usage) {
  const input = Number(usage?.input_tokens);
  const output = Number(usage?.output_tokens);
  /** @type {{ input_tokens?: number, output_tokens?: number, costUsd?: number }} */
  const out = {};
  if (Number.isFinite(input) && input >= 0) {
    out.input_tokens = input;
    out.costUsd = input * JEV_USD_PER_INPUT_TOKEN;
  }
  if (Number.isFinite(output) && output >= 0) out.output_tokens = output;
  return out;
}

/**
 * @param {{
 *   getSecret?: (provider: string) => string|null|Promise<string|null>,
 *   getConfig?: () => unknown,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   cooldownMs?: number,
 *   http?: Partial<import('../http.js').FetchJsonOptions>
 * }} [deps]   getConfig returns the stored `configuration` (or an `intelligence` object)
 * @returns {import('../types.js').DecisionProvider & Record<string, any>}
 */
export function createJevProvider({ getSecret, getConfig, fetchImpl, now = Date.now, cooldownMs = 60000, http = {} } = {}) {
  const core = createCloudCore({ id: JEV_ID, label: JEV_LABEL, getSecret, getConfig, now, cooldownMs });

  /**
   * @param {object} body
   * @param {string} key
   * @param {Record<string, any>} settings
   * @param {{ signal?: AbortSignal, retries?: number }} [opts]
   */
  function post(body, key, settings, { signal, retries } = {}) {
    return fetchJson(jevEndpoint(settings.baseUrl), {
      timeoutMs: Number.isFinite(settings.timeoutMs) ? settings.timeoutMs : 8000,
      now,
      ...http, // retry/sleep tuning (tests); never the fields below
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body,
      fetchImpl: fetchImpl || globalThis.fetch,
      signal,
      redactValues: [key],
      ...(retries !== undefined ? { retries } : {})
    });
  }

  /** @type {import('../types.js').DecisionProvider['decide']} */
  async function decide({ state, questions, signal } = /** @type {any} */ ({})) {
    const { key, settings } = await core.load();
    // Refusals (no key, switched off, circuit open) are not calls: thrown without touching the stats.
    core.guard(key);
    const body = buildJevRequest(state, questions, settings.model);
    if (!Object.keys(body.questions).length) throw providerError('bad_request', 'No question to send to TypeSafe Jev.');
    const started = now();
    try {
      const res = await post(body, /** @type {string} */ (key), settings, { signal });
      const answers = mapJevAnswers(res.data, questions);
      if (!Object.keys(answers).length) throw providerError('bad_response', 'TypeSafe Jev returned no usable answers.');
      const usage = jevUsage(res.data?.usage);
      const latencyMs = Math.max(0, now() - started);
      core.succeeded(latencyMs, { costUsd: usage.costUsd });
      return {
        answers,
        provider: JEV_ID,
        model: typeof res.data?.model === 'string' ? res.data.model : settings.model,
        latencyMs,
        usage
      };
    } catch (err) {
      throw core.failed(err);
    }
  }

  /**
   * TEST_PROVIDER: one tiny fixed synthetic post (never user data). Allowed while the provider is
   * switched off and while the circuit is open, so the user can check a new key; a success closes
   * the circuit.
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {Promise<{ ok: boolean, latencyMs: number, model: string, error?: string, code?: string }>}
   */
  async function testConnection({ signal } = {}) {
    const { key, settings } = await core.load();
    const model = String(settings.model || '');
    if (!key) return { ok: false, latencyMs: 0, model, error: `No ${JEV_LABEL} API key is set.`, code: 'no_key' };
    const started = now();
    try {
      const res = await post(
        { model, state: { ...JEV_TEST_STATE }, questions: JSON.parse(JSON.stringify(JEV_TEST_QUESTIONS)) },
        /** @type {string} */ (key),
        settings,
        { signal, retries: 0 }
      );
      if (!mapJevAnswers(res.data, JEV_TEST_QUESTIONS).connection_test) {
        throw providerError('bad_response', 'TypeSafe Jev answered in an unexpected format.');
      }
      core.resetCircuit();
      return { ok: true, latencyMs: Math.max(0, now() - started), model: typeof res.data?.model === 'string' ? res.data.model : model };
    } catch (err) {
      const e = core.failed(err);
      return { ok: false, latencyMs: Math.max(0, now() - started), model, error: e.message, code: e.code };
    }
  }

  return {
    id: JEV_ID,
    displayName: JEV_LABEL,
    isCloud: true,
    maxConcurrency: JEV_MAX_CONCURRENCY,
    async isReady() {
      await core.load();
      const { state } = core.status();
      return state === 'ready' || state === 'offline';
    },
    status: () => core.status(),
    /** Re-reads the key and settings; returns status(). */
    async refresh() {
      await core.load();
      return core.status();
    },
    decide,
    testConnection,
    stats: () => ({ model: core.settings.model, ...core.stats() }),
    resetStats: () => core.resetStats()
  };
}
