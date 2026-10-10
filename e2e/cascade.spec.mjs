// The integrated decision cascade end to end (Phases 4-7): a LinkedIn feed served on the real
// hostname is collected by content.js, decided by System 1 in the offscreen document, uncertain
// posts escalate to TypeSafe Jev (the local mock decision server), a prompt change hides what no
// longer matches (never deletes) and re-collects, and a Jev fault degrades gracefully without the
// API key ever leaving the service worker.
import { test, expect } from '@playwright/test';
import { launchWithExtension, collectConsole } from './helpers/launch.mjs';
import { annotations, waitDecided } from './helpers/ext.mjs';
import { startMockDecisionServer } from './mock-decision-server.mjs';
import { SCHEMA_VERSION } from '../lib/storage/schema.js';

const PROMPT = 'find me restaurant and 5 star quality food posts. I am fascinated by michelin star cooking';
const KEY = 'jev-e2e-SECRET-0123456789';
// Same posts as e2e/s1.spec.mjs: System 1 (MiniLM) scores the first three food posts ~0.98, the
// bistro post (3) ~0.6 (uncertain at the calibrated floor) and the others < 0.07.
const POSTS = [
  { food: true, text: 'Chef Ingrid Solberg and her team have been awarded a third Michelin star for their tasting menu.' },
  { food: true, text: 'We just opened our new restaurant downtown: a seven-course tasting menu built around local seafood and seasonal vegetables.' },
  { food: true, text: 'Dinner last night at a two Michelin star restaurant in Lyon was unforgettable. The lobster bisque and the souffle were perfect.' },
  { food: true, text: 'Our head chef spent ten years in fine dining kitchens before opening this bistro, and the duck confit is worth the trip.' },
  { food: false, text: 'We are hiring a remote backend engineer to build payment services in Go and Postgres.' },
  { food: false, text: 'Hurricane warning issued for the Gulf Coast as the storm strengthens to Category 4.' },
  { food: false, text: 'Our open-source code review bot just passed 10,000 stars on GitHub.' },
  { food: false, text: 'Thrilled to share that our team just wrapped up a two-day planning offsite.' },
  { food: false, text: 'Great Trips Begin with Good Planning and the Proper Kit Changes Everything.' },
  { food: false, text: 'Is it ever too late to pick up a second language? Most adults think so, and they are wrong.' }
];
const URNS = POSTS.map((_, i) => `urn:li:activity:73020000000000000${String(i).padStart(2, '0')}`);
const KEYS = URNS.map((u) => `li:${u}`);

