import { describe, test, expect } from 'vitest';
import { createOffscreenClient, isNoReceiverError, OFFSCREEN_URL } from '../../lib/offscreen-client.js';

const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/**
 * Fake chrome.runtime / chrome.offscreen. `respond(message)` plays the offscreen document; it may
 * return a value, a promise, or throw. Without a document every send fails with NO_RECEIVER.
 */
function fakeChrome({ exists = false, createDelayMs = 0, respond = (m) => ({ ok: true, echo: m.type }) } = {}) {
  const state = { exists, created: 0, closed: 0, sent: [], createArgs: [], respond };
  const api = {
    runtime: {
      getURL: (p) => `chrome-extension://abc/${p}`,
      getContexts: async ({ contextTypes, documentUrls }) => {
        expect(contextTypes).toEqual(['OFFSCREEN_DOCUMENT']);
        expect(documentUrls).toEqual([`chrome-extension://abc/${OFFSCREEN_URL}`]);
        return state.exists ? [{ contextType: 'OFFSCREEN_DOCUMENT', documentUrl: documentUrls[0] }] : [];
      },
      sendMessage: async (message) => {
        state.sent.push(message);
        await tick();
        if (!state.exists) throw new Error(NO_RECEIVER);
        return state.respond(message);
      }
    },
    offscreen: {
      createDocument: async (args) => {
        state.createArgs.push(args);
        await tick(createDelayMs);
        if (state.exists) throw new Error('Only a single offscreen document may be created.');
        state.exists = true;
        state.created += 1;
      },
      closeDocument: async () => {
        state.closed += 1;
        state.exists = false;
      }
    }
  };
  return { api, state };
}

describe('ensureOffscreenDocument', () => {
  test('creates the document once for concurrent callers (WORKERS reason, justification)', async () => {
    const { api, state } = fakeChrome({ createDelayMs: 10 });
    const client = createOffscreenClient({ chromeApi: api });
    const results = await Promise.all([client.ensureOffscreenDocument(), client.ensureOffscreenDocument(), client.ensureOffscreenDocument()]);
    expect(state.created).toBe(1);
    expect(state.createArgs).toHaveLength(1);
    expect(state.createArgs[0]).toMatchObject({ url: OFFSCREEN_URL, reasons: ['WORKERS'] });
    expect(state.createArgs[0].justification).toMatch(/embedding model/);
    // The callers shared the one creation.
    expect(results).toEqual([true, true, true]);
    expect(await client.ensureOffscreenDocument()).toBe(false);
    expect(state.created).toBe(1);
  });

  test('does not create a document that already exists, and treats "only a single offscreen document" as success', async () => {
    const existing = fakeChrome({ exists: true });
    expect(await createOffscreenClient({ chromeApi: existing.api }).ensureOffscreenDocument()).toBe(false);
    expect(existing.state.createArgs).toHaveLength(0);

    // getContexts says "none" but another context created it meanwhile.
    const racing = fakeChrome();
    racing.api.runtime.getContexts = async () => [];
    racing.state.exists = true;
    await expect(createOffscreenClient({ chromeApi: racing.api }).ensureOffscreenDocument()).resolves.toBe(false);
  });

  test('reports a missing offscreen API with code offscreen_unavailable', async () => {
    const { api } = fakeChrome();
    delete api.offscreen;
    await expect(createOffscreenClient({ chromeApi: api }).ensureOffscreenDocument()).rejects.toMatchObject({ code: 'offscreen_unavailable' });
  });
});

