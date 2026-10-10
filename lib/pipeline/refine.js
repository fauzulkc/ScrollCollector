/**
 * refine.js
 *
 * Idle multi-model refinement of posts that are already collected. While the user is idle (see
 * createIdleTrigger below and lib/bg/decision-runtime.js), stored items are decided again by BOTH
 * bundled System 1 embedding models and the two calibrated answers are averaged; what is still
 * uncertain goes to the browser's built-in model (Gemini Nano). Cloud providers are never called:
 * the refiner only ever receives System 1 and Nano.
 *
 * One pass (createRefiner().run()):
 *  - candidates: stored items with text that are not manual overrides, not prefiltered noise, not
 *    decided by an escalation provider at ingest (that verdict is already stronger than two embedding
 *    models), and whose decision.refined does not match the current spec hash and model pair. Newest
 *    first, in batches of REFINE_BATCH_SIZE.
 *  - per batch: (a) the active System 1 model (its answers are not persisted, so it runs again: the
 *    vectors come from the embedding cache) and the SECONDARY model (the bundled model that is not
 *    the active one, decideBatch({ model })) answer the same questions; (b) ensembleAnswers()
 *    averages their calibrated probabilities: matches_prompt p = mean, primary_tag probabilities =
 *    mean over the union of labels (renormalised), tag:<label> nouls = mean of the models that gave
 *    one; confidences are recomputed (thresholdConfidence against the strictness threshold,
 *    choiceConfidence for the tag); (c) questions still below the confidence floors go to Nano when
 *    it is ready, switched on (providers.nano.enabled) and refine.nano !== false; its answers decide.
 *    After one Nano failure or timeout the pass stops asking it.
 *  - commit: store.mutateStack matched by id against the FRESH stack. Items deleted meanwhile are
 *    absent (never resurrected); items whose text or decision changed meanwhile, or that became
 *    manual overrides, are skipped. decision gets path + 'ensemble' (+ 'nano'), pMatch, confidences,
 *    tag, tags and refined: { at, specHash, models, agreement, nano }; assignedTag, matchInfo and
 *    hiddenByPrompt (stack-utils shouldHideByPrompt: gate on, collect false, not a favourite, not a
 *    manual override) follow. Items are never deleted.
 *  - yields: before every batch the pass stops when ingest or a re-decide is busy (isBusy) or a
 *    pause() was requested (the user became active: the batch in flight still commits). A cancel()
 *    (configuration / prompt change) or a re-decide (isSuperseded), or a changed decision fingerprint
 *    inside the commit, drop the batch in flight. A later pass recomputes the candidates, so it
 *    resumes where this one stopped.
 */

import { Q, noulAnswer } from '../decision/types.js';
import { argmax, choiceConfidence, normalizeDistribution, thresholdConfidence } from '../decision/confidence.js';
import { buildDecideContext, buildDecisionSpec, resolvePolicy, sanitizeAnswers, rankTags, UNCLASSIFIED } from '../decision/cascade.js';
import { buildDecisionState } from '../decision/state.js';
import { NONE_OPTION } from '../decision/questions.js';
import { MODEL_REGISTRY, DEFAULT_MODEL_KEY } from '../decision/models.js';
import { resolveIntelligence } from '../storage/schema.js';
import { buildMatchInfo, decisionFingerprint, displayNameFor } from './apply-decision.js';
import { isManualItem, shouldHideByPrompt, telemetryFromStack } from '../bg/stack-utils.js';

/** Items decided per System 1 call / per commit. */
export const REFINE_BATCH_SIZE = 8;
/** chrome.alarms name of the periodic idle check (survives service-worker restarts). */
export const REFINE_ALARM = 'refineIdle';
export const REFINE_ALARM_MINUTES = 5;
/** Longest a pass waits for System 1 to load. */
const S1_WAIT_MS = 180000;
/** Deadline of one Nano call when the provider declares no timeoutMs. */
const NANO_TIMEOUT_MS = 20000;
const NANO_READY_TIMEOUT_MS = 5000;
/** Fallback floors (the cascade's, used when neither the user nor the calibration sets one). */
const DEFAULT_FLOOR = 0.5;
const DEFAULT_TAG_FLOOR = 0.35;

