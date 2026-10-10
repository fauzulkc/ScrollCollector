/* ==========================================================================
   ScrollCollector — Side Panel Controller (Virtualized & Curated)
   Ambient tabbed navigation, inline horizontal filters with drag-to-scroll,
   favorites (<3), popover overrides, master paused status banner,
   ignored keyword settings, keyboard hotkey HUD, and list virtualization.

   ES module. Feature modules live in ui/: intelligence settings, diagnostics,
   engine badge, toasts, exports and decision tooltips. Works in the side
   panel and when opened as a tab (chrome-extension://<id>/sidepanel.html).
   ========================================================================== */

import { MSG } from './lib/messages.js';
import { isExtensionPageSender } from './lib/bg/sender.js';
import { escapeHTML, safeHttpUrl, sendMessage, debounce, isTextEntry } from './ui/util.js';
import { createToaster } from './ui/toast.js';
import { badgeView, renderBadge, engineDisplayName, createEnginePoller } from './ui/engine-badge.js';
import { decisionTooltip } from './ui/decision-info.js';
import { toCsv, toJson, toHtmlExport, downloadText, exportFilename, EXPORT_MIME } from './ui/export.js';
import { mountIntelligence } from './ui/intelligence.js';
import { mountDiagnostics } from './ui/diagnostics.js';

// ---------- Constants & Assets ----------

const BADGE_COLORS = [
  '#6366f1', '#a855f7', '#06b6d4', '#10b981', '#f59e0b',
  '#f43f5e', '#0ea5e9', '#84cc16', '#f97316', '#ec4899'
];
const FALLBACK_COLOR = '#71717a';

const PLATFORM_ICONS = {
  'linkedin.com': `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z"/></svg>`,
  'twitter.com': `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`,
  'x.com': `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`,
  'youtube.com': `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M23.498 6.163a3.003 3.003 0 0 0-2.11-2.11C19.518 3.545 12 3.545 12 3.545s-7.518 0-9.388.507a3.003 3.003 0 0 0-2.11 2.11C0 8.033 0 12 0 12s0 3.967.502 5.837a3.003 3.003 0 0 0 2.11 2.11c1.87.507 9.388.507 9.388.507s7.518 0 9.388-.507a3.003 3.003 0 0 0 2.11-2.11C24 15.967 24 12 24 12s0-3.967-.502-5.837zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>`,
  'facebook.com': `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M22 12c0-5.52-4.48-10-10-10S2 6.48 2 12c0 4.84 3.44 8.87 8 9.8V15H8v-3h2V9.5C10 7.57 11.57 6 13.5 6H16v3h-2c-.55 0-1 .45-1 1v2h3v3h-3v6.95c4.56-.93 8-4.96 8-9.75z"/></svg>`,
  'instagram.com': `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>`,
  'medium.com': `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M13.54 12a6.8 6.8 0 0 1-6.77 6.82A6.8 6.8 0 0 1 0 12a6.8 6.8 0 0 1 6.77-6.82A6.8 6.8 0 0 1 13.54 12zm7.42 0c0 3.54-1.51 6.42-3.38 6.42s-3.38-2.88-3.38-6.42 1.51-6.42 3.38-6.42 3.38 2.88 3.38 6.42zm3.04 0c0 3.24-.43 5.86-.96 5.86s-.96-2.62-.96-5.86.43-5.86.96-5.86.96 2.62.96 5.86z"/></svg>`,
  'github.com': `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>`,
  'news.ycombinator.com': `<svg viewBox="4 4 188 188" width="14" height="14" fill="currentColor"><path d="m73.2521756 45.01 22.7478244 47.39130083 22.7478244-47.39130083h19.56569631l-34.32352071 64.48661468v41.49338532h-15.98v-41.49338532l-34.32352071-64.48661468z"/></svg>`,
  'fallback': `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`
};

// ---------- State ----------

let state = {
  configuration: { trackedTags: [], sites: [], ignoredKeywords: [], ignoredTags: [], ignoredLinks: [], ignoredDomains: [], isTrackingPaused: false, trackingPausedAt: null },
  metrics: { counts: {} },
  stack: [],
  telemetry: {
    totalProcessed: 0,
    classifiedCount: 0,
    unclassifiedCount: 0,
    sessionStart: 0,
    lastProcessed: null
  },
  // Unknown until the service worker answers: the badge starts grey ('checking'), never green.
  engineStatus: null
};

/** True for items hidden because they no longer match the prompt (never deleted). */
function isHiddenByPrompt(item) {
  return !!(item && item.hiddenByPrompt && !item.isFavorite && !(item.matchInfo && item.matchInfo.manual));
}

/** Items not filtered by the ignore lists (hidden-by-prompt items included). */
function getUnignoredStack() {
  const stack = state.stack || [];
  const ignoredTags = (state.configuration?.ignoredTags || []).map(t => String(t).toLowerCase());
  const ignoredLinks = state.configuration?.ignoredLinks || [];
  const ignoredDomains = (state.configuration?.ignoredDomains || []).map(d => String(d).toLowerCase());

  return stack.filter(i => {
    if (ignoredTags.includes((i.assignedTag || '').toLowerCase())) return false;
    if (i.sourceUrl && ignoredLinks.includes(i.sourceUrl)) return false;
    const rawPlatform = (i.sourcePlatform || '').toLowerCase();
    if (ignoredDomains.some(d => rawPlatform === d || rawPlatform.endsWith('.' + d))) return false;
    return true;
  });
}

/** Items shown in the feed: hidden-by-prompt items only while "Hidden by prompt" is toggled on. */
function getActiveStack() {
  const list = getUnignoredStack();
  return showHiddenByPrompt ? list : list.filter(i => !isHiddenByPrompt(i));
}

function countHiddenByPrompt() {
  return getUnignoredStack().filter(isHiddenByPrompt).length;
}

/** Ads: flagged by the content script (isAd) or tagged 'Ads' by an older version. */
function isAdItem(item) {
  return !!(item && (item.isAd || item.assignedTag === 'Ads'));
}

/** The key the author filter, its counts and the card's author pill all use. */
function authorKey(item) {
  return (item && (item.canonicalAuthorName || item.authorName)) || '';
}

let showHiddenByPrompt = false; // "Hidden by prompt (N)" pill state
let activeFilterTag = 'All'; // Horizontal category tag filter
let activeFilterSite = 'All'; // Horizontal website filter
let activeFilterAuthor = 'All'; // Global active author filter
let searchQuery = ''; // Global search query
let openDropdownItemId = null; // Track currently open override dropdown item ID
let expandedItemIds = new Set(); // Track expanded text snippet row IDs

// Keyboard Navigation State
let focusedItemIndex = -1; // Index in currently filtered stack
let filteredStack = []; // Cache of currently rendered filtered items

// Virtualizer Observer Instance
let virtualizerObserver = null;

// Settings › Tracked Categories: rows whose prompt editor is open, and a re-render that was
// skipped because the user was typing in that list.
const expandedTagPrompts = new Set();
let tagListDirty = false;

// Feature modules (mounted on DOMContentLoaded)
let toaster = null;
let intelligence = null;
let diagnostics = null;
let enginePoller = null;
let lastRedecide = null;

/** Shows a toast (falls back to the console before the toaster exists). */
function notify(level, text, key) {
  if (toaster) toaster.show({ level, text, key });
  else console.warn(`[sidepanel] ${text}`);
}

function send(type, payload) {
  return sendMessage(type, payload);
}

// ---------- DOM References ----------

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let dom = {};

// ---------- Initialization ----------

/** localStorage holds per-viewer conveniences only (theme, last tab); it may be unavailable. */
function readPref(key, fallback) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* not persisted */
  }
}

const TAB_NAMES = ['stream', 'export', 'settings'];

function initTheme() {
  const saved = readPref('scrollcollector-theme', 'dark');
  document.documentElement.setAttribute('data-theme', saved === 'light' ? 'light' : 'dark');
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  writePref('scrollcollector-theme', next);
}

function initTabs() {
  const savedTab = readPref('scrollcollector-active-tab', 'stream');
  switchTab(TAB_NAMES.includes(savedTab) ? savedTab : 'stream');

  $$('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      switchTab(tab);
    });
  });
}

function switchTab(tabName) {
  $$('.tab-btn').forEach(btn => {
    const active = btn.dataset.tab === tabName;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  $$('.tab-panel').forEach(panel => {
    const isTarget = panel.id === `panel-${tabName}`;
    panel.classList.toggle('active', isTarget);
  });

  // Card keyboard focus belongs to the Stream tab.
  if (tabName !== 'stream' && focusedItemIndex !== -1 && dom.streamList) clearCardFocus();

  writePref('scrollcollector-active-tab', tabName);
}

function isStreamTabActive() {
  const panel = document.getElementById('panel-stream');
  return !!(panel && panel.classList.contains('active'));
}

// ---------- Helpers ----------

function relativeTime(ts) {
  if (!ts) return '';
  const diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function getDaySeparatorLabel(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  const now = new Date();
  
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  
  const targetDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  
  if (targetDate.getTime() === today.getTime()) {
    return 'Today';
  } else if (targetDate.getTime() === yesterday.getTime()) {
    return 'Yesterday';
  } else {
    const options = { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' };
    return date.toLocaleDateString(undefined, options);
  }
}

function resetClearConfirmation() {
  if (dom.clearConfirmContainer) {
    dom.clearConfirmContainer.classList.add('hidden');
  }
  if (dom.clearStackBtn) {
    dom.clearStackBtn.classList.remove('hidden');
  }
}

function getTagColor(tag) {
  if (tag === 'All') return '#8b5cf6'; // Indigo/Purple
  if (tag === 'Favorites') return '#f43f5e'; // Rose Red
  if (tag === 'Ads') return '#ef4444'; // Red
  if (tag === 'Unclassified') return '#71717a'; // Zinc Gray
  
  const tags = state.configuration.trackedTags || [];
  const idx = tags.findIndex(t => (typeof t === 'string' ? t : t.label) === tag);
  if (idx === -1) return FALLBACK_COLOR;
  return BADGE_COLORS[idx % BADGE_COLORS.length];
}

function isTagDynamic(tag) {
  if (tag === 'All' || tag === 'Favorites' || tag === 'Ads' || tag === 'Unclassified') {
    return false;
  }
  const tagCfg = findTagConfig(tag);
  return tagCfg ? !!tagCfg.isDynamic : true;
}

/** Tracked-tag entry (object) for a label, case-insensitively; tolerates plain-string tags. */
function findTagConfig(tag) {
  const wanted = String(tag || '').toLowerCase();
  const trackedTags = state.configuration?.trackedTags || [];
  const found = trackedTags.find(t => String(typeof t === 'string' ? t : (t && t.label) || '').toLowerCase() === wanted);
  if (!found) return null;
  return typeof found === 'string' ? { label: found, isEnabled: true } : found;
}

function handleTagTrackToggle(tag) {
  if (tag === 'All' || tag === 'Favorites' || tag === 'Ads' || tag === 'Unclassified') {
    return;
  }
  const isDynamic = isTagDynamic(tag);
  if (isDynamic) {
    // Dynamic -> Tracked (Solid)
    send(MSG.TAG_PROMOTED, { tag });
  } else {
    // Tracked -> Untracked (Dynamic/Remove)
    showUntrackConfirmation(tag);
  }
}

function showUntrackConfirmation(tag) {
  // Create dialog overlay container
  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';
  
  overlay.innerHTML = `
    <div class="confirm-dialog">
      <div class="confirm-title">Stop tracking tag?</div>
      <div class="confirm-message">Are you sure you want to stop tracking tag <strong>#${escapeHTML(tag)}</strong>? It will revert to a dynamic tag.</div>
      <div class="confirm-actions">
        <button class="btn-confirm-cancel">Cancel</button>
        <button class="btn-confirm-ok">Stop tracking</button>
      </div>
    </div>
  `;
  
  const cancelBtn = overlay.querySelector('.btn-confirm-cancel');
  const okBtn = overlay.querySelector('.btn-confirm-ok');
  
  const closeDialog = () => {
    overlay.classList.add('fadeOut');
    overlay.addEventListener('animationend', () => {
      overlay.remove();
    });
  };
  
  cancelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeDialog();
  });
  
  okBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    send(MSG.TAG_REMOVED, { tag });
    closeDialog();
  });
  
  overlay.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.target === overlay) {
      closeDialog();
    }
  });
  
  document.body.appendChild(overlay);
}

function showIgnoreTagConfirmation(tag, onConfirm) {
  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';
  
  overlay.innerHTML = `
    <div class="confirm-dialog">
      <div class="confirm-title">Ignore tag?</div>
      <div class="confirm-message">Are you sure you want to ignore tag <strong>#${escapeHTML(tag)}</strong>? Existing and future posts with this tag will be hidden.</div>
      <div class="confirm-actions">
        <button class="btn-confirm-cancel">Cancel</button>
        <button class="btn-confirm-ok">Ignore Tag</button>
      </div>
    </div>
  `;
  
  const cancelBtn = overlay.querySelector('.btn-confirm-cancel');
  const okBtn = overlay.querySelector('.btn-confirm-ok');
  
  const closeDialog = () => {
    overlay.classList.add('fadeOut');
    overlay.addEventListener('animationend', () => {
      overlay.remove();
    });
  };
  
  cancelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeDialog();
  });
  
  okBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    onConfirm();
    closeDialog();
  });
  
  overlay.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.target === overlay) {
      closeDialog();
    }
  });
  
  document.body.appendChild(overlay);
}

function showIgnoreDomainConfirmation(domain, onConfirm) {
  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';
  
  overlay.innerHTML = `
    <div class="confirm-dialog">
      <div class="confirm-title">Ignore domain?</div>
      <div class="confirm-message">Are you sure you want to ignore all posts from <strong>${escapeHTML(domain)}</strong>? Existing and future posts from this domain will be hidden.</div>
      <div class="confirm-actions">
        <button class="btn-confirm-cancel">Cancel</button>
        <button class="btn-confirm-ok">Ignore Domain</button>
      </div>
    </div>
  `;
  
  const cancelBtn = overlay.querySelector('.btn-confirm-cancel');
  const okBtn = overlay.querySelector('.btn-confirm-ok');
  
  const closeDialog = () => {
    overlay.classList.add('fadeOut');
    overlay.addEventListener('animationend', () => {
      overlay.remove();
    });
  };
  
  cancelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeDialog();
  });
  
  okBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    onConfirm();
    closeDialog();
  });
  
  overlay.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.target === overlay) {
      closeDialog();
    }
  });
  
  document.body.appendChild(overlay);
}

function hexToRgb(hex) {
  const shorthandRegex = /^#?([a-f\d])([a-f\d])([a-f\d])$/i;
  const fullHex = hex.replace(shorthandRegex, (m, r, g, b) => r + r + g + g + b + b);
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(fullHex);
  return result ? `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}` : '113, 113, 122';
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return url;
  }
}

/** 
 * Local text parser:
 * Splits text into a bold title (first sentence) and body.
 */
