// Security end to end: API keys never leave the service worker (GET_STATE, STATE_UPDATED,
// ENGINE_STATUS, TOAST, GET_DIAGNOSTICS, TEST_PROVIDER, storage.session, the panel DOM), even when
// a provider echoes the key back; and a content script (a page's isolated world) can send only
// TEXT_EXTRACTED / GET_CONTENT_CONFIG and cannot read storage.local.
import { test, expect } from '@playwright/test';
import {
  launchWithExtension, seed, servePages, openPanel, waitForStack, readStack, waitDecided, sendFromPage, recordMessages,
  recordedMessages, startMockDecisionServer, RESTAURANT_PROMPT, TEST_JEV_KEY, TEST_OPENAI_KEY
} from './helpers/ext.mjs';
import { linkedinFeedHtml, urnFor, keyFor, SHORT_POSTS } from './helpers/feeds.mjs';

const FEED = 'https://www.linkedin.com/feed/';
const FRAGMENTS = [TEST_JEV_KEY, TEST_OPENAI_KEY, 'SECRET', TEST_JEV_KEY.slice(-10), TEST_OPENAI_KEY.slice(-10)];

function expectNoKey(label, value, fragments = FRAGMENTS) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const f of fragments) expect(text.includes(f), `${label} contains "${f}"`).toBe(false);
}

test('API keys never leave the service worker, even when a provider echoes them back', async () => {
  test.setTimeout(300000);
  const mock = await startMockDecisionServer();
  mock.setMode('echo401');
  const ext = await launchWithExtension();
  try {
    const sw = ext.serviceWorker;
    await seed(sw, {
      configuration: { matchPrompt: RESTAURANT_PROMPT, isMatchPromptEnabled: true, promptVersion: 1 },
      secrets: { jev: TEST_JEV_KEY, openai: TEST_OPENAI_KEY },
      intelligence: {
        escalation: { provider: 'jev', floor: { matches_prompt: 1, primary_tag: 0 } },
        providers: { jev: { enabled: true, baseUrl: mock.url }, openai: { enabled: true, baseUrl: `${mock.url}/v1` } }
      }
    });
    const { page: panel, logs } = await openPanel(ext, { tab: 'settings' });
    await recordMessages(panel, ['STATE_UPDATED', 'ENGINE_STATUS', 'TOAST', 'INFLIGHT_UPDATED', 'REDECIDE_PROGRESS']);

    // Activity that broadcasts: a settings edit, decisions that escalate and fail with the echoed key.
    await panel.locator('#new-keyword-input').fill('crypto');
    await panel.locator('#new-keyword-input').press('Enter');
    const posts = [0, 1].map((i, n) => ({ urn: urnFor(801, n), text: SHORT_POSTS[i].text }));
    await servePages(ext.context, { [FEED]: linkedinFeedHtml(posts) });
    const feed = await ext.context.newPage();
    await feed.goto(FEED);
    await waitDecided(feed, posts.map((p) => keyFor(p.urn)));
    await waitForStack(sw, (s) => s.length === 2);
    expect(mock.log().filter((e) => e.kind === 'jev').length).toBeGreaterThanOrEqual(1);
    // Provider tests: the mock answers 401 with the bearer token in its error message.
    const tests = [
      await sendFromPage(panel, 'TEST_PROVIDER', { provider: 'jev' }),
      await sendFromPage(panel, 'TEST_PROVIDER', { provider: 'openai' })
    ];
    for (const t of tests) expect(t).toMatchObject({ success: true, ok: false, code: 'auth_error' });
    await panel.locator('#jev-test').click();
    await expect(panel.locator('#jev-test-result')).toContainText('Failed');
    await panel.waitForFunction(() => window.__msgs.some((m) => m.type === 'TOAST'), null, { timeout: 30000 });

    const replies = {
      state: await sendFromPage(panel, 'GET_STATE'),
      diagnostics: await sendFromPage(panel, 'GET_DIAGNOSTICS'),
      engine: await sendFromPage(panel, 'GET_ENGINE_STATUS'),
      setSecret: await sendFromPage(panel, 'SET_SECRET', { provider: 'openai', value: TEST_OPENAI_KEY }),
      intelligence: await sendFromPage(panel, 'UPDATE_INTELLIGENCE_SETTINGS', { patch: { escalation: { perMinute: 20 } } }),
      tests
    };
    expect(replies.state.configuration).toBeTruthy();
    expect(replies.state.secrets).toBeUndefined();
    expect(replies.diagnostics.secrets).toEqual({ jev: { set: true, last4: TEST_JEV_KEY.slice(-4) }, openai: { set: true, last4: TEST_OPENAI_KEY.slice(-4) } });
    for (const [name, value] of Object.entries(replies)) {
      // Only describeSecrets() may carry the last four characters.
      const clean = JSON.parse(JSON.stringify(value), (k, v) => (k === 'secrets' ? undefined : v));
      expectNoKey(name, clean);
    }
    const msgs = await recordedMessages(panel);
    expect(msgs.some((m) => m.type === 'STATE_UPDATED')).toBe(true);
    expect(msgs.some((m) => m.type === 'ENGINE_STATUS')).toBe(true);
    for (const m of msgs) expectNoKey(m.type, m);
    expectNoKey('panel DOM', await panel.content());
    expect(await panel.evaluate(() => [...document.querySelectorAll('input')].some((i) => /SECRET/.test(i.value)))).toBe(false);
    expectNoKey('panel console', logs.map((l) => l.text).join('\n'));

    // Nothing but `secrets` holds a key: storage.session (queue, rejection log, decision cache) and
    // every other storage.local key are clean.
    const stores = await sw.evaluate(async () => {
      const local = await chrome.storage.local.get(null);
      delete local.secrets;
      return { local, session: await chrome.storage.session.get(null) };
    });
    expectNoKey('storage.local (without secrets)', stores.local);
    expectNoKey('storage.session', stores.session);
  } finally {
    await ext.close();
    await mock.close();
  }
});