/** A LinkedIn-shaped feed (the structure of test/fixtures/linkedin-feed.html). */
function feedHtml() {
  const posts = POSTS.map((p, i) => `
    <div><div class="relative" data-id="${URNS[i]}" data-finite-scroll-hotkey-item="${i}"><div class="full-height">
      <div class="feed-shared-update-v2 full-height relative artdeco-card" role="article" data-urn="${URNS[i]}">
        <div class="update-components-actor display-flex"><div class="update-components-actor__container display-flex">
          <div class="update-components-actor__meta relative">
            <a class="update-components-actor__meta-link" href="https://www.linkedin.com/in/person-${i}/">
              <span class="update-components-actor__title"><span dir="ltr"><span aria-hidden="true">Person ${i}</span></span></span>
            </a>
          </div>
        </div></div>
        <div class="feed-shared-update-v2__description-wrapper">
          <div class="feed-shared-inline-show-more-text feed-shared-update-v2__description" tabindex="-1">
            <div class="update-components-text relative update-components-update-v2__commentary" dir="ltr">
              <span class="break-words tvm-parent-container"><span dir="ltr">${p.text}</span></span>
            </div>
          </div>
        </div>
      </div>
    </div></div></div>`).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Feed | LinkedIn</title></head>
<body><main class="scaffold-layout__main" id="main"><div class="scaffold-finite-scroll__content" data-finite-scroll-hotkey-context="FEED">${posts}</div></main></body></html>`;
}

/** Polls `fn` in the service worker until it returns a truthy value. */
async function swPoll(sw, fn, arg, timeout = 60000) {
  const start = Date.now();
  for (;;) {
    const value = await sw.evaluate(fn, arg);
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('swPoll timed out');
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function routeFeed(ext) {
  const body = feedHtml();
  await ext.context.route('https://www.linkedin.com/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/feed/' || url.pathname === '/feed') {
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
    }
    return route.fulfill({ status: 404, body: '' });
  });
}

/** Seeds the prompt, Jev as the (allowed) escalator at the mock, and a key. */
async function seed(sw, { baseUrl, extraIntelligence = {} }) {
  await swPoll(sw, async (v) => (await chrome.storage.local.get('schemaVersion')).schemaVersion === v, SCHEMA_VERSION);
  await sw.evaluate(async ({ prompt, baseUrl, key, extra }) => {
    const { configuration } = await chrome.storage.local.get('configuration');
    await chrome.storage.local.set({
      secrets: { jev: key },
      configuration: {
        ...configuration,
        matchPrompt: prompt,
        isMatchPromptEnabled: true,
        promptVersion: 1,
        intelligence: {
          escalation: { provider: 'jev', ...(extra.escalation || {}) },
          providers: { jev: { enabled: true, baseUrl } },
          ...(extra.gate ? { gate: extra.gate } : {})
        }
      }
    });
  }, { prompt: PROMPT, baseUrl, key: KEY, extra: extraIntelligence });
}

/** Status content.js received for each post (kept in its isolated world, not in the page). */
async function statuses(page) {
  return (await annotations(page, KEYS)).map((a) => a.status);
}

async function waitAllDecided(page, timeout = 240000) {
  await waitDecided(page, KEYS, { statuses: ['collected', 'rejected'], timeout });
}

test('System 1 decides the feed, only the uncertain post goes to Jev, and a prompt change hides and re-collects', async () => {
  test.setTimeout(480000);
  const mock = await startMockDecisionServer();
  const ext = await launchWithExtension();
  try {
    await routeFeed(ext);
    const sw = ext.serviceWorker;
    await seed(sw, { baseUrl: mock.url });

    const feed = await ext.context.newPage();
    const feedLogs = collectConsole(feed);
    await feed.goto('https://www.linkedin.com/feed/');
    await waitAllDecided(feed);
    const st = await statuses(feed);
    console.log('[cascade] statuses', JSON.stringify(st));
    expect(st.slice(0, 4)).toEqual(['collected', 'collected', 'collected', 'collected']);
    expect(st.slice(4)).toEqual(Array(6).fill('rejected'));

    const stack = await swPoll(sw, async (n) => {
      const { stack } = await chrome.storage.local.get('stack');
      return Array.isArray(stack) && stack.length >= n ? stack : null;
    }, 4);
    console.log('[cascade] decisions', JSON.stringify(stack.map((i) => ({ k: i.postKey.slice(-2), p: i.decision.pMatch, path: i.decision.path, tag: i.assignedTag }))));
    expect(stack.map((i) => i.postKey).sort()).toEqual(KEYS.slice(0, 4).sort());
    for (const item of stack) {
      expect(item.decision.path[0]).toBe('system1');
      expect(item.decision.collect).toBe(true);
      expect(item.sourceUrl).toBe(`https://www.linkedin.com/feed/update/${item.postKey.slice(3)}/`);
    }

    // Escalation: only the questions System 1 was unsure about reached Jev (with a key). The
    // prompt-match question went out for the bistro post only; posts System 1 confidently rejected
    // never left the device; a collected post may still ask Jev for its tag (default tags have no
    // food tag, so System 1 is unsure which one fits).
    const jev = mock.log().filter((e) => e.kind === 'jev');
    console.log('[cascade] jev requests', JSON.stringify(jev.map((e) => ({ post: e.post.slice(0, 40), q: e.questionIds }))));
    const sentWith = (i, q) => jev.some((e) => e.post.includes(POSTS[i].text.slice(0, 40)) && (!q || e.questionIds.includes(q)));
    expect(sentWith(3, 'matches_prompt')).toBe(true); // the bistro post
    for (const i of [0, 1, 2]) expect(sentWith(i, 'matches_prompt'), `post ${i}: its prompt match is certain`).toBe(false);
    for (const i of [4, 5, 6, 7, 8, 9]) expect(sentWith(i), `post ${i} was confidently rejected and stays on the device`).toBe(false);
    expect(jev.every((e) => e.auth === 'present')).toBe(true);
    const bistro = stack.find((i) => i.postKey === KEYS[3]);
    expect(bistro.decision).toMatchObject({ escalated: true, provider: 'jev', path: ['system1', 'jev'], pMatch: 0.93 });
    for (const item of stack) {
      const asked = jev.some((e) => e.post.includes(POSTS[KEYS.indexOf(item.postKey)].text.slice(0, 40)));
      expect(item.decision.escalated, item.postKey).toBe(asked);
    }

    // The panel sees a green badge and the counters.
    const panel = await ext.context.newPage();
    const panelLogs = collectConsole(panel);
    await panel.goto(`chrome-extension://${ext.extensionId}/sidepanel.html`);
    await expect(panel.locator('#engine-badge')).toHaveAttribute('data-level', 'ok', { timeout: 60000 });
    const diag = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_DIAGNOSTICS' }));
    expect(diag.engineStatus.counters.decided).toBeGreaterThanOrEqual(10);
    expect(diag.engineStatus.counters.escalated).toBeGreaterThanOrEqual(1);
    expect(diag.rejected.length).toBeGreaterThanOrEqual(6);
    expect(diag.rejected[0]).toMatchObject({ reason: expect.stringMatching(/_no_match$|social_noise/) });
    expect(diag.providers.jev.calls).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(diag)).not.toContain('SECRET');

    // A prompt change: the food posts are hidden (never deleted) and the coding post is collected.
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'UPDATE_INTELLIGENCE_SETTINGS', payload: { patch: { escalation: { provider: 'none' } } } }));
    await panel.evaluate(() => {
      window.__progress = [];
      chrome.runtime.onMessage.addListener((m) => { if (m && m.type === 'REDECIDE_PROGRESS') window.__progress.push(m.payload); });
    });
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'UPDATE_MATCH_PROMPT', payload: { prompt: 'AI tools that help developers write and review code' } }));
    const after = await swPoll(sw, async (keys) => {
      const { stack } = await chrome.storage.local.get('stack');
      const food = (stack || []).filter((i) => keys.includes(i.postKey));
      return food.length === 4 && food.filter((i) => i.hiddenByPrompt).length >= 3 ? stack : null;
    }, KEYS.slice(0, 4), 120000);
    expect(after.filter((i) => KEYS.slice(0, 4).includes(i.postKey))).toHaveLength(4);
    await swPoll(sw, async (k) => {
      const { stack } = await chrome.storage.local.get('stack');
      return (stack || []).some((i) => i.postKey === k && !i.hiddenByPrompt);
    }, KEYS[6], 120000);
    await panel.waitForFunction(() => window.__progress.some((p) => p.finished && !p.cancelled), null, { timeout: 60000 });

    // Switching the filter off shows everything again, without a model call.
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'TOGGLE_MATCH_PROMPT', payload: { isEnabled: false } }));
    await swPoll(sw, async () => {
      const { stack } = await chrome.storage.local.get('stack');
      return (stack || []).length >= 5 && stack.every((i) => !i.hiddenByPrompt);
    }, null, 60000);

    const errors = [...feedLogs, ...panelLogs].filter((l) => l.type === 'pageerror' || /Content Security Policy|Refused to/i.test(l.text));
    expect(errors).toEqual([]);
  } finally {
    await ext.close();
    await mock.close();
  }
});

