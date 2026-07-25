/**
 * Offscreen document for WebGPU / WASM inference via Transformers.js.
 * Used when the browser Prompt API is unavailable (e.g. Brave).
 */
import { pipeline, env } from '../lib/vendor/transformers.web.min.js';

const MODEL_ID = 'onnx-community/Qwen2.5-0.5B-Instruct';

/** @type {Promise<object> | null} */
let generatorPromise = null;

/** @type {'idle' | 'downloading' | 'ready' | 'error'} */
let modelStatus = 'idle';

env.useBrowserCache = true;
env.allowRemoteModels = true;

async function getGenerator() {
  if (generatorPromise) return generatorPromise;

  modelStatus = 'downloading';
  generatorPromise = (async () => {
    const device = typeof navigator !== 'undefined' && navigator.gpu ? 'webgpu' : 'wasm';
    const pipe = await pipeline('text-generation', MODEL_ID, {
      dtype: 'q4',
      device
    });
    modelStatus = 'ready';
    return pipe;
  })().catch((err) => {
    console.error('[offscreen-ai] Model load failed:', err);
    modelStatus = 'error';
    generatorPromise = null;
    throw err;
  });

  return generatorPromise;
}

/**
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @returns {string}
 */
function buildChatPrompt(systemPrompt, userPrompt) {
  return `<|im_start|>system\n${systemPrompt}\n<|im_start|>user\n${userPrompt}\n<|im_start|>assistant\n`;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'WEBGPU_STATUS') {
    (async () => {
      if (!navigator.gpu) {
        sendResponse({ available: false, status: 'no_webgpu', displayName: 'WebGPU (Qwen)' });
        return;
      }
      if (modelStatus === 'ready') {
        sendResponse({ available: true, status: 'ready', displayName: 'WebGPU (Qwen)' });
        return;
      }
      if (modelStatus === 'downloading') {
        sendResponse({ available: false, status: 'downloading', displayName: 'WebGPU (Qwen)' });
        return;
      }
      try {
        await getGenerator();
        sendResponse({ available: true, status: 'ready', displayName: 'WebGPU (Qwen)' });
      } catch {
        sendResponse({ available: false, status: modelStatus, displayName: 'WebGPU (Qwen)' });
      }
    })();
    return true;
  }

  if (message.type === 'WEBGPU_INFER_JSON') {
    (async () => {
      try {
        const { systemPrompt, userPrompt } = message.payload;
        const gen = await getGenerator();
        const prompt = buildChatPrompt(systemPrompt, userPrompt);
        const output = await gen(prompt, {
          max_new_tokens: 256,
          do_sample: false,
          return_full_text: false
        });
        const raw = output?.[0]?.generated_text ?? output?.generated_text ?? '';
        sendResponse({ success: true, raw: String(raw).trim() });
      } catch (err) {
        sendResponse({ success: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  return false;
});

console.info('[offscreen-ai] WebGPU inference worker ready.');
