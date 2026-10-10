// @vitest-environment happy-dom
/**
 * sidepanel.html + sidepanel.js loaded in happy-dom against a fake chrome: the Phase 6 UI fixes
 * (badge, tag editor surviving broadcasts, clear confirmation, category toggle, keyboard
 * shortcuts, prompt debounce/stale replies/chips, hidden-by-prompt pill, author filter key, Ads
 * count, favicon handler, toasts instead of alert(), JSON export).
 *
 * One module instance is shared by all tests; each test pushes its own STATE_UPDATED.
 */
import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createFakeChrome, installFakeChrome } from '../helpers/fake-chrome.js';

// Real timers (the prompt debounce is 600 ms) on a loaded machine: generous limits.
vi.setConfig({ testTimeout: 30000, hookTimeout: 60000 });

const ROOT = path.resolve(__dirname, '../..');
const HTML = fs.readFileSync(path.join(ROOT, 'sidepanel.html'), 'utf8');
const BODY = /<body[^>]*>([\s\S]*)<\/body>/i.exec(HTML)[1].replace(/<script[\s\S]*?<\/script>/gi, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flush = async () => { for (let i = 0; i < 4; i++) await sleep(0); };

let fake;
/** @type {Record<string, (payload: any) => any>} */
let handlers;
const blobs = [];
let initialBadgeLevel = null;

function baseConfig(overrides = {}) {
  return {
    trackedTags: [
      { id: 't1', label: 'Food', isEnabled: true, prompt: 'Food posts' },
      { id: 't2', label: 'Tech', isEnabled: true, prompt: 'Tech posts' },
      { id: 't3', label: 'Travel', isEnabled: true, prompt: '' },
      { id: 'ads', label: 'Ads', isEnabled: true, isPseudo: true }
    ],
    sites: [],
    ignoredKeywords: [],
    ignoredTags: [],
    ignoredLinks: [],
    ignoredDomains: [],
    isTrackingPaused: false,
    trackingPausedAt: null,
    matchPrompt: '',
    isMatchPromptEnabled: false,
    matchPromptTags: [],
    ...overrides
  };
}

let seq = 0;
function mkItem(id, overrides = {}) {
  seq += 1;
  return {
    id,
    postKey: `li:urn:li:activity:${id}`,
    timestamp: Date.now() - seq * 1000,
    sourcePlatform: 'linkedin.com',
    sourceUrl: `https://www.linkedin.com/feed/update/urn:li:activity:${id}/`,
    authorName: 'Ada',
    canonicalAuthorName: 'Ada',
    authorUrl: '',
    textSnippet: `Post ${id} title. Body of post ${id}.`,
    assignedTag: 'Food',
    tags: [{ name: 'Food', score: 0.9 }],
    isAd: false,
    isFavorite: false,
    decision: { v: 1, path: ['system1'], provider: 'system1', pMatch: null, matchConfidence: null, tag: 'Food', tagConfidence: 0.7, tags: [], escalated: false, uncertain: false, reason: null, collect: true, latencyMs: 9, at: seq },
    matchInfo: { engine: 'System 1 (local embeddings)' },
    ...overrides
  };
}

function statePayload(configuration, stack = []) {
  return {
    configuration,
    metrics: { counts: {} },
    stack,
    telemetry: { totalProcessed: stack.length, classifiedCount: stack.length, unclassifiedCount: 0, sessionStart: 0, lastProcessed: null },
    inFlightCount: 0
  };
}

let current = statePayload(baseConfig(), []);

/** The service worker as a runtime message sender. */
const SW_SENDER = { id: 'fake-extension-id', url: 'chrome-extension://fake-extension-id/background.js' };
/** A content script in a LinkedIn tab. */
const PAGE_SENDER = { id: 'fake-extension-id', tab: { id: 9 }, url: 'https://www.linkedin.com/feed/', origin: 'https://www.linkedin.com' };

function push(type, payload, sender = SW_SENDER) {
  fake.runtime.onMessage.dispatch({ type, payload }, sender, () => {});
}

async function setState(configuration, stack = []) {
  current = statePayload(configuration, stack);
  push('STATE_UPDATED', current);
  await flush();
}

function sentOfType(type) {
  return fake.runtime.sent.map((s) => s.message).filter((m) => m && m.type === type);
}

function key(k, opts = {}) {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts });
  (document.activeElement || document.body).dispatchEvent(e);
  return e;
}

