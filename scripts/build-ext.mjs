#!/usr/bin/env node
/**
 * Assembles the loadable extension into dist/ext/.
 *
 *  - copies the runtime sources (manifest, background, content, side panel, ui, lib, offscreen, icons)
 *  - vendors the self-contained Transformers.js bundle + ONNX Runtime wasm files from node_modules
 *    (no CDN: MV3 forbids remote code and our CSP is script-src 'self' 'wasm-unsafe-eval')
 *  - bundles the q8 System 1 embedding weights from eval/.cache/models (run `npm run fetch:models` first)
 *    plus models/manifest.json with each model file's byte size (served as Content-Length, see
 *    offscreen/model-fetch.js)
 *
 * Usage: node scripts/build-ext.mjs [--out dir] [--no-models] [--models bge-small,minilm]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_REGISTRY } from '../lib/decision/models.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const OUT = path.resolve(ROOT, argValue('--out') || 'dist/ext');
const WITH_MODELS = !args.includes('--no-models');
const MODEL_KEYS = (argValue('--models') || Object.keys(MODEL_REGISTRY).join(',')).split(',').filter(Boolean);

const RUNTIME_ENTRIES = [
  'manifest.json',
  'background.js',
  'content.js',
  'sidepanel.html',
  'sidepanel.js',
  'sidepanel.css',
  'diagnostics.html',
  'diagnostics.js',
  'icons',
  'lib',
  'offscreen',
  'ui'
];

/** Paths (relative to ROOT) never shipped in the extension. */
const EXCLUDE = new Set([
  'lib/vendor/transformers.web.min.js',
  'icons/convert.py'
]);

const VENDOR_FILES = [
  'transformers.min.js',
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm'
];

function copyRecursive(src, dest) {
  const rel = path.relative(ROOT, src).split(path.sep).join('/');
  if (EXCLUDE.has(rel) || path.basename(src) === '.DS_Store') return 0;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    let n = 0;
    for (const entry of fs.readdirSync(src)) {
      n += copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
    return n;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return 1;
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let fileCount = 0;
for (const entry of RUNTIME_ENTRIES) {
  const src = path.join(ROOT, entry);
  if (!fs.existsSync(src)) continue;
  fileCount += copyRecursive(src, path.join(OUT, entry));
}

const vendorSrc = path.join(ROOT, 'node_modules/@huggingface/transformers/dist');
const vendorDest = path.join(OUT, 'lib/vendor');
fs.mkdirSync(vendorDest, { recursive: true });
for (const file of VENDOR_FILES) {
  const src = path.join(vendorSrc, file);
  if (!fs.existsSync(src)) {
    console.error(`[build-ext] Missing ${src}. Run \`npm install\` first.`);
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(vendorDest, file));
  fileCount += 1;
}

let modelBytes = 0;
/** models/manifest.json: byte size per bundled model file (offscreen/model-fetch.js adds them as Content-Length). */
const modelSizes = {};
if (WITH_MODELS) {
  const cacheRoot = path.join(ROOT, 'eval/.cache/models');
  for (const key of MODEL_KEYS) {
    const spec = MODEL_REGISTRY[key];
    if (!spec) {
      console.error(`[build-ext] Unknown model key "${key}".`);
      process.exit(1);
    }
    for (const file of spec.files) {
      const src = path.join(cacheRoot, spec.id, file);
      if (!fs.existsSync(src)) {
        console.error(`[build-ext] Missing model file ${src}. Run \`npm run fetch:models\` first.`);
        process.exit(1);
      }
      const dest = path.join(OUT, 'models', spec.id, file);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      const size = fs.statSync(src).size;
      modelSizes[`${spec.id}/${file}`] = size;
      modelBytes += size;
      fileCount += 1;
    }
  }
  fs.writeFileSync(path.join(OUT, 'models/manifest.json'), JSON.stringify({ files: modelSizes }, null, 2) + '\n');
  fileCount += 1;
}

const mb = (n) => (n / 1024 / 1024).toFixed(1);
console.log(
  `[build-ext] ${fileCount} files -> ${path.relative(ROOT, OUT)}` +
  (WITH_MODELS ? ` (models: ${MODEL_KEYS.join(', ')}, ${mb(modelBytes)} MB)` : ' (no models)')
);
