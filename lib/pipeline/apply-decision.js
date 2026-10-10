/**
 * apply-decision.js
 *
 * Shared glue between a DecideMany implementation (lib/decision/types.js) and stored stack items:
 * decide contexts, decision sanitising, back-compat matchInfo and the opt-in dynamic tags.
 */

import { ADS_TAG, UNCLASSIFIED } from '../bg/stack-utils.js';
import { selectQuestionTags } from '../decision/questions.js';
import { stableStringify } from '../decision/state.js';
import { resolveIntelligence } from '../storage/schema.js';

/** Display names for provider ids (matchInfo.engine keeps a human-readable engine name). */
export const PROVIDER_DISPLAY_NAMES = Object.freeze({
  rules: 'Rule-based Classifier',
  prefilter: 'Prefilter',
  system1: 'System 1 (local embeddings)',
  nano: 'Gemini Nano',
  jev: 'TypeSafe Jev',
  openai: 'OpenAI',
  manual: 'Manual Override',
  error: 'Rule-based Classifier'
});

/** Most dynamic tags kept at once (matches the old limit). */
export const MAX_DYNAMIC_TAGS = 10;

/** @param {string} provider */
export function displayNameFor(provider) {
  return PROVIDER_DISPLAY_NAMES[provider] || provider || PROVIDER_DISPLAY_NAMES.rules;
}

/**
 * @param {object} configuration
 * @returns {boolean} gate on AND a non-empty prompt (a gate with an empty prompt lets posts through)
 */
export function isGateOn(configuration) {
  return !!(configuration && configuration.isMatchPromptEnabled && String(configuration.matchPrompt || '').trim());
}

/**
 * Prompt-related warnings surfaced to the panel (GET_ENGINE_STATUS.warnings).
 *
 * @param {object} configuration
 * @returns {string[]}
 */
export function promptWarnings(configuration) {
  const cfg = configuration || {};
  const hasPrompt = !!String(cfg.matchPrompt || '').trim();
  const warnings = [];
  if (cfg.isMatchPromptEnabled && !hasPrompt) warnings.push('empty_prompt');
  if (!cfg.isMatchPromptEnabled && hasPrompt) warnings.push('gate_off_with_prompt');
  return warnings;
}

/**
 * Everything in the configuration a stored verdict depends on besides the post: the gate, the
 * prompt (its version, text, expansion, enhancement and prompt tags; only while the gate is on),
 * the tags a classifier is offered, and the System 1 model / gate policy. These are exactly the
 * settings whose change starts or schedules a re-decide of the stored stack.
 *
 * A decision computed outside the state lock is committed only while this is unchanged: a batch
 * decided for an older configuration would otherwise land after the re-decide job took its
 * snapshot, and nothing would ever correct it.
 *
 * @param {object} configuration
 * @returns {string}
 */
export function decisionFingerprint(configuration) {
  const cfg = configuration && typeof configuration === 'object' ? configuration : {};
  const gateOn = isGateOn(cfg);
  let intel;
  try {
    intel = resolveIntelligence(cfg);
  } catch {
    intel = resolveIntelligence(null);
  }
  const promptTags = Array.isArray(cfg.matchPromptTags)
    ? cfg.matchPromptTags.map(t => (typeof t === 'string' ? t : (t && typeof t.name === 'string' ? t.name : '')))
    : [];
  return stableStringify([
    gateOn,
    gateOn && Number.isFinite(cfg.promptVersion) ? cfg.promptVersion : 0,
    gateOn ? String(cfg.matchPrompt || '').trim() : '',
    gateOn ? String(cfg.matchPromptExpansion || '') : '',
    gateOn ? String(cfg.matchPromptEnhanced || '') : '',
    gateOn ? promptTags : [],
    selectQuestionTags(cfg.trackedTags).map(t => [t.label, t.description]),
    intel.system1 ? [intel.system1.enabled !== false, intel.system1.model || ''] : [],
    intel.gate ? [intel.gate.strictness || '', intel.gate.whenUnsure || ''] : [],
    intel.escalation && intel.escalation.floor ? intel.escalation.floor : null
  ]);
}