const $ = (sel) => document.querySelector(sel);
const pill = (cat) => [...document.querySelectorAll('#filter-pills .filter-pill')].find((p) => p.dataset.category === cat);
const feedIds = () => [...document.querySelectorAll('#stream-list .item-row')].map((r) => r.dataset.id);

beforeAll(async () => {
  document.body.innerHTML = BODY;

  // Browser APIs happy-dom lacks (or that would hit the network).
  globalThis.CSS = globalThis.CSS || {};
  if (typeof globalThis.CSS.escape !== 'function') globalThis.CSS.escape = (s) => String(s).replace(/["\\\]]/g, '\\$&');
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function () {};
  globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });
  globalThis.IntersectionObserver = class {
    constructor(cb) { this.cb = cb; }
    observe(el) { queueMicrotask(() => this.cb([{ target: el, isIntersecting: true }], this)); }
    unobserve() {}
    disconnect() {}
  };
  window.open = vi.fn();
  window.alert = vi.fn();
  URL.createObjectURL = (blob) => { blobs.push(blob); return `blob:test/${blobs.length}`; };
  URL.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = function () {};

  handlers = {
    GET_STATE: () => current,
    GET_ENGINE_STATUS: () => ({ tier: 3, name: 'Rule-based Classifier', status: 'ready', warnings: [] }),
    GET_DIAGNOSTICS: () => ({ success: false, error: 'Unknown message type' }),
    GENERATE_PROMPT_TAGS: () => ({ success: true, stale: true })
  };
  fake = createFakeChrome({
    onRuntimeMessage: (msg) => (handlers[msg.type] ? handlers[msg.type](msg.payload) : { success: true })
  });
  fake.runtime.getManifest = () => ({ version: '0.9.0' });
  installFakeChrome(fake);

  await import('../../sidepanel.js');
  document.dispatchEvent(new Event('DOMContentLoaded'));
  initialBadgeLevel = $('#engine-badge').dataset.level;
  await flush();
});

beforeEach(async () => {
  // Back to the Stream tab, no keyboard focus, no filters.
  document.querySelector('.tab-btn[data-tab="stream"]').click();
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  key('Escape');
  await setState(baseConfig(), []);
  // The All pill also resets the author filter.
  const all = pill('All');
  if (all) all.click();
  fake.runtime.sent.length = 0;
});

describe('engine badge', () => {
  test('starts grey "checking" (never a false green), then follows the reply and pushes', async () => {
    expect(initialBadgeLevel).toBe('checking');
    // The legacy rules-only reply is amber, not green.
    expect($('#engine-badge').dataset.level).toBe('warn');
    push('ENGINE_STATUS', { badge: { level: 'loading', label: 'Loading…', title: 'Loading the local model' }, system1: { state: 'loading', progress: 0.3 }, warnings: [] });
    expect($('#engine-dot').className).toBe('engine-dot level-loading');
    expect($('#engine-label').textContent).toBe('Loading 30%');
    push('ENGINE_STATUS', { badge: { level: 'ok', label: 'Ready', title: 'System 1 ready' }, system1: { state: 'ready', model: 'minilm' }, warnings: [] });
    expect($('#engine-dot').className).toBe('engine-dot level-ok');
    expect($('#engine-badge').title).toBe('System 1 ready');
    expect($('#tel-engine').textContent).toBe('System 1 (minilm)');
  });
});

