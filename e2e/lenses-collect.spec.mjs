// The per-prompt collect switch end to end (DEC-6 and its 02:27 / 02:58 addenda), in a real browser
// with the real System 1: a prompt the user wrote as a tag ("lens") either collects the posts that
// match it (collects: true, the default) or only labels and sorts (collects: false). The gate is on
// whenever at least one prompt collects (the master prompt counts only while its own switch is on);
// with none collecting, every post is collected. Built-in tags never gate.
//
// Written by the Testing seat's team (called by the CEO, Testing away) for the lens re-pins.
// Posts come from eval/golden/posts.synthetic.jsonl; scores are System 1's own (no escalation).
import { test, expect } from '@playwright/test';
import { launchWithExtension, seed, servePages, waitForStack, waitDecided, waitForStartup, readConfig, annotations, RESTAURANT_PROMPT } from './helpers/ext.mjs';
import { linkedinFeedHtml, goldenText, urnFor, keyFor } from './helpers/feeds.mjs';

const FEED = 'https://www.linkedin.com/feed/';
const FOOD = ['food-02', 'food-17'];
const OTHER = ['tag-weather-03', 'tag-sports-01'];
const IDS = [...FOOD, ...OTHER];
const COOKING = (extra = {}) => ({
  id: 't_cooking',
  label: 'Cooking',
  prompt: RESTAURANT_PROMPT, // the prompt s1.spec.mjs / cascade.spec.mjs score food posts ~0.98 with
  isEnabled: true,
  isLens: true,
  ...extra
});
const SPORTS = (extra = {}) => ({
  id: 't_sports',
  label: 'Football',
  prompt: 'Find posts about football, soccer matches, goals and cup finals.',
  isEnabled: true,
  isLens: true,
  ...extra
});

test('master off, one collecting prompt: the feed is filtered to what that prompt matches, and the match is labelled', async () => {
  test.setTimeout(300000);
  const ext = await launchWithExtension();
  try {
    const sw = ext.serviceWorker;
    const posts = IDS.map((id, i) => ({ urn: urnFor(310, i), text: goldenText(id) }));
    const keyOf = Object.fromEntries(IDS.map((id, i) => [id, keyFor(posts[i].urn)]));
    await servePages(ext.context, { [FEED]: linkedinFeedHtml(posts) });
    await waitForStartup(sw);
    const config = await readConfig(sw);
    await seed(sw, {
      configuration: { matchPrompt: '', isMatchPromptEnabled: false, trackedTags: [...config.trackedTags, COOKING()] },
      intelligence: { escalation: { provider: 'none' } }
    });
    const page = await ext.context.newPage();
    await page.goto(FEED);
    await waitDecided(page, Object.values(keyOf));
    const stack = await waitForStack(sw, (s) => s.length === FOOD.length);
    const byKey = Object.fromEntries(stack.map((i) => [i.postKey, i]));
    console.log('[lenses on]', JSON.stringify(IDS.map((id) => [id, byKey[keyOf[id]]?.decision?.lenses ?? null, byKey[keyOf[id]]?.assignedTag ?? null])));
    for (const id of FOOD) {
      const item = byKey[keyOf[id]];
      expect(item, id).toBeTruthy();
      expect(item.decision.collect, id).toBe(true);
      expect(item.decision.lenses.t_cooking, id).toBeGreaterThanOrEqual(0.5);
      expect(item.assignedTag, id).toBe('Cooking');
    }
    for (const id of OTHER) expect(byKey[keyOf[id]], id).toBeUndefined();
    const status = await annotations(page, OTHER.map((id) => keyOf[id]));
    expect(status.map((a) => a.status)).toEqual(['rejected', 'rejected']);
    // nothing else got in, even after a settle
    await new Promise((r) => setTimeout(r, 1500));
    expect((await waitForStack(sw, () => true)).length).toBe(FOOD.length);
  } finally {
    await ext.context.close();
  }
});

test('master off, the only prompt has collects off: nothing is filtered (every post collected) and the prompt still labels and scores', async () => {
  test.setTimeout(300000);
  const ext = await launchWithExtension();
  try {
    const sw = ext.serviceWorker;
    const posts = IDS.map((id, i) => ({ urn: urnFor(320, i), text: goldenText(id) }));
    const keyOf = Object.fromEntries(IDS.map((id, i) => [id, keyFor(posts[i].urn)]));
    await servePages(ext.context, { [FEED]: linkedinFeedHtml(posts) });
    await waitForStartup(sw);
    const config = await readConfig(sw);
    await seed(sw, {
      configuration: { matchPrompt: '', isMatchPromptEnabled: false, trackedTags: [...config.trackedTags, COOKING({ collects: false })] },
      // whenUnsure 'skip' so a gate wrongly left on with nothing collecting rejects, instead of collecting through whenUnsure
      intelligence: { escalation: { provider: 'none' }, gate: { whenUnsure: 'skip' } }
    });
    const page = await ext.context.newPage();
    await page.goto(FEED);
    await waitDecided(page, Object.values(keyOf));
    const stack = await waitForStack(sw, (s) => s.length === IDS.length);
    const byKey = Object.fromEntries(stack.map((i) => [i.postKey, i]));
    console.log('[lenses off]', JSON.stringify(IDS.map((id) => [id, byKey[keyOf[id]].decision.lenses, byKey[keyOf[id]].assignedTag])));
    for (const id of IDS) expect(byKey[keyOf[id]].decision.collect, id).toBe(true);
    // still a lens: every post is scored, the food posts high and the others low...
    for (const id of FOOD) expect(byKey[keyOf[id]].decision.lenses.t_cooking, id).toBeGreaterThanOrEqual(0.5);
    for (const id of OTHER) expect(byKey[keyOf[id]].decision.lenses.t_cooking, id).toBeLessThan(0.5);
    // ...and still a label
    for (const id of FOOD) expect(byKey[keyOf[id]].assignedTag, id).toBe('Cooking');
    for (const id of OTHER) expect(byKey[keyOf[id]].assignedTag, id).not.toBe('Cooking');
  } finally {
    await ext.context.close();
  }
});

