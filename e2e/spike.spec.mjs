// Phase-0 capability probe of the extension service worker. (The Transformers.js spike page was
// retired in Phase 4: e2e/s1.spec.mjs and e2e/parity.spec.mjs cover the real offscreen host.)
import { test, expect } from '@playwright/test';
import { launchWithExtension } from './helpers/launch.mjs';

test('service worker capability probe (storage access level, Prompt API)', async () => {
  const ext = await launchWithExtension();
  try {
    const probe = await ext.serviceWorker.evaluate(async () => {
      const out = {
        languageModelInSW: typeof globalThis.LanguageModel,
        setAccessLevelLocal: typeof chrome.storage.local.setAccessLevel,
        setAccessLevelSession: typeof chrome.storage.session.setAccessLevel
      };
      try {
        await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
        out.localTrustedOnly = 'ok';
      } catch (err) {
        out.localTrustedOnly = String(err?.message || err);
      }
      return out;
    });
    console.log('[spike-probe]', JSON.stringify(probe));
    expect(probe.setAccessLevelSession).toBe('function');
  } finally {
    await ext.close();
  }
});
