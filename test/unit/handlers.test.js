import { describe, test, expect } from 'vitest';
import { createFakeChrome, tabMessagesOfType, runtimeMessagesOfType } from '../helpers/fake-chrome.js';
import { createStore } from '../../lib/bg/store.js';
import { createBroadcaster } from '../../lib/bg/broadcast.js';
import { createHandlers } from '../../lib/bg/handlers/index.js';
import { createContentConfigWatcher } from '../../lib/bg/handlers/content.js';
import { defaultConfiguration, initializeState, seedAndUpgrade } from '../../lib/bg/defaults.js';
import { emptyTelemetry } from '../../lib/bg/stack-utils.js';
import { migrateCanonicalAuthors } from '../../lib/pipeline/authors.js';
import { MSG } from '../../lib/messages.js';

const migrateAuthors = migrateCanonicalAuthors;

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function item(id, extra = {}) {
  return {
    id, postKey: `k-${id}`, timestamp: 1, sourcePlatform: 'linkedin.com', sourceUrl: '', textSnippet: `text ${id}`,
    assignedTag: 'Tech/AI', tags: [{ name: 'Tech/AI', score: 1 }], isFavorite: false, favoritedAt: null, isAd: false,
    ...extra
  };
}

function setup({ config = {}, stack = [], engine = {}, tabs = [], onTabMessage } = {}) {
  const fake = createFakeChrome({
    local: {
      configuration: { ...defaultConfiguration(), ...config },
      stack,
      metrics: { counts: {} },
      telemetry: { ...emptyTelemetry(0), totalProcessed: stack.length },
      secrets: { jev: 'sk-jev-SECRET', openai: 'sk-openai-SECRET' }
    },
    tabs,
    onTabMessage
  });
  const store = createStore({ area: fake.storage.local });
  const broadcast = createBroadcaster({ area: fake.storage.local, runtime: fake.runtime, tabs: fake.tabs, delayMs: 5 });
  /** Re-decide requests the handlers made: { op: 'start'|'schedule'|'clearHidden', scope? }. */
  const redecideCalls = [];
  const enqueued = [];
  let clock = 1_700_000_000_000;
  const handlers = createHandlers({
    store,
    broadcast,
    redecide: {
      start: ({ scope, rescan }) => { redecideCalls.push({ op: 'start', scope, ...(rescan ? { rescan } : {}) }); return 'job-1'; },
      schedule: async ({ scope, rescan }) => { redecideCalls.push({ op: 'schedule', scope, ...(rescan ? { rescan } : {}) }); return 'job-2'; },
      clearHidden: async () => { redecideCalls.push({ op: 'clearHidden' }); return { cleared: 0, hidden: 0 }; }
    },
    ingest: { enqueue: async (payload, sender) => { enqueued.push({ payload, sender }); return { status: 'queued', postKey: payload.postKey }; } },
    now: () => ++clock,
    engine: {
      checkEngineStatus: async () => ({ tier: 3, name: 'Rule-based Classifier', status: 'ready' }),
      extractTagsFromPrompt: async () => ['Restaurants'],
      enhanceMatchPrompt: async (p) => `Collect substantive posts about ${p}.`,
      autoSuggestTagPrompt: async (t) => `Identify posts related to ${t}.`,
      ...engine
    }
  });
  return { fake, store, broadcast, handlers, redecideCalls, enqueued, cfg: () => fake.storage.local.peek('configuration') };
}

describe('GET_STATE / broadcasts', () => {
  test('GET_STATE never returns secrets', async () => {
    const { handlers } = setup({ stack: [item('a')] });
    const state = await handlers[MSG.GET_STATE]({});
    expect(Object.keys(state).sort()).toEqual(['configuration', 'inFlightCount', 'metrics', 'stack', 'telemetry']);
    expect(JSON.stringify(state)).not.toContain('SECRET');
    expect(state.inFlightCount).toBe(0);
    expect(state.stack).toHaveLength(1);
  });

  test('STATE_UPDATED carries only whitelisted keys plus inFlightCount', async () => {
    const { handlers, broadcast, fake } = setup();
    broadcast.sendInflight(3, 'ingest');
    await handlers[MSG.TAG_TOGGLED]({ tag: 'Health', enabled: false });
    await broadcast.scheduleBroadcast();
    const [update] = runtimeMessagesOfType(fake, MSG.STATE_UPDATED);
    expect(Object.keys(update.payload).sort()).toEqual(['configuration', 'inFlightCount', 'metrics', 'stack', 'telemetry']);
    expect(update.payload.inFlightCount).toBe(3);
    expect(JSON.stringify(update)).not.toContain('SECRET');
  });

  test('GET_ENGINE_STATUS keeps the engine shape and flags a gate with an empty prompt', async () => {
    const { handlers } = setup({ config: { isMatchPromptEnabled: true, matchPrompt: '  ' } });
    const status = await handlers[MSG.GET_ENGINE_STATUS]({});
    expect(status).toMatchObject({ tier: 3, name: 'Rule-based Classifier', status: 'ready', warnings: ['empty_prompt'] });
  });
});

