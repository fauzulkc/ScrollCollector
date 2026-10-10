// Escalation end to end against the local mock decision server (e2e/mock-decision-server.mjs): only
// posts System 1 is unsure about leave the device, only to the ONE provider the user picked and
// allowed; the budget caps calls; provider faults (401, 429 + retry-after, 529, timeouts) keep
// System 1's decision, raise one toast and never stop collection.
import { test, expect } from '@playwright/test';
import {
  launchWithExtension, seed, servePages, openPanel, waitForStack, readStack, waitDecided, annotations, sendFromPage,
  recordMessages, recordedMessages, startMockDecisionServer, RESTAURANT_PROMPT, TEST_JEV_KEY, TEST_OPENAI_KEY
} from './helpers/ext.mjs';
import { linkedinFeedHtml, urnFor, keyFor, SHORT_POSTS, UNCERTAIN_SHORT_POST } from './helpers/feeds.mjs';

const BASE = 'https://www.linkedin.com';
const FOOD = [0, 1, 2, 3];
const REJECTED = [4, 5, 6, 7, 8, 9];

/** One feed page per phase (same texts, new URNs), all served on www.linkedin.com. */
function phases(names) {
  const out = {};
  names.forEach((name, n) => {
    const posts = SHORT_POSTS.map((p, i) => ({ urn: urnFor(300 + n, i), text: p.text }));
    out[name] = { url: `${BASE}/feed/${name}/`, html: linkedinFeedHtml(posts), keys: posts.map((p) => keyFor(p.urn)) };
  });
  return out;
}

async function serve(ext, feeds) {
  await servePages(ext.context, Object.fromEntries(Object.values(feeds).map((f) => [f.url, f.html])));
}

/** Opens a phase's feed and waits until every post is decided on the page. */
async function visit(ext, feed) {
  const page = await ext.context.newPage();
  await page.goto(feed.url);
  await waitDecided(page, feed.keys);
  return page;
}

/** Requests the mock logged for `kind`, each mapped to the index of the SHORT_POSTS text it carried. */
function sentPosts(mock, kind) {
  return mock.log().filter((e) => e.kind === kind).map((e) => ({
    ...e,
    index: SHORT_POSTS.findIndex((p) => e.post.includes(p.text.slice(0, 50)))
  }));
}

function gateConfig() {
  return { matchPrompt: RESTAURANT_PROMPT, isMatchPromptEnabled: true, promptVersion: 1 };
}

/** Live settings change through the panel (UPDATE_INTELLIGENCE_SETTINGS), as the UI sends it. */
async function patchIntelligence(panel, patch) {
  const reply = await sendFromPage(panel, 'UPDATE_INTELLIGENCE_SETTINGS', { patch });
  expect(reply.success, JSON.stringify(reply)).toBe(true);
}

