#!/usr/bin/env node
/**
 * Offline evaluation and calibration of the local System 1 embedding classifier.
 *
 *   node eval/run-eval.mjs [--models bge-small,minilm] [--write-calibration] [--assert] [--batch N]
 *                          [--check-calibration] [--report <file.md>]
 *
 * For each model it embeds the golden set (eval/golden), the neutral background corpus, the prompt
 * query texts and the tag label texts (cached in eval/.cache), then:
 *  - matches_prompt: compares query recipes A/B/C/D, fits Platt scaling on background z-scores with
 *    leave-one-prompt-out (LOPO), and simulates escalation of the uncertain band to a perfect
 *    escalator to choose the confidence floor;
 *  - primary_tag: compares label phrasings and score modes, grid-searches temperature T and the
 *    `none` anchor with 5-fold cross-validation, fits multi-label tag nouls;
 *  - prints a rules-engine baseline (lib/inference-engine.js) and latency per text.
 * --write-calibration writes lib/decision/calibration/<model>.q8.json and eval/reference-vectors.json.
 * The Markdown report goes to eval/reports/<YYYY-MM-DD>-system1.md.
 * --assert exits non-zero unless at least one model passes every gate; the default model is the
 * smallest passing one.
 * --check-calibration compares the fitted calibration numbers with the committed
 * lib/decision/calibration/<model>.q8.json (the `report` block aside) and exits non-zero on a difference.
 * --report writes the Markdown report to another file.
 *
 * All scoring goes through lib/decision/system1-math.js. The deployed decision path (chunking,
 * query/label texts, background stats, decideFromEmbeddings) is lib/decision/system1-scorer.js, the
 * same module the offscreen host runs in the browser: the eval scores every golden post with it under
 * the fitted calibration and fails unless it reproduces the fitting code's numbers exactly.
 */
import fs from 'node:fs';
import path from 'node:path';
// First import: it picks the ONNX runtime Transformers.js runs on (see eval/lib/embed-node.mjs).
import { createEmbedder, ROOT, RUNTIME_LABEL } from './lib/embed-node.mjs';
import { normalizeForEval, cleanPrompt as cleanPromptForEval } from './lib/text.mjs';
import { auroc, ece, logLoss, fitPlatt, binaryStats, foldOf, mean, quantile, simulateEscalation } from './lib/metrics.mjs';
import * as S1 from '../lib/decision/system1-math.js';
import { createSystem1Scorer } from '../lib/decision/system1-scorer.js';
import { stableStringify } from '../lib/decision/state.js';
import { BACKGROUND_CORPUS } from '../lib/decision/background-corpus.js';
import { MODEL_REGISTRY } from '../lib/decision/models.js';
import { sigmoid } from '../lib/decision/confidence.js';
import { Q } from '../lib/decision/types.js';

// ---------------------------------------------------------------------------
// Settings (fixed before looking at results; never tuned on a held-out prompt)
// ---------------------------------------------------------------------------

const RECIPES = /** @type {const} */ (['A', 'B', 'C', 'D']);
/**
 * Recipes the deployed calibration may use. C and D need an LLM-written expansion, which exists only
 * when the browser's built-in model is available, so System 1 must not depend on them; they are
 * still evaluated and reported.
 */
const DEPLOYABLE_RECIPES = ['A', 'B'];
/** Tie-break order when recipes score the same on the training prompts (plan default first). */
const RECIPE_PREFERENCE = ['B', 'A', 'D', 'C'];
/** Label representations: one phrasing of the whole description, or several anchors aggregated. */
const TAG_VARIANTS = [
  { template: 'about', anchors: 'single', agg: 'max' },
  { template: 'raw', anchors: 'single', agg: 'max' },
  { template: 'label', anchors: 'single', agg: 'max' },
  { template: 'about', anchors: 'items', agg: 'max' },
  { template: 'about', anchors: 'items', agg: 'mean' },
  { template: 'about', anchors: 'items', agg: 'top2' },
  { template: 'about', anchors: 'all', agg: 'max' },
  { template: 'about', anchors: 'all', agg: 'mean' },
  { template: 'about', anchors: 'all', agg: 'top2' }
];
const TAG_MODES = /** @type {const} */ (['raw', 'centered', 'z']);
/** Lexical-overlap weights, in units of the config's score standard deviation (0 = embeddings only). */
const LEX_MULTS = [0, 0.5, 1, 2];
const LEX_CAP = 3;
const CHUNK_CHARS = S1.DEFAULT_CHUNK_CHARS;
const BG_TRIM = S1.DEFAULT_BG_TRIM;
const K_FOLDS = 5;
const FLOOR_STEPS = Array.from({ length: 50 }, (_, i) => +(i * 0.02).toFixed(2));
/** Floors are chosen on training data with a margin over the gate targets. */
const MATCH_FLOOR_TARGET = { precision: 0.95, recall: 0.9 };
const TAG_FLOOR_TARGET = 0.9;
const MAX_ESCALATION = 0.25;
const GATES = {
  restaurantAuroc: 0.9,
  privateMaxP: 0.5,
  falseFriendsMax: 2,
  escPrecision: 0.9,
  escRecall: 0.85,
  escRate: 0.25,
  tagTop1: 0.7,
  tagTop3: 0.9,
  ece: 0.08
};
const PLATFORM = 'www.linkedin.com';
/** Prompt tags the old GENERATE_PROMPT_TAGS produced for the restaurant prompt (seen in the user's export). */
const EXPORT_PROMPT_TAGS = ['5 Star Cooking', 'Food'];
const REFERENCE_SENTENCES = [
  { role: 'query', text: 'find me restaurant and 5 star quality food posts. I am fascinated by michelin star cooking' },
  { role: 'query', text: 'AI tools that help with coding' },
  { role: 'label', text: 'This post is about job postings, career opportunities, hiring, recruitment, resumes, or interviews.' },
  { role: 'passage', text: 'Chef Ingrid Solberg and her team have been awarded a third Michelin star for their tasting menu.' },
  { role: 'passage', text: 'We are hiring a remote backend engineer to build payment services in Go and Postgres.' },
  { role: 'passage', text: 'Hurricane warning issued for the Gulf Coast as the storm strengthens to Category 4.' },
  { role: 'passage', text: 'Our open-source code review bot just passed 10,000 stars on GitHub.' },
  { role: 'passage', text: 'Thrilled to share that our team just wrapped up a two-day planning offsite.' },
  // Invented sentences in the style of the export posts (the export's own text stays out of the repo).
  { role: 'passage', text: 'Great Trips Begin with Good Planning and the Proper Kit Changes Everything.' },
  { role: 'passage', text: 'Is it ever too late to pick up a second language? Most adults think so, and they are wrong.' }
];

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : def;
};
const MODEL_KEYS = opt('--models', Object.keys(MODEL_REGISTRY).join(','))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const WRITE = flag('--write-calibration');
const ASSERT = flag('--assert');
const CHECK_CALIBRATION = flag('--check-calibration');
const REPORT_PATH = opt('--report', '');
const BATCH = Math.max(1, Number(opt('--batch', '1')) || 1);
const log = (...a) => console.log(...a);

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const readJsonl = (file) =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
    : [];

const GOLDEN = path.join(ROOT, 'eval/golden');
const synthetic = readJsonl(path.join(GOLDEN, 'posts.synthetic.jsonl'));
const privatePosts = readJsonl(path.join(GOLDEN, 'posts.private.jsonl'));
const PROMPTS = JSON.parse(fs.readFileSync(path.join(GOLDEN, 'prompts.json'), 'utf8')).prompts;
const TAGS = JSON.parse(fs.readFileSync(path.join(GOLDEN, 'tags.json'), 'utf8')).tags;
const TAG_LABELS = TAGS.map((t) => t.label);
if (!synthetic.length) throw new Error('eval/golden/posts.synthetic.jsonl is missing or empty');

/** Prefer the extension's own normalizer once it exists, so the calibration sees what the extension embeds. */
let normalize = normalizeForEval;
let normalizerName = 'eval/lib/text.mjs normalizeForEval';
try {
  const state = await import('../lib/decision/state.js');
  if (typeof state.normalizeForDecision === 'function' && typeof state.normalizeForDecision('Post by x\nhello world') === 'string') {
    normalize = (t) => state.normalizeForDecision(t);
    normalizerName = 'lib/decision/state.js normalizeForDecision';
  }
} catch {
  // state.js not written yet (Phase 2) or broken mid-edit: use the eval mirror.
}

/** Same for prompt cleaning: the query text System 1 embeds comes from lib/decision/questions.js. */
let cleanPrompt = cleanPromptForEval;
let promptCleanerName = 'eval/lib/text.mjs cleanPrompt';
try {
  const questions = await import('../lib/decision/questions.js');
  if (typeof questions.cleanPrompt === 'function' && typeof questions.cleanPrompt('find me food posts') === 'string') {
    cleanPrompt = (t) => questions.cleanPrompt(t);
    promptCleanerName = 'lib/decision/questions.js cleanPrompt';
  }
} catch {
  // questions.js broken mid-edit: use the eval mirror.
}

