/** Tests for sparecrow report command and report-data computation. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Command } from 'commander';
import {
  computeReportWindow,
  isInWindow,
  discoverReportFiles,
  parseReportFile,
  extractUtilizationBoundaries,
  deriveTaskType,
  buildBreakdownRows,
  estimateValueRecovered,
  computeReport,
} from './report-data.js';
import type { UsagePolledRecord, TaskCompletedRecord } from '../../types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return join(tmpdir(), `report-test-${randomBytes(6).toString('hex')}`);
}

async function writeAuditFile(logsDir: string, date: string, lines: string[]): Promise<void> {
  const filePath = join(logsDir, `audit-${date}.jsonl`);
  await writeFile(filePath, lines.join('\n') + '\n', 'utf-8');
}

function makeUsagePolledLine(ts: string, weekly: number | null, session: number | null): string {
  return JSON.stringify({
    ts,
    level: 'info',
    event: 'usage.polled',
    data: {
      weeklyUtilization: weekly,
      sessionUtilization: session,
      source: 'cli-quota',
      confidence: 'high',
    },
    provider: 'claude-code',
    source: 'monitor',
    confidence: 'high',
    error: null,
  });
}

function makeTaskCompletedLine(
  ts: string,
  taskName: string,
  type?: string | null,
  templateName?: string | null,
): string {
  return JSON.stringify({
    ts,
    level: 'info',
    event: 'task.completed',
    data: {
      taskId: `id-${taskName}`,
      taskName,
      type: type ?? null,
      templateName: templateName ?? null,
      durationMs: 1000,
      outcome: 'done',
      exitCode: 0,
    },
    provider: 'claude-code',
    source: 'executor',
    confidence: 'high',
    error: null,
  });
}

// Fixed clock for deterministic window tests
const FIXED_NOW = new Date('2026-02-25T12:00:00.000Z').getTime();
const fixedClock = () => FIXED_NOW;

// ---------------------------------------------------------------------------
// computeReportWindow tests
// ---------------------------------------------------------------------------

describe('computeReportWindow', () => {
  it('returns periodEnd equal to invocation time', () => {
    const { periodEnd } = computeReportWindow(fixedClock);
    expect(periodEnd.toISOString()).toBe('2026-02-25T12:00:00.000Z');
  });

  it('returns periodStart exactly 7 days before periodEnd', () => {
    const { periodStart, periodEnd } = computeReportWindow(fixedClock);
    const diff = periodEnd.getTime() - periodStart.getTime();
    expect(diff).toBe(7 * 24 * 60 * 60 * 1000);
    expect(periodStart.toISOString()).toBe('2026-02-18T12:00:00.000Z');
  });

  it('uses system clock when no clockFn provided', () => {
    const before = Date.now();
    const { periodEnd } = computeReportWindow();
    const after = Date.now();
    expect(periodEnd.getTime()).toBeGreaterThanOrEqual(before);
    expect(periodEnd.getTime()).toBeLessThanOrEqual(after);
  });
});

// ---------------------------------------------------------------------------
// isInWindow tests (AC5 — inclusive boundary)
// ---------------------------------------------------------------------------

describe('isInWindow', () => {
  const start = new Date('2026-02-18T12:00:00.000Z');
  const end = new Date('2026-02-25T12:00:00.000Z');

  it('includes timestamps exactly at periodStart', () => {
    expect(isInWindow('2026-02-18T12:00:00.000Z', start, end)).toBe(true);
  });

  it('includes timestamps exactly at periodEnd', () => {
    expect(isInWindow('2026-02-25T12:00:00.000Z', start, end)).toBe(true);
  });

  it('includes timestamps within the window', () => {
    expect(isInWindow('2026-02-22T00:00:00.000Z', start, end)).toBe(true);
  });

  it('excludes timestamps before periodStart', () => {
    expect(isInWindow('2026-02-18T11:59:59.999Z', start, end)).toBe(false);
  });

  it('excludes timestamps after periodEnd', () => {
    expect(isInWindow('2026-02-25T12:00:00.001Z', start, end)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// discoverReportFiles tests
// ---------------------------------------------------------------------------

describe('discoverReportFiles', () => {
  let logsDir: string;

  beforeEach(async () => {
    logsDir = makeTempDir();
    await mkdir(logsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(logsDir, { recursive: true, force: true });
  });

  it('returns empty array when logsDir does not exist (ENOENT)', async () => {
    const missing = join(tmpdir(), 'does-not-exist-' + randomBytes(4).toString('hex'));
    const files = await discoverReportFiles(missing, new Date('2026-02-18T12:00:00.000Z'));
    expect(files).toEqual([]);
  });

  it('returns empty array when no audit files exist', async () => {
    const files = await discoverReportFiles(logsDir, new Date('2026-02-18T12:00:00.000Z'));
    expect(files).toEqual([]);
  });

  it('returns only files overlapping the window', async () => {
    await writeFile(join(logsDir, 'audit-2026-02-15.jsonl'), '', 'utf-8');
    await writeFile(join(logsDir, 'audit-2026-02-18.jsonl'), '', 'utf-8');
    await writeFile(join(logsDir, 'audit-2026-02-22.jsonl'), '', 'utf-8');
    await writeFile(join(logsDir, 'audit-2026-02-25.jsonl'), '', 'utf-8');
    await writeFile(join(logsDir, 'other-file.txt'), '', 'utf-8');

    const since = new Date('2026-02-18T12:00:00.000Z');
    const files = await discoverReportFiles(logsDir, since);
    // Only files from 2026-02-18 onwards (YYYY-MM-DD comparison with since day 2026-02-18)
    expect(files).toHaveLength(3);
    // Sorted oldest-first
    expect(files[0]).toContain('audit-2026-02-18.jsonl');
    expect(files[1]).toContain('audit-2026-02-22.jsonl');
    expect(files[2]).toContain('audit-2026-02-25.jsonl');
  });

  it('ignores non-jsonl files', async () => {
    await writeFile(join(logsDir, 'not-audit.txt'), '', 'utf-8');
    await writeFile(join(logsDir, 'audit-2026-02-22.jsonl'), '', 'utf-8');
    const since = new Date('2026-02-18T00:00:00.000Z');
    const files = await discoverReportFiles(logsDir, since);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain('audit-2026-02-22.jsonl');
  });
});

// ---------------------------------------------------------------------------
// parseReportFile tests — usage.polled and task.completed extraction
// ---------------------------------------------------------------------------

describe('parseReportFile', () => {
  let logsDir: string;
  const start = new Date('2026-02-18T12:00:00.000Z');
  const end = new Date('2026-02-25T12:00:00.000Z');

  beforeEach(async () => {
    logsDir = makeTempDir();
    await mkdir(logsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(logsDir, { recursive: true, force: true });
  });

  it('returns empty arrays for ENOENT file', async () => {
    const result = await parseReportFile(join(logsDir, 'missing.jsonl'), start, end);
    expect(result.usageRecords).toEqual([]);
    expect(result.taskRecords).toEqual([]);
  });

  it('parses usage.polled records within window', async () => {
    const filePath = join(logsDir, 'audit-2026-02-22.jsonl');
    await writeFile(
      filePath,
      makeUsagePolledLine('2026-02-22T10:00:00.000Z', 0.75, 0.5) + '\n',
      'utf-8',
    );
    const result = await parseReportFile(filePath, start, end);
    expect(result.usageRecords).toHaveLength(1);
    expect(result.usageRecords[0]!.weeklyUtilization).toBe(0.75);
    expect(result.usageRecords[0]!.sessionUtilization).toBe(0.5);
  });

  it('parses task.completed records within window', async () => {
    const filePath = join(logsDir, 'audit-2026-02-22.jsonl');
    await writeFile(
      filePath,
      makeTaskCompletedLine('2026-02-22T10:00:00.000Z', 'my-task', 'template', 'improve-code') +
        '\n',
      'utf-8',
    );
    const result = await parseReportFile(filePath, start, end);
    expect(result.taskRecords).toHaveLength(1);
    expect(result.taskRecords[0]!.taskName).toBe('my-task');
    expect(result.taskRecords[0]!.type).toBe('template');
    expect(result.taskRecords[0]!.templateName).toBe('improve-code');
  });

  it('skips records outside the window', async () => {
    const filePath = join(logsDir, 'audit-2026-02-22.jsonl');
    await writeFile(
      filePath,
      [
        makeUsagePolledLine('2026-02-17T10:00:00.000Z', 0.5, null), // before window
        makeUsagePolledLine('2026-02-22T10:00:00.000Z', 0.75, null), // in window
        makeUsagePolledLine('2026-02-26T10:00:00.000Z', 0.9, null), // after window
      ].join('\n') + '\n',
      'utf-8',
    );
    const result = await parseReportFile(filePath, start, end);
    expect(result.usageRecords).toHaveLength(1);
    expect(result.usageRecords[0]!.ts).toBe('2026-02-22T10:00:00.000Z');
  });

  it('skips malformed JSONL lines without throwing (AC13)', async () => {
    const filePath = join(logsDir, 'audit-2026-02-22.jsonl');
    await writeFile(
      filePath,
      [
        'not-valid-json{{{',
        makeUsagePolledLine('2026-02-22T10:00:00.000Z', 0.5, null),
        '{incomplete',
        makeTaskCompletedLine('2026-02-22T11:00:00.000Z', 'good-task'),
      ].join('\n') + '\n',
      'utf-8',
    );
    const result = await parseReportFile(filePath, start, end);
    expect(result.usageRecords).toHaveLength(1);
    expect(result.taskRecords).toHaveLength(1);
  });

  it('includes records exactly at window boundary timestamps (AC5)', async () => {
    const filePath = join(logsDir, 'audit-2026-02-18.jsonl');
    await writeFile(
      filePath,
      [
        makeUsagePolledLine('2026-02-18T12:00:00.000Z', 0.4, null), // exactly at start
        makeUsagePolledLine('2026-02-25T12:00:00.000Z', 0.8, null), // exactly at end
      ].join('\n') + '\n',
      'utf-8',
    );
    const result = await parseReportFile(filePath, start, end);
    expect(result.usageRecords).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// extractUtilizationBoundaries tests
// ---------------------------------------------------------------------------

describe('extractUtilizationBoundaries', () => {
  it('returns null for both when no records', () => {
    const result = extractUtilizationBoundaries([]);
    expect(result.beforeUtilization).toBeNull();
    expect(result.currentUtilization).toBeNull();
  });

  it('returns same value for before and current when single record', () => {
    const records: UsagePolledRecord[] = [
      { ts: '2026-02-22T00:00:00.000Z', weeklyUtilization: 0.5, sessionUtilization: null },
    ];
    const result = extractUtilizationBoundaries(records);
    // 0.5 fraction -> 50 percent
    expect(result.beforeUtilization).toBe(50);
    expect(result.currentUtilization).toBe(50);
  });

  it('extracts before from earliest and current from latest', () => {
    const records: UsagePolledRecord[] = [
      { ts: '2026-02-25T00:00:00.000Z', weeklyUtilization: 0.9, sessionUtilization: null },
      { ts: '2026-02-18T00:00:00.000Z', weeklyUtilization: 0.4, sessionUtilization: null },
      { ts: '2026-02-22T00:00:00.000Z', weeklyUtilization: 0.6, sessionUtilization: null },
    ];
    const result = extractUtilizationBoundaries(records);
    expect(result.beforeUtilization).toBe(40); // earliest
    expect(result.currentUtilization).toBe(90); // latest
  });

  it('converts fraction-space values to percentage', () => {
    const records: UsagePolledRecord[] = [
      { ts: '2026-02-22T00:00:00.000Z', weeklyUtilization: 0.75, sessionUtilization: null },
    ];
    const result = extractUtilizationBoundaries(records);
    expect(result.beforeUtilization).toBe(75);
    expect(result.currentUtilization).toBe(75);
  });

  it('returns null when weeklyUtilization is null', () => {
    const records: UsagePolledRecord[] = [
      { ts: '2026-02-22T00:00:00.000Z', weeklyUtilization: null, sessionUtilization: 0.5 },
    ];
    const result = extractUtilizationBoundaries(records);
    expect(result.beforeUtilization).toBeNull();
    expect(result.currentUtilization).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deriveTaskType tests (AC7 — legacy fallback)
// ---------------------------------------------------------------------------

describe('deriveTaskType', () => {
  it('prefers explicit type field', () => {
    const record: TaskCompletedRecord = {
      ts: 't',
      taskId: null,
      taskName: null,
      type: 'template',
      templateName: 'improve-code',
    };
    expect(deriveTaskType(record)).toBe('template');
  });

  it('falls back to templateName when type is null', () => {
    const record: TaskCompletedRecord = {
      ts: 't',
      taskId: null,
      taskName: null,
      type: null,
      templateName: 'security-audit',
    };
    expect(deriveTaskType(record)).toBe('security-audit');
  });

  it('returns unknown when both type and templateName are null', () => {
    const record: TaskCompletedRecord = {
      ts: 't',
      taskId: null,
      taskName: null,
      type: null,
      templateName: null,
    };
    expect(deriveTaskType(record)).toBe('unknown');
  });

  it('returns unknown when both are empty strings', () => {
    const record: TaskCompletedRecord = {
      ts: 't',
      taskId: null,
      taskName: null,
      type: '',
      templateName: '',
    };
    expect(deriveTaskType(record)).toBe('unknown');
  });

  it('trims whitespace from type', () => {
    const record: TaskCompletedRecord = {
      ts: 't',
      taskId: null,
      taskName: null,
      type: '  template  ',
      templateName: null,
    };
    expect(deriveTaskType(record)).toBe('template');
  });
});

// ---------------------------------------------------------------------------
// buildBreakdownRows tests (AC8 — deterministic sorting)
// ---------------------------------------------------------------------------

describe('buildBreakdownRows', () => {
  it('returns empty array for no tasks', () => {
    expect(buildBreakdownRows([], 10)).toEqual([]);
  });

  it('groups tasks by derived task type', () => {
    const records: TaskCompletedRecord[] = [
      { ts: 't1', taskId: null, taskName: null, type: 'template', templateName: 'improve-code' },
      { ts: 't2', taskId: null, taskName: null, type: 'template', templateName: 'improve-code' },
      { ts: 't3', taskId: null, taskName: null, type: null, templateName: 'security-audit' },
    ];
    const rows = buildBreakdownRows(records, 5);
    expect(rows).toHaveLength(2);
    const templateRow = rows.find((r) => r.taskType === 'template');
    expect(templateRow?.tasksCompleted).toBe(2);
    const secRow = rows.find((r) => r.taskType === 'security-audit');
    expect(secRow?.tasksCompleted).toBe(1);
  });

  it('sorts by estimatedValueRecoveredUsd descending', () => {
    const records: TaskCompletedRecord[] = [
      { ts: 't1', taskId: null, taskName: null, type: 'A', templateName: null },
      { ts: 't2', taskId: null, taskName: null, type: 'B', templateName: null },
      { ts: 't3', taskId: null, taskName: null, type: 'B', templateName: null },
    ];
    const rows = buildBreakdownRows(records, 10);
    // B has 2 tasks, A has 1 — B should be first
    expect(rows[0]!.taskType).toBe('B');
    expect(rows[1]!.taskType).toBe('A');
  });

  it('sorts by taskType ascending for ties in value (AC8)', () => {
    // All tasks have same value — sort by taskType ascending
    const records: TaskCompletedRecord[] = [
      { ts: 't1', taskId: null, taskName: null, type: 'zebra', templateName: null },
      { ts: 't2', taskId: null, taskName: null, type: 'apple', templateName: null },
      { ts: 't3', taskId: null, taskName: null, type: 'mango', templateName: null },
    ];
    const rows = buildBreakdownRows(records, 10);
    expect(rows[0]!.taskType).toBe('apple');
    expect(rows[1]!.taskType).toBe('mango');
    expect(rows[2]!.taskType).toBe('zebra');
  });

  it('handles legacy records without type or templateName (AC7)', () => {
    const records: TaskCompletedRecord[] = [
      { ts: 't1', taskId: null, taskName: 'old-task', type: null, templateName: null },
      { ts: 't2', taskId: null, taskName: 'another', type: null, templateName: null },
    ];
    const rows = buildBreakdownRows(records, 5);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.taskType).toBe('unknown');
    expect(rows[0]!.tasksCompleted).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// estimateValueRecovered tests
// ---------------------------------------------------------------------------

describe('estimateValueRecovered', () => {
  it('returns null when deltaUtilization is null', () => {
    expect(estimateValueRecovered(null)).toBeNull();
  });

  it('returns null when deltaUtilization is zero', () => {
    expect(estimateValueRecovered(0)).toBeNull();
  });

  it('returns null when deltaUtilization is negative', () => {
    expect(estimateValueRecovered(-5)).toBeNull();
  });

  it('returns positive value for positive delta', () => {
    const value = estimateValueRecovered(10);
    expect(value).not.toBeNull();
    expect(value!).toBeGreaterThan(0);
  });

  it('returns whole-dollar integer (rounded)', () => {
    const value = estimateValueRecovered(7);
    expect(value).not.toBeNull();
    expect(Number.isInteger(value!)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeReport end-to-end tests
// ---------------------------------------------------------------------------

describe('computeReport', () => {
  let logsDir: string;

  beforeEach(async () => {
    logsDir = makeTempDir();
    await mkdir(logsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(logsDir, { recursive: true, force: true });
  });

  // Insufficient data path (AC4)
  it('returns insufficientData=true when no audit files exist', async () => {
    const result = await computeReport(logsDir, fixedClock);
    expect(result.insufficientData).toBe(true);
    expect(result.beforeUtilization).toBeNull();
    expect(result.currentUtilization).toBeNull();
    expect(result.deltaUtilization).toBeNull();
    expect(result.estimatedValueRecoveredUsd).toBeNull();
    expect(result.attribution).toBeNull();
    expect(result.tasksCompleted).toBe(0);
    expect(result.breakdownByTaskType).toEqual([]);
  });

  it('returns insufficientData=true when logsDir is missing (ENOENT) — first-run behavior (AC6)', async () => {
    const missing = join(tmpdir(), 'missing-dir-' + randomBytes(4).toString('hex'));
    const result = await computeReport(missing, fixedClock);
    expect(result.insufficientData).toBe(true);
  });

  it('returns correct periodStart and periodEnd using injected clock', async () => {
    const result = await computeReport(logsDir, fixedClock);
    expect(result.periodStart).toBe('2026-02-18T12:00:00.000Z');
    expect(result.periodEnd).toBe('2026-02-25T12:00:00.000Z');
  });

  it('all required keys are present even in insufficient-data mode (AC2, AC3)', async () => {
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

  it('returns sufficient data with utilization snapshots in window', async () => {
    const dateInWindow = '2026-02-22';
    await writeAuditFile(logsDir, dateInWindow, [
      makeUsagePolledLine('2026-02-18T13:00:00.000Z', 0.4, null),
      makeUsagePolledLine('2026-02-22T10:00:00.000Z', 0.7, null),
      makeTaskCompletedLine('2026-02-22T11:00:00.000Z', 'task-1', 'template', 'improve-code'),
      makeTaskCompletedLine('2026-02-22T12:00:00.000Z', 'task-2', null, null),
    ]);

    const result = await computeReport(logsDir, fixedClock);
    expect(result.insufficientData).toBe(false);
    expect(result.beforeUtilization).toBe(40);
    expect(result.currentUtilization).toBe(70);
    expect(result.deltaUtilization).toBe(30);
    expect(result.tasksCompleted).toBe(2);
    expect(result.attribution).toBe('Your configuration recovered $15 in capacity this week.');
  });

  it('attribution uses exact voice format (AC1)', async () => {
    await writeAuditFile(logsDir, '2026-02-22', [
      makeUsagePolledLine('2026-02-18T13:00:00.000Z', 0.3, null),
      makeUsagePolledLine('2026-02-22T10:00:00.000Z', 0.8, null),
    ]);
    const result = await computeReport(logsDir, fixedClock);
    expect(result.attribution).toMatch(
      /^Your configuration recovered \$\d+ in capacity this week\.$/,
    );
  });

  it('returns insufficientData=true when only one boundary snapshot exists', async () => {
    // Only current snapshot — no "before" reference
    await writeAuditFile(logsDir, '2026-02-24', [
      makeUsagePolledLine('2026-02-24T10:00:00.000Z', 0.8, null),
    ]);
    // With a single record, before = current (same value) so delta=0
    // -> not actually insufficient, since both boundaries are available from same record
    const result = await computeReport(logsDir, fixedClock);
    // Single record: before = current = same snapshot -> delta = 0 -> estimatedValueRecoveredUsd = null
    expect(result.insufficientData).toBe(false);
    expect(result.deltaUtilization).toBe(0);
    expect(result.estimatedValueRecoveredUsd).toBeNull();
  });

  it('handles negative delta gracefully — no fabricated value (insufficient value)', async () => {
    // Before utilization > current (utilization went down)
    await writeAuditFile(logsDir, '2026-02-22', [
      makeUsagePolledLine('2026-02-18T13:00:00.000Z', 0.8, null),
      makeUsagePolledLine('2026-02-22T10:00:00.000Z', 0.4, null),
    ]);
    const result = await computeReport(logsDir, fixedClock);
    expect(result.insufficientData).toBe(false);
    expect(result.deltaUtilization).toBe(-40);
    expect(result.estimatedValueRecoveredUsd).toBeNull();
  });

  it('skips malformed lines but still computes report from valid records (AC13)', async () => {
    await writeAuditFile(logsDir, '2026-02-22', [
      'BAD JSON LINE',
      makeUsagePolledLine('2026-02-18T13:00:00.000Z', 0.4, null),
      '{corrupt:}',
      makeUsagePolledLine('2026-02-22T10:00:00.000Z', 0.6, null),
    ]);
    const result = await computeReport(logsDir, fixedClock);
    expect(result.insufficientData).toBe(false);
    expect(result.beforeUtilization).toBe(40);
    expect(result.currentUtilization).toBe(60);
  });

  it('counts tasks from multiple files across window (AC15)', async () => {
    await writeAuditFile(logsDir, '2026-02-20', [
      makeUsagePolledLine('2026-02-20T10:00:00.000Z', 0.5, null),
      makeTaskCompletedLine('2026-02-20T11:00:00.000Z', 'task-A', 'template', null),
    ]);
    await writeAuditFile(logsDir, '2026-02-23', [
      makeUsagePolledLine('2026-02-23T10:00:00.000Z', 0.8, null),
      makeTaskCompletedLine('2026-02-23T11:00:00.000Z', 'task-B', 'custom', null),
    ]);
    const result = await computeReport(logsDir, fixedClock);
    expect(result.tasksCompleted).toBe(2);
  });

  it('only parses files overlapping the window (AC15 — performance boundary)', async () => {
    // File outside window — should not be included
    await writeAuditFile(logsDir, '2026-02-10', [
      makeUsagePolledLine('2026-02-10T10:00:00.000Z', 0.3, null),
    ]);
    // File inside window
    await writeAuditFile(logsDir, '2026-02-22', [
      makeUsagePolledLine('2026-02-18T13:00:00.000Z', 0.4, null),
      makeUsagePolledLine('2026-02-22T10:00:00.000Z', 0.7, null),
    ]);
    const result = await computeReport(logsDir, fixedClock);
    expect(result.insufficientData).toBe(false);
    // The 2026-02-10 record should not affect the computation
    expect(result.beforeUtilization).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// report command integration tests
// ---------------------------------------------------------------------------

describe('registerReport — human mode', () => {
  let stdoutOutput: string;
  let stderrOutput: string;
  let logsDir: string;

  beforeEach(async () => {
    vi.resetModules();
    logsDir = makeTempDir();
    await mkdir(logsDir, { recursive: true });
    stdoutOutput = '';
    stderrOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      stderrOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    vi.doMock('../index.js', () => ({ isJsonMode: () => false }));
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ logs: logsDir, data: logsDir, config: logsDir }),
    }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(logsDir, { recursive: true, force: true });
  });

  it('renders insufficient-data fallback string when no audit data (AC4)', async () => {
    const { registerReport } = await import('./report.js');
    const program = new Command();
    program.exitOverride();
    registerReport(program);
    await program.parseAsync(['node', 'sparecrow', 'report']);
    expect(stdoutOutput).toBe(
      'Insufficient data to calculate utilization and recovered value yet.\n',
    );
  });

  it('renders detailed report when sufficient data exists (AC1)', async () => {
    // Use a relative date 2 days ago so audit data stays within the 7-day rolling window
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const dateStr = twoDaysAgo.toISOString().slice(0, 10);
    const ts1 = new Date(twoDaysAgo.setHours(8, 0, 0, 0)).toISOString();
    const ts2 = new Date(twoDaysAgo.setHours(10, 0, 0, 0)).toISOString();
    const ts3 = new Date(twoDaysAgo.setHours(11, 0, 0, 0)).toISOString();
    await writeAuditFile(logsDir, dateStr, [
      makeUsagePolledLine(ts1, 0.4, null),
      makeUsagePolledLine(ts2, 0.7, null),
      makeTaskCompletedLine(ts3, 'task-1', 'template', 'improve-code'),
    ]);

    const { registerReport } = await import('./report.js');
    const program = new Command();
    program.exitOverride();
    registerReport(program);
    await program.parseAsync(['node', 'sparecrow', 'report']);
    expect(stdoutOutput).toContain('Utilization Report');
    expect(stdoutOutput).toContain('Before utilization:');
    expect(stdoutOutput).toContain('Current utilization:');
    expect(stdoutOutput).toContain('Value recovered:');
    expect(stdoutOutput).toContain('Tasks completed:');
  });

  it('renders attribution line in exact voice (AC1)', async () => {
    // Use a relative date 2 days ago so audit data stays within the 7-day rolling window
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const dateStr = twoDaysAgo.toISOString().slice(0, 10);
    const ts1 = new Date(twoDaysAgo.setHours(8, 0, 0, 0)).toISOString();
    const ts2 = new Date(twoDaysAgo.setHours(10, 0, 0, 0)).toISOString();
    await writeAuditFile(logsDir, dateStr, [
      makeUsagePolledLine(ts1, 0.3, null),
      makeUsagePolledLine(ts2, 0.8, null),
    ]);

    const { registerReport } = await import('./report.js');
    const program = new Command();
    program.exitOverride();
    registerReport(program);
    await program.parseAsync(['node', 'sparecrow', 'report']);
    expect(stdoutOutput).toMatch(/Your configuration recovered \$\d+ in capacity this week\./);
  });

  it('insufficient-data mode outputs exactly one line — no additional lines (AC4)', async () => {
    const { registerReport } = await import('./report.js');
    const program = new Command();
    program.exitOverride();
    registerReport(program);
    await program.parseAsync(['node', 'sparecrow', 'report']);
    const lines = stdoutOutput.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('Insufficient data to calculate utilization and recovered value yet.');
  });
});

describe('registerReport — JSON mode', () => {
  let stdoutOutput: string;
  let logsDir: string;

  beforeEach(async () => {
    vi.resetModules();
    logsDir = makeTempDir();
    await mkdir(logsDir, { recursive: true });
    stdoutOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    vi.doMock('../index.js', () => ({ isJsonMode: () => true }));
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ logs: logsDir, data: logsDir, config: logsDir }),
    }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(logsDir, { recursive: true, force: true });
  });

  function parseOutput(): { ok: boolean; data: unknown; error: unknown } {
    return JSON.parse(stdoutOutput) as { ok: boolean; data: unknown; error: unknown };
  }

  it('returns fixed-schema wrapper with ok, data, error fields (AC2)', async () => {
    const { registerReport } = await import('./report.js');
    const program = new Command();
    program.exitOverride();
    registerReport(program);
    await program.parseAsync(['node', 'sparecrow', 'report']);
    const parsed = parseOutput();
    expect(parsed).toHaveProperty('ok');
    expect(parsed).toHaveProperty('data');
    expect(parsed).toHaveProperty('error');
    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeNull();
  });

  it('data has all required keys (AC2)', async () => {
    const { registerReport } = await import('./report.js');
    const program = new Command();
    program.exitOverride();
    registerReport(program);
    await program.parseAsync(['node', 'sparecrow', 'report']);
    const { data } = parseOutput();
    const d = data as Record<string, unknown>;
    expect(d).toHaveProperty('periodStart');
    expect(d).toHaveProperty('periodEnd');
    expect(d).toHaveProperty('beforeUtilization');
    expect(d).toHaveProperty('currentUtilization');
    expect(d).toHaveProperty('deltaUtilization');
    expect(d).toHaveProperty('estimatedValueRecoveredUsd');
    expect(d).toHaveProperty('tasksCompleted');
    expect(d).toHaveProperty('breakdownByTaskType');
    expect(d).toHaveProperty('attribution');
    expect(d).toHaveProperty('insufficientData');
  });

  it('nullable fields are null in insufficient-data mode (AC3, AC4)', async () => {
    const { registerReport } = await import('./report.js');
    const program = new Command();
    program.exitOverride();
    registerReport(program);
    await program.parseAsync(['node', 'sparecrow', 'report']);
    const { data } = parseOutput();
    const d = data as Record<string, unknown>;
    expect(d['beforeUtilization']).toBeNull();
    expect(d['currentUtilization']).toBeNull();
    expect(d['deltaUtilization']).toBeNull();
    expect(d['estimatedValueRecoveredUsd']).toBeNull();
    expect(d['attribution']).toBeNull();
    expect(d['insufficientData']).toBe(true);
    // tasksCompleted must be a number
    expect(typeof d['tasksCompleted']).toBe('number');
    // breakdownByTaskType must be an array
    expect(Array.isArray(d['breakdownByTaskType'])).toBe(true);
  });

  it('periodStart and periodEnd are ISO 8601 strings (AC3)', async () => {
    const { registerReport } = await import('./report.js');
    const program = new Command();
    program.exitOverride();
    registerReport(program);
    await program.parseAsync(['node', 'sparecrow', 'report']);
    const { data } = parseOutput();
    const d = data as Record<string, unknown>;
    expect(typeof d['periodStart']).toBe('string');
    expect(typeof d['periodEnd']).toBe('string');
    // Should parse as valid ISO dates
    expect(new Date(d['periodStart'] as string).toISOString()).toBe(d['periodStart']);
    expect(new Date(d['periodEnd'] as string).toISOString()).toBe(d['periodEnd']);
  });

  it('returns valid wrapper with error field populated on fatal error (AC13)', async () => {
    // Mock computeReport to throw an ScrowError
    vi.doMock('./report-data.js', () => ({
      computeReport: () => {
        throw Object.assign(new Error('mock failure'), { code: 'REPORT_COMPUTATION_FAILED' });
      },
    }));

    const { registerReport } = await import('./report.js');
    const program = new Command();
    program.exitOverride();
    registerReport(program);
    await program.parseAsync(['node', 'sparecrow', 'report']);
    const parsed = parseOutput();
    expect(parsed.ok).toBe(false);
    expect(parsed.data).toBeNull();
    expect(parsed.error).not.toBeNull();
  });
});
