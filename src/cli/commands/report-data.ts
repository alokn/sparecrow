/** Report data computation — window math, audit parsing, aggregation, and formatting. */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../../utils/index.js';
import { AUDIT_LOG_FILENAME_REGEX } from '../../utils/index.js';
import { ScrowError, ErrorCode } from '../../errors/index.js';
import { EventName } from '../../types/index.js';
import { asAuditRecord, asNumber, asString } from './audit-parsing.js';
import type {
  ReportData,
  ReportBreakdownRow,
  UsagePolledRecord,
  TaskCompletedRecord,
} from '../../types/index.js';

// ---------------------------------------------------------------------------
// ROI estimation constants — documented assumptions
// ---------------------------------------------------------------------------

/**
 * Estimated dollar value recovered per percentage-point of weekly utilization delta.
 *
 * Assumption: Claude Pro plan costs approximately $20/month, equivalent to ~$20 of recoverable
 * capacity per billing cycle. A 1% utilization delta over a 7-day window represents roughly $0.05
 * of recovered capacity. This is a conservative estimate for informational purposes.
 *
 * Formula: estimatedValueRecoveredUsd = deltaUtilization * PLAN_VALUE_PER_PCT_POINT * (WINDOW_HOURS / HOURS_PER_WEEK)
 *
 * Where WINDOW_HOURS = 168 (7 days), and HOURS_PER_WEEK = 168, so window factor = 1.0 for 7-day windows.
 * Effective rate: $0.50 per percentage-point recovered in a 7-day window.
 */
const PLAN_VALUE_PER_PCT_POINT_USD = 0.5;

/** Report window size: 7 days in milliseconds. */
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Clockable time interface for testability
// ---------------------------------------------------------------------------

/** Injectable clock interface — use real Date.now() in production, mock in tests. */
export type ClockFn = () => number;

/** Default clock using system time. */
export const systemClock: ClockFn = () => Date.now();

// ---------------------------------------------------------------------------
// Window math
// ---------------------------------------------------------------------------

/** Computes the [periodStart, periodEnd] window for a report invocation.
 *  periodEnd = T (invocation time), periodStart = T - 7 days. Both are inclusive. */
export function computeReportWindow(clockFn: ClockFn = systemClock): {
  periodStart: Date;
  periodEnd: Date;
} {
  const now = clockFn();
  const periodEnd = new Date(now);
  const periodStart = new Date(now - WINDOW_MS);
  return { periodStart, periodEnd };
}

/** Returns true if a timestamp falls within [periodStart, periodEnd] (inclusive both ends). */
export function isInWindow(ts: string, periodStart: Date, periodEnd: Date): boolean {
  const t = new Date(ts).getTime();
  return t >= periodStart.getTime() && t <= periodEnd.getTime();
}

// ---------------------------------------------------------------------------
// Audit JSONL discovery for report window
// ---------------------------------------------------------------------------

/** Discovers audit-YYYY-MM-DD.jsonl files overlapping the report window.
 *  Only returns files whose date is >= periodStart date (to keep runtime bounded — AC15). */
export async function discoverReportFiles(logsDir: string, periodStart: Date): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(logsDir);
  } catch (err) {
    const errno = err as NodeJS.ErrnoException;
    if (errno.code === 'ENOENT') return [];
    // Non-ENOENT is unexpected — propagate as typed error
    throw new ScrowError(
      ErrorCode.REPORT_COMPUTATION_FAILED,
      `Failed to read audit logs directory: ${errno.message ?? String(err)}`,
      err instanceof Error ? err : undefined,
    );
  }

  const sinceDay = new Date(`${periodStart.toISOString().slice(0, 10)}T00:00:00.000Z`);
  const matched: Array<{ path: string; date: string }> = [];

  for (const name of entries) {
    const m = AUDIT_LOG_FILENAME_REGEX.exec(name);
    if (!m || !m[1]) continue;
    const dateStr = m[1];
    const fileDate = new Date(`${dateStr}T00:00:00.000Z`);
    if (fileDate < sinceDay) continue;
    matched.push({ path: join(logsDir, name), date: dateStr });
  }

  // Sort oldest-first for chronological processing
  matched.sort((a, b) => a.date.localeCompare(b.date));
  return matched.map((m) => m.path);
}

// ---------------------------------------------------------------------------
// Audit JSONL raw-record parsing
// ---------------------------------------------------------------------------

/** Parses usage.polled and task.completed raw records from a single JSONL file.
 *  Malformed lines are skipped with a debug log. ENOENT returns empty arrays. */