for (const provider of ['jev', 'openai']) {
  const kind = provider === 'jev' ? 'jev' : 'chat';
  test(`${provider}: nothing is sent while it is not allowed or not the chosen provider; once allowed only uncertain questions go out`, async () => {
    test.setTimeout(420000);
    const mock = await startMockDecisionServer();
    const ext = await launchWithExtension();
    try {
      const sw = ext.serviceWorker;
      const feeds = phases(['disabled', 'none', 'enabled']);
      await serve(ext, feeds);
      const baseUrl = provider === 'jev' ? mock.url : `${mock.url}/v1`;
      await seed(sw, {
        configuration: gateConfig(),
        secrets: { [provider]: provider === 'jev' ? TEST_JEV_KEY : TEST_OPENAI_KEY },
        intelligence: { escalation: { provider }, providers: { [provider]: { enabled: false, baseUrl } } }
      });
      const { page: panel } = await openPanel(ext);

      // 1. The provider is chosen but not allowed: nothing leaves the device.
      await visit(ext, feeds.disabled);
      expect(sentPosts(mock, kind)).toEqual([]);
      let stack = await waitForStack(sw, (s) => s.length === 4);
      const unsure = stack.find((i) => i.postKey === feeds.disabled.keys[UNCERTAIN_SHORT_POST]);
      expect(unsure.decision).toMatchObject({ escalated: false, uncertain: true, reason: 'cloud_not_allowed', path: ['system1'] });

      // 2. Allowed, but the chosen provider is "none": still nothing.
      await patchIntelligence(panel, { escalation: { provider: 'none' }, providers: { [provider]: { enabled: true } } });
      await visit(ext, feeds.none);
      expect(sentPosts(mock, kind)).toEqual([]);
      stack = await waitForStack(sw, (s) => s.length === 8);
      expect(stack.find((i) => i.postKey === feeds.none.keys[UNCERTAIN_SHORT_POST]).decision).toMatchObject({ escalated: false, reason: 'provider_none' });

      // 3. Chosen and allowed: only the questions System 1 was unsure about are sent.
      await patchIntelligence(panel, { escalation: { provider } });
      await visit(ext, feeds.enabled);
      stack = await waitForStack(sw, (s) => s.length === 12);
      const sent = sentPosts(mock, kind);
      console.log(`[${provider}] sent`, JSON.stringify(sent.map((e) => ({ i: e.index, q: e.questionIds, auth: e.auth, model: e.model }))));
      expect(sent.length).toBeGreaterThanOrEqual(1);
      expect(sent.every((e) => e.auth === 'present')).toBe(true);
      // Confidently rejected posts never leave the device.
      for (const e of sent) expect(REJECTED, `post ${e.index} must stay on the device`).not.toContain(e.index);
      // The prompt question goes out for the uncertain post only.
      expect(sent.some((e) => e.index === UNCERTAIN_SHORT_POST && e.questionIds.includes('matches_prompt'))).toBe(true);
      for (const e of sent.filter((x) => x.index !== UNCERTAIN_SHORT_POST)) expect(e.questionIds).not.toContain('matches_prompt');
      if (provider === 'openai') {
        expect(sent.every((e) => e.model === 'gpt-6-luna' && e.responseFormat === 'json_schema')).toBe(true);
      }
      const enabledItems = stack.filter((i) => feeds.enabled.keys.includes(i.postKey));
      expect(enabledItems).toHaveLength(4);
      for (const item of enabledItems) {
        const index = feeds.enabled.keys.indexOf(item.postKey);
        const asked = sent.some((e) => e.index === index);
        expect(item.decision.escalated, `post ${index}`).toBe(asked);
        if (asked) {
          // The same texts were decided in phases 1-2: System 1's answers come from the decision
          // cache ('cache' in the path); the uncertain ones still escalate under the new policy.
          expect(item.decision.path[0]).toBe('system1');
          expect(item.decision.path.at(-1)).toBe(provider);
          expect(item.decision.path.filter((p) => p !== 'cache')).toEqual(['system1', provider]);
          expect(item.decision.provider).toBe(provider);
        }
      }
      expect(enabledItems.find((i) => i.postKey === feeds.enabled.keys[UNCERTAIN_SHORT_POST]).decision).toMatchObject({ escalated: true, pMatch: 0.93 });

      const diag = await sendFromPage(panel, 'GET_DIAGNOSTICS');
      expect(diag.providers[provider].calls).toBe(sent.length);
      expect(diag.engineStatus.escalation).toMatchObject({ provider });
      expect(JSON.stringify(diag)).not.toContain('SECRET');
    } finally {
      await ext.close();
      await mock.close();
    }
  });
}