describe('match prompt', () => {
  test('UPDATE_MATCH_PROMPT clears enhanced/tags, bumps promptVersion and auto-enables the gate', async () => {
    const { handlers, cfg } = setup({
      config: { matchPrompt: '', matchPromptEnhanced: 'old enhanced', matchPromptTags: ['Old'], promptVersion: 4, isMatchPromptEnabled: false }
    });
    await handlers[MSG.UPDATE_MATCH_PROMPT]({ prompt: 'Find me restaurant posts' });
    expect(cfg()).toMatchObject({
      matchPrompt: 'Find me restaurant posts',
      matchPromptEnhanced: '',
      matchPromptTags: [],
      promptVersion: 5,
      isMatchPromptEnabled: true
    });

    // Further edits keep bumping the version and clearing stale derived fields.
    await handlers[MSG.UPDATE_MATCH_PROMPT]({ prompt: 'Find me ramen restaurant posts' });
    expect(cfg()).toMatchObject({ promptVersion: 6, isMatchPromptEnabled: true });
    // Unchanged text is a no-op.
    await handlers[MSG.UPDATE_MATCH_PROMPT]({ prompt: 'Find me ramen restaurant posts' });
    expect(cfg().promptVersion).toBe(6);
  });

  test('no auto-enable after the user switched the gate off', async () => {
    const { handlers, cfg } = setup({ config: { matchPrompt: 'cats', isMatchPromptEnabled: true } });
    await handlers[MSG.TOGGLE_MATCH_PROMPT]({ isEnabled: false });
    expect(cfg()).toMatchObject({ isMatchPromptEnabled: false, matchPromptUserDisabled: true });
    await handlers[MSG.UPDATE_MATCH_PROMPT]({ prompt: '' });
    await handlers[MSG.UPDATE_MATCH_PROMPT]({ prompt: 'dogs' });
    expect(cfg().isMatchPromptEnabled).toBe(false);
  });

  test('a stale GENERATE_PROMPT_TAGS result is not committed', async () => {
    const release = deferred();
    const started = deferred();
    const { handlers, cfg } = setup({
      config: { matchPrompt: 'restaurants', promptVersion: 1, isMatchPromptEnabled: true },
      engine: {
        extractTagsFromPrompt: async () => { started.resolve(); await release.promise; return [{ name: 'Restaurants', weight: 5 }]; }
      }
    });

    const pending = handlers[MSG.GENERATE_PROMPT_TAGS]({ prompt: 'restaurants' });
    await started.promise;
    await handlers[MSG.UPDATE_MATCH_PROMPT]({ prompt: 'used cars' });
    release.resolve();

    expect(await pending).toEqual({ success: true, stale: true });
    expect(cfg()).toMatchObject({ matchPrompt: 'used cars', matchPromptTags: [], matchPromptEnhanced: '', promptVersion: 2 });
  });

  test('a current GENERATE_PROMPT_TAGS result is committed as plain strings', async () => {
    const { handlers, cfg, fake, redecideCalls } = setup({
      config: { matchPrompt: 'restaurants', promptVersion: 3 },
      engine: { extractTagsFromPrompt: async () => [{ name: 'Restaurants', weight: 5 }, 'Dining', { name: 'Restaurants', weight: 1 }] },
      tabs: [{ id: 1, url: 'https://www.linkedin.com/feed/' }],
      onTabMessage: () => ({ success: true })
    });
    const reply = await handlers[MSG.GENERATE_PROMPT_TAGS]({ prompt: 'restaurants' });
    expect(reply).toEqual({ success: true, tags: ['Restaurants', 'Dining'], enhanced: 'Collect substantive posts about restaurants.' });
    expect(cfg()).toMatchObject({ matchPromptTags: ['Restaurants', 'Dining'], matchPromptEnhanced: 'Collect substantive posts about restaurants.', promptVersion: 3 });
    // The tabs rescan after the re-decide (the redecider does it), never before it: a re-sent post
    // must meet the re-decided stack.
    await new Promise(r => setTimeout(r, 10));
    expect(redecideCalls).toEqual([{ op: 'schedule', scope: 'prompt', rescan: true }]);
    expect(tabMessagesOfType(fake, MSG.RESET_AND_RESCAN)).toHaveLength(0);
  });

  test('TOGGLE_MATCH_PROMPT: model work outside the lock, stale results dropped', async () => {
    const release = deferred();
    const started = deferred();
    const { handlers, cfg, redecideCalls } = setup({
      config: { matchPrompt: 'restaurants', promptVersion: 2, isMatchPromptEnabled: false },
      engine: { enhanceMatchPrompt: async () => { started.resolve(); await release.promise; return 'enhanced (stale)'; } }
    });
    const pending = handlers[MSG.TOGGLE_MATCH_PROMPT]({ isEnabled: true });
    await started.promise;
    // The toggle itself is already committed while the model runs.
    expect(cfg()).toMatchObject({ isMatchPromptEnabled: true, matchPromptUserDisabled: false });
    await handlers[MSG.UPDATE_MATCH_PROMPT]({ prompt: 'bakeries' });
    release.resolve();
    expect(await pending).toEqual({ success: true, stale: true });
    expect(cfg()).toMatchObject({ matchPrompt: 'bakeries', matchPromptEnhanced: '', matchPromptTags: [] });
    // The prompt edit schedules a debounced re-decide; switching the gate on starts one. Both rescan
    // the open tabs once they finished.
    expect(redecideCalls).toEqual([{ op: 'schedule', scope: 'prompt', rescan: true }, { op: 'start', scope: 'prompt', rescan: true }]);

    // Switching the gate off un-hides items without a model pass.
    expect(await handlers[MSG.TOGGLE_MATCH_PROMPT]({ isEnabled: false })).toEqual({ success: true });
    expect(redecideCalls.at(-1)).toEqual({ op: 'clearHidden' });
  });
});

