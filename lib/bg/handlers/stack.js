/**
 * Stack item handlers: favourite, delete, retag, clear, category listing, re-decide.
 * Every write goes through mutateStack, which re-derives metrics.counts from the stack.
 *
 * Hidden items (hiddenByPrompt, set by lib/pipeline/redecide.js when an item no longer matches the
 * prompt) are regular stack items: Clear removes them like any other item of the cleared tag,
 * favourites and manual overrides are never hidden.
 */

import { MSG } from '../../messages.js';
import { commitStack } from './common.js';
import {
  ADS_TAG,
  UNCLASSIFIED,
  emptyTelemetry,
  shouldHideByPrompt,
  pruneEmptyDynamicTags
} from '../stack-utils.js';
import { parseScope, redeciderFrom, REDECIDE_SCOPES } from '../../pipeline/redecide.js';

/** CLEAR_STACK / filter name that keeps everything (favourites are never cleared). */
const FAVORITES_FILTER = 'Favorites';

/**
 * @param {import('./common.js').HandlerDeps} deps
 * @returns {import('./common.js').HandlerMap}
 */
export function createStackHandlers(deps) {
  const { store, now } = deps;
  const redecide = redeciderFrom(deps);

  return {
    /** A favourite is never hidden; un-favouriting hides it again if its current decision rejects it. */
    async [MSG.FAVORITE_TOGGLED]({ itemId, isFavorite }) {
      await commitStack(deps, (stack, state) => {
        if (!stack.some(item => item.id === itemId)) return null;
        const cfg = state.configuration || {};
        return stack.map(item => {
          if (item.id !== itemId) return item;
          const updated = { ...item, isFavorite: !!isFavorite, favoritedAt: isFavorite ? now() : null };
          const hide = shouldHideByPrompt(updated, cfg);
          if (hide || updated.hiddenByPrompt) updated.hiddenByPrompt = hide;
          return updated;
        });
      });
      return { success: true };
    },

    async [MSG.ITEM_DELETED]({ itemId }) {
      let found = false;
      await commitStack(deps, (stack) => {
        found = stack.some(item => item.id === itemId);
        return found ? stack.filter(item => item.id !== itemId) : null;
      });
      return found ? { success: true } : { success: false, error: 'Item not found' };
    },

    /** A manual retag is an override: re-decides keep the tag and never hide the item. */
    async [MSG.ITEM_RETAGGED]({ itemId, newTag }) {
      await commitStack(deps, (stack) => {
        if (!stack.some(item => item.id === itemId)) return null;
        return stack.map(item => item.id === itemId
          ? {
            ...item,
            assignedTag: newTag,
            matchInfo: { engine: 'Manual Override', manual: true },
            ...(item.hiddenByPrompt ? { hiddenByPrompt: false } : {})
          }
          : item);
      });
      return { success: true };
    },

    /**
     * payload.tag: a tag label (incl. 'Unclassified'), 'Ads', 'Favorites' (no-op), or 'All'/undefined
     * for everything. Hidden items of the cleared tag are removed too. payload.hiddenOnly: true limits
     * the clear to hidden items. Favourites always survive. Dynamic, non-sticky tags left without
     * any item are dropped.
     */
    async [MSG.CLEAR_STACK](payload) {
      const targetTag = payload && payload.tag;
      const hiddenOnly = !!(payload && payload.hiddenOnly === true);
      const all = !targetTag || targetTag === 'All';
      await commitStack(deps, (stack, state) => {
        const configuration = state.configuration || {};
        const trackedTags = Array.isArray(configuration.trackedTags) ? configuration.trackedTags : [];

        /** @param {object} item */
        const inScope = (item) => {
          if (all) return true;
          if (targetTag === ADS_TAG) return !!item.isAd;
          if (targetTag === FAVORITES_FILTER) return false;
          return (item.assignedTag || UNCLASSIFIED) === targetTag;
        };
        const updatedStack = stack.filter(item => !item || item.isFavorite || !inScope(item) || (hiddenOnly && !item.hiddenByPrompt));
        const preservedTags = pruneEmptyDynamicTags(trackedTags, updatedStack);
        // "Clear all" always resets the session telemetry, even when only favourites were left.
        const resetTelemetry = all && !hiddenOnly;
        if (!resetTelemetry && updatedStack.length === stack.length && preservedTags === trackedTags) return null;

        const commit = {
          stack: updatedStack,
          telemetry: resetTelemetry ? emptyTelemetry(now()) : (state.telemetry || emptyTelemetry(now()))
        };
        if (preservedTags !== trackedTags) commit.configuration = { ...configuration, trackedTags: preservedTags };
        return commit;
      });
      return { success: true };
    },

    /** payload: { category, includeHidden? } — hidden items are left out unless includeHidden. */
    async [MSG.GET_CATEGORY_ITEMS]({ category, includeHidden }) {
      const { stack = [] } = (await store.get('stack')) || {};
      return {
        items: stack.filter(item => item && item.assignedTag === category && (includeHidden === true || !item.hiddenByPrompt))
      };
    },

    /**
     * payload: { scope?: 'all'|'prompt'|'rules-only' } (default 'all') -> { success, jobId }.
     * Progress arrives as REDECIDE_PROGRESS { jobId, done, total, hidden, finished }.
     */
    async [MSG.REDECIDE_STACK](payload) {
      const raw = payload ? payload.scope : undefined;
      const scope = raw === undefined || raw === null ? 'all' : parseScope(raw);
      if (!scope) {
        return { success: false, error: `scope must be one of: ${REDECIDE_SCOPES.join(', ')}`, code: 'bad_request' };
      }
      const jobId = redecide.start({ scope, reason: 'redecide_stack' });
      return { success: true, jobId: jobId ?? null };
    }
  };
}
