// Data integrity end to end: a burst of 25 posts (one infinite-scroll mutation) becomes 25 items
// with unique ids, no text over 2000 characters and no text glued from two posts; a "…more"
// expansion updates its one item in place; a reshare is one item. Texts come from
// eval/golden/posts.synthetic.jsonl (no prompt filter: every post is collected).
import { test, expect } from '@playwright/test';
import { launchWithExtension, seed, servePages, waitForStack, waitDecided, annotations, readStack } from './helpers/ext.mjs';
import { linkedinFeedHtml, appendPosts, goldenText, urnFor, keyFor } from './helpers/feeds.mjs';

const FEED = 'https://www.linkedin.com/feed/';
const MAX_TEXT = 2000;

// 25 distinct texts; three are longer than 2000 characters.
const BURST = [
  'food-01', 'food-02', 'food-03', 'food-14', 'food-20', 'tag-opinion-02', 'tag-blog-02', 'tag-jobs-01',
  'tag-weather-01', 'tag-weather-02', 'tag-politics-01', 'tag-politics-02', 'tag-tech-01', 'tag-tech-02',
  'tag-sports-01', 'tag-sports-02', 'tag-health-02', 'tag-health-03', 'tag-news-01', 'tag-news-02',
  'tag-ent-01', 'tag-promo-01', 'tag-portfolio-01', 'tag-immigration-01', 'tag-migration-01'
];

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
/** Trailing "… more" / "See more" labels: content.js strips them (some golden texts end with one). */
const MORE_MARKER_RE = /(?:\s*(?:…|\.{3})\s*(?:(?:see|show|read)\s+)?more|(?:^|\s+)(?:see|show|read)\s+(?:more|less))\s*$/i;

/** The text content.js sends for fixture post `i` (actor line + body, expander label stripped). */
function expectedText(i, text) {
  let body = String(text).trim();
  for (let n = 0; n < 3; n++) body = body.replace(MORE_MARKER_RE, '').trim();
  return norm(`Post by: Person ${i}\n\n${body}`);
}

/** Opens an empty feed (the posts arrive later, like infinite scroll). */
async function emptyFeed(ext) {
  await servePages(ext.context, { [FEED]: linkedinFeedHtml([]) });
  const page = await ext.context.newPage();
  await page.goto(FEED);
  // The content script is configured and observing (no posts yet).
  await page.waitForTimeout(1500);
  return page;
}

test('a burst of 25 posts becomes 25 items: unique ids, nothing over 2000 characters, nothing glued', async () => {
  test.setTimeout(300000);
  const ext = await launchWithExtension();
  try {
    const sw = ext.serviceWorker;
    await seed(sw, { configuration: { isMatchPromptEnabled: false, matchPrompt: '' }, intelligence: { escalation: { provider: 'none' } } });
    const page = await emptyFeed(ext);

    const posts = BURST.map((id, i) => ({ urn: urnFor(501, i), text: goldenText(id) }));
    const keys = posts.map((p) => keyFor(p.urn));
    await appendPosts(page, posts, 0);
    await waitDecided(page, keys);
    expect((await annotations(page, keys)).every((a) => a.status === 'collected')).toBe(true);

    const stack = await waitForStack(sw, (s) => s.length >= 25);
    // Give late duplicates a chance to show up.
    await page.waitForTimeout(1500);
    const final = await readStack(sw);
    expect(final).toHaveLength(25);
    expect(new Set(final.map((i) => i.id)).size).toBe(25);
    expect(new Set(final.map((i) => i.postKey)).size).toBe(25);
    expect(final.map((i) => i.postKey).sort()).toEqual([...keys].sort());

    const bodies = posts.map((p) => norm(p.text));
    for (const item of final) {
      const i = keys.indexOf(item.postKey);
      const text = item.textSnippet;
      expect(text.length, item.postKey).toBeLessThanOrEqual(MAX_TEXT);
      // No concatenation: the item holds its own post and no other post's text.
      const others = bodies.filter((b, j) => j !== i && norm(text).includes(b.slice(0, 80)));
      expect(others, `${item.postKey} contains another post`).toEqual([]);
      const expected = expectedText(i, posts[i].text);
      if (expected.length <= MAX_TEXT) {
        expect(norm(text), item.postKey).toBe(expected);
      } else {
        // Over 2000 characters: cut at a word boundary with an ellipsis, never padded with more text.
        expect(text.endsWith('…'), item.postKey).toBe(true);
        expect(expected.startsWith(norm(text.slice(0, -1))), item.postKey).toBe(true);
      }
      expect(item.sourceUrl).toBe(`https://www.linkedin.com/feed/update/${posts[i].urn}/`);
      expect(item.authorName).toBe(`Person ${i}`);
      expect(item.decision).toMatchObject({ collect: true, path: ['system1'] });
    }
    expect(final.filter((i) => i.textSnippet.endsWith('…'))).toHaveLength(3);
    // Telemetry counted every post once.
    const telemetry = await sw.evaluate(async () => (await chrome.storage.local.get('telemetry')).telemetry);
    expect(telemetry.totalProcessed).toBe(25);
  } finally {
    await ext.close();
  }
});