describe('configuration', () => {
  test('pause timestamp is persisted and cleared on resume', async () => {
    const { handlers, cfg } = setup();
    await handlers[MSG.IS_TRACKING_PAUSED_TOGGLED]({ isPaused: true });
    const paused = cfg();
    expect(paused.isTrackingPaused).toBe(true);
    expect(typeof paused.trackingPausedAt).toBe('number');

    // Re-sending "paused" keeps the original start time.
    await handlers[MSG.IS_TRACKING_PAUSED_TOGGLED]({ isPaused: true });
    expect(cfg().trackingPausedAt).toBe(paused.trackingPausedAt);

    await handlers[MSG.IS_TRACKING_PAUSED_TOGGLED]({ isPaused: false });
    expect(cfg()).toMatchObject({ isTrackingPaused: false, trackingPausedAt: null });
  });

  test('content scripts get config by message and a push when it changes', async () => {
    const { handlers, fake } = setup({ tabs: [{ id: 3, url: 'https://x.com/home' }, { id: 4, url: 'chrome://extensions' }], onTabMessage: () => ({}) });
    const broadcastStub = { pushed: [], broadcastToAllTabs(m) { this.pushed.push(m); } };
    fake.storage.onChanged.addListener(createContentConfigWatcher(broadcastStub));

    const reply = await handlers[MSG.GET_CONTENT_CONFIG]({});
    expect(reply).toMatchObject({ success: true, isTrackingPaused: false, ignoredDomains: [], debugAnnotate: false });
    expect(Array.isArray(reply.sites)).toBe(true);
    expect(reply).not.toHaveProperty('stack');

    await handlers[MSG.TAG_TOGGLED]({ tag: 'Health', enabled: false }); // not content-relevant
    expect(broadcastStub.pushed).toHaveLength(0);
    await handlers[MSG.IGNORE_DOMAIN_ADDED]({ domain: 'example.com' });
    await handlers[MSG.IS_TRACKING_PAUSED_TOGGLED]({ isPaused: true });
    expect(broadcastStub.pushed.map(m => m.type)).toEqual([MSG.CONTENT_CONFIG_UPDATED, MSG.CONTENT_CONFIG_UPDATED]);
    expect(broadcastStub.pushed[1].payload).toMatchObject({ isTrackingPaused: true, ignoredDomains: ['example.com'] });
  });

  test('tags, sites and ignore lists keep their reply shapes', async () => {
    const { handlers, cfg, redecideCalls } = setup();
    expect(await handlers[MSG.TAG_ADDED]({ tag: 'Ramen', prompt: '' })).toEqual({ success: true });
    expect(await handlers[MSG.TAG_ADDED]({ tag: 'ramen' })).toEqual({ success: false, error: 'Tag already exists' });
    expect(cfg().trackedTags.find(t => t.label === 'Ramen').prompt).toBe('Find posts related to Ramen.');
    expect(redecideCalls).toEqual([{ op: 'schedule', scope: 'all' }]);

    expect(await handlers[MSG.SITE_ADDED]({ domain: 'Reddit.com' })).toEqual({ success: true });
    expect(await handlers[MSG.SITE_ADDED]({ domain: 'reddit.com' })).toEqual({ success: false, error: 'Site already exists' });
    expect(await handlers[MSG.KEYWORD_ADDED]({ keyword: 'Crypto' })).toEqual({ success: true });
    expect(await handlers[MSG.KEYWORD_ADDED]({ keyword: 'crypto' })).toEqual({ success: false, error: 'Keyword already exists' });
    expect(await handlers[MSG.IGNORE_LINK_ADDED]({ url: 'https://a.example/p/1' })).toEqual({ success: true });
    expect(await handlers[MSG.IGNORE_LINK_ADDED]({ url: 'https://a.example/p/1' })).toEqual({ success: false, error: 'Link already ignored' });
    await handlers[MSG.IGNORE_TAG_ADDED]({ tag: 'Ads' });
    await handlers[MSG.IGNORE_TAG_REMOVED]({ tag: 'ads' });
    expect(cfg()).toMatchObject({ ignoredKeywords: ['Crypto'], ignoredLinks: ['https://a.example/p/1'], ignoredTags: [] });
    expect(cfg().sites.some(s => s.domain === 'reddit.com' && s.isCustom)).toBe(true);

    const wand = await handlers[MSG.GENERATE_TAG_EVAL_PROMPT]({ tag: 'Ramen', currentPrompt: '' });
    expect(wand).toEqual({ success: true, prompt: 'Identify posts related to Ramen.' });
  });

  test('TEXT_EXTRACTED hands the payload and sender to the ingest queue', async () => {
    const { handlers, enqueued } = setup();
    const reply = await handlers[MSG.TEXT_EXTRACTED]({ text: 'hello', postKey: 'k1' }, { tab: { id: 9 } });
    expect(reply).toEqual({ success: true, status: 'queued', postKey: 'k1' });
    expect(enqueued[0].sender.tab.id).toBe(9);
  });
});