/** @param {number} n */
const round4 = (n) => Math.round(n * 1e4) / 1e4;

/**
 * The bundled embedding model that is not `primary`.
 * @param {string} primary
 * @returns {string|null}
 */
export function secondaryModelOf(primary) {
  return Object.keys(MODEL_REGISTRY).find((k) => k !== primary) || null;
}

/**
 * Spec, policy and model pair of a pass for `configuration` (the same spec hash the cascade uses).
 * @param {object} configuration
 * @param {{ calibrationId?: string|null, floor?: Record<string, number>|null }|null} [system1]
 */
export function refineSpec(configuration, system1 = null) {
  const cfg = configuration && typeof configuration === 'object' ? configuration : {};
  const ctx = buildDecideContext(cfg, 'redecide');
  const policy = resolvePolicy(cfg, { calibratedFloor: (system1 && system1.floor) || null });
  const spec = buildDecisionSpec(ctx, policy, { calibrationId: (system1 && system1.calibrationId) ?? null });
  const primary = MODEL_REGISTRY[policy.model] ? policy.model : DEFAULT_MODEL_KEY;
  const secondary = secondaryModelOf(primary);
  return { ctx, policy, spec, models: secondary ? [primary, secondary] : [primary], fingerprint: decisionFingerprint(cfg) };
}

/**
 * Whether a stored item takes part in refinement at all.
 * @param {any} item
 */
export function isRefineEligible(item) {
  if (!item || !item.id || typeof item.textSnippet !== 'string' || !item.textSnippet.trim()) return false;
  if (isManualItem(item)) return false;
  const d = item.decision;
  if (!d || typeof d !== 'object') return false;
  const path = Array.isArray(d.path) ? d.path : [];
  if (path.includes('prefilter')) return false;
  // An escalation provider decided it at ingest: keep that verdict (unless the refiner asked Nano).
  if (d.escalated && !d.refined) return false;
  return true;
}

/**
 * Whether `item` is refined for this spec hash and model pair.
 * @param {any} item
 * @param {string} specHash
 * @param {string[]} models
 */
export function isRefined(item, specHash, models) {
  const r = item && item.decision && item.decision.refined;
  return !!(r && r.specHash === specHash && Array.isArray(r.models) && r.models.join('|') === models.join('|'));
}

/**
 * { refined, total } over the eligible items of `stack`.
 * @param {any[]} stack
 * @param {string} specHash
 * @param {string[]} models
 */
export function refineProgress(stack, specHash, models) {
  let total = 0;
  let refined = 0;
  for (const item of Array.isArray(stack) ? stack : []) {
    if (!isRefineEligible(item)) continue;
    total++;
    if (isRefined(item, specHash, models)) refined++;
  }
  return { refined, total };
}

/**
 * Items still to refine, newest first.
 * @param {any[]} stack
 * @param {string} specHash
 * @param {string[]} models
 */
export function refineCandidates(stack, specHash, models) {
  return (Array.isArray(stack) ? stack : [])
    .filter((item) => isRefineEligible(item) && !isRefined(item, specHash, models))
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (Number(b.item.timestamp) || 0) - (Number(a.item.timestamp) || 0) || a.index - b.index)
    .map((x) => x.item);
}

/**
 * Averages two models' calibrated answers (see the module header). A question only one model
 * answered keeps that model's answer.
 *
 * @param {Record<string, any>} a   primary model answers (sanitised)
 * @param {Record<string, any>} b   secondary model answers (sanitised)
 * @param {number} threshold        P(match) needed to collect
 * @returns {Record<string, any>}
 */
