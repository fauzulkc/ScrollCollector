/**
 * Offscreen document: home of the local System 1 embedding host (offscreen/system1-host.js).
 *
 * It never hosts a generative model: the only on-device LLM is the browser's built-in
 * LanguageModel (Gemini Nano in Chrome), which runs in the service worker.
 *
 * Routing (lib/messages.js): only messages with `target: 'offscreen'` from this extension's own
 * contexts (service worker, extension pages) are answered here; everything else belongs to the
 * service worker or the side panel and is ignored (return false). Replies are
 * `{ ok, ...data, requestId }` or `{ ok: false, error, code, requestId }`; async handlers keep the
 * channel open (return true). OFFSCREEN_PING is answered synchronously and never waits for a model
 * load.
 *
 *   OFFSCREEN_PING  -> { ok, caps: { crossOriginIsolated, webgpu, threads, hardwareConcurrency }, s1, cspViolations, consoleWarnings }
 *   S1_LOAD         { model, device, dtype }          -> { ok, model, device, loadMs, calibrationId, floor }
 *   S1_DECIDE       { model, items, spec, secondary? } -> { ok, model, results: [{ id, answers, ms }], ms }
 *   S1_EMBED        { texts, isQuery, model, cache }  -> { ok, model, vectors, ms }
 *   S1_CLEAR_CACHE  -> { ok }
 *   S1_UNLOAD       { model? }  -> { ok }  (a secondary model only when `model` names one)
 * Pushes: S1_STATUS { status, model, progress?, detail?, device?, loadMs?, error? } (target 'background').
 */
import { MSG, TARGET } from '../lib/messages.js';
import { isExtensionPageSender, ownExtensionOrigin } from '../lib/bg/sender.js';
import { createSystem1Host } from './system1-host.js';

/** @param {unknown} err */
const failure = (err) => ({ ok: false, code: 'error', error: String(/** @type {any} */ (err)?.message || err).slice(0, 300) });

/**
 * @param {ReturnType<typeof createSystem1Host>} host
 * @param {{ extensionOrigin?: string, pingExtras?: () => object }} [opts]
 *        pingExtras: merged into OFFSCREEN_PING replies (e.g. CSP violations seen by the document)
 * @returns {(message: any, sender: chrome.runtime.MessageSender, sendResponse: (r: any) => void) => boolean}
 */
export function createOffscreenRouter(host, { extensionOrigin, pingExtras } = {}) {
  /** @type {Record<string, (payload: any) => any>} */
  const handlers = {
    [MSG.OFFSCREEN_PING]: () => ({ ...host.ping(), ...(typeof pingExtras === 'function' ? pingExtras() : {}) }),
    [MSG.S1_LOAD]: (p) => host.load(p),
    [MSG.S1_DECIDE]: (p) => host.decide(p),
    [MSG.S1_EMBED]: (p) => host.embed(p),
    [MSG.S1_CLEAR_CACHE]: () => host.clearCache(),
    [MSG.S1_UNLOAD]: (p) => host.unload(p)
  };

  return function onMessage(message, sender, sendResponse) {
    if (!message || message.target !== TARGET.OFFSCREEN) return false;
    const requestId = typeof message.requestId === 'string' ? message.requestId : undefined;
    // Content scripts run inside web pages: they never talk to the model host.
    if (!isExtensionPageSender(sender, extensionOrigin ?? ownExtensionOrigin())) {
      sendResponse({ ok: false, code: 'forbidden', error: 'Not allowed from a web page', requestId });
      return false;
    }
    const handler = Object.prototype.hasOwnProperty.call(handlers, message.type) ? handlers[message.type] : null;
    if (!handler) {
      sendResponse({ ok: false, code: 'unsupported', error: `Unsupported offscreen message: ${String(message.type).slice(0, 40)}`, requestId });
      return false;
    }
    let result;
    try {
      result = handler(message.payload ?? {});
    } catch (err) {
      sendResponse({ ...failure(err), requestId });
      return false;
    }
    if (!result || typeof result.then !== 'function') {
      sendResponse({ ...result, requestId });
      return false;
    }
    result.then(
      (reply) => sendResponse({ ...reply, requestId }),
      (err) => sendResponse({ ...failure(err), requestId })
    );
    return true;
  };
}

if (globalThis.chrome?.runtime?.onMessage) {
  /** CSP violations seen by this document, reported by OFFSCREEN_PING (diagnostics, E2E). */
  const cspViolations = [];
  globalThis.document?.addEventListener?.('securitypolicyviolation', (e) => {
    if (cspViolations.length < 20) cspViolations.push({ directive: e.violatedDirective, blocked: String(e.blockedURI || '').slice(0, 120) });
  });
  /** The first console warnings / errors of this document (Transformers.js, ONNX Runtime), reported by OFFSCREEN_PING. */
  const consoleWarnings = [];
  for (const level of /** @type {const} */ (['warn', 'error'])) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      if (consoleWarnings.length < 20) {
        consoleWarnings.push({ level, text: args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ').slice(0, 200) });
      }
      original(...args);
    };
  }
  chrome.runtime.onMessage.addListener(createOffscreenRouter(createSystem1Host(), { pingExtras: () => ({ cspViolations: [...cspViolations], consoleWarnings: [...consoleWarnings] }) }));
}
