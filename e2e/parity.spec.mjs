// Browser/Node embedding parity: the offscreen host's vectors (Transformers.js + ONNX Runtime web,
// bundled q8 weights, one text per call) for the fixed sentences of eval/reference-vectors.json must
// match the Node reference vectors written by the eval the calibration was fitted with
// (eval/lib/embed-node.mjs: the same onnxruntime-web wasm, run in Node).
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchWithExtension, collectConsole, ROOT, EXT_DIR } from './helpers/launch.mjs';
import { seed } from './helpers/ext.mjs';

const REFERENCE = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval/reference-vectors.json'), 'utf8')).models;
const MODELS = Object.entries(REFERENCE)
  .filter(([, m]) => fs.existsSync(path.join(EXT_DIR, 'models', m.id)))
  .map(([key, m]) => ({ key, texts: m.sentences.map((s) => s.text) }));
const MIN_COSINE = 0.999;

/** @param {number[]} a @param {number[]} b */
function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
}

test('offscreen embeddings match the Node reference vectors (cosine >= 0.999)', async () => {
  test.setTimeout(600000);
  expect(MODELS.length, 'no bundled model has reference vectors: run npm run build:ext').toBeGreaterThan(0);
  const ext = await launchWithExtension();
  try {
    // This test drives the offscreen host with its own client. The service worker's System 1 stays
    // off: an open panel would otherwise make the worker create the same (single) offscreen
    // document at the same moment.
    await seed(ext.serviceWorker, { intelligence: { system1: { enabled: false } } });
    const page = await ext.context.newPage();
    const logs = collectConsole(page);
    await page.goto(`chrome-extension://${ext.extensionId}/sidepanel.html`);
    const out = await page.evaluate(async (models) => {
      const { createOffscreenClient } = await import('/lib/offscreen-client.js');
      const client = createOffscreenClient();
      const res = {};
      for (const m of models) {
        const load = await client.sendToOffscreen('S1_LOAD', { model: m.key, device: 'wasm', dtype: 'q8' }, { timeoutMs: 240000 });
        if (!load.ok) {
          res[m.key] = { error: load.error || load.code };
          continue;
        }
        // Not from the cache: fresh single-text model calls.
        const fresh = await client.sendToOffscreen('S1_EMBED', { model: m.key, texts: m.texts, cache: false }, { timeoutMs: 120000 });
        // And through the cache (written by the call below, read back by the next one).
        await client.sendToOffscreen('S1_EMBED', { model: m.key, texts: m.texts }, { timeoutMs: 120000 });
        const cached = await client.sendToOffscreen('S1_EMBED', { model: m.key, texts: m.texts }, { timeoutMs: 120000 });
        res[m.key] = { load, fresh, cached };
      }
      const ping = await client.sendToOffscreen('OFFSCREEN_PING', {});
      return { res, ping };
    }, MODELS);

    for (const m of MODELS) {
      const r = out.res[m.key];
      expect(r.error, `${m.key} load`).toBeUndefined();
      expect(r.fresh.ok, `${m.key} embed`).toBe(true);
      const refs = REFERENCE[m.key].sentences.map((s) => s.vector);
      const cos = r.fresh.vectors.map((v, i) => cosine(v, refs[i]));
      const min = Math.min(...cos);
      const maxAbs = Math.max(...r.fresh.vectors.flatMap((v, i) => v.map((x, j) => Math.abs(x - refs[i][j]))));
      console.log(`[parity] ${m.key}: load ${Math.round(r.load.loadMs)} ms, ${m.texts.length} texts in ${Math.round(r.fresh.ms)} ms, cosine min ${min.toFixed(6)} mean ${(cos.reduce((a, b) => a + b, 0) / cos.length).toFixed(6)}, max |diff| ${maxAbs.toExponential(2)}`);
      expect(r.fresh.vectors).toHaveLength(m.texts.length);
      expect(r.fresh.vectors[0]).toHaveLength(refs[0].length);
      for (const [i, c] of cos.entries()) expect(c, `${m.key} sentence ${i}: ${m.texts[i].slice(0, 50)}`).toBeGreaterThanOrEqual(MIN_COSINE);
      // Cached vectors are the vectors that were computed.
      for (const [i, v] of r.cached.vectors.entries()) expect(cosine(v, r.fresh.vectors[i])).toBeGreaterThan(0.999999);
    }
    expect(out.ping.cspViolations).toEqual([]);
    expect(logs.filter((l) => /Content Security Policy|Refused to/i.test(l.text))).toEqual([]);
  } finally {
    await ext.close();
  }
});
