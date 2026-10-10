/**
 * Decision cascade: System 1 -> one primary escalation provider -> rules.
 *
 * Per decideMany() call:
 *  1. cache      : answers cached under `specHash:textHash` are reused (uncertain, non-escalated
 *                  cached answers may still escalate under the current policy)
 *  2. prefilter  : with the gate on, social noise gets matches_prompt = 0.02 and stops here
 *  3. System 1   : ONE batched decideBatch() for every remaining post (waits up to
 *                  policy.waitForReadyMs for the model to become ready)
 *  4. escalation : a question is uncertain when its confidence < policy.floor[id] (for
 *                  matches_prompt: the confidence of the verdict p >= strictness threshold, see
 *                  thresholdConfidence). Uncertain posts go to the ONE primary provider (no
 *                  chaining) only when the provider is not 'none', exists and is ready, cloud
 *                  providers are explicitly enabled, the call is not a re-decide (unless allowed)
 *                  and the budget has room. Escalator answers override System 1; escalator errors
 *                  keep the System 1 answers.
 *                  Every escalator call has a deadline (the provider's own `timeoutMs` plus a
 *                  grace period, else ESCALATION_TIMEOUT_MS / CLOUD_ESCALATION_TIMEOUT_MS): its
 *                  signal aborts and the post keeps System 1's answer with reason 'timeout', even
 *                  if the provider never settles. After a timeout the rest of the call does not
 *                  escalate (a stalled model would otherwise cost one deadline per post), so one
 *                  batch never waits more than about one deadline on an escalator.
 *                  Cloud providers only ever get questions System 1 ANSWERED with low confidence:
 *                  a post System 1 could not answer (down, disabled, timed out) and the idle-retry
 *                  re-checks of stored posts never leave the device (unless re-decide escalation
 *                  is allowed).
 *  5. rules      : fill whatever is still missing
 *  6. finalize   : gate verdict, tag, lens scores, cache write (never for degraded answers), status counters
 *
 * Lenses (lib/decision/lenses.js, ENG-1): the match prompt (`main`) and every enabled tag the user
 * added are scored with the matches_prompt recipe, one `lens:<id>` question each (`main` keeps the
 * matches_prompt question while the gate is on). decision.lenses keeps every score; the gate
 * collects a post when ANY lens reaches the strictness threshold. Lens questions escalate only
 * while the gate is on (at most MAX_ESCALATED_LENSES per post, in the post's one call).
 *
 * The only LLM tier is the browser's built-in LanguageModel ('nano'); cloud providers
 * ('jev', 'openai') are opt-in per provider.
 */
import { Q, noulAnswer } from './types.js';
import { clamp01, choiceConfidence, normalizeDistribution, argmax, thresholdConfidence } from './confidence.js';
import { buildDecisionState, specHash as computeSpecHash } from './state.js';
import {
  buildMatchQuestion,
  buildPrimaryTagQuestion,
  buildTagNouls,
  cleanPrompt,
  selectQuestionTags,
  NONE_OPTION
} from './questions.js';
import { cacheKey } from './cache.js';
import { resolveIntelligence, ESCALATION_PROVIDERS } from '../storage/schema.js';
import {
  STRICTNESS_THRESHOLDS,
  MAX_ESCALATED_LENSES,
  LENS_MAIN_ID,
  scoredLenses,
  lensThreshold,
  isLensGateOn,
  lensQuestionId,
  lensGateVerdict
} from './lenses.js';

// Defined in lenses.js (the side panel imports it from there); kept exported from here.
export { STRICTNESS_THRESHOLDS };
export const CLOUD_PROVIDERS = Object.freeze(['jev', 'openai']);
/** P(match) given to social noise by the prefilter. */
export const PREFILTER_NOISE_P = 0.02;
export const UNCLASSIFIED = 'Unclassified';
/** Bump when the meaning of cached answers changes. */
const SPEC_VERSION = 1;
const MAX_TAGS = 3;
const MAX_ESCALATION_TAG_NOULS = 3;
/** Minimum probability for a tag taken from choice probabilities. */
const MIN_TAG_PROBABILITY = 0.15;
/** Floors used when neither the user nor the System 1 calibration sets one. */
const DEFAULT_FLOOR = 0.5;
const DEFAULT_TAG_FLOOR = 0.35;
const PROVIDER_STATES_AS_REASON = new Set([
  'loading', 'downloadable', 'downloading', 'unavailable', 'no_key', 'auth_error', 'rate_limited', 'offline', 'error', 'disabled'
]);
/** Deadline of one on-device escalator call when the provider declares no `timeoutMs`. */
export const ESCALATION_TIMEOUT_MS = 20000;
/** Same for cloud providers (their HTTP layer bounds each attempt; this covers the retries too). */
export const CLOUD_ESCALATION_TIMEOUT_MS = 120000;
/** Added to a provider's own `timeoutMs`, so its own (more specific) timeout error normally wins. */
const ESCALATION_TIMEOUT_GRACE_MS = 1000;
/** Longest an escalator's isReady() may take before it counts as not ready. */
export const ESCALATOR_READY_TIMEOUT_MS = 5000;
const TIMED_OUT = Symbol('timed_out');

/**
 * Resolves with what `promise` resolves to, or with TIMED_OUT after `ms` (the promise may never
 * settle). Rejections pass through.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T|typeof TIMED_OUT>}
 */