export function ensembleAnswers(a, b, threshold) {
  /** @type {Record<string, any>} */
  const out = {};
  const ids = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const id of ids) {
    const x = a && a[id];
    const y = b && b[id];
    const only = x && !y ? x : y && !x ? y : null;
    if (only) {
      out[id] = { ...only, source: 'ensemble' };
      continue;
    }
    if (x.type === 'noul' && y.type === 'noul') {
      const ans = noulAnswer((x.noul + y.noul) / 2, 'ensemble');
      if (id === Q.MATCHES_PROMPT) ans.confidence = thresholdConfidence(ans.noul, threshold);
      out[id] = ans;
    } else if (x.type === 'choice' && y.type === 'choice') {
      const px = x.probabilities || { [x.choice ?? NONE_OPTION]: 1 };
      const py = y.probabilities || { [y.choice ?? NONE_OPTION]: 1 };
      const labels = new Set([...Object.keys(px), ...Object.keys(py)]);
      /** @type {Record<string, number>} */
      const mean = {};
      for (const label of labels) mean[label] = ((Number(px[label]) || 0) + (Number(py[label]) || 0)) / 2;
      const probabilities = normalizeDistribution(mean);
      const top = argmax(probabilities);
      out[id] = { type: 'choice', choice: top === NONE_OPTION ? null : top, probabilities, confidence: choiceConfidence(probabilities), source: 'ensemble' };
    } else {
      out[id] = { ...x, source: 'ensemble' };
    }
  }
  return out;
}

/**
 * Both models agree on the gate verdict (when there is a match question) and on the tag choice.
 * @param {Record<string, any>} a
 * @param {Record<string, any>} b
 * @param {number} threshold
 */
export function modelsAgree(a, b, threshold) {
  const ma = a[Q.MATCHES_PROMPT];
  const mb = b[Q.MATCHES_PROMPT];
  if (ma || mb) {
    if (!ma || !mb || (ma.noul >= threshold) !== (mb.noul >= threshold)) return false;
  }
  const ta = a[Q.PRIMARY_TAG];
  const tb = b[Q.PRIMARY_TAG];
  if (ta || tb) {
    if (!ta || !tb || (ta.choice ?? null) !== (tb.choice ?? null)) return false;
  }
  return true;
}

/** @param {any} policy @param {string} id */
function floorFor(policy, id) {
  const v = policy && policy.floor && policy.floor[id];
  if (Number.isFinite(v)) return v;
  return id === Q.PRIMARY_TAG ? DEFAULT_TAG_FLOOR : DEFAULT_FLOOR;
}

/**
 * Questions still uncertain after the ensemble (same rules as the cascade's escalation step).
 * @param {Record<string, any>} answers
 * @param {any} spec
 * @param {any} policy
 * @returns {string[]}
 */
export function uncertainQuestions(answers, spec, policy) {
  const ids = [];
  const m = answers[Q.MATCHES_PROMPT];
  const matchConfident = !!m && thresholdConfidence(m.noul, policy.threshold) >= floorFor(policy, Q.MATCHES_PROMPT);
  if (spec.questions[Q.MATCHES_PROMPT] && !matchConfident) ids.push(Q.MATCHES_PROMPT);
  if (spec.questions[Q.PRIMARY_TAG]) {
    const t = answers[Q.PRIMARY_TAG];
    const mayCollect = !spec.questions[Q.MATCHES_PROMPT] || ids.includes(Q.MATCHES_PROMPT) || (m && m.noul >= policy.threshold);
    if (mayCollect && !(t && t.confidence >= floorFor(policy, Q.PRIMARY_TAG))) ids.push(Q.PRIMARY_TAG);
  }
  return ids;
}

/**
 * The refined ItemDecision.
 * @param {any} previous          the item's current decision
 * @param {Record<string, any>} answers   ensemble answers (Nano answers merged in)
 * @param {{ spec: any, policy: any, ctx: any, models: string[], agreement: boolean, nano: boolean, at: number }} o
 */
