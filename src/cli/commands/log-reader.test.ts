/** Tests for log-reader — file discovery, JSONL parsing, duration parsing, query orchestration. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

// We need to mock the logger to suppress output in tests.
// Provide all exports used by log-reader.ts: logger, AUDIT_LOG_FILENAME_REGEX, ScrowError, ErrorCode
vi.mock('../../utils/index.js', () => ({
  logger: {
    debug: vi.fn().mockResolvedValue(undefined),
    info: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
  },
  AUDIT_LOG_FILENAME_REGEX: /^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/,
  isRecord: (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value),
  retryWithBackoff: vi.fn(),
  setLogLevel: vi.fn(),
  enableFileLogging: vi.fn(),
  setLogDir: vi.fn(),
  resetLoggerState: vi.fn(),
  atomicWrite: vi.fn(),
  safeReadJson: vi.fn(),
  VERSION: '0.0.0-test',
  spawnWithGuardrails: vi.fn(),
  validateRepository: vi.fn(),
}));

import { discoverLogFiles, parseLogFile, parseSinceDuration, queryLogs } from './log-reader.js';

/** Creates a fixture JSONL line for a task.completed event */
function makeCompletedLine(
  ts: string,
  taskName = 'security-audit',
  taskId = 'abc-123',
  durationMs = 45000,
): string {
  return JSON.stringify({
    ts,
    level: 'info',
    event: 'task.completed',
    data: { taskId, taskName, durationMs, outcome: 'success', exitCode: 0 },
    provider: 'claude-code',
    source: 'executor',
    confidence: 'high',
    error: null,
  });
}

/** Creates a fixture JSONL line for a task.failed event */
function makeFailedLine(ts: string, taskName = 'fix-bugs', taskId = 'def-456'): string {
  return JSON.stringify({
    ts,
    level: 'warn',
    event: 'task.failed',
    data: { taskId, taskName, durationMs: 12000, outcome: 'failed', exitCode: 1 },
    provider: 'claude-code',
    source: 'executor',
    confidence: 'high',
    error: 'Process exited with code 1',
  });
}

describe('discoverLogFiles', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), 'sparecrow-logs-' + randomBytes(6).toString('hex'));
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('finds JSONL files and sorts newest-first', async () => {
    await writeFile(join(tmpDir, 'audit-2026-02-20.jsonl'), '');
    await writeFile(join(tmpDir, 'audit-2026-02-23.jsonl'), '');
    await writeFile(join(tmpDir, 'audit-2026-02-21.jsonl'), '');
    const files = await discoverLogFiles(tmpDir);
    const names = files.map((f) => f.split('/').pop() ?? '');
    expect(names).toEqual([
      'audit-2026-02-23.jsonl',
      'audit-2026-02-21.jsonl',
      'audit-2026-02-20.jsonl',
    ]);
  });

  it('filters files by since date, excluding files before the cutoff', async () => {
    await writeFile(join(tmpDir, 'audit-2026-02-10.jsonl'), '');
    await writeFile(join(tmpDir, 'audit-2026-02-20.jsonl'), '');
    await writeFile(join(tmpDir, 'audit-2026-02-25.jsonl'), '');
    const since = new Date('2026-02-18T00:00:00.000Z');
    const files = await discoverLogFiles(tmpDir, since);
    const names = files.map((f) => f.split('/').pop() ?? '');
    expect(names).not.toContain('audit-2026-02-10.jsonl');
    expect(names).toContain('audit-2026-02-20.jsonl');
    expect(names).toContain('audit-2026-02-25.jsonl');
  });

  it('returns empty array when directory is empty', async () => {
    const files = await discoverLogFiles(tmpDir);
    expect(files).toEqual([]);
  });

  it('returns empty array when directory does not exist', async () => {
    const files = await discoverLogFiles(join(tmpDir, 'nonexistent'));
    expect(files).toEqual([]);
  });

  it('ignores non-matching filenames', async () => {
    await writeFile(join(tmpDir, 'readme.txt'), '');
    await writeFile(join(tmpDir, 'other.json'), '');
    await writeFile(join(tmpDir, 'audit-2026-02-20.jsonl'), '');
    const files = await discoverLogFiles(tmpDir);
    expect(files).toHaveLength(1);
    expect(files.at(0)).toContain('audit-2026-02-20.jsonl');
  });
});

