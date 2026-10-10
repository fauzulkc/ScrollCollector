/**
 * System 1 embedding model registry.
 * Shared by the offscreen host (browser), the Node eval harness and the build script.
 *
 * Weights are bundled under `models/<id>/` in the built extension (q8 ONNX), so the
 * browser never fetches them at runtime.
 *
 * MiniLM is the default: it is the smallest and fastest model and passes every matches_prompt gate
 * of the offline eval (eval/reports). BGE small stays selectable; it separates the uncertain band a
 * little better, which matters most when uncertain posts escalate to another provider.
 */

/**
 * @typedef {object} EmbeddingModelSpec
 * @property {string} key            Registry key stored in configuration.intelligence.system1.model
 * @property {string} id             Hugging Face repo id (also the folder under models/)
 * @property {string} label          Human-readable name for the settings UI
 * @property {number} paramsM        Parameter count in millions (the eval prefers the smallest passing model)
 * @property {'cls'|'mean'} pooling  Pooling used by the feature-extraction pipeline
 * @property {string} queryPrefix    Prefix applied to "query" side texts (prompt, labels)
 * @property {number} maxTokens      Model context length in word pieces
 * @property {number} dims           Embedding dimensionality
 * @property {string} dtype          Quantization used everywhere (browser + Node)
 * @property {string[]} files        Files (relative to the repo root) bundled into the extension
 */

/** @type {Record<string, EmbeddingModelSpec>} */
export const MODEL_REGISTRY = {
  minilm: {
    key: 'minilm',
    id: 'Xenova/all-MiniLM-L6-v2',
    label: 'MiniLM L6 v2 — fastest (default)',
    paramsM: 22,
    pooling: 'mean',
    queryPrefix: '',
    maxTokens: 256,
    dims: 384,
    dtype: 'q8',
    files: ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx']
  },
  'bge-small': {
    key: 'bge-small',
    id: 'Xenova/bge-small-en-v1.5',
    label: 'BGE small v1.5 — more accurate escalation',
    paramsM: 33,
    pooling: 'cls',
    queryPrefix: 'Represent this sentence for searching relevant passages: ',
    maxTokens: 512,
    dims: 384,
    dtype: 'q8',
    files: ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx']
  }
};

export const DEFAULT_MODEL_KEY = 'minilm';

/**
 * @param {string} key
 * @returns {EmbeddingModelSpec}
 */
export function getModelSpec(key) {
  return MODEL_REGISTRY[key] || MODEL_REGISTRY[DEFAULT_MODEL_KEY];
}