describe('sendToOffscreen', () => {
  test('creates the document, adds target and a unique request id, and resolves with the reply', async () => {
    const { api, state } = fakeChrome({ respond: (m) => ({ ok: true, got: m.payload }) });
    const client = createOffscreenClient({ chromeApi: api });
    const [a, b] = await Promise.all([client.sendToOffscreen('S1_LOAD', { model: 'minilm' }), client.sendToOffscreen('OFFSCREEN_PING')]);
    expect(a).toEqual({ ok: true, got: { model: 'minilm' } });
    expect(b).toEqual({ ok: true, got: {} });
    expect(state.created).toBe(1);
    expect(state.sent.map((m) => m.target)).toEqual(['offscreen', 'offscreen']);
    expect(state.sent[0]).toMatchObject({ type: 'S1_LOAD', payload: { model: 'minilm' } });
    expect(new Set(state.sent.map((m) => m.requestId)).size).toBe(2);
  });

  test('rejects with code timeout when the document does not answer in time', async () => {
    const { api } = fakeChrome({ exists: true, respond: () => new Promise(() => {}) });
    const client = createOffscreenClient({ chromeApi: api });
    const started = Date.now();
    await expect(client.sendToOffscreen('S1_DECIDE', {}, { timeoutMs: 30 })).rejects.toMatchObject({ code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(client.stats().timeouts).toBe(1);
  });

  test('re-creates the document and retries once when nobody answers', async () => {
    const { api, state } = fakeChrome({ exists: true });
    let first = true;
    state.respond = (m) => {
      if (first) {
        first = false;
        throw new Error(NO_RECEIVER);
      }
      return { ok: true, type: m.type };
    };
    const client = createOffscreenClient({ chromeApi: api });
    await expect(client.sendToOffscreen('S1_LOAD', { model: 'minilm' })).resolves.toEqual({ ok: true, type: 'S1_LOAD' });
    expect(state.closed).toBe(1);
    expect(state.created).toBe(1);
    expect(state.sent).toHaveLength(2);
    expect(state.sent[0].requestId).toBe(state.sent[1].requestId);
    expect(client.stats().recreated).toBe(1);
  });

  test('an undefined reply (port closed without an answer) counts as no receiver; a second failure rejects', async () => {
    const { api, state } = fakeChrome({ exists: true, respond: () => undefined });
    const client = createOffscreenClient({ chromeApi: api });
    await expect(client.sendToOffscreen('S1_EMBED', {})).rejects.toMatchObject({ code: 'no_receiver' });
    expect(state.sent).toHaveLength(2);
    expect(state.closed).toBe(1);
  });

  test('other errors are not retried', async () => {
    const { api, state } = fakeChrome({ exists: true, respond: () => { throw new Error('Extension context invalidated.'); } });
    const client = createOffscreenClient({ chromeApi: api });
    await expect(client.sendToOffscreen('S1_LOAD', {})).rejects.toMatchObject({ code: 'offscreen_error' });
    expect(state.sent).toHaveLength(1);
    expect(state.closed).toBe(0);
  });

  test('concurrent senders that all hit a dead document re-create it only once', async () => {
    const { api, state } = fakeChrome({ exists: true });
    let dead = true;
    state.respond = (m) => {
      if (dead) throw new Error(NO_RECEIVER);
      return { ok: true, id: m.requestId };
    };
    const origCreate = api.offscreen.createDocument;
    api.offscreen.createDocument = async (args) => {
      await origCreate(args);
      dead = false;
    };
    const client = createOffscreenClient({ chromeApi: api });
    const replies = await Promise.all([1, 2, 3].map(() => client.sendToOffscreen('S1_DECIDE', {})));
    expect(replies.every((r) => r.ok)).toBe(true);
    expect(state.closed).toBe(1);
    expect(state.created).toBe(1);
  });
});

describe('isNoReceiverError', () => {
  test('recognises the Chrome messages and the client code', () => {
    expect(isNoReceiverError(new Error(NO_RECEIVER))).toBe(true);
    expect(isNoReceiverError(new Error('The message port closed before a response was received.'))).toBe(true);
    expect(isNoReceiverError({ code: 'no_receiver' })).toBe(true);
    expect(isNoReceiverError(new Error('boom'))).toBe(false);
  });
});
