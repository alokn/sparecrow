/** Provider plugin interface and execution backend abstractions — orchestration core only interacts through these. */
import type { CapacitySnapshot } from './usage.js';
import type { TaskDefinition, TaskResult } from './task.js';

export interface UsageMonitor {
  poll(): Promise<CapacitySnapshot>;
}

export interface TaskExecutorOptions {
  signal?: AbortSignal;
  /**
   * Interval in ms for periodic child process health checks.
   * Defaults to 60000ms (60 seconds). Set to 0 to disable health checks.
   * Note: the first check establishes a CPU baseline, so the earliest a warning
   * can fire is after 3 intervals (baseline + 2 consecutive idle checks).
   */
  healthCheckIntervalMs?: number;
  /**
   * Explicit environment map for the child process.
   * When provided, forwarded as-is to the backend; no additional sanitization is applied.
   * When absent, the backend constructs a sanitized env
   * (stripping Claude Code session variables and any configured extra patterns).
   */
  env?: Record<string, string>;
  /**
   * Optional callback invoked for each stdout/stderr chunk as it arrives.
   * Used by the daemon's partial output writer to stream live task output to disk.
   * Errors thrown by this callback are swallowed at the spawn level to protect execution.
   */
  onChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void;
}

export interface TaskExecutor {
  execute(task: TaskDefinition, options?: TaskExecutorOptions): Promise<TaskResult>;
}

export interface AuthManager {
  getToken(): Promise<string>;
  refresh(): Promise<void>;
  validate(): Promise<boolean>;
}

/** Result of a full auth validation (credential file check + CLI status check). */
export interface AuthValidationResult {
  valid: boolean;
  tier: string;
}

export interface Provider {
  usageMonitor: UsageMonitor;
  taskExecutor: TaskExecutor;
  authManager: AuthManager;
  /** The execution backend used by this provider, if applicable. */
  backend?: ExecutionBackend;
}

// ─── Execution Backend abstractions ────────────────────────────────────────────

/** Options for executing a CLI command via an ExecutionBackend. */
export interface BackendExecutionOptions {
  /** Working directory for the child process. */
  cwd?: string;
  /** Timeout in milliseconds; 0 means no timeout. */
  timeoutMs: number;
  /** Optional external AbortSignal; child is killed on abort. */
  signal?: AbortSignal;
  /**
   * Explicit environment map for the child process.
   * When provided, used as-is — no additional sanitization is applied by the backend.
   * When undefined, the backend constructs a sanitized env (container backends
   * may inherit process.env or construct their own env).
   */
  env?: Record<string, string>;
  /**
   * Interval in ms for periodic child process health checks.
   * Defaults to 60000ms (60 seconds). Set to 0 to disable health checks.
   */
  healthCheckIntervalMs?: number;
  /** Additional env variable name patterns to strip (glob-style, suffix-wildcard only). */
  envStripPatterns?: string[];
  /**
   * Optional callback invoked for each stdout/stderr chunk as it arrives.
   * Used by the daemon's partial output writer to stream live task output to disk.
   * Errors thrown by this callback are swallowed at the spawn level to protect execution.
   */
  onChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void;
}

/** Result of a CLI command executed by an ExecutionBackend. */
export interface BackendExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** True when the child was terminated due to timeout. */
  timedOut: boolean;
  /** True when the child was terminated due to external abort signal. */
  aborted: boolean;
  /** True when the container was killed by the OOM killer. Always false for non-container backends. */
  oomKilled: boolean;
}

/** Abstraction for HOW a CLI binary is invoked via a container runtime. */
export interface ExecutionBackend {
  /** Backend identifier (always 'container'). */
  readonly name: string;
  /** Runtime availability check — resolves true if the backend can execute commands. */
  available(): Promise<boolean>;
  /** Execute a CLI command with the given arguments and options. */
  execute(
    command: string,
    args: string[],
    options: BackendExecutionOptions,
  ): Promise<BackendExecutionResult>;
}
