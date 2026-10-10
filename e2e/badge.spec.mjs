// The header engine badge against the real service worker: grey "checking" first (never a false
// green), amber while System 1 loads, green when ready; red when the bundled model is broken (posts
// are still collected by the rules); amber when the escalation provider rejects its key.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import {
  launchWithExtension, seed, servePages, openPanel, waitForStack, waitForStartup, waitDecided, sendFromPage,
  recordBadgeLevels, extensionCopy, startMockDecisionServer, RESTAURANT_PROMPT, TEST_JEV_KEY
} from './helpers/ext.mjs';
import { linkedinFeedHtml, urnFor, keyFor, SHORT_POSTS, goldenText } from './helpers/feeds.mjs';

const FEED = 'https://www.linkedin.com/feed/';

test('checking -> loading -> ok, and a model switch shows loading again before ok', async () => {
  test.setTimeout(300000);
  const ext = await launchWithExtension();
  try {
    const { page } = await openPanel(ext, { initScripts: [recordBadgeLevels] });
    await expect(page.locator('#engine-badge')).toHaveAttribute('data-level', 'ok', { timeout: 180000 });
    await expect(page.locator('#engine-label')).toHaveText('Ready');
    let levels = await page.evaluate(() => window.__badgeLevels);
    console.log('[badge] start', JSON.stringify(levels));
    expect(levels[0]).toBe('checking');
    expect(levels.at(-1)).toBe('ok');
    expect(levels.slice(0, levels.indexOf('ok'))).not.toContain('error');

    // Switching the System 1 model (Settings › Intelligence) reloads it: amber, then green again.
    await page.evaluate(() => { window.__badgeLevels = []; });
    await page.locator('.tab-btn[data-tab="settings"]').click();
    await page.locator('#s1-model').selectOption('bge-small');
    await expect.poll(() => page.evaluate(() => window.__badgeLevels.includes('loading')), { timeout: 60000 }).toBe(true);
    await expect(page.locator('#engine-badge')).toHaveAttribute('data-level', 'ok', { timeout: 180000 });
    levels = await page.evaluate(() => window.__badgeLevels);
    console.log('[badge] model switch', JSON.stringify(levels));
    expect(levels.at(-1)).toBe('ok');
    const s = await sendFromPage(page, 'GET_ENGINE_STATUS');
    expect(s.system1).toMatchObject({ state: 'ready', model: 'bge-small' });
    expect(s).toMatchObject({ tier: 1, status: 'ready' });
    await expect(page.locator('#engine-badge')).toHaveAttribute('title', /bge-small/);
  } finally {
    await ext.close();
  }
});

test('a broken bundled model turns the badge red and the rules keep collecting', async () => {
  test.setTimeout(300000);
  // A build whose MiniLM weights are corrupt (the default model).
  const broken = extensionCopy((dir) => {
    const file = path.join(dir, 'models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx');
    fs.writeFileSync(file, Buffer.from('this is not an onnx model'));
  });
  const ext = await launchWithExtension({ extDir: broken.dir });
  try {
    const sw = ext.serviceWorker;
    await waitForStartup(sw);
    await seed(sw, { configuration: { isMatchPromptEnabled: false, matchPrompt: '' }, intelligence: { escalation: { provider: 'none' } } });
    const { page } = await openPanel(ext, { initScripts: [recordBadgeLevels] });
    await expect(page.locator('#engine-badge')).toHaveAttribute('data-level', 'error', { timeout: 180000 });
    await expect(page.locator('#engine-label')).toHaveText('Model error');
    await expect(page.locator('#engine-badge')).toHaveAttribute('title', /Posts are decided by rules only/);
    const levels = await page.evaluate(() => window.__badgeLevels);
    console.log('[badge] broken', JSON.stringify(levels));
    expect(levels[0]).toBe('checking');
    expect(levels).not.toContain('ok');
    const s = await sendFromPage(page, 'GET_ENGINE_STATUS');
    expect(s.system1.state).toBe('error');
    expect(s).toMatchObject({ tier: 3, status: 'error' });
    // Settings shows the failure and offers a retry.
    await page.locator('#engine-badge').click();
    await expect(page.locator('#s1-pill .status-pill-text')).toHaveText('Error');
    await expect(page.locator('#s1-load')).toHaveText('Retry');

    // Collection goes on without System 1: the rules decide.
    const posts = [0, 1].map((n) => ({ urn: urnFor(601, n), text: goldenText(n ? 'tag-weather-03' : 'tag-sports-01') }));
    await servePages(ext.context, { [FEED]: linkedinFeedHtml(posts) });
    const feed = await ext.context.newPage();
    await feed.goto(FEED);
    await waitDecided(feed, posts.map((p) => keyFor(p.urn)));
    const stack = await waitForStack(sw, (st) => st.length === 2);
    for (const item of stack) {
      expect(item.decision.path).not.toContain('system1');
      expect(item.decision.collect).toBe(true);
    }
  } finally {
    await ext.close();
    broken.remove();
  }
});

