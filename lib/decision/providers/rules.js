/**
 * Rules decision provider: the keyword engine of lib/inference-engine.js behind the common
 * DecisionProvider interface. It is the last resort of the cascade (only fills answers no model
 * produced) and the prefilter for social noise.
 *
 * Its answers are deliberately low-confidence: matches_prompt is scoreRuleBasedEvalMatch's pMatch
 * (0.2 / 0.4 / 0.65 / 0.75 / 0.85 for 0 / 1 / 2 / 3 / 4+ distinct prompt concepts, 0.5 when the prompt
 * has no usable terms), so it never looks like a confident model verdict and the strictness
 * threshold (0.3 / 0.5 / 0.7) still separates "one concept" from "two or more".
 */
import {
  keywordFallback,
  scoreRuleBasedEvalMatch,
  isSocialNoise,
  normalizeForMatch,
  normalizeTagList
} from '../../inference-engine.js';
import { Q } from '../types.js';
import { LENS_MAIN_ID, isLensQuestionId, lensQuestionId } from '../lenses.js';
import { normalizeDistribution, argmax, choiceConfidence } from '../confidence.js';

/** Fallbacks when the rules engine reports no pMatch. */
export const RULES_MATCH_P = 0.7;
export const RULES_NO_MATCH_P = 0.3;

// primary_tag weights before normalization: a keyword hit dominates, no hit makes 'none' win.
const BASE_WEIGHT = 0.05;
const HIT_WEIGHT = 2;
const HIT_SCORE_WEIGHT = 3;
const NONE_WEIGHT_WITH_HITS = 0.5;
const NONE_WEIGHT_NO_HITS = 3;

/**
 * The raw prompt quoted in a matches_prompt question ('… Reader request: "<raw>"').
 * @param {import('../types.js').Question|undefined} question
 */
function promptFromQuestion(question) {
  const m = /Reader request: "([^"]*)"\s*$/.exec(question?.instructions || '');
  return m ? m[1] : '';
}

/**
 * @param {string} text
 * @param {string} prompt
 * @param {unknown} promptTags
 * @returns {import('../types.js').NoulAnswer}
 */
export function rulesMatchAnswer(text, prompt, promptTags) {
  const res = scoreRuleBasedEvalMatch(normalizeForMatch(text), String(prompt || ''), normalizeTagList(promptTags));
  const reported = res?.pMatch;
  const p = typeof reported === 'number' && Number.isFinite(reported)
    ? Math.min(1, Math.max(0, reported))
    : res?.doesMatch ? RULES_MATCH_P : RULES_NO_MATCH_P;
  return { type: 'noul', noul: p, confidence: Math.abs(2 * p - 1), source: 'rules' };
}

/**
 * Keyword scores over a choice question's options (option descriptions feed extra keywords),
 * turned into probabilities that include 'none'.
 *
 * @param {string} text
 * @param {Record<string, string|null>} criteria
 * @returns {import('../types.js').ChoiceAnswer}
 */
export function rulesChoiceAnswer(text, criteria) {
  const options = Object.keys(criteria || {}).filter((k) => k !== 'none');
  const enabled = options.map((label) => ({ label, prompt: typeof criteria[label] === 'string' ? criteria[label] : '' }));
  const hits = options.length ? keywordFallback(normalizeForMatch(text), enabled)?.tags || [] : [];
  /** @type {Record<string, number>} */
  const weights = {};
  for (const label of options) weights[label] = BASE_WEIGHT;
  for (const t of hits) {
    if (Object.prototype.hasOwnProperty.call(weights, t.name)) {
      weights[t.name] = HIT_WEIGHT + HIT_SCORE_WEIGHT * (Number.isFinite(t.score) ? t.score : 1);
    }
  }
  weights.none = hits.length ? NONE_WEIGHT_WITH_HITS : NONE_WEIGHT_NO_HITS;
  const probabilities = normalizeDistribution(weights);
  const best = argmax(probabilities);
  return {
    type: 'choice',
    choice: best === 'none' ? null : best,
    probabilities,
    confidence: choiceConfidence(probabilities),
    source: 'rules'
  };
}

/**
 * Social-feed noise (notifications, connection boilerplate, very short snippets).
 * @param {string} text
 */
export function isNoise(text) {
  return isSocialNoise(normalizeForMatch(text));
}

/**
 * @typedef {object} RulesContext
 * @property {string} [prompt]       raw global prompt (else parsed from the matches_prompt question)
 * @property {unknown} [promptTags]  configuration.matchPromptTags (strings or v0.9 {name, weight})
 */

/**
 * @returns {import('../types.js').DecisionProvider & { isNoise: (text: string) => boolean }}
 */
export function createRulesProvider() {
  return {
    id: 'rules',
    displayName: 'Rules',
    isCloud: false,
    isReady: async () => true,
    status: () => ({ state: 'ready' }),
    isNoise,
    /**
     * @param {import('../types.js').ProviderDecideRequest & { context?: RulesContext }} req
     * @returns {Promise<import('../types.js').ProviderDecideResult>}
     */
    async decide({ state, questions, context = {} }) {
      const t0 = Date.now();
      const text = state?.text || '';
      /** @type {Record<string, import('../types.js').Answer>} */
      const answers = {};
      for (const [id, q] of Object.entries(questions || {})) {
        if (id === Q.MATCHES_PROMPT && q?.type === 'noul') {
          answers[id] = rulesMatchAnswer(text, context.prompt ?? promptFromQuestion(q), context.promptTags);
        } else if (isLensQuestionId(id) && q?.type === 'noul') {
          // A lens is a prompt scored like matches_prompt: the keyword engine reads the prompt quoted
          // in its question. Only the match prompt has prompt tags.
          answers[id] = rulesMatchAnswer(text, promptFromQuestion(q), id === lensQuestionId(LENS_MAIN_ID) ? context.promptTags : undefined);
        } else if (q?.type === 'choice') {
          answers[id] = rulesChoiceAnswer(text, q.criteria);
        }
      }
      return { answers, provider: 'rules', model: 'keywords', latencyMs: Date.now() - t0 };
    }
  };
}