test('"…more" updates its one item in place and a reshare is one item', async () => {
  test.setTimeout(240000);
  const ext = await launchWithExtension();
  try {
    const sw = ext.serviceWorker;
    await seed(sw, { configuration: { isMatchPromptEnabled: false, matchPrompt: '' }, intelligence: { escalation: { provider: 'none' } } });
    const longText = goldenText('food-14'); // 1915 characters
    const reshared = goldenText('tag-weather-03');
    const posts = [
      { urn: urnFor(502, 0), text: longText, truncateAt: 220 },
      {
        urn: urnFor(502, 1),
        text: 'Worth reading before the weekend, especially if you are heading out to the coast.',
        reshare: { urn: urnFor(502, 9), text: reshared, author: 'Bay Area Weather Desk' }
      }
    ];
    const keys = posts.map((p) => keyFor(p.urn));
    await servePages(ext.context, { [FEED]: linkedinFeedHtml(posts) });
    const page = await ext.context.newPage();
    await page.goto(FEED);
    await waitDecided(page, keys);

    let stack = await waitForStack(sw, (s) => s.length === 2);
    const truncated = stack.find((i) => i.postKey === keys[0]);
    expect(norm(truncated.textSnippet)).toBe(norm(`Post by: Person 0 ${longText.slice(0, 220)}`));
    const id = truncated.id;

    // The reshare: ONE item for the resharing post, carrying the original as a quote; no item for
    // the embedded original's own URN.
    const reshare = stack.find((i) => i.postKey === keys[1]);
    expect(reshare.textSnippet).toContain('Worth reading before the weekend');
    expect(reshare.textSnippet).toContain('Reshared from Bay Area Weather Desk:');
    expect(norm(reshare.textSnippet)).toContain(norm(reshared));
    expect(stack.some((i) => i.postKey === keyFor(urnFor(502, 9)))).toBe(false);
    expect(reshare.authorName).toBe('Person 1');

    // "…more": the full text replaces the truncated one in the same item (same id, same key).
    await page.locator(`[data-urn="${posts[0].urn}"] .see-more`).click();
    stack = await waitForStack(sw, (s) => norm(s.find((i) => i.postKey === keys[0])?.textSnippet).length > 1000, 60000);
    await page.waitForTimeout(1500);
    stack = await readStack(sw);
    expect(stack).toHaveLength(2);
    const expanded = stack.find((i) => i.postKey === keys[0]);
    expect(expanded.id).toBe(id);
    expect(norm(expanded.textSnippet)).toBe(expectedText(0, longText));
    expect(expanded.textSnippet.length).toBeLessThanOrEqual(MAX_TEXT);
    expect((await annotations(page, keys)).map((a) => a.status)).toEqual(['collected', 'collected']);
    const telemetry = await sw.evaluate(async () => (await chrome.storage.local.get('telemetry')).telemetry);
    expect(telemetry.totalProcessed).toBe(2);
  } finally {
    await ext.close();
  }
});
