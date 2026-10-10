import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import { createSystem1Scorer, validateCalibration, calibrationIdOf } from '../../lib/decision/system1-scorer.js';
import * as S1 from '../../lib/decision/system1-math.js';
import { BACKGROUND_CORPUS } from '../../lib/decision/background-corpus.js';
import { MODEL_REGISTRY } from '../../lib/decision/models.js';
import { cleanPrompt } from '../../lib/decision/questions.js';
import { Q } from '../../lib/decision/types.js';

const DIMS = 24;
const CORPUS_HASH = S1.hashTexts([...BACKGROUND_CORPUS]);

/** Deterministic unit vector per text (mulberry32 seeded with FNV-1a). */
function vectorFor(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  let s = h || 1;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
  // Shared "food" direction so food texts really are closer to a food prompt.
  const food = /restaurant|chef|michelin|food|dining|menu/i.test(text) ? 1 : 0;
  const v = Array.from({ length: DIMS }, (_, i) => rand() + (i === 0 ? 1.5 * food : 0));
  const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0));
  return v.map((x) => x / n);
}

function fakeEmbed() {
  const calls = [];
  const embed = async (texts, opts) => {
    calls.push({ texts: [...texts], isQuery: opts?.isQuery });
    return texts.map(vectorFor);
  };
  return { embed, calls, textsEmbedded: () => calls.flatMap((c) => c.texts) };
}

/** @param {object} [over] */
function calibration(over = {}) {
  return {
    model: 'minilm',
    dtype: 'q8',
    pooling: 'mean',
    queryPrefix: '',
    recipe: 'B',
    labelTemplate: 'about',
    labelAnchors: 'single',
    labelPrefix: false,
    chunk: { maxChars: 800, pool: 'max' },
    match: { a: 0.9, b: -2, bgTrim: 0.1, minStd: 0.02 },
    tag: { score: 'raw', agg: 'max', lexical: { beta: 0.2, cap: 3 }, T: 0.05, noneSim: 0.2, multi: { a: 0.7, b: -1 } },
    floor: { matches_prompt: 0.7, primary_tag: 0.3 },
    corpusHash: CORPUS_HASH,
    ...over
  };
}

const MINILM = { ...MODEL_REGISTRY.minilm, dims: DIMS };
const PROMPT = 'find me restaurant and 5 star quality food posts. I am fascinated by michelin star cooking';
const TAGS = [
  { label: 'Health', description: 'health, medicine, fitness, or nutrition' },
  { label: 'Jobs', description: 'job postings, hiring, recruitment, or interviews' },
  { label: 'Tech/AI', description: null }
];
const spec = (over = {}) => ({
  specHash: 'spec-1',
  prompt: { raw: PROMPT, cleaned: cleanPrompt(PROMPT), expansion: '' },
  tags: TAGS,
  questions: { [Q.MATCHES_PROMPT]: true, [Q.PRIMARY_TAG]: true },
  ...over
});
const POSTS = [
  { id: 'a', text: 'Our chef earned a Michelin star for the new tasting menu at the restaurant.' },
  { id: 'b', text: 'We are hiring a remote backend engineer.' },
  { id: 'c', text: 'Ten minutes of stretching every morning changed my fitness.' }
];

/** The eval's own path (eval/run-eval.mjs before the scorer existed), written out by hand. */
function expectedAnswers(cal, post, sp) {
  const prefix = cal.queryPrefix || '';
  const bgVecs = BACKGROUND_CORPUS.map(vectorFor);
  const qVecs = S1.queryTextsForRecipe(cal.recipe, sp.prompt, prefix).map(vectorFor);
  const qStats = qVecs.map((q) => S1.bgStatsFor(q, bgVecs, { trim: cal.match.bgTrim }));
  const labelVecs = {};
  const labelBgStats = {};
  const labelTerms = {};
  for (const t of sp.tags) {
    const anchors = S1.labelAnchorTexts(t.label, t.description || '', { template: cal.labelTemplate, anchors: cal.labelAnchors, prefix: cal.labelPrefix ? prefix : '' }).map(vectorFor);
    labelVecs[t.label] = anchors;
    labelBgStats[t.label] = S1.labelBgStatsFor(anchors, bgVecs, { trim: cal.match.bgTrim, agg: cal.tag.agg });
    labelTerms[t.label] = S1.labelLexTerms(t.label, t.description || '');
  }
  const postVecs = S1.chunkText(post.text, { maxChars: cal.chunk.maxChars }).map(vectorFor);
  return S1.decideFromEmbeddings({ postVecs, queryVec: qVecs, bgStats: qStats, labelVecs, labelBgStats, postText: post.text, labelTerms, calibration: cal });
}