const prepare = (p, isPrivate) => {
  const norm = normalize(p.text);
  return { ...p, isPrivate, norm, chunks: S1.chunkText(norm, { maxChars: CHUNK_CHARS }) };
};
const POSTS = synthetic.map((p) => prepare(p, false));
const PRIVATE = privatePosts.map((p) => prepare(p, true));
const ALL_POSTS = [...POSTS, ...PRIVATE];

const promptParts = (P) => ({ raw: P.text, cleaned: cleanPrompt(P.text), expansion: P.expansion || '' });
/** @returns {0|1|null} */
const ybin = (post, promptId) => (post.labels[promptId] === 'yes' ? 1 : post.labels[promptId] === 'no' ? 0 : null);
const truthTag = (post) => (post.primaryTag && post.primaryTag !== 'none' ? post.primaryTag : 'none');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const f3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : 'n/a');
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : 'n/a');
const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : 'n/a');
const std = (xs) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};
const table = (head, rows) =>
  [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
const pickBest = (candidates, score, order) =>
  candidates.slice().sort((a, b) => score(b) - score(a) || order.indexOf(a) - order.indexOf(b))[0];
const logAddExp = (a, b) => {
  const m = Math.max(a, b);
  return m + Math.log(Math.exp(a - m) + Math.exp(b - m));
};

/** Smallest floor meeting the targets on the given data; else the best F1 within the escalation cap. */
function chooseMatchFloor(probs, labels) {
  let fallback = null;
  for (const f of FLOOR_STEPS) {
    const sim = simulateEscalation(probs, labels, f);
    if (sim.escalationRate > MAX_ESCALATION) break;
    if (sim.precision >= MATCH_FLOOR_TARGET.precision && sim.recall >= MATCH_FLOOR_TARGET.recall) return { floor: f, sim, met: true };
    if (!fallback || sim.f1 > fallback.sim.f1) fallback = { floor: f, sim, met: false };
  }
  return fallback || { floor: 0, sim: simulateEscalation(probs, labels, 0), met: false };
}

/** Smallest choice-confidence floor giving TAG_FLOOR_TARGET accuracy after escalation; else best within the cap. */
function chooseTagFloor(confs, correct) {
  let fallback = null;
  for (const f of FLOOR_STEPS) {
    let esc = 0;
    let ok = 0;
    confs.forEach((c, i) => {
      if (c < f) {
        esc++;
        ok++;
      } else if (correct[i]) ok++;
    });
    const rate = esc / confs.length;
    const acc = ok / confs.length;
    if (rate > MAX_ESCALATION) break;
    if (acc >= TAG_FLOOR_TARGET) return { floor: f, accuracy: acc, escalationRate: rate, met: true };
    if (!fallback || acc > fallback.accuracy) fallback = { floor: f, accuracy: acc, escalationRate: rate, met: false };
  }
  return fallback || { floor: 0, accuracy: NaN, escalationRate: 0, met: false };
}

// ---------------------------------------------------------------------------
// Rules baseline (lib/inference-engine.js is being refactored concurrently: tolerate failures)
// ---------------------------------------------------------------------------

async function rulesBaseline() {
  const out = { ok: false, error: null, match: {}, tags: null };
  let engine;
  try {
    engine = await import('../lib/inference-engine.js');
  } catch (err) {
    out.error = `import failed: ${err?.message || err}`;
    return out;
  }
  const warn = console.warn;
  console.warn = () => {};
  try {
    const runs = PROMPTS.map((P) => ({ key: P.id, P, tags: [] }));
    runs.push({ key: 'restaurant+exportTags', P: PROMPTS.find((p) => p.id === 'restaurant'), tags: EXPORT_PROMPT_TAGS });
    for (const { key, P, tags } of runs) {
      const preds = [];
      const ys = [];
      let ffPass = 0;
      let privPass = 0;
      let errors = 0;
      for (const post of ALL_POSTS) {
        let match = false;
        try {
          const r = await engine.evaluateMatchWithReason(post.norm, PLATFORM, P.text, { matchPromptTags: tags });
          match = !!r?.doesMatch;
        } catch {
          errors++;
        }
        if (post.isPrivate) {
          if (match) privPass++;
          continue;
        }
        if (post.kind === 'false_friend' && match && ybin(post, P.id) === 0) ffPass++;
        const y = ybin(post, P.id);
        if (y === null) continue;
        preds.push(match);
        ys.push(y);
      }
      out.match[key] = { ...binaryStats(preds, ys), ffPass, privPass, errors };
    }
    let top1 = 0;
    let n = 0;
    const enabled = TAGS.map((t) => ({ label: t.label, prompt: t.description }));
    for (const post of POSTS) {
      if (truthTag(post) === 'none') continue;
      n++;
      try {
        const r = engine.keywordFallback(post.norm, enabled);
        const top = r?.tags?.[0]?.name || r?.category || 'none';
        if (top === post.primaryTag) top1++;
      } catch {
        // counted as a miss
      }
    }
    out.tags = { top1: top1 / Math.max(1, n), n };
    if (typeof engine.isSocialNoise === 'function') {
      const noise = POSTS.filter((p) => p.kind === 'noise');
      const other = ALL_POSTS.filter((p) => p.kind !== 'noise');
      out.prefilter = {
        caught: noise.filter((p) => engine.isSocialNoise(p.norm)).length,
        nNoise: noise.length,
        missed: noise.filter((p) => !engine.isSocialNoise(p.norm)).map((p) => p.id),
        falseHits: other.filter((p) => engine.isSocialNoise(p.norm)).map((p) => p.id),
        nOther: other.length
      };
    }
    out.ok = true;
  } catch (err) {
    out.error = err?.message || String(err);
  } finally {
    console.warn = warn;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-model evaluation
// ---------------------------------------------------------------------------

async function evaluateModel(modelKey) {
  const em = await createEmbedder(modelKey, { batchSize: BATCH, log });
  const spec = em.spec;
  const prefix = spec.queryPrefix || '';
  const labelPrefixOptions = prefix ? [false, true] : [false];

  // ---- Embed everything once (cached) -------------------------------------------------------
  const queryTexts = new Set();
  for (const P of PROMPTS) for (const R of RECIPES) S1.queryTextsForRecipe(R, promptParts(P), prefix).forEach((t) => queryTexts.add(t));
  const labelTexts = new Set();
  const anchorTexts = (t, v, lp) => S1.labelAnchorTexts(t.label, t.description, { template: v.template, anchors: v.anchors, prefix: lp ? prefix : '' });
  for (const v of TAG_VARIANTS) for (const lp of labelPrefixOptions) for (const t of TAGS) anchorTexts(t, v, lp).forEach((x) => labelTexts.add(x));
  const allTexts = [...new Set([...ALL_POSTS.flatMap((p) => p.chunks), ...BACKGROUND_CORPUS, ...queryTexts, ...labelTexts])];
  log(`${modelKey}: ${allTexts.length} distinct texts (${ALL_POSTS.reduce((a, p) => a + p.chunks.length, 0)} post chunks)`);
  const vectors = await em.embed(allTexts);
  const vecOf = new Map(allTexts.map((t, i) => [t, vectors[i]]));
  const vec = (t) => {
    const v = vecOf.get(t);
    if (!v) throw new Error(`missing embedding for: ${t.slice(0, 60)}`);
    return v;
  };
  const bgVecs = BACKGROUND_CORPUS.map(vec);
  const postVecsById = new Map(ALL_POSTS.map((p) => [p.id, p.chunks.map(vec)]));

  // ---- matches_prompt: z-scores per prompt x recipe ----------------------------------------
  /** @type {Record<string, Record<string, { zs: Record<string, number>, qTexts: string[], qStats: S1.BgStats[] }>>} */
  const M = {};
  for (const P of PROMPTS) {
    M[P.id] = {};
    for (const R of RECIPES) {
      const qTexts = S1.queryTextsForRecipe(R, promptParts(P), prefix);
      const qVecs = qTexts.map(vec);
      const qStats = qVecs.map((q) => S1.bgStatsFor(q, bgVecs, { trim: BG_TRIM }));
      const zs = {};
      for (const p of ALL_POSTS) zs[p.id] = S1.scoreEmbeddings({ postVecs: postVecsById.get(p.id), queryVec: qVecs, bgStats: qStats }).match.z;
      M[P.id][R] = { zs, qTexts, qStats };
    }
  }
  const labeled = (Pid) => POSTS.filter((p) => ybin(p, Pid) !== null);
  const aucOf = (Pid, R) => {
    const ps = labeled(Pid);
    return auroc(ps.map((p) => M[Pid][R].zs[p.id]), ps.map((p) => ybin(p, Pid)));
  };
  const AUC = Object.fromEntries(PROMPTS.map((P) => [P.id, Object.fromEntries(RECIPES.map((R) => [R, aucOf(P.id, R)]))]));
  const selectRecipe = (promptIds, candidates = RECIPES) => pickBest([...candidates], (R) => mean(promptIds.map((id) => AUC[id][R])), RECIPE_PREFERENCE);
  const fitMatch = (promptIds, R) => {
    const xs = [];
    const ys = [];
    for (const id of promptIds)
      for (const p of labeled(id)) {
        xs.push(M[id][R].zs[p.id]);
        ys.push(ybin(p, id));
      }
    return fitPlatt(xs, ys);
  };
  const probsOf = (Pid, R, platt, posts) => posts.map((p) => sigmoid(platt.a * M[Pid][R].zs[p.id] + platt.b));
  const floorFor = (promptIds, R, platt) => {
    const probs = [];
    const labels = [];
    for (const id of promptIds) {
      probs.push(...probsOf(id, R, platt, POSTS));
      labels.push(...POSTS.map((p) => ybin(p, id)));
    }
    return chooseMatchFloor(probs, labels);
  };

  /** Held-out metrics for one prompt under (R, platt, floor). */
  const heldOut = (P, R, platt, floor) => {
    const probs = probsOf(P.id, R, platt, POSTS);
    const labels = POSTS.map((p) => ybin(p, P.id));
    const idx = labels.map((l, i) => (l === null ? -1 : i)).filter((i) => i >= 0);
    const pL = idx.map((i) => probs[i]);
    const yL = idx.map((i) => /** @type {0|1} */ (labels[i]));
    const at05 = binaryStats(pL.map((p) => p >= 0.5), yL);
    const esc = simulateEscalation(probs, labels, floor);
    const ff = POSTS.map((p, i) => ({ p, prob: probs[i] })).filter(({ p }) => p.kind === 'false_friend' && ybin(p, P.id) === 0);
    const priv = PRIVATE.map((p) => ({ id: p.id, prob: sigmoid(platt.a * M[P.id][R].zs[p.id] + platt.b), y: ybin(p, P.id) }));
    const borderline = POSTS.map((p, i) => ({ p, prob: probs[i] })).filter(({ p }) => ybin(p, P.id) === null);
    return {
      recipe: R,
      platt: { a: platt.a, b: platt.b },
      floor,
      auroc: auroc(idx.map((i) => M[P.id][R].zs[POSTS[i].id]), yL),
      ece: ece(pL, yL),
      logLoss: logLoss(pL, yL),
      at05,
      esc,
      falseFriendsOver05: ff.filter((x) => x.prob > 0.5).length,
      noiseOver05: POSTS.map((p, i) => ({ p, prob: probs[i] })).filter(({ p, prob }) => p.kind === 'noise' && prob > 0.5).map(({ p }) => p.id),
      falseFriends: ff.map((x) => ({ id: x.p.id, p: x.prob })),
      privateMaxP: priv.length ? Math.max(...priv.filter((x) => x.y !== 1).map((x) => x.prob)) : NaN,
      private: priv,
      borderline: borderline.map((x) => ({ id: x.p.id, p: x.prob })),
      probs,
      labels,
      errors: POSTS.map((p, i) => ({ id: p.id, kind: p.kind, p: probs[i], y: labels[i] }))
        .filter((x) => x.y !== null && (x.p >= 0.5) !== (x.y === 1))
        .sort((a, b) => Math.abs(b.p - 0.5) - Math.abs(a.p - 0.5))
    };
  };

  /** LOPO for a fixed recipe, or per-fold selection when R is null ('auto'). */
  const runLopo = (Rfixed) => {
    const per = {};
    for (const P of PROMPTS) {
      const train = PROMPTS.filter((q) => q.id !== P.id).map((q) => q.id);
      const R = Rfixed || selectRecipe(train, DEPLOYABLE_RECIPES);
      const platt = fitMatch(train, R);
      const { floor } = floorFor(train, R, platt);
      per[P.id] = heldOut(P, R, platt, floor);
    }
    const pooledP = [];
    const pooledY = [];
    for (const P of PROMPTS)
      per[P.id].probs.forEach((p, i) => {
        if (per[P.id].labels[i] !== null) {
          pooledP.push(p);
          pooledY.push(per[P.id].labels[i]);
        }
      });
    return { per, pooledEce: ece(pooledP, pooledY), meanAuroc: mean(PROMPTS.map((P) => per[P.id].auroc)) };
  };
  const lopoByRecipe = Object.fromEntries(RECIPES.map((R) => [R, runLopo(R)]));
  const lopoAuto = runLopo(null);

  const allIds = PROMPTS.map((P) => P.id);
  const finalRecipe = selectRecipe(allIds, DEPLOYABLE_RECIPES);
  const bestAnyRecipe = selectRecipe(allIds);
  const finalPlatt = fitMatch(allIds, finalRecipe);
  const finalFloor = floorFor(allIds, finalRecipe, finalPlatt);
  const finalRestaurant = heldOut(PROMPTS.find((p) => p.id === 'restaurant'), finalRecipe, finalPlatt, finalFloor.floor);

  // ---- primary_tag ---------------------------------------------------------------------------
  /** config key -> { template, anchors, agg, labelPrefix, mode, lexBeta, labelVecs (anchors per label), labelStats, scores, zs } */
  const tagCfg = {};
  const labelTermsList = TAGS.map((t) => S1.labelLexTerms(t.label, t.description));
  const lexOverlap = {};
  for (const p of ALL_POSTS) {
    const terms = S1.lexTerms(p.norm);
    lexOverlap[p.id] = labelTermsList.map((lt) => S1.lexicalOverlap(terms, lt, LEX_CAP));
  }
  for (const v of TAG_VARIANTS)
    for (const lp of labelPrefixOptions) {
      const labelVecs = TAGS.map((t) => anchorTexts(t, v, lp).map(vec));
      const labelStats = labelVecs.map((a) => S1.labelBgStatsFor(a, bgVecs, { trim: BG_TRIM, agg: v.agg }));
      const sims = {};
      for (const p of ALL_POSTS) sims[p.id] = labelVecs.map((a) => S1.labelSimilarity(postVecsById.get(p.id), a, v.agg));
      const zs = {};
      for (const p of ALL_POSTS) zs[p.id] = sims[p.id].map((s, j) => S1.zScore(s, labelStats[j]));
      for (const mode of TAG_MODES) {
        const base = `${v.template}${v.anchors !== 'single' ? `+${v.anchors}-${v.agg}` : ''}${lp ? '+prefix' : ''}/${mode}`;
        const baseScores = {};
        for (const p of ALL_POSTS)
          baseScores[p.id] = sims[p.id].map((s, j) => (mode === 'raw' ? s : mode === 'centered' ? s - labelStats[j].mean : zs[p.id][j]));
        // Label-free scale for the lexical weight: spread of this config's scores over all posts.
        const scale = std(ALL_POSTS.flatMap((p) => baseScores[p.id])) || 1;
        for (const m of LEX_MULTS) {
          const key = m ? `${base}+lex${m}` : base;
          const lexBeta = m * scale;
          const scores = {};
          for (const p of ALL_POSTS) scores[p.id] = baseScores[p.id].map((s, j) => s + lexBeta * lexOverlap[p.id][j]);
          tagCfg[key] = { key, ...v, labelPrefix: lp, mode, lexBeta, labelVecs, labelStats, scores, zs };
        }
      }
    }
  const CFG_ORDER = Object.keys(tagCfg);
  const ranked = (cfg, p) =>
    TAG_LABELS.map((l, j) => [l, cfg.scores[p.id][j]]).sort((a, b) => b[1] - a[1]).map(([l]) => l);
  const labelOnly = (cfg, posts) => {
    const ps = posts.filter((p) => truthTag(p) !== 'none');
    let t1 = 0;
    let t3 = 0;
    for (const p of ps) {
      const r = ranked(cfg, p);
      if (r[0] === p.primaryTag) t1++;
      if (r.slice(0, 3).includes(p.primaryTag)) t3++;
    }
    return { top1: t1 / ps.length, top3: t3 / ps.length };
  };
  const TOPIC_POSTS = POSTS.filter((p) => p.kind === 'topic');
  const labelOnlyTable = Object.fromEntries(CFG_ORDER.map((k) => [k, { all: labelOnly(tagCfg[k], POSTS), topic: labelOnly(tagCfg[k], TOPIC_POSTS) }]));

  /** Grid search T and noneSim maximizing the mean log-likelihood of the true option (incl. none). */
  const gridTN = (cfg, posts) => {
    const all = posts.flatMap((p) => cfg.scores[p.id]);
    const scale = std(all) || 1;
    const maxes = posts.map((p) => Math.max(...cfg.scores[p.id]));
    const noneCands = [Math.min(...maxes) - 10 * scale, ...Array.from({ length: 51 }, (_, i) => quantile(maxes, i / 50))];
    let best = null;
    for (let k = -14; k <= 4; k++) {
      const T = scale * 2 ** (k / 2);
      const lse = posts.map((p) => cfg.scores[p.id].reduce((acc, s) => logAddExp(acc, s / T), -Infinity));
      for (const ns of noneCands) {
        let ll = 0;
        posts.forEach((p, i) => {
          const logZ = logAddExp(lse[i], ns / T);
          const t = truthTag(p);
          ll += (t === 'none' ? ns / T : cfg.scores[p.id][TAG_LABELS.indexOf(t)] / T) - logZ;
        });
        ll /= posts.length;
        if (!best || ll > best.ll) best = { T, noneSim: ns, ll };
      }
    }
    return best;
  };
  const decideTag = (cfg, T, noneSim, p) => {
    const byLabel = Object.fromEntries(TAG_LABELS.map((l, j) => [l, cfg.scores[p.id][j]]));
    return S1.choiceFromSims(byLabel, { T, noneSim });
  };
  const multiData = (cfg, posts) => {
    const xs = [];
    const ys = [];
    for (const p of posts)
      TAG_LABELS.forEach((l, j) => {
        xs.push(cfg.zs[p.id][j]);
        ys.push(p.tags.includes(l) ? 1 : 0);
      });
    return { xs, ys };
  };

  const cv = { strict: 0, lenient: 0, top3: 0, top3Labels: 0, nTag: 0, noneOk: 0, nNone: 0, correct: [], pmax: [], escRows: [], multiP: [], multiY: [], folds: [], byKind: {} };
  for (let k = 0; k < K_FOLDS; k++) {
    const train = POSTS.filter((p) => foldOf(p.id, K_FOLDS) !== k);
    const test = POSTS.filter((p) => foldOf(p.id, K_FOLDS) === k);
    const cfgKey = pickBest(CFG_ORDER, (key) => labelOnly(tagCfg[key], train).top1, CFG_ORDER);
    const cfg = tagCfg[cfgKey];
    const { T, noneSim } = gridTN(cfg, train);
    const trainDec = train.map((p) => decideTag(cfg, T, noneSim, p));
    const tagFloor = chooseTagFloor(
      trainDec.map((c) => c.confidence),
      train.map((p, i) => (trainDec[i].choice ?? 'none') === truthTag(p))
    );
    const md = multiData(cfg, train);
    const multi = fitPlatt(md.xs, md.ys);
    cv.folds.push({ k, cfg: cfgKey, T, noneSim, tagFloor: tagFloor.floor, n: test.length });
    for (const p of test) {
      const c = decideTag(cfg, T, noneSim, p);
      const choice = c.choice ?? 'none';
      const truth = truthTag(p);
      const ok = choice === truth;
      const kb = (cv.byKind[p.kind] ||= { n: 0, top1: 0, lenient: 0, top3: 0, top3Labels: 0, nNone: 0, noneOk: 0 });
      if (truth === 'none') {
        cv.nNone++;
        kb.nNone++;
        if (ok) {
          cv.noneOk++;
          kb.noneOk++;
        }
      } else {
        // top-3 over all options (none can take a slot) and over tags only (the candidates handed to tag nouls / escalation).
        const in3 = c.ranked.slice(0, 3).some(([l]) => l === truth);
        const in3Labels = c.ranked.filter(([l]) => l !== 'none').slice(0, 3).some(([l]) => l === truth);
        cv.nTag++;
        kb.n++;
        if (ok) cv.strict++, kb.top1++;
        if (p.tags.includes(choice)) cv.lenient++, kb.lenient++;
        if (in3) cv.top3++, kb.top3++;
        if (in3Labels) cv.top3Labels++, kb.top3Labels++;
      }
      cv.pmax.push(Math.max(...Object.values(c.probabilities)));
      cv.correct.push(ok ? 1 : 0);
      cv.escRows.push({ conf: c.confidence, ok, floor: tagFloor.floor });
      TAG_LABELS.forEach((l, j) => {
        cv.multiP.push(sigmoid(multi.a * cfg.zs[p.id][j] + multi.b));
        cv.multiY.push(p.tags.includes(l) ? 1 : 0);
      });
    }
  }
  const escN = cv.escRows.filter((r) => r.conf < r.floor).length;
  const tagCv = {
    top1: cv.strict / cv.nTag,
    lenientTop1: cv.lenient / cv.nTag,
    top3: cv.top3 / cv.nTag,
    top3Labels: cv.top3Labels / cv.nTag,
    noneAccuracy: cv.nNone ? cv.noneOk / cv.nNone : NaN,
    overallAccuracy: mean(cv.correct),
    ece: ece(cv.pmax, /** @type {(0|1)[]} */ (cv.correct)),
    escalationRate: escN / cv.escRows.length,
    accuracyWithEscalation: cv.escRows.filter((r) => r.conf < r.floor || r.ok).length / cv.escRows.length,
    multiAuroc: auroc(cv.multiP, cv.multiY),
    multiEce: ece(cv.multiP, cv.multiY),
    nTag: cv.nTag,
    nNone: cv.nNone,
    byKind: cv.byKind,
    topicTop1: cv.byKind.topic ? cv.byKind.topic.top1 / cv.byKind.topic.n : NaN,
    topicTop3: cv.byKind.topic ? cv.byKind.topic.top3 / cv.byKind.topic.n : NaN,
    topicTop3Labels: cv.byKind.topic ? cv.byKind.topic.top3Labels / cv.byKind.topic.n : NaN,
    topicLenientTop1: cv.byKind.topic ? cv.byKind.topic.lenient / cv.byKind.topic.n : NaN,
    folds: cv.folds
  };

  const finalCfgKey = pickBest(CFG_ORDER, (key) => labelOnlyTable[key].all.top1, CFG_ORDER);
  const finalCfg = tagCfg[finalCfgKey];
  const finalTN = gridTN(finalCfg, POSTS);
  const finalDec = POSTS.map((p) => decideTag(finalCfg, finalTN.T, finalTN.noneSim, p));
  const finalTagFloor = chooseTagFloor(
    finalDec.map((c) => c.confidence),
    POSTS.map((p, i) => (finalDec[i].choice ?? 'none') === truthTag(p))
  );
  const finalMd = multiData(finalCfg, POSTS);
  const finalMulti = fitPlatt(finalMd.xs, finalMd.ys);
  const privateTags = PRIVATE.map((p) => {
    const c = decideTag(finalCfg, finalTN.T, finalTN.noneSim, p);
    return { id: p.id, truth: truthTag(p), choice: c.choice ?? 'none', confidence: c.confidence };
  });

  // ---- Calibration object + consistency check against decideFromEmbeddings -----------------
  const restaurant = PROMPTS.find((p) => p.id === 'restaurant');
  const calibration = {
    model: spec.key,
    modelId: spec.id,
    dtype: spec.dtype,
    pooling: spec.pooling,
    queryPrefix: prefix,
    recipe: finalRecipe,
    labelTemplate: finalCfg.template,
    labelAnchors: finalCfg.anchors,
    labelPrefix: finalCfg.labelPrefix,
    chunk: { maxChars: CHUNK_CHARS, pool: 'max' },
    embedBatchSize: BATCH,
    embedRuntime: em.runtime,
    match: { a: round(finalPlatt.a), b: round(finalPlatt.b), bgTrim: BG_TRIM, minStd: S1.MIN_BG_STD },
    tag: {
      score: finalCfg.mode,
      agg: finalCfg.agg,
      lexical: { beta: round(finalCfg.lexBeta), cap: LEX_CAP },
      T: round(finalTN.T),
      noneSim: round(finalTN.noneSim),
      multi: { a: round(finalMulti.a), b: round(finalMulti.b) }
    },
    floor: { matches_prompt: finalFloor.floor, primary_tag: finalTagFloor.floor },
    corpusHash: S1.hashTexts([...BACKGROUND_CORPUS]),
    corpusSize: BACKGROUND_CORPUS.length,
    normalizer: normalizerName,
    promptCleaner: promptCleanerName
  };
  // ---- Deployed path: every golden post through the shared scorer (the offscreen host's code) --
  // The scorer derives the query texts, label anchors, background stats and chunks from the
  // calibration alone and gets its vectors from the same embedder; it must reproduce the fitting
  // code's probabilities exactly, so the extension computes what this eval measured.
  const deployedPath = await (async () => {
    const scorer = createSystem1Scorer({ embed: (texts) => em.embed(texts), calibration, modelSpec: spec, corpus: BACKGROUND_CORPUS });
    const R = calibration.recipe;
    const tagSpec = TAGS.map((t) => ({ label: t.label, description: t.description }));
    const items = ALL_POSTS.map((p) => ({ id: p.id, text: p.norm }));
    const chunkMismatch = ALL_POSTS.filter((p) => stableStringify(scorer.postChunks(p.norm)) !== stableStringify(p.chunks)).map((p) => p.id);
    if (chunkMismatch.length) throw new Error(`system1-scorer chunks differ from the eval for ${chunkMismatch.join(', ')}`);
    /** @type {Record<string, Map<string, Record<string, any>>>} */
    const answersByPrompt = {};
    let maxDiffP = 0;
    let maxDiffTagP = 0;
    let maxDiffNoul = 0;
    for (const P of PROMPTS) {
      const results = await scorer.decideItems(items, { prompt: promptParts(P), tags: tagSpec, questions: [Q.MATCHES_PROMPT, Q.PRIMARY_TAG] });
      answersByPrompt[P.id] = new Map();
      results.forEach((r, i) => {
        const p = ALL_POSTS[i];
        if (r.error || !r.answers) throw new Error(`system1-scorer failed for ${p.id}: ${r.error}`);
        answersByPrompt[P.id].set(p.id, r.answers);
        const expectP = sigmoid(calibration.match.a * M[P.id][R].zs[p.id] + calibration.match.b);
        maxDiffP = Math.max(maxDiffP, Math.abs(r.answers[Q.MATCHES_PROMPT].noul - expectP));
        const expect = decideTag(finalCfg, calibration.tag.T, calibration.tag.noneSim, p);
        const got = r.answers[Q.PRIMARY_TAG];
        if (got.choice !== expect.choice) throw new Error(`system1-scorer tag ${got.choice} != eval ${expect.choice} for ${p.id} (${P.id})`);
        for (const [label, prob] of Object.entries(expect.probabilities)) maxDiffTagP = Math.max(maxDiffTagP, Math.abs((got.probabilities[label] ?? NaN) - prob));
        for (const [id, a] of Object.entries(r.answers)) {
          if (!id.startsWith(Q.TAG_PREFIX)) continue;
          const j = TAG_LABELS.indexOf(id.slice(Q.TAG_PREFIX.length));
          maxDiffNoul = Math.max(maxDiffNoul, Math.abs(a.noul - sigmoid(calibration.tag.multi.a * finalCfg.zs[p.id][j] + calibration.tag.multi.b)));
        }
      });
    }
    // Exact for matches_prompt (same vectors, same math); the tag scores differ only by the rounding
    // of the lexical weight written to the calibration file.
    if (!(maxDiffP <= 1e-9) || !(maxDiffNoul <= 1e-9) || !(maxDiffTagP <= 1e-4)) {
      throw new Error(`system1-scorer disagrees with the eval: max |dp| ${maxDiffP}, tag prob ${maxDiffTagP}, tag noul ${maxDiffNoul}`);
    }
    const pOf = (Pid, p) => answersByPrompt[Pid].get(p.id)[Q.MATCHES_PROMPT].noul;
    const restaurantProbs = POSTS.map((p) => pOf('restaurant', p));
    const restaurantLabels = POSTS.map((p) => ybin(p, 'restaurant'));
    const idx = restaurantLabels.map((l, i) => (l === null ? -1 : i)).filter((i) => i >= 0);
    return {
      checked: ALL_POSTS.length * PROMPTS.length,
      maxDiffP,
      maxDiffTagP,
      maxDiffNoul,
      restaurant: {
        at05: binaryStats(idx.map((i) => restaurantProbs[i] >= 0.5), idx.map((i) => /** @type {0|1} */ (restaurantLabels[i]))),
        esc: simulateEscalation(restaurantProbs, restaurantLabels, calibration.floor.matches_prompt),
        falseFriendsOver05: POSTS.filter((p) => p.kind === 'false_friend' && ybin(p, 'restaurant') === 0 && pOf('restaurant', p) > 0.5).length,
        privateMaxP: PRIVATE.length ? Math.max(...PRIVATE.filter((p) => ybin(p, 'restaurant') !== 1).map((p) => pOf('restaurant', p))) : NaN
      },
      stats: scorer.stats()
    };
  })();

  // ---- Latency and batch drift ----------------------------------------------------------------
  const latTexts = POSTS.filter((p, i) => i % 9 === 0)
    .slice(0, 12)
    .map((p) => p.chunks[0]);
  const latency = await em.measureLatency(latTexts);
  const driftTexts = latTexts.slice(0, 8);
  const batched = await em.embedRaw(driftTexts);
  const singles = [];
  for (const t of driftTexts) singles.push((await em.embedRaw([t]))[0]);
  const drift = singles.map((s, i) => S1.cosine(s, batched[i]));
  latency.batchVsSingleCos = { min: Math.min(...drift), mean: mean(drift) };

  // ---- Reference vectors -----------------------------------------------------------------------
  const reference = [];
  for (const s of REFERENCE_SENTENCES) {
    const text = s.role === 'passage' ? s.text : `${prefix}${s.text}`;
    const v = (await em.embedRaw([text]))[0];
    reference.push({ role: s.role, text, vector: v.map((x) => +x.toFixed(7)) });
  }
  await em.dispose();

  // ---- Gates (all LOPO / cross-validated numbers) -------------------------------------------
  const rl = lopoAuto.per.restaurant;
  // Without the gitignored private export there is nothing to score: the gate is SKIPPED, which
  // counts as not passed (it must never pass vacuously).
  const privateScored = Number.isFinite(rl.privateMaxP);
  // The extension escalates at the deployed calibration's floor (calibration.floor, read through
  // the System 1 provider unless the user sets a floor), so the held-out restaurant probabilities
  // are also gated at that floor, not only at the floor each LOPO fold chose.
  const deployedEsc = simulateEscalation(rl.probs, rl.labels, finalFloor.floor);
  const gates = [
    { name: 'restaurant AUROC (LOPO)', value: rl.auroc, target: `>= ${GATES.restaurantAuroc}`, pass: rl.auroc >= GATES.restaurantAuroc },
    {
      name: 'private export max p (LOPO)',
      value: rl.privateMaxP,
      target: `< ${GATES.privateMaxP}`,
      pass: privateScored && rl.privateMaxP < GATES.privateMaxP,
      ...(privateScored ? {} : { skipped: 'eval/golden/posts.private.jsonl is missing or has no non-matching posts' })
    },
    { name: 'false friends with p > 0.5 (LOPO)', value: rl.falseFriendsOver05, target: `<= ${GATES.falseFriendsMax}`, pass: rl.falseFriendsOver05 <= GATES.falseFriendsMax },
    { name: 'escalated precision (restaurant, LOPO)', value: rl.esc.precision, target: `>= ${GATES.escPrecision}`, pass: rl.esc.precision >= GATES.escPrecision },
    { name: 'escalated recall (restaurant, LOPO)', value: rl.esc.recall, target: `>= ${GATES.escRecall}`, pass: rl.esc.recall >= GATES.escRecall },
    { name: 'escalation rate (restaurant, LOPO)', value: rl.esc.escalationRate, target: `<= ${GATES.escRate}`, pass: rl.esc.escalationRate <= GATES.escRate },
    { name: 'escalated precision at the deployed floor (restaurant, LOPO p)', value: deployedEsc.precision, target: `>= ${GATES.escPrecision}`, pass: deployedEsc.precision >= GATES.escPrecision },
    { name: 'escalated recall at the deployed floor (restaurant, LOPO p)', value: deployedEsc.recall, target: `>= ${GATES.escRecall}`, pass: deployedEsc.recall >= GATES.escRecall },
    { name: 'escalation rate at the deployed floor (restaurant, LOPO p)', value: deployedEsc.escalationRate, target: `<= ${GATES.escRate}`, pass: deployedEsc.escalationRate <= GATES.escRate },
    { name: 'tag top-1, tag-coverage posts (5-fold CV)', value: tagCv.topicTop1, target: `>= ${GATES.tagTop1}`, pass: tagCv.topicTop1 >= GATES.tagTop1 },
    { name: 'tag top-3 (tags only), tag-coverage posts (5-fold CV)', value: tagCv.topicTop3Labels, target: `>= ${GATES.tagTop3}`, pass: tagCv.topicTop3Labels >= GATES.tagTop3 },
    { name: 'match ECE (pooled LOPO)', value: lopoAuto.pooledEce, target: `<= ${GATES.ece}`, pass: lopoAuto.pooledEce <= GATES.ece },
    { name: 'tag ECE (5-fold CV)', value: tagCv.ece, target: `<= ${GATES.ece}`, pass: tagCv.ece <= GATES.ece },
    // Reported, not gating: tags of food / false-friend posts are genre judgements written for the restaurant prompt.
    { name: 'info: tag top-1, all tagged posts (5-fold CV)', value: tagCv.top1, target: `>= ${GATES.tagTop1}`, pass: tagCv.top1 >= GATES.tagTop1, info: true },
    { name: 'info: tag top-3 (tags only), all tagged posts (5-fold CV)', value: tagCv.top3Labels, target: `>= ${GATES.tagTop3}`, pass: tagCv.top3Labels >= GATES.tagTop3, info: true },
    { name: 'info: tag top-1 any listed tag, tag-coverage posts', value: tagCv.topicLenientTop1, target: `>= ${GATES.tagTop1}`, pass: tagCv.topicLenientTop1 >= GATES.tagTop1, info: true }
  ];
  const pass = gates.filter((g) => !g.info).every((g) => g.pass);

  calibration.report = {
    generatedAt: localDate(),
    generator: 'eval/run-eval.mjs',
    golden: { synthetic: POSTS.length, private: PRIVATE.length, prompts: PROMPTS.map((p) => p.id) },
    pass,
    gates: gates.map((g) => ({ name: g.name, value: round(g.value), target: g.target, pass: g.pass, ...(g.info ? { info: true } : {}), ...(g.skipped ? { skipped: g.skipped } : {}) })),
    match: {
      lopoRecipeByPrompt: Object.fromEntries(PROMPTS.map((P) => [P.id, lopoAuto.per[P.id].recipe])),
      lopoAurocByPrompt: Object.fromEntries(PROMPTS.map((P) => [P.id, round(lopoAuto.per[P.id].auroc)])),
      lopoPooledEce: round(lopoAuto.pooledEce),
      restaurantLopo: {
        precisionAt05: round(rl.at05.precision),
        recallAt05: round(rl.at05.recall),
        escalated: { precision: round(rl.esc.precision), recall: round(rl.esc.recall), rate: round(rl.esc.escalationRate), floor: rl.floor },
        escalatedAtDeployedFloor: { precision: round(deployedEsc.precision), recall: round(deployedEsc.recall), rate: round(deployedEsc.escalationRate), floor: finalFloor.floor },
        falseFriendsOver05: rl.falseFriendsOver05,
        privateMaxP: round(rl.privateMaxP)
      },
      bestRecipeAnyExpansion: bestAnyRecipe,
      restaurantAurocByRecipe: Object.fromEntries(RECIPES.map((R) => [R, round(lopoByRecipe[R].per.restaurant.auroc)]))
    },
    tag: {
      top1: round(tagCv.top1),
      lenientTop1: round(tagCv.lenientTop1),
      top3: round(tagCv.top3),
      top3TagsOnly: round(tagCv.top3Labels),
      topicTop1: round(tagCv.topicTop1),
      topicTop3TagsOnly: round(tagCv.topicTop3Labels),
      topicLenientTop1: round(tagCv.topicLenientTop1),
      noneAccuracy: round(tagCv.noneAccuracy),
      ece: round(tagCv.ece),
      escalationRate: round(tagCv.escalationRate),
      accuracyWithEscalation: round(tagCv.accuracyWithEscalation),
      multiAuroc: round(tagCv.multiAuroc)
    },
    latency
  };

  return {
    modelKey,
    spec,
    AUC,
    lopoByRecipe,
    lopoAuto,
    finalRecipe,
    bestAnyRecipe,
    finalFloor,
    finalRestaurant,
    labelOnlyTable,
    finalCfgKey,
    finalTN,
    finalTagFloor,
    tagCv,
    privateTags,
    calibration,
    gates,
    pass,
    latency,
    reference,
    deployedPath,
    M
  };
}

function round(x, d = 6) {
  return Number.isFinite(x) ? +x.toFixed(d) : x;
}

/** YYYY-MM-DD in local time. */
function localDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function renderReport(results, rules, recommended) {
  const date = localDate();
  const L = [];
  L.push(`# System 1 offline eval (${date})`);
  L.push('');
  L.push(`Generated by \`node eval/run-eval.mjs --models ${MODEL_KEYS.join(',')}${WRITE ? ' --write-calibration' : ''}${ASSERT ? ' --assert' : ''}\`.`);
  L.push('');
  L.push('## Setup');
  L.push('');
  const kinds = {};
  for (const p of POSTS) kinds[p.kind] = (kinds[p.kind] || 0) + 1;
  L.push(`- Golden set: ${POSTS.length} synthetic LinkedIn-style posts (${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ')}) plus ${PRIVATE.length} posts from the user's export (held out, never used for fitting).`);
  L.push(`- Labels per prompt: ${PROMPTS.map((P) => `${P.id} ${POSTS.filter((p) => p.labels[P.id] === 'yes').length} yes / ${POSTS.filter((p) => p.labels[P.id] === 'borderline').length} borderline`).join('; ')}. Borderline posts are excluded from AUROC, ECE, precision and recall but count toward escalation rates.`);
  L.push(`- Text: ${normalizerName}, chunks of at most ${CHUNK_CHARS} characters at sentence boundaries, max-pooled similarity over chunks. Background corpus: ${BACKGROUND_CORPUS.length} neutral posts (trim ${BG_TRIM} each end, std floor ${S1.MIN_BG_STD}).`);
  L.push(`- Embeddings: q8 ONNX on ${RUNTIME_LABEL}, ${BATCH === 1 ? 'one text per inference call (deterministic; matches the browser parity test)' : `batches of ${BATCH}`}.`);
  L.push('- Every matches_prompt number below is leave-one-prompt-out (LOPO): recipe choice, Platt fit and escalation floor come from the other four prompts. Tag numbers are 5-fold cross-validated over posts.');
  L.push('');
  L.push(`Query recipes (cleaned = ${promptCleanerName}; the expansion is a fixed text standing in for an on-device LLM expansion):`);
  L.push('');
  L.push(table(['prompt', 'raw', 'cleaned', 'expansion (C/D)'], PROMPTS.map((P) => [P.id, P.text, cleanPrompt(P.text), P.expansion])));
  L.push('');
  L.push('- A: raw prompt. B: max z over raw and cleaned. C: cleaned + expansion. D: max z over raw, cleaned and cleaned + expansion.');
  L.push('');

  L.push('## Gates');
  L.push('');
  const cell = (g) =>
    g.skipped
      ? 'SKIPPED'
      : `${typeof g.value === 'number' && !Number.isInteger(g.value) ? f3(g.value) : g.value} ${g.info ? (g.pass ? '(met)' : '(not met)') : g.pass ? 'PASS' : 'FAIL'}`;
  L.push(table(['gate', 'target', ...results.map((r) => r.modelKey)], results[0].gates.map((g, i) => [g.name, g.target, ...results.map((r) => cell(r.gates[i]))])));
  L.push('');
  L.push(
    'Tag gates are evaluated on the tag-coverage posts (kind `topic`, written to cover the 25 default tags). The food and false-friend posts were written for the restaurant prompt and their primary tags are genre judgements (News vs Personal Opinion vs Blog); the first run of this harness gated on all tagged posts, and the `info` rows keep those numbers visible. `top-3 (tags only)` ranks the tags without the `none` option, i.e. the candidates passed to tag nouls and escalation.'
  );
  L.push('');
  L.push(
    'The `(restaurant, LOPO)` escalation rows use the floor each LOPO fold chose on the other four prompts. The `at the deployed floor` rows apply the floor shipped in the calibration file (fitted on all five prompts) to the same held-out restaurant probabilities: that is the floor the extension uses unless the user sets one. A SKIPPED gate counts as not passed.'
  );
  L.push('');
  const skipped = results.flatMap((r) => r.gates.filter((g) => g.skipped).map((g) => `${r.modelKey}: ${g.name} (${g.skipped})`));
  if (skipped.length) {
    L.push(`Skipped: ${skipped.join('; ')}.`);
    L.push('');
  }
  L.push(table(['model', 'params', 'all gates'], results.map((r) => [r.modelKey, `${r.spec.label} (${SIZE_M(r.spec)}M)`, r.pass ? 'PASS' : 'FAIL'])));
  L.push('');
  L.push(recommended ? `**Recommended default: \`${recommended}\`** (smallest model passing every gate).` : '**No model passes every gate.** See the gaps above.');
  if (!recommended) {
    const matchOnly = results
      .filter((r) => r.gates.filter((g) => !g.info && !g.name.startsWith('tag')).every((g) => g.pass))
      .sort((a, b) => SIZE_M(a.spec) - SIZE_M(b.spec));
    L.push('');
    L.push(
      matchOnly.length
        ? `Every matches_prompt gate passes for: ${matchOnly.map((r) => `\`${r.modelKey}\``).join(', ')} (smallest first); the failures are in primary_tag.`
        : 'No model passes the matches_prompt gates either.'
    );
  }
  L.push('');

  for (const r of results) {
    L.push(`## ${r.modelKey} (${r.spec.id})`);
    L.push('');
    L.push('### matches_prompt: recipe comparison (AUROC of the z-score, per prompt; calibration-free)');
    L.push('');
    L.push(table(['prompt', ...RECIPES], PROMPTS.map((P) => [P.id, ...RECIPES.map((R) => f3(r.AUC[P.id][R]))])));
    L.push('');
    L.push('### matches_prompt: LOPO by recipe');
    L.push('');
    L.push(
      table(
        ['recipe', 'mean AUROC', 'restaurant AUROC', 'pooled ECE', 'restaurant P/R @0.5', 'restaurant escalated P/R', 'escalation rate', 'false friends > 0.5', 'private max p'],
        [...RECIPES.map((R) => [R, r.lopoByRecipe[R]]), ['auto', r.lopoAuto]].map(([R, lo]) => {
          const x = lo.per.restaurant;
          return [R, f3(lo.meanAuroc), f3(x.auroc), f3(lo.pooledEce), `${f2(x.at05.precision)} / ${f2(x.at05.recall)}`, `${f2(x.esc.precision)} / ${f2(x.esc.recall)}`, pct(x.esc.escalationRate), `${x.falseFriendsOver05}/${x.falseFriends.length}`, f3(x.privateMaxP)];
        })
      )
    );
    L.push('');
    L.push(`\`auto\` picks, per held-out prompt, the best of ${DEPLOYABLE_RECIPES.join('/')} by mean AUROC on the other four prompts; the gates use it.`);
    L.push('');
    L.push('### matches_prompt: LOPO per held-out prompt (auto recipe)');
    L.push('');
    L.push(
      table(
        ['held-out', 'recipe', 'Platt a, b', 'AUROC', 'ECE', 'log-loss', 'P/R @0.5', 'floor', 'escalated P/R', 'escalation rate'],
        PROMPTS.map((P) => {
          const x = r.lopoAuto.per[P.id];
          return [P.id, x.recipe, `${f2(x.platt.a)}, ${f2(x.platt.b)}`, f3(x.auroc), f3(x.ece), f3(x.logLoss), `${f2(x.at05.precision)} / ${f2(x.at05.recall)}`, f2(x.floor), `${f2(x.esc.precision)} / ${f2(x.esc.recall)}`, pct(x.esc.escalationRate)];
        })
      )
    );
    L.push('');
    const rl = r.lopoAuto.per.restaurant;
    L.push('Restaurant prompt, held out:');
    L.push('');
    L.push(`- False friends: ${rl.falseFriends.map((x) => `${x.id} ${f2(x.p)}`).join(', ')}.`);
    L.push(`- Borderline: ${rl.borderline.filter((x) => POSTS.find((p) => p.id === x.id).kind.startsWith('food')).map((x) => `${x.id} ${f2(x.p)}`).join(', ')}.`);
    L.push(`- Private export posts: ${rl.private.map((x) => `${x.id} ${f3(x.prob)}`).join(', ')}.`);
    L.push(`- Social-noise posts with p > 0.5 (System 1 alone, before the prefilter): ${rl.noiseOver05.join(', ') || 'none'}.`);
    L.push(`- Largest errors at p = 0.5: ${rl.errors.slice(0, 8).map((x) => `${x.id} (${x.kind}, y=${x.y}) ${f2(x.p)}`).join('; ') || 'none'}.`);
    L.push('');
    L.push(`Deployed calibration (fitted on all five prompts, recipes limited to ${DEPLOYABLE_RECIPES.join('/')} so no LLM expansion is needed; best recipe if an expansion were always available: ${r.bestAnyRecipe}): recipe ${r.finalRecipe}, a = ${f3(r.calibration.match.a)}, b = ${f3(r.calibration.match.b)}, floor ${f2(r.finalFloor.floor)} (targets ${r.finalFloor.met ? 'met' : 'not met'} in-sample). In-sample restaurant: escalated P/R ${f2(r.finalRestaurant.esc.precision)} / ${f2(r.finalRestaurant.esc.recall)}, escalation ${pct(r.finalRestaurant.esc.escalationRate)}, private max p ${f3(r.finalRestaurant.privateMaxP)}. Held-out (LOPO) restaurant probabilities at this floor: escalated P/R ${f2(r.calibration.report.match.restaurantLopo.escalatedAtDeployedFloor.precision)} / ${f2(r.calibration.report.match.restaurantLopo.escalatedAtDeployedFloor.recall)}, escalation ${pct(r.calibration.report.match.restaurantLopo.escalatedAtDeployedFloor.rate)}.`);
    L.push('');
    const dp = r.deployedPath;
    L.push(`Deployed path (lib/decision/system1-scorer.js, the code the offscreen host runs, with this calibration file): ${dp.checked} post x prompt decisions reproduce the fitting code (max |dp| ${dp.maxDiffP.toExponential(1)}, tag probabilities ${dp.maxDiffTagP.toExponential(1)}). In-sample restaurant: P/R @0.5 ${f2(dp.restaurant.at05.precision)} / ${f2(dp.restaurant.at05.recall)}, escalated P/R at floor ${f2(r.calibration.floor.matches_prompt)} ${f2(dp.restaurant.esc.precision)} / ${f2(dp.restaurant.esc.recall)}, escalation ${pct(dp.restaurant.esc.escalationRate)}, false friends > 0.5 ${dp.restaurant.falseFriendsOver05}, private max p ${f3(dp.restaurant.privateMaxP)}.`);
    L.push('');
    L.push('### primary_tag: label representation and score mode (label-only ranking, no `none`; in-sample, no fitting involved)');
    L.push('');
    L.push(
      table(
        ['config', 'top-1 all tagged', 'top-3 all tagged', 'top-1 tag-coverage', 'top-3 tag-coverage'],
        Object.entries(r.labelOnlyTable)
          .filter(([k]) => !k.includes('+lex') || k === r.finalCfgKey || /\+lex1$/.test(k))
          .sort((a, b) => b[1].all.top1 - a[1].all.top1 || b[1].topic.top1 - a[1].topic.top1)
          .slice(0, 24)
          .map(([k, v]) => [k === r.finalCfgKey ? `**${k}**` : k, f3(v.all.top1), f3(v.all.top3), f3(v.topic.top1), f3(v.topic.top3)])
      )
    );
    L.push('');
    L.push(`Top 24 of ${Object.keys(r.labelOnlyTable).length} configs (lexical variants shown at weight 1 only), sorted by top-1 on all tagged posts; bold = deployed.`);
    L.push('');
    L.push('Templates: `about` = "This post is about <topic>.", `raw` = the default description as written, `label` = "<Label>: <topic>". Anchors: `+items-<agg>` adds one "This post is about <item>." anchor per comma-separated description item, `+all-<agg>` also adds the label name; `agg` combines the anchor similarities (max, mean, top2 = mean of the best two). `+prefix` adds the query prefix. Modes: `raw` cosine, `centered` cosine minus the label\'s background mean, `z` background z-score. `+lexN` adds N score standard deviations times the capped overlap between the post\'s words and the tag\'s own label/description words (lexicalOverlap, cap 3).');
    L.push('');
    L.push('### primary_tag: 5-fold CV with the `none` option');
    L.push('');
    const t = r.tagCv;
    L.push(
      table(
        ['top-1 (strict)', 'top-1 (any listed tag)', 'top-3 (with none)', 'top-3 (tags only)', 'none accuracy', 'overall accuracy', 'ECE (pmax)', 'escalation rate', 'accuracy with escalation', 'tag noul AUROC', 'tag noul ECE'],
        [[f3(t.top1), f3(t.lenientTop1), f3(t.top3), f3(t.top3Labels), f3(t.noneAccuracy), f3(t.overallAccuracy), f3(t.ece), pct(t.escalationRate), f3(t.accuracyWithEscalation), f3(t.multiAuroc), f3(t.multiEce)]]
      )
    );
    L.push('');
    L.push(
      table(
        ['post kind', 'tagged posts', 'top-1', 'top-1 (any listed tag)', 'top-3 (with none)', 'top-3 (tags only)', 'none posts', 'none accuracy'],
        Object.entries(t.byKind).map(([k, b]) => [
          k,
          String(b.n),
          b.n ? f3(b.top1 / b.n) : 'n/a',
          b.n ? f3(b.lenient / b.n) : 'n/a',
          b.n ? f3(b.top3 / b.n) : 'n/a',
          b.n ? f3(b.top3Labels / b.n) : 'n/a',
          String(b.nNone),
          b.nNone ? f3(b.noneOk / b.nNone) : 'n/a'
        ])
      )
    );
    L.push('');
    L.push(`Folds: ${t.folds.map((f) => `#${f.k} ${f.cfg} T=${f.T.toPrecision(3)} floor=${f2(f.tagFloor)}`).join('; ')}.`);
    L.push(`Deployed: ${r.finalCfgKey}, T = ${r.finalTN.T.toPrecision(4)}, noneSim = ${r.finalTN.noneSim.toPrecision(4)}, floor ${f2(r.finalTagFloor.floor)}. Private export tags: ${r.privateTags.map((x) => `${x.id} ${x.choice}${x.choice === x.truth ? '' : ` (labelled ${x.truth})`}`).join(', ')}.`);
    L.push('');
    L.push('### Latency (this machine, heavily loaded)');
    L.push('');
    L.push(table(['single text median', 'single p90', 'batched per text', 'cos(batched, single) min / mean'], [[`${r.latency.singleMedianMs} ms`, `${r.latency.singleP90Ms} ms`, `${r.latency.batchPerTextMs} ms`, `${r.latency.batchVsSingleCos.min.toFixed(5)} / ${r.latency.batchVsSingleCos.mean.toFixed(5)}`]]));
    L.push('');
  }

  L.push('## Rules-engine baseline (lib/inference-engine.js)');
  L.push('');
  if (!rules.ok) {
    L.push(`Could not run: ${rules.error}`);
  } else {
    L.push(
      table(
        ['prompt', 'precision', 'recall', 'false friends passed', 'private passed', 'errors'],
        Object.entries(rules.match).map(([k, v]) => [k, f2(v.precision), f2(v.recall), String(v.ffPass), `${v.privPass}/${PRIVATE.length}`, String(v.errors)])
      )
    );
    L.push('');
    L.push(`keywordFallback tag top-1: ${f3(rules.tags.top1)} over ${rules.tags.n} tagged posts.`);
    if (rules.prefilter) {
      const pf = rules.prefilter;
      L.push('');
      L.push(`Prefilter (isSocialNoise): catches ${pf.caught}/${pf.nNoise} social-noise posts (missed: ${pf.missed.join(', ') || 'none'}); flags ${pf.falseHits.length}/${pf.nOther} other posts${pf.falseHits.length ? ` (${pf.falseHits.join(', ')})` : ''}.`);
    }
  }
  L.push('');
  L.push('## Notes');
  L.push('');
  L.push('- q8 models quantize activations per inference call, so a vector depends on the other texts in its batch (see the cos(batched, single) column). The calibration and eval/reference-vectors.json use one text per call, as the offscreen host does.');
  L.push("- The vectors come from onnxruntime-web's wasm backend running in Node with the wasm file the extension bundles, so they are the vectors the offscreen host computes (e2e/parity.spec.mjs). onnxruntime-node's native int8 kernels differ for a few percent of texts (cosine about 0.997); `S1_EVAL_RUNTIME=node` selects them.");
  L.push('- One Platt (a, b) on background z-scores transfers across prompts in ranking (AUROC near 1 everywhere) but not always in level: compare the P/R @0.5 column per held-out prompt. Adding the raw cosine as a second feature did not fix this in a LOPO check, so the calibration stays one-feature; escalation of the uncertain band recovers part of the gap.');
  L.push('- The `none` option of primary_tag rarely wins for social noise; the prefilter (isSocialNoise) has to remove it before System 1.');
  L.push('- The golden set is synthetic and small (borderline items excluded), so every number has wide error bars (one tag-coverage post is 1.3 points); the private export set has 7 items. The same author wrote the golden posts, the background corpus and the prompt expansions.');
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const results = [];
for (const key of MODEL_KEYS) {
  if (!MODEL_REGISTRY[key]) throw new Error(`Unknown model "${key}". Known: ${Object.keys(MODEL_REGISTRY).join(', ')}`);
  log(`\n=== ${key} ===`);
  results.push(await evaluateModel(key));
}
const rules = await rulesBaseline();

// Smallest passing model (lib/decision/models.js paramsM: MiniLM 22M < BGE small 33M).
const SIZE_M = (spec) => (Number.isFinite(spec.paramsM) ? spec.paramsM : Number((spec.label.match(/(\d+)M/) || [])[1]) || Infinity);
const passing = results.filter((r) => r.pass).sort((a, b) => SIZE_M(a.spec) - SIZE_M(b.spec));
const recommended = passing[0]?.modelKey || null;
for (const r of results) r.calibration.report.recommendedDefault = r.modelKey === recommended;

for (const r of results) {
  log(`\n${r.modelKey}: ${r.pass ? 'PASS' : 'FAIL'}`);
  for (const g of r.gates) {
    if (g.skipped) log(`  SKIP ${g.name}: ${g.skipped} (counts as not passed)`);
    else log(`  ${g.info ? 'info' : g.pass ? 'ok  ' : 'FAIL'} ${g.name}: ${typeof g.value === 'number' ? f3(g.value) : g.value} (${g.target})`);
  }
  log(`  recipe ${r.finalRecipe} (best with an expansion: ${r.bestAnyRecipe}), tag ${r.finalCfgKey}, latency ${r.latency.singleMedianMs} ms/text single, ${r.latency.batchPerTextMs} ms/text batched`);
  const dp = r.deployedPath;
  log(
    `  deployed path (system1-scorer): ${dp.checked} decisions match the eval (max |dp| ${dp.maxDiffP.toExponential(1)}, tag prob ${dp.maxDiffTagP.toExponential(1)}); ` +
      `restaurant in-sample P/R@0.5 ${f2(dp.restaurant.at05.precision)}/${f2(dp.restaurant.at05.recall)}, false friends>0.5 ${dp.restaurant.falseFriendsOver05}, private max p ${f3(dp.restaurant.privateMaxP)}`
  );
}
if (rules.ok) {
  log('\nrules baseline:');
  for (const [k, v] of Object.entries(rules.match)) log(`  ${k}: P ${f2(v.precision)} R ${f2(v.recall)} false friends ${v.ffPass} private ${v.privPass}/${PRIVATE.length}`);
  log(`  keywordFallback tag top-1 ${f3(rules.tags.top1)}`);
} else {
  log(`\nrules baseline unavailable: ${rules.error}`);
}
log(`\nrecommended default model: ${recommended || 'none (no model passes every gate)'}`);

const date = localDate();
const reportPath = REPORT_PATH ? path.resolve(REPORT_PATH) : path.join(ROOT, 'eval/reports', `${date}-system1.md`);
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, renderReport(results, rules, recommended));
log(`report: ${path.relative(ROOT, reportPath)}`);

// Before --write-calibration, so the comparison is with the committed files.
if (CHECK_CALIBRATION) {
  /** Leaf paths where two JSON values differ. */
  const diffPaths = (a, b, at = '') => {
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) => diffPaths(a[k], b[k], at ? `${at}.${k}` : k));
    }
    return stableStringify(a) === stableStringify(b) ? [] : [`${at}: committed ${stableStringify(b)} vs fitted ${stableStringify(a)}`];
  };
  let same = true;
  for (const r of results) {
    const file = path.join(ROOT, 'lib/decision/calibration', `${r.modelKey}.${r.spec.dtype}.json`);
    let committed = null;
    try {
      committed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      log(`calibration check ${r.modelKey}: cannot read ${path.relative(ROOT, file)} (${err?.message || err})`);
      same = false;
      continue;
    }
    const { report: _fitted, ...fitted } = r.calibration;
    const { report: _committed, ...kept } = committed;
    const diffs = diffPaths(JSON.parse(JSON.stringify(fitted)), kept);
    if (diffs.length) same = false;
    log(diffs.length ? `calibration check ${r.modelKey}: DIFFERS\n  ${diffs.join('\n  ')}` : `calibration check ${r.modelKey}: identical to ${path.relative(ROOT, file)}`);
  }
  // A deliberate refit (--write-calibration) is expected to differ.
  if (!same && !WRITE) process.exitCode = 1;
}

