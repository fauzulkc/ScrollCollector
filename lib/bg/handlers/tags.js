/**
 * Tracked-tag handlers.
 *
 * A change to the tag set a classifier sees (TAG_ADDED / TAG_REMOVED / TAG_TOGGLED /
 * TAG_PROMPT_UPDATED) schedules a debounced re-decide of the stored stack (scope 'all',
 * lib/pipeline/redecide.js), so a burst of edits causes one pass. Items are never deleted by it.
 * TAG_ADDED marks the new tag `isLens: true, collects: true` (ENG-1); TAG_COLLECTS_TOGGLED flips `collects`.
 * The lenses are part of decisionFingerprint, so adding, removing, toggling, re-prompting or flipping
 * `collects` on one re-decides.
 */

import { MSG } from '../../messages.js';
import { commitConfig, lower, requireString } from './common.js';
import { redeciderFrom } from '../../pipeline/redecide.js';

/**
 * @param {import('./common.js').HandlerDeps} deps
 * @returns {import('./common.js').HandlerMap}
 */
export function createTagHandlers(deps) {
  const { engine, uuid } = deps;
  const redecide = redeciderFrom(deps);

  /** @param {object} cfg */
  const tagsOf = (cfg) => (Array.isArray(cfg.trackedTags) ? cfg.trackedTags : []);

  /** @param {string} reason */
  function scheduleRedecide(reason) {
    try {
      Promise.resolve(redecide.schedule({ scope: 'all', reason })).catch(() => {});
    } catch (err) {
      console.warn('[background] Could not schedule a re-decide:', err);
    }
  }

  return {
    async [MSG.TAG_TOGGLED]({ tag, enabled }) {
      const written = await commitConfig(deps, (cfg) => {
        let changed = false;
        const trackedTags = tagsOf(cfg).map(t => {
          if (t.label !== tag || !!t.isEnabled === !!enabled) return t;
          changed = true;
          return { ...t, isEnabled: !!enabled };
        });
        return changed ? { ...cfg, trackedTags } : null;
      });
      if (written) scheduleRedecide('tag_toggled');
      return { success: true };
    },

    async [MSG.TAG_ADDED]({ tag, prompt }) {
      const label = requireString(tag, 'tag').trim();
      let exists = false;
      await commitConfig(deps, (cfg) => {
        exists = tagsOf(cfg).some(t => lower(t.label) === lower(label));
        if (exists) return null;
        return {
          ...cfg,
          trackedTags: [...tagsOf(cfg), {
            id: `t_${uuid()}`,
            label,
            prompt: (typeof prompt === 'string' && prompt.trim()) ? prompt : `Find posts related to ${label}.`,
            isEnabled: true,
            // A tag the user adds is a prompt lens (lib/decision/lenses.js): scored on every post, and
            // it collects (is part of the any-prompt gate) until the user switches that off.
            // The built-in tags never are lenses.
            isLens: true,
            collects: true
          }]
        };
      });
      if (exists) return { success: false, error: 'Tag already exists' };
      scheduleRedecide('tag_added');
      return { success: true };
    },

    async [MSG.TAG_REMOVED]({ tag }) {
      const written = await commitConfig(deps, (cfg) => {
        const trackedTags = tagsOf(cfg).filter(t => t.label !== tag);
        return trackedTags.length === tagsOf(cfg).length ? null : { ...cfg, trackedTags };
      });
      // Items that carried the removed tag get re-decided over the remaining tags.
      if (written) scheduleRedecide('tag_removed');
      return { success: true };
    },

    async [MSG.TAG_PROMPT_UPDATED]({ tag, prompt }) {
      const written = await commitConfig(deps, (cfg) => {
        let changed = false;
        const trackedTags = tagsOf(cfg).map(t => {
          if (lower(t.label) !== lower(tag) || t.prompt === prompt) return t;
          changed = true;
          return { ...t, prompt };
        });
        return changed ? { ...cfg, trackedTags } : null;
      });
      if (written) scheduleRedecide('tag_prompt_updated');
      return { success: true };
    },

    /** Magic wand: suggests a description prompt for a tag (model call, no state change). */
    async [MSG.GENERATE_TAG_EVAL_PROMPT]({ tag, currentPrompt }) {
      try {
        const suggested = await engine.autoSuggestTagPrompt(tag, currentPrompt || '');
        return { success: true, prompt: suggested };
      } catch (err) {
        console.error('Error generating tag eval prompt:', err);
        return { success: false, error: (err && err.message) || String(err) };
      }
    },

    /** Elevates a dynamic tag to a regular one (or adds it). */
    async [MSG.TAG_PROMOTED]({ tag }) {
      await commitConfig(deps, (cfg) => {
        let exists = false;
        const trackedTags = tagsOf(cfg).map(t => {
          if (lower(t.label) === lower(tag)) {
            exists = true;
            return { ...t, isDynamic: false, isSticky: false };
          }
          return t;
        });
        if (!exists) {
          trackedTags.push({ id: `t_${uuid()}`, label: tag, isEnabled: true, isCustom: true });
        }
        return { ...cfg, trackedTags };
      });
      return { success: true };
    },

    /** Sets whether a lens tag's match collects a post (payload { tag: label, collects }); re-decides. */
    async [MSG.TAG_COLLECTS_TOGGLED]({ tag, collects }) {
      const wanted = collects !== false;
      const written = await commitConfig(deps, (cfg) => {
        let changed = false;
        const trackedTags = tagsOf(cfg).map(t => {
          if (t.label !== tag || t.isLens !== true || (t.collects !== false) === wanted) return t;
          changed = true;
          return { ...t, collects: wanted };
        });
        return changed ? { ...cfg, trackedTags } : null;
      });
      if (written) scheduleRedecide('tag_collects_toggled');
      return { success: true };
    },

    async [MSG.TAG_STICKY_TOGGLED]({ tag, isSticky }) {
      await commitConfig(deps, (cfg) => ({
        ...cfg,
        trackedTags: tagsOf(cfg).map(t => (t.label === tag ? { ...t, isSticky: !!isSticky } : t))
      }));
      return { success: true };
    }
  };
}