/**
 * @param {object} configuration
 * @param {'ingest'|'redecide'|'retry'} purpose
 * @returns {import('../decision/types.js').DecideContext}
 */
export function decideContext(configuration, purpose) {
  const cfg = configuration || {};
  return {
    configuration: cfg,
    promptVersion: Number.isFinite(cfg.promptVersion) ? cfg.promptVersion : 0,
    gateOn: purpose === 'retry' ? false : isGateOn(cfg),
    purpose
  };
}

/**
 * Tags offered to a classifier: enabled, not the 'Ads' pseudo-tag.
 *
 * @param {object[]} trackedTags
 */
export function classifiableTags(trackedTags) {
  return (trackedTags || []).filter(t => t && t.isEnabled && t.label && t.label !== ADS_TAG && !t.isPseudo);
}

/**
 * Decision used when a DecideMany call failed or returned nothing for an item.
 *
 * @param {import('../decision/types.js').DecideContext} ctx
 * @param {string} reason
 * @param {number} now
 * @returns {import('../decision/types.js').ItemDecision}
 */
export function fallbackDecision(ctx, reason, now) {
  return {
    v: 1,
    promptVersion: ctx.promptVersion,
    specHash: '',
    path: ['error'],
    provider: 'rules',
    pMatch: null,
    matchConfidence: null,
    tag: UNCLASSIFIED,
    tagConfidence: null,
    tags: [],
    escalated: false,
    uncertain: true,
    reason,
    // Without a verdict, collect only when no gate is filtering.
    collect: !ctx.gateOn,
    latencyMs: 0,
    at: now
  };
}

/**
 * Fills defaults so a partial provider result can be stored safely.
 *
 * @param {any} d
 * @param {import('../decision/types.js').DecideContext} ctx
 * @param {number} now
 */
export function sanitizeDecision(d, ctx, now) {
  if (!d || typeof d !== 'object') return fallbackDecision(ctx, 'decide_missing', now);
  const tags = Array.isArray(d.tags)
    ? d.tags.filter(t => t && typeof t.name === 'string' && t.name !== ADS_TAG)
      .map(t => ({ name: t.name, score: Number.isFinite(t.score) ? t.score : 1 }))
    : [];
  const tag = typeof d.tag === 'string' && d.tag && d.tag !== ADS_TAG ? d.tag : (tags[0] ? tags[0].name : UNCLASSIFIED);
  return {
    v: 1,
    promptVersion: Number.isFinite(d.promptVersion) ? d.promptVersion : ctx.promptVersion,
    specHash: typeof d.specHash === 'string' ? d.specHash : '',
    path: Array.isArray(d.path) ? d.path.slice() : [],
    provider: typeof d.provider === 'string' && d.provider ? d.provider : 'rules',
    pMatch: Number.isFinite(d.pMatch) ? d.pMatch : null,
    matchConfidence: Number.isFinite(d.matchConfidence) ? d.matchConfidence : null,
    tag,
    tagConfidence: Number.isFinite(d.tagConfidence) ? d.tagConfidence : null,
    tags,
    escalated: !!d.escalated,
    uncertain: !!d.uncertain,
    reason: typeof d.reason === 'string' ? d.reason : null,
    collect: d.collect !== false,
    latencyMs: Number.isFinite(d.latencyMs) ? d.latencyMs : 0,
    at: Number.isFinite(d.at) ? d.at : now,
    ...(d.meta && typeof d.meta === 'object' ? { meta: d.meta } : {})
  };
}

