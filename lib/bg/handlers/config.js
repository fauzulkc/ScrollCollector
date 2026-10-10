/**
 * General configuration handlers: bulk tag list (legacy) and pause/resume.
 */

import { MSG } from '../../messages.js';
import { commitConfig } from './common.js';
import { redeciderFrom } from '../../pipeline/redecide.js';

/**
 * @param {import('./common.js').HandlerDeps} deps
 * @returns {import('./common.js').HandlerMap}
 */
export function createConfigHandlers(deps) {
  const { now } = deps;
  const redecide = redeciderFrom(deps);

  return {
    /** Replaces the tag list wholesale; the stack is re-decided against it (debounced, scope 'all'). */
    async [MSG.CONFIG_CHANGED]({ trackedTags }) {
      if (!Array.isArray(trackedTags)) return { success: false, error: 'trackedTags must be an array' };
      const written = await commitConfig(deps, (cfg) => {
        // A bulk replace must not drop the lens flag of a tag the caller did not know about.
        const lens = new Map((Array.isArray(cfg.trackedTags) ? cfg.trackedTags : []).filter((t) => t && t.id && t.isLens === true).map((t) => [t.id, true]));
        const next = trackedTags.map((t) => (t && typeof t === 'object' && t.isLens === undefined && lens.has(t.id) ? { ...t, isLens: true } : t));
        return { ...cfg, trackedTags: next };
      });
      if (written) {
        try {
          Promise.resolve(redecide.schedule({ scope: 'all', reason: 'tags_replaced' })).catch(() => {});
        } catch (err) {
          console.warn('[background] Could not schedule a re-decide:', err);
        }
      }
      return { success: true };
    },

    /** Persists the pause flag and when it started (null once resumed). */
    async [MSG.IS_TRACKING_PAUSED_TOGGLED]({ isPaused }) {
      const paused = !!isPaused;
      await commitConfig(deps, (cfg) => {
        const pausedAt = paused
          ? (cfg.isTrackingPaused && Number.isFinite(cfg.trackingPausedAt) ? cfg.trackingPausedAt : now())
          : null;
        if (!!cfg.isTrackingPaused === paused && (cfg.trackingPausedAt ?? null) === pausedAt) return null;
        return { ...cfg, isTrackingPaused: paused, trackingPausedAt: pausedAt };
      });
      return { success: true };
    }
  };
}
