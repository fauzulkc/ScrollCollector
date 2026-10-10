/**
 * Message contract shared by every extension context.
 *
 * Routing rules (chrome.runtime.sendMessage reaches ALL extension contexts):
 *  - Messages for the offscreen document carry `target: 'offscreen'`; the background router ignores them.
 *  - Messages pushed by the offscreen document to the service worker carry `target: 'background'`.
 *  - Everything else (side panel -> background, background -> side panel broadcasts) has no target;
 *    the offscreen router ignores any message whose target is not 'offscreen'.
 *  - Content scripts run inside web pages and may send only CONTENT_SCRIPT_MESSAGES; the background
 *    router answers any other message from a non-extension-page sender with
 *    { success: false, code: 'forbidden' } (lib/bg/sender.js).
 *
 * Handlers always reply with an object. Failures reply `{ success: false, error, code? }`;
 * successes reply `{ success: true, ...data }` unless documented otherwise.
 */

export const TARGET = Object.freeze({
  OFFSCREEN: 'offscreen',
  BACKGROUND: 'background'
});

/** content script -> background */
export const MSG = Object.freeze({
  // --- content -> background ---
  /** payload: { text, postKey, postUrl, pageUrl, sourcePlatform, authorName, authorUrl, isAd, isUpdate, timestamp } -> { status:'queued'|'ignored', postKey, reason? } */
  TEXT_EXTRACTED: 'TEXT_EXTRACTED',
  /** -> { isTrackingPaused, sites, ignoredDomains, debugAnnotate } (content scripts cannot read storage.local) */
  GET_CONTENT_CONFIG: 'GET_CONTENT_CONFIG',

  // --- background -> content (chrome.tabs.sendMessage) ---
  PING: 'PING',
  RESET_AND_RESCAN: 'RESET_AND_RESCAN',
  /**
   * payload: { postKey, status:'collected'|'rejected'|'ignored'|'pending', reason?, tag?, pMatch? }
   * rejected reasons: '<provider>_no_match' | 'uncertain_skipped' | 'social_noise' | 'empty_text' |
   * 'hidden_by_prompt' (a re-send of a stored post the prompt hides)
   */
  DECISION_RESULT: 'DECISION_RESULT',
  /** payload: same shape as GET_CONTENT_CONFIG reply; pushed when content-relevant config changes */
  CONTENT_CONFIG_UPDATED: 'CONTENT_CONFIG_UPDATED',

  // --- side panel -> background: state & stack ---
  GET_STATE: 'GET_STATE',
  FAVORITE_TOGGLED: 'FAVORITE_TOGGLED',
  ITEM_DELETED: 'ITEM_DELETED',
  ITEM_RETAGGED: 'ITEM_RETAGGED',
  CLEAR_STACK: 'CLEAR_STACK',
  GET_CATEGORY_ITEMS: 'GET_CATEGORY_ITEMS',

  // --- side panel -> background: configuration ---
  CONFIG_CHANGED: 'CONFIG_CHANGED',
  TAG_TOGGLED: 'TAG_TOGGLED',
  TAG_ADDED: 'TAG_ADDED',
  TAG_REMOVED: 'TAG_REMOVED',
  TAG_PROMPT_UPDATED: 'TAG_PROMPT_UPDATED',
  TAG_PROMOTED: 'TAG_PROMOTED',
  TAG_STICKY_TOGGLED: 'TAG_STICKY_TOGGLED',
  GENERATE_TAG_EVAL_PROMPT: 'GENERATE_TAG_EVAL_PROMPT',
  TOGGLE_MATCH_PROMPT: 'TOGGLE_MATCH_PROMPT',
  UPDATE_MATCH_PROMPT: 'UPDATE_MATCH_PROMPT',
  GENERATE_PROMPT_TAGS: 'GENERATE_PROMPT_TAGS',
  SITE_TOGGLED: 'SITE_TOGGLED',
  SITE_ADDED: 'SITE_ADDED',
  SITE_REMOVED: 'SITE_REMOVED',
  KEYWORD_ADDED: 'KEYWORD_ADDED',
  KEYWORD_REMOVED: 'KEYWORD_REMOVED',
  IGNORE_TAG_ADDED: 'IGNORE_TAG_ADDED',
  IGNORE_TAG_REMOVED: 'IGNORE_TAG_REMOVED',
  IGNORE_DOMAIN_ADDED: 'IGNORE_DOMAIN_ADDED',
  IGNORE_DOMAIN_REMOVED: 'IGNORE_DOMAIN_REMOVED',
  IGNORE_LINK_ADDED: 'IGNORE_LINK_ADDED',
  IGNORE_LINK_REMOVED: 'IGNORE_LINK_REMOVED',
  IS_TRACKING_PAUSED_TOGGLED: 'IS_TRACKING_PAUSED_TOGGLED',

  // --- side panel -> background: intelligence ---
  /** -> EngineStatus (lib/decision/types.js) + legacy { tier, name, status } + warnings */
  GET_ENGINE_STATUS: 'GET_ENGINE_STATUS',
  /** payload: { patch } deep-merged into configuration.intelligence (null deletes a floor) -> { success, intelligence } */
  UPDATE_INTELLIGENCE_SETTINGS: 'UPDATE_INTELLIGENCE_SETTINGS',
  /** payload: { provider:'jev'|'openai', value } -> { success, secrets: describeSecrets() } */
  SET_SECRET: 'SET_SECRET',
  /** payload: { provider } -> { success, secrets } */
  CLEAR_SECRET: 'CLEAR_SECRET',
  /** payload: { provider:'system1'|'nano'|'jev'|'openai' } -> { success, ok, latencyMs, model, error?, code? } (error redacted) */
  TEST_PROVIDER: 'TEST_PROVIDER',
  /** -> { success, status } (starts loading the System 1 model; does not wait for it) */
  S1_ENSURE_LOADED: 'S1_ENSURE_LOADED',
  /** payload: { phase:'start'|'progress'|'done'|'error', loaded?, error? } (side panel drives the user-activated download) -> { success, status } */
  NANO_DOWNLOAD_STATE: 'NANO_DOWNLOAD_STATE',
  /** payload: { scope:'all'|'prompt'|'rules-only' } -> { success, jobId }; progress as REDECIDE_PROGRESS */
  REDECIDE_STACK: 'REDECIDE_STACK',
  /** -> { success, engineStatus, rejected:[{ at, platform, snippet, pMatch, path, reason }], budget, cache:{ size, hits, misses }, providers:{ system1, nano, jev, openai }, secrets:{ jev:{set,last4}, openai:{set,last4} } } */
  GET_DIAGNOSTICS: 'GET_DIAGNOSTICS',
  /** -> { success } (decision counters, provider statistics, cache counters) */
  RESET_DIAGNOSTICS: 'RESET_DIAGNOSTICS',

  // --- background -> side panel broadcasts ---
  /** payload: whitelisted state { configuration, metrics, stack, telemetry } (never secrets) */
  STATE_UPDATED: 'STATE_UPDATED',
  /** payload: { count } */
  INFLIGHT_UPDATED: 'INFLIGHT_UPDATED',
  /** payload: EngineStatus (lib/decision/types.js) */
  ENGINE_STATUS: 'ENGINE_STATUS',
  /** payload: { jobId, done, total, hidden, finished } */
  REDECIDE_PROGRESS: 'REDECIDE_PROGRESS',
  /** payload: { level:'info'|'warn'|'error', text, key? } */
  TOAST: 'TOAST',

  // --- background <-> offscreen (target: 'offscreen' / 'background') ---
  OFFSCREEN_PING: 'OFFSCREEN_PING',
  /** payload: { model, device, dtype } -> { ok, device, loadMs, error? } */
  S1_LOAD: 'S1_LOAD',
  /** payload: { items:[{id,text}], spec } -> { ok, results:[{ id, answers, ms }], error? } */
  S1_DECIDE: 'S1_DECIDE',
  /** payload: { texts, isQuery } -> { ok, vectors:number[][] } (diagnostics / parity tests only) */
  S1_EMBED: 'S1_EMBED',
  S1_CLEAR_CACHE: 'S1_CLEAR_CACHE',
  S1_UNLOAD: 'S1_UNLOAD',
  /** offscreen -> background push: { status, progress?, device?, model?, error? } */
  S1_STATUS: 'S1_STATUS'
});

/** The only background messages a content script may send. */
export const CONTENT_SCRIPT_MESSAGES = Object.freeze([MSG.TEXT_EXTRACTED, MSG.GET_CONTENT_CONFIG]);

/** Keys of chrome.storage.local that may leave the service worker (GET_STATE / STATE_UPDATED). */
export const BROADCAST_STATE_KEYS = Object.freeze(['configuration', 'metrics', 'stack', 'telemetry']);

/** Top-level storage key holding API keys. Never broadcast, exported or logged. */
export const SECRETS_KEY = 'secrets';