describe('parseLogFile', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), 'sparecrow-logs-' + randomBytes(6).toString('hex'));
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses valid JSONL records into LogEntry objects', async () => {
    const ts = '2026-02-25T10:30:00.000Z';
    const content = makeCompletedLine(ts) + '\n' + makeFailedLine('2026-02-25T10:31:00.000Z');
    const filePath = join(tmpDir, 'audit-2026-02-25.jsonl');
    await writeFile(filePath, content);
    const entries = await parseLogFile(filePath);
    expect(entries).toHaveLength(2);
    const first = entries.at(0);
    const second = entries.at(1);
    expect(first?.outcome).toBe('success');
    expect(first?.taskName).toBe('security-audit');
    expect(first?.taskId).toBe('abc-123');
    expect(first?.durationMs).toBe(45000);
    expect(first?.exitCode).toBe(0);
    expect(first?.timestamp).toBe(ts);
    expect(second?.outcome).toBe('failed');
    expect(second?.taskName).toBe('fix-bugs');
  });

  it('skips malformed lines and continues parsing', async () => {
    const { logger } = await import('../../utils/index.js');
    const validLine = makeCompletedLine('2026-02-25T10:30:00.000Z');
    const content = validLine + '\nNOT_JSON\n' + makeFailedLine('2026-02-25T10:31:00.000Z');
    const filePath = join(tmpDir, 'audit-2026-02-25.jsonl');
    await writeFile(filePath, content);
    const entries = await parseLogFile(filePath);
    expect(entries).toHaveLength(2);
    expect(logger.debug).toHaveBeenCalled();
  });

  it('returns empty array for missing file', async () => {
    const entries = await parseLogFile(join(tmpDir, 'nonexistent.jsonl'));
    expect(entries).toEqual([]);
  });

  it('returns empty array for file with only blank lines', async () => {
    const filePath = join(tmpDir, 'audit-2026-02-25.jsonl');
    await writeFile(filePath, '\n\n\n');
    const entries = await parseLogFile(filePath);
    expect(entries).toEqual([]);
  });

  it('maps dispatch.quota-exhausted event to quota outcome', async () => {
    const line = JSON.stringify({
      ts: '2026-02-25T10:30:00.000Z',
      level: 'warn',
      event: 'dispatch.quota-exhausted',
      data: { taskName: 'improve-code' },
      provider: null,
      source: null,
      confidence: null,
      error: null,
    });
    const filePath = join(tmpDir, 'audit-2026-02-25.jsonl');
    await writeFile(filePath, line);
    const entries = await parseLogFile(filePath);
    expect(entries.at(0)?.outcome).toBe('quota');
  });

  it('maps task.requeued event to retrying outcome', async () => {
    const line = JSON.stringify({
      ts: '2026-02-25T10:30:00.000Z',
      level: 'info',
      event: 'task.requeued',
      data: { taskName: 'improve-code', summary: 'queued for retry' },
      provider: null,
      source: null,
      confidence: null,
      error: null,
    });
    const filePath = join(tmpDir, 'audit-2026-02-25.jsonl');
    await writeFile(filePath, line);
    const entries = await parseLogFile(filePath);
    expect(entries.at(0)?.outcome).toBe('retrying');
  });

  it('falls back to data.error when top-level error is null for backward compatibility', async () => {
    const line = JSON.stringify({
      ts: '2026-02-25T10:30:00.000Z',
      level: 'warn',
      event: 'task.failed',
      data: {
        taskId: 'legacy-1',
        taskName: 'custom-task',
        durationMs: 1,
        outcome: 'failed',
        exitCode: null,
        error: 'Claude binary not found. Run sparecrow onboard.',
      },
      provider: 'claude-code',
      source: 'executor',
      confidence: 'high',
      error: null,
    });
    const filePath = join(tmpDir, 'audit-2026-02-25.jsonl');
    await writeFile(filePath, line);
    const entries = await parseLogFile(filePath);
    expect(entries).toHaveLength(1);
    expect(entries.at(0)?.error).toBe('Claude binary not found. Run sparecrow onboard.');
  });

  it('prefers top-level error over data.error when both are present', async () => {
    const line = JSON.stringify({
      ts: '2026-02-25T10:30:00.000Z',
      level: 'warn',
      event: 'task.failed',
      data: {
        taskId: 'both-1',
        taskName: 'custom-task',
        durationMs: 1,
        outcome: 'failed',
        exitCode: null,
        error: 'old nested error',
      },
      provider: 'claude-code',
      source: 'executor',
      confidence: 'high',
      error: 'top-level error message',
    });
    const filePath = join(tmpDir, 'audit-2026-02-25.jsonl');
    await writeFile(filePath, line);
    const entries = await parseLogFile(filePath);
    expect(entries).toHaveLength(1);
    expect(entries.at(0)?.error).toBe('top-level error message');
  });

  it('returns null error when both top-level and data.error are null', async () => {
    const line = JSON.stringify({
      ts: '2026-02-25T10:30:00.000Z',
      level: 'warn',
      event: 'task.failed',
      data: {
        taskId: 'no-error-1',
        taskName: 'custom-task',
        durationMs: 5000,
        outcome: 'failed',
        exitCode: 1,
      },
      provider: 'claude-code',
      source: 'executor',
      confidence: 'high',
      error: null,
    });
    const filePath = join(tmpDir, 'audit-2026-02-25.jsonl');
    await writeFile(filePath, line);
    const entries = await parseLogFile(filePath);
    expect(entries).toHaveLength(1);
    expect(entries.at(0)?.error).toBeNull();
  });

  it('filters out non-task events like daemon.started', async () => {
    const daemonLine = JSON.stringify({
      ts: '2026-02-25T10:30:00.000Z',
      level: 'info',
      event: 'daemon.started',
      data: {},
      provider: null,
      source: null,
      confidence: null,
      error: null,
    });
    const taskLine = makeCompletedLine('2026-02-25T10:31:00.000Z');
    const filePath = join(tmpDir, 'audit-2026-02-25.jsonl');
    await writeFile(filePath, daemonLine + '\n' + taskLine);
    const entries = await parseLogFile(filePath);
    // daemon.started should be filtered out; only task.completed entry should remain
    expect(entries).toHaveLength(1);
    expect(entries.at(0)?.outcome).toBe('success');
  });
});

