/**
 * Regression: an ingest batch that is still being decided when the prompt, the gate or the tags
 * change must not be committed with the verdict for the old configuration (the re-decide job the
 * change starts took its snapshot before the batch was stored, and a re-send of the post only hits
 * the duplicate shortcut). The batch is decided again for the new configuration instead.
 */
import { describe, test, expect } from 'vitest';
import { createFakeChrome } from '../helpers/fake-chrome.js';
import { createStore } from '../../lib/bg/store.js';
import { createBroadcaster } from '../../lib/bg/broadcast.js';
import { createHandlers } from '../../lib/bg/handlers/index.js';
import { defaultConfiguration } from '../../lib/bg/defaults.js';
import { emptyTelemetry } from '../../lib/bg/stack-utils.js';
import { createIngest, MAX_STALE_REDECIDES } from '../../lib/pipeline/ingest.js';
import { createRedecider } from '../../lib/pipeline/redecide.js';
import { createIdleRetry } from '../../lib/pipeline/retry.js';
import { decisionFingerprint } from '../../lib/pipeline/apply-decision.js';
import { createCascade } from '../../lib/decision/cascade.js';
import { createRulesProvider } from '../../lib/decision/providers/rules.js';
import { MSG } from '../../lib/messages.js';

const TAB = { tab: { id: 3 } };
const FOOD = { id: 't-food', label: 'Food', prompt: 'Find posts about food.', isEnabled: true };
const BITCOIN = { id: 't-btc', label: 'Bitcoin', prompt: 'Find posts about crypto.', isEnabled: true };
const CRYPTO_POST = 'Bitcoin price breaks a new all time record today, here is my crypto portfolio update.';
const MICHELIN_POST = 'Our Michelin restaurant just launched a new seasonal tasting menu for the autumn.';

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

/**
 * System 1 stand-in: matches_prompt by word overlap with the prompt, primary_tag by a tag label in
 * the text. holdNext() makes the next call wait until released (a batch "in flight").
 */
function fakeSystem1() {
  /** @type {{ prompt: string, questions: string[], tags: string[] }[]} */
  const calls = [];
  let hold = null;
  return {
    calls,
    isReady: () => true,
    floor: { matches_prompt: 0.3, primary_tag: 0.3 },
    holdNext() {
      const entered = deferred();
      const release = deferred();
      hold = { entered, release };
      return { entered: entered.promise, release: () => release.resolve() };
    },
    async decideBatch({ items, questions, context }) {
      calls.push({ prompt: context.prompt.raw, questions: Object.keys(questions), tags: context.tags.map(t => t.label) });
      if (hold) {
        const h = hold;
        hold = null;
        h.entered.resolve();
        await h.release.promise;
      }
      const words = String(context.prompt.raw || '').toLowerCase().split(/\W+/).filter(w => w.length > 3);
      return {
        results: items.map((it) => {
          const text = it.text.toLowerCase();
          const answers = {};
          if (questions.matches_prompt) answers.matches_prompt = { noul: words.some(w => text.includes(w)) ? 0.95 : 0.05 };
          if (questions.primary_tag) {
            const labels = Object.keys(questions.primary_tag.criteria || {}).filter(l => l !== 'none');
            const pick = labels.find(l => text.includes(l.toLowerCase())) || null;
            answers.primary_tag = { choice: pick, probabilities: pick ? { [pick]: 0.9, none: 0.1 } : { none: 0.95 } };
          }
          return { id: it.id, answers };
        })
      };
    }
  };
}

function setup(config) {
  const fake = createFakeChrome({
    local: {
      configuration: { ...defaultConfiguration(), intelligence: { escalation: { provider: 'none' } }, ...config },
      stack: config.stack || [],
      metrics: { counts: {} },
      telemetry: emptyTelemetry(0)
    },
    session: {}
  });
  const store = createStore({ area: fake.storage.local });
  const broadcast = createBroadcaster({ area: fake.storage.local, runtime: fake.runtime, tabs: fake.tabs, delayMs: 5 });
  const system1 = fakeSystem1();
  const { decideMany } = createCascade({ system1, rules: createRulesProvider() });
  /** @type {object[]} */
  const notified = [];
  const ingest = createIngest({
    store,
    decideMany,
    broadcast,
    notifyTab: (_tabId, message) => { notified.push(message.payload); },
    session: fake.storage.session,
    settleMs: 0
  });
  const redecide = createRedecider({ store, decideMany, broadcast, debounceMs: 10 });
  const handlers = createHandlers({
    store,
    broadcast,
    ingest,
    redecide,
    engine: {
      extractTagsFromPrompt: async () => [],
      enhanceMatchPrompt: async () => 'enhanced',
      autoSuggestTagPrompt: async (t) => `Find posts related to ${t}.`
    }
  });
  return { fake, store, broadcast, system1, decideMany, ingest, redecide, handlers, notified };
}

