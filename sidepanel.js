/* ==========================================================================
   ScrollCollector — Side Panel Controller
   Flat, monochromic, separator-based design
   ========================================================================== */

// ---------- Constants ----------

const BADGE_COLORS = [
  '#6366f1', '#a855f7', '#06b6d4', '#10b981', '#f59e0b',
  '#f43f5e', '#0ea5e9', '#84cc16', '#f97316', '#ec4899'
];
const FALLBACK_COLOR = '#71717a';
const MAX_STACK_DISPLAY = 15;

const LANG_FLAGS = {
  'EN': '🇬🇧', 'US': '🇺🇸', 'ES': '🇪🇸', 'FR': '🇫🇷', 'DE': '🇩🇪',
  'IT': '🇮🇹', 'JA': '🇯🇵', 'ZH': '🇨🇳', 'RU': '🇷🇺', 'PT': '🇵🇹',
  'KO': '🇰🇷', 'AR': '🇸🇦', 'HI': '🇮🇳', 'TR': '🇹🇷', 'NL': '🇳🇱',
  'PL': '🇵🇱', 'VI': '🇻🇳', 'ID': '🇮🇩', 'SV': '🇸🇪', 'FI': '🇫🇮',
  'DA': '🇩🇰', 'NO': '🇳🇴'
};

function getLanguageSymbol(lang) {
  const code = (lang || '').toUpperCase();
  return LANG_FLAGS[code] || '🌐';
}

// ---------- State ----------

let state = {
  configuration: { trackedTags: [] },
  metrics: { counts: {} },
  stack: [],
  telemetry: {
    totalProcessed: 0,
    classifiedCount: 0,
    unclassifiedCount: 0,
    sessionStart: 0,
    lastProcessed: null
  },
  engineStatus: { tier: 2, name: 'Keyword Fallback', status: 'ready' }
};
let prevCounts = {};
let renderedItemIds = new Set();
let activeCategory = null; // Currently viewing category (null = main view)

// ---------- DOM References ----------

const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// Cached after DOMContentLoaded
let dom = {};

// ---------- Theme ----------

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

// ---------- Utilities ----------