export async function parseReportFile(
  filePath: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<{ usageRecords: UsagePolledRecord[]; taskRecords: TaskCompletedRecord[] }> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf-8');
  } catch (err) {
    const errno = err as NodeJS.ErrnoException;
    if (errno.code === 'ENOENT') return { usageRecords: [], taskRecords: [] };
    throw new ScrowError(
      ErrorCode.REPORT_COMPUTATION_FAILED,
      `Failed to read audit log file: ${errno.message ?? String(err)}`,
      err instanceof Error ? err : undefined,
    );
  }

  const lines = text.split('\n');
  const usageRecords: UsagePolledRecord[] = [];
  const taskRecords: TaskCompletedRecord[] = [];

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const rawLine = lines[lineNum];
    if (rawLine === undefined) continue;
    const line = rawLine.trim();
    if (line.length === 0) continue;

    try {
      const parsed: unknown = JSON.parse(line);
      const record = asAuditRecord(parsed);
      if (record === null) {
        void logger.debug('report.parse.skip', { file: filePath, line: lineNum + 1 });
        continue;
      }

      // Filter to report window (inclusive both ends)
      if (!isInWindow(record.ts, periodStart, periodEnd)) continue;

      if (record.event === EventName.USAGE_POLLED) {
        const data = record.data;
        const weekly = asNumber(data['weeklyUtilization']);
        const session = asNumber(data['sessionUtilization']);
        usageRecords.push({
          ts: record.ts,
          weeklyUtilization: weekly,
          sessionUtilization: session,
        });
      } else if (record.event === EventName.TASK_COMPLETED) {
        const data = record.data;
        taskRecords.push({
          ts: record.ts,
          taskId: asString(data['taskId']),
          taskName: asString(data['taskName']) ?? asString(data['name']),
          type: asString(data['type']),
          templateName: asString(data['templateName']),
        });
      }
    } catch {
      void logger.debug('report.parse.skip', { file: filePath, line: lineNum + 1 });
    }
  }

  return { usageRecords, taskRecords };
}

// ---------------------------------------------------------------------------
// Utilization boundary extraction
// ---------------------------------------------------------------------------

/** Converts a fractional utilization value (0–1) to percentage units.
 *
 * Utilization values emitted by the polling loop are always stored in fraction-space (0..1),
 * e.g. 0.33 represents 33% utilization, and 1.5 represents 150% utilization.
 * This function always multiplies by 100 to convert to percentage units — no heuristic branching.
 */
export function toPercent(value: number): number {
  // Polling loop stores utilization in fraction-space (0..1) — always convert by multiplying
  return value * 100;
}

/** Extracts before/current utilization from sorted usage records.
 *  beforeUtilization = weeklyUtilization from the earliest record.
 *  currentUtilization = weeklyUtilization from the latest record.
 *  Returns null for each boundary if no records exist. */