describe('parseSinceDuration', () => {
  it('parses 7d to a date 7 days ago', () => {
    const before = Date.now();
    const result = parseSinceDuration('7d');
    const after = Date.now();
    const expectedMs = 7 * 24 * 60 * 60 * 1000;
    expect(before - result.getTime()).toBeGreaterThanOrEqual(expectedMs - 100);
    expect(after - result.getTime()).toBeLessThanOrEqual(expectedMs + 100);
  });

  it('parses 24h to a date 24 hours ago', () => {
    const before = Date.now();
    const result = parseSinceDuration('24h');
    const after = Date.now();
    const expectedMs = 24 * 60 * 60 * 1000;
    expect(before - result.getTime()).toBeGreaterThanOrEqual(expectedMs - 100);
    expect(after - result.getTime()).toBeLessThanOrEqual(expectedMs + 100);
  });

  it('parses 30m to a date 30 minutes ago', () => {
    const before = Date.now();
    const result = parseSinceDuration('30m');
    const after = Date.now();
    const expectedMs = 30 * 60 * 1000;
    expect(before - result.getTime()).toBeGreaterThanOrEqual(expectedMs - 100);
    expect(after - result.getTime()).toBeLessThanOrEqual(expectedMs + 100);
  });

  it('parses ISO 8601 date string 2026-02-20', () => {
    const result = parseSinceDuration('2026-02-20');
    expect(result.toISOString().startsWith('2026-02-20')).toBe(true);
  });

  it('throws ScrowError(LOGS_INVALID_FILTER) for invalid input "abc"', () => {
    expect(() => parseSinceDuration('abc')).toThrow();
    try {
      parseSinceDuration('abc');
    } catch (err) {
      expect(err).toMatchObject({ code: 'LOGS_INVALID_FILTER' });
    }
  });

  it('throws ScrowError(LOGS_INVALID_FILTER) for empty string', () => {
    expect(() => parseSinceDuration('')).toThrow();
    try {
      parseSinceDuration('');
    } catch (err) {
      expect(err).toMatchObject({ code: 'LOGS_INVALID_FILTER' });
    }
  });

  it('throws ScrowError(LOGS_INVALID_FILTER) for malformed duration like "-1d"', () => {
    expect(() => parseSinceDuration('-1d')).toThrow();
    try {
      parseSinceDuration('-1d');
    } catch (err) {
      expect(err).toMatchObject({ code: 'LOGS_INVALID_FILTER' });
    }
  });

  it('throws ScrowError(LOGS_INVALID_FILTER) for bare numbers like "1" or "99999"', () => {
    expect(() => parseSinceDuration('1')).toThrow();
    try {
      parseSinceDuration('1');
    } catch (err) {
      expect(err).toMatchObject({ code: 'LOGS_INVALID_FILTER' });
    }
    expect(() => parseSinceDuration('99999')).toThrow();
  });

  it('parses ISO 8601 datetime string with time component', () => {
    const result = parseSinceDuration('2026-02-20T10:00:00Z');
    expect(result.toISOString()).toBe('2026-02-20T10:00:00.000Z');
  });
});

