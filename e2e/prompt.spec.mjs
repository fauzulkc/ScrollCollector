// Prompt respect end to end: the restaurant prompt collects food posts and rejects false friends and
// unrelated posts (System 1, no escalation); a prompt change hides what no longer matches (never
// deletes) and collects the newly matching posts when the page is rescanned; switching the filter
// off shows everything again. Texts come from eval/golden/posts.synthetic.jsonl.
import { test, expect } from '@playwright/test';
import {
  launchWithExtension, seed, servePages, openPanel, waitForStack, readStack, annotations, waitDecided,
  waitAnnotations, pageVisibleDecisions, sendFromPage, pageErrors, collectConsole, RESTAURANT_PROMPT, CODING_PROMPT
} from './helpers/ext.mjs';
import { linkedinFeedHtml, goldenText, urnFor, keyFor } from './helpers/feeds.mjs';

const FEED = 'https://www.linkedin.com/feed/';

// System 1 (MiniLM) p(match) far from the uncertain band (see the eval scores): food >= 0.96,
// false friends / unrelated <= 0.04 for the restaurant prompt; coding posts >= 0.99 for the coding
// prompt, food posts <= 0.006 for it.
const FOOD = ['food-06', 'food-15', 'food-17', 'food-01', 'food-02'];
const FALSE_FRIENDS = ['ff-01', 'ff-06', 'ff-07', 'ff-08', 'ff-13', 'ff-16'];
const UNRELATED = ['tag-weather-02', 'tag-politics-01'];
const CODING = ['tag-tech-05', 'tag-events-02', 'tag-tech-01'];

function feed(ids, series) {
  const posts = ids.map((id, i) => ({ urn: urnFor(series, i), text: goldenText(id) }));
  return { html: linkedinFeedHtml(posts), keys: posts.map((p) => keyFor(p.urn)), byId: Object.fromEntries(ids.map((id, i) => [id, keyFor(posts[i].urn)])) };
}

const NO_ESCALATION = { escalation: { provider: 'none' } };

test('the restaurant prompt collects the food posts and rejects false friends and unrelated posts', async () => {
  test.setTimeout(300000);
  const ext = await launchWithExtension();
  try {
    const f = feed([...FOOD, ...FALSE_FRIENDS, ...UNRELATED], 101);
    await servePages(ext.context, { [FEED]: f.html });
    await seed(ext.serviceWorker, {
      configuration: { matchPrompt: RESTAURANT_PROMPT, isMatchPromptEnabled: true, promptVersion: 1 },
      intelligence: NO_ESCALATION
    });

    const page = await ext.context.newPage();
    const logs = collectConsole(page);
    await page.goto(FEED);
    await waitDecided(page, f.keys);
    const ann = await annotations(page, f.keys);
    console.log('[prompt] annotations', JSON.stringify(ann));

    for (const id of FOOD) expect(ann[f.keys.indexOf(f.byId[id])], id).toMatchObject({ status: 'collected' });
    for (const id of [...FALSE_FRIENDS, ...UNRELATED]) {
      expect(ann[f.keys.indexOf(f.byId[id])], id).toEqual({ status: 'rejected', reason: 'system1_no_match' });
    }

    const stack = await waitForStack(ext.serviceWorker, (s) => s.length >= FOOD.length);
    expect(stack.map((i) => i.postKey).sort()).toEqual(FOOD.map((id) => f.byId[id]).sort());
    for (const item of stack) {
      expect(item.decision).toMatchObject({ collect: true, provider: 'system1', escalated: false, promptVersion: 1 });
      expect(item.decision.path).toEqual(['system1']);
      expect(item.decision.pMatch).toBeGreaterThanOrEqual(0.85);
      expect(item.matchInfo.engine).toBe('System 1 (local embeddings)');
      expect(item.hiddenByPrompt).toBeFalsy();
    }

    // The panel: diagnostics list the rejections (newest first) with System 1 as the decider.
    const { page: panel } = await openPanel(ext);
    const diag = await sendFromPage(panel, 'GET_DIAGNOSTICS');
    expect(diag.rejected.length).toBe(FALSE_FRIENDS.length + UNRELATED.length);
    for (const r of diag.rejected) {
      expect(r).toMatchObject({ reason: 'system1_no_match', path: ['system1'], platform: 'linkedin.com' });
      expect(r.pMatch).toBeLessThan(0.15);
      expect(r.snippet.length).toBeLessThanOrEqual(140);
    }
    await expect(panel.locator('#stream-list .item-row')).toHaveCount(FOOD.length);
    expect(pageErrors(logs)).toEqual([]);
  } finally {
    await ext.close();
  }
});

