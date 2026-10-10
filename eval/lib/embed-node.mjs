/**
 * Node embedding helper for the System 1 eval.
 *
 * Uses the same q8 ONNX weights (eval/.cache/models, fetched by scripts/fetch-models.mjs and bundled
 * into the extension by scripts/build-ext.mjs) and the same pooling as the offscreen host, with no
 * network access. Vectors are cached in eval/.cache/embeddings-<model>[-web].json keyed by a hash of
 * the exact embedded text (including any query prefix), so reruns only embed new texts.
 *
 * Runtime: by default the model runs on onnxruntime-web's WebAssembly backend with the very wasm
 * file the extension bundles (node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.*,
 * copied to dist/ext/lib/vendor by scripts/build-ext.mjs), so the calibration is fitted on exactly
 * the vectors the offscreen host computes (e2e/parity.spec.mjs). onnxruntime-node's native int8
 * kernels round differently for a few percent of texts (cosine ~0.997 to the browser).
 * S1_EVAL_RUNTIME=node selects onnxruntime-node instead (faster; not browser-exact).
 *
 * The runtime is chosen when Transformers.js is first imported (once per process), so this module
 * must be imported before anything else imports '@huggingface/transformers'.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getModelSpec } from '../../lib/decision/models.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODELS_DIR = path.join(ROOT, 'eval/.cache/models');
const TRANSFORMERS_DIST = path.join(ROOT, 'node_modules/@huggingface/transformers/dist');

/** 'web' (onnxruntime-web wasm, browser-exact; default) or 'node' (onnxruntime-node). */
export const RUNTIME = process.env.S1_EVAL_RUNTIME === 'node' ? 'node' : 'web';

/**
 * Makes Transformers.js use onnxruntime-web (wasm) in Node through its `Symbol.for('onnxruntime')`
 * hook. Transformers.js creates its tensors with onnxruntime-common's Tensor class, onnxruntime-web
 * bundles its own: feeds and outputs are converted at the session boundary.
 * @returns {Promise<{ env: any, version: string }>}
 */
async function installOrtWeb() {
  const ortWeb = await import('onnxruntime-web');
  const common = await import('onnxruntime-common');
  ortWeb.env.wasm.wasmPaths = {
    mjs: pathToFileURL(path.join(TRANSFORMERS_DIST, 'ort-wasm-simd-threaded.jsep.mjs')).href,
    wasm: pathToFileURL(path.join(TRANSFORMERS_DIST, 'ort-wasm-simd-threaded.jsep.wasm')).href
  };
  // Thread count does not change the numbers (checked against the browser's 4 threads).
  ortWeb.env.wasm.numThreads = Math.max(1, Math.min(4, Math.ceil((os.availableParallelism?.() || os.cpus().length) / 2)));
  const toWeb = (t) => new ortWeb.Tensor(t.type, t.data, t.dims);
  const toCommon = (t) => new common.Tensor(t.type, t.data, t.dims);
  globalThis[Symbol.for('onnxruntime')] = {
    ...ortWeb,
    env: ortWeb.env,
    Tensor: common.Tensor,
    InferenceSession: {
      async create(model, options) {
        const session = await ortWeb.InferenceSession.create(model, { ...options, executionProviders: ['wasm'] });
        return {
          inputNames: session.inputNames,
          outputNames: session.outputNames,
          async run(feeds, ...rest) {
            const out = await session.run(Object.fromEntries(Object.entries(feeds).map(([k, v]) => [k, toWeb(v)])), ...rest);
            return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, toCommon(v)]));
          },
          release: () => session.release()
        };
      }
    }
  };
  return { env: ortWeb.env, version: ortWeb.env.versions?.web || 'unknown' };
}

const ortWebInfo = RUNTIME === 'web' ? await installOrtWeb() : null;
const { pipeline, env } = await import('@huggingface/transformers');
if (ortWebInfo && env.backends?.onnx !== ortWebInfo.env) {
  throw new Error('eval/lib/embed-node.mjs: @huggingface/transformers was imported before this module, so it is not running on onnxruntime-web.');
}

/** Human-readable runtime, recorded in the calibration and the report. */
export const RUNTIME_LABEL =
  RUNTIME === 'web' ? `onnxruntime-web ${ortWebInfo?.version} (wasm, the extension's runtime)` : 'onnxruntime-node (native CPU)';

env.cacheDir = MODELS_DIR;
env.localModelPath = MODELS_DIR;
env.allowLocalModels = true;
env.allowRemoteModels = false;

