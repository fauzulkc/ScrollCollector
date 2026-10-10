// Gemini Nano (the browser's built-in LanguageModel) with a fake LanguageModel injected into the
// service worker and the side panel (headless Chrome for Testing has no usable Nano): the panel's
// Download / enable button drives the download from a click and shows its progress 0 -> 50 -> 100 %,
// the service worker follows through NANO_DOWNLOAD_STATE, and once Nano is ready the posts System 1
// is unsure about are answered by Nano.
import { test, expect } from '@playwright/test';
import {
  launchWithExtension, seed, servePages, openPanel, waitForStack, waitForStartup, waitDecided, annotations,
  sendFromPage, installFakeLanguageModel, RESTAURANT_PROMPT
} from './helpers/ext.mjs';
import { linkedinFeedHtml, urnFor, keyFor, SHORT_POSTS } from './helpers/feeds.mjs';

const FEED = 'https://www.linkedin.com/feed/';

test('the Nano download shows its progress, the service worker follows, and Nano answers the unsure posts', async () => {
  test.setTimeout(300000);
  const ext = await launchWithExtension();
  try {
    const sw = ext.serviceWorker;
    await waitForStartup(sw);
    // The service worker sees the same (fake) model: downloadable until the panel's download ends.
    await sw.evaluate(installFakeLanguageModel, { availability: 'downloadable' });
    // Nano is the escalation provider; a prompt floor of 1 makes every post unsure.
    await seed(sw, {
      configuration: { matchPrompt: RESTAURANT_PROMPT, isMatchPromptEnabled: true, promptVersion: 1 },
      intelligence: { escalation: { provider: 'nano', floor: { matches_prompt: 1, primary_tag: 0 } } }
    });
    const { page: panel } = await openPanel(ext, { initScripts: [[installFakeLanguageModel, { availability: 'downloadable' }]], tab: 'settings' });
    const engine = () => sendFromPage(panel, 'GET_ENGINE_STATUS');
    // The worker checked availability when it started (before the model was downloadable): the
    // panel's own probe shows the Download button anyway, and an open panel makes the worker
    // re-check (GET_ENGINE_STATUS, at most once per availability TTL).
    await expect(panel.locator('#nano-pill .status-pill-text')).toHaveText('Not downloaded');
    const button = panel.locator('#nano-download');
    await expect(button).toBeVisible();
    await expect.poll(async () => (await engine()).nano.state, { timeout: 30000 }).toBe('downloadable');
    expect((await engine()).escalation).toMatchObject({ provider: 'nano', status: { state: 'downloadable' } });

    // The click starts LanguageModel.create() with a download monitor.
    await button.click();
    // While the panel downloads, Chrome reports 'downloading' to every context.
    await sw.evaluate(() => { globalThis.__fakeLM.availability = 'downloading'; });
    await expect(button).toHaveText('Downloading…');
    await expect(button).toBeDisabled();
    expect(await panel.evaluate(() => window.__fakeLM.creates)).toBe(1);

    const progress = panel.locator('#nano-progress');
    for (const [loaded, pct] of [[0, 0], [0.5, 50], [1, 100]]) {
      await panel.evaluate((l) => window.__fakeLM.download.progress(l), loaded);
      await expect(panel.locator('#nano-pill .status-pill-text')).toHaveText(`Downloading ${pct}%`);
      await expect(progress).toBeVisible();
      await expect(progress).toHaveAttribute('aria-valuenow', String(pct));
      // The service worker follows the panel (NANO_DOWNLOAD_STATE progress).
      await expect.poll(async () => {
        const s = await engine();
        return `${s.nano.state}:${s.nano.progress}`;
      }, { timeout: 15000 }).toBe(`downloading:${loaded}`);
    }

    // The download finishes: Chrome makes the model available to the service worker as well.
    await sw.evaluate(() => { globalThis.__fakeLM.availability = 'available'; });
    await panel.evaluate(() => window.__fakeLM.download.finish());
    await expect(panel.locator('#nano-pill .status-pill-text')).toHaveText('Ready', { timeout: 15000 });
    await expect(progress).toBeHidden();
    await expect(button).toBeHidden();
    await expect(panel.locator('.toast-region .toast').filter({ hasText: 'Gemini Nano is ready.' })).toBeVisible();
    await expect.poll(async () => (await engine()).nano.state, { timeout: 15000 }).toBe('ready');
    expect((await engine()).escalation).toMatchObject({ provider: 'nano', status: { state: 'ready' } });
    await expect(panel.locator('#esc-hint')).toHaveText('Uncertain posts are checked again by Gemini Nano, on this device.');

    // The provider test prompts the service worker's model once.
    const t = await sendFromPage(panel, 'TEST_PROVIDER', { provider: 'nano' });
    expect(t).toMatchObject({ success: true, ok: true });

    // Unsure posts are answered by Nano, on the device.
    const posts = [0, 1, 4, 5].map((i, n) => ({ urn: urnFor(401, n), text: SHORT_POSTS[i].text, food: SHORT_POSTS[i].food }));
    const keys = posts.map((p) => keyFor(p.urn));
    await servePages(ext.context, { [FEED]: linkedinFeedHtml(posts) });
    const callsBefore = await sw.evaluate(() => globalThis.__fakeLM.calls.length);
    const page = await ext.context.newPage();
    await page.goto(FEED);
    await waitDecided(page, keys);
    const ann = await annotations(page, keys);
    console.log('[nano] annotations', JSON.stringify(ann));
    expect(ann.map((a) => a.status)).toEqual(['collected', 'collected', 'rejected', 'rejected']);
    expect(ann[2].reason).toBe('nano_no_match');
    expect(ann[3].reason).toBe('nano_no_match');

    const stack = await waitForStack(sw, (s) => s.length === 2);
    for (const item of stack) {
      expect(item.decision).toMatchObject({ escalated: true, provider: 'nano', path: ['system1', 'nano'], pMatch: 0.93, collect: true });
    }
    const calls = (await sw.evaluate(() => globalThis.__fakeLM.calls)).slice(callsBefore);
    // One prompt per unsure post, with the prompt question only (the tag floor is 0).
    expect(calls.length).toBe(4);
    for (const c of calls) expect(c.keys).toEqual(['matches_prompt']);
    const diag = await sendFromPage(panel, 'GET_DIAGNOSTICS');
    expect(diag.engineStatus.counters.escalated).toBeGreaterThanOrEqual(4);
    expect(diag.providers.nano.calls).toBeGreaterThanOrEqual(4);
  } finally {
    await ext.close();
  }
});

