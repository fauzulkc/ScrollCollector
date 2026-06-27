import test from 'node:test';
import assert from 'node:assert';
import './lib/sanitizer.js';
const { sanitize } = globalThis.MindstreamSanitizer;

import { buildSystemPrompt, buildUserPrompt } from './lib/prompt-builder.js';
import { cleanTagName, keywordFallback, extractNounTopic } from './lib/inference-engine.js';

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
  const systemPrompt = buildSystemPrompt(['Tech', 'Finance']);
  assert.ok(systemPrompt.includes('Tech, Finance'));
  assert.ok(systemPrompt.includes('deterministic text categorization'));

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
  const enabledTags = ['Tech', 'Finance', 'AI & Machine Learning'];

  // Tech match
  const match1 = keywordFallback('We need to write python code and commit it to our repository.', enabledTags);
  assert.strictEqual(match1.category, 'Tech');

  // Finance match
  const match2 = keywordFallback('The bond yield curve is showing recession indicators.', enabledTags);
  assert.strictEqual(match2.category, 'Finance');

  // AI match
  const match3 = keywordFallback('A new transformers language model was trained on GPUs.', enabledTags);
  assert.strictEqual(match3.category, 'AI & Machine Learning');

  // Unclassified fallback
  const match4 = keywordFallback('The weather is lovely outside today.', enabledTags);
  assert.strictEqual(match4.category, 'Unclassified');
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