function parseCardText(text) {
  if (!text) return { title: '', body: '' };
  
  const cleanText = text.replace(/\s+/g, ' ').trim();
  
  const boundaryMatch = cleanText.match(/^.*?[.!?](?:\s|$)/);
  if (boundaryMatch) {
    const title = boundaryMatch[0].trim();
    const body = cleanText.slice(title.length).trim();
    return { title, body };
  }
  
  if (cleanText.length > 70) {
    const title = cleanText.slice(0, 65) + '…';
    const body = cleanText;
    return { title, body };
  }
  
  return { title: cleanText, body: '' };
}

/**
 * Local entity extractor.
 */
function extractLocalEntities(text, assignedCategory) {
  if (!text) return [];
  const entities = new Set();

  if (assignedCategory && assignedCategory !== 'Unclassified' && assignedCategory !== 'Ads') {
    entities.add(assignedCategory);
  }

  const hashtags = text.match(/#\w+/g);
  if (hashtags) {
    hashtags.slice(0, 2).forEach(tag => entities.add(tag.replace('#', '')));
  }

  const words = text.replace(/[^\w\s]/g, '').split(/\s+/);
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (word.length >= 4 && /^[A-Z]/.test(word) && !/^[A-Z]+$/.test(word)) {
      const lower = word.toLowerCase();
      const ignoreList = ['with', 'this', 'that', 'from', 'they', 'your', 'about', 'their', 'there', 'when', 'more'];
      if (!ignoreList.includes(lower)) {
        entities.add(word);
        if (entities.size >= 3) break;
      }
    }
  }

  return Array.from(entities).slice(0, 3);
}

// ---------- Telemetry & Engine ----------

function renderTelemetry() {
  const tel = state.telemetry || {};
  const total = tel.totalProcessed || 0;
  const classified = tel.classifiedCount || 0;
  const rate = total > 0 ? Math.round((classified / total) * 100) : 0;

  dom.tabCountStream.textContent = getActiveStack().length;

  dom.telTotal.textContent = total;
  dom.telRate.textContent = rate + '%';
  dom.telEngine.textContent = engineDisplayName(state.engineStatus);
  dom.telEngine.title = dom.telEngine.textContent;
}

/** Header badge from the last EngineStatus (grey 'checking' until the service worker answers). */
function renderEngineStatus() {
  const view = badgeView(state.engineStatus);
  renderBadge({ root: dom.engineBadge, dot: dom.engineDot, label: dom.engineLabel }, view);
  if (enginePoller) enginePoller.sync(view);
}

/** Accepts an ENGINE_STATUS push or a GET_ENGINE_STATUS reply. */
function applyEngineStatus(status) {
  if (!status || typeof status !== 'object' || status.success === false) return;
  state.engineStatus = status;
  renderEngineStatus();
  renderTelemetry();
  renderPromptStatus();
  if (intelligence) intelligence.update({ engineStatus: status });
}

async function fetchEngineStatus() {
  const reply = await send(MSG.GET_ENGINE_STATUS);
  applyEngineStatus(reply);
}

let visualProcessingTimeout = null;
let lastProcessingTime = 0;

function renderProcessingStatus() {
  const count = state.inFlightCount || 0;
  
  if (count > 0) {
    dom.processingCount.textContent = count;
    dom.processingIndicator.classList.remove('hidden');
    lastProcessingTime = Date.now();
    if (visualProcessingTimeout) {
      clearTimeout(visualProcessingTimeout);
      visualProcessingTimeout = null;
    }
  } else {
    const elapsed = Date.now() - lastProcessingTime;
    const minDuration = 800; // minimum visible duration in ms
    
    if (elapsed < minDuration) {
      if (!visualProcessingTimeout) {
        visualProcessingTimeout = setTimeout(() => {
          dom.processingIndicator.classList.add('hidden');
          visualProcessingTimeout = null;
        }, minDuration - elapsed);
      }
    } else {
      dom.processingIndicator.classList.add('hidden');
      if (visualProcessingTimeout) {
        clearTimeout(visualProcessingTimeout);
        visualProcessingTimeout = null;
      }
    }
  }
}

/** configuration.trackingPausedAt as "14:03" (today) or "Oct 9, 14:03". */
function formatPausedAt(pausedAt) {
  const ts = Number(pausedAt);
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

function renderPauseStatus() {
  const config = state.configuration || {};
  const isPaused = !!config.isTrackingPaused;
  const pausedAt = config.trackingPausedAt;

  dom.pauseToggle.classList.toggle('paused', isPaused);
  
  if (isPaused) {
    dom.pauseIcon.classList.add('hidden');
    dom.playIcon.classList.remove('hidden');
    dom.pauseToggle.title = 'Resume tracking';
    
    dom.pauseBanner.classList.remove('hidden');
    dom.pauseTime.textContent = formatPausedAt(pausedAt);
  } else {
    dom.pauseIcon.classList.remove('hidden');
    dom.playIcon.classList.add('hidden');
    dom.pauseToggle.title = 'Pause tracking';
    
    dom.pauseBanner.classList.add('hidden');
  }
}

// ---------- Drag-to-Scroll pills containers ----------

function initDragToScroll() {
  [dom.filterPills, dom.filterSitePills, dom.filterAuthorPills].forEach(el => {
    if (!el) return;
    let isDragging = false;
    let startX;
    let scrollLeft;
    
    el.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.pageX - el.offsetLeft;
      scrollLeft = el.scrollLeft;
    });

    el.addEventListener('mouseleave', () => {
      isDragging = false;
    });

    el.addEventListener('mouseup', () => {
      isDragging = false;
    });

    el.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      e.preventDefault();
      const x = e.pageX - el.offsetLeft;
      const walk = (x - startX) * 1.5;
      el.scrollLeft = scrollLeft - walk;
    });
  });
}

function initFilterDropdowns() {
  const dropdownPairs = [
    { btn: dom.btnTagsDropdown, menu: dom.menuTagsDropdown },
    { btn: dom.btnSitesDropdown, menu: dom.menuSitesDropdown },
    { btn: dom.btnAuthorsDropdown, menu: dom.menuAuthorsDropdown }
  ];

  dropdownPairs.forEach(({ btn, menu }) => {
    if (!btn || !menu) return;

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const isShown = menu.classList.contains('show');

      // Close all first
      dropdownPairs.forEach(p => {
        if (p.menu) p.menu.classList.remove('show');
        if (p.btn) p.btn.classList.remove('active');
      });

      if (!isShown) {
        menu.classList.add('show');
        btn.classList.add('active');
      }
    });
  });

  // Global click event to close dropdowns when clicking outside
  document.addEventListener('click', () => {
    dropdownPairs.forEach(p => {
      if (p.menu) p.menu.classList.remove('show');
      if (p.btn) p.btn.classList.remove('active');
    });
  });
}

// ---------- Keyboard Curation HUD Engine ----------

/** The feed row of an item (ids come from storage: escape them for the selector). */
function rowForItem(id) {
  if (!dom.streamList || id === undefined || id === null) return null;
  return dom.streamList.querySelector(`.item-row[data-id="${CSS.escape(String(id))}"]`);
}

function clearCardFocus() {
  focusedItemIndex = -1;
  dom.streamList.querySelectorAll('.item-row.keyboard-focused').forEach(row => row.classList.remove('keyboard-focused'));
}

function focusCard(index) {
  if (filteredStack.length === 0) {
    focusedItemIndex = -1;
    return;
  }

  if (index < 0) index = 0;
  if (index >= filteredStack.length) index = filteredStack.length - 1;

  focusedItemIndex = index;
  const item = filteredStack[focusedItemIndex];

  dom.streamList.querySelectorAll('.item-row.keyboard-focused').forEach(row => {
    row.classList.remove('keyboard-focused');
  });

  const targetRow = rowForItem(item.id);
  if (targetRow) {
    targetRow.classList.add('keyboard-focused');
    targetRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    // Cards take focus (tabindex=-1) so the shortcuts keep working after a click elsewhere.
    if (document.activeElement !== targetRow) targetRow.focus({ preventScroll: true });
  }
}

/** Tags a card can be re-tagged to: tracked labels (not the Ads pseudo-tag) + Unclassified. */
function retagOptions() {
  const tags = state.configuration.trackedTags || [];
  const labels = tags
    .filter(t => typeof t === 'string' || (t && t.label && !t.isPseudo))
    .map(t => (typeof t === 'string' ? t : t.label))
    .filter(l => l && l !== 'Ads' && l !== 'Unclassified');
  return [...new Set(labels), 'Unclassified'];
}

/**
 * ←/→ on a focused card: moves its tag to the previous/next tag (a manual override).
 * @returns {boolean} false when no card is focused
 */
function rotateFocusedCardTag(direction) {
  if (focusedItemIndex === -1 || filteredStack.length === 0) return false;
  const item = filteredStack[focusedItemIndex];
  if (!item) return false;

  const tagLabels = retagOptions();
  const currentTag = item.assignedTag || 'Unclassified';
  let idx = tagLabels.indexOf(currentTag);
  if (idx === -1) idx = tagLabels.length - 1;
  idx = (idx + direction + tagLabels.length) % tagLabels.length;
  const newTag = tagLabels[idx];
  if (newTag === currentTag) return true;

  send(MSG.ITEM_RETAGGED, { itemId: item.id, newTag });
  item.assignedTag = newTag;
  item.matchInfo = { engine: 'Manual Override', manual: true };

  const previousIndex = focusedItemIndex;
  renderFilterPills();
  renderAuthorPills();
  renderFeed();
  // Stay on the same post; if the active filter dropped it, stay at the same position.
  const nextIndex = filteredStack.findIndex(i => i.id === item.id);
  if (filteredStack.length === 0) focusedItemIndex = -1;
  else focusCard(nextIndex !== -1 ? nextIndex : Math.min(previousIndex, filteredStack.length - 1));
  return true;
}

/** ←/→ with no focused card: previous/next category filter. */
function cycleFilterTag(direction) {
  const categories = getFilterCategories();
  let idx = categories.indexOf(activeFilterTag);
  if (idx === -1) idx = 0;
  activeFilterTag = categories[(idx + direction + categories.length) % categories.length];
  activeFilterAuthor = 'All';
  applyFilterChange();
  scrollActivePillIntoView();
}

/** A filter changed: the clear confirmation no longer applies, so it resets; everything re-renders. */
function applyFilterChange() {
  resetClearConfirmation();
  renderFilterPills();
  renderSiteFilterPills();
  renderAuthorPills();
  renderFeed();
}

function scrollActivePillIntoView() {
  const activePill = dom.filterPills.querySelector(`.filter-pill.active`);
  if (activePill) {
    activePill.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }
}

/** Elements that own their keys: typing, buttons, links, selects. Shortcuts never act there. */
const SHORTCUT_EXCLUDED_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A', 'SUMMARY', 'OPTION']);

/**
 * Whether a keydown may trigger a Stream shortcut: Stream tab active, no dialog open, focus not in
 * an input/textarea/select/button/link, no browser-shortcut modifiers. Tab is never handled.
 */
function shortcutsAllowed(e) {
  if (e.defaultPrevented || e.isComposing || e.altKey) return false;
  if (e.key === 'Tab') return false;
  if ((e.ctrlKey || e.metaKey) && e.key !== 'Enter') return false;
  if (!isStreamTabActive()) return false;
  if (document.querySelector('.confirm-overlay')) return false;
  const activeEl = document.activeElement;
  if (activeEl && (SHORTCUT_EXCLUDED_TAGS.has(activeEl.tagName) || isTextEntry(activeEl) || activeEl.isContentEditable)) return false;
  return true;
}

function initKeyboardNavigation() {
  document.addEventListener('keydown', (e) => {
    if (!shortcutsAllowed(e)) return;

    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowLeft': {
        e.preventDefault();
        const direction = e.key === 'ArrowRight' ? 1 : -1;
        // A focused card is re-tagged; otherwise the category filter moves.
        if (!rotateFocusedCardTag(direction)) cycleFilterTag(direction);
        break;
      }

      case 'Escape':
        if (focusedItemIndex !== -1) {
          e.preventDefault();
          clearCardFocus();
        }
        break;

      case 'ArrowDown':
        if (filteredStack.length === 0) return;
        e.preventDefault();
        focusCard(focusedItemIndex + 1);
        break;

      case 'ArrowUp':
        if (filteredStack.length === 0) return;
        e.preventDefault();
        focusCard(focusedItemIndex - 1);
        break;

      case ' ':
        if (filteredStack.length === 0) return;
        e.preventDefault();
        if (focusedItemIndex !== -1) {
          const item = filteredStack[focusedItemIndex];
          const isFavorite = !item.isFavorite;
          send(MSG.FAVORITE_TOGGLED, { itemId: item.id, isFavorite });
          item.isFavorite = isFavorite;

          const cardRow = rowForItem(item.id);
          if (cardRow) {
            updateFavoriteButtonUI(cardRow, isFavorite, true);
          }

          renderFilterPills();
          renderFeed();
          focusCard(focusedItemIndex);
        }
        break;

      case 'Enter':
        if (filteredStack.length === 0) return;
        if (focusedItemIndex !== -1) {
          const item = filteredStack[focusedItemIndex];

          if (e.shiftKey || e.ctrlKey || e.metaKey) {
            e.preventDefault();
            openExternal(item.sourceUrl);
          } else {
            e.preventDefault();
            const cardRow = rowForItem(item.id);
            if (cardRow) {
              const expandBtn = cardRow.querySelector('.btn-body-expand');
              if (expandBtn) expandBtn.click();
            }
          }
        }
        break;
    }
  });

  dom.streamList.addEventListener('click', (e) => {
    const cardEl = e.target.closest('.item-row');
    if (!cardEl) return;
    const itemId = cardEl.dataset.id;
    const idx = filteredStack.findIndex(i => i.id === itemId);
    if (idx !== -1) {
      focusedItemIndex = idx;
      dom.streamList.querySelectorAll('.item-row.keyboard-focused').forEach(row => {
        row.classList.remove('keyboard-focused');
      });
      cardEl.classList.add('keyboard-focused');
      // Clicking the card body (not one of its controls) gives the card keyboard focus.
      if (!e.target.closest('button, a, input, select, textarea')) cardEl.focus({ preventScroll: true });
    }
  });
}

/** Opens a collected link in a new tab (http/https only). */
function openExternal(url) {
  const safe = safeHttpUrl(url);
  if (safe) window.open(safe, '_blank', 'noopener');
}

// ---------- List Virtualization observer setup ----------

