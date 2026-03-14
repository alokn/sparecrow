/** Unit tests for report-data computation: window math, file discovery, parsing, and aggregation. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  computeReportWindow,
  isInWindow,
  discoverReportFiles,
  parseReportFile,
  extractUtilizationBoundaries,
  deriveTaskType,
  buildBreakdownRows,
  estimateValueRecovered,
  toPercent,
  computeReport,
} from './report-data.js';
import type { UsagePolledRecord, TaskCompletedRecord } from '../../types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUsageRecord(
  ts: string,
  weeklyUtilization: number | null = 0.4,
  sessionUtilization: number | null = 0.3,
): UsagePolledRecord {
  return { ts, weeklyUtilization, sessionUtilization };
}

function makeTaskRecord(ts: string, overrides?: Partial<TaskCompletedRecord>): TaskCompletedRecord {
  return {
    ts,
    taskId: 'task-001',
    taskName: 'Run linter',
    type: 'template',
    templateName: 'lint-check',
    ...overrides,
  };
}

// Fixed reference time: 2026-01-15T10:00:00.000Z
const FIXED_NOW = new Date('2026-01-15T10:00:00.000Z').getTime();
const fixedClock = () => FIXED_NOW;

// ---------------------------------------------------------------------------
// computeReportWindow
// ---------------------------------------------------------------------------

describe('computeReportWindow', () => {
  it('returns a 7-day window ending at current time', () => {
    const { periodStart, periodEnd } = computeReportWindow(fixedClock);
    expect(periodEnd.toISOString()).toBe('2026-01-15T10:00:00.000Z');
    expect(periodStart.toISOString()).toBe('2026-01-08T10:00:00.000Z');
  });

  it('periodStart is exactly 7 days before periodEnd', () => {
    const { periodStart, periodEnd } = computeReportWindow(fixedClock);
    const diffMs = periodEnd.getTime() - periodStart.getTime();
    expect(diffMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('uses system clock by default (does not throw)', () => {
    expect(() => computeReportWindow()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// isInWindow
// ---------------------------------------------------------------------------

describe('isInWindow', () => {
  const start = new Date('2026-01-08T10:00:00.000Z');
  const end = new Date('2026-01-15T10:00:00.000Z');

  it('returns true for a timestamp at the start boundary (inclusive)', () => {
    expect(isInWindow('2026-01-08T10:00:00.000Z', start, end)).toBe(true);
  });

  it('returns true for a timestamp at the end boundary (inclusive)', () => {
    expect(isInWindow('2026-01-15T10:00:00.000Z', start, end)).toBe(true);
  });

  it('returns true for a timestamp strictly within the window', () => {
    expect(isInWindow('2026-01-12T00:00:00.000Z', start, end)).toBe(true);
  });

  it('returns false for a timestamp before the start', () => {
    expect(isInWindow('2026-01-08T09:59:59.999Z', start, end)).toBe(false);
  });

  it('returns false for a timestamp after the end', () => {
    expect(isInWindow('2026-01-15T10:00:00.001Z', start, end)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// toPercent
// ---------------------------------------------------------------------------

describe('toPercent', () => {
  it('converts 0.33 to 33', () => {
    expect(toPercent(0.33)).toBeCloseTo(33);
  });

  it('converts 1.0 to 100', () => {
    expect(toPercent(1.0)).toBe(100);
  });

  it('converts 0 to 0', () => {
    expect(toPercent(0)).toBe(0);
  });

  it('converts values > 1 (e.g. 1.5 → 150)', () => {
    expect(toPercent(1.5)).toBe(150);
  });
});

// ---------------------------------------------------------------------------
// discoverReportFiles
// ---------------------------------------------------------------------------

describe('discoverReportFiles', () => {
  let logsDir: string;

  beforeEach(async () => {
    logsDir = join(tmpdir(), `sparecrow-test-${Date.now()}`);
    await mkdir(logsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(logsDir, { recursive: true, force: true });
  });

  it('returns empty array when logs directory does not exist (ENOENT)', async () => {
    const result = await discoverReportFiles(
      '/nonexistent/path/logs',
      new Date('2026-01-08T00:00:00.000Z'),
    );
    expect(result).toEqual([]);
  });

  it('returns empty array when directory is empty', async () => {
    const result = await discoverReportFiles(logsDir, new Date('2026-01-08T00:00:00.000Z'));
    expect(result).toEqual([]);
  });

  it('discovers matching audit files within the window', async () => {
    await writeFile(join(logsDir, 'audit-2026-01-10.jsonl'), '');
    await writeFile(join(logsDir, 'audit-2026-01-15.jsonl'), '');
    const result = await discoverReportFiles(logsDir, new Date('2026-01-08T00:00:00.000Z'));
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('audit-2026-01-10.jsonl');
    expect(result[1]).toContain('audit-2026-01-15.jsonl');
  });

  it('excludes files before periodStart date', async () => {
    await writeFile(join(logsDir, 'audit-2026-01-05.jsonl'), '');
    await writeFile(join(logsDir, 'audit-2026-01-10.jsonl'), '');
    const result = await discoverReportFiles(logsDir, new Date('2026-01-08T00:00:00.000Z'));
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('audit-2026-01-10.jsonl');
  });

  it('ignores files with non-matching names', async () => {
    await writeFile(join(logsDir, 'audit-2026-01-10.jsonl'), '');
    await writeFile(join(logsDir, 'daemon.log'), '');
    await writeFile(join(logsDir, 'queue.json'), '');
    const result = await discoverReportFiles(logsDir, new Date('2026-01-08T00:00:00.000Z'));
    expect(result).toHaveLength(1);
  });

  it('returns files sorted oldest-first', async () => {
    await writeFile(join(logsDir, 'audit-2026-01-15.jsonl'), '');
    await writeFile(join(logsDir, 'audit-2026-01-10.jsonl'), '');
    await writeFile(join(logsDir, 'audit-2026-01-12.jsonl'), '');
    const result = await discoverReportFiles(logsDir, new Date('2026-01-08T00:00:00.000Z'));
    expect(result[0]).toContain('audit-2026-01-10.jsonl');
    expect(result[1]).toContain('audit-2026-01-12.jsonl');
    expect(result[2]).toContain('audit-2026-01-15.jsonl');
  });
});

// ---------------------------------------------------------------------------
// parseReportFile
// ---------------------------------------------------------------------------

describe('parseReportFile', () => {
  let logsDir: string;

  beforeEach(async () => {
    logsDir = join(tmpdir(), `sparecrow-test-${Date.now()}`);
    await mkdir(logsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(logsDir, { recursive: true, force: true });
  });

  const start = new Date('2026-01-08T00:00:00.000Z');
  const end = new Date('2026-01-15T23:59:59.999Z');

  it('returns empty arrays for a non-existent file (ENOENT)', async () => {
    const result = await parseReportFile('/nonexistent/file.jsonl', start, end);
    expect(result.usageRecords).toEqual([]);
    expect(result.taskRecords).toEqual([]);
  });

  it('parses usage.polled records within the window', async () => {
    const line = JSON.stringify({
      ts: '2026-01-12T10:00:00.000Z',
      level: 'info',
      event: 'usage.polled',
      data: { weeklyUtilization: 0.4, sessionUtilization: 0.3 },
    });
    const filePath = join(logsDir, 'audit-2026-01-12.jsonl');
    await writeFile(filePath, line + '\n');
    const result = await parseReportFile(filePath, start, end);
    expect(result.usageRecords).toHaveLength(1);
    expect(result.usageRecords[0]!.weeklyUtilization).toBe(0.4);
    expect(result.usageRecords[0]!.sessionUtilization).toBe(0.3);
  });

  it('parses task.completed records within the window', async () => {
    const line = JSON.stringify({
      ts: '2026-01-12T10:00:00.000Z',
      level: 'info',
      event: 'task.completed',
      data: { taskId: 'abc', taskName: 'Lint check', type: 'template', templateName: 'lint' },
    });
    const filePath = join(logsDir, 'audit-2026-01-12.jsonl');
    await writeFile(filePath, line + '\n');
    const result = await parseReportFile(filePath, start, end);
    expect(result.taskRecords).toHaveLength(1);
    expect(result.taskRecords[0]!.taskId).toBe('abc');
    expect(result.taskRecords[0]!.taskName).toBe('Lint check');
  });

  it('skips records outside the window', async () => {
    const line = JSON.stringify({
      ts: '2026-01-01T00:00:00.000Z',
      level: 'info',
      event: 'usage.polled',
      data: { weeklyUtilization: 0.5, sessionUtilization: 0.2 },
    });
    const filePath = join(logsDir, 'audit-2026-01-01.jsonl');
    await writeFile(filePath, line + '\n');
    const result = await parseReportFile(filePath, start, end);
    expect(result.usageRecords).toHaveLength(0);
  });

  it('skips malformed JSON lines without throwing', async () => {
    const content =
      'this is not JSON\n' +
      JSON.stringify({
        ts: '2026-01-12T10:00:00.000Z',
        level: 'info',
        event: 'usage.polled',
        data: { weeklyUtilization: 0.4, sessionUtilization: 0.3 },
      });
    const filePath = join(logsDir, 'audit-2026-01-12.jsonl');
    await writeFile(filePath, content);
    const result = await parseReportFile(filePath, start, end);
    expect(result.usageRecords).toHaveLength(1);
  });

  it('skips blank lines without throwing', async () => {
    const filePath = join(logsDir, 'audit-2026-01-12.jsonl');
    await writeFile(filePath, '\n\n\n');
    const result = await parseReportFile(filePath, start, end);
    expect(result.usageRecords).toHaveLength(0);
    expect(result.taskRecords).toHaveLength(0);
  });

  it('skips lines with non-object JSON values', async () => {
    const filePath = join(logsDir, 'audit-2026-01-12.jsonl');
    await writeFile(filePath, '"just a string"\nnull\n42\n');
    const result = await parseReportFile(filePath, start, end);
    expect(result.usageRecords).toHaveLength(0);
    expect(result.taskRecords).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// extractUtilizationBoundaries
// ---------------------------------------------------------------------------

describe('extractUtilizationBoundaries', () => {
  it('returns nulls for empty records array', () => {
    const result = extractUtilizationBoundaries([]);
    expect(result.beforeUtilization).toBeNull();
    expect(result.currentUtilization).toBeNull();
  });

  it('returns both from/to as same value for single record', () => {
    const records = [makeUsageRecord('2026-01-12T10:00:00.000Z', 0.5)];
    const result = extractUtilizationBoundaries(records);
    expect(result.beforeUtilization).toBeCloseTo(50);
    expect(result.currentUtilization).toBeCloseTo(50);
  });

  it('extracts earliest as before and latest as current', () => {
    const records = [
      makeUsageRecord('2026-01-12T10:00:00.000Z', 0.8),
      makeUsageRecord('2026-01-10T08:00:00.000Z', 0.3),
      makeUsageRecord('2026-01-14T12:00:00.000Z', 0.6),
    ];
    const result = extractUtilizationBoundaries(records);
    expect(result.beforeUtilization).toBeCloseTo(30); // earliest: Jan 10
    expect(result.currentUtilization).toBeCloseTo(60); // latest: Jan 14
  });

  it('returns null boundaries when weeklyUtilization is null', () => {
    const records = [makeUsageRecord('2026-01-12T10:00:00.000Z', null)];
    const result = extractUtilizationBoundaries(records);
    expect(result.beforeUtilization).toBeNull();
    expect(result.currentUtilization).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deriveTaskType
// ---------------------------------------------------------------------------

describe('deriveTaskType', () => {
  it('returns type when it is set', () => {
    const record = makeTaskRecord('2026-01-12T10:00:00.000Z', {
      type: 'code-review',
      templateName: null,
    });
    expect(deriveTaskType(record)).toBe('code-review');
  });

  it('falls back to templateName when type is null', () => {
    const record = makeTaskRecord('2026-01-12T10:00:00.000Z', {
      type: null,
      templateName: 'lint-check',
    });
    expect(deriveTaskType(record)).toBe('lint-check');
  });

  it('falls back to templateName when type is whitespace', () => {
    const record = makeTaskRecord('2026-01-12T10:00:00.000Z', {
      type: '  ',
      templateName: 'lint-check',
    });
    expect(deriveTaskType(record)).toBe('lint-check');
  });

  it('returns "unknown" when both type and templateName are null', () => {
    const record = makeTaskRecord('2026-01-12T10:00:00.000Z', { type: null, templateName: null });
    expect(deriveTaskType(record)).toBe('unknown');
  });

  it('returns "unknown" when type is null and templateName is whitespace', () => {
    const record = makeTaskRecord('2026-01-12T10:00:00.000Z', { type: null, templateName: '   ' });
    expect(deriveTaskType(record)).toBe('unknown');
  });

  it('trims whitespace from type', () => {
    const record = makeTaskRecord('2026-01-12T10:00:00.000Z', { type: '  code-review  ' });
    expect(deriveTaskType(record)).toBe('code-review');
  });
});

// ---------------------------------------------------------------------------
// estimateValueRecovered
// ---------------------------------------------------------------------------

describe('estimateValueRecovered', () => {
  it('returns null when deltaUtilization is null', () => {
    expect(estimateValueRecovered(null)).toBeNull();
  });

  it('returns null when deltaUtilization is zero', () => {
    expect(estimateValueRecovered(0)).toBeNull();
  });

  it('returns null when deltaUtilization is negative', () => {
    expect(estimateValueRecovered(-10)).toBeNull();
  });

  it('computes value for a positive delta (10 pct-points → $5)', () => {
    expect(estimateValueRecovered(10)).toBe(5);
  });

  it('rounds to nearest whole dollar', () => {
    // 3 pct-points * $0.50 = $1.50 → rounds to $2
    expect(estimateValueRecovered(3)).toBe(2);
  });

  it('returns $0 only when rounded from very small positive delta', () => {
    // 0.5 * 0.5 = 0.25 → rounds to 0
    expect(estimateValueRecovered(0.5)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildBreakdownRows
// ---------------------------------------------------------------------------

describe('buildBreakdownRows', () => {
  it('returns empty array for no task records', () => {
    expect(buildBreakdownRows([], 0)).toEqual([]);
  });

  it('groups records by task type', () => {
    const records = [
      makeTaskRecord('2026-01-12T10:00:00.000Z', { type: 'lint' }),
      makeTaskRecord('2026-01-12T11:00:00.000Z', { type: 'lint' }),
      makeTaskRecord('2026-01-12T12:00:00.000Z', { type: 'test' }),
    ];
    const rows = buildBreakdownRows(records, 2);
    expect(rows).toHaveLength(2);
    const lintRow = rows.find((r) => r.taskType === 'lint');
    const testRow = rows.find((r) => r.taskType === 'test');
    expect(lintRow!.tasksCompleted).toBe(2);
    expect(testRow!.tasksCompleted).toBe(1);
  });

  it('sorts rows by estimatedValueRecoveredUsd descending', () => {
    const records = [
      makeTaskRecord('2026-01-12T10:00:00.000Z', { type: 'cheap' }),
      makeTaskRecord('2026-01-12T11:00:00.000Z', { type: 'expensive' }),
      makeTaskRecord('2026-01-12T12:00:00.000Z', { type: 'expensive' }),
    ];
    const rows = buildBreakdownRows(records, 5);
    expect(rows[0]!.taskType).toBe('expensive');
    expect(rows[1]!.taskType).toBe('cheap');
  });

  it('sorts alphabetically by taskType when values are equal', () => {
    const records = [
      makeTaskRecord('2026-01-12T10:00:00.000Z', { type: 'zebra' }),
      makeTaskRecord('2026-01-12T11:00:00.000Z', { type: 'alpha' }),
    ];
    const rows = buildBreakdownRows(records, 5);
    expect(rows[0]!.taskType).toBe('alpha');
    expect(rows[1]!.taskType).toBe('zebra');
  });

  it('groups records with null/whitespace type as "unknown"', () => {
    const records = [
      makeTaskRecord('2026-01-12T10:00:00.000Z', { type: null, templateName: null }),
      makeTaskRecord('2026-01-12T11:00:00.000Z', { type: null, templateName: null }),
    ];
    const rows = buildBreakdownRows(records, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.taskType).toBe('unknown');
    expect(rows[0]!.tasksCompleted).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// computeReport integration
// ---------------------------------------------------------------------------

describe('computeReport', () => {
  let logsDir: string;

  beforeEach(async () => {
    logsDir = join(tmpdir(), `sparecrow-test-${Date.now()}`);
    await mkdir(logsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(logsDir, { recursive: true, force: true });
  });

  it('returns insufficientData=true when logs directory is missing', async () => {
    const result = await computeReport('/nonexistent/logs', fixedClock);
    expect(result.insufficientData).toBe(true);
    expect(result.beforeUtilization).toBeNull();
    expect(result.currentUtilization).toBeNull();
    expect(result.estimatedValueRecoveredUsd).toBeNull();
  });

  it('returns insufficientData=true when there are no usage records', async () => {
    const result = await computeReport(logsDir, fixedClock);
    expect(result.insufficientData).toBe(true);
  });

  it('computes a full report with usage and task records', async () => {
    const usageLine1 = JSON.stringify({
      ts: '2026-01-09T10:00:00.000Z',
      level: 'info',
      event: 'usage.polled',
      data: { weeklyUtilization: 0.3, sessionUtilization: 0.2 },
    });
    const usageLine2 = JSON.stringify({
      ts: '2026-01-14T10:00:00.000Z',
      level: 'info',
      event: 'usage.polled',
      data: { weeklyUtilization: 0.6, sessionUtilization: 0.4 },
    });
    const taskLine = JSON.stringify({
      ts: '2026-01-12T10:00:00.000Z',
      level: 'info',
      event: 'task.completed',
      data: { taskId: 't1', taskName: 'Lint', type: 'template', templateName: 'lint' },
    });

    await writeFile(join(logsDir, 'audit-2026-01-09.jsonl'), usageLine1 + '\n' + taskLine);
    await writeFile(join(logsDir, 'audit-2026-01-14.jsonl'), usageLine2);

    const result = await computeReport(logsDir, fixedClock);

    expect(result.insufficientData).toBe(false);
    expect(result.beforeUtilization).toBeCloseTo(30);
    expect(result.currentUtilization).toBeCloseTo(60);
    expect(result.deltaUtilization).toBeCloseTo(30);
    expect(result.tasksCompleted).toBe(1);
    expect(result.estimatedValueRecoveredUsd).toBe(15); // 30 * 0.5 = 15
    expect(result.attribution).toContain('$15');
    expect(result.breakdownByTaskType).toHaveLength(1);
  });

  it('sets attribution to null when utilization decreased', async () => {
    const usageLine1 = JSON.stringify({
      ts: '2026-01-09T10:00:00.000Z',
      level: 'info',
      event: 'usage.polled',
      data: { weeklyUtilization: 0.8, sessionUtilization: 0.5 },
    });
    const usageLine2 = JSON.stringify({
      ts: '2026-01-14T10:00:00.000Z',
      level: 'info',
      event: 'usage.polled',
      data: { weeklyUtilization: 0.4, sessionUtilization: 0.3 },
    });

    await writeFile(join(logsDir, 'audit-2026-01-09.jsonl'), usageLine1);
    await writeFile(join(logsDir, 'audit-2026-01-14.jsonl'), usageLine2);

    const result = await computeReport(logsDir, fixedClock);

    expect(result.insufficientData).toBe(false);
    expect(result.deltaUtilization).toBeLessThan(0);
    expect(result.estimatedValueRecoveredUsd).toBeNull();
    expect(result.attribution).toBeNull();
  });

  it('includes all required fields in the output (no optional field omissions)', async () => {
    const result = await computeReport(logsDir, fixedClock);
    expect(result).toHaveProperty('periodStart');
    expect(result).toHaveProperty('periodEnd');
    expect(result).toHaveProperty('beforeUtilization');
    expect(result).toHaveProperty('currentUtilization');
    expect(result).toHaveProperty('deltaUtilization');
    expect(result).toHaveProperty('estimatedValueRecoveredUsd');
    expect(result).toHaveProperty('tasksCompleted');
    expect(result).toHaveProperty('breakdownByTaskType');
    expect(result).toHaveProperty('attribution');
    expect(result).toHaveProperty('insufficientData');
  });
});
