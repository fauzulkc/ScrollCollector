// Integration smoke test of the built extension (Phases 1-3): service-worker startup and schema
// migration, the side panel <-> service worker message contract, and a LinkedIn feed (fixture served
// on the real hostname) collected end to end by content.js.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchWithExtension, collectConsole, ROOT } from './helpers/launch.mjs';
import { waitDecided, pageVisibleDecisions } from './helpers/ext.mjs';

const FIXTURE = fs.readFileSync(path.join(ROOT, 'test/fixtures/linkedin-feed.html'), 'utf8');
const POST_KEYS = [
  'li:urn:li:activity:7301000000000000001',
  'li:urn:li:activity:7301000000000000002',
  'li:urn:li:activity:7301000000000000003',
  'li:urn:li:ugcPost:7301000000000000444'
];

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

test('service worker migrates storage to schema v2 and the side panel gets whitelisted state', async () => {
  const ext = await launchWithExtension();
  try {
    const sw = ext.serviceWorker;
    const stored = await swPoll(sw, async () => {
      const s = await chrome.storage.local.get(['schemaVersion', 'configuration']);
      return s.schemaVersion === 2 ? s : null;
    });
    // Only the user's explicit intelligence settings are stored (none on a fresh profile); the
    // defaults (cloud providers off, Nano as the escalator) are merged in when read.
    expect(stored.configuration.intelligence).toBeUndefined();
    expect(stored.configuration.trackedTags.find((t) => t.label === 'Ads')).toMatchObject({ isPseudo: true });

    await sw.evaluate(() => chrome.storage.local.set({ secrets: { jev: 'jev-e2e-SECRET-0123456789' } }));

    const panel = await ext.context.newPage();
    const logs = collectConsole(panel);
    await panel.goto(`chrome-extension://${ext.extensionId}/sidepanel.html`);
    await panel.waitForLoadState('load');

    const state = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATE' }));
    expect(Object.keys(state).sort()).toEqual(['configuration', 'inFlightCount', 'metrics', 'stack', 'telemetry']);
    expect(JSON.stringify(state)).not.toContain('SECRET');

    const engine = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_ENGINE_STATUS' }));
    expect(engine).toHaveProperty('status');
    expect(Array.isArray(engine.warnings)).toBe(true);

    const key = 'sk-e2e-SECRET-abcdefghijklmnopqrstuvwxyz';
    const set = await panel.evaluate((value) => chrome.runtime.sendMessage({ type: 'SET_SECRET', payload: { provider: 'openai', value } }), key);
    expect(set).toEqual({ success: true, secrets: { jev: { set: true, last4: '6789' }, openai: { set: true, last4: 'wxyz' } } });

    const unknown = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'NOT_A_MESSAGE' }));
    expect(unknown).toEqual({ success: false, error: 'Unknown message type' });

    const errors = logs.filter((l) => l.type === 'pageerror' || /Content Security Policy|Refused to|Uncaught/i.test(l.text));
    expect(errors).toEqual([]);
  } finally {
    await ext.close();
  }
});

test('a LinkedIn feed is collected end to end with URN keys and in-page annotations', async () => {
  const ext = await launchWithExtension();
  try {
    await ext.context.route('https://www.linkedin.com/**', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/feed/' || url.pathname === '/feed') {
        return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: FIXTURE });
      }
      return route.fulfill({ status: 404, body: '' });
    });
    // Startup (and the migration) must be done before the page asks for its configuration.
    await swPoll(ext.serviceWorker, async () => (await chrome.storage.local.get('schemaVersion')).schemaVersion === 2);

    const page = await ext.context.newPage();
    await page.goto('https://www.linkedin.com/feed/');

    // content.js keeps each decision in its isolated world...
    await waitDecided(page, POST_KEYS, { statuses: ['collected'], timeout: 60000 });
    // ...and writes none of it into the page, whose own scripts could read the DOM.
    expect(await pageVisibleDecisions(page)).toEqual([]);

    const stack = await swPoll(ext.serviceWorker, async (n) => {
      const { stack } = await chrome.storage.local.get('stack');
      return Array.isArray(stack) && stack.length >= n ? stack : null;
    }, POST_KEYS.length);
    expect(stack.map((i) => i.postKey).sort()).toEqual([...POST_KEYS].sort());
    for (const item of stack) {
      expect(item.sourceUrl).toBe(`https://www.linkedin.com/feed/update/${item.postKey.slice(3)}/`);
      expect(item.textSnippet.length).toBeLessThanOrEqual(2000);
      expect(item.decision).toMatchObject({ v: 1, collect: true });
    }
  } finally {
    await ext.close();
  }
});
