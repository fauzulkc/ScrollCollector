import { describe, test, expect } from 'vitest';
import {
  clamp01,
  sigmoid,
  softmax,
  noulConfidence,
  choiceConfidence,
  scoreConfidence,
  expectedLevel,
  normalizeDistribution,
  argmax,
  thresholdConfidence
} from '../../lib/decision/confidence.js';
import { noulAnswer } from '../../lib/decision/types.js';

describe('Jev confidence formulas', () => {
  test('thresholdConfidence: 0 at the threshold, 1 at the ends; |2p - 1| at 0.5', () => {
    for (const p of [0, 0.1, 0.25, 0.5, 0.62, 0.9, 1]) expect(thresholdConfidence(p, 0.5)).toBeCloseTo(noulConfidence(p), 12);
    expect(thresholdConfidence(0.7, 0.7)).toBe(0);
    expect(thresholdConfidence(1, 0.7)).toBe(1);
    expect(thresholdConfidence(0, 0.7)).toBe(1);
    expect(thresholdConfidence(0.85, 0.7)).toBeCloseTo(0.5, 12);
    expect(thresholdConfidence(0.35, 0.7)).toBeCloseTo(0.5, 12);
    expect(thresholdConfidence(0.15, 0.3)).toBeCloseTo(0.5, 12);
    // invalid thresholds behave like 0.5
    expect(thresholdConfidence(0.8, NaN)).toBeCloseTo(0.6, 12);
    expect(thresholdConfidence(0.8, 1)).toBeCloseTo(0.6, 12);
  });

  test('choice: (pmax - 1/n) / (1 - 1/n)', () => {
    expect(choiceConfidence([0.6, 0.3, 0.1])).toBeCloseTo(0.4, 10);
    expect(choiceConfidence([0.9, 0.06, 0.04])).toBeCloseTo(0.85, 10);
    expect(choiceConfidence({ a: 0.6, b: 0.3, none: 0.1 })).toBeCloseTo(0.4, 10);
    // uniform -> 0, certain -> 1, single option -> 1
    expect(choiceConfidence([0.25, 0.25, 0.25, 0.25])).toBeCloseTo(0, 10);
    expect(choiceConfidence([1, 0, 0])).toBe(1);
    expect(choiceConfidence([1])).toBe(1);
  });

  test('score: 1 - MAD / MAD_uniform around the arg-max level', () => {
    expect(scoreConfidence([0, 0.5, 0.5])).toBeCloseTo(0.25, 10);
    expect(scoreConfidence([0.5, 0, 0.5])).toBeCloseTo(0, 10);
    expect(scoreConfidence([0, 1, 0])).toBe(1);
    expect(scoreConfidence([1])).toBe(1);
  });

  test('noul: |2p - 1|', () => {
    expect(noulConfidence(0.5)).toBe(0);
    expect(noulConfidence(0.9)).toBeCloseTo(0.8, 10);
    expect(noulConfidence(0.1)).toBeCloseTo(0.8, 10);
    expect(noulConfidence(1.7)).toBe(1); // clamped
    expect(noulConfidence(NaN)).toBe(1); // clamp01(NaN) = 0 -> |0 - 1|
  });

  test('noulAnswer clamps and derives confidence', () => {
    expect(noulAnswer(0.75, 'system1')).toEqual({ type: 'noul', noul: 0.75, confidence: 0.5, source: 'system1' });
    expect(noulAnswer(2, 'x').noul).toBe(1);
    expect(noulAnswer(Number.NaN, 'x')).toMatchObject({ noul: 0.5, confidence: 0 });
  });
});

describe('probability helpers', () => {
  test('sigmoid is symmetric and stable for large inputs', () => {
    expect(sigmoid(0)).toBe(0.5);
    expect(sigmoid(2) + sigmoid(-2)).toBeCloseTo(1, 12);
    expect(sigmoid(1000)).toBe(1);
    expect(sigmoid(-1000)).toBe(0);
  });

  test('softmax sums to 1 and survives large logits', () => {
    const p = softmax([1000, 1001, 1002]);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(p[2]).toBeGreaterThan(p[1]);
    expect(softmax([])).toEqual([]);
  });

  test('normalizeDistribution handles zero, negative and non-finite weights', () => {
    expect(normalizeDistribution({ a: 1, b: 3 })).toEqual({ a: 0.25, b: 0.75 });
    expect(normalizeDistribution({ a: 0, b: 0 })).toEqual({ a: 0.5, b: 0.5 });
    expect(normalizeDistribution({ a: -1, b: NaN, c: 2 })).toEqual({ a: 0, b: 0, c: 1 });
  });

  test('argmax, expectedLevel, clamp01', () => {
    expect(argmax({ a: 0.2, b: 0.5, none: 0.3 })).toBe('b');
    expect(argmax({})).toBeNull();
    expect(expectedLevel([0, 0.5, 0.5])).toBeCloseTo(1.5, 12);
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(Infinity)).toBe(0);
  });
});
