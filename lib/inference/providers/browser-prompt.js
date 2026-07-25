/**
 * Tier 1 — Browser Prompt API (LanguageModel / legacy window.ai).
 * Chrome: Gemini Nano | Edge: Phi-4-mini
 */
import { parseModelJson, isModelReady, isModelDownloadable } from '../types.js';
import { getBrowserModelDisplayName, getBrowserModelDownloadingLabel } from '../browser-detect.js';

export const tier = 1;

/** Session options for the modern LanguageModel API (Chrome 138+). */
const LM_SESSION_OPTIONS = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }]
};

const rootSessions = new Map();
const EVICT_ERROR_REGEX = /quota|context|token|session|destroyed|invalid state/i;

function getOrCreateRootSession(apiInfo, systemPrompt) {
  let sessionPromise = rootSessions.get(systemPrompt);
  if (!sessionPromise) {
    sessionPromise = createLanguageModelSession(apiInfo, systemPrompt).catch((err) => {
      rootSessions.delete(systemPrompt);
      throw err;
    });
    rootSessions.set(systemPrompt, sessionPromise);
  }
  return sessionPromise;
}

async function evictRootSession(systemPrompt) {
  const sessionPromise = rootSessions.get(systemPrompt);
  if (sessionPromise) {
    rootSessions.delete(systemPrompt);
    try {
      const session = await sessionPromise;
      if (session && typeof session.destroy === 'function') {
        session.destroy();
      }
    } catch {
      // Ignore errors during destroy
    }
  }
}

export async function resetSessions() {
  const entries = Array.from(rootSessions.values());
  rootSessions.clear();
  for (const sessionPromise of entries) {
    try {
      const session = await sessionPromise;
      if (session && typeof session.destroy === 'function') {
        session.destroy();
      }
    } catch {
      // Ignore errors during destroy
    }
  }
}

/**
 * @returns {{ kind: 'modern' | 'legacy', api: object } | null}
 */
export function getLanguageModelAPI() {
  const modern = typeof LanguageModel !== 'undefined'
    ? LanguageModel
    : (typeof globalThis !== 'undefined' ? globalThis.LanguageModel : undefined);

  if (modern) {
    return { kind: 'modern', api: modern };
  }

  let legacy = null;
  if (typeof chrome !== 'undefined' && chrome.aiOriginTrial?.languageModel) {
    legacy = chrome.aiOriginTrial.languageModel;
  } else if (typeof chrome !== 'undefined' && chrome.ai?.languageModel) {
    legacy = chrome.ai.languageModel;
  } else if (typeof self !== 'undefined' && self.ai?.languageModel) {
    legacy = self.ai.languageModel;
  } else if (typeof ai !== 'undefined' && ai.languageModel) {
    legacy = ai.languageModel;
  }

  return legacy ? { kind: 'legacy', api: legacy } : null;
}

/**
 * @param {{ kind: 'modern' | 'legacy', api: object }} apiInfo
 * @returns {Promise<string>}
 */
export async function queryModelAvailability(apiInfo) {
  if (apiInfo.kind === 'modern') {
    return apiInfo.api.availability(LM_SESSION_OPTIONS);
  }
  const capabilities = await apiInfo.api.capabilities();
  return capabilities.available;
}

/**
 * @param {{ kind: 'modern' | 'legacy', api: object }} apiInfo
 * @param {string} systemPrompt
 * @returns {Promise<object>}
 */
async function createLanguageModelSession(apiInfo, systemPrompt) {
  if (apiInfo.kind === 'modern') {
    const createOptions = {
      ...LM_SESSION_OPTIONS,
      initialPrompts: [{ role: 'system', content: systemPrompt }]
    };
    try {
      const params = await apiInfo.api.params();
      if (params) {
        createOptions.topK = params.defaultTopK;
        createOptions.temperature = Math.min(params.defaultTemperature ?? 1, 0.5);
      }
    } catch {
      // params() is extension-only
    }
    return apiInfo.api.create(createOptions);
  }
  return apiInfo.api.create({ systemPrompt });
}

/**
 * @param {object} session
 * @param {string} userPrompt
 * @param {object | null} responseConstraint
 * @returns {Promise<object | null>}
 */
async function promptForJson(session, userPrompt, responseConstraint = null) {
  const promptOptions = responseConstraint ? { responseConstraint } : undefined;
  const raw = await session.prompt(userPrompt, promptOptions);
  return parseModelJson(raw);
}

/**
 * @returns {Promise<{ present: boolean, availability?: string }>}
 */
export async function getAvailability() {
  const apiInfo = getLanguageModelAPI();
  if (!apiInfo) return { present: false };
  try {
    const availability = await queryModelAvailability(apiInfo);
    return { present: true, availability };
  } catch {
    return { present: true, availability: 'unavailable' };
  }
}

export function getDisplayName() {
  return getBrowserModelDisplayName();
}

/**
 * @returns {Promise<import('../types.js').EngineStatus | null>}
 */
export async function getEngineStatus() {
  const { present, availability } = await getAvailability();
  if (!present) return null;

  const name = getBrowserModelDisplayName();
  if (isModelReady(availability)) {
    return { tier, name, status: 'ready', availability };
  }
  if (isModelDownloadable(availability)) {
    return { tier, name: getBrowserModelDownloadingLabel(), status: 'downloading', availability };
  }
  return { tier, name, status: 'unavailable', availability };
}

/**
 * @returns {Promise<boolean>}
 */
export async function isAvailable() {
  const { present, availability } = await getAvailability();
  return present && isModelReady(availability);
}

/**
 * @param {import('../types.js').InferJsonRequest} req
 * @returns {Promise<object | null>}
 */
export async function inferJson({ systemPrompt, userPrompt, responseConstraint = null }) {
  try {
    const apiInfo = getLanguageModelAPI();
    if (!apiInfo) {
      return null;
    }

    const availability = await queryModelAvailability(apiInfo);

    if (isModelReady(availability)) {
      const rootSession = await getOrCreateRootSession(apiInfo, systemPrompt);
      let session = rootSession;
      let isClone = false;

      if (typeof rootSession.clone === 'function') {
        session = await rootSession.clone();
        isClone = true;
      }

      try {
        return await promptForJson(session, userPrompt, responseConstraint);
      } finally {
        if (isClone && session && typeof session.destroy === 'function') {
          session.destroy();
        }
      }
    }

    if (isModelDownloadable(availability)) {
      console.info('[browser-prompt] Model download triggered (status: %s).', availability);
      try {
        const session = await createLanguageModelSession(apiInfo, systemPrompt);
        session.destroy();
      } catch (downloadErr) {
        console.warn('[browser-prompt] Model download kickoff failed:', downloadErr);
      }
    }

    return null;
  } catch (err) {
    const message = err?.message || String(err || '');
    if (EVICT_ERROR_REGEX.test(message)) {
      await evictRootSession(systemPrompt);
    }
    console.warn('[browser-prompt] Inference failed:', err);
    return null;
  }
}

export const browserPromptProvider = {
  tier,
  getDisplayName,
  getAvailability,
  getEngineStatus,
  isAvailable,
  inferJson,
  resetSessions
};
