/**
 * Drafted by Engineering for 🧪 Testing review (ENG-1, prompt lenses; docs/team/engineering-goals.md).
 *
 * System 1 side of lenses: a lens is scored with the matches_prompt recipe and `calibration.match`
 * (never the tag noul, never the tag softmax), one prompt vector per lens against the SAME post
 * vectors, and the provider forwards lens question ids and prompts to the offscreen host.
 */
import { describe, test, expect } from 'vitest';
import { createSystem1Scorer } from '../../lib/decision/system1-scorer.js';
import * as S1 from '../../lib/decision/system1-math.js';
import { BACKGROUND_CORPUS } from '../../lib/decision/background-corpus.js';
import { MODEL_REGISTRY } from '../../lib/decision/models.js';
import { cleanPrompt } from '../../lib/decision/questions.js';
import { Q } from '../../lib/decision/types.js';
import { createLocalSystem1 } from '../../lib/decision/providers/local-system1.js';

const DIMS = 24;
const CORPUS_HASH = S1.hashTexts([...BACKGROUND_CORPUS]);

/** Deterministic unit vector per text; texts that mention a topic share a direction with its prompt. */
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
  const dir = (re, i) => (re.test(text) ? 1.5 : 0) * (i === 0 ? 1 : 0);
  const food = /restaurant|chef|michelin|food|dining|menu/i;
  const chess = /chess|opening|tournament|gambit/i;
  const v = Array.from({ length: DIMS }, (_, i) => rand() + dir(food, i) + (chess.test(text) && i === 1 ? 1.5 : 0));
  const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0));
  return v.map((x) => x / n);
}

function fakeEmbed() {
  const calls = [];
  return {
    calls,
    embed: async (texts, opts) => {
      calls.push({ texts: [...texts], isQuery: opts?.isQuery });
      return texts.map(vectorFor);
    }
  };
}

function calibration(over = {}) {
  return {
    model: 'minilm', dtype: 'q8', pooling: 'mean', queryPrefix: '', recipe: 'B', labelTemplate: 'about', labelAnchors: 'single', labelPrefix: false,
    chunk: { maxChars: 800, pool: 'max' },
    match: { a: 0.9, b: -2, bgTrim: 0.1, minStd: 0.02 },
    // The tag calibration is deliberately different from the match one: a lens scored with it would not equal matches_prompt.
    tag: { score: 'raw', agg: 'max', lexical: { beta: 0.2, cap: 3 }, T: 0.05, noneSim: 0.2, multi: { a: 2.1, b: 3 } },
    floor: { matches_prompt: 0.7, primary_tag: 0.3 },
    corpusHash: CORPUS_HASH,
    ...over
  };
}

const MINILM = { ...MODEL_REGISTRY.minilm, dims: DIMS };
const FOOD_PROMPT = 'find me restaurant and 5 star quality food posts. I am fascinated by michelin star cooking';
const CHESS_PROMPT = 'Find posts about chess openings and tournaments.';
const promptOf = (raw) => ({ raw, cleaned: cleanPrompt(raw), expansion: '' });
const POSTS = [
  { id: 'a', text: 'Our chef earned a Michelin star for the new tasting menu at the restaurant.' },
  { id: 'b', text: 'The Sicilian opening is a sharp choice at the chess tournament this weekend.' },
  { id: 'c', text: 'We are hiring a remote backend engineer.' }
];