describe('createSystem1Scorer', () => {
  test('answers exactly like the hand-written eval path (match, tag choice, tag nouls)', async () => {
    const { embed } = fakeEmbed();
    const cal = calibration();
    const scorer = createSystem1Scorer({ embed, calibration: cal, modelSpec: MINILM });
    const results = await scorer.decideItems(POSTS, spec());
    expect(results.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    results.forEach((r, i) => {
      const want = expectedAnswers(cal, POSTS[i], spec());
      expect(r.error).toBeUndefined();
      expect(r.answers).toEqual(want);
      expect(r.answers[Q.MATCHES_PROMPT].type).toBe('noul');
      expect(r.answers[Q.PRIMARY_TAG].type).toBe('choice');
      expect(r.ms).toBeGreaterThanOrEqual(0);
    });
    // The fake food direction makes the food post the clear match.
    expect(results[0].answers[Q.MATCHES_PROMPT].noul).toBeGreaterThan(results[1].answers[Q.MATCHES_PROMPT].noul);
  });

  test('matches the eval path for bge-style calibrations (prefix on queries and labels, item anchors)', async () => {
    const { embed, calls } = fakeEmbed();
    const prefix = MODEL_REGISTRY['bge-small'].queryPrefix;
    const cal = calibration({ model: 'bge-small', pooling: 'cls', queryPrefix: prefix, labelPrefix: true, labelAnchors: 'items', tag: { ...calibration().tag, agg: 'top2', score: 'z' } });
    const scorer = createSystem1Scorer({ embed, calibration: cal, modelSpec: { ...MODEL_REGISTRY['bge-small'], dims: DIMS } });
    const results = await scorer.decideItems(POSTS, spec());
    results.forEach((r, i) => expect(r.answers).toEqual(expectedAnswers(cal, POSTS[i], spec())));
    const queryCalls = calls.filter((c) => c.isQuery);
    const queryTexts = queryCalls.flatMap((c) => c.texts);
    expect(queryTexts).toContain(`${prefix}${PROMPT}`);
    expect(queryTexts).toContain(`${prefix}${cleanPrompt(PROMPT)}`);
    expect(queryTexts).toContain(`${prefix}This post is about job postings, hiring, recruitment, or interviews.`);
    expect(queryTexts).toContain(`${prefix}This post is about hiring.`);
    // Post chunks are passages: never prefixed.
    expect(calls.filter((c) => !c.isQuery).flatMap((c) => c.texts).some((t) => t.startsWith(prefix))).toBe(false);
  });

  test('embeds the background corpus once and caches prepared specs by specHash', async () => {
    const { embed, textsEmbedded } = fakeEmbed();
    const scorer = createSystem1Scorer({ embed, calibration: calibration(), modelSpec: MINILM });
    await scorer.warm();
    expect(textsEmbedded().filter((t) => t === BACKGROUND_CORPUS[0])).toHaveLength(1);
    await scorer.decideItems(POSTS.slice(0, 1), spec());
    await scorer.decideItems(POSTS.slice(1, 2), spec());
    await scorer.decideItems(POSTS.slice(2), spec({ specHash: 'spec-2', prompt: { raw: 'AI tools that help with coding' } }));
    const all = textsEmbedded();
    expect(all.filter((t) => t === BACKGROUND_CORPUS[0])).toHaveLength(1);
    expect(all.filter((t) => t === PROMPT)).toHaveLength(1);
    expect(all.filter((t) => t === 'AI tools that help with coding')).toHaveLength(1);
    expect(scorer.stats().prepares).toBe(2);
    expect(scorer.stats().preparedSpecs).toBe(2);
  });

  test('concurrent decides with the same spec share one preparation', async () => {
    const { embed, textsEmbedded } = fakeEmbed();
    const scorer = createSystem1Scorer({ embed, calibration: calibration(), modelSpec: MINILM });
    await Promise.all([scorer.decideItems(POSTS.slice(0, 1), spec()), scorer.decideItems(POSTS.slice(1), spec())]);
    expect(textsEmbedded().filter((t) => t === PROMPT)).toHaveLength(1);
    expect(scorer.stats().prepares).toBe(1);
  });

  test('answers only the questions asked (or derives them from prompt and tags)', async () => {
    const { embed } = fakeEmbed();
    const scorer = createSystem1Scorer({ embed, calibration: calibration(), modelSpec: MINILM });
    const [onlyMatch] = await scorer.decideItems(POSTS.slice(0, 1), spec({ specHash: 'm', questions: [Q.MATCHES_PROMPT] }));
    expect(Object.keys(onlyMatch.answers)).toEqual([Q.MATCHES_PROMPT]);
    const [onlyTag] = await scorer.decideItems(POSTS.slice(0, 1), spec({ specHash: 't', questions: { [Q.PRIMARY_TAG]: {} } }));
    expect(onlyTag.answers[Q.MATCHES_PROMPT]).toBeUndefined();
    expect(onlyTag.answers[Q.PRIMARY_TAG]).toBeDefined();
    const [derived] = await scorer.decideItems(POSTS.slice(0, 1), { prompt: { raw: '' }, tags: TAGS });
    expect(derived.answers[Q.MATCHES_PROMPT]).toBeUndefined();
    expect(derived.answers[Q.PRIMARY_TAG]).toBeDefined();
  });

  test('chunks long posts and max-pools over the chunks; empty text is an item error', async () => {
    const { embed, calls } = fakeEmbed();
    const scorer = createSystem1Scorer({ embed, calibration: calibration({ chunk: { maxChars: 60 } }), modelSpec: MINILM });
    const long = 'The weather was grey all week. '.repeat(3) + 'Our chef earned a Michelin star for the tasting menu.';
    const chunks = scorer.postChunks(long);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks).toEqual(S1.chunkText(long, { maxChars: 60 }));
    const [r, empty] = await scorer.decideItems([{ id: 'x', text: long }, { id: 'y', text: '   ' }], spec());
    expect(calls.some((c) => !c.isQuery && c.texts.length === new Set(chunks).size && chunks.every((t) => c.texts.includes(t)))).toBe(true);
    expect(r.answers).toEqual(expectedAnswers(calibration({ chunk: { maxChars: 60 } }), { text: long }, spec()));
    expect(empty).toEqual({ id: 'y', error: 'empty_text', ms: 0 });
  });

  test('a failing post embedding is an item error; a failing preparation rejects and is retried next time', async () => {
    let fail = 'post';
    const embed = async (texts, { isQuery }) => {
      if (fail === 'post' && !isQuery && texts.includes(POSTS[1].text)) throw Object.assign(new Error('boom'), { code: 's1_embed_error' });
      if (fail === 'query' && isQuery) throw new Error('model gone');
      return texts.map(vectorFor);
    };
    const scorer = createSystem1Scorer({ embed, calibration: calibration(), modelSpec: MINILM });
    const results = await scorer.decideItems(POSTS, spec());
    expect(results[0].answers).toBeDefined();
    expect(results[1]).toMatchObject({ id: 'b', error: 's1_embed_error' });
    expect(results[2].answers).toBeDefined();

    fail = 'query';
    await expect(scorer.decideItems(POSTS, spec({ specHash: 'other' }))).rejects.toThrow('model gone');
    fail = null;
    const ok = await scorer.decideItems(POSTS.slice(0, 1), spec({ specHash: 'other' }));
    expect(ok[0].answers[Q.MATCHES_PROMPT]).toBeDefined();
  });

  test('rejects malformed vectors from embed', async () => {
    const scorer = createSystem1Scorer({ embed: async (texts) => texts.map(() => [1, 0]), calibration: calibration(), modelSpec: MINILM });
    await expect(scorer.warm()).rejects.toMatchObject({ code: 's1_embed_error' });
    const short = createSystem1Scorer({ embed: async () => [], calibration: calibration(), modelSpec: MINILM });
    await expect(short.warm()).rejects.toMatchObject({ code: 's1_embed_error' });
  });

  test('exposes calibrationId and floor', () => {
    const scorer = createSystem1Scorer({ embed: fakeEmbed().embed, calibration: calibration(), modelSpec: MINILM });
    expect(scorer.calibrationId).toBe(`minilm.q8@${CORPUS_HASH}`);
    expect(calibrationIdOf({ model: 'bge-small', dtype: 'q8' })).toBe(`bge-small.q8@${CORPUS_HASH}`);
    expect(scorer.floor).toEqual({ matches_prompt: 0.7, primary_tag: 0.3 });
  });
});

