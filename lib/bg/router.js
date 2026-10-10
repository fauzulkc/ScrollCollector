/**
 * router.js
 *
 * Turns a { [messageType]: handler } table into a chrome.runtime.onMessage listener.
 *
 *  - Messages addressed to the offscreen document (target: 'offscreen') are not ours: return false
 *    without replying so the offscreen listener can answer.
 *  - Unknown types get { success: false, error: 'Unknown message type' }.
 *  - Content scripts may send only CONTENT_SCRIPT_MESSAGES; anything else from a sender that is not
 *    one of this extension's pages gets FORBIDDEN (no handler runs), so a web page cannot read the
 *    collected stack (GET_STATE) or change it.
 *  - Handlers are awaited (after the optional `ready` gate, e.g. startup/migrations); a throw replies
 *    { success: false, error }. A handler returning undefined replies { success: true }.
 */

import { TARGET, CONTENT_SCRIPT_MESSAGES } from '../messages.js';
import { FORBIDDEN, isExtensionPageSender, ownExtensionOrigin } from './sender.js';

const FROM_CONTENT = new Set(CONTENT_SCRIPT_MESSAGES);

/**
 * @typedef {(payload: any, sender: chrome.runtime.MessageSender, message: object) => any} Handler
 */

/**
 * @param {Record<string, Handler>} handlerMap
 * @param {{ ready?: (() => Promise<unknown>) | Promise<unknown>, extensionOrigin?: string }} [options]
 *        extensionOrigin: 'chrome-extension://<id>' (default: chrome.runtime.getURL(''))
 * @returns {(message: any, sender: chrome.runtime.MessageSender, sendResponse: (r: any) => void) => boolean}
 */
export function createRouter(handlerMap, { ready, extensionOrigin } = {}) {
  return function onMessage(message, sender, sendResponse) {
    if (message && message.target === TARGET.OFFSCREEN) return false;

    const type = message && message.type;
    const handler = typeof type === 'string' && Object.prototype.hasOwnProperty.call(handlerMap, type)
      ? handlerMap[type]
      : null;

    if (typeof handler !== 'function') {
      sendResponse({ success: false, error: 'Unknown message type' });
      return false;
    }

    if (!FROM_CONTENT.has(type) && !isExtensionPageSender(sender, extensionOrigin ?? ownExtensionOrigin())) {
      sendResponse(FORBIDDEN);
      return false;
    }

    (async () => {
      try {
        if (ready) await (typeof ready === 'function' ? ready() : ready);
        const result = await handler(message.payload ?? {}, sender, message);
        sendResponse(result === undefined ? { success: true } : result);
      } catch (err) {
        console.error(`[background] Error handling "${type}":`, err);
        sendResponse({ success: false, error: (err && err.message) || String(err) });
      }
    })();

    return true;
  };
}
