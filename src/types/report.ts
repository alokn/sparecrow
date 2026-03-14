/** Report domain types for utilization ROI and breakdown. */

/** A single row in the task-type breakdown of the report. */
export interface ReportBreakdownRow {
  taskType: string;
  tasksCompleted: number;
  estimatedValueRecoveredUsd: number;
}

/** The computed report data payload. All metric fields are nullable to support insufficient-data paths. */
export interface ReportData {
  /** Start of the 7-day report window (T-7d), ISO 8601. */
  periodStart: string;
  /** End of the report window (invocation time T), ISO 8601. */
  periodEnd: string;
  /** Utilization percentage at the beginning of the window, or null if unavailable. */
  beforeUtilization: number | null;
  /** Utilization percentage at the end of the window (current), or null if unavailable. */
  currentUtilization: number | null;
  /** Delta in utilization percentage (current - before), or null if either boundary is unavailable. */
  deltaUtilization: number | null;
  /** Estimated dollar value recovered, or null if delta unavailable or non-positive. */
  estimatedValueRecoveredUsd: number | null;
  /** Number of tasks completed in the window. */
  tasksCompleted: number;
  /** Breakdown rows grouped by task type, sorted by value desc then taskType asc. */
  breakdownByTaskType: ReportBreakdownRow[];
  /** Attribution line in exact voice, or null if insufficient data. */
  attribution: string | null;
  /** True when boundary utilization snapshots are missing and metrics could not be computed. */
  insufficientData: boolean;
}

/** A parsed utilization snapshot from audit JSONL usage.polled events. */
export interface UsagePolledRecord {
  ts: string;
  weeklyUtilization: number | null;
  sessionUtilization: number | null;
}

/** A parsed task completion record from audit JSONL task.completed events. */
export interface TaskCompletedRecord {
  ts: string;
  taskId: string | null;
  taskName: string | null;
  /** Explicit task type metadata (preferred grouping key). */
  type: string | null;
  /** Template name fallback for grouping key. */
  templateName: string | null;
}
