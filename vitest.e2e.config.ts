import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    globalSetup: ['tests/e2e/global-setup.ts'],
    testTimeout: 120000,
    hookTimeout: 30000,
    maxConcurrency: 1,
    fileParallelism: false,
    coverage: { enabled: false },
    environment: 'node',
  },
});
