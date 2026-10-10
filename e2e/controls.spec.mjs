// Side panel controls against the real service worker and content script: pause / resume, the four
// ignore lists, favourite (button and Space), delete, re-tag through the Override menu (a manual tag
// survives a re-decide), Clear tag / Clear all keep favourites, the clear confirmation survives a
// broadcast, keyboard navigation, and the theme surviving a reload.
import { test, expect } from '@playwright/test';
import {
  launchWithExtension, seed, servePages, openPanel, waitForStack, readStack, readConfig, waitForStartup, waitDecided,
  annotations, sendFromPage, swPoll, waitForSystem1, recordMessages, recordedMessages
} from './helpers/ext.mjs';
import { linkedinFeedHtml, appendPosts, goldenText, urnFor, keyFor } from './helpers/feeds.mjs';

const FEED = 'https://www.linkedin.com/feed/';
const NO_GATE = { configuration: { isMatchPromptEnabled: false, matchPrompt: '' }, intelligence: { escalation: { provider: 'none' } } };

/** A stored item as System 1 would have left it (gate off). */
function storedItem(id, goldenId, tag, n, extra = {}) {
  const urn = urnFor(700, n);
  return {
    id,
    postKey: keyFor(urn),
    timestamp: Date.now() - n * 60000,
    sourcePlatform: 'linkedin.com',
    sourceUrl: `https://www.linkedin.com/feed/update/${urn}/`,
    authorName: `Person ${n}`,
    canonicalAuthorName: `Person ${n}`,
    authorUrl: `https://www.linkedin.com/in/person-${n}/`,
    textSnippet: `Post by: Person ${n}\n\n${goldenText(goldenId)}`,
    assignedTag: tag,
    tags: tag === 'Unclassified' ? [] : [{ name: tag, score: 0.9 }],
    isAd: false,
    isFavorite: false,
    favoritedAt: null,
    decision: {
      v: 1, promptVersion: 0, specHash: 'seed', path: ['system1'], provider: 'system1', pMatch: null, matchConfidence: null,
      tag, tagConfidence: 0.9, tags: [], escalated: false, uncertain: false, reason: null, collect: true, latencyMs: 5, at: Date.now() - n * 60000
    },
    matchInfo: { engine: 'System 1 (local embeddings)' },
    ...extra
  };
}

const row = (panel, id) => panel.locator(`#stream-list .item-row[data-id="${id}"]`);
const item = async (sw, id) => (await readStack(sw)).find((i) => i.id === id);

test('pause stops collection (the banner shows since when) and resume collects the page', async () => {
  test.setTimeout(240000);
  const ext = await launchWithExtension();
  try {
    const sw = ext.serviceWorker;
    await seed(sw, NO_GATE);
    const { page: panel } = await openPanel(ext, { tab: 'stream' });
    await expect(panel.locator('#pause-banner')).toBeHidden();

    await panel.locator('#pause-toggle').click();
    await expect(panel.locator('#pause-banner')).toBeVisible();
    await expect(panel.locator('#pause-time')).toHaveText(/\d{1,2}:\d{2}/);
    await expect(panel.locator('#pause-toggle')).toHaveAttribute('title', 'Resume tracking');
    const paused = await swPoll(sw, async () => {
      const { configuration } = await chrome.storage.local.get('configuration');
      return configuration.isTrackingPaused ? configuration : null;
    });
    expect(Number.isFinite(paused.trackingPausedAt)).toBe(true);

    // The banner survives a reload of the panel (the time comes from storage).
    await panel.reload();
    await expect(panel.locator('#pause-banner')).toBeVisible();
    await expect(panel.locator('#pause-time')).toHaveText(/\d{1,2}:\d{2}/);
    await expect(panel.locator('#pause-toggle')).toHaveAttribute('title', 'Resume tracking');

    // Paused: the feed is not read at all.
    const posts = ['tag-weather-03', 'tag-sports-01', 'tag-study-01'].map((id, n) => ({ urn: urnFor(701, n), text: goldenText(id) }));
    const keys = posts.map((p) => keyFor(p.urn));
    await servePages(ext.context, { [FEED]: linkedinFeedHtml(posts) });
    const page = await ext.context.newPage();
    await page.goto(FEED);
    await page.waitForTimeout(4000);
    expect((await annotations(page, keys)).map((a) => a.status)).toEqual([null, null, null]);
    expect(await readStack(sw)).toEqual([]);

    // Resume: the open page is read right away.
    await panel.locator('#pause-toggle').click();
    await expect(panel.locator('#pause-banner')).toBeHidden();
    await waitDecided(page, keys);
    await waitForStack(sw, (s) => s.length === 3);
    const cfg = await readConfig(sw);
    expect(cfg).toMatchObject({ isTrackingPaused: false, trackingPausedAt: null });
    await expect(panel.locator('#stream-list .item-row')).toHaveCount(3);
  } finally {
    await ext.close();
  }
});

