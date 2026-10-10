import { describe, test, expect } from 'vitest';
import {
  dot,
  cosine,
  pooledSimilarity,
  chunkText,
  stripInstruction,
  labelText,
  descriptionItems,
  labelAnchorTexts,
  aggregateSims,
  labelSimilarity,
  labelBgStatsFor,
  lexStem,
  lexTerms,
  labelLexTerms,
  lexicalOverlap,
  queryTextsForRecipe,
  hashTexts,
  bgStats,
  bgStatsFor,
  zScore,
  noulFromSim,
  choiceFromSims,
  scoreEmbeddings,
  decideFromEmbeddings,
  MIN_BG_STD
} from '../../lib/decision/system1-math.js';
import { choiceConfidence, sigmoid } from '../../lib/decision/confidence.js';
import { Q } from '../../lib/decision/types.js';
import { BACKGROUND_CORPUS } from '../../lib/decision/background-corpus.js';

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const unit = (v) => {
  const n = Math.sqrt(dot(v, v));
  return v.map((x) => x / n);
};

describe('vectors', () => {
  test('dot and cosine', () => {
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(32);
    expect(cosine([1, 0], [2, 0])).toBeCloseTo(1, 12);
    expect(cosine([1, 0], [0, 3])).toBeCloseTo(0, 12);
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1, 12);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });

  test('pooledSimilarity takes the best chunk', () => {
    const q = [1, 0, 0];
    expect(pooledSimilarity([[0, 1, 0], unit([1, 1, 0]), [1, 0, 0]], q)).toBeCloseTo(1, 12);
    expect(pooledSimilarity([[0, 1, 0]], q)).toBeCloseTo(0, 12);
    expect(pooledSimilarity([], q)).toBe(-1);
  });
});