function settleWithin(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, ms));
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/**
 * @typedef {object} CascadePolicy
 * @property {'none'|'nano'|'jev'|'openai'} provider       the ONE primary escalation provider
 * @property {Record<string, number>} floor                   question id -> confidence floor
 * @property {Record<string, { enabled?: boolean }>} providers
 * @property {number} perMinute
 * @property {number} perDay
 * @property {boolean} sendAuthor                             send the author name to cloud providers
 * @property {boolean} allowRedecideEscalation
 * @property {boolean} system1Enabled
 * @property {number} waitForReadyMs
 * @property {string} model
 * @property {string} dtype
 * @property {'strict'|'balanced'|'lenient'} strictness
 * @property {number} threshold                               P(match) needed to collect
 * @property {'collect'|'skip'} whenUnsure
 */

/**
 * System 1 provider (lib/decision/providers/local-system1.js).
 * decideBatch() answers every item in one call; results are matched by `id` (else by index).
 * @typedef {object} System1Provider
 * @property {string} [id]
 * @property {() => boolean|Promise<boolean>} isReady
 * @property {(timeoutMs: number) => Promise<boolean>} [waitUntilReady]
 * @property {string} [calibrationId]                         part of the spec hash when present
 * @property {Partial<Record<string, number>>} [floor]       the calibration's confidence floors
 *                                                            (lib/decision/calibration/<model>.json `floor`),
 *                                                            used for every floor the user has not set
 * @property {(req: {
 *   items: { id: string, text: string }[],
 *   questions: Record<string, import('./types.js').Question>,
 *   specHash: string,
 *   context: { prompt: { raw: string, cleaned: string, expansion: string }, tags: { label: string, description: string|null }[] }
 * }) => Promise<{ results: ({ id: string, answers?: Record<string, import('./types.js').Answer>, ms?: number, error?: string }|null)[] }|any[]>} decideBatch
 */