const post = (text, n = 1) => ({
  text,
  sourcePlatform: 'linkedin.com',
  postUrl: `https://www.linkedin.com/feed/update/urn:li:activity:730100000000000000${n}/`,
  authorName: 'Someone'
});

/**
 * Enqueues `payload`, lets its batch reach System 1, runs `change` while the batch is held, then
 * releases it and waits for the queue and every re-decide job.
 */
async function decideDuringChange(env, payload, change) {
  const held = env.system1.holdNext();
  await env.ingest.enqueue(payload, TAB);
  const draining = env.ingest.drain();
  await held.entered;
  await change();
  await env.redecide.idle(); // the job the change started has already taken its snapshot
  held.release();
  await draining;
  await env.ingest.drain();
  await env.redecide.idle();
}

describe('ingest: configuration changed while a batch is being decided', () => {
  test('gate switched on: the post is decided again with the gate and rejected, not stored as collected', async () => {
    const env = setup({ isMatchPromptEnabled: false, matchPrompt: 'michelin restaurant', matchPromptEnhanced: 'fine dining', promptVersion: 3, trackedTags: [FOOD] });

    await decideDuringChange(env, post(CRYPTO_POST), () => env.handlers[MSG.TOGGLE_MATCH_PROMPT]({ isEnabled: true }));

    const { stack, configuration } = env.fake.storage.local.dump();
    expect(configuration.isMatchPromptEnabled).toBe(true);
    // A fresh ingest under the new configuration rejects this post: so must the in-flight one.
    expect(stack).toHaveLength(0);
    expect(env.system1.calls.map(c => c.questions.includes('matches_prompt'))).toEqual([false, true]);
    expect(env.notified).toHaveLength(1);
    expect(env.notified[0]).toMatchObject({ status: 'rejected', reason: 'system1_no_match' });
  });

  test('prompt edited: the post is decided for the new prompt (version) and rejected', async () => {
    const env = setup({ isMatchPromptEnabled: true, matchPrompt: 'michelin restaurant', matchPromptEnhanced: 'fine dining', promptVersion: 1, trackedTags: [FOOD] });

    await decideDuringChange(env, post(MICHELIN_POST), () => env.handlers[MSG.UPDATE_MATCH_PROMPT]({ prompt: 'bitcoin crypto' }));

    const { stack, configuration } = env.fake.storage.local.dump();
    expect(configuration.promptVersion).toBe(2);
    expect(stack).toHaveLength(0);
    expect(env.system1.calls.map(c => c.prompt)).toEqual(['michelin restaurant', 'bitcoin crypto']);
    expect(env.notified.map(n => n.status)).toEqual(['rejected']);
  });

  test('prompt edited to one the post matches: stored with the current prompt version', async () => {
    const env = setup({ isMatchPromptEnabled: true, matchPrompt: 'michelin restaurant', matchPromptEnhanced: 'fine dining', promptVersion: 1, trackedTags: [FOOD] });

    await decideDuringChange(env, post(CRYPTO_POST), () => env.handlers[MSG.UPDATE_MATCH_PROMPT]({ prompt: 'bitcoin crypto' }));

    const { stack } = env.fake.storage.local.dump();
    expect(stack).toHaveLength(1);
    expect(stack[0].decision).toMatchObject({ promptVersion: 2, collect: true, pMatch: 0.95 });
    expect(stack[0].hiddenByPrompt).toBeUndefined();
  });

  test('tag removed: the post never gets the removed tag', async () => {
    const env = setup({ isMatchPromptEnabled: false, matchPrompt: '', promptVersion: 1, trackedTags: [FOOD, BITCOIN] });

    await decideDuringChange(env, post(CRYPTO_POST), async () => {
      await env.handlers[MSG.TAG_REMOVED]({ tag: 'Bitcoin' });
    });

    const { stack, configuration } = env.fake.storage.local.dump();
    expect(configuration.trackedTags.map(t => t.label)).toEqual(['Food']);
    expect(stack).toHaveLength(1);
    expect(stack[0].assignedTag).toBe('Unclassified');
    expect(env.system1.calls.map(c => c.tags)).toEqual([['Food', 'Bitcoin'], ['Food']]);
    expect(env.notified.map(n => n.status)).toEqual(['collected']);
  });

  test('a change that does not affect decisions (ignored keyword, site) commits the batch as decided', async () => {
    const env = setup({ isMatchPromptEnabled: false, matchPrompt: '', trackedTags: [FOOD, BITCOIN] });

    await decideDuringChange(env, post(CRYPTO_POST), async () => {
      await env.handlers[MSG.KEYWORD_ADDED]({ keyword: 'weather' });
    });

    const { stack } = env.fake.storage.local.dump();
    expect(env.system1.calls).toHaveLength(1);
    expect(stack).toHaveLength(1);
    expect(stack[0].assignedTag).toBe('Bitcoin');
  });

  test('a newer copy queued meanwhile absorbs the re-queued post: one item, one more decision', async () => {
    const env = setup({ isMatchPromptEnabled: false, matchPrompt: '', trackedTags: [FOOD, BITCOIN] });
    const longer = `${CRYPTO_POST} Also: the halving is coming and fees are rising again this week.`;

    await decideDuringChange(env, post(CRYPTO_POST), async () => {
      await env.handlers[MSG.TAG_REMOVED]({ tag: 'Bitcoin' });
      await env.ingest.enqueue({ ...post(longer), isUpdate: true }, TAB);
    });

    const { stack } = env.fake.storage.local.dump();
    expect(stack).toHaveLength(1);
    expect(stack[0].textSnippet).toBe(longer);
    expect(stack[0].assignedTag).toBe('Unclassified');
    expect(env.system1.calls).toHaveLength(2);
    expect(env.ingest.pendingCount()).toBe(0);
  });

  test('a configuration that changes on every batch cannot stall the queue (bounded re-decides)', async () => {
    let calls = 0;
    const fakeEnv = setup({ isMatchPromptEnabled: false, trackedTags: [FOOD] });
    const { store, broadcast, fake } = fakeEnv;
    const decideMany = async (items) => {
      calls++;
      await store.mutateConfig(cfg => ({ ...cfg, trackedTags: [{ ...FOOD, prompt: `Find posts about food, take ${calls}.` }] }));
      return items.map(() => ({ v: 1, path: ['system1'], provider: 'system1', tag: 'Unclassified', tags: [], collect: true }));
    };
    const ingest = createIngest({ store, decideMany, broadcast, session: null, settleMs: 0 });
    await ingest.enqueue(post(CRYPTO_POST), TAB);
    await ingest.drain();
    expect(calls).toBe(MAX_STALE_REDECIDES + 1);
    expect(fake.storage.local.dump().stack).toHaveLength(1);
  });
});

