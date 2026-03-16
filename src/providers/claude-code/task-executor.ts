/** ClaudeCodeTaskExecutor — spawns Claude CLI in headless mode with guardrails. */
import { access, constants } from 'node:fs/promises';
import type {
  TaskExecutor,
  TaskExecutorOptions,
  ExecutionBackend,
  BackendExecutionOptions,
  BackendExecutionResult,
} from '../../types/index.js';
import type { TaskDefinition, TaskResult, TaskStatus } from '../../types/index.js';
import type { ProviderConfig } from '../../types/index.js';
import type { RequeuePort } from '../../types/index.js';
import { NoOpRequeueAdapter, EventName } from '../../types/index.js';
import { ScrowError, ErrorCode } from '../../errors/index.js';
import type { ErrorCodeValue } from '../../errors/index.js';
import { logger } from '../../utils/index.js';

// DEFAULT_TIMEOUT_MS is authoritative in src/queue/queue-store.ts. Task definitions
// are validated by QueuePayloadSchema which enforces timeoutMs >= 0 (nonnegative()),
// so task.timeoutMs is always a valid non-negative value by the time it reaches this executor.

/** Patterns (case-insensitive) that classify a non-zero exit as quota exhaustion. */
const QUOTA_PATTERNS = [
  'rate limit',
  'quota',
  'capacity exceeded',
  'too many requests',
  '429',
] as const;

/**
 * Classifies process exit as task status.
 * Pure function — no side effects, fully unit-testable.
 */
export function classifyExit(
  exitCode: number | null,
  stdout: string,
  stderr: string,
): { status: TaskStatus; errorCode: ErrorCodeValue | null } {
  if (exitCode === 0) {
    return { status: 'done', errorCode: null };
  }

  const combined = (stdout + stderr).toLowerCase();
  for (const pattern of QUOTA_PATTERNS) {
    if (combined.includes(pattern)) {
      return { status: 'failed_quota', errorCode: ErrorCode.QUOTA_EXHAUSTED };
    }
  }

  return { status: 'failed', errorCode: ErrorCode.TASK_EXECUTION_FAILED };
}

/**
 * Extracts executor output from raw stdout string.
 * Isolated to allow future swap to stream-json parsing without changing executor contract.
 */
export function parseExecutorOutput(raw: string): string {
  return raw;
}

export class ClaudeCodeTaskExecutor implements TaskExecutor {
  private readonly _config: ProviderConfig;
  private readonly _backend: ExecutionBackend;
  private readonly _requeuePort: RequeuePort;

  constructor(
    config: ProviderConfig,
    backend: ExecutionBackend,
    requeuePort: RequeuePort = new NoOpRequeueAdapter(),
  ) {
    this._config = config;
    this._backend = backend;
    this._requeuePort = requeuePort;
  }

