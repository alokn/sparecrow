/** Status snapshot types for the status command display. */
import type { DispatchCycleResult } from './task.js';

export type DaemonState = 'running' | 'stopped' | 'not-started' | 'unknown';
export type AuthState = 'valid' | 'expired' | 'missing' | 'unknown';

export interface StatusHealth {
  daemon: DaemonState;
  auth: AuthState;
  pid: number | null;
  uptime: string | null;
  lastErrorDetail: DaemonLastError | null;
}

export interface StatusUsage {
  sessionUtilization: number | null;
  weeklyUtilization: number | null;
  sessionResetsAt: string | null;
  weeklyResetsAt: string | null;
  source: string | null;
  confidence: string | null;
  subscriptionTier: string | null;
  degradedReason: string | null;
  /** ISO 8601 timestamp of when the daemon last polled usage data. null when daemon has never polled. */
  lastPolledAt: string | null;
  /** Waste potential fraction (0-1). null when no trigger data. */
  wastePotential: number | null;
  /** Effective reserve fraction (0-1). null when no trigger data. */
  effectiveReserve: number | null;
  /** Available budget fraction (can be negative). null when no trigger data. */
  availableBudget: number | null;
  /** Whether current time is within idle_hours. null when no trigger data. */
  isIdleHours: boolean | null;
  /** Whether any rate window is below 80% utilization. null when no trigger data. */
  rateHeadroom: boolean | null;
  /** The reason string from the last trigger evaluation. null when no trigger data. */
  dispatchReason: string | null;
  /** Whether dispatch is currently active. null when no trigger data. */
  shouldDispatch: boolean | null;
  /** Human-readable idle_hours schedule summary. null when not configured or config unavailable. */
  idleHoursSchedule: string | null;
  /** Per-model waste potential. null when no trigger data. */
  perModelWaste: Array<{ model: string; waste: number }> | null;
}

export interface StatusQueue {
  pendingCount: number;
  /** Count of tasks currently being executed (status === 'in-progress'). Story 10.9 AC4. */
  runningCount: number;
  taskNames: string[];
}

export interface StatusDispatchRow {
  outcome: 'success' | 'failed' | 'retrying';
  task: string;
  relativeTime: string;
  duration: string;
  summary: string;
  targetPath: string;
  errorCode: string | null;
}

export interface StatusActivity {
  dispatchCount: number;
  successRate: number | null;
  dollarValueRecovered: number | null;
  recentDispatches: StatusDispatchRow[];
}

export interface StatusSnapshot {
  health: StatusHealth;
  usage: StatusUsage;
  queue: StatusQueue;
  activity: StatusActivity;
  backendState: DaemonBackendState | null;
}

/** Outcome of a single log entry derived from its event type. */
export type LogOutcome = 'success' | 'failed' | 'quota' | 'retrying' | 'unknown';

/** A single parsed entry from the audit JSONL log, ready for display. */
export interface LogEntry {
  timestamp: string; // ISO 8601
  level: string;
  event: string;
  outcome: LogOutcome;
  taskName: string;
  taskId: string | null;
  durationMs: number | null;
  exitCode: number | null;
  summary: string;
  targetPath: string | null;
  stdout: string | null;
  stderr: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  provider: string | null;
  source: string | null;
  confidence: string | null;
  error: string | null;
}

/** Options passed to the log query engine. */
export interface LogQueryOptions {
  logsDir: string;
  since?: Date;
  count: number;
  taskFilter?: string;
  verbose?: boolean;
  full?: boolean;
  outcomeFilter?: LogOutcome[];
}

/** A single failure reason grouped with its count for summary display. */
export interface FailureSummaryEntry {
  reason: string;
  code: string;
  count: number;
}

/** Result returned by the log query engine. */
export interface LogQueryResult {
  entries: LogEntry[];
  total: number;
  successCount: number;
  failureCount: number;
  failureSummary: FailureSummaryEntry[];
}

/** Backend state for container execution — written to daemon-status.json per cycle. */
export interface DaemonBackendState {
  /** Backend name: always 'container'. */
  name: string;
  /** Container runtime name (e.g., 'docker', 'podman'). null when runtime unavailable. */
  runtime: string | null;
  /** Container runtime version string. null when runtime unavailable. */
  version: string | null;
  /** Whether the backend is currently available. */
  available: boolean;
}

