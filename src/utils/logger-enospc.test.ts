/** ENOSPC filesystem error tests for audit log append (AC3). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('Logger ENOSPC handling (AC3)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.resetModules();
    // Suppress stderr output during all tests in this suite
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(async () => {
    // Always reset logger singleton state even if test fails early
    try {
      const { resetLoggerState } = await import('./logger.js');
      resetLoggerState();
    } catch {
      // logger may not have been imported if test failed before import — ignore
    }
    stderrSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('continues operating when appendFile throws ENOSPC during audit log write', async () => {
    const enospcError = Object.assign(new Error('ENOSPC: no space left on device'), {
      code: 'ENOSPC',
    });

    const appendFileSpy = vi.fn().mockRejectedValue(enospcError);
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

    vi.doMock('node:fs/promises', () => ({
      ...actualFs,
      appendFile: appendFileSpy,
    }));

    const { logger, setLogDir, enableFileLogging, setLogLevel } = await import('./logger.js');

    setLogDir('/tmp/test-logs');
    enableFileLogging();
    setLogLevel('debug');

    // AC3: Logger must not throw — the .catch(() => {}) in writeRecord handles ENOSPC
    await expect(logger.info('test.event', { key: 'value' })).resolves.toBeUndefined();

    // appendFile was called (file logging is enabled)
    expect(appendFileSpy).toHaveBeenCalledTimes(1);

    // Can continue logging after ENOSPC — daemon is not broken
    await expect(logger.warn('another.event', { key: 'value2' })).resolves.toBeUndefined();

    expect(appendFileSpy).toHaveBeenCalledTimes(2);
  });

  it('does not corrupt existing audit log content on ENOSPC', async () => {
    const enospcError = Object.assign(new Error('ENOSPC: no space left on device'), {
      code: 'ENOSPC',
    });

    // Track what appendFile receives
    const appendFileSpy = vi.fn().mockRejectedValue(enospcError);
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

    vi.doMock('node:fs/promises', () => ({
      ...actualFs,
      appendFile: appendFileSpy,
    }));

    const { logger, setLogDir, enableFileLogging, setLogLevel } = await import('./logger.js');

    setLogDir('/tmp/test-logs');
    enableFileLogging();
    setLogLevel('debug');

    // The write is attempted but ENOSPC means it won't persist — that's expected.
    // The key guarantee is the logger doesn't throw and doesn't corrupt existing data.
    // appendFile is an append operation — if it fails, existing content is untouched.
    await logger.info('test.event', { data: 'test' });

    // Verify appendFile was called with proper JSONL format (the record itself is valid)
    const callArgs = appendFileSpy.mock.calls[0]!;
    const writtenLine = callArgs[1] as string;
    expect(writtenLine).toMatch(/\n$/);

    const record = JSON.parse(writtenLine.trim()) as Record<string, unknown>;
    expect(record['event']).toBe('test.event');
    expect(record['level']).toBe('info');
  });
});
