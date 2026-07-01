import test from 'node:test';
import assert from 'node:assert';
import './lib/sanitizer.js';
const { sanitize } = globalThis.MindstreamSanitizer;

import { buildSystemPrompt, buildUserPrompt } from './lib/prompt-builder.js';
import { cleanTagName, keywordFallback, extractNounTopic, heuristicAuthorMatch } from './lib/inference-engine.js';

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

