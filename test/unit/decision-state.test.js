import { describe, test, expect } from 'vitest';
import {
  normalizeForDecision,
  textHash,
  specHash,
  stableStringify,
  buildDecisionState,
  DECISION_MAX_CHARS
} from '../../lib/decision/state.js';

/** Reference FNV-1a 64 with BigInt, to check the limb implementation. */
function fnv1a64BigInt(str) {
  let h = 0xcbf29ce484222325n;
  for (const b of new TextEncoder().encode(str)) {
    h ^= BigInt(b);
    h = BigInt.asUintN(64, h * 0x100000001b3n);
  }
  return h.toString(16).padStart(16, '0');
}

describe('normalizeForDecision', () => {
  test('folds math-bold text (NFKC) and strips zero-width characters', () => {
    expect(normalizeForDecision('𝗚𝗲𝘁 𝗬𝗼𝘂𝗿𝘀 𝗡𝗼𝘄')).toBe('Get Yours Now');
    expect(normalizeForDecision('mi​che‍lin﻿ star')).toBe('michelin star');
  });

  test('drops a leading "Post by" / "Tweet by" / "Comment by" header line only', () => {
    expect(normalizeForDecision('Post by: Jane Doe (Chef at Noma)\n\nOur tasting menu is back.')).toBe('Our tasting menu is back.');
    expect(normalizeForDecision('Tweet by: @dev\n\nShipping v2 today')).toBe('Shipping v2 today');
    expect(normalizeForDecision('Comment by Bob:\nGreat point about ramen')).toBe('Great point about ramen');
    expect(normalizeForDecision('A post by the river\nsecond line')).toBe('A post by the river second line');
  });

  test('drops the other attribution lines content.js writes (they name people, not the topic)', () => {
    // LinkedIn reshare (content.js extractLinkedInText)
    expect(normalizeForDecision('Post by: Alice Martin (Head of Growth at Acme)\n\nWorth a read.\n\nReshared from Robert Kowalski:\nWe opened our second restaurant.'))
      .toBe('Worth a read. We opened our second restaurant.');
    expect(normalizeForDecision('Post by: Alice\n\nReshared post:\nOriginal text here.')).toBe('Original text here.');
    // Facebook Reel: trailing "Author:" line
    expect(normalizeForDecision('Our pasta night was a success!\n\nAuthor: Carol Nguyen')).toBe('Our pasta night was a success!');
    // YouTube video: "Channel:" after the title, optionally followed by "Info:"
    expect(normalizeForDecision('How to make ramen broth\nChannel: Chef Dana\nInfo: 1.2M views • 2 days ago')).toBe('How to make ramen broth Info: 1.2M views • 2 days ago');
    expect(normalizeForDecision('How to make ramen broth\nChannel: Chef Dana')).toBe('How to make ramen broth');
    // the same words inside the post are content and stay
    expect(normalizeForDecision('Author: Jane Austen is my favourite.\nWhat is yours?')).toBe('Author: Jane Austen is my favourite. What is yours?');
    expect(normalizeForDecision('Our plan.\nChannel: email first\nThen ads.')).toBe('Our plan. Channel: email first Then ads.');
    expect(normalizeForDecision('She reshared from her archive: the 2019 menu')).toBe('She reshared from her archive: the 2019 menu');
  });

  test('drops a trailing "By:" byline (Hacker News / Medium items stored with the author in the text)', () => {
    // Hacker News: own last line
    expect(normalizeForDecision('Show HN: A tracker for my sourdough starter\n\nBy: jdoe42')).toBe('Show HN: A tracker for my sourdough starter');
    // Medium: collapsed to one line by content.js
    expect(normalizeForDecision('How I bake sourdough at home A beginner guide to starters By: Jane Q. Doe'))
      .toBe('How I bake sourdough at home A beginner guide to starters');
    // Only the last byline-like run, and only a name-like one, is removed.
    expect(normalizeForDecision('Interview By: Sam about bread By: Jane Q. Doe')).toBe('Interview By: Sam about bread');
    expect(normalizeForDecision('We shipped it. Written By: the whole platform team after many long months of work'))
      .toBe('We shipped it. Written By: the whole platform team after many long months of work');
    expect(normalizeForDecision('Stand by me, a classic film')).toBe('Stand by me, a classic film');
    expect(normalizeForDecision('Who wrote this By: anyone?')).toBe('Who wrote this By: anyone?');
  });

  test('strips URLs, lnkd.in links and emoji; keeps hashtag words', () => {
    const raw = '🚀Order today:https://lnkd.in/aB3cD4eF and www.example.com/x ✔ Done 👍🏽 #MichelinStar #food lnkd.in/abc';
    expect(normalizeForDecision(raw)).toBe('Order today: and Done MichelinStar food');
    expect(normalizeForDecision('Price #1 deal')).toBe('Price 1 deal');
  });

  test('collapses whitespace and handles non-strings', () => {
    expect(normalizeForDecision('  a \n\n\t b  ')).toBe('a b');
    expect(normalizeForDecision(null)).toBe('');
    expect(normalizeForDecision(undefined)).toBe('');
    expect(normalizeForDecision(42)).toBe('42');
  });

  test('truncates on a word boundary at maxChars (default 1500)', () => {
    const words = Array.from({ length: 600 }, (_, i) => `word${i}`).join(' ');
    const out = normalizeForDecision(words);
    expect(out.length).toBeLessThanOrEqual(DECISION_MAX_CHARS);
    expect(words.startsWith(out)).toBe(true);
    expect(words[out.length]).toBe(' '); // cut exactly before a space
    expect(normalizeForDecision('alpha beta gamma', { maxChars: 12 })).toBe('alpha beta');
    expect(normalizeForDecision('alpha beta gamma', { maxChars: 10 })).toBe('alpha beta');
    // one long token: hard cut
    expect(normalizeForDecision('x'.repeat(50), { maxChars: 20 })).toBe('x'.repeat(20));
  });

  test('never ends on half a surrogate pair', () => {
    const s = `${'a'.repeat(9)}\u{20000}b`; // CJK ext-B char (not an emoji) straddles the cut
    const out = normalizeForDecision(s, { maxChars: 10 });
    expect(out).toBe('a'.repeat(9));
  });
});

