import test from 'node:test';
import assert from 'node:assert';
import './lib/sanitizer.js';
const { sanitize } = globalThis.MindstreamSanitizer;

import { buildSystemPrompt, buildUserPrompt } from './lib/prompt-builder.js';
import { cleanTagName, keywordFallback, extractNounTopic, heuristicAuthorMatch, isSocialNoise, scoreRuleBasedEvalMatch, buildEvalKeywords, parseModelJson, containsEvalTerm, generateCustomKeywords } from './lib/inference-engine.js';
import { createRouter } from './lib/inference/router.js';
import { getBrowserModelDisplayName } from './lib/inference/browser-detect.js';

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

  // Tech match
  const match1 = keywordFallback('We need to write python code and commit it to our repository.', enabledTags);
  assert.strictEqual(match1.tags[0]?.name, 'Tech');

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

test('parseModelJson tolerates markdown fences', (t) => {
  assert.deepStrictEqual(parseModelJson('{"matches": true}'), { matches: true });
  assert.deepStrictEqual(
    parseModelJson('Here is the result:\n```json\n{"matches": false}\n```'),
    { matches: false }
  );
});

test('Inference router — provider fallback order', async (t) => {
  const calls = [];

  const tier1 = {
    tier: 1,
    getDisplayName: () => 'Mock Browser SLM',
    isAvailable: async () => true,
    inferJson: async () => {
      calls.push('tier1');
      return null;
    },
    getEngineStatus: async () => ({ tier: 1, name: 'Mock Browser SLM', status: 'ready' })
  };

  const tier2 = {
    tier: 2,
    getDisplayName: () => 'Mock WebGPU',
    isAvailable: async () => true,
    inferJson: async () => {
      calls.push('tier2');
      return { tags: [{ name: 'Tech', score: 1 }] };
    },
    getEngineStatus: async () => ({ tier: 2, name: 'Mock WebGPU', status: 'ready' })
  };

  const keyword = {
    tier: 3,
    getDisplayName: () => 'Rule-based Classifier',
    isAvailable: async () => true,
    getEngineStatus: async () => ({ tier: 3, name: 'Rule-based Classifier', status: 'ready' })
  };

  const router = createRouter([tier1, tier2], [tier1, tier2, keyword]);

  const result = await router.inferJson({
    systemPrompt: 'test',
    userPrompt: 'hello'
  });

  assert.deepStrictEqual(calls, ['tier1', 'tier2']);
  assert.strictEqual(result.engine, 'Mock WebGPU');
  assert.strictEqual(result.tier, 2);

  const status = await router.checkEngineStatus();
  assert.strictEqual(status.tier, 1);
  assert.strictEqual(status.name, 'Mock Browser SLM');
});

test('Inference router — keyword status when no semantic provider ready', async (t) => {
  const unavailable = {
    tier: 1,
    getDisplayName: () => 'Mock Browser SLM',
    isAvailable: async () => false,
    inferJson: async () => null,
    getEngineStatus: async () => null
  };

  const keyword = {
    tier: 3,
    getDisplayName: () => 'Rule-based Classifier',
    isAvailable: async () => true,
    getEngineStatus: async () => ({ tier: 3, name: 'Rule-based Classifier', status: 'ready' })
  };

  const router = createRouter([unavailable], [unavailable, keyword]);
  const status = await router.checkEngineStatus();
  assert.strictEqual(status.tier, 3);
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




