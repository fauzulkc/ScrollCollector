/**
 * System 1 scorer: the ONE implementation of the deployed System 1 decision path, shared by the
 * offscreen host (offscreen/system1-host.js, Transformers.js in the browser) and the Node eval
 * (eval/run-eval.mjs, onnxruntime-node). Given the same vectors both produce the same answers, so
 * the calibration fitted offline applies unchanged in the extension.
 *
 *   post text (already normalizeForDecision()d)
 *     -> chunkText(maxChars = calibration.chunk.maxChars)
 *     -> embed each chunk (one text per model call: q8 quantizes activations per call)
 *     -> decideFromEmbeddings() with the prepared spec:
 *          query vectors      queryTextsForRecipe(calibration.recipe, prompt, calibration.queryPrefix)
 *          query bg stats     bgStatsFor(query, background corpus, { trim: match.bgTrim, minStd })
 *          label anchors      labelAnchorTexts(label, description, labelTemplate / labelAnchors / labelPrefix)
 *          label bg stats     labelBgStatsFor(anchors, background corpus, { agg: tag.agg })
 *          label lex terms    labelLexTerms(label, description)
 *
 * The background corpus is embedded once per scorer (one scorer per model); prepared specs are
 * cached by spec.specHash (small LRU). Vector caching across specs and reloads is the embed
 * function's job (the host puts an IndexedDB cache behind it, the eval a JSON file).
 *
 * Pure apart from the injected `embed`: no browser or Node APIs.
 */
import * as S1 from './system1-math.js';
import { BACKGROUND_CORPUS } from './background-corpus.js';
import { Q } from './types.js';
import { cleanPrompt } from './questions.js';
import { specHash as computeSpecHash } from './state.js';

/** Prepared specs kept per scorer (a prompt edit or tag change creates a new one). */
const DEFAULT_MAX_SPECS = 8;

/**
 * @callback EmbedFn
 * @param {string[]} texts               embedded exactly as given (prefixes are already applied)
 * @param {{ isQuery: boolean }} opts    true for prompt query texts and label anchors (a hint only)
 * @returns {Promise<(Float32Array|number[])[]>}  one vector per text, same order
 */

/**
 * The spec of one decision call (the cascade's decideBatch context plus its question ids).
 * @typedef {object} ScorerSpec
 * @property {string} [specHash]          cache key; computed from the rest when missing
 * @property {{ raw?: string, cleaned?: string, expansion?: string }} [prompt]
 * @property {{ label: string, description?: string|null }[]} [tags]
 * @property {Record<string, unknown>|string[]} [questions]   question ids to answer (matches_prompt,
 *                                        primary_tag); when missing: matches_prompt for a non-empty
 *                                        prompt, primary_tag for a non-empty tag list
 */

/**
 * @typedef {object} PreparedSpec
 * @property {string} key
 * @property {{ texts: string[], vecs: ArrayLike<number>[], stats: S1.BgStats[] }|null} query
 * @property {Record<string, ArrayLike<number>[]>|null} labelVecs
 * @property {Record<string, S1.BgStats>|null} labelBgStats
 * @property {Record<string, Set<string>>|null} labelTerms
 * @property {number} ms
 */

/**
 * `<model>.<dtype>@<corpusHash>`: identifies the calibration in the cascade's spec hash.
 * @param {{ model?: string, dtype?: string, corpusHash?: string }} calibration
 */
export function calibrationIdOf(calibration) {
  const c = calibration || {};
  return `${c.model || 'unknown'}.${c.dtype || 'q8'}@${c.corpusHash || S1.hashTexts([...BACKGROUND_CORPUS])}`;
}

/**
 * Throws `{ code: 'calibration_mismatch' }` when the calibration cannot be used with this model
 * and background corpus (a stale calibration silently gives wrong probabilities).
 *
 * @param {any} calibration
 * @param {{ modelSpec?: import('./models.js').EmbeddingModelSpec|null, corpus?: readonly string[]|null }} [opts]
 */