describe('textHash (FNV-1a 64)', () => {
  test('matches the published test vectors', () => {
    expect(textHash('')).toBe('cbf29ce484222325');
    expect(textHash('a')).toBe('af63dc4c8601ec8c');
    expect(textHash('foobar')).toBe('85944171f73967e8');
  });

  test('matches a BigInt reference on unicode and long text', () => {
    for (const s of ['héllo wörld', '𝗠𝗮𝘁𝗵 bold', '日本語のテキスト', 'x'.repeat(3000), 'mixed 🚀 emoji']) {
      expect(textHash(s)).toBe(fnv1a64BigInt(s));
    }
  });

  test('is 16 hex chars and stable', () => {
    expect(textHash('restaurant')).toMatch(/^[0-9a-f]{16}$/);
    expect(textHash('restaurant')).toBe(textHash('restaurant'));
    expect(textHash('restaurant')).not.toBe(textHash('restaurants'));
  });
});

describe('specHash', () => {
  test('is stable over key order and changes with content', () => {
    const a = specHash({ prompt: 'food', tags: [['Food', 'cooking']], model: 'bge-small', calibration: 'c1' });
    const b = specHash({ calibration: 'c1', model: 'bge-small', tags: [['Food', 'cooking']], prompt: 'food' });
    expect(a).toBe(b);
    expect(specHash({ prompt: 'food', tags: [['Food', 'cooking']], model: 'minilm', calibration: 'c1' })).not.toBe(a);
    expect(specHash({ prompt: 'food', tags: [['Food', 'recipes']], model: 'bge-small', calibration: 'c1' })).not.toBe(a);
    // array order matters (tags are an ordered list)
    expect(specHash({ t: [1, 2] })).not.toBe(specHash({ t: [2, 1] }));
  });

  test('stableStringify ignores undefined members like JSON', () => {
    expect(stableStringify({ b: 1, a: undefined, c: [undefined, 2] })).toBe('{"b":1,"c":[null,2]}');
    expect(stableStringify(undefined)).toBe('null');
  });
});

describe('buildDecisionState', () => {
  test('normalizes text, hashes it and keeps platform/author', () => {
    const s = buildDecisionState({ id: 'x', text: 'Post by: Ann\n\nRamen night 🍜 https://t.co/x', platform: 'linkedin.com', author: ' Ann ' });
    expect(s).toEqual({ text: 'Ramen night', textHash: textHash('Ramen night'), platform: 'linkedin.com', author: 'Ann' });
  });

  test('accepts legacy item fields and omits an empty author', () => {
    const s = buildDecisionState({ textSnippet: 'Hello world', sourcePlatform: 'x.com', authorName: '' });
    expect(s).toEqual({ text: 'Hello world', textHash: textHash('Hello world'), platform: 'x.com' });
    expect(buildDecisionState(null)).toEqual({ text: '', textHash: textHash(''), platform: '' });
  });
});