export function buildRefinedDecision(previous, answers, { spec, policy, ctx, models, agreement, nano, at }) {
  const gateOn = spec.gateOn;
  const m = gateOn ? answers[Q.MATCHES_PROMPT] : null;
  const matchByNano = !!(m && m.source === 'nano');
  const matchConfidence = m ? (matchByNano ? m.confidence : thresholdConfidence(m.noul, policy.threshold)) : null;
  const uncertain = gateOn && !matchByNano && (!m || /** @type {number} */ (matchConfidence) < floorFor(policy, Q.MATCHES_PROMPT));
  let collect;
  if (!gateOn) collect = true;
  else if (!m || uncertain) collect = policy.whenUnsure !== 'skip';
  else collect = m.noul >= policy.threshold;

  const t = answers[Q.PRIMARY_TAG];
  const tag = t && t.choice && spec.tagLabels.has(t.choice) && t.confidence >= floorFor(policy, Q.PRIMARY_TAG) ? t.choice : UNCLASSIFIED;
  const base = (Array.isArray(previous && previous.path) ? previous.path : []).filter((p) => p !== 'cache' && p !== 'ensemble' && p !== 'nano' && p !== 'rules' && p !== 'error');
  const path = [...(base.includes('system1') ? base : ['system1', ...base]), 'ensemble', ...(nano ? ['nano'] : [])];
  return {
    v: 1,
    promptVersion: ctx.promptVersion ?? 0,
    specHash: spec.specHash,
    path,
    provider: nano ? 'nano' : 'ensemble',
    pMatch: m ? round4(m.noul) : null,
    matchConfidence: matchConfidence === null ? null : round4(matchConfidence),
    tag,
    tagConfidence: t ? round4(t.confidence) : null,
    tags: rankTags(answers, tag),
    escalated: nano,
    uncertain,
    reason: null,
    collect,
    latencyMs: Number.isFinite(previous && previous.latencyMs) ? previous.latencyMs : 0,
    at,
    refined: { at, specHash: spec.specHash, models: [...models], agreement: !!agreement, nano: !!nano }
  };
}

const TIMEOUT = Symbol('refine.timeout');

/**
 * Resolves with what `promise` resolves to, or with TIMEOUT after `ms`.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T|typeof TIMEOUT>}
 */
function within(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(TIMEOUT), Math.max(0, ms));
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * @typedef {object} RefineResult
 * @property {string} reason
 * @property {'done'|'paused'|'busy'|'cancelled'|'skipped'} outcome
 * @property {string|null} skipped     why nothing ran ('disabled', 's1_disabled', 's1_unavailable', 'no_questions')
 * @property {number} total            candidates at the start
 * @property {number} done             candidates processed
 * @property {number} refined          items committed as refined
 * @property {number} changedVerdicts
 * @property {number} changedTags
 * @property {number} nanoCalls
 * @property {number} failed           items a model could not answer (retried by a later pass)
 * @property {string[]} models
 */

/**
 * @param {object} deps
 * @param {ReturnType<import('../bg/store.js').createStore>} deps.store
 * @param {any} deps.system1     System1Provider with decideBatch({ model }), isReady / waitUntilReady, release
 * @param {any} [deps.nano]      the browser built-in model (decide, isReady, status); never a cloud provider
 * @param {{ scheduleBroadcast?: () => unknown }|null} [deps.broadcast]
 * @param {() => number} [deps.now]
 * @param {() => boolean} [deps.isBusy]         ingest or a re-decide in flight: stop before the next batch
 * @param {() => boolean} [deps.isSuperseded]   a re-decide started: drop the batch in flight
 * @param {(p: object) => void} [deps.onProgress]
 * @param {number} [deps.batchSize]
 * @param {number} [deps.s1WaitMs]
 */
