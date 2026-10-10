/**
 * Shared types and helpers for background message handlers.
 */

/**
 * @typedef {object} HandlerDeps
 * @property {ReturnType<import('../store.js').createStore>} store
 * @property {ReturnType<import('../broadcast.js').createBroadcaster>} broadcast
 * @property {ReturnType<import('../../pipeline/ingest.js').createIngest>} ingest
 * @property {{ trigger: () => void }} relabel   deprecated: used only when `redecide` is absent
 * @property {{
 *   start: (opts?: { scope?: 'all'|'prompt'|'rules-only', reason?: string }) => string,
 *   schedule: (opts?: { scope?: 'all'|'prompt'|'rules-only', reason?: string, delayMs?: number }) => Promise<string|null>,
 *   cancel: () => void,
 *   clearHidden: () => Promise<{ cleared: number, hidden: number }>,
 *   onSystem1Ready: () => string
 * }} [redecide]   lib/pipeline/redecide.js createRedecider()
 * @property {ReturnType<import('../decision-runtime.js').createDecisionRuntime>} [decision]
 *           the decision runtime (engine status, diagnostics, provider tests, System 1 loading)
 * @property {{
 *   checkEngineStatus?: () => Promise<object>,
 *   extractTagsFromPrompt: (prompt: string) => Promise<any[]>,
 *   enhanceMatchPrompt: (prompt: string, tags: string[]) => Promise<string>,
 *   autoSuggestTagPrompt: (tag: string, current?: string) => Promise<string>
 * }} engine   checkEngineStatus is a deprecated fallback for GET_ENGINE_STATUS without `decision`
 * @property {() => Promise<void>} [ensureInitialized]
 * @property {string} [extensionOrigin]   'chrome-extension://<id>' (default: chrome.runtime.getURL(''))
 * @property {number} [gateOnGenerateWaitMs]   TOGGLE_MATCH_PROMPT's wait for the prompt enhancement (tests)
 * @property {() => number} now
 * @property {() => string} uuid
 */

/**
 * @typedef {Record<string, (payload: any, sender?: chrome.runtime.MessageSender, message?: object) => any>} HandlerMap
 */

/**
 * Commits a configuration change and, when something was written, schedules a state broadcast.
 *
 * @param {HandlerDeps} deps
 * @param {(cfg: object) => object|null} fn
 * @returns {Promise<object|null>}
 */
export async function commitConfig(deps, fn) {
  const written = await deps.store.mutateConfig(fn);
  if (written) deps.broadcast.scheduleBroadcast();
  return written;
}

/**
 * Commits a stack change and, when something was written, schedules a state broadcast.
 *
 * @param {HandlerDeps} deps
 * @param {(stack: object[], state: object) => any} fn
 */
export async function commitStack(deps, fn) {
  const written = await deps.store.mutateStack(fn);
  if (written) deps.broadcast.scheduleBroadcast();
  return written;
}

/** @param {unknown} s */
export function lower(s) {
  return String(s ?? '').toLowerCase();
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
export function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value;
}