describe('stack', () => {
  test('CLEAR_STACK keeps favourites and recomputes counts', async () => {
    const stack = [
      item('a', { isFavorite: true, favoritedAt: 5 }),
      item('b'),
      item('c', { assignedTag: 'Rust Conf' }),
      item('d', { assignedTag: 'Jobs', isAd: true })
    ];
    const { handlers, fake } = setup({
      stack,
      config: { trackedTags: [{ id: 'dt1', label: 'Rust Conf', isEnabled: true, isDynamic: true }, { id: 'dt2', label: 'Sticky', isEnabled: true, isDynamic: true, isSticky: true }, { id: 't2', label: 'Jobs', isEnabled: true }] }
    });

    await handlers[MSG.CLEAR_STACK]({ tag: 'Rust Conf' });
    let state = fake.storage.local.dump();
    expect(state.stack.map(i => i.id)).toEqual(['a', 'b', 'd']);
    expect(state.configuration.trackedTags.map(t => t.label)).toEqual(['Sticky', 'Jobs']);

    await handlers[MSG.CLEAR_STACK]({ tag: 'All' });
    state = fake.storage.local.dump();
    expect(state.stack.map(i => i.id)).toEqual(['a']);
    expect(state.metrics.counts).toEqual({ 'Tech/AI': 1 });
    expect(state.telemetry.totalProcessed).toBe(0);
  });

  test('favourite, retag and delete go through the stack commit', async () => {
    const { handlers, fake } = setup({ stack: [item('a'), item('b')] });
    await handlers[MSG.FAVORITE_TOGGLED]({ itemId: 'a', isFavorite: true });
    await handlers[MSG.ITEM_RETAGGED]({ itemId: 'b', newTag: 'Jobs' });
    let state = fake.storage.local.dump();
    expect(state.stack[0]).toMatchObject({ isFavorite: true });
    expect(typeof state.stack[0].favoritedAt).toBe('number');
    expect(state.stack[1]).toMatchObject({ assignedTag: 'Jobs', matchInfo: { engine: 'Manual Override', manual: true } });
    expect(state.metrics.counts).toEqual({ 'Tech/AI': 1, Jobs: 1 });

    expect(await handlers[MSG.ITEM_DELETED]({ itemId: 'zzz' })).toEqual({ success: false, error: 'Item not found' });
    expect(await handlers[MSG.ITEM_DELETED]({ itemId: 'b' })).toEqual({ success: true });
    state = fake.storage.local.dump();
    expect(state.stack.map(i => i.id)).toEqual(['a']);
    expect(state.metrics.counts).toEqual({ 'Tech/AI': 1 });

    expect(await handlers[MSG.GET_CATEGORY_ITEMS]({ category: 'Tech/AI' })).toMatchObject({ items: [{ id: 'a' }] });
  });
});

