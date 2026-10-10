import { describe, test, expect } from 'vitest';
import { createFakeChrome, runtimeMessagesOfType, tabMessagesOfType } from '../helpers/fake-chrome.js';
import { createStore } from '../../lib/bg/store.js';
import { createBroadcaster } from '../../lib/bg/broadcast.js';
import { createHandlers } from '../../lib/bg/handlers/index.js';
import { defaultConfiguration } from '../../lib/bg/defaults.js';
import {
  emptyTelemetry,
  shouldHideByPrompt,
  pruneEmptyDynamicTags,
  computeCounts,
  isManualItem
} from '../../lib/bg/stack-utils.js';
import { createIngest } from '../../lib/pipeline/ingest.js';
import {
  createRedecider,
  isRulesDecided,
  isRedecideTarget,
  widerScope,
  parseScope,
  redeciderFrom,
  REDECIDE_BATCH_SIZE
} from '../../lib/pipeline/redecide.js';
import { createRelabeler } from '../../lib/pipeline/relabel.js';
import { MSG } from '../../lib/messages.js';

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

/** '#Jobs' in the text -> tag 'Jobs'. */
const tagFor = (text) => (/#([\w/]+)/.exec(text)?.[1] ?? 'Unclassified');

/**
 * Fake DecideMany: with the gate on, a post matches when its text contains the prompt (case-insensitive).
 *
 * @param {{ hold?: (items: any[], ctx: any, call: number) => Promise<void>|void, path?: string[], tagOverride?: string }} [opts]
 */
function fakeDecider({ hold, path = ['system1'], tagOverride } = {}) {
  const calls = [];
  async function decideMany(items, ctx) {
    const call = calls.length + 1;
    calls.push({ ids: items.map(i => i.id), ctx });
    if (hold) await hold(items, ctx, call);
    const prompt = String(ctx.configuration.matchPrompt || '').trim().toLowerCase();
    return items.map(it => {
      const matches = !ctx.gateOn || it.text.toLowerCase().includes(prompt);
      const tag = tagOverride ?? tagFor(it.text);
      return {
        v: 1, promptVersion: ctx.promptVersion, specHash: 'test', path: [...path], provider: path[path.length - 1],
        pMatch: ctx.gateOn ? (matches ? 0.9 : 0.1) : null, matchConfidence: ctx.gateOn ? 0.8 : null,
        tag, tagConfidence: 0.9, tags: tag === 'Unclassified' ? [] : [{ name: tag, score: 0.9 }],
        escalated: false, uncertain: false, reason: null, collect: matches, latencyMs: 1, at: 1
      };
    });
  }
  return { decideMany, calls, decidedIds: () => calls.flatMap(c => c.ids) };
}

const acceptAll = async (items, ctx) => items.map(() => ({
  v: 1, promptVersion: ctx.promptVersion, specHash: 'ingest', path: ['system1'], provider: 'system1',
  pMatch: 0.95, matchConfidence: 0.9, tag: 'Food', tagConfidence: 0.9, tags: [{ name: 'Food', score: 0.9 }],
  escalated: false, uncertain: false, reason: null, collect: true, latencyMs: 1, at: 1
}));

/** A stored item whose decision was made for prompt version `pv`. */
function stored(id, text, extra = {}, pv = 0) {
  return {
    id, postKey: `k-${id}`, timestamp: 1, sourcePlatform: 'linkedin.com', sourceUrl: '', textSnippet: text,
    assignedTag: 'Unclassified', tags: [], isFavorite: false, favoritedAt: null, isAd: false,
    decision: {
      v: 1, promptVersion: pv, specHash: 'old', path: ['system1'], provider: 'system1', pMatch: 0.9, matchConfidence: 0.8,
      tag: 'Unclassified', tagConfidence: 0.5, tags: [], escalated: false, uncertain: false, reason: null,
      collect: true, latencyMs: 1, at: 1
    },
    matchInfo: { engine: 'System 1 (local embeddings)' },
    ...extra
  };
}

const GATE = (prompt, promptVersion = 1, extra = {}) => ({ isMatchPromptEnabled: true, matchPrompt: prompt, promptVersion, ...extra });

function setup({ config = {}, stack = [], decider = fakeDecider(), ingestDecideMany = acceptAll, batchSize, debounceMs = 5, tabs = [], onTabMessage = () => ({ success: true }) } = {}) {
  const fake = createFakeChrome({
    local: {
      configuration: { ...defaultConfiguration(), ...config },
      stack,
      metrics: { counts: {} },
      telemetry: { ...emptyTelemetry(0), totalProcessed: stack.length }
    },
    tabs,
    onTabMessage
  });
  const store = createStore({ area: fake.storage.local });
  const broadcast = createBroadcaster({ area: fake.storage.local, runtime: fake.runtime, tabs: fake.tabs, delayMs: 5 });
  const redecide = createRedecider({
    store,
    decideMany: decider.decideMany,
    broadcast,
    debounceMs,
    ...(batchSize ? { batchSize } : {})
  });
  const ingest = createIngest({
    store,
    decideMany: ingestDecideMany,
    broadcast,
    notifyTab: () => {},
    session: fake.storage.session,
    settleMs: 0
  });
  const handlers = createHandlers({
    store,
    broadcast,
    ingest,
    redecide,
    engine: {
      checkEngineStatus: async () => ({ tier: 3, name: 'Rule-based Classifier', status: 'ready' }),
      extractTagsFromPrompt: async () => [],
      enhanceMatchPrompt: async (p) => `Collect posts about ${p}.`,
      autoSuggestTagPrompt: async (t) => `Find posts related to ${t}.`
    }
  });
  const items = () => fake.storage.local.peek('stack');
  const byId = (id) => items().find(i => i.id === id);
  const progress = () => runtimeMessagesOfType(fake, MSG.REDECIDE_PROGRESS).map(m => m.payload);
  return { fake, store, broadcast, redecide, ingest, handlers, decider, items, byId, progress };
}

describe('re-decide after a prompt change', () => {
  test('hides non-matching items, un-hides matching ones, never deletes', async () => {
    const stack = [
      stored('a', 'Best ramen shop in town #Food', {}, 1),
      stored('b', 'Sushi bar opening on Main street #Food', {}, 1),
      stored('c', 'Ramen and sushi tasting menu #Food', {}, 1),
      stored('d', 'We are hiring engineers #Jobs', {}, 1)
    ];
    const { handlers, redecide, items, byId, progress, decider, fake } = setup({ config: GATE('ramen', 1), stack });

    await handlers[MSG.UPDATE_MATCH_PROMPT]({ prompt: 'sushi' });
    expect(redecide.isScheduled).toBe(true);
    await redecide.idle();

    expect(items().map(i => i.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(byId('a').hiddenByPrompt).toBe(true);
    expect(byId('b').hiddenByPrompt).toBe(false);
    expect(byId('c').hiddenByPrompt).toBe(false);
    expect(byId('d').hiddenByPrompt).toBe(true);
    expect(byId('b')).toMatchObject({ assignedTag: 'Food', decision: { promptVersion: 2, collect: true } });
    expect(byId('d')).toMatchObject({ assignedTag: 'Jobs', decision: { promptVersion: 2, collect: false } });
    // Every re-decide call is a 'redecide' (the cascade never escalates those to cloud).
    expect(decider.calls.every(c => c.ctx.purpose === 'redecide')).toBe(true);
    // metrics.counts counts what the feed shows.
    expect(fake.storage.local.peek('metrics').counts).toEqual({ Food: 2 });

    const last = progress().at(-1);
    expect(last).toMatchObject({ done: 4, total: 4, hidden: 2, finished: true });
    expect(typeof last.jobId).toBe('string');

    await handlers[MSG.UPDATE_MATCH_PROMPT]({ prompt: 'ramen' });
    await redecide.idle();
    expect(items().map(i => i.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(byId('a').hiddenByPrompt).toBe(false);
    expect(byId('b').hiddenByPrompt).toBe(true);
    expect(byId('c').hiddenByPrompt).toBe(false);
    expect(byId('a').decision.promptVersion).toBe(3);
  });

  test('keystroke bursts are debounced into one job and one tab rescan', async () => {
    const stack = [stored('a', 'ramen #Food', {}, 1), stored('b', 'sushi #Food', {}, 1)];
    const { handlers, redecide, decider, byId, fake } = setup({
      config: GATE('ramen', 1), stack, debounceMs: 20, tabs: [{ id: 3, url: 'https://www.linkedin.com/feed/' }]
    });
    await handlers[MSG.UPDATE_MATCH_PROMPT]({ prompt: 's' });
    await handlers[MSG.UPDATE_MATCH_PROMPT]({ prompt: 'su' });
    await handlers[MSG.UPDATE_MATCH_PROMPT]({ prompt: 'sushi' });
    expect(tabMessagesOfType(fake, MSG.RESET_AND_RESCAN)).toHaveLength(0);
    await redecide.idle();
    await tick(5);
    expect(decider.calls).toHaveLength(1);
    expect(decider.calls[0].ctx.configuration.matchPrompt).toBe('sushi');
    expect(byId('a').hiddenByPrompt).toBe(true);
    expect(byId('b').hiddenByPrompt).toBe(false);
    // Posts the old prompt rejected on the open page are offered again, once per debounced job.
    expect(tabMessagesOfType(fake, MSG.RESET_AND_RESCAN)).toHaveLength(1);
  });

  test('open tabs rescan only after the job committed: a re-sent hidden post is reported hidden_by_prompt', async () => {
    const gate = deferred();
    const entered = deferred();
    const decider = fakeDecider({ hold: async () => { entered.resolve(); await gate.promise; } });
    const stack = [stored('a', 'Best ramen in town #Food', { postKey: 'li:urn:li:activity:1' }, 1)];
    const rescans = [];
    let onRescan = () => ({ success: true });
    const { handlers, redecide, fake, store, broadcast } = setup({
      config: GATE('ramen', 1), stack, decider, tabs: [{ id: 3, url: 'https://www.linkedin.com/feed/' }],
      onTabMessage: (tabId, msg) => (msg.type === MSG.RESET_AND_RESCAN ? onRescan() : { success: true })
    });
    const notified = [];
    const ingest = createIngest({
      store, decideMany: decider.decideMany, broadcast, settleMs: 0, session: fake.storage.session,
      notifyTab: (tabId, msg) => notified.push(msg.payload)
    });
    // What content.js does on RESET_AND_RESCAN: the page re-sends the stored post, text unchanged.
    let resent = null;
    onRescan = () => {
      rescans.push(fake.storage.local.peek('stack')[0].hiddenByPrompt === true);
      resent = ingest.enqueue({ text: 'Best ramen in town #Food', postKey: 'li:urn:li:activity:1', sourcePlatform: 'linkedin.com' }, { tab: { id: 3 } });
      return resent.then(() => ({ success: true }));
    };

    await handlers[MSG.UPDATE_MATCH_PROMPT]({ prompt: 'sushi' });
    await entered.promise;
    // The job is deciding: no rescan yet (the re-sent post would meet its stale 'collected' verdict).
    expect(tabMessagesOfType(fake, MSG.RESET_AND_RESCAN)).toHaveLength(0);
    gate.resolve();
    await redecide.idle();
    // The rescan reaches the tab asynchronously; wait until the re-sent post is queued, then for it.
    for (let i = 0; i < 200 && !resent; i++) await tick(5);
    await resent;
    await ingest.drain();

    expect(tabMessagesOfType(fake, MSG.RESET_AND_RESCAN)).toHaveLength(1);
    expect(rescans).toEqual([true]);
    expect(notified.at(-1)).toMatchObject({ postKey: 'li:urn:li:activity:1', status: 'rejected', reason: 'hidden_by_prompt' });
  });

  test('the rescan request carries over to a job that supersedes it; cancel() drops it', async () => {
    const gate = deferred();
    const entered = deferred();
    const decider = fakeDecider({
      hold: async (items, ctx, call) => {
        if (call === 1) {
          entered.resolve();
          await gate.promise;
        }
      }
    });
    const { redecide, fake } = setup({
      config: GATE('ramen', 1), stack: [stored('a', 'Ramen #Food', {}, 1)], decider, tabs: [{ id: 3, url: 'https://www.linkedin.com/feed/' }]
    });
    const first = redecide.start({ scope: 'prompt', rescan: true });
    await entered.promise;
    const second = redecide.start({ scope: 'rules-only' });
    gate.resolve();
    expect(await redecide.wait(first)).toMatchObject({ cancelled: true });
    expect(await redecide.wait(second)).toMatchObject({ cancelled: false, scope: 'prompt' });
    await tick(5);
    expect(tabMessagesOfType(fake, MSG.RESET_AND_RESCAN)).toHaveLength(1);

    // cancel() drops a scheduled job and its rescan request alike.
    redecide.schedule({ scope: 'prompt', rescan: true, delayMs: 20 });
    redecide.cancel();
    await tick(40);
    await redecide.idle();
    expect(tabMessagesOfType(fake, MSG.RESET_AND_RESCAN)).toHaveLength(1);

    // Debounced schedules merge their rescan requests into the one job.
    const merged = redecide.schedule({ scope: 'prompt', rescan: true, delayMs: 20 });
    redecide.schedule({ scope: 'all', delayMs: 20 });
    expect(await redecide.wait(await merged)).toMatchObject({ cancelled: false, scope: 'all' });
    await tick(5);
    expect(tabMessagesOfType(fake, MSG.RESET_AND_RESCAN)).toHaveLength(2);

    // A job without a rescan request does not rescan.
    await redecide.wait(redecide.start({ scope: 'all' }));
    await tick(5);
    expect(tabMessagesOfType(fake, MSG.RESET_AND_RESCAN)).toHaveLength(2);
  });

  test('favourites and manual overrides are never hidden; manual items keep their tag', async () => {
    const stack = [
      stored('fav', 'Sushi platter #Food', { isFavorite: true, favoritedAt: 5 }, 1),
      stored('man', 'Sushi chef interview #Jobs', { assignedTag: 'Health', matchInfo: { engine: 'Manual Override', manual: true } }, 1),
      stored('man2', 'Sushi rolls #Food', { assignedTag: 'Sports', decision: { provider: 'manual', path: ['manual'], collect: true, promptVersion: 1 } }, 1),
      stored('x', 'Sushi happy hour #Food', {}, 1)
    ];
    const { handlers, redecide, byId, decider, items } = setup({ config: GATE('sushi', 1), stack });

    await handlers[MSG.UPDATE_MATCH_PROMPT]({ prompt: 'ramen' });
    await redecide.idle();

    // Manual overrides are not re-decided at all.
    expect(decider.decidedIds().sort()).toEqual(['fav', 'x']);
    expect(byId('fav')).toMatchObject({ hiddenByPrompt: false, decision: { collect: false } });
    expect(byId('man')).toMatchObject({ assignedTag: 'Health', matchInfo: { manual: true } });
    expect(byId('man').hiddenByPrompt).toBeFalsy();
    expect(byId('man2')).toMatchObject({ assignedTag: 'Sports' });
    expect(byId('man2').hiddenByPrompt).toBeFalsy();
    expect(byId('x').hiddenByPrompt).toBe(true);

    // Un-favouriting a non-matching item hides it; favouriting a hidden one shows it.
    await handlers[MSG.FAVORITE_TOGGLED]({ itemId: 'fav', isFavorite: false });
    await handlers[MSG.FAVORITE_TOGGLED]({ itemId: 'x', isFavorite: true });
    expect(byId('fav').hiddenByPrompt).toBe(true);
    expect(byId('x').hiddenByPrompt).toBe(false);

    // A manual retag of a hidden item makes it a visible override.
    await handlers[MSG.ITEM_RETAGGED]({ itemId: 'fav', newTag: 'Food' });
    expect(byId('fav')).toMatchObject({ hiddenByPrompt: false, assignedTag: 'Food', matchInfo: { manual: true } });
    expect(items()).toHaveLength(4);
  });

  test('a manual retag made while a batch is being decided is respected', async () => {
    const gate = deferred();
    const entered = deferred();
    const decider = fakeDecider({ hold: async () => { entered.resolve(); await gate.promise; } });
    const stack = [stored('a', 'Sushi #Food', {}, 1), stored('b', 'Ramen #Food', {}, 1)];
    const { handlers, redecide, byId } = setup({ config: GATE('pizza', 1), stack, decider });

    const jobId = redecide.start({ scope: 'all' });
    await entered.promise;
    await handlers[MSG.ITEM_RETAGGED]({ itemId: 'a', newTag: 'Travel' });
    gate.resolve();
    const result = await redecide.wait(jobId);

    expect(result).toMatchObject({ cancelled: false, updated: 1 });
    expect(byId('a')).toMatchObject({ assignedTag: 'Travel', matchInfo: { manual: true } });
    expect(byId('a').hiddenByPrompt).toBeFalsy();
    expect(byId('b').hiddenByPrompt).toBe(true);
  });
});

describe('concurrency', () => {
  test('ingest during a re-decide keeps new items and deleted items stay deleted', async () => {
    const gate = deferred();
    const entered = deferred();
    const decider = fakeDecider({ hold: async () => { entered.resolve(); await gate.promise; } });
    const stack = [stored('a', 'Ramen #Food', {}, 1), stored('b', 'Sushi #Food', {}, 1), stored('c', 'Hiring #Jobs', {}, 1)];
    const { handlers, ingest, redecide, items, byId } = setup({ config: GATE('ramen', 1), stack, decider });

    const jobId = redecide.start({ scope: 'prompt', reason: 'test' });
    await entered.promise;
    expect(await handlers[MSG.ITEM_DELETED]({ itemId: 'b' })).toEqual({ success: true });
    await ingest.enqueue({
      text: 'Hand-pulled noodles at a new spot downtown',
      postKey: 'li:urn:li:activity:999',
      postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:999/',
      pageUrl: 'https://www.linkedin.com/feed/',
      sourcePlatform: 'linkedin.com',
      authorName: 'Ann'
    }, { tab: { id: 1 } });
    await ingest.drain();
    gate.resolve();
    const result = await redecide.wait(jobId);

    expect(result).toMatchObject({ cancelled: false, total: 3, done: 3 });
    const ids = items().map(i => i.id);
    expect(ids).not.toContain('b');
    expect(ids).toHaveLength(3);
    const fresh = items().find(i => i.postKey === 'li:urn:li:activity:999');
    // Added meanwhile: untouched by the re-decide (no hidden flag, ingest's decision).
    expect(fresh).toMatchObject({ assignedTag: 'Food', decision: { specHash: 'ingest' } });
    expect(fresh.hiddenByPrompt).toBeUndefined();
    expect(byId('a').hiddenByPrompt).toBe(false);
    expect(byId('c').hiddenByPrompt).toBe(true);
  });

  test('text edited by ingest meanwhile keeps the ingest decision', async () => {
    const gate = deferred();
    const entered = deferred();
    const decider = fakeDecider({ hold: async () => { entered.resolve(); await gate.promise; } });
    const stack = [stored('a', 'Short teaser', { postKey: 'li:urn:li:activity:5' }, 1)];
    const { ingest, redecide, byId } = setup({ config: GATE('ramen', 1), stack, decider });

    const jobId = redecide.start({ scope: 'all' });
    await entered.promise;
    await ingest.enqueue({
      text: 'Short teaser, now expanded with the full ramen review',
      postKey: 'li:urn:li:activity:5',
      postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:5/',
      sourcePlatform: 'linkedin.com',
      isUpdate: true
    }, { tab: { id: 1 } });
    await ingest.drain();
    gate.resolve();
    expect(await redecide.wait(jobId)).toMatchObject({ updated: 0 });
    expect(byId('a')).toMatchObject({ textSnippet: 'Short teaser, now expanded with the full ramen review', decision: { specHash: 'ingest' } });
    expect(byId('a').hiddenByPrompt).toBeFalsy();
  });

  test('a newer job cancels an older one; the older one never commits', async () => {
    const gate = deferred();
    const entered = deferred();
    const decider = fakeDecider({
      hold: async (items, ctx, call) => {
        if (call === 1) {
          entered.resolve();
          await gate.promise;
        }
      }
    });
    const stack = [stored('a', 'Ramen #Food', {}, 1), stored('b', 'Sushi #Food', {}, 1)];
    const { redecide, fake, byId, progress } = setup({ config: GATE('ramen', 1), stack, decider });

    const first = redecide.start({ scope: 'all' });
    await entered.promise;
    // Change the prompt behind the first job's back, then start a newer job.
    const cfg = fake.storage.local.peek('configuration');
    fake.storage.local.seed({ configuration: { ...cfg, matchPrompt: 'sushi', promptVersion: 2 } });
    const second = redecide.start({ scope: 'rules-only' });
    gate.resolve();

    const r1 = await redecide.wait(first);
    const r2 = await redecide.wait(second);
    expect(r1).toMatchObject({ cancelled: true, updated: 0 });
    // The newer job covers what the superseded one would have done.
    expect(r2).toMatchObject({ cancelled: false, scope: 'all', updated: 2 });
    expect(byId('a')).toMatchObject({ hiddenByPrompt: true, decision: { promptVersion: 2 } });
    expect(byId('b')).toMatchObject({ hiddenByPrompt: false, decision: { promptVersion: 2 } });
    expect(progress().find(p => p.jobId === first && p.finished)).toMatchObject({ cancelled: true });
    expect(progress().find(p => p.jobId === second && p.finished).cancelled).toBeUndefined();
  });

  test('a job superseded while it waits for the state lock does not commit', async () => {
    const release = deferred();
    const entered = deferred();
    let lock = null;
    const decider = fakeDecider({
      hold: async (items, ctx, call) => {
        if (call !== 1) return;
        // Something else holds the state lock while the first job tries to commit.
        const held = deferred();
        lock.run(async () => { held.resolve(); await release.promise; });
        await held.promise;
        entered.resolve();
      }
    });
    const { redecide, store, byId } = setup({ config: GATE('pizza', 1), stack: [stored('a', 'Ramen #Food', {}, 1)], decider });
    lock = store.lock;

    const first = redecide.start({ scope: 'all' });
    await entered.promise;
    await tick(5); // the first job is now queued on the lock with its commit
    const second = redecide.start({ scope: 'all' });
    release.resolve();

    expect(await redecide.wait(first)).toMatchObject({ cancelled: true, updated: 0 });
    expect(await redecide.wait(second)).toMatchObject({ cancelled: false, updated: 1 });
    expect(byId('a').hiddenByPrompt).toBe(true);
  });

  test('schedule() supersedes the running job at once and widens the scope', async () => {
    const gate = deferred();
    const entered = deferred();
    const decider = fakeDecider({
      hold: async (items, ctx, call) => {
        if (call === 1) {
          entered.resolve();
          await gate.promise;
        }
      }
    });
    const stack = [
      stored('r', 'Ramen #Food', { decision: { path: ['rules'], provider: 'rules', collect: true, promptVersion: 1 } }, 1),
      stored('s', 'Sushi #Food', {}, 1)
    ];
    const { redecide, decider: d } = setup({ config: GATE('ramen', 1), stack, decider });

    const first = redecide.start({ scope: 'all' });
    await entered.promise;
    const scheduled = redecide.schedule({ scope: 'rules-only' });
    gate.resolve();
    expect(await redecide.wait(first)).toMatchObject({ cancelled: true });
    const second = await scheduled;
    expect(await redecide.wait(second)).toMatchObject({ scope: 'all', cancelled: false });
    // The widened job re-decided every item, not just the rules-decided one.
    expect(d.calls[1].ids.sort()).toEqual(['r', 's']);
  });

  test('cancel() stops the running job and drops a pending schedule', async () => {
    const gate = deferred();
    const entered = deferred();
    const decider = fakeDecider({ hold: async () => { entered.resolve(); await gate.promise; } });
    const { redecide, byId } = setup({ config: GATE('pizza', 1), stack: [stored('a', 'Ramen #Food', {}, 1)], decider });
    const jobId = redecide.start({ scope: 'all' });
    await entered.promise;
    redecide.cancel();
    const scheduled = redecide.schedule({ scope: 'prompt' });
    redecide.cancel();
    gate.resolve();
    expect(await scheduled).toBeNull();
    expect(await redecide.wait(jobId)).toMatchObject({ cancelled: true });
    await redecide.idle();
    expect(byId('a').hiddenByPrompt).toBeUndefined();
  });
});

describe('gate off', () => {
  const hiddenStack = () => [
    stored('a', 'Sushi #Food', { hiddenByPrompt: true, decision: { collect: false, promptVersion: 1, path: ['system1'], provider: 'system1' } }, 1),
    stored('b', 'Ramen #Food', {}, 1),
    stored('c', 'Hiring #Jobs', { hiddenByPrompt: true, assignedTag: 'Jobs', decision: { collect: false, promptVersion: 1, path: ['system1'], provider: 'system1' } }, 1)
  ];

  test('TOGGLE_MATCH_PROMPT off clears every hidden flag without model calls', async () => {
    const { handlers, decider, items, fake, redecide } = setup({ config: GATE('ramen', 1), stack: hiddenStack() });
    expect(computeCounts(fake.storage.local.peek('stack'))).toEqual({ Unclassified: 1 });
    expect(await handlers[MSG.TOGGLE_MATCH_PROMPT]({ isEnabled: false })).toEqual({ success: true });
    await redecide.idle();
    expect(decider.calls).toHaveLength(0);
    expect(items().every(i => !i.hiddenByPrompt)).toBe(true);
    expect(items()).toHaveLength(3);
    expect(fake.storage.local.peek('metrics').counts).toEqual({ Unclassified: 2, Jobs: 1 });
  });

  test('a prompt job with the gate off only clears flags; an all job re-tags without hiding', async () => {
    const { redecide, decider, items, byId } = setup({ config: { ...GATE('ramen', 1), isMatchPromptEnabled: false }, stack: hiddenStack() });
    const p = await redecide.wait(redecide.start({ scope: 'prompt' }));
    expect(p).toMatchObject({ total: 0, cleared: 2, hidden: 0, cancelled: false });
    expect(decider.calls).toHaveLength(0);
    expect(items().every(i => !i.hiddenByPrompt)).toBe(true);

    const all = await redecide.wait(redecide.start({ scope: 'all' }));
    expect(all).toMatchObject({ total: 3, updated: 3, hidden: 0 });
    expect(decider.calls[0].ctx.gateOn).toBe(false);
    expect(byId('c')).toMatchObject({ assignedTag: 'Jobs', hiddenByPrompt: false, decision: { collect: true } });
  });

  test('an empty prompt counts as gate off', async () => {
    const { handlers, redecide, items, decider } = setup({ config: GATE('ramen', 1), stack: hiddenStack() });
    await handlers[MSG.UPDATE_MATCH_PROMPT]({ prompt: '   ' });
    await redecide.idle();
    expect(decider.calls).toHaveLength(0);
    expect(items().every(i => !i.hiddenByPrompt)).toBe(true);
  });

  test('switching the gate on hides non-matching items right away', async () => {
    const { handlers, redecide, byId } = setup({
      config: { matchPrompt: 'ramen', promptVersion: 1, isMatchPromptEnabled: false, matchPromptEnhanced: 'x' },
      stack: [stored('a', 'Ramen #Food', {}, 1), stored('b', 'Sushi #Food', {}, 1)]
    });
    await handlers[MSG.TOGGLE_MATCH_PROMPT]({ isEnabled: true });
    await redecide.idle();
    expect(byId('a').hiddenByPrompt).toBe(false);
    expect(byId('b').hiddenByPrompt).toBe(true);
  });
});

describe('scopes', () => {
  test('rules-only (System 1 ready) re-decides only items without a model verdict', async () => {
    const stack = [
      stored('rules', 'Ramen #Food', { decision: { path: ['rules'], provider: 'rules', collect: true, promptVersion: 1 } }, 1),
      stored('legacy', 'Sushi #Food', { decision: undefined, legacy: true }, 1),
      stored('error', 'Ramen #Food', { decision: { path: ['error'], provider: 'rules', collect: true, promptVersion: 1 } }, 1),
      stored('s1', 'Sushi #Food', {}, 1),
      stored('s1rules', 'Sushi #Food', { decision: { path: ['system1', 'rules'], provider: 'rules', collect: true, promptVersion: 1 } }, 1),
      stored('stale', 'Sushi #Food', {}, 0),
      stored('cached', 'Sushi #Food', { decision: { path: ['system1', 'cache'], provider: 'system1', collect: true, promptVersion: 1 } }, 1)
    ];
    const { redecide, decider, byId, items } = setup({ config: GATE('ramen', 1), stack });
    const result = await redecide.wait(redecide.onSystem1Ready());

    expect(result).toMatchObject({ scope: 'rules-only', reason: 'system1_ready', total: 4, cancelled: false });
    expect(decider.decidedIds().sort()).toEqual(['error', 'legacy', 'rules', 'stale']);
    expect(byId('legacy')).toMatchObject({ hiddenByPrompt: true, decision: { path: ['system1'] } });
    expect(byId('rules')).toMatchObject({ hiddenByPrompt: false, decision: { path: ['system1'] } });
    expect(byId('s1').decision.specHash).toBe('old');
    expect(items()).toHaveLength(7);
  });

  test('scope helpers', () => {
    expect(widerScope('rules-only', 'prompt')).toBe('prompt');
    expect(widerScope('all', 'rules-only')).toBe('all');
    expect(widerScope(null, 'rules-only')).toBe('rules-only');
    expect(parseScope('prompt')).toBe('prompt');
    expect(parseScope('everything')).toBeNull();
    expect(isRulesDecided({})).toBe(true);
    expect(isRulesDecided({ decision: { path: [] } })).toBe(false);
    expect(isRulesDecided({ decision: { path: ['rules', 'cache'] } })).toBe(true);
    expect(isRulesDecided({ decision: { path: ['prefilter'] } })).toBe(false);
    expect(isRedecideTarget({ id: 'x', textSnippet: '' }, 'all', {})).toBe(false);
    expect(isRedecideTarget({ id: 'x', textSnippet: 't', matchInfo: { manual: true } }, 'all', {})).toBe(false);
    expect(isManualItem({ decision: { provider: 'manual' } })).toBe(true);
  });

  test('items are decided in batches of 32 with progress after each batch', async () => {
    const stack = Array.from({ length: 70 }, (_, i) => stored(`i${i}`, i % 2 ? `Ramen ${i} #Food` : `Sushi ${i} #Food`, {}, 1));
    const { redecide, decider, progress, items, broadcast, fake } = setup({ config: GATE('ramen', 1), stack });
    const jobId = redecide.start({ scope: 'all' });
    const result = await redecide.wait(jobId);

    // The idle retry backs off while a re-decide is in flight; the count is released at the end.
    const inflight = runtimeMessagesOfType(fake, MSG.INFLIGHT_UPDATED).map(m => m.payload.count);
    expect(inflight).toEqual([70, 38, 6, 0]);
    expect(broadcast.getInflightCount()).toBe(0);

    expect(REDECIDE_BATCH_SIZE).toBe(32);
    expect(decider.calls.map(c => c.ids.length)).toEqual([32, 32, 6]);
    expect(result).toMatchObject({ total: 70, done: 70, updated: 70, hidden: 35 });
    const mine = progress().filter(p => p.jobId === jobId);
    expect(mine.map(p => [p.done, p.finished])).toEqual([[0, false], [32, false], [64, false], [70, true]]);
    expect(mine.at(-1)).toMatchObject({ total: 70, hidden: 35 });
    expect(items()).toHaveLength(70);
  });
});

describe('never deletes', () => {
  test('rejecting everything hides items; a failing batch keeps its labels; error verdicts change nothing', async () => {
    const stack = Array.from({ length: 5 }, (_, i) => stored(`i${i}`, `Post ${i} #Food`, { assignedTag: 'Food' }, 1));
    let call = 0;
    const decider = fakeDecider();
    const flaky = {
      ...decider,
      decideMany: async (items, ctx) => {
        call++;
        if (call === 2) throw new Error('model crashed');
        if (call === 3) {
          return items.map(() => ({ path: ['error'], provider: 'rules', collect: false, tag: 'Unclassified', tags: [], promptVersion: ctx.promptVersion }));
        }
        return decider.decideMany(items, ctx);
      }
    };
    const { redecide, items, byId } = setup({ config: GATE('nothing-matches-this', 1), stack, decider: flaky, batchSize: 2 });
    const result = await redecide.wait(redecide.start({ scope: 'all' }));

    expect(result).toMatchObject({ total: 5, done: 5, updated: 2, cancelled: false });
    expect(items().map(i => i.id)).toEqual(['i0', 'i1', 'i2', 'i3', 'i4']);
    expect(byId('i0').hiddenByPrompt).toBe(true);
    expect(byId('i1').hiddenByPrompt).toBe(true);
    // Batch 2 (i2, i3) failed and batch 3 (i4) had no verdict: untouched and visible.
    for (const id of ['i2', 'i3', 'i4']) {
      expect(byId(id)).toMatchObject({ assignedTag: 'Food', decision: { specHash: 'old', collect: true } });
      expect(byId(id).hiddenByPrompt).toBeUndefined();
    }
    expect(call).toBe(3);
  });

  test('the relabel wrapper keeps the old run()/trigger() interface on top of the redecider', async () => {
    const { store, broadcast, fake } = setup({ config: GATE('ramen', 1), stack: [stored('a', 'Sushi #Food', {}, 1)] });
    const decider = fakeDecider();
    const relabel = createRelabeler({ store, decideMany: decider.decideMany, broadcast, debounceMs: 0, chunkSize: 1 });
    expect(await relabel.run()).toEqual({ cancelled: false, updated: 1 });
    expect(fake.storage.local.peek('stack')[0].hiddenByPrompt).toBe(true);
    relabel.trigger();
    expect(relabel.isScheduled).toBe(true);
    await relabel.idle();
    expect(decider.calls).toHaveLength(2);
  });
});

describe('tags and clear', () => {
  test('tag changes schedule one debounced full re-decide', async () => {
    const stack = [stored('a', 'Ramen #Food', {}, 1)];
    const { handlers, redecide, decider } = setup({ config: GATE('ramen', 1), stack, debounceMs: 20 });
    await handlers[MSG.TAG_ADDED]({ tag: 'Food', prompt: 'Food posts' });
    await handlers[MSG.TAG_PROMPT_UPDATED]({ tag: 'Food', prompt: 'Restaurant and food posts' });
    await handlers[MSG.TAG_TOGGLED]({ tag: 'Health', enabled: false });
    await handlers[MSG.TAG_REMOVED]({ tag: 'Jobs' });
    expect(redecide.isScheduled).toBe(true);
    await redecide.idle();
    expect(decider.calls).toHaveLength(1);
    const tags = decider.calls[0].ctx.configuration.trackedTags;
    expect(tags.find(t => t.label === 'Food')).toMatchObject({ prompt: 'Restaurant and food posts', isEnabled: true });
    expect(tags.some(t => t.label === 'Jobs')).toBe(false);

    // No-op edits schedule nothing.
    await handlers[MSG.TAG_TOGGLED]({ tag: 'Health', enabled: false });
    await handlers[MSG.TAG_REMOVED]({ tag: 'Jobs' });
    await handlers[MSG.TAG_PROMPT_UPDATED]({ tag: 'Food', prompt: 'Restaurant and food posts' });
    expect(redecide.isScheduled).toBe(false);
  });

  test('a re-decide prunes dynamic tags left without items (sticky ones stay)', async () => {
    const trackedTags = [
      { id: 'dt1', label: 'Rust Conf', isEnabled: true, isDynamic: true },
      { id: 'dt2', label: 'Sticky', isEnabled: true, isDynamic: true, isSticky: true },
      { id: 'dt3', label: 'Ramen Week', isEnabled: true, isDynamic: true },
      { id: 't1', label: 'Food', isEnabled: true }
    ];
    const stack = [stored('a', 'Ramen #Food', { assignedTag: 'Rust Conf' }, 1), stored('b', 'Sushi #Food', { assignedTag: 'Ramen Week' }, 1)];
    const { redecide, fake } = setup({ config: GATE('ramen', 1, { trackedTags }), stack, decider: fakeDecider({ tagOverride: 'Ramen Week' }) });
    await redecide.wait(redecide.start({ scope: 'all' }));
    // 'Ramen Week' is still used (by a hidden item too); 'Rust Conf' lost its only item.
    expect(fake.storage.local.peek('configuration').trackedTags.map(t => t.label)).toEqual(['Sticky', 'Ramen Week', 'Food']);
    expect(pruneEmptyDynamicTags(trackedTags, [])).toHaveLength(2);
    expect(pruneEmptyDynamicTags(trackedTags, [{ assignedTag: 'Rust Conf' }, { assignedTag: 'Ramen Week' }])).toBe(trackedTags);
  });

  test('Clear of a tag removes its hidden items too; hiddenOnly removes just the hidden ones; favourites stay', async () => {
    const trackedTags = [{ id: 'dt1', label: 'Pop-up', isEnabled: true, isDynamic: true }, { id: 't1', label: 'Food', isEnabled: true }];
    const stack = [
      stored('vis', 'Ramen', { assignedTag: 'Food' }, 1),
      stored('hid', 'Sushi', { assignedTag: 'Food', hiddenByPrompt: true }, 1),
      stored('fav', 'Sushi', { assignedTag: 'Food', isFavorite: true }, 1),
      stored('pop', 'Pop-up', { assignedTag: 'Pop-up', hiddenByPrompt: true }, 1),
      stored('other', 'Jobs', { assignedTag: 'Jobs' }, 1),
      stored('untagged', 'x', { assignedTag: undefined, hiddenByPrompt: true }, 1)
    ];
    const { handlers, items, fake } = setup({ config: GATE('ramen', 1, { trackedTags }), stack });

    await handlers[MSG.CLEAR_STACK]({ hiddenOnly: true, tag: 'Pop-up' });
    expect(items().map(i => i.id)).toEqual(['vis', 'hid', 'fav', 'other', 'untagged']);
    // The dynamic tag lost its last item.
    expect(fake.storage.local.peek('configuration').trackedTags.map(t => t.label)).toEqual(['Food']);

    await handlers[MSG.CLEAR_STACK]({ tag: 'Food' });
    expect(items().map(i => i.id)).toEqual(['fav', 'other', 'untagged']);

    await handlers[MSG.CLEAR_STACK]({ tag: 'Unclassified' });
    expect(items().map(i => i.id)).toEqual(['fav', 'other']);

    await handlers[MSG.CLEAR_STACK]({ tag: 'All', hiddenOnly: true });
    expect(items().map(i => i.id)).toEqual(['fav', 'other']);
    await handlers[MSG.CLEAR_STACK]({ tag: 'All' });
    expect(items().map(i => i.id)).toEqual(['fav']);
    expect(fake.storage.local.peek('telemetry').totalProcessed).toBe(0);
  });

  test('GET_CATEGORY_ITEMS leaves hidden items out unless asked', async () => {
    const stack = [stored('a', 'x', { assignedTag: 'Food' }, 1), stored('b', 'y', { assignedTag: 'Food', hiddenByPrompt: true }, 1)];
    const { handlers } = setup({ config: GATE('ramen', 1), stack });
    expect((await handlers[MSG.GET_CATEGORY_ITEMS]({ category: 'Food' })).items.map(i => i.id)).toEqual(['a']);
    expect((await handlers[MSG.GET_CATEGORY_ITEMS]({ category: 'Food', includeHidden: true })).items.map(i => i.id)).toEqual(['a', 'b']);
  });
});

describe('REDECIDE_STACK', () => {
  test('starts a job and replies with its id; rejects unknown scopes', async () => {
    const { handlers, redecide, progress } = setup({ config: GATE('ramen', 1), stack: [stored('a', 'Sushi #Food', {}, 1)] });
    const reply = await handlers[MSG.REDECIDE_STACK]({ scope: 'all' });
    expect(reply).toMatchObject({ success: true });
    expect(typeof reply.jobId).toBe('string');
    expect(await redecide.wait(reply.jobId)).toMatchObject({ scope: 'all', updated: 1, hidden: 1 });
    await tick(5);
    expect(progress().filter(p => p.jobId === reply.jobId).at(-1)).toEqual({ jobId: reply.jobId, done: 1, total: 1, hidden: 1, finished: true });

    expect(await handlers[MSG.REDECIDE_STACK]({ scope: 'bogus' })).toMatchObject({ success: false, code: 'bad_request' });
    const dflt = await handlers[MSG.REDECIDE_STACK]({});
    expect(await redecide.wait(dflt.jobId)).toMatchObject({ scope: 'all' });
  });

  test('handlers fall back to a legacy relabel { trigger } dependency', async () => {
    const triggers = [];
    const r = redeciderFrom({ relabel: { trigger: () => triggers.push(1) } });
    expect(r.start({ scope: 'all' })).toBeNull();
    expect(await r.schedule({ scope: 'prompt' })).toBeNull();
    expect(triggers).toHaveLength(2);
    expect(await r.clearHidden()).toEqual({ cleared: 0, hidden: 0 });
  });
});

describe('shouldHideByPrompt', () => {
  const cfg = GATE('ramen', 3);
  const d = (extra = {}) => ({ collect: false, promptVersion: 3, path: ['system1'], ...extra });
  test('needs gate on, a current rejecting verdict, and no favourite/manual', () => {
    expect(shouldHideByPrompt({ decision: d() }, cfg)).toBe(true);
    expect(shouldHideByPrompt({ decision: d({ promptVersion: 2 }) }, cfg)).toBe(false);
    expect(shouldHideByPrompt({ decision: d({ path: ['error'] }) }, cfg)).toBe(false);
    expect(shouldHideByPrompt({ decision: d({ collect: true }) }, cfg)).toBe(false);
    expect(shouldHideByPrompt({ decision: d(), isFavorite: true }, cfg)).toBe(false);
    expect(shouldHideByPrompt({ decision: d(), matchInfo: { manual: true } }, cfg)).toBe(false);
    expect(shouldHideByPrompt({ decision: d() }, { ...cfg, isMatchPromptEnabled: false })).toBe(false);
    expect(shouldHideByPrompt({ decision: d() }, { ...cfg, matchPrompt: ' ' })).toBe(false);
    expect(shouldHideByPrompt({}, cfg)).toBe(false);
  });
});