export function createRefiner({
  store,
  system1,
  nano = null,
  broadcast = null,
  now = Date.now,
  isBusy = () => false,
  isSuperseded = () => false,
  onProgress = () => {},
  batchSize = REFINE_BATCH_SIZE,
  s1WaitMs = S1_WAIT_MS
}) {
  const size = Math.max(1, Math.floor(batchSize) || REFINE_BATCH_SIZE);
  let version = 0;
  let pauseRequested = false;
  /** @type {Promise<RefineResult>|null} */
  let running = null;
  const totals = { passes: 0, refined: 0, changedVerdicts: 0, changedTags: 0, nanoCalls: 0, nanoErrors: 0, failed: 0, /** @type {number|null} */ lastRunAt: null, /** @type {RefineResult|null} */ last: null };
  /** @type {{ done: number, total: number }|null} */
  let live = null;

  /** @param {object} p */
  function progress(p) {
    try {
      onProgress(p);
    } catch {
      /* best effort */
    }
  }

  function scheduleBroadcast() {
    try {
      if (broadcast && typeof broadcast.scheduleBroadcast === 'function') Promise.resolve(broadcast.scheduleBroadcast()).catch(() => {});
    } catch {
      /* best effort */
    }
  }

  /** @returns {Promise<boolean>} */
  async function nanoUsable(intel) {
    if (!nano || typeof nano.decide !== 'function') return false;
    if (intel.refine && intel.refine.nano === false) return false;
    if (intel.providers && intel.providers.nano && intel.providers.nano.enabled === false) return false;
    try {
      return (await within(Promise.resolve().then(() => nano.isReady()), NANO_READY_TIMEOUT_MS)) === true;
    } catch {
      return false;
    }
  }

  /**
   * @param {{ reason: string }} opts
   * @returns {Promise<RefineResult>}
   */
  async function pass({ reason }) {
    const myVersion = version;
    const isCurrent = () => myVersion === version;
    /** @type {RefineResult} */
    const result = { reason, outcome: 'done', skipped: null, total: 0, done: 0, refined: 0, changedVerdicts: 0, changedTags: 0, nanoCalls: 0, failed: 0, models: [] };
    const report = (finished) => progress({ running: !finished, finished, ...result });
    const end = (outcome, skipped = null) => {
      result.outcome = outcome;
      result.skipped = skipped;
      return result;
    };

    let { configuration = {}, stack = [] } = (await store.snapshot(['configuration', 'stack'])) || {};
    const intel = resolveIntelligence(configuration);
    if (!intel.refine || intel.refine.enabled === false) return end('skipped', 'disabled');
    if (intel.system1 && intel.system1.enabled === false) return end('skipped', 's1_disabled');
    let r = refineSpec(configuration, system1);
    result.models = r.models;
    if (r.models.length < 2) return end('skipped', 'no_second_model');
    if (!Object.keys(r.spec.questions).length) return end('skipped', 'no_questions');
    let candidates = refineCandidates(stack, r.spec.specHash, r.models);
    if (!candidates.length) return end('done');

    // Only now (there is work) load System 1.
    let ready = false;
    try {
      ready = typeof system1.waitUntilReady === 'function' ? (await system1.waitUntilReady(s1WaitMs)) === true : (await system1.isReady()) === true;
    } catch {
      ready = false;
    }
    if (!ready) return end('skipped', 's1_unavailable');
    if (!isCurrent()) return end('cancelled');
    // The calibration is known for sure once the model is ready: recompute.
    ({ configuration = {}, stack = [] } = (await store.snapshot(['configuration', 'stack'])) || {});
    r = refineSpec(configuration, system1);
    candidates = refineCandidates(stack, r.spec.specHash, r.models);
    const { ctx, policy, spec, models, fingerprint } = r;
    result.models = models;
    result.total = candidates.length;
    live = { done: 0, total: candidates.length };
    report(false);
    const useNano = await nanoUsable(resolveIntelligence(configuration));
    let nanoBroken = false;

    for (let start = 0; start < candidates.length; start += size) {
      if (!isCurrent()) return end('cancelled');
      if (pauseRequested) return end('paused');
      if (isBusy()) return end('busy');
      const chunk = candidates.slice(start, start + size);
      const states = chunk.map((item) => buildDecisionState(item));
      const req = {
        items: states.map((s, i) => ({ id: String(i), text: s.text })),
        questions: spec.questions,
        specHash: spec.specHash,
        context: { prompt: spec.prompt, tags: spec.tags }
      };
      /** @type {any[]} */
      let outs = [null, null];
      try {
        outs = await Promise.all([system1.decideBatch(req), system1.decideBatch({ ...req, model: models[1] })]);
      } catch (err) {
        console.warn('[background] Refine batch failed:', err);
      }
      if (!isCurrent()) return end('cancelled');
      const byIndex = (res) => {
        const list = Array.isArray(res) ? res : Array.isArray(res && res.results) ? res.results : [];
        const map = new Map();
        for (const x of list) if (x && x.id !== undefined && x.id !== null) map.set(String(x.id), x);
        return map;
      };
      const primary = byIndex(outs[0]);
      const secondary = byIndex(outs[1]);

      /** @type {Map<string, { text: string, at: any, decision: object }>} */
      const updates = new Map();
      for (let i = 0; i < chunk.length; i++) {
        const item = chunk[i];
        const a = sanitizeAnswers(primary.get(String(i))?.answers, spec.questions, 'system1', spec.tagLabels, true);
        const b = sanitizeAnswers(secondary.get(String(i))?.answers, spec.questions, 'system1', spec.tagLabels, true);
        if (!Object.keys(a).length || !Object.keys(b).length) {
          result.failed++;
          continue;
        }
        const answers = ensembleAnswers(a, b, policy.threshold);
        const agreement = modelsAgree(a, b, policy.threshold);
        let usedNano = false;
        const ids = uncertainQuestions(answers, spec, policy);
        if (ids.length && useNano && !nanoBroken && isCurrent() && !pauseRequested) {
          const questions = Object.fromEntries(ids.map((id) => [id, spec.questions[id]]));
          const controller = new AbortController();
          const ms = Number.isFinite(nano.timeoutMs) && nano.timeoutMs > 0 ? nano.timeoutMs + 1000 : NANO_TIMEOUT_MS;
          result.nanoCalls++;
          try {
            const { author: _author, ...state } = states[i];
            const res = await within(Promise.resolve().then(() => nano.decide({ state, questions, signal: controller.signal })), ms);
            if (res === TIMEOUT) {
              controller.abort();
              throw Object.assign(new Error('Gemini Nano did not answer in time.'), { code: 'timeout' });
            }
            const got = sanitizeAnswers(/** @type {any} */ (res)?.answers, questions, 'nano', spec.tagLabels, true);
            if (Object.keys(got).length) {
              Object.assign(answers, got);
              usedNano = true;
            }
          } catch (err) {
            nanoBroken = true;
            totals.nanoErrors++;
            console.warn('[background] Refine: Gemini Nano failed; the rest of this pass keeps the ensemble:', /** @type {any} */ (err)?.code || err);
          }
        }
        const decision = buildRefinedDecision(item.decision, answers, { spec, policy, ctx, models, agreement, nano: usedNano, at: now() });
        updates.set(item.id, { text: item.textSnippet, at: item.decision && item.decision.at, decision });
      }
      if (!isCurrent()) return end('cancelled');

      if (updates.size) {
        let superseded = false;
        let counts = { refined: 0, changedVerdicts: 0, changedTags: 0 };
        await store.mutateStack((fresh, state) => {
          const cfg = state.configuration || {};
          if (!isCurrent() || isSuperseded() || decisionFingerprint(cfg) !== fingerprint) {
            superseded = true;
            return null;
          }
          counts = { refined: 0, changedVerdicts: 0, changedTags: 0 };
          const next = fresh.map((item) => {
            const hit = item && updates.get(item.id);
            // Deleted items are absent; edited text, a newer decision or a manual override win.
            if (!hit || item.textSnippet !== hit.text || isManualItem(item) || (item.decision && item.decision.at) !== hit.at) return item;
            const d = /** @type {any} */ (hit.decision);
            const tag = d.tag || UNCLASSIFIED;
            const updated = {
              ...item,
              assignedTag: tag,
              tags: tag !== UNCLASSIFIED && d.tags.length === 0 ? [{ name: tag, score: 1 }] : d.tags,
              decision: d,
              matchInfo: buildMatchInfo({ ...d, meta: { engine: displayNameFor(d.provider) } }, cfg, ctx.gateOn)
            };
            updated.hiddenByPrompt = shouldHideByPrompt(updated, cfg);
            counts.refined++;
            if ((item.decision ? item.decision.collect !== false : true) !== (d.collect !== false)) counts.changedVerdicts++;
            if ((item.assignedTag || UNCLASSIFIED) !== tag) counts.changedTags++;
            return updated;
          });
          if (!counts.refined) return null;
          return { stack: next, telemetry: telemetryFromStack(next, state.telemetry, now()) };
        });
        if (superseded) {
          version += 1; // the rest of this pass would be stale too
          return end('cancelled');
        }
        result.refined += counts.refined;
        result.changedVerdicts += counts.changedVerdicts;
        result.changedTags += counts.changedTags;
        if (counts.refined) scheduleBroadcast();
      }
      result.done += chunk.length;
      live = { done: result.done, total: result.total };
      if (result.done < result.total) report(false);
    }
    return end('done');
  }

  /**
   * Starts a pass (or joins the running one).
   * @param {{ reason?: string }} [opts]
   * @returns {Promise<RefineResult>}
   */
  function run({ reason = 'idle' } = {}) {
    if (running) return running;
    pauseRequested = false;
    const p = pass({ reason })
      .catch((err) => {
        console.warn('[background] Refine pass failed:', err);
        return /** @type {RefineResult} */ ({ reason, outcome: 'cancelled', skipped: 'error', total: 0, done: 0, refined: 0, changedVerdicts: 0, changedTags: 0, nanoCalls: 0, failed: 0, models: [] });
      })
      .then(async (result) => {
        if (result.outcome !== 'skipped' || result.total > 0) {
          totals.passes += 1;
          totals.lastRunAt = now();
        }
        totals.refined += result.refined;
        totals.changedVerdicts += result.changedVerdicts;
        totals.changedTags += result.changedTags;
        totals.nanoCalls += result.nanoCalls;
        totals.failed += result.failed;
        totals.last = result;
        // Free the second model (the host also drops it after a while without use).
        if (result.total > 0 && result.models[1] && typeof system1.release === 'function') {
          try {
            await system1.release(result.models[1]);
          } catch {
            /* best effort */
          }
        }
        return result;
      })
      .finally(() => {
        if (running === p) running = null;
        live = null;
      });
    running = p;
    p.then((result) => progress({ running: false, finished: true, ...result }), () => {});
    return p;
  }

  return {
    run,
    /** The user is active again: stop after the batch in flight. */
    pause() {
      if (running) pauseRequested = true;
    },
    /** Configuration / prompt changed or a re-decide started: drop the batch in flight. */
    cancel() {
      version += 1;
    },
    get running() {
      return running !== null;
    },
    /** @returns {{ done: number, total: number }|null} progress of the running pass */
    get progress() {
      return live ? { ...live } : null;
    },
    stats() {
      return { ...totals, last: totals.last ? { ...totals.last } : null };
    },
    resetStats() {
      Object.assign(totals, { passes: 0, refined: 0, changedVerdicts: 0, changedTags: 0, nanoCalls: 0, nanoErrors: 0, failed: 0 });
    },
    /** Resolves when no pass is running. */
    async idle() {
      while (running) await running.catch(() => {});
    }
  };
}

