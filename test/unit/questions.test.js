import { describe, test, expect } from 'vitest';
import {
  cleanPrompt,
  describeTag,
  selectQuestionTags,
  buildMatchQuestion,
  buildPrimaryTagQuestion,
  buildTagNouls,
  lintInstructions,
  rotationOffset,
  NONE_OPTION,
  NONE_DESCRIPTION,
  MAX_CHOICE_OPTIONS
} from '../../lib/decision/questions.js';

const USER_PROMPT = 'find me restaurant and 5 star quality food posts. I am fascinated by michelin star cooking';

const TRACKED = [
  { id: 't1', label: 'Health', isEnabled: true, prompt: 'Identify posts related to health, medicine, doctors, hospitals, fitness, wellness, or nutrition.' },
  { id: 't2', label: 'Jobs', isEnabled: true, prompt: 'Identify posts related to job postings, career opportunities, hiring, recruitment, resumes, or interviews.' },
  { id: 't3', label: 'Tech/AI', isEnabled: true, prompt: 'Identify posts related to software, technology, programming, developer tools, artificial intelligence, or machine learning.' },
  { id: 't6', label: 'Ad', isEnabled: true, prompt: 'Identify advertisements, sponsored content, products for sale, or promotional codes.' },
  { id: 't19', label: 'Blog', isEnabled: true, prompt: 'Identify references to blog articles, long-form posts, reading materials, or updates for written sites.' },
  { id: 't9', label: 'Weather', isEnabled: false, prompt: 'Identify posts related to weather.' },
  { id: 't_ads', label: 'Ads', isEnabled: true },
  { id: 't_x', label: 'Food', isEnabled: true, isPseudo: true, prompt: 'Identify food' }
];

describe('cleanPrompt', () => {
  test("strips request boilerplate from the user's prompt", () => {
    expect(cleanPrompt(USER_PROMPT)).toBe('restaurant and 5 star quality food; michelin star cooking');
  });

  test.each([
    ['Please find me all posts about Rust', 'Rust'],
    ['show posts related to climate tech.', 'climate tech'],
    ['collect AI tools that help with coding', 'AI tools that help with coding'],
    ['get me posts on remote jobs', 'remote jobs'],
    ["I'm interested in sourdough baking", 'sourdough baking'],
    ['I am curious about quantum computing posts', 'quantum computing'],
    ["I'd like to see posts about F1 racing", 'F1 racing'],
    ['getting started with rust', 'getting started with rust'],
    ['  ', '']
  ])('%s -> %s', (raw, expected) => {
    expect(cleanPrompt(raw)).toBe(expected);
  });
});

describe('tag descriptions', () => {
  test('describeTag strips the instruction lead-in and trailing period', () => {
    expect(describeTag(TRACKED[0].prompt)).toBe('health, medicine, doctors, hospitals, fitness, wellness, or nutrition');
    expect(describeTag(TRACKED[3].prompt)).toBe('advertisements, sponsored content, products for sale, or promotional codes');
    expect(describeTag(TRACKED[4].prompt)).toBe('blog articles, long-form posts, reading materials, or updates for written sites');
    expect(describeTag('')).toBeNull();
    expect(describeTag(undefined)).toBeNull();
  });

  test('selectQuestionTags keeps enabled, non-pseudo, unique tags in order', () => {
    const tags = selectQuestionTags([...TRACKED, { label: 'health', isEnabled: true }, 'Sports', { label: 'none' }, null]);
    expect(tags.map((t) => t.label)).toEqual(['Health', 'Jobs', 'Tech/AI', 'Ad', 'Blog', 'Sports']);
    expect(tags.find((t) => t.label === 'Sports').description).toBeNull();
  });
});

describe('buildMatchQuestion', () => {
  test('builds the noul from the raw prompt and the cleaned topic', () => {
    const q = buildMatchQuestion(USER_PROMPT);
    expect(q).toEqual({
      type: 'noul',
      instructions: `Is the main subject of this post something the reader asked for? Reader request: "${USER_PROMPT}"`,
      criteria: {
        true: 'The post is mainly about restaurant and 5 star quality food; michelin star cooking.',
        false: 'The post is mainly about another subject.'
      }
    });
  });

  test('prefers an expansion and protects the quoting', () => {
    const q = buildMatchQuestion('posts about "AI" tools', 'AI coding assistants and developer tools.');
    expect(q.instructions.endsWith(`Reader request: "posts about 'AI' tools"`)).toBe(true);
    expect(q.criteria.true).toBe('The post is mainly about AI coding assistants and developer tools.');
  });

  test('returns null for an empty prompt', () => {
    expect(buildMatchQuestion('   ')).toBeNull();
    expect(buildMatchQuestion(undefined)).toBeNull();
  });
});

