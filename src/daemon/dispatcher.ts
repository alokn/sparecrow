/** Sequential dispatcher that drains dispatch-eligible queue tasks through the task executor. */
import type {
  DispatchAuditMeta,
  DispatchCycleResult,
  DispatcherDeps,
  DispatchLogger,
  DispatchOptions,
  TaskDefinition,
  TaskResult,
  TaskStatus,
} from '../types/index.js';
import { EventName } from '../types/index.js';
import { ScrowError, ErrorCode } from '../errors/index.js';
import { logger } from '../utils/index.js';

const DISPATCH_AUDIT_META: DispatchAuditMeta = {
  provider: 'claude-code',
  source: 'executor',
  confidence: 'high',
};

function isTaskOutcome(status: TaskStatus): status is 'done' | 'failed' | 'failed_quota' {
  return status === 'done' || status === 'failed' || status === 'failed_quota';
}

function makeResult(
  startedAt: Date,
  completedAt: Date,
  tasksAttempted: number,
  tasksSucceeded: number,
  tasksFailed: number,
  stoppedByQuota: boolean,
): DispatchCycleResult {
  return {
    tasksAttempted,
    tasksSucceeded,
    tasksFailed,
    stoppedByQuota,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
  };
}

function makeTaskAuditData(task: TaskDefinition, result: TaskResult): Record<string, unknown> {
  return {
    taskId: task.id,
    taskName: task.name,
    // Include type and templateName for deterministic report breakdown (AC7)
    type: task.type,
    templateName: task.templateName ?? null,
    durationMs: result.durationMs,
    outcome: result.status,
    exitCode: result.exitCode,
    error: result.errorCode ?? null,
  };
}

/** Builds audit meta, optionally including an error message for failed task log events. */
function makeAuditMetaWithError(errorMessage: string | null | undefined): DispatchAuditMeta {
  if (!errorMessage) return DISPATCH_AUDIT_META;
  return { ...DISPATCH_AUDIT_META, error: errorMessage };
}

export class Dispatcher {
  private readonly _queueManager: DispatcherDeps['queueManager'];
  private _taskExecutor: DispatcherDeps['taskExecutor'];
  private readonly _logger: DispatchLogger;
  private _dispatching = false;

  constructor(deps: DispatcherDeps) {
    if (!deps.queueManager) {
      throw new ScrowError(
        ErrorCode.CONFIG_INVALID,
        'Dispatcher requires queueManager dependency in constructor.',
      );
    }

    if (!deps.taskExecutor) {
      throw new ScrowError(
        ErrorCode.CONFIG_INVALID,
        'Dispatcher requires taskExecutor dependency in constructor.',
      );
    }

    this._queueManager = deps.queueManager;
    this._taskExecutor = deps.taskExecutor;
    this._logger = deps.logger ?? logger;
  }

  /** Returns true when a dispatch cycle is currently executing. */
  get dispatching(): boolean {
    return this._dispatching;
  }

  /** Replace the task executor reference.
   *  Only safe when no dispatch cycle is in progress (_dispatching === false).
   *  Throws CONFIG_INVALID if called during an active dispatch cycle. */
  replaceExecutor(newExecutor: DispatcherDeps['taskExecutor']): void {
    if (this._dispatching) {
      throw new ScrowError(
        ErrorCode.CONFIG_INVALID,
        'Cannot replace executor while a dispatch cycle is in progress.',
      );
    }
    if (!newExecutor) {
      throw new ScrowError(
        ErrorCode.CONFIG_INVALID,
        'Dispatcher.replaceExecutor requires a non-null taskExecutor.',
      );
    }
    this._taskExecutor = newExecutor;
  }

  /** Safely invoke onTaskStart callback. Errors are caught and logged — never abort dispatch. */
  private async _safeOnTaskStart(
    options: DispatchOptions | undefined,
    task: TaskDefinition,
  ): Promise<void> {
    if (!options?.onTaskStart) return;
    try {
      await options.onTaskStart(task);
    } catch (err) {
      await this._logger.error(
        'dispatch.callback-failed',
        { callback: 'onTaskStart', taskId: task.id },
        err instanceof Error ? err : undefined,
      );
    }
  }

  /** Safely invoke onTaskComplete callback. Errors are caught and logged — never abort dispatch. */
  private async _safeOnTaskComplete(
    options: DispatchOptions | undefined,
    task: TaskDefinition,
    result: TaskResult,
  ): Promise<void> {
    if (!options?.onTaskComplete) return;
    try {
      await options.onTaskComplete(task, result);
    } catch (err) {
      await this._logger.error(
        'dispatch.callback-failed',
        { callback: 'onTaskComplete', taskId: task.id },
        err instanceof Error ? err : undefined,
      );
    }
  }

