/**
 * Tier 2 — WebGPU / Transformers.js via offscreen document.
 * Runs inference in offscreen/offscreen.html where WebGPU is available.
 */
import { parseModelJson } from '../types.js';

export const tier = 2;
const OFFSCREEN_PATH = 'offscreen/offscreen.html';
const INFER_TIMEOUT_MS = 120_000;

let offscreenCreating = null;

/**
 * Ensure the offscreen AI document exists (service worker context).
 */
async function ensureOffscreenDocument() {
  if (typeof chrome === 'undefined' || !chrome.offscreen) {
    return false;
  }

  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
  });

  if (existingContexts.length > 0) {
    return true;
  }

  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['WORKERS'],
      justification: 'Run on-device WebGPU inference when browser Prompt API is unavailable (e.g. Brave).'
    }).finally(() => {
      offscreenCreating = null;
    });
  }

  await offscreenCreating;
  return true;
}

/**
 * Query offscreen document for WebGPU / model availability.
 *
 * @returns {Promise<{ available: boolean, status: string, displayName?: string }>}
 */
async function queryOffscreenStatus() {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
    return { available: false, status: 'no_runtime' };
  }

  try {
    const ready = await ensureOffscreenDocument();
    if (!ready) return { available: false, status: 'no_offscreen_api' };

    return await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'WEBGPU_STATUS' }, (response) => {
        if (chrome.runtime.lastError || !response) {
          resolve({ available: false, status: 'error' });
          return;
        }
        resolve(response);
      });
    });
  } catch {
    return { available: false, status: 'error' };
  }
}

export function getDisplayName() {
  return 'WebGPU (Qwen)';
}

/**
 * @returns {Promise<import('../types.js').EngineStatus | null>}
 */
export async function getEngineStatus() {
  const status = await queryOffscreenStatus();
  if (status.status === 'downloading') {
    return { tier, name: `${getDisplayName()} (downloading…)`, status: 'downloading' };
  }
  if (status.available) {
    return { tier, name: getDisplayName(), status: 'ready' };
  }
  return null;
}

export async function isAvailable() {
  const status = await queryOffscreenStatus();
  return status.available === true;
}

/**
 * @param {import('../types.js').InferJsonRequest} req
 * @returns {Promise<object | null>}
 */
export async function inferJson({ systemPrompt, userPrompt, responseConstraint = null }) {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
    return null;
  }

  try {
    const ready = await ensureOffscreenDocument();
    if (!ready) return null;

    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebGPU inference timeout')), INFER_TIMEOUT_MS);
      chrome.runtime.sendMessage({
        type: 'WEBGPU_INFER_JSON',
        payload: { systemPrompt, userPrompt, responseConstraint }
      }, (result) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(result);
      });
    });

    if (!response?.success || !response.raw) {
      return null;
    }
    return parseModelJson(response.raw);
  } catch (err) {
    console.warn('[webgpu] Inference failed:', err);
    return null;
  }
}

export const webgpuProvider = {
  tier,
  getDisplayName,
  isAvailable,
  getEngineStatus,
  inferJson,
  ensureOffscreenDocument,
  queryOffscreenStatus
};
