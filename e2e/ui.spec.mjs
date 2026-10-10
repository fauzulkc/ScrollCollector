// Side panel UI (Phase 6) against the built extension: engine badge, Settings › Intelligence,
// API keys never re-displayed, exports, and the tag editor surviving STATE_UPDATED broadcasts.
// The panel is opened as a tab (chrome-extension://<id>/sidepanel.html).
import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { launchWithExtension, collectConsole } from './helpers/launch.mjs';

const XSS = '<img src=x onerror=alert(1)>';

/** Polls `fn` in the service worker until it returns a truthy value. */
async function swPoll(sw, fn, arg, timeout = 30000) {
  const start = Date.now();
  for (;;) {
    const value = await sw.evaluate(fn, arg);
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('swPoll timed out');
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function waitForStartup(sw) {
  await swPoll(sw, async () => (await chrome.storage.local.get('schemaVersion')).schemaVersion === 2);
}

/** Records every value the header badge's data-level takes, from the first parse on. */
function recordBadgeLevels() {
  window.__badgeLevels = [];
  const record = () => {
    const badge = document.getElementById('engine-badge');
    if (!badge) return;
    const level = badge.getAttribute('data-level');
    if (window.__badgeLevels[window.__badgeLevels.length - 1] !== level) window.__badgeLevels.push(level);
  };
  new MutationObserver(record).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-level'] });
}

async function openPanel(ext, { recordBadge = false } = {}) {
  const page = await ext.context.newPage();
  if (recordBadge) await page.addInitScript(recordBadgeLevels);
  const logs = collectConsole(page);
  await page.goto(`chrome-extension://${ext.extensionId}/sidepanel.html`);
  await page.waitForLoadState('load');
  // Mounted by the module (the Settings tab may be hidden, so only wait for it to exist).
  await page.waitForSelector('#intelligence-root .intel', { state: 'attached', timeout: 30000 });
  return { page, logs };
}

function seedItem(id, overrides = {}) {
  const now = Date.now();
  return {
    id,
    postKey: `li:urn:li:activity:${id}`,
    timestamp: now - Number(id.replace(/\D/g, '') || 0) * 1000,
    sourcePlatform: 'linkedin.com',
    sourceUrl: `https://www.linkedin.com/feed/update/urn:li:activity:${id}/`,
    authorName: 'Ada',
    canonicalAuthorName: 'Ada',
    authorUrl: 'https://www.linkedin.com/in/ada/',
    textSnippet: `Post ${id} about ramen. "Quoted", with commas, and a line\nbreak.`,
    assignedTag: 'Unclassified',
    tags: [],
    isAd: false,
    isFavorite: false,
    favoritedAt: null,
    decision: {
      v: 1, promptVersion: 1, specHash: '', path: ['system1'], provider: 'system1', pMatch: 0.91,
      matchConfidence: 0.82, tag: 'Unclassified', tagConfidence: 0.4, tags: [], escalated: false,
      uncertain: false, reason: null, collect: true, latencyMs: 8, at: now
    },
    matchInfo: { engine: 'System 1 (local embeddings)' },
    ...overrides
  };
}

function cspErrors(logs) {
  return logs.filter((l) => l.type === 'pageerror' || /Content Security Policy|Refused to|Uncaught/i.test(l.text));
}

test('badge, Intelligence settings and API keys', async () => {
  const ext = await launchWithExtension();
  try {
    const sw = ext.serviceWorker;
    await waitForStartup(sw);
    const { page, logs } = await openPanel(ext, { recordBadge: true });

    // 1. The badge starts grey "checking" (never a false green) and then follows the service worker:
    //    System 1 loads in the offscreen document (amber while loading) and the badge turns green.
    await page.waitForFunction(() => window.__badgeLevels && window.__badgeLevels.length > 0);
    expect(await page.evaluate(() => window.__badgeLevels[0])).toBe('checking');
    await expect(page.locator('#engine-badge')).not.toHaveAttribute('data-level', '');
    await expect(page.locator('#engine-badge')).toHaveAttribute('data-level', 'ok', { timeout: 150000 });
    expect(await page.evaluate(() => window.__badgeLevels.indexOf('ok'))).toBeGreaterThan(0);

    // ENGINE_STATUS pushes drive it (sent from the service worker like the real broadcast; the real
    // ones only follow decisions and settings changes now that System 1 is ready).
    await sw.evaluate(() => chrome.runtime.sendMessage({
      type: 'ENGINE_STATUS',
      payload: { badge: { level: 'loading', label: 'Loading…', title: 'Loading the local decision model…' }, system1: { state: 'loading', progress: 0.42 }, warnings: [] }
    }).catch(() => {}));
    await expect(page.locator('#engine-dot')).toHaveClass(/level-loading/);
    await expect(page.locator('#engine-label')).toHaveText('Loading 42%');
    await sw.evaluate(() => chrome.runtime.sendMessage({
      type: 'ENGINE_STATUS',
      payload: { badge: { level: 'error', label: 'Model error', title: 'The local decision model failed.' }, system1: { state: 'error' }, warnings: [] }
    }).catch(() => {}));
    await expect(page.locator('#engine-dot')).toHaveClass(/level-error/);
    await expect(page.locator('#engine-badge')).toHaveAttribute('title', 'The local decision model failed.');

    // 2. Settings shows the Intelligence section (clicking the badge opens it).
    await page.locator('#engine-badge').click();
    await expect(page.locator('#panel-settings')).toHaveClass(/active/);
    await expect(page.locator('#intelligence-section')).toBeVisible();
    await expect(page.locator('#intel-s1')).toBeVisible();
    await expect(page.locator('#esc-provider option')).toHaveText([
      'None (keep System 1’s answer)', 'Browser built-in AI (Gemini Nano)', 'TypeSafe Jev', 'OpenAI'
    ]);
    // Cloud providers are off by default.
    await expect(page.locator('#jev-enabled')).not.toBeChecked();
    await expect(page.locator('#openai-enabled')).not.toBeChecked();

    // 3. The provider select sends UPDATE_INTELLIGENCE_SETTINGS; the choice is persisted.
    await page.locator('#esc-provider').selectOption('none');
    const provider = await swPoll(sw, async () => {
      const { configuration } = await chrome.storage.local.get('configuration');
      return configuration?.intelligence?.escalation?.provider;
    });
    expect(provider).toBe('none');
    await page.locator('#esc-provider').selectOption('openai');
    await swPoll(sw, async () => (await chrome.storage.local.get('configuration')).configuration?.intelligence?.escalation?.provider === 'openai');
    await expect(page.locator('#esc-hint')).toContainText('not allowed yet');

    // The allow switch persists providers.openai.enabled.
    await page.locator('label[for="openai-enabled"]').click();
    await swPoll(sw, async () => (await chrome.storage.local.get('configuration')).configuration?.intelligence?.providers?.openai?.enabled === true);

    // 4. The API key is saved and never displayed again.
    const key = 'sk-e2e-SECRET-abcdefghijklmnopqrstuvwxyz';
    await page.locator('#openai-key').fill(key);
    await page.locator('#openai-key-save').click();
    await expect(page.locator('#openai-key-status')).toHaveText('Key saved ••wxyz');
    await expect(page.locator('#openai-key')).toHaveValue('');
    const stored = await sw.evaluate(async () => (await chrome.storage.local.get('secrets')).secrets);
    expect(stored.openai).toBe(key);
    expect(await page.content()).not.toContain('SECRET');
    const state = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATE' }));
    expect(JSON.stringify(state)).not.toContain('SECRET');

    await page.reload();
    await page.waitForSelector('#intelligence-root .intel', { state: 'attached', timeout: 30000 });
    await expect(page.locator('#openai-key')).toHaveValue('');
    expect(await page.content()).not.toContain('SECRET');
    expect(await page.evaluate(() => [...document.querySelectorAll('input')].some((i) => i.value.includes('SECRET')))).toBe(false);

    expect(cspErrors(logs)).toEqual([]);
  } finally {
    await ext.close();
  }
});

test('exports, hidden-by-prompt pill and the tag editor surviving STATE_UPDATED', async () => {
  const ext = await launchWithExtension();
  try {
    const sw = ext.serviceWorker;
    await waitForStartup(sw);
    const items = [
      seedItem('p1', { authorName: XSS, canonicalAuthorName: XSS, textSnippet: `${XSS} Ramen night. Broth was great.` }),
      seedItem('p2', { isFavorite: true }),
      // Hidden: its decision (for the current prompt version) rejects it.
      seedItem('p3', { hiddenByPrompt: true, decision: { ...seedItem('p3').decision, pMatch: 0.08, matchConfidence: 0.84, collect: false } })
    ];
    await sw.evaluate(async (stack) => {
      const { configuration } = await chrome.storage.local.get('configuration');
      await chrome.storage.local.set({ stack, configuration: { ...configuration, matchPrompt: 'ramen', isMatchPromptEnabled: true, promptVersion: 1 } });
    }, items);

    const { page, logs } = await openPanel(ext);
    await page.locator('.tab-btn[data-tab="stream"]').click();

    // Hidden-by-prompt pill: hidden items are not shown (or exported) until toggled.
    await expect(page.locator('#hidden-pill')).toBeVisible();
    await expect(page.locator('#hidden-pill')).toContainText('Hidden by prompt (1)');
    await expect(page.locator('#stream-list .item-row')).toHaveCount(2);
    await expect(page.locator('#tab-count-stream')).toHaveText('2');

    // JSON export parses and carries schema v2 with the visible items.
    await page.locator('.tab-btn[data-tab="export"]').click();
    await expect(page.locator('#export-note')).toContainText('1 post hidden by your prompt');
    const [jsonDl] = await Promise.all([page.waitForEvent('download'), page.locator('#btn-export-json').click()]);
    const json = JSON.parse(fs.readFileSync(await jsonDl.path(), 'utf8'));
    expect(json).toMatchObject({ schema: 'scrollcollector.export/v2', prompt: 'ramen', promptFilterEnabled: true });
    expect(typeof json.version).toBe('string');
    expect(json.version.length).toBeGreaterThan(0);
    expect(json.items.map((i) => i.id).sort()).toEqual(['p1', 'p2']);
    expect(JSON.stringify(json)).not.toContain('SECRET');

    // CSV: header + RFC 4180 quoting.
    const [csvDl] = await Promise.all([page.waitForEvent('download'), page.locator('#btn-export-csv').click()]);
    const csv = fs.readFileSync(await csvDl.path(), 'utf8').replace(/^﻿/, '');
    expect(csv.split('\r\n')[0]).toBe('"ID","Timestamp","Platform","Post URL","Author","Tag","Tags","P(match)","Decided by","Confidence","Escalated","Is Ad","Favorite","Text"');
    expect(csv).toContain('"Post p2 about ramen. ""Quoted"", with commas, and a line\nbreak."');

    // HTML: user text escaped, decision line shown.
    const [htmlDl] = await Promise.all([page.waitForEvent('download'), page.locator('#btn-export-html').click()]);
    const html = fs.readFileSync(await htmlDl.path(), 'utf8');
    expect(html).not.toContain(XSS);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('class="decision-line"');

    // Showing hidden posts includes them.
    await page.locator('.tab-btn[data-tab="stream"]').click();
    await page.locator('#hidden-pill').click();
    await expect(page.locator('#stream-list .item-row')).toHaveCount(3);
    await expect(page.locator('#stream-list .item-row.is-hidden-by-prompt')).toHaveCount(1);

    // Tag prompt editor: typing survives a STATE_UPDATED broadcast (a tag toggled from the worker).
    await page.locator('.tab-btn[data-tab="settings"]').click();
    const firstRow = page.locator('#tag-list .tag-row').first();
    const label = await firstRow.getAttribute('data-tag');
    await firstRow.locator('.btn-expand-prompt').click();
    const textarea = firstRow.locator('.tag-prompt-textarea');
    await textarea.fill('typed while a broadcast arrives');
    await textarea.focus();
    const toggled = await sw.evaluate(async (skip) => {
      const { configuration } = await chrome.storage.local.get('configuration');
      const target = configuration.trackedTags.find((t) => t.label !== skip && t.label !== 'Ads' && !t.isPseudo);
      configuration.trackedTags = configuration.trackedTags.map((t) => (t === target ? { ...t, isEnabled: !t.isEnabled } : t));
      await chrome.storage.local.set({ configuration });
      const s = await chrome.storage.local.get(['configuration', 'metrics', 'stack', 'telemetry']);
      await chrome.runtime.sendMessage({ type: 'STATE_UPDATED', payload: { ...s, inFlightCount: 0 } }).catch(() => {});
      return { label: target.label, enabled: !target.isEnabled };
    }, label);
    await page.waitForTimeout(300);
    await expect(textarea).toHaveValue('typed while a broadcast arrives');
    await expect(textarea).toBeFocused();
    await expect(firstRow.locator('.tag-prompt-container')).toBeVisible();

    // Leaving the field applies the broadcast; the editor stays open.
    await page.locator('#new-keyword-input').focus();
    const toggledRow = page.locator(`#tag-list .tag-row[data-tag="${toggled.label}"]`);
    await expect(toggledRow.locator('input[type="checkbox"]')).toBeChecked({ checked: toggled.enabled });
    await expect(page.locator(`#tag-list .tag-row[data-tag="${label}"] .tag-prompt-container`)).toBeVisible();

    expect(cspErrors(logs)).toEqual([]);
  } finally {
    await ext.close();
  }
});

test('keyboard re-tag and clear confirmation across a broadcast', async () => {
  const ext = await launchWithExtension();
  try {
    const sw = ext.serviceWorker;
    await waitForStartup(sw);
    await sw.evaluate(async (stack) => chrome.storage.local.set({ stack }), [seedItem('k1', { assignedTag: 'Unclassified' })]);
    const { page } = await openPanel(ext);
    await page.locator('.tab-btn[data-tab="stream"]').click();
    await expect(page.locator('#stream-list .item-row')).toHaveCount(1);

    // ↓ focuses the card, → re-tags it (ITEM_RETAGGED is persisted by the worker).
    await page.locator('#feed-container').click({ position: { x: 2, y: 2 } });
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.item-row.keyboard-focused')).toHaveCount(1);
    await page.keyboard.press('ArrowRight');
    const retagged = await swPoll(sw, async () => {
      const { stack } = await chrome.storage.local.get('stack');
      const it = stack.find((i) => i.id === 'k1');
      return it && it.assignedTag !== 'Unclassified' ? it : null;
    });
    expect(retagged.matchInfo).toMatchObject({ manual: true });

    // The clear confirmation survives a broadcast.
    await page.locator('#clear-stack-btn').click();
    await expect(page.locator('#clear-confirm-container')).toBeVisible();
    await sw.evaluate(async () => {
      const s = await chrome.storage.local.get(['configuration', 'metrics', 'stack', 'telemetry']);
      await chrome.runtime.sendMessage({ type: 'STATE_UPDATED', payload: { ...s, inFlightCount: 0 } }).catch(() => {});
    });
    await page.waitForTimeout(300);
    await expect(page.locator('#clear-confirm-container')).toBeVisible();
    await page.locator('#btn-clear-cancel').click();
    await expect(page.locator('#clear-confirm-container')).toBeHidden();
  } finally {
    await ext.close();
  }
});

// The integrated background: GET_DIAGNOSTICS (describeSecrets), TEST_PROVIDER, REDECIDE_STACK with
// REDECIDE_PROGRESS, and Copy diagnostics without key material.
test('diagnostics, provider tests and re-decide against the integrated background', async () => {
  const ext = await launchWithExtension();
  try {
    const sw = ext.serviceWorker;
    await waitForStartup(sw);
    await sw.evaluate(() => chrome.storage.local.set({ secrets: { jev: 'jev-e2e-SECRET-0123456789' } }));
    const { page } = await openPanel(ext);
    await page.locator('.tab-btn[data-tab="settings"]').click();

    // describeSecrets() via GET_DIAGNOSTICS: only the last 4 characters.
    await expect(page.locator('#jev-key-status')).toHaveText('Key saved ••6789');

    // Diagnostics: providers table and counters.
    await page.locator('#diag-details > summary').click();
    await expect(page.locator('#diag-providers .diag-provider')).toHaveCount(4);
    await expect(page.locator('#diag-unavailable')).toBeHidden();

    // System 1 test (local; no network). It waits for the model if it is still loading.
    await page.locator('#s1-test').click();
    await expect(page.locator('#s1-test-result')).toHaveText(/Connected · \d+/, { timeout: 150000 });

    // Gemini Nano is not available in headless Chrome for Testing: a clear failure, no throw.
    const nano = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'TEST_PROVIDER', payload: { provider: 'nano' } }));
    expect(nano).toMatchObject({ success: true, ok: false });

    // Re-decide: REDECIDE_STACK { scope: 'all' } with REDECIDE_PROGRESS.
    await page.locator('#diag-redecide').click();
    await expect(page.locator('#diag-redecide-text')).toContainText(/Re-check/);

    // Copy diagnostics never contains key material.
    await ext.context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.locator('#diag-copy').click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).not.toContain('SECRET');
    expect(copied).not.toContain('6789');
  } finally {
    await ext.close();
  }
});