/**
 * Why a post was rejected, for the page annotation (DECISION_RESULT reason) and the rejection log.
 * A decision's own `reason` is a cascade note (why it did not escalate, a provider failure), not the
 * verdict, so it is only used for prefilter rejections ('social_noise', 'empty_text'):
 *  - 'uncertain_skipped'      a model was unsure and gate.whenUnsure is 'skip'
 *  - '<provider>_no_match'    e.g. 'system1_no_match', 'jev_no_match', 'rules_no_match'
 *
 * @param {object} d   sanitised decision
 * @returns {string}
 */
export function rejectionReason(d) {
  const path = Array.isArray(d && d.path) ? d.path : [];
  if (path.includes('prefilter')) return (d && d.reason) || 'social_noise';
  const provider = (d && typeof d.provider === 'string' && d.provider) || 'rules';
  if (d && d.uncertain && provider !== 'rules' && provider !== 'prefilter') return 'uncertain_skipped';
  return `${provider === 'error' ? 'rules' : provider}_no_match`;
}

/**
 * The persisted ItemDecision (adapter-only `meta` stripped).
 *
 * @param {object} d
 */
export function persistedDecision(d) {
  const { meta, ...rest } = d;
  return rest;
}

/**
 * matchInfo kept for the current side panel: { engine, globalEngine, globalMatchPrompt, ... }.
 *
 * @param {object} d            sanitised decision (may carry meta)
 * @param {object} configuration
 * @param {boolean} gateOn
 */
export function buildMatchInfo(d, configuration, gateOn) {
  const meta = d.meta || {};
  const engine = meta.engine || displayNameFor(d.provider);
  const info = { engine };
  // Gate details describe a match; a re-label that kept a non-matching item does not claim one.
  if (gateOn && d.collect !== false) {
    info.globalEngine = meta.gateEngine || engine;
    info.globalMatchPrompt = (configuration && configuration.matchPrompt) || '';
    if (Array.isArray(meta.globalMatchedKeywords) && meta.globalMatchedKeywords.length) {
      info.globalMatchedKeywords = meta.globalMatchedKeywords.slice();
    }
    if (Array.isArray(meta.globalMatchedPhrases) && meta.globalMatchedPhrases.length) {
      info.globalMatchedPhrases = meta.globalMatchedPhrases.slice();
    }
  }
  if (Array.isArray(meta.matchedKeywords) && meta.matchedKeywords.length) {
    info.matchedKeywords = meta.matchedKeywords.slice();
  }
  return info;
}

/**
 * Opt-in dynamic tags (configuration.intelligence.dynamicTags === true): an Unclassified post whose
 * decision proposed a new topic gets that topic as its tag, minting it if there is room.
 *
 * @param {object[]} trackedTags   fresh tag list (not mutated)
 * @param {object} d               sanitised decision
 * @param {object} configuration
 * @param {boolean} gateOn
 * @param {() => string} makeId
 * @returns {{ tag: string, newTag: object|null }}
 */
export function resolveDynamicTag(trackedTags, d, configuration, gateOn, makeId) {
  const proposed = d.meta && typeof d.meta.dynamicTag === 'string' ? d.meta.dynamicTag.trim() : '';
  const enabled = !!(configuration && configuration.intelligence && configuration.intelligence.dynamicTags === true);
  if (d.tag !== UNCLASSIFIED || !proposed || !enabled || gateOn || proposed === ADS_TAG) {
    return { tag: d.tag, newTag: null };
  }
  const existing = (trackedTags || []).find(t => t && t.label && t.label.toLowerCase() === proposed.toLowerCase());
  if (existing) {
    return { tag: existing.isEnabled ? existing.label : UNCLASSIFIED, newTag: null };
  }
  const dynamicCount = (trackedTags || []).filter(t => t && t.isDynamic).length;
  if (dynamicCount >= MAX_DYNAMIC_TAGS) return { tag: UNCLASSIFIED, newTag: null };
  return {
    tag: proposed,
    newTag: { id: makeId(), label: proposed, isEnabled: true, isDynamic: true, isSticky: false }
  };
}
