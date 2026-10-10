/**
 * Launches Chrome for Testing (Playwright's bundled Chromium) with the built extension
 * from dist/ext loaded unpacked. Branded Chrome ignores --load-extension since 137,
 * so E2E always runs on CfT.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '../..');
export const EXT_DIR = path.join(ROOT, 'dist/ext');

/**
 * @param {{ headless?: boolean, extDir?: string, userDataDir?: string }} [opts]
 *   extDir: a different unpacked build (default dist/ext);
 *   userDataDir: reuse a profile (e.g. a relaunch after `close({ keepProfile: true })`)
 * @returns {Promise<{ context: import('@playwright/test').BrowserContext, extensionId: string,
 *   serviceWorker: import('@playwright/test').Worker, userDataDir: string,
 *   close: (opts?: { keepProfile?: boolean }) => Promise<void> }>}
 */
export async function launchWithExtension(opts = {}) {
  const extDir = opts.extDir || EXT_DIR;
  if (!fs.existsSync(path.join(extDir, 'manifest.json'))) {
    throw new Error('dist/ext missing: run `npm run build:ext` before E2E tests.');
  }
  const userDataDir = opts.userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'sc-e2e-'));
  const headless = opts.headless ?? process.env.HEADED !== '1';
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless,
    args: [
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`
    ]
  });

  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) serviceWorker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = serviceWorker.url().split('/')[2];

  return {
    context,
    extensionId,
    serviceWorker,
    userDataDir,
    async close({ keepProfile = false } = {}) {
      await context.close();
      if (!keepProfile) fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  };
}

/**
 * Collects console messages and page errors for a page, for asserting "no CSP errors".
 * @param {import('@playwright/test').Page} page
 */
export function collectConsole(page) {
  const messages = [];
  page.on('console', (msg) => messages.push({ type: msg.type(), text: msg.text() }));
  page.on('pageerror', (err) => messages.push({ type: 'pageerror', text: String(err) }));
  return messages;
}