  async execute(task: TaskDefinition, options?: TaskExecutorOptions): Promise<TaskResult> {
    const startedAt = new Date();

    // AC2: Fail with typed error if claudePath is missing or not accessible
    const claudePath = this._config.claudePath;
    if (!claudePath) {
      throw new ScrowError(
        ErrorCode.CLAUDE_NOT_FOUND,
        'Claude binary not found. Run `sparecrow onboard` or set `provider.claude_path` in config.',
      );
    }

    // AC2: Verify binary exists AND is executable (X_OK prevents obscure spawn errors)
    try {
      await access(claudePath, constants.X_OK);
    } catch {
      throw new ScrowError(
        ErrorCode.CLAUDE_NOT_FOUND,
        `Claude binary not accessible at '${claudePath}'. Run \`sparecrow onboard\` or set \`provider.claude_path\` in config.`,
      );
    }

    // AC1/AC3: Build args — prompt delivered via stdin (Story 22.2) to prevent
    // exposure in /proc/PID/cmdline on shared servers. The `--print` flag without
    // a positional argument causes Claude CLI to read the prompt from stdin.
    const args: string[] = ['--print'];
    if (this._config.allowDangerouslySkipPermissions) {
      args.push('--dangerously-skip-permissions');
    }

    // timeoutMs === 0 means "no timeout" (AC7); positive values enforce a deadline.
    // QueuePayloadSchema enforces nonnegative() so task.timeoutMs is always >= 0 here.
    const timeoutMs = task.timeoutMs;

    // AC10: Log task start with identifier only — never log prompt content or tokens
    await logger.info(EventName.TASK_EXECUTOR_START, {
      taskId: task.id,
      taskName: task.name,
      taskType: task.type,
      timeoutMs,
    });

    // H2 fix: call available() before dispatch so the interface contract is exercised in
    // the production path. This guards against attempting execution when the container
    // runtime is absent.
    const backendAvailable = await this._backend.available();
    if (!backendAvailable) {
      throw new ScrowError(
        ErrorCode.BACKEND_NOT_AVAILABLE,
        `Execution backend '${this._backend.name}' reported unavailable at dispatch time.`,
      );
    }

    // AC4/AC5: Delegate CLI invocation to the injected ExecutionBackend.
    // Prompt is delivered via stdinData to prevent /proc/PID/cmdline exposure (Story 22.2).
    const backendOptions: BackendExecutionOptions = {
      cwd: task.targetPath,
      timeoutMs,
      stdinData: task.prompt,
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      ...(options?.healthCheckIntervalMs !== undefined
        ? { healthCheckIntervalMs: options.healthCheckIntervalMs }
        : {}),
      ...(options?.env !== undefined ? { env: options.env } : {}),
      ...(this._config.envStripPatterns !== undefined
        ? { envStripPatterns: this._config.envStripPatterns }
        : {}),
      ...(options?.onChunk !== undefined ? { onChunk: options.onChunk } : {}),
    };

    let result: BackendExecutionResult;
    try {
      result = await this._backend.execute(claudePath, args, backendOptions);
    } catch (backendErr) {
      // Log before re-throwing so the audit trail captures backend failures.
      // ScrowError(CLAUDE_NOT_FOUND) from the backend (enoent path) propagates here.
      // Any unexpected error from the backend implementation is also caught and logged.
      await logger.error(EventName.TASK_EXECUTOR_BACKEND_ERROR, {
        taskId: task.id,
        taskName: task.name,
        error: backendErr instanceof Error ? backendErr.message : String(backendErr),
      });
      throw backendErr;
    }

    const completedAt = new Date();
    const durationMs = completedAt.getTime() - startedAt.getTime();

    // AC4: Timeout path
    if (result.timedOut) {
      await logger.warn(EventName.TASK_EXECUTOR_TIMEOUT, {
        taskId: task.id,
        taskName: task.name,
        durationMs,
      });

      return {
        taskId: task.id,
        status: 'failed',
        startedAt,
        completedAt,
        durationMs,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        error: `Task exceeded timeout of ${timeoutMs}ms`,
        errorCode: ErrorCode.TASK_TIMEOUT,
      };
    }

    // AC5: Abort path
    if (result.aborted) {
      await logger.warn(EventName.TASK_EXECUTOR_ABORTED, {
        taskId: task.id,
        taskName: task.name,
        durationMs,
      });

      return {
        taskId: task.id,
        status: 'failed',
        startedAt,
        completedAt,
        durationMs,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        error: 'Task was cancelled',
        errorCode: null,
      };
    }

    // OOM kill path: container was killed by the OOM killer (Story 10.11 AC3)
    if (result.oomKilled) {
      await logger.warn(EventName.TASK_EXECUTOR_FAILED, {
        taskId: task.id,
        taskName: task.name,
        durationMs,
        exitCode: result.exitCode,
        status: 'failed',
        errorCode: ErrorCode.TASK_OOM_KILLED,
        oomKilled: true,
      });

      return {
        taskId: task.id,
        status: 'failed',
        startedAt,
        completedAt,
        durationMs,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        error: 'Container was killed due to insufficient memory',
        errorCode: ErrorCode.TASK_OOM_KILLED,
      };
    }

    // AC8: Success path
    if (result.exitCode === 0) {
      const stdout = parseExecutorOutput(result.stdout);

      await logger.info(EventName.TASK_EXECUTOR_SUCCESS, {
        taskId: task.id,
        taskName: task.name,
        durationMs,
        exitCode: result.exitCode,
      });

      return {
        taskId: task.id,
        status: 'done',
        startedAt,
        completedAt,
        durationMs,
        stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        error: null,
        errorCode: null,
      };
    }

    // AC6/AC7: Classify non-zero exit
    const { status, errorCode } = classifyExit(result.exitCode, result.stdout, result.stderr);

    await logger.warn('task.executor.failed', {
      taskId: task.id,
      taskName: task.name,
      durationMs,
      exitCode: result.exitCode,
      status,
      errorCode,
    });

    // AC6: Re-queue on quota exhaustion via seam
    if (status === 'failed_quota') {
      await this._requeuePort.requeue(task.id);
    }

    return {
      taskId: task.id,
      status,
      startedAt,
      completedAt,
      durationMs,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      error: `Process exited with code ${result.exitCode}`,
      errorCode,
    };
  }
}