/** @param {unknown} v @param {number} fallback */
function num(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** @param {number} n */
function round4(n) {
  return Math.round(n * 1e4) / 1e4;
}

/**
 * Escalation policy from configuration.intelligence (defaults filled in).
 *
 * Floors: the user's escalation.floor[id] when set, else the System 1 calibration's floor (the
 * floor the offline eval measured), else DEFAULT_FLOOR / DEFAULT_TAG_FLOOR.
 *
 * @param {object} configuration
 * @param {{ calibratedFloor?: Partial<Record<string, number>>|null }} [extra]
 * @returns {CascadePolicy}
 */
export function resolvePolicy(configuration, { calibratedFloor = null } = {}) {
  const intel = resolveIntelligence(configuration);
  const esc = intel.escalation || {};
  const gate = intel.gate || {};
  const strictness = Object.prototype.hasOwnProperty.call(STRICTNESS_THRESHOLDS, gate.strictness) ? gate.strictness : 'balanced';
  const floorOf = (id, fallback) => num(esc.floor?.[id], num(calibratedFloor?.[id], fallback));
  return {
    provider: ESCALATION_PROVIDERS.includes(esc.provider) ? esc.provider : 'none',
    floor: {
      [Q.MATCHES_PROMPT]: floorOf(Q.MATCHES_PROMPT, DEFAULT_FLOOR),
      [Q.PRIMARY_TAG]: floorOf(Q.PRIMARY_TAG, DEFAULT_TAG_FLOOR)
    },
    providers: intel.providers || {},
    perMinute: num(esc.perMinute, 30),
    perDay: num(esc.perDay, 1000),
    sendAuthor: esc.sendAuthor === true,
    allowRedecideEscalation: esc.allowRedecideEscalation === true,
    system1Enabled: intel.system1?.enabled !== false,
    waitForReadyMs: Math.max(0, num(intel.system1?.waitForReadyMs, 0)),
    model: intel.system1?.model,
    dtype: intel.system1?.dtype,
    strictness,
    // The one "matched" threshold (lib/decision/lenses.js lensThreshold), shared with the side panel.
    threshold: lensThreshold(configuration),
    whenUnsure: gate.whenUnsure === 'skip' ? 'skip' : 'collect'
  };
}

/**
 * @param {object} configuration
 * @param {'ingest'|'redecide'|'retry'} [purpose]
 * @returns {import('./types.js').DecideContext}
 */
export function buildDecideContext(configuration, purpose = 'ingest') {
  const cfg = configuration && typeof configuration === 'object' ? configuration : {};
  return {
    configuration: cfg,
    promptVersion: Number.isFinite(cfg.promptVersion) ? cfg.promptVersion : 0,
    // The match-prompt switch is on and at least one lens (the match prompt or a user tag) exists.
    gateOn: isLensGateOn(cfg),
    purpose: purpose === 'redecide' || purpose === 'retry' ? purpose : 'ingest'
  };
}

/**
 * Questions, prompt pieces and spec hash shared by every post of one decideMany() call.
 * The match question exists only when the gate is on with a non-empty prompt.
 *
 * @param {import('./types.js').DecideContext} ctx
 * @param {CascadePolicy} policy
 * @param {{ calibrationId?: string|null }} [extra]
 */
export function buildDecisionSpec(ctx, policy, extra = {}) {
  const cfg = ctx?.configuration || {};
  const prompt = typeof cfg.matchPrompt === 'string' ? cfg.matchPrompt.trim() : '';
  const gateRequested = ctx?.gateOn ?? buildDecideContext(cfg).gateOn;
  const expansion = typeof cfg.matchPromptExpansion === 'string' ? cfg.matchPromptExpansion.trim() : '';
  const tags = selectQuestionTags(cfg.trackedTags);
  /** @type {Record<string, import('./types.js').Question>} */
  const questions = {};
  const matchQuestion = gateRequested ? buildMatchQuestion(prompt, expansion) : null;
  if (matchQuestion) questions[Q.MATCHES_PROMPT] = matchQuestion;
  const tagQuestion = buildPrimaryTagQuestion(tags, 0);
  if (tagQuestion) questions[Q.PRIMARY_TAG] = tagQuestion;

  // Lenses: `main` keeps the matches_prompt question while the gate asks it; any other lens (a tag
  // the user added, or `main` of a gate-off call such as the idle retry) gets its own `lens:<id>`
  // question, built exactly like matches_prompt so its score comes from the same recipe.
  /** @type {{ id: string, qid: string, prompt: { raw: string, cleaned: string, expansion: string } }[]} */
  const lensEntries = [];
  if (matchQuestion) {
    lensEntries.push({ id: LENS_MAIN_ID, qid: Q.MATCHES_PROMPT, prompt: { raw: prompt, cleaned: cleanPrompt(prompt), expansion } });
  }
  for (const lens of scoredLenses(cfg)) {
    if (lens.id === LENS_MAIN_ID && matchQuestion) continue;
    // Only `main` has an expansion (configuration.matchPromptExpansion).
    const lensExpansion = lens.id === LENS_MAIN_ID ? expansion : '';
    const question = buildMatchQuestion(lens.text, lensExpansion);
    if (!question) continue;
    const qid = lensQuestionId(lens.id);
    questions[qid] = question;
    lensEntries.push({ id: lens.id, qid, prompt: { raw: lens.text, cleaned: cleanPrompt(lens.text), expansion: lensExpansion } });
  }
  const extraLenses = lensEntries.filter((l) => l.qid !== Q.MATCHES_PROMPT);
  const hasTagLens = extraLenses.some((l) => l.id !== LENS_MAIN_ID);
  // On when the gate was asked for and something can match: the match prompt or a lens tag.
  const gateOn = !!matchQuestion || (gateRequested && hasTagLens);
  const mainOn = !!matchQuestion;
  const hash = computeSpecHash({
    v: SPEC_VERSION,
    gateOn,
    prompt: mainOn ? prompt : '',
    expansion: mainOn ? expansion : '',
    tags: tags.map((t) => [t.label, t.description]),
    model: policy?.model ?? null,
    dtype: policy?.dtype ?? null,
    calibration: extra.calibrationId ?? null,
    // Only present with lenses, so a configuration without any keeps its cache keys.
    ...(extraLenses.length ? { lenses: extraLenses.map((l) => [l.id, l.prompt.raw, l.prompt.expansion]) } : {})
  });
  return {
    gateOn,
    prompt: { raw: mainOn ? prompt : '', cleaned: mainOn ? cleanPrompt(prompt) : '', expansion: mainOn ? expansion : '' },
    tags,
    tagLabels: new Set(tags.map((t) => t.label)),
    questions,
    /** Every lens of this call, `main` first: { id, qid (the question that scores it), prompt }. */
    lenses: lensEntries,
    /** The lens questions System 1 embeds a prompt for (everything but matches_prompt). */
    lensPrompts: extraLenses,
    specHash: hash,
    rulesContext: { prompt, promptTags: cfg.matchPromptTags }
  };
}

/**
 * Validates and normalizes provider answers against the questions asked. Unknown ids are
 * dropped, except `tag:<label>` nouls for known tags (System 1 may add them unasked).
 *
 * @param {unknown} raw
 * @param {Record<string, import('./types.js').Question>} questions
 * @param {string} source     default source id
 * @param {Set<string>} [tagLabels]
 * @param {boolean} [forceSource]  stamp `source` on every answer (fresh provider output)
 * @returns {Record<string, import('./types.js').Answer>}
 */
export function sanitizeAnswers(raw, questions, source, tagLabels = new Set(), forceSource = false) {
  /** @type {Record<string, import('./types.js').Answer>} */
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, a] of Object.entries(raw)) {
    if (!a || typeof a !== 'object') continue;
    let q = questions[id];
    if (!q && id.startsWith(Q.TAG_PREFIX) && tagLabels.has(id.slice(Q.TAG_PREFIX.length))) q = { type: 'noul', instructions: '' };
    if (!q) continue;
    const src = !forceSource && typeof a.source === 'string' && a.source ? a.source : source;
    if (q.type === 'noul') {
      const p = a.noul ?? a.probability ?? a.p;
      if (typeof p === 'number' && Number.isFinite(p)) out[id] = noulAnswer(p, src);
    } else if (q.type === 'choice') {
      const options = Object.keys(q.criteria || {});
      if (!options.includes(NONE_OPTION)) options.push(NONE_OPTION);
      let probabilities = null;
      if (a.probabilities && typeof a.probabilities === 'object') {
        const weights = {};
        for (const o of options) weights[o] = num(a.probabilities[o], 0);
        if (Object.values(weights).some((w) => w > 0)) probabilities = normalizeDistribution(weights);
      }
      const requested = a.choice === null || a.choice === undefined ? (probabilities ? null : NONE_OPTION) : String(a.choice);
      let key = requested && options.includes(requested) ? requested : null;
      if (!key && probabilities) key = argmax(probabilities);
      if (!key) continue;
      if (!probabilities) probabilities = { [key]: 1 };
      const confidence = Object.keys(probabilities).length > 1
        ? choiceConfidence(probabilities)
        : clamp01(num(a.confidence, 0));
      out[id] = { type: 'choice', choice: key === NONE_OPTION ? null : key, probabilities, confidence, source: src };
    } else if (q.type === 'score' && Number.isFinite(a.score)) {
      out[id] = { ...a, confidence: clamp01(num(a.confidence, 0)), source: src };
    }
  }
  return out;
}

