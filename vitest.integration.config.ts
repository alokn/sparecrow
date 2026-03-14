import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts', 'tests/soak/**/*.test.ts'],
    passWithNoTests: true,
    coverage: { enabled: false },
    environment: 'node',
    testTimeout: 60000,
    hookTimeout: 30000,
  },
});