test('master on with a collecting prompt, a second prompt with collects off: a post only the sort-only prompt matches is not collected', async () => {
  test.setTimeout(300000);
  const ext = await launchWithExtension();
  try {
    const sw = ext.serviceWorker;
    const posts = IDS.map((id, i) => ({ urn: urnFor(330, i), text: goldenText(id) }));
    const keyOf = Object.fromEntries(IDS.map((id, i) => [id, keyFor(posts[i].urn)]));
    await servePages(ext.context, { [FEED]: linkedinFeedHtml(posts) });
    await waitForStartup(sw);
    const config = await readConfig(sw);
    await seed(sw, {
      configuration: {
        matchPrompt: RESTAURANT_PROMPT,
        isMatchPromptEnabled: true,
        promptVersion: 1,
        trackedTags: [...config.trackedTags, SPORTS({ collects: false })]
      },
      intelligence: { escalation: { provider: 'none' } }
    });
    const page = await ext.context.newPage();
    await page.goto(FEED);
    await waitDecided(page, Object.values(keyOf));
    const stack = await waitForStack(sw, (s) => s.length === FOOD.length);
    const byKey = Object.fromEntries(stack.map((i) => [i.postKey, i]));
    console.log('[lenses mixed]', JSON.stringify(IDS.map((id) => [id, byKey[keyOf[id]]?.decision?.pMatch ?? null, byKey[keyOf[id]]?.decision?.lenses ?? null])));
    // collected through the master prompt, scored on both prompts
    for (const id of FOOD) {
      expect(byKey[keyOf[id]], id).toBeTruthy();
      expect(Object.keys(byKey[keyOf[id]].decision.lenses).sort(), id).toEqual(['main', 't_sports']);
    }
    // the football post matches only the sort-only prompt: it never collects
    expect(byKey[keyOf['tag-sports-01']]).toBeUndefined();
    expect((await annotations(page, [keyOf['tag-sports-01']]))[0].status).toBe('rejected');
  } finally {
    await ext.context.close();
  }
});

test('master on with a collecting prompt, CONTROL, the same second prompt with collects on: the post only it matches is collected', async () => {
  test.setTimeout(300000);
  const ext = await launchWithExtension();
  try {
    const sw = ext.serviceWorker;
    const posts = IDS.map((id, i) => ({ urn: urnFor(340, i), text: goldenText(id) }));
    const keyOf = Object.fromEntries(IDS.map((id, i) => [id, keyFor(posts[i].urn)]));
    await servePages(ext.context, { [FEED]: linkedinFeedHtml(posts) });
    await waitForStartup(sw);
    const config = await readConfig(sw);
    await seed(sw, {
      configuration: {
        matchPrompt: RESTAURANT_PROMPT,
        isMatchPromptEnabled: true,
        promptVersion: 1,
        trackedTags: [...config.trackedTags, SPORTS({ collects: true })]
      },
      intelligence: { escalation: { provider: 'none' } }
    });
    const page = await ext.context.newPage();
    await page.goto(FEED);
    await waitDecided(page, Object.values(keyOf));
    const stack = await waitForStack(sw, (s) => s.length === FOOD.length + 1);
    const byKey = Object.fromEntries(stack.map((i) => [i.postKey, i]));
    console.log('[lenses mixed]', JSON.stringify(IDS.map((id) => [id, byKey[keyOf[id]]?.decision?.pMatch ?? null, byKey[keyOf[id]]?.decision?.lenses ?? null])));
    expect(byKey[keyOf['tag-sports-01']], 'tag-sports-01').toBeTruthy();
    expect(byKey[keyOf['tag-sports-01']].decision.lenses.t_sports).toBeGreaterThanOrEqual(0.5);
    expect(byKey[keyOf['tag-sports-01']].decision.lenses.main).toBeLessThan(0.5);
    expect(byKey[keyOf['tag-weather-03']]).toBeUndefined();
  } finally {
    await ext.context.close();
  }
});
