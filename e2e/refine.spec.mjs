// Idle multi-model refinement end to end: posts collected with System 1 (MiniLM) are refined by the
// second bundled model (BGE small, loaded next to MiniLM in the offscreen document) when a pass runs.
// The pass is started with REFINE_NOW from the side panel (the "Refine now" button), the same code
// path chrome.idle's 'idle' state takes. Also checks that loading the bundled models no longer makes
// Transformers.js warn about a missing Content-Length (models/manifest.json + offscreen/model-fetch.js).
import { test, expect } from '@playwright/test';
import {
  launchWithExtension, seed, servePages, waitForStack, readStack, waitDecided, sendFromPage, pageErrors, collectConsole,
  swPoll, RESTAURANT_PROMPT
} from './helpers/ext.mjs';
import { linkedinFeedHtml, goldenText, urnFor, keyFor } from './helpers/feeds.mjs';

const FEED = 'https://www.linkedin.com/feed/';
const FOOD = ['food-06', 'food-15', 'food-17'];
const OTHER = ['ff-01', 'tag-weather-02'];

test('collected posts are refined with both bundled models and the panel shows the refine status', async () => {
  test.setTimeout(480000);
  const ext = await launchWithExtension();
  try {
    const sw = ext.serviceWorker;
    const posts = [...FOOD, ...OTHER].map((id, i) => ({ urn: urnFor(131, i), text: goldenText(id) }));
    const keys = posts.map((p) => keyFor(p.urn));
    await servePages(ext.context, { [FEED]: linkedinFeedHtml(posts) });
    await seed(sw, {
      configuration: { matchPrompt: RESTAURANT_PROMPT, isMatchPromptEnabled: true, promptVersion: 1 },
      intelligence: { escalation: { provider: 'none' } }
    });

    const page = await ext.context.newPage();
    await page.goto(FEED);
    await waitDecided(page, keys);
    const collected = await waitForStack(sw, (s) => s.length >= FOOD.length);
    expect(collected).toHaveLength(FOOD.length);
    for (const item of collected) {
      expect(item.decision.path).toEqual(['system1']);
      expect(item.decision.refined).toBeUndefined();
    }

    // The side panel's Settings › Intelligence: the toggle is on by default with a status line.
    const panel = await ext.context.newPage();
    const logs = collectConsole(panel);
    await panel.goto(`chrome-extension://${ext.extensionId}/sidepanel.html`);
    await panel.waitForSelector('#intelligence-root .intel', { state: 'attached', timeout: 30000 });
    await panel.locator('#engine-badge').click();
    await expect(panel.locator('#intel-refine')).toBeVisible();
    await expect(panel.locator('#refine-title')).toHaveText('Refine collected posts when idle (second model + on-device AI)');
    await expect(panel.locator('#refine-enabled')).toBeChecked();
    await expect(panel.locator('#refine-status')).toHaveText(/Refined 0 of 3|Waiting for idle/, { timeout: 30000 });

    // Run a pass now (as chrome.idle reporting 'idle' would).
    await panel.locator('#refine-now').click();
    const refined = await waitForStack(sw, (s) => s.length === FOOD.length && s.every((i) => i.decision && i.decision.refined), 300000);
    for (const item of refined) {
      expect(item.decision.refined.models).toEqual(['minilm', 'bge-small']);
      expect(item.decision.refined.nano).toBe(false);
      expect(item.decision.path).toEqual(['system1', 'ensemble']);
      expect(item.decision.provider).toBe('ensemble');
      // Clear food posts stay matches for both models.
      expect(item.decision.collect).toBe(true);
      expect(item.decision.pMatch).toBeGreaterThan(0.5);
      expect(item.hiddenByPrompt).toBeFalsy();
    }
    console.log('[refine] decisions', JSON.stringify(refined.map((i) => ({ p: i.decision.pMatch, tag: i.decision.tag, agree: i.decision.refined.agreement }))));
    // Never deleted, same ids.
    expect(refined.map((i) => i.id).sort()).toEqual(collected.map((i) => i.id).sort());

    await expect(panel.locator('#refine-status')).toHaveText(/^Refined 3 of 3 · last run/, { timeout: 30000 });
    const diag = await sendFromPage(panel, 'GET_DIAGNOSTICS');
    expect(diag.refine).toMatchObject({ enabled: true, refined: 3, total: 3, counters: { refined: 3, nanoCalls: 0 } });
    expect(diag.providers.system1).toMatchObject({ model: 'minilm', state: 'ready' });
    expect(diag.providers.system1.secondaryCalls).toBeGreaterThanOrEqual(1);

    // The offscreen document: the active model is still MiniLM, BGE was only the secondary model,
    // and no "Unable to determine content-length" warning was logged while loading either.
    const ping = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'OFFSCREEN_PING', target: 'offscreen', requestId: 'e2e' }));
    expect(ping.s1).toMatchObject({ model: 'minilm', state: 'ready' });
    console.log('[refine] offscreen warnings', JSON.stringify(ping.consoleWarnings));
    expect(ping.consoleWarnings.filter((w) => /content-length/i.test(w.text))).toEqual([]);

    // A second pass has nothing left to do.
    await sendFromPage(panel, 'REFINE_NOW');
    await swPoll(sw, async () => true);
    const after = await readStack(sw);
    expect(after.map((i) => i.decision.refined.at)).toEqual(refined.map((i) => i.decision.refined.at));
    expect(pageErrors(logs)).toEqual([]);
  } finally {
    await ext.close();
  }
});
