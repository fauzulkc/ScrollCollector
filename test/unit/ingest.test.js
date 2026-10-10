import { describe, test, expect } from 'vitest';
import { createFakeChrome, tabMessagesOfType } from '../helpers/fake-chrome.js';
import { createStore } from '../../lib/bg/store.js';
import { createBroadcaster } from '../../lib/bg/broadcast.js';
import { createHandlers } from '../../lib/bg/handlers/index.js';
import { defaultConfiguration } from '../../lib/bg/defaults.js';
import { emptyTelemetry } from '../../lib/bg/stack-utils.js';
import { createIngest, PENDING_QUEUE_KEY, REJECTED_LOG_KEY } from '../../lib/pipeline/ingest.js';
import { createCascade } from '../../lib/decision/cascade.js';
import { createRulesProvider } from '../../lib/decision/providers/rules.js';
import { createRelabeler } from '../../lib/pipeline/relabel.js';
import { createIdleRetry, RETRY_ATTEMPTS_KEY } from '../../lib/pipeline/retry.js';
import { MSG } from '../../lib/messages.js';

const TAB = { tab: { id: 7 } };

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

/** ItemDecision builder for stub DecideMany implementations. */
function decision(overrides = {}) {
  const tag = overrides.tag ?? 'Tech/AI';
  return {
    v: 1, promptVersion: 0, specHash: 'test', path: ['rules'], provider: 'rules',
    pMatch: null, matchConfidence: null, tag,
    tagConfidence: 1, tags: tag === 'Unclassified' ? [] : [{ name: tag, score: 1 }],
    escalated: false, uncertain: false, reason: null, collect: true, latencyMs: 1, at: 1,
    ...overrides
  };
}

const acceptAll = async (items) => items.map(() => decision());

function setup({ config = {}, stack = [], decideMany = acceptAll, batchSize = 8, session } = {}) {
  const fake = createFakeChrome({
    local: {
      configuration: { ...defaultConfiguration(), ...config },
      stack,
      metrics: { counts: {} },
      telemetry: emptyTelemetry(0),
      secrets: { jev: 'sk-test-secret' }
    },
    session: session || {}
  });
  const store = createStore({ area: fake.storage.local });
  const broadcast = createBroadcaster({ area: fake.storage.local, runtime: fake.runtime, tabs: fake.tabs, delayMs: 5 });
  const notified = [];
  const ingest = createIngest({
    store,
    decideMany,
    broadcast,
    notifyTab: (tabId, message) => { notified.push({ tabId, message }); },
    session: fake.storage.session,
    batchSize,
    settleMs: 0
  });
  const handlers = createHandlers({
    store,
    broadcast,
    ingest,
    engine: {
      checkEngineStatus: async () => ({ tier: 3, name: 'Rule-based Classifier', status: 'ready' }),
      extractTagsFromPrompt: async () => [],
      enhanceMatchPrompt: async () => '',
      autoSuggestTagPrompt: async (t) => `Find posts related to ${t}.`
    }
  });
  return { fake, store, broadcast, ingest, handlers, notified };
}

const post = (i, extra = {}) => ({
  text: `Post number ${i}: shipping a new developer tool for teams`,
  postKey: `li:urn:li:activity:${1000 + i}`,
  postUrl: `https://www.linkedin.com/feed/update/urn:li:activity:${1000 + i}/`,
  pageUrl: 'https://www.linkedin.com/feed/',
  sourcePlatform: 'linkedin.com',
  authorName: `Author ${i}`,
  isUpdate: false,
  ...extra
});

