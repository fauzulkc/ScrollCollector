// @vitest-environment happy-dom
/**
 * content.js configuration via messaging (GET_CONTENT_CONFIG / CONTENT_CONFIG_UPDATED),
 * site gating, DECISION_RESULT annotations and the runtime message listener.
 * The fake chrome has NO storage: storage.local is TRUSTED_CONTEXTS-only in the extension.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const CONTENT_JS = fs.readFileSync(path.resolve(__dirname, '../../content.js'), 'utf8');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, timeout = 4000) {
  const start = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await sleep(20);
  }
}

function teardownContentScript() {
  const instance = globalThis.__scrollCollectorLoaded;
  if (instance && typeof instance.teardown === 'function') instance.teardown();
  delete globalThis.__scrollCollectorLoaded;
}

const BASE_CONFIG = { isTrackingPaused: false, sites: [], ignoredDomains: [], debugAnnotate: false };

/**
 * Fake chrome without storage. `getConfig(attempt)` answers GET_CONTENT_CONFIG
 * (default: BASE_CONFIG merged with `config`).
 */
function installChrome({ config = {}, getConfig } = {}) {
  const messages = [];
  const listeners = [];
  let getCount = 0;
  const answer = getConfig || (() => Promise.resolve({ ...BASE_CONFIG, ...config }));
  const fake = {
    runtime: {
      id: 'test-extension',
      sendMessage: vi.fn((message) => {
        messages.push(message);
        if (message.type === 'GET_CONTENT_CONFIG') return answer(getCount++);
        return Promise.resolve({ status: 'queued', postKey: message.payload && message.payload.postKey });
      }),
      onMessage: {
        addListener: vi.fn(fn => listeners.push(fn)),
        removeListener: vi.fn(fn => {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        })
      }
    }
  };
  let storageTouched = false;
  Object.defineProperty(fake, 'storage', { get() { storageTouched = true; return undefined; } });
  globalThis.chrome = fake;

  return {
    fake,
    messages,
    listeners,
    extracted: () => messages.filter(m => m.type === 'TEXT_EXTRACTED').map(m => m.payload),
    getConfigCalls: () => getCount,
    /** Delivers a background -> content message; returns [{ returned, reply }] per listener. */
    send(message) {
      return listeners.map(fn => {
        let reply;
        const returned = fn(message, {}, r => { reply = r; });
        return { returned, reply };
      });
    },
    storageTouched: () => storageTouched
  };
}

function setLocation(url) {
  delete globalThis.location;
  globalThis.location = new URL(url);
}

const run = () => vm.runInThisContext(CONTENT_JS);

const URN = 'urn:li:activity:7301000000000000777';
const KEY = 'li:' + URN;

function linkedInPost(urn = URN, text = 'Two new omakase counters opened in Lisbon this month, both run by chefs from Michelin-starred kitchens.') {
  return `
    <div class="relative" data-id="${urn}">
      <div class="feed-shared-update-v2" role="article" data-urn="${urn}">
        <div class="update-components-actor"><a class="update-components-actor__meta-link" href="https://www.linkedin.com/in/rui-costa/">
          <span class="update-components-actor__title"><span aria-hidden="true">Rui Costa</span></span></a></div>
        <div class="update-components-text"><span dir="ltr">${text}</span></div>
      </div>
    </div>`;
}