/** Daemon lifecycle state — written to daemon-status.json on startup. */
export type DaemonLifecycleState = 'running' | 'restarting' | 'stopping' | 'stopped' | 'error';

/** Usage state as written to daemon-status.json (stable contract for CLI readers). */
export interface DaemonUsageState {
  sessionUtilization: number | null;
  weeklyUtilization: number | null;
  sessionResetsAt: string | null;
  weeklyResetsAt: string | null;
  source: string | null;
  confidence: string | null;
  subscriptionTier: string | null;
  degradedReason: string | null;
}

/** Trigger evaluation state written per cycle. */
export interface DaemonTriggerState {
  shouldDispatch: boolean;
  reason: string;
  evaluatedAt: string;
  snapshotSource: string;
  /** Waste potential fraction (0-1). null when no budget windows. */
  wastePotential: number | null;
  /** Effective reserve fraction (0-1). null when no budget windows. */
  effectiveReserve: number | null;
  /** Available budget fraction (can be negative). null when no budget windows. */
  availableBudget: number | null;
  /**
   * Whether current time is within configured idle_hours.
   *
   * Always non-null (never nullable) because this field is only written to daemon-status.json
   * when a trigger evaluation cycle has run — it is always either true or false at that point.
   * Contrast with `StatusUsage.isIdleHours` (boolean | null) which allows null for the
   * "no trigger data yet" case when the CLI reads before the first cycle completes.
   */
  isIdleHours: boolean;
  /** Whether any rate window is below 80% utilization. */
  rateHeadroom: boolean;
  /** Per-model waste potential. null when no per-model data available. */
  perModelWaste: Array<{ model: string; waste: number }> | null;
}

/** Active task identity written when dispatch is in-flight. */
export interface DaemonActiveTaskState {
  taskId: string;
  taskName: string;
  taskType: string;
  startedAt: string;
}

/** Structured error context written to daemon-status.json for operator/UI consumption.
 *  All fields always present; null used for absent values. */
export interface DaemonLastError {
  /** Typed error code from ErrorCode (e.g. DAEMON_AUTH_FAILED). */
  code: string;
  /** Human-readable error message (sanitized — no raw stack traces). */
  message: string;
  /** CLI command the operator can run to recover (e.g. 'sparecrow config --reconnect'). null when not applicable. */
  recoveryCommand: string | null;
}

/** Full daemon status file written on every cycle and on state transitions.
 *  All top-level fields always present; null used for absent values. */
export interface DaemonStatusFile {
  state: DaemonLifecycleState;
  startedAt: string | null;
  lastPollAt: string | null;
  nextPollAt: string | null;
  usage: DaemonUsageState | null;
  trigger: DaemonTriggerState | null;
  activeTask: DaemonActiveTaskState | null;
  /** Simple string error for backward compatibility with readers that only expect a string. */
  lastError: string | null;
  /** Structured error context for UI/CLI rendering — includes code, message, and recovery hint. */
  lastErrorDetail: DaemonLastError | null;
  updatedAt: string;
  /** Legacy fields kept for backward compatibility with existing readers. */
  lastDispatchAt: string | null;
  cycleResult: DispatchCycleResult | null;
  queueDepth: number;
  /** PID of the running daemon process. null when daemon is not running. Always present. */
  pid: number | null;
  /** Backend state for container execution. null before first backend probe. */
  backendState: DaemonBackendState | null;
}

/** Initial daemon status written on bootstrap (superset of what status-state.ts reads). */
export interface DaemonBootstrapStatus {
  startedAt: string;
  state: DaemonLifecycleState;
  pid: number;
  lastDispatchAt: null;
  cycleResult: null;
  queueDepth: number;
  updatedAt: string;
  lastPollAt: null;
  nextPollAt: null;
  usage: null;
  trigger: null;
  activeTask: null;
  lastError: null;
  lastErrorDetail: null;
  backendState: null;
}

/** Result returned by getDaemonStatus() in the lifecycle service. */
export interface DaemonStatusInfo {
  state: DaemonState;
  pid: number | null;
  uptime: string | null;
  startedAt: string | null;
  /** Active task identity read from daemon-status.json, or null when no task is executing.
   *  Included here to allow callers to perform a single status-file read (no TOCTOU). */
  activeTask: { taskName: string; startedAt: string } | null;
}