test('a rejected escalation key turns the badge amber with the reason; a working key turns it green', async () => {
  test.setTimeout(300000);
  const mock = await startMockDecisionServer();
  mock.setMode('401');
  const ext = await launchWithExtension();
  try {
    const sw = ext.serviceWorker;
    await seed(sw, {
      configuration: { matchPrompt: RESTAURANT_PROMPT, isMatchPromptEnabled: true, promptVersion: 1 },
      secrets: { jev: TEST_JEV_KEY },
      intelligence: { escalation: { provider: 'jev', floor: { matches_prompt: 1, primary_tag: 0 } }, providers: { jev: { enabled: true, baseUrl: mock.url } } }
    });
    const { page } = await openPanel(ext);
    await expect(page.locator('#engine-badge')).toHaveAttribute('data-level', 'ok', { timeout: 180000 });

    const posts = [{ urn: urnFor(602, 0), text: SHORT_POSTS[0].text }];
    await servePages(ext.context, { [FEED]: linkedinFeedHtml(posts) });
    const feed = await ext.context.newPage();
    await feed.goto(FEED);
    await waitDecided(feed, [keyFor(posts[0].urn)]);

    await expect(page.locator('#engine-badge')).toHaveAttribute('data-level', 'warn', { timeout: 30000 });
    await expect(page.locator('#engine-label')).toHaveText('TypeSafe Jev: key rejected');
    await expect(page.locator('#engine-badge')).toHaveAttribute('title', /System 1 is deciding/);
    await page.locator('.tab-btn[data-tab="settings"]').click();
    await expect(page.locator('#jev-pill .status-pill-text')).toHaveText('Key rejected');
    const s = await sendFromPage(page, 'GET_ENGINE_STATUS');
    expect(s.escalation).toMatchObject({ provider: 'jev', status: { state: 'auth_error' } });
    // Still System 1's (collected) verdict.
    const [item] = await waitForStack(sw, (st) => st.length === 1);
    expect(item.decision).toMatchObject({ escalated: false, collect: true, reason: 'auth_error' });

    // A new key that works: the provider test passes and the badge turns green.
    mock.setMode('ok');
    expect(await sendFromPage(page, 'SET_SECRET', { provider: 'jev', value: 'jev-e2e-OTHER-1111222233' })).toMatchObject({ success: true });
    expect(await sendFromPage(page, 'TEST_PROVIDER', { provider: 'jev' })).toMatchObject({ success: true, ok: true });
    await expect(page.locator('#engine-badge')).toHaveAttribute('data-level', 'ok', { timeout: 30000 });
    await expect(page.locator('#jev-pill .status-pill-text')).toHaveText('Ready');
  } finally {
    await ext.close();
    await mock.close();
  }
});
