import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.mjs$/,
  timeout: 180000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure'
  }
});