describe('buildPrimaryTagQuestion', () => {
  test('choice over enabled non-pseudo tags with descriptions, none last', () => {
    const q = buildPrimaryTagQuestion(TRACKED);
    expect(q.type).toBe('choice');
    expect(Object.keys(q.criteria)).toEqual(['Health', 'Jobs', 'Tech/AI', 'Ad', 'Blog', NONE_OPTION]);
    expect(q.criteria.Health).toBe('health, medicine, doctors, hospitals, fitness, wellness, or nutrition');
    expect(q.criteria[NONE_OPTION]).toBe(NONE_DESCRIPTION);
    expect(q.criteria).not.toHaveProperty('Ads');
    expect(q.criteria).not.toHaveProperty('Weather');
  });

  test('rotation is deterministic per seed and keeps the same options', () => {
    const a = Object.keys(buildPrimaryTagQuestion(TRACKED, 2).criteria);
    const b = Object.keys(buildPrimaryTagQuestion(TRACKED, 2).criteria);
    expect(a).toEqual(b);
    expect(a).toEqual(['Tech/AI', 'Ad', 'Blog', 'Health', 'Jobs', NONE_OPTION]);
    expect(Object.keys(buildPrimaryTagQuestion(TRACKED, 'some-hash').criteria)).toEqual(
      Object.keys(buildPrimaryTagQuestion(TRACKED, 'some-hash').criteria)
    );
    // seeds spread the first position over the tags
    const firsts = new Set(Array.from({ length: 50 }, (_, i) => Object.keys(buildPrimaryTagQuestion(TRACKED, `post-${i}`).criteria)[0]));
    expect(firsts.size).toBeGreaterThan(2);
    for (let s = 0; s < 10; s++) {
      const keys = Object.keys(buildPrimaryTagQuestion(TRACKED, s).criteria);
      expect([...keys].sort()).toEqual(['Ad', 'Blog', 'Health', 'Jobs', 'Tech/AI', NONE_OPTION].sort());
      expect(keys[keys.length - 1]).toBe(NONE_OPTION);
    }
  });

  test('rotationOffset stays in range', () => {
    expect(rotationOffset(7, 5)).toBe(2);
    expect(rotationOffset(-7, 5)).toBe(2);
    expect(rotationOffset('abc', 1)).toBe(0);
    const o = rotationOffset('abc', 13);
    expect(o).toBeGreaterThanOrEqual(0);
    expect(o).toBeLessThan(13);
  });

  test('caps options at 255 including none; null without tags', () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ label: `Tag ${i}`, isEnabled: true }));
    const q = buildPrimaryTagQuestion(many, 3);
    expect(Object.keys(q.criteria)).toHaveLength(MAX_CHOICE_OPTIONS);
    expect(buildPrimaryTagQuestion([])).toBeNull();
    expect(buildPrimaryTagQuestion([{ label: 'Ads', isEnabled: true }])).toBeNull();
  });
});

describe('buildTagNouls', () => {
  test('one noul per label keyed tag:<label>', () => {
    const qs = buildTagNouls(['Food', { label: 'Tech/AI', description: 'software and AI' }, 'none', ''], { Food: 'restaurants and cooking.' });
    expect(Object.keys(qs)).toEqual(['tag:Food', 'tag:Tech/AI']);
    expect(qs['tag:Food']).toEqual({
      type: 'noul',
      instructions: 'Does this post belong to the category "Food"?',
      criteria: { true: 'The post is mainly about restaurants and cooking.', false: 'The post is mainly about another subject.' }
    });
    expect(qs['tag:Tech/AI'].criteria.true).toBe('The post is mainly about software and AI.');
  });
});

describe('lintInstructions', () => {
  test('passes for every built question', () => {
    const questions = {
      matches_prompt: buildMatchQuestion("find posts that are not about crypto, I don't like it"),
      primary_tag: buildPrimaryTagQuestion(TRACKED, 1),
      ...buildTagNouls(['Food', 'Tech/AI'])
    };
    expect(lintInstructions(questions)).toEqual({ ok: true, issues: [] });
    expect(lintInstructions(questions.matches_prompt).ok).toBe(true);
  });

  test('rejects negations outside quotes', () => {
    expect(lintInstructions('Is this post not about food?').ok).toBe(false);
    expect(lintInstructions("Isn't this about food?").ok).toBe(false);
    expect(lintInstructions('Does it never mention food?').ok).toBe(false);
    const res = lintInstructions({ a: { type: 'noul', instructions: 'Is it about food?' }, b: { type: 'noul', instructions: 'Is it not spam?' } });
    expect(res.ok).toBe(false);
    expect(res.issues.map((i) => i.id)).toEqual(['b']);
    // words containing "not" are fine
    expect(lintInstructions('Is this a notable notebook?').ok).toBe(true);
  });
});
