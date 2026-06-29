/* ==========================================================================
   ScrollCollector — Side Panel Controller (Virtualized & Curated)
   Ambient tabbed navigation, inline horizontal filters with drag-to-scroll,
   favorites (<3), popover overrides, master paused status banner,
   ignored keyword settings, keyboard hotkey HUD, and list virtualization.
   ========================================================================== */

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
  'fallback': `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`
};

// ---------- State ----------

let state = {
  configuration: { trackedTags: [], sites: [], ignoredKeywords: [], isTrackingPaused: false, trackingPausedAt: null },
  metrics: { counts: {} },
  stack: [],
  telemetry: {
    totalProcessed: 0,
    classifiedCount: 0,
    unclassifiedCount: 0,
    sessionStart: 0,
    lastProcessed: null
  },
  engineStatus: { tier: 2, name: 'Rule-based Classifier', status: 'ready' }
};

let activeFilterTag = 'All'; // Horizontal category tag filter
let activeFilterSite = 'All'; // Horizontal website filter
let openDropdownItemId = null; // Track currently open override dropdown item ID
let expandedItemIds = new Set(); // Track expanded text snippet row IDs

// Keyboard Navigation State
let focusedItemIndex = -1; // Index in currently filtered stack
let filteredStack = []; // Cache of currently rendered filtered items

// Virtualizer Observer Instance
let virtualizerObserver = null;

// ---------- DOM References ----------

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let dom = {};

// ---------- Initialization ----------

function initTheme() {
  const saved = localStorage.getItem('scrollcollector-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('scrollcollector-theme', next);
}

function initTabs() {
  const savedTab = localStorage.getItem('scrollcollector-active-tab') || 'stream';
  switchTab(savedTab);

  $$('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      switchTab(tab);
    });
  });
}

