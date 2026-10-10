/**
 * Human-readable views of a stack item's decision (item.decision, lib/decision/types.js
 * ItemDecision), with a fallback to the legacy item.matchInfo for items collected before the
 * decision cascade. Used by the card tooltip and the exports.
 */
import { formatMs, formatPct, formatProb } from './util.js';

/** Display names for provider / path ids (same names as lib/decision/engine-status.js). */
export const PROVIDER_LABELS = Object.freeze({
  system1: 'System 1',
  nano: 'Gemini Nano',
  jev: 'TypeSafe Jev',
  openai: 'OpenAI',
  rules: 'Rules',
  prefilter: 'Prefilter',
  cache: 'Cache',
  manual: 'Manual',
  error: 'Fallback'
});

/** Reason codes written by lib/decision/cascade.js and the providers. */
export const REASON_TEXT = Object.freeze({
  provider_none: 'no escalation provider selected',
  provider_unavailable: 'escalation provider unavailable',
  provider_disabled: 'escalation provider turned off',
  cloud_not_allowed: 'cloud provider not allowed',
  cloud_needs_system1: 'cloud escalation needs System 1',
  redecide_no_escalation: 're-check without escalation',
  retry_no_cloud: 'retry without cloud escalation',
  budget_exceeded: 'escalation budget used up',
  escalation_error: 'escalation failed',
  empty_text: 'no text to decide',
  s1_disabled: 'System 1 turned off',
  s1_unavailable: 'System 1 unavailable',
  s1_missing: 'System 1 returned no answer',
  s1_error: 'System 1 failed',
  s1_timeout: 'System 1 timed out',
  no_key: 'no API key saved',
  auth_error: 'API key rejected',
  rate_limited: 'rate limited',
  overloaded: 'provider overloaded',
  offline: 'offline',
  timeout: 'timed out',
  loading: 'model still loading',
  downloadable: 'model not downloaded',
  downloading: 'model downloading',
  unavailable: 'unavailable',
  disabled: 'turned off',
  decide_missing: 'no decision returned',
  error: 'error',
  // Rejection reasons (lib/pipeline/apply-decision.js rejectionReason)
  system1_no_match: 'does not match the prompt (System 1)',
  nano_no_match: 'does not match the prompt (Gemini Nano)',
  jev_no_match: 'does not match the prompt (TypeSafe Jev)',
  openai_no_match: 'does not match the prompt (OpenAI)',
  rules_no_match: 'does not match the prompt (rules)',
  uncertain_skipped: 'unsure, skipped',
  hidden_by_prompt: 'hidden by the prompt',
  social_noise: 'social-feed noise'
});

/** @param {unknown} v */
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** @param {unknown} id */
export function providerLabel(id) {
  if (typeof id !== 'string' || !id) return 'Unknown';
  return PROVIDER_LABELS[id] || id;
}

/** @param {unknown} code */
export function reasonText(code) {
  if (typeof code !== 'string' || !code) return '';
  return REASON_TEXT[code] || code.replace(/_/g, ' ');
}

/**
 * @typedef {object} DecisionFacts
 * @property {'decision'|'manual'|'legacy'|'none'} kind
 * @property {boolean} manual
 * @property {string} provider
 * @property {string} providerLabel
 * @property {string[]} path
 * @property {string} pathLabel
 * @property {number|null} pMatch
 * @property {number|null} matchConfidence
 * @property {number|null} tagConfidence
 * @property {boolean} escalated
 * @property {boolean} uncertain
 * @property {string|null} reason
 * @property {number|null} latencyMs
 * @property {string} engine          legacy matchInfo.engine
 */

/**
 * @param {any} item
 * @returns {DecisionFacts}
 */
export function decisionFacts(item) {
  const it = item && typeof item === 'object' ? item : {};
  const mi = it.matchInfo && typeof it.matchInfo === 'object' ? it.matchInfo : {};
  const d = it.decision && typeof it.decision === 'object' ? it.decision : null;
  const manual = !!mi.manual;
  const engine = typeof mi.engine === 'string' ? mi.engine : '';
  if (!d) {
    return {
      kind: manual ? 'manual' : (engine ? 'legacy' : 'none'),
      manual,
      provider: manual ? 'manual' : '',
      providerLabel: manual ? PROVIDER_LABELS.manual : engine,
      path: [],
      pathLabel: '',
      pMatch: null,
      matchConfidence: null,
      tagConfidence: null,
      escalated: false,
      uncertain: false,
      reason: null,
      latencyMs: null,
      engine
    };
  }
  const path = Array.isArray(d.path) ? d.path.filter((p) => typeof p === 'string' && p) : [];
  const provider = typeof d.provider === 'string' ? d.provider : '';
  return {
    kind: manual ? 'manual' : 'decision',
    manual,
    provider,
    providerLabel: providerLabel(provider),
    path,
    pathLabel: path.map(providerLabel).join(' → '),
    pMatch: finite(d.pMatch),
    matchConfidence: finite(d.matchConfidence),
    tagConfidence: finite(d.tagConfidence),
    escalated: !!d.escalated,
    uncertain: !!d.uncertain,
    reason: typeof d.reason === 'string' && d.reason ? d.reason : null,
    latencyMs: finite(d.latencyMs),
    engine
  };
}