export function extractUtilizationBoundaries(usageRecords: UsagePolledRecord[]): {
  beforeUtilization: number | null;
  currentUtilization: number | null;
} {
  if (usageRecords.length === 0) {
    return { beforeUtilization: null, currentUtilization: null };
  }

  // Sort by timestamp ascending
  const sorted = [...usageRecords].sort(
    (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime(),
  );

  const earliest = sorted[0]!;
  const latest = sorted[sorted.length - 1]!;

  const beforeRaw = earliest.weeklyUtilization;
  const currentRaw = latest.weeklyUtilization;

  return {
    beforeUtilization: beforeRaw !== null ? toPercent(beforeRaw) : null,
    currentUtilization: currentRaw !== null ? toPercent(currentRaw) : null,
  };
}

// ---------------------------------------------------------------------------
// Grouping, sorting, and formatting
// ---------------------------------------------------------------------------

/** Derives the deterministic task-type grouping key.
 *  Prefer explicit type metadata, else templateName, else literal 'unknown'.
 *  This supports both current and historical records (AC7). */
export function deriveTaskType(record: TaskCompletedRecord): string {
  if (record.type !== null && record.type.trim().length > 0) return record.type.trim();
  if (record.templateName !== null && record.templateName.trim().length > 0)
    return record.templateName.trim();
  return 'unknown';
}

/** Rounds a dollar amount to a whole-dollar integer. */
export function roundDollars(amount: number): number {
  return Math.round(amount);
}

/** Builds breakdown rows from task records.
 *  Rows are grouped by task type, then sorted by estimatedValueRecoveredUsd desc,
 *  then taskType asc for ties (AC8). */
export function buildBreakdownRows(
  taskRecords: TaskCompletedRecord[],
  valuePerTask: number,
): ReportBreakdownRow[] {
  const byType = new Map<string, number>();

  for (const record of taskRecords) {
    const key = deriveTaskType(record);
    byType.set(key, (byType.get(key) ?? 0) + 1);
  }

  const rows: ReportBreakdownRow[] = [];
  for (const [taskType, count] of byType) {
    const estimatedValue = roundDollars(count * valuePerTask);
    rows.push({ taskType, tasksCompleted: count, estimatedValueRecoveredUsd: estimatedValue });
  }

  // Sort: by estimatedValueRecoveredUsd desc, then taskType asc for ties (AC8)
  rows.sort((a, b) => {
    const valueDiff = b.estimatedValueRecoveredUsd - a.estimatedValueRecoveredUsd;
    if (valueDiff !== 0) return valueDiff;
    return a.taskType.localeCompare(b.taskType);
  });

  return rows;
}

/** Estimates the total value recovered for the report window.
 *  Returns null if deltaUtilization is null or non-positive (AC per Dev Notes).
 *
 * Formula: estimatedValueRecoveredUsd = deltaUtilization (percentage-points) * PLAN_VALUE_PER_PCT_POINT_USD
 * The 7-day window factor is 1.0 since PLAN_VALUE_PER_PCT_POINT_USD is calibrated per 7-day window. */
export function estimateValueRecovered(deltaUtilization: number | null): number | null {
  if (deltaUtilization === null || deltaUtilization <= 0) return null;
  return roundDollars(deltaUtilization * PLAN_VALUE_PER_PCT_POINT_USD);
}

// ---------------------------------------------------------------------------
// Main report computation
// ---------------------------------------------------------------------------

/** Computes the full report for the given window using only local audit files.
 *  All ENOENT missing files are treated as empty data (AC6).
 *  Malformed JSONL lines are skipped (AC13).
 *  Non-ENOENT read failures propagate as typed ScrowError (AC13). */
export async function computeReport(
  logsDir: string,
  clockFn: ClockFn = systemClock,
): Promise<ReportData> {
  const { periodStart, periodEnd } = computeReportWindow(clockFn);

  // Discover and parse audit files overlapping the window
  const files = await discoverReportFiles(logsDir, periodStart);

  const allUsageRecords: UsagePolledRecord[] = [];
  const allTaskRecords: TaskCompletedRecord[] = [];

  for (const file of files) {
    const { usageRecords, taskRecords } = await parseReportFile(file, periodStart, periodEnd);
    allUsageRecords.push(...usageRecords);
    allTaskRecords.push(...taskRecords);
  }

  // Extract boundary utilization values
  const { beforeUtilization, currentUtilization } = extractUtilizationBoundaries(allUsageRecords);

  // Determine if we have sufficient data
  const insufficientData = beforeUtilization === null || currentUtilization === null;

  if (insufficientData) {
    return {
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      beforeUtilization: null,
      currentUtilization: null,
      deltaUtilization: null,
      estimatedValueRecoveredUsd: null,
      tasksCompleted: allTaskRecords.length,
      breakdownByTaskType: [],
      attribution: null,
      insufficientData: true,
    };
  }

  // Compute delta (percentage-points)
  const deltaUtilization = currentUtilization - beforeUtilization;

  // Estimate dollar value
  const estimatedValueRecoveredUsd = estimateValueRecovered(deltaUtilization);

  // Compute per-task value for breakdown (distribute total value evenly across tasks)
  const tasksCompleted = allTaskRecords.length;
  let valuePerTask = 0;
  if (estimatedValueRecoveredUsd !== null && tasksCompleted > 0) {
    valuePerTask = estimatedValueRecoveredUsd / tasksCompleted;
  }

  const breakdownByTaskType = buildBreakdownRows(allTaskRecords, valuePerTask);

  // Build attribution line (exact voice per AC1).
  // Only generated when value was actually recovered (estimatedValueRecoveredUsd is non-null and positive).
  // If utilization decreased or no value was recovered, attribution is null to avoid misleading "$0" messages.
  const attribution =
    estimatedValueRecoveredUsd !== null
      ? `Your configuration recovered $${String(roundDollars(estimatedValueRecoveredUsd))} in capacity this week.`
      : null;

  return {
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    beforeUtilization,
    currentUtilization,
    deltaUtilization,
    estimatedValueRecoveredUsd,
    tasksCompleted,
    breakdownByTaskType,
    attribution,
    insufficientData: false,
  };
}