describe('Settings tab', () => {
  test('shows the Intelligence section next to the prompt filter', () => {
    const section = $('#intelligence-section');
    expect(section).not.toBeNull();
    expect(section.previousElementSibling.id).toBe('prompt-section');
    expect(section.querySelector('#esc-provider')).not.toBeNull();
    expect(section.querySelector('#diag-details')).not.toBeNull();
  });

  test('tag prompt textarea and expanded rows survive STATE_UPDATED', async () => {
    document.querySelector('.tab-btn[data-tab="settings"]').click();
    const row = () => [...document.querySelectorAll('#tag-list .tag-row')].find((r) => r.dataset.tag === 'Food');
    row().querySelector('.btn-expand-prompt').click();
    const textarea = row().querySelector('.tag-prompt-textarea');
    expect(document.activeElement).toBe(textarea);
    textarea.value = 'Typed but not saved';

    // A broadcast while typing (another tag toggled elsewhere).
    const cfg = baseConfig();
    cfg.trackedTags[1] = { ...cfg.trackedTags[1], isEnabled: false };
    await setState(cfg, []);
    expect(row().querySelector('.tag-prompt-textarea')).toBe(textarea);
    expect(textarea.value).toBe('Typed but not saved');
    expect(document.activeElement).toBe(textarea);

    // Leaving the field applies the skipped re-render; the editor stays open.
    textarea.blur();
    textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await flush();
    expect(row().querySelector('.tag-prompt-container').style.display).toBe('flex');
    const tech = [...document.querySelectorAll('#tag-list .tag-row')].find((r) => r.dataset.tag === 'Tech');
    expect(tech.querySelector('input[type="checkbox"]').checked).toBe(false);
    // Clicking a row button (not typing) does not block re-renders.
    row().querySelector('.btn-expand-prompt').click();
    expect(row().querySelector('.tag-prompt-container').style.display).toBe('none');
  });

  test('prompt filter shows ON/OFF and a hint when a prompt is set but the filter is off', async () => {
    await setState(baseConfig({ matchPrompt: 'ramen spots', isMatchPromptEnabled: false }), []);
    expect($('#match-prompt-state').textContent).toBe('Off');
    expect($('#match-prompt-hint').classList.contains('hidden')).toBe(false);
    expect($('#match-prompt-hint').textContent).toContain('filter is off');
    await setState(baseConfig({ matchPrompt: '', isMatchPromptEnabled: true }), []);
    expect($('#match-prompt-state').textContent).toBe('On');
    expect($('#match-prompt-hint').textContent).toContain('prompt is empty');
    await setState(baseConfig({ matchPrompt: 'ramen', isMatchPromptEnabled: true }), []);
    expect($('#match-prompt-hint').classList.contains('hidden')).toBe(true);
  });

  test('prompt chips use textContent and accept strings or { name }', async () => {
    await setState(baseConfig({ matchPrompt: 'food', matchPromptTags: ['a&b', { name: '<i>x</i>', weight: 3 }, { name: '' }] }), []);
    const chips = [...document.querySelectorAll('#match-prompt-tags-container .prompt-chip')];
    expect(chips.map((c) => c.firstChild.textContent)).toEqual(['#a&b', '#<i>x</i>']);
    expect(document.querySelector('#match-prompt-tags-container i')).toBeNull();
    expect(chips[1].querySelector('.chip-weight').textContent).toBe('3');
  });

  test('the prompt is saved only on Save / Ctrl+Enter, then GENERATE_PROMPT_TAGS; stale replies are ignored', async () => {
    const input = $('#match-prompt-input');
    const save = $('#match-prompt-save');
    input.focus();
    for (const v of ['r', 'ra', 'ram', 'ramen']) {
      input.value = v;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(50);
    }
    await sleep(700);
    input.blur(); // typing and leaving the field never saves
    await flush();
    expect(sentOfType('UPDATE_MATCH_PROMPT')).toHaveLength(0);
    expect(save.disabled).toBe(false);
    expect($('#match-prompt-save-state').textContent).toContain('Unsaved');
    save.click();
    await flush();
    await sleep(20);
    expect(sentOfType('UPDATE_MATCH_PROMPT').map((m) => m.payload.prompt)).toEqual(['ramen']);
    expect(sentOfType('GENERATE_PROMPT_TAGS').map((m) => m.payload.prompt)).toEqual(['ramen']);
    // The stale reply rendered nothing; the loading note is gone.
    expect(document.querySelectorAll('#match-prompt-tags-container .prompt-chip')).toHaveLength(0);
    expect($('#match-prompt-tags-container').textContent).not.toContain('Finding');

    // A fresh reply renders its chips.
    handlers.GENERATE_PROMPT_TAGS = (p) => ({ success: true, tags: ['noodles', { name: 'broth' }], enhanced: `${p.prompt} restaurants` });
    input.value = 'ramen bars';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })); // Ctrl+Enter saves
    await flush();
    await sleep(20);
    expect(sentOfType('UPDATE_MATCH_PROMPT').map((m) => m.payload.prompt)).toEqual(['ramen', 'ramen bars']);
    expect([...document.querySelectorAll('#match-prompt-tags-container .prompt-chip')].map((c) => c.textContent)).toEqual(['#noodles', '#broth']);
    handlers.GENERATE_PROMPT_TAGS = () => ({ success: true, stale: true });
  });
});