test('a failed Nano download is reported and Nano stays off the decision path', async () => {
  test.setTimeout(240000);
  const ext = await launchWithExtension();
  try {
    const sw = ext.serviceWorker;
    await waitForStartup(sw);
    await sw.evaluate(installFakeLanguageModel, { availability: 'downloadable' });
    await seed(sw, { intelligence: { escalation: { provider: 'nano' } } });
    const { page: panel } = await openPanel(ext, { initScripts: [[installFakeLanguageModel, { availability: 'downloadable' }]], tab: 'settings' });
    await expect(panel.locator('#nano-download')).toBeVisible({ timeout: 30000 });
    await panel.locator('#nano-download').click();
    await panel.evaluate(() => window.__fakeLM.download.progress(0.25));
    await expect(panel.locator('#nano-pill .status-pill-text')).toHaveText('Downloading 25%');
    await panel.evaluate(() => window.__fakeLM.download.fail('Not enough disk space.'));
    await expect(panel.locator('#nano-error')).toContainText('Not enough disk space.');
    await expect(panel.locator('.toast-region .toast').filter({ hasText: 'Gemini Nano could not be enabled' })).toBeVisible();
    await expect(panel.locator('#nano-download')).toBeVisible();
    await expect(panel.locator('#nano-download')).toBeEnabled();
    const s = await sendFromPage(panel, 'GET_ENGINE_STATUS');
    expect(s.nano.state).toBe('downloadable');
    expect(s.nano.lastError).toContain('Not enough disk space.');
    // Not ready: the escalation provider is reported unusable (System 1's answer is kept).
    expect(s.escalation).toMatchObject({ provider: 'nano', status: { state: 'downloadable' } });
  } finally {
    await ext.close();
  }
});
