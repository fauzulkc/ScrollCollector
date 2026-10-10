import test from 'node:test';
import assert from 'node:assert';
import './lib/sanitizer.js';
const { sanitize } = globalThis.MindstreamSanitizer;

import { buildSystemPrompt, buildUserPrompt } from './lib/prompt-builder.js';
import { cleanTagName, keywordFallback, extractNounTopic, heuristicAuthorMatch, isSocialNoise, scoreRuleBasedEvalMatch, buildEvalKeywords, parseModelJson, containsEvalTerm, generateCustomKeywords, normalizeForMatch, normalizeTagList, setSemanticGenerator, checkEngineStatus, autoSuggestTagPrompt, extractTagsFromPrompt, RULES_ENGINE } from './lib/inference-engine.js';
import { createNanoProvider } from './lib/decision/providers/nano.js';
import { getBrowserModelDisplayName } from './lib/inference/browser-detect.js';
import { createStateLock } from './lib/state-lock.js';

test('PII Sanitizer Tests', (t) => {
  // Test email redaction
  assert.strictEqual(
    sanitize('Write to john.doe@example.org or info@company.com'),
    'Write to [REDACTED_EMAIL] or [REDACTED_EMAIL]'
  );

  // Test phone redaction
  assert.strictEqual(
    sanitize('My phone number is +1 (555) 019-2834, call me.'),
    'My phone number is [REDACTED_PHONE], call me.'
  );

  // Test Luhn-valid CC redaction
  // 4111-1111-1111-1111 is a valid Visa test card number (passes Luhn)
  assert.strictEqual(
    sanitize('Charge my card 4111 1111 1111 1111'),
    'Charge my card [REDACTED_CC]'
  );

  // Test Luhn-invalid CC (should not be redacted)
  // 4111-1111-1111-1112 fails Luhn
  assert.strictEqual(
    sanitize('Fake number is 4111-1111-1111-1112'),
    'Fake number is 4111-1111-1111-1112'
  );
});

test('Prompt Builder Tests', (t) => {
  const systemPrompt = buildSystemPrompt([
    { label: 'Tech', prompt: 'Identify posts related to Tech.' },
    { label: 'Finance', prompt: 'Identify posts related to Finance.' }
  ]);
  assert.ok(systemPrompt.includes('Tech: Identify posts related to Tech.'));
  assert.ok(systemPrompt.includes('semantic text categorization'));

  const userPrompt = buildUserPrompt('Exploring Bitcoin markets', 'linkedin.com');
  assert.strictEqual(userPrompt, '[Source: linkedin.com] "Exploring Bitcoin markets"');
});

test('Inference Engine - cleanTagName Tests', (t) => {
  assert.strictEqual(cleanTagName('artificial   intelligence!!!'), 'Artificial Intellige');
  assert.strictEqual(cleanTagName('spacex-rocket'), 'Spacex-rocket');
  assert.strictEqual(cleanTagName('   '), null);
  assert.strictEqual(cleanTagName('a'.repeat(30)), 'A' + 'a'.repeat(19)); // cap at 20 chars
});

test('Inference Engine - keywordFallback Tests', (t) => {
  const enabledTags = [
    { label: 'Tech', prompt: 'Identify posts related to technology, code, coding, programming.' },
    { label: 'Finance', prompt: 'Identify posts related to finance, economy, bond, yields, market stocks.' },
    { label: 'AI & Machine Learning', prompt: 'Identify posts related to AI, machine learning, deep learning, model, transformers.' }
  ];

  // Tech match. Intentional change: one short keyword ("code") is no longer enough on its own,
  // the rules tier needs two hits or one specific (6+ chars, non-generic) keyword.
  const match1 = keywordFallback('We need to write python code and commit it to our repository.', enabledTags);
  assert.strictEqual(match1.tags.length, 0);
  const match1b = keywordFallback('We need to write python code and review the programming guide.', enabledTags);
  assert.strictEqual(match1b.tags[0]?.name, 'Tech');
  assert.ok(match1b.tags[0].score < 1, 'scores are absolute, not normalized to 1.0');

  // Finance match
  const match2 = keywordFallback('The bond yield curve is showing recession indicators.', enabledTags);
  assert.strictEqual(match2.tags[0]?.name, 'Finance');

  // AI match
  const match3 = keywordFallback('A new transformers language model was trained on GPUs.', enabledTags);
  assert.strictEqual(match3.tags[0]?.name, 'AI & Machine Learning');

  // Unclassified fallback
  const match4 = keywordFallback('The weather is lovely outside today.', enabledTags);
  assert.strictEqual(match4.tags.length, 0);
});

