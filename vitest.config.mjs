import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.{js,mjs}'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**', 'eval/**']
  }
});
