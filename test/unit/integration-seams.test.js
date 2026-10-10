// @vitest-environment happy-dom
/**
 * Seams between the modules written in parallel for Phases 1-3:
 *  - content.js <-> background router/handlers/ingest (real modules, real rules engine): config by
 *    message, TEXT_EXTRACTED payload, DECISION_RESULT annotations, no storage access in the page;
 *  - startup: seed + legacy upgrades + the real schema migration, idempotent;
 *  - migrated legacy items <-> new content postKeys (no duplicates);
 *  - lib/sites.js (shared site / ignore-domain matching);
 *  - the decision cascade (rules tier, no System 1 in node) <-> the rules engine (pMatch, reasons);
 *  - intelligence settings / API-key handlers (whitelist, no key in any reply, page senders refused);
 *  - the router's sender policy (content scripts may only send TEXT_EXTRACTED / GET_CONTENT_CONFIG).
 */
import { describe, test, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { createFakeChrome, runtimeMessagesOfType } from '../helpers/fake-chrome.js';
import { createStore } from '../../lib/bg/store.js';
import { createBroadcaster } from '../../lib/bg/broadcast.js';
import { createRouter } from '../../lib/bg/router.js';
import { createHandlers } from '../../lib/bg/handlers/index.js';
import { initializeState, seedAndUpgrade, defaultConfiguration } from '../../lib/bg/defaults.js';
import { createContentConfigWatcher } from '../../lib/bg/handlers/content.js';
import { createIngest } from '../../lib/pipeline/ingest.js';
import { createCascade } from '../../lib/decision/cascade.js';
import { createRulesProvider } from '../../lib/decision/providers/rules.js';
import { rejectionReason } from '../../lib/pipeline/apply-decision.js';
import { migrateCanonicalAuthors } from '../../lib/pipeline/authors.js';
import { migrateState } from '../../lib/storage/migrations.js';
import { SCHEMA_VERSION, DEFAULT_INTELLIGENCE, resolveIntelligence } from '../../lib/storage/schema.js';
import { normalizeDomain, checkIfSiteEnabled, isIgnoredHost } from '../../lib/sites.js';
import { checkIfSiteEnabled as injectCheck } from '../../lib/bg/inject.js';
import {
  checkEngineStatus,
  extractTagsFromPrompt,
  enhanceMatchPrompt,
  autoSuggestTagPrompt
} from '../../lib/inference-engine.js';

/** The service worker's cascade as it runs when System 1 and Gemini Nano are unavailable: rules only. */
const rulesOnlyDecideMany = () => createCascade({ rules: createRulesProvider() }).decideMany;
import { MSG } from '../../lib/messages.js';

const CONTENT_JS = fs.readFileSync(path.resolve(__dirname, '../../content.js'), 'utf8');
const PROMPT = 'find me restaurant and 5 star quality food posts. I am fascinated by michelin star cooking';
const TAB_ID = 5;
const FEED_URL = 'https://www.linkedin.com/feed/';

const LI = {
  michelin: 'li:urn:li:activity:7301000000000000001',
  company: 'li:urn:li:activity:7301000000000000002',
  reshare: 'li:urn:li:activity:7301000000000000003',
  promoted: 'li:urn:li:ugcPost:7301000000000000444'
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, timeout = 8000) {
  const start = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await sleep(20);
  }
}

function fixtureBody(name) {
  const html = fs.readFileSync(path.resolve(__dirname, '../fixtures', name), 'utf8');
  const match = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  return match ? match[1] : html;
}

function teardownContentScript() {
  const instance = globalThis.__scrollCollectorLoaded;
  if (instance && typeof instance.teardown === 'function') instance.teardown();
  delete globalThis.__scrollCollectorLoaded;
}

afterEach(() => {
  teardownContentScript();
  delete globalThis.chrome;
});

/**
 * The service-worker side built from the real modules (rules engine only: no LanguageModel in
 * node), plus a page running content.js whose chrome.runtime talks to that router.
 */