function initVirtualizer() {
  virtualizerObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const cardEl = entry.target;
      const itemId = cardEl.dataset.id;
      const item = state.stack.find(i => i.id === itemId);
      if (!item) return;

      if (entry.isIntersecting) {
        if (cardEl.classList.contains('is-virtualized')) {
          cardEl.classList.remove('is-virtualized');
          cardEl.style.minHeight = '';
          populateCardInner(cardEl, item);
        }
      } else {
        if (!cardEl.classList.contains('is-virtualized')) {
          const height = cardEl.offsetHeight;
          if (height > 0) {
            cardEl.style.minHeight = `${height}px`;
            cardEl.classList.add('is-virtualized');
            cardEl.innerHTML = `<div class="virtual-placeholder" style="height: ${height - 24}px;"></div>`;
          }
        }
      }
    });
  }, {
    root: dom.feedContainer,
    rootMargin: '300px 0px'
  });
}

function getSearchFilteredStack() {
  const stack = [...getActiveStack()];
  // Always search latest to oldest
  stack.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  if (!searchQuery) {
    return stack;
  }

  const q = searchQuery.toLowerCase().trim();
  return stack.filter(i => {
    const tagMatch = (i.assignedTag || '').toLowerCase().includes(q) ||
                     (i.tags || []).some(t => String((t && typeof t === 'object' ? t.name : t) || '').toLowerCase().includes(q));
    const postMatch = (i.textSnippet || '').toLowerCase().includes(q);
    const authorMatch = (i.authorName || '').toLowerCase().includes(q) || 
                        (i.canonicalAuthorName || '').toLowerCase().includes(q);
    const siteMatch = (i.sourcePlatform || '').toLowerCase().includes(q);
    return tagMatch || postMatch || authorMatch || siteMatch;
  });
}

// ---------- Rendering: Tag Filters ----------

function getFilterCategories() {
  const tags = state.configuration.trackedTags || [];
  const list = getSearchFilteredStack();
  const ignoredTags = (state.configuration?.ignoredTags || []).map(t => t.toLowerCase());

  const enabledTags = [];
  tags.forEach(t => {
    const label = typeof t === 'string' ? t : (t && t.label);
    if (!label) return;
    const enabled = typeof t === 'string' ? true : t.isEnabled !== false;
    if (enabled && label !== 'Ads' && label !== 'Unclassified' && !(t && t.isPseudo)
      && !ignoredTags.includes(label.toLowerCase()) && !enabledTags.includes(label)) {
      enabledTags.push(label);
    }
  });

  // Calculate the most recent item timestamp for each tag to sort by recency
  const latestTimestampMap = {};
  list.forEach(item => {
    const tag = item.assignedTag;
    if (tag && !latestTimestampMap[tag]) {
      latestTimestampMap[tag] = item.timestamp;
    }
  });

  enabledTags.sort((a, b) => {
    const timeA = latestTimestampMap[a] || 0;
    const timeB = latestTimestampMap[b] || 0;
    return timeB - timeA;
  });

  return ['All', 'Favorites', ...enabledTags, 'Ads', 'Unclassified'];
}

function renderFilterPills() {
  const categories = getFilterCategories();
  const list = getSearchFilteredStack();

  // 'Ads' counts (and filters) ad posts whatever their tag; a legacy 'Ads' tag is not counted twice.
  const counts = { All: list.length, Favorites: list.filter(i => i.isFavorite).length, Ads: 0 };
  list.forEach(item => {
    const tag = item.assignedTag || 'Unclassified';
    if (tag !== 'Ads') counts[tag] = (counts[tag] || 0) + 1;
    if (isAdItem(item)) counts.Ads += 1;
  });

  // Capture starting layout coordinates of existing category pills (First)
  const firstRects = {};
  Array.from(dom.filterPills.children).forEach(child => {
    const cat = child.dataset.category;
    if (cat) {
      firstRects[cat] = child.getBoundingClientRect();
    }
  });

  dom.filterPills.innerHTML = '';

  const displayCategories = categories.filter(cat => {
    if (cat === 'All' || cat === 'Favorites') return true;
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase().trim();
    if (cat.toLowerCase().includes(q)) return true;
    if (counts[cat] > 0) return true;
    return false;
  });

  displayCategories.forEach(cat => {
    const count = counts[cat] || 0;
    const pill = document.createElement('button');
    const isDyn = isTagDynamic(cat);
    pill.className = `filter-pill ${activeFilterTag === cat ? 'active' : ''} ${isDyn ? 'is-dynamic' : ''}`.trim();
    pill.dataset.category = cat;
    
    const color = getTagColor(cat);
    const rgb = hexToRgb(color);
    pill.style.setProperty('--pill-color', color);
    pill.style.setProperty('--pill-color-rgb', rgb);

    let labelText = cat;
    if (cat === 'Favorites') labelText = 'Favorites';

    pill.innerHTML = `
      <span class="pill-dot" style="background: ${color}"></span>
      <span class="pill-label">${escapeHTML(labelText)}</span>
      <span class="pill-count">${count}</span>
    `;

    pill.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      handleTagTrackToggle(cat);
    });
    
    pill.addEventListener('click', () => {
      activeFilterTag = cat;
      activeFilterAuthor = 'All'; // Reset author filter on category change
      applyFilterChange();
    });

    dom.filterPills.appendChild(pill);
  });

  // Apply FLIP (First, Last, Invert, Play) transition
  Array.from(dom.filterPills.children).forEach(pill => {
    const cat = pill.dataset.category;
    if (cat && firstRects[cat]) {
      const firstRect = firstRects[cat];
      const lastRect = pill.getBoundingClientRect();
      const deltaX = firstRect.left - lastRect.left;
      
      if (deltaX !== 0) {
        // Invert: shift instantly to the old layout position
        pill.style.transform = `translateX(${deltaX}px)`;
        pill.style.transition = 'none';
        
        // Force synchronous browser layout reflow
        void pill.offsetWidth;
        
        // Play: smoothly animate back to natural origin
        pill.style.transition = 'transform 0.45s cubic-bezier(0.16, 1, 0.3, 1)';
        pill.style.transform = '';
        
        // Cleanup transition property after animation completes
        pill.addEventListener('transitionend', function handler() {
          pill.style.transition = '';
          pill.removeEventListener('transitionend', handler);
        });
      }
    }
  });

  // Populate Tags Dropdown
  if (dom.menuTagsDropdown) {
    dom.menuTagsDropdown.innerHTML = '';
    displayCategories.forEach(cat => {
      const count = counts[cat] || 0;
      const color = getTagColor(cat);

      const btn = document.createElement('button');
      btn.className = `filter-dropdown-item ${activeFilterTag === cat ? 'active' : ''}`;
      btn.style.setProperty('--pill-color', color);
      btn.style.setProperty('--pill-color-rgb', hexToRgb(color));
      
      let labelText = cat;
      if (cat === 'Favorites') labelText = 'Favorites';
      else if (cat === 'All') labelText = 'All Categories';

      let dotHtml = `<span class="pill-dot" style="background: ${color}; margin-right: 6px; width: 6px; height: 6px; border-radius: 50%; display: inline-block; flex-shrink: 0;"></span>`;
      if (cat === 'Favorites') {
        dotHtml = `<span style="margin-right: 6px; font-size: 11px; flex-shrink: 0; line-height: 1;">❤️</span>`;
      } else if (cat === 'All') {
        dotHtml = `<span class="pill-dot" style="background: var(--text-muted); opacity: 0.3; margin-right: 6px; width: 6px; height: 6px; border-radius: 50%; display: inline-block; flex-shrink: 0;"></span>`;
      }

      btn.innerHTML = `
        <span style="display: flex; align-items: center; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">
          ${dotHtml}
          <span>${escapeHTML(labelText)}</span>
        </span>
        <span class="filter-dropdown-item-count">${count}</span>
      `;

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        activeFilterTag = cat;
        activeFilterAuthor = 'All'; // Reset author filter on category change
        dom.menuTagsDropdown.classList.remove('show');
        dom.btnTagsDropdown.classList.remove('active');
        applyFilterChange();
      });
      dom.menuTagsDropdown.appendChild(btn);
    });
  }
}

// ---------- Rendering: Site Filters ----------

function setFilterSite(site) {
  if (activeFilterSite === site) return;
  activeFilterSite = site;
  activeFilterAuthor = 'All'; // Reset author filter on site change

  // If the active tag filter is not 'All' or 'Favorites', check if any items match the activeTag + new site
  if (activeFilterTag !== 'All' && activeFilterTag !== 'Favorites' && activeFilterTag !== 'Ads') {
    const hasItemsForTagOnSite = getSearchFilteredStack().some(item => {
      const tagMatch = item.assignedTag === activeFilterTag;
      if (!tagMatch) return false;
      
      if (activeFilterSite === 'All') return true;
      const rawPlatform = (item.sourcePlatform || '').toLowerCase();
      if (activeFilterSite === 'Other') {
        const defaultSites = ['linkedin.com', 'x.com', 'youtube.com', 'facebook.com', 'instagram.com', 'medium.com', 'github.com', 'news.ycombinator.com'];
        const customSites = (state.configuration.sites || []).filter(s => s.isCustom).map(s => s.domain);
        const configuredSites = state.configuration.sites || [];
        const enabledDomains = [...defaultSites, ...customSites].filter(d => {
          const cfg = configuredSites.find(s => s.domain.toLowerCase() === d.toLowerCase());
          return !cfg || cfg.isEnabled !== false;
        });
        return !enabledDomains.some(domain => rawPlatform === domain || rawPlatform.endsWith('.' + domain));
      }
      return rawPlatform === activeFilterSite || rawPlatform.endsWith('.' + activeFilterSite);
    });
    
    if (!hasItemsForTagOnSite) {
      activeFilterTag = 'All';
    }
  } else if (activeFilterTag === 'Ads') {
    const hasAdsOnSite = getSearchFilteredStack().some(item => {
      if (!isAdItem(item)) return false;
      if (activeFilterSite === 'All') return true;
      const rawPlatform = (item.sourcePlatform || '').toLowerCase();
      if (activeFilterSite === 'Other') {
        const defaultSites = ['linkedin.com', 'x.com', 'youtube.com', 'facebook.com', 'instagram.com', 'medium.com', 'github.com', 'news.ycombinator.com'];
        return !defaultSites.some(d => rawPlatform === d || rawPlatform.endsWith('.' + d));
      }
      return rawPlatform === activeFilterSite || rawPlatform.endsWith('.' + activeFilterSite);
    });
    if (!hasAdsOnSite) {
      activeFilterTag = 'All';
    }
  }

  applyFilterChange();
}

function renderSiteFilterPills() {
  const defaultSites = ['linkedin.com', 'x.com', 'youtube.com', 'facebook.com', 'instagram.com', 'medium.com', 'github.com', 'news.ycombinator.com'];
  const customSites = (state.configuration.sites || []).filter(s => s.isCustom).map(s => s.domain);
  const configuredSites = state.configuration.sites || [];
  
  // 1. Gather all active configured sites (excluding All and Other)
  const candidateSites = [];
  defaultSites.forEach(d => {
    const cfg = configuredSites.find(s => s.domain.toLowerCase() === d.toLowerCase());
    if (!cfg || cfg.isEnabled !== false) {
      if (!candidateSites.includes(d)) candidateSites.push(d);
    }
  });

  customSites.forEach(d => {
    const cfg = configuredSites.find(s => s.domain.toLowerCase() === d.toLowerCase());
    if (cfg && cfg.isEnabled !== false) {
      if (!candidateSites.includes(d)) candidateSites.push(d);
    }
  });

  // 2. Compute counts dynamically
  const searchList = getSearchFilteredStack();
  const counts = { All: searchList.length };
  let otherCount = 0;

  searchList.forEach(item => {
    const rawPlatform = (item.sourcePlatform || '').toLowerCase();
    
    // Find matching site candidate
    let matchedCandidate = null;
    for (const site of candidateSites) {
      if (rawPlatform === site || rawPlatform.endsWith('.' + site)) {
        matchedCandidate = site;
        break;
      }
    }
    
    if (matchedCandidate) {
      counts[matchedCandidate] = (counts[matchedCandidate] || 0) + 1;
    } else {
      otherCount++;
    }
  });
  counts.Other = otherCount;

  // 3. Sort candidate sites by recency (last item added timestamp)
  const siteTimestamps = {};
  searchList.forEach(item => {
    const rawPlatform = (item.sourcePlatform || '').toLowerCase();
    let matchedCandidate = null;
    for (const site of candidateSites) {
      if (rawPlatform === site || rawPlatform.endsWith('.' + site)) {
        matchedCandidate = site;
        break;
      }
    }
    if (matchedCandidate && !siteTimestamps[matchedCandidate]) {
      siteTimestamps[matchedCandidate] = item.timestamp;
    }
  });

  candidateSites.sort((a, b) => {
    const tA = siteTimestamps[a] || 0;
    const tB = siteTimestamps[b] || 0;
    return tB - tA;
  });

  // 4. Final ordered list of site pills
  const orderedSites = ['All', ...candidateSites];
  if (otherCount > 0) {
    orderedSites.push('Other');
  }

  // Preserve positions for FLIP animation
  const oldRects = new Map();
  Array.from(dom.filterSitePills.children).forEach(pill => {
    const site = pill.dataset.site;
    if (site) {
      oldRects.set(site, pill.getBoundingClientRect());
    }
  });

  dom.filterSitePills.innerHTML = '';

  let displaySites = orderedSites;
  if (searchQuery) {
    const q = searchQuery.toLowerCase().trim();
    displaySites = orderedSites.filter(site => {
      if (site === 'All' || site === 'Other') return true;
      if (site.toLowerCase().includes(q)) return true;
      if (counts[site] > 0) return true;
      return false;
    });
  }

  displaySites.forEach(site => {
    const count = counts[site] || 0;
    const pill = document.createElement('div');
    pill.dataset.site = site;
    pill.className = `filter-pill ${activeFilterSite === site ? 'active' : ''}`;
    
    let labelText = site;
    if (site === 'All') labelText = 'All Sites';
    
    // Add custom icon if available
    const iconHtml = PLATFORM_ICONS[site] || PLATFORM_ICONS['fallback'];
    
    pill.innerHTML = `
      <span class="pill-icon">${iconHtml}</span>
      <span>${escapeHTML(labelText)}</span>
      <span style="opacity: 0.6; font-size: 9px; margin-left: 2px;">${count}</span>
    `;
    
    pill.addEventListener('click', () => {
      setFilterSite(site);
    });

    dom.filterSitePills.appendChild(pill);
  });

  // Apply FLIP (First, Last, Invert, Play) transition
  Array.from(dom.filterSitePills.children).forEach(pill => {
    const site = pill.dataset.site;
    const oldRect = oldRects.get(site);
    if (site && oldRect) {
      const lastRect = pill.getBoundingClientRect();
      const deltaX = oldRect.left - lastRect.left;
      
      if (deltaX !== 0) {
        // Invert: shift instantly to the old layout position
        pill.style.transform = `translateX(${deltaX}px)`;
        pill.style.transition = 'none';
        
        // Force synchronous browser layout reflow
        void pill.offsetWidth;
        
        // Play: smoothly animate back to natural origin
        pill.style.transition = 'transform 0.45s cubic-bezier(0.16, 1, 0.3, 1)';
        pill.style.transform = '';
        
        // Cleanup transition property after animation completes
        pill.addEventListener('transitionend', function handler() {
          pill.style.transition = '';
          pill.removeEventListener('transitionend', handler);
        });
      }
    }
  });

  // Populate Sites Dropdown
  if (dom.menuSitesDropdown) {
    dom.menuSitesDropdown.innerHTML = '';
    displaySites.forEach(site => {
      const count = counts[site] || 0;
      const btn = document.createElement('button');
      btn.className = `filter-dropdown-item ${activeFilterSite === site ? 'active' : ''}`;
      
      let labelText = site;
      if (site === 'All') labelText = 'All Sites';

      const iconHtml = PLATFORM_ICONS[site] || PLATFORM_ICONS['fallback'];

      btn.innerHTML = `
        <span style="display: flex; align-items: center; gap: 6px; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">
          <span class="pill-icon" style="display: inline-flex; align-items: center; width: 12px; height: 12px; flex-shrink: 0;">${iconHtml}</span>
          <span>${escapeHTML(labelText)}</span>
        </span>
        <span class="filter-dropdown-item-count">${count}</span>
      `;

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        dom.menuSitesDropdown.classList.remove('show');
        dom.btnSitesDropdown.classList.remove('active');
        setFilterSite(site);
      });
      dom.menuSitesDropdown.appendChild(btn);
    });
  }
}