test('the per-minute budget caps escalations; the rest keep System 1’s answer with one budget toast', async () => {
  test.setTimeout(300000);
  const mock = await startMockDecisionServer();
  const ext = await launchWithExtension();
  try {
    const sw = ext.serviceWorker;
    const feeds = phases(['budget']);
    await serve(ext, feeds);
    // A floor of 1 makes every answered post uncertain, so every one would escalate.
    await seed(sw, {
      configuration: gateConfig(),
      secrets: { jev: TEST_JEV_KEY },
      intelligence: { escalation: { provider: 'jev', perMinute: 2, floor: { matches_prompt: 1 } }, providers: { jev: { enabled: true, baseUrl: mock.url } } }
    });
    const { page: panel } = await openPanel(ext);
    await recordMessages(panel, ['TOAST']);
    await visit(ext, feeds.budget);
    const sent = sentPosts(mock, 'jev');
    console.log('[budget] sent', sent.length);
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(sent.length).toBeLessThanOrEqual(2);
    const stack = await readStack(sw);
    const capped = stack.filter((i) => i.decision.reason === 'budget_exceeded');
    expect(capped.length).toBeGreaterThanOrEqual(1);
    for (const item of capped) expect(item.decision).toMatchObject({ escalated: false, path: ['system1'] });
    expect(stack.filter((i) => i.decision.escalated).length).toBe(sent.length);
    await panel.waitForFunction(() => (window.__msgs || []).some((m) => m.payload && m.payload.key === 'budget'), null, { timeout: 30000 });
    const toasts = (await recordedMessages(panel)).filter((m) => m.payload.key === 'budget');
    expect(toasts).toHaveLength(1);
    const diag = await sendFromPage(panel, 'GET_DIAGNOSTICS');
    expect(diag.budget).toMatchObject({ perMinute: 2 });
  } finally {
    await ext.close();
    await mock.close();
  }
});

/**
 * One single-post feed per fault phase. Each phase needs a text the extension has never decided:
 * escalated answers are cached, so a re-seen text would not be sent again.
 */
function singlePostPhases(entries) {
  const out = {};
  entries.forEach(([name, index], n) => {
    const posts = [{ urn: urnFor(320 + n, index), text: SHORT_POSTS[index].text }];
    out[name] = { url: `${BASE}/feed/${name}/`, html: linkedinFeedHtml(posts), keys: posts.map((p) => keyFor(p.urn)), index };
  });
  return out;
}

test('faults: a 429 with retry-after is retried; a timeout and a 529 keep System 1’s decision; one toast per fault', async () => {
  test.setTimeout(420000);
  const mock = await startMockDecisionServer();
  const ext = await launchWithExtension();
  try {
    const sw = ext.serviceWorker;
    // Food posts with distinct texts (System 1 collects them all).
    const feeds = singlePostPhases([['retry', 0], ['slow', 1], ['overloaded', 2], ['later', 3]]);
    await serve(ext, feeds);
    await seed(sw, {
      configuration: gateConfig(),
      secrets: { jev: TEST_JEV_KEY },
      // A prompt floor of 1 makes every answered post unsure, so each post sends ONE request (its
      // prompt question); the tag floor of 0 keeps tag questions on the device.
      intelligence: { escalation: { provider: 'jev', floor: { matches_prompt: 1, primary_tag: 0 } }, providers: { jev: { enabled: true, baseUrl: mock.url, timeoutMs: 1500 } } }
    });
    const { page: panel } = await openPanel(ext);
    await recordMessages(panel, ['TOAST', 'ENGINE_STATUS']);
    const itemOf = async (feed) => (await waitForStack(sw, (s) => s.some((i) => i.postKey === feed.keys[0]))).find((i) => i.postKey === feed.keys[0]);

    // 429 once (retry-after: 1 s), then OK: the retry succeeds and the answer is Jev's.
    mock.setMode('429', { retryAfter: 1, count: 1 });
    await visit(ext, feeds.retry);
    let sent = sentPosts(mock, 'jev');
    console.log('[faults] retry', JSON.stringify(sent.map((e) => ({ i: e.index, mode: e.mode, at: e.at }))));
    expect(sent.map((e) => e.mode)).toEqual(['429', 'ok']);
    expect(sent.every((e) => e.index === feeds.retry.index && e.questionIds.join() === 'matches_prompt')).toBe(true);
    expect(sent[1].at - sent[0].at).toBeGreaterThanOrEqual(900);
    expect((await itemOf(feeds.retry)).decision).toMatchObject({ escalated: true, provider: 'jev', pMatch: 0.93 });

    // Slower than the provider timeout: System 1's answer stands (when unsure: collect); no retry.
    mock.clearLog();
    mock.setMode('slow', { delayMs: 4000 });
    await visit(ext, feeds.slow);
    expect(sentPosts(mock, 'jev').length).toBe(1);
    expect((await itemOf(feeds.slow)).decision).toMatchObject({ escalated: false, uncertain: true, collect: true, reason: 'timeout', path: ['system1'] });

    // 529 (overloaded) on every attempt: retried, then System 1 keeps deciding; ONE toast.
    mock.clearLog();
    mock.setMode('529');
    const page = await visit(ext, feeds.overloaded);
    sent = sentPosts(mock, 'jev');
    expect(sent.length).toBe(3); // the first try and two retries
    expect((await itemOf(feeds.overloaded)).decision).toMatchObject({ escalated: false, collect: true, reason: 'overloaded', path: ['system1'] });
    expect((await annotations(page, feeds.overloaded.keys)).map((a) => a.status)).toEqual(['collected']);

    await expect(panel.locator('#engine-badge')).toHaveAttribute('data-level', 'warn', { timeout: 30000 });
    const engine = await sendFromPage(panel, 'GET_ENGINE_STATUS');
    expect(engine.escalation.status.state).toBe('rate_limited');

    // A later post while Jev cools down is not sent (the circuit is open) and raises no second toast.
    mock.clearLog();
    mock.setMode('ok');
    await visit(ext, feeds.later);
    expect(sentPosts(mock, 'jev')).toEqual([]);
    expect((await itemOf(feeds.later)).decision).toMatchObject({ escalated: false, collect: true, path: ['system1'] });

    await panel.waitForTimeout(1000);
    const toasts = (await recordedMessages(panel)).filter((m) => m.type === 'TOAST');
    console.log('[faults] toasts', JSON.stringify(toasts.map((t) => t.payload)));
    expect(toasts).toHaveLength(1);
    expect(toasts[0].payload).toMatchObject({ key: 'jev', level: 'warn' });
    expect(toasts[0].payload.text).toMatch(/overloaded/);
  } finally {
    await ext.close();
    await mock.close();
  }
});