test('a Jev fault raises one toast and an amber badge, System 1 keeps deciding, and the key never leaves the worker', async () => {
  test.setTimeout(480000);
  const mock = await startMockDecisionServer();
  mock.setMode('echo401'); // the server echoes the bearer token back in its error
  const ext = await launchWithExtension();
  try {
    await routeFeed(ext);
    const sw = ext.serviceWorker;
    // A confidence floor of 1 makes every post uncertain, so the first batch escalates.
    await seed(sw, { baseUrl: mock.url, extraIntelligence: { escalation: { floor: { matches_prompt: 1 } } } });

    const panel = await ext.context.newPage();
    await panel.goto(`chrome-extension://${ext.extensionId}/sidepanel.html`);
    await panel.evaluate(() => {
      window.__msgs = [];
      chrome.runtime.onMessage.addListener((m) => { if (m && (m.type === 'TOAST' || m.type === 'ENGINE_STATUS')) window.__msgs.push(m); });
    });

    const feed = await ext.context.newPage();
    await feed.goto('https://www.linkedin.com/feed/');
    await waitAllDecided(feed);

    // System 1 kept deciding: every post was unsure, Jev failed, "when unsure: collect" applied.
    // Only the social-noise prefilter (before System 1) rejects anything here.
    const st = await statuses(feed);
    const reasons = (await annotations(feed, KEYS)).map((a) => a.reason);
    console.log('[cascade fault] statuses', JSON.stringify(st), 'reasons', JSON.stringify(reasons));
    expect(st.slice(0, 4)).toEqual(['collected', 'collected', 'collected', 'collected']);
    st.forEach((s, i) => { if (s === 'rejected') expect(reasons[i], `post ${i}`).toBe('social_noise'); });
    const collected = st.filter((s) => s === 'collected').length;
    expect(collected).toBeGreaterThanOrEqual(8);
    const stack = await swPoll(sw, async (n) => {
      const { stack } = await chrome.storage.local.get('stack');
      return Array.isArray(stack) && stack.length === n ? stack : null;
    }, collected);
    for (const item of stack) {
      expect(item.decision).toMatchObject({ escalated: false, uncertain: true, collect: true });
      expect(item.decision.path).toEqual(['system1']);
      expect(item.decision.reason).toBe('auth_error');
    }

    // One toast with a fixed text; the badge is amber; Jev is paused after the rejected key.
    await panel.waitForFunction(() => window.__msgs.some((m) => m.type === 'TOAST'), null, { timeout: 30000 });
    await expect(panel.locator('#engine-badge')).toHaveAttribute('data-level', 'warn', { timeout: 30000 });
    const msgs = await panel.evaluate(() => window.__msgs);
    const toasts = msgs.filter((m) => m.type === 'TOAST');
    expect(toasts).toHaveLength(1);
    expect(toasts[0].payload).toMatchObject({ key: 'jev', level: 'warn' });
    expect(toasts[0].payload.text).toMatch(/rejected the API key/);
    const engine = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_ENGINE_STATUS' }));
    expect(engine.escalation).toMatchObject({ provider: 'jev', status: { state: 'auth_error' } });
    const jevCalls = mock.log().filter((e) => e.kind === 'jev');
    expect(jevCalls.length).toBeGreaterThanOrEqual(1);
    expect(jevCalls.length).toBeLessThanOrEqual(4); // the circuit opened after the first failures

    // The echoed key appears nowhere: pushes, replies, the panel DOM, diagnostics, a provider test.
    const diag = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_DIAGNOSTICS' }));
    const test401 = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'TEST_PROVIDER', payload: { provider: 'jev' } }));
    expect(test401).toMatchObject({ success: true, ok: false, code: 'auth_error' });
    for (const blob of [JSON.stringify(msgs), JSON.stringify(engine), JSON.stringify(diag), JSON.stringify(test401), await panel.content()]) {
      expect(blob).not.toContain('SECRET');
      expect(blob).not.toContain('0123456789');
    }
    expect(diag.secrets.jev).toEqual({ set: true, last4: '6789' });

    // A new key closes the circuit: the provider test passes and the badge turns green again.
    mock.setMode('ok');
    const saved = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'SET_SECRET', payload: { provider: 'jev', value: 'jev-e2e-NEWKEY-9876543210' } }));
    expect(saved).toMatchObject({ success: true, secrets: { jev: { set: true, last4: '3210' } } });
    const ok = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'TEST_PROVIDER', payload: { provider: 'jev' } }));
    expect(ok).toMatchObject({ success: true, ok: true });
    await expect(panel.locator('#engine-badge')).toHaveAttribute('data-level', 'ok', { timeout: 30000 });
  } finally {
    await ext.close();
    await mock.close();
  }
});