/** Escape HTML to prevent XSS */
function escapeHTML(str) {
  if (!str) return '';
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return str.replace(/[&<>"']/g, (c) => map[c]);
}

/** Truncate text with ellipsis */
function truncate(text, max) {
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/** Relative time — compact format: "2m", "1h", "3d" */
function relativeTime(ts) {
  if (!ts) return '';
  const diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diff < 60)   return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d`;
  return `${Math.floor(diff / 2592000)}mo`;
}

/** Get color for a tag based on its position in trackedTags */
function getTagColor(tag) {
  if (tag === 'Ads') return '#ef4444';
  const tags = state.configuration.trackedTags || [];
  const idx = tags.findIndex(
    (t) => (typeof t === 'string' ? t : t.label) === tag
  );
  if (idx === -1) return FALLBACK_COLOR;
  return BADGE_COLORS[idx % BADGE_COLORS.length];
}

/** Extract domain from URL */
function extractDomain(url) {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return url;
  }
}

// ---------- Rendering: Telemetry ----------

function renderTelemetry() {
  const tel = state.telemetry || {};
  const total = tel.totalProcessed || 0;
  const classified = tel.classifiedCount || 0;
  const rate = total > 0 ? Math.round((classified / total) * 100) : 0;
  const engineName = (state.engineStatus && state.engineStatus.name) || '—';

  dom.telTotal.textContent = total;
  dom.telRate.textContent = rate + '%';
  dom.telEngine.textContent = engineName;
}

// ---------- Rendering: Engine Status ----------

function renderEngineStatus() {
  const es = state.engineStatus || {};
  const dot = dom.engineDot;
  const label = dom.engineLabel;

  // Reset classes
  dot.classList.remove('active', 'fallback', 'error');

  if (es.tier === 1 || es.status === 'active') {
    dot.classList.add('active');
  } else if (es.tier === 2 || es.status === 'ready') {
    dot.classList.add('fallback');
  } else {
    dot.classList.add('error');
  }

  label.textContent = es.name || '—';
}

// ---------- Rendering: Counter Grid ----------

function renderCounterGrid() {
  const counts = state.metrics.counts || {};
  const tags = state.configuration.trackedTags || [];
  const grid = dom.counterGrid;

  // Build ordered list of tag labels + Unclassified
  const tagLabels = tags.map((t) => (typeof t === 'string' ? t : t.label));
  tagLabels.push('Unclassified');

  // Only rebuild if tags changed (otherwise just update values)
  const currentKeys = tagLabels.join(',');
  if (grid.dataset.keys !== currentKeys) {
    grid.innerHTML = '';
    grid.dataset.keys = currentKeys;

    tagLabels.forEach((label, i) => {
      const tagObj = tags.find(t => (typeof t === 'string' ? t : t.label) === label);
      const isDynamic = tagObj && tagObj.isDynamic;

      const item = document.createElement('div');
      item.className = isDynamic ? 'counter-item dynamic' : 'counter-item';
      if (label === 'Ads') {
        item.style.borderLeftColor = '#ef4444';
      } else if (label === 'Unclassified') {
        item.style.borderLeftColor = FALLBACK_COLOR;
      } else {
        item.style.borderLeftColor = BADGE_COLORS[i % BADGE_COLORS.length];
      }
      item.dataset.tag = label;

      item.innerHTML = `
        <div class="counter-label">${escapeHTML(label)}</div>
        <div class="counter-value" id="count-${i}">0</div>
      `;

      item.addEventListener('click', () => showCategoryView(label));
      grid.appendChild(item);
    });
  }

  // Update counts
  tagLabels.forEach((label, i) => {
    const valEl = grid.querySelector(`#count-${i}`);
    if (!valEl) return;
    const newCount = counts[label] || 0;
    const oldCount = prevCounts[label] || 0;

    valEl.textContent = newCount;

    // Pop animation on increase
    if (newCount > oldCount) {
      valEl.classList.remove('pop');
      // Force reflow for re-triggering animation
      void valEl.offsetWidth;
      valEl.classList.add('pop');
    }
  });

  prevCounts = { ...counts };
}

// ---------- Rendering: Stack (Recent Items) ----------

function renderStack() {
  const stack = state.stack || [];
  const list = dom.stackList;
  const nonPinned = stack.filter((item) => !item.isPinned).slice(0, MAX_STACK_DISPLAY);

  // Track which IDs are new for enter animation
  const newIds = new Set();
  nonPinned.forEach((item) => {
    if (!renderedItemIds.has(item.id)) {
      newIds.add(item.id);
    }
  });

  list.innerHTML = '';
  nonPinned.forEach((item) => {
    const row = createItemRow(item, true);
    if (newIds.has(item.id)) {
      row.classList.add('entering');
    }
    list.appendChild(row);
  });

  // Update rendered set
  renderedItemIds = new Set(nonPinned.map((i) => i.id));
}

// ---------- Rendering: Pinned Section ----------

function renderPinnedSection() {
  const stack = state.stack || [];
  const pinned = stack.filter((item) => item.isPinned);

  dom.pinnedCount.textContent = pinned.length;
  dom.pinnedList.innerHTML = '';

  if (pinned.length === 0) {
    dom.pinnedEmpty.classList.remove('hidden');
    dom.pinnedList.classList.add('hidden');
  } else {
    dom.pinnedEmpty.classList.add('hidden');
    dom.pinnedList.classList.remove('hidden');
    pinned.forEach((item) => {
      dom.pinnedList.appendChild(createItemRow(item, true));
    });
  }
}