export function validateCalibration(calibration, { modelSpec = null, corpus = BACKGROUND_CORPUS } = {}) {
  /** @type {string[]} */
  const problems = [];
  if (!calibration || typeof calibration !== 'object') {
    problems.push('no calibration');
  } else {
    if (!Number.isFinite(calibration.match?.a) || !Number.isFinite(calibration.match?.b)) problems.push('match.a/b missing');
    if (!Number.isFinite(calibration.tag?.T)) problems.push('tag.T missing');
    if (modelSpec) {
      if (calibration.model && calibration.model !== modelSpec.key) problems.push(`fitted for ${calibration.model}, not ${modelSpec.key}`);
      if (calibration.dtype && calibration.dtype !== modelSpec.dtype) problems.push(`dtype ${calibration.dtype} != ${modelSpec.dtype}`);
      if (calibration.pooling && calibration.pooling !== modelSpec.pooling) problems.push(`pooling ${calibration.pooling} != ${modelSpec.pooling}`);
      if ((calibration.queryPrefix ?? '') !== (modelSpec.queryPrefix ?? '')) problems.push('query prefix differs from the model registry');
    }
    if (corpus && calibration.corpusHash && calibration.corpusHash !== S1.hashTexts([...corpus])) {
      problems.push('background corpus changed since the calibration was fitted (re-run eval/run-eval.mjs --write-calibration)');
    }
  }
  if (problems.length) {
    throw Object.assign(new Error(`System 1 calibration unusable: ${problems.join('; ')}`), { code: 'calibration_mismatch' });
  }
}

/**
 * Question ids requested by a spec.
 * @param {ScorerSpec} spec
 * @returns {{ match: boolean, tags: boolean }}
 */
function wanted(spec) {
  const q = spec?.questions;
  if (q && typeof q === 'object') {
    const ids = new Set(Array.isArray(q) ? q.map(String) : Object.keys(q).filter((k) => q[k]));
    return { match: ids.has(Q.MATCHES_PROMPT), tags: ids.has(Q.PRIMARY_TAG) };
  }
  return { match: !!String(spec?.prompt?.raw || '').trim(), tags: Array.isArray(spec?.tags) && spec.tags.length > 0 };
}

/**
 * Enabled tags as given, de-duplicated by label (first wins).
 * @param {ScorerSpec} spec
 * @returns {{ label: string, description: string }[]}
 */
function specTags(spec) {
  const out = [];
  const seen = new Set();
  for (const t of Array.isArray(spec?.tags) ? spec.tags : []) {
    const label = typeof t === 'string' ? t : t?.label;
    if (typeof label !== 'string' || !label || seen.has(label)) continue;
    seen.add(label);
    const description = typeof t === 'object' && typeof t?.description === 'string' ? t.description : '';
    out.push({ label, description });
  }
  return out;
}

/**
 * @param {{
 *   embed: EmbedFn,
 *   calibration: S1.System1Calibration & Record<string, any>,
 *   modelSpec?: import('./models.js').EmbeddingModelSpec|null,
 *   corpus?: readonly string[],
 *   maxSpecs?: number,
 *   now?: () => number
 * }} deps
 */
