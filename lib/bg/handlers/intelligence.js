/**
 * Intelligence settings, API keys and the decision runtime (Settings › Intelligence, Diagnostics).
 *
 *  - UPDATE_INTELLIGENCE_SETTINGS: a whitelisted patch (lib/storage/schema.js) deep-merged into
 *    configuration.intelligence, which keeps only explicit choices (defaults are merged in on
 *    read; null deletes an explicit confidence floor). A patch with any invalid field is rejected
 *    as a whole. The decision runtime applies the change live (it watches configuration).
 *  - SET_SECRET / CLEAR_SECRET: API keys under the top-level `secrets` key (lib/storage/secrets.js).
 *    Replies carry only describeSecrets() ({ set, last4 }), never a key.
 *  - S1_STATUS (offscreen push), S1_ENSURE_LOADED, TEST_PROVIDER, NANO_DOWNLOAD_STATE,
 *    GET_DIAGNOSTICS, RESET_DIAGNOSTICS, REFINE_NOW: delegated to deps.decision (lib/bg/decision-runtime.js).
 *    No reply carries a key; provider error texts are redacted.
 *
 * These are privileged: only extension pages (side panel, or an extension page opened in a tab)
 * may send them; content scripts, which run inside web pages, are refused.
 */

import { MSG } from '../../messages.js';
import { commitConfig } from './common.js';
import { validateIntelligencePatch, resolveIntelligence, deepMerge, isPlainObject, pruneNulls } from '../../storage/schema.js';
import { setSecret, clearSecret } from '../../storage/secrets.js';
import { FORBIDDEN, isExtensionPageSender, ownExtensionOrigin } from '../sender.js';

// The router already refuses these from content scripts; the handlers check again so they stay safe
// when called directly.
export { isExtensionPageSender };

/**
 * @param {unknown} err
 * @returns {{ success: false, error: string, code: string }}
 */
function failure(err) {
  const e = /** @type {any} */ (err);
  return {
    success: false,
    error: (e && typeof e.message === 'string' && e.message) || 'error',
    code: (e && typeof e.code === 'string' && e.code) || 'error'
  };
}

/**
 * @param {import('./common.js').HandlerDeps} deps
 * @returns {import('./common.js').HandlerMap}
 */
export function createIntelligenceHandlers(deps) {
  const { store } = deps;
  /** @param {chrome.runtime.MessageSender|undefined} sender */
  const allowed = (sender) => isExtensionPageSender(sender, deps.extensionOrigin ?? ownExtensionOrigin());

  /**
   * Runs a secrets write inside the state lock, so a startup migration (which rewrites the whole
   * snapshot) can never put back a key that was just changed.
   *
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  const locked = (fn) => (store.lock && typeof store.lock.run === 'function' ? store.lock.run(fn) : fn());

  return {
    /**
     * payload: { patch } -> { success, intelligence } | { success: false, error, errors }
     * Only the user's explicit values are stored (defaults are merged in on read); the reply
     * carries the resolved settings.
     */
    async [MSG.UPDATE_INTELLIGENCE_SETTINGS](payload, sender) {
      if (!allowed(sender)) return FORBIDDEN;
      const { ok, patch, errors } = validateIntelligencePatch(payload && payload.patch);
      if (!ok || Object.keys(patch).length === 0) {
        return { success: false, error: errors.length ? `Invalid settings: ${errors.join('; ')}` : 'Nothing to update', errors };
      }
      let intelligence = null;
      await commitConfig(deps, (cfg) => {
        // null leaves (a cleared confidence floor) delete the explicit value: the default applies.
        const explicit = pruneNulls(deepMerge(isPlainObject(cfg.intelligence) ? cfg.intelligence : {}, patch));
        intelligence = resolveIntelligence({ intelligence: explicit });
        const next = { ...cfg, intelligence: explicit };
        if (Object.keys(explicit).length === 0) delete next.intelligence;
        return next;
      });
      // Applied live by the decision runtime (lib/bg/decision-runtime.js), which watches
      // configuration changes: budgets, System 1 model / on-off, provider status, re-decides.
      return { success: true, intelligence };
    },

    /** payload: { provider: 'jev'|'openai', value } -> { success, secrets: { [provider]: { set, last4 } } } */
    async [MSG.SET_SECRET](payload, sender) {
      if (!allowed(sender)) return FORBIDDEN;
      try {
        const secrets = await locked(() => setSecret(store.area, payload && payload.provider, payload && payload.value));
        return { success: true, secrets };
      } catch (err) {
        return failure(err);
      }
    },

    /** payload: { provider } -> { success, secrets } */
    async [MSG.CLEAR_SECRET](payload, sender) {
      if (!allowed(sender)) return FORBIDDEN;
      try {
        const secrets = await locked(() => clearSecret(store.area, payload && payload.provider));
        return { success: true, secrets };
      } catch (err) {
        return failure(err);
      }
    },

    ...runtimeHandlers(deps, allowed)
  };
}

/**
 * Handlers backed by the decision runtime (lib/bg/decision-runtime.js). Without one (unit tests of
 * other handlers) they are not registered, so the router answers 'Unknown message type' — the
 * reply the side panel treats as "not available in this version".
 *
 * @param {import('./common.js').HandlerDeps} deps
 * @param {(sender: chrome.runtime.MessageSender|undefined) => boolean} allowed
 * @returns {import('./common.js').HandlerMap}
 */
function runtimeHandlers(deps, allowed) {
  const decision = deps.decision;
  if (!decision) return {};
  return {
    /** offscreen -> background push: { status, model, progress?, detail?, device?, loadMs?, error? } */
    async [MSG.S1_STATUS](payload, sender) {
      if (!allowed(sender)) return FORBIDDEN;
      return { success: true, changed: decision.handleS1Status(payload) === true };
    },

    /** Starts loading the System 1 model (not awaited: up to 180 s) -> { success, status } */
    async [MSG.S1_ENSURE_LOADED](_payload, sender) {
      if (!allowed(sender)) return FORBIDDEN;
      return decision.ensureSystem1Loaded();
    },

    /** payload: { provider: 'system1'|'nano'|'jev'|'openai' } -> { success, ok, latencyMs, model, error?, code? } */
    async [MSG.TEST_PROVIDER](payload, sender) {
      if (!allowed(sender)) return FORBIDDEN;
      return decision.testProvider(payload && payload.provider);
    },

    /** payload: { phase: 'start'|'progress'|'done'|'error', loaded?, error? } -> { success, status } */
    async [MSG.NANO_DOWNLOAD_STATE](payload, sender) {
      if (!allowed(sender)) return FORBIDDEN;
      return decision.noteNanoDownload(payload);
    },

    /** -> { success, engineStatus, rejected, budget, cache, providers, secrets: describeSecrets() } */
    async [MSG.GET_DIAGNOSTICS](_payload, sender) {
      if (!allowed(sender)) return FORBIDDEN;
      return decision.diagnostics();
    },

    /** Clears decision counters, provider statistics and cache counters. */
    async [MSG.RESET_DIAGNOSTICS](_payload, sender) {
      if (!allowed(sender)) return FORBIDDEN;
      return decision.resetDiagnostics();
    },

    /** Starts an idle refinement pass now (not awaited) -> { success, running, refine } */
    async [MSG.REFINE_NOW](_payload, sender) {
      if (!allowed(sender)) return FORBIDDEN;
      if (typeof decision.refineNow !== 'function') return { success: false, error: 'Refinement is not available.', code: 'unsupported' };
      return decision.refineNow();
    }
  };
}