// ---------- Rendering: Tag Configurator ----------

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
      ? `<button class="btn-promote-tag" data-tag="${escapeHTML(label)}" title="Promote to custom tag">★</button>`
      : '';

    const stickyHtml = isDynamic
      ? `<button class="btn-sticky-tag ${isSticky ? 'sticky' : ''}" data-tag="${escapeHTML(label)}" title="${isSticky ? 'Make tag temporary' : 'Make tag sticky'}">${isSticky ? '📌' : '📍'}</button>`
      : '';

    row.innerHTML = `
      <span class="tag-dot-indicator" style="background: ${color}"></span>
      <span class="tag-label">${escapeHTML(label)} ${isDynamic ? '<span style="font-size: 9px; opacity: 0.6; font-style: italic;">(dynamic)</span>' : ''}</span>
      <label class="tag-toggle">
        <input type="checkbox" ${enabled ? 'checked' : ''} data-tag="${escapeHTML(label)}">
        <span class="toggle-track"></span>
      </label>
      ${stickyHtml}
      ${promoteHtml}
      <button class="btn-delete-tag" data-tag="${escapeHTML(label)}" title="Remove tag">×</button>
    `;

    // Toggle handler
    const checkbox = row.querySelector('input[type="checkbox"]');
    checkbox.addEventListener('change', () => {
      chrome.runtime.sendMessage({
        type: 'TAG_TOGGLED',
        payload: { tag: label, enabled: checkbox.checked }
      });
    });

    // Sticky handler
    if (isDynamic) {
      const stickyBtn = row.querySelector('.btn-sticky-tag');
      stickyBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({
          type: 'TAG_STICKY_TOGGLED',
          payload: { tag: label, isSticky: !isSticky }
        });
      });
    }

    // Promote handler
    if (isDynamic) {
      const promoteBtn = row.querySelector('.btn-promote-tag');
      promoteBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({
          type: 'TAG_PROMOTED',
          payload: { tag: label }
        });
      });
    }

    // Delete handler
    const deleteBtn = row.querySelector('.btn-delete-tag');
    deleteBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({
        type: 'TAG_REMOVED',
        payload: { tag: label }
      });
    });

    list.appendChild(row);
  });
}

// ---------- Category View ----------

function showCategoryView(category) {
  activeCategory = category;
  dom.mainContent.classList.add('hidden');
  dom.categoryView.classList.remove('hidden');

  dom.categoryViewTitle.textContent = category;
  const count = (state.metrics.counts || {})[category] || 0;
  dom.categoryViewCount.textContent = count + ' items';

  // Filter all items matching this category (optimistic rendering)
  const items = (state.stack || []).filter(
    (item) => item.assignedTag === category
  );

  dom.categoryItems.innerHTML = '';
  items.forEach((item) => {
    dom.categoryItems.appendChild(createItemRow(item, true));
  });

  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No items in this category';
    dom.categoryItems.appendChild(empty);
  }

  // Fetch full/latest list from background
  chrome.runtime.sendMessage({
    type: 'GET_CATEGORY_ITEMS',
    payload: { category }
  }, (response) => {
    if (response && response.items && activeCategory === category) {
      const dbItems = response.items;
      dom.categoryItems.innerHTML = '';
      dom.categoryViewCount.textContent = dbItems.length + ' items';
      dbItems.forEach((item) => {
        dom.categoryItems.appendChild(createItemRow(item, true));
      });
      if (dbItems.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = 'No items in this category';
        dom.categoryItems.appendChild(empty);
      }
    }
  });
}

function hideCategoryView() {
  activeCategory = null;
  dom.categoryView.classList.add('hidden');
  dom.mainContent.classList.remove('hidden');
}

// ---------- Item Row Factory ----------