test('ignore lists: keyword, tag, link and domain', async () => {
  test.setTimeout(300000);
  const ext = await launchWithExtension();
  try {
    const sw = ext.serviceWorker;
    await seed(sw, NO_GATE);
    const { page: panel } = await openPanel(ext, { tab: 'settings' });

    const posts = [
      { id: 'tag-weather-02', urn: urnFor(702, 0) }, // contains "Hurricane"
      { id: 'tag-politics-02', urn: urnFor(702, 1) }, // System 1 tags it Politics
      { id: 'tag-sports-01', urn: urnFor(702, 2) }, // its link is ignored
      { id: 'tag-study-01', urn: urnFor(702, 3) } // collected
    ].map((p) => ({ ...p, text: goldenText(p.id) }));
    const keys = posts.map((p) => keyFor(p.urn));

    // Settings forms (Enter submits).
    await panel.locator('#new-keyword-input').fill('hurricane');
    await panel.locator('#new-keyword-input').press('Enter');
    await panel.locator('#new-ignored-tag-input').fill('Politics');
    await panel.locator('#new-ignored-tag-input').press('Enter');
    await panel.locator('#new-ignored-link-input').fill(`https://www.linkedin.com/feed/update/${posts[2].urn}/`);
    await panel.locator('#new-ignored-link-input').press('Enter');
    await swPoll(sw, async () => {
      const { configuration: c } = await chrome.storage.local.get('configuration');
      return c.ignoredKeywords.length === 1 && c.ignoredTags.length === 1 && c.ignoredLinks.length === 1;
    });
    await expect(panel.locator('#keywords-list .tag-label')).toHaveText(['hurricane']);
    await expect(panel.locator('#ignored-tags-list .tag-label')).toHaveText(['Politics']);
    await expect(panel.locator('#ignored-links-list .tag-label')).toHaveCount(1);
    // A duplicate keyword (any case) is refused.
    expect(await sendFromPage(panel, 'KEYWORD_ADDED', { keyword: 'Hurricane' })).toMatchObject({ success: false });

    await servePages(ext.context, { [FEED]: linkedinFeedHtml(posts) });
    const page = await ext.context.newPage();
    await page.goto(FEED);
    await waitDecided(page, keys);
    const ann = await annotations(page, keys);
    console.log('[ignore] annotations', JSON.stringify(ann));
    expect(ann).toEqual([
      { status: 'ignored', reason: 'ignored_keyword' },
      { status: 'ignored', reason: 'ignored_tag' },
      { status: 'ignored', reason: 'ignored_link' },
      { status: 'collected', reason: null }
    ]);
    let stack = await waitForStack(sw, (s) => s.length === 1);
    expect(stack[0].postKey).toBe(keys[3]);

    // Domain: the card's flag asks first; confirming hides linkedin.com posts (kept in storage).
    await panel.locator('.tab-btn[data-tab="stream"]').click();
    await expect(panel.locator('#stream-list .item-row')).toHaveCount(1);
    // The flag appears on hover.
    await panel.locator('#stream-list .item-row .platform-name-wrapper').hover();
    await panel.locator('#stream-list .item-row .btn-ignore-domain').click();
    await expect(panel.locator('.confirm-overlay .confirm-title')).toHaveText('Ignore domain?');
    await panel.locator('.confirm-overlay .btn-confirm-ok').click();
    await swPoll(sw, async () => (await chrome.storage.local.get('configuration')).configuration.ignoredDomains.includes('linkedin.com'));
    await expect(panel.locator('#stream-list .item-row')).toHaveCount(0);
    expect(await readStack(sw)).toHaveLength(1);
    // The content script stops reading the site: a new post is neither annotated nor stored.
    const late = { urn: urnFor(702, 4), text: goldenText('tag-migration-02') };
    await page.waitForTimeout(500);
    await appendPosts(page, [late], 4);
    await page.waitForTimeout(3000);
    expect((await annotations(page, [keyFor(late.urn)]))[0].status).toBeNull();
    expect(await readStack(sw)).toHaveLength(1);

    // Removing the domain and the keyword from Settings shows the post again, and the content
    // script reads the site again: the post that appeared meanwhile is collected now.
    await panel.locator('.tab-btn[data-tab="settings"]').click();
    await panel.locator('#ignored-domains-list .btn-delete-ignored-domain').click();
    await panel.locator('#keywords-list .btn-delete-kw').click();
    await swPoll(sw, async () => {
      const { configuration: c } = await chrome.storage.local.get('configuration');
      return c.ignoredDomains.length === 0 && c.ignoredKeywords.length === 0;
    });
    await waitDecided(page, [keyFor(late.urn)]);
    stack = await waitForStack(sw, (s) => s.length === 2);
    expect(stack.map((i) => i.postKey).sort()).toEqual([keys[3], keyFor(late.urn)].sort());
    await panel.locator('.tab-btn[data-tab="stream"]').click();
    await expect(panel.locator('#stream-list .item-row')).toHaveCount(2);
  } finally {
    await ext.close();
  }
});