/** @param {string} text */
export function textKey(text) {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex');
}

/**
 * @param {string} modelKey  registry key ('bge-small' | 'minilm')
 * @param {{ cache?: boolean, batchSize?: number, log?: (msg: string) => void }} [opts]
 *   batchSize defaults to 1: one text per inference call, which is deterministic and matches the browser host.
 */
export async function createEmbedder(modelKey, opts = {}) {
  const spec = getModelSpec(modelKey);
  if (spec.key !== modelKey) throw new Error(`Unknown model key "${modelKey}"`);
  const batchSize = opts.batchSize || 1;
  const log = opts.log || (() => {});
  const useCache = opts.cache !== false;
  // q8 activations are quantized per call, so a vector depends on what it was batched with:
  // single-text vectors (batch 1, what the extension parity test uses) get their own cache file,
  // and so does each runtime (the native and wasm kernels round differently).
  const cacheFile = path.join(ROOT, 'eval/.cache', `embeddings-${spec.key}${RUNTIME === 'web' ? '-web' : ''}${batchSize > 1 ? `-b${batchSize}` : ''}.json`);

  /** @type {Record<string, number[]>} */
  let store = {};
  if (useCache && fs.existsSync(cacheFile)) {
    try {
      store = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch {
      store = {};
    }
  }
  let dirty = false;
  const save = () => {
    if (!useCache || !dirty) return;
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(store));
    dirty = false;
  };

  /** @type {any} */
  let extractor = null;
  const load = async () => {
    if (!extractor) {
      const t0 = performance.now();
      // 'auto' maps to the execution providers of the runtime installed above (wasm for onnxruntime-web).
      extractor = await pipeline('feature-extraction', spec.id, RUNTIME === 'web' ? { dtype: spec.dtype, device: 'auto' } : { dtype: spec.dtype });
      log(`${spec.key}: loaded ${spec.id} (${spec.dtype}) on ${RUNTIME_LABEL} in ${Math.round(performance.now() - t0)} ms`);
    }
    return extractor;
  };

  /**
   * Embeds without the cache.
   * @param {string[]} texts
   * @returns {Promise<number[][]>}
   */
  const embedRaw = async (texts) => {
    const ex = await load();
    const out = await ex(texts, { pooling: spec.pooling, normalize: true });
    return out.tolist();
  };

  /**
   * Embeds texts (cached). Missing texts are embedded in length-sorted batches to limit padding.
   * @param {string[]} texts
   * @returns {Promise<number[][]>}
   */
  const embed = async (texts) => {
    const missing = [...new Set(texts.filter((t) => !store[textKey(t)]))].sort((a, b) => a.length - b.length);
    if (missing.length) {
      const t0 = performance.now();
      for (let i = 0; i < missing.length; i += batchSize) {
        const batch = missing.slice(i, i + batchSize);
        const vecs = await embedRaw(batch);
        batch.forEach((t, j) => {
          store[textKey(t)] = vecs[j];
        });
        dirty = true;
        const done = Math.min(i + batchSize, missing.length);
        if (done % 40 < batchSize || done === missing.length) {
          save();
          log(`${spec.key}: embedded ${done}/${missing.length}`);
        }
      }
      save();
      log(`${spec.key}: ${missing.length} new texts in ${Math.round(performance.now() - t0)} ms`);
    }
    return texts.map((t) => store[textKey(t)]);
  };

  /**
   * Median wall time per text, uncached, for single-text calls and for one batch.
   * @param {string[]} texts
   */
  const measureLatency = async (texts) => {
    await embedRaw([texts[0]]);
    const single = [];
    for (const t of texts) {
      const t0 = performance.now();
      await embedRaw([t]);
      single.push(performance.now() - t0);
    }
    single.sort((a, b) => a - b);
    const t0 = performance.now();
    await embedRaw(texts);
    const batchPerText = (performance.now() - t0) / texts.length;
    return {
      singleMedianMs: Math.round(single[single.length >> 1]),
      singleP90Ms: Math.round(single[Math.floor(single.length * 0.9)]),
      batchPerTextMs: Math.round(batchPerText),
      n: texts.length
    };
  };

  return {
    spec,
    runtime: RUNTIME_LABEL,
    embed,
    embedRaw,
    measureLatency,
    save,
    dispose: async () => {
      save();
      await extractor?.dispose?.();
      extractor = null;
    }
  };
}