function createItemRow(item, showPin = true) {
  const div = document.createElement('div');
  div.className = 'item-row';

  const platform = item.sourcePlatform || 'unknown';
  const time = relativeTime(item.timestamp);
  const snippet = escapeHTML(truncate(item.textSnippet || '', 140));
  const tag = item.assignedTag || 'Unclassified';
  const tagColor = getTagColor(tag);
  const pinClass = item.isPinned ? 'pinned' : '';
  const pinIcon = item.isPinned ? '◆' : '◇';

  // Link markup
  let linkHtml = '';
  if (item.sourceUrl) {
    const domain = escapeHTML(extractDomain(item.sourceUrl));
    linkHtml = `<a href="#" class="item-link" data-url="${escapeHTML(item.sourceUrl)}" title="${escapeHTML(item.sourceUrl)}">${domain} ↗</a>`;
  }

  // Pin button
  const pinHtml = showPin
    ? `<button class="btn-pin ${pinClass}" data-id="${item.id}" title="${item.isPinned ? 'Unpin' : 'Pin'}">${pinIcon}</button>`
    : '';

  // Ad chip markup
  const adChipHtml = item.isAd ? `<span class="ad-chip">Ad</span>` : '';

  // Language badge markup
  const flag = getLanguageSymbol(item.language);
  const langHtml = item.language && item.language !== 'UN'
    ? `<span class="lang-badge" title="Language: ${item.language}">${flag} ${escapeHTML(item.language)}</span>`
    : '';

  // Dropdown options for retagging
  const tagsList = state.configuration.trackedTags || [];
  const tagOptions = tagsList
    .map(t => typeof t === 'string' ? t : t.label)
    .filter(label => label !== 'Ads') // Don't retag main category to Ads
    .concat(['Unclassified'])
    .map(label => `<option value="${escapeHTML(label)}" ${label === tag ? 'selected' : ''}>${escapeHTML(label)}</option>`)
    .join('');

  const selectHtml = `
    <div class="retag-container">
      <select class="select-retag" data-id="${item.id}" title="Reclassify this item">
        ${tagOptions}
      </select>
    </div>
  `;

  div.innerHTML = `
    <div class="item-meta">
      <span class="item-platform">${escapeHTML(platform)}</span>
      ${adChipHtml}
      ${langHtml}
      <span class="meta-sep">·</span>
      <span class="item-time">${time}</span>
      ${linkHtml}
      ${pinHtml}
    </div>
    <div class="item-text">${snippet}</div>
    <div class="item-footer">
      <span class="item-tag" style="--tag-color: ${tagColor}"><span class="tag-dot"></span>${escapeHTML(tag)}</span>
      ${selectHtml}
    </div>
  `;

  // Link click handler
  const link = div.querySelector('.item-link');
  if (link) {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      window.open(link.dataset.url, '_blank');
    });
  }

  // Retag selector handler
  const select = div.querySelector('.select-retag');
  if (select) {
    select.addEventListener('change', (e) => {
      const newTag = e.target.value;
      chrome.runtime.sendMessage({
        type: 'ITEM_RETAGGED',
        payload: { itemId: item.id, newTag }
      });
      // Optimistic update
      item.assignedTag = newTag;
      renderAll();
    });
  }

  // Pin handler
  if (showPin) {
    const pinBtn = div.querySelector('.btn-pin');
    if (pinBtn) {
      pinBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({
          type: 'PIN_TOGGLED',
          payload: { itemId: item.id, isPinned: !item.isPinned }
        });
        // Optimistic update
        item.isPinned = !item.isPinned;
        renderStack();
        renderPinnedSection();
      });
    }
  }

  return div;
}

// ---------- Collapsible Sections ----------

function initCollapsibles() {
  // Pinned section — open by default
  const pinnedToggle = dom.pinnedToggle;
  const pinnedContent = dom.pinnedContent;
  const pinnedChevron = pinnedToggle.querySelector('.chevron');
  pinnedChevron.classList.add('rotated'); // starts open

  pinnedToggle.addEventListener('click', () => {
    const isCollapsed = pinnedContent.classList.toggle('collapsed');
    pinnedChevron.classList.toggle('rotated', !isCollapsed);
  });

  // Config section — collapsed by default
  const configToggle = dom.configToggle;
  const configContent = dom.configContent;
  const configChevron = configToggle.querySelector('.chevron');

  configToggle.addEventListener('click', () => {
    const isCollapsed = configContent.classList.toggle('collapsed');
    configChevron.classList.toggle('rotated', !isCollapsed);
  });

  // Sites section — collapsed by default
  const sitesToggle = dom.sitesToggle;
  const sitesContent = dom.sitesContent;
  const sitesChevron = sitesToggle.querySelector('.chevron');

  sitesToggle.addEventListener('click', () => {
    const isCollapsed = sitesContent.classList.toggle('collapsed');
    sitesChevron.classList.toggle('rotated', !isCollapsed);
  });
}