test('favourite (button and Space), delete, Override re-tag that survives a re-decide, Clear tag and Clear all keep favourites', async () => {
  test.setTimeout(300000);
  const ext = await launchWithExtension();
  try {
    const sw = ext.serviceWorker;
    await waitForStartup(sw);
    const items = [
      storedItem('A', 'tag-weather-03', 'Weather', 0),
      storedItem('E', 'tag-weather-01', 'Weather', 1),
      storedItem('B', 'tag-politics-02', 'Politics', 2),
      storedItem('C', 'tag-sports-01', 'Sports', 3),
      storedItem('D', 'tag-study-01', 'Study', 4)
    ];
    await seed(sw, { ...NO_GATE, stack: items });
    const { page: panel } = await openPanel(ext, { tab: 'stream' });
    await waitForSystem1(panel);
    await expect(panel.locator('#stream-list .item-row')).toHaveCount(5);

    // Favourite with the heart button.
    await row(panel, 'A').locator('.btn-favorite').click();
    await expect.poll(async () => (await item(sw, 'A')).isFavorite).toBe(true);
    expect(Number.isFinite((await item(sw, 'A')).favoritedAt)).toBe(true);
    await expect(row(panel, 'A')).toHaveAttribute('data-favorite', 'true');

    // Favourite with Space on the keyboard-focused card (B is the third card, newest first).
    await panel.locator('#feed-container').click({ position: { x: 2, y: 2 } });
    for (let i = 0; i < 3; i++) await panel.keyboard.press('ArrowDown');
    await expect(row(panel, 'B')).toHaveClass(/keyboard-focused/);
    await panel.keyboard.press(' ');
    await expect.poll(async () => (await item(sw, 'B')).isFavorite).toBe(true);
    await expect(panel.locator('.filter-pill[data-category="Favorites"] .pill-count')).toHaveText('2');

    // Delete.
    await row(panel, 'C').locator('.btn-card-delete').click();
    await expect.poll(async () => (await readStack(sw)).length).toBe(4);
    expect(await item(sw, 'C')).toBeUndefined();
    await expect(row(panel, 'C')).toHaveCount(0);

    // Re-tag through the Override menu: a manual override.
    await row(panel, 'D').locator('.btn-override-trigger').click();
    await expect(row(panel, 'D').locator('.override-popover')).toHaveClass(/show/);
    await row(panel, 'D').locator('.override-popover-item[data-tag="Culture"]').click();
    await expect.poll(async () => (await item(sw, 'D')).assignedTag).toBe('Culture');
    expect((await item(sw, 'D')).matchInfo).toMatchObject({ manual: true, engine: 'Manual Override' });
    await expect(row(panel, 'D')).toHaveAttribute('data-tag', 'Culture');

    // A full re-decide (System 1) keeps the manual tag and re-derives the others.
    await recordMessages(panel, ['REDECIDE_PROGRESS']);
    const { jobId } = await sendFromPage(panel, 'REDECIDE_STACK', { scope: 'all' });
    await panel.waitForFunction((id) => (window.__msgs || []).some((m) => m.payload.jobId === id && m.payload.finished), jobId, { timeout: 120000 });
    let stack = await readStack(sw);
    expect(stack.find((i) => i.id === 'D')).toMatchObject({ assignedTag: 'Culture', matchInfo: { manual: true } });
    expect(stack.find((i) => i.id === 'A').assignedTag).toBe('Weather');
    expect(stack.find((i) => i.id === 'E').assignedTag).toBe('Weather');
    expect(stack.find((i) => i.id === 'A').decision.specHash).not.toBe('seed');
    expect((await recordedMessages(panel)).filter((m) => m.payload.jobId === jobId).at(-1).payload).toMatchObject({ jobId, finished: true, total: 3 });

    // Clear "Weather": the favourite A stays, E goes.
    await panel.locator('.filter-pill[data-category="Weather"]').click();
    await expect(panel.locator('#stream-list .item-row')).toHaveCount(2);
    await panel.locator('#clear-stack-btn').click();
    await expect(panel.locator('#btn-confirm-clear-tag')).toHaveText('Clear "Weather"');
    // The confirmation survives a broadcast (a real state change from the worker).
    await sw.evaluate(async () => {
      const { configuration } = await chrome.storage.local.get('configuration');
      await chrome.storage.local.set({ configuration: { ...configuration, ignoredKeywords: ['zzz-unused'] } });
      const s = await chrome.storage.local.get(['configuration', 'metrics', 'stack', 'telemetry']);
      await chrome.runtime.sendMessage({ type: 'STATE_UPDATED', payload: { ...s, inFlightCount: 0 } }).catch(() => {});
    });
    await panel.waitForTimeout(500);
    await expect(panel.locator('#clear-confirm-container')).toBeVisible();
    await panel.locator('#btn-confirm-clear-tag').click();
    await expect.poll(async () => (await readStack(sw)).map((i) => i.id).sort().join()).toBe('A,B,D');

    // Clear all: only the favourites are left.
    await panel.locator('.filter-pill[data-category="All"]').click();
    await panel.locator('#clear-stack-btn').click();
    await expect(panel.locator('#btn-confirm-clear-tag')).toBeHidden();
    await panel.locator('#btn-confirm-clear-all').click();
    await expect.poll(async () => (await readStack(sw)).map((i) => i.id).sort().join()).toBe('A,B');
    stack = await readStack(sw);
    expect(stack.every((i) => i.isFavorite)).toBe(true);
    await expect(panel.locator('#stream-list .item-row')).toHaveCount(2);
    const telemetry = await sw.evaluate(async () => (await chrome.storage.local.get('telemetry')).telemetry);
    expect(telemetry.totalProcessed).toBe(0);
  } finally {
    await ext.close();
  }
});

