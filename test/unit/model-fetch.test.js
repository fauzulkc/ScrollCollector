/**
 * offscreen/model-fetch.js: Content-Length for bundled model files (silences Transformers.js'
 * "Unable to determine content-length" warning while keeping load progress).
 */
import { describe, test, expect } from 'vitest';
import { manifestSizes, modelPathOf, withModelContentLength, installModelFetch, MODEL_MANIFEST_PATH } from '../../offscreen/model-fetch.js';

const BASE = 'chrome-extension://abc/offscreen/offscreen.html';
const FILE = 'Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx';

/** A fetch whose responses carry no Content-Length (like chrome-extension:// responses). */
function bareFetch(calls = []) {
  return async (input, init) => {
    calls.push({ input, init });
    return new Response(new Uint8Array([1, 2, 3, 4, 5]), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
  };
}

describe('model fetch', () => {
  test('manifest sizes and model paths', () => {
    expect([...manifestSizes({ files: { [FILE]: 5, bad: -1, worse: 'x', '/lead/slash.json': 2 } })]).toEqual([[FILE, 5], ['lead/slash.json', 2]]);
    expect(manifestSizes(null).size).toBe(0);
    expect(modelPathOf(`/models/${FILE}`, BASE)).toBe(FILE);
    expect(modelPathOf(new URL(`chrome-extension://abc/models/${FILE}`))).toBe(FILE);
    expect(modelPathOf({ url: `chrome-extension://abc/models/${FILE}` })).toBe(FILE);
    expect(modelPathOf('/lib/vendor/ort.wasm', BASE)).toBeNull();
    expect(MODEL_MANIFEST_PATH).toBe('models/manifest.json');
  });

  test('adds Content-Length to listed model files only; the body is untouched', async () => {
    const calls = [];
    const f = withModelContentLength(bareFetch(calls), new Map([[FILE, 5]]), { base: BASE });
    const res = await f(`/models/${FILE}`);
    expect(res.headers.get('Content-Length')).toBe('5');
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    expect((await f('/models/unknown.json')).headers.get('Content-Length')).toBeNull();
    expect((await f('/lib/decision/calibration/minilm.q8.json')).headers.get('Content-Length')).toBeNull();
    expect(calls).toHaveLength(3);
  });

  test('installModelFetch wraps the target fetch once, and not at all without a manifest', async () => {
    const target = { fetch: bareFetch(), location: { href: BASE } };
    expect(await installModelFetch({ target, loadManifest: async () => ({ files: {} }) })).toBe(false);
    expect(await installModelFetch({ target, loadManifest: async () => ({ files: { [FILE]: 5 } }) })).toBe(true);
    expect((await target.fetch(`/models/${FILE}`)).headers.get('Content-Length')).toBe('5');
    expect(await installModelFetch({ target, loadManifest: async () => ({ files: { [FILE]: 5 } }) })).toBe(false);
    await expect(installModelFetch({ target: {}, loadManifest: async () => ({}) })).resolves.toBe(false);
  });
});