test('Inference Engine - extractNounTopic Heuristic Tests', (t) => {
  const text = `
    Microsoft launched a new platform. The Microsoft platform is very fast.
    Many developers like Microsoft because of its open-source support.
    Today, Microsoft stock increased.
  `;
  const topic = extractNounTopic(text);
  assert.strictEqual(topic, 'Microsoft');
});

test('Inference Engine - heuristicAuthorMatch Tests', (t) => {
  // Test direct exact match
  assert.ok(heuristicAuthorMatch(
    { name: 'John Doe', platform: 'x.com', url: '' },
    { name: 'john doe', platform: 'linkedin.com', url: '' }
  ));

  // Test name normalization (punctuation, spaces, handles)
  assert.ok(heuristicAuthorMatch(
    { name: '@JohnDoe', platform: 'x.com', url: '' },
    { name: 'john_doe', platform: 'linkedin.com', url: '' }
  ));

  assert.ok(heuristicAuthorMatch(
    { name: 'John Doe 123', platform: 'x.com', url: '' },
    { name: 'John-Doe', platform: 'linkedin.com', url: '' }
  ));

  // Test URL handle extraction
  assert.ok(heuristicAuthorMatch(
    { name: 'John Doe', platform: 'x.com', url: 'https://x.com/johndoe' },
    { name: 'John D.', platform: 'linkedin.com', url: 'https://linkedin.com/in/johndoe/' }
  ));

  // Test substring matching
  assert.ok(heuristicAuthorMatch(
    { name: 'Johnathan Doe', platform: 'x.com', url: '' },
    { name: 'Johnathan', platform: 'linkedin.com', url: '' }
  ));

  // Test Levenshtein distance similarity (> 0.8)
  assert.ok(heuristicAuthorMatch(
    { name: 'Johnathan Doe', platform: 'x.com', url: '' },
    { name: 'Johnathon Doe', platform: 'linkedin.com', url: '' }
  ));

  // Test mismatch
  assert.ok(!heuristicAuthorMatch(
    { name: 'John Doe', platform: 'x.com', url: 'https://x.com/johndoe' },
    { name: 'Jane Smith', platform: 'linkedin.com', url: 'https://linkedin.com/in/janesmith' }
  ));
});

test('Ignore List Filtering Logic Tests', (t) => {
  const mockStack = [
    { id: '1', assignedTag: 'Tech', sourcePlatform: 'linkedin.com', sourceUrl: 'https://linkedin.com/post1' },
    { id: '2', assignedTag: 'Finance', sourcePlatform: 'x.com', sourceUrl: 'https://x.com/post2' },
    { id: '3', assignedTag: 'AI', sourcePlatform: 'youtube.com', sourceUrl: 'https://youtube.com/post3' },
    { id: '4', assignedTag: 'Tech', sourcePlatform: 'medium.com', sourceUrl: 'https://medium.com/post4' }
  ];

  const filterFn = (stack, configuration) => {
    const ignoredTags = (configuration.ignoredTags || []).map(t => t.toLowerCase());
    const ignoredLinks = configuration.ignoredLinks || [];
    const ignoredDomains = (configuration.ignoredDomains || []).map(d => d.toLowerCase());

    return stack.filter(i => {
      if (ignoredTags.includes((i.assignedTag || '').toLowerCase())) return false;
      if (i.sourceUrl && ignoredLinks.includes(i.sourceUrl)) return false;
      const rawPlatform = (i.sourcePlatform || '').toLowerCase();
      if (ignoredDomains.some(d => rawPlatform === d || rawPlatform.endsWith('.' + d))) return false;
      return true;
    });
  };

  // 1. Test Tag Ignore
  const config1 = { ignoredTags: ['Tech'], ignoredDomains: [], ignoredLinks: [] };
  const filtered1 = filterFn(mockStack, config1);
  assert.strictEqual(filtered1.length, 2);
  assert.ok(!filtered1.some(i => i.id === '1' || i.id === '4'));

  // 2. Test Link Ignore
  const config2 = { ignoredTags: [], ignoredDomains: [], ignoredLinks: ['https://x.com/post2'] };
  const filtered2 = filterFn(mockStack, config2);
  assert.strictEqual(filtered2.length, 3);
  assert.ok(!filtered2.some(i => i.id === '2'));

  // 3. Test Domain Ignore
  const config3 = { ignoredTags: [], ignoredDomains: ['youtube.com'], ignoredLinks: [] };
  const filtered3 = filterFn(mockStack, config3);
  assert.strictEqual(filtered3.length, 3);
  assert.ok(!filtered3.some(i => i.id === '3'));
});

