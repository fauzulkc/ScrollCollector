import { describe, test, expect, afterAll } from 'vitest';
import { createRouter } from '../../lib/bg/router.js';
import { createFakeChrome, installFakeChrome } from '../helpers/fake-chrome.js';
import { MSG, CONTENT_SCRIPT_MESSAGES } from '../../lib/messages.js';

/** The side panel as chrome reports it (the fake extension id of test/helpers/fake-chrome.js). */
const SIDE_PANEL = { id: 'fake-extension-id', url: 'chrome-extension://fake-extension-id/sidepanel.html', origin: 'chrome-extension://fake-extension-id' };

/** Invokes the listener like chrome.runtime.onMessage and resolves with { returned, response }. */
async function dispatch(listener, message, sender = SIDE_PANEL) {
  let respond;
  const replied = new Promise(r => { respond = r; });
  const returned = listener(message, sender, respond);
  // A listener that did not return true must have replied synchronously (or not at all).
  const response = returned === true ? await replied : await Promise.race([replied, new Promise(r => setTimeout(() => r(undefined), 20))]);
  return { returned, response };
}

describe('background router', () => {
  test('offscreen-targeted messages are not ours: no reply, returns false', async () => {
    let called = false;
    const listener = createRouter({ [MSG.S1_LOAD]: () => { called = true; return {}; } });
    const { returned, response } = await dispatch(listener, { type: MSG.S1_LOAD, target: 'offscreen' });
    expect(returned).toBe(false);
    expect(response).toBeUndefined();
    expect(called).toBe(false);
  });

  test('unknown types get an error reply (and the channel is not held open)', async () => {
    const listener = createRouter({});
    const responses = [];
    const returned = listener({ type: 'NOPE' }, {}, r => responses.push(r));
    expect(returned).toBe(false);
    expect(responses).toEqual([{ success: false, error: 'Unknown message type' }]);

    const noType = [];
    listener({}, {}, r => noType.push(r));
    listener(null, {}, r => noType.push(r));
    expect(noType).toEqual([
      { success: false, error: 'Unknown message type' },
      { success: false, error: 'Unknown message type' }
    ]);
  });

  test('a throwing handler replies { success: false, error }', async () => {
    const listener = createRouter({
      [MSG.GET_STATE]: async () => { throw new Error('boom'); },
      [MSG.TAG_TOGGLED]: () => { throw new TypeError('sync boom'); }
    });
    expect(await dispatch(listener, { type: MSG.GET_STATE })).toEqual({ returned: true, response: { success: false, error: 'boom' } });
    expect(await dispatch(listener, { type: MSG.TAG_TOGGLED, payload: {} })).toEqual({ returned: true, response: { success: false, error: 'sync boom' } });
  });

  test('handlers get payload + sender, run after `ready`, and undefined replies { success: true }', async () => {
    const order = [];
    let release;
    const ready = new Promise(r => { release = r; });
    const listener = createRouter({
      [MSG.TEXT_EXTRACTED]: (payload, sender) => { order.push(['handler', payload.text, sender.tab.id]); return { status: 'queued' }; },
      [MSG.TAG_TOGGLED]: () => undefined
    }, { ready: () => ready });

    const pending = dispatch(listener, { type: MSG.TEXT_EXTRACTED, payload: { text: 'hi' } }, { tab: { id: 4 } });
    await new Promise(r => setTimeout(r, 10));
    expect(order).toEqual([]);
    order.push(['ready']);
    release();
    expect(await pending).toEqual({ returned: true, response: { status: 'queued' } });
    expect(order).toEqual([['ready'], ['handler', 'hi', 4]]);
    expect(await dispatch(listener, { type: MSG.TAG_TOGGLED })).toEqual({ returned: true, response: { success: true } });
  });

  test('messages for the background (target: background) are routed normally', async () => {
    const listener = createRouter({ [MSG.GET_STATE]: () => ({ ok: 1 }) });
    expect(await dispatch(listener, { type: MSG.GET_STATE, target: 'background' })).toEqual({ returned: true, response: { ok: 1 } });
  });

  test('content scripts may send only TEXT_EXTRACTED and GET_CONTENT_CONFIG; extension pages anything', async () => {
    expect(CONTENT_SCRIPT_MESSAGES).toEqual([MSG.TEXT_EXTRACTED, MSG.GET_CONTENT_CONFIG]);
    const calls = [];
    const handlers = Object.fromEntries([MSG.GET_STATE, MSG.CLEAR_STACK, MSG.ITEM_DELETED, MSG.GET_CATEGORY_ITEMS, MSG.TEXT_EXTRACTED, MSG.GET_CONTENT_CONFIG]
      .map(type => [type, () => { calls.push(type); return { ok: type }; }]));
    const listener = createRouter(handlers, { extensionOrigin: 'chrome-extension://abc' });
    const page = { id: 'abc', tab: { id: 3, url: 'https://www.linkedin.com/feed/' }, frameId: 0, url: 'https://www.linkedin.com/feed/', origin: 'https://www.linkedin.com' };
    const panel = { id: 'abc', url: 'chrome-extension://abc/sidepanel.html', origin: 'chrome-extension://abc' };
    const panelInTab = { ...panel, tab: { id: 9 } };

    for (const type of [MSG.GET_STATE, MSG.CLEAR_STACK, MSG.ITEM_DELETED, MSG.GET_CATEGORY_ITEMS]) {
      expect(await dispatch(listener, { type }, page)).toEqual({ returned: false, response: { success: false, error: 'Not allowed from a web page', code: 'forbidden' } });
    }
    expect(calls).toEqual([]);
    expect((await dispatch(listener, { type: MSG.TEXT_EXTRACTED, payload: { text: 'x' } }, page)).response).toEqual({ ok: MSG.TEXT_EXTRACTED });
    expect((await dispatch(listener, { type: MSG.GET_CONTENT_CONFIG }, page)).response).toEqual({ ok: MSG.GET_CONTENT_CONFIG });
    expect((await dispatch(listener, { type: MSG.GET_STATE }, panel)).response).toEqual({ ok: MSG.GET_STATE });
    expect((await dispatch(listener, { type: MSG.CLEAR_STACK }, panelInTab)).response).toEqual({ ok: MSG.CLEAR_STACK });
    // a page URL that merely contains the extension URL is still a page
    expect((await dispatch(listener, { type: MSG.GET_STATE }, { ...page, url: 'https://evil.example/chrome-extension://abc/x' })).response).toMatchObject({ code: 'forbidden' });
  });
});

