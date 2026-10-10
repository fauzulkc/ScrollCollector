// Tags end to end: System 1 assigns the primary tag of each collected post (the 25 default tags),
// Unclassified when no tag fits, the panel shows them, and adding a tag re-decides the stack.
// Texts come from eval/golden/posts.synthetic.jsonl and test/fixtures/linkedin-feed.html.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchWithExtension, seed, servePages, openPanel, waitForStack, waitDecided, annotations, annotationDetails, ROOT } from './helpers/ext.mjs';
import { linkedinFeedHtml, goldenText, urnFor, keyFor } from './helpers/feeds.mjs';

const FEED = 'https://www.linkedin.com/feed/';
// System 1 (MiniLM) primary-tag choices with confidence >= 0.86 (calibrated tag floor 0.3).
const TAGGED = {
  'tag-weather-03': 'Weather',
  'tag-politics-02': 'Politics',
  'tag-immigration-08': 'Immigration',
  'tag-study-01': 'Study',
  'tag-migration-02': 'Migration',
  'tag-sports-01': 'Sports',
  'tag-ngo-02': 'NGO',
  'tag-portfolio-01': 'Portfolio'
};
// System 1 picks 'none' for these: no default tag fits.
const UNTAGGED = ['food-02', 'food-17', 'tag-intl-03'];

test('System 1 assigns tags to collected posts and Unclassified when no tag fits; a new tag re-decides', async () => {
  test.setTimeout(300000);
  const ext = await launchWithExtension();
  try {
    const sw = ext.serviceWorker;
    const ids = [...Object.keys(TAGGED), ...UNTAGGED];
    const posts = ids.map((id, i) => ({ urn: urnFor(201, i), text: goldenText(id) }));
    const keyOf = Object.fromEntries(ids.map((id, i) => [id, keyFor(posts[i].urn)]));
    await servePages(ext.context, { [FEED]: linkedinFeedHtml(posts) });
    // No prompt filter: every post is collected and only tagged.
    await seed(sw, { configuration: { matchPrompt: '', isMatchPromptEnabled: false }, intelligence: { escalation: { provider: 'none' } } });

    const page = await ext.context.newPage();
    await page.goto(FEED);
    await waitDecided(page, Object.values(keyOf));
    const stack = await waitForStack(sw, (s) => s.length === ids.length);
    const byKey = Object.fromEntries(stack.map((i) => [i.postKey, i]));
    console.log('[tags]', JSON.stringify(ids.map((id) => [id, byKey[keyOf[id]].assignedTag, byKey[keyOf[id]].decision.tagConfidence])));

    for (const [id, tag] of Object.entries(TAGGED)) {
      const item = byKey[keyOf[id]];
      expect(item.assignedTag, id).toBe(tag);
      expect(item.decision).toMatchObject({ tag, provider: 'system1', path: ['system1'], collect: true, pMatch: null });
      expect(item.decision.tagConfidence, id).toBeGreaterThanOrEqual(0.3);
      expect(item.tags[0], id).toMatchObject({ name: tag });
    }
    for (const id of UNTAGGED) {
      const item = byKey[keyOf[id]];
      expect(item.assignedTag, id).toBe('Unclassified');
      expect(item.decision.tag).toBe('Unclassified');
    }
    // The content script got the tag too (in its isolated world: the page's scripts never see it).
    const [ann] = await annotationDetails(page, [keyOf['tag-weather-03']]);
    expect(ann.tag).toBe('Weather');
    expect(await page.evaluate((k) => document.querySelector(`[data-sc-key="${k}"]`).hasAttribute('data-sc-tag'), keyOf['tag-weather-03'])).toBe(false);
    // The 'Ads' pseudo-tag is never a classification.
    expect(stack.some((i) => i.assignedTag === 'Ads')).toBe(false);

    // The panel counts the tags in its filter pills; a tag pill filters the feed to its posts.
    const { page: panel } = await openPanel(ext, { tab: 'stream' });
    await expect(panel.locator('#stream-list .item-row')).toHaveCount(ids.length);
    await expect(panel.locator('.filter-pill[data-category="Weather"] .pill-count')).toHaveText('1');
    await expect(panel.locator('.filter-pill[data-category="Unclassified"] .pill-count')).toHaveText(String(UNTAGGED.length));
    await panel.locator('.filter-pill[data-category="Weather"]').click();
    await expect(panel.locator('#stream-list .item-row')).toHaveCount(1);
    await expect(panel.locator('#stream-list .item-row').first()).toHaveAttribute('data-tag', 'Weather');
    await panel.locator('.filter-pill[data-category="All"]').click();

    // Adding a tag re-decides the stack: the food posts System 1 could not tag get the new tag.
    await panel.locator('.tab-btn[data-tab="settings"]').click();
    await panel.locator('#new-tag-input').fill('Food');
    await panel.locator('#new-tag-prompt-input').fill('Identify posts about restaurants, chefs, cooking, dining, recipes or food.');
    await panel.locator('#add-tag-form button[type="submit"]').click();
    const retagged = await waitForStack(sw, (s) => ['food-02', 'food-17'].every((id) => s.find((i) => i.postKey === keyOf[id])?.assignedTag === 'Food'), 120000);
    // The other posts keep their tags; nothing was deleted.
    expect(retagged).toHaveLength(ids.length);
    for (const [id, tag] of Object.entries(TAGGED)) expect(retagged.find((i) => i.postKey === keyOf[id]).assignedTag, id).toBe(tag);
  } finally {
    await ext.close();
  }
});

test('the LinkedIn fixture feed: every post decided by System 1 with a tracked tag or Unclassified', async () => {
  test.setTimeout(240000);
  const ext = await launchWithExtension();
  try {
    const sw = ext.serviceWorker;
    const fixture = fs.readFileSync(path.join(ROOT, 'test/fixtures/linkedin-feed.html'), 'utf8');
    await servePages(ext.context, { [FEED]: fixture });
    await seed(sw, { intelligence: { escalation: { provider: 'none' } } });
    const keys = [
      'li:urn:li:activity:7301000000000000001',
      'li:urn:li:activity:7301000000000000002',
      'li:urn:li:activity:7301000000000000003',
      'li:urn:li:ugcPost:7301000000000000444'
    ];
    const page = await ext.context.newPage();
    await page.goto(FEED);
    await waitDecided(page, keys);
    expect((await annotations(page, keys)).map((a) => a.status)).toEqual(['collected', 'collected', 'collected', 'collected']);
    const stack = await waitForStack(sw, (s) => s.length === 4);
    const config = await sw.evaluate(async () => (await chrome.storage.local.get('configuration')).configuration);
    const labels = new Set(config.trackedTags.filter((t) => t.isEnabled && !t.isPseudo).map((t) => t.label));
    console.log('[tags fixture]', JSON.stringify(stack.map((i) => [i.postKey.slice(-4), i.assignedTag, i.decision.tagConfidence, i.isAd])));
    for (const item of stack) {
      expect(item.decision.path).toEqual(['system1']);
      expect(item.assignedTag === 'Unclassified' || labels.has(item.assignedTag), item.assignedTag).toBe(true);
      expect(item.tags.every((t) => labels.has(t.name))).toBe(true);
    }
    // The promoted post is flagged as an ad (the Ads pill counts it), not tagged 'Ads'.
    const promoted = stack.find((i) => i.postKey.endsWith('444'));
    expect(promoted.isAd).toBe(true);
    expect(promoted.assignedTag).not.toBe('Ads');
  } finally {
    await ext.close();
  }
});