// ---------- Rendering: Author Filters ----------

function getFilterAuthors() {
  const list = getSearchFilteredStack();
  const counts = { All: 0 };
  
  // Count authors that match the activeTag and activeSite filters!
  list.forEach(item => {
    // Check if item matches current activeTag filter
    let tagMatch = true;
    if (activeFilterTag === 'Favorites') {
      tagMatch = item.isFavorite;
    } else if (activeFilterTag === 'Ads') {
      tagMatch = isAdItem(item);
    } else if (activeFilterTag !== 'All') {
      tagMatch = item.assignedTag === activeFilterTag;
    }
    
    // Check if item matches current activeSite filter
    let siteMatch = true;
    if (activeFilterSite !== 'All') {
      const rawPlatform = (item.sourcePlatform || '').toLowerCase();
      if (activeFilterSite === 'Other') {
        const defaultSites = ['linkedin.com', 'x.com', 'youtube.com', 'facebook.com', 'instagram.com', 'medium.com', 'github.com', 'news.ycombinator.com'];
        const customSites = (state.configuration.sites || []).filter(s => s.isCustom).map(s => s.domain);
        const configuredSites = state.configuration.sites || [];
        const enabledDomains = [...defaultSites, ...customSites].filter(d => {
          const cfg = configuredSites.find(s => s.domain.toLowerCase() === d.toLowerCase());
          return !cfg || cfg.isEnabled !== false;
        });
        siteMatch = !enabledDomains.some(domain => rawPlatform === domain || rawPlatform.endsWith('.' + domain));
      } else {
        siteMatch = rawPlatform === activeFilterSite || rawPlatform.endsWith('.' + activeFilterSite);
      }
    }
    
    if (tagMatch && siteMatch) {
      counts.All++;
      const auth = authorKey(item);
      if (auth) {
        counts[auth] = (counts[auth] || 0) + 1;
      }
    }
  });

  // Extract author names (excluding empty and 'All')
  const authorNames = Object.keys(counts).filter(k => k !== 'All' && k !== '');
  
  // Sort authors by post count descending
  authorNames.sort((a, b) => counts[b] - counts[a]);

  // Keep top 10 authors, but if the activeFilterAuthor is set and not in the top 10, include it.
  let displayAuthors = authorNames.slice(0, 10);
  if (activeFilterAuthor !== 'All' && !displayAuthors.includes(activeFilterAuthor)) {
    displayAuthors.push(activeFilterAuthor);
  }

  // Filter displayAuthors by search query if present
  if (searchQuery) {
    const q = searchQuery.toLowerCase().trim();
    displayAuthors = displayAuthors.filter(auth => {
      if (auth.toLowerCase().includes(q)) return true;
      if (counts[auth] > 0) return true;
      return false;
    });
  }

  return {
    authors: ['All', ...displayAuthors],
    counts
  };
}

function renderAuthorPills() {
  const { authors, counts } = getFilterAuthors();
  
  dom.filterAuthorPills.innerHTML = '';
  
  // If there are no authors or only 'All' with 0 posts, we can hide the wrapper or just show 'All'
  if (authors.length <= 1) {
    dom.filterAuthorPills.parentElement.classList.add('hidden');
    return;
  }
  dom.filterAuthorPills.parentElement.classList.remove('hidden');

  authors.forEach(auth => {
    const count = counts[auth] || 0;
    if (auth !== 'All' && count === 0) return; // Skip if no posts for this author in current filters

    const pill = document.createElement('button');
    pill.className = `filter-pill ${activeFilterAuthor === auth ? 'active' : ''}`;
    pill.dataset.author = auth;
    
    const color = '#8b5cf6'; // Violet for authors
    pill.style.setProperty('--pill-color', color);
    const rgb = hexToRgb(color);
    pill.style.setProperty('--pill-color-rgb', rgb);

    let labelText = auth === 'All' ? 'All Authors' : auth;

    pill.innerHTML = `
      <span class="pill-dot" style="background: ${color}"></span>
      <span class="pill-label">${escapeHTML(labelText)}</span>
      <span class="pill-count">${count}</span>
    `;

    pill.addEventListener('click', () => {
      activeFilterAuthor = auth;
      applyFilterChange();
    });

    dom.filterAuthorPills.appendChild(pill);
  });

  // Populate Authors Dropdown
  if (dom.menuAuthorsDropdown) {
    dom.menuAuthorsDropdown.innerHTML = '';
    
    // Hide dropdown trigger if there are no authors or only 'All' with 0 posts
    if (authors.length <= 1) {
      dom.btnAuthorsDropdown.parentElement.classList.add('hidden');
    } else {
      dom.btnAuthorsDropdown.parentElement.classList.remove('hidden');
    }

    authors.forEach(auth => {
      const count = counts[auth] || 0;
      if (auth !== 'All' && count === 0) return;

      const btn = document.createElement('button');
      btn.className = `filter-dropdown-item ${activeFilterAuthor === auth ? 'active' : ''}`;
      
      let labelText = auth === 'All' ? 'All Authors' : auth;

      const color = '#8b5cf6'; // Violet for authors
      let dotHtml = `<span class="pill-dot" style="background: ${color}; margin-right: 6px; width: 6px; height: 6px; border-radius: 50%; display: inline-block; flex-shrink: 0;"></span>`;
      if (auth === 'All') {
        dotHtml = `<span class="pill-dot" style="background: var(--text-muted); opacity: 0.3; margin-right: 6px; width: 6px; height: 6px; border-radius: 50%; display: inline-block; flex-shrink: 0;"></span>`;
      }

      btn.innerHTML = `
        <span style="display: flex; align-items: center; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">
          ${dotHtml}
          <span>${escapeHTML(labelText)}</span>
        </span>
        <span class="filter-dropdown-item-count">${count}</span>
      `;

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        activeFilterAuthor = auth;
        dom.menuAuthorsDropdown.classList.remove('show');
        dom.btnAuthorsDropdown.classList.remove('active');
        applyFilterChange();
      });
      dom.menuAuthorsDropdown.appendChild(btn);
    });
  }
}

// ---------- Rendering: Feed Cards ----------

function renderFeed() {
  const searchResults = getSearchFilteredStack();
  const list = dom.streamList;
  
  if (virtualizerObserver) {
    virtualizerObserver.disconnect();
  }

  // Not resetClearConfirmation(): broadcasts re-render the feed constantly while scrolling, and
  // only a filter change (applyFilterChange) makes a pending "Clear …?" confirmation stale.

  const oldFilteredStack = [...filteredStack];
  const focusedId = focusedItemIndex !== -1 && filteredStack[focusedItemIndex] ? filteredStack[focusedItemIndex].id : null;

  filteredStack = searchResults;

  // Filter 1: Tag
  if (activeFilterTag === 'Favorites') {
    filteredStack = searchResults.filter(i => i.isFavorite);
  } else if (activeFilterTag === 'Ads') {
    filteredStack = searchResults.filter(isAdItem);
  } else if (activeFilterTag !== 'All') {
    filteredStack = searchResults.filter(i => i.assignedTag === activeFilterTag);
  }

  // Filter 2: Website
  if (activeFilterSite !== 'All') {
    filteredStack = filteredStack.filter(i => {
      const rawPlatform = (i.sourcePlatform || '').toLowerCase();
      if (activeFilterSite === 'Other') {
        const defaultSites = ['linkedin.com', 'x.com', 'youtube.com', 'facebook.com', 'instagram.com', 'medium.com', 'github.com', 'news.ycombinator.com'];
        const customSites = (state.configuration.sites || []).filter(s => s.isCustom).map(s => s.domain);
        const configuredSites = state.configuration.sites || [];
        const enabledDomains = [...defaultSites, ...customSites].filter(d => {
          const cfg = configuredSites.find(s => s.domain.toLowerCase() === d.toLowerCase());
          return !cfg || cfg.isEnabled !== false;
        });
        return !enabledDomains.some(domain => rawPlatform === domain || rawPlatform.endsWith('.' + domain));
      }
      return rawPlatform === activeFilterSite || rawPlatform.endsWith('.' + activeFilterSite);
    });
  }

  // Filter 3: Author (same key as the author pills and their counts)
  if (activeFilterAuthor !== 'All') {
    filteredStack = filteredStack.filter(i => authorKey(i) === activeFilterAuthor);
  }

  // Keep keyboard focus on the same post when items arrive above it.
  if (focusedId !== null) {
    const idx = filteredStack.findIndex(i => i.id === focusedId);
    focusedItemIndex = idx;
  }

  if (filteredStack.length === 0) {
    list.innerHTML = '';
    dom.streamEmpty.textContent = emptyFeedMessage();
    dom.streamEmpty.classList.remove('hidden');
    list.classList.add('hidden');
    focusedItemIndex = -1;
    return;
  }

  dom.streamEmpty.classList.add('hidden');
  list.classList.remove('hidden');

  // Construct renderable items: blending separators and cards
  const renderableItems = [];
  let lastDayLabel = '';
  filteredStack.forEach((item, idx) => {
    const dayLabel = getDaySeparatorLabel(item.timestamp);
    if (dayLabel !== lastDayLabel) {
      renderableItems.push({
        type: 'separator',
        id: `day_${dayLabel.replace(/[\s,]+/g, '_')}`,
        label: dayLabel
      });
      lastDayLabel = dayLabel;
    }
    renderableItems.push({
      type: 'item',
      id: item.id,
      item: item,
      index: idx
    });
  });

  // Perform smart DOM reconciliation to allow slide-down animation for new items
  const currentCards = Array.from(list.children);
  const currentCardMap = new Map();
  currentCards.forEach(card => {
    if (card.dataset && card.dataset.id) {
      currentCardMap.set(card.dataset.id, card);
    }
  });

  const newIds = new Set(renderableItems.map(i => i.id));
  const oldIds = new Set(oldFilteredStack.map(i => i.id));

  // Remove elements that are no longer present
  currentCardMap.forEach((element, id) => {
    if (!newIds.has(id)) {
      element.remove();
    }
  });

  // Render and position items/separators
  renderableItems.forEach((entry, index) => {
    let element = currentCardMap.get(entry.id);

    if (!element) {
      if (entry.type === 'separator') {
        element = createDaySeparator(entry.label, entry.id);
      } else {
        const isNew = oldIds.size > 0 && !oldIds.has(entry.item.id);
        element = createItemCardShell(entry.item, entry.index);
        if (isNew) {
          element.classList.add('slide-down-new');
          setTimeout(() => {
            element.classList.remove('slide-down-new');
          }, 500);
        }
      }
      currentCardMap.set(entry.id, element);
    } else {
      if (entry.type === 'item') {
        element.dataset.index = entry.index;
        if (entry.index === focusedItemIndex) {
          element.classList.add('keyboard-focused');
        } else {
          element.classList.remove('keyboard-focused');
        }

        // Update card contents if favorite status, tag, decision or visibility changed
        if (!element.classList.contains('is-virtualized') && element.dataset.sig !== cardSignature(entry.item)) {
          populateCardInner(element, entry.item);
        }
      }
    }

    // Insert element at correct position relative to live children
    const expectedNextSibling = list.children[index];
    if (expectedNextSibling !== element) {
      list.insertBefore(element, expectedNextSibling || null);
    }

    if (entry.type === 'item' && virtualizerObserver) {
      virtualizerObserver.observe(element);
    }
  });
}

function emptyFeedMessage() {
  if ((state.stack || []).length === 0) return 'No items collected yet. Start scrolling feeds!';
  const hidden = countHiddenByPrompt();
  if (!showHiddenByPrompt && hidden > 0 && getActiveStack().length === 0) {
    return `All ${hidden} collected post${hidden === 1 ? ' is' : 's are'} hidden by your prompt. Use “Hidden by prompt” above to see them.`;
  }
  return 'No posts match these filters.';
}

/** What a rendered card depends on; a change re-renders the card. */
function cardSignature(item) {
  const d = item.decision || {};
  return [
    item.isFavorite ? 1 : 0,
    item.assignedTag || 'Unclassified',
    isHiddenByPrompt(item) ? 1 : 0,
    d.at || 0,
    d.provider || '',
    item.matchInfo && item.matchInfo.manual ? 1 : 0,
    (item.textSnippet || '').length
  ].join('|');
}

function createItemCardShell(item, index) {
  const card = document.createElement('div');
  card.className = 'item-row is-virtualized';
  card.dataset.id = item.id;
  card.tabIndex = -1;
  card.style.minHeight = '90px';
  card.innerHTML = `<div class="virtual-placeholder" style="height: 66px;"></div>`;

  if (index === focusedItemIndex) {
    card.classList.add('keyboard-focused');
  }

  return card;
}

function createDaySeparator(label, id) {
  const div = document.createElement('div');
  div.className = 'day-separator';
  div.dataset.id = id;
  div.textContent = label;
  return div;
}

