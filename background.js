/**
 * background.js
 *
 * Service worker wiring for ScrollCollector. The logic lives in:
 *  - lib/bg/store.js            locked read-modify-write over chrome.storage.local
 *  - lib/bg/broadcast.js        coalesced STATE_UPDATED / INFLIGHT_UPDATED / tab messages
 *  - lib/bg/router.js           message table -> onMessage listener
 *  - lib/bg/handlers/*.js       one module per message family
 *  - lib/bg/decision-runtime.js the decision cascade: System 1 (offscreen) -> one escalation provider
 *                               (Gemini Nano | TypeSafe Jev | OpenAI) -> rules, with budget, cache,
 *                               ENGINE_STATUS and diagnostics
 *  - lib/pipeline/ingest.js     TEXT_EXTRACTED queue -> decisions (outside the lock) -> batched commits
 *  - lib/pipeline/redecide.js   re-decides the stored stack when the prompt, tags or model change
 *
 * Every handler awaits startup(): access level, default seeding, schema migration and the
 * restore of posts queued by a previous service-worker instance.
 */

import {
  extractTagsFromPrompt,
  enhanceMatchPrompt,
  autoSuggestTagPrompt,
  setSemanticGenerator
} from './lib/inference-engine.js';
import { migrateState } from './lib/storage/migrations.js';
import { createStore } from './lib/bg/store.js';
import { createBroadcaster } from './lib/bg/broadcast.js';
import { createRouter } from './lib/bg/router.js';
import { createHandlers } from './lib/bg/handlers/index.js';
import { createContentConfigWatcher, contentConfigOf } from './lib/bg/handlers/content.js';
import { MSG } from './lib/messages.js';
import { initializeState } from './lib/bg/defaults.js';
import { ensureContentScriptInjected, injectIntoOpenTabs } from './lib/bg/inject.js';
import { createDecisionRuntime } from './lib/bg/decision-runtime.js';
import { getOffscreenClient } from './lib/offscreen-client.js';
import { createIngest } from './lib/pipeline/ingest.js';
import { migrateCanonicalAuthors } from './lib/pipeline/authors.js';
import { createRedecider } from './lib/pipeline/redecide.js';
import { createIdleRetry } from './lib/pipeline/retry.js';

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

const store = createStore({ area: chrome.storage.local });
const broadcast = createBroadcaster();

/**
 * The decision layer (lib/bg/decision-runtime.js). Its decideMany serves ingest, the idle retry
 * and the redecider; its Gemini Nano provider also backs the prompt-tag / prompt-expansion / tag
 * wand helpers of lib/inference-engine.js (one LanguageModel instance with shared sessions; they
 * fall back to heuristics when Nano is not ready or switched off).
 */
const decision = createDecisionRuntime({
  store,
  broadcast,
  area: chrome.storage.local,
  session: chrome.storage.session,
  offscreenClient: getOffscreenClient()
});
setSemanticGenerator(decision.nano);
const { decideMany } = decision;

const ingest = createIngest({
  store,
  decideMany,
  broadcast,
  notifyTab: (tabId, message) => broadcast.sendToTab(tabId, message),
  session: chrome.storage.session
});

const redecide = createRedecider({ store, decideMany, broadcast });
decision.setRedecider(redecide);

const idleRetry = createIdleRetry({
  store,
  decideMany,
  broadcast,
  isBusy: () => broadcast.getInflightCount() > 0,
  // Attempt counts must outlive this worker: the alarm usually wakes a fresh one.
  session: chrome.storage.session
});

const ensureInitialized = () => initializeState({ store, migrateState, migrateAuthors: migrateCanonicalAuthors });

let startupPromise = null;

/**
 * One-time service-worker initialisation; memoised, never rejects.
 *
 * @returns {Promise<void>}
 */
function startup() {
  if (!startupPromise) {
    startupPromise = (async () => {
      // Keep storage.local (and the API keys) out of content scripts.
      try {
        await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
      } catch (err) {
        console.warn('[background] storage.local.setAccessLevel failed:', err);
      }
      try {
        await ensureInitialized();
      } catch (err) {
        console.error('[background] State initialisation failed:', err);
      }
      // Provider status and prompt warnings. Not awaited: handlers must not wait for
      // LanguageModel.availability(). System 1 is not loaded here (this worker also wakes for every
      // page and for the idle-retry alarm): it loads on the first decision or when the side panel
      // asks for the engine status, and is unloaded again when idle.
      decision.start().catch((err) => console.warn('[background] Decision layer start failed:', err));
      // Content scripts that gave up asking (GET_CONTENT_CONFIG retries end after ~8 s) wait for a
      // push; send one per service-worker start. Not awaited: handlers must not wait on tabs.
      try {
        const { configuration } = (await store.get('configuration')) || {};
        broadcast.broadcastToAllTabs({ type: MSG.CONTENT_CONFIG_UPDATED, payload: contentConfigOf(configuration) });
      } catch (err) {
        console.warn('[background] Could not push the content configuration:', err);
      }
      try {
        await ingest.restore();
      } catch (err) {
        console.warn('[background] Could not restore the ingest queue:', err);
      }
    })();
  }
  return startupPromise;
}

startup();

// ---------------------------------------------------------------------------
// Side Panel — open on toolbar icon click
// ---------------------------------------------------------------------------

try {
  Promise.resolve(chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })).catch(err => {
    console.warn('[background] sidePanel.setPanelBehavior failed:', err);
  });
} catch (err) {
  console.warn('[background] sidePanel.setPanelBehavior failed:', err);
}

// ---------------------------------------------------------------------------
// Install / update
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  await startup();
  // Tabs opened before install/update have no (live) content script yet.
  await injectIntoOpenTabs({ store });
});

chrome.tabs.onActivated.addListener(activeInfo => {
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (chrome.runtime.lastError || !tab || !tab.url) return;
    ensureContentScriptInjected(tab.id, tab.url, { store }).catch(() => {});
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && tab.url) {
    ensureContentScriptInjected(tabId, tab.url, { store }).catch(() => {});
  }
});

// Content scripts cannot read storage.local: push them the parts they need when those change.
chrome.storage.onChanged.addListener(createContentConfigWatcher(broadcast));
// Intelligence settings and API keys apply live, whoever wrote them.
chrome.storage.onChanged.addListener((changes, areaName) => decision.onStorageChanged(changes, areaName));

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

const handlers = createHandlers({
  store,
  broadcast,
  ingest,
  redecide,
  decision,
  ensureInitialized,
  engine: { extractTagsFromPrompt, enhanceMatchPrompt, autoSuggestTagPrompt }
});

chrome.runtime.onMessage.addListener(createRouter(handlers, { ready: startup }));

// ---------------------------------------------------------------------------
// 2nd pass evaluation (idle retry)
// ---------------------------------------------------------------------------

if (chrome.alarms) {
  chrome.alarms.create('idleRetry', { periodInMinutes: 1 });

  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== 'idleRetry') return;
    await startup();
    try {
      await idleRetry.run();
    } catch (err) {
      console.warn('[background] idle retry failed:', err);
    }
  });
}