describe('chunkText', () => {
  const sentence = (i, len) => `Sentence ${i} ${'word '.repeat(Math.max(0, Math.floor((len - 14) / 5)))}`.trim() + '.';

  test('returns short text as a single trimmed chunk and empty text as no chunks', () => {
    expect(chunkText('  Hello world.\nSecond line.  ')).toEqual(['Hello world.\nSecond line.']);
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   ')).toEqual([]);
    expect(chunkText(undefined)).toEqual([]);
  });

  test('splits long text at sentence boundaries within maxChars and keeps every word in order', () => {
    const text = Array.from({ length: 12 }, (_, i) => sentence(i, 150)).join(' ');
    const chunks = chunkText(text, { maxChars: 400 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(400);
      expect(c.endsWith('.')).toBe(true);
    }
    expect(chunks.join(' ').split(/\s+/)).toEqual(text.split(/\s+/));
  });

  test('breaks at line breaks too', () => {
    const text = `${'a '.repeat(150).trim()}\n${'b '.repeat(150).trim()}\n${'c '.repeat(150).trim()}`;
    const chunks = chunkText(text, { maxChars: 400 });
    expect(chunks.every((c) => c.length <= 400)).toBe(true);
    expect(chunks.some((c) => c.startsWith('b'))).toBe(true);
  });

  test('balances chunk sizes instead of leaving a tiny tail', () => {
    const text = Array.from({ length: 9 }, (_, i) => sentence(i, 100)).join(' ');
    const chunks = chunkText(text, { maxChars: 800 });
    expect(chunks.length).toBe(2);
    expect(Math.min(...chunks.map((c) => c.length))).toBeGreaterThan(300);
  });

  test('splits an oversized sentence at word boundaries and hard-cuts a giant token', () => {
    const longSentence = `${'lorem '.repeat(300).trim()}.`;
    const chunks = chunkText(longSentence, { maxChars: 200 });
    expect(chunks.every((c) => c.length <= 200)).toBe(true);
    expect(chunks.every((c) => /^(lorem ?)+\.?$/.test(c))).toBe(true);
    const giant = 'x'.repeat(1000);
    const cut = chunkText(giant, { maxChars: 300 });
    expect(cut.every((c) => c.length <= 300)).toBe(true);
    expect(cut.join('')).toBe(giant);
  });

  test('defaults to 800 characters', () => {
    const text = Array.from({ length: 30 }, (_, i) => sentence(i, 100)).join(' ');
    expect(chunkText(text).every((c) => c.length <= 800)).toBe(true);
  });
});

describe('text helpers', () => {
  test('stripInstruction removes the tag-description lead-in', () => {
    expect(stripInstruction('Identify posts related to health, medicine, or nutrition.')).toBe('health, medicine, or nutrition.');
    expect(stripInstruction('Identify advertisements, sponsored content, or promotional codes.')).toBe('advertisements, sponsored content, or promotional codes.');
    expect(stripInstruction('Identify references to blog articles or long-form posts.')).toBe('blog articles or long-form posts.');
    expect(stripInstruction('Restaurants and chefs')).toBe('Restaurants and chefs');
  });

  test('labelText templates and prefix', () => {
    const d = 'Identify posts related to athletic sports, games, or leagues.';
    expect(labelText('Sports', d, 'about')).toBe('This post is about athletic sports, games, or leagues.');
    expect(labelText('Sports', d, 'raw')).toBe(d);
    expect(labelText('Sports', d, 'label')).toBe('Sports: athletic sports, games, or leagues.');
    expect(labelText('Sports', d, 'about', 'Q: ')).toBe('Q: This post is about athletic sports, games, or leagues.');
    expect(labelText('Cats', '', 'about')).toBe('This post is about Cats.');
  });

  test('descriptionItems splits the topical list', () => {
    expect(descriptionItems('Identify posts related to health, medicine, doctors, or nutrition.')).toEqual(['health', 'medicine', 'doctors', 'nutrition']);
    expect(descriptionItems('Identify posts related to relocation, moving to another region or country, expats, or emigration.')).toEqual([
      'relocation',
      'moving to another region or country',
      'expats',
      'emigration'
    ]);
    expect(descriptionItems('Restaurant openings and chef interviews')).toEqual(['Restaurant openings and chef interviews']);
    expect(descriptionItems('')).toEqual([]);
    expect(descriptionItems('a, b, c, d, e, f, g, h, i, j, k'.replace(/\w/g, (c) => c.repeat(3)), 3)).toHaveLength(3);
  });

  test('labelAnchorTexts builds single, items and all anchors', () => {
    const d = 'Identify posts related to sports, leagues, or coaches.';
    expect(labelAnchorTexts('Sports', d)).toEqual(['This post is about sports, leagues, or coaches.']);
    expect(labelAnchorTexts('Sports', d, { anchors: 'items' })).toEqual([
      'This post is about sports, leagues, or coaches.',
      'This post is about sports.',
      'This post is about leagues.',
      'This post is about coaches.'
    ]);
    const all = labelAnchorTexts('Sports', d, { anchors: 'all', template: 'raw', prefix: 'Q: ' });
    expect(all[0]).toBe(`Q: ${d}`);
    expect(all.at(-1)).toBe('Q: This post is about Sports.');
    expect(all.every((t) => t.startsWith('Q: '))).toBe(true);
  });

  test('queryTextsForRecipe', () => {
    const prompt = { raw: 'find me food posts', cleaned: 'food', expansion: 'restaurants and chefs' };
    expect(queryTextsForRecipe('A', prompt)).toEqual(['find me food posts']);
    expect(queryTextsForRecipe('B', prompt)).toEqual(['find me food posts', 'food']);
    expect(queryTextsForRecipe('C', prompt)).toEqual(['food: restaurants and chefs']);
    expect(queryTextsForRecipe('D', prompt)).toEqual(['find me food posts', 'food', 'food: restaurants and chefs']);
    expect(queryTextsForRecipe('B', prompt, 'P: ')).toEqual(['P: find me food posts', 'P: food']);
    // No expansion: C falls back to B; identical raw/cleaned collapse to one text.
    expect(queryTextsForRecipe('C', { raw: 'climate news', cleaned: 'climate news' })).toEqual(['climate news']);
    expect(queryTextsForRecipe('B', { raw: 'climate news' })).toEqual(['climate news']);
  });

  test('hashTexts is deterministic and content-sensitive', () => {
    expect(hashTexts(['a', 'b'])).toBe(hashTexts(['a', 'b']));
    expect(hashTexts(['a', 'b'])).not.toBe(hashTexts(['ab']));
    expect(hashTexts(['a', 'b'])).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('bgStats', () => {
  test('trims both tails before computing mean and std', () => {
    const sims = [...Array.from({ length: 16 }, (_, i) => 0.3 + (i % 4) * 0.02), 0.95, 0.99, -0.8, -0.9];
    const trimmed = bgStats(sims, { trim: 0.1 });
    expect(trimmed.mean).toBeCloseTo(0.33, 10);
    expect(trimmed.std).toBeCloseTo(Math.sqrt(0.0005), 10);
    const untrimmed = bgStats(sims, { trim: 0 });
    expect(untrimmed.std).toBeGreaterThan(0.3);
  });

  test('floors the standard deviation', () => {
    expect(bgStats([0.5, 0.5, 0.5, 0.5])).toEqual({ mean: 0.5, std: MIN_BG_STD });
    expect(bgStats([0.5, 0.501], { minStd: 0.1 }).std).toBe(0.1);
    expect(bgStats([])).toEqual({ mean: 0, std: MIN_BG_STD });
  });

  test('ignores non-finite values and keeps at least two values when trimming tiny samples', () => {
    expect(bgStats([0.2, NaN, 0.4, Infinity]).mean).toBeCloseTo(0.3, 12);
    expect(bgStats([0.1, 0.2, 0.3], { trim: 0.45 }).mean).toBeCloseTo(0.2, 12);
  });

  test('bgStatsFor compares a query with background vectors', () => {
    const st = bgStatsFor([1, 0], [[1, 0], [0, 1], unit([1, 1]), [0, 1]], { trim: 0 });
    expect(st.mean).toBeCloseTo((1 + 0 + Math.SQRT1_2 + 0) / 4, 12);
  });
});

describe('noulFromSim', () => {
  const stats = { mean: 0.4, std: 0.05 };

  test('z-scores against the background and applies the Platt sigmoid', () => {
    const { p, z } = noulFromSim(0.5, stats, { a: 2, b: -3 });
    expect(z).toBeCloseTo(2, 12);
    expect(p).toBeCloseTo(sigmoid(2 * 2 - 3), 12);
    expect(noulFromSim(stats.mean, stats, { a: 1.7, b: -1 }).p).toBeCloseTo(sigmoid(-1), 12);
    expect(zScore(0.3, stats)).toBeCloseTo(-2, 12);
  });

  test('is monotonic increasing in similarity for a > 0', () => {
    let prev = -1;
    for (let s = -0.2; s <= 1; s += 0.05) {
      const { p } = noulFromSim(s, stats, { a: 1.3, b: -4 });
      expect(p).toBeGreaterThanOrEqual(prev);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
      prev = p;
    }
  });
});

describe('choiceFromSims', () => {
  const sims = { Health: 0.62, Jobs: 0.55, Sports: 0.4 };

  test('probabilities include none and sum to 1', () => {
    const r = choiceFromSims(sims, { T: 0.05, noneSim: 0.5 });
    expect(Object.keys(r.probabilities).sort()).toEqual(['Health', 'Jobs', 'Sports', 'none']);
    expect(sum(Object.values(r.probabilities))).toBeCloseTo(1, 12);
    expect(r.choice).toBe('Health');
    expect(r.confidence).toBeCloseTo(choiceConfidence(r.probabilities), 12);
    expect(r.ranked.map(([l]) => l)).toEqual(['Health', 'Jobs', 'none', 'Sports']);
  });

  test('returns null when the none anchor wins', () => {
    const r = choiceFromSims(sims, { T: 0.05, noneSim: 0.7 });
    expect(r.choice).toBeNull();
    expect(r.probabilities.none).toBeGreaterThan(r.probabilities.Health);
    expect(sum(Object.values(r.probabilities))).toBeCloseTo(1, 12);
  });

  test('without a none anchor, none is present with probability 0', () => {
    const r = choiceFromSims(sims, { T: 0.05 });
    expect(r.probabilities.none).toBe(0);
    expect(r.choice).toBe('Health');
    expect(sum(Object.values(r.probabilities))).toBeCloseTo(1, 12);
  });

  test('a lower temperature makes the choice more confident', () => {
    const hot = choiceFromSims(sims, { T: 0.5, noneSim: 0.3 });
    const cold = choiceFromSims(sims, { T: 0.02, noneSim: 0.3 });
    expect(cold.confidence).toBeGreaterThan(hot.confidence);
    expect(cold.choice).toBe(hot.choice);
  });

  test('handles no labels and non-finite scores', () => {
    const empty = choiceFromSims({}, { T: 0.05, noneSim: 0 });
    expect(empty.choice).toBeNull();
    expect(empty.probabilities).toEqual({ none: 1 });
    const empty2 = choiceFromSims({}, { T: 0.05 });
    expect(empty2.probabilities).toEqual({ none: 1 });
    const bad = choiceFromSims({ A: NaN, B: 0.3 }, { T: 0.05, noneSim: 0 });
    expect(bad.choice).toBe('B');
    expect(bad.probabilities.A).toBeCloseTo(0, 12);
    expect(sum(Object.values(bad.probabilities))).toBeCloseTo(1, 12);
  });
});

describe('label anchors', () => {
  test('aggregateSims', () => {
    expect(aggregateSims([0.2, 0.8, 0.5])).toBe(0.8);
    expect(aggregateSims([0.2, 0.8, 0.5], 'mean')).toBeCloseTo(0.5, 12);
    expect(aggregateSims([0.2, 0.8, 0.5], 'top2')).toBeCloseTo(0.65, 12);
    expect(aggregateSims([0.3], 'top2')).toBe(0.3);
    expect(aggregateSims([])).toBe(-1);
  });

  test('labelSimilarity accepts one vector or several anchors', () => {
    const post = [[1, 0, 0]];
    expect(labelSimilarity(post, [1, 0, 0])).toBeCloseTo(1, 12);
    expect(labelSimilarity(post, [[0, 1, 0], [1, 0, 0]], 'max')).toBeCloseTo(1, 12);
    expect(labelSimilarity(post, [[0, 1, 0], [1, 0, 0]], 'mean')).toBeCloseTo(0.5, 12);
  });

  test('labelBgStatsFor uses the same aggregation as labelSimilarity', () => {
    const anchors = [[1, 0], [0, 1]];
    const bg = [[1, 0], [0, 1], unit([1, 1])];
    const maxStats = labelBgStatsFor(anchors, bg, { trim: 0, agg: 'max' });
    expect(maxStats.mean).toBeCloseTo((1 + 1 + Math.SQRT1_2) / 3, 12);
    const meanStats = labelBgStatsFor(anchors, bg, { trim: 0, agg: 'mean' });
    expect(meanStats.mean).toBeCloseTo((0.5 + 0.5 + Math.SQRT1_2) / 3, 12);
  });
});

describe('lexical overlap', () => {
  test('lexStem trims plurals, -ing and -ed', () => {
    expect(lexStem('Stories')).toBe('story');
    expect(lexStem('webinars')).toBe('webinar');
    expect(lexStem('hiring')).toBe('hir');
    expect(lexStem('hired')).toBe('hir');
    expect(lexStem('class')).toBe('class');
    expect(lexStem("chef's")).toBe('chef');
  });

  test('lexTerms keeps distinct content words (NFKC, no stop words, length >= 3)', () => {
    const t = lexTerms('Join our 𝗪𝗲𝗯𝗶𝗻𝗮𝗿 on AI! The webinars are free, and so is the new update.');
    expect(t.has('webinar')).toBe(true);
    expect(t.has('join')).toBe(true);
    expect(t.has('free')).toBe(true);
    expect(t.has('the')).toBe(false);
    expect(t.has('update')).toBe(false);
    expect(t.has('ai')).toBe(false);
  });

  test('labelLexTerms uses the label and the topical part of the description', () => {
    const terms = labelLexTerms('Vlog', 'Identify video logs, YouTube clips, vlog updates, or video content updates.');
    expect([...terms].sort()).toEqual(['clip', 'content', 'log', 'video', 'vlog', 'youtube']);
  });

  test('lexicalOverlap counts distinct label terms and caps them', () => {
    const post = lexTerms('New vlog on my YouTube channel: a video about travel');
    const terms = labelLexTerms('Vlog', 'Identify video logs, YouTube clips, vlog updates, or video content updates.');
    expect(lexicalOverlap(post, terms, 3)).toBe(1);
    expect(lexicalOverlap(post, terms, 6)).toBeCloseTo(3 / 6, 12);
    expect(lexicalOverlap(lexTerms('nothing relevant'), terms)).toBe(0);
  });
});

describe('scoreEmbeddings / decideFromEmbeddings', () => {
  const q1 = [1, 0, 0, 0];
  const q2 = [0, 1, 0, 0];
  const post = [unit([0.2, 0.9, 0.1, 0]), unit([0.9, 0.1, 0, 0.1])];
  const statsA = { mean: 0.1, std: 0.1 };
  const statsB = { mean: 0.5, std: 0.1 };
  const labelVecs = { Food: unit([1, 0.2, 0, 0]), Tech: [0, 0, 1, 0], Sports: [0, 0, 0, 1] };
  const labelBgStats = { Food: { mean: 0.2, std: 0.1 }, Tech: { mean: 0.1, std: 0.1 }, Sports: { mean: 0.1, std: 0.1 } };
  const calibration = {
    match: { a: 1.5, b: -3, bgTrim: 0.1 },
    tag: { score: 'centered', T: 0.05, noneSim: 0.2, multi: { a: 1, b: -2 } },
    floor: { matches_prompt: 0.5, primary_tag: 0.3 }
  };

  test('several query vectors: the largest z wins', () => {
    const s = scoreEmbeddings({ postVecs: post, queryVec: [q1, q2], bgStats: [statsA, statsB] });
    const z1 = zScore(pooledSimilarity(post, q1), statsA);
    const z2 = zScore(pooledSimilarity(post, q2), statsB);
    expect(s.match.z).toBeCloseTo(Math.max(z1, z2), 12);
    const single = scoreEmbeddings({ postVecs: post, queryVec: q1, bgStats: statsA });
    expect(single.match.z).toBeCloseTo(z1, 12);
  });

  test('returns answers shaped like lib/decision/types.js', () => {
    const answers = decideFromEmbeddings({ postVecs: post, queryVec: [q1, q2], bgStats: [statsA, statsB], labelVecs, labelBgStats, calibration });
    const m = answers[Q.MATCHES_PROMPT];
    const z = Math.max(zScore(pooledSimilarity(post, q1), statsA), zScore(pooledSimilarity(post, q2), statsB));
    expect(m).toEqual({ type: 'noul', noul: sigmoid(1.5 * z - 3), confidence: Math.abs(2 * sigmoid(1.5 * z - 3) - 1), source: 'system1' });

    const t = answers[Q.PRIMARY_TAG];
    expect(t.type).toBe('choice');
    expect(t.source).toBe('system1');
    expect(t.choice).toBe('Food');
    expect(sum(Object.values(t.probabilities))).toBeCloseTo(1, 12);
    expect(t.probabilities).toHaveProperty('none');
    expect(t.confidence).toBeCloseTo(choiceConfidence(t.probabilities), 12);

    const tagKeys = Object.keys(answers).filter((k) => k.startsWith(Q.TAG_PREFIX));
    expect(tagKeys).toHaveLength(3);
    expect(tagKeys[0]).toBe(`${Q.TAG_PREFIX}Food`);
    expect(answers[`${Q.TAG_PREFIX}Food`].type).toBe('noul');
  });

  test('omits matches_prompt without a query and tag nouls without multi calibration', () => {
    const answers = decideFromEmbeddings({
      postVecs: post,
      labelVecs,
      labelBgStats,
      calibration: { ...calibration, tag: { score: 'raw', T: 0.05, noneSim: 1.5 } },
      options: { source: 'test' }
    });
    expect(answers[Q.MATCHES_PROMPT]).toBeUndefined();
    expect(answers[Q.PRIMARY_TAG].choice).toBeNull();
    expect(answers[Q.PRIMARY_TAG].source).toBe('test');
    expect(Object.keys(answers).filter((k) => k.startsWith(Q.TAG_PREFIX))).toHaveLength(0);
  });

  test('anchor labels are aggregated with calibration.tag.agg', () => {
    const anchored = { Food: [[0, 0, 1, 0], unit([1, 0.2, 0, 0])], Tech: [[0, 0, 1, 0]], Sports: [[0, 0, 0, 1]] };
    const cal = { ...calibration, tag: { score: 'raw', agg: 'max', T: 0.05, noneSim: -1 } };
    const viaMax = decideFromEmbeddings({ postVecs: post, labelVecs: anchored, calibration: cal });
    expect(viaMax[Q.PRIMARY_TAG].choice).toBe('Food');
    const s = scoreEmbeddings({ postVecs: post, labelVecs: anchored, labelAgg: 'mean' });
    expect(s.tags.Food.sim).toBeCloseTo((pooledSimilarity(post, anchored.Food[0]) + pooledSimilarity(post, anchored.Food[1])) / 2, 12);
  });

  test('the lexical term can flip a close call when calibration.tag.lexical is set', () => {
    const vecs = { Blog: [1, 0, 0, 0], Vlog: unit([1, 0.05, 0, 0]) };
    const postVecs = [[1, 0, 0, 0]];
    const labelTerms = { Blog: labelLexTerms('Blog', 'blog articles'), Vlog: labelLexTerms('Vlog', 'video logs, YouTube clips') };
    const base = { tag: { score: 'raw', T: 0.01, noneSim: -1 } };
    const args = { postVecs, labelVecs: vecs, postText: 'Watch the new video on YouTube', labelTerms };
    expect(decideFromEmbeddings({ ...args, calibration: base })[Q.PRIMARY_TAG].choice).toBe('Blog');
    const withLex = { tag: { ...base.tag, lexical: { beta: 0.05, cap: 3 } } };
    expect(decideFromEmbeddings({ ...args, calibration: withLex })[Q.PRIMARY_TAG].choice).toBe('Vlog');
    // Without the post text the lexical term is skipped.
    expect(decideFromEmbeddings({ ...args, postText: undefined, calibration: withLex })[Q.PRIMARY_TAG].choice).toBe('Blog');
  });

  test('tagNoulsTopK limits the per-tag nouls', () => {
    const answers = decideFromEmbeddings({ postVecs: post, labelVecs, labelBgStats, calibration, options: { tagNoulsTopK: 1 } });
    expect(Object.keys(answers).filter((k) => k.startsWith(Q.TAG_PREFIX))).toEqual([`${Q.TAG_PREFIX}Food`]);
  });
});

describe('BACKGROUND_CORPUS', () => {
  test('has 64 distinct non-empty posts', () => {
    expect(BACKGROUND_CORPUS).toHaveLength(64);
    expect(new Set(BACKGROUND_CORPUS).size).toBe(64);
    expect(BACKGROUND_CORPUS.every((t) => typeof t === 'string' && t.length > 40)).toBe(true);
  });
});
