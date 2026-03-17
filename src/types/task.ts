/** Task definition and execution result types. */
import type { TaskExecutor } from './provider.js';
import type { AuditMeta } from './audit.js';
import type { ActionType } from './action.js';

export type TaskStatus = 'pending' | 'in-progress' | 'done' | 'failed' | 'failed_quota' | 'skipped';

/** Opaque string alias for error code values — keeps types/ free of errors/ imports. */
export type TaskErrorCode = string;

/**
 * In-memory representation of a queued task ready for dispatch.
 *
 * Tasks are created via `sparecrow queue add` (CLI) or the onboarding wizard,
 * persisted as `PersistedTask` in `queue.json`, and hydrated into this
 * interface before execution by the dispatcher.
 *
 * @see {@link TaskResult} for the output produced after execution.
 */
export interface TaskDefinition {
  /** Unique task identifier (UUID v4). */
  id: string;
  /** Human-readable task name shown in queue listings and logs. */
  name: string;
  /** Discriminator: 'template' for built-in/custom templates, 'custom' for ad-hoc prompts. */
  type: 'template' | 'custom';
  /** Template key when `type` is 'template'. */
  templateName?: string;
  /** Persisted queue status. Legacy queue.json records missing this field are migrated to "pending" by the schema layer. */
  status: TaskStatus;
  /** The prompt text sent to Claude Code for execution. */
  prompt: string;
  /** Absolute path to the git repository targeted by this task. */
  targetPath: string;
  /** Execution priority (1 = highest). Priorities are normalized to contiguous 1-based after every mutation. */
  priority: number;
  /** Timestamp when the task was added to the queue. */
  createdAt: Date;
  /** Timestamp when the task transitioned to a terminal status (done/failed/skipped). Absent for pending/in-progress tasks. */
  completedAt?: Date;
  /** Maximum execution time in milliseconds. Default: 3,600,000 (60 min). */
  timeoutMs: number;
  /** Declared action types from the template manifest (for post-execution pipeline). Always present; defaults to []. */
  actions: ReadonlyArray<ActionType>;
}

/**
 * Result produced by executing a single task via the dispatcher.
 *
 * Contains the full stdout/stderr capture, timing information, and any
 * error details. Written to the audit log and used by the report command.
 */
export interface TaskResult {
  /** ID of the executed task (matches {@link TaskDefinition.id}). */
  taskId: string;
  /** Final status after execution. */
  status: TaskStatus;
  /** Timestamp when execution began. */
  startedAt: Date;
  /** Timestamp when execution finished. */
  completedAt: Date;
  /** Wall-clock execution duration in milliseconds. */
  durationMs: number;
  /** Captured standard output from the Claude Code process. */
  stdout: string;
  /** Captured standard error from the Claude Code process. */
  stderr: string;
  /** Process exit code, or null if the process was killed by a signal. */
  exitCode: number | null;
  /** Human-readable error description, or null on success. */
  error: string | null;
  /** Typed error code for programmatic handling, or null on success. */
  errorCode: TaskErrorCode | null;
}

/** Output contract returned by a single dispatcher execution cycle. */
export interface DispatchCycleResult {
  tasksAttempted: number;
  tasksSucceeded: number;
  tasksFailed: number;
  stoppedByQuota: boolean;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

/** Callback invoked before a task begins execution. */
export type OnTaskStartCallback = (task: TaskDefinition) => void | Promise<void>;

/** Callback invoked after a task completes (success or failure). */
export type OnTaskCompleteCallback = (
  task: TaskDefinition,
  result: TaskResult,
) => void | Promise<void>;

/** Optional per-dispatch execution controls. */
export interface DispatchOptions {
  signal?: AbortSignal;
  /** Called before each task begins execution. Failures are caught and logged — never abort dispatch. */
  onTaskStart?: OnTaskStartCallback;
  /** Called after each task completes (success or failure). Failures are caught and logged — never abort dispatch. */
  onTaskComplete?: OnTaskCompleteCallback;
  /**
   * Optional callback invoked for each stdout/stderr chunk during task execution.
   * Used by the daemon's partial output writer for live task output streaming (AC1).
   * Errors thrown by this callback are swallowed at the spawn level to protect execution.
   */
  onChunk?: (taskId: string, chunk: string, stream: 'stdout' | 'stderr') => void;
}

/** Audit metadata for dispatcher log calls.
 *  Aliased to AuditMeta so compile-time enforcement guarantees both types stay in sync. */
export type DispatchAuditMeta = AuditMeta;

/** Minimal logger contract used by the dispatcher for structured audit events. */
export interface DispatchLogger {
  info(
    event: string,
    data?: Record<string, unknown>,
    meta?: DispatchAuditMeta,
  ): void | Promise<void>;
  warn(
    event: string,
    data?: Record<string, unknown>,
    meta?: DispatchAuditMeta,
  ): void | Promise<void>;
  error(event: string, data?: Record<string, unknown>, err?: Error): void | Promise<void>;
}

/** Dispatcher-facing queue contract: only dispatch-relevant queue operations. */
export interface QueueDispatchPort {
  listDispatchable(): Promise<TaskDefinition[]>;
  setTaskStatus(taskId: string, status: TaskStatus): Promise<void>;
}

/** Dependency injection contract for dispatcher construction. */
export interface DispatcherDeps {
  queueManager: QueueDispatchPort;
  taskExecutor: TaskExecutor;
  logger?: DispatchLogger;
}

/** Options passed to a DispatchAdapter for cancellation propagation and status callbacks.
 *  Extends DispatchOptions so that adding fields to DispatchOptions automatically applies here,
 *  eliminating the three-place update hazard noted in the code review. */
export interface DispatchAdapterOptions extends DispatchOptions {}

/** Narrow adapter interface for the polling loop dispatch seam.
 *  The real implementation is wired in runner.ts via createDispatchAdapter(). */
export interface DispatchAdapter {
  dispatchIfTriggered(
    triggerResult: import('./trigger.js').TriggerResult,
    options?: DispatchAdapterOptions,
  ): Promise<DispatchCycleResult | null>;
}
