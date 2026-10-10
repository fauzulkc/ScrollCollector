/**
 * The background message table: { [MSG type]: handler }.
 */

import { createStateHandlers } from './state.js';
import { createStackHandlers } from './stack.js';
import { createConfigHandlers } from './config.js';
import { createPromptHandlers } from './prompt.js';
import { createTagHandlers } from './tags.js';
import { createSiteHandlers } from './sites.js';
import { createIgnoreHandlers } from './ignore.js';
import { createContentHandlers } from './content.js';
import { createIntelligenceHandlers } from './intelligence.js';

/**
 * @param {Partial<import('./common.js').HandlerDeps> & Pick<import('./common.js').HandlerDeps, 'store'|'broadcast'|'ingest'|'engine'>} deps
 * @returns {import('./common.js').HandlerMap}
 */
export function createHandlers(deps) {
  /** @type {import('./common.js').HandlerDeps} */
  const full = {
    now: Date.now,
    uuid: () => crypto.randomUUID(),
    relabel: { trigger() {} },
    ...deps
  };
  return {
    ...createStateHandlers(full),
    ...createStackHandlers(full),
    ...createConfigHandlers(full),
    ...createPromptHandlers(full),
    ...createTagHandlers(full),
    ...createSiteHandlers(full),
    ...createIgnoreHandlers(full),
    ...createContentHandlers(full),
    ...createIntelligenceHandlers(full)
  };
}
