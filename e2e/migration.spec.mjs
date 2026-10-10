// A v1 profile (the shape of a v0.9 export: /company/x/posts/ source URLs, a glued text over 2000
// characters, {name, weight} prompt tags, colliding item ids, isPinned) migrated by a browser
// restart: every item is kept, flagged legacy / suspectMerged, ids made unique, tags normalized;
// the panel renders it; System 1 then decides the legacy items (hiding, never deleting); and a
// re-sent post heals its migrated item in place instead of duplicating it. Synthetic texts only.
import { test, expect } from '@playwright/test';
import {
  launchWithExtension, relaunch, openPanel, waitForStack, readStack, readConfig, swPoll, servePages, waitDecided,
  waitForSystem1, pageErrors, collectConsole, RESTAURANT_PROMPT
} from './helpers/ext.mjs';
import { linkedinFeedHtml, goldenText } from './helpers/feeds.mjs';
import { SCHEMA_VERSION } from '../lib/storage/schema.js';

const URN = (n) => `urn:li:activity:700000000000000000${n}`;
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const PERMALINK = (n) => `https://www.linkedin.com/feed/update/${URN(n)}/`;
const T0 = Date.now() - 3 * 86400000;

/** A v0.9 (schema v1) storage snapshot. */
function v1Profile() {
  const labels = ['Health', 'Jobs', 'Politics', 'Tech/AI', 'Weather', 'News', 'Personal Opinion', 'Events'];
  const glued = `${goldenText('food-20')}\n\n${goldenText('tag-jobs-01')}`; // two posts glued by the old append bug
  return {
    configuration: {
      trackedTags: [
        ...labels.map((label, i) => ({ id: `t${i + 1}`, label, isEnabled: true, prompt: `Identify posts related to ${label}.` })),
        { id: 't_ads', label: 'Ads', isEnabled: true },
        { id: 'u_ramen', label: 'Ramen', isEnabled: true, prompt: 'Find posts about ramen.' } // a tag the user wrote
      ],
      sites: [
        { id: 's1', domain: 'linkedin.com', isEnabled: true, isCustom: false },
        { id: 's2', domain: 'twitter.com', isEnabled: true, isCustom: false }
      ],
      ignoredKeywords: ['crypto'],
      ignoredTags: [],
      ignoredLinks: [],
      ignoredDomains: [],
      isTrackingPaused: false,
      matchPrompt: RESTAURANT_PROMPT,
      isMatchPromptEnabled: true,
      matchPromptEnhanced: 'Collect posts about restaurants and Michelin-star cooking.',
      matchPromptTags: [{ name: 'Restaurants', weight: 5 }, { name: 'Michelin', weight: 4 }, { name: 'restaurants', weight: 2 }, { name: '  ', weight: 1 }]
    },
    metrics: { counts: { Unclassified: 2, 'Personal Opinion': 1, Jobs: 1 } },
    telemetry: { totalProcessed: 4, classifiedCount: 2, unclassifiedCount: 2, sessionStart: T0, lastProcessed: T0 + 5000 },
    stack: [
      {
        id: 'item_1', timestamp: T0 + 4000, sourcePlatform: 'linkedin.com',
        sourceUrl: 'https://www.linkedin.com/company/golden-fork/posts/', authorName: 'The Golden Fork', authorUrl: 'https://www.linkedin.com/company/golden-fork/',
        textSnippet: goldenText('food-06'), assignedTag: 'Unclassified', tags: [{ name: 'Right', score: 0.4 }, { name: 'Soc', score: 0.3 }],
        isPinned: true, matchInfo: { engine: 'Gemini Nano', score: 0.71 }
      },
      {
        id: 'item_1', timestamp: T0 + 3000, sourcePlatform: 'linkedin.com',
        sourceUrl: PERMALINK(2), authorName: 'Ana Pereira', authorUrl: 'https://www.linkedin.com/in/ana-pereira/',
        textSnippet: glued, assignedTag: 'Personal Opinion', tags: [{ name: 'Mvp', score: 0.5 }], matchInfo: { engine: 'Rule-based Classifier' }
      },
      {
        id: 'item_3', timestamp: T0 + 2000, sourcePlatform: 'linkedin.com',
        sourceUrl: PERMALINK(3), authorName: 'Person 1', authorUrl: 'https://www.linkedin.com/in/person-1/',
        textSnippet: goldenText('tag-weather-03'), assignedTag: 'Unclassified', tags: [], matchInfo: { engine: 'Rule-based Classifier' }
      },
      {
        id: 'item_3', timestamp: T0 + 1000, sourcePlatform: 'linkedin.com',
        sourceUrl: PERMALINK(4), authorName: 'Chef Mara', authorUrl: 'https://www.linkedin.com/in/chef-mara/',
        textSnippet: goldenText('food-17'), assignedTag: 'Jobs', tags: [{ name: 'Jobs', score: 0.6 }], matchInfo: { engine: 'Gemini Nano' }
      }
    ]
  };
}