if (WRITE) {
  for (const r of results) {
    const file = path.join(ROOT, 'lib/decision/calibration', `${r.modelKey}.${r.spec.dtype}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(r.calibration, null, 2) + '\n');
    log(`calibration: ${path.relative(ROOT, file)}`);
  }
  const refFile = path.join(ROOT, 'eval/reference-vectors.json');
  let ref = {};
  try {
    ref = JSON.parse(fs.readFileSync(refFile, 'utf8')).models || {};
  } catch {
    ref = {};
  }
  for (const r of results) ref[r.modelKey] = { id: r.spec.id, dtype: r.spec.dtype, pooling: r.spec.pooling, normalize: true, batchSize: 1, runtime: r.calibration.embedRuntime, sentences: r.reference };
  fs.writeFileSync(
    refFile,
    JSON.stringify({ note: 'Node embeddings (see `runtime`) of fixed texts, one text per call, for the browser parity test (e2e/parity.spec.mjs). `text` is exactly what was embedded.', models: ref }, null, 1) + '\n'
  );
  log(`reference vectors: ${path.relative(ROOT, refFile)}`);
}

if (ASSERT && !recommended) {
  const skippedAny = results.some((r) => r.gates.some((g) => g.skipped));
  console.error(`\nGate failed: no model passes every gate.${skippedAny ? ' Some gates were skipped for missing data and count as not passed.' : ''}`);
  process.exitCode = 1;
}
