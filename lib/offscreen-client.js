/**
 * Service-worker side of the offscreen document (offscreen/offscreen.html, the local System 1 host).
 *
 *  - ensureOffscreenDocument(): creates the document once (chrome.runtime.getContexts to find an
 *    existing one, a creation mutex so concurrent callers share one createDocument call, and
 *    "only a single offscreen document" treated as success).
 *  - sendToOffscreen(type, payload, { timeoutMs }): adds `target: 'offscreen'` and a request id,
 *    rejects with `code: 'timeout'` when no reply arrives in time, and when nobody answers
 *    ("Receiving end does not exist", or the port closed without a reply) re-creates the document and
 *    retries once.
 *
 * Errors carry `code`: 'timeout' | 'no_receiver' | 'offscreen_unavailable' | 'offscreen_error'.
 */
import { TARGET } from './messages.js';

export const OFFSCREEN_URL = 'offscreen/offscreen.html';
export const OFFSCREEN_REASONS = Object.freeze(['WORKERS']);
export const OFFSCREEN_JUSTIFICATION =
  'Runs the bundled local sentence-embedding model (WebAssembly workers) that decides which collected posts match the user prompt.';
export const DEFAULT_TIMEOUT_MS = 30000;

const NO_RECEIVER_RE = /Receiving end does not exist|Could not establish connection|message port closed before a response/i;
const ALREADY_EXISTS_RE = /single offscreen document|already exists|only a single/i;

/** @param {unknown} err */
function messageOf(err) {
  const raw = err && typeof err === 'object' && 'message' in err ? /** @type {any} */ (err).message : err;
  return String(raw ?? 'error').slice(0, 300);
}

/** @param {unknown} err */
export function isNoReceiverError(err) {
  return /** @type {any} */ (err)?.code === 'no_receiver' || NO_RECEIVER_RE.test(messageOf(err));
}

/**
 * @param {{
 *   chromeApi?: any,
 *   url?: string,
 *   reasons?: readonly string[],
 *   justification?: string,
 *   defaultTimeoutMs?: number,
 *   setTimer?: typeof setTimeout,
 *   clearTimer?: typeof clearTimeout
 * }} [opts]
 */