function switchTab(tabName) {
  $$('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });

  $$('.tab-panel').forEach(panel => {
    const isTarget = panel.id === `panel-${tabName}`;
    panel.classList.toggle('active', isTarget);
  });

  localStorage.setItem('scrollcollector-active-tab', tabName);
}

// ---------- Helpers ----------

function escapeHTML(str) {
  if (!str) return '';
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return str.replace(/[&<>"']/g, (c) => map[c]);
}

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
  const trackedTags = state.configuration?.trackedTags || [];
  const tagCfg = trackedTags.find(t => t.label.toLowerCase() === tag.toLowerCase());
  return tagCfg ? !!tagCfg.isDynamic : true;
}

function handleTagTrackToggle(tag) {
  if (tag === 'All' || tag === 'Favorites' || tag === 'Ads' || tag === 'Unclassified') {
    return;
  }
  const isDynamic = isTagDynamic(tag);
  if (isDynamic) {
    // Dynamic -> Tracked (Solid)
    chrome.runtime.sendMessage({
      type: 'TAG_PROMOTED',
      payload: { tag }
    });
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
    chrome.runtime.sendMessage({
      type: 'TAG_REMOVED',
      payload: { tag }
    });
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
  const engineName = (state.engineStatus && state.engineStatus.name) || '—';

  dom.tabCountStream.textContent = state.stack.length;

  dom.telTotal.textContent = total;
  dom.telRate.textContent = rate + '%';
  dom.telEngine.textContent = engineName;
}

function renderEngineStatus() {
  const es = state.engineStatus || {};
  dom.engineDot.classList.remove('active', 'fallback', 'error');

  if (es.tier === 1 || es.status === 'active') {
    dom.engineDot.classList.add('active');
  } else if (es.tier === 2 || es.status === 'ready') {
    dom.engineDot.classList.add('fallback');
  } else {
    dom.engineDot.classList.add('error');
  }

  dom.engineLabel.textContent = es.name || '—';
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
    if (pausedAt) {
      const timeStr = new Date(pausedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      dom.pauseTime.textContent = timeStr;
    } else {
      dom.pauseTime.textContent = '—';
    }
  } else {
    dom.pauseIcon.classList.remove('hidden');
    dom.playIcon.classList.add('hidden');
    dom.pauseToggle.title = 'Pause tracking';
    
    dom.pauseBanner.classList.add('hidden');
  }
}

// ---------- Drag-to-Scroll pills containers ----------

function initDragToScroll() {
  [dom.filterPills, dom.filterSitePills].forEach(el => {
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

// ---------- Keyboard Curation HUD Engine ----------

function focusCard(index) {
  if (filteredStack.length === 0) {
    focusedItemIndex = -1;
    return;
  }

  if (index < 0) index = 0;
  if (index >= filteredStack.length) index = filteredStack.length - 1;

  focusedItemIndex = index;
  const item = filteredStack[focusedItemIndex];

  dom.streamList.querySelectorAll('.item-row').forEach(row => {
    row.classList.remove('keyboard-focused');
  });

  const targetRow = dom.streamList.querySelector(`.item-row[data-id="${item.id}"]`);
  if (targetRow) {
    targetRow.classList.add('keyboard-focused');
    targetRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function rotateFocusedCardTag(direction) {
  if (focusedItemIndex === -1 || filteredStack.length === 0) return;
  
  const item = filteredStack[focusedItemIndex];
  const tags = state.configuration.trackedTags || [];
  const tagLabels = tags.map(t => typeof t === 'string' ? t : t.label).filter(l => l !== 'Ads').concat(['Unclassified']);
  
  const currentTag = item.assignedTag || 'Unclassified';
  let idx = tagLabels.indexOf(currentTag);
  if (idx === -1) idx = tagLabels.length - 1;

  idx += direction;
  if (idx < 0) idx = tagLabels.length - 1;
  if (idx >= tagLabels.length) idx = 0;

  const newTag = tagLabels[idx];

  chrome.runtime.sendMessage({
    type: 'ITEM_RETAGGED',
    payload: { itemId: item.id, newTag }
  });

  item.assignedTag = newTag;
  renderAll();
  
  focusCard(focusedItemIndex);
}

function scrollActivePillIntoView() {
  const activePill = dom.filterPills.querySelector(`.filter-pill.active`);
  if (activePill) {
    activePill.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }
}

function initKeyboardNavigation() {
  document.addEventListener('keydown', (e) => {
    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable)) {
      return;
    }

    switch (e.key) {
      case 'ArrowRight': {
        e.preventDefault();
        const categories = getFilterCategories();
        const currentIndex = categories.indexOf(activeFilterTag);
        if (currentIndex !== -1) {
          const nextIndex = (currentIndex + 1) % categories.length;
          activeFilterTag = categories[nextIndex];
          
          renderFilterPills();
          renderSiteFilterPills();
          renderFeed();
          scrollActivePillIntoView();
        }
        break;
      }

      case 'ArrowLeft': {
        e.preventDefault();
        const categories = getFilterCategories();
        const currentIndex = categories.indexOf(activeFilterTag);
        if (currentIndex !== -1) {
          const prevIndex = (currentIndex - 1 + categories.length) % categories.length;
          activeFilterTag = categories[prevIndex];
          
          renderFilterPills();
          renderSiteFilterPills();
          renderFeed();
          scrollActivePillIntoView();
        }
        break;
      }

      case 'Tab':
        if (filteredStack.length === 0) return;
        if (!e.shiftKey) {
          e.preventDefault();
          focusCard(focusedItemIndex + 1);
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
          chrome.runtime.sendMessage({
            type: 'FAVORITE_TOGGLED',
            payload: { itemId: item.id, isFavorite }
          });
          item.isFavorite = isFavorite;
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
            if (item.sourceUrl) {
              window.open(item.sourceUrl, '_blank');
            }
          } else {
            e.preventDefault();
            const cardRow = dom.streamList.querySelector(`.item-row[data-id="${item.id}"]`);
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
      dom.streamList.querySelectorAll('.item-row').forEach(row => {
        row.classList.remove('keyboard-focused');
      });
      cardEl.classList.add('keyboard-focused');
    }
  });
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

// ---------- Rendering: Tag Filters ----------

function getFilterCategories() {
  const tags = state.configuration.trackedTags || [];
  const list = state.stack || [];

  const enabledTags = [];
  tags.forEach(t => {
    const label = typeof t === 'string' ? t : t.label;
    const enabled = typeof t === 'string' ? true : t.isEnabled !== false;
    if (enabled && label !== 'Ads') {
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
  const list = state.stack || [];

  const counts = { All: list.length, Favorites: list.filter(i => i.isFavorite).length };
  list.forEach(item => {
    const tag = item.assignedTag || 'Unclassified';
    counts[tag] = (counts[tag] || 0) + 1;
    if (item.isAd) {
      counts['Ads'] = (counts['Ads'] || 0) + 1;
    }
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
  categories.forEach(cat => {
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
      renderFilterPills();
      renderSiteFilterPills();
      renderFeed();
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
}

// ---------- Rendering: Site Filters ----------

function setFilterSite(site) {
  if (activeFilterSite === site) return;
  activeFilterSite = site;

  // If the active tag filter is not 'All' or 'Favorites', check if any items match the activeTag + new site
  if (activeFilterTag !== 'All' && activeFilterTag !== 'Favorites' && activeFilterTag !== 'Ads') {
    const hasItemsForTagOnSite = (state.stack || []).some(item => {
      const tagMatch = item.assignedTag === activeFilterTag;
      if (!tagMatch) return false;
      
      if (activeFilterSite === 'All') return true;
      const rawPlatform = (item.sourcePlatform || '').toLowerCase();
      if (activeFilterSite === 'Other') {
        const defaultSites = ['linkedin.com', 'x.com', 'youtube.com', 'facebook.com', 'instagram.com', 'medium.com'];
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
    const hasAdsOnSite = (state.stack || []).some(item => {
      if (!item.isAd) return false;
      if (activeFilterSite === 'All') return true;
      const rawPlatform = (item.sourcePlatform || '').toLowerCase();
      if (activeFilterSite === 'Other') {
        const defaultSites = ['linkedin.com', 'x.com', 'youtube.com', 'facebook.com', 'instagram.com', 'medium.com'];
        return !defaultSites.some(d => rawPlatform === d || rawPlatform.endsWith('.' + d));
      }
      return rawPlatform === activeFilterSite || rawPlatform.endsWith('.' + activeFilterSite);
    });
    if (!hasAdsOnSite) {
      activeFilterTag = 'All';
    }
  }

  renderFilterPills();
  renderSiteFilterPills();
  renderFeed();
}

function renderSiteFilterPills() {
  const defaultSites = ['linkedin.com', 'x.com', 'youtube.com', 'facebook.com', 'instagram.com', 'medium.com'];
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
  const counts = { All: state.stack ? state.stack.length : 0 };
  let otherCount = 0;

  (state.stack || []).forEach(item => {
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
  (state.stack || []).forEach(item => {
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

  orderedSites.forEach(site => {
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
}

// ---------- Rendering: Feed Cards ----------

function renderFeed() {
  const stack = state.stack || [];
  const list = dom.streamList;
  
  if (virtualizerObserver) {
    virtualizerObserver.disconnect();
  }

  resetClearConfirmation();

  const oldFilteredStack = [...filteredStack];

  // Filter 1: Tag
  filteredStack = stack;
  if (activeFilterTag === 'Favorites') {
    filteredStack = stack.filter(i => i.isFavorite);
  } else if (activeFilterTag === 'Ads') {
    filteredStack = stack.filter(i => i.isAd);
  } else if (activeFilterTag !== 'All') {
    filteredStack = stack.filter(i => i.assignedTag === activeFilterTag);
  }

  // Filter 2: Website
  if (activeFilterSite !== 'All') {
    filteredStack = filteredStack.filter(i => {
      const rawPlatform = (i.sourcePlatform || '').toLowerCase();
      if (activeFilterSite === 'Other') {
        const defaultSites = ['linkedin.com', 'x.com', 'youtube.com', 'facebook.com', 'instagram.com', 'medium.com'];
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

  if (filteredStack.length === 0) {
    list.innerHTML = '';
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

function createItemCardShell(item, index) {
  const card = document.createElement('div');
  card.className = 'item-row is-virtualized';
  card.dataset.id = item.id;
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

function populateCardInner(card, item) {
  const platform = item.sourcePlatform || 'unknown';
  const timeStr = relativeTime(item.timestamp);
  const tag = item.assignedTag || 'Unclassified';
  const tagColor = getTagColor(tag);
  card.style.setProperty('--card-accent', tagColor);

  const trackedTags = state.configuration?.trackedTags || [];
  const tagCfg = trackedTags.find(t => t.label.toLowerCase() === tag.toLowerCase());
  const isTrackedCategory = tagCfg ? !tagCfg.isDynamic : false;

  if (tag !== 'Unclassified' && isTrackedCategory) {
    card.classList.add('news-glow');
  } else {
    card.classList.remove('news-glow');
  }

  const { title, body } = parseCardText(item.textSnippet);
  const entities = extractLocalEntities(item.textSnippet, tag);
  const isCollapsed = !expandedItemIds.has(item.id);

  // Native Favicon integration
  const faviconUrl = `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(item.sourceUrl || 'https://' + platform)}&size=32`;
  const faviconHtml = `<img src="${faviconUrl}" class="card-favicon" onerror="this.style.display='none';" />`;

  let linkHtml = '';
  if (item.sourceUrl) {
    const domain = escapeHTML(extractDomain(item.sourceUrl));
    linkHtml = `<a href="#" class="card-site-link" data-url="${escapeHTML(item.sourceUrl)}" title="${escapeHTML(item.sourceUrl)}">${domain} ↗</a>`;
  }

  const favClass = item.isFavorite ? 'favorited' : '';
  const favIcon = item.isFavorite
    ? `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`
    : `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;

  const adBadge = item.isAd ? `<span class="ad-badge">Ad</span>` : '';

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
    const secondaryTags = item.tags.slice(1, 3); // Up to 2 secondary tags
    secondaryTagsHtml = secondaryTags.map(t => {
      const sTag = t.name;
      const sTagColor = getTagColor(sTag);
      return `
        <span class="card-category-label secondary ${isTagDynamic(sTag) ? 'is-dynamic' : ''}" style="--tag-color: ${sTagColor}" title="Confidence: ${Math.round(t.score * 100)}%">
          <span>${escapeHTML(sTag)}</span>
        </span>
      `;
    }).join('');
  }

  // Rebuild inside Shell
  card.innerHTML = `
    <div class="card-header">
      <span class="platform-logo">${faviconHtml}</span>
      <span class="platform-name">${escapeHTML(platform)}</span>
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
    
    <div class="card-summary">${escapeHTML(title)}</div>
    ${bodyHtml}
    ${entityChips}
    
    <div class="card-footer">
      <div class="tags-container">
        <span class="card-category-label ${isTagDynamic(tag) ? 'is-dynamic' : ''}" style="--tag-color: ${tagColor}">
          <span class="cat-dot"></span>
          <span>${escapeHTML(tag)}</span>
        </span>
        ${secondaryTagsHtml}
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

  // Bind Event Listeners
  const catLabel = card.querySelector('.card-category-label');
  if (catLabel) {
    catLabel.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      handleTagTrackToggle(tag);
    });
  }

  const link = card.querySelector('.card-site-link');
  if (link) {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      window.open(link.dataset.url, '_blank');
    });
  }

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
    chrome.runtime.sendMessage({
      type: 'FAVORITE_TOGGLED',
      payload: { itemId: item.id, isFavorite }
    });
    item.isFavorite = isFavorite;
    renderFilterPills();
    renderFeed();
  });

  card.querySelector('.btn-card-delete').addEventListener('click', (e) => {
    e.stopPropagation();
    if (virtualizerObserver) {
      virtualizerObserver.unobserve(card);
    }
    chrome.runtime.sendMessage({
      type: 'ITEM_DELETED',
      payload: { itemId: item.id }
    });
    state.stack = state.stack.filter(i => i.id !== item.id);
    renderAll();
  });

  const triggerBtn = card.querySelector('.btn-override-trigger');
  const popover = card.querySelector('.override-popover');
  triggerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    
    if (openDropdownItemId && openDropdownItemId !== item.id) {
      const activeCard = dom.streamList.querySelector(`.item-row[data-id="${openDropdownItemId}"]`);
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

      chrome.runtime.sendMessage({
        type: 'ITEM_RETAGGED',
        payload: { itemId: item.id, newTag }
      });

      item.assignedTag = newTag;
      renderAll();
    });
  });
}

// ---------- Configurator Rendering ----------

function renderTagConfigurator() {
  const tags = state.configuration.trackedTags || [];
  const list = dom.tagList;
  list.innerHTML = '';

  tags.forEach((tag, i) => {
    const label = typeof tag === 'string' ? tag : tag.label;
    const enabled = typeof tag === 'string' ? true : tag.isEnabled !== false;
    const isDynamic = typeof tag === 'object' && tag.isDynamic;
    const isSticky = typeof tag === 'object' && tag.isSticky;
    const color = BADGE_COLORS[i % BADGE_COLORS.length];

    const row = document.createElement('div');
    row.className = isDynamic ? 'tag-row dynamic' : 'tag-row';

    const promoteHtml = isDynamic
      ? `<button class="btn-tag-action btn-promote-tag" data-tag="${escapeHTML(label)}" title="Promote to tracking tag">★</button>`
      : '';

    const stickyHtml = isDynamic
      ? `<button class="btn-tag-action btn-sticky-tag ${isSticky ? 'sticky' : ''}" data-tag="${escapeHTML(label)}" title="${isSticky ? 'Make tag temporary' : 'Make tag sticky'}">${isSticky ? '📌' : '📍'}</button>`
      : '';

    row.innerHTML = `
      <span class="tag-dot-indicator" style="background: ${color}"></span>
      <span class="tag-label">${escapeHTML(label)} ${isDynamic ? '<span style="font-size: 9px; opacity: 0.5; font-style: italic;">(dynamic)</span>' : ''}</span>
      <label class="tag-toggle">
        <input type="checkbox" ${enabled ? 'checked' : ''} data-tag="${escapeHTML(label)}">
        <span class="toggle-track"></span>
      </label>
      ${stickyHtml}
      ${promoteHtml}
      <button class="btn-tag-action btn-delete-tag" data-tag="${escapeHTML(label)}" title="Remove tag">×</button>
    `;

    const checkbox = row.querySelector('input[type="checkbox"]');
    checkbox.addEventListener('change', () => {
      chrome.runtime.sendMessage({
        type: 'TAG_TOGGLED',
        payload: { tag: label, enabled: checkbox.checked }
      });
    });

    if (isDynamic) {
      row.querySelector('.btn-sticky-tag').addEventListener('click', () => {
        chrome.runtime.sendMessage({
          type: 'TAG_STICKY_TOGGLED',
          payload: { tag: label, isSticky: !isSticky }
        });
      });
    }

    if (isDynamic) {
      row.querySelector('.btn-promote-tag').addEventListener('click', () => {
        chrome.runtime.sendMessage({
          type: 'TAG_PROMOTED',
          payload: { tag: label }
        });
      });
    }

    row.querySelector('.btn-delete-tag').addEventListener('click', () => {
      chrome.runtime.sendMessage({
        type: 'TAG_REMOVED',
        payload: { tag: label }
      });
    });

    list.appendChild(row);
  });
}

function renderSitesConfigurator() {
  const sites = state.configuration.sites || [];
  const list = dom.sitesList;
  list.innerHTML = '';

  sites.forEach(site => {
    const row = document.createElement('div');
    row.className = site.isCustom ? 'tag-row custom-site' : 'tag-row';

    const deleteBtnHtml = site.isCustom
      ? `<button class="btn-tag-action btn-delete-tag btn-delete-site" data-id="${site.id}" title="Remove site">×</button>`
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
        <input type="checkbox" ${site.isEnabled ? 'checked' : ''} data-id="${site.id}">
        <span class="toggle-track"></span>
      </label>
      ${deleteBtnHtml}
    `;

    const checkbox = row.querySelector('input[type="checkbox"]');
    checkbox.addEventListener('change', () => {
      chrome.runtime.sendMessage({
        type: 'SITE_TOGGLED',
        payload: { siteId: site.id, enabled: checkbox.checked }
      });
    });

    if (site.isCustom) {
      row.querySelector('.btn-delete-site').addEventListener('click', () => {
        chrome.runtime.sendMessage({
          type: 'SITE_REMOVED',
          payload: { siteId: site.id }
        });
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
      chrome.runtime.sendMessage({
        type: 'KEYWORD_REMOVED',
        payload: { keyword: kw }
      });
    });

    list.appendChild(row);
  });
}

function renderAll() {
  renderTelemetry();
  renderEngineStatus();
  renderProcessingStatus();
  renderPauseStatus();
  renderFilterPills();
  renderSiteFilterPills();
  renderFeed();
  renderTagConfigurator();
  renderSitesConfigurator();
  renderIgnoredKeywords();
}

// ---------- HTML Feed Diary Export Builder ----------

function triggerHtmlExport() {
  const stack = state.stack || [];
  if (stack.length === 0) {
    alert('No items collected to export. Start scrolling feeds first!');
    return;
  }

  const itemsHtml = stack.map(item => {
    const { title, body } = parseCardText(item.textSnippet);
    const tag = item.assignedTag || 'Unclassified';
    const tagColor = getTagColor(tag);
    const platform = item.sourcePlatform || 'unknown';
    const timestampStr = new Date(item.timestamp).toLocaleString();
    const linkStr = item.sourceUrl 
      ? `<a href="${escapeHTML(item.sourceUrl)}" target="_blank" class="card-link">${escapeHTML(extractDomain(item.sourceUrl))} ↗</a>` 
      : '';
    const adBadge = item.isAd ? `<span class="ad-badge">Ad</span>` : '';
    const bodyStr = body ? `<div class="card-body">${escapeHTML(body)}</div>` : '';
    const favIndicator = item.isFavorite ? '<span class="fav-indicator">❤️ Favorite</span>' : '';

    return `
      <div class="card" data-category="${escapeHTML(tag)}" data-favorite="${item.isFavorite}" data-ad="${item.isAd}">
        <div class="card-header">
          <span class="platform">${escapeHTML(platform)}</span>
          ${linkStr}
          <span class="time">${timestampStr}</span>
          ${adBadge}
          ${favIndicator}
        </div>
        <div class="card-title">${escapeHTML(title)}</div>
        ${bodyStr}
        <div class="card-footer">
          <span class="card-category" style="--tag-color: ${tagColor}">
            <span class="cat-dot"></span>${escapeHTML(tag)}
          </span>
        </div>
      </div>
    `;
  }).join('\n');

  const htmlTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ScrollCollector — Personal Feed Diary</title>
  <style>
    :root {
      --bg: #09090b;
      --bg-elevated: #131316;
      --bg-hover: #1e1e22;
      --text-primary: #f4f4f5;
      --text-secondary: #a1a1aa;
      --text-muted: #52525b;
      --border: #202024;
      --accent: #6366f1;
      --accent-hover: #4f46e5;
    }

    body.light-theme {
      --bg: #fafafa;
      --bg-elevated: #ffffff;
      --bg-hover: #f4f4f5;
      --text-primary: #09090b;
      --text-secondary: #71717a;
      --text-muted: #a1a1aa;
      --border: #e4e4e7;
      --accent: #4f46e5;
      --accent-hover: #3730a3;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text-primary);
      padding: 40px 24px;
      line-height: 1.5;
      transition: background 0.3s ease, color 0.3s ease;
    }

    .container {
      max-width: 800px;
      margin: 0 auto;
    }

    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 30px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 20px;
    }

    h1 {
      font-size: 24px;
      font-weight: 700;
      letter-spacing: -0.02em;
    }

    .theme-toggle {
      background: var(--bg-elevated);
      color: var(--text-secondary);
      border: 1px solid var(--border);
      padding: 6px 12px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      transition: all 0.2s;
    }
    .theme-toggle:hover {
      background: var(--bg-hover);
      color: var(--text-primary);
    }

    /* Controls */
    .controls {
      display: flex;
      flex-direction: column;
      gap: 16px;
      margin-bottom: 24px;
    }

    .search-input {
      width: 100%;
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      color: var(--text-primary);
      padding: 10px 16px;
      border-radius: 8px;
      font-size: 14px;
      outline: none;
      transition: border-color 0.2s;
    }
    .search-input:focus {
      border-color: var(--accent);
    }

    .filters {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .filter-btn {
      background: var(--bg-elevated);
      color: var(--text-secondary);
      border: 1px solid var(--border);
      padding: 6px 12px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s;
    }
    .filter-btn:hover {
      background: var(--bg-hover);
      color: var(--text-primary);
    }
    .filter-btn.active {
      background: var(--accent);
      color: #ffffff;
      border-color: var(--accent);
    }

    /* Cards Grid */
    .cards-list {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .card {
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 20px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
      transition: transform 0.2s, border-color 0.2s;
    }
    .card:hover {
      transform: translateY(-2px);
      border-color: var(--text-muted);
    }

    .card-header {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 11px;
      color: var(--text-secondary);
      margin-bottom: 12px;
    }

    .platform {
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .card-link {
      color: var(--accent);
      text-decoration: none;
    }
    .card-link:hover { text-decoration: underline; }

    .time {
      color: var(--text-muted);
      margin-left: auto;
    }

    .fav-indicator {
      background: rgba(236, 72, 153, 0.12);
      color: #ec4899;
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: 600;
    }

    .ad-badge {
      background: rgba(239, 68, 68, 0.15);
      color: #ef4444;
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: 700;
    }

    .card-title {
      font-size: 16px;
      font-weight: 700;
      line-height: 1.4;
      margin-bottom: 8px;
      word-break: break-all;
      overflow-wrap: break-word;
      word-wrap: break-word;
    }

    .card-body {
      font-size: 13px;
      color: var(--text-secondary);
      line-height: 1.6;
      margin-bottom: 12px;
      white-space: pre-wrap;
      word-break: break-all;
      overflow-wrap: break-word;
      word-wrap: break-word;
    }

    .card-footer {
      display: flex;
      align-items: center;
      border-top: 1px solid var(--border);
      padding-top: 12px;
    }

    .card-category {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 600;
    }

    .cat-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--tag-color, var(--text-muted));
    }

    .no-results {
      text-align: center;
      padding: 40px;
      color: var(--text-muted);
      font-style: italic;
      display: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>ScrollCollector Diary</h1>
      <button class="theme-toggle" id="theme-btn">Light Theme</button>
    </header>

    <div class="controls">
      <input type="text" id="search" class="search-input" placeholder="Search insights by keywords, domains, or body text...">
      <div class="filters" id="filters-container">
        <button class="filter-btn active" data-filter="all">All</button>
        <button class="filter-btn" data-filter="favorites">❤️ Favorites</button>
        <button class="filter-btn" data-filter="ads">Ads</button>
      </div>
    </div>

    <div class="cards-list" id="cards-wrapper">
      ${itemsHtml}
      <div class="no-results" id="no-results-msg">No matching insights found.</div>
    </div>
  </div>

  <script>
    const searchInput = document.getElementById('search');
    const cards = Array.from(document.querySelectorAll('.card'));
    const filtersContainer = document.getElementById('filters-container');
    const noResults = document.getElementById('no-results-msg');
    
    // Theme Toggle
    const themeBtn = document.getElementById('theme-btn');
    themeBtn.addEventListener('click', () => {
      const isLight = document.body.classList.toggle('light-theme');
      themeBtn.textContent = isLight ? 'Dark Theme' : 'Light Theme';
    });

    // Populate Dynamic Filters
    const categories = new Set();
    cards.forEach(card => {
      const cat = card.dataset.category;
      if (cat && cat !== 'Ads' && cat !== 'Unclassified') {
        categories.add(cat);
      }
    });
    
    categories.forEach(cat => {
      const btn = document.createElement('button');
      btn.className = 'filter-btn';
      btn.dataset.filter = cat.toLowerCase();
      btn.textContent = cat;
      filtersContainer.appendChild(btn);
    });

    const allFilters = Array.from(document.querySelectorAll('.filter-btn'));
    let activeFilter = 'all';

    allFilters.forEach(btn => {
      btn.addEventListener('click', () => {
        allFilters.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeFilter = btn.dataset.filter;
        filterAndSearch();
      });
    });

    searchInput.addEventListener('input', filterAndSearch);

    function filterAndSearch() {
      const query = searchInput.value.toLowerCase().trim();
      let matchCount = 0;

      cards.forEach(card => {
        const text = card.textContent.toLowerCase();
        const category = card.dataset.category.toLowerCase();
        const isFavorite = card.dataset.favorite === 'true';
        const isAd = card.dataset.ad === 'true';

        let matchesFilter = false;
        if (activeFilter === 'all') {
          matchesFilter = true;
        } else if (activeFilter === 'favorites') {
          matchesFilter = isFavorite;
        } else if (activeFilter === 'ads') {
          matchesFilter = isAd;
        } else {
          matchesFilter = category === activeFilter;
        }

        const matchesQuery = !query || text.includes(query);

        if (matchesFilter && matchesQuery) {
          card.style.display = 'block';
          matchCount++;
        } else {
          card.style.display = 'none';
        }
      });

      noResults.style.display = matchCount === 0 ? 'block' : 'none';
    }
  </script>
</body>
</html>`;

  const blob = new Blob([htmlTemplate], { type: 'text/html;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `scrollcollector_diary_${Date.now()}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------- Standard Data Downloaders ----------

function triggerJsonExport() {
  const stack = state.stack || [];
  if (stack.length === 0) {
    alert('No items collected to export.');
    return;
  }

  const jsonString = JSON.stringify(stack, null, 2);
  const blob = new Blob([jsonString], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `scrollcollector_export_${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function triggerCsvExport() {
  const stack = state.stack || [];
  if (stack.length === 0) {
    alert('No items collected to export.');
    return;
  }

  const headers = ['ID', 'Timestamp', 'Platform', 'Source URL', 'Category', 'Is Ad', 'Is Favorite', 'Favorited At', 'Text Snippet'];
  
  const rows = stack.map(item => [
    item.id,
    new Date(item.timestamp).toISOString(),
    item.sourcePlatform || 'unknown',
    item.sourceUrl || '',
    item.assignedTag || 'Unclassified',
    item.isAd ? 'TRUE' : 'FALSE',
    item.isFavorite ? 'TRUE' : 'FALSE',
    item.favoritedAt ? new Date(item.favoritedAt).toISOString() : '',
    `"${(item.textSnippet || '').replace(/"/g, '""')}"`
  ]);

  const csvContent = [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `scrollcollector_export_${Date.now()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
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
    const defaultSites = ['linkedin.com', 'x.com', 'twitter.com', 'youtube.com', 'facebook.com', 'instagram.com', 'medium.com'];
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
  chrome.runtime.onMessage.addListener((message) => {
    if (!message || !message.type) return;

    switch (message.type) {
      case 'STATE_UPDATED':
        state = { ...state, ...message.payload };
        renderAll();
        break;

      case 'ENGINE_STATUS':
        state.engineStatus = message.payload;
        renderEngineStatus();
        renderTelemetry();
        break;
    }
  });
}

// ---------- DOMContentLoaded Bootstrap ----------

document.addEventListener('DOMContentLoaded', () => {
  dom = {
    telTotal: $('#tel-total'),
    telRate: $('#tel-rate'),
    telEngine: $('#tel-engine'),
    engineDot: $('#engine-dot'),
    engineLabel: $('#engine-label'),
    processingIndicator: $('#processing-indicator'),
    processingCount: $('#processing-count'),
    streamList: $('#stream-list'),
    streamEmpty: $('#stream-empty'),
    filterPills: $('#filter-pills'),
    filterSitePills: $('#filter-site-pills'), // Site filter scroller
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

    clearStackBtn: $('#clear-stack-btn'),
    clearConfirmContainer: $('#clear-confirm-container'),
    btnConfirmClearTag: $('#btn-confirm-clear-tag'),
    btnConfirmClearAll: $('#btn-confirm-clear-all'),
    btnClearCancel: $('#btn-clear-cancel'),
    themeToggle: $('#theme-toggle'),
  };

  // Init Theme
  initTheme();
  dom.themeToggle.addEventListener('click', toggleTheme);

  // Init segmented tab panels switching
  initTabs();

  // Drag to scroll pills
  initDragToScroll();

  // Initialize virtualization observer
  initVirtualizer();

  // Keyboard navigation shortcuts
  initKeyboardNavigation();

  // Add tag form handler
  dom.addTagForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = dom.newTagInput.value.trim();
    if (!value) return;
    chrome.runtime.sendMessage({
      type: 'TAG_ADDED',
      payload: { tag: value }
    });
    dom.newTagInput.value = '';
  });

  // Add site form handler
  dom.addSiteForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = dom.newSiteInput.value.trim();
    if (!value) return;
    if (!value.includes('.')) {
      alert('Please enter a valid domain name (e.g. reddit.com)');
      return;
    }
    chrome.runtime.sendMessage({
      type: 'SITE_ADDED',
      payload: { domain: value }
    });
    dom.newSiteInput.value = '';
  });

  // Add keyword form handler
  dom.addKeywordForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = dom.newKeywordInput.value.trim();
    if (!value) return;
    chrome.runtime.sendMessage({
      type: 'KEYWORD_ADDED',
      payload: { keyword: value }
    });
    dom.newKeywordInput.value = '';
  });

  // Pause button clicker
  dom.pauseToggle.addEventListener('click', () => {
    const nextPausedState = !state.configuration.isTrackingPaused;
    
    state.configuration.isTrackingPaused = nextPausedState;
    state.configuration.trackingPausedAt = nextPausedState ? Date.now() : null;
    renderPauseStatus();

    chrome.runtime.sendMessage({
      type: 'IS_TRACKING_PAUSED_TOGGLED',
      payload: { isPaused: nextPausedState }
    });
  });

  // Export action triggers
  dom.btnExportHtml.addEventListener('click', triggerHtmlExport);
  dom.btnExportJson.addEventListener('click', triggerJsonExport);
  dom.btnExportCsv.addEventListener('click', triggerCsvExport);

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
    chrome.runtime.sendMessage({
      type: 'CLEAR_STACK',
      payload: { tag: activeFilterTag }
    });
    resetClearConfirmation();
  });

  dom.btnConfirmClearAll.addEventListener('click', () => {
    chrome.runtime.sendMessage({
      type: 'CLEAR_STACK',
      payload: { tag: 'All' }
    });
    resetClearConfirmation();
  });

  // Global click event to dismiss custom popover overrides dropdown
  document.addEventListener('click', () => {
    if (openDropdownItemId) {
      const activeCard = dom.streamList.querySelector(`.item-row[data-id="${openDropdownItemId}"]`);
      if (activeCard) {
        activeCard.querySelector('.override-popover').classList.remove('show');
        activeCard.querySelector('.btn-override-trigger').classList.remove('dropdown-active');
      }
      openDropdownItemId = null;
    }
  });

  // Message listeners
  initMessageListener();

  // Tab change listeners
  initTabChangeListener();

  // Request initial state payload
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
    if (response) {
      state = { ...state, ...response };
      try {
        renderAll();
      } catch (e) {
        document.body.innerHTML = `<div style="color:red; padding:20px; font-family: monospace; white-space: pre-wrap;">${e.stack}</div>`;
      }
    }
  });

  chrome.runtime.sendMessage({ type: 'GET_ENGINE_STATUS' }, (response) => {
    if (response) {
      state.engineStatus = response;
      renderEngineStatus();
      renderTelemetry();
    }
  });
});
