/**
 * Tier 3 — Rule-based keyword matching (always available).
 */
export const tier = 3;

export function getDisplayName() {
  return 'Rule-based Classifier';
}

export async function isAvailable() {
  return true;
}

export async function getEngineStatus() {
  return { tier, name: getDisplayName(), status: 'ready' };
}

export const keywordProvider = {
  tier,
  getDisplayName,
  isAvailable,
  getEngineStatus
};
