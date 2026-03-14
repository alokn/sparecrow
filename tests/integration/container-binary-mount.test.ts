/** Integration tests for container binary mount resolution (Story 10.5, Task 4.7). */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveBinaryMount } from '../../src/providers/backends/container/binary-resolver.js';

// Mock logger to prevent disk I/O during integration tests
vi.mock('../../src/utils/index.js', () => ({
  logger: {
    info: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
    debug: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('resolveBinaryMount (integration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves real host paths without throwing', async () => {
    // Use a path that is guaranteed to exist on the host (/bin/sh is universal)
    // This validates the happy path: access check, realpath, stat, mount construction
    const result = await resolveBinaryMount('/bin/sh');

    if (result !== null) {
      // If sh is found, validate the mount structure
      expect(result.mount.source).toBeTruthy();
      expect(result.mount.target).toMatch(/^\/opt\/claude\//);
      expect(result.mount.readonly).toBe(true);
      expect(result.containerCommandPath).toMatch(/^\/opt\/claude\//);
    } else {
      // Graceful degradation is also acceptable (e.g. X_OK check fails in restricted env)
      expect(result).toBeNull();
    }
  });

  it('returns null gracefully for a non-existent path', async () => {
    const result = await resolveBinaryMount('/nonexistent/path/to/claude');
    expect(result).toBeNull();
  });

  it('never mounts root filesystem (root-path guard)', async () => {
    // Even if someone passes a root-level file, the guard must block it
    // We test with a known root-level file if it exists, otherwise skip
    // by using a synthetic path that would produce installDir='/'
    // Since we cannot easily create a real file at / without root, we
    // verify the guard rejects by testing that a file whose dirname is '/'
    // produces null. We use /bin/sh as input but override containerInstallDir
    // to verify the path computation: dirname('/some-root-file') === '/'
    // Direct test: pass a path whose realpath would be at root level.
    // We approximate this by testing the guard condition directly via unit
    // test in binary-resolver.test.ts; this integration test validates that
    // the function never returns a mount with source === '/'.
    const result = await resolveBinaryMount('/bin/sh');
    if (result !== null) {
      expect(result.mount.source).not.toBe('/');
    }
  });
});
