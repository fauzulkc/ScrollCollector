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

import { classify, checkEngineStatus, evaluateMatch, evaluateMatchWithReason, extractTagsFromPrompt, evaluateAuthorMatch, heuristicAuthorMatch } from './lib/inference-engine.js';

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

  const defaultPrompts = {
    'Health': 'Identify posts related to health, medicine, doctors, hospitals, fitness, wellness, or nutrition.',
    'Jobs': 'Identify posts related to job postings, career opportunities, hiring, recruitment, resumes, or interviews.',
    'Politics': 'Identify posts related to government, elections, political parties, public policy, or legislation.',
    'Tech/AI': 'Identify posts related to software, technology, programming, developer tools, artificial intelligence, or machine learning.',
    'Weather': 'Identify posts related to weather forecasts, storms, climate, temperatures, sunny, rain, or snow.',
    'Ad': 'Identify advertisements, sponsored content, products for sale, or promotional codes.',
    'News': 'Identify breaking news updates, media reports, journalism, headlines, or press coverage.',
    'Entertainment': 'Identify posts related to movies, television, music, concerts, gaming, or celebrity culture.',
    'Promotion': 'Identify giveaways, special offers, discounts, brand campaigns, or sales promotions.',
    'Personal Opinion': 'Identify personal viewpoints, personal updates, opinions, thoughts, or editorial reflections.',
    'Portfolio': 'Identify project showcases, personal portfolios, designs, case studies, or displays of professional work.',
    'Product Showcase': 'Identify product launches, demonstrations, features, release highlights, or new tools.',
    'Immigration': 'Identify posts related to immigration processes, visas, passports, citizenship, or green cards.',
    'Migration': 'Identify posts related to relocation, moving to another region or country, expats, or emigration.',
    'Study': 'Identify posts related to academic studies, university, learning resources, college courses, or scholarships.',
    'International News': 'Identify news about international events, global affairs, foreign relations, or world news.',
    'Sports': 'Identify posts related to athletic sports, games, leagues, matches, players, championships, or coaches.',
    'Events': 'Identify posts related to upcoming events, conferences, webinars, meetups, festivals, or workshops.',
    'Blog': 'Identify references to blog articles, long-form posts, reading materials, or updates for written sites.',
    'Vlog': 'Identify video logs, YouTube clips, vlog updates, or video content updates.',
    'Culture': 'Identify posts related to cultural heritage, traditions, societal customs, art, or historical celebrations.',
    'NGO': 'Identify posts related to non-governmental organizations, charities, volunteering, non-profits, or donations.',
    'Policy': 'Identify posts related to policy changes, company guidelines, compliance rules, or regulatory frameworks.',
    'Release': 'Identify software releases, product versions, changelogs, updates, or patch notes.',
    'History': 'Identify posts related to historical events, ancient civilizations, timelines, archives, or heritage.'
  };

  if (!existing.configuration || !existing.configuration.trackedTags || existing.configuration.trackedTags.length === 0) {
    const defaultState = {
      configuration: {
        trackedTags: [
          { id: 't1',  label: 'Health',             isEnabled: true, prompt: defaultPrompts['Health'] },
          { id: 't2',  label: 'Jobs',               isEnabled: true, prompt: defaultPrompts['Jobs'] },
          { id: 't3',  label: 'Politics',           isEnabled: true, prompt: defaultPrompts['Politics'] },
          { id: 't4',  label: 'Tech/AI',            isEnabled: true, prompt: defaultPrompts['Tech/AI'] },
          { id: 't5',  label: 'Weather',            isEnabled: true, prompt: defaultPrompts['Weather'] },
          { id: 't6',  label: 'Ad',                 isEnabled: true, prompt: defaultPrompts['Ad'] },
          { id: 't7',  label: 'News',               isEnabled: true, prompt: defaultPrompts['News'] },
          { id: 't8',  label: 'Entertainment',      isEnabled: true, prompt: defaultPrompts['Entertainment'] },
          { id: 't9',  label: 'Promotion',          isEnabled: true, prompt: defaultPrompts['Promotion'] },
          { id: 't10', label: 'Personal Opinion',   isEnabled: true, prompt: defaultPrompts['Personal Opinion'] },
          { id: 't11', label: 'Portfolio',          isEnabled: true, prompt: defaultPrompts['Portfolio'] },
          { id: 't12', label: 'Product Showcase',   isEnabled: true, prompt: defaultPrompts['Product Showcase'] },
          { id: 't13', label: 'Immigration',        isEnabled: true, prompt: defaultPrompts['Immigration'] },
          { id: 't14', label: 'Migration',          isEnabled: true, prompt: defaultPrompts['Migration'] },
          { id: 't15', label: 'Study',              isEnabled: true, prompt: defaultPrompts['Study'] },
          { id: 't16', label: 'International News', isEnabled: true, prompt: defaultPrompts['International News'] },
          { id: 't17', label: 'Sports',             isEnabled: true, prompt: defaultPrompts['Sports'] },
          { id: 't18', label: 'Events',             isEnabled: true, prompt: defaultPrompts['Events'] },
          { id: 't19', label: 'Blog',               isEnabled: true, prompt: defaultPrompts['Blog'] },
          { id: 't20', label: 'Vlog',               isEnabled: true, prompt: defaultPrompts['Vlog'] },
          { id: 't21', label: 'Culture',            isEnabled: true, prompt: defaultPrompts['Culture'] },
          { id: 't22', label: 'NGO',                isEnabled: true, prompt: defaultPrompts['NGO'] },
          { id: 't23', label: 'Policy',             isEnabled: true, prompt: defaultPrompts['Policy'] },
          { id: 't24', label: 'Release',            isEnabled: true, prompt: defaultPrompts['Release'] },
          { id: 't25', label: 'History',            isEnabled: true, prompt: defaultPrompts['History'] }
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
        ignoredTags: [],
        ignoredLinks: [],
        ignoredDomains: [],
        isTrackingPaused: false,
        matchPrompt: '',
        isMatchPromptEnabled: false
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

  // Migration: ensure all existing tags have a prompt property
  let mutated = false;
  if (existing.configuration && existing.configuration.trackedTags) {
    for (const tag of existing.configuration.trackedTags) {
      if (tag.prompt === undefined || tag.prompt === null) {
        tag.prompt = defaultPrompts[tag.label] || `Identify posts related to ${tag.label}.`;
        mutated = true;
      }
    }
  }
  if (mutated) {
    await storage.set(existing);
    console.info('[background] Migration: Populated missing prompts for trackedTags.');
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

    if (!existing.configuration.ignoredTags) {
      existing.configuration.ignoredTags = [];
      updated = true;
    }

    if (!existing.configuration.ignoredLinks) {
      existing.configuration.ignoredLinks = [];
      updated = true;
    }

    if (!existing.configuration.ignoredDomains) {
      existing.configuration.ignoredDomains = [];
      updated = true;
    }

    if (existing.configuration.isTrackingPaused === undefined) {
      existing.configuration.isTrackingPaused = false;
      updated = true;
    }

    if (existing.configuration.isMatchPromptEnabled === undefined) {
      existing.configuration.isMatchPromptEnabled = false;
      existing.configuration.matchPrompt = '';
      existing.configuration.matchPromptTags = [];
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

    // Migrate/populate missing canonicalAuthorName fields
    const authorMigrationUpdated = migrateCanonicalAuthors(upgradedStack || existing.stack || []);
    if (authorMigrationUpdated) {
      stackUpdated = true;
    }

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

function getEnabledCustomTags(trackedTags) {
  return trackedTags.filter(t => t.isEnabled && !t.isDynamic).map(t => ({ label: t.label, prompt: t.prompt }));
}

function getEnabledDynamicLabels(trackedTags) {
  return trackedTags.filter(t => t.isEnabled && t.isDynamic).map(t => t.label);
}

async function refreshStackInference() {
  console.info('[background] Refreshing stack inference after prompt change...');
  const state = await storage.get(null);
  const config = state.configuration;
  const stack = state.stack || [];
  const trackedTags = config.trackedTags || [];
  
  const enabledCustom = getEnabledCustomTags(trackedTags);
  const enabledDynamic = getEnabledDynamicLabels(trackedTags);
  
  const newStack = [];
  const counts = {};
  let classifiedCount = 0;
  let unclassifiedCount = 0;

  for (const item of stack) {
    let matchInfo = {
      engine: 'Rule-based Classifier',
      globalMatchedPhrases: [],
      globalMatchedKeywords: []
    };

    if (config.isMatchPromptEnabled && config.matchPrompt && config.matchPrompt.trim().length > 0) {
      const evalResult = await evaluateMatchWithReason(item.textSnippet, item.sourcePlatform, config.matchPrompt);
      if (!evalResult.doesMatch) {
        // Drop items that don't match the new global eval prompt
        continue;
      }
      matchInfo.globalMatchPrompt = config.matchPrompt;
      matchInfo.globalMatchedPhrases = evalResult.matchedPhrases || [];
      matchInfo.globalMatchedKeywords = evalResult.matchedKeywords || [];
      matchInfo.globalEngine = evalResult.engine || 'Rule-based Classifier';
    }

    let finalCategory = item.assignedTag;
    let storedTags = item.tags || [];
    
    if (item.matchInfo?.manual) {
      // Keep manual override
      matchInfo = item.matchInfo;
    } else {
      const classifyResult = await classify(item.textSnippet, item.sourcePlatform, enabledCustom, enabledDynamic);
      storedTags = classifyResult.tags || [];
      finalCategory = storedTags.length > 0 ? storedTags[0].name : 'Unclassified';
      
      matchInfo.engine = classifyResult.engine || 'Rule-based Classifier';
      const primaryTagMatch = storedTags.length > 0 ? storedTags[0] : null;
      if (primaryTagMatch && primaryTagMatch.hitKeywords) {
        matchInfo.matchedKeywords = primaryTagMatch.hitKeywords;
      }
    }

    const updatedItem = {
      ...item,
      assignedTag: finalCategory,
      tags: storedTags,
      matchInfo: matchInfo
    };
    newStack.push(updatedItem);

    // Update counts
    counts[finalCategory] = (counts[finalCategory] || 0) + 1;
    if (updatedItem.isAd) {
      counts['Ads'] = (counts['Ads'] || 0) + 1;
    }
    if (finalCategory === 'Unclassified') {
      unclassifiedCount++;
    } else {
      classifiedCount++;
    }
  }

  // Update state
  const updatedTelemetry = {
    ...state.telemetry,
    totalProcessed: newStack.length,
    classifiedCount,
    unclassifiedCount,
    lastProcessed: Date.now()
  };

  await storage.set({
    stack: newStack,
    metrics: { counts },
    telemetry: updatedTelemetry
  });

  await broadcastStateUpdate();
  console.info(`[background] Refresh complete. Updated stack size: ${newStack.length}`);
}

let refreshDebounceTimeout = null;
function triggerRefreshStackInference() {
  if (refreshDebounceTimeout) {
    clearTimeout(refreshDebounceTimeout);
  }
  refreshDebounceTimeout = setTimeout(() => {
    refreshStackInference().catch(err => {
      console.error('[background] Error refreshing stack inference:', err);
    });
  }, 1000); // 1s debounce
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
            const { text, sourcePlatform, sourceUrl, authorName, authorUrl, isAd } = message.payload;

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
            const enabledCustom = getEnabledCustomTags(trackedTags);
            const enabledDynamic = getEnabledDynamicLabels(trackedTags);

            let matchInfo = {
              engine: 'Rule-based Classifier',
              globalMatchedPhrases: [],
              globalMatchedKeywords: []
            };

            // If Match Prompt mode is enabled, evaluate it first
            if (config.isMatchPromptEnabled && config.matchPrompt && config.matchPrompt.trim().length > 0) {
              const evalResult = await evaluateMatchWithReason(textToClassify, normalizedPlatform, config.matchPrompt);
              if (!evalResult.doesMatch) {
                // Drop the item silently
                sendResponse({ success: false, reason: 'eval_match_failed' });
                break;
              }
              matchInfo.globalMatchPrompt = config.matchPrompt;
              matchInfo.globalMatchedPhrases = evalResult.matchedPhrases || [];
              matchInfo.globalMatchedKeywords = evalResult.matchedKeywords || [];
              matchInfo.globalEngine = evalResult.engine || 'Rule-based Classifier';
            }

            // Run the inference pipeline (Tier 1 → Tier 2)
            const classifyResult = await classify(textToClassify, normalizedPlatform, enabledCustom, enabledDynamic);
            const { tags: classifiedTags, dynamicTag } = classifyResult;

            matchInfo.engine = classifyResult.engine || 'Rule-based Classifier';
            const primaryTagMatch = classifiedTags && classifiedTags.length > 0 ? classifiedTags[0] : null;
            if (primaryTagMatch && primaryTagMatch.hitKeywords) {
              matchInfo.matchedKeywords = primaryTagMatch.hitKeywords;
            }

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
            
            // Let's resolve the canonical author name!
            let canonicalAuthorName = authorName || '';
            if (authorName) {
              // Extract unique author names and their platforms/urls from current stack
              const existingAuthors = [];
              const seenAuthors = new Set();
              for (const item of stack) {
                if (item.authorName && !seenAuthors.has(item.canonicalAuthorName || item.authorName)) {
                  const cName = item.canonicalAuthorName || item.authorName;
                  seenAuthors.add(cName);
                  existingAuthors.push({
                    name: item.authorName,
                    canonicalName: cName,
                    platform: item.sourcePlatform,
                    url: item.authorUrl
                  });
                }
              }

              // Try to find a match among existing authors
              let foundMatch = null;
              for (const extAuth of existingAuthors) {
                const isSame = await evaluateAuthorMatch(
                  { name: authorName, platform: normalizedPlatform, url: authorUrl || '' },
                  { name: extAuth.name, platform: extAuth.platform, url: extAuth.url || '' }
                );
                if (isSame) {
                  foundMatch = extAuth;
                  break;
                }
              }

              if (foundMatch) {
                canonicalAuthorName = foundMatch.canonicalName;
              } else {
                canonicalAuthorName = authorName; // It's a new author
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
                authorName: authorName || existingItem.authorName || '',
                authorUrl: authorUrl || existingItem.authorUrl || '',
                canonicalAuthorName: canonicalAuthorName || existingItem.canonicalAuthorName || existingItem.authorName || '',
                isAd: existingItem.isAd || !!isAd,
                matchInfo
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
                authorName:     authorName || '',
                authorUrl:      authorUrl || '',
                canonicalAuthorName: canonicalAuthorName || authorName || '',
                textSnippet:    textToClassify, // Store full body so cards can expand properly
                assignedTag:    finalCategory,
                tags:           storedTags,
                isFavorite:     false,
                favoritedAt:    null,
                isAd:           !!isAd,
                matchInfo
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
        // TOGGLE_MATCH_PROMPT — enable/disable the eval match prompt feature
        // -----------------------------------------------------------------
        case 'TOGGLE_MATCH_PROMPT': {
          const { isEnabled } = message.payload;
          const { configuration } = await storage.get('configuration');
          
          await storage.set({
            configuration: { ...configuration, isMatchPromptEnabled: isEnabled }
          });

          await broadcastStateUpdate();
          triggerRefreshStackInference();
          sendResponse({ success: true });
          break;
        }

        // -----------------------------------------------------------------
        // UPDATE_MATCH_PROMPT — save the text for the eval match prompt
        // -----------------------------------------------------------------
        case 'UPDATE_MATCH_PROMPT': {
          const { prompt } = message.payload;
          const { configuration } = await storage.get('configuration');

          await storage.set({
            configuration: { ...configuration, matchPrompt: prompt }
          });

          await broadcastStateUpdate();
          triggerRefreshStackInference();
          sendResponse({ success: true });
          break;
        }

        // -----------------------------------------------------------------
        // GENERATE_PROMPT_TAGS — generate AI tags for the prompt
        // -----------------------------------------------------------------
        case 'GENERATE_PROMPT_TAGS': {
          const { prompt } = message.payload;
          extractTagsFromPrompt(prompt).then(async tags => {
            const { configuration } = await storage.get('configuration');
            configuration.matchPromptTags = tags;
            await storage.set({ configuration });
            await broadcastStateUpdate();
            sendResponse({ success: true, tags });
          }).catch(err => {
            console.error('Error in GENERATE_PROMPT_TAGS', err);
            sendResponse({ success: false, tags: [] });
          });
          return true; // Keep channel open for async response
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
          const { tag: newTagLabel, prompt: newTagPrompt } = message.payload;
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
            prompt: newTagPrompt || `Find posts related to ${newTagLabel}.`,
            isEnabled: true
          });

          await storage.set({ configuration });

          await broadcastStateUpdate();
          triggerRefreshStackInference();
          sendResponse({ success: true });
          break;
        }

        // -----------------------------------------------------------------
        // TAG_PROMPT_UPDATED — update the eval prompt for an existing tag
        // -----------------------------------------------------------------
        case 'TAG_PROMPT_UPDATED': {
          const { tag: tagLabel, prompt: tagPrompt } = message.payload;
          const { configuration } = await storage.get('configuration');

          const updatedTags = configuration.trackedTags.map(t => {
            if (t.label.toLowerCase() === tagLabel.toLowerCase()) {
              return { ...t, prompt: tagPrompt };
            }
            return t;
          });

          await storage.set({
            configuration: { ...configuration, trackedTags: updatedTags }
          });

          await broadcastStateUpdate();
          triggerRefreshStackInference();
          sendResponse({ success: true });
          break;
        }

        // -----------------------------------------------------------------
        // GENERATE_TAG_EVAL_PROMPT — magic wand for a single tag
        // -----------------------------------------------------------------
        case 'GENERATE_TAG_EVAL_PROMPT': {
          const { tag: tagName, currentPrompt } = message.payload;
          // We will implement `autoSuggestTagPrompt` in inference-engine.js and call it here.
          // Need to dynamically import or just assume it is exported
          import('./lib/inference-engine.js').then(({ autoSuggestTagPrompt }) => {
            return autoSuggestTagPrompt(tagName, currentPrompt);
          }).then(suggestedPrompt => {
            sendResponse({ success: true, prompt: suggestedPrompt });
          }).catch(err => {
            console.error('Error generating tag eval prompt:', err);
            sendResponse({ success: false, error: err.message });
          });
          return true; // async
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
              return { 
                ...item, 
                assignedTag: newTag,
                matchInfo: {
                  engine: 'Manual Override',
                  manual: true
                }
              };
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
    const enabledCustom = getEnabledCustomTags(trackedTags);
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

/**
 * Migration helper to update existing stack items with canonicalAuthorName fields.
 */
function migrateCanonicalAuthors(stack) {
  let updated = false;
  const knownAuthors = [];

  for (let i = stack.length - 1; i >= 0; i--) {
    const item = stack[i];
    if (!item.authorName) {
      if (item.canonicalAuthorName !== '') {
        item.canonicalAuthorName = '';
        updated = true;
      }
      continue;
    }

    if (item.canonicalAuthorName) {
      const exists = knownAuthors.some(ka => ka.canonicalName === item.canonicalAuthorName);
      if (!exists) {
        knownAuthors.push({
          name: item.authorName,
          platform: item.sourcePlatform,
          url: item.authorUrl || '',
          canonicalName: item.canonicalAuthorName
        });
      }
      continue;
    }

    let foundMatch = null;
    for (const ka of knownAuthors) {
      const isSame = heuristicAuthorMatch(
        { name: item.authorName, platform: item.sourcePlatform, url: item.authorUrl || '' },
        { name: ka.name, platform: ka.platform, url: ka.url || '' }
      );
      if (isSame) {
        foundMatch = ka;
        break;
      }
    }

    if (foundMatch) {
      item.canonicalAuthorName = foundMatch.canonicalName;
      updated = true;
    } else {
      item.canonicalAuthorName = item.authorName;
      updated = true;
      knownAuthors.push({
        name: item.authorName,
        platform: item.sourcePlatform,
        url: item.authorUrl || '',
        canonicalName: item.canonicalAuthorName
      });
    }
  }

  return updated;
}

