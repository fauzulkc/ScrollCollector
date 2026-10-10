/**
 * Global match-prompt handlers.
 *
 * configuration.promptVersion increments on every prompt edit. Model calls (tag extraction, prompt
 * enhancement) run OUTSIDE the state lock and their results are committed only if the prompt
 * version is still the one they were computed for; otherwise the reply is { success: true, stale: true }.
 * matchPromptTags are stored as plain strings.
 *
 * Re-evaluation of what is already collected (lib/pipeline/redecide.js; items are hidden, never
 * deleted). Open tabs are asked to rescan (RESET_AND_RESCAN) once the re-decide FINISHED, so the
 * posts the page re-sends meet the re-decided stack (a stored post the new prompt hides is reported
 * 'hidden_by_prompt' instead of a stale 'collected'), and posts the old prompt rejected are offered
 * again:
 *  - UPDATE_MATCH_PROMPT    debounced (800 ms) re-decide, scope 'prompt', then a rescan
 *  - GENERATE_PROMPT_TAGS   committed tags/enhancement feed the rules tier: debounced 'prompt' re-decide, then a rescan
 *  - TOGGLE_MATCH_PROMPT    on: re-decide now, scope 'prompt', then a rescan; off: un-hide every item
 *                           (no model call) and rescan right away. A missing prompt enhancement is
 *                           generated first, but the re-decide waits for it at most
 *                           GATE_ON_GENERATE_WAIT_MS: a slow or stalled on-device model must not hold
 *                           up the gate. An enhancement that lands later is committed and re-decided
 *                           like GENERATE_PROMPT_TAGS.
 */

import { MSG } from '../../messages.js';
import { commitConfig } from './common.js';
import { toTagStrings } from '../../pipeline/normalize.js';
import { redeciderFrom } from '../../pipeline/redecide.js';

/** How long TOGGLE_MATCH_PROMPT waits for a missing prompt enhancement before it re-decides. */
export const GATE_ON_GENERATE_WAIT_MS = 5000;

/** @param {object} cfg */
function versionOf(cfg) {
  return Number.isFinite(cfg && cfg.promptVersion) ? cfg.promptVersion : 0;
}

/**
 * Resolves with what `promise` resolves to, or with `fallback` after `ms` (the promise keeps going).
 * @template T, F
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {F} fallback
 * @returns {Promise<T|F>}
 */
function within(promise, ms, fallback) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback), Math.max(0, ms));
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/**
 * @param {import('./common.js').HandlerDeps} deps
 * @returns {import('./common.js').HandlerMap}
 */