describe('content.js configuration via messaging', () => {
  beforeEach(() => {
    teardownContentScript();
    document.body.innerHTML = '';
  });
  afterEach(() => teardownContentScript());

  test('never touches chrome.storage and dispatches nothing until GET_CONTENT_CONFIG answers', async () => {
    setLocation('https://www.linkedin.com/feed/');
    document.body.innerHTML = linkedInPost();
    let resolveConfig;
    const chrome = installChrome({ getConfig: () => new Promise(resolve => { resolveConfig = resolve; }) });
    run();

    expect(chrome.messages[0]).toEqual({ type: 'GET_CONTENT_CONFIG' });
    await sleep(400);
    expect(chrome.extracted()).toHaveLength(0);

    resolveConfig({ ...BASE_CONFIG });
    const item = await waitFor(() => chrome.extracted()[0]);
    expect(item.postKey).toBe(KEY);
    expect(chrome.storageTouched()).toBe(false);
  });

  test('retries GET_CONTENT_CONFIG with backoff while the service worker is not ready', async () => {
    setLocation('https://www.linkedin.com/feed/');
    document.body.innerHTML = linkedInPost();
    const chrome = installChrome({
      getConfig: (attempt) => {
        if (attempt === 0) return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
        if (attempt === 1) return Promise.resolve(undefined);
        return Promise.resolve({ ...BASE_CONFIG });
      }
    });
    run();

    await waitFor(() => chrome.extracted().length === 1, 5000);
    expect(chrome.getConfigCalls()).toBe(3);
    const firstDispatch = chrome.messages.findIndex(m => m.type === 'TEXT_EXTRACTED');
    const lastGet = chrome.messages.map(m => m.type).lastIndexOf('GET_CONTENT_CONFIG');
    expect(firstDispatch).toBeGreaterThan(lastGet);
  });

  test('a paused config suppresses dispatch; CONTENT_CONFIG_UPDATED resumes and pauses again', async () => {
    setLocation('https://www.linkedin.com/feed/');
    document.body.innerHTML = linkedInPost();
    const chrome = installChrome({ config: { isTrackingPaused: true } });
    run();

    await waitFor(() => chrome.getConfigCalls() === 1);
    await sleep(400);
    expect(chrome.extracted()).toHaveLength(0);

    const [resume] = chrome.send({ type: 'CONTENT_CONFIG_UPDATED', payload: { ...BASE_CONFIG, isTrackingPaused: false } });
    expect(resume.returned).toBe(false);
    expect(resume.reply).toEqual({ success: true });
    await waitFor(() => chrome.extracted().length === 1);

    chrome.send({ type: 'CONTENT_CONFIG_UPDATED', payload: { ...BASE_CONFIG, isTrackingPaused: true } });
    const holder = document.createElement('div');
    holder.innerHTML = linkedInPost('urn:li:activity:7301000000000000778', 'A second post that shows up while tracking is paused and must not be sent.');
    document.body.appendChild(holder);
    await sleep(600);
    expect(chrome.extracted()).toHaveLength(1);
  });

  test.each([
    ['www.linkedin.com entry disabled', 'https://www.linkedin.com/feed/', { sites: [{ domain: 'www.linkedin.com', isEnabled: false }] }, 0],
    ['scheme + trailing slash entry disabled', 'https://www.linkedin.com/feed/', { sites: [{ domain: 'https://www.linkedin.com/', isEnabled: false }] }, 0],
    ['www.linkedin.com entry enabled', 'https://www.linkedin.com/feed/', { sites: [{ domain: 'www.linkedin.com', isEnabled: true }] }, 1],
    ['default site with no entries', 'https://www.linkedin.com/feed/', { sites: [] }, 1],
    ['ignored domain', 'https://www.linkedin.com/feed/', { ignoredDomains: ['LinkedIn.com'] }, 0],
    ['unknown site, no entries', 'https://blog.example.org/', { sites: [] }, 0],
    ['unknown site, wildcard', 'https://blog.example.org/', { sites: [{ domain: '*', isEnabled: true }] }, 1],
    ['unknown site, www. parent entry', 'https://blog.example.org/', { sites: [{ domain: 'https://www.example.org/', isEnabled: true }] }, 1],
    ['twitter.com host, x.com entry disabled', 'https://twitter.com/home', { sites: [{ domain: 'x.com', isEnabled: false }] }, 0]
  ])('site gating: %s', async (_label, url, config, expected) => {
    setLocation(url);
    document.body.innerHTML = url.includes('linkedin')
      ? linkedInPost()
      : '<article><h2>Seasonal menus</h2><p>Plain article text that is comfortably longer than the sixty character minimum for generic sites.</p></article>';
    const chrome = installChrome({ config });
    run();

    await waitFor(() => chrome.getConfigCalls() === 1);
    await sleep(150);
    expect(chrome.extracted()).toHaveLength(expected);
  });

  test('disabling the site via CONTENT_CONFIG_UPDATED stops collecting new posts', async () => {
    setLocation('https://www.linkedin.com/feed/');
    document.body.innerHTML = linkedInPost();
    const chrome = installChrome();
    run();
    await waitFor(() => chrome.extracted().length === 1);

    chrome.send({ type: 'CONTENT_CONFIG_UPDATED', payload: { ...BASE_CONFIG, sites: [{ domain: 'linkedin.com', isEnabled: false }] } });
    const holder = document.createElement('div');
    holder.innerHTML = linkedInPost('urn:li:activity:7301000000000000779', 'Another post that arrives after the user switched this site off in the panel.');
    document.body.appendChild(holder);
    await sleep(600);
    expect(chrome.extracted()).toHaveLength(1);
  });
});