test('a prompt change hides what no longer matches, collects the new matches on rescan, and filter off un-hides', async () => {
  test.setTimeout(360000);
  const ext = await launchWithExtension();
  try {
    const sw = ext.serviceWorker;
    const f = feed([...FOOD.slice(0, 3), ...CODING, 'tag-weather-02'], 102);
    const foodKeys = FOOD.slice(0, 3).map((id) => f.byId[id]);
    const codingKeys = CODING.map((id) => f.byId[id]);
    const weatherKey = f.byId['tag-weather-02'];
    await servePages(ext.context, { [FEED]: f.html });
    await seed(sw, {
      configuration: { matchPrompt: RESTAURANT_PROMPT, isMatchPromptEnabled: true, promptVersion: 1 },
      intelligence: NO_ESCALATION
    });

    const page = await ext.context.newPage();
    await page.goto(FEED);
    await waitDecided(page, f.keys);
    let ann = await annotations(page, f.keys);
    expect(foodKeys.map((k) => ann[f.keys.indexOf(k)].status)).toEqual(['collected', 'collected', 'collected']);
    expect(codingKeys.map((k) => ann[f.keys.indexOf(k)].status)).toEqual(['rejected', 'rejected', 'rejected']);
    await waitForStack(sw, (s) => s.length === 3);
    const before = await readStack(sw);
    const idsBefore = Object.fromEntries(before.map((i) => [i.postKey, i.id]));

    // Edit the prompt in Settings like a user (explicit Save, then the re-decide).
    const { page: panel } = await openPanel(ext, { tab: 'settings' });
    await panel.evaluate(() => {
      window.__progress = [];
      chrome.runtime.onMessage.addListener((m) => { if (m && m.type === 'REDECIDE_PROGRESS') window.__progress.push(m.payload); });
    });
    await panel.locator('#match-prompt-input').fill(CODING_PROMPT);
    await panel.locator('#match-prompt-input').blur();
    // Leaving the field no longer saves: the prompt applies only on Save.
    await expect(panel.locator('#match-prompt-save')).toBeEnabled();
    await panel.locator('#match-prompt-save').click();

    const after = await waitForStack(sw, (s) => {
      const food = s.filter((i) => foodKeys.includes(i.postKey));
      const coding = s.filter((i) => codingKeys.includes(i.postKey));
      return food.length === 3 && food.every((i) => i.hiddenByPrompt) && coding.length === 3 && coding.every((i) => !i.hiddenByPrompt);
    }, 180000);
    console.log('[prompt change] stack', JSON.stringify(after.map((i) => ({ k: i.postKey.slice(-3), hidden: !!i.hiddenByPrompt, p: i.decision.pMatch, v: i.decision.promptVersion }))));
    // Never deleted: the food items keep their ids; the weather post is still not collected.
    for (const k of foodKeys) expect(after.find((i) => i.postKey === k).id).toBe(idsBefore[k]);
    expect(after.some((i) => i.postKey === weatherKey)).toBe(false);
    const cfg = await sw.evaluate(async () => (await chrome.storage.local.get('configuration')).configuration);
    expect(cfg.matchPrompt).toBe(CODING_PROMPT);
    for (const item of after) {
      expect(item.decision.promptVersion, item.postKey).toBe(cfg.promptVersion);
      if (foodKeys.includes(item.postKey)) expect(item.decision).toMatchObject({ collect: false });
      else expect(item.decision).toMatchObject({ collect: true, provider: 'system1' });
    }
    await panel.waitForFunction(() => window.__progress.some((p) => p.finished && !p.cancelled), null, { timeout: 60000 });

    // The page agrees with the stack once the rescan settled: coding posts collected, food posts
    // reported as hidden by the prompt.
    await waitAnnotations(
      page,
      [...codingKeys, ...foodKeys],
      (list) => list.slice(0, codingKeys.length).every((a) => a.status === 'collected')
        && list.slice(codingKeys.length).every((a) => a.reason === 'hidden_by_prompt'),
      { timeout: 60000 }
    ).catch(async (err) => {
      console.log('[prompt change] annotations', JSON.stringify(await annotations(page, f.keys)));
      throw err;
    });
    // None of it is visible to the page's own scripts.
    expect(await pageVisibleDecisions(page)).toEqual([]);

    // The panel: the hidden pill counts the food posts, the feed shows the coding posts.
    await panel.locator('.tab-btn[data-tab="stream"]').click();
    await expect(panel.locator('#hidden-pill-label')).toHaveText('Hidden by prompt (3)');
    await expect(panel.locator('#stream-list .item-row')).toHaveCount(3);

    // Filter off: everything visible again (no model call), the rejected weather post is collected
    // when the page is rescanned.
    await panel.locator('.tab-btn[data-tab="settings"]').click();
    await panel.locator('label.filter-switch[for="match-prompt-toggle"]').click();
    const off = await waitForStack(sw, (s) => s.length === 7 && s.every((i) => !i.hiddenByPrompt), 120000);
    expect(off.some((i) => i.postKey === weatherKey)).toBe(true);
    await panel.locator('.tab-btn[data-tab="stream"]').click();
    await expect(panel.locator('#hidden-pill')).toBeHidden();
    await expect(panel.locator('#stream-list .item-row')).toHaveCount(7);
    ann = await annotations(page, f.keys);
    expect(ann.every((a) => a.status === 'collected')).toBe(true);
  } finally {
    await ext.close();
  }
});