test('Eval Match - social noise rejection', (t) => {
  assert.ok(isSocialNoise('Shihabul Islam and 2 others reacted to your post about WSL and Claude Code.'));
  assert.ok(isSocialNoise('Hi Saquib, Amazing to be connected with you! Excited to start our journey together.'));
  assert.ok(!isSocialNoise('A stunning Michelin-star tasting menu featured locally sourced ingredients and modern French technique.'));
});

test('Eval Match - strict rule-based scoring', (t) => {
  const prompt = 'find me restaurant and 5 star quality food posts. I am fascinated by michelin star cooking';
  const tags = ['Michelin', '5 Star Cooking', 'Cooking', 'Restaurant', 'Food'];

  const linkedInNoise = scoreRuleBasedEvalMatch(
    'Hi Saquib, Amazing to be connected with you! Together we can do amazing things from start to December.',
    prompt,
    tags
  );
  assert.ok(!linkedInNoise.doesMatch);

  const reactionNoise = scoreRuleBasedEvalMatch(
    'Shihabul Islam and 2 others reacted to your post.',
    prompt,
    tags
  );
  assert.ok(!reactionNoise.doesMatch);

  const foodPost = scoreRuleBasedEvalMatch(
    'We visited a Michelin star restaurant last night. The chef presented a five course tasting menu with exceptional technique.',
    prompt,
    tags
  );
  assert.ok(foodPost.doesMatch);

  const keywords = buildEvalKeywords(prompt, tags);
  assert.ok(keywords.tagKeywords.includes('michelin'));
  assert.ok(keywords.tagKeywords.includes('restaurant'));
});

test('Eval Match - normalized text and legacy prompt tags', (t) => {
  assert.strictEqual(normalizeForMatch('𝗠𝗶𝗰𝗵𝗲𝗹𝗶𝗻​  Star'), 'michelin star');
  assert.ok(containsEvalTerm('Dinner at a 𝗠𝗶𝗰𝗵𝗲𝗹𝗶𝗻 restaurant', 'michelin'));
  assert.deepStrictEqual(normalizeTagList([{ name: 'Michelin', weight: 1 }, 'michelin', null, 'Food']), ['Michelin', 'Food']);

  const legacy = scoreRuleBasedEvalMatch(
    'We visited a Michelin star restaurant last night.',
    'find me restaurant and 5 star quality food posts',
    [{ name: 'Michelin', weight: 1 }, { name: 'Restaurant', weight: 0.5 }]
  );
  assert.ok(legacy.doesMatch);
  assert.ok(legacy.matchedKeywords.every(k => !k.includes('[object')));
});

test('parseModelJson tolerates markdown fences', (t) => {
  assert.deepStrictEqual(parseModelJson('{"matches": true}'), { matches: true });
  assert.deepStrictEqual(
    parseModelJson('Here is the result:\n```json\n{"matches": false}\n```'),
    { matches: false }
  );
});