function updateFavoriteButtonUI(card, isFavorite, shouldAnimate = false) {
  const favBtn = card.querySelector('.btn-favorite');
  if (!favBtn) return;

  card.dataset.favorite = isFavorite ? 'true' : 'false';

  if (isFavorite) {
    favBtn.classList.add('favorited');
    favBtn.title = 'Remove from favorites';
    favBtn.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`;
    if (shouldAnimate) {
      favBtn.classList.remove('animate-unpop');
      favBtn.classList.add('animate-pop');
      const onAnimEnd = () => {
        favBtn.classList.remove('animate-pop');
        favBtn.removeEventListener('animationend', onAnimEnd);
      };
      favBtn.addEventListener('animationend', onAnimEnd);
    }
  } else {
    favBtn.classList.remove('favorited');
    favBtn.title = 'Add to favorites';
    favBtn.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
    if (shouldAnimate) {
      favBtn.classList.remove('animate-pop');
      favBtn.classList.add('animate-unpop');
      const onAnimEnd = () => {
        favBtn.classList.remove('animate-unpop');
        favBtn.removeEventListener('animationend', onAnimEnd);
      };
      favBtn.addEventListener('animationend', onAnimEnd);
    }
  }
}

function populateCardInner(card, item) {
  card.dataset.favorite = item.isFavorite ? 'true' : 'false';
  card.dataset.tag = item.assignedTag || 'Unclassified';
  card.dataset.sig = cardSignature(item);
  const hiddenByPrompt = isHiddenByPrompt(item);
  card.classList.toggle('is-hidden-by-prompt', hiddenByPrompt);

  const platform = item.sourcePlatform || 'unknown';
  const timeStr = relativeTime(item.timestamp);
  const tag = item.assignedTag || 'Unclassified';
  const tagColor = getTagColor(tag);
  card.style.setProperty('--card-accent', tagColor);

  const tagCfg = findTagConfig(tag);
  const isTrackedCategory = tagCfg ? !tagCfg.isDynamic : false;

  if (tag !== 'Unclassified' && isTrackedCategory) {
    card.classList.add('news-glow');
  } else {
    card.classList.remove('news-glow');
  }

  const { title, body } = parseCardText(item.textSnippet);
  const entities = extractLocalEntities(item.textSnippet, tag);
  const isCollapsed = !expandedItemIds.has(item.id);

  // Native Favicon integration (the error handler is attached below: CSP blocks inline handlers)
  const faviconUrl = `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(safeHttpUrl(item.sourceUrl) || 'https://' + platform)}&size=32`;
  const faviconHtml = `<img src="${escapeHTML(faviconUrl)}" class="card-favicon" alt="" />`;

  let linkHtml = '';
  if (item.sourceUrl) {
    const domain = escapeHTML(extractDomain(item.sourceUrl));
    linkHtml = `
      <span class="card-site-link-wrapper">
        <a href="#" class="card-site-link" data-url="${escapeHTML(item.sourceUrl)}" title="${escapeHTML(item.sourceUrl)}">${domain} ↗</a>
        <button class="btn-flag btn-ignore-link" title="Ignore link" data-url="${escapeHTML(item.sourceUrl)}">
          <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path><line x1="4" y1="22" x2="4" y2="15"></line></svg>
        </button>
      </span>
    `;
  }

  let authorHtml = '';
  if (item.authorName) {
    let authorNameSafe = escapeHTML(item.authorName);
    let canonicalAuthorNameSafe = escapeHTML(item.canonicalAuthorName || item.authorName);
    if (item.authorUrl) {
      authorHtml = `
        <span class="card-author-pill-wrapper">
          <span class="card-author-pill card-author-filter-btn" data-author="${canonicalAuthorNameSafe}" title="Filter by ${canonicalAuthorNameSafe}">@${authorNameSafe}</span>
          <a href="#" class="card-author-profile-link" data-url="${escapeHTML(item.authorUrl)}" title="Visit ${authorNameSafe}'s profile">↗</a>
        </span>
      `;
    } else {
      authorHtml = `<span class="card-author-pill card-author-filter-btn" data-author="${canonicalAuthorNameSafe}" title="Filter by ${canonicalAuthorNameSafe}">@${authorNameSafe}</span>`;
    }
  }


  const favClass = item.isFavorite ? 'favorited' : '';
  const favIcon = item.isFavorite
    ? `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`
    : `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;

  const adBadge = (isAdItem(item) ? `<span class="ad-badge">Ad</span>` : '')
    + (hiddenByPrompt ? `<span class="hidden-badge" title="No longer matches your prompt. Hidden, not deleted.">Hidden</span>` : '');

  let bodyHtml = '';
  if (body) {
    bodyHtml = `
      <div class="card-body ${isCollapsed ? 'collapsed' : ''}">${escapeHTML(body)}</div>
      <button class="btn-body-expand">${isCollapsed ? 'Show more' : 'Show less'}</button>
    `;
  }

  let entityChips = '';
  if (entities.length > 0) {
    entityChips = `<div class="card-entities">` + 
      entities.map(e => `<span class="entity-chip">#${escapeHTML(e)}</span>`).join('') + 
      `</div>`;
  }

  const tagsList = state.configuration.trackedTags || [];
  const tagOptions = tagsList
    .map(t => typeof t === 'string' ? t : t.label)
    .filter(label => label !== 'Ads')
    .concat(['Unclassified'])
    .map(label => `
      <div class="override-popover-item ${label === tag ? 'selected' : ''}" data-tag="${escapeHTML(label)}">
        <span>${escapeHTML(label)}</span>
        ${label === tag ? '✓' : ''}
      </div>
    `).join('');

  let secondaryTagsHtml = '';
  if (item.tags && item.tags.length > 1) {
    const secondaryTags = item.tags
      .map(t => (typeof t === 'string' ? { name: t } : t))
      .filter(t => t && typeof t.name === 'string' && t.name && t.name !== tag)
      .slice(0, 2); // Up to 2 secondary tags
    secondaryTagsHtml = secondaryTags.map(t => {
      const sTag = t.name;
      const sTagColor = getTagColor(sTag);
      const scoreTitle = Number.isFinite(t.score) ? `Confidence: ${Math.round(t.score * 100)}%` : sTag;
      return `
        <span class="card-category-label secondary ${isTagDynamic(sTag) ? 'is-dynamic' : ''}" style="--tag-color: ${sTagColor}" title="${escapeHTML(scoreTitle)}" data-filter-tag="${escapeHTML(sTag)}">
          <span>${escapeHTML(sTag)}</span>
          <button class="btn-flag btn-ignore-tag" title="Ignore tag ${escapeHTML(sTag)}" data-tag="${escapeHTML(sTag)}">
            <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path><line x1="4" y1="22" x2="4" y2="15"></line></svg>
          </button>
        </span>
      `;
    }).join('');
  }

  // Decision details (path, provider, p(match), confidences, latency, reason, escalation); items
  // collected before the decision cascade fall back to their legacy matchInfo.
  let infoTooltipHtml = '';
  const tooltipText = decisionTooltip(item);
  if (tooltipText) {
    const escalated = !!(item.decision && item.decision.escalated);
    infoTooltipHtml = `
      <span class="info-tooltip-wrapper ${escalated ? 'is-escalated' : ''}" title="${escapeHTML(tooltipText)}" aria-label="${escapeHTML(tooltipText)}" role="img">
        <svg class="info-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="16" x2="12" y2="12"></line>
          <line x1="12" y1="8" x2="12.01" y2="8"></line>
        </svg>
      </span>
    `;
  }

  // Rebuild inside Shell
  card.innerHTML = `
    <div class="card-header">
      <span class="platform-logo">${faviconHtml}</span>
      <span class="platform-name-wrapper">
        <span class="platform-name">${escapeHTML(platform)}</span>
        <button class="btn-flag btn-ignore-domain" title="Ignore domain ${escapeHTML(platform)}" data-domain="${escapeHTML(platform)}">
          <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path><line x1="4" y1="22" x2="4" y2="15"></line></svg>
        </button>
      </span>
      ${linkHtml}
      <span class="card-time">${timeStr}</span>
      ${adBadge}
      <div class="card-header-actions">
        <button class="btn-card-action btn-favorite ${favClass}" title="${item.isFavorite ? 'Remove from favorites' : 'Add to favorites'}">
          ${favIcon}
        </button>
        <button class="btn-card-action btn-card-delete" title="Remove from list">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
    </div>
    
    <div class="card-summary">
      ${item.sourceUrl ? `
        <a href="#" class="card-title-link" data-url="${escapeHTML(item.sourceUrl)}" title="Open original post: ${escapeHTML(item.sourceUrl)}">
          ${escapeHTML(title)} ↗
        </a>
      ` : escapeHTML(title)}
    </div>
    ${bodyHtml}
    ${entityChips}
    
    <div class="card-footer">
      <div class="tags-container">
        <span class="card-category-label ${isTagDynamic(tag) ? 'is-dynamic' : ''}" style="--tag-color: ${tagColor}" data-filter-tag="${escapeHTML(tag)}">
          <span class="cat-dot"></span>
          <span>${escapeHTML(tag)}</span>
          <button class="btn-flag btn-ignore-tag" title="Ignore tag ${escapeHTML(tag)}" data-tag="${escapeHTML(tag)}">
            <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path><line x1="4" y1="22" x2="4" y2="15"></line></svg>
          </button>
        </span>
        ${secondaryTagsHtml}
        ${authorHtml}
        ${infoTooltipHtml}
      </div>
      <div class="override-trigger-wrapper">
        <button class="btn-override-trigger">
          <span>Override</span>
          <svg class="dropdown-arrow-icon" viewBox="0 0 24 24" width="8" height="8" fill="none" stroke="currentColor" stroke-width="3">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>
        <div class="override-popover">
          ${tagOptions}
        </div>
      </div>
    </div>
  `;

  // Favicon fallback (inline onerror handlers are blocked by the extension CSP)
  const favicon = card.querySelector('.card-favicon');
  if (favicon) {
    favicon.addEventListener('error', () => { favicon.style.display = 'none'; }, { once: true });
  }

  // Handle author profile clicks
  const profileLinks = card.querySelectorAll('.card-author-profile-link');
  profileLinks.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openExternal(link.dataset.url);
    });
  });

  // Handle author filter button clicks
  const filterBtns = card.querySelectorAll('.card-author-filter-btn');
  filterBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const author = btn.dataset.author;
      if (activeFilterAuthor === author) {
        activeFilterAuthor = 'All';
      } else {
        activeFilterAuthor = author;
      }
      applyFilterChange();
    });
  });

  // Handle ignore tag button clicks
  const ignoreTagBtns = card.querySelectorAll('.btn-ignore-tag');
  ignoreTagBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const tagToIgnore = btn.dataset.tag;
      showIgnoreTagConfirmation(tagToIgnore, () => {
        send(MSG.IGNORE_TAG_ADDED, { tag: tagToIgnore });
      });
    });
  });

  // Handle ignore domain button clicks
  const ignoreDomainBtns = card.querySelectorAll('.btn-ignore-domain');
  ignoreDomainBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const domainToIgnore = btn.dataset.domain;
      showIgnoreDomainConfirmation(domainToIgnore, () => {
        send(MSG.IGNORE_DOMAIN_ADDED, { domain: domainToIgnore });
      });
    });
  });

  // Handle ignore link button clicks
  const ignoreLinkBtns = card.querySelectorAll('.btn-ignore-link');
  ignoreLinkBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const linkToIgnore = btn.dataset.url;
      send(MSG.IGNORE_LINK_ADDED, { url: linkToIgnore });
    });
  });

  const titleLink = card.querySelector('.card-title-link');
  if (titleLink) {
    titleLink.addEventListener('click', (e) => {
      e.preventDefault();
      openExternal(titleLink.dataset.url);
    });
  }

  const link = card.querySelector('.card-site-link');
  if (link) {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      openExternal(link.dataset.url);
    });
  }

  const categoryLabels = card.querySelectorAll('.card-category-label');
  categoryLabels.forEach(label => {
    label.addEventListener('click', (e) => {
      e.stopPropagation();
      const filterTag = label.dataset.filterTag;
      if (filterTag) {
        // Clicking the active category again goes back to All (never to "no filter").
        activeFilterTag = activeFilterTag === filterTag ? 'All' : filterTag;
        activeFilterAuthor = 'All';
        if (dom.feedContainer) dom.feedContainer.scrollTop = 0;
        applyFilterChange();
        scrollActivePillIntoView();
      }
    });
    // Preserve existing double-click logic for sticky toggle
    label.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const filterTag = label.dataset.filterTag;
      if (filterTag) handleTagTrackToggle(filterTag);
    });
  });

  const expandBtn = card.querySelector('.btn-body-expand');
  if (expandBtn) {
    expandBtn.addEventListener('click', () => {
      const bodyEl = card.querySelector('.card-body');
      const isCurrentlyCollapsed = bodyEl.classList.toggle('collapsed');
      expandBtn.textContent = isCurrentlyCollapsed ? 'Show more' : 'Show less';
      if (isCurrentlyCollapsed) {
        expandedItemIds.delete(item.id);
      } else {
        expandedItemIds.add(item.id);
      }
      
      if (virtualizerObserver) {
        virtualizerObserver.unobserve(card);
        virtualizerObserver.observe(card);
      }
    });
  }

  card.querySelector('.btn-favorite').addEventListener('click', (e) => {
    e.stopPropagation();
    const isFavorite = !item.isFavorite;
    send(MSG.FAVORITE_TOGGLED, { itemId: item.id, isFavorite });
    item.isFavorite = isFavorite;
    updateFavoriteButtonUI(card, isFavorite, true);
    card.dataset.sig = cardSignature(item);
    renderFilterPills();
    renderFeed();
  });

  card.querySelector('.btn-card-delete').addEventListener('click', (e) => {
    e.stopPropagation();
    if (virtualizerObserver) {
      virtualizerObserver.unobserve(card);
    }
    send(MSG.ITEM_DELETED, { itemId: item.id });
    state.stack = state.stack.filter(i => i.id !== item.id);
    renderStreamViews();
  });

  const triggerBtn = card.querySelector('.btn-override-trigger');
  const popover = card.querySelector('.override-popover');
  triggerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    
    if (openDropdownItemId && openDropdownItemId !== item.id) {
      const activeCard = rowForItem(openDropdownItemId);
      if (activeCard) {
        activeCard.querySelector('.override-popover').classList.remove('show');
        activeCard.querySelector('.btn-override-trigger').classList.remove('dropdown-active');
      }
    }

    const isOpen = popover.classList.toggle('show');
    triggerBtn.classList.toggle('dropdown-active', isOpen);
    openDropdownItemId = isOpen ? item.id : null;
  });

  popover.querySelectorAll('.override-popover-item').forEach(opt => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      const newTag = opt.dataset.tag;
      popover.classList.remove('show');
      triggerBtn.classList.remove('dropdown-active');
      openDropdownItemId = null;

      send(MSG.ITEM_RETAGGED, { itemId: item.id, newTag });

      item.assignedTag = newTag;
      item.matchInfo = { engine: 'Manual Override', manual: true };
      renderStreamViews();
    });
  });
}

/** Re-renders the Stream tab (counts, pills, feed) without touching the Settings forms. */
function renderStreamViews() {
  renderTelemetry();
  renderStreamStatus();
  renderFilterPills();
  renderSiteFilterPills();
  renderAuthorPills();
  renderFeed();
}

// ---------- Configurator Rendering ----------

/**
 * Settings › Tracked Categories. A broadcast (STATE_UPDATED) must not wipe what the user is
 * typing: while a text field in the list has focus the re-render is skipped and done on focusout;
 * open prompt editors stay open across re-renders.
 */