/** Compact JSON copy of answers for the cache. */
function compactAnswers(answers) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [id, a] of Object.entries(answers)) {
    const c = { ...a };
    if (typeof c.noul === 'number') c.noul = round4(c.noul);
    if (typeof c.confidence === 'number') c.confidence = round4(c.confidence);
    if (c.probabilities) c.probabilities = Object.fromEntries(Object.entries(c.probabilities).map(([k, p]) => [k, round4(p)]));
    out[id] = c;
  }
  return out;
}

/** @param {any} v */
function copyData(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

/** @param {() => any} fn */
async function asBool(fn) {
  try {
    return (await fn()) === true;
  } catch {
    return false;
  }
}

/**
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<void>} fn
 */
async function runPool(items, limit, fn) {
  let next = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const item = items[next++];
        await fn(item);
      }
    })
  );
}

/**
 * decision.lenses: the score of every lens of `spec` that has an answer, 0..1 rounded to 4 places.
 * A lens is scored by its own question (`lens:<id>`), `main` by matches_prompt while the gate asks
 * it, so lenses.main is pMatch. Shared with the idle refinement pass.
 *
 * @param {{ lenses?: { id: string, qid: string }[] }} spec
 * @param {Record<string, import('./types.js').Answer>} answers
 * @returns {Record<string, number>}
 */
export function lensScores(spec, answers) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const l of spec?.lenses || []) {
    const a = /** @type {any} */ (answers?.[l.qid]);
    if (a && a.type === 'noul' && Number.isFinite(a.noul)) out[l.id] = round4(a.noul);
  }
  return out;
}

/** The first lens answer of a post (provider attribution when `main` has none). */
function firstLensAnswer(w, spec) {
  for (const l of spec.lenses) if (w.answers[l.qid]) return w.answers[l.qid];
  return undefined;
}

/**
 * Ranked tags of a post (decision.tags): the tag nouls >= 0.5 when any, else the primary_tag
 * probabilities; the assigned tag first. Shared with the idle refinement pass.
 *
 * @param {Record<string, import('./types.js').Answer>} answers
 * @param {string} tag   the assigned tag (or UNCLASSIFIED)
 * @returns {{ name: string, score: number }[]}
 */
export function rankTags(answers, tag) {
  const nouls = Object.entries(answers)
    .filter(([id, a]) => id.startsWith(Q.TAG_PREFIX) && a?.type === 'noul' && a.noul >= 0.5)
    .map(([id, a]) => ({ name: id.slice(Q.TAG_PREFIX.length), score: round4(/** @type {any} */ (a).noul) }));
  let list;
  if (nouls.length) {
    list = nouls;
  } else {
    const probs = /** @type {any} */ (answers[Q.PRIMARY_TAG])?.probabilities || {};
    const min = tag === UNCLASSIFIED ? 0.5 : MIN_TAG_PROBABILITY;
    list = Object.entries(probs)
      .filter(([name, p]) => name !== NONE_OPTION && /** @type {number} */ (p) >= min)
      .map(([name, p]) => ({ name, score: round4(/** @type {number} */ (p)) }));
  }
  list.sort((a, b) => b.score - a.score);
  if (tag !== UNCLASSIFIED) {
    const own = list.find((t) => t.name === tag);
    const confidence = /** @type {any} */ (answers[Q.PRIMARY_TAG])?.probabilities?.[tag];
    list = [own || { name: tag, score: round4(num(confidence, 1)) }, ...list.filter((t) => t.name !== tag)];
  }
  return list.slice(0, MAX_TAGS);
}

/** @param {string} hex */
function seedFromHash(hex) {
  return parseInt(String(hex || '0').slice(-8), 16) >>> 0;
}

/**
 * @param {{
 *   system1?: System1Provider|null,
 *   escalators?: Record<string, import('./types.js').DecisionProvider>,
 *   rules?: (import('./types.js').DecisionProvider & { isNoise?: (text: string) => boolean })|null,
 *   getPolicy?: ((configuration: object, ctx: import('./types.js').DecideContext) => Partial<CascadePolicy>|null)|null,
 *   budget?: { tryConsume: (n?: number) => Promise<boolean>, setLimits?: (l: object) => void, snapshot?: () => object }|null,
 *   cache?: { get: (key: string) => any, set: (key: string, value: any) => void, ready?: () => Promise<void> }|null,
 *   status?: { count?: (d: object) => void, error?: (id: string, err: unknown) => void, update?: (p: object) => void }|null,
 *   prefilter?: ((state: import('./types.js').DecisionState) => string|boolean|null)|null,
 *   now?: () => number,
 *   escalationTimeoutMs?: number|null,
 *   readyTimeoutMs?: number
 * }} deps
 *   escalationTimeoutMs: deadline of every escalator call (tests); null = per provider (see above).
 */
