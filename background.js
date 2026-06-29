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
// Storage Wrapper
// ---------------------------------------------------------------------------

const storage = {
  async get(keys) {
    return await chrome.storage.local.get(keys);
  },

  async set(items) {
    await chrome.storage.local.set(items);
  }
};

// ---------------------------------------------------------------------------
// Side Panel — open on toolbar icon click
// ---------------------------------------------------------------------------

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// ---------------------------------------------------------------------------
// Default state — seed storage on first install / upgrade
// ---------------------------------------------------------------------------

async function ensureInitialized() {
  const existing = await storage.get(null);
  if (!existing.configuration || !existing.configuration.trackedTags || existing.configuration.trackedTags.length === 0) {
    const defaultState = {
      configuration: {
        trackedTags: [
          { id: 't1',  label: 'Health',             isEnabled: true },
          { id: 't2',  label: 'Jobs',               isEnabled: true },
          { id: 't3',  label: 'Politics',           isEnabled: true },
          { id: 't4',  label: 'Tech/AI',            isEnabled: true },
          { id: 't5',  label: 'Weather',            isEnabled: true },
          { id: 't6',  label: 'Ad',                 isEnabled: true },
          { id: 't7',  label: 'News',               isEnabled: true },
          { id: 't8',  label: 'Entertainment',      isEnabled: true },
          { id: 't9',  label: 'Promotion',          isEnabled: true },
          { id: 't10', label: 'Personal Opinion',   isEnabled: true },
          { id: 't11', label: 'Portfolio',          isEnabled: true },
          { id: 't12', label: 'Product Showcase',   isEnabled: true },
          { id: 't13', label: 'Immigration',        isEnabled: true },
          { id: 't14', label: 'Migration',          isEnabled: true },
          { id: 't15', label: 'Study',              isEnabled: true },
          { id: 't16', label: 'International News', isEnabled: true },
          { id: 't17', label: 'Sports',             isEnabled: true },
          { id: 't18', label: 'Events',             isEnabled: true },
          { id: 't19', label: 'Blog',               isEnabled: true },
          { id: 't20', label: 'Vlog',               isEnabled: true },
          { id: 't21', label: 'Culture',            isEnabled: true },
          { id: 't22', label: 'NGO',                isEnabled: true },
          { id: 't23', label: 'Policy',             isEnabled: true },
          { id: 't24', label: 'Release',            isEnabled: true },
          { id: 't25', label: 'History',            isEnabled: true }
        ],
        sites: [
          { id: 's_all', domain: '*', isEnabled: false, isCustom: false },
          { id: 's1', domain: 'facebook.com', isEnabled: true, isCustom: false },
          { id: 's2', domain: 'linkedin.com', isEnabled: true, isCustom: false },
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
    };
    await storage.set(defaultState);
    console.info('[background] Default state initialized.');
    return defaultState;
  }
  return existing;
}

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await ensureInitialized();
  
  if (existing.configuration) {
    if (existing.inFlightCount === undefined) {
      existing.inFlightCount = 0;
      await storage.set({ inFlightCount: 0 });
    }
    // Upgrade existing state to include sites & Ads tag if missing
    let updated = false;
    
    if (!existing.configuration.sites) {
      existing.configuration.sites = [
        { id: 's_all', domain: '*', isEnabled: false, isCustom: false },
        { id: 's1', domain: 'facebook.com', isEnabled: true, isCustom: false },
        { id: 's2', domain: 'linkedin.com', isEnabled: true, isCustom: false },
        { id: 's4', domain: 'x.com', isEnabled: true, isCustom: false },
        { id: 's5', domain: 'instagram.com', isEnabled: true, isCustom: false },
        { id: 's6', domain: 'youtube.com', isEnabled: true, isCustom: false },
        { id: 's7', domain: 'medium.com', isEnabled: true, isCustom: false }
      ];
      updated = true;
    } else {
      const hasAnySite = existing.configuration.sites.some(s => s.domain === '*');
      if (!hasAnySite) {
        existing.configuration.sites.unshift({ id: 's_all', domain: '*', isEnabled: false, isCustom: false });
        updated = true;
      }

      const hasTwitter = existing.configuration.sites.some(s => s.domain === 'twitter.com');
      if (hasTwitter) {
        // Remove twitter.com
        existing.configuration.sites = existing.configuration.sites.filter(s => s.domain !== 'twitter.com');
        // Ensure x.com exists in the list
        const hasX = existing.configuration.sites.some(s => s.domain === 'x.com');
        if (!hasX) {
          existing.configuration.sites.push({ id: 's4', domain: 'x.com', isEnabled: true, isCustom: false });
        }
        updated = true;
      }
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
      
      await storage.set(payload);
      console.info('[background] Upgraded existing configuration and stack.');
    }
  }

  // Programmatically inject content scripts into matching open tabs
  // on installation/update to avoid requiring tab refresh.
  if (chrome.scripting && chrome.tabs) {
    try {
      const state = await storage.get('configuration');
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
// Dynamic Content Script Injection
// ---------------------------------------------------------------------------

function checkIfSiteEnabled(hostname, sites) {
  let lowerHost = hostname.toLowerCase();
  if (lowerHost === 'twitter.com' || lowerHost.endsWith('.twitter.com')) {
    lowerHost = 'x.com';
  }
  const defaultSites = ['facebook.com', 'linkedin.com', 'x.com', 'instagram.com', 'youtube.com', 'medium.com'];
  
  if (sites && sites.length > 0) {
    const anySite = sites.find(s => s.domain === '*');
    if (anySite && anySite.isEnabled) {
      return true;
    }
    
    const match = sites.find(s => {
      if (s.domain === '*') return false;
      const domain = s.domain.toLowerCase();
      return lowerHost === domain || lowerHost.endsWith('.' + domain);
    });
    if (match) {
      return match.isEnabled !== false;
    }
  }
  
  // Default sites are enabled unless explicitly disabled in config
  return defaultSites.some(d => lowerHost === d || lowerHost.endsWith('.' + d));
}

async function ensureContentScriptInjected(tabId, url) {
  if (!tabId || !url) return;
  if (!url.startsWith('http://') && !url.startsWith('https://')) return;

  try {
    const hostname = new URL(url).hostname.replace('www.', '').toLowerCase();
    const state = await storage.get('configuration');
    const config = state.configuration || {};
    
    const defaultSites = ['facebook.com', 'linkedin.com', 'x.com', 'instagram.com', 'youtube.com', 'medium.com'];
    const allConfiguredSites = config.sites || defaultSites.map((d, i) => ({ id: 's' + i, domain: d, isEnabled: true }));

    const isEnabled = checkIfSiteEnabled(hostname, allConfiguredSites);
    if (!isEnabled) return;

    // Ping the tab to check if the content script is active
    chrome.tabs.sendMessage(tabId, { type: 'PING' }, () => {
      if (chrome.runtime.lastError) {
        console.info(`[background] Tab ${tabId} has no active content script. Injecting...`);
        (async () => {
          try {
            await chrome.scripting.executeScript({
              target: { tabId },
              files: ['vendor/browser-polyfill.js']
            });
            await chrome.scripting.executeScript({
              target: { tabId },
              files: ['content.js']
            });
            console.info(`[background] Injected content script successfully on tab ${tabId}`);
          } catch (err) {
            console.warn(`[background] Failed to inject content script on tab ${tabId}:`, err);
          }
        })();
      }
    });
  } catch (err) {
    // Ignore URL parse errors
  }
}

// Track tab activation and loading updates to ensure content scripts are active
chrome.tabs.onActivated.addListener(activeInfo => {
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (chrome.runtime.lastError || !tab || !tab.url) return;
    ensureContentScriptInjected(tab.id, tab.url);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && tab.url) {
    ensureContentScriptInjected(tabId, tab.url);
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
    const fullState = await storage.get(null);
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

            let normalizedPlatform = sourcePlatform || '';
            const lowerPlatform = normalizedPlatform.toLowerCase();
            if (lowerPlatform === 'twitter.com' || lowerPlatform.endsWith('.twitter.com')) {
              normalizedPlatform = 'x.com';
            }

            const state = await storage.get(['configuration', 'metrics', 'stack', 'telemetry']);
            const config = state.configuration || {};
            let stack = state.stack || [];

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

            // Deduplication logic: Check if we already have this sourceUrl in the stack
            let existingItemIndex = -1;
            let textToClassify = text;
            
            if (sourceUrl && sourceUrl.startsWith('http')) {
              existingItemIndex = stack.findIndex(item => item.sourceUrl === sourceUrl);
            }
            
            if (existingItemIndex !== -1) {
              const existingItem = stack[existingItemIndex];
              // Avoid duplicating text if it's already a substring
              if (!existingItem.textSnippet.includes(text)) {
                textToClassify = existingItem.textSnippet + '\n\n' + text;
              } else {
                // Exactly the same or subset, no need to reclassify or duplicate
                sendResponse({ success: true, reason: 'duplicate_text' });
                break;
              }
            }

            const trackedTags = config.trackedTags || [];
            const enabledCustom = getEnabledCustomLabels(trackedTags);
            const enabledDynamic = getEnabledDynamicLabels(trackedTags);

            // Run the inference pipeline (Tier 1 → Tier 2)
            const { tags: classifiedTags, dynamicTag } = await classify(textToClassify, normalizedPlatform, enabledCustom, enabledDynamic);

            // --- Atomic state mutation ---
            let finalCategory = classifiedTags && classifiedTags.length > 0 ? classifiedTags[0].name : 'Unclassified';
            const updatedTags = [...trackedTags];

            // Register new dynamic tag if matched
            if (finalCategory === 'Unclassified' && dynamicTag) {
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
            
            // Ensure the dynamic tag is in the tags array if it became the final category
            let storedTags = classifiedTags || [];
            if (finalCategory !== 'Unclassified' && storedTags.length === 0) {
              storedTags = [{ name: finalCategory, score: 1.0 }];
            }

            let updatedStack = [...stack];
            const counts = { ...state.metrics.counts };
            const telemetry = state.telemetry || { totalProcessed: 0, classifiedCount: 0, unclassifiedCount: 0, sessionStart: Date.now() };

            if (existingItemIndex !== -1) {
              const existingItem = updatedStack[existingItemIndex];
              
              // Remove old category from counts
              if (counts[existingItem.assignedTag] > 0) {
                counts[existingItem.assignedTag]--;
              }
              if (existingItem.isAd && counts['Ads'] > 0) {
                counts['Ads']--;
              }
              if (existingItem.assignedTag === 'Unclassified') {
                telemetry.unclassifiedCount--;
              } else {
                telemetry.classifiedCount--;
              }
              telemetry.totalProcessed--;

              // Create updated item
              const updatedItem = {
                ...existingItem,
                textSnippet: textToClassify,
                assignedTag: finalCategory,
                tags: storedTags,
                isAd: existingItem.isAd || !!isAd
              };
              
              // Move it to the top
              updatedStack.splice(existingItemIndex, 1);
              updatedStack.unshift(updatedItem);
            } else {
              // Create new item
              const newItem = {
                id:             `item_${Date.now()}`,
                timestamp:      Date.now(),
                sourcePlatform: normalizedPlatform,
                sourceUrl:      sourceUrl || '',
                textSnippet:    textToClassify, // Store full body so cards can expand properly
                assignedTag:    finalCategory,
                tags:           storedTags,
                isFavorite:     false,
                favoritedAt:    null,
                isAd:           !!isAd
              };
              updatedStack.unshift(newItem);
            }

            // 1. Increment metrics counter
            counts[finalCategory] = (counts[finalCategory] || 0) + 1;
            if (isAd || (existingItemIndex !== -1 && updatedStack[0].isAd)) {
              counts['Ads'] = (counts['Ads'] || 0) + 1;
            }

            // 2. Update telemetry
            telemetry.totalProcessed++;
            if (finalCategory === 'Unclassified') {
              telemetry.unclassifiedCount++;
            } else {
              telemetry.classifiedCount++;
            }
            telemetry.lastProcessed = Date.now();

            // 4. Persist
            await storage.set({
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
          const { configuration } = await storage.get('configuration');

          await storage.set({
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
          const { configuration } = await storage.get('configuration');

          const updatedTags = configuration.trackedTags.map(t =>
            t.label === tag ? { ...t, isEnabled: enabled } : t
          );

          await storage.set({
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
          const { configuration } = await storage.get('configuration');

          const filteredTags = configuration.trackedTags.filter(
            t => t.label !== tagToRemove
          );

          await storage.set({
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
          const { configuration } = await storage.get('configuration');

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

          await storage.set({ configuration });

          await broadcastStateUpdate();
          sendResponse({ success: true });
          break;
        }

        // -----------------------------------------------------------------
        // TAG_PROMOTED — elevate a dynamic tag to custom status
        // -----------------------------------------------------------------
        case 'TAG_PROMOTED': {
          const { tag: tagLabel } = message.payload;
          const { configuration } = await storage.get('configuration');

          let exists = false;
          const updatedTags = configuration.trackedTags.map(t => {
            if (t.label.toLowerCase() === tagLabel.toLowerCase()) {
              exists = true;
              return { ...t, isDynamic: false, isSticky: false };
            }
            return t;
          });

          if (!exists) {
            updatedTags.push({
              id: 't_' + Date.now(),
              label: tagLabel,
              isEnabled: true,
              isCustom: true
            });
          }

          await storage.set({
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
          const { configuration } = await storage.get('configuration');

          const updatedTags = configuration.trackedTags.map(t =>
            t.label === tagLabel ? { ...t, isSticky: !!isSticky } : t
          );

          await storage.set({
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
          const state = await storage.get(['metrics', 'stack', 'configuration']);
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

            await storage.set({
              stack: updatedStack,
              metrics: { counts }
            });
          } else {
            await storage.set({
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
          const { configuration } = await storage.get('configuration');

          const updatedSites = (configuration.sites || []).map(s =>
            s.id === siteId ? { ...s, isEnabled: enabled } : s
          );

          await storage.set({
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
          const { configuration } = await storage.get('configuration');
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

          await storage.set({
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
          const { configuration } = await storage.get('configuration');
          const sites = configuration.sites || [];

          const filteredSites = sites.filter(s => s.id !== siteId);

          await storage.set({
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
          let state = await storage.get(null);
          if (!state.configuration || !state.configuration.trackedTags || state.configuration.trackedTags.length === 0) {
            state = await ensureInitialized();
          }
          state.inFlightCount = inFlightCount;
          sendResponse(state);
          break;
        }

        // -----------------------------------------------------------------
        // FAVORITE_TOGGLED — flip the isFavorite flag on a stack item
        // -----------------------------------------------------------------
        case 'FAVORITE_TOGGLED': {
          const { itemId, isFavorite } = message.payload;
          const { stack } = await storage.get('stack');

          const updatedStack = stack.map(item =>
            item.id === itemId ? { ...item, isFavorite, favoritedAt: isFavorite ? Date.now() : null } : item
          );

          await storage.set({ stack: updatedStack });
          await broadcastStateUpdate();

          sendResponse({ success: true });
          break;
        }

        // -----------------------------------------------------------------
        // ITEM_DELETED — remove a single item from the feed list
        // -----------------------------------------------------------------
        case 'ITEM_DELETED': {
          const { itemId } = message.payload;
          const state = await storage.get(['metrics', 'stack']);
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

          await storage.set({
            stack: updatedStack,
            metrics: { counts }
          });

          await broadcastStateUpdate();
          sendResponse({ success: true });
          break;
        }

        case 'CLEAR_STACK': {
          const { stack, configuration, telemetry } = await storage.get(['stack', 'configuration', 'telemetry']);
          const targetTag = message.payload && message.payload.tag;

          let updatedStack;
          let preservedTags = configuration.trackedTags || [];
          let updatedTelemetry;

          if (targetTag && targetTag !== 'All') {
            // Retain items: keep if not target tag or if favorited
            if (targetTag === 'Ads') {
              updatedStack = stack.filter(item => !item.isAd || item.isFavorite);
            } else {
              updatedStack = stack.filter(item => item.assignedTag !== targetTag || item.isFavorite);
            }

            // Remove tag if dynamic, not sticky, and no items left
            if (targetTag !== 'Favorites' && targetTag !== 'Ads') {
              const hasItems = updatedStack.some(item => item.assignedTag === targetTag);
              if (!hasItems) {
                preservedTags = preservedTags.filter(t => {
                  const label = typeof t === 'string' ? t : t.label;
                  if (label === targetTag) {
                    return !t.isDynamic || t.isSticky;
                  }
                  return true;
                });
              }
            }

            // Keep telemetry as is
            updatedTelemetry = telemetry || { totalProcessed: 0, classifiedCount: 0, unclassifiedCount: 0, sessionStart: Date.now(), lastProcessed: null };
          } else {
            // Clear all: retain only favorited items
            updatedStack = stack.filter(item => item.isFavorite);

            // Clear all dynamic tags unless sticky
            preservedTags = preservedTags.filter(t => !t.isDynamic || t.isSticky);

            // Reset telemetry completely
            updatedTelemetry = { totalProcessed: 0, classifiedCount: 0, unclassifiedCount: 0, sessionStart: Date.now(), lastProcessed: null };
          }

          // Rebuild counts
          const counts = {};
          updatedStack.forEach(item => {
            counts[item.assignedTag] = (counts[item.assignedTag] || 0) + 1;
            if (item.isAd) {
              counts['Ads'] = (counts['Ads'] || 0) + 1;
            }
          });

          await storage.set({
            configuration: { ...configuration, trackedTags: preservedTags },
            stack:   updatedStack,
            metrics: { counts },
            telemetry: updatedTelemetry
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
          const { configuration } = await storage.get('configuration');
          const keywords = configuration.ignoredKeywords || [];

          const exists = keywords.some(k => k.toLowerCase() === keyword.toLowerCase());
          if (exists) {
            sendResponse({ success: false, error: 'Keyword already exists' });
            break;
          }

          keywords.push(keyword);
          configuration.ignoredKeywords = keywords;

          await storage.set({ configuration });
          await broadcastStateUpdate();
          sendResponse({ success: true });
          break;
        }

        // -----------------------------------------------------------------
        // KEYWORD_REMOVED — remove an ignored keyword filter
        // -----------------------------------------------------------------
        case 'KEYWORD_REMOVED': {
          const { keyword } = message.payload;
          const { configuration } = await storage.get('configuration');
          const keywords = configuration.ignoredKeywords || [];

          const filtered = keywords.filter(k => k !== keyword);
          configuration.ignoredKeywords = filtered;

          await storage.set({ configuration });
          await broadcastStateUpdate();
          sendResponse({ success: true });
          break;
        }

        // -----------------------------------------------------------------
        // IS_TRACKING_PAUSED_TOGGLED — pause or resume scanning
        // -----------------------------------------------------------------
        case 'IS_TRACKING_PAUSED_TOGGLED': {
          const { isPaused } = message.payload;
          const { configuration } = await storage.get('configuration');

          configuration.isTrackingPaused = !!isPaused;

          await storage.set({ configuration });
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
          const { stack } = await storage.get('stack');
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

// ---------------------------------------------------------------------------
// 2nd Pass Evaluation (Idle Retry)
// ---------------------------------------------------------------------------
if (chrome.alarms) {
  chrome.alarms.create('idleRetry', { periodInMinutes: 1 });

  chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'idleRetry') {
    // Only proceed if there's no active parsing queue
    if (inFlightCount > 0) return;

    const state = await storage.get(['configuration', 'metrics', 'stack', 'telemetry']);
    if (!state.stack || state.stack.length === 0) return;

    // Find Unclassified items
    const unclassifiedItems = state.stack.filter(item => item.assignedTag === 'Unclassified');
    if (unclassifiedItems.length === 0) return;

    // Take a small batch to not overwhelm the system
    const batch = unclassifiedItems.slice(0, 5);
    
    if (batch.length > 0) {
      console.info(`[background] 2nd pass evaluation: processing ${batch.length} items`);
    }

    const trackedTags = state.configuration?.trackedTags || [];
    const enabledCustom = getEnabledCustomLabels(trackedTags);
    const enabledDynamic = getEnabledDynamicLabels(trackedTags);

    let stackChanged = false;
    let tagsChanged = false;
    const updatedTags = [...trackedTags];
    const counts = { ...(state.metrics?.counts || {}) };

    for (const item of batch) {
      // In flight
      updateInFlightCount(1);
      
      try {
        const { tags: classifiedTags, dynamicTag } = await classify(
          item.textSnippet, 
          item.sourcePlatform, 
          enabledCustom, 
          enabledDynamic
        );
        
        let finalCategory = classifiedTags && classifiedTags.length > 0 ? classifiedTags[0].name : 'Unclassified';
        
        if (finalCategory === 'Unclassified' && dynamicTag) {
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
              tagsChanged = true;
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

        if (finalCategory !== 'Unclassified') {
          // It successfully re-classified!
          let storedTags = classifiedTags || [];
          if (storedTags.length === 0) {
            storedTags = [{ name: finalCategory, score: 1.0 }];
          }
          
          item.assignedTag = finalCategory;
          item.tags = storedTags;
          stackChanged = true;
          
          counts['Unclassified'] = Math.max(0, (counts['Unclassified'] || 0) - 1);
          counts[finalCategory] = (counts[finalCategory] || 0) + 1;
        }
      } catch (err) {
        console.warn(`[background] Retry classification failed for item ${item.id}:`, err);
      } finally {
        updateInFlightCount(-1);
      }
    }

    if (stackChanged || tagsChanged) {
      const payload = {
        stack: state.stack,
        metrics: { counts }
      };
      if (tagsChanged) {
        payload.configuration = { ...state.configuration, trackedTags: updatedTags };
      }
      await storage.set(payload);
      await broadcastStateUpdate();
    }
  }
});
}