describe('background.js wiring', () => {
  const fake = createFakeChrome({
    local: { secrets: { jev: 'sk-wiring-SECRET' } },
    tabs: [{ id: 11, url: 'https://www.linkedin.com/feed/' }]
  });
  const uninstall = installFakeChrome(fake);
  afterAll(() => uninstall());

  test('loads, seeds state, restricts storage access and serves the side panel contract', async () => {
    await import('../../background.js');
    const [listener] = fake.runtime.onMessage.listeners;
    expect(typeof listener).toBe('function');
    expect(fake.sidePanel.behavior).toEqual({ openPanelOnActionClick: true });
    expect(fake.alarms.created.has('idleRetry')).toBe(true);

    const PANEL = { id: 'fake-extension-id', url: 'chrome-extension://fake-extension-id/sidepanel.html', origin: 'chrome-extension://fake-extension-id' };
    const PAGE = { id: 'fake-extension-id', tab: { id: 11 }, url: 'https://www.linkedin.com/feed/', origin: 'https://www.linkedin.com' };
    const { response: state } = await dispatch(listener, { type: MSG.GET_STATE }, PANEL);
    expect(fake.storage.local.accessLevel).toBe('TRUSTED_CONTEXTS');
    expect(Object.keys(state).sort()).toEqual(['configuration', 'inFlightCount', 'metrics', 'stack', 'telemetry']);
    expect(JSON.stringify(state)).not.toContain('SECRET');
    expect(state.configuration.trackedTags.length).toBeGreaterThan(0);
    // storage.local is closed to content scripts, and so is the stack through messages
    expect((await dispatch(listener, { type: MSG.GET_STATE }, PAGE)).response).toMatchObject({ success: false, code: 'forbidden' });

    const { response: content } = await dispatch(listener, { type: MSG.GET_CONTENT_CONFIG }, PAGE);
    expect(content).toMatchObject({ success: true, isTrackingPaused: false });

    const { response: queued } = await dispatch(listener, {
      type: MSG.TEXT_EXTRACTED,
      payload: {
        text: 'We are hiring a senior software engineer to join our developer tools team, apply now.',
        postKey: 'li:urn:li:activity:77',
        postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:77/',
        sourcePlatform: 'linkedin.com'
      }
    }, PAGE);
    expect(queued).toMatchObject({ success: true, status: 'queued', postKey: 'li:urn:li:activity:77' });

    // The cascade decides and commits the post: no offscreen document answers in node, so System 1
    // is unavailable and the rules tier decides.
    for (let i = 0; i < 250 && !(fake.storage.local.peek('stack') || []).length; i++) {
      await new Promise(r => setTimeout(r, 20));
    }
    const stack = fake.storage.local.peek('stack');
    expect(stack).toHaveLength(1);
    expect(stack[0]).toMatchObject({ postKey: 'li:urn:li:activity:77', decision: { v: 1, collect: true } });
    expect(stack[0].decision.path).toContain('rules');

    // GET_ENGINE_STATUS: the EngineStatus plus the legacy { tier, name, status }.
    const { response: engine } = await dispatch(listener, { type: MSG.GET_ENGINE_STATUS }, PANEL);
    expect(engine).toMatchObject({ badge: { level: expect.any(String) }, tier: 3, name: 'Rule-based Classifier', warnings: [] });
    expect(engine.system1).toHaveProperty('state');
    expect(engine.nano).toMatchObject({ present: 'none' });

    // GET_DIAGNOSTICS: counters, providers and describeSecrets(), never a key.
    const { response: diag } = await dispatch(listener, { type: MSG.GET_DIAGNOSTICS }, PANEL);
    expect(diag).toMatchObject({ success: true, secrets: { jev: { set: true }, openai: { set: false } }, cache: { size: expect.any(Number) } });
    expect(Object.keys(diag.providers).sort()).toEqual(['jev', 'nano', 'openai', 'system1']);
    expect(diag.engineStatus.counters.decided).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(diag)).not.toContain('sk-wiring');
    expect((await dispatch(listener, { type: MSG.GET_DIAGNOSTICS }, PAGE)).response).toMatchObject({ code: 'forbidden' });

    expect((await dispatch(listener, { type: MSG.TEST_PROVIDER, payload: { provider: 'gpt' } }, PANEL)).response)
      .toMatchObject({ success: false, code: 'bad_request' });
    const { response: jevTest } = await dispatch(listener, { type: MSG.TEST_PROVIDER, payload: { provider: 'nano' } }, PANEL);
    expect(jevTest).toMatchObject({ success: true, ok: false, code: 'unavailable' });
    expect((await dispatch(listener, { type: MSG.NANO_DOWNLOAD_STATE, payload: { phase: 'nope' } }, PANEL)).response)
      .toMatchObject({ success: false, code: 'bad_request' });
    expect((await dispatch(listener, { type: MSG.RESET_DIAGNOSTICS }, PANEL)).response).toEqual({ success: true });
    expect((await dispatch(listener, { type: MSG.S1_STATUS, target: 'background', payload: { status: 'loading', model: 'minilm', progress: 0.5 } }, { url: 'chrome-extension://fake-extension-id/offscreen/offscreen.html' })).response)
      .toMatchObject({ success: true });
    const { response: redecide } = await dispatch(listener, { type: MSG.REDECIDE_STACK, payload: { scope: 'rules-only' } }, PANEL);
    expect(redecide).toMatchObject({ success: true, jobId: expect.any(String) });

    const { response: unknown } = await dispatch(listener, { type: 'NOT_A_MESSAGE' }, PANEL);
    expect(unknown).toEqual({ success: false, error: 'Unknown message type' });
  }, 60000); // the dynamic import of background.js counts toward the timeout; slow on a loaded machine
});
