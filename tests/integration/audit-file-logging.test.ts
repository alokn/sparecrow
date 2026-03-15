/** Integration test — AC6: enableFileLogging() results in JSONL records written to disk.
 *  Verifies that calling enableFileLogging() on the real logger singleton causes subsequent
 *  logger.* calls to produce actual audit-YYYY-MM-DD.jsonl files containing valid JSONL records
 *  with the 8 required top-level fields (CLAUDE.md §8). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

describe('audit file logging integration (AC6)', () => {
  let logsDir: string;

  beforeEach(async () => {
    logsDir = join(tmpdir(), `audit-logging-${randomBytes(6).toString('hex')}`);
    await mkdir(logsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(logsDir, { recursive: true, force: true });
  });

  it('enableFileLogging() causes logger calls to write JSONL records to the audit file on disk', async () => {
    // This test uses the real logger module (no mocks for fs/promises or platform paths).
    // It monkey-patches the module-level path resolution by temporarily overriding the
    // getPaths() call used by todayFile() inside logger.ts.
    //
    // Implementation approach: import logger.ts directly but override the platform module
    // so that getPaths().logs returns our controlled temp directory. This is the real
    // integration scenario — the daemon calls enableFileLogging() and then all logger.*
    // calls produce actual files in the logs directory, exactly as they would in production.

    // Step 1: Reset modules so we get a clean logger singleton with _logToFile = false.
    // We use dynamic import with a module override technique to inject the temp logs dir.
    const { vi } = await import('vitest');
    vi.resetModules();

    // Step 2: Mock only the platform paths module to redirect logs to our temp dir.
    vi.doMock('../../src/platform/paths.js', () => ({
      getPaths: () => ({
        logs: logsDir,
        config: logsDir,
        data: logsDir,
      }),
    }));

    // Step 3: Import the fresh logger singleton (with _logToFile = false by default).
    const { logger, setLogDir, enableFileLogging } = await import('../../src/utils/logger.js');

    // Step 4: Set log directory and enable file logging — mirrors what runner.ts does at daemon startup.
    setLogDir(logsDir);
    enableFileLogging();

    // Step 5: Write a log record at each level to exercise the file output path.
    await logger.info('integration.test.info', { message: 'test-info-payload' });
    await logger.warn('integration.test.warn', { message: 'test-warn-payload' });
    await logger.error('integration.test.error', { message: 'test-error-payload' });

    // Step 6: Read the audit file from disk and verify its contents.
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const auditFilePath = join(logsDir, `audit-${today}.jsonl`);

    let fileContent: string;
    try {
      fileContent = await readFile(auditFilePath, 'utf-8');
    } catch (err) {
      throw new Error(
        `Audit file was not created at ${auditFilePath}. ` +
          `enableFileLogging() call did not activate file output. ` +
          `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Each non-empty line must be a valid JSON object.
    const lines = fileContent.split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(3); // at least info, warn, error records

    // Step 7: Validate the 8-field JSONL schema (CLAUDE.md §8) for every record.
    const REQUIRED_FIELDS = ['ts', 'level', 'event', 'data', 'provider', 'source', 'confidence', 'error'];
    for (const line of lines) {
      const record = JSON.parse(line) as Record<string, unknown>;
      const actualKeys = Object.keys(record).sort();
      const requiredKeys = [...REQUIRED_FIELDS].sort();
      expect(actualKeys).toEqual(requiredKeys);
    }

    // Step 8: Verify the specific events we wrote are present in the file.
    const records = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const events = records.map((r) => r['event']);
    expect(events).toContain('integration.test.info');
    expect(events).toContain('integration.test.warn');
    expect(events).toContain('integration.test.error');

    // Step 9: Spot-check a single record's field values for correctness.
    const infoRecord = records.find((r) => r['event'] === 'integration.test.info');
    expect(infoRecord).toBeDefined();
    expect(infoRecord!['level']).toBe('info');
    expect(typeof infoRecord!['ts']).toBe('string');
    expect(infoRecord!['data']).toEqual({ message: 'test-info-payload' });
    // Nullable fields must be present (even if null) — never absent.
    expect(Object.prototype.hasOwnProperty.call(infoRecord, 'provider')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(infoRecord, 'source')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(infoRecord, 'confidence')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(infoRecord, 'error')).toBe(true);

    vi.restoreAllMocks();
  });
});