test('keyboard: ↑/↓ move, Enter expands, Shift+Enter opens the post, ←/→ re-tag, Esc then ←/→ switch the category', async () => {
  test.setTimeout(240000);
  const ext = await launchWithExtension();
  try {
    const sw = ext.serviceWorker;
    await waitForStartup(sw);
    const items = [
      storedItem('K1', 'food-14', 'Personal Opinion', 0),
      storedItem('K2', 'tag-weather-03', 'Weather', 1),
      storedItem('K3', 'tag-sports-01', 'Sports', 2)
    ];
    await seed(sw, { ...NO_GATE, stack: items });
    await servePages(ext.context, { [items[0].sourceUrl]: '<!doctype html><title>Post</title><p>post</p>' });
    const { page: panel } = await openPanel(ext, { tab: 'stream' });
    await expect(panel.locator('#stream-list .item-row')).toHaveCount(3);

    await panel.locator('#feed-container').click({ position: { x: 2, y: 2 } });
    await panel.keyboard.press('ArrowDown');
    await expect(row(panel, 'K1')).toHaveClass(/keyboard-focused/);
    await panel.keyboard.press('ArrowDown');
    await expect(row(panel, 'K2')).toHaveClass(/keyboard-focused/);
    await panel.keyboard.press('ArrowUp');
    await expect(row(panel, 'K1')).toHaveClass(/keyboard-focused/);
    await expect(panel.locator('.item-row.keyboard-focused')).toHaveCount(1);

    // Enter toggles the body of the focused card.
    const body = row(panel, 'K1').locator('.card-body');
    await expect(body).toHaveClass(/collapsed/);
    await panel.keyboard.press('Enter');
    await expect(body).not.toHaveClass(/collapsed/);
    await expect(row(panel, 'K1').locator('.btn-body-expand')).toHaveText('Show less');
    await panel.keyboard.press('Enter');
    await expect(body).toHaveClass(/collapsed/);

    // Shift+Enter opens the original post in a new tab.
    const [popup] = await Promise.all([ext.context.waitForEvent('page'), panel.keyboard.press('Shift+Enter')]);
    await popup.waitForLoadState('domcontentloaded').catch(() => {});
    expect(popup.url()).toBe(items[0].sourceUrl);
    await popup.close();
    await panel.bringToFront();

    // → / ← re-tag the focused card (manual overrides), one step each way.
    const before = (await item(sw, 'K1')).assignedTag;
    await panel.keyboard.press('ArrowRight');
    await expect.poll(async () => (await item(sw, 'K1')).assignedTag).not.toBe(before);
    expect((await item(sw, 'K1')).matchInfo).toMatchObject({ manual: true });
    await panel.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await item(sw, 'K1')).assignedTag).toBe(before);
    await expect(row(panel, 'K1')).toHaveClass(/keyboard-focused/);

    // Esc drops the focus; ← / → then move through the category pills.
    await panel.keyboard.press('Escape');
    await expect(panel.locator('.item-row.keyboard-focused')).toHaveCount(0);
    await expect(panel.locator('#filter-pills .filter-pill.active')).toHaveAttribute('data-category', 'All');
    await panel.keyboard.press('ArrowRight');
    await expect(panel.locator('#filter-pills .filter-pill.active')).toHaveAttribute('data-category', 'Favorites');
    await panel.keyboard.press('ArrowLeft');
    await expect(panel.locator('#filter-pills .filter-pill.active')).toHaveAttribute('data-category', 'All');
    // Nothing else changed.
    expect((await readStack(sw)).map((i) => i.assignedTag)).toEqual(['Personal Opinion', 'Weather', 'Sports']);

    // Shortcuts never fire while typing in a field.
    await panel.locator('#global-search').click();
    await panel.keyboard.press('ArrowRight');
    await expect(panel.locator('#filter-pills .filter-pill.active')).toHaveAttribute('data-category', 'All');
  } finally {
    await ext.close();
  }
});

test('the theme choice survives a reload', async () => {
  test.setTimeout(120000);
  const ext = await launchWithExtension();
  try {
    await waitForStartup(ext.serviceWorker);
    const { page: panel } = await openPanel(ext);
    const theme = () => panel.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(await theme()).toBe('dark');
    await panel.locator('#theme-toggle').click();
    expect(await theme()).toBe('light');
    await panel.reload();
    await panel.waitForSelector('#intelligence-root .intel', { state: 'attached' });
    expect(await theme()).toBe('light');
    await panel.locator('#theme-toggle').click();
    await panel.reload();
    await panel.waitForSelector('#intelligence-root .intel', { state: 'attached' });
    expect(await theme()).toBe('dark');
  } finally {
    await ext.close();
  }
});
