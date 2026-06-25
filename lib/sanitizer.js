/**
 * Mindstream PII Sanitizer
 * ─────────────────────────
 * Scrubs personally identifiable information from extracted text.
 * Supports: emails, US/international phone numbers, and Luhn-validated
 * credit card numbers.
 *
 * Usage (content script):  window.MindstreamSanitizer.sanitize(text)
 * Usage (ES module):       import { sanitize } from './lib/sanitizer.js'
 */

(function (root) {
  'use strict';

  // ── Patterns ──────────────────────────────────────────────────────────

  /** Standard email addresses */
  const EMAIL_RE = /\b[\w.-]+@[\w.-]+\.\w{2,}\b/g;

  /**
   * Phone numbers – US & international formats:
   *   +1 (xxx) xxx-xxxx | +1-xxx-xxx-xxxx | +1xxxxxxxxxx
   *   (xxx) xxx-xxxx    | xxx-xxx-xxxx     | xxx.xxx.xxxx
   *   +xx xxx xxxx xxxx (international with country code 1-3 digits)
   */
  const PHONE_RE =
    /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b|\+\d{1,3}\s\d{3}\s\d{4}\s\d{4}/g;

  /**
   * Potential credit card numbers: 13-19 digits with optional spaces or
   * dashes between groups.  We validate with Luhn before redacting.
   */
  const CC_CANDIDATE_RE = /\b(?:\d[ -]*?){13,19}\b/g;

  // ── Luhn algorithm ────────────────────────────────────────────────────

  /**
   * Validates a numeric string using the Luhn (mod-10) algorithm.
   * @param {string} digits – digits-only string (spaces/dashes stripped)
   * @returns {boolean} true if the checksum passes
   */
  function passesLuhn(digits) {
    let sum = 0;
    let alternate = false;

    // Walk from rightmost digit to the left
    for (let i = digits.length - 1; i >= 0; i--) {
      let n = parseInt(digits[i], 10);

      if (alternate) {
        n *= 2;
        if (n > 9) n -= 9;
      }

      sum += n;
      alternate = !alternate;
    }

    return sum % 10 === 0;
  }

  // ── Core sanitize function ────────────────────────────────────────────

  /**
   * Scrub PII from a text string.
   *
   * Processing order matters: credit cards are checked first so that a
   * long digit sequence isn't partially consumed by a phone-number match.
   *
   * @param {string} text – raw text to sanitize
   * @returns {string} text with PII tokens replaced
   */
  function sanitize(text) {
    if (typeof text !== 'string') return text;

    let scrubbed = text;

    // 1. Credit cards (Luhn-validated) — check before phones to avoid
    //    partial digit overlap.
    scrubbed = scrubbed.replace(CC_CANDIDATE_RE, function (match) {
      const digits = match.replace(/[\s-]/g, '');
      if (digits.length >= 13 && digits.length <= 19 && passesLuhn(digits)) {
        return '[REDACTED_CC]';
      }
      return match; // not a valid card — leave as-is
    });

    // 2. Phone numbers
    scrubbed = scrubbed.replace(PHONE_RE, '[REDACTED_PHONE]');

    // 3. Email addresses
    scrubbed = scrubbed.replace(EMAIL_RE, '[REDACTED_EMAIL]');

    return scrubbed;
  }

  // ── Export surface ────────────────────────────────────────────────────

  // Attach to window for content-script (IIFE) usage
  if (typeof root !== 'undefined' && root !== null) {
    root.MindstreamSanitizer = { sanitize };
  }

  // Support CommonJS / Node environments (e.g. unit tests)
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { sanitize };
  }

})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this);
