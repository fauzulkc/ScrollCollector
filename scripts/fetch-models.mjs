#!/usr/bin/env node
/**
 * Downloads the System 1 embedding models (q8 ONNX) into eval/.cache/models.
 * The same files are used by the Node eval/calibration and bundled into
 * dist/ext/models by scripts/build-ext.mjs, so browser and Node run identical weights.
 *
 * Usage: node scripts/fetch-models.mjs [modelKey ...]   (default: all registry models)
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline, env } from '@huggingface/transformers';
import { MODEL_REGISTRY } from '../lib/decision/models.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

env.cacheDir = path.join(ROOT, 'eval/.cache/models');
env.allowLocalModels = false;
env.allowRemoteModels = true;

const keys = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(MODEL_REGISTRY);

for (const key of keys) {
  const spec = MODEL_REGISTRY[key];
  if (!spec) {
    console.error(`Unknown model key "${key}". Known: ${Object.keys(MODEL_REGISTRY).join(', ')}`);
    process.exitCode = 1;
    continue;
  }
  const t0 = performance.now();
  try {
    const extractor = await pipeline('feature-extraction', spec.id, { dtype: spec.dtype });
    const out = await extractor(['hello world'], { pooling: spec.pooling, normalize: true });
    console.log(`${key}: ${spec.id} dims=${out.dims.join('x')} in ${Math.round(performance.now() - t0)}ms`);
    await extractor.dispose?.();
  } catch (err) {
    console.error(`${key}: failed to fetch ${spec.id}: ${err?.message || err}`);
    process.exitCode = 1;
  }
}
