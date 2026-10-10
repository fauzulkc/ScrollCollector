/**
 * OpenAI escalation provider (opt-in cloud). Also works with OpenAI-compatible servers through a
 * configurable baseUrl/model (OpenRouter, Ollama, the e2e mock server).
 *
 * Chat Completions (default, providers.openai.api === 'chat'):
 *   POST <baseUrl>/chat/completions
 *   { model, max_completion_tokens: 400, reasoning_effort (unless 'default'),
 *     messages: [system: DECISION_SYSTEM_PROMPT, user: rendered questions + <post>…</post>],
 *     response_format: { type: 'json_schema', json_schema: { name: 'sc_decisions', strict: true, schema } } }
 * Responses API (providers.openai.api === 'responses'):
 *   POST <baseUrl>/responses { model, max_output_tokens, instructions, input, reasoning: { effort },
 *     text: { format: { type: 'json_schema', name, strict: true, schema } } }
 *
 * Structured Outputs emulate Jev's primitives (lib/decision/providers/schema-builder.js): noul ->
 * { probability }, choice -> { choice: enum incl. 'none', confidence }. A noul maps to
 * noulAnswer(probability); a choice gets probabilities { choice: c, others: (1 - c) / (n - 1) } with
 * c = the self-reported confidence shrunk x0.9.
 *
 * A 400/422 that names response_format / json_schema / text.format, reasoning_effort / reasoning,
 * or max_completion_tokens / max_output_tokens is retried once without the offending feature
 * (json_object + tolerant JSON parsing instead of the schema); what a base URL + model rejected is
 * remembered so later calls do not fail first.
 *
 * Status and circuit breaker as for Jev (lib/decision/http.js createCloudCore). costUsd is
 * estimated from usage when the model's pricing is known (gpt-6-luna: $0.10 in / $0.50 out per
 * million tokens), else omitted.
 */
import { fetchJson, createCloudCore, providerError, joinUrl, DecisionHttpError } from '../http.js';
import {
  DECISION_SYSTEM_PROMPT,
  SCHEMA_NAME,
  buildQuestionPlan,
  renderUserPrompt,
  mapLlmAnswers,
  parseModelJson
} from './schema-builder.js';

export const OPENAI_ID = 'openai';
export const OPENAI_LABEL = 'OpenAI';
export const OPENAI_MAX_CONCURRENCY = 4;
export const OPENAI_MAX_OUTPUT_TOKENS = 400;
/** USD per million tokens. Models not listed get no cost estimate. */
export const OPENAI_PRICING = Object.freeze({
  'gpt-6-luna': Object.freeze({ input: 0.1, output: 0.5 })
});

/** Fixed synthetic post used by testConnection(): never user data. */
export const OPENAI_TEST_STATE = Object.freeze({ platform: 'example.com', text: 'Our neighbourhood bakery now sells sourdough croissants on weekends.' });
export const OPENAI_TEST_QUESTIONS = Object.freeze({
  connection_test: Object.freeze({
    type: 'noul',
    instructions: 'Is this post about food?',
    criteria: Object.freeze({ true: 'The post is mainly about food.', false: 'The post is mainly about another subject.' })
  })
});

const SCHEMA_ERROR_RE = /response_format|json_schema|text\.format|structured output|\bstrict\b/i;
const REASONING_ERROR_RE = /reasoning/i;
const MAX_TOKENS_ERROR_RE = /max_completion_tokens|max_output_tokens/i;

/**
 * @typedef {object} Compat
 * @property {boolean} noSchema       use json_object instead of the strict json_schema
 * @property {boolean} noReasoning    omit reasoning_effort / reasoning
 * @property {boolean} legacyTokens   max_tokens instead of max_completion_tokens (responses: omit)
 */

/**
 * Cost estimate in USD for a model with known pricing (exact id or a dated snapshot of it).
 * @param {string} model
 * @param {number|undefined} inputTokens
 * @param {number|undefined} outputTokens
 * @returns {number|undefined}
 */