describe('feed', () => {
  test('clear confirmation survives broadcasts; only a filter change resets it', async () => {
    await setState(baseConfig(), [mkItem('a'), mkItem('b', { assignedTag: 'Tech' })]);
    $('#clear-stack-btn').click();
    expect($('#clear-confirm-container').classList.contains('hidden')).toBe(false);
    await setState(baseConfig(), [mkItem('a'), mkItem('b', { assignedTag: 'Tech' }), mkItem('c')]);
    expect($('#clear-confirm-container').classList.contains('hidden')).toBe(false);
    pill('Tech').click();
    expect($('#clear-confirm-container').classList.contains('hidden')).toBe(true);
  });

  test('clicking a card category label filters, clicking it again goes back to All', async () => {
    await setState(baseConfig(), [mkItem('a'), mkItem('b', { assignedTag: 'Tech', tags: [{ name: 'Tech', score: 1 }] })]);
    const label = () => document.querySelector('.item-row[data-id="b"] .card-category-label:not(.secondary)');
    label().click();
    await flush();
    expect(pill('Tech').classList.contains('active')).toBe(true);
    expect(feedIds()).toEqual(['b']);
    label().click();
    await flush();
    expect(pill('All').classList.contains('active')).toBe(true);
    expect(feedIds().sort()).toEqual(['a', 'b']);
  });

  test('←/→ re-tag the focused card; without a focused card they cycle the filter', async () => {
    await setState(baseConfig(), [mkItem('a'), mkItem('b')]);
    key('ArrowDown');
    expect(document.querySelector('.item-row.keyboard-focused').dataset.id).toBe('a');
    key('ArrowRight');
    expect(sentOfType('ITEM_RETAGGED')).toEqual([{ type: 'ITEM_RETAGGED', payload: { itemId: 'a', newTag: 'Tech' } }]);
    key('ArrowLeft');
    expect(sentOfType('ITEM_RETAGGED').at(-1).payload).toEqual({ itemId: 'a', newTag: 'Food' });

    key('Escape');
    const before = document.querySelector('#filter-pills .filter-pill.active').dataset.category;
    key('ArrowRight');
    const after = document.querySelector('#filter-pills .filter-pill.active').dataset.category;
    expect(after).not.toBe(before);
    expect(sentOfType('ITEM_RETAGGED')).toHaveLength(2);
  });

  test('shortcuts never act from inputs/buttons or another tab, and Tab is not hijacked', async () => {
    await setState(baseConfig(), [mkItem('a')]);
    $('#global-search').focus();
    expect(key('ArrowDown').defaultPrevented).toBe(false);
    $('#global-search').blur();
    $('#clear-stack-btn').focus();
    expect(key(' ').defaultPrevented).toBe(false);
    $('#clear-stack-btn').blur();
    expect(key('Tab').defaultPrevented).toBe(false);
    expect(key('Tab', { shiftKey: true }).defaultPrevented).toBe(false);
    document.querySelector('.tab-btn[data-tab="settings"]').click();
    document.activeElement.blur();
    expect(key('ArrowDown').defaultPrevented).toBe(false);
    expect(document.querySelector('.item-row.keyboard-focused')).toBeNull();
    expect(sentOfType('FAVORITE_TOGGLED')).toHaveLength(0);
  });

  test('"Hidden by prompt (N)" toggles items with hiddenByPrompt; favorites are never hidden', async () => {
    await setState(baseConfig({ matchPrompt: 'x', isMatchPromptEnabled: true }), [
      mkItem('shown'),
      mkItem('hidden', { hiddenByPrompt: true }),
      mkItem('fav', { hiddenByPrompt: true, isFavorite: true })
    ]);
    const hp = $('#hidden-pill');
    expect(hp.classList.contains('hidden')).toBe(false);
    expect(hp.textContent).toContain('Hidden by prompt (1)');
    expect(feedIds().sort()).toEqual(['fav', 'shown']);
    expect($('#tab-count-stream').textContent).toBe('2');
    hp.click();
    await flush();
    expect(hp.getAttribute('aria-pressed')).toBe('true');
    expect(feedIds().sort()).toEqual(['fav', 'hidden', 'shown']);
    expect(document.querySelector('.item-row[data-id="hidden"]').classList.contains('is-hidden-by-prompt')).toBe(true);
    hp.click();
    await flush();
    expect(feedIds().sort()).toEqual(['fav', 'shown']);
  });

  test('author filter count and filter use canonicalAuthorName || authorName', async () => {
    await setState(baseConfig(), [
      mkItem('a', { authorName: 'Bob', canonicalAuthorName: '' }),
      mkItem('b', { authorName: 'Ada', canonicalAuthorName: 'Ada Lovelace' })
    ]);
    const bob = [...document.querySelectorAll('#filter-author-pills .filter-pill')].find((p) => p.dataset.author === 'Bob');
    expect(bob.querySelector('.pill-count').textContent).toBe('1');
    bob.click();
    await flush();
    expect(feedIds()).toEqual(['a']);
  });

  test('Ads counts each ad once (legacy "Ads" tag included)', async () => {
    await setState(baseConfig(), [
      mkItem('a', { isAd: true, assignedTag: 'Ads' }),
      mkItem('b', { isAd: true }),
      mkItem('c')
    ]);
    expect(pill('Ads').querySelector('.pill-count').textContent).toBe('2');
    pill('Ads').click();
    await flush();
    expect(feedIds().sort()).toEqual(['a', 'b']);
  });

  test('cards: favicon fallback without inline handlers, decision tooltip', async () => {
    await setState(baseConfig(), [mkItem('a', { decision: { ...mkItem('x').decision, path: ['system1', 'jev'], provider: 'jev', escalated: true, pMatch: 0.8, matchConfidence: 0.6 } })]);
    const card = document.querySelector('.item-row[data-id="a"]');
    const img = card.querySelector('.card-favicon');
    expect(img.getAttribute('onerror')).toBeNull();
    img.dispatchEvent(new Event('error'));
    expect(img.style.display).toBe('none');
    const tip = card.querySelector('.info-tooltip-wrapper').getAttribute('title');
    expect(tip).toContain('Decided by: TypeSafe Jev (escalated)');
    expect(tip).toContain('Path: System 1 → TypeSafe Jev');
    expect(tip).toContain('P(match): 0.80');
  });

  test('INFLIGHT_UPDATED updates the indicator without re-rendering', async () => {
    await setState(baseConfig(), [mkItem('a')]);
    const firstRow = document.querySelector('#tag-list .tag-row');
    const card = document.querySelector('.item-row[data-id="a"]');
    push('INFLIGHT_UPDATED', { count: 3 });
    expect($('#processing-count').textContent).toBe('3');
    expect($('#processing-indicator').classList.contains('hidden')).toBe(false);
    expect(document.querySelector('#tag-list .tag-row')).toBe(firstRow);
    expect(document.querySelector('.item-row[data-id="a"]')).toBe(card);
  });

  test('pause banner shows trackingPausedAt', async () => {
    const at = new Date();
    at.setHours(9, 5, 0, 0);
    await setState(baseConfig({ isTrackingPaused: true, trackingPausedAt: at.getTime() }), []);
    expect($('#pause-banner').classList.contains('hidden')).toBe(false);
    expect($('#pause-time').textContent).toBe(at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  });

  test('REDECIDE_PROGRESS shows a slim progress bar', async () => {
    await setState(baseConfig(), [mkItem('a')]);
    push('REDECIDE_PROGRESS', { jobId: 'j', done: 5, total: 10, hidden: 1, finished: false });
    expect($('#redecide-status').classList.contains('hidden')).toBe(false);
    expect($('#redecide-bar .progress-fill').style.width).toBe('50%');
    push('REDECIDE_PROGRESS', { jobId: 'j', done: 10, total: 10, hidden: 1, finished: true });
    expect($('#redecide-text').textContent).toContain('Re-checked 10 posts');
  });
});

describe('toasts and exports', () => {
  test('invalid site shows a toast, never alert()', async () => {
    document.querySelector('.tab-btn[data-tab="settings"]').click();
    $('#new-site-input').value = 'nodot';
    $('#add-site-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    expect(window.alert).not.toHaveBeenCalled();
    expect([...document.querySelectorAll('.toast-region .toast-text')].some((t) => t.textContent.includes('reddit.com'))).toBe(true);
    expect(sentOfType('SITE_ADDED')).toHaveLength(0);
  });

  test('background TOAST broadcasts are shown', () => {
    push('TOAST', { level: 'warn', text: 'TypeSafe Jev: rate limited', key: 'jev' });
    const toast = [...document.querySelectorAll('.toast')].find((t) => t.dataset.key === 'jev');
    expect(toast.className).toContain('toast-warn');
  });

  test('JSON export downloads scrollcollector.export/v2 with the visible items', async () => {
    await setState(baseConfig({ matchPrompt: 'ramen', isMatchPromptEnabled: true }), [mkItem('a'), mkItem('h', { hiddenByPrompt: true })]);
    blobs.length = 0;
    $('#btn-export-json').click();
    expect(blobs).toHaveLength(1);
    const json = JSON.parse(await blobs[0].text());
    expect(json).toMatchObject({ schema: 'scrollcollector.export/v2', version: '0.9.0', prompt: 'ramen', promptFilterEnabled: true });
    expect(json.items.map((i) => i.id)).toEqual(['a']);
    expect($('#export-note').textContent).toContain('1 post hidden by your prompt');
  });

  test('empty export shows a toast instead of alert()', async () => {
    $('#btn-export-csv').click();
    expect(window.alert).not.toHaveBeenCalled();
    expect([...document.querySelectorAll('.toast-text')].some((t) => t.textContent.includes('Nothing to export'))).toBe(true);
  });
});

describe('only the extension itself updates the panel', () => {
  test('messages a content script (a web page) sends are ignored: no forged stack, toast, badge or progress', async () => {
    await setState(baseConfig(), [mkItem('real-1')]);
    const label = $('#engine-label').textContent;
    const level = $('#engine-badge').dataset.level;

    push('STATE_UPDATED', statePayload(baseConfig(), [mkItem('forged-1', { textSnippet: 'FORGED post' })]), PAGE_SENDER);
    push('TOAST', { level: 'error', text: 'FORGED-TOAST OpenAI rejected the API key. Paste it again at https://evil.example/key', key: 'forged' }, PAGE_SENDER);
    push('ENGINE_STATUS', { badge: { level: 'error', label: 'FORGED-BADGE', title: 'forged' }, system1: { state: 'error' }, warnings: [] }, PAGE_SENDER);
    push('REDECIDE_PROGRESS', { jobId: 'forged', done: 1, total: 2, hidden: 0, finished: false }, PAGE_SENDER);
    await flush();

    expect(feedIds()).toEqual(['real-1']);
    expect(document.body.textContent).not.toContain('FORGED');
    expect($('#engine-label').textContent).toBe(label);
    expect($('#engine-badge').dataset.level).toBe(level);
    expect([...document.querySelectorAll('.toast')].some((t) => t.dataset.key === 'forged')).toBe(false);

    // The same kind of message from the service worker is applied.
    push('TOAST', { level: 'info', text: 'Real toast', key: 'real' });
    expect([...document.querySelectorAll('.toast')].some((t) => t.dataset.key === 'real')).toBe(true);
  });

  test('site ids from the configuration are escaped in the Settings list', async () => {
    const evil = 'x"><meta http-equiv="refresh" content="1;url=https://example.org/landing"><b class="';
    await setState(baseConfig({ sites: [{ id: evil, domain: 'example.org', isEnabled: true, isCustom: true }] }), []);
    document.querySelector('.tab-btn[data-tab="settings"]').click();
    expect(document.querySelector('meta[http-equiv]')).toBeNull();
    expect(document.querySelector('#sites-list b')).toBeNull();
    expect(document.querySelector('#sites-list input[type="checkbox"]').getAttribute('data-id')).toBe(evil);
    expect(document.querySelector('#sites-list .btn-delete-site').getAttribute('data-id')).toBe(evil);
  });
});