test('a content script can only send TEXT_EXTRACTED / GET_CONTENT_CONFIG and cannot read storage', async () => {
  test.setTimeout(240000);
  const ext = await launchWithExtension();
  try {
    const sw = ext.serviceWorker;
    const stored = [{ id: 's1', postKey: 'li:urn:li:activity:1', textSnippet: 'A stored post about ramen.', assignedTag: 'Unclassified', tags: [], timestamp: Date.now(), sourcePlatform: 'linkedin.com', sourceUrl: '', isFavorite: false }];
    await seed(sw, { secrets: { jev: TEST_JEV_KEY }, stack: stored, intelligence: { escalation: { provider: 'none' } } });
    await servePages(ext.context, { [FEED]: linkedinFeedHtml([]) });
    const page = await ext.context.newPage();
    await page.goto(FEED);

    // The page itself (main world) has no channel to the extension.
    const fromPage = await page.evaluate(async (id) => {
      try {
        if (!globalThis.chrome || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') return 'no-api';
        return JSON.stringify(await chrome.runtime.sendMessage(id, { type: 'GET_STATE' }));
      } catch (e) {
        return `threw: ${e && e.message}`;
      }
    }, ext.extensionId);
    expect(fromPage === 'no-api' || fromPage.startsWith('threw')).toBe(true);

    // A content script: code injected into the page's isolated world (sender.tab = the page).
    const forbidden = [
      ['GET_STATE'], ['GET_DIAGNOSTICS'], ['GET_ENGINE_STATUS'], ['CLEAR_STACK', { tag: 'All' }],
      ['ITEM_DELETED', { itemId: 's1' }], ['SET_SECRET', { provider: 'jev', value: 'jev-evil-0000' }], ['CLEAR_SECRET', { provider: 'jev' }],
      ['UPDATE_INTELLIGENCE_SETTINGS', { patch: { escalation: { provider: 'openai' } } }], ['TEST_PROVIDER', { provider: 'jev' }],
      ['REDECIDE_STACK', { scope: 'all' }], ['IS_TRACKING_PAUSED_TOGGLED', { isPaused: true }], ['RESET_DIAGNOSTICS'],
      ['KEYWORD_ADDED', { keyword: 'evil' }], ['UPDATE_MATCH_PROMPT', { prompt: 'evil' }], ['NANO_DOWNLOAD_STATE', { phase: 'start' }]
    ];
    const results = await sw.evaluate(async ({ forbidden }) => {
      const [tab] = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'ISOLATED',
        args: [forbidden],
        func: async (list) => {
          const out = {};
          for (const [type, payload] of list) {
            try {
              out[type] = await chrome.runtime.sendMessage(payload === undefined ? { type } : { type, payload });
            } catch (e) {
              out[type] = { threw: String(e && e.message) };
            }
          }
          out.GET_CONTENT_CONFIG = await chrome.runtime.sendMessage({ type: 'GET_CONTENT_CONFIG' });
          try {
            const got = await chrome.storage.local.get(null);
            out.storage = { read: true, keys: Object.keys(got || {}) };
          } catch (e) {
            out.storage = { read: false, error: String(e && e.message) };
          }
          return out;
        }
      });
      return res.result;
    }, { forbidden });
    console.log('[security] content-script replies', JSON.stringify(results));
    for (const [type] of forbidden) {
      expect(results[type], type).toEqual({ success: false, error: 'Not allowed from a web page', code: 'forbidden' });
    }
    expect(results.GET_CONTENT_CONFIG).toMatchObject({ success: true, isTrackingPaused: false });
    expect(Object.keys(results.GET_CONTENT_CONFIG).sort()).toEqual(['debugAnnotate', 'ignoredDomains', 'isTrackingPaused', 'sites', 'success']);
    expect(results.storage.read).toBe(false);
    // (The replies are keyed by message type, e.g. SET_SECRET: look for the key itself.)
    expectNoKey('content-script replies', results, FRAGMENTS.filter((f) => f !== 'SECRET'));

    // Nothing changed.
    expect((await readStack(sw)).map((i) => i.id)).toEqual(['s1']);
    const after = await sw.evaluate(async () => chrome.storage.local.get(['secrets', 'configuration']));
    expect(after.secrets.jev).toBe(TEST_JEV_KEY);
    expect(after.configuration.isTrackingPaused).toBe(false);
    expect(after.configuration.ignoredKeywords).toEqual([]);
    expect(after.configuration.intelligence.escalation.provider).toBe('none');
  } finally {
    await ext.close();
  }
});