export function createSystem1Scorer({
  embed,
  calibration,
  modelSpec = null,
  corpus = BACKGROUND_CORPUS,
  maxSpecs = DEFAULT_MAX_SPECS,
  now = () => (globalThis.performance ? globalThis.performance.now() : Date.now())
}) {
  if (typeof embed !== 'function') throw new TypeError('createSystem1Scorer: embed must be a function');
  validateCalibration(calibration, { modelSpec, corpus });

  const prefix = calibration.queryPrefix || '';
  const maxChars = calibration.chunk?.maxChars || S1.DEFAULT_CHUNK_CHARS;
  const statOpts = { trim: calibration.match?.bgTrim ?? S1.DEFAULT_BG_TRIM, minStd: calibration.match?.minStd ?? S1.MIN_BG_STD };
  const labelOpts = {
    template: calibration.labelTemplate || 'about',
    anchors: calibration.labelAnchors || 'single',
    prefix: calibration.labelPrefix ? prefix : ''
  };
  const agg = calibration.tag?.agg || 'max';
  const corpusTexts = [...corpus];

  /** @type {Promise<ArrayLike<number>[]>|null} */
  let corpusPromise = null;
  /** @type {Map<string, Promise<PreparedSpec>>} insertion order = LRU order */
  const prepared = new Map();
  const counters = { prepares: 0, decided: 0, embeddedTexts: 0 };

  /**
   * Embeds distinct texts once and maps the vectors back.
   * @param {string[]} texts
   * @param {boolean} isQuery
   */
  async function embedAll(texts, isQuery) {
    const unique = [...new Set(texts)];
    if (!unique.length) return [];
    const vecs = await embed(unique, { isQuery });
    if (!Array.isArray(vecs) || vecs.length !== unique.length) {
      throw Object.assign(new Error(`embed returned ${Array.isArray(vecs) ? vecs.length : 'no'} vectors for ${unique.length} texts`), { code: 's1_embed_error' });
    }
    for (const v of vecs) {
      if (!v || typeof v.length !== 'number' || !v.length || (modelSpec?.dims && v.length !== modelSpec.dims)) {
        throw Object.assign(new Error('embed returned a malformed vector'), { code: 's1_embed_error' });
      }
    }
    counters.embeddedTexts += unique.length;
    const byText = new Map(unique.map((t, i) => [t, vecs[i]]));
    return texts.map((t) => /** @type {ArrayLike<number>} */ (byText.get(t)));
  }

  /** Background corpus vectors, embedded once per scorer. */
  function corpusVectors() {
    if (!corpusPromise) {
      corpusPromise = embedAll(corpusTexts, false).catch((err) => {
        corpusPromise = null;
        throw err;
      });
    }
    return corpusPromise;
  }

  /**
   * Query texts embedded for a prompt (recipe from the calibration; a recipe needing a missing
   * expansion falls back to calibration.recipeFallback when set).
   * @param {ScorerSpec['prompt']} prompt
   */
  function queryTexts(prompt) {
    const raw = String(prompt?.raw || '').trim();
    if (!raw) return [];
    const parts = {
      raw,
      cleaned: typeof prompt?.cleaned === 'string' ? prompt.cleaned : cleanPrompt(raw),
      expansion: typeof prompt?.expansion === 'string' ? prompt.expansion : ''
    };
    let recipe = calibration.recipe || 'B';
    if ((recipe === 'C' || recipe === 'D') && !parts.expansion.trim() && calibration.recipeFallback) recipe = calibration.recipeFallback;
    return S1.queryTextsForRecipe(/** @type {any} */ (recipe), parts, prefix);
  }

  /**
   * Anchor texts embedded for one tag.
   * @param {{ label: string, description?: string|null }} tag
   */
  function labelAnchors(tag) {
    return S1.labelAnchorTexts(tag.label, tag.description || '', labelOpts);
  }

  /** @param {ScorerSpec} spec */
  function keyOf(spec) {
    if (typeof spec?.specHash === 'string' && spec.specHash) return spec.specHash;
    const w = wanted(spec);
    return computeSpecHash({ prompt: spec?.prompt || null, tags: specTags(spec), match: w.match, tagsWanted: w.tags });
  }

  /**
   * Embeds the query texts, label anchors (and, once, the background corpus) for a spec.
   * @param {ScorerSpec} spec
   * @returns {Promise<PreparedSpec>}
   */
  function prepare(spec) {
    const key = keyOf(spec);
    const hit = prepared.get(key);
    if (hit) {
      prepared.delete(key);
      prepared.set(key, hit);
      return hit;
    }
    const promise = (async () => {
      const t0 = now();
      counters.prepares += 1;
      const bgVecs = await corpusVectors();
      const w = wanted(spec);

      /** @type {PreparedSpec['query']} */
      let query = null;
      if (w.match) {
        const texts = queryTexts(spec?.prompt);
        if (texts.length) {
          const vecs = await embedAll(texts, true);
          query = { texts, vecs, stats: vecs.map((q) => S1.bgStatsFor(q, bgVecs, statOpts)) };
        }
      }

      let labelVecs = null;
      let labelBgStats = null;
      let labelTerms = null;
      const tags = w.tags ? specTags(spec) : [];
      if (tags.length) {
        const anchorsByLabel = tags.map((t) => labelAnchors(t));
        const vecs = await embedAll(anchorsByLabel.flat(), true);
        labelVecs = {};
        labelBgStats = {};
        labelTerms = {};
        let k = 0;
        tags.forEach((t, i) => {
          const anchors = vecs.slice(k, k + anchorsByLabel[i].length);
          k += anchorsByLabel[i].length;
          labelVecs[t.label] = anchors;
          labelBgStats[t.label] = S1.labelBgStatsFor(anchors, bgVecs, { ...statOpts, agg });
          labelTerms[t.label] = S1.labelLexTerms(t.label, t.description || '');
        });
      }
      return { key, query, labelVecs, labelBgStats, labelTerms, ms: now() - t0 };
    })();
    prepared.set(key, promise);
    promise.catch(() => {
      if (prepared.get(key) === promise) prepared.delete(key);
    });
    while (prepared.size > Math.max(1, maxSpecs)) prepared.delete(prepared.keys().next().value);
    return promise;
  }

  /**
   * Chunks embedded for a post (the text must already be normalizeForDecision()d).
   * @param {string} text
   */
  function postChunks(text) {
    return S1.chunkText(String(text ?? ''), { maxChars });
  }

  /**
   * Answers for posts, one result per item in order: { id, answers, ms } or { id, error, ms }.
   * An item without text gets error 'empty_text'.
   *
   * @param {{ id: string, text: string }[]} items
   * @param {ScorerSpec} spec
   * @param {{ tagNoulsTopK?: number, source?: string }} [options]
   * @returns {Promise<{ id: string, answers?: Record<string, import('./types.js').Answer>, ms: number, error?: string }[]>}
   */
  async function decideItems(items, spec, options = {}) {
    const prep = await prepare(spec);
    const out = [];
    for (const item of Array.isArray(items) ? items : []) {
      const t0 = now();
      const id = item?.id;
      const text = String(item?.text ?? '');
      const chunks = postChunks(text);
      if (!chunks.length) {
        out.push({ id, error: 'empty_text', ms: 0 });
        continue;
      }
      try {
        const postVecs = await embedAll(chunks, false);
        const answers = S1.decideFromEmbeddings({
          postVecs,
          queryVec: prep.query?.vecs,
          bgStats: prep.query?.stats,
          labelVecs: prep.labelVecs || undefined,
          labelBgStats: prep.labelBgStats || undefined,
          postText: text,
          labelTerms: prep.labelTerms || undefined,
          calibration,
          options: { source: options.source || 'system1', tagNoulsTopK: options.tagNoulsTopK }
        });
        counters.decided += 1;
        out.push({ id, answers, ms: Math.round((now() - t0) * 10) / 10 });
      } catch (err) {
        const code = typeof err?.code === 'string' && err.code ? err.code : 's1_error';
        out.push({ id, error: code, ms: Math.round((now() - t0) * 10) / 10 });
      }
    }
    return out;
  }

  /** Embeds the background corpus now (so the first decision does not pay for it). */
  async function warm() {
    await corpusVectors();
  }

  /** Drops prepared specs and corpus vectors (e.g. after the embedding cache was cleared). */
  function clear() {
    prepared.clear();
    corpusPromise = null;
  }

  return {
    calibration,
    calibrationId: calibrationIdOf(calibration),
    floor: calibration.floor ? { ...calibration.floor } : null,
    prepare,
    decideItems,
    postChunks,
    queryTexts,
    labelAnchors,
    warm,
    clear,
    stats: () => ({ ...counters, preparedSpecs: prepared.size })
  };
}
