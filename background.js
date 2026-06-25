/**
 * background.js
 *
 * Service worker orchestrator for ScrollCollector.
 *
 * Responsibilities:
 *  1. Side Panel lifecycle management
 *  2. Default state initialization on extension install
 *  3. Message routing for classification, config, and UI state
 *  4. Atomic state mutations (read → modify → write)
 *  5. Broadcasting state updates to all extension contexts
 */

import { classify, checkEngineStatus } from './lib/inference-engine.js';

// ---------------------------------------------------------------------------
// Side Panel — open on toolbar icon click
// ---------------------------------------------------------------------------

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// ---------------------------------------------------------------------------
// Default state — seed storage on first install
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(null);

  if (!existing.configuration) {
    await chrome.storage.local.set({
      configuration: {
        trackedTags: [
          { id: 't1',  label: 'Tech',                 isEnabled: true },
          { id: 't2',  label: 'Finance',               isEnabled: true },
          { id: 't3',  label: 'AI & Machine Learning',  isEnabled: true },
          { id: 't4',  label: 'Health & Wellness',      isEnabled: true },
          { id: 't5',  label: 'Politics & Society',     isEnabled: true },
          { id: 't6',  label: 'Entertainment',          isEnabled: true },
          { id: 't7',  label: 'Sports',                 isEnabled: true },
          { id: 't8',  label: 'Science',                isEnabled: true },
          { id: 't9',  label: 'Education',              isEnabled: true },
          { id: 't10', label: 'Business & Startups',    isEnabled: true }
        ]
      },
      metrics: { counts: {} },
      stack: [],
      telemetry: { totalProcessed: 0, classifiedCount: 0, unclassifiedCount: 0, sessionStart: Date.now(), lastProcessed: null }
    });

    console.info('[background] Default state initialized.');
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Broadcasts a message to every extension context (side panel, popups, etc.).
 * Swallows errors from contexts that have already been destroyed.
 *
 * @param {object} message - The message payload to broadcast.
 */
async function broadcastStateUpdate() {
  try {
    const fullState = await chrome.storage.local.get(null);
    await chrome.runtime.sendMessage({
      type: 'STATE_UPDATED',
      payload: {
        configuration: fullState.configuration,
        metrics: fullState.metrics,
        stack: fullState.stack,
        telemetry: fullState.telemetry
      }
    });
  } catch {
    // No listeners active — safe to ignore
  }
}

/**
 * Extracts the labels of enabled custom/default tags.
 *
 * @param {Array<{id: string, label: string, isEnabled: boolean, isDynamic?: boolean}>} trackedTags
 * @returns {string[]}
 */
function getEnabledCustomLabels(trackedTags) {
  return trackedTags.filter(t => t.isEnabled && !t.isDynamic).map(t => t.label);
}

/**
 * Extracts the labels of enabled dynamic tags.
 *
 * @param {Array<{id: string, label: string, isEnabled: boolean, isDynamic?: boolean}>} trackedTags
 * @returns {string[]}
 */
function getEnabledDynamicLabels(trackedTags) {
  return trackedTags.filter(t => t.isEnabled && t.isDynamic).map(t => t.label);
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Wrap in an async IIFE so we can `await` inside the listener
  (async () => {
    try {
      switch (message.type) {

        // -----------------------------------------------------------------
        // TEXT_EXTRACTED — classify incoming text and update state
        // -----------------------------------------------------------------
        case 'TEXT_EXTRACTED': {
          const { text, sourcePlatform, sourceUrl } = message.payload;

          // Read current state atomically
          const state = await chrome.storage.local.get(['configuration', 'metrics', 'stack', 'telemetry']);
          const trackedTags = state.configuration.trackedTags || [];
          
          const enabledCustom = getEnabledCustomLabels(trackedTags);
          const enabledDynamic = getEnabledDynamicLabels(trackedTags);

          // Run the inference pipeline (Tier 1 → Tier 2)
          const { category, dynamicTag } = await classify(text, sourcePlatform, enabledCustom, enabledDynamic);

          // --- Atomic state mutation ---
          let finalCategory = category;
          const updatedTags = [...trackedTags];

          // Register new dynamic tag if matched
          if (category === 'Unclassified' && dynamicTag) {
            const exists = updatedTags.some(t => t.label.toLowerCase() === dynamicTag.toLowerCase());
            if (!exists) {
              const dynamicTagsCount = updatedTags.filter(t => t.isDynamic).length;
              if (dynamicTagsCount < 10) {
                updatedTags.push({
                  id: 'dt_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
                  label: dynamicTag,
                  isEnabled: true,
                  isDynamic: true
                });
                finalCategory = dynamicTag;
              } else {
                finalCategory = 'Unclassified';
              }
            } else {
              const existingTag = updatedTags.find(t => t.label.toLowerCase() === dynamicTag.toLowerCase());
              if (existingTag && existingTag.isEnabled) {
                finalCategory = existingTag.label;
              } else {
                finalCategory = 'Unclassified';
              }
            }
          }

          // 1. Increment metrics counter
          const counts = { ...state.metrics.counts };
          counts[finalCategory] = (counts[finalCategory] || 0) + 1;

          // 2. Update telemetry
          const telemetry = state.telemetry || { totalProcessed: 0, classifiedCount: 0, unclassifiedCount: 0, sessionStart: Date.now() };
          telemetry.totalProcessed++;
          if (finalCategory === 'Unclassified') {
            telemetry.unclassifiedCount++;
          } else {
            telemetry.classifiedCount++;
          }
          telemetry.lastProcessed = Date.now();

          // 3. Prepend new item to the stack
          const newItem = {
            id:             `item_${Date.now()}`,
            timestamp:      Date.now(),
            sourcePlatform,
            sourceUrl:      sourceUrl || '',
            textSnippet:    text.substring(0, 200),
            assignedTag:    finalCategory,
            isPinned:       false
          };

          const updatedStack = [newItem, ...state.stack];

          // 4. Persist
          await chrome.storage.local.set({
            configuration: { trackedTags: updatedTags },
            metrics:   { counts },
            stack:     updatedStack,
            telemetry
          });

          // Notify all contexts
          await broadcastStateUpdate();

          sendResponse({ success: true, category: finalCategory });
          break;
        }

        // -----------------------------------------------------------------
        // CONFIG_CHANGED — persist updated tag configuration (legacy)
        // -----------------------------------------------------------------
        case 'CONFIG_CHANGED': {
          const { trackedTags } = message.payload;

          await chrome.storage.local.set({
            configuration: { trackedTags }
          });

          await broadcastStateUpdate();
          sendResponse({ success: true });
          break;
        }

        // -----------------------------------------------------------------
        // TAG_TOGGLED — toggle a single tag's enabled state
        // -----------------------------------------------------------------
        case 'TAG_TOGGLED': {
          const { tag, enabled } = message.payload;
          const { configuration } = await chrome.storage.local.get('configuration');

          const updatedTags = configuration.trackedTags.map(t =>
            t.label === tag ? { ...t, isEnabled: enabled } : t
          );

          await chrome.storage.local.set({
            configuration: { trackedTags: updatedTags }
          });

          await broadcastStateUpdate();
          sendResponse({ success: true });
          break;
        }

        // -----------------------------------------------------------------
        // TAG_REMOVED — delete a tag from configuration
        // -----------------------------------------------------------------
        case 'TAG_REMOVED': {
          const { tag: tagToRemove } = message.payload;
          const { configuration } = await chrome.storage.local.get('configuration');

          const filteredTags = configuration.trackedTags.filter(
            t => t.label !== tagToRemove
          );

          await chrome.storage.local.set({
            configuration: { trackedTags: filteredTags }
          });

          await broadcastStateUpdate();
          sendResponse({ success: true });
          break;
        }

        // -----------------------------------------------------------------
        // TAG_ADDED — add a new custom tag
        // -----------------------------------------------------------------
        case 'TAG_ADDED': {
          const { tag: newTagLabel } = message.payload;
          const { configuration } = await chrome.storage.local.get('configuration');

          // Duplicate check (case-insensitive)
          const exists = configuration.trackedTags.some(
            t => t.label.toLowerCase() === newTagLabel.toLowerCase()
          );

          if (exists) {
            sendResponse({ success: false, error: 'Tag already exists' });
            break;
          }

          configuration.trackedTags.push({
            id: 't' + Date.now(),
            label: newTagLabel,
            isEnabled: true
          });

          await chrome.storage.local.set({ configuration });

          await broadcastStateUpdate();
          sendResponse({ success: true });
          break;
        }

        // -----------------------------------------------------------------
        // TAG_PROMOTED — elevate a dynamic tag to custom status
        // -----------------------------------------------------------------
        case 'TAG_PROMOTED': {
          const { tag: tagLabel } = message.payload;
          const { configuration } = await chrome.storage.local.get('configuration');

          const updatedTags = configuration.trackedTags.map(t =>
            t.label === tagLabel ? { ...t, isDynamic: false } : t
          );

          await chrome.storage.local.set({
            configuration: { trackedTags: updatedTags }
          });

          await broadcastStateUpdate();
          sendResponse({ success: true });
          break;
        }

        // -----------------------------------------------------------------
        // GET_STATE — return full state snapshot (cold-start for side panel)
        // -----------------------------------------------------------------
        case 'GET_STATE': {
          const state = await chrome.storage.local.get(null);
          sendResponse(state);
          break;
        }

        // -----------------------------------------------------------------
        // PIN_TOGGLED — flip the isPinned flag on a stack item
        // -----------------------------------------------------------------
        case 'PIN_TOGGLED': {
          const { itemId, isPinned } = message.payload;

          const { stack } = await chrome.storage.local.get('stack');

          const updatedStack = stack.map(item =>
            item.id === itemId ? { ...item, isPinned } : item
          );

          await chrome.storage.local.set({ stack: updatedStack });
          await broadcastStateUpdate();

          sendResponse({ success: true });
          break;
        }

        // -----------------------------------------------------------------
        // CLEAR_STACK — remove unpinned items, reset metrics, and clear dynamic tags
        // -----------------------------------------------------------------
        case 'CLEAR_STACK': {
          const { stack, configuration } = await chrome.storage.local.get(['stack', 'configuration']);

          // Retain only pinned items
          const pinnedItems = stack.filter(item => item.isPinned);

          // Clear any dynamic tags (retain custom ones)
          const customTagsOnly = (configuration.trackedTags || []).filter(t => !t.isDynamic);

          await chrome.storage.local.set({
            configuration: { trackedTags: customTagsOnly },
            stack:   pinnedItems,
            metrics: { counts: {} },
            telemetry: { totalProcessed: 0, classifiedCount: 0, unclassifiedCount: 0, sessionStart: Date.now(), lastProcessed: null }
          });

          await broadcastStateUpdate();

          sendResponse({ success: true });
          break;
        }

        // -----------------------------------------------------------------
        // GET_ENGINE_STATUS — report which inference tier is active
        // -----------------------------------------------------------------
        case 'GET_ENGINE_STATUS': {
          const status = await checkEngineStatus();
          sendResponse(status);
          break;
        }

        // -----------------------------------------------------------------
        // GET_CATEGORY_ITEMS — return stack items for a specific category
        // -----------------------------------------------------------------
        case 'GET_CATEGORY_ITEMS': {
          const { category } = message.payload;
          const { stack } = await chrome.storage.local.get('stack');
          const items = stack.filter(item => item.assignedTag === category);
          sendResponse({ items });
          break;
        }

        default:
          sendResponse({ error: `Unknown message type: ${message.type}` });
      }
    } catch (err) {
      console.error(`[background] Error handling "${message.type}":`, err);
      sendResponse({ error: err.message });
    }
  })();

  // Return true to signal that sendResponse will be called asynchronously
  return true;
});