/**
 * The confidence of the verdict that mattered: the prompt match when the gate decided, else the tag.
 * @param {DecisionFacts} f
 */
export function primaryConfidence(f) {
  return f.pMatch !== null ? f.matchConfidence : f.tagConfidence;
}

/**
 * "Decided by" value: provider label, 'Manual', or the legacy engine name.
 * @param {any} item
 */
export function decidedBy(item) {
  const f = decisionFacts(item);
  if (f.manual) return PROVIDER_LABELS.manual;
  if (f.kind === 'decision') return f.providerLabel;
  return f.engine;
}

/**
 * One line, e.g. "System 1 → TypeSafe Jev (escalated) · p(match) 0.92 · confidence 84% · 310 ms".
 * @param {any} item
 */
export function decisionLine(item) {
  const f = decisionFacts(item);
  if (f.manual) return 'Tag set manually';
  if (f.kind === 'legacy') return `Classified by ${f.engine}`;
  if (f.kind !== 'decision') return '';
  const parts = [];
  const who = f.path.length > 1 ? f.pathLabel : f.providerLabel;
  parts.push(`Decided by ${who}${f.escalated ? ' (escalated)' : ''}`);
  if (f.pMatch !== null) parts.push(`p(match) ${formatProb(f.pMatch)}`);
  const conf = primaryConfidence(f);
  if (conf !== null) parts.push(`confidence ${formatPct(conf)}`);
  if (f.latencyMs !== null && f.latencyMs > 0) parts.push(formatMs(f.latencyMs));
  if (f.reason) parts.push(reasonText(f.reason));
  return parts.join(' · ');
}

/**
 * Multi-line tooltip for a feed card.
 * @param {any} item
 * @returns {string}
 */
export function decisionTooltip(item) {
  const f = decisionFacts(item);
  const mi = item && item.matchInfo && typeof item.matchInfo === 'object' ? item.matchInfo : {};
  /** @type {string[]} */
  const lines = [];
  if (f.manual) {
    lines.push('Tag set manually.');
    return lines.join('\n');
  }
  if (f.kind === 'decision') {
    lines.push(`Decided by: ${f.providerLabel}${f.escalated ? ' (escalated)' : ''}`);
    if (f.path.length) lines.push(`Path: ${f.pathLabel}`);
    if (f.pMatch !== null) {
      lines.push(`P(match): ${formatProb(f.pMatch)}${f.matchConfidence !== null ? ` · confidence ${formatPct(f.matchConfidence)}` : ''}`);
    } else {
      lines.push('Prompt filter: off');
    }
    if (f.tagConfidence !== null) lines.push(`Tag confidence: ${formatPct(f.tagConfidence)}`);
    if (f.latencyMs !== null) lines.push(`Latency: ${formatMs(f.latencyMs)}`);
    lines.push(`Escalated: ${f.escalated ? 'yes' : 'no'}`);
    if (f.reason) lines.push(`Note: ${reasonText(f.reason)}`);
    if (f.uncertain) lines.push('Still uncertain after all checks.');
    if (item && item.hiddenByPrompt) lines.push('Hidden: no longer matches the prompt.');
    return lines.join('\n');
  }
  if (f.kind === 'legacy') {
    lines.push(`Classified using: ${f.engine}`);
    if (mi.globalMatchPrompt) lines.push(`Prompt: "${mi.globalMatchPrompt}"`);
    if (Array.isArray(mi.globalMatchedPhrases) && mi.globalMatchedPhrases.length) {
      lines.push(`Matched phrase(s): ${mi.globalMatchedPhrases.map((p) => `'${p}'`).join(', ')}`);
    }
    if (Array.isArray(mi.globalMatchedKeywords) && mi.globalMatchedKeywords.length) {
      lines.push(`Matched keyword(s): ${mi.globalMatchedKeywords.map((k) => `'${k}'`).join(', ')}`);
    }
    if (Array.isArray(mi.matchedKeywords) && mi.matchedKeywords.length) {
      lines.push(`Tag keyword(s): ${mi.matchedKeywords.map((k) => `'${k}'`).join(', ')}`);
    }
  }
  return lines.join('\n');
}