export function estimateOpenAICost(model, inputTokens, outputTokens) {
  const id = String(model || '').toLowerCase();
  const key = Object.keys(OPENAI_PRICING).find((m) => id === m || id.startsWith(`${m}-`));
  if (!key) return undefined;
  const price = OPENAI_PRICING[/** @type {keyof typeof OPENAI_PRICING} */ (key)];
  const i = Number.isFinite(inputTokens) ? /** @type {number} */ (inputTokens) : 0;
  const o = Number.isFinite(outputTokens) ? /** @type {number} */ (outputTokens) : 0;
  return (i * price.input + o * price.output) / 1e6;
}

/**
 * @param {Record<string, any>} settings
 * @param {Compat} compat
 */
function reasoningEffort(settings, compat) {
  const effort = settings.reasoningEffort;
  return !compat.noReasoning && typeof effort === 'string' && effort && effort !== 'default' ? effort : null;
}

/**
 * Chat Completions body.
 * @param {{ settings: Record<string, any>, system: string, user: string, schema: object|null, compat: Compat, maxTokens?: number }} p
 */
export function buildChatBody({ settings, system, user, schema, compat, maxTokens = OPENAI_MAX_OUTPUT_TOKENS }) {
  /** @type {Record<string, any>} */
  const body = { model: settings.model };
  if (compat.legacyTokens) body.max_tokens = maxTokens;
  else body.max_completion_tokens = maxTokens;
  const effort = reasoningEffort(settings, compat);
  if (effort) body.reasoning_effort = effort;
  body.messages = [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
  body.response_format = schema && !compat.noSchema
    ? { type: 'json_schema', json_schema: { name: SCHEMA_NAME, strict: true, schema } }
    : { type: 'json_object' };
  return body;
}

/**
 * Responses API body.
 * @param {{ settings: Record<string, any>, system: string, user: string, schema: object|null, compat: Compat, maxTokens?: number }} p
 */
export function buildResponsesBody({ settings, system, user, schema, compat, maxTokens = OPENAI_MAX_OUTPUT_TOKENS }) {
  /** @type {Record<string, any>} */
  const body = { model: settings.model };
  if (!compat.legacyTokens) body.max_output_tokens = maxTokens;
  const effort = reasoningEffort(settings, compat);
  if (effort) body.reasoning = { effort };
  body.instructions = system;
  body.input = [{ role: 'user', content: user }];
  body.text = {
    format: schema && !compat.noSchema
      ? { type: 'json_schema', name: SCHEMA_NAME, strict: true, schema }
      : { type: 'json_object' }
  };
  return body;
}

/**
 * Reply text, refusal and usage from a Chat Completions or Responses API result.
 * @param {any} data
 * @param {'chat'|'responses'} api
 * @returns {{ text: string, refusal: string|null, inputTokens?: number, outputTokens?: number }}
 */
export function readOpenAIReply(data, api) {
  let text = '';
  let refusal = null;
  if (api === 'responses') {
    if (typeof data?.output_text === 'string') text = data.output_text;
    for (const item of Array.isArray(data?.output) ? data.output : []) {
      for (const part of Array.isArray(item?.content) ? item.content : []) {
        if (part?.type === 'output_text' && typeof part.text === 'string' && !text) text = part.text;
        if (part?.type === 'refusal' && typeof part.refusal === 'string') refusal = part.refusal;
      }
    }
  } else {
    const msg = data?.choices?.[0]?.message;
    if (typeof msg?.content === 'string') text = msg.content;
    else if (Array.isArray(msg?.content)) text = msg.content.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('');
    if (typeof msg?.refusal === 'string' && msg.refusal) refusal = msg.refusal;
  }
  const u = data?.usage || {};
  const inputTokens = Number(u.input_tokens ?? u.prompt_tokens);
  const outputTokens = Number(u.output_tokens ?? u.completion_tokens);
  return {
    text,
    refusal,
    ...(Number.isFinite(inputTokens) ? { inputTokens } : {}),
    ...(Number.isFinite(outputTokens) ? { outputTokens } : {})
  };
}

/**
 * The compatibility fallback a 400/422 asks for, or null when the error is about something else
 * (or that fallback is already in use).
 * @param {unknown} err
 * @param {Compat} compat
 * @param {boolean} usedSchema
 * @returns {Partial<Compat>|null}
 */
export function fallbackFor(err, compat, usedSchema) {
  const e = /** @type {any} */ (err);
  if (!(e instanceof DecisionHttpError) || e.code !== 'bad_request') return null;
  const text = `${e.message || ''} ${e.body || ''}`;
  /** @type {Partial<Compat>} */
  const next = {};
  if (usedSchema && !compat.noSchema && SCHEMA_ERROR_RE.test(text)) next.noSchema = true;
  if (!compat.noReasoning && REASONING_ERROR_RE.test(text)) next.noReasoning = true;
  if (!compat.legacyTokens && MAX_TOKENS_ERROR_RE.test(text)) next.legacyTokens = true;
  return Object.keys(next).length ? next : null;
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
export function createOpenAIProvider({ getSecret, getConfig, fetchImpl, now = Date.now, cooldownMs = 60000, http = {} } = {}) {
  const core = createCloudCore({ id: OPENAI_ID, label: OPENAI_LABEL, getSecret, getConfig, now, cooldownMs });
  /** @type {Map<string, Compat>} what each `api|baseUrl|model` rejected */
  const compatByTarget = new Map();

  /** @param {Record<string, any>} settings */
  function apiOf(settings) {
    return settings.api === 'responses' ? 'responses' : 'chat';
  }

  /** @param {Record<string, any>} settings */
  function compatFor(settings) {
    const target = `${apiOf(settings)}|${settings.baseUrl}|${settings.model}`;
    let compat = compatByTarget.get(target);
    if (!compat) {
      compat = { noSchema: false, noReasoning: false, legacyTokens: false };
      compatByTarget.set(target, compat);
    }
    return compat;
  }

  /**
   * One model call with the schema fallback. Returns the parsed JSON object and usage.
   * @param {{ key: string, settings: Record<string, any>, system: string, user: string, schema: object|null, signal?: AbortSignal, retries?: number }} p
   */
  async function call({ key, settings, system, user, schema, signal, retries }) {
    const api = apiOf(settings);
    const compat = compatFor(settings);
    const url = joinUrl(settings.baseUrl, api === 'responses' ? 'responses' : 'chat/completions');
    const build = api === 'responses' ? buildResponsesBody : buildChatBody;
    const request = (c) =>
      fetchJson(url, {
        timeoutMs: Number.isFinite(settings.timeoutMs) ? settings.timeoutMs : 15000,
        now,
        ...http, // retry/sleep tuning (tests); never the fields below
        method: 'POST',
        headers: { authorization: `Bearer ${key}` },
        body: build({ settings, system, user, schema, compat: c }),
        fetchImpl: fetchImpl || globalThis.fetch,
        signal,
        redactValues: [key],
        ...(retries !== undefined ? { retries } : {})
      });

    let res;
    try {
      res = await request(compat);
    } catch (err) {
      const fix = fallbackFor(err, compat, !!schema);
      if (!fix) throw err;
      Object.assign(compat, fix); // remembered for this api|baseUrl|model
      res = await request(compat);
    }
    const reply = readOpenAIReply(res.data, api);
    if (reply.refusal) throw providerError('refused', `${OPENAI_LABEL} refused to answer: ${reply.refusal}`, [key]);
    const parsed = parseModelJson(reply.text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw providerError('bad_response', `${OPENAI_LABEL} returned a reply that is not a JSON object.`, [key]);
    }
    const model = typeof res.data?.model === 'string' && res.data.model ? res.data.model : settings.model;
    const costUsd = estimateOpenAICost(settings.model, reply.inputTokens, reply.outputTokens);
    return {
      parsed,
      model,
      usage: {
        ...(reply.inputTokens !== undefined ? { input_tokens: reply.inputTokens } : {}),
        ...(reply.outputTokens !== undefined ? { output_tokens: reply.outputTokens } : {}),
        ...(costUsd !== undefined ? { costUsd } : {})
      }
    };
  }

  /** @type {import('../types.js').DecisionProvider['decide']} */
  async function decide({ state, questions, signal } = /** @type {any} */ ({})) {
    const { key, settings } = await core.load();
    // Refusals (no key, switched off, circuit open) are not calls: thrown without touching the stats.
    core.guard(key);
    const plan = buildQuestionPlan(questions);
    if (!plan.entries.length) throw providerError('bad_request', `No question ${OPENAI_LABEL} can answer.`);
    const user = renderUserPrompt({ state, plan });
    const started = now();
    try {
      const r = await call({ key: /** @type {string} */ (key), settings, system: DECISION_SYSTEM_PROMPT, user, schema: plan.schema, signal });
      const answers = mapLlmAnswers(r.parsed, plan, OPENAI_ID);
      if (!Object.keys(answers).length) throw providerError('bad_response', `${OPENAI_LABEL} returned no usable answers.`);
      const latencyMs = Math.max(0, now() - started);
      core.succeeded(latencyMs, { costUsd: r.usage.costUsd });
      return { answers, provider: OPENAI_ID, model: r.model, latencyMs, usage: r.usage };
    } catch (err) {
      throw core.failed(err);
    }
  }

  /**
   * JSON generation for the configuration helpers (tag wand, prompt tags/expansion) when the user
   * enabled OpenAI. Uses json_object mode (the helper prompts ask for JSON). Never sees posts.
   * @param {string} system
   * @param {string} user
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {Promise<any>}
   */
  async function generateJson(system, user, { signal } = {}) {
    const { key, settings } = await core.load();
    core.guard(key);
    const started = now();
    try {
      const r = await call({ key: /** @type {string} */ (key), settings, system, user, schema: null, signal });
      core.succeeded(Math.max(0, now() - started), { costUsd: r.usage.costUsd });
      return r.parsed;
    } catch (err) {
      throw core.failed(err);
    }
  }

  /**
   * TEST_PROVIDER: one tiny fixed synthetic post (never user data), allowed while switched off and
   * while the circuit is open; a success closes the circuit.
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {Promise<{ ok: boolean, latencyMs: number, model: string, error?: string, code?: string }>}
   */
  async function testConnection({ signal } = {}) {
    const { key, settings } = await core.load();
    const model = String(settings.model || '');
    if (!key) return { ok: false, latencyMs: 0, model, error: `No ${OPENAI_LABEL} API key is set.`, code: 'no_key' };
    const plan = buildQuestionPlan(/** @type {any} */ (OPENAI_TEST_QUESTIONS));
    const started = now();
    try {
      const r = await call({
        key,
        settings,
        system: DECISION_SYSTEM_PROMPT,
        user: renderUserPrompt({ state: { ...OPENAI_TEST_STATE }, plan }),
        schema: plan.schema,
        signal,
        retries: 0
      });
      if (!mapLlmAnswers(r.parsed, plan, OPENAI_ID).connection_test) {
        throw providerError('bad_response', `${OPENAI_LABEL} answered in an unexpected format.`);
      }
      core.resetCircuit();
      return { ok: true, latencyMs: Math.max(0, now() - started), model: r.model };
    } catch (err) {
      const e = core.failed(err);
      return { ok: false, latencyMs: Math.max(0, now() - started), model, error: e.message, code: e.code };
    }
  }

  return {
    id: OPENAI_ID,
    displayName: OPENAI_LABEL,
    isCloud: true,
    maxConcurrency: OPENAI_MAX_CONCURRENCY,
    async isReady() {
      await core.load();
      const { state } = core.status();
      return state === 'ready' || state === 'offline';
    },
    status: () => core.status(),
    async refresh() {
      await core.load();
      return core.status();
    },
    decide,
    generateJson,
    testConnection,
    stats: () => ({ model: core.settings.model, ...core.stats() }),
    resetStats: () => core.resetStats()
  };
}