// Ported from the retired lib/inference/router.js tests: the semantic tier is now an injectable
// generator list (lib/inference-engine.js setSemanticGenerator), by default the browser's built-in
// LanguageModel provider (lib/decision/providers/nano.js); provider details are covered by
// test/unit/provider-nano.test.js.
test('Semantic generators — fallback order, readiness and legacy engine status', async (t) => {
  const calls = [];
  const notReady = {
    displayName: 'Not Ready SLM',
    isReady: async () => false,
    generateJson: async () => { calls.push('notReady'); return { prompt: 'never' }; }
  };
  const failing = {
    displayName: 'Failing SLM',
    isReady: async () => true,
    generateJson: async () => { calls.push('failing'); throw Object.assign(new Error('boom'), { code: 'error' }); }
  };
  const working = {
    displayName: 'Mock Nano',
    isReady: async () => true,
    status: () => ({ state: 'ready', availability: 'available' }),
    generateJson: async (system, user, opts) => {
      calls.push('working');
      assert.ok(opts.schema && opts.schema.required.includes('prompt'), 'the helper passes its response schema');
      return { prompt: 'Identify posts about sourdough baking.' };
    }
  };
  t.after(() => setSemanticGenerator(null));

  setSemanticGenerator([notReady, failing, working]);
  const original = console.warn;
  console.warn = () => {};
  try {
    assert.strictEqual(await autoSuggestTagPrompt('Baking'), 'Identify posts about sourdough baking.');
  } finally {
    console.warn = original;
  }
  assert.deepStrictEqual(calls, ['failing', 'working'], 'a generator that is not ready is skipped without a call');

  // The deprecated legacy status reflects the first generator.
  setSemanticGenerator(working);
  assert.deepStrictEqual(await checkEngineStatus(), { tier: 1, name: 'Mock Nano', status: 'ready', availability: 'available' });
  setSemanticGenerator({ displayName: 'Mock Nano', isReady: async () => false, status: () => ({ state: 'downloading' }), generateJson: async () => null });
  assert.strictEqual((await checkEngineStatus()).status, 'downloading');

  // Rules only.
  setSemanticGenerator(false);
  assert.deepStrictEqual(await checkEngineStatus(), { tier: 3, name: RULES_ENGINE, status: 'ready' });
  assert.strictEqual(await autoSuggestTagPrompt('Baking'), 'Find posts related to Baking.');
});

test('Semantic generators — default built-in LanguageModel: heuristics without it, JSON with it', async (t) => {
  t.after(() => setSemanticGenerator(null));

  // Node has no LanguageModel: the default generator is not ready and every helper uses its heuristic.
  setSemanticGenerator(null);
  assert.strictEqual(typeof globalThis.LanguageModel, 'undefined');
  assert.strictEqual((await checkEngineStatus()).tier, 3);
  assert.strictEqual(await autoSuggestTagPrompt('Baking'), 'Find posts related to Baking.');

  // A fake LanguageModel behind the nano provider answers through the same hook.
  const prompts = [];
  const languageModel = {
    availability: async () => 'available',
    create: async () => ({
      clone: async () => ({
        prompt: async (text, options) => {
          prompts.push({ text, options });
          return '{"tags": ["Baking", "Bread"]}';
        },
        destroy() {}
      }),
      destroy() {}
    })
  };
  setSemanticGenerator(createNanoProvider({ languageModel }));
  assert.deepStrictEqual(await extractTagsFromPrompt('sourdough bread and baking posts'), ['Baking', 'Bread']);
  assert.strictEqual(prompts.length, 1);
  assert.deepStrictEqual(prompts[0].options.responseConstraint.required, ['tags']);
});

test('Browser detect — display names', (t) => {
  assert.strictEqual(typeof getBrowserModelDisplayName(), 'string');
});

test('Requirement 7 — Substring match and weak keyword fallback tests', (t) => {
  const result = keywordFallback(
    'Lack of SOC 2 has slowed growth for so many SaaS startups. Our creator economy is great.',
    [{ label: '5 Star Cooking', prompt: '' }, { label: 'Food', prompt: '' }]
  );
  assert.strictEqual(result.tags.length, 0);

  assert.strictEqual(containsEvalTerm('SaaS startups', 'star'), false);
  assert.strictEqual(containsEvalTerm('three Michelin stars', 'stars'), true);

  const customKeywords5Star = generateCustomKeywords('5 Star Cooking');
  assert.ok(!customKeywords5Star.includes('star'));

  const customKeywordsRestaurant = generateCustomKeywords('Restaurant');
  assert.ok(customKeywordsRestaurant.includes('restaurant'));

  const text1 = 'Lack of SOC 2 has slowed growth for so many SaaS startups.';
  const topic1 = extractNounTopic(text1);
  assert.notStrictEqual(topic1, 'Soc');
  assert.notStrictEqual(topic1, 'Starts');

  const text2 = 'Right preparation and starts of gear update thing.';
  const topic2 = extractNounTopic(text2);
  assert.notStrictEqual(topic2, 'Right');
  assert.notStrictEqual(topic2, 'Starts');
});