test('a v1 profile migrates intact on restart, renders, and heals when its posts are seen again', async () => {
  test.setTimeout(360000);
  let ext = await launchWithExtension();
  try {
    // A settled first run (System 1 ready), then the v1 snapshot replaces everything.
    const { page: first } = await openPanel(ext);
    await waitForSystem1(first);
    await first.close();
    const profile = v1Profile();
    await ext.serviceWorker.evaluate(async (p) => {
      await chrome.storage.local.clear();
      await chrome.storage.local.set(p);
    }, profile);
    await new Promise((r) => setTimeout(r, 500));

    // Restart: the service worker migrates on startup.
    ext = await relaunch(ext);
    const sw = ext.serviceWorker;
    await swPoll(sw, async (v) => (await chrome.storage.local.get('schemaVersion')).schemaVersion === v, SCHEMA_VERSION, 60000);
    let stack = await readStack(sw);
    console.log('[migration] migrated', JSON.stringify(stack.map((i) => ({ id: i.id, key: i.postKey, legacy: i.legacy, merged: i.suspectMerged, fav: i.isFavorite, len: i.textSnippet.length }))));

    // Every item kept, in order, text untouched; ids unique (first occurrence keeps its id).
    expect(stack.map((i) => i.id)).toEqual(['item_1', 'item_1_2', 'item_3', 'item_3_2']);
    stack.forEach((item, n) => expect(item.textSnippet, item.id).toBe(profile.stack[n].textSnippet));
    // postKey only from real single-post permalinks (never a company page).
    expect(stack[0].postKey).toBeUndefined();
    expect(stack.slice(1).map((i) => i.postKey)).toEqual([2, 3, 4].map((n) => `url:https://www.linkedin.com/feed/update/${URN(n)}`));
    expect(stack.every((i) => i.legacy === true)).toBe(true);
    // Company-page URL and glued text are suspect; the others are not.
    expect(stack.map((i) => !!i.suspectMerged)).toEqual([true, true, false, false]);
    // isPinned -> isFavorite.
    expect(stack[0]).toMatchObject({ isFavorite: true });
    expect('isPinned' in stack[0]).toBe(false);

    const cfg = await readConfig(sw);
    expect(cfg.matchPromptTags).toEqual(['Restaurants', 'Michelin']);
    expect(cfg.promptVersion).toBe(0);
    expect(cfg.trackedTags.find((t) => t.label === 'Ads')).toMatchObject({ isPseudo: true });
    // v2 -> v3: the tag the user wrote becomes a labels-only prompt (collects: false), so nobody's collected set
    // changes, master on or off (DEC-6 cdd1490; re-pinned by Engineering); built-in tags are never prompts (DEC-6)
    expect(cfg.trackedTags.find((t) => t.label === 'Ramen')).toMatchObject({ isLens: true, collects: false });
    expect(cfg.trackedTags.filter((t) => t.isLens !== undefined || t.collects !== undefined).map((t) => t.label)).toEqual(['Ramen']);
    expect(cfg.ignoredKeywords).toEqual(['crypto']);
    expect(cfg.intelligence).toBeUndefined();
    expect(cfg.sites.some((s) => s.domain === 'twitter.com')).toBe(false);
    expect(cfg.sites.some((s) => s.domain === 'x.com')).toBe(true);

    // The panel renders the migrated profile without errors.
    const { page: panel, logs } = await openPanel(ext, { tab: 'stream' });
    await waitForSystem1(panel);
    // System 1 decides the legacy items: the ones that do not match the prompt are hidden, never
    // deleted; the favourite is never hidden.
    stack = await waitForStack(sw, (s) => s.length === 4 && s.every((i) => i.decision && Array.isArray(i.decision.path)), 120000);
    console.log('[migration] decided', JSON.stringify(stack.map((i) => ({ id: i.id, p: i.decision.pMatch, path: i.decision.path, hidden: !!i.hiddenByPrompt }))));
    expect(stack.map((i) => i.id)).toEqual(['item_1', 'item_1_2', 'item_3', 'item_3_2']);
    for (const item of stack) expect(item.decision.path).toContain('system1');
    const weather = stack.find((i) => i.id === 'item_3');
    expect(weather.hiddenByPrompt).toBe(true);
    expect(stack.find((i) => i.id === 'item_1').hiddenByPrompt).toBeFalsy();
    const visible = stack.filter((i) => !i.hiddenByPrompt).length;
    await expect(panel.locator('#stream-list .item-row')).toHaveCount(visible);
    await expect(panel.locator('#hidden-pill-label')).toHaveText(`Hidden by prompt (${4 - visible})`);
    await expect(panel.locator('.filter-pill[data-category="Favorites"] .pill-count')).toHaveText('1');
    expect(pageErrors(logs)).toEqual([]);

    // The posts are seen again on the feed: the migrated items are updated in place (same ids,
    // canonical keys), the glued text is replaced by the post's own text, no duplicates.
    const feedPosts = [
      { urn: URN(2), text: goldenText('food-20').slice(0, 1500), author: 'Ana Pereira', authorSlug: 'ana-pereira' },
      { urn: URN(4), text: goldenText('food-17'), author: 'Chef Mara', authorSlug: 'chef-mara' }
    ];
    await servePages(ext.context, { 'https://www.linkedin.com/feed/': linkedinFeedHtml(feedPosts) });
    const feed = await ext.context.newPage();
    const feedLogs = collectConsole(feed);
    await feed.goto('https://www.linkedin.com/feed/');
    await waitDecided(feed, feedPosts.map((p) => `li:${p.urn}`));
    stack = await waitForStack(sw, (s) => s.filter((i) => String(i.postKey).startsWith('li:')).length === 2, 60000);
    expect(stack).toHaveLength(4);
    const healedGlued = stack.find((i) => i.postKey === `li:${URN(2)}`);
    expect(healedGlued.id).toBe('item_1_2');
    expect(healedGlued.textSnippet.length).toBeLessThanOrEqual(2000);
    expect(norm(healedGlued.textSnippet)).toBe(norm(`Post by: Ana Pereira\n\n${feedPosts[0].text}`));
    expect(norm(healedGlued.textSnippet)).not.toContain(norm(goldenText('tag-jobs-01').slice(0, 60)));
    expect(healedGlued.suspectMerged).toBeUndefined();
    expect(healedGlued.legacy).toBeUndefined();
    const chef = stack.find((i) => i.postKey === `li:${URN(4)}`);
    expect(chef.id).toBe('item_3_2');
    expect(chef.legacy).toBeUndefined();
    expect(new Set(stack.map((i) => i.id)).size).toBe(4);
    expect(pageErrors(feedLogs)).toEqual([]);
  } finally {
    await ext.close();
  }
});
