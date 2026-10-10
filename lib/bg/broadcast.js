/**
 * broadcast.js
 *
 * Messages leaving the service worker:
 *  - STATE_UPDATED   coalesced (100 ms), whitelisted state + inFlightCount — never secrets
 *  - INFLIGHT_UPDATED cheap processing counter, no storage read
 *  - tab messages     (DECISION_RESULT, RESET_AND_RESCAN, CONTENT_CONFIG_UPDATED)
 *
 * "No receiver" errors (side panel closed, tab without a content script) are expected and swallowed.
 */

import { MSG, BROADCAST_STATE_KEYS } from '../messages.js';

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isNoReceiverError(err) {
  const msg = String((err && /** @type {any} */ (err).message) || err || '');
  return /Receiving end does not exist|Could not establish connection|message port closed|No tab with id/i.test(msg);
}

/**
 * Whitelisted view of persisted state. Anything not in BROADCAST_STATE_KEYS (e.g. 'secrets') is dropped.
 *
 * @param {object} state
 * @param {number} inFlightCount
 */
export function pickBroadcastState(state, inFlightCount = 0) {
  const out = {};
  for (const key of BROADCAST_STATE_KEYS) out[key] = state ? state[key] : undefined;
  out.inFlightCount = inFlightCount;
  return out;
}

/**
 * @param {object} [options]
 * @param {chrome.storage.StorageArea} [options.area]
 * @param {typeof chrome.runtime} [options.runtime]
 * @param {typeof chrome.tabs} [options.tabs]
 * @param {number} [options.delayMs]
 * @param {(fn: () => void, ms: number) => any} [options.setTimer]
 */
export function createBroadcaster({
  area = globalThis.chrome?.storage?.local,
  runtime = globalThis.chrome?.runtime,
  tabs = globalThis.chrome?.tabs,
  delayMs = 100,
  setTimer = (fn, ms) => setTimeout(fn, ms)
} = {}) {
  /** @type {Map<string, number>} in-flight counts per source (ingest, relabel, ...) */
  const inflight = new Map();
  let timer = null;
  /** @type {Promise<void>|null} */
  let pending = null;

  function getInflightCount() {
    let total = 0;
    for (const n of inflight.values()) total += n;
    return total;
  }

  /** @param {object} message */
  async function sendRuntime(message) {
    try {
      await runtime.sendMessage(message);
    } catch (err) {
      if (!isNoReceiverError(err)) console.warn('[background] runtime message failed:', err);
    }
  }

  /** Sends STATE_UPDATED now, reading the latest persisted state. */
  async function flush() {
    const state = await area.get([...BROADCAST_STATE_KEYS]);
    await sendRuntime({ type: MSG.STATE_UPDATED, payload: pickBroadcastState(state, getInflightCount()) });
  }

  /**
   * Coalesces state broadcasts: the first call arms a timer, later calls join it, and the state is
   * read when the timer fires — so a burst of commits produces one up-to-date STATE_UPDATED.
   *
   * @returns {Promise<void>} resolves once the broadcast went out
   */
  function scheduleBroadcast() {
    if (pending) return pending;
    let resolve;
    const current = new Promise((r) => { resolve = r; });
    pending = current;
    timer = setTimer(async () => {
      timer = null;
      // Calls arriving from here on arm a new broadcast; this one may already read stale state.
      if (pending === current) pending = null;
      try {
        await flush();
      } catch (err) {
        console.warn('[background] state broadcast failed:', err);
      }
      resolve();
    }, delayMs);
    return current;
  }

  /**
   * Updates one source's in-flight count and pushes the total (cheap; no storage read).
   *
   * @param {number} count
   * @param {string} [source]
   */
  function sendInflight(count, source = 'ingest') {
    inflight.set(source, Math.max(0, Number(count) || 0));
    return sendRuntime({ type: MSG.INFLIGHT_UPDATED, payload: { count: getInflightCount() } });
  }

  /**
   * @param {number} tabId
   * @param {object} message
   */
  async function sendToTab(tabId, message) {
    if (tabId == null || !tabs?.sendMessage) return;
    try {
      await tabs.sendMessage(tabId, message);
    } catch (err) {
      if (!isNoReceiverError(err)) console.warn(`[background] tab ${tabId} message failed:`, err);
    }
  }

  /** @param {object} message */
  async function broadcastToAllTabs(message) {
    try {
      const all = await tabs.query({});
      await Promise.all(all
        .filter(tab => tab.id != null && tab.url && (tab.url.startsWith('http://') || tab.url.startsWith('https://')))
        .map(tab => sendToTab(tab.id, message)));
    } catch (err) {
      console.warn('[background] Error broadcasting to tabs:', err);
    }
  }

  return {
    scheduleBroadcast,
    flush,
    sendInflight,
    getInflightCount,
    sendRuntime,
    sendToTab,
    broadcastToAllTabs,
    /** true while a coalesced broadcast is armed */
    get isScheduled() {
      return timer !== null;
    }
  };
}
