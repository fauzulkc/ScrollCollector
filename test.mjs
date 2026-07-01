import test from 'node:test';
import assert from 'node:assert';
import './lib/sanitizer.js';
const { sanitize } = globalThis.MindstreamSanitizer;

import { buildSystemPrompt, buildUserPrompt } from './lib/prompt-builder.js';
import { cleanTagName, keywordFallback, extractNounTopic, heuristicAuthorMatch, extractTagsFromPrompt, enhancePrompt, evaluateMatchWithReason } from './lib/inference-engine.js';

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

test('Inference Engine - Weighted Tag Extraction and Enhanced Matching Fallback Tests', async (t) => {
  // Test fallback tag extraction with culinary query
  const tags = await extractTagsFromPrompt('find me restaurant and 5 star quality food posts. I am fascinated by michelin star cooking.');
  assert.ok(tags.length >= 3);
  
  const tagNames = tags.map(t => t.name);
  assert.ok(tagNames.includes('Michelin'));
  assert.ok(tagNames.includes('5 Star Cooking'));
  assert.ok(tagNames.includes('Restaurant'));
  assert.ok(tagNames.includes('Food'));
  
  // Verify weights are on 1-5 scale
  tags.forEach(tag => {
    assert.strictEqual(typeof tag.weight, 'number');
    assert.ok(tag.weight >= 1 && tag.weight <= 5);
  });

  // Test fallback prompt enhancement with culinary query
  const enhanced = await enhancePrompt('find me restaurant and 5 star quality food posts. I am fascinated by michelin star cooking.');
  assert.strictEqual(enhanced, 'Identify posts showcasing high-quality restaurants, Michelin-star cooking, culinary arts, gourmet dishes, cooking shows, or celebrity chefs.');

  // Test fallback prompt enhancement with AI query
  const enhancedAI = await enhancePrompt('AI jobs');
  assert.strictEqual(enhancedAI, 'Identify posts about software development, artificial intelligence breakthroughs, machine learning models, programming tips, or new tech products.');

  // Test evaluateMatchWithReason Tier 2 fallback with weighted tags and enhanced prompt
  const matchPromptTags = [
    { name: 'Tech', weight: 4 },
    { name: 'Jobs', weight: 5 }
  ];
  
  // Post 1: has both Tech ("python", "code") and Jobs ("hiring", "apply") keywords
  const text1 = 'We are hiring a backend developer. Apply now to write python code!';
  const res1 = await evaluateMatchWithReason(text1, 'x.com', 'hiring tech', 'We are hiring technical developers', matchPromptTags);
  assert.ok(res1.doesMatch);
  assert.ok(res1.score > 5);

  // Post 2: does not match either Tech or Jobs keywords
  const text2 = 'The weather today is rainy and wet.';
  const res2 = await evaluateMatchWithReason(text2, 'x.com', 'hiring tech', 'We are hiring technical developers', matchPromptTags);
  assert.ok(!res2.doesMatch);
  assert.strictEqual(res2.score, 0);
});