describe('content.js runtime messages', () => {
  let chrome;

  beforeEach(async () => {
    teardownContentScript();
    setLocation('https://www.linkedin.com/feed/');
    document.body.innerHTML = linkedInPost();
    chrome = installChrome();
    run();
    await waitFor(() => chrome.extracted().length === 1);
  });
  afterEach(() => teardownContentScript());

  test('DECISION_RESULT stays in the content script: nothing about the decision is written into the page', () => {
    const [result] = chrome.send({
      type: 'DECISION_RESULT',
      payload: { postKey: KEY, status: 'collected', reason: 'system1_match', tag: 'Food', pMatch: 0.913 }
    });
    expect(result.returned).toBe(false);
    expect(result.reply).toEqual({ success: true });

    // The page's own scripts (and analytics / session replay) read the DOM: no tag, verdict,
    // p(match) or provider may end up there.
    const el = document.querySelector(`[data-sc-key="${KEY}"]`);
    for (const attr of ['data-sc-status', 'data-sc-reason', 'data-sc-tag', 'data-sc-pmatch']) {
      expect(el.hasAttribute(attr)).toBe(false);
    }
    expect(document.querySelector('[data-sc-status], [data-sc-tag], [data-sc-reason], [data-sc-pmatch], [data-sc-badge]')).toBeNull();
    expect(globalThis.__scrollCollectorLoaded.annotation(KEY)).toEqual({ status: 'collected', reason: 'system1_match', tag: 'Food', pMatch: 0.913 });

    chrome.send({ type: 'DECISION_RESULT', payload: { postKey: KEY, status: 'rejected', reason: 'prompt_mismatch' } });
    expect(globalThis.__scrollCollectorLoaded.annotation(KEY)).toEqual({ status: 'rejected', reason: 'prompt_mismatch', tag: null, pMatch: null });
    expect(el.hasAttribute('data-sc-status')).toBe(false);

    // Unknown keys and malformed payloads are harmless
    expect(chrome.send({ type: 'DECISION_RESULT', payload: { postKey: 'li:nope', status: 'collected' } })[0].reply).toEqual({ success: true });
    expect(chrome.send({ type: 'DECISION_RESULT', payload: { status: 'collected' } })[0].reply).toEqual({ success: false });
    expect(globalThis.__scrollCollectorLoaded.annotation('li:never-seen')).toBeNull();
  });

  test('debugAnnotate (opt-in) writes the attributes and a badge without a re-dispatch, and removes both when turned off', async () => {
    chrome.send({ type: 'DECISION_RESULT', payload: { postKey: KEY, status: 'collected', tag: 'Food', pMatch: 0.91 } });
    chrome.send({ type: 'CONTENT_CONFIG_UPDATED', payload: { ...BASE_CONFIG, debugAnnotate: true } });

    const el = document.querySelector(`[data-sc-key="${KEY}"]`);
    expect(el.getAttribute('data-sc-status')).toBe('collected');
    expect(el.getAttribute('data-sc-tag')).toBe('Food');
    expect(el.getAttribute('data-sc-pmatch')).toBe('0.910');
    const badge = el.querySelector('[data-sc-badge]');
    expect(badge).not.toBeNull();
    expect(badge.textContent).toContain('collected');
    expect(badge.textContent).toContain('Food');
    expect(badge.getAttribute('onclick')).toBeNull();

    chrome.send({ type: 'DECISION_RESULT', payload: { postKey: KEY, status: 'rejected', reason: 'prompt_mismatch', pMatch: 0.12 } });
    expect(el.querySelectorAll('[data-sc-badge]')).toHaveLength(1);
    expect(el.querySelector('[data-sc-badge]').textContent).toContain('rejected');
    expect(el.getAttribute('data-sc-status')).toBe('rejected');
    // A later decision without a tag clears the stale tag
    expect(el.hasAttribute('data-sc-tag')).toBe(false);
    expect(el.getAttribute('data-sc-reason')).toBe('prompt_mismatch');

    await sleep(700);
    expect(chrome.extracted()).toHaveLength(1);

    chrome.send({ type: 'CONTENT_CONFIG_UPDATED', payload: { ...BASE_CONFIG, debugAnnotate: false } });
    expect(document.querySelector('[data-sc-badge]')).toBeNull();
    for (const attr of ['data-sc-status', 'data-sc-reason', 'data-sc-tag', 'data-sc-pmatch']) {
      expect(el.hasAttribute(attr)).toBe(false);
    }
    expect(globalThis.__scrollCollectorLoaded.annotation(KEY)).toMatchObject({ status: 'rejected' });
  });

  test('PING replies, unhandled messages return false', () => {
    const [ping] = chrome.send({ type: 'PING' });
    expect(ping).toEqual({ returned: false, reply: { alive: true } });

    const [unknown] = chrome.send({ type: 'STATE_UPDATED', payload: {} });
    expect(unknown).toEqual({ returned: false, reply: undefined });
    expect(chrome.send(null)[0].returned).toBe(false);
  });

  test('RESET_AND_RESCAN re-dispatches the page with the same postKeys', async () => {
    const [reset] = chrome.send({ type: 'RESET_AND_RESCAN' });
    expect(reset).toEqual({ returned: false, reply: { success: true } });
    await waitFor(() => chrome.extracted().length === 2);
    expect(chrome.extracted()[1].postKey).toBe(KEY);
    expect(chrome.extracted()[1].isUpdate).toBe(false);
  });

  test('a second injection is a no-op while the first instance is alive', async () => {
    run();
    await sleep(300);
    expect(chrome.listeners).toHaveLength(1);
    expect(chrome.getConfigCalls()).toBe(1);
    expect(chrome.extracted()).toHaveLength(1);
  });

  test('an orphaned instance (extension context invalidated) is replaced by a fresh injection', async () => {
    const orphan = globalThis.__scrollCollectorLoaded;
    chrome.fake.runtime.id = undefined; // what an invalidated context looks like
    run();
    expect(globalThis.__scrollCollectorLoaded).not.toBe(orphan);
    expect(orphan.isAlive()).toBe(false);
    expect(chrome.listeners).toHaveLength(1); // old listener removed, new one added
    await waitFor(() => chrome.getConfigCalls() === 2);
  });
});
