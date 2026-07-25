/**
 * Progressive-enhancement inference router.
 * Tries browser Prompt API → WebGPU → (future cloud) in order.
 */
import { browserPromptProvider } from './providers/browser-prompt.js';
import { webgpuProvider } from './providers/webgpu.js';
import { cloudProvider } from './providers/cloud.js';
import { keywordProvider } from './providers/keyword-status.js';

/** Semantic inference providers in priority order. */
const DEFAULT_SEMANTIC_PROVIDERS = [browserPromptProvider, webgpuProvider, cloudProvider];

/** All providers for status reporting (includes keyword fallback tier). */
const DEFAULT_STATUS_PROVIDERS = [browserPromptProvider, webgpuProvider, keywordProvider];

/**
 * @param {object[]} semanticProviders
 * @param {object[]} statusProviders
 */
export function createRouter(semanticProviders, statusProviders) {
  return {
    /**
     * @param {import('./types.js').InferJsonRequest} req
     * @returns {Promise<import('./types.js').InferJsonResult | null>}
     */
    async inferJson(req) {
      for (const provider of semanticProviders) {
        if (!(await provider.isAvailable())) continue;

        const data = await provider.inferJson(req);
        if (data) {
          return {
            data,
            engine: provider.getDisplayName(),
            tier: provider.tier
          };
        }
      }
      return null;
    },

    /**
     * @returns {Promise<import('./types.js').EngineStatus>}
     */
    async checkEngineStatus() {
      for (const provider of statusProviders) {
        try {
          const status = await provider.getEngineStatus?.();
          if (!status) continue;

          if (status.status === 'ready' || status.status === 'downloading') {
            return status;
          }
        } catch (err) {
          console.warn(`[router] Status check failed for ${provider.getDisplayName?.()}:`, err);
        }
      }

      return keywordProvider.getEngineStatus();
    }
  };
}

const defaultRouter = createRouter(DEFAULT_SEMANTIC_PROVIDERS, DEFAULT_STATUS_PROVIDERS);

export const inferJson = defaultRouter.inferJson.bind(defaultRouter);
export const checkEngineStatus = defaultRouter.checkEngineStatus.bind(defaultRouter);

export { browserPromptProvider, webgpuProvider, cloudProvider, keywordProvider };
export { DEFAULT_SEMANTIC_PROVIDERS, DEFAULT_STATUS_PROVIDERS };
