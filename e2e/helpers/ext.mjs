/**
 * Shared E2E helpers on top of launch.mjs: seeding the service worker's storage, serving fixtures on
 * real hostnames, the mock decision server, the side panel opened as a tab, and polling the stack /
 * the decisions content.js received per post. Those live in the content script's isolated world
 * (window.__scrollCollectorLoaded.annotation(postKey)), never in page-visible attributes, so they are
 * read through the DevTools protocol in that world (inContentScript), not with page.evaluate (which
 * runs in the page's main world, like the page's own scripts).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchWithExtension, collectConsole, ROOT, EXT_DIR } from './launch.mjs';
import { startMockDecisionServer } from '../mock-decision-server.mjs';

export { launchWithExtension, collectConsole, ROOT, EXT_DIR, startMockDecisionServer };

export const RESTAURANT_PROMPT = 'find me restaurant and 5 star quality food posts. I am fascinated by michelin star cooking';
export const CODING_PROMPT = 'AI tools that help with coding';
/** A test key: the string must never appear in anything that leaves the service worker. */
export const TEST_JEV_KEY = 'jev-e2e-SECRET-0123456789';
export const TEST_OPENAI_KEY = 'sk-e2e-SECRET-abcdefghijklmnopqrstuvwxyz';

/**
 * Polls `fn` in the service worker until it returns a truthy value.
 * @template T
 * @param {import('@playwright/test').Worker} sw
 * @param {(arg: any) => T|Promise<T>} fn
 * @param {any} [arg]
 * @param {number} [timeout]
 * @returns {Promise<T>}
 */
