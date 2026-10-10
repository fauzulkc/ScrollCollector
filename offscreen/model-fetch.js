/**
 * Content-Length for the bundled model files (offscreen document only).
 *
 * chrome-extension:// responses carry no Content-Length header. Transformers.js 3.4 reads it to
 * size its buffer and report progress whenever a progress_callback is passed, and otherwise logs
 * "Unable to determine content-length from response headers. Will expand buffer when needed." for
 * every model file (it shows up on chrome://extensions > Errors). Transformers.js 3.4 has no fetch
 * hook (it calls the global fetch), so the offscreen document's fetch is wrapped: responses for
 * /models/<path> that lack the header get it from models/manifest.json, which scripts/build-ext.mjs
 * writes with the byte size of every bundled model file. Everything else passes through untouched.
 */

/** Published path of the manifest: { files: { "<path under models/>": bytes } }. */
export const MODEL_MANIFEST_PATH = 'models/manifest.json';

const MODELS_PREFIX = '/models/';

/**
 * Bytes per path under /models/ from a manifest object (invalid entries dropped).
 * @param {unknown} manifest
 * @returns {Map<string, number>}
 */
export function manifestSizes(manifest) {
  const sizes = new Map();
  const files = manifest && typeof manifest === 'object' ? /** @type {any} */ (manifest).files : null;
  if (!files || typeof files !== 'object') return sizes;
  for (const [file, bytes] of Object.entries(files)) {
    if (typeof file === 'string' && Number.isInteger(bytes) && bytes >= 0) sizes.set(file.replace(/^\/+/, ''), bytes);
  }
  return sizes;
}

/**
 * The manifest key of a request for a bundled model file, or null.
 * @param {unknown} input   fetch() input (string, URL or Request)
 * @param {string} [base]
 */
export function modelPathOf(input, base = globalThis.location?.href) {
  let raw;
  if (typeof input === 'string') raw = input;
  else if (input && typeof input === 'object' && 'url' in input) raw = String(/** @type {any} */ (input).url);
  else if (input && typeof input === 'object' && 'href' in input) raw = String(/** @type {any} */ (input).href);
  else return null;
  let url;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return null;
  }
  if (!url.pathname.startsWith(MODELS_PREFIX)) return null;
  try {
    return decodeURIComponent(url.pathname.slice(MODELS_PREFIX.length));
  } catch {
    return null;
  }
}

/**
 * fetch() that adds Content-Length to bundled model files listed in `sizes`.
 * @param {typeof fetch} fetchImpl
 * @param {Map<string, number>} sizes
 * @param {{ base?: string }} [opts]
 * @returns {typeof fetch}
 */
export function withModelContentLength(fetchImpl, sizes, { base } = {}) {
  const wrapped = async (/** @type {any} */ input, /** @type {any} */ init) => {
    const res = await fetchImpl(input, init);
    const path = sizes.size ? modelPathOf(input, base) : null;
    if (!path || !res || !res.ok || !sizes.has(path) || res.headers.get('Content-Length') !== null) return res;
    const headers = new Headers(res.headers);
    headers.set('Content-Length', String(sizes.get(path)));
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
  /** @type {any} */ (wrapped).modelSizes = sizes;
  return /** @type {typeof fetch} */ (wrapped);
}

/**
 * Wraps `target.fetch` once the manifest is loaded. Resolves false (fetch untouched) when there is
 * no fetch, no manifest or an empty one.
 * @param {{ target?: any, loadManifest: () => Promise<unknown> }} opts
 * @returns {Promise<boolean>}
 */
export async function installModelFetch({ target = globalThis, loadManifest }) {
  if (!target || typeof target.fetch !== 'function' || target.fetch.modelSizes) return false;
  const sizes = manifestSizes(await loadManifest());
  if (!sizes.size || target.fetch.modelSizes) return false;
  target.fetch = withModelContentLength(target.fetch.bind(target), sizes, { base: target.location?.href });
  return true;
}
