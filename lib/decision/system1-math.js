/**
 * System 1 math: turns sentence embeddings into the typed answers of lib/decision/types.js.
 *
 * Pure functions (no browser or Node APIs) shared by the offscreen System 1 host and the Node
 * eval harness (eval/run-eval.mjs), so a calibration fitted offline applies unchanged in the
 * extension. Embeddings are expected L2-normalized (Transformers.js `normalize: true`), but the
 * similarity helpers do not rely on it.
 *
 * For one post:
 *   text -> chunkText() -> embed each chunk -> postVecs
 *   matches_prompt : s = max over chunks of cos(chunk, query); z = (s - bg.mean) / bg.std against
 *                    the query's similarities to the neutral background corpus; p = sigmoid(a z + b).
 *                    With several query texts (recipe B/D) the largest z wins.
 *   primary_tag    : per-label score -> softmax(score / T) with a constant `none` logit (noneSim / T).
 *   tag:<label>    : z against the label's own background stats -> sigmoid(a z + b).
 */
import { sigmoid, softmax, choiceConfidence, clamp01 } from './confidence.js';
import { Q, noulAnswer } from './types.js';

/**
 * @typedef {object} BgStats
 * @property {number} mean   trimmed mean of the similarities to the background corpus
 * @property {number} std    trimmed standard deviation, floored at minStd
 */

/**
 * Calibration written by eval/run-eval.mjs to lib/decision/calibration/<model>.q8.json.
 * @typedef {object} System1Calibration
 * @property {string} model                  registry key (lib/decision/models.js)
 * @property {string} dtype
 * @property {'cls'|'mean'} pooling
 * @property {string} queryPrefix            applied to prompt query texts (and labels when labelPrefix)
 * @property {'A'|'B'|'C'|'D'} recipe        query recipe, see queryTextsForRecipe()
 * @property {string} [recipeFallback]       recipe to use when the chosen one needs an expansion that is missing
 * @property {'about'|'raw'|'label'} labelTemplate   see labelText()
 * @property {'single'|'items'|'all'} [labelAnchors]  see labelAnchorTexts()
 * @property {boolean} [labelPrefix]         whether the query prefix is applied to label texts
 * @property {{ maxChars: number }} [chunk]
 * @property {{ a: number, b: number, bgTrim: number }} match
 * @property {{ score: 'raw'|'centered'|'z', agg?: 'max'|'mean'|'top2', lexical?: { beta: number, cap: number }, T: number, noneSim: number, multi?: { a: number, b: number } }} tag
 * @property {{ matches_prompt: number, primary_tag: number }} floor   escalate when confidence < floor
 * @property {string} corpusHash             hashTexts(BACKGROUND_CORPUS) the stats were fitted with
 */

export const DEFAULT_CHUNK_CHARS = 800;
export const DEFAULT_BG_TRIM = 0.1;
export const MIN_BG_STD = 0.02;

// ---------------------------------------------------------------------------
// Vectors
// ---------------------------------------------------------------------------

