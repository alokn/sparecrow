/** Stats computation engine — aggregates audit log data into personal usage analytics. */
import { discoverLogFiles, parseLogFile, parseSinceDuration } from './log-reader.js';
import type { LogEntry } from '../../types/index.js';

/** Aggregate stats computed from audit log entries. */
export interface StatsData {
  /** ISO 8601 start of the period. */
  periodStart: string;
  /** ISO 8601 end of the period. */
  periodEnd: string;
  /** Total number of task executions (including retries and quota events). */
  totalTasks: number;
  /** Number of successful tasks. */
  successCount: number;
  /** Number of failed tasks. */
  failureCount: number;
  /** Number of retried/quota-exhausted tasks. */
  retryCount: number;
  /** True when at least one terminal (success or failed) task execution exists. */
  hasTasks: boolean;
  /** Success rate as a percentage (0-100). 0 when no terminal task executions exist. */
  successRate: number;
  /** Total execution time in milliseconds across all tasks. */
  totalDurationMs: number;
  /** Average execution time in milliseconds. 0 when no tasks with duration exist. */
  avgDurationMs: number;
  /** Breakdown of task counts by task name. */
  taskBreakdown: StatsTaskBreakdown[];
  /** Number of distinct days with at least one task execution. */
  activeDays: number;
  /** Average tasks per active day. 0 when no active days. */
  avgTasksPerDay: number;
}

/** Per-task-name breakdown for stats. */
export interface StatsTaskBreakdown {
  taskName: string;
  total: number;
  succeeded: number;
  failed: number;
  /** Retry/quota-exhausted events for this task. */
  retried: number;
}

/** Options for computing stats. */
export interface StatsOptions {
  logsDir: string;
  since?: string;
}

/** Computes aggregate stats from audit log entries. */
export async function computeStats(options: StatsOptions): Promise<StatsData> {
  let sinceDate: Date | undefined;
  if (options.since) {
    sinceDate = parseSinceDuration(options.since);
  }

  const files = await discoverLogFiles(options.logsDir, sinceDate);
  const allEntries: LogEntry[] = [];
  for (const file of files) {
    const entries = await parseLogFile(file);
    allEntries.push(...entries);
  }

  // Capture sinceDate in a local const to avoid fragile TypeScript narrowing across the lambda closure
  const since = sinceDate;

  // Apply since filter at timestamp level — use a spread copy to avoid mutating allEntries in place
  const filtered = since
    ? allEntries.filter((e) => new Date(e.timestamp) >= since)
    : [...allEntries];

  // Sort chronologically
  filtered.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  const totalTasks = filtered.length;
  const successCount = filtered.filter((e) => e.outcome === 'success').length;
  const failureCount = filtered.filter((e) => e.outcome === 'failed').length;
  const retryCount = filtered.filter(
    (e) => e.outcome === 'retrying' || e.outcome === 'quota',
  ).length;
  // Use only terminal outcomes (success + failure) as denominator so retry/quota events
  // do not artificially deflate the success rate.
  const terminalCount = successCount + failureCount;
  const hasTasks = terminalCount > 0;
  const successRate = hasTasks ? Math.round((successCount / terminalCount) * 100) : 0;

  // Duration aggregation
  const durationsMs = filtered
    .map((e) => e.durationMs)
    .filter((d): d is number => d !== null && d >= 0);
  const totalDurationMs = durationsMs.reduce((sum, d) => sum + d, 0);
  const avgDurationMs =
    durationsMs.length > 0 ? Math.round(totalDurationMs / durationsMs.length) : 0;

  // Task breakdown
  const breakdownMap = new Map<
    string,
    { total: number; succeeded: number; failed: number; retried: number }
  >();
  for (const entry of filtered) {
    const existing = breakdownMap.get(entry.taskName) ?? {
      total: 0,
      succeeded: 0,
      failed: 0,
      retried: 0,
    };
    existing.total++;
    if (entry.outcome === 'success') existing.succeeded++;
    if (entry.outcome === 'failed') existing.failed++;
    if (entry.outcome === 'retrying' || entry.outcome === 'quota') existing.retried++;
    breakdownMap.set(entry.taskName, existing);
  }
  const taskBreakdown: StatsTaskBreakdown[] = Array.from(breakdownMap.entries())
    .map(([taskName, counts]) => ({ taskName, ...counts }))
    .sort((a, b) => b.total - a.total);

  // Active days
  const daySet = new Set<string>();
  for (const entry of filtered) {
    daySet.add(entry.timestamp.slice(0, 10));
  }
  const activeDays = daySet.size;
  const avgTasksPerDay = activeDays > 0 ? Math.round((totalTasks / activeDays) * 10) / 10 : 0;

  // Period boundaries
  const periodStart =
    filtered.length > 0
      ? filtered[0]!.timestamp
      : (sinceDate?.toISOString() ?? new Date().toISOString());
  const periodEnd =
    filtered.length > 0 ? filtered[filtered.length - 1]!.timestamp : new Date().toISOString();

  return {
    periodStart,
    periodEnd,
    totalTasks,
    successCount,
    failureCount,
    retryCount,
    hasTasks,
    successRate,
    totalDurationMs,
    avgDurationMs,
    taskBreakdown,
    activeDays,
    avgTasksPerDay,
  };
}