function renderTagConfigurator() {
  const list = dom.tagList;
  if (!list) return;
  if (list.contains(document.activeElement) && isTextEntry(document.activeElement)) {
    tagListDirty = true;
    return;
  }
  tagListDirty = false;

  const tags = state.configuration.trackedTags || [];
  list.innerHTML = '';
  const labelsNow = new Set();

  tags.forEach((tag, i) => {
    const label = typeof tag === 'string' ? tag : (tag && tag.label);
    if (!label) return;
    labelsNow.add(label);
    const enabled = typeof tag === 'string' ? true : tag.isEnabled !== false;
    const isDynamic = typeof tag === 'object' && tag.isDynamic;
    const isSticky = typeof tag === 'object' && tag.isSticky;
    const color = BADGE_COLORS[i % BADGE_COLORS.length];
    const isExpanded = expandedTagPrompts.has(label);

    const prompt = typeof tag === 'object' ? (tag.prompt || '') : '';

    const row = document.createElement('div');
    row.className = isDynamic ? 'tag-row dynamic' : 'tag-row';
    row.dataset.tag = label;
    row.style.flexDirection = 'column';
    row.style.alignItems = 'stretch';

    const promoteHtml = isDynamic
      ? `<button class="btn-tag-action btn-promote-tag" data-tag="${escapeHTML(label)}" title="Promote to tracking tag">★</button>`
      : '';

    const stickyHtml = isDynamic
      ? `<button class="btn-tag-action btn-sticky-tag ${isSticky ? 'sticky' : ''}" data-tag="${escapeHTML(label)}" title="${isSticky ? 'Make tag temporary' : 'Make tag sticky'}">${isSticky ? '📌' : '📍'}</button>`
      : '';

    row.innerHTML = `
      <div style="display: flex; align-items: center; width: 100%;">
        <span class="tag-dot-indicator" style="background: ${color}"></span>
        <span class="tag-label" style="flex: 1;">${escapeHTML(label)} ${isDynamic ? '<span style="font-size: 9px; opacity: 0.5; font-style: italic;">(dynamic)</span>' : ''}</span>
        <button class="btn-expand-prompt" title="Edit tag prompt" aria-expanded="${isExpanded ? 'true' : 'false'}">✎</button>
        <label class="tag-toggle" style="margin-left: auto;" title="${enabled ? 'Tracking' : 'Not tracking'}">
          <input type="checkbox" ${enabled ? 'checked' : ''} data-tag="${escapeHTML(label)}" aria-label="Track ${escapeHTML(label)}">
          <span class="toggle-track"></span>
        </label>
        ${stickyHtml}
        ${promoteHtml}
        <button class="btn-tag-action btn-delete-tag" data-tag="${escapeHTML(label)}" title="Remove tag">×</button>
      </div>
      <div class="tag-prompt-container" style="display: ${isExpanded ? 'flex' : 'none'};">
        <textarea class="tag-prompt-textarea" rows="2" aria-label="Prompt for ${escapeHTML(label)}" placeholder="Identify posts related to ${escapeHTML(label)}.">${escapeHTML(prompt)}</textarea>
        <button type="button" class="btn-wand btn-wand-existing" title="Regenerate prompt with AI">✨</button>
      </div>
    `;

    const checkbox = row.querySelector('input[type="checkbox"]');
    checkbox.addEventListener('change', () => {
      send(MSG.TAG_TOGGLED, { tag: label, enabled: checkbox.checked });
    });

    // Expand prompt box (remembered across re-renders)
    const expandBtn = row.querySelector('.btn-expand-prompt');
    const promptContainer = row.querySelector('.tag-prompt-container');
    const promptTextarea = row.querySelector('.tag-prompt-textarea');
    expandBtn.addEventListener('click', () => {
      const open = promptContainer.style.display === 'none';
      promptContainer.style.display = open ? 'flex' : 'none';
      expandBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) {
        expandedTagPrompts.add(label);
        promptTextarea.focus();
      } else {
        expandedTagPrompts.delete(label);
      }
    });

    // Save prompt on change (blur)
    promptTextarea.addEventListener('change', (e) => {
      send(MSG.TAG_PROMPT_UPDATED, { tag: label, prompt: e.target.value });
    });

    // Magic wand for existing tag
    const wandBtn = row.querySelector('.btn-wand-existing');
    wandBtn.addEventListener('click', async () => {
      const currentPrompt = promptTextarea.value;
      promptTextarea.placeholder = 'Regenerating…';
      promptTextarea.value = '';
      wandBtn.disabled = true;
      const response = await send(MSG.GENERATE_TAG_EVAL_PROMPT, { tag: label, currentPrompt });
      wandBtn.disabled = false;
      // The row may have been re-rendered meanwhile: write to the live textarea.
      const live = rowTextareaFor(label) || promptTextarea;
      if (response && response.success && typeof response.prompt === 'string') {
        live.value = response.prompt;
        send(MSG.TAG_PROMPT_UPDATED, { tag: label, prompt: response.prompt });
      } else {
        live.value = currentPrompt;
        notify('warn', 'Could not suggest a prompt right now.', 'tag-wand');
      }
    });

    if (isDynamic) {
      row.querySelector('.btn-sticky-tag').addEventListener('click', () => {
        send(MSG.TAG_STICKY_TOGGLED, { tag: label, isSticky: !isSticky });
      });
      row.querySelector('.btn-promote-tag').addEventListener('click', () => {
        send(MSG.TAG_PROMOTED, { tag: label });
      });
    }

    row.querySelector('.btn-delete-tag').addEventListener('click', () => {
      expandedTagPrompts.delete(label);
      send(MSG.TAG_REMOVED, { tag: label });
    });

    list.appendChild(row);
  });

  // Forget editors of tags that no longer exist.
  for (const label of [...expandedTagPrompts]) if (!labelsNow.has(label)) expandedTagPrompts.delete(label);
}

/** The prompt textarea of a tag row currently in the DOM. */
function rowTextareaFor(label) {
  if (!dom.tagList) return null;
  const row = [...dom.tagList.querySelectorAll('.tag-row')].find(r => r.dataset.tag === label);
  return row ? row.querySelector('.tag-prompt-textarea') : null;
}

function renderSitesConfigurator() {
  const sites = state.configuration.sites || [];
  const list = dom.sitesList;
  list.innerHTML = '';

  sites.forEach(site => {
    const row = document.createElement('div');
    row.className = site.isCustom ? 'tag-row custom-site' : 'tag-row';

    const siteId = escapeHTML(String(site.id ?? ''));
    const deleteBtnHtml = site.isCustom
      ? `<button class="btn-tag-action btn-delete-tag btn-delete-site" data-id="${siteId}" title="Remove site">×</button>`
      : '';

    const domainLabel = site.domain === '*' ? 'Any Site (*)' : escapeHTML(site.domain);
    const cautionWarning = site.domain === '*' ? '<div style="font-size: 9px; color: var(--danger); margin-left: 8px;">(Enable with caution)</div>' : '';

    row.innerHTML = `
      <div style="display: flex; align-items: center; flex: 1;">
        <span class="tag-dot-indicator" style="background: var(--text-muted); opacity: 0.5;"></span>
        <span class="tag-label" style="font-family: monospace;">${domainLabel}</span>
        ${cautionWarning}
      </div>
      <label class="tag-toggle">
        <input type="checkbox" ${site.isEnabled ? 'checked' : ''} data-id="${siteId}">
        <span class="toggle-track"></span>
      </label>
      ${deleteBtnHtml}
    `;

    const checkbox = row.querySelector('input[type="checkbox"]');
    checkbox.addEventListener('change', () => {
      send(MSG.SITE_TOGGLED, { siteId: site.id, enabled: checkbox.checked });
    });

    if (site.isCustom) {
      row.querySelector('.btn-delete-site').addEventListener('click', () => {
        send(MSG.SITE_REMOVED, { siteId: site.id });
      });
    }

    list.appendChild(row);
  });
}

function renderIgnoredKeywords() {
  const keywords = state.configuration.ignoredKeywords || [];
  const list = dom.keywordsList;
  list.innerHTML = '';

  if (keywords.length === 0) {
    list.innerHTML = `<div style="font-size: 11px; color: var(--text-muted); font-style: italic; padding: 4px 0;">No ignored keywords.</div>`;
    return;
  }

  keywords.forEach(kw => {
    const row = document.createElement('div');
    row.className = 'tag-row';
    row.innerHTML = `
      <span class="tag-dot-indicator" style="background: var(--danger); opacity: 0.5;"></span>
      <span class="tag-label">${escapeHTML(kw)}</span>
      <button class="btn-tag-action btn-delete-tag btn-delete-kw" data-kw="${escapeHTML(kw)}" title="Remove filter">×</button>
    `;

    row.querySelector('.btn-delete-kw').addEventListener('click', () => {
      send(MSG.KEYWORD_REMOVED, { keyword: kw });
    });

    list.appendChild(row);
  });
}

function renderIgnoredTags() {
  const tags = state.configuration.ignoredTags || [];
  const list = dom.ignoredTagsList;
  if (!list) return;
  list.innerHTML = '';

  if (tags.length === 0) {
    list.innerHTML = `<div style="font-size: 11px; color: var(--text-muted); font-style: italic; padding: 4px 0;">No ignored tags.</div>`;
    return;
  }

  tags.forEach(t => {
    const row = document.createElement('div');
    row.className = 'tag-row';
    row.innerHTML = `
      <span class="tag-dot-indicator" style="background: var(--danger); opacity: 0.5;"></span>
      <span class="tag-label">${escapeHTML(t)}</span>
      <button class="btn-tag-action btn-delete-tag btn-delete-ignored-tag" data-tag="${escapeHTML(t)}" title="Remove filter">×</button>
    `;

    row.querySelector('.btn-delete-ignored-tag').addEventListener('click', () => {
      send(MSG.IGNORE_TAG_REMOVED, { tag: t });
    });

    list.appendChild(row);
  });
}

function renderIgnoredDomains() {
  const domains = state.configuration.ignoredDomains || [];
  const list = dom.ignoredDomainsList;
  if (!list) return;
  list.innerHTML = '';

  if (domains.length === 0) {
    list.innerHTML = `<div style="font-size: 11px; color: var(--text-muted); font-style: italic; padding: 4px 0;">No ignored domains.</div>`;
    return;
  }

  domains.forEach(d => {
    const row = document.createElement('div');
    row.className = 'tag-row';
    row.innerHTML = `
      <span class="tag-dot-indicator" style="background: var(--danger); opacity: 0.5;"></span>
      <span class="tag-label">${escapeHTML(d)}</span>
      <button class="btn-tag-action btn-delete-tag btn-delete-ignored-domain" data-domain="${escapeHTML(d)}" title="Remove filter">×</button>
    `;

    row.querySelector('.btn-delete-ignored-domain').addEventListener('click', () => {
      send(MSG.IGNORE_DOMAIN_REMOVED, { domain: d });
    });

    list.appendChild(row);
  });
}

function renderIgnoredLinks() {
  const links = state.configuration.ignoredLinks || [];
  const list = dom.ignoredLinksList;
  if (!list) return;
  list.innerHTML = '';

  if (links.length === 0) {
    list.innerHTML = `<div style="font-size: 11px; color: var(--text-muted); font-style: italic; padding: 4px 0;">No ignored links.</div>`;
    return;
  }

  links.forEach(lnk => {
    const row = document.createElement('div');
    row.className = 'tag-row';
    row.innerHTML = `
      <span class="tag-dot-indicator" style="background: var(--danger); opacity: 0.5;"></span>
      <span class="tag-label" style="text-overflow: ellipsis; overflow: hidden; white-space: nowrap; max-width: 180px;" title="${escapeHTML(lnk)}">${escapeHTML(lnk)}</span>
      <button class="btn-tag-action btn-delete-tag btn-delete-ignored-link" data-link="${escapeHTML(lnk)}" title="Remove filter">×</button>
    `;

    row.querySelector('.btn-delete-ignored-link').addEventListener('click', () => {
      send(MSG.IGNORE_LINK_REMOVED, { url: lnk });
    });

    list.appendChild(row);
  });
}

// ---------- Prompt filter ----------

/** Known EngineStatus.warnings (lib/pipeline/apply-decision.js promptWarnings and the cascade). */
const PROMPT_WARNING_TEXT = {
  empty_prompt: 'The filter is on but the prompt is empty, so every post is collected.',
  gate_off_with_prompt: 'The filter is off, so every post is collected. Turn it on to keep only posts that match this prompt.'
};

// The prompt is saved explicitly (Save button or Ctrl/Cmd+Enter) so a half-typed prompt never
// re-decides the stack. GENERATE_PROMPT_TAGS follows the save; `promptGen` identifies the latest
// save so replies for older text are ignored.
let promptGen = 0;
let promptSaveInFlight = 0;
let promptTagsPending = false;
/** Set when the user types in the prompt box; cleared by Save / Discard. */
let promptUserEdited = false;

/** True when the user typed a prompt that differs from the saved one. */
function isPromptDirty() {
  if (!dom.matchPromptInput || !promptUserEdited) return false;
  return dom.matchPromptInput.value.trim() !== String((state.configuration || {}).matchPrompt || '').trim();
}

/** Save button / Discard button / "Unsaved changes" line. */
function renderPromptSaveState(errorText = '') {
  if (!dom.matchPromptSave) return;
  const dirty = isPromptDirty();
  const saving = promptSaveInFlight > 0;
  dom.matchPromptSave.disabled = !dirty || saving;
  dom.matchPromptSave.textContent = saving ? 'Saving…' : 'Save prompt';
  if (dom.matchPromptRevert) dom.matchPromptRevert.classList.toggle('hidden', !dirty || saving);
  if (dom.matchPromptSaveState) {
    let text = '';
    let tone = '';
    if (errorText) { text = errorText; tone = 'error'; }
    else if (saving) text = 'Saving and re-checking collected posts…';
    else if (dirty) { text = 'Unsaved changes — press Save (Ctrl+Enter) to apply.'; tone = 'dirty'; }
    dom.matchPromptSaveState.textContent = text;
    dom.matchPromptSaveState.dataset.tone = tone;
  }
}

/** Saves whatever is in the textarea (no-op when nothing changed). */
function saveTypedPrompt() {
  if (!dom.matchPromptInput || !isPromptDirty() || promptSaveInFlight > 0) return;
  const value = dom.matchPromptInput.value.trim();
  promptTagsPending = !!value;
  if (promptTagsPending) renderPromptChipsLoading();
  else renderPromptChips([]);
  renderPromptEnhanced('');
  return savePrompt(value);
}

