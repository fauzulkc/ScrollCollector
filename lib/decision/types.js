/**
 * Decision layer contracts.
 *
 * Every provider (local System 1 embeddings, the browser's built-in LanguageModel, TypeSafe Jev,
 * OpenAI, rules) answers the same typed questions modelled on Jev's primitives
 * (https://docs.typesafe.ai/primitives): noul (yes/no probability), choice (one of N), score (ordered levels).
 * This file is documentation-only (JSDoc typedefs) plus a few tiny constructors used everywhere.
 */

/**
 * @typedef {object} NoulQuestion
 * @property {'noul'} type
 * @property {string} instructions          Literal, direct yes/no condition (no negation).
 * @property {{ true?: string, false?: string }} [criteria]
 */

/**
 * @typedef {object} ChoiceQuestion
 * @property {'choice'} type
 * @property {string} instructions
 * @property {Record<string, string|null>} criteria   option -> description (max 255). Always includes 'none'.
 */

/**
 * @typedef {object} ScoreQuestion
 * @property {'score'} type
 * @property {string} instructions
 * @property {string[]} criteria            Ordered levels, low -> high (2..10).
 */

/** @typedef {NoulQuestion|ChoiceQuestion|ScoreQuestion} Question */

/**
 * Well-known question ids used by the pipeline.
 *  - matches_prompt : noul  — does the post match the user's global prompt? (only when the gate is on)
 *  - primary_tag    : choice — which enabled tag best describes the post ('none' => Unclassified)
 *  - tag:<label>    : noul  — optional multi-label check for a specific tag
 */
export const Q = Object.freeze({
  MATCHES_PROMPT: 'matches_prompt',
  PRIMARY_TAG: 'primary_tag',
  TAG_PREFIX: 'tag:'
});

/**
 * @typedef {object} NoulAnswer
 * @property {'noul'} type
 * @property {number} noul                  P(yes) in [0,1]
 * @property {number} confidence            |2p-1|
 * @property {string} source                provider id that produced it
 */

/**
 * @typedef {object} ChoiceAnswer
 * @property {'choice'} type
 * @property {string|null} choice           selected option; null when 'none'
 * @property {Record<string, number>} probabilities   sums to 1, includes 'none'
 * @property {number} confidence            (pmax - 1/n) / (1 - 1/n)
 * @property {string} source
 */

/**
 * @typedef {object} ScoreAnswer
 * @property {'score'} type
 * @property {number} score
 * @property {Record<string, number>} probabilities
 * @property {number} confidence
 * @property {string} source
 */

/** @typedef {NoulAnswer|ChoiceAnswer|ScoreAnswer} Answer */

/**
 * State sent to a provider for one post.
 * @typedef {object} DecisionState
 * @property {string} text                  normalizeForDecision() output (sanitized, NFKC, <=1500 chars,
 *                                          without content.js's author/attribution lines)
 * @property {string} textHash
 * @property {string} platform              e.g. 'linkedin.com'
 * @property {string} [author]              only sent to cloud when intelligence.escalation.sendAuthor
 */

/**
 * @typedef {object} ProviderDecideRequest
 * @property {DecisionState} state
 * @property {Record<string, Question>} questions
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {object} ProviderDecideResult
 * @property {Record<string, Answer>} answers
 * @property {string} provider              provider id
 * @property {string} [model]
 * @property {number} latencyMs
 * @property {{ input_tokens?: number, output_tokens?: number, costUsd?: number }} [usage]
 */

/**
 * Common provider interface (escalators and rules). System 1 adds decideBatch().
 * @typedef {object} DecisionProvider
 * @property {'system1'|'nano'|'jev'|'openai'|'rules'} id
 * @property {string} displayName
 * @property {boolean} isCloud
 * @property {() => Promise<boolean>} isReady
 * @property {() => ProviderStatus} status
 * @property {(req: ProviderDecideRequest) => Promise<ProviderDecideResult>} decide
 * @property {number} [maxConcurrency]      escalator calls in flight at once (cascade default: cloud 4, local 1)
 * @property {number} [timeoutMs]           longest a decide() takes; the cascade aborts it after this plus a grace period
 */

/**
 * @typedef {object} ProviderStatus
 * @property {'ready'|'loading'|'downloadable'|'downloading'|'unavailable'|'no_key'|'cloud_not_allowed'|'auth_error'|'rate_limited'|'offline'|'error'|'disabled'} state
 * @property {string} [detail]
 * @property {string} [lastError]
 * @property {number} [progress]            0..1 for loading/downloading
 * @property {string} [paused]              why a ready provider is skipped for now (e.g. 'timeout'); isReady() is false meanwhile
 */

/**
 * Persisted on every stack item as item.decision.
 * @typedef {object} ItemDecision
 * @property {1} v
 * @property {number} promptVersion
 * @property {string} specHash
 * @property {string[]} path                e.g. ['system1'] | ['prefilter'] | ['system1','jev'] | ['rules'] | [...,'cache']
 * @property {string} provider              provider that made the final call (display id)
 * @property {number|null} pMatch           P(matches prompt); null when gate off
 * @property {number|null} matchConfidence
 * @property {string} tag                   assigned tag label or 'Unclassified'
 * @property {number|null} tagConfidence
 * @property {{ name: string, score: number }[]} tags
 * @property {boolean} escalated
 * @property {boolean} uncertain            true when still below the floor after the cascade
 * @property {string|null} reason           why escalation did not happen / failure code
 * @property {boolean} collect              final gate verdict
 * @property {number} latencyMs
 * @property {number} at                    epoch ms
 */

/**
 * The function ingest, the idle retry and the re-decide pass call: lib/decision/cascade.js
 * decideMany(), composed by lib/bg/decision-runtime.js.
 * @callback DecideMany
 * @param {{ id: string, text: string, platform: string, author?: string }[]} items
 * @param {DecideContext} ctx
 * @returns {Promise<ItemDecision[]>}   same order/length as items
 */

/**
 * @typedef {object} DecideContext
 * @property {object} configuration         current configuration (read-only snapshot)
 * @property {number} promptVersion
 * @property {boolean} gateOn               configuration.isMatchPromptEnabled && prompt non-empty
 * @property {'ingest'|'redecide'|'retry'} purpose   redecide never escalates and retry never escalates to
 *                                          cloud unless intelligence.escalation.allowRedecideEscalation
 */

/**
 * Pushed to the side panel as ENGINE_STATUS and returned by GET_ENGINE_STATUS.
 * @typedef {object} EngineStatus
 * @property {{ level: 'checking'|'loading'|'ok'|'warn'|'error', label: string, title: string }} badge
 *           checking = grey (status unknown), loading = amber (System 1 loading), ok = green
 * @property {ProviderStatus & { model?: string, device?: string, lastLatencyMs?: number }} system1
 * @property {ProviderStatus & { present: 'sw'|'offscreen'|'none', availability?: string }} nano
 * @property {{ provider: 'none'|'nano'|'jev'|'openai', status: ProviderStatus, budget?: object }} escalation
 * @property {{ decided: number, bySource: Record<string, number>, escalated: number, escalationRate: number, avgMs: number, p95Ms: number }} counters
 * @property {string[]} warnings            e.g. 'empty_prompt', 'gate_off_with_prompt'
 */

/**
 * @param {number} p
 * @param {string} source
 * @returns {NoulAnswer}
 */
export function noulAnswer(p, source) {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(p) ? p : 0.5));
  return { type: 'noul', noul: clamped, confidence: Math.abs(2 * clamped - 1), source };
}