/**
 * Starts refinement passes while the user is idle. The service worker registers the chrome.idle /
 * chrome.alarms listeners at top level (so they wake it) and forwards them here.
 *
 *  - onIdleState('idle'|'locked') starts (or resumes) a pass; 'active' pauses it after the batch in
 *    flight.
 *  - onAlarm() (REFINE_ALARM, every REFINE_ALARM_MINUTES) asks chrome.idle.queryState, so passes
 *    resume after a service-worker restart without a state change.
 *  - applySettings(refine) keeps chrome.idle's detection interval at refine.idleSeconds.
 *
 * @param {{
 *   refiner: ReturnType<typeof createRefiner>,
 *   idle?: { setDetectionInterval?: (s: number) => void, queryState?: (s: number) => Promise<string>|void } | null,
 *   alarms?: { create?: (name: string, info: object) => unknown, clear?: (name: string) => unknown } | null,
 *   getSettings: () => Promise<{ enabled: boolean, idleSeconds: number, nano: boolean }>,
 *   canRun?: () => boolean|Promise<boolean>
 * }} deps
 *   canRun: extra precondition (System 1 enabled, not in an error state, ...)
 */
export function createIdleTrigger({ refiner, idle = globalThis.chrome?.idle ?? null, alarms = globalThis.chrome?.alarms ?? null, getSettings, canRun = () => true }) {
  let interval = null;
  /** Last state chrome.idle reported. */
  let lastState = 'active';

  /** @param {{ enabled?: boolean, idleSeconds?: number }|null|undefined} refine */
  function applySettings(refine) {
    const seconds = Math.min(3600, Math.max(15, Math.round(Number(refine && refine.idleSeconds) || 60)));
    if (seconds !== interval && idle && typeof idle.setDetectionInterval === 'function') {
      try {
        idle.setDetectionInterval(seconds);
        interval = seconds;
      } catch {
        /* best effort */
      }
    }
    if (refine && refine.enabled === false) refiner.pause();
    return seconds;
  }

  /** @param {string} reason */
  async function trigger(reason) {
    const s = await getSettings();
    applySettings(s);
    if (!s || s.enabled === false) return null;
    if (!(await canRun())) return null;
    return refiner.run({ reason });
  }

  return {
    applySettings,
    /** Registers the periodic check (call on every service-worker start). */
    async start() {
      try {
        applySettings(await getSettings());
      } catch {
        /* defaults */
      }
      try {
        // Re-creating an alarm restarts its period, and the worker wakes far more often than every
        // REFINE_ALARM_MINUTES: create it only when it is missing.
        const existing = alarms && typeof alarms.get === 'function' ? await alarms.get(REFINE_ALARM) : null;
        if (!existing && alarms && typeof alarms.create === 'function') await alarms.create(REFINE_ALARM, { periodInMinutes: REFINE_ALARM_MINUTES });
      } catch {
        /* best effort */
      }
    },
    /** @param {string} state  chrome.idle.IdleState */
    onIdleState(state) {
      lastState = state;
      if (state === 'idle' || state === 'locked') return trigger('idle');
      if (state === 'active') refiner.pause();
      return Promise.resolve(null);
    },
    /** The periodic alarm: runs only when chrome.idle says the user is idle. */
    async onAlarm() {
      const s = await getSettings();
      const seconds = applySettings(s);
      if (!s || s.enabled === false || !idle || typeof idle.queryState !== 'function') return null;
      let state;
      try {
        state = await idle.queryState(seconds);
      } catch {
        return null;
      }
      lastState = state;
      if (state !== 'idle' && state !== 'locked') return null;
      return trigger('alarm');
    },
    /** A pass right away (side panel "Refine now"), idle or not. */
    runNow() {
      return trigger('manual');
    },
    get lastState() {
      return lastState;
    }
  };
}