test('Global Search and Sub-filtering Logic Tests', (t) => {
  const mockStack = [
    { id: '1', timestamp: 1000, assignedTag: 'Tech', sourcePlatform: 'linkedin.com', textSnippet: 'First post about react' },
    { id: '2', timestamp: 3000, assignedTag: 'Finance', sourcePlatform: 'x.com', textSnippet: 'Latest post about bitcoin' },
    { id: '3', timestamp: 2000, assignedTag: 'Tech', sourcePlatform: 'youtube.com', textSnippet: 'Middle post about react' },
    { id: '4', timestamp: 4000, assignedTag: 'AI', sourcePlatform: 'medium.com', textSnippet: 'Very latest post about ai' }
  ];

  // Helper matching the logic in getSearchFilteredStack
  const getSearchFilteredStackFn = (stack, query) => {
    const list = [...stack];
    list.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    if (!query) return list;
    const q = query.toLowerCase().trim();
    return list.filter(i => {
      const tagMatch = (i.assignedTag || '').toLowerCase().includes(q);
      const postMatch = (i.textSnippet || '').toLowerCase().includes(q);
      const siteMatch = (i.sourcePlatform || '').toLowerCase().includes(q);
      return tagMatch || postMatch || siteMatch;
    });
  };

  // 1. Verify latest to oldest sorting
  const sorted = getSearchFilteredStackFn(mockStack, '');
  assert.strictEqual(sorted[0].id, '4');
  assert.strictEqual(sorted[1].id, '2');
  assert.strictEqual(sorted[2].id, '3');
  assert.strictEqual(sorted[3].id, '1');

  // 2. Verify search query matches on all posts first (ignoring previous filters)
  const searchResult = getSearchFilteredStackFn(mockStack, 'react');
  // Should match post 1 and post 3, sorted latest first (post 3 first because timestamp 2000 > 1000)
  assert.strictEqual(searchResult.length, 2);
  assert.strictEqual(searchResult[0].id, '3');
  assert.strictEqual(searchResult[1].id, '1');

  // 3. Verify sub-filtering of tag on the search result
  const searchResultAll = getSearchFilteredStackFn(mockStack, 'post');
  assert.strictEqual(searchResultAll.length, 4);

  // Sub-filter by site (e.g. youtube.com)
  const subFiltered = searchResultAll.filter(i => i.sourcePlatform === 'youtube.com');
  assert.strictEqual(subFiltered.length, 1);
  assert.strictEqual(subFiltered[0].id, '3');
});

test('State lock - concurrent parses must not delete collected items', async (t) => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Models the TEXT_EXTRACTED handler: read state, await slow inference,
  // then write. Without serialization every handler writes a snapshot taken
  // before its await, so the last writer wipes out everything added meanwhile.
  const makeStore = () => {
    const store = { stack: [] };
    return {
      store,
      get: async () => ({ stack: [...store.stack] }),
      set: async (stack) => { store.stack = stack; }
    };
  };

  // 1. Unserialized: reproduces the data loss.
  const racy = makeStore();
  await Promise.all(Array.from({ length: 20 }, async (_, i) => {
    const snapshot = await racy.get();          // read BEFORE the await
    await sleep(5);                             // inference
    await racy.set([{ id: i }, ...snapshot.stack]);
  }));
  assert.ok(
    racy.store.stack.length < 20,
    'expected the unserialized pattern to lose items; if this passes the test no longer models the bug'
  );

  // 2. Serialized, re-reading inside the lock: nothing is lost.
  const safe = makeStore();
  const lock = createStateLock();
  await Promise.all(Array.from({ length: 20 }, async (_, i) => {
    await sleep(5);                             // inference stays concurrent
    await lock.run(async () => {
      const fresh = await safe.get();           // read INSIDE the lock
      await safe.set([{ id: i }, ...fresh.stack]);
    });
  }));
  assert.strictEqual(safe.store.stack.length, 20, 'every collected item must survive');

  const ids = safe.store.stack.map(i => i.id).sort((a, b) => a - b);
  assert.deepStrictEqual(ids, Array.from({ length: 20 }, (_, i) => i));
});

test('State lock - a failing section does not stall later ones', async (t) => {
  const lock = createStateLock();
  const order = [];

  const failing = lock.run(async () => { order.push('a'); throw new Error('boom'); });
  await assert.rejects(failing, /boom/);

  await lock.run(async () => { order.push('b'); });
  assert.deepStrictEqual(order, ['a', 'b']);
});




