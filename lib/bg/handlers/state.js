/**
 * GET_STATE / GET_ENGINE_STATUS.
 */

import { MSG, BROADCAST_STATE_KEYS } from '../../messages.js';
import { pickBroadcastState } from '../broadcast.js';
import { promptWarnings } from '../../pipeline/apply-decision.js';

/**
 * @param {import('./common.js').HandlerDeps} deps
 * @returns {import('./common.js').HandlerMap}
 */
export function createStateHandlers(deps) {
  const { store, broadcast, engine } = deps;

  return {
    /** Whitelisted state only (never secrets) + inFlightCount. */
    async [MSG.GET_STATE]() {
      let state = (await store.get([...BROADCAST_STATE_KEYS])) || {};
      const tags = state.configuration && state.configuration.trackedTags;
      if ((!Array.isArray(tags) || tags.length === 0) && deps.ensureInitialized) {
        await deps.ensureInitialized();
        state = (await store.get([...BROADCAST_STATE_KEYS])) || {};
      }
      return pickBroadcastState(state, broadcast.getInflightCount());
    },

    /**
     * The EngineStatus pushed as ENGINE_STATUS (lib/decision/types.js) plus the legacy
     * { tier, name, status } derived from its badge, and the prompt warnings ('empty_prompt',
     * 'gate_off_with_prompt'). Without a decision runtime (unit tests) the legacy engine shim answers.
     */
    async [MSG.GET_ENGINE_STATUS]() {
      const stored = await store.get('configuration');
      const configuration = stored && stored.configuration;
      if (deps.decision) return deps.decision.engineStatusReply(configuration);
      const status = engine && typeof engine.checkEngineStatus === 'function' ? await engine.checkEngineStatus() : null;
      return { ...(status || {}), warnings: promptWarnings(configuration) };
    }
  };
}
