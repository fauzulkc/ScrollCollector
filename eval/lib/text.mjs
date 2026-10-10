/**
 * Text preparation for the System 1 eval.
 *
 * normalizeForEval mirrors the plan's normalizeForDecision (lib/decision/state.js): NFKC (undoes
 * LinkedIn math-bold letters), strips zero-width characters, URLs, emoji and a leading "Post by"
 * header, collapses whitespace and truncates at 1,500 characters. run-eval.mjs prefers the real
 * state.js export when it exists, so the calibration sees exactly what the extension will embed.
 *
 * cleanPrompt is a tiny deterministic stand-in for lib/decision/questions.js cleanPrompt: it removes
 * request scaffolding ("find me …", "… posts", "I am fascinated by") and keeps the topic.
 * run-eval.mjs prefers the questions.js export, so the calibrated query text is the one System 1 embeds.
 */

export const MAX_DECISION_CHARS = 1500;

/**
 * @param {string} text
 * @param {number} [maxChars]
 */
export function normalizeForEval(text, maxChars = MAX_DECISION_CHARS) {
  let t = String(text || '').normalize('NFKC');
  t = t.replace(/[​-‍⁠﻿]/g, '');
  t = t.replace(/^\s*Post by [^\n]*\n/i, '');
  t = t.replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ');
  t = t.replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}️⃣]/gu, ' ');
  t = t.replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (t.length > maxChars) {
    const cut = t.slice(0, maxChars);
    const sp = cut.lastIndexOf(' ');
    t = (sp > maxChars * 0.8 ? cut.slice(0, sp) : cut).trim();
  }
  return t;
}

/**
 * @param {string} raw
 * @returns {string}
 */
export function cleanPrompt(raw) {
  let t = ` ${String(raw || '').normalize('NFKC').trim()} `;
  t = t.replace(/\b(?:please\s+)?(?:find|show|give|get|collect|send)\s+me\s+(?:all\s+|any\s+|some\s+)?/gi, ' ');
  t = t.replace(/\b(?:i\s+am|i'm|im)\s+(?:really\s+|very\s+)?(?:fascinated|interested|obsessed|curious|passionate)\s+(?:by|in|with|about)\s+/gi, ' ');
  t = t.replace(/\bi\s+(?:really\s+)?(?:love|like|want|need|enjoy)\s+(?:to\s+(?:see|read)\s+)?/gi, ' ');
  t = t.replace(/\s(?:posts?|content|items?)(?=\s*(?:[.,;!?]|$))/gi, ' ');
  t = t.replace(/\s+([.,;!?])/g, '$1').replace(/\s+/g, ' ').trim();
  return t.replace(/^[.,;!?\s]+|[,;\s]+$/g, '').trim();
}