export async function swPoll(sw, fn, arg, timeout = 60000) {
  const start = Date.now();
  let last;
  for (;;) {
    last = await sw.evaluate(fn, arg);
    if (last) return last;
    if (Date.now() - start > timeout) throw new Error(`swPoll timed out after ${timeout} ms`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Waits for startup (schema migration done). @param {import('@playwright/test').Worker} sw */
export async function waitForStartup(sw) {
  await swPoll(sw, async () => (await chrome.storage.local.get('schemaVersion')).schemaVersion === 2);
}

/**
 * Seeds storage through the service worker (after startup): `configuration` is shallow-merged into
 * the stored configuration; `intelligence` replaces configuration.intelligence; `secrets`, `stack` and
 * any `extra` top-level keys are written as given.
 * @param {import('@playwright/test').Worker} sw
 * @param {{ configuration?: object, intelligence?: object, secrets?: object, stack?: object[], extra?: object }} seed
 */
export async function seed(sw, { configuration = {}, intelligence, secrets, stack, extra } = {}) {
  await waitForStartup(sw);
  await sw.evaluate(async ({ configuration, intelligence, secrets, stack, extra }) => {
    const { configuration: current } = await chrome.storage.local.get('configuration');
    const next = { ...current, ...configuration };
    if (intelligence !== undefined) next.intelligence = intelligence;
    const write = { configuration: next, ...(extra || {}) };
    if (secrets !== undefined) write.secrets = secrets;
    if (stack !== undefined) write.stack = stack;
    await chrome.storage.local.set(write);
  }, { configuration, intelligence, secrets, stack, extra });
}

/** @param {import('@playwright/test').Worker} sw @returns {Promise<any[]>} */
export function readStack(sw) {
  return sw.evaluate(async () => (await chrome.storage.local.get('stack')).stack || []);
}

/** @param {import('@playwright/test').Worker} sw */
export function readConfig(sw) {
  return sw.evaluate(async () => (await chrome.storage.local.get('configuration')).configuration || {});
}

/**
 * Polls the stored stack until `predicate(stack)` is truthy (evaluated in Node).
 * @param {import('@playwright/test').Worker} sw
 * @param {(stack: any[]) => any} predicate
 * @param {number} [timeout]
 */
export async function waitForStack(sw, predicate, timeout = 120000) {
  const start = Date.now();
  let stack = [];
  for (;;) {
    stack = await readStack(sw);
    if (predicate(stack)) return stack;
    if (Date.now() - start > timeout) {
      throw new Error(`waitForStack timed out after ${timeout} ms; stack: ${JSON.stringify(stack.map((i) => ({ k: i.postKey, tag: i.assignedTag, hidden: i.hiddenByPrompt, p: i.decision?.pMatch })))}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

/**
 * Serves fixtures on their real hostnames and aborts every other external request (the mock
 * decision server on 127.0.0.1 / localhost is allowed).
 * @param {import('@playwright/test').BrowserContext} context
 * @param {Record<string, string | (() => string)>} pages  absolute URL (no query) -> HTML
 */
export async function servePages(context, pages) {
  const table = new Map(Object.entries(pages).map(([url, html]) => [url.replace(/\/+$/, ''), html]));
  const hosts = new Set([...table.keys()].map((u) => new URL(u).hostname));
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return route.continue();
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return route.continue();
    if (!hosts.has(url.hostname)) return route.abort('blockedbyclient');
    const html = table.get(`${url.origin}${url.pathname}`.replace(/\/+$/, ''));
    if (html === undefined) return route.fulfill({ status: 404, contentType: 'text/plain', body: '' });
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: typeof html === 'function' ? html() : html });
  });
}

/**
 * Opens the side panel as a tab and waits until it mounted.
 * @param {{ context: import('@playwright/test').BrowserContext, extensionId: string }} ext
 * @param {{ initScripts?: (Function|[Function, any])[], tab?: 'stream'|'export'|'settings' }} [opts]
 *   initScripts: functions (or [function, argument] pairs) run before the panel's own scripts
 */
export async function openPanel(ext, { initScripts = [], tab } = {}) {
  const page = await ext.context.newPage();
  for (const s of initScripts) {
    if (Array.isArray(s)) await page.addInitScript(s[0], s[1]);
    else await page.addInitScript(s);
  }
  const logs = collectConsole(page);
  await page.goto(`chrome-extension://${ext.extensionId}/sidepanel.html`);
  await page.waitForSelector('#intelligence-root .intel', { state: 'attached', timeout: 30000 });
  if (tab) await page.locator(`.tab-btn[data-tab="${tab}"]`).click();
  return { page, logs };
}

/**
 * Sends a runtime message from an extension page (the side panel tab) and returns the reply.
 * @param {import('@playwright/test').Page} page
 * @param {string} type
 * @param {object} [payload]
 */
export function sendFromPage(page, type, payload) {
  return page.evaluate(({ type, payload }) => chrome.runtime.sendMessage(payload === undefined ? { type } : { type, payload }), { type, payload });
}

/** Records runtime messages of the given types in the page (window.__msgs). */
export async function recordMessages(page, types) {
  await page.evaluate((list) => {
    window.__msgs = [];
    chrome.runtime.onMessage.addListener((m) => {
      if (m && list.includes(m.type)) window.__msgs.push(JSON.parse(JSON.stringify(m)));
    });
  }, types);
}

/** @param {import('@playwright/test').Page} page */
export function recordedMessages(page) {
  return page.evaluate(() => window.__msgs || []);
}

/** page -> { cdp, contexts } (execution contexts reported by the DevTools protocol) */
const contentWorlds = new WeakMap();

/** @param {import('@playwright/test').Page} page */
async function contentWorld(page) {
  let world = contentWorlds.get(page);
  if (world) return world;
  const cdp = await page.context().newCDPSession(page);
  /** @type {Map<number, any>} */
  const contexts = new Map();
  cdp.on('Runtime.executionContextCreated', ({ context }) => contexts.set(context.id, context));
  cdp.on('Runtime.executionContextDestroyed', ({ executionContextId }) => contexts.delete(executionContextId));
  cdp.on('Runtime.executionContextsCleared', () => contexts.clear());
  await cdp.send('Runtime.enable'); // reports the existing contexts too
  world = { cdp, contexts };
  contentWorlds.set(page, world);
  return world;
}

const MISSING = '__sc_content_script_missing__';

/**
 * Runs `fn(arg)` in the isolated world of this extension's content script on `page` (where
 * window.__scrollCollectorLoaded lives) and returns its JSON result, or undefined while no content
 * script is there.
 * @template T
 * @param {import('@playwright/test').Page} page
 * @param {(arg: any) => T} fn
 * @param {any} [arg]
 * @returns {Promise<T|undefined>}
 */
export async function inContentScript(page, fn, arg) {
  const { cdp, contexts } = await contentWorld(page);
  const expression = `(() => {
    const sc = window.__scrollCollectorLoaded;
    if (!sc || typeof sc.annotation !== 'function') return ${JSON.stringify(MISSING)};
    return (${fn.toString()})(${JSON.stringify(arg === undefined ? null : arg)});
  })()`;
  // Newest first: after an extension reload the fresh content script is the one that answers.
  for (const ctx of [...contexts.values()].reverse()) {
    if (!ctx.auxData || ctx.auxData.isDefault || ctx.auxData.type !== 'isolated') continue;
    try {
      const res = await cdp.send('Runtime.evaluate', { expression, contextId: ctx.id, returnByValue: true, awaitPromise: true });
      if (res.exceptionDetails) continue;
      const value = res.result ? res.result.value : undefined;
      if (value !== MISSING) return value;
    } catch {
      // the context went away meanwhile
    }
  }
  return undefined;
}

/**
 * Status / reason / tag / pMatch content.js received (DECISION_RESULT) for each post key on a page.
 * @param {import('@playwright/test').Page} page
 * @param {string[]} keys
 * @returns {Promise<{ status: string|null, reason: string|null, tag: string|null, pMatch: number|null }[]>}
 */
export async function annotationDetails(page, keys) {
  const out = await inContentScript(page, (ks) => ks.map((k) => {
    const a = window.__scrollCollectorLoaded.annotation(k);
    return { status: a ? a.status : null, reason: a ? a.reason : null, tag: a ? a.tag : null, pMatch: a ? a.pMatch : null };
  }), keys);
  return out || keys.map(() => ({ status: null, reason: null, tag: null, pMatch: null }));
}

/**
 * Status and reason content.js received for each post key on a page.
 * @param {import('@playwright/test').Page} page
 * @param {string[]} keys
 * @returns {Promise<{ status: string|null, reason: string|null }[]>}
 */
export async function annotations(page, keys) {
  return (await annotationDetails(page, keys)).map(({ status, reason }) => ({ status, reason }));
}

/**
 * Waits until every key has one of `statuses` on the page.
 * @param {import('@playwright/test').Page} page
 * @param {string[]} keys
 * @param {{ statuses?: string[], timeout?: number }} [opts]
 */
export async function waitDecided(page, keys, { statuses = ['collected', 'rejected', 'ignored'], timeout = 240000 } = {}) {
  await waitAnnotations(page, keys, (list) => list.every((a) => statuses.includes(a.status)), { timeout });
}

/**
 * Polls annotations(page, keys) until `predicate(list)` holds.
 * @param {import('@playwright/test').Page} page
 * @param {string[]} keys
 * @param {(list: { status: string|null, reason: string|null }[]) => boolean} predicate
 * @param {{ timeout?: number }} [opts]
 */
export async function waitAnnotations(page, keys, predicate, { timeout = 240000 } = {}) {
  const start = Date.now();
  let last = [];
  for (;;) {
    last = await annotations(page, keys);
    if (predicate(last)) return last;
    if (Date.now() - start > timeout) throw new Error(`waitAnnotations timed out after ${timeout} ms: ${JSON.stringify(last)}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Decision data visible to the page's own scripts (main world): every data-sc-* attribute except
 * the structural data-sc-key, and the debug badge. Must be empty unless debugAnnotate is on.
 * @param {import('@playwright/test').Page} page
 */
export function pageVisibleDecisions(page) {
  return page.evaluate(() => [...document.querySelectorAll('[data-sc-status], [data-sc-reason], [data-sc-tag], [data-sc-pmatch], [data-sc-badge]')]
    .map((el) => el.outerHTML.slice(0, 200)));
}

/**
 * Waits until the service worker reports System 1 ready (GET_ENGINE_STATUS from an extension page).
 * @param {import('@playwright/test').Page} panel
 */
export async function waitForSystem1(panel, timeout = 180000) {
  await panel.waitForFunction(async () => {
    const s = await chrome.runtime.sendMessage({ type: 'GET_ENGINE_STATUS' });
    return s && s.system1 && s.system1.state === 'ready';
  }, null, { timeout, polling: 500 });
}

/** Console errors that indicate a CSP violation or an uncaught exception. */
export function pageErrors(logs) {
  return logs.filter((l) => l.type === 'pageerror' || /Content Security Policy|Refused to|Uncaught/i.test(l.text));
}

/**
 * A copy of dist/ext (for tests that need a broken build, e.g. a corrupt model file).
 * @param {(dir: string) => void} mutate
 * @returns {{ dir: string, remove: () => void }}
 */
export function extensionCopy(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-ext-'));
  fs.cpSync(EXT_DIR, dir, { recursive: true });
  mutate(dir);
  return { dir, remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Closes the browser keeping its profile and launches it again on the same profile (a browser
 * restart: the service worker starts fresh and runs its startup migration).
 * @param {Awaited<ReturnType<typeof launchWithExtension>>} ext
 * @param {{ extDir?: string }} [opts]
 */
export async function relaunch(ext, opts = {}) {
  await ext.close({ keepProfile: true });
  return launchWithExtension({ ...opts, userDataDir: ext.userDataDir });
}

/** Init script: records every value the header badge's data-level takes (window.__badgeLevels). */
export function recordBadgeLevels() {
  window.__badgeLevels = [];
  const record = () => {
    const badge = document.getElementById('engine-badge');
    if (!badge) return;
    const level = badge.getAttribute('data-level');
    if (window.__badgeLevels[window.__badgeLevels.length - 1] !== level) window.__badgeLevels.push(level);
  };
  new MutationObserver(record).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-level'] });
}

/**
 * A fake built-in LanguageModel (Prompt API) installed as globalThis.LanguageModel, for the service
 * worker (`sw.evaluate(installFakeLanguageModel, opts)`) and the side panel
 * (`page.addInitScript(installFakeLanguageModel, opts)`). Self-contained: it is serialized.
 *
 *  - availability() returns globalThis.__fakeLM.availability (settable from the test);
 *  - create() while 'downloadable' starts a download the test drives through
 *    __fakeLM.download.progress(loaded) / finish() / fail(message);
 *  - prompt(text, { responseConstraint }) fills the schema: P(yes) 0.93 for food posts (else 0.07),
 *    a food-like option for choices; calls are recorded in __fakeLM.calls.
 *
 * @param {{ availability?: string }} [opts]
 */
export function installFakeLanguageModel(opts = {}) {
  const FOOD = /\b(?:food|restaurants?|michelin|chefs?|cook(?:s|ed|ing)?|cuisine|culinary|dish(?:es)?|menu|tasting|dining|dinner|bistro|kitchen|recipes?)\b/i;
  const state = { availability: (opts && opts.availability) || 'downloadable', calls: [], creates: 0, download: null };
  const fill = (schema, post) => {
    if (!schema || typeof schema !== 'object') return null;
    if (schema.type === 'object' || schema.properties) {
      const props = schema.properties || {};
      if (props.probability) return { probability: FOOD.test(post) ? 0.93 : 0.07 };
      if (props.choice) {
        const options = Array.isArray(props.choice.enum) ? props.choice.enum : ['none'];
        const pick = (FOOD.test(post) && options.find((o) => /food|restaurant|dining|culinary/i.test(o))) || (options.includes('none') ? 'none' : options[0]);
        return { choice: pick, confidence: 0.6 };
      }
      const out = {};
      for (const [k, v] of Object.entries(props)) out[k] = fill(v, post);
      return out;
    }
    if (schema.type === 'array') return [];
    if (schema.type === 'string') return Array.isArray(schema.enum) ? schema.enum[0] : 'fake';
    if (schema.type === 'number' || schema.type === 'integer') return 0.5;
    if (schema.type === 'boolean') return false;
    return null;
  };
  const session = () => ({
    inputQuota: 6000,
    inputUsage: 0,
    async prompt(input, options = {}) {
      const text = typeof input === 'string' ? input : JSON.stringify(input);
      const m = /<post>\n?([\s\S]*?)\n?<\/post>/i.exec(text);
      const post = m ? m[1] : text;
      const schema = options && options.responseConstraint;
      state.calls.push({ post: post.slice(0, 300), keys: Object.keys((schema && schema.properties) || {}) });
      return schema ? JSON.stringify(fill(schema, post)) : 'fake answer';
    },
    async clone() {
      return session();
    },
    destroy() {}
  });
  globalThis.__fakeLM = state;
  globalThis.LanguageModel = {
    async availability() {
      return state.availability;
    },
    async params() {
      return { defaultTopK: 3, maxTopK: 8, defaultTemperature: 1, maxTemperature: 2 };
    },
    create(options = {}) {
      state.creates += 1;
      if (state.availability === 'available') return Promise.resolve(session());
      if (state.availability !== 'downloadable' && state.availability !== 'downloading') {
        return Promise.reject(Object.assign(new Error('The model is not available.'), { name: 'NotSupportedError' }));
      }
      const target = new EventTarget();
      if (typeof options.monitor === 'function') options.monitor(target);
      state.availability = 'downloading';
      return new Promise((resolve, reject) => {
        state.download = {
          progress(loaded) {
            target.dispatchEvent(Object.assign(new Event('downloadprogress'), { loaded, total: 1 }));
          },
          finish() {
            state.availability = 'available';
            resolve(session());
          },
          fail(message) {
            state.availability = 'downloadable';
            reject(new Error(message));
          }
        };
      });
    }
  };
}

/** Minimal RFC 4180 CSV parser (quoted fields with commas, quotes and line breaks). @param {string} text */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