describe('queryLogs', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), 'sparecrow-logs-' + randomBytes(6).toString('hex'));
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty result when no files exist', async () => {
    const result = await queryLogs({ logsDir: tmpDir, count: 20 });
    expect(result.entries).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.successCount).toBe(0);
    expect(result.failureCount).toBe(0);
  });

  it('applies count limit returning newest entries first', async () => {
    const lines = [
      makeCompletedLine('2026-02-25T10:00:00.000Z', 'task-a'),
      makeCompletedLine('2026-02-25T11:00:00.000Z', 'task-b'),
      makeCompletedLine('2026-02-25T12:00:00.000Z', 'task-c'),
    ].join('\n');
    await writeFile(join(tmpDir, 'audit-2026-02-25.jsonl'), lines);
    const result = await queryLogs({ logsDir: tmpDir, count: 2 });
    expect(result.entries).toHaveLength(2);
    expect(result.entries.at(0)?.taskName).toBe('task-c'); // newest first
    expect(result.entries.at(1)?.taskName).toBe('task-b');
    expect(result.total).toBe(3); // total before slice
  });

  it('applies since date filter correctly', async () => {
    const lines = [
      makeCompletedLine('2026-02-20T10:00:00.000Z', 'old-task'),
      makeCompletedLine('2026-02-25T10:00:00.000Z', 'new-task'),
    ].join('\n');
    await writeFile(join(tmpDir, 'audit-2026-02-25.jsonl'), lines);
    await writeFile(
      join(tmpDir, 'audit-2026-02-20.jsonl'),
      makeCompletedLine('2026-02-20T10:00:00.000Z', 'old-task'),
    );
    const since = new Date('2026-02-22T00:00:00.000Z');
    const result = await queryLogs({ logsDir: tmpDir, count: 20, since });
    expect(result.entries.every((e) => new Date(e.timestamp) >= since)).toBe(true);
  });

  it('applies task filter and returns all matching entries sorted chronologically', async () => {
    const lines = [
      makeCompletedLine('2026-02-25T10:00:00.000Z', 'security-audit', 'id-1'),
      makeCompletedLine('2026-02-25T11:00:00.000Z', 'fix-bugs', 'id-2'),
      makeCompletedLine('2026-02-25T12:00:00.000Z', 'security-audit', 'id-3'),
    ].join('\n');
    await writeFile(join(tmpDir, 'audit-2026-02-25.jsonl'), lines);
    const result = await queryLogs({ logsDir: tmpDir, count: 20, taskFilter: 'security-audit' });
    expect(result.entries).toHaveLength(2);
    // Should be chronological (oldest first)
    expect(result.entries.at(0)?.taskId).toBe('id-1');
    expect(result.entries.at(1)?.taskId).toBe('id-3');
  });

  it('task filter is case-insensitive', async () => {
    const line = makeCompletedLine('2026-02-25T10:00:00.000Z', 'Security-Audit');
    await writeFile(join(tmpDir, 'audit-2026-02-25.jsonl'), line);
    const result = await queryLogs({ logsDir: tmpDir, count: 20, taskFilter: 'security-audit' });
    expect(result.entries).toHaveLength(1);
  });

  it('computes correct successCount and failureCount aggregates', async () => {
    const lines = [
      makeCompletedLine('2026-02-25T10:00:00.000Z'),
      makeCompletedLine('2026-02-25T10:01:00.000Z'),
      makeFailedLine('2026-02-25T10:02:00.000Z'),
    ].join('\n');
    await writeFile(join(tmpDir, 'audit-2026-02-25.jsonl'), lines);
    const result = await queryLogs({ logsDir: tmpDir, count: 20 });
    expect(result.total).toBe(3);
    expect(result.successCount).toBe(2);
    expect(result.failureCount).toBe(1);
  });

  it('excludes non-task events from results (daemon.started, usage.polled, etc.)', async () => {
    const daemonLine = JSON.stringify({
      ts: '2026-02-25T10:00:00.000Z',
      level: 'info',
      event: 'daemon.started',
      data: {},
      provider: null,
      source: null,
      confidence: null,
      error: null,
    });
    const taskLine = makeCompletedLine('2026-02-25T10:01:00.000Z', 'security-audit');
    await writeFile(join(tmpDir, 'audit-2026-02-25.jsonl'), daemonLine + '\n' + taskLine);
    const result = await queryLogs({ logsDir: tmpDir, count: 20 });
    // Only the task.completed entry should appear, not daemon.started
    expect(result.entries).toHaveLength(1);
    expect(result.entries.at(0)?.event).toBe('task.completed');
  });

  it('returns empty result for task filter with no matches', async () => {
    const line = makeCompletedLine('2026-02-25T10:00:00.000Z', 'security-audit');
    await writeFile(join(tmpDir, 'audit-2026-02-25.jsonl'), line);
    const result = await queryLogs({ logsDir: tmpDir, count: 20, taskFilter: 'nonexistent' });
    expect(result.entries).toEqual([]);
    expect(result.total).toBe(0);
  });
});