async function wire({ config = {}, local = {} } = {}) {
  /** content.js onMessage listeners */
  const pageListeners = [];
  const bg = createFakeChrome({
    local: { configuration: { ...defaultConfiguration(), ...config }, secrets: { jev: 'jev-key-SECRET-1234567890' }, ...local },
    tabs: [{ id: TAB_ID, url: FEED_URL }],
    onTabMessage: (tabId, message) => {
      if (tabId !== TAB_ID || pageListeners.length === 0) throw new Error('Could not establish connection. Receiving end does not exist.');
      let reply;
      for (const fn of pageListeners) fn(message, { id: 'ext' }, (r) => { reply = r; });
      return reply;
    }
  });
  const store = createStore({ area: bg.storage.local });
  const broadcast = createBroadcaster({ area: bg.storage.local, runtime: bg.runtime, tabs: bg.tabs, delayMs: 5 });
  let n = 0;
  const ingest = createIngest({
    store,
    decideMany: rulesOnlyDecideMany(),
    broadcast,
    notifyTab: (tabId, message) => broadcast.sendToTab(tabId, message),
    session: bg.storage.session,
    uuid: () => `item-${++n}`
  });
  const handlers = createHandlers({
    store,
    broadcast,
    ingest,
    relabel: { trigger() {} },
    engine: { checkEngineStatus, extractTagsFromPrompt, enhanceMatchPrompt, autoSuggestTagPrompt }
  });
  let started = null;
  const ready = () => (started ||= initializeState({ store, migrateState, migrateAuthors: migrateCanonicalAuthors }));
  const listener = createRouter(handlers, { ready });

  /** Messages the page sent, as the router saw them. */
  const fromPage = [];
  let storageTouched = false;
  const pageChrome = {
    runtime: {
      id: 'ext',
      sendMessage: vi.fn((message) => new Promise((resolve) => {
        const copy = structuredClone(message);
        fromPage.push(copy);
        let answered = false;
        const keepOpen = listener(copy, { id: 'ext', tab: { id: TAB_ID, url: FEED_URL }, frameId: 0, url: FEED_URL }, (r) => {
          answered = true;
          resolve(structuredClone(r));
        });
        if (keepOpen !== true && !answered) resolve(undefined);
      })),
      onMessage: {
        addListener: (fn) => pageListeners.push(fn),
        removeListener: (fn) => {
          const i = pageListeners.indexOf(fn);
          if (i >= 0) pageListeners.splice(i, 1);
        }
      }
    }
  };
  Object.defineProperty(pageChrome, 'storage', { get() { storageTouched = true; return undefined; } });

  return {
    bg,
    store,
    handlers,
    listener,
    ready,
    fromPage,
    storageTouched: () => storageTouched,
    openPage(url, html) {
      delete globalThis.location;
      globalThis.location = new URL(url);
      document.body.innerHTML = html;
      globalThis.chrome = pageChrome;
      vm.runInThisContext(CONTENT_JS);
    },
    stack: () => bg.storage.local.peek('stack') || [],
    // Decisions live in the content script (isolated world), never in page-visible attributes.
    annotationOf: (postKey) => globalThis.__scrollCollectorLoaded?.annotation(postKey) ?? null,
    statusOf: (postKey) => globalThis.__scrollCollectorLoaded?.annotation(postKey)?.status ?? null
  };
}