export function createOffscreenClient({
  chromeApi = globalThis.chrome,
  url = OFFSCREEN_URL,
  reasons = OFFSCREEN_REASONS,
  justification = OFFSCREEN_JUSTIFICATION,
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  /** @type {Promise<boolean>|null} */
  let creating = null;
  /** @type {Promise<void>|null} */
  let recreating = null;
  /** Bumped whenever this client creates the document. */
  let generation = 0;
  let seq = 0;
  const instance = Math.random().toString(36).slice(2, 8);
  const counters = { sent: 0, timeouts: 0, recreated: 0, created: 0, errors: 0 };

  function fullUrl() {
    return chromeApi.runtime.getURL(url);
  }

  /** @returns {Promise<boolean>} */
  async function hasOffscreenDocument() {
    if (typeof chromeApi?.runtime?.getContexts === 'function') {
      const contexts = await chromeApi.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [fullUrl()] });
      return Array.isArray(contexts) && contexts.length > 0;
    }
    if (typeof chromeApi?.offscreen?.hasDocument === 'function') return !!(await chromeApi.offscreen.hasDocument());
    return false;
  }

  /**
   * Creates the offscreen document unless it exists. Concurrent callers share one creation.
   * @returns {Promise<boolean>}  true when this call created it
   */
  function ensureOffscreenDocument() {
    if (creating) return creating;
    creating = (async () => {
      if (!chromeApi?.offscreen?.createDocument) {
        throw Object.assign(new Error('chrome.offscreen is not available in this context'), { code: 'offscreen_unavailable' });
      }
      if (await hasOffscreenDocument()) return false;
      try {
        await chromeApi.offscreen.createDocument({ url, reasons: [...reasons], justification });
      } catch (err) {
        if (ALREADY_EXISTS_RE.test(messageOf(err))) return false;
        throw Object.assign(new Error(`Could not create the offscreen document: ${messageOf(err)}`), { code: 'offscreen_unavailable' });
      }
      generation += 1;
      counters.created += 1;
      return true;
    })().finally(() => {
      creating = null;
    });
    return creating;
  }

  /** Closes the offscreen document if it exists (errors ignored). */
  async function closeOffscreenDocument() {
    try {
      if (await hasOffscreenDocument()) await chromeApi.offscreen.closeDocument();
    } catch {
      /* already gone */
    }
  }

  /**
   * Replaces a document that exists but does not answer, or creates a missing one. Only the first
   * caller that saw generation `seen` recreates; later ones just wait for it.
   * @param {number} seen
   */
  function recreate(seen) {
    if (recreating) return recreating;
    if (generation !== seen) return Promise.resolve();
    recreating = (async () => {
      if (creating) await creating.catch(() => {});
      if (generation !== seen) return;
      counters.recreated += 1;
      await closeOffscreenDocument();
      await ensureOffscreenDocument();
    })().finally(() => {
      recreating = null;
    });
    return recreating;
  }

  /**
   * @param {object} message
   * @param {number} timeoutMs
   * @returns {Promise<any>}
   */
  function attempt(message, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimer(() => {
        if (settled) return;
        settled = true;
        counters.timeouts += 1;
        reject(Object.assign(new Error(`The offscreen document did not answer ${/** @type {any} */ (message).type} within ${timeoutMs} ms`), { code: 'timeout' }));
      }, timeoutMs);
      Promise.resolve()
        .then(() => chromeApi.runtime.sendMessage(message))
        .then(
          (reply) => {
            if (settled) return;
            settled = true;
            clearTimer(timer);
            if (reply === undefined) reject(Object.assign(new Error('No reply from the offscreen document'), { code: 'no_receiver' }));
            else resolve(reply);
          },
          (err) => {
            if (settled) return;
            settled = true;
            clearTimer(timer);
            reject(Object.assign(new Error(messageOf(err)), { code: NO_RECEIVER_RE.test(messageOf(err)) ? 'no_receiver' : 'offscreen_error' }));
          }
        );
    });
  }

  /**
   * Sends a message to the offscreen document and resolves with its reply.
   * @param {string} type
   * @param {object} [payload]
   * @param {{ timeoutMs?: number }} [opts]
   * @returns {Promise<any>}
   */
  async function sendToOffscreen(type, payload = {}, { timeoutMs = defaultTimeoutMs } = {}) {
    await ensureOffscreenDocument();
    const seen = generation;
    const message = { type, target: TARGET.OFFSCREEN, requestId: `${instance}-${++seq}`, payload };
    counters.sent += 1;
    try {
      return await attempt(message, timeoutMs);
    } catch (err) {
      if (!isNoReceiverError(err)) {
        counters.errors += 1;
        throw err;
      }
      await recreate(seen);
      try {
        return await attempt(message, timeoutMs);
      } catch (again) {
        counters.errors += 1;
        throw again;
      }
    }
  }

  return {
    ensureOffscreenDocument,
    hasOffscreenDocument,
    closeOffscreenDocument,
    sendToOffscreen,
    stats: () => ({ ...counters, generation })
  };
}

/** @type {ReturnType<typeof createOffscreenClient>|null} */
let defaultClient = null;

/** The service worker's shared client (created on first use). */
export function getOffscreenClient() {
  if (!defaultClient) defaultClient = createOffscreenClient();
  return defaultClient;
}

/** @returns {Promise<boolean>} */
export function ensureOffscreenDocument() {
  return getOffscreenClient().ensureOffscreenDocument();
}

/**
 * @param {string} type
 * @param {object} [payload]
 * @param {{ timeoutMs?: number }} [opts]
 */
export function sendToOffscreen(type, payload, opts) {
  return getOffscreenClient().sendToOffscreen(type, payload, opts);
}
