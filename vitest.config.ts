import { cpus } from 'node:os';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['tests/integration/**'],
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: Math.max(Math.floor(cpus().length * 0.75), 2),
      },
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/index.ts'],
      thresholds: {
        lines: 70,
        branches: 70,
        functions: 70,
        statements: 70,
      },
      reporter: ['text', 'lcov'],
    },
    environment: 'node',
  },
});