  async dispatch(options?: DispatchOptions): Promise<DispatchCycleResult> {
    const startedAt = new Date();

    if (this._dispatching) {
      await this._logger.warn('dispatch.already-running', {
        at: startedAt.toISOString(),
      });
      return makeResult(startedAt, startedAt, 0, 0, 0, false);
    }

    this._dispatching = true;

    let tasksAttempted = 0;
    let tasksSucceeded = 0;
    let tasksFailed = 0;
    let stoppedByQuota = false;

    try {
      const dispatchableTasks = await this._queueManager.listDispatchable();

      if (dispatchableTasks.length === 0) {
        await this._logger.info('dispatch.queue-empty', {});
        const completedAt = new Date();
        return makeResult(
          startedAt,
          completedAt,
          tasksAttempted,
          tasksSucceeded,
          tasksFailed,
          stoppedByQuota,
        );
      }

      for (const task of dispatchableTasks) {
        if (options?.signal?.aborted) {
          await this._logger.warn('dispatch.aborted', {
            tasksAttempted,
            tasksSucceeded,
            tasksFailed,
          });
          break;
        }

        tasksAttempted += 1;

        // Notify caller that a task is about to begin (AC1, AC2)
        await this._safeOnTaskStart(options, task);

        // Story 10.9 AC1: Transition task to in-progress before execution begins.
        // This ensures `scrow queue` and `scrow status` show the task as actively running.
        await this._queueManager.setTaskStatus(task.id, 'in-progress');

        let executionResult: TaskResult;

        // Capture execution start time before the executor call so that
        // the synthetic failedResult on throw carries the actual elapsed duration.
        const taskStartedAt = new Date();

        try {
          // Build executor options: forward signal and onChunk if present.
          const executorOptions =
            options?.signal !== undefined || options?.onChunk !== undefined
              ? {
                  ...(options.signal !== undefined ? { signal: options.signal } : {}),
                  ...(options.onChunk !== undefined
                    ? {
                        onChunk: (chunk: string, stream: 'stdout' | 'stderr') =>
                          options.onChunk!(task.id, chunk, stream),
                      }
                    : {}),
                }
              : undefined;
          executionResult = await this._taskExecutor.execute(task, executorOptions);
        } catch (err) {
          const completedAt = new Date();
          const failedResult: TaskResult = {
            taskId: task.id,
            status: 'failed',
            startedAt: taskStartedAt,
            completedAt,
            durationMs: completedAt.getTime() - taskStartedAt.getTime(),
            stdout: '',
            stderr: '',
            exitCode: null,
            error: err instanceof Error ? err.message : String(err),
            errorCode: null,
          };

          tasksFailed += 1;
          await this._queueManager.setTaskStatus(task.id, 'failed');
          await this._logger.warn(
            'task.failed',
            makeTaskAuditData(task, failedResult),
            makeAuditMetaWithError(failedResult.error),
          );
          // Notify caller that the task completed with failure (AC3, AC4)
          await this._safeOnTaskComplete(options, task, failedResult);
          continue;
        }

        if (!isTaskOutcome(executionResult.status)) {
          tasksFailed += 1;
          await this._queueManager.setTaskStatus(task.id, 'failed');
          await this._logger.warn(
            'task.failed',
            makeTaskAuditData(task, executionResult),
            makeAuditMetaWithError(executionResult.error),
          );
          // Notify caller that the task completed with unexpected status (AC3, AC4)
          await this._safeOnTaskComplete(options, task, executionResult);
          continue;
        }

        if (executionResult.status === 'done') {
          tasksSucceeded += 1;
          await this._queueManager.setTaskStatus(task.id, 'done');
          await this._logger.info(
            'task.completed',
            makeTaskAuditData(task, executionResult),
            DISPATCH_AUDIT_META,
          );
          // Notify caller that the task completed successfully (AC3, AC4)
          await this._safeOnTaskComplete(options, task, executionResult);
          continue;
        }

        if (executionResult.status === 'failed') {
          tasksFailed += 1;
          await this._queueManager.setTaskStatus(task.id, 'failed');
          await this._logger.warn(
            'task.failed',
            makeTaskAuditData(task, executionResult),
            makeAuditMetaWithError(executionResult.error),
          );
          // Notify caller that the task completed with failure (AC3, AC4)
          await this._safeOnTaskComplete(options, task, executionResult);
          continue;
        }

        await this._queueManager.setTaskStatus(task.id, 'failed_quota');
        await this._logger.warn(
          EventName.DISPATCH_QUOTA_EXHAUSTED,
          makeTaskAuditData(task, executionResult),
          DISPATCH_AUDIT_META,
        );
        await this._logger.info(
          EventName.TASK_REQUEUED,
          {
            ...makeTaskAuditData(task, executionResult),
            reason: 'quota-exhausted',
          },
          DISPATCH_AUDIT_META,
        );
        // Notify caller that the task completed with quota exhaustion (AC3, AC4)
        await this._safeOnTaskComplete(options, task, executionResult);
        stoppedByQuota = true;
        break;
      }

      const completedAt = new Date();
      return makeResult(
        startedAt,
        completedAt,
        tasksAttempted,
        tasksSucceeded,
        tasksFailed,
        stoppedByQuota,
      );
    } catch (err) {
      const wrappedErr =
        err instanceof ScrowError
          ? err
          : new ScrowError(
              ErrorCode.TASK_EXECUTION_FAILED,
              'Dispatch cycle encountered an unexpected internal error.',
              err instanceof Error ? err : undefined,
            );
      await this._logger.error('dispatch.internal-error', {}, wrappedErr);
      throw wrappedErr;
    } finally {
      this._dispatching = false;
    }
  }
}