test('a 401 raises one toast and an amber badge while collection goes on (OpenAI)', async () => {
  test.setTimeout(300000);
  const mock = await startMockDecisionServer();
  mock.setMode('echo401');
  const ext = await launchWithExtension();
  try {
    const sw = ext.serviceWorker;
    const feeds = phases(['auth']);
    await serve(ext, feeds);
    await seed(sw, {
      configuration: gateConfig(),
      secrets: { openai: TEST_OPENAI_KEY },
      intelligence: { escalation: { provider: 'openai', floor: { matches_prompt: 1 } }, providers: { openai: { enabled: true, baseUrl: `${mock.url}/v1` } } }
    });
    const { page: panel } = await openPanel(ext);
    await recordMessages(panel, ['TOAST', 'ENGINE_STATUS', 'STATE_UPDATED']);
    const page = await visit(ext, feeds.auth);
    const ann = await annotations(page, feeds.auth.keys);
    // Every post was unsure (floor 1), OpenAI refused the key: "when unsure: collect" applies.
    expect(ann.filter((a) => a.status === 'collected').length).toBeGreaterThanOrEqual(8);
    const stack = await readStack(sw);
    for (const item of stack) expect(item.decision).toMatchObject({ escalated: false, reason: 'auth_error' });
    expect(sentPosts(mock, 'chat').length).toBeLessThanOrEqual(4); // the circuit opened

    await panel.waitForFunction(() => window.__msgs.some((m) => m.type === 'TOAST'), null, { timeout: 30000 });
    await expect(panel.locator('#engine-badge')).toHaveAttribute('data-level', 'warn', { timeout: 30000 });
    await expect(panel.locator('#engine-label')).toContainText('key rejected');
    const msgs = await recordedMessages(panel);
    const toasts = msgs.filter((m) => m.type === 'TOAST');
    expect(toasts).toHaveLength(1);
    expect(toasts[0].payload.text).toMatch(/OpenAI rejected the API key/);
    await expect(panel.locator('.toast-region .toast')).toContainText('OpenAI rejected the API key');
    // The echoed key is nowhere: pushes, the panel, diagnostics.
    const diag = await sendFromPage(panel, 'GET_DIAGNOSTICS');
    for (const blob of [JSON.stringify(msgs), JSON.stringify(diag), await panel.content()]) {
      expect(blob).not.toContain('SECRET');
      expect(blob).not.toContain('abcdefghijklmnop');
    }
  } finally {
    await ext.close();
    await mock.close();
  }
});