/**
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 */
export function dot(a, b) {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/** @param {ArrayLike<number>} a */
export function norm(a) {
  return Math.sqrt(dot(a, a));
}

/**
 * Cosine similarity; 0 when either vector is all zeros.
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 */
export function cosine(a, b) {
  const d = norm(a) * norm(b);
  return d > 0 ? dot(a, b) / d : 0;
}

/**
 * Pooled post-to-query similarity: the best-matching chunk decides, so one relevant paragraph in
 * a long post is not diluted by the rest.
 * @param {ArrayLike<number>[]} postVecs   chunk embeddings
 * @param {ArrayLike<number>} queryVec
 * @returns {number}  -1 when the post has no chunks
 */
export function pooledSimilarity(postVecs, queryVec) {
  let best = -1;
  for (const v of postVecs || []) {
    const s = cosine(v, queryVec);
    if (s > best) best = s;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Text helpers (must match between Node calibration and the browser host)
// ---------------------------------------------------------------------------

/**
 * Splits text into chunks of at most `maxChars`, breaking at sentence or line boundaries and
 * balancing chunk sizes so a long post does not end in a tiny tail chunk. A sentence longer than
 * `maxChars` is split at word boundaries (hard cut only for a single oversized token).
 * Text that already fits is returned as one chunk, unchanged apart from trimming.
 * @param {string} text
 * @param {{ maxChars?: number }} [opts]
 * @returns {string[]}
 */
export function chunkText(text, opts = {}) {
  const maxChars = Math.max(16, opts.maxChars || DEFAULT_CHUNK_CHARS);
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  /** @type {string[]} */
  const pieces = [];
  for (const sentence of trimmed.split(/(?<=[.!?…])\s+|\s*\n+\s*/)) {
    const s = sentence.replace(/\s+/g, ' ').trim();
    if (!s) continue;
    if (s.length <= maxChars) {
      pieces.push(s);
      continue;
    }
    let cur = '';
    for (const word of s.split(' ')) {
      for (let i = 0; i < word.length; i += maxChars) {
        const part = word.slice(i, i + maxChars);
        if (cur && cur.length + 1 + part.length > maxChars) {
          pieces.push(cur);
          cur = part;
        } else {
          cur = cur ? `${cur} ${part}` : part;
        }
      }
    }
    if (cur) pieces.push(cur);
  }

  const total = pieces.reduce((acc, p) => acc + p.length + 1, 0);
  const target = total / Math.ceil(total / maxChars);
  /** @type {string[]} */
  const chunks = [];
  let cur = '';
  for (const p of pieces) {
    if (cur && (cur.length + 1 + p.length > maxChars || cur.length >= target)) {
      chunks.push(cur);
      cur = p;
    } else {
      cur = cur ? `${cur} ${p}` : p;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/**
 * Strips the instruction lead-in of a tag description ("Identify posts related to health, ..."
 * -> "health, ..."), leaving the topical part.
 * @param {string} description
 */
export function stripInstruction(description) {
  return String(description || '')
    .trim()
    .replace(/^(?:please\s+)?(?:identify|find|detect|collect|flag|match)\s+/i, '')
    .replace(/^(?:any\s+)?(?:posts?|content|items?)\s+(?:that\s+(?:are|is)\s+)?(?:related\s+to|about|on|regarding|covering)\s+/i, '')
    .replace(/^references\s+to\s+/i, '')
    .trim();
}

/**
 * Text embedded for a tag label.
 *  - 'about' : "This post is about <topic>"
 *  - 'raw'   : the description as written
 *  - 'label' : "<Label>: <topic>"
 * @param {string} label
 * @param {string} description
 * @param {'about'|'raw'|'label'} template
 * @param {string} [prefix]  query prefix (bge) when the calibration says labelPrefix
 */
export function labelText(label, description, template, prefix = '') {
  const desc = String(description || '').trim();
  const topic = stripInstruction(desc) || label;
  let body;
  if (template === 'raw') body = desc || label;
  else if (template === 'label') body = `${label}: ${topic}`;
  else body = `This post is about ${topic.replace(/\.$/, '')}.`;
  return `${prefix || ''}${body}`;
}

/**
 * Splits a tag description into its comma-separated topical items:
 * "Identify posts related to health, medicine, or nutrition." -> ['health', 'medicine', 'nutrition'].
 * @param {string} description
 * @param {number} [max]
 * @returns {string[]}
 */
export function descriptionItems(description, max = 8) {
  const topic = stripInstruction(description).replace(/[.!]+$/, '');
  const items = topic
    .split(/\s*[,;]\s*/)
    .map((s) => s.replace(/^(?:or|and|etc)\b\s*/i, '').trim())
    .filter((s) => s.length >= 3);
  return [...new Set(items)].slice(0, max);
}

/**
 * Anchor texts embedded for one tag label. A label can be represented by several anchors whose
 * similarities are aggregated (labelSimilarity), which keeps a long list of topics from being
 * averaged into one blurred vector.
 *  - 'single' : labelText(template) only
 *  - 'items'  : that plus "This post is about <item>." for each description item
 *  - 'all'    : 'items' plus "This post is about <Label>."
 * @param {string} label
 * @param {string} description
 * @param {{ template?: 'about'|'raw'|'label', anchors?: 'single'|'items'|'all', prefix?: string }} [opts]
 * @returns {string[]}
 */
export function labelAnchorTexts(label, description, opts = {}) {
  const prefix = opts.prefix || '';
  const texts = [labelText(label, description, opts.template || 'about', prefix)];
  if (opts.anchors === 'items' || opts.anchors === 'all') {
    for (const item of descriptionItems(description)) texts.push(`${prefix}This post is about ${item}.`);
    if (opts.anchors === 'all') texts.push(`${prefix}This post is about ${label}.`);
  }
  return [...new Set(texts)];
}

/**
 * Aggregates per-anchor similarities: 'max', 'mean', or 'top2' (mean of the two best).
 * @param {number[]} sims
 * @param {'max'|'mean'|'top2'} [agg]
 */
export function aggregateSims(sims, agg = 'max') {
  if (!sims.length) return -1;
  if (sims.length === 1) return sims[0];
  if (agg === 'mean') return sims.reduce((a, b) => a + b, 0) / sims.length;
  if (agg === 'top2') {
    const [a, b] = sims.slice().sort((x, y) => y - x);
    return (a + b) / 2;
  }
  return Math.max(...sims);
}

/**
 * Post-to-label similarity for a label given by one vector or several anchor vectors.
 * @param {ArrayLike<number>[]} postVecs
 * @param {ArrayLike<number>|ArrayLike<number>[]} labelVecOrAnchors
 * @param {'max'|'mean'|'top2'} [agg]
 */
export function labelSimilarity(postVecs, labelVecOrAnchors, agg = 'max') {
  return aggregateSims(asVecList(labelVecOrAnchors).map((a) => pooledSimilarity(postVecs, a)), agg);
}

/**
 * Background stats of a label (one vector or anchors), using the same aggregation as labelSimilarity.
 * @param {ArrayLike<number>|ArrayLike<number>[]} labelVecOrAnchors
 * @param {ArrayLike<number>[]} bgVecs
 * @param {{ trim?: number, minStd?: number, agg?: 'max'|'mean'|'top2' }} [opts]
 */
export function labelBgStatsFor(labelVecOrAnchors, bgVecs, opts = {}) {
  return bgStats(bgVecs.map((b) => labelSimilarity([b], labelVecOrAnchors, opts.agg)), opts);
}

const LEX_STOP = new Set(
  ('the and for are but not you your our their his her its this that these those with from into onto about over under ' +
    'was were been being have has had will would can could should may might must shall what which who whom whose when ' +
    'where why how all any each few more most other some such only own same than too very just also new update updates ' +
    'post posts related identify references reference etc thing things like get got one two').split(' ')
);

/**
 * Crude, deterministic stem used for lexical overlap (lowercase, plural/-ing/-ed trimmed).
 * @param {string} word
 */
export function lexStem(word) {
  let w = String(word || '').toLowerCase().replace(/['’]s$/, '');
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  return w;
}

/**
 * Distinct stems of the content words in a text (letters/digits, length >= 3, minus stop words).
 * @param {string} text
 * @returns {Set<string>}
 */
export function lexTerms(text) {
  const out = new Set();
  for (const m of String(text || '').normalize('NFKC').toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const w = m[0];
    if (w.length < 3 || LEX_STOP.has(w)) continue;
    out.add(lexStem(w));
  }
  return out;
}

/**
 * Lexical terms of a tag: its label plus the topical part of its description.
 * @param {string} label
 * @param {string} description
 */
export function labelLexTerms(label, description) {
  return lexTerms(`${label} ${stripInstruction(description)}`);
}

/**
 * Lexical bonus in [0, 1]: distinct label terms present in the post, capped at `cap`.
 * @param {Set<string>} postTerms
 * @param {Set<string>|string[]} labelTerms
 * @param {number} [cap]
 */
export function lexicalOverlap(postTerms, labelTerms, cap = 3) {
  let hits = 0;
  for (const t of labelTerms) if (postTerms.has(t)) hits++;
  return Math.min(hits, cap) / cap;
}

/**
 * Query texts embedded for the global prompt under a recipe.
 *  - A : raw prompt
 *  - B : raw prompt and cleaned prompt (max z wins)
 *  - C : cleaned prompt plus a short expansion (falls back to B without an expansion)
 *  - D : raw, cleaned and cleaned + expansion (max z wins)
 * @param {'A'|'B'|'C'|'D'} recipe
 * @param {{ raw: string, cleaned?: string, expansion?: string }} prompt
 * @param {string} [prefix]
 * @returns {string[]}  de-duplicated, non-empty
 */
export function queryTextsForRecipe(recipe, prompt, prefix = '') {
  const raw = String(prompt?.raw || '').trim();
  const cleaned = String(prompt?.cleaned || '').trim() || raw;
  const expansion = String(prompt?.expansion || '').trim();
  const expanded = expansion ? `${cleaned}: ${expansion}` : '';
  /** @type {string[]} */
  let texts;
  if (recipe === 'A') texts = [raw];
  else if (recipe === 'C') texts = expanded ? [expanded] : [raw, cleaned];
  else if (recipe === 'D') texts = [raw, cleaned, expanded];
  else texts = [raw, cleaned];
  return [...new Set(texts.filter(Boolean))].map((t) => `${prefix || ''}${t}`);
}

/**
 * Deterministic 32-bit FNV-1a hash (hex) of a list of texts; identifies the background corpus a
 * calibration was fitted with.
 * @param {string[]} texts
 */
export function hashTexts(texts) {
  let h = 0x811c9dc5;
  const s = (texts || []).join('␞');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/**
 * Trimmed mean / std of a query's similarities to the background corpus.
 * @param {number[]} simsToBg
 * @param {{ trim?: number, minStd?: number }} [opts]   trim = fraction dropped at EACH end
 * @returns {BgStats}
 */
export function bgStats(simsToBg, opts = {}) {
  const trim = Math.min(0.45, Math.max(0, opts.trim ?? DEFAULT_BG_TRIM));
  const minStd = opts.minStd ?? MIN_BG_STD;
  const sorted = (simsToBg || []).filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return { mean: 0, std: minStd };
  let k = Math.floor(sorted.length * trim);
  if (sorted.length - 2 * k < 2) k = Math.max(0, Math.floor((sorted.length - 2) / 2));
  const kept = sorted.slice(k, sorted.length - k);
  const mean = kept.reduce((a, b) => a + b, 0) / kept.length;
  const variance = kept.reduce((a, b) => a + (b - mean) ** 2, 0) / kept.length;
  return { mean, std: Math.max(Math.sqrt(variance), minStd) };
}

/**
 * Background stats for a query vector against background embeddings.
 * @param {ArrayLike<number>} queryVec
 * @param {ArrayLike<number>[]} bgVecs
 * @param {{ trim?: number, minStd?: number }} [opts]
 */
export function bgStatsFor(queryVec, bgVecs, opts) {
  return bgStats(bgVecs.map((v) => cosine(queryVec, v)), opts);
}

/**
 * @param {number} s
 * @param {BgStats} stats
 */
export function zScore(s, stats) {
  return (s - stats.mean) / (stats.std || MIN_BG_STD);
}

/**
 * Platt-calibrated yes probability from a similarity.
 * @param {number} s
 * @param {BgStats} stats
 * @param {{ a: number, b: number }} platt
 * @returns {{ p: number, z: number }}
 */
export function noulFromSim(s, stats, platt) {
  const z = zScore(s, stats);
  return { p: sigmoid(platt.a * z + platt.b), z };
}

/**
 * Softmax choice over label scores with a constant `none` anchor.
 * @param {Record<string, number>} simByLabel   label -> score (similarity or centered/z score)
 * @param {{ T: number, noneSim?: number }} opts  T temperature; noneSim score of the `none` option
 * @returns {{ choice: string|null, probabilities: Record<string, number>, confidence: number, ranked: [string, number][] }}
 */
export function choiceFromSims(simByLabel, opts) {
  const T = opts?.T > 0 ? opts.T : 1;
  const labels = Object.keys(simByLabel || {}).filter((l) => l !== 'none');
  const hasNone = Number.isFinite(opts?.noneSim);
  // Non-finite scores get a very low logit instead of -Infinity so softmax never sees NaN.
  const logits = labels.map((l) => (Number.isFinite(simByLabel[l]) ? simByLabel[l] / T : -1e9));
  if (hasNone) logits.push(opts.noneSim / T);
  const probs = softmax(logits);
  /** @type {Record<string, number>} */
  const probabilities = {};
  labels.forEach((l, i) => {
    probabilities[l] = probs[i];
  });
  probabilities.none = hasNone ? probs[labels.length] : labels.length ? 0 : 1;
  const ranked = /** @type {[string, number][]} */ (Object.entries(probabilities).sort((a, b) => b[1] - a[1]));
  const top = ranked[0]?.[0] ?? 'none';
  return {
    choice: top === 'none' ? null : top,
    probabilities,
    confidence: choiceConfidence(probabilities),
    ranked
  };
}

// ---------------------------------------------------------------------------
// Post scoring and answers
// ---------------------------------------------------------------------------

/**
 * @param {ArrayLike<number>|ArrayLike<number>[]|undefined} v
 * @returns {ArrayLike<number>[]}
 */
function asVecList(v) {
  if (!v || !v.length) return [];
  return typeof v[0] === 'number' ? [/** @type {ArrayLike<number>} */ (v)] : /** @type {ArrayLike<number>[]} */ (v);
}

/**
 * @param {number} sim
 * @param {BgStats|undefined} stats
 * @param {'raw'|'centered'|'z'} mode
 */
function tagScore(sim, stats, mode) {
  if (mode === 'raw' || !stats) return sim;
  if (mode === 'centered') return sim - stats.mean;
  return zScore(sim, stats);
}

/**
 * Raw System 1 scores for one post (used by the eval harness and by decideFromEmbeddings).
 * @param {object} args
 * @param {ArrayLike<number>[]} args.postVecs
 * @param {ArrayLike<number>|ArrayLike<number>[]} [args.queryVec]   one or several (recipe B/D) query vectors
 * @param {BgStats|BgStats[]} [args.bgStats]                        stats per query vector (same order)
 * @param {Record<string, ArrayLike<number>|ArrayLike<number>[]>} [args.labelVecs]   label -> vector or anchor vectors
 * @param {Record<string, BgStats>} [args.labelBgStats]                             from labelBgStatsFor (same agg)
 * @param {'raw'|'centered'|'z'} [args.tagScoreMode]
 * @param {'max'|'mean'|'top2'} [args.labelAgg]                                     anchor aggregation
 * @param {string} [args.postText]                                                  post text for the lexical term
 * @param {Record<string, Set<string>|string[]>} [args.labelTerms]                 labelLexTerms() per label
 * @param {number} [args.lexBeta]                                                   weight of lexicalOverlap (0 = off)
 * @param {number} [args.lexCap]
 * @returns {{ match: { sim: number, z: number } | null, tags: Record<string, { sim: number, z: number|null, score: number }> }}
 */
export function scoreEmbeddings({
  postVecs,
  queryVec,
  bgStats: stats,
  labelVecs,
  labelBgStats,
  tagScoreMode = 'raw',
  labelAgg = 'max',
  postText,
  labelTerms,
  lexBeta = 0,
  lexCap = 3
}) {
  const queries = asVecList(queryVec);
  const statsList = Array.isArray(stats) ? stats : stats ? [stats] : [];
  let match = null;
  queries.forEach((q, i) => {
    const sim = pooledSimilarity(postVecs, q);
    const z = zScore(sim, statsList[i] || statsList[0] || { mean: 0, std: 1 });
    if (!match || z > match.z) match = { sim, z };
  });
  /** @type {Record<string, { sim: number, z: number|null, score: number }>} */
  const tags = {};
  const postTerms = lexBeta && labelTerms && postText ? lexTerms(postText) : null;
  for (const [label, vec] of Object.entries(labelVecs || {})) {
    const sim = labelSimilarity(postVecs, vec, labelAgg);
    const st = labelBgStats?.[label];
    let score = tagScore(sim, st, tagScoreMode);
    if (postTerms && labelTerms[label]) score += lexBeta * lexicalOverlap(postTerms, labelTerms[label], lexCap);
    tags[label] = { sim, z: st ? zScore(sim, st) : null, score };
  }
  return { match, tags };
}

/**
 * Answers for one post, shaped like lib/decision/types.js:
 *  - matches_prompt : NoulAnswer (only when a query vector is given)
 *  - primary_tag    : ChoiceAnswer over the labels plus 'none' (only when label vectors are given)
 *  - tag:<label>    : NoulAnswer for the top `tagNoulsTopK` labels (needs labelBgStats and tag.multi)
 *  - lens:<id>      : NoulAnswer per entry of `lensQueries`, scored EXACTLY like matches_prompt (same
 *                     pooled similarity, z-score and `calibration.match`), never with the tag recipe
 * @param {object} args
 * @param {ArrayLike<number>[]} args.postVecs
 * @param {ArrayLike<number>|ArrayLike<number>[]} [args.queryVec]
 * @param {BgStats|BgStats[]} [args.bgStats]
 * @param {Record<string, ArrayLike<number>|ArrayLike<number>[]>} [args.labelVecs]  vectors of labelAnchorTexts()
 * @param {Record<string, BgStats>} [args.labelBgStats]
 * @param {string} [args.postText]                                  needed when calibration.tag.lexical.beta > 0
 * @param {Record<string, Set<string>|string[]>} [args.labelTerms]  labelLexTerms() per label (same condition)
 * @param {Record<string, { queryVec: ArrayLike<number>|ArrayLike<number>[], bgStats: BgStats|BgStats[] }>} [args.lensQueries]  question id (`lens:<id>`) -> that prompt's query vectors and background stats
 * @param {System1Calibration} args.calibration
 * @param {{ source?: string, tagNoulsTopK?: number }} [args.options]
 * @returns {Record<string, import('./types.js').Answer>}
 */
export function decideFromEmbeddings({ postVecs, queryVec, bgStats: stats, labelVecs, labelBgStats, postText, labelTerms, lensQueries, calibration, options = {} }) {
  const source = options.source || 'system1';
  const topK = options.tagNoulsTopK ?? 3;
  const tagCal = calibration?.tag || { score: 'raw', T: 0.05, noneSim: undefined };
  const scores = scoreEmbeddings({
    postVecs,
    queryVec,
    bgStats: stats,
    labelVecs,
    labelBgStats,
    tagScoreMode: tagCal.score || 'raw',
    labelAgg: tagCal.agg || 'max',
    postText,
    labelTerms,
    lexBeta: tagCal.lexical?.beta || 0,
    lexCap: tagCal.lexical?.cap || 3
  });

  /** @type {Record<string, import('./types.js').Answer>} */
  const answers = {};
  if (scores.match) {
    const { a, b } = calibration?.match || { a: 1, b: 0 };
    answers[Q.MATCHES_PROMPT] = noulAnswer(sigmoid(a * scores.match.z + b), source);
  }

  // Lenses: the matches_prompt recipe once per prompt (one post vector set, one query per lens).
  for (const [qid, lens] of Object.entries(lensQueries || {})) {
    const lensMatch = scoreEmbeddings({ postVecs, queryVec: lens.queryVec, bgStats: lens.bgStats }).match;
    if (!lensMatch) continue;
    const { a, b } = calibration?.match || { a: 1, b: 0 };
    answers[qid] = noulAnswer(sigmoid(a * lensMatch.z + b), source);
  }

  const labels = Object.keys(scores.tags);
  if (labels.length) {
    const scoreByLabel = Object.fromEntries(labels.map((l) => [l, scores.tags[l].score]));
    const c = choiceFromSims(scoreByLabel, { T: tagCal.T, noneSim: tagCal.noneSim });
    answers[Q.PRIMARY_TAG] = { type: 'choice', choice: c.choice, probabilities: c.probabilities, confidence: c.confidence, source };

    const multi = tagCal.multi;
    if (multi && topK > 0) {
      const top = c.ranked.filter(([l]) => l !== 'none').slice(0, topK);
      for (const [label] of top) {
        const z = scores.tags[label].z;
        if (z === null) continue;
        answers[`${Q.TAG_PREFIX}${label}`] = noulAnswer(clamp01(sigmoid(multi.a * z + multi.b)), source);
      }
    }
  }
  return answers;
}
