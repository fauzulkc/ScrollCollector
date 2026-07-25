/**
 * Tier 4 — Cloud API provider (deferred, opt-in only).
 */
export const tier = 4;

export function getDisplayName() {
  return 'Cloud API';
}

export async function isAvailable() {
  // Future: read configuration.cloudApiEnabled + credentials from storage
  return false;
}

export async function getEngineStatus() {
  return null;
}

export async function inferJson() {
  return null;
}

export const cloudProvider = {
  tier,
  getDisplayName,
  isAvailable,
  getEngineStatus,
  inferJson
};