describe('content.js <-> service worker (real router, handlers, ingest and rules engine)', () => {
  test('a LinkedIn feed becomes 4 clean items keyed by URN, annotated in the page', async () => {
    const w = await wire();
    w.openPage(FEED_URL, fixtureBody('linkedin-feed.html'));

    await waitFor(() => w.stack().length === 4);
    await waitFor(() => Object.values(LI).every(k => w.statusOf(k) === 'collected'));

    // Configuration only ever arrived by message.
    expect(w.storageTouched()).toBe(false);
    expect(w.fromPage[0]).toEqual({ type: MSG.GET_CONTENT_CONFIG });

    const stack = w.stack();
    expect(stack.map(i => i.postKey).sort()).toEqual(Object.values(LI).sort());
    for (const item of stack) {
      expect(item.sourceUrl).toBe(`https://www.linkedin.com/feed/update/${item.postKey.slice(3)}/`);
      expect(item.sourceUrl).not.toMatch(/\/company\/|\/in\//);
      expect(item.textSnippet.length).toBeLessThanOrEqual(2000);
      expect(item.textSnippet).not.toMatch(/…more\s*$/);
      expect(item.decision).toMatchObject({ v: 1, collect: true });
      expect(item.id).toMatch(/^item-\d+$/);
    }
    expect(stack.find(i => i.postKey === LI.promoted).isAd).toBe(true);
    expect(stack.filter(i => i.isAd)).toHaveLength(1);

    // Every payload had the documented TEXT_EXTRACTED shape.
    const extracted = w.fromPage.filter(m => m.type === MSG.TEXT_EXTRACTED).map(m => m.payload);
    expect(extracted.length).toBeGreaterThanOrEqual(4);
    for (const p of extracted) {
      expect(Object.keys(p).sort()).toEqual(
        ['authorName', 'authorUrl', 'isAd', 'isUpdate', 'pageUrl', 'postKey', 'postUrl', 'sourcePlatform', 'sourceUrl', 'text', 'timestamp'].sort()
      );
    }

    // Nothing sent to the tab carries a secret; STATE_UPDATED stays whitelisted.
    expect(JSON.stringify(w.bg.tabs.sent)).not.toContain('SECRET');
    await sleep(30);
    const updates = runtimeMessagesOfType(w.bg, MSG.STATE_UPDATED);
    expect(updates.length).toBeGreaterThan(0);
    expect(JSON.stringify(updates)).not.toContain('SECRET');
    expect(updates.at(-1).payload).toHaveProperty('inFlightCount');
  });

  test('with the restaurant prompt gate on, off-topic posts are rejected, annotated and never stored', async () => {
    const w = await wire({ config: { isMatchPromptEnabled: true, matchPrompt: PROMPT } });
    w.openPage(FEED_URL, fixtureBody('linkedin-feed.html'));

    const offTopic = [LI.company, LI.reshare, LI.promoted];
    await waitFor(() => offTopic.every(k => w.statusOf(k) === 'rejected'));
    await waitFor(() => w.statusOf(LI.michelin) !== null);
    const keys = w.stack().map(i => i.postKey);
    for (const k of offTopic) expect(keys).not.toContain(k);
    expect(keys.every(k => k === LI.michelin)).toBe(true);

    const reason = w.annotationOf(LI.company).reason;
    expect(reason).toMatch(/^(rules_no_match|social_noise)$/);
    expect(document.querySelector('[data-sc-status], [data-sc-reason], [data-sc-tag], [data-sc-pmatch]')).toBeNull();
    const log = (await w.bg.storage.session.get('rejectedLog')).rejectedLog;
    expect(log.map(r => r.postKey)).toEqual(expect.arrayContaining(offTopic));
  });

  test('a paused tracker dispatches nothing; resuming pushes CONTENT_CONFIG_UPDATED and collection starts', async () => {
    const w = await wire({ config: { isTrackingPaused: true } });
    w.bg.storage.onChanged.addListener(createContentConfigWatcher(createBroadcaster({ area: w.bg.storage.local, runtime: w.bg.runtime, tabs: w.bg.tabs })));
    w.openPage(FEED_URL, fixtureBody('linkedin-feed.html'));
    await sleep(300);
    expect(w.fromPage.filter(m => m.type === MSG.TEXT_EXTRACTED)).toHaveLength(0);

    await w.handlers[MSG.IS_TRACKING_PAUSED_TOGGLED]({ isPaused: false });
    await waitFor(() => w.stack().length === 4);
  });
});

describe('startup: seed, legacy upgrades and the real schema migration', () => {
  /** A v0.9 profile shaped like the user's export. */
  function v09Profile() {
    return {
      configuration: {
        trackedTags: [{ id: 't1', label: 'Health', isEnabled: true }, { id: 't_ads', label: 'Ads', isEnabled: true }],
        sites: [{ id: 's3', domain: 'twitter.com', isEnabled: true }],
        ignoredKeywords: [],
        matchPrompt: PROMPT,
        isMatchPromptEnabled: true,
        matchPromptTags: [{ name: 'Michelin', weight: 5 }, { name: 'Restaurant', weight: 3 }]
      },
      stack: [
        { id: 'item_1', sourceUrl: 'https://www.linkedin.com/company/northwind-labs/posts/', textSnippet: 'glued '.repeat(500), assignedTag: 'Right', timestamp: 1 },
        { id: 'item_1', sourceUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:7301000000000000001/', textSnippet: 'Dinner at Maison Aubergine', assignedTag: 'Unclassified', timestamp: 2, isPinned: true }
      ],
      metrics: { counts: { Right: 1, Unclassified: 1 } },
      secrets: { openai: 'sk-test-SECRET-abcdefghijklmnop' }
    };
  }

  test('migrates a v0.9 profile once; a second start writes nothing', async () => {
    const fake = createFakeChrome({ local: v09Profile() });
    const store = createStore({ area: fake.storage.local });
    const init = () => initializeState({ store, migrateState, migrateAuthors: migrateCanonicalAuthors });

    await init();
    const s = fake.storage.local.dump();
    expect(s.schemaVersion).toBe(SCHEMA_VERSION);
    // defaults are filled in on read, never copied into storage
    expect(s.configuration).not.toHaveProperty('intelligence');
    expect(resolveIntelligence(s.configuration)).toEqual(DEFAULT_INTELLIGENCE);
    expect(s.configuration.matchPromptTags).toEqual(['Michelin', 'Restaurant']);
    expect(s.configuration.trackedTags.find(t => t.label === 'Ads')).toMatchObject({ isPseudo: true });
    expect(s.configuration.sites.some(x => x.domain === 'twitter.com')).toBe(false);
    expect(s.stack.map(i => i.id)).toEqual(['item_1', 'item_1_2']);
    expect(s.stack[0]).toMatchObject({ legacy: true, suspectMerged: true });
    expect(s.stack[0]).not.toHaveProperty('postKey');
    expect(s.stack[1]).toMatchObject({ legacy: true, isFavorite: true, postKey: 'url:https://www.linkedin.com/feed/update/urn:li:activity:7301000000000000001' });
    expect(s.secrets).toEqual({ openai: 'sk-test-SECRET-abcdefghijklmnop' });

    const sets = fake.storage.local.calls.set;
    await init();
    expect(fake.storage.local.calls.set).toBe(sets);
    expect(seedAndUpgrade(fake.storage.local.dump(), Date.now(), { migrateAuthors: migrateCanonicalAuthors }).changedKeys.size).toBe(0);
    expect(migrateState(fake.storage.local.dump()).changed).toBe(false);
  });

  test('a migrated legacy item and the same post sent by the new content.js stay one item', async () => {
    const fake = createFakeChrome({ local: v09Profile() });
    const store = createStore({ area: fake.storage.local });
    await initializeState({ store, migrateState, migrateAuthors: migrateCanonicalAuthors });
    await store.mutateConfig(cfg => ({ ...cfg, isMatchPromptEnabled: false }));

    const ingest = createIngest({
      store,
      decideMany: rulesOnlyDecideMany(),
      broadcast: { scheduleBroadcast() {} },
      session: null,
      settleMs: 0
    });
    await ingest.enqueue({
      text: 'Dinner at Maison Aubergine last night, two days after it received its second Michelin star.',
      postKey: LI.michelin,
      postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:7301000000000000001/',
      sourcePlatform: 'www.linkedin.com',
      isUpdate: true
    });
    await ingest.drain();

    const stack = fake.storage.local.peek('stack');
    expect(stack).toHaveLength(2);
    const item = stack.find(i => i.id === 'item_1_2');
    expect(item).toMatchObject({ postKey: LI.michelin, isFavorite: true });
    expect(item.textSnippet).toContain('second Michelin star');
    expect(item).not.toHaveProperty('legacy');
  });
});

describe('lib/sites.js (shared with content.js semantics)', () => {
  test('normalizeDomain tolerates schemes, www, paths, ports, wildcards and folds twitter.com', () => {
    expect(normalizeDomain('https://www.Example.com:8443/path?q=1')).toBe('example.com');
    expect(normalizeDomain('*.example.com.')).toBe('example.com');
    expect(normalizeDomain('mobile.twitter.com')).toBe('x.com');
    expect(normalizeDomain('*')).toBe('*');
  });

  test('a stored twitter.com entry matches x.com, both directions', () => {
    expect(checkIfSiteEnabled('x.com', [{ domain: 'twitter.com', isEnabled: false }])).toBe(false);
    expect(checkIfSiteEnabled('twitter.com', [{ domain: 'x.com', isEnabled: false }])).toBe(false);
    expect(injectCheck('www.reddit.com', [{ domain: 'https://reddit.com/', isEnabled: true }])).toBe(true);
    expect(checkIfSiteEnabled('example.org', [{ domain: '*', isEnabled: true }])).toBe(true);
    expect(checkIfSiteEnabled('example.org', [{ domain: '*', isEnabled: false }])).toBe(false);
    expect(checkIfSiteEnabled('news.ycombinator.com', [])).toBe(true);
  });

  test('ignored domains typed as URLs still block ingest', async () => {
    expect(isIgnoredHost('www.linkedin.com', ['https://linkedin.com/feed'])).toBe(true);
    expect(isIgnoredHost('linkedin.com', ['*'])).toBe(false);
    const fake = createFakeChrome({ local: { configuration: { ...defaultConfiguration(), ignoredDomains: ['https://www.linkedin.com/'] } } });
    const ingest = createIngest({ store: createStore({ area: fake.storage.local }), decideMany: async () => [], broadcast: { scheduleBroadcast() {} }, session: null });
    const res = await ingest.enqueue({ text: 'hello world, a long enough post', postKey: 'k1', sourcePlatform: 'www.linkedin.com' });
    expect(res).toEqual({ status: 'ignored', postKey: 'k1', reason: 'ignored_domain' });
  });
});

describe('decision cascade (rules tier) <-> rules engine', () => {
  const ctx = (configuration) => ({ configuration, promptVersion: 1, gateOn: true, purpose: 'ingest' });

  test('rules gate decisions carry pMatch and confidence (low-confidence rules, not 1/0)', async () => {
    const decideMany = rulesOnlyDecideMany();
    const cfg = { ...defaultConfiguration(), isMatchPromptEnabled: true, matchPrompt: PROMPT };
    const [yes, no] = await decideMany([
      { id: 'a', text: 'A Michelin star restaurant opened downtown, the tasting menu is all about quality food and seasonal cooking.', platform: 'linkedin.com' },
      { id: 'b', text: 'Our compliance autopilot collects SOC 2 evidence from your cloud accounts automatically.', platform: 'linkedin.com' }
    ], ctx(cfg));
    expect(yes).toMatchObject({ collect: true, path: ['rules'], provider: 'rules', uncertain: true });
    expect(yes.pMatch).toBeGreaterThanOrEqual(0.65);
    expect(yes.pMatch).toBeLessThan(1);
    expect(yes.matchConfidence).toBeGreaterThan(0);
    expect(no).toMatchObject({ collect: false, path: ['rules'], provider: 'rules' });
    expect(rejectionReason(no)).toBe('rules_no_match');
    expect(no.pMatch).toBeLessThan(0.5);
  });
});

describe('intelligence settings and API keys', () => {
  async function setup() {
    const w = await wire();
    await w.ready();
    return w;
  }
  const PAGE = { tab: { id: TAB_ID, url: FEED_URL }, url: FEED_URL };
  const PANEL = { id: 'ext', url: 'chrome-extension://ext/sidepanel.html' };

  test('UPDATE_INTELLIGENCE_SETTINGS applies a whitelisted patch and rejects a bad one as a whole', async () => {
    const { handlers, bg } = await setup();
    const ok = await handlers[MSG.UPDATE_INTELLIGENCE_SETTINGS]({ patch: { escalation: { provider: 'jev' }, providers: { jev: { enabled: true } }, debugAnnotate: true } }, PANEL);
    expect(ok.success).toBe(true);
    // the reply carries the resolved settings ...
    expect(ok.intelligence).toMatchObject({ escalation: { provider: 'jev', perMinute: 30 }, providers: { jev: { enabled: true, model: 'jev-latest' }, openai: { enabled: false } }, debugAnnotate: true });
    // ... storage only the explicit choices, so later default changes still apply
    expect(bg.storage.local.peek('configuration').intelligence).toEqual({ escalation: { provider: 'jev' }, providers: { jev: { enabled: true } }, debugAnnotate: true });
    const second = await handlers[MSG.UPDATE_INTELLIGENCE_SETTINGS]({ patch: { gate: { strictness: 'strict' } } }, PANEL);
    expect(second.intelligence).toMatchObject({ escalation: { provider: 'jev' }, gate: { strictness: 'strict', whenUnsure: 'collect' } });
    expect(bg.storage.local.peek('configuration').intelligence).toEqual({ escalation: { provider: 'jev' }, providers: { jev: { enabled: true } }, debugAnnotate: true, gate: { strictness: 'strict' } });

    const bad = await handlers[MSG.UPDATE_INTELLIGENCE_SETTINGS]({ patch: { escalation: { provider: 'gpt' }, providers: { openai: { apiKey: 'sk-xyz' } }, dynamicTags: true } }, PANEL);
    expect(bad.success).toBe(false);
    expect(bad.errors.length).toBe(2);
    expect(bg.storage.local.peek('configuration').intelligence).not.toHaveProperty('dynamicTags');

    // content-relevant: debugAnnotate reaches GET_CONTENT_CONFIG
    expect(await handlers[MSG.GET_CONTENT_CONFIG]({})).toMatchObject({ debugAnnotate: true });
  });

  test('SET_SECRET / CLEAR_SECRET store keys outside configuration and never echo them', async () => {
    const { handlers, bg, listener } = await setup();
    const key = 'sk-openai-test-SECRET-0123456789wxyz';
    const set = await handlers[MSG.SET_SECRET]({ provider: 'openai', value: key }, PANEL);
    expect(set).toEqual({ success: true, secrets: { jev: { set: true, last4: '7890' }, openai: { set: true, last4: 'wxyz' } } });
    expect(JSON.stringify(set)).not.toContain(key);
    expect(bg.storage.local.peek('secrets').openai).toBe(key);
    expect(JSON.stringify(bg.storage.local.peek('configuration'))).not.toContain(key);

    const state = await handlers[MSG.GET_STATE]({});
    expect(JSON.stringify(state)).not.toContain('SECRET');

    const bad = await handlers[MSG.SET_SECRET]({ provider: 'anthropic', value: key }, PANEL);
    expect(bad).toMatchObject({ success: false, code: 'bad_request' });
    expect(JSON.stringify(bad)).not.toContain(key);

    const cleared = await handlers[MSG.CLEAR_SECRET]({ provider: 'openai' }, PANEL);
    expect(cleared.secrets.openai).toEqual({ set: false, last4: null });

    // Through the router as well (reply shape is what the panel will see).
    const viaRouter = await new Promise(resolve => listener({ type: MSG.CLEAR_SECRET, payload: { provider: 'jev' } }, PANEL, resolve));
    expect(viaRouter).toMatchObject({ success: true, secrets: { jev: { set: false } } });
  });

  test('content scripts (senders with a tab) cannot change settings or keys', async () => {
    const { handlers, bg } = await setup();
    for (const [type, payload] of [
      [MSG.SET_SECRET, { provider: 'jev', value: 'attacker-key-123456789' }],
      [MSG.CLEAR_SECRET, { provider: 'jev' }],
      [MSG.UPDATE_INTELLIGENCE_SETTINGS, { patch: { providers: { openai: { enabled: true } } } }]
    ]) {
      expect(await handlers[type](payload, PAGE)).toMatchObject({ success: false, code: 'forbidden' });
    }
    expect(bg.storage.local.peek('secrets')).toEqual({ jev: 'jev-key-SECRET-1234567890' });
    expect(resolveIntelligence(bg.storage.local.peek('configuration')).providers.openai.enabled).toBe(false);
  });

  test('through the router, content scripts may only send TEXT_EXTRACTED and GET_CONTENT_CONFIG', async () => {
    const { listener, bg } = await setup();
    const send = (type, payload, sender) => new Promise(resolve => {
      const open = listener({ type, payload }, sender, resolve);
      if (open !== true) setTimeout(() => resolve(undefined), 20);
    });
    for (const [type, payload] of [[MSG.GET_STATE, {}], [MSG.CLEAR_STACK, {}], [MSG.CONFIG_CHANGED, { isTrackingPaused: true }], [MSG.SET_SECRET, { provider: 'jev', value: 'attacker-key-123456789' }]]) {
      expect(await send(type, payload, PAGE)).toEqual({ success: false, error: 'Not allowed from a web page', code: 'forbidden' });
    }
    expect(bg.storage.local.peek('secrets')).toEqual({ jev: 'jev-key-SECRET-1234567890' });
    expect(await send(MSG.GET_CONTENT_CONFIG, {}, PAGE)).toMatchObject({ success: true });
    const state = await send(MSG.GET_STATE, {}, PANEL);
    expect(Object.keys(state).sort()).toEqual(['configuration', 'inFlightCount', 'metrics', 'stack', 'telemetry']);
  });

  test('with the extension origin known, senders are judged by URL (an extension page in a tab is allowed)', async () => {
    const fake = createFakeChrome({ local: { configuration: defaultConfiguration() } });
    const handlers = createHandlers({
      store: createStore({ area: fake.storage.local }),
      broadcast: createBroadcaster({ area: fake.storage.local, runtime: fake.runtime, tabs: fake.tabs }),
      ingest: { enqueue: async () => ({ status: 'queued' }) },
      engine: {},
      extensionOrigin: 'chrome-extension://ext'
    });
    const panelInTab = { id: 'ext', tab: { id: 9 }, url: 'chrome-extension://ext/sidepanel.html', origin: 'chrome-extension://ext' };
    const page = { id: 'ext', tab: { id: 5 }, url: FEED_URL, origin: 'https://www.linkedin.com' };
    const lookalike = { id: 'ext', tab: { id: 5 }, url: 'https://evil.example/chrome-extension://ext/x' };
    expect(await handlers[MSG.SET_SECRET]({ provider: 'jev', value: 'jev-key-0123456789abcd' }, panelInTab)).toMatchObject({ success: true });
    expect(await handlers[MSG.CLEAR_SECRET]({ provider: 'jev' }, page)).toMatchObject({ success: false, code: 'forbidden' });
    expect(await handlers[MSG.CLEAR_SECRET]({ provider: 'jev' }, lookalike)).toMatchObject({ success: false, code: 'forbidden' });
    expect(fake.storage.local.peek('secrets')).toEqual({ jev: 'jev-key-0123456789abcd' });
  });
});

describe('prompt edits clear the decision-layer expansion', () => {
  test('UPDATE_MATCH_PROMPT empties matchPromptExpansion', async () => {
    const w = await wire({ config: { matchPrompt: 'ramen', matchPromptExpansion: 'ramen shops, noodle bars' } });
    await w.handlers[MSG.UPDATE_MATCH_PROMPT]({ prompt: 'sushi' });
    expect(w.bg.storage.local.peek('configuration')).toMatchObject({ matchPrompt: 'sushi', matchPromptExpansion: '' });
  });
});
