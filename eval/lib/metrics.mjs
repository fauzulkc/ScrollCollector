/**
 * Metrics and fitting helpers for the System 1 eval (pure, Node or browser).
 */
import { sigmoid } from '../../lib/decision/confidence.js';

/**
 * Area under the ROC curve (Mann-Whitney U, ties count half). NaN when one class is missing.
 * @param {number[]} scores
 * @param {(0|1)[]} labels
 */
export function auroc(scores, labels) {
  const idx = scores.map((s, i) => i).sort((a, b) => scores[a] - scores[b]);
  let rank = 1;
  const ranks = new Array(scores.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && scores[idx[j + 1]] === scores[idx[i]]) j++;
    const avg = (rank + rank + (j - i)) / 2;
    for (let k = i; k <= j; k++) ranks[idx[k]] = avg;
    rank += j - i + 1;
    i = j + 1;
  }
  const nPos = labels.filter((l) => l === 1).length;
  const nNeg = labels.length - nPos;
  if (!nPos || !nNeg) return NaN;
  const sumPos = labels.reduce((acc, l, i) => acc + (l === 1 ? ranks[i] : 0), 0);
  return (sumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

/**
 * Expected calibration error of P(yes) with equal-width bins:
 * Σ_b (n_b / N) · |mean p_b − fraction positive_b|.
 * @param {number[]} probs
 * @param {(0|1)[]} labels
 * @param {number} [bins]
 */
export function ece(probs, labels, bins = 10) {
  if (!probs.length) return NaN;
  const sumP = new Array(bins).fill(0);
  const sumY = new Array(bins).fill(0);
  const n = new Array(bins).fill(0);
  probs.forEach((p, i) => {
    const b = Math.min(bins - 1, Math.floor(p * bins));
    sumP[b] += p;
    sumY[b] += labels[i];
    n[b]++;
  });
  let e = 0;
  for (let b = 0; b < bins; b++) if (n[b]) e += (n[b] / probs.length) * Math.abs(sumP[b] / n[b] - sumY[b] / n[b]);
  return e;
}

/**
 * Top-label ECE for a multi-class classifier: bins by the max probability, compares with accuracy.
 * @param {number[]} confidences   pmax per item
 * @param {(0|1)[]} correct
 * @param {number} [bins]
 */
export function topLabelEce(confidences, correct, bins = 10) {
  return ece(confidences, correct, bins);
}

/**
 * Mean binary log-loss.
 * @param {number[]} probs
 * @param {(0|1)[]} labels
 */
export function logLoss(probs, labels) {
  const eps = 1e-12;
  let s = 0;
  probs.forEach((p, i) => {
    const q = Math.min(1 - eps, Math.max(eps, p));
    s += labels[i] ? -Math.log(q) : -Math.log(1 - q);
  });
  return s / Math.max(1, probs.length);
}

/**
 * Platt scaling p = sigmoid(a·x + b), fitted by full-batch gradient descent (with momentum) on the
 * mean log-loss plus a small L2 penalty on `a`.
 * @param {number[]} xs
 * @param {(0|1)[]} ys
 * @param {{ iters?: number, lr?: number, l2?: number, weights?: number[] }} [opts]
 * @returns {{ a: number, b: number, loss: number }}
 */
export function fitPlatt(xs, ys, opts = {}) {
  const iters = opts.iters ?? 4000;
  const lr = opts.lr ?? 0.05;
  const l2 = opts.l2 ?? 1e-4;
  const w = opts.weights || xs.map(() => 1);
  const W = w.reduce((a, b) => a + b, 0) || 1;
  let a = 1;
  let b = 0;
  let va = 0;
  let vb = 0;
  for (let t = 0; t < iters; t++) {
    let ga = 0;
    let gb = 0;
    for (let i = 0; i < xs.length; i++) {
      const err = sigmoid(a * xs[i] + b) - ys[i];
      ga += w[i] * err * xs[i];
      gb += w[i] * err;
    }
    ga = ga / W + l2 * a;
    gb /= W;
    va = 0.9 * va - lr * ga;
    vb = 0.9 * vb - lr * gb;
    a += va;
    b += vb;
  }
  const loss = logLoss(xs.map((x) => sigmoid(a * x + b)), ys);
  return { a, b, loss };
}

/**
 * Precision / recall / F1 / accuracy for binary predictions.
 * @param {boolean[]} preds
 * @param {(0|1)[]} labels
 */
export function binaryStats(preds, labels) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  preds.forEach((p, i) => {
    if (p && labels[i]) tp++;
    else if (p) fp++;
    else if (labels[i]) fn++;
    else tn++;
  });
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { tp, fp, fn, tn, precision, recall, f1, accuracy: (tp + tn) / Math.max(1, preds.length) };
}

/**
 * Deterministic fold assignment by string id (FNV-1a).
 * @param {string} id
 * @param {number} k
 */
export function foldOf(id, k) {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % k;
}

/** @param {number[]} xs */
export function mean(xs) {
  const v = xs.filter(Number.isFinite);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
}

/** @param {number[]} xs @param {number} q 0..1 */
export function quantile(xs, q) {
  const s = xs.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!s.length) return NaN;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/**
 * Simulated escalation for a noul: items whose confidence |2p−1| is below `floor` are answered by a
 * perfect escalator (their true label); the rest keep the System 1 verdict p ≥ 0.5.
 * Items with label null (borderline) count toward the escalation rate but not toward precision/recall.
 * @param {number[]} probs
 * @param {(0|1|null)[]} labels
 * @param {number} floor
 */
export function simulateEscalation(probs, labels, floor) {
  const preds = [];
  const ys = [];
  let escalated = 0;
  probs.forEach((p, i) => {
    const esc = Math.abs(2 * p - 1) < floor;
    if (esc) escalated++;
    if (labels[i] === null) return;
    preds.push(esc ? labels[i] === 1 : p >= 0.5);
    ys.push(labels[i]);
  });
  return { ...binaryStats(preds, /** @type {(0|1)[]} */ (ys)), escalationRate: escalated / Math.max(1, probs.length), escalated };
}