describe('ingest pipeline', () => {
  test('25 concurrent enqueues -> 25 stored items with unique ids', async () => {
    const { fake, ingest, notified } = setup();

    const replies = await Promise.all(Array.from({ length: 25 }, (_, i) => ingest.enqueue(post(i), TAB)));
    expect(replies.every(r => r.status === 'queued')).toBe(true);
    await ingest.drain();

    const { stack, metrics, telemetry } = fake.storage.local.dump();
    expect(stack).toHaveLength(25);
    expect(new Set(stack.map(i => i.id)).size).toBe(25);
    expect(new Set(stack.map(i => i.postKey)).size).toBe(25);
    for (const item of stack) {
      expect(item.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(item.sourceUrl).toMatch(/^https:\/\/www\.linkedin\.com\/feed\/update\//);
      expect(item.assignedTag).toBe('Tech/AI');
      expect(item.decision).toMatchObject({ v: 1, collect: true, tag: 'Tech/AI' });
      expect(item.decision.meta).toBeUndefined();
      expect(item.matchInfo.engine).toBe('Rule-based Classifier');
    }
    expect(metrics.counts['Tech/AI']).toBe(25);
    expect(telemetry.totalProcessed).toBe(25);

    const results = notified.filter(n => n.message.type === MSG.DECISION_RESULT);
    expect(results).toHaveLength(25);
    expect(results.every(r => r.tabId === 7 && r.message.payload.status === 'collected')).toBe(true);
    expect(ingest.pendingCount()).toBe(0);
  });

  test('burst through the real cascade (System 1 stub, rules) keeps every item and respects the gate', async () => {
    let batches = 0;
    const system1 = {
      isReady: () => true,
      floor: { matches_prompt: 0.3, primary_tag: 0.3 },
      async decideBatch({ items, questions }) {
        batches++;
        return {
          results: items.map((it) => {
            const food = it.text.includes('dinner');
            const answers = {};
            if (questions.matches_prompt) answers.matches_prompt = { noul: food ? 0.95 : 0.04 };
            if (questions.primary_tag) answers.primary_tag = { choice: food ? 'Food' : null, probabilities: food ? { Food: 0.9, none: 0.1 } : { Food: 0.1, none: 0.9 } };
            return { id: it.id, answers };
          })
        };
      }
    };
    const decideMany = createCascade({ system1, rules: createRulesProvider() }).decideMany;
    const { fake, ingest, notified } = setup({
      decideMany,
      config: {
        isMatchPromptEnabled: true,
        matchPrompt: 'restaurants and dinner spots',
        matchPromptTags: [{ name: 'Restaurants', weight: 5 }], // legacy shape must not crash the gate
        trackedTags: [{ id: 't1', label: 'Food', isEnabled: true, prompt: 'food' }, { id: 't_ads', label: 'Ads', isEnabled: true, isPseudo: true }],
        intelligence: { escalation: { provider: 'none' } }
      }
    });

    await Promise.all(Array.from({ length: 10 }, (_, i) => ingest.enqueue(
      post(i, {
        text: i % 2 === 0
          ? `Lovely dinner place number ${i} downtown: the tasting menu was excellent and the staff were kind.`
          : `Quarterly results number ${i} are in and revenue grew faster than the analysts expected.`
      }), TAB)));
    await ingest.drain();

    const { stack } = fake.storage.local.dump();
    expect(stack).toHaveLength(5);
    expect(stack.every(i => i.assignedTag === 'Food' && i.textSnippet.includes('dinner'))).toBe(true);
    expect(stack[0].matchInfo).toMatchObject({ engine: 'System 1 (local embeddings)', globalMatchPrompt: 'restaurants and dinner spots' });
    expect(stack[0].decision).toMatchObject({ path: ['system1'], provider: 'system1', collect: true, escalated: false, uncertain: false });
    expect(stack[0].decision.pMatch).toBeCloseTo(0.95, 4);
    expect(batches).toBeLessThan(10); // one System 1 call per ingest batch, not per post
    const rejected = notified.filter(n => n.message.payload.status === 'rejected');
    expect(rejected).toHaveLength(5);
    expect(rejected[0].message.payload).toMatchObject({ reason: 'system1_no_match', pMatch: 0.04 });
  });

  test('a stored post re-sent with text the prompt now rejects is kept and hidden, never deleted', async () => {
    let verdict = true;
    const decideMany = async (items, ctx) => items.map(() => (verdict
      ? decision({ promptVersion: ctx.promptVersion, pMatch: 0.9 })
      : decision({ promptVersion: ctx.promptVersion, collect: false, pMatch: 0.1, path: ['system1'], provider: 'system1' })));
    const { fake, ingest, notified } = setup({ decideMany, config: { isMatchPromptEnabled: true, matchPrompt: 'developer tools', promptVersion: 3 } });

    await ingest.enqueue(post(60, { text: 'A new developer tool for teams…more' }), TAB);
    await ingest.drain();
    expect(fake.storage.local.dump().stack).toHaveLength(1);

    verdict = false;
    await ingest.enqueue(post(60, { text: 'A new developer tool for teams that turned out to be a cooking competition.', isUpdate: true }), TAB);
    await ingest.drain();
    let { stack, metrics } = fake.storage.local.dump();
    expect(stack).toHaveLength(1);
    expect(stack[0]).toMatchObject({ hiddenByPrompt: true, textSnippet: expect.stringContaining('cooking competition'), decision: { collect: false } });
    expect(metrics.counts).toEqual({});
    expect(notified.at(-1).message.payload).toMatchObject({ status: 'rejected', reason: 'system1_no_match' });

    // An exact re-send of the hidden post is reported as hidden, not collected.
    await ingest.enqueue(post(60, { text: 'A new developer tool for teams that turned out to be a cooking competition.' }), TAB);
    await ingest.drain();
    expect(notified.at(-1).message.payload).toMatchObject({ status: 'rejected', reason: 'hidden_by_prompt' });

    // Matching again un-hides it.
    verdict = true;
    await ingest.enqueue(post(60, { text: 'A new developer tool for teams, with plugins and a much faster CLI.', isUpdate: true }), TAB);
    await ingest.drain();
    ({ stack, metrics } = fake.storage.local.dump());
    expect(stack).toHaveLength(1);
    expect(stack[0].hiddenByPrompt).toBe(false);
    expect(metrics.counts).toEqual({ 'Tech/AI': 1 });
  });

  test('truncated then expanded (isUpdate) -> 1 item with the full text and no "…more"', async () => {
    const { fake, ingest } = setup();
    const truncated = 'Dinner at the new ramen place was great, the broth was…more';
    const full = 'Dinner at the new ramen place was great, the broth was rich and the noodles were perfect.';

    await ingest.enqueue(post(1, { text: truncated }), TAB);
    await ingest.drain();
    await ingest.enqueue(post(1, { text: full, isUpdate: true }), TAB);
    await ingest.drain();

    const { stack } = fake.storage.local.dump();
    expect(stack).toHaveLength(1);
    expect(stack[0].textSnippet).toBe(full);
    expect(stack[0].textSnippet).not.toMatch(/more$/);
  });

  test('truncated + expanded in the same burst coalesce into one clean item', async () => {
    const { fake, ingest } = setup();
    const full = 'Our team just shipped v2 of the CLI with plugin support and a much faster startup time.';
    await Promise.all([
      ingest.enqueue(post(2, { text: 'Our team just shipped v2 of the CLI with plugin…more' }), TAB),
      ingest.enqueue(post(2, { text: full, isUpdate: true }), TAB)
    ]);
    await ingest.drain();
    const { stack } = fake.storage.local.dump();
    expect(stack).toHaveLength(1);
    expect(stack[0].textSnippet).toBe(full);
  });

  test('a TAG_TOGGLED / config change committed during the drain is preserved', async () => {
    const gate = deferred();
    const entered = deferred();
    const decideMany = async (items) => {
      entered.resolve();
      await gate.promise;
      return items.map(() => decision({ tag: 'Unclassified', meta: { dynamicTag: 'Rust Conf' } }));
    };
    const { fake, ingest, handlers } = setup({ decideMany, config: { intelligence: { dynamicTags: true } } });

    await ingest.enqueue(post(3), TAB);
    const draining = ingest.drain();
    await entered.promise;

    // Decisions are in flight (outside the lock): the user edits configuration meanwhile.
    await handlers[MSG.TAG_TOGGLED]({ tag: 'Health', enabled: false });
    await handlers[MSG.KEYWORD_ADDED]({ keyword: 'crypto' });
    gate.resolve();
    await draining;

    const { configuration, stack } = fake.storage.local.dump();
    expect(configuration.trackedTags.find(t => t.label === 'Health').isEnabled).toBe(false);
    expect(configuration.ignoredKeywords).toEqual(['crypto']);
    // The opt-in dynamic tag was merged into the FRESH tag list, not a stale copy.
    expect(configuration.trackedTags.some(t => t.label === 'Rust Conf' && t.isDynamic)).toBe(true);
    expect(stack).toHaveLength(1);
    expect(stack[0].assignedTag).toBe('Rust Conf');
  });

  test('dynamic tags are not minted unless intelligence.dynamicTags is on', async () => {
    const decideMany = async (items) => items.map(() => decision({ tag: 'Unclassified', meta: { dynamicTag: 'Right' } }));
    const { fake, ingest } = setup({ decideMany });
    await ingest.enqueue(post(4), TAB);
    await ingest.drain();
    const { configuration, stack } = fake.storage.local.dump();
    expect(configuration.trackedTags.some(t => t.label === 'Right')).toBe(false);
    expect(stack[0].assignedTag).toBe('Unclassified');
  });

  test('rejected items are not stored; DECISION_RESULT and the rejection log record why', async () => {
    const decideMany = async (items) => items.map(it => (it.text.includes('SaaS')
      ? decision({ collect: false, tag: 'Unclassified', reason: 'eval_match_failed', pMatch: 0.08 })
      : decision()));
    const { fake, ingest, notified } = setup({ decideMany });

    await Promise.all([
      ingest.enqueue(post(5, { text: 'Five stars for our SaaS onboarding flow this quarter' }), TAB),
      ingest.enqueue(post(6), TAB)
    ]);
    await ingest.drain();

    const { stack } = fake.storage.local.dump();
    expect(stack).toHaveLength(1);
    expect(stack[0].postKey).toBe(post(6).postKey);

    // The verdict's reason (who rejected it); the decision's own note is kept as `detail`.
    const rejected = notified.find(n => n.message.payload.postKey === post(5).postKey);
    expect(rejected).toMatchObject({ tabId: 7, message: { type: MSG.DECISION_RESULT, payload: { status: 'rejected', reason: 'rules_no_match', pMatch: 0.08 } } });

    const log = fake.storage.session.peek(REJECTED_LOG_KEY);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ postKey: post(5).postKey, reason: 'rules_no_match', detail: 'eval_match_failed', pMatch: 0.08 });
  });

  test('the rejection log is a bounded ring', async () => {
    const decideMany = async (items) => items.map(() => decision({ collect: false, reason: 'eval_match_failed' }));
    const seeded = Array.from({ length: 199 }, (_, i) => ({ postKey: `old${i}` }));
    const { fake, ingest } = setup({ decideMany, session: { [REJECTED_LOG_KEY]: seeded } });
    await Promise.all([1, 2, 3].map(i => ingest.enqueue(post(i), TAB)));
    await ingest.drain();
    const log = fake.storage.session.peek(REJECTED_LOG_KEY);
    expect(log).toHaveLength(200);
    expect(log[log.length - 1].postKey).toBe(post(3).postKey);
  });

  test("ignored keyword 'ai' does not block 'said' (word boundaries, NFKC)", async () => {
    const { fake, ingest } = setup({ config: { ignoredKeywords: ['ai'] } });

    const said = await ingest.enqueue(post(7, { text: 'She said the conference talks were excellent this year' }), TAB);
    const ai = await ingest.enqueue(post(8, { text: 'New AI tools are changing how teams write code' }), TAB);
    const bold = await ingest.enqueue(post(9, { text: 'Why 𝐀𝐈 agents need better evaluation pipelines' }), TAB);
    await ingest.drain();

    expect(said.status).toBe('queued');
    expect(ai).toMatchObject({ status: 'ignored', reason: 'ignored_keyword' });
    expect(bold).toMatchObject({ status: 'ignored', reason: 'ignored_keyword' });
    const { stack } = fake.storage.local.dump();
    expect(stack.map(i => i.postKey)).toEqual([post(7).postKey]);
  });

  test('pause, ignored links and ignored domains are enforced at enqueue', async () => {
    const paused = setup({ config: { isTrackingPaused: true } });
    expect(await paused.ingest.enqueue(post(1), TAB)).toMatchObject({ status: 'ignored', reason: 'paused' });

    const { ingest, fake } = setup({
      config: { ignoredLinks: [post(2).postUrl], ignoredDomains: ['linkedin.com'] }
    });
    expect(await ingest.enqueue(post(2, { sourcePlatform: 'example.org' }), TAB)).toMatchObject({ status: 'ignored', reason: 'ignored_link' });
    expect(await ingest.enqueue(post(3), TAB)).toMatchObject({ status: 'ignored', reason: 'ignored_domain' });
    await ingest.drain();
    expect(fake.storage.local.dump().stack).toHaveLength(0);
    expect(tabMessagesOfType(fake, MSG.DECISION_RESULT)).toHaveLength(0); // notifyTab is injected
  });

  test('never-append invariant: stored text is always exactly one sent text', async () => {
    const { fake, ingest } = setup();
    const texts = [
      'Short first version of the post',
      'Short first version of the post with a bit more text after expanding',
      'Short first',
      'Short first version of the post',
      'Completely rewritten edit of the post (isUpdate)'
    ];
    for (const [i, text] of texts.entries()) {
      await ingest.enqueue(post(10, { text, isUpdate: i === 4 }), TAB);
      await ingest.drain();
      const { stack } = fake.storage.local.dump();
      expect(stack).toHaveLength(1);
      expect(texts).toContain(stack[0].textSnippet);
      expect(stack[0].textSnippet.length).toBeLessThanOrEqual(2000);
    }
    expect(fake.storage.local.dump().stack[0].textSnippet).toBe(texts[4]);

    // Oversized text is capped, never concatenated.
    await ingest.enqueue(post(11, { text: 'x'.repeat(2500) }), TAB);
    await ingest.drain();
    const long = fake.storage.local.dump().stack.find(i => i.postKey === post(11).postKey);
    expect(long.textSnippet).toHaveLength(2000);
  });

  test('legacy items: merged by sourceUrl only when it is a real permalink', async () => {
    const permalink = 'https://www.linkedin.com/feed/update/urn:li:activity:42/';
    const legacy = [
      { id: 'item_1', timestamp: 1, sourcePlatform: 'linkedin.com', sourceUrl: permalink, textSnippet: 'Old truncated text', assignedTag: 'Unclassified', tags: [], isFavorite: false },
      { id: 'item_2', timestamp: 2, sourcePlatform: 'linkedin.com', sourceUrl: 'https://www.linkedin.com/company/acme/posts/', textSnippet: 'Company page post A', assignedTag: 'Unclassified', tags: [], isFavorite: false }
    ];
    const { fake, ingest } = setup({ stack: legacy });

    // Old content script payload (no postKey): permalink -> merged and replaced, not appended.
    await ingest.enqueue({ text: 'Old truncated text, now complete with the full story', sourceUrl: permalink, sourcePlatform: 'linkedin.com' }, TAB);
    // Same company-page URL as item_2 but a different post -> a new item, never glued onto item_2.
    await ingest.enqueue({ text: 'Company page post B is a different post entirely', sourceUrl: 'https://www.linkedin.com/company/acme/posts/', sourcePlatform: 'linkedin.com' }, TAB);
    await ingest.drain();

    const { stack, metrics } = fake.storage.local.dump();
    expect(stack).toHaveLength(3);
    const merged = stack.find(i => i.id === 'item_1');
    expect(merged.textSnippet).toBe('Old truncated text, now complete with the full story');
    expect(merged.postKey).toMatch(/^url:/);
    expect(stack.find(i => i.id === 'item_2').textSnippet).toBe('Company page post A');
    expect(metrics.counts).toEqual({ 'Tech/AI': 2, Unclassified: 1 });
  });

  test('a migrated suspectMerged item heals: a fresh (shorter) copy of the post replaces the glued text', async () => {
    const permalink = 'https://www.linkedin.com/feed/update/urn:li:activity:77/';
    const glued = `${'First post about a tasting menu. '.repeat(40)}\n\n${'Second post about hiring engineers. '.repeat(40)}`;
    const migrated = [
      {
        id: 'item_1', timestamp: 1, sourcePlatform: 'linkedin.com', sourceUrl: permalink,
        postKey: 'url:https://www.linkedin.com/feed/update/urn:li:activity:77', textSnippet: glued,
        assignedTag: 'Unclassified', tags: [], isFavorite: false, legacy: true, suspectMerged: true
      },
      // Not suspect: a shorter re-send never replaces its text.
      {
        id: 'item_2', timestamp: 2, sourcePlatform: 'linkedin.com', sourceUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:78/',
        postKey: 'url:https://www.linkedin.com/feed/update/urn:li:activity:78', textSnippet: 'A complete post about a new developer tool for teams, already stored in full.',
        assignedTag: 'Unclassified', tags: [], isFavorite: false, legacy: true
      }
    ];
    expect(glued.length).toBeGreaterThan(2000);
    let calls = 0;
    const decideMany = async (items) => { calls += items.length; return items.map(() => decision()); };
    const { fake, ingest, notified } = setup({ stack: migrated, decideMany });

    await ingest.enqueue(post(0, { text: 'Post by: Ana\n\nFirst post about a tasting menu.', postKey: 'li:urn:li:activity:77', postUrl: permalink }), TAB);
    await ingest.enqueue(post(1, { text: 'A complete post', postKey: 'li:urn:li:activity:78', postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:78/' }), TAB);
    await ingest.drain();

    const { stack } = fake.storage.local.dump();
    expect(stack).toHaveLength(2);
    const healed = stack.find(i => i.id === 'item_1');
    expect(healed).toMatchObject({ postKey: 'li:urn:li:activity:77', textSnippet: 'Post by: Ana\n\nFirst post about a tasting menu.', assignedTag: 'Tech/AI' });
    expect(healed.suspectMerged).toBeUndefined();
    expect(healed.legacy).toBeUndefined();
    const kept = stack.find(i => i.id === 'item_2');
    expect(kept.textSnippet).toBe('A complete post about a new developer tool for teams, already stored in full.');
    expect(kept.legacy).toBe(true);
    // Only the suspect item was re-decided; the other re-send is a duplicate.
    expect(calls).toBe(1);
    expect(notified.map(n => n.message.payload)).toEqual(expect.arrayContaining([
      expect.objectContaining({ postKey: 'li:urn:li:activity:78', status: 'collected', reason: 'duplicate' })
    ]));
  });

  test('exact re-sends are not re-decided', async () => {
    let calls = 0;
    const decideMany = async (items) => { calls += items.length; return items.map(() => decision()); };
    const { ingest, notified } = setup({ decideMany });
    await ingest.enqueue(post(12), TAB);
    await ingest.drain();
    await ingest.enqueue(post(12), TAB);
    await ingest.drain();
    expect(calls).toBe(1);
    const last = notified[notified.length - 1].message.payload;
    expect(last).toMatchObject({ status: 'collected', reason: 'duplicate' });
  });

  test('decideMany failure stores without a verdict when no gate filters', async () => {
    const decideMany = async () => { throw new Error('model crashed'); };
    const { fake, ingest } = setup({ decideMany });
    await ingest.enqueue(post(13), TAB);
    await ingest.drain();
    const { stack } = fake.storage.local.dump();
    expect(stack).toHaveLength(1);
    expect(stack[0]).toMatchObject({ assignedTag: 'Unclassified', decision: { reason: 'decide_error', collect: true } });
  });

  test('the queue is mirrored to storage.session and restored by a new service worker', async () => {
    const never = new Promise(() => {});
    const first = setup({ decideMany: async () => never });
    await first.ingest.enqueue(post(20), TAB);
    await first.ingest.enqueue(post(21), TAB);
    await new Promise(r => setTimeout(r, 20));
    const mirrored = first.fake.storage.session.peek(PENDING_QUEUE_KEY);
    expect(mirrored.map(e => e.postKey).sort()).toEqual([post(20).postKey, post(21).postKey].sort());

    // "Restart": same session storage, fresh worker state.
    const second = setup({ session: { [PENDING_QUEUE_KEY]: mirrored } });
    expect(await second.ingest.restore()).toBe(2);
    await second.ingest.drain();
    expect(second.fake.storage.local.dump().stack).toHaveLength(2);
    expect(second.fake.storage.session.peek(PENDING_QUEUE_KEY)).toEqual([]);
  });

  test('a post queued while the drain writes its final queue mirror is still processed', async () => {
    const { fake, ingest } = setup();
    // storage.session writes take time in Chrome; hold each one until the test releases it.
    const realSet = fake.storage.session.set.bind(fake.storage.session);
    const writes = [];
    fake.storage.session.set = (items) => new Promise((resolve) => writes.push(() => resolve(realSet(items))));
    const tick = () => new Promise(r => setTimeout(r, 1));

    await ingest.enqueue(post(50), TAB);
    const draining = ingest.drain();
    // Post 50 commits while the first mirror write is still pending; the drain then waits on it.
    for (let i = 0; i < 500 && !(fake.storage.local.peek('stack') || []).length; i++) await tick();
    expect(fake.storage.local.peek('stack')).toHaveLength(1);
    expect(writes.length).toBe(1);

    // Post 51 arrives in that window: enqueue() joins the running drain instead of starting one.
    expect(await ingest.enqueue(post(51), TAB)).toMatchObject({ status: 'queued' });
    let settled = false;
    draining.then(() => { settled = true; });
    for (let i = 0; i < 2000 && !settled; i++) {
      while (writes.length) writes.shift()();
      await tick();
    }
    expect(settled).toBe(true);

    // No further enqueue or drain() call: the running drain must have picked post 51 up itself.
    expect(fake.storage.local.peek('stack').map(i => i.postKey).sort()).toEqual([post(50).postKey, post(51).postKey].sort());
    expect(ingest.pendingCount()).toBe(0);
    expect(fake.storage.session.peek(PENDING_QUEUE_KEY)).toEqual([]);
  });

  test('one coalesced STATE_UPDATED per burst, whitelisted and with inFlightCount', async () => {
    const { fake, ingest, broadcast } = setup({ batchSize: 4 });
    await Promise.all(Array.from({ length: 8 }, (_, i) => ingest.enqueue(post(30 + i), TAB)));
    await ingest.drain();
    await broadcast.scheduleBroadcast();
    const updates = fake.runtime.sent.map(s => s.message).filter(m => m.type === MSG.STATE_UPDATED);
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates.length).toBeLessThanOrEqual(3);
    for (const u of updates) {
      expect(Object.keys(u.payload).sort()).toEqual(['configuration', 'inFlightCount', 'metrics', 'stack', 'telemetry']);
    }
    expect(updates[updates.length - 1].payload.inFlightCount).toBe(0);
    expect(fake.runtime.sent.some(s => s.message.type === MSG.INFLIGHT_UPDATED)).toBe(true);
  });
});

describe('re-label and idle retry (decide outside the lock, commit by id)', () => {
  const stored = (id, extra = {}) => ({
    id, postKey: `k-${id}`, timestamp: 1, sourcePlatform: 'linkedin.com', sourceUrl: '', textSnippet: `text of ${id}`,
    assignedTag: 'Unclassified', tags: [], isFavorite: false, favoritedAt: null, isAd: false, ...extra
  });

  test('re-label never deletes, keeps manual tags and does not resurrect items deleted meanwhile', async () => {
    const gate = deferred();
    const entered = deferred();
    const decideMany = async (items) => {
      entered.resolve();
      await gate.promise;
      return items.map(it => (it.id === 'c'
        ? decision({ tag: 'Jobs', collect: false, reason: 'eval_match_failed' })
        : decision({ tag: 'Jobs' })));
    };
    const { fake, store, broadcast, ingest, handlers } = setup({
      decideMany: acceptAll,
      stack: [stored('a', { assignedTag: 'Health', matchInfo: { engine: 'Manual Override', manual: true } }), stored('b'), stored('c')]
    });
    const relabel = createRelabeler({ store, decideMany, broadcast, debounceMs: 0 });

    const running = relabel.run();
    await entered.promise;
    await handlers[MSG.ITEM_DELETED]({ itemId: 'b' });
    await ingest.enqueue(post(40), TAB);
    await ingest.drain();
    gate.resolve();
    expect(await running).toEqual({ cancelled: false, updated: 1 });

    const { stack, metrics } = fake.storage.local.dump();
    expect(stack.map(i => i.id).sort()).toEqual(['a', 'c', stack.find(i => i.postKey === post(40).postKey).id].sort());
    expect(stack.find(i => i.id === 'a').assignedTag).toBe('Health');
    // A re-label that the gate rejects keeps the item (never deleted) and records the decision.
    expect(stack.find(i => i.id === 'c')).toMatchObject({ assignedTag: 'Jobs', decision: { collect: false } });
    expect(metrics.counts).toEqual({ Health: 1, Jobs: 1, 'Tech/AI': 1 });
  });

  test('a newer re-label run cancels an older one', async () => {
    const gate = deferred();
    let calls = 0;
    const decideMany = async (items) => { calls++; if (calls === 1) await gate.promise; return items.map(() => decision({ tag: 'Jobs' })); };
    const { store, broadcast } = setup({ stack: [stored('a')] });
    const relabel = createRelabeler({ store, decideMany, broadcast, debounceMs: 0 });
    const first = relabel.run();
    await new Promise(r => setTimeout(r, 5));
    const second = relabel.run();
    gate.resolve();
    expect(await first).toMatchObject({ cancelled: true });
    expect(await second).toMatchObject({ cancelled: false, updated: 1 });
  });

  test('idle retry re-tags Unclassified items by id and respects a manual retag made meanwhile', async () => {
    const gate = deferred();
    const entered = deferred();
    const decideMany = async (items, ctx) => {
      expect(ctx.purpose).toBe('retry');
      entered.resolve();
      await gate.promise;
      return items.map(it => (it.id === 'y' ? decision({ tag: 'Unclassified' }) : decision({ tag: 'Health' })));
    };
    const { fake, store, broadcast, handlers } = setup({ stack: [stored('x'), stored('y'), stored('z'), stored('done', { assignedTag: 'Jobs' })] });
    const retry = createIdleRetry({ store, decideMany, broadcast, batchSize: 5 });

    const running = retry.run();
    await entered.promise;
    await handlers[MSG.ITEM_RETAGGED]({ itemId: 'z', newTag: 'Sports' });
    gate.resolve();
    expect(await running).toEqual({ tried: 3, updated: 1 });

    const { stack, metrics } = fake.storage.local.dump();
    expect(stack.find(i => i.id === 'x')).toMatchObject({ assignedTag: 'Health', tags: [{ name: 'Health', score: 1 }] });
    expect(stack.find(i => i.id === 'y').assignedTag).toBe('Unclassified');
    expect(stack.find(i => i.id === 'z')).toMatchObject({ assignedTag: 'Sports', matchInfo: { manual: true } });
    expect(metrics.counts).toEqual({ Health: 1, Unclassified: 1, Sports: 1, Jobs: 1 });
  });

  test('idle retry skips while ingestion is busy and bounds attempts per item', async () => {
    let calls = 0;
    const decideMany = async (items) => { calls++; return items.map(() => decision({ tag: 'Unclassified' })); };
    const { store, broadcast } = setup({ stack: [stored('x')] });
    let busy = true;
    const retry = createIdleRetry({ store, decideMany, broadcast, isBusy: () => busy, maxAttempts: 2 });
    expect(await retry.run()).toEqual({ tried: 0, updated: 0 });
    busy = false;
    await retry.run();
    await retry.run();
    await retry.run();
    expect(calls).toBe(2);
  });

  test('idle retry attempts survive service-worker restarts and rotate through every item', async () => {
    const tried = [];
    const decideMany = async (items) => { tried.push(items.map(i => i.id)); return items.map(() => decision({ tag: 'Unclassified' })); };
    const ids = Array.from({ length: 8 }, (_, i) => `item_${i + 1}`);
    const { fake, store, broadcast, handlers } = setup({ stack: ids.map(id => stored(id)) });
    // Every alarm wakes a fresh service worker: a new createIdleRetry each time, same storage.session.
    const alarm = () => createIdleRetry({ store, decideMany, broadcast, session: fake.storage.session, maxAttempts: 3, batchSize: 5 }).run();

    for (let i = 0; i < 8; i++) await alarm();
    const perItem = Object.fromEntries(ids.map(id => [id, tried.flat().filter(x => x === id).length]));
    expect(tried[0]).toEqual(['item_1', 'item_2', 'item_3', 'item_4', 'item_5']);
    expect(tried[1].slice(0, 3)).toEqual(['item_6', 'item_7', 'item_8']); // the older items get their turn
    expect(Object.values(perItem).every(n => n === 3)).toBe(true); // bounded, and nobody starved
    expect(tried.flat()).toHaveLength(24);
    expect(await alarm()).toEqual({ tried: 0, updated: 0 });
    expect(fake.storage.session.peek(RETRY_ATTEMPTS_KEY).counts).toEqual(Object.fromEntries(ids.map(id => [id, 3])));

    // A tag change can make old posts classifiable: the counts start over.
    await handlers[MSG.TAG_TOGGLED]({ tag: 'Health', enabled: false });
    expect((await alarm()).tried).toBe(5);
  });
});