describe('scorer: lens:<id> questions', () => {
  test('a lens score equals matches_prompt for the same prompt text (same recipe, same calibration)', async () => {
    const { embed } = fakeEmbed();
    const scorer = createSystem1Scorer({ embed, calibration: calibration(), modelSpec: MINILM });
    const results = await scorer.decideItems(POSTS, {
      specHash: 's1',
      prompt: promptOf(FOOD_PROMPT),
      tags: [{ label: 'Jobs', description: 'job postings, hiring' }],
      questions: { [Q.MATCHES_PROMPT]: true, [Q.PRIMARY_TAG]: true, 'lens:t_food': true },
      lenses: [{ id: 't_food', qid: 'lens:t_food', prompt: promptOf(FOOD_PROMPT) }]
    });
    for (const r of results) {
      expect(r.answers['lens:t_food']).toBeDefined();
      expect(r.answers['lens:t_food'].noul).toBe(r.answers[Q.MATCHES_PROMPT].noul);
      expect(r.answers['lens:t_food']).toEqual(r.answers[Q.MATCHES_PROMPT]);
    }
  });

  test('a lens is scored with calibration.match, not with the tag noul', async () => {
    const { embed } = fakeEmbed();
    const cal = calibration();
    const scorer = createSystem1Scorer({ embed, calibration: cal, modelSpec: MINILM });
    const [r] = await scorer.decideItems([POSTS[1]], {
      specHash: 's2',
      prompt: promptOf(''),
      tags: [{ label: 'Chess', description: 'chess openings and tournaments' }],
      questions: { 'lens:t_chess': true, [Q.PRIMARY_TAG]: true },
      lenses: [{ id: 't_chess', qid: 'lens:t_chess', prompt: promptOf(CHESS_PROMPT) }]
    });
    // By hand: the match recipe over the lens prompt's recipe-B query vectors.
    const bg = BACKGROUND_CORPUS.map(vectorFor);
    const queries = S1.queryTextsForRecipe('B', promptOf(CHESS_PROMPT), '').map(vectorFor);
    const stats = queries.map((q) => S1.bgStatsFor(q, bg, { trim: cal.match.bgTrim }));
    const post = S1.chunkText(POSTS[1].text, { maxChars: 800 }).map(vectorFor);
    const { match } = S1.scoreEmbeddings({ postVecs: post, queryVec: queries, bgStats: stats });
    const want = 1 / (1 + Math.exp(-(cal.match.a * match.z + cal.match.b)));
    expect(r.answers['lens:t_chess'].noul).toBeCloseTo(want, 10);
    // The tag noul of the same text (its own calibration and label vectors) is a different number.
    expect(r.answers['tag:Chess']?.noul).not.toBeCloseTo(want, 3);
  });

  test('two lenses: each gets its own prompt vectors; the post is embedded once; no second post embedding per lens', async () => {
    const { embed, calls } = fakeEmbed();
    const scorer = createSystem1Scorer({ embed, calibration: calibration(), modelSpec: MINILM });
    const spec = {
      specHash: 's3',
      prompt: promptOf(FOOD_PROMPT),
      tags: [],
      questions: { [Q.MATCHES_PROMPT]: true, 'lens:t_chess': true, 'lens:t_other': true },
      lenses: [
        { id: 't_chess', qid: 'lens:t_chess', prompt: promptOf(CHESS_PROMPT) },
        { id: 't_other', qid: 'lens:t_other', prompt: promptOf('Find posts about gardening and tomatoes.') }
      ]
    };
    const [r] = await scorer.decideItems([POSTS[1]], spec);
    expect(r.answers['lens:t_chess'].noul).toBeGreaterThan(r.answers[Q.MATCHES_PROMPT].noul);
    expect(r.answers['lens:t_chess'].noul).toBeGreaterThan(r.answers['lens:t_other'].noul);
    expect(calls.filter((c) => !c.isQuery && c.texts.includes(POSTS[1].text))).toHaveLength(1);
    // Prompt vectors are embedded once per spec, however many posts follow.
    await scorer.decideItems([POSTS[0]], spec);
    const queryTexts = calls.filter((c) => c.isQuery).flatMap((c) => c.texts);
    expect(queryTexts.filter((t) => t === CHESS_PROMPT)).toHaveLength(1);
  });

  test('the prepared spec is keyed by specHash and a lens-free spec answers no lens', async () => {
    const { embed } = fakeEmbed();
    const scorer = createSystem1Scorer({ embed, calibration: calibration(), modelSpec: MINILM });
    const [r] = await scorer.decideItems([POSTS[0]], { specHash: 's4', prompt: promptOf(FOOD_PROMPT), tags: [], questions: [Q.MATCHES_PROMPT] });
    expect(Object.keys(r.answers)).toEqual([Q.MATCHES_PROMPT]);
  });

  test('a lens question without a prompt in spec.lenses is not answered', async () => {
    const { embed } = fakeEmbed();
    const scorer = createSystem1Scorer({ embed, calibration: calibration(), modelSpec: MINILM });
    const [r] = await scorer.decideItems([POSTS[0]], { specHash: 's5', prompt: promptOf(''), tags: [], questions: { 'lens:t_x': true }, lenses: [] });
    expect(r.answers).toEqual({});
  });
});

describe('local System 1 provider forwards the lens questions', () => {
  test('S1_DECIDE carries the lens question ids and their prompts', async () => {
    const calls = [];
    const client = {
      async sendToOffscreen(type, payload) {
        calls.push({ type, payload });
        if (type === 'S1_LOAD') return { ok: true, model: payload.model, device: 'wasm', loadMs: 1, calibrationId: 'minilm.q8@x', floor: null };
        if (type === 'S1_DECIDE') {
          return { ok: true, model: payload.model, ms: 1, results: payload.items.map((it) => ({ id: it.id, answers: { 'lens:t_chess': { type: 'noul', noul: 0.7, confidence: 0.4, source: 'system1' } }, ms: 1 })) };
        }
        return { ok: true };
      }
    };
    const provider = createLocalSystem1({ client, getConfig: () => ({ system1: { model: 'minilm' } }), batchWindowMs: 1 });
    const lenses = [{ id: 't_chess', qid: 'lens:t_chess', prompt: promptOf(CHESS_PROMPT) }];
    const { results } = await provider.decideBatch({
      items: [{ id: '0', text: POSTS[1].text }],
      questions: { 'lens:t_chess': { type: 'noul' }, other_question: {} },
      specHash: 'h',
      context: { prompt: { raw: '', cleaned: '', expansion: '' }, tags: [], lenses }
    });
    const decide = calls.find((c) => c.type === 'S1_DECIDE');
    expect(decide.payload.spec.questions).toEqual(['lens:t_chess']);
    expect(decide.payload.spec.lenses).toEqual(lenses);
    expect(results[0].answers['lens:t_chess'].noul).toBe(0.7);
  });

  test('without lenses the spec sent to the host is unchanged (no lenses key)', async () => {
    const calls = [];
    const client = {
      async sendToOffscreen(type, payload) {
        calls.push({ type, payload });
        if (type === 'S1_LOAD') return { ok: true, model: payload.model, device: 'wasm', loadMs: 1, calibrationId: 'minilm.q8@x', floor: null };
        return { ok: true, model: payload.model, ms: 1, results: payload.items.map((it) => ({ id: it.id, answers: {}, ms: 1 })) };
      }
    };
    const provider = createLocalSystem1({ client, getConfig: () => ({ system1: { model: 'minilm' } }), batchWindowMs: 1 });
    await provider.decideBatch({ items: [{ id: '0', text: 'x' }], questions: { [Q.MATCHES_PROMPT]: {} }, specHash: 'h', context: { prompt: promptOf('p'), tags: [] } });
    expect('lenses' in calls.find((c) => c.type === 'S1_DECIDE').payload.spec).toBe(false);
  });
});