/** Saves the prompt text, then asks for its key topics (chips) and expansion. */
async function savePrompt(value) {
  const gen = ++promptGen;
  promptSaveInFlight += 1;
  renderPromptSaveState();
  const reply = await send(MSG.UPDATE_MATCH_PROMPT, { prompt: value });
  promptSaveInFlight -= 1;
  if (!reply || reply.success === false) {
    if (gen === promptGen) {
      promptTagsPending = false;
      notify('error', 'Could not save the prompt. Try again in a moment.', 'prompt-save');
      renderMatchPromptConfigurator();
      renderPromptSaveState('Not saved — try again.');
    }
    return;
  }
  state.configuration = { ...state.configuration, matchPrompt: value };
  if (dom.matchPromptInput && dom.matchPromptInput.value.trim() === value) promptUserEdited = false;
  renderPromptSaveState();
  if (gen === promptGen) notify('info', 'Prompt saved. Collected posts are being re-checked.', 'prompt-save');
  if (gen !== promptGen) return; // a newer edit is on its way
  if (!value.trim()) {
    promptTagsPending = false;
    renderMatchPromptConfigurator();
    return;
  }
  const res = await send(MSG.GENERATE_PROMPT_TAGS, { prompt: value });
  if (gen !== promptGen) return; // the prompt changed while the topics were generated
  promptTagsPending = false;
  if (!res || res.stale || res.success === false) {
    // Stale replies (the prompt changed in the meantime) are ignored: broadcasts carry the truth.
    renderMatchPromptConfigurator();
    return;
  }
  renderPromptChips(res.tags);
  renderPromptEnhanced(res.enhanced);
}

/** Prompt-topic chips; tags may be strings or { name, weight }. Text is set with textContent. */
function renderPromptChips(tags) {
  const box = dom.matchPromptTagsContainer;
  if (!box) return;
  box.textContent = '';
  (Array.isArray(tags) ? tags : []).forEach(t => {
    const name = typeof t === 'string' ? t : (t && typeof t.name === 'string' ? t.name : '');
    if (!name.trim()) return;
    const weight = t && typeof t === 'object' && Number.isFinite(t.weight) ? t.weight : null;
    const chip = document.createElement('span');
    chip.className = 'entity-chip prompt-chip';
    chip.textContent = `#${name.trim()}`;
    if (weight !== null) {
      const w = document.createElement('span');
      w.className = 'chip-weight';
      w.textContent = String(weight);
      chip.append(' ', w);
      chip.style.opacity = Math.min(1, 0.4 + (weight / 5) * 0.5).toFixed(2);
    }
    box.appendChild(chip);
  });
}

function renderPromptChipsLoading() {
  const box = dom.matchPromptTagsContainer;
  if (!box) return;
  box.textContent = '';
  const note = document.createElement('span');
  note.className = 'prompt-chips-loading';
  note.textContent = 'Finding the key topics…';
  box.appendChild(note);
}

function renderPromptEnhanced(enhanced) {
  if (!dom.matchPromptEnhanced) return;
  const text = typeof enhanced === 'string' ? enhanced.trim() : '';
  dom.matchPromptEnhanced.textContent = text ? `Expanded: “${text}”` : '';
  dom.matchPromptEnhanced.classList.toggle('hidden', !text);
}

function renderMatchPromptConfigurator() {
  const cfg = state.configuration || {};
  if (!dom.matchPromptToggle || !dom.matchPromptInput) return;
  // Never overwrite what the user is typing, or typed and has not saved yet.
  const editing = document.activeElement === dom.matchPromptInput || isPromptDirty() || promptSaveInFlight > 0;
  if (!editing && dom.matchPromptInput.value !== (cfg.matchPrompt || '')) {
    dom.matchPromptInput.value = cfg.matchPrompt || '';
  }
  dom.matchPromptToggle.checked = !!cfg.isMatchPromptEnabled;

  if (promptTagsPending) renderPromptChipsLoading();
  else renderPromptChips(cfg.matchPrompt ? cfg.matchPromptTags : []);
  if (!promptTagsPending) renderPromptEnhanced(cfg.matchPrompt ? cfg.matchPromptEnhanced : '');

  renderPromptStatus();
  renderPromptSaveState();
}

/**
 * ON/OFF state of the filter plus a one-line hint: the prompt is set but the filter is off, the
 * filter is on with an empty prompt, and other EngineStatus warnings.
 */
function renderPromptStatus() {
  if (!dom.matchPromptState || !dom.matchPromptHint) return;
  const cfg = state.configuration || {};
  const on = !!cfg.isMatchPromptEnabled;
  const typed = dom.matchPromptInput ? dom.matchPromptInput.value : '';
  const hasPrompt = !!String((dom.matchPromptInput ? typed : cfg.matchPrompt) || '').trim();

  dom.matchPromptState.textContent = on ? 'On' : 'Off';
  dom.matchPromptState.dataset.on = on ? 'true' : 'false';
  if (dom.promptSection) dom.promptSection.dataset.filter = on ? 'on' : 'off';

  const lines = [];
  let tone = 'info';
  // Derived here (fresher than the service worker's copy while the user types).
  if (on && !hasPrompt) {
    lines.push(PROMPT_WARNING_TEXT.empty_prompt);
    tone = 'warn';
  } else if (!on && hasPrompt) {
    lines.push(PROMPT_WARNING_TEXT.gate_off_with_prompt);
  }
  const warnings = state.engineStatus && Array.isArray(state.engineStatus.warnings) ? state.engineStatus.warnings : [];
  for (const w of warnings) {
    if (typeof w !== 'string' || w === 'empty_prompt' || w === 'gate_off_with_prompt') continue;
    lines.push(PROMPT_WARNING_TEXT[w] || w.replace(/_/g, ' '));
    tone = 'warn';
  }
  dom.matchPromptHint.textContent = lines.join(' ');
  dom.matchPromptHint.dataset.tone = tone;
  dom.matchPromptHint.classList.toggle('hidden', lines.length === 0);
}

// ---------- Stream status: hidden-by-prompt pill, re-decide progress ----------

function renderStreamStatus() {
  if (!dom.streamStatus) return;
  const hidden = countHiddenByPrompt();
  if (hidden === 0 && showHiddenByPrompt) showHiddenByPrompt = false;

  dom.hiddenPill.classList.toggle('hidden', hidden === 0);
  dom.hiddenPill.classList.toggle('active', showHiddenByPrompt);
  dom.hiddenPill.setAttribute('aria-pressed', showHiddenByPrompt ? 'true' : 'false');
  dom.hiddenPillLabel.textContent = `Hidden by prompt (${hidden})`;
  dom.hiddenPill.title = showHiddenByPrompt
    ? 'Showing posts that no longer match your prompt. Click to hide them again.'
    : 'Posts that no longer match your prompt are hidden, never deleted. Click to show them.';

  const p = lastRedecide;
  const showProgress = !!p;
  dom.redecideStatus.classList.toggle('hidden', !showProgress);
  if (showProgress) {
    const total = Number(p.total) || 0;
    const done = Math.min(Number(p.done) || 0, total || Infinity);
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    dom.redecideText.textContent = p.finished
      ? `Re-checked ${total} post${total === 1 ? '' : 's'} · ${Number(p.hidden) || 0} hidden`
      : `Re-checking posts… ${total > 0 ? `${done}/${total}` : ''}`;
    const fill = dom.redecideBar.querySelector('.progress-fill');
    dom.redecideBar.classList.toggle('indeterminate', !p.finished && total === 0);
    fill.style.width = p.finished ? '100%' : (total > 0 ? `${pct}%` : '');
    dom.redecideBar.setAttribute('aria-valuenow', String(p.finished ? 100 : pct));
  }
  dom.streamStatus.classList.toggle('hidden', hidden === 0 && !showProgress);
}

/** REDECIDE_PROGRESS { jobId, done, total, hidden, finished } */
function onRedecideProgress(p) {
  if (!p || typeof p !== 'object') return;
  lastRedecide = { ...p };
  renderStreamStatus();
  if (diagnostics) diagnostics.onRedecideProgress(p);
  if (p.finished) {
    const finishedJob = p.jobId;
    setTimeout(() => {
      if (lastRedecide && lastRedecide.finished && lastRedecide.jobId === finishedJob) {
        lastRedecide = null;
        renderStreamStatus();
      }
    }, 5000);
  }
}

function toggleHiddenByPrompt() {
  showHiddenByPrompt = !showHiddenByPrompt;
  renderStreamStatus();
  applyFilterChange();
  renderTelemetry();
  renderExportNote();
}

function renderAll() {
  renderTelemetry();
  renderEngineStatus();
  renderProcessingStatus();
  renderPauseStatus();
  renderStreamStatus();
  renderFilterPills();
  renderSiteFilterPills();
  renderAuthorPills();
  renderFeed();
  renderExportNote();
  renderMatchPromptConfigurator();
  renderTagConfigurator();
  renderSitesConfigurator();
  renderIgnoredKeywords();
  renderIgnoredTags();
  renderIgnoredDomains();
  renderIgnoredLinks();
  if (intelligence) intelligence.update({ configuration: state.configuration });
}

// ---------- Exports (ui/export.js) ----------

function manifestVersion() {
  try {
    return (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '';
  } catch {
    return '';
  }
}

/** Exports contain what the feed shows: ignore lists apply; hidden-by-prompt posts only when shown. */
function renderExportNote() {
  if (!dom.exportNote) return;
  const hidden = countHiddenByPrompt();
  const text = hidden > 0 && !showHiddenByPrompt
    ? `${hidden} post${hidden === 1 ? '' : 's'} hidden by your prompt ${hidden === 1 ? 'is' : 'are'} not included. Turn on “Hidden by prompt” in Stream to include ${hidden === 1 ? 'it' : 'them'}.`
    : '';
  dom.exportNote.textContent = text;
  dom.exportNote.classList.toggle('hidden', !text);
}

/** @param {'json'|'csv'|'html'} kind */
function triggerExport(kind) {
  const items = getActiveStack();
  if (items.length === 0) {
    notify('info', 'Nothing to export yet. Start scrolling a feed first.', 'export');
    return;
  }
  const now = Date.now();
  const input = { items, configuration: state.configuration, version: manifestVersion(), now };
  let content;
  if (kind === 'json') content = toJson(input);
  // The BOM lets spreadsheet apps detect UTF-8.
  else if (kind === 'csv') content = `﻿${toCsv(items)}`;
  else content = toHtmlExport({ ...input, tagColor: getTagColor });
  try {
    downloadText(content, exportFilename(kind, now), EXPORT_MIME[kind]);
    notify('success', `Exported ${items.length} post${items.length === 1 ? '' : 's'} as ${kind.toUpperCase()}.`, 'export');
  } catch (err) {
    console.error('[sidepanel] export failed', err);
    notify('error', 'The export failed. Please try again.', 'export');
  }
}

// ---------- Tab Change Auto-Detection Listener ----------

function initTabChangeListener() {
  if (!chrome.tabs) return;

  chrome.tabs.onActivated.addListener(activeInfo => {
    chrome.tabs.get(activeInfo.tabId, (tab) => {
      if (chrome.runtime.lastError || !tab || !tab.url) return;
      handleTabUrlChange(tab.url);
    });
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs && tabs[0] && tabs[0].id === tabId) {
          handleTabUrlChange(changeInfo.url);
        }
      });
    }
  });

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs[0] && tabs[0].url) {
      handleTabUrlChange(tabs[0].url);
    }
  });
}

function handleTabUrlChange(url) {
  try {
    const hostname = new URL(url).hostname.replace('www.', '').toLowerCase();
    const defaultSites = ['linkedin.com', 'x.com', 'twitter.com', 'youtube.com', 'facebook.com', 'instagram.com', 'medium.com', 'github.com', 'news.ycombinator.com'];
    const customSites = (state.configuration.sites || []).filter(s => s.isCustom).map(s => s.domain.toLowerCase());
    const enabledDomains = [...defaultSites, ...customSites];

    let matched = 'All';
    for (const domain of enabledDomains) {
      if (hostname === domain || hostname.endsWith('.' + domain)) {
        matched = domain;
        break;
      }
    }

    if (matched === 'twitter.com') matched = 'x.com';

    const configuredSites = state.configuration.sites || [];
    const cfg = configuredSites.find(s => s.domain.toLowerCase() === matched);
    if (cfg && cfg.isEnabled === false) {
      matched = 'All';
    }

    if (activeFilterSite !== matched) {
      setFilterSite(matched);
    }
  } catch (err) {
    // ignore
  }
}

// ---------- Message Listener ----------

function initMessageListener() {
  chrome.runtime.onMessage.addListener((message, sender) => {
    // Messages for the offscreen document / service worker carry a target: not ours.
    if (!message || typeof message.type !== 'string' || message.target) return;
    // Only this extension's own contexts (the service worker) update the panel. Content scripts
    // run inside web pages: a compromised page could otherwise forge the collected stack, toasts,
    // the engine badge or re-decide progress in this trusted UI.
    if (!isExtensionPageSender(sender)) return;

    switch (message.type) {
      case MSG.STATE_UPDATED:
        if (message.payload && typeof message.payload === 'object') {
          state = { ...state, ...message.payload, engineStatus: state.engineStatus };
          renderAll();
        }
        break;

      case MSG.INFLIGHT_UPDATED:
        // Cheap counter update: no full re-render.
        state.inFlightCount = Math.max(0, Number(message.payload && message.payload.count) || 0);
        renderProcessingStatus();
        break;

      case MSG.ENGINE_STATUS:
        applyEngineStatus(message.payload);
        break;

      case MSG.REDECIDE_PROGRESS:
        onRedecideProgress(message.payload);
        break;

      case MSG.TOAST: {
        const p = message.payload || {};
        if (typeof p.text === 'string' && p.text.trim()) notify(p.level, p.text, typeof p.key === 'string' ? p.key : undefined);
        break;
      }
    }
  });
}

// ---------- Intelligence settings & diagnostics ----------

/** Calibrated confidence floors of a System 1 model (placeholders for the floor inputs). */
async function loadCalibration(modelKey) {
  if (!/^[a-z0-9-]+$/i.test(String(modelKey || ''))) return null;
  try {
    const res = await fetch(chrome.runtime.getURL(`lib/decision/calibration/${modelKey}.q8.json`));
    if (!res.ok) return null;
    const json = await res.json();
    return json && typeof json === 'object' ? { floor: json.floor || null } : null;
  } catch {
    return null;
  }
}

function initIntelligence() {
  const intelligenceRoot = $('#intelligence-root');
  const diagnosticsRoot = $('#diagnostics-root');
  if (intelligenceRoot) {
    intelligence = mountIntelligence(intelligenceRoot, {
      send,
      toast: toaster,
      getLanguageModel: () => globalThis.LanguageModel,
      loadCalibration
    });
  }
  if (diagnosticsRoot) {
    diagnostics = mountDiagnostics(diagnosticsRoot, {
      send,
      toast: toaster,
      getContext: () => ({
        version: manifestVersion(),
        intelligence: (state.configuration && state.configuration.intelligence) || null,
        engineStatus: state.engineStatus
      }),
      onDiagnostics: (diag) => {
        if (intelligence) intelligence.update({ diagnostics: diag });
        if (diag && diag.engineStatus && typeof diag.engineStatus === 'object' && diag.engineStatus.badge) {
          applyEngineStatus(diag.engineStatus);
        }
      }
    });
  }
}