describe('idle retry: configuration changed while deciding', () => {
  test('a tag removed meanwhile is never assigned', async () => {
    const item = {
      id: 'r1', postKey: 'k-r1', timestamp: 1, sourcePlatform: 'linkedin.com', sourceUrl: '', textSnippet: CRYPTO_POST,
      assignedTag: 'Unclassified', tags: [], isFavorite: false, favoritedAt: null, isAd: false
    };
    const env = setup({ isMatchPromptEnabled: false, trackedTags: [FOOD, BITCOIN], stack: [item] });
    const retry = createIdleRetry({ store: env.store, decideMany: env.decideMany, broadcast: env.broadcast, session: null });

    const held = env.system1.holdNext();
    const running = retry.run();
    await held.entered;
    await env.handlers[MSG.TAG_REMOVED]({ tag: 'Bitcoin' });
    held.release();
    expect(await running).toMatchObject({ updated: 0 });
    expect(env.fake.storage.local.dump().stack[0].assignedTag).toBe('Unclassified');

    // The next pass (new tag set) decides it with the current tags.
    await env.redecide.idle();
    expect(await retry.run()).toMatchObject({ updated: 0 });
    expect(env.fake.storage.local.dump().stack[0].assignedTag).toBe('Unclassified');
  });
});

describe('decisionFingerprint', () => {
  const base = { isMatchPromptEnabled: true, matchPrompt: 'restaurants', promptVersion: 4, trackedTags: [FOOD] };

  test('changes with the gate, the prompt version, the tags and the gate policy', () => {
    const fp = decisionFingerprint(base);
    expect(decisionFingerprint({ ...base, isMatchPromptEnabled: false })).not.toBe(fp);
    expect(decisionFingerprint({ ...base, promptVersion: 5 })).not.toBe(fp);
    expect(decisionFingerprint({ ...base, matchPromptEnhanced: 'fine dining' })).not.toBe(fp);
    expect(decisionFingerprint({ ...base, trackedTags: [FOOD, BITCOIN] })).not.toBe(fp);
    expect(decisionFingerprint({ ...base, trackedTags: [{ ...FOOD, isEnabled: false }] })).not.toBe(fp);
    expect(decisionFingerprint({ ...base, trackedTags: [{ ...FOOD, prompt: 'Find posts about cooking.' }] })).not.toBe(fp);
    expect(decisionFingerprint({ ...base, intelligence: { gate: { strictness: 'strict' } } })).not.toBe(fp);
    expect(decisionFingerprint({ ...base, intelligence: { system1: { model: 'bge-small' } } })).not.toBe(fp);
  });

  test('ignores settings that do not change a verdict', () => {
    const fp = decisionFingerprint(base);
    expect(decisionFingerprint({ ...base, ignoredKeywords: ['crypto'], sites: [{ id: 's', domain: 'x.com' }] })).toBe(fp);
    expect(decisionFingerprint({ ...base, intelligence: { escalation: { provider: 'jev' } } })).toBe(fp);
    // With the gate off the prompt does not affect any decision.
    const off = { ...base, isMatchPromptEnabled: false };
    expect(decisionFingerprint({ ...off, promptVersion: 9, matchPrompt: 'other' })).toBe(decisionFingerprint(off));
  });
});