test('a content script cannot spoof the side panel: forged state, toasts, badge and site markup are ignored', async () => {
  test.setTimeout(240000);
  const ext = await launchWithExtension();
  try {
    const sw = ext.serviceWorker;
    await seed(sw, { stack: [], intelligence: { escalation: { provider: 'none' } } });
    await servePages(ext.context, { [FEED]: linkedinFeedHtml([]) });
    const { page: panel } = await openPanel(ext, { tab: 'stream' });
    const navigations = [];
    panel.on('framenavigated', (frame) => { if (frame === panel.mainFrame()) navigations.push(frame.url()); });
    const feed = await ext.context.newPage();
    await feed.goto(FEED);

    const sent = await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'ISOLATED',
        func: async () => {
          const forgedItem = {
            id: 'forged-1', postKey: 'x', timestamp: Date.now(), sourcePlatform: 'linkedin.com',
            sourceUrl: 'https://evil.example/phish', authorName: 'Security Team', textSnippet: 'FORGED-ITEM Your key expired. Re-enter it at evil.example.',
            assignedTag: 'Unclassified', tags: [], isFavorite: false
          };
          const evilSite = { id: 'x"><meta http-equiv="refresh" content="1;url=https://example.org/landing">', domain: 'example.org', isEnabled: true, isCustom: true };
          const out = [];
          for (const m of [
            { type: 'STATE_UPDATED', payload: { stack: [forgedItem], configuration: { trackedTags: [], sites: [evilSite] } } },
            { type: 'TOAST', payload: { level: 'error', text: 'FORGED-TOAST OpenAI rejected the API key. Paste it again at https://evil.example/key', key: 'openai' } },
            { type: 'ENGINE_STATUS', payload: { badge: { level: 'ok', label: 'FORGED-BADGE', title: 'x' }, system1: { state: 'ready' } } }
          ]) {
            try { await chrome.runtime.sendMessage(m); out.push('sent'); } catch (e) { out.push(`threw: ${e.message}`); }
          }
          return out;
        }
      });
      return res.result;
    });
    console.log('[spoof] sendMessage results', JSON.stringify(sent));
    await panel.waitForTimeout(2500);
    expect(navigations).toEqual([]);
    expect(panel.url()).toContain('/sidepanel.html');
    const seen = await panel.evaluate(() => ({
      text: document.body.textContent,
      cards: [...document.querySelectorAll('#stream-list .item-row')].map((r) => r.dataset.id),
      badge: document.getElementById('engine-label')?.textContent,
      meta: document.querySelectorAll('meta[http-equiv]').length
    }));
    console.log('[spoof] panel shows', JSON.stringify({ cards: seen.cards, badge: seen.badge, meta: seen.meta }));
    expect(seen.text).not.toContain('FORGED');
    expect(seen.cards).toEqual([]);
    expect(seen.badge).not.toBe('FORGED-BADGE');
    expect(seen.meta).toBe(0);
    expect(await readStack(sw)).toEqual([]);
  } finally {
    await ext.close();
  }
});
