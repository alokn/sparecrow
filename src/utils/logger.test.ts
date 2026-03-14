/** Unit tests for the structured JSONL logger. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs/promises before importing logger
vi.mock('node:fs/promises', () => ({
  appendFile: vi.fn().mockResolvedValue(undefined),
}));

describe('logger', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.resetModules();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes info events to stderr at default log level', async () => {
    const { logger } = await import('./logger.js');
    await logger.info('test.event', { key: 'value' });
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('test.event'));
  });

  it('suppresses debug events at default info log level', async () => {
    const { logger } = await import('./logger.js');
    await logger.debug('debug.event', {});
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('writes debug events when log level is set to debug', async () => {
    const { logger, setLogLevel } = await import('./logger.js');
    setLogLevel('debug');
    await logger.debug('debug.event', {});
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('debug.event'));
  });

  it('writes warn events at default log level', async () => {
    const { logger } = await import('./logger.js');
    await logger.warn('warn.event', { reason: 'test' });
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('WARN'));
  });

  it('writes error events with error message', async () => {
    const { logger } = await import('./logger.js');
    const err = new Error('something went wrong');
    await logger.error('error.event', {}, err);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('ERROR'));
  });

  it('writes error events without error argument', async () => {
    const { logger } = await import('./logger.js');
    await logger.error('error.event', {});
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('error.event'));
  });

  it('appends to file when file logging is enabled after setLogDir', async () => {
    const { appendFile } = await import('node:fs/promises');
    const { logger, enableFileLogging, setLogDir } = await import('./logger.js');
    setLogDir('/tmp/sparecrow-test-logs');
    enableFileLogging();
    await logger.info('file.event', {});
    expect(appendFile).toHaveBeenCalled();
  });

  it('does not throw when appendFile fails', async () => {
    const { appendFile } = await import('node:fs/promises');
    vi.mocked(appendFile).mockRejectedValueOnce(new Error('disk full'));
    const { logger, enableFileLogging, setLogDir } = await import('./logger.js');
    setLogDir('/tmp/sparecrow-test-logs');
    enableFileLogging();
    await expect(logger.info('safe.event', {})).resolves.toBeUndefined();
  });

  it('throws CONFIG_INVALID when enableFileLogging is called without setLogDir', async () => {
    expect.assertions(1);
    const { enableFileLogging } = await import('./logger.js');
    try {
      enableFileLogging();
    } catch (err) {
      expect(err).toMatchObject({ code: 'CONFIG_INVALID' });
    }
  });

  it('resetLoggerState clears log dir and disables file logging', async () => {
    const { appendFile } = await import('node:fs/promises');
    const { logger, enableFileLogging, setLogDir, resetLoggerState } = await import('./logger.js');
    setLogDir('/tmp/sparecrow-test-logs');
    enableFileLogging();
    resetLoggerState();
    vi.mocked(appendFile).mockClear();
    await logger.info('after.reset', {});
    // appendFile must not be called after state reset (log dir and toggle cleared)
    expect(appendFile).not.toHaveBeenCalled();
  });

  it('setLogDir emits stderr warning when overwriting an existing log directory', async () => {
    const { setLogDir } = await import('./logger.js');
    setLogDir('/tmp/first-dir');
    // Change to a different directory — should trigger warning
    setLogDir('/tmp/second-dir');
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('logger.setLogDir: overwriting log directory'),
    );
  });

  it('setLogDir does not emit warning when called twice with the same directory', async () => {
    const { setLogDir } = await import('./logger.js');
    setLogDir('/tmp/same-dir');
    setLogDir('/tmp/same-dir');
    // No overwrite warning — same value repeated
    const warnCalls = stderrSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((s: string) => s.includes('logger.setLogDir'));
    expect(warnCalls).toHaveLength(0);
  });

  it('setLogDir sets the directory used for audit log file paths', async () => {
    const { appendFile } = await import('node:fs/promises');
    const writtenPaths: string[] = [];
    vi.mocked(appendFile).mockImplementation(async (path: unknown) => {
      writtenPaths.push(String(path));
    });
    const { logger, enableFileLogging, setLogDir } = await import('./logger.js');
    setLogDir('/tmp/custom-log-dir');
    enableFileLogging();
    await logger.info('path.test', {});
    expect(writtenPaths[0]).toMatch(/^\/tmp\/custom-log-dir\/audit-\d{4}-\d{2}-\d{2}\.jsonl$/);
  });

  it('info() passes meta.error to the JSONL record top-level error field', async () => {
    const { appendFile } = await import('node:fs/promises');
    const writtenLines: string[] = [];
    vi.mocked(appendFile).mockImplementation(async (_path: unknown, data: unknown) => {
      writtenLines.push(String(data));
    });
    const { logger, enableFileLogging, setLogDir } = await import('./logger.js');
    setLogDir('/tmp/sparecrow-test-logs');
    enableFileLogging();
    await logger.info('info.with.error', {}, { error: 'info error message' });
    expect(writtenLines.length).toBe(1);
    const record = JSON.parse(writtenLines[0]!.trimEnd()) as Record<string, unknown>;
    expect(record['error']).toBe('info error message');
  });

  it('debug() passes meta.error to the JSONL record top-level error field', async () => {
    const { appendFile } = await import('node:fs/promises');
    const writtenLines: string[] = [];
    vi.mocked(appendFile).mockImplementation(async (_path: unknown, data: unknown) => {
      writtenLines.push(String(data));
    });
    const { logger, setLogLevel, enableFileLogging, setLogDir } = await import('./logger.js');
    setLogLevel('debug');
    setLogDir('/tmp/sparecrow-test-logs');
    enableFileLogging();
    await logger.debug('debug.with.error', {}, { error: 'debug error message' });
    expect(writtenLines.length).toBe(1);
    const record = JSON.parse(writtenLines[0]!.trimEnd()) as Record<string, unknown>;
    expect(record['error']).toBe('debug error message');
  });

  it('info() sets error field to null when meta has no error', async () => {
    const { appendFile } = await import('node:fs/promises');
    const writtenLines: string[] = [];
    vi.mocked(appendFile).mockImplementation(async (_path: unknown, data: unknown) => {
      writtenLines.push(String(data));
    });
    const { logger, enableFileLogging, setLogDir } = await import('./logger.js');
    setLogDir('/tmp/sparecrow-test-logs');
    enableFileLogging();
    await logger.info('info.no.error', {}, { provider: 'claude-code' });
    expect(writtenLines.length).toBe(1);
    const record = JSON.parse(writtenLines[0]!.trimEnd()) as Record<string, unknown>;
    expect(record['error']).toBeNull();
  });

  it('JSONL record written to file contains exactly the 8 required top-level fields (CLAUDE.md §8)', async () => {
    // AC: JSONL audit records must always have exactly these 8 top-level fields (no more, no fewer):
    //   ts, level, event, data, provider, source, confidence, error
    // This test captures the raw string passed to appendFile and parses it to verify the schema.
    // A future field addition or omission will be caught here before it silently breaks consumers
    // such as `sparecrow report` and audit log parsers.
    const { appendFile } = await import('node:fs/promises');
    const writtenLines: string[] = [];
    vi.mocked(appendFile).mockImplementation(async (_path: unknown, data: unknown) => {
      writtenLines.push(String(data));
    });

    const { logger, enableFileLogging, setLogDir } = await import('./logger.js');
    setLogDir('/tmp/sparecrow-test-logs');
    enableFileLogging();
    await logger.info('schema.test', { key: 'value' });

    expect(writtenLines.length).toBe(1);
    const record = JSON.parse(writtenLines[0]!.trimEnd()) as Record<string, unknown>;
    const actualKeys = Object.keys(record).sort();
    const requiredKeys = [
      'ts',
      'level',
      'event',
      'data',
      'provider',
      'source',
      'confidence',
      'error',
    ].sort();

    // Assert exact field set — catches both additions and omissions.
    expect(actualKeys).toEqual(requiredKeys);

    // Assert field types match the expected schema.
    expect(typeof record['ts']).toBe('string');
    expect(record['level']).toBe('info');
    expect(record['event']).toBe('schema.test');
    expect(record['data']).toEqual({ key: 'value' });
    // Optional fields must be present but may be null.
    expect(Object.prototype.hasOwnProperty.call(record, 'provider')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(record, 'source')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(record, 'confidence')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(record, 'error')).toBe(true);
  });

  it('calls appendFile with mode 0o600 for audit log files (Story 18.1 AC2)', async () => {
    const { appendFile } = await import('node:fs/promises');
    const { logger, enableFileLogging, setLogDir } = await import('./logger.js');
    setLogDir('/tmp/sparecrow-test-logs');
    enableFileLogging();
    await logger.info('mode.test', {});
    expect(appendFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ mode: 0o600 }),
    );
  });
});