// ---------- Rendering: Sites Configurator ----------

function renderSitesConfigurator() {
  const sites = state.configuration.sites || [];
  const list = dom.sitesList;
  list.innerHTML = '';

  sites.forEach((site) => {
    const row = document.createElement('div');
    row.className = site.isCustom ? 'tag-row custom-site' : 'tag-row';
    
    const deleteBtnHtml = site.isCustom
      ? `<button class="btn-delete-tag btn-delete-site" data-id="${site.id}" title="Remove site">×</button>`
      : '';

    row.innerHTML = `
      <span class="tag-dot-indicator" style="background: var(--text-muted); opacity: 0.5;"></span>
      <span class="tag-label" style="font-family: monospace;">${escapeHTML(site.domain)}</span>
      <label class="tag-toggle">
        <input type="checkbox" ${site.isEnabled ? 'checked' : ''} data-id="${site.id}">
        <span class="toggle-track"></span>
      </label>
      ${deleteBtnHtml}
    `;

    // Toggle handler
    const checkbox = row.querySelector('input[type="checkbox"]');
    checkbox.addEventListener('change', () => {
      chrome.runtime.sendMessage({
        type: 'SITE_TOGGLED',
        payload: { siteId: site.id, enabled: checkbox.checked }
      });
    });

    // Delete handler
    if (site.isCustom) {
      const deleteBtn = row.querySelector('.btn-delete-site');
      deleteBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({
          type: 'SITE_REMOVED',
          payload: { siteId: site.id }
        });
      });
    }

    list.appendChild(row);
  });
}

// ---------- Render All ----------

function renderAll() {
  renderTelemetry();
  renderEngineStatus();
  renderCounterGrid();
  renderStack();
  renderPinnedSection();
  renderTagConfigurator();
  renderSitesConfigurator();

  // If category view is active, refresh it
  if (activeCategory) {
    showCategoryView(activeCategory);
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

// ---------- Init ----------

document.addEventListener('DOMContentLoaded', () => {
  // Cache DOM references
  dom = {
    telTotal: $('#tel-total'),
    telRate: $('#tel-rate'),
    telEngine: $('#tel-engine'),
    engineDot: $('#engine-dot'),
    engineLabel: $('#engine-label'),
    counterGrid: $('#counter-grid'),
    stackList: $('#stack-list'),
    pinnedList: $('#pinned-list'),
    pinnedEmpty: $('#pinned-empty'),
    pinnedCount: $('#pinned-count'),
    pinnedToggle: $('#pinned-toggle'),
    pinnedContent: $('#pinned-content'),
    configToggle: $('#config-toggle'),
    configContent: $('#config-content'),
    tagList: $('#tag-list'),
    mainContent: $('#main-content'),
    categoryView: $('#category-view'),
    categoryViewTitle: $('#category-view-title'),
    categoryViewCount: $('#category-view-count'),
    categoryItems: $('#category-items'),
    categoryBack: $('#category-back'),
    addTagForm: $('#add-tag-form'),
    newTagInput: $('#new-tag-input'),
    clearStackBtn: $('#clear-stack-btn'),
    themeToggle: $('#theme-toggle'),
    // Sites references
    sitesToggle: $('#sites-toggle'),
    sitesContent: $('#sites-content'),
    sitesList: $('#sites-list'),
    addSiteForm: $('#add-site-form'),
    newSiteInput: $('#new-site-input'),
  };

  // Theme
  initTheme();
  dom.themeToggle.addEventListener('click', toggleTheme);

  // Collapsibles
  initCollapsibles();

  // Category back button
  dom.categoryBack.addEventListener('click', hideCategoryView);

  // Add tag form
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

  // Add site form
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

  // Clear stack
  dom.clearStackBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'CLEAR_STACK' });
  });

  // Message listener
  initMessageListener();

  // Request initial state from background
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
    if (response) {
      state = { ...state, ...response };
      renderAll();
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
