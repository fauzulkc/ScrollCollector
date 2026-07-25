/**
 * Shared inference types and JSON parsing utilities.
 */

/** @typedef {'ready' | 'downloading' | 'unavailable'} ProviderStatus */

/**
 * @typedef {object} EngineStatus
 * @property {number} tier - 1 = browser SLM, 2 = WebGPU, 3 = keyword
 * @property {string} name - Display label for the UI
 * @property {ProviderStatus} status
 * @property {string} [availability] - Raw availability string from the provider
 */

/**
 * @typedef {object} InferJsonRequest
 * @property {string} systemPrompt
 * @property {string} userPrompt
 * @property {object} [responseConstraint]
 */

/**
 * @typedef {object} InferJsonResult
 * @property {object} data - Parsed JSON from the model
 * @property {string} engine - Provider display name
 * @property {number} tier
 */

/**
 * Parse JSON from model output, tolerating markdown fences or extra prose.
 *
 * @param {string} text
 * @returns {object | null}
 */
export function parseModelJson(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // continue
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // continue
    }
  }
  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch {
      // continue
    }
  }
  return null;
}

/** @param {string} availability */
export function isModelReady(availability) {
  return availability === 'readily' || availability === 'available';
}

/** @param {string} availability */
export function isModelDownloadable(availability) {
  return availability === 'after-download' || availability === 'downloadable' || availability === 'downloading';
}
