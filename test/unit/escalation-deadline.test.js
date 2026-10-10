/**
 * Regression: a Gemini Nano prompt that stalls (or crawls) must not hold up ingest, which decides
 * one batch at a time, nor TOGGLE_MATCH_PROMPT (whose re-decide used to wait for a Nano generate()).
 */
import { describe, test, expect } from 'vitest';
import { createFakeChrome } from '../helpers/fake-chrome.js';
import { createStore } from '../../lib/bg/store.js';
import { createBroadcaster } from '../../lib/bg/broadcast.js';
import { createHandlers } from '../../lib/bg/handlers/index.js';
import { defaultConfiguration } from '../../lib/bg/defaults.js';
import { emptyTelemetry } from '../../lib/bg/stack-utils.js';
import { createIngest } from '../../lib/pipeline/ingest.js';
import { createCascade } from '../../lib/decision/cascade.js';
import { createRulesProvider } from '../../lib/decision/providers/rules.js';
import { createNanoProvider } from '../../lib/decision/providers/nano.js';
import { MSG } from '../../lib/messages.js';

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

/** A LanguageModel whose prompts never settle (the on-device model service hung). */
function stalledLanguageModel() {
  const state = { prompts: 0, aborted: 0 };
  const LM = {
    availability: async () => 'available',
    create: async () => ({
      clone: async () => ({
        prompt: (_text, options) => {
          state.prompts += 1;
          options?.signal?.addEventListener('abort', () => { state.aborted += 1; });
          return new Promise(() => {});
        },
        destroy() {}
      }),
      destroy() {}
    })
  };
  return { LM, state };
}

function fakeStorage(configuration) {
  const fake = createFakeChrome({
    local: { configuration, stack: [], metrics: { counts: {} }, telemetry: emptyTelemetry(0) },
    session: {}
  });
  return { fake, store: createStore({ area: fake.storage.local }) };
}

describe('a stalled Gemini Nano', () => {
  test('ingest keeps storing posts: the unsure post keeps System 1’s answer after the deadline', async () => {
    const configuration = {
      ...defaultConfiguration(),
      matchPrompt: 'michelin restaurant',
      isMatchPromptEnabled: true,
      promptVersion: 1,
      intelligence: { escalation: { provider: 'nano' } }
    };
    const { fake, store } = fakeStorage(configuration);
    const { LM, state } = stalledLanguageModel();
    const nano = createNanoProvider({ getConfig: async () => configuration, languageModel: LM, decideTimeoutMs: 50 });
    // System 1 is unsure (p = 0.5) about the first post only.
    const system1 = {
      isReady: async () => true,
      floor: { matches_prompt: 0.7 },
      decideBatch: async ({ items }) => ({
        results: items.map(it => ({ id: it.id, answers: { matches_prompt: { noul: /unsure/.test(it.text) ? 0.5 : 0.97 } } }))
      })
    };
    const { decideMany } = createCascade({ system1, escalators: { nano }, rules: createRulesProvider() });
    const broadcast = createBroadcaster({ area: fake.storage.local, runtime: fake.runtime, tabs: fake.tabs, delayMs: 5 });
    const notified = [];
    const ingest = createIngest({ store, decideMany, broadcast, session: null, settleMs: 0, notifyTab: (_t, m) => notified.push(m.payload) });

    const post = (i, text) => ({
      text,
      sourcePlatform: 'linkedin.com',
      postUrl: `https://www.linkedin.com/feed/update/urn:li:activity:73010000000000000${10 + i}/`,
      authorName: `A${i}`
    });
    const t0 = Date.now();
    await ingest.enqueue(post(0, 'unsure: a restaurant opened downtown last week near the station'), { tab: { id: 1 } });
    await ingest.drain();
    for (let i = 1; i <= 5; i++) await ingest.enqueue(post(i, `Michelin restaurant tasting menu number ${i} for the autumn season`), { tab: { id: 1 } });
    await ingest.drain();

    expect(Date.now() - t0).toBeLessThan(3000);
    expect(state.prompts).toBe(1);
    expect(state.aborted).toBe(1);
    const { stack } = fake.storage.local.dump();
    expect(stack).toHaveLength(6);
    const unsure = stack.find(i => /unsure/.test(i.textSnippet));
    expect(unsure.decision).toMatchObject({ pMatch: 0.5, escalated: false, reason: 'timeout', uncertain: true });
    expect(ingest.pendingCount()).toBe(0);
    expect(notified.filter(n => n.status === 'collected')).toHaveLength(6);
    // Nano is skipped for a while after the timeout.
    expect(await nano.isReady()).toBe(false);
  });

  test('TOGGLE_MATCH_PROMPT does not wait for a stalled prompt enhancement before re-deciding', async () => {
    const configuration = { ...defaultConfiguration(), matchPrompt: 'michelin restaurant', matchPromptEnhanced: '', isMatchPromptEnabled: false };
    const { fake, store } = fakeStorage(configuration);
    const broadcast = createBroadcaster({ area: fake.storage.local, runtime: fake.runtime, tabs: fake.tabs, delayMs: 5 });
    const tags = deferred();
    const starts = [];
    const schedules = [];
    const redecide = {
      start: (opts) => { starts.push(opts); return 'job-1'; },
      schedule: async (opts) => { schedules.push(opts); return 'job-2'; },
      clearHidden: async () => ({ cleared: 0, hidden: 0 })
    };
    const handlers = createHandlers({
      store,
      broadcast,
      ingest: { enqueue: async () => ({}) },
      redecide,
      gateOnGenerateWaitMs: 30,
      engine: {
        extractTagsFromPrompt: () => tags.promise, // a model that does not answer
        enhanceMatchPrompt: async () => 'fine dining and tasting menus',
        autoSuggestTagPrompt: async () => ''
      }
    });

    const t0 = Date.now();
    expect(await handlers[MSG.TOGGLE_MATCH_PROMPT]({ isEnabled: true })).toEqual({ success: true });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(starts).toEqual([{ scope: 'prompt', reason: 'gate_on', rescan: true }]);
    expect(schedules).toEqual([]);

    // The enhancement lands later: committed and re-decided like GENERATE_PROMPT_TAGS.
    tags.resolve(['Restaurants']);
    for (let i = 0; i < 50 && schedules.length === 0; i++) await new Promise(r => setTimeout(r, 5));
    expect(schedules).toEqual([{ scope: 'prompt', reason: 'prompt_tags', rescan: true }]);
    expect(fake.storage.local.dump().configuration).toMatchObject({
      isMatchPromptEnabled: true,
      matchPromptTags: ['Restaurants'],
      matchPromptEnhanced: 'fine dining and tasting menus'
    });
  });
});