export function createCascade({
  system1 = null,
  escalators = {},
  rules = null,
  getPolicy = null,
  budget = null,
  cache = null,
  status = null,
  prefilter = null,
  now = Date.now,
  escalationTimeoutMs = null,
  readyTimeoutMs = ESCALATOR_READY_TIMEOUT_MS
} = {}) {
  const detectNoise = prefilter || ((state) => (rules && typeof rules.isNoise === 'function' && rules.isNoise(state.text) ? 'social_noise' : null));

  /** @param {object} configuration @param {import('./types.js').DecideContext} ctx */
  function policyFor(configuration, ctx) {
    const base = resolvePolicy(configuration, { calibratedFloor: system1?.floor ?? null });
    const custom = typeof getPolicy === 'function' ? getPolicy(configuration, ctx) : null;
    if (!custom) return base;
    return { ...base, ...custom, floor: { ...base.floor, ...(custom.floor || {}) }, providers: custom.providers || base.providers };
  }

  /** @param {CascadePolicy} policy @param {string} id */
  function floorFor(policy, id) {
    if (Number.isFinite(policy.floor?.[id])) return policy.floor[id];
    return id === Q.PRIMARY_TAG ? DEFAULT_TAG_FLOOR : DEFAULT_FLOOR;
  }

  /**
   * True when the gate verdict of a matches_prompt answer is confident: the confidence of
   * `p >= threshold` reaches the floor. With 'balanced' (0.5) this is the answer's own |2p - 1|;
   * 'strict' / 'lenient' move the uncertain band with the threshold, so strictness changes which
   * posts are decided outright and which go to the escalator or `whenUnsure`.
   *
   * @param {import('./types.js').Answer|undefined} m
   * @param {CascadePolicy} policy
   */
  function matchIsConfident(m, policy) {
    if (!m) return false;
    const confidence = typeof m.noul === 'number' ? thresholdConfidence(m.noul, policy.threshold) : num(m.confidence, 0);
    return confidence >= floorFor(policy, Q.MATCHES_PROMPT);
  }

  /**
   * Question ids still uncertain for this post. primary_tag is skipped when the post is
   * confidently rejected anyway.
   */
  function uncertainIds(w, spec, policy) {
    const ids = [];
    // Only while the gate is on do lens questions (matches_prompt included) decide anything; a
    // gate-off call scores the lenses with System 1 alone and never escalates them.
    const lensIds = spec.gateOn ? spec.lenses.map((l) => l.qid) : [];
    const uncertainLensIds = lensIds.filter((qid) => !matchIsConfident(w.answers[qid], policy));
    ids.push(...uncertainLensIds.slice(0, MAX_ESCALATED_LENSES));
    if (spec.questions[Q.PRIMARY_TAG]) {
      const t = w.answers[Q.PRIMARY_TAG];
      const mayCollect = !spec.gateOn
        || uncertainLensIds.length > 0
        || lensIds.some((qid) => w.answers[qid] && w.answers[qid].noul >= policy.threshold);
      if (mayCollect && !(t && t.confidence >= floorFor(policy, Q.PRIMARY_TAG))) ids.push(Q.PRIMARY_TAG);
    }
    return ids;
  }

  /**
   * Policy checks shared by every post of the call. Returns the escalator or the reason why
   * nothing escalates.
   */
  async function escalationGate(policy, ctx) {
    // The lens backfill (lib/pipeline/redecide.js) asks System 1 only, whatever the policy allows.
    if (ctx.noEscalation === true) return { reason: 'lens_backfill' };
    const id = policy.provider;
    if (!id || id === 'none') return { reason: 'provider_none' };
    const escalator = escalators?.[id];
    if (!escalator || typeof escalator.decide !== 'function') return { reason: 'provider_unavailable' };
    const isCloud = escalator.isCloud === true || CLOUD_PROVIDERS.includes(id);
    const providerCfg = policy.providers?.[id];
    if (isCloud && providerCfg?.enabled !== true) return { reason: 'cloud_not_allowed' };
    if (!isCloud && providerCfg?.enabled === false) return { reason: 'provider_disabled' };
    if (ctx.purpose === 'redecide' && !policy.allowRedecideEscalation) return { reason: 'redecide_no_escalation' };
    // The idle retry re-checks posts that are already stored (and were already escalated at ingest
    // when they qualified); those background re-checks stay on the device.
    if (isCloud && ctx.purpose === 'retry' && !policy.allowRedecideEscalation) return { reason: 'retry_no_cloud' };
    // A hung readiness check (e.g. LanguageModel.availability()) must not hold up the batch.
    const ready = await asBool(async () => (await settleWithin(Promise.resolve().then(() => escalator.isReady()), readyTimeoutMs)) === true);
    if (!ready) {
      let s = null;
      try {
        s = escalator.status?.() ?? null;
      } catch {
        /* ignore */
      }
      const state = s?.state ?? null;
      if (PROVIDER_STATES_AS_REASON.has(state)) return { reason: state };
      // e.g. Nano pausing for a minute after a prompt timed out
      return { reason: typeof s?.paused === 'string' && s.paused ? s.paused : 'provider_unavailable' };
    }
    return { escalator, isCloud };
  }

  /**
   * Deadline of one call to `escalator`.
   * @param {import('./types.js').DecisionProvider & { timeoutMs?: number }} escalator
   * @param {boolean} isCloud
   */
  function deadlineFor(escalator, isCloud) {
    if (Number.isFinite(escalationTimeoutMs) && /** @type {number} */ (escalationTimeoutMs) > 0) return /** @type {number} */ (escalationTimeoutMs);
    if (Number.isFinite(escalator.timeoutMs) && /** @type {number} */ (escalator.timeoutMs) > 0) {
      return /** @type {number} */ (escalator.timeoutMs) + ESCALATION_TIMEOUT_GRACE_MS;
    }
    return isCloud ? CLOUD_ESCALATION_TIMEOUT_MS : ESCALATION_TIMEOUT_MS;
  }

  /**
   * escalator.decide() with a deadline: its signal aborts and the call rejects with code 'timeout'
   * once `ms` passed, even when the provider never settles.
   *
   * @param {import('./types.js').DecisionProvider} escalator
   * @param {object} req   { state, questions }
   * @param {number} ms
   */
  async function decideWithin(escalator, req, ms) {
    const controller = new AbortController();
    const outcome = await settleWithin(Promise.resolve().then(() => escalator.decide({ ...req, signal: controller.signal })), ms);
    if (outcome !== TIMED_OUT) return outcome;
    controller.abort();
    throw Object.assign(new Error(`${escalator.displayName || escalator.id} did not answer within ${Math.round(ms / 1000)} s.`), { code: 'timeout' });
  }

  /** Questions sent to the escalator: the uncertain ones, primary_tag rotated per post. */
  function escalationQuestions(w, spec, ids) {
    /** @type {Record<string, import('./types.js').Question>} */
    const questions = {};
    for (const id of ids) {
      questions[id] = id === Q.PRIMARY_TAG ? buildPrimaryTagQuestion(spec.tags, seedFromHash(w.state.textHash)) : spec.questions[id];
    }
    const probs = w.answers[Q.PRIMARY_TAG]?.probabilities;
    if (ids.includes(Q.PRIMARY_TAG) && probs) {
      const top = Object.entries(probs)
        .filter(([label, p]) => label !== NONE_OPTION && p > 0 && spec.tagLabels.has(label))
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_ESCALATION_TAG_NOULS)
        .map(([label]) => spec.tags.find((t) => t.label === label));
      Object.assign(questions, buildTagNouls(top));
    }
    return questions;
  }

  /** @param {import('./types.js').DecisionState} state @param {CascadePolicy} policy @param {boolean} isCloud */
  function stateForProvider(state, policy, isCloud) {
    if (!isCloud || policy.sendAuthor || !state.author) return { ...state };
    const { author: _author, ...rest } = state;
    return rest;
  }

  /**
   * @param {any} w
   * @param {ReturnType<typeof buildDecisionSpec>} spec
   * @param {CascadePolicy} policy
   * @param {import('./types.js').DecideContext} ctx
   * @param {number} start
   * @returns {import('./types.js').ItemDecision}
   */
  function finalize(w, spec, policy, ctx, start) {
    const gateOn = spec.gateOn;
    const m = gateOn ? w.answers[Q.MATCHES_PROMPT] : null;

    // The gate over every lens: collected when ANY lens reaches the threshold. whenUnsure decides
    // uncertain MODEL answers. Rules answers are low-confidence by design but are the best signal
    // left when no model answered, so their verdict stands; a rules answer is never a confident
    // verdict, whatever its pMatch (0.2 has confidence 0.6), so it stays flagged uncertain and a
    // later re-decide with a model can replace it.
    let collect = true;
    let uncertain = false;
    if (gateOn) {
      const verdict = lensGateVerdict(spec.lenses.map((l) => {
        const a = w.answers[l.qid];
        if (!a) return { noul: null, decisive: false, settled: false };
        const escalated = !!(w.escalated && a.source === w.escalator);
        const confident = escalated || matchIsConfident(a, policy);
        return { noul: a.noul, decisive: confident || a.source === 'rules', settled: confident && a.source !== 'rules' };
      }), policy);
      collect = verdict.collect;
      uncertain = verdict.uncertain;
    }

    const t = w.answers[Q.PRIMARY_TAG];
    const tagFloor = floorFor(policy, Q.PRIMARY_TAG);
    const tag = t && t.choice && spec.tagLabels.has(t.choice) && t.confidence >= tagFloor ? t.choice : UNCLASSIFIED;

    let provider;
    if (w.prefiltered) provider = 'prefilter';
    else if (w.escalated) provider = w.escalator;
    else provider = (gateOn ? m ?? firstLensAnswer(w, spec) : t)?.source || w.path.find((p) => p !== 'cache') || 'none';

    // Most actionable first: escalator failure, then System 1 failure, then the policy block.
    const reason = w.prefiltered
      ? w.reason
      : w.escalated
        ? null
        : (w.escalationError ?? (w.s1 ? null : w.s1Reason) ?? w.reason ?? null);
    const done = w.doneAt ?? now();
    return {
      v: 1,
      promptVersion: ctx.promptVersion ?? 0,
      specHash: spec.specHash,
      path: [...w.path],
      provider,
      pMatch: m ? round4(m.noul) : null,
      matchConfidence: m ? round4(m.confidence) : null,
      tag,
      tagConfidence: t ? round4(t.confidence) : null,
      tags: w.prefiltered ? [] : rankTags(w.answers, tag),
      lenses: lensScores(spec, w.answers),
      escalated: !!w.escalated,
      uncertain,
      reason,
      collect,
      latencyMs: Math.max(0, Math.round(done - start - (w.waited ? w.waitMs : 0))),
      at: now()
    };
  }

  /**
   * @type {import('./types.js').DecideMany}
   */
  async function decideMany(items, ctxIn = {}) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return [];

    /** @type {import('./types.js').DecideContext} */
    const ctx = buildDecideContext(ctxIn?.configuration, ctxIn?.purpose);
    // The caller's snapshot values win over the ones derived from the configuration.
    if (Number.isFinite(ctxIn?.promptVersion)) ctx.promptVersion = ctxIn.promptVersion;
    if (typeof ctxIn?.gateOn === 'boolean') ctx.gateOn = ctxIn.gateOn;
    if (ctxIn?.noEscalation === true) ctx.noEscalation = true;
    const policy = policyFor(ctx.configuration, ctx);
    budget?.setLimits?.({ perMinute: policy.perMinute, perDay: policy.perDay });
    const spec = buildDecisionSpec(ctx, policy, { calibrationId: system1?.calibrationId ?? null });
    const questionIds = Object.keys(spec.questions);
    const start = now();

    if (cache && typeof cache.ready === 'function') {
      try {
        await cache.ready();
      } catch {
        /* cache is best effort */
      }
    }

    const work = list.map((item, index) => ({
      index,
      state: buildDecisionState(item),
      /** @type {Record<string, import('./types.js').Answer>} */
      answers: {},
      /** @type {string[]} */
      path: [],
      key: '',
      cachedHit: false,
      prefiltered: false,
      final: false,
      s1: false,
      /** @type {string|null} */
      s1Reason: null,
      escalated: false,
      /** @type {string|null} */
      escalator: null,
      /** @type {string|null} why escalation was skipped (policy) */
      reason: null,
      /** @type {string|null} escalator error code */
      escalationError: null,
      dirty: false,
      waited: false,
      waitMs: 0,
      /** @type {number|null} */
      doneAt: null
    }));

    // 1-2. cache, prefilter
    for (const w of work) {
      if (!questionIds.length) {
        w.final = true;
        w.doneAt = now();
        continue;
      }
      w.key = cacheKey(spec.specHash, w.state.textHash);
      let hit;
      try {
        hit = cache ? cache.get(w.key) : undefined;
      } catch {
        hit = undefined;
      }
      if (hit && hit.answers && typeof hit.answers === 'object') {
        w.answers = sanitizeAnswers(copyData(hit.answers), spec.questions, 'system1', spec.tagLabels);
        w.path = [...(Array.isArray(hit.path) ? hit.path : []), 'cache'];
        w.cachedHit = true;
        w.s1 = true;
        w.escalated = !!hit.escalated;
        w.escalator = hit.escalated ? hit.provider : null;
        if (w.escalated || !uncertainIds(w, spec, policy).length) {
          w.final = true;
          w.doneAt = now();
        }
        continue;
      }
      if (spec.gateOn) {
        const noise = !w.state.text ? 'empty_text' : detectNoise(w.state);
        if (noise) {
          // Noise matches no prompt: every lens gets the same low score as matches_prompt.
          for (const l of spec.lenses) w.answers[l.qid] = noulAnswer(PREFILTER_NOISE_P, 'prefilter');
          w.path = ['prefilter'];
          w.prefiltered = true;
          w.reason = typeof noise === 'string' ? noise : 'social_noise';
          w.final = true;
          w.doneAt = now();
        }
      } else if (!w.state.text) {
        // Nothing to classify (e.g. an image-only post): collected as Unclassified.
        w.reason = 'empty_text';
        w.final = true;
        w.doneAt = now();
      }
    }

    // 3. System 1, one batch
    const s1Work = work.filter((w) => !w.final && !w.cachedHit);
    if (s1Work.length) {
      if (!system1 || !policy.system1Enabled) {
        for (const w of s1Work) w.s1Reason = system1 ? 's1_disabled' : 's1_unavailable';
      } else {
        let ready = await asBool(() => system1.isReady());
        let waitMs = 0;
        if (!ready && policy.waitForReadyMs > 0 && typeof system1.waitUntilReady === 'function') {
          const t = now();
          ready = await asBool(() => system1.waitUntilReady(policy.waitForReadyMs));
          waitMs = now() - t;
          for (const w of s1Work) {
            w.waited = true;
            w.waitMs = waitMs;
          }
        }
        if (!ready) {
          for (const w of s1Work) w.s1Reason = 's1_unavailable';
        } else {
          try {
            const res = await system1.decideBatch({
              items: s1Work.map((w) => ({ id: String(w.index), text: w.state.text })),
              questions: spec.questions,
              specHash: spec.specHash,
              context: { prompt: spec.prompt, tags: spec.tags, ...(spec.lensPrompts.length ? { lenses: spec.lensPrompts } : {}) }
            });
            const results = Array.isArray(res) ? res : Array.isArray(res?.results) ? res.results : [];
            const byId = new Map();
            for (const r of results) if (r && r.id !== undefined && r.id !== null) byId.set(String(r.id), r);
            s1Work.forEach((w, i) => {
              const r = byId.size ? byId.get(String(w.index)) : results[i];
              const answers = r?.answers ? sanitizeAnswers(r.answers, spec.questions, 'system1', spec.tagLabels, true) : {};
              if (Object.keys(answers).length) {
                Object.assign(w.answers, answers);
                w.path.push('system1');
                w.s1 = true;
              } else {
                w.s1Reason = (typeof r?.error === 'string' && r.error) || (typeof r?.code === 'string' && r.code) || 's1_missing';
              }
              w.doneAt = now();
            });
          } catch (err) {
            status?.error?.('system1', err);
            const code = typeof err?.code === 'string' && err.code ? err.code : 's1_error';
            for (const w of s1Work) w.s1Reason = code;
          }
        }
      }
    }

    // 4. escalation (one primary provider, no chaining)
    const candidates = [];
    for (const w of work) {
      if (w.final) continue;
      const ids = uncertainIds(w, spec, policy);
      if (ids.length) candidates.push({ w, ids });
    }
    if (candidates.length) {
      const gate = await escalationGate(policy, ctx);
      if (!gate.escalator) {
        for (const { w } of candidates) w.reason = gate.reason;
      } else {
        const escalator = gate.escalator;
        let send = candidates;
        if (gate.isCloud) {
          // Off-device only for questions System 1 answered and was unsure about. A question
          // nobody answered (System 1 down, disabled, timed out) is left to the rules, so an
          // outage never sends the whole feed to the cloud.
          send = [];
          for (const { w, ids } of candidates) {
            const answered = ids.filter((id) => w.answers[id]);
            if (answered.length) send.push({ w, ids: answered });
            else w.reason = 'cloud_needs_system1';
          }
        }
        const concurrency = Number.isFinite(escalator.maxConcurrency) ? escalator.maxConcurrency : gate.isCloud ? 4 : 1;
        const deadline = deadlineFor(escalator, gate.isCloud);
        let timedOut = false;
        await runPool(send, concurrency, async ({ w, ids }) => {
          // The escalator just timed out on another post of this call: keep System 1's answers.
          if (timedOut) {
            w.escalationError = 'timeout';
            w.doneAt = now();
            return;
          }
          let allowed = true;
          if (budget) {
            try {
              allowed = (await budget.tryConsume(1)) === true;
            } catch {
              allowed = false;
            }
          }
          if (!allowed) {
            w.reason = 'budget_exceeded';
            return;
          }
          const questions = escalationQuestions(w, spec, ids);
          try {
            const res = await decideWithin(escalator, { state: stateForProvider(w.state, policy, gate.isCloud), questions }, deadline);
            const answers = sanitizeAnswers(res?.answers, questions, escalator.id, spec.tagLabels, true);
            if (!Object.keys(answers).length) {
              throw Object.assign(new Error('The provider returned no usable answers.'), { code: 'empty_answer' });
            }
            Object.assign(w.answers, answers);
            w.escalated = true;
            w.escalator = escalator.id;
            w.path.push(escalator.id);
            w.reason = null;
            w.dirty = true;
          } catch (err) {
            status?.error?.(escalator.id, err);
            w.escalationError = typeof err?.code === 'string' && err.code ? err.code : 'escalation_error';
            if (w.escalationError === 'timeout') timedOut = true;
          }
          w.doneAt = now();
        });
      }
    }

    // 5. rules fill whatever is still missing
    if (rules && typeof rules.decide === 'function') {
      for (const w of work) {
        if (w.final) continue;
        const missing = questionIds.filter((id) => !w.answers[id]);
        if (!missing.length) continue;
        try {
          const res = await rules.decide({
            state: w.state,
            questions: Object.fromEntries(missing.map((id) => [id, spec.questions[id]])),
            context: spec.rulesContext
          });
          const answers = sanitizeAnswers(res?.answers, spec.questions, 'rules', spec.tagLabels, true);
          let filled = false;
          for (const id of missing) {
            if (answers[id]) {
              w.answers[id] = answers[id];
              filled = true;
            }
          }
          if (filled) w.path.push('rules');
        } catch (err) {
          status?.error?.('rules', err);
        }
        w.doneAt = now();
      }
    }

    // 6. finalize, cache, count
    const decisions = work.map((w) => {
      const decision = finalize(w, spec, policy, ctx, start);
      const complete = questionIds.length > 0 && questionIds.every((id) => w.answers[id]);
      const degraded = w.prefiltered || !complete || Object.values(w.answers).some((a) => a.source === 'rules' || a.source === 'prefilter');
      if (cache && w.key && !degraded && (!w.cachedHit || w.dirty)) {
        try {
          cache.set(w.key, {
            answers: compactAnswers(w.answers),
            path: w.path.filter((p) => p !== 'cache'),
            provider: decision.provider,
            escalated: w.escalated
          });
        } catch {
          /* cache is best effort */
        }
      }
      try {
        status?.count?.(decision);
      } catch {
        /* status is best effort */
      }
      return decision;
    });

    try {
      status?.update?.({ escalation: { provider: policy.provider, ...(budget?.snapshot ? { budget: budget.snapshot() } : {}) } });
    } catch {
      /* status is best effort */
    }
    return decisions;
  }

  return { decideMany };
}
