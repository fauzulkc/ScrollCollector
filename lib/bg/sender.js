/**
 * Who sent a runtime message.
 *
 * Content scripts run inside web pages, so a compromised page renderer can send any message through
 * them: they may only send the messages listed in CONTENT_SCRIPT_MESSAGES (lib/messages.js).
 * Everything else is for this extension's own pages (side panel, offscreen document, an extension
 * page opened in a tab).
 */

/** Reply for a message the sender may not send. */
export const FORBIDDEN = Object.freeze({ success: false, error: 'Not allowed from a web page', code: 'forbidden' });

/** 'chrome-extension://<id>' of this extension, or '' outside an extension (tests). */
export function ownExtensionOrigin() {
  try {
    const base = globalThis.chrome?.runtime?.getURL?.('');
    return typeof base === 'string' ? base.replace(/\/+$/, '') : '';
  } catch {
    return '';
  }
}

/**
 * True for messages from this extension's own pages (or internal calls without a sender); false for
 * content scripts. Extension pages are recognised by their URL/origin, because an extension page
 * opened in a tab has `sender.tab` too. Without a known origin, any sender with a tab is refused.
 *
 * @param {chrome.runtime.MessageSender|undefined} sender
 * @param {string} [extensionOrigin]  'chrome-extension://<id>'
 */
export function isExtensionPageSender(sender, extensionOrigin = ownExtensionOrigin()) {
  if (!sender) return true;
  if (extensionOrigin) {
    const url = typeof sender.url === 'string' ? sender.url : '';
    return url.startsWith(`${extensionOrigin}/`) || sender.origin === extensionOrigin;
  }
  return !sender.tab;
}
