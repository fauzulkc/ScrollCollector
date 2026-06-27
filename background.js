/**
 * background.js
 *
 * Service worker orchestrator for ScrollCollector.
 *
 * Responsibilities:
 *  1. Side Panel lifecycle management
 *  2. Default state initialization on extension install / migration
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
// Default state — seed storage on first install / upgrade
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
          { id: 't10', label: 'Business & Startups',    isEnabled: true },
          { id: 't_ads', label: 'Ads',                  isEnabled: true }
        ],
        sites: [
          { id: 's1', domain: 'facebook.com', isEnabled: true, isCustom: false },
          { id: 's2', domain: 'linkedin.com', isEnabled: true, isCustom: false },
          { id: 's3', domain: 'twitter.com', isEnabled: true, isCustom: false },
          { id: 's4', domain: 'x.com', isEnabled: true, isCustom: false },
          { id: 's5', domain: 'instagram.com', isEnabled: true, isCustom: false },
          { id: 's6', domain: 'youtube.com', isEnabled: true, isCustom: false },
          { id: 's7', domain: 'medium.com', isEnabled: true, isCustom: false }
        ],
        ignoredKeywords: [],
        isTrackingPaused: false
      },
      metrics: { counts: {} },
      stack: [],
      telemetry: { totalProcessed: 0, classifiedCount: 0, unclassifiedCount: 0, sessionStart: Date.now(), lastProcessed: null },
      inFlightCount: 0
    });

    console.info('[background] Default state initialized.');
  } else {
    if (existing.inFlightCount === undefined) {
      existing.inFlightCount = 0;
      await chrome.storage.local.set({ inFlightCount: 0 });
    }
    // Upgrade existing state to include sites & Ads tag if missing
    let updated = false;
    
    if (!existing.configuration.sites) {
      existing.configuration.sites = [
        { id: 's1', domain: 'facebook.com', isEnabled: true, isCustom: false },
        { id: 's2', domain: 'linkedin.com', isEnabled: true, isCustom: false },
        { id: 's3', domain: 'twitter.com', isEnabled: true, isCustom: false },
        { id: 's4', domain: 'x.com', isEnabled: true, isCustom: false },
        { id: 's5', domain: 'instagram.com', isEnabled: true, isCustom: false },
        { id: 's6', domain: 'youtube.com', isEnabled: true, isCustom: false },
        { id: 's7', domain: 'medium.com', isEnabled: true, isCustom: false }
      ];
      updated = true;
    }
    
    const hasAds = existing.configuration.trackedTags.some(t => t.label === 'Ads');
    if (!hasAds) {
      existing.configuration.trackedTags.push({ id: 't_ads', label: 'Ads', isEnabled: true });
      updated = true;
    }

    if (!existing.configuration.ignoredKeywords) {
      existing.configuration.ignoredKeywords = [];
      updated = true;
    }

    if (existing.configuration.isTrackingPaused === undefined) {
      existing.configuration.isTrackingPaused = false;
      updated = true;
    }

    // Migrate stack pinned state to favorites state
    let stackUpdated = false;
    const upgradedStack = (existing.stack || []).map(item => {
      let itemChanged = false;
      if (item.isPinned !== undefined) {
        item.isFavorite = item.isPinned;
        item.favoritedAt = item.isPinned ? (item.favoritedAt || item.timestamp) : null;
        delete item.isPinned;
        itemChanged = true;
        stackUpdated = true;
      }
      return item;
    });

    if (updated || stackUpdated) {
      const payload = {};
      if (updated) payload.configuration = existing.configuration;
      if (stackUpdated) payload.stack = upgradedStack;
      
      await chrome.storage.local.set(payload);
      console.info('[background] Upgraded existing configuration and stack.');
    }
  }

  // Programmatically inject content scripts into matching open tabs
  // on installation/update to avoid requiring tab refresh.
  if (chrome.scripting && chrome.tabs) {
    try {
      const state = await chrome.storage.local.get('configuration');
      const customSites = state.configuration?.sites?.filter(s => s.isCustom).map(s => s.domain) || [];
      const defaultSites = ['facebook.com', 'linkedin.com', 'twitter.com', 'x.com', 'instagram.com', 'youtube.com', 'medium.com'];
      const uniqueDomains = Array.from(new Set([...defaultSites, ...customSites]));
      
      const queryUrls = [];
      uniqueDomains.forEach(d => {
        queryUrls.push(`*://${d}/*`);
        queryUrls.push(`*://*.${d}/*`);
      });
      const tabs = await chrome.tabs.query({ url: queryUrls });
      
      for (const tab of tabs) {
        if (!tab.id || !tab.url) continue;
        
        // Inject polyfill helper
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['vendor/browser-polyfill.js']
        }).catch(() => {});
        
        // Inject content script
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js']
        }).catch(() => {});
      }
      console.info('[background] Programmatic content script auto-injection complete.');
    } catch (err) {
      console.warn('[background] Content script auto-injection failed:', err);
    }
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let inFlightCount = 0;

function updateInFlightCount(delta) {
  inFlightCount = Math.max(0, inFlightCount + delta);
  broadcastStateUpdate();
}

/**
 * Broadcasts a message to every extension context (side panel, popups, etc.).
 * Swallows errors from contexts that have already been destroyed.
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
        telemetry: fullState.telemetry,
        inFlightCount: inFlightCount
      }
    });
  } catch {
    // No listeners active — safe to ignore
  }
}

function getEnabledCustomLabels(trackedTags) {
  return trackedTags.filter(t => t.isEnabled && !t.isDynamic).map(t => t.label);
}

function getEnabledDynamicLabels(trackedTags) {
  return trackedTags.filter(t => t.isEnabled && t.isDynamic).map(t => t.label);
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {

        // -----------------------------------------------------------------
        // TEXT_EXTRACTED — classify incoming text and update state
        // -----------------------------------------------------------------
        case 'TEXT_EXTRACTED': {
          await updateInFlightCount(1);
          try {
            const { text, sourcePlatform, sourceUrl, isAd } = message.payload;

            // Read current state atomically
            const state = await chrome.storage.local.get(['configuration', 'metrics', 'stack', 'telemetry']);
            const config = state.configuration || {};

            // Guard 1: Ignore if tracking is paused
            if (config.isTrackingPaused) {
              sendResponse({ success: false, reason: 'paused' });
              break;
            }

            // Guard 2: Ignore if contains ignored keywords
            const ignoredKeywords = config.ignoredKeywords || [];
            const lowerText = text.toLowerCase();
            const shouldIgnore = ignoredKeywords.some(kw => lowerText.includes(kw.toLowerCase()));
            if (shouldIgnore) {
              sendResponse({ success: false, reason: 'ignored' });
              break;
            }

            const trackedTags = config.trackedTags || [];
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
                    isDynamic: true,
                    isSticky: false
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
            
            if (isAd) {
              counts['Ads'] = (counts['Ads'] || 0) + 1;
            }

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
              textSnippet:    text, // Store full body so cards can expand properly
              assignedTag:    finalCategory,
              isFavorite:     false,
              favoritedAt:    null,
              isAd:           !!isAd
            };

            const updatedStack = [newItem, ...state.stack];

            // 4. Persist
            await chrome.storage.local.set({
              configuration: { ...state.configuration, trackedTags: updatedTags },
              metrics:   { counts },
              stack:     updatedStack,
              telemetry
            });

            await broadcastStateUpdate();

            sendResponse({ success: true, category: finalCategory });
          } catch (err) {
            console.error(`[background] Error processing TEXT_EXTRACTED:`, err);
            sendResponse({ error: err.message });
          } finally {
            await updateInFlightCount(-1);
          }
          break;
        }

        // -----------------------------------------------------------------
        // CONFIG_CHANGED — persist updated tag configuration (legacy)
        // -----------------------------------------------------------------
        case 'CONFIG_CHANGED': {
          const { trackedTags } = message.payload;
          const { configuration } = await chrome.storage.local.get('configuration');

          await chrome.storage.local.set({
            configuration: { ...configuration, trackedTags }
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
            configuration: { ...configuration, trackedTags: updatedTags }
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
            configuration: { ...configuration, trackedTags: filteredTags }
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
            t.label === tagLabel ? { ...t, isDynamic: false, isSticky: false } : t
          );

          await chrome.storage.local.set({
            configuration: { ...configuration, trackedTags: updatedTags }
          });

          await broadcastStateUpdate();
          sendResponse({ success: true });
          break;
        }

        // -----------------------------------------------------------------
        // TAG_STICKY_TOGGLED — toggle dynamic tag sticky state
        // -----------------------------------------------------------------
        case 'TAG_STICKY_TOGGLED': {
          const { tag: tagLabel, isSticky } = message.payload;
          const { configuration } = await chrome.storage.local.get('configuration');

          const updatedTags = configuration.trackedTags.map(t =>
            t.label === tagLabel ? { ...t, isSticky: !!isSticky } : t
          );

          await chrome.storage.local.set({
            configuration: { ...configuration, trackedTags: updatedTags }
          });

          await broadcastStateUpdate();
          sendResponse({ success: true });
          break;
        }

        // -----------------------------------------------------------------
        // ITEM_RETAGGED — update category tag on a specific stack item
        // -----------------------------------------------------------------
        case 'ITEM_RETAGGED': {
          const { itemId, newTag } = message.payload;
          const state = await chrome.storage.local.get(['metrics', 'stack', 'configuration']);
          const stack = state.stack || [];

          let oldTag = null;
          const updatedStack = stack.map(item => {
            if (item.id === itemId) {
              oldTag = item.assignedTag;
              return { ...item, assignedTag: newTag };
            }
            return item;
          });

          if (oldTag && oldTag !== newTag) {
            const counts = { ...state.metrics.counts };
            if (counts[oldTag] > 0) {
              counts[oldTag]--;
            }
            counts[newTag] = (counts[newTag] || 0) + 1;

            await chrome.storage.local.set({
              stack: updatedStack,
              metrics: { counts }
            });
          } else {
            await chrome.storage.local.set({
              stack: updatedStack
            });
          }

          await broadcastStateUpdate();
          sendResponse({ success: true });
          break;
        }

        // -----------------------------------------------------------------
        // SITE_TOGGLED — enable or disable scanning on a site
        // -----------------------------------------------------------------
        case 'SITE_TOGGLED': {
          const { siteId, enabled } = message.payload;
          const { configuration } = await chrome.storage.local.get('configuration');

          const updatedSites = (configuration.sites || []).map(s =>
            s.id === siteId ? { ...s, isEnabled: enabled } : s
          );

          await chrome.storage.local.set({
            configuration: { ...configuration, sites: updatedSites }
          });

          await broadcastStateUpdate();
          sendResponse({ success: true });
          break;
        }

        // -----------------------------------------------------------------
        // SITE_ADDED — register a new site in configurations
        // -----------------------------------------------------------------
        case 'SITE_ADDED': {
          const { domain } = message.payload;
          const { configuration } = await chrome.storage.local.get('configuration');
          const sites = configuration.sites || [];

          const exists = sites.some(s => s.domain.toLowerCase() === domain.toLowerCase());
          if (exists) {
            sendResponse({ success: false, error: 'Site already exists' });
            break;
          }

          sites.push({
            id: 's_' + Date.now(),
            domain: domain.toLowerCase(),
            isEnabled: true,
            isCustom: true
          });

          await chrome.storage.local.set({
            configuration: { ...configuration, sites }
          });

          await broadcastStateUpdate();
          sendResponse({ success: true });
          break;
        }

        // -----------------------------------------------------------------
        // SITE_REMOVED — remove a registered site configuration
        // -----------------------------------------------------------------
        case 'SITE_REMOVED': {
          const { siteId } = message.payload;
          const { configuration } = await chrome.storage.local.get('configuration');
          const sites = configuration.sites || [];

          const filteredSites = sites.filter(s => s.id !== siteId);

          await chrome.storage.local.set({
            configuration: { ...configuration, sites: filteredSites }
          });

          await broadcastStateUpdate();
          sendResponse({ success: true });
          break;
        }

        // -----------------------------------------------------------------
        // GET_STATE — return full state snapshot
        // -----------------------------------------------------------------
        case 'GET_STATE': {
          const state = await chrome.storage.local.get(null);
          state.inFlightCount = inFlightCount;
          sendResponse(state);
          break;
        }

        // -----------------------------------------------------------------
        // FAVORITE_TOGGLED — flip the isFavorite flag on a stack item
        // -----------------------------------------------------------------
        case 'FAVORITE_TOGGLED': {
          const { itemId, isFavorite } = message.payload;
          const { stack } = await chrome.storage.local.get('stack');

          const updatedStack = stack.map(item =>
            item.id === itemId ? { ...item, isFavorite, favoritedAt: isFavorite ? Date.now() : null } : item
          );

          await chrome.storage.local.set({ stack: updatedStack });
          await broadcastStateUpdate();

          sendResponse({ success: true });
          break;
        }

        // -----------------------------------------------------------------
        // ITEM_DELETED — remove a single item from the feed list
        // -----------------------------------------------------------------
        case 'ITEM_DELETED': {
          const { itemId } = message.payload;
          const state = await chrome.storage.local.get(['metrics', 'stack']);
          const stack = state.stack || [];

          const itemToDelete = stack.find(i => i.id === itemId);
          if (!itemToDelete) {
            sendResponse({ success: false, error: 'Item not found' });
            break;
          }

          const updatedStack = stack.filter(i => i.id !== itemId);
          
          const counts = { ...state.metrics.counts };
          const tag = itemToDelete.assignedTag || 'Unclassified';
          if (counts[tag] > 0) {
            counts[tag]--;
          }
          if (itemToDelete.isAd && counts['Ads'] > 0) {
            counts['Ads']--;
          }

          await chrome.storage.local.set({
            stack: updatedStack,
            metrics: { counts }
          });

          await broadcastStateUpdate();
          sendResponse({ success: true });
          break;
        }

        // -----------------------------------------------------------------
        // CLEAR_STACK — remove un-favorited items, reset metrics
        // -----------------------------------------------------------------
        case 'CLEAR_STACK': {
          const { stack, configuration } = await chrome.storage.local.get(['stack', 'configuration']);

          // Retain only favorited items
          const favoritedItems = stack.filter(item => item.isFavorite);

          // Clear dynamic tags unless sticky
          const preservedTags = (configuration.trackedTags || []).filter(t => !t.isDynamic || t.isSticky);

          // Rebuild counts
          const counts = {};
          favoritedItems.forEach(item => {
            counts[item.assignedTag] = (counts[item.assignedTag] || 0) + 1;
            if (item.isAd) {
              counts['Ads'] = (counts['Ads'] || 0) + 1;
            }
          });

          await chrome.storage.local.set({
            configuration: { ...configuration, trackedTags: preservedTags },
            stack:   favoritedItems,
            metrics: { counts },
            telemetry: { totalProcessed: 0, classifiedCount: 0, unclassifiedCount: 0, sessionStart: Date.now(), lastProcessed: null }
          });

          await broadcastStateUpdate();
          sendResponse({ success: true });
          break;
        }

        // -----------------------------------------------------------------
        // KEYWORD_ADDED — add an ignored keyword filter
        // -----------------------------------------------------------------
        case 'KEYWORD_ADDED': {
          const { keyword } = message.payload;
          const { configuration } = await chrome.storage.local.get('configuration');
          const keywords = configuration.ignoredKeywords || [];

          const exists = keywords.some(k => k.toLowerCase() === keyword.toLowerCase());
          if (exists) {
            sendResponse({ success: false, error: 'Keyword already exists' });
            break;
          }

          keywords.push(keyword);
          configuration.ignoredKeywords = keywords;

          await chrome.storage.local.set({ configuration });
          await broadcastStateUpdate();
          sendResponse({ success: true });
          break;
        }

        // -----------------------------------------------------------------
        // KEYWORD_REMOVED — remove an ignored keyword filter
        // -----------------------------------------------------------------
        case 'KEYWORD_REMOVED': {
          const { keyword } = message.payload;
          const { configuration } = await chrome.storage.local.get('configuration');
          const keywords = configuration.ignoredKeywords || [];

          const filtered = keywords.filter(k => k !== keyword);
          configuration.ignoredKeywords = filtered;

          await chrome.storage.local.set({ configuration });
          await broadcastStateUpdate();
          sendResponse({ success: true });
          break;
        }

        // -----------------------------------------------------------------
        // IS_TRACKING_PAUSED_TOGGLED — pause or resume scanning
        // -----------------------------------------------------------------
        case 'IS_TRACKING_PAUSED_TOGGLED': {
          const { isPaused } = message.payload;
          const { configuration } = await chrome.storage.local.get('configuration');

          configuration.isTrackingPaused = !!isPaused;

          await chrome.storage.local.set({ configuration });
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

  return true;
});