/** Header badge: opens Settings › Intelligence. */
function openIntelligenceSettings() {
  switchTab('settings');
  const section = $('#intelligence-section');
  if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- DOMContentLoaded Bootstrap ----------

document.addEventListener('DOMContentLoaded', () => {
  dom = {
    telTotal: $('#tel-total'),
    telRate: $('#tel-rate'),
    telEngine: $('#tel-engine'),
    engineBadge: $('#engine-badge'),
    engineDot: $('#engine-dot'),
    engineLabel: $('#engine-label'),
    processingIndicator: $('#processing-indicator'),
    processingCount: $('#processing-count'),
    streamList: $('#stream-list'),
    streamEmpty: $('#stream-empty'),
    streamStatus: $('#stream-status'),
    hiddenPill: $('#hidden-pill'),
    hiddenPillLabel: $('#hidden-pill-label'),
    redecideStatus: $('#redecide-status'),
    redecideText: $('#redecide-text'),
    redecideBar: $('#redecide-bar'),
    filterPills: $('#filter-pills'),
    filterSitePills: $('#filter-site-pills'), // Site filter scroller
    filterAuthorPills: $('#filter-author-pills'), // Author filter scroller
    globalSearch: $('#global-search'), // Search input element
    searchClearBtn: $('#search-clear-btn'), // Search clear button
    btnTagsDropdown: $('#btn-tags-dropdown'),
    menuTagsDropdown: $('#menu-tags-dropdown'),
    btnSitesDropdown: $('#btn-sites-dropdown'),
    menuSitesDropdown: $('#menu-sites-dropdown'),
    btnAuthorsDropdown: $('#btn-authors-dropdown'),
    menuAuthorsDropdown: $('#menu-authors-dropdown'),
    tabCountStream: $('#tab-count-stream'),
    feedContainer: $('#feed-container'),

    // Pause elements
    pauseToggle: $('#pause-toggle'),
    pauseIcon: $('#pause-icon'),
    playIcon: $('#play-icon'),
    pauseBanner: $('#pause-banner'),
    pauseTime: $('#pause-time'),

    // Export Buttons
    btnExportHtml: $('#btn-export-html'),
    btnExportJson: $('#btn-export-json'),
    btnExportCsv: $('#btn-export-csv'),
    exportNote: $('#export-note'),

    // Settings config
    tagList: $('#tag-list'),
    sitesList: $('#sites-list'),
    keywordsList: $('#keywords-list'),
    addTagForm: $('#add-tag-form'),
    addSiteForm: $('#add-site-form'),
    addKeywordForm: $('#add-keyword-form'),
    newTagInput: $('#new-tag-input'),
    newSiteInput: $('#new-site-input'),
    newKeywordInput: $('#new-keyword-input'),

    ignoredTagsList: $('#ignored-tags-list'),
    ignoredDomainsList: $('#ignored-domains-list'),
    ignoredLinksList: $('#ignored-links-list'),
    addIgnoredTagForm: $('#add-ignored-tag-form'),
    addIgnoredDomainForm: $('#add-ignored-domain-form'),
    addIgnoredLinkForm: $('#add-ignored-link-form'),
    newIgnoredTagInput: $('#new-ignored-tag-input'),
    newIgnoredDomainInput: $('#new-ignored-domain-input'),
    newIgnoredLinkInput: $('#new-ignored-link-input'),

    promptSection: $('#prompt-section'),
    matchPromptToggle: $('#match-prompt-toggle'),
    matchPromptState: $('#match-prompt-state'),
    matchPromptInput: $('#match-prompt-input'),
    matchPromptSave: $('#match-prompt-save'),
    matchPromptRevert: $('#match-prompt-revert'),
    matchPromptSaveState: $('#match-prompt-save-state'),
    matchPromptHint: $('#match-prompt-hint'),
    matchPromptTagsContainer: $('#match-prompt-tags-container'),
    matchPromptEnhanced: $('#match-prompt-enhanced'),

    clearStackBtn: $('#clear-stack-btn'),
    clearConfirmContainer: $('#clear-confirm-container'),
    btnConfirmClearTag: $('#btn-confirm-clear-tag'),
    btnConfirmClearAll: $('#btn-confirm-clear-all'),
    btnClearCancel: $('#btn-clear-cancel'),
    themeToggle: $('#theme-toggle'),
  };

  // Toasts first: everything below may report through them.
  toaster = createToaster({ root: document.body });

  // Init Theme
  initTheme();
  dom.themeToggle.addEventListener('click', toggleTheme);

  // Engine badge: grey "checking" until the service worker answers; polled only while unknown/loading.
  enginePoller = createEnginePoller({ poll: fetchEngineStatus, intervalMs: 5000 });
  renderEngineStatus();
  dom.engineBadge.addEventListener('click', openIntelligenceSettings);

  // Init segmented tab panels switching
  initTabs();

  // Drag to scroll pills
  initDragToScroll();

  // Initialize filter dropdown menus
  initFilterDropdowns();

  // Initialize virtualization observer
  initVirtualizer();

  // Keyboard navigation shortcuts
  initKeyboardNavigation();

  // Settings › Intelligence (System 1, providers, behaviour) and Diagnostics
  initIntelligence();

  // Hidden-by-prompt pill
  dom.hiddenPill.addEventListener('click', toggleHiddenByPrompt);

  // Tracked Categories: re-render once the user leaves a text field the broadcasts skipped.
  dom.tagList.addEventListener('focusout', () => {
    setTimeout(() => {
      if (tagListDirty && !(dom.tagList.contains(document.activeElement) && isTextEntry(document.activeElement))) {
        renderTagConfigurator();
      }
    }, 0);
  });

  // Add tag form handler
  // New tag prompt logic
  const newTagInput = $('#new-tag-input');
  const newTagPromptContainer = $('#new-tag-prompt-container');
  const newTagPromptInput = $('#new-tag-prompt-input');
  const newTagWandBtn = $('#new-tag-wand-btn');
  let newTagDebounce = null;
  let newTagRequest = 0;

  newTagInput.addEventListener('input', (e) => {
    const val = e.target.value.trim();
    if (!val) {
      newTagPromptContainer.style.display = 'none';
      newTagPromptInput.value = '';
      clearTimeout(newTagDebounce);
      return;
    }

    if (newTagPromptContainer.style.display === 'none') {
      newTagPromptContainer.style.display = 'flex';
      newTagPromptInput.placeholder = 'Generating prompt…';
      newTagPromptInput.value = '';
    }

    clearTimeout(newTagDebounce);
    newTagDebounce = setTimeout(async () => {
      const request = ++newTagRequest;
      const response = await send(MSG.GENERATE_TAG_EVAL_PROMPT, { tag: val, currentPrompt: '' });
      // Only fill in when this is still the latest request and the user has not typed a prompt.
      if (request === newTagRequest && response && response.success && typeof response.prompt === 'string' && !newTagPromptInput.value) {
        newTagPromptInput.value = response.prompt;
      }
    }, 800);
  });

  newTagWandBtn.addEventListener('click', async () => {
    const val = newTagInput.value.trim();
    if (!val) return;
    const currentPrompt = newTagPromptInput.value;
    newTagPromptInput.value = '';
    newTagPromptInput.placeholder = 'Regenerating…';
    const request = ++newTagRequest;
    const response = await send(MSG.GENERATE_TAG_EVAL_PROMPT, { tag: val, currentPrompt });
    if (request !== newTagRequest) return;
    if (response && response.success && typeof response.prompt === 'string') {
      newTagPromptInput.value = response.prompt;
    } else {
      newTagPromptInput.value = currentPrompt;
      notify('warn', 'Could not suggest a prompt right now.', 'tag-wand');
    }
  });

  dom.addTagForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const tagVal = newTagInput.value.trim();
    const promptVal = newTagPromptInput.value.trim();
    if (!tagVal) return;
    newTagRequest += 1;
    newTagInput.value = '';
    newTagPromptInput.value = '';
    newTagPromptContainer.style.display = 'none';
    const reply = await send(MSG.TAG_ADDED, { tag: tagVal, prompt: promptVal });
    if (reply && reply.success === false) notify('warn', reply.error === 'Tag already exists' ? `“${tagVal}” is already tracked.` : `Could not add “${tagVal}”.`, 'tag-add');
  });

  // Add site form handler
  dom.addSiteForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = dom.newSiteInput.value.trim();
    if (!value) return;
    if (!value.includes('.')) {
      notify('warn', 'Enter a domain name such as reddit.com.', 'site-add');
      dom.newSiteInput.focus();
      return;
    }
    send(MSG.SITE_ADDED, { domain: value });
    dom.newSiteInput.value = '';
  });

  // Add keyword form handler
  dom.addKeywordForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = dom.newKeywordInput.value.trim();
    if (!value) return;
    send(MSG.KEYWORD_ADDED, { keyword: value });
    dom.newKeywordInput.value = '';
  });

  // Add ignored tag form handler
  if (dom.addIgnoredTagForm) {
    dom.addIgnoredTagForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const value = dom.newIgnoredTagInput.value.trim();
      if (!value) return;
      send(MSG.IGNORE_TAG_ADDED, { tag: value });
      dom.newIgnoredTagInput.value = '';
    });
  }

  // Add ignored domain form handler
  if (dom.addIgnoredDomainForm) {
    dom.addIgnoredDomainForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const value = dom.newIgnoredDomainInput.value.trim();
      if (!value) return;
      send(MSG.IGNORE_DOMAIN_ADDED, { domain: value });
      dom.newIgnoredDomainInput.value = '';
    });
  }

  // Add ignored link form handler
  if (dom.addIgnoredLinkForm) {
    dom.addIgnoredLinkForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const value = dom.newIgnoredLinkInput.value.trim();
      if (!value) return;
      send(MSG.IGNORE_LINK_ADDED, { url: value });
      dom.newIgnoredLinkInput.value = '';
    });
  }

  // Prompt filter: toggle + explicit save (button / Ctrl+Enter) followed by topic generation
  if (dom.matchPromptToggle && dom.matchPromptInput) {
    dom.matchPromptToggle.addEventListener('change', async (e) => {
      const isEnabled = !!e.target.checked;
      // The toggle acts on the saved prompt: save pending typing first.
      if (isPromptDirty()) await saveTypedPrompt();
      state.configuration = { ...state.configuration, isMatchPromptEnabled: isEnabled };
      renderPromptStatus();
      const reply = await send(MSG.TOGGLE_MATCH_PROMPT, { isEnabled });
      if (!reply || reply.success === false) {
        notify('error', 'Could not change the prompt filter. Try again.', 'prompt-toggle');
        state.configuration = { ...state.configuration, isMatchPromptEnabled: !isEnabled };
        renderMatchPromptConfigurator();
      }
      // { stale: true } replies only mean the expansion was for an older prompt: nothing to do.
    });

    dom.matchPromptInput.addEventListener('input', () => {
      promptUserEdited = true;
      renderPromptStatus();
      renderPromptSaveState();
    });

    dom.matchPromptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        saveTypedPrompt();
      }
    });

    if (dom.matchPromptSave) dom.matchPromptSave.addEventListener('click', () => saveTypedPrompt());
    if (dom.matchPromptRevert) {
      dom.matchPromptRevert.addEventListener('click', () => {
        promptUserEdited = false;
        dom.matchPromptInput.value = (state.configuration || {}).matchPrompt || '';
        renderMatchPromptConfigurator();
        renderPromptSaveState();
      });
    }
    renderPromptSaveState();
  }

  // Pause button clicker
  dom.pauseToggle.addEventListener('click', () => {
    const nextPausedState = !state.configuration.isTrackingPaused;

    state.configuration.isTrackingPaused = nextPausedState;
    state.configuration.trackingPausedAt = nextPausedState ? Date.now() : null;
    renderPauseStatus();

    send(MSG.IS_TRACKING_PAUSED_TOGGLED, { isPaused: nextPausedState });
  });

  // Export action triggers
  dom.btnExportHtml.addEventListener('click', () => triggerExport('html'));
  dom.btnExportJson.addEventListener('click', () => triggerExport('json'));
  dom.btnExportCsv.addEventListener('click', () => triggerExport('csv'));

  // Clear stream
  dom.clearStackBtn.addEventListener('click', () => {
    dom.clearStackBtn.classList.add('hidden');
    dom.clearConfirmContainer.classList.remove('hidden');

    if (activeFilterTag && activeFilterTag !== 'All') {
      dom.btnConfirmClearTag.classList.remove('hidden');
      dom.btnConfirmClearTag.textContent = `Clear "${activeFilterTag}"`;
    } else {
      dom.btnConfirmClearTag.classList.add('hidden');
    }
  });

  dom.btnClearCancel.addEventListener('click', () => {
    resetClearConfirmation();
  });

  dom.btnConfirmClearTag.addEventListener('click', () => {
    send(MSG.CLEAR_STACK, { tag: activeFilterTag });
    resetClearConfirmation();
  });

  dom.btnConfirmClearAll.addEventListener('click', () => {
    send(MSG.CLEAR_STACK, { tag: 'All' });
    resetClearConfirmation();
  });

  // Global click event to dismiss custom popover overrides dropdown
  document.addEventListener('click', () => {
    if (openDropdownItemId) {
      const activeCard = rowForItem(openDropdownItemId);
      if (activeCard) {
        activeCard.querySelector('.override-popover').classList.remove('show');
        activeCard.querySelector('.btn-override-trigger').classList.remove('dropdown-active');
      }
      openDropdownItemId = null;
    }
  });

  // Search input listeners
  if (dom.globalSearch && dom.searchClearBtn) {
    dom.globalSearch.addEventListener('input', (e) => {
      searchQuery = e.target.value;
      if (searchQuery.trim().length > 0) {
        dom.searchClearBtn.classList.remove('hidden');
      } else {
        dom.searchClearBtn.classList.add('hidden');
      }
      // Post search works for all posts first: reset active sub-filters when searching
      activeFilterTag = 'All';
      activeFilterSite = 'All';
      activeFilterAuthor = 'All';
      applyFilterChange();
    });


    dom.searchClearBtn.addEventListener('click', () => {
      dom.globalSearch.value = '';
      searchQuery = '';
      dom.searchClearBtn.classList.add('hidden');
      applyFilterChange();
    });
  }

  // Message listeners
  initMessageListener();

  // Tab change listeners
  initTabChangeListener();

  // Initial state (rendered with defaults if the service worker does not answer)
  send(MSG.GET_STATE).then((response) => {
    if (response && typeof response === 'object' && response.success !== false) {
      state = { ...state, ...response, engineStatus: state.engineStatus };
    }
    try {
      renderAll();
    } catch (err) {
      console.error('[sidepanel] render failed', err);
      notify('error', 'Part of the panel failed to render. Reopen it to try again.', 'render');
    }
  });

  fetchEngineStatus();

  // Key status ({ set, last4 }) and provider stats for Settings › Intelligence.
  if (diagnostics) diagnostics.refresh();
});