describe('startup state', () => {
  test('seeds defaults, upgrades v0.9 state, never wipes the stack, and is idempotent', async () => {
    const fake = createFakeChrome({
      local: {
        configuration: {
          trackedTags: [],
          sites: [{ id: 's3', domain: 'twitter.com', isEnabled: true }],
          matchPrompt: 'restaurants',
          isMatchPromptEnabled: true,
          matchPromptTags: [{ name: 'Restaurants', weight: 5 }]
        },
        stack: [{ id: 'item_1', textSnippet: 'kept', assignedTag: 'Unclassified', isPinned: true, timestamp: 3, authorName: 'Jane Doe' }],
        secrets: { jev: 'sk-x' }
      }
    });
    const store = createStore({ area: fake.storage.local });
    let migrateCalls = 0;
    const migrateState = (state) => { migrateCalls++; return { state, changed: false }; };

    await initializeState({ store, migrateState, migrateAuthors });
    const state = fake.storage.local.dump();
    expect(state.stack).toHaveLength(1);
    expect(state.stack[0]).toMatchObject({ id: 'item_1', isFavorite: true, favoritedAt: 3, canonicalAuthorName: 'Jane Doe' });
    expect(state.stack[0]).not.toHaveProperty('isPinned');
    expect(state.configuration.trackedTags.length).toBeGreaterThanOrEqual(25);
    expect(state.configuration.trackedTags.some(t => t.label === 'Ads')).toBe(true);
    expect(state.configuration.sites.some(s => s.domain === 'twitter.com')).toBe(false);
    expect(state.configuration.sites.some(s => s.domain === 'x.com')).toBe(true);
    expect(state.configuration.sites[0].domain).toBe('*');
    expect(state.configuration.matchPromptTags).toEqual(['Restaurants']);
    expect(state.configuration).toMatchObject({ promptVersion: 0, matchPromptUserDisabled: false, trackingPausedAt: null });
    expect(state.secrets).toEqual({ jev: 'sk-x' });
    expect(migrateCalls).toBe(1);

    const setsBefore = fake.storage.local.calls.set;
    await initializeState({ store, migrateState, migrateAuthors });
    expect(fake.storage.local.calls.set).toBe(setsBefore);
    expect(seedAndUpgrade(fake.storage.local.dump(), Date.now(), { migrateAuthors }).changedKeys.size).toBe(0);
  });

  test('a migration that reports changes is written; a throwing migration does not brick startup', async () => {
    const fake = createFakeChrome();
    const store = createStore({ area: fake.storage.local });
    await initializeState({ store, migrateState: (s) => ({ state: { ...s, schemaVersion: 2 }, changed: true }) });
    expect(fake.storage.local.peek('schemaVersion')).toBe(2);
    expect(fake.storage.local.peek('configuration').trackedTags.length).toBeGreaterThan(0);

    const fake2 = createFakeChrome();
    const store2 = createStore({ area: fake2.storage.local });
    await initializeState({ store: store2, migrateState: () => { throw new Error('bad migration'); } });
    expect(fake2.storage.local.peek('configuration').trackedTags.length).toBeGreaterThan(0);
  });
});
