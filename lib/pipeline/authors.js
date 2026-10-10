/**
 * authors.js
 *
 * Author canonicalisation: groups "Jane Doe", "@janedoe" and "Jane Doe (she/her)" under one name.
 * Heuristics only (heuristicAuthorMatch) — the old per-known-author model loop made every post cost
 * one LLM call per distinct author already in the stack.
 */

import { heuristicAuthorMatch } from '../inference-engine.js';

/**
 * @typedef {{ name: string, platform: string, url: string }} AuthorRef
 */

/**
 * @param {{ match?: (a: AuthorRef, b: AuthorRef) => boolean, maxMemo?: number }} [options]
 */
export function createAuthorCanonicalizer({ match = heuristicAuthorMatch, maxMemo = 5000 } = {}) {
  /** @type {Map<string, string>} author fingerprint -> canonical name */
  const memo = new Map();

  /**
   * @param {AuthorRef} author
   * @param {object[]} stack  current (fresh) stack; synchronous, safe inside a commit
   * @returns {string} canonical name ('' when the author is unknown)
   */
  function canonicalize(author, stack) {
    const name = (author && author.name || '').trim();
    if (!name) return '';
    const key = `${name.toLowerCase()}\u0000${(author.platform || '').toLowerCase()}\u0000${(author.url || '').toLowerCase()}`;
    const hit = memo.get(key);
    if (hit) return hit;

    let canonical = name;
    const seen = new Set();
    for (const item of stack || []) {
      if (!item || !item.authorName) continue;
      const cName = item.canonicalAuthorName || item.authorName;
      if (seen.has(cName)) continue;
      seen.add(cName);
      if (match({ name, platform: author.platform || '', url: author.url || '' },
        { name: item.authorName, platform: item.sourcePlatform || '', url: item.authorUrl || '' })) {
        canonical = cName;
        break;
      }
    }

    if (memo.size >= maxMemo) memo.clear();
    memo.set(key, canonical);
    return canonical;
  }

  return { canonicalize, clear: () => memo.clear() };
}

/**
 * Fills missing canonicalAuthorName fields in place (oldest items first). Idempotent.
 *
 * @param {object[]} stack
 * @param {(a: AuthorRef, b: AuthorRef) => boolean} [match]
 * @returns {boolean} whether anything changed
 */
export function migrateCanonicalAuthors(stack, match = heuristicAuthorMatch) {
  let updated = false;
  const knownAuthors = [];

  for (let i = stack.length - 1; i >= 0; i--) {
    const item = stack[i];
    if (!item) continue;
    if (!item.authorName) {
      if (item.canonicalAuthorName !== '') {
        item.canonicalAuthorName = '';
        updated = true;
      }
      continue;
    }

    if (item.canonicalAuthorName) {
      if (!knownAuthors.some(ka => ka.canonicalName === item.canonicalAuthorName)) {
        knownAuthors.push({
          name: item.authorName,
          platform: item.sourcePlatform,
          url: item.authorUrl || '',
          canonicalName: item.canonicalAuthorName
        });
      }
      continue;
    }

    const foundMatch = knownAuthors.find(ka => match(
      { name: item.authorName, platform: item.sourcePlatform, url: item.authorUrl || '' },
      { name: ka.name, platform: ka.platform, url: ka.url || '' }
    ));

    updated = true;
    if (foundMatch) {
      item.canonicalAuthorName = foundMatch.canonicalName;
    } else {
      item.canonicalAuthorName = item.authorName;
      knownAuthors.push({
        name: item.authorName,
        platform: item.sourcePlatform,
        url: item.authorUrl || '',
        canonicalName: item.canonicalAuthorName
      });
    }
  }

  return updated;
}