describe('validateCalibration', () => {
  test('refuses a calibration fitted for another model, corpus or prefix', () => {
    expect(() => validateCalibration(calibration(), { modelSpec: MODEL_REGISTRY['bge-small'] })).toThrow(/fitted for minilm/);
    expect(() => validateCalibration(calibration({ corpusHash: 'deadbeef' }), { modelSpec: MODEL_REGISTRY.minilm })).toThrow(/background corpus changed/);
    expect(() => validateCalibration(calibration({ queryPrefix: 'query: ' }), { modelSpec: MODEL_REGISTRY.minilm })).toThrow(/prefix/);
    expect(() => validateCalibration(calibration({ match: {} }))).toThrow(/match/);
    expect(() => validateCalibration(null)).toThrow(/no calibration/);
    try {
      validateCalibration(null);
    } catch (err) {
      expect(err.code).toBe('calibration_mismatch');
    }
    expect(() => createSystem1Scorer({ embed: fakeEmbed().embed, calibration: calibration({ corpusHash: 'x' }) })).toThrow(/corpus/);
  });

  test.each(Object.keys(MODEL_REGISTRY))('the bundled %s calibration fits the registry and the current background corpus', (key) => {
    const spec = MODEL_REGISTRY[key];
    const cal = JSON.parse(fs.readFileSync(new URL(`../../lib/decision/calibration/${key}.${spec.dtype}.json`, import.meta.url), 'utf8'));
    expect(() => validateCalibration(cal, { modelSpec: spec })).not.toThrow();
    expect(cal.corpusHash).toBe(CORPUS_HASH);
    expect(cal.floor.matches_prompt).toBeGreaterThan(0);
  });
});
