import { cpus } from 'node:os';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['tests/integration/**'],
    pool: 'forks',
    maxForks: Math.max(Math.floor(cpus().length * 0.75), 2),
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/index.ts',
        // Daemon internals — timer-based polling loop and process signal management
        // are not reliably unit-testable without integration harness
        'src/daemon/polling-loop.ts',
        'src/daemon/pid-manager.ts',
        'src/daemon/lifecycle.ts',
        // FSWatcher — node:fs watch API is not reliably mockable in unit tests
        'src/config/watcher.ts',
        // OS service installation — execFile + systemd/launchd interactions
        'src/platform/service-installer.ts',
        // Container availability probing — requires a live container runtime
        'src/providers/backends/container-backend-wrapper.ts',
        // Daemon CLI command — wraps lifecycle ops; branches depend on live daemon state
        'src/cli/commands/daemon.ts',
        // Diagnostic runner — fs.access + OS-level health checks
        'src/cli/commands/doctor-runner.ts',
      ],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
      reporter: ['text', 'lcov'],
    },
    environment: 'node',
  },
});