export function createPromptHandlers(deps) {
  const { store, broadcast, engine } = deps;
  const redecide = redeciderFrom(deps);

  /**
   * Debounced 'prompt' re-decide; open tabs rescan once it finished.
   *
   * @param {string} reason
   */
  function scheduleRedecide(reason) {
    try {
      Promise.resolve(redecide.schedule({ scope: 'prompt', reason, rescan: true })).catch(() => {});
    } catch (err) {
      console.warn('[background] Could not schedule a re-decide:', err);
    }
  }

  /**
   * Model work for a prompt: tags first, then the enhancement weighted by them.
   *
   * @param {string} prompt
   * @param {string[]} [knownTags]
   */
  async function generate(prompt, knownTags = []) {
    const tags = knownTags.length > 0 ? knownTags : toTagStrings(await engine.extractTagsFromPrompt(prompt));
    const enhanced = String((await engine.enhanceMatchPrompt(prompt, tags)) || '');
    return { tags, enhanced };
  }

  /**
   * Commits generated tags/enhancement if the prompt has not changed since `version`.
   *
   * @returns {Promise<boolean>} true when committed, false when stale
   */
  async function commitGenerated(version, prompt, tags, enhanced) {
    let stale = false;
    await commitConfig(deps, (cfg) => {
      if (versionOf(cfg) !== version || (cfg.matchPrompt || '') !== prompt) {
        stale = true;
        return null;
      }
      return { ...cfg, matchPromptTags: tags, matchPromptEnhanced: enhanced };
    });
    return !stale;
  }

  return {
    /**
     * Saves the prompt text. Clears the (now stale) tags/enhancement/expansion, bumps promptVersion and, when the
     * prompt goes from empty to non-empty, switches the gate on unless the user turned it off.
     * A real change schedules a debounced re-decide of the stack (scope 'prompt').
     */
    async [MSG.UPDATE_MATCH_PROMPT]({ prompt }) {
      const next = typeof prompt === 'string' ? prompt : '';
      const written = await commitConfig(deps, (cfg) => {
        const prev = typeof cfg.matchPrompt === 'string' ? cfg.matchPrompt : '';
        if (prev === next) return null;
        const updated = {
          ...cfg,
          matchPrompt: next,
          matchPromptEnhanced: '',
          // Short noun-phrase expansion read by lib/decision/questions.js buildMatchQuestion().
          matchPromptExpansion: '',
          matchPromptTags: [],
          promptVersion: versionOf(cfg) + 1
        };
        if (!prev.trim() && next.trim() && !cfg.matchPromptUserDisabled) {
          updated.isMatchPromptEnabled = true;
        }
        return updated;
      });
      if (written) scheduleRedecide('prompt_changed');
      return { success: true };
    },

    /**
     * Turns the gate on/off (remembering an explicit "off").
     *  - on:  fills in the enhancement if missing, then re-decides the stack (scope 'prompt').
     *  - off: clears every hidden flag right away, without model calls.
     */
    async [MSG.TOGGLE_MATCH_PROMPT]({ isEnabled }) {
      const enabled = !!isEnabled;
      let snapshot = null;
      await commitConfig(deps, (cfg) => {
        snapshot = cfg;
        return { ...cfg, isMatchPromptEnabled: enabled, matchPromptUserDisabled: !enabled };
      });

      if (!enabled) {
        try {
          await redecide.clearHidden();
        } catch (err) {
          console.warn('[background] Could not un-hide items after switching the gate off:', err);
        }
        // Posts the gate rejected can be collected again: ask open tabs to rescan.
        broadcast.broadcastToAllTabs({ type: MSG.RESET_AND_RESCAN });
        return { success: true };
      }

      let stale = false;
      const prompt = (snapshot && typeof snapshot.matchPrompt === 'string') ? snapshot.matchPrompt : '';
      if (prompt.trim() && !(snapshot.matchPromptEnhanced || '').trim()) {
        const version = versionOf(snapshot);
        const work = (async () => {
          const { tags, enhanced } = await generate(prompt, toTagStrings(snapshot.matchPromptTags));
          return commitGenerated(version, prompt, tags, enhanced);
        })();
        const waitMs = Number.isFinite(deps.gateOnGenerateWaitMs) ? deps.gateOnGenerateWaitMs : GATE_ON_GENERATE_WAIT_MS;
        const PENDING = Symbol('pending');
        try {
          const committed = await within(work, waitMs, PENDING);
          if (committed === PENDING) {
            // Still generating: the gate re-decides now; the enhancement re-decides again once it lands.
            work.then(
              (late) => { if (late) scheduleRedecide('prompt_tags'); },
              (err) => console.warn('[background] Could not enhance the match prompt:', err)
            );
          } else {
            stale = !committed;
          }
        } catch (err) {
          console.warn('[background] Could not enhance the match prompt:', err);
        }
      }

      // Re-decide what is collected (non-matching items get hidden); open tabs rescan once it is done.
      try {
        redecide.start({ scope: 'prompt', reason: 'gate_on', rescan: true });
      } catch (err) {
        console.warn('[background] Could not start a re-decide:', err);
      }
      return stale ? { success: true, stale: true } : { success: true };
    },

    /** Generates prompt tags + enhancement for `prompt`; committed only if the prompt is unchanged. */
    async [MSG.GENERATE_PROMPT_TAGS]({ prompt }) {
      const text = typeof prompt === 'string' ? prompt : '';
      // Ordered after any queued UPDATE_MATCH_PROMPT commit.
      const { configuration: cfg = {} } = (await store.snapshot('configuration')) || {};
      if ((cfg.matchPrompt || '') !== text) return { success: true, stale: true };
      const version = versionOf(cfg);

      let tags;
      let enhanced;
      try {
        ({ tags, enhanced } = await generate(text));
      } catch (err) {
        console.error('Error in GENERATE_PROMPT_TAGS', err);
        return { success: false, error: (err && err.message) || String(err), tags: [], enhanced: '' };
      }

      if (!(await commitGenerated(version, text, tags, enhanced))) return { success: true, stale: true };
      // The rules tier reads the prompt tags / enhancement: re-check the stack with them.
      scheduleRedecide('prompt_tags');
      return { success: true, tags, enhanced };
    }
  };
}
