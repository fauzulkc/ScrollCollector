/**
 * Probability / confidence math shared by every decision provider, the offscreen System 1 host
 * and the Node eval harness. Pure functions, no browser APIs.
 *
 * Confidence definitions follow TypeSafe's Jev (https://docs.typesafe.ai/confidence):
 *  - noul   : |2p - 1|
 *  - choice : (pmax - 1/n) / (1 - 1/n)
 *  - score  : max(0, 1 - Σ p_i |i - m| / MAD_unif), m = argmax level, MAD_unif = mean |i - m| under a uniform spread
 */

/** @param {number} x */
export function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** @param {number} x */
export function sigmoid(x) {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

/**
 * Numerically stable softmax.
 * @param {number[]} logits
 * @returns {number[]}
 */
export function softmax(logits) {
  if (!logits.length) return [];
  const max = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

/** @param {number} p */
export function noulConfidence(p) {
  return Math.abs(2 * clamp01(p) - 1);
}

/**
 * Confidence of the verdict `p >= threshold`: 0 at the threshold, 1 at p = 0 or p = 1, linear on
 * each side. Equals noulConfidence(p) for threshold 0.5, so a floor calibrated on |2p - 1| keeps
 * its meaning there; for other thresholds the uncertain band moves with the threshold.
 *
 * @param {number} p
 * @param {number} threshold  in (0, 1); anything else falls back to 0.5
 */
export function thresholdConfidence(p, threshold) {
  const t = Number.isFinite(threshold) && threshold > 0 && threshold < 1 ? threshold : 0.5;
  const x = clamp01(p);
  return clamp01(x >= t ? (x - t) / (1 - t) : (t - x) / t);
}

/**
 * @param {Record<string, number>|number[]} probabilities
 * @returns {number}
 */
export function choiceConfidence(probabilities) {
  const values = Array.isArray(probabilities) ? probabilities : Object.values(probabilities);
  const n = values.length;
  if (n <= 1) return 1;
  const pmax = Math.max(...values);
  return clamp01((pmax - 1 / n) / (1 - 1 / n));
}

/**
 * @param {number[]} levelProbabilities  index = level (low -> high)
 * @returns {number}
 */
export function scoreConfidence(levelProbabilities) {
  const n = levelProbabilities.length;
  if (n <= 1) return 1;
  let m = 0;
  for (let i = 1; i < n; i++) if (levelProbabilities[i] > levelProbabilities[m]) m = i;
  let mad = 0;
  let madUnif = 0;
  for (let i = 0; i < n; i++) {
    mad += levelProbabilities[i] * Math.abs(i - m);
    madUnif += Math.abs(i - m) / n;
  }
  if (madUnif === 0) return 1;
  return clamp01(1 - mad / madUnif);
}

/**
 * Probability-weighted level index (Jev "score").
 * @param {number[]} levelProbabilities
 */
export function expectedLevel(levelProbabilities) {
  return levelProbabilities.reduce((acc, p, i) => acc + p * i, 0);
}

/**
 * Normalizes a map of non-negative weights into probabilities summing to 1.
 * @param {Record<string, number>} weights
 * @returns {Record<string, number>}
 */
export function normalizeDistribution(weights) {
  const entries = Object.entries(weights).map(([k, v]) => [k, Math.max(0, Number.isFinite(v) ? v : 0)]);
  const sum = entries.reduce((a, [, v]) => a + v, 0);
  if (sum === 0) {
    const u = entries.length ? 1 / entries.length : 0;
    return Object.fromEntries(entries.map(([k]) => [k, u]));
  }
  return Object.fromEntries(entries.map(([k, v]) => [k, v / sum]));
}

/**
 * Picks the arg-max key of a distribution.
 * @param {Record<string, number>} probabilities
 * @returns {string|null}
 */
export function argmax(probabilities) {
  let best = null;
  let bestP = -Infinity;
  for (const [k, p] of Object.entries(probabilities)) {
    if (p > bestP) {
      best = k;
      bestP = p;
    }
  }
  return best;
}
