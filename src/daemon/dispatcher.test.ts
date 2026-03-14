/** Unit tests for Dispatcher sequential dispatch behavior, result contract, callbacks, and guardrails. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DispatchLogger,
  QueueDispatchPort,
  TaskDefinition,
  TaskExecutor,
  TaskResult,
  TaskStatus,
} from '../types/index.js';
import { ScrowError, ErrorCode } from '../errors/index.js';
import { Dispatcher } from './dispatcher.js';

const DISPATCH_META = {
  provider: 'claude-code',
  source: 'executor',
  confidence: 'high',
};

function makeTask(
  id: string,
  priority: number,
  overrides: Partial<TaskDefinition> = {},
): TaskDefinition {
  return {
    id,
    name: `task-${id}`,
    type: 'custom',
    status: 'pending',
    prompt: `secret-prompt-${id}`,
    targetPath: '/repo',
    priority,
    createdAt: new Date('2026-02-25T00:00:00.000Z'),
    timeoutMs: 60 * 60 * 1000,
    actions: [],
    ...overrides,
  };
}

function makeResult(task: TaskDefinition, status: TaskStatus, durationMs = 10): TaskResult {
  const startedAt = new Date();
  const completedAt = new Date(startedAt.getTime() + durationMs);
  return {
    taskId: task.id,
    status,
    startedAt,
    completedAt,
    durationMs,
    stdout: '',
    stderr: '',
    exitCode: status === 'done' ? 0 : 1,
    error: status === 'done' ? null : `Task ${task.id} failed`,
    errorCode: status === 'done' ? null : 'TASK_EXECUTION_FAILED',
  };
}

function createQueueManager(initialTasks: TaskDefinition[]): {
  queueManager: QueueDispatchPort;
  statusOf: (taskId: string) => TaskStatus;
} {
  const statusById = new Map<string, TaskStatus>(
    initialTasks.map((task) => [task.id, task.status ?? 'pending']),
  );
  const taskById = new Map<string, TaskDefinition>(initialTasks.map((task) => [task.id, task]));

  const queueManager: QueueDispatchPort = {
    listDispatchable: vi.fn(async () =>
      initialTasks
        .map((task) => ({
          ...task,
          status: statusById.get(task.id) ?? 'pending',
        }))
        .filter((task) => task.status === 'pending' || task.status === 'failed_quota')
        .sort((a, b) => a.priority - b.priority),
    ),
    setTaskStatus: vi.fn(async (taskId: string, status: TaskStatus) => {
      if (!taskById.has(taskId)) {
        throw new Error(`Unknown task: ${taskId}`);
      }
      statusById.set(taskId, status);
    }),
  };

  return {
    queueManager,
    statusOf: (taskId: string) => statusById.get(taskId) ?? 'pending',
  };
}

function createLogger(): DispatchLogger {
  return {
    info: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
  };
}

describe('Dispatcher', () => {
  let logger: DispatchLogger;

  beforeEach(() => {
    logger = createLogger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('executes dispatchable tasks sequentially in priority order', async () => {
    const t1 = makeTask('a', 2);
    const t2 = makeTask('b', 1);
    const t3 = makeTask('c', 3);
    const { queueManager, statusOf } = createQueueManager([t1, t2, t3]);

    const callOrder: string[] = [];
    const taskExecutor: TaskExecutor = {
      execute: vi.fn(async (task) => {
        callOrder.push(task.id);
        return makeResult(task, 'done');
      }),
    };

    const dispatcher = new Dispatcher({ queueManager, taskExecutor, logger });
    const result = await dispatcher.dispatch();

    expect(callOrder).toEqual(['b', 'a', 'c']);
    expect(result.tasksAttempted).toBe(3);
    expect(result.tasksSucceeded).toBe(3);
    expect(result.tasksFailed).toBe(0);
    expect(result.stoppedByQuota).toBe(false);
    expect(statusOf('a')).toBe('done');
    expect(statusOf('b')).toBe('done');
    expect(statusOf('c')).toBe('done');
  });

  it('continues processing after non-quota task failure', async () => {
    const t1 = makeTask('a', 1);
    const t2 = makeTask('b', 2);
    const t3 = makeTask('c', 3);
    const { queueManager, statusOf } = createQueueManager([t1, t2, t3]);

    const taskExecutor: TaskExecutor = {
      execute: vi.fn(async (task) => {
        if (task.id === 'b') {
          return makeResult(task, 'failed');
        }
        return makeResult(task, 'done');
      }),
    };

    const dispatcher = new Dispatcher({ queueManager, taskExecutor, logger });
    const result = await dispatcher.dispatch();

    expect(result.tasksAttempted).toBe(3);
    expect(result.tasksSucceeded).toBe(2);
    expect(result.tasksFailed).toBe(1);
    expect(result.stoppedByQuota).toBe(false);
    expect(statusOf('a')).toBe('done');
    expect(statusOf('b')).toBe('failed');
    expect(statusOf('c')).toBe('done');
  });

  it('stops immediately on failed_quota and leaves remaining tasks pending', async () => {
    const t1 = makeTask('a', 1);
    const t2 = makeTask('b', 2);
    const t3 = makeTask('c', 3);
    const { queueManager, statusOf } = createQueueManager([t1, t2, t3]);

    const taskExecutor: TaskExecutor = {
      execute: vi.fn(async (task) => {
        if (task.id === 'b') {
          return makeResult(task, 'failed_quota');
        }
        return makeResult(task, 'done');
      }),
    };

    const dispatcher = new Dispatcher({ queueManager, taskExecutor, logger });
    const result = await dispatcher.dispatch();

    expect(result.tasksAttempted).toBe(2);
    expect(result.tasksSucceeded).toBe(1);
    expect(result.tasksFailed).toBe(0);
    expect(result.stoppedByQuota).toBe(true);
    expect(statusOf('a')).toBe('done');
    expect(statusOf('b')).toBe('failed_quota');
    expect(statusOf('c')).toBe('pending');
  });

  it('returns zero-count result and logs queue-empty when no task is dispatchable', async () => {
    const { queueManager } = createQueueManager([]);
    const taskExecutor: TaskExecutor = {
      execute: vi.fn(),
    };
    const dispatcher = new Dispatcher({ queueManager, taskExecutor, logger });

    const result = await dispatcher.dispatch();

    expect(result.tasksAttempted).toBe(0);
    expect(result.tasksSucceeded).toBe(0);
    expect(result.tasksFailed).toBe(0);
    expect(result.stoppedByQuota).toBe(false);
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith('dispatch.queue-empty', {});
  });

  it('prevents concurrent dispatch cycles with the re-dispatch guard', async () => {
    let releaseFirstDispatch: (() => void) | undefined;
    const firstDispatchDone = new Promise<void>((resolve) => {
      releaseFirstDispatch = () => resolve();
    });

    const t1 = makeTask('a', 1);
    const { queueManager } = createQueueManager([t1]);
    const taskExecutor: TaskExecutor = {
      execute: vi.fn(async (task) => {
        await firstDispatchDone;
        return makeResult(task, 'done');
      }),
    };

    const dispatcher = new Dispatcher({ queueManager, taskExecutor, logger });
    const runningDispatch = dispatcher.dispatch();
    const secondResultPromise = dispatcher.dispatch();

    const secondResult = await secondResultPromise;
    expect(secondResult).toEqual({
      tasksAttempted: 0,
      tasksSucceeded: 0,
      tasksFailed: 0,
      stoppedByQuota: false,
      startedAt: secondResult.startedAt,
      completedAt: secondResult.completedAt,
      durationMs: 0,
    });
    expect(secondResult.startedAt).toBe(secondResult.completedAt);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      'dispatch.already-running',
      expect.objectContaining({ at: expect.any(String) }),
    );

    if (!releaseFirstDispatch) {
      throw new Error('Expected deferred resolver to be initialized');
    }
    releaseFirstDispatch();
    await runningDispatch;
  });

  it('stops between tasks when AbortSignal is aborted', async () => {
    const controller = new AbortController();
    const t1 = makeTask('a', 1);
    const t2 = makeTask('b', 2);
    const { queueManager } = createQueueManager([t1, t2]);

    const taskExecutor: TaskExecutor = {
      execute: vi.fn(async (task, options) => {
        expect(options?.signal).toBe(controller.signal);
        controller.abort();
        return makeResult(task, 'done');
      }),
    };

    const dispatcher = new Dispatcher({ queueManager, taskExecutor, logger });
    const result = await dispatcher.dispatch({ signal: controller.signal });

    expect(result.tasksAttempted).toBe(1);
    expect(result.tasksSucceeded).toBe(1);
    expect(result.tasksFailed).toBe(0);
    expect(result.stoppedByQuota).toBe(false);
    expect(vi.mocked(taskExecutor.execute)).toHaveBeenCalledTimes(1);
  });

  it('emits expected audit log events with dispatch meta for success, failure, and quota', async () => {
    const t1 = makeTask('a', 1);
    const t2 = makeTask('b', 2);
    const t3 = makeTask('c', 3);
    const { queueManager } = createQueueManager([t1, t2, t3]);

    const taskExecutor: TaskExecutor = {
      execute: vi.fn(async (task) => {
        if (task.id === 'a') return makeResult(task, 'done');
        if (task.id === 'b') return makeResult(task, 'failed');
        return makeResult(task, 'failed_quota');
      }),
    };

    const dispatcher = new Dispatcher({ queueManager, taskExecutor, logger });
    await dispatcher.dispatch();

    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      'task.completed',
      expect.objectContaining({
        taskId: 'a',
        taskName: 'task-a',
        outcome: 'done',
      }),
      DISPATCH_META,
    );
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      'task.failed',
      expect.objectContaining({
        taskId: 'b',
        taskName: 'task-b',
        outcome: 'failed',
      }),
      expect.objectContaining(DISPATCH_META),
    );
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      'dispatch.quota-exhausted',
      expect.objectContaining({
        taskId: 'c',
        taskName: 'task-c',
        outcome: 'failed_quota',
      }),
      DISPATCH_META,
    );
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      'task.requeued',
      expect.objectContaining({
        taskId: 'c',
        taskName: 'task-c',
        outcome: 'failed_quota',
        reason: 'quota-exhausted',
      }),
      DISPATCH_META,
    );
  });

  it('returns fully populated cycle result with ISO timestamps and consistent duration', async () => {
    const t1 = makeTask('a', 1);
    const { queueManager } = createQueueManager([t1]);
    const taskExecutor: TaskExecutor = {
      execute: vi.fn(async (task) => makeResult(task, 'done', 15)),
    };

    const dispatcher = new Dispatcher({ queueManager, taskExecutor, logger });
    const result = await dispatcher.dispatch();

    expect(result).toEqual({
      tasksAttempted: 1,
      tasksSucceeded: 1,
      tasksFailed: 0,
      stoppedByQuota: false,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      durationMs: result.durationMs,
    });
    expect(Number.isNaN(Date.parse(result.startedAt))).toBe(false);
    expect(Number.isNaN(Date.parse(result.completedAt))).toBe(false);

    const elapsed = Date.parse(result.completedAt) - Date.parse(result.startedAt);
    expect(Math.abs(result.durationMs - elapsed)).toBeLessThanOrEqual(25);
  });

  it('never includes TaskDefinition.prompt in logger data fields', async () => {
    const t1 = makeTask('a', 1, { prompt: 'ULTRA_SECRET_PROMPT_A' });
    const t2 = makeTask('b', 2, { prompt: 'ULTRA_SECRET_PROMPT_B' });
    const { queueManager } = createQueueManager([t1, t2]);
    const taskExecutor: TaskExecutor = {
      execute: vi.fn(async (task) => makeResult(task, 'done')),
    };

    const dispatcher = new Dispatcher({ queueManager, taskExecutor, logger });
    await dispatcher.dispatch();

    const prompts = [t1.prompt, t2.prompt];
    const allCalls = [...vi.mocked(logger.info).mock.calls, ...vi.mocked(logger.warn).mock.calls];
    for (const [, data] of allCalls) {
      const serialized = JSON.stringify(data ?? {});
      for (const prompt of prompts) {
        expect(serialized.includes(prompt)).toBe(false);
      }
    }
  });

  it('throws ScrowError(CONFIG_INVALID) when required constructor deps are missing', () => {
    const taskExecutor: TaskExecutor = {
      execute: vi.fn(),
    };
    const queueManager = createQueueManager([]).queueManager;

    expect(
      () =>
        new Dispatcher({ taskExecutor } as unknown as ConstructorParameters<typeof Dispatcher>[0]),
    ).toThrowError(ScrowError);
    expect(
      () =>
        new Dispatcher({ taskExecutor } as unknown as ConstructorParameters<typeof Dispatcher>[0]),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.CONFIG_INVALID }));

    expect(
      () =>
        new Dispatcher({ queueManager } as unknown as ConstructorParameters<typeof Dispatcher>[0]),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.CONFIG_INVALID }));
  });

  it('handles mixed scenario: failure then quota stop with correct per-task statuses and counts', async () => {
    const tasks = [
      makeTask('1', 1),
      makeTask('2', 2),
      makeTask('3', 3),
      makeTask('4', 4),
      makeTask('5', 5),
    ];
    const { queueManager, statusOf } = createQueueManager(tasks);

    const taskExecutor: TaskExecutor = {
      execute: vi.fn(async (task) => {
        if (task.id === '2') return makeResult(task, 'failed');
        if (task.id === '4') return makeResult(task, 'failed_quota');
        return makeResult(task, 'done');
      }),
    };

    const dispatcher = new Dispatcher({ queueManager, taskExecutor, logger });
    const result = await dispatcher.dispatch();

    expect(result.tasksAttempted).toBe(4);
    expect(result.tasksSucceeded).toBe(2);
    expect(result.tasksFailed).toBe(1);
    expect(result.stoppedByQuota).toBe(true);
    expect(statusOf('1')).toBe('done');
    expect(statusOf('2')).toBe('failed');
    expect(statusOf('3')).toBe('done');
    expect(statusOf('4')).toBe('failed_quota');
    expect(statusOf('5')).toBe('pending');
  });

  it('stops by quota when the first task fails with failed_quota', async () => {
    const t1 = makeTask('a', 1);
    const t2 = makeTask('b', 2);
    const { queueManager } = createQueueManager([t1, t2]);

    const taskExecutor: TaskExecutor = {
      execute: vi.fn(async (task) =>
        task.id === 'a' ? makeResult(task, 'failed_quota') : makeResult(task, 'done'),
      ),
    };

    const dispatcher = new Dispatcher({ queueManager, taskExecutor, logger });
    const result = await dispatcher.dispatch();

    expect(result.tasksAttempted).toBe(1);
    expect(result.tasksSucceeded).toBe(0);
    expect(result.tasksFailed).toBe(0);
    expect(result.stoppedByQuota).toBe(true);
  });

  it('stops by quota on the last task after prior successes', async () => {
    const t1 = makeTask('a', 1);
    const t2 = makeTask('b', 2);
    const t3 = makeTask('c', 3);
    const { queueManager } = createQueueManager([t1, t2, t3]);

    const taskExecutor: TaskExecutor = {
      execute: vi.fn(async (task) =>
        task.id === 'c' ? makeResult(task, 'failed_quota') : makeResult(task, 'done'),
      ),
    };

    const dispatcher = new Dispatcher({ queueManager, taskExecutor, logger });
    const result = await dispatcher.dispatch();

    expect(result.tasksAttempted).toBe(3);
    expect(result.tasksSucceeded).toBe(2);
    expect(result.tasksFailed).toBe(0);
    expect(result.stoppedByQuota).toBe(true);
  });

  it('treats executor throw as task failure and continues to next task', async () => {
    const t1 = makeTask('a', 1);
    const t2 = makeTask('b', 2);
    const t3 = makeTask('c', 3);
    const { queueManager, statusOf } = createQueueManager([t1, t2, t3]);

    const taskExecutor: TaskExecutor = {
      execute: vi.fn(async (task) => {
        if (task.id === 'b') {
          throw new Error('executor exploded');
        }
        return makeResult(task, 'done');
      }),
    };

    const dispatcher = new Dispatcher({ queueManager, taskExecutor, logger });
    const result = await dispatcher.dispatch();

    expect(result.tasksAttempted).toBe(3);
    expect(result.tasksSucceeded).toBe(2);
    expect(result.tasksFailed).toBe(1);
    expect(result.stoppedByQuota).toBe(false);
    expect(statusOf('a')).toBe('done');
    expect(statusOf('b')).toBe('failed');
    expect(statusOf('c')).toBe('done');
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      'task.failed',
      expect.objectContaining({ taskId: 'b' }),
      expect.objectContaining(DISPATCH_META),
    );
  });

  it('treats unexpected executor status as task failure and continues', async () => {
    const t1 = makeTask('a', 1);
    const t2 = makeTask('b', 2);
    const { queueManager, statusOf } = createQueueManager([t1, t2]);

    const taskExecutor: TaskExecutor = {
      execute: vi.fn(async (task) => {
        if (task.id === 'a') {
          return makeResult(task, 'in-progress' as TaskStatus);
        }
        return makeResult(task, 'done');
      }),
    };

    const dispatcher = new Dispatcher({ queueManager, taskExecutor, logger });
    const result = await dispatcher.dispatch();

    expect(result.tasksAttempted).toBe(2);
    expect(result.tasksSucceeded).toBe(1);
    expect(result.tasksFailed).toBe(1);
    expect(result.stoppedByQuota).toBe(false);
    expect(statusOf('a')).toBe('failed');
    expect(statusOf('b')).toBe('done');
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      'task.failed',
      expect.objectContaining({ taskId: 'a', outcome: 'in-progress' }),
      expect.objectContaining(DISPATCH_META),
    );
  });

  it('persists executor throw error message in audit record top-level error field', async () => {
    const t1 = makeTask('a', 1);
    const { queueManager } = createQueueManager([t1]);

    const taskExecutor: TaskExecutor = {
      execute: vi.fn(async () => {
        throw new ScrowError(ErrorCode.CLAUDE_NOT_FOUND, 'Claude binary not found');
      }),
    };

    const dispatcher = new Dispatcher({ queueManager, taskExecutor, logger });
    await dispatcher.dispatch();

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      'task.failed',
      expect.objectContaining({ taskId: 'a' }),
      expect.objectContaining({
        ...DISPATCH_META,
        error: 'Claude binary not found',
      }),
    );
  });

  it('persists error message in audit meta when executor returns failed status', async () => {
    const t1 = makeTask('a', 1);
    const { queueManager } = createQueueManager([t1]);

    const taskExecutor: TaskExecutor = {
      execute: vi.fn(async (task) => makeResult(task, 'failed')),
    };

    const dispatcher = new Dispatcher({ queueManager, taskExecutor, logger });
    await dispatcher.dispatch();

    // makeResult sets error to 'Task a failed' for non-done statuses
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      'task.failed',
      expect.objectContaining({ taskId: 'a', outcome: 'failed' }),
      expect.objectContaining({
        ...DISPATCH_META,
        error: 'Task a failed',
      }),
    );
  });

  it('wraps unexpected listDispatchable error in ScrowError and re-throws', async () => {
    const { queueManager } = createQueueManager([]);
    vi.mocked(queueManager.listDispatchable).mockRejectedValueOnce(
      new Error('storage unavailable'),
    );
    const taskExecutor: TaskExecutor = { execute: vi.fn() };

    const dispatcher = new Dispatcher({ queueManager, taskExecutor, logger });

    await expect(dispatcher.dispatch()).rejects.toMatchObject({
      code: ErrorCode.TASK_EXECUTION_FAILED,
    });
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      'dispatch.internal-error',
      {},
      expect.any(Object),
    );
  });

  // Story 7.17: onTaskStart / onTaskComplete callback tests (AC7)

  it('invokes onTaskStart callback with the task before execution', async () => {
    const t1 = makeTask('a', 1, { type: 'template', templateName: 'security-audit' });
    const t2 = makeTask('b', 2);
    const { queueManager } = createQueueManager([t1, t2]);

    const startedTasks: TaskDefinition[] = [];
    const onTaskStart = vi.fn(async (task: TaskDefinition) => {
      startedTasks.push(task);
    });
    const onTaskComplete = vi.fn().mockResolvedValue(undefined);

    const taskExecutor: TaskExecutor = {
      execute: vi.fn(async (task) => makeResult(task, 'done')),
    };

    const dispatcher = new Dispatcher({ queueManager, taskExecutor, logger });
    await dispatcher.dispatch({ onTaskStart, onTaskComplete });

    expect(onTaskStart).toHaveBeenCalledTimes(2);
    expect(startedTasks[0]!.id).toBe('a');
    expect(startedTasks[0]!.name).toBe('task-a');
    expect(startedTasks[0]!.type).toBe('template');
    expect(startedTasks[1]!.id).toBe('b');
  });

  it('invokes onTaskComplete callback with task and result after execution', async () => {
    const t1 = makeTask('a', 1);
    const t2 = makeTask('b', 2);
    const { queueManager } = createQueueManager([t1, t2]);

    const completedCalls: Array<{ task: TaskDefinition; result: TaskResult }> = [];
    const onTaskStart = vi.fn().mockResolvedValue(undefined);
    const onTaskComplete = vi.fn(async (task: TaskDefinition, result: TaskResult) => {
      completedCalls.push({ task, result });
    });

    const taskExecutor: TaskExecutor = {
      execute: vi.fn(async (task) => {
        if (task.id === 'a') return makeResult(task, 'done');
        return makeResult(task, 'failed');
      }),
    };

    const dispatcher = new Dispatcher({ queueManager, taskExecutor, logger });
    await dispatcher.dispatch({ onTaskStart, onTaskComplete });

    expect(onTaskComplete).toHaveBeenCalledTimes(2);
    expect(completedCalls[0]!.task.id).toBe('a');
    expect(completedCalls[0]!.result.status).toBe('done');
    expect(completedCalls[1]!.task.id).toBe('b');
    expect(completedCalls[1]!.result.status).toBe('failed');
  });

  it('invokes onTaskComplete for executor throws with a failed TaskResult', async () => {
    const t1 = makeTask('a', 1);
    const { queueManager } = createQueueManager([t1]);

    const completedCalls: Array<{ task: TaskDefinition; result: TaskResult }> = [];
    const onTaskComplete = vi.fn(async (task: TaskDefinition, result: TaskResult) => {
      completedCalls.push({ task, result });
    });

    const taskExecutor: TaskExecutor = {
      execute: vi.fn(async () => {
        throw new Error('executor boom');
      }),
    };

    const dispatcher = new Dispatcher({ queueManager, taskExecutor, logger });
    await dispatcher.dispatch({ onTaskComplete });

    expect(onTaskComplete).toHaveBeenCalledTimes(1);
    expect(completedCalls[0]!.result.status).toBe('failed');
    expect(completedCalls[0]!.result.error).toBe('executor boom');
  });

  it('invokes onTaskComplete for unexpected executor status', async () => {
    const t1 = makeTask('a', 1);
    const { queueManager } = createQueueManager([t1]);

    const onTaskComplete = vi.fn().mockResolvedValue(undefined);
    const taskExecutor: TaskExecutor = {
      execute: vi.fn(async (task) => makeResult(task, 'in-progress' as TaskStatus)),
    };

    const dispatcher = new Dispatcher({ queueManager, taskExecutor, logger });
    await dispatcher.dispatch({ onTaskComplete });

    expect(onTaskComplete).toHaveBeenCalledTimes(1);
    expect(onTaskComplete.mock.calls[0]![1].status).toBe('in-progress');
  });

  it('invokes onTaskComplete for failed_quota tasks before breaking', async () => {
    const t1 = makeTask('a', 1);
    const t2 = makeTask('b', 2);
    const { queueManager } = createQueueManager([t1, t2]);

    const onTaskStart = vi.fn().mockResolvedValue(undefined);
    const onTaskComplete = vi.fn().mockResolvedValue(undefined);

    const taskExecutor: TaskExecutor = {
      execute: vi.fn(async (task) => {
        if (task.id === 'a') return makeResult(task, 'failed_quota');
        return makeResult(task, 'done');
      }),
    };

    const dispatcher = new Dispatcher({ queueManager, taskExecutor, logger });
    const result = await dispatcher.dispatch({ onTaskStart, onTaskComplete });

    // Only task 'a' should have been started and completed (quota stop)
    expect(onTaskStart).toHaveBeenCalledTimes(1);
    expect(onTaskComplete).toHaveBeenCalledTimes(1);
    expect(result.stoppedByQuota).toBe(true);
  });

  it('continues dispatch when onTaskStart callback throws', async () => {
    const t1 = makeTask('a', 1);
    const t2 = makeTask('b', 2);
    const { queueManager, statusOf } = createQueueManager([t1, t2]);

    const onTaskStart = vi.fn(async (task: TaskDefinition) => {
      if (task.id === 'a') throw new Error('start callback failed');
    });
    const onTaskComplete = vi.fn().mockResolvedValue(undefined);

    const taskExecutor: TaskExecutor = {
      execute: vi.fn(async (task) => makeResult(task, 'done')),
    };

    const dispatcher = new Dispatcher({ queueManager, taskExecutor, logger });
    const result = await dispatcher.dispatch({ onTaskStart, onTaskComplete });

    // Dispatch should continue despite callback failure
    expect(result.tasksAttempted).toBe(2);
    expect(result.tasksSucceeded).toBe(2);
    expect(statusOf('a')).toBe('done');
    expect(statusOf('b')).toBe('done');

    // Callback error should be logged
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      'dispatch.callback-failed',
      expect.objectContaining({ callback: 'onTaskStart', taskId: 'a' }),
      expect.any(Error),
    );
  });

  it('continues dispatch when onTaskComplete callback throws', async () => {
    const t1 = makeTask('a', 1);
    const t2 = makeTask('b', 2);
    const { queueManager, statusOf } = createQueueManager([t1, t2]);

    const onTaskStart = vi.fn().mockResolvedValue(undefined);
    const onTaskComplete = vi.fn(async (task: TaskDefinition) => {
      if (task.id === 'a') throw new Error('complete callback failed');
    });

    const taskExecutor: TaskExecutor = {
      execute: vi.fn(async (task) => makeResult(task, 'done')),
    };

    const dispatcher = new Dispatcher({ queueManager, taskExecutor, logger });
    const result = await dispatcher.dispatch({ onTaskStart, onTaskComplete });

    // Dispatch should continue despite callback failure
    expect(result.tasksAttempted).toBe(2);
    expect(result.tasksSucceeded).toBe(2);
    expect(statusOf('a')).toBe('done');
    expect(statusOf('b')).toBe('done');

    // Callback error should be logged
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      'dispatch.callback-failed',
      expect.objectContaining({ callback: 'onTaskComplete', taskId: 'a' }),
      expect.any(Error),
    );
  });

  it('does not invoke callbacks when no options are provided', async () => {
    const t1 = makeTask('a', 1);
    const { queueManager } = createQueueManager([t1]);

    const taskExecutor: TaskExecutor = {
      execute: vi.fn(async (task) => makeResult(task, 'done')),
    };

    const dispatcher = new Dispatcher({ queueManager, taskExecutor, logger });
    // No options = no callbacks — should not throw
    const result = await dispatcher.dispatch();

    expect(result.tasksSucceeded).toBe(1);
  });
});

describe('Dispatcher in-progress transition (Story 10.9)', () => {
  let logger: DispatchLogger;

  beforeEach(() => {
    logger = createLogger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls setTaskStatus with in-progress before execute()', async () => {
    const t1 = makeTask('a', 1);
    const callOrder: string[] = [];

    const queueManager: QueueDispatchPort = {
      listDispatchable: vi.fn(async () => [t1]),
      setTaskStatus: vi.fn(async (_taskId: string, status: TaskStatus) => {
        callOrder.push(`setTaskStatus:${status}`);
      }),
    };

    const taskExecutor: TaskExecutor = {
      execute: vi.fn(async (task) => {
        callOrder.push('execute');
        return makeResult(task, 'done');
      }),
    };

    const dispatcher = new Dispatcher({ queueManager, taskExecutor, logger });
    await dispatcher.dispatch();

    // Verify in-progress is set before execute, and done is set after
    expect(callOrder).toEqual(['setTaskStatus:in-progress', 'execute', 'setTaskStatus:done']);
  });

  it('transitions through pending -> in-progress -> done on success', async () => {
    const t1 = makeTask('a', 1);
    const { queueManager, statusOf } = createQueueManager([t1]);

    const taskExecutor: TaskExecutor = {
      execute: vi.fn(async (task) => {
        // During execution, the task should be in-progress
        expect(statusOf(task.id)).toBe('in-progress');
        return makeResult(task, 'done');
      }),
    };

    const dispatcher = new Dispatcher({ queueManager, taskExecutor, logger });
    await dispatcher.dispatch();

    // After execution, should be done
    expect(statusOf('a')).toBe('done');
  });

  it('transitions through pending -> in-progress -> failed on failure', async () => {
    const t1 = makeTask('a', 1);
    const { queueManager, statusOf } = createQueueManager([t1]);

    const taskExecutor: TaskExecutor = {
      execute: vi.fn(async (task) => {
        expect(statusOf(task.id)).toBe('in-progress');
        return makeResult(task, 'failed');
      }),
    };

    const dispatcher = new Dispatcher({ queueManager, taskExecutor, logger });
    await dispatcher.dispatch();

    expect(statusOf('a')).toBe('failed');
  });

  it('transitions through pending -> in-progress -> failed on executor throw', async () => {
    const t1 = makeTask('a', 1);
    const { queueManager, statusOf } = createQueueManager([t1]);

    const taskExecutor: TaskExecutor = {
      execute: vi.fn(async (task) => {
        expect(statusOf(task.id)).toBe('in-progress');
        throw new Error('executor crashed');
      }),
    };

    const dispatcher = new Dispatcher({ queueManager, taskExecutor, logger });
    await dispatcher.dispatch();

    expect(statusOf('a')).toBe('failed');
  });

  it('transitions through pending -> in-progress -> failed_quota on quota exhaustion', async () => {
    const t1 = makeTask('a', 1);
    const { queueManager, statusOf } = createQueueManager([t1]);

    const taskExecutor: TaskExecutor = {
      execute: vi.fn(async (task) => {
        expect(statusOf(task.id)).toBe('in-progress');
        return makeResult(task, 'failed_quota');
      }),
    };

    const dispatcher = new Dispatcher({ queueManager, taskExecutor, logger });
    await dispatcher.dispatch();

    expect(statusOf('a')).toBe('failed_quota');
  });
});

describe('Dispatcher.replaceExecutor (Story 10.4)', () => {
  let logger: DispatchLogger;

  beforeEach(() => {
    logger = {
      info: vi.fn(async () => {}),
      warn: vi.fn(async () => {}),
      error: vi.fn(async () => {}),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('replaces the executor and subsequent dispatch uses the new one (6.4)', async () => {
    const t1 = makeTask('a', 1);
    const { queueManager } = createQueueManager([t1]);

    const oldExecutor: TaskExecutor = {
      execute: vi.fn(async (task) => makeResult(task, 'failed')),
    };
    const newExecutor: TaskExecutor = {
      execute: vi.fn(async (task) => makeResult(task, 'done')),
    };

    const dispatcher = new Dispatcher({ queueManager, taskExecutor: oldExecutor, logger });

    // Replace executor before dispatch
    dispatcher.replaceExecutor(newExecutor);

    const result = await dispatcher.dispatch();
    expect(result.tasksSucceeded).toBe(1);
    expect(result.tasksFailed).toBe(0);
    expect(oldExecutor.execute).not.toHaveBeenCalled();
    expect(newExecutor.execute).toHaveBeenCalledTimes(1);
  });

  it('throws when called during an active dispatch cycle (AC2, 6.6)', async () => {
    // Create a task whose execution will try to replace the executor mid-dispatch.
    const t1 = makeTask('a', 1);
    const { queueManager } = createQueueManager([t1]);

    let replaceError: Error | null = null;
    const slowExecutor: TaskExecutor = {
      execute: vi.fn(async (task) => {
        // Attempt to replace executor while dispatch is in progress
        try {
          dispatcher.replaceExecutor({
            execute: vi.fn(async (t) => makeResult(t, 'done')),
          });
        } catch (err) {
          replaceError = err as Error;
        }
        return makeResult(task, 'done');
      }),
    };

    const dispatcher = new Dispatcher({
      queueManager,
      taskExecutor: slowExecutor,
      logger,
    });

    await dispatcher.dispatch();

    // replaceExecutor should have thrown because _dispatching was true
    expect(replaceError).not.toBeNull();
    expect(replaceError!.message).toContain(
      'Cannot replace executor while a dispatch cycle is in progress',
    );
  });

  it('throws when called with null executor', () => {
    const { queueManager } = createQueueManager([]);
    const executor: TaskExecutor = {
      execute: vi.fn(async (task) => makeResult(task, 'done')),
    };

    const dispatcher = new Dispatcher({ queueManager, taskExecutor: executor, logger });

    expect(() => dispatcher.replaceExecutor(null as never)).toThrow(
      'Dispatcher.replaceExecutor requires a non-null taskExecutor',
    );
  });

  it('exposes dispatching state via getter', async () => {
    const { queueManager } = createQueueManager([]);
    const executor: TaskExecutor = {
      execute: vi.fn(async (task) => makeResult(task, 'done')),
    };

    const dispatcher = new Dispatcher({ queueManager, taskExecutor: executor, logger });

    expect(dispatcher.dispatching).toBe(false);
  });

  it('AC2: replaceExecutor succeeds when called after dispatch cycle completes (AC2 guarantee, 6.6 improvement)', async () => {
    // This test validates the AC2 guarantee from the runner perspective:
    // the onRestartRequired callback (fire-and-forget from polling-loop.ts) calls
    // replaceExecutor() AFTER the dispatch cycle has completed — not mid-dispatch.
    // We verify that replaceExecutor is only safe when _dispatching is false, which
    // corresponds to the between-cycles timing that runner.ts relies on.
    const t1 = makeTask('a', 1);
    const { queueManager } = createQueueManager([t1]);

    const oldExecutor: TaskExecutor = {
      execute: vi.fn(async (task) => makeResult(task, 'done')),
    };
    const newExecutor: TaskExecutor = {
      execute: vi.fn(async (task) => makeResult(task, 'done')),
    };

    const dispatcher = new Dispatcher({ queueManager, taskExecutor: oldExecutor, logger });

    // Confirm dispatching is false before dispatch starts (pre-condition)
    expect(dispatcher.dispatching).toBe(false);

    // Run dispatch to completion — uses oldExecutor
    await dispatcher.dispatch();

    // Confirm dispatching is false after dispatch completes (post-condition: safe to swap)
    expect(dispatcher.dispatching).toBe(false);

    // replaceExecutor must succeed when called after dispatch cycle completes —
    // this is the AC2 guarantee: the runner's onRestartRequired callback fires
    // between cycles (when _dispatching is false) and can safely swap the executor.
    expect(() => dispatcher.replaceExecutor(newExecutor)).not.toThrow();

    // Subsequent dispatch uses the new executor.
    // Add a new task to queue for the second dispatch cycle.
    const t2 = makeTask('b', 2);
    const { queueManager: qm2 } = createQueueManager([t2]);
    // Create a fresh dispatcher with newExecutor already in place to verify it dispatches correctly.
    const dispatcher2 = new Dispatcher({ queueManager: qm2, taskExecutor: newExecutor, logger });
    const result = await dispatcher2.dispatch();
    expect(result.tasksSucceeded).toBe(1);
    // oldExecutor was only used for the first dispatch (t1); newExecutor is used for t2
    expect(oldExecutor.execute).toHaveBeenCalledTimes(1);
    expect(newExecutor.execute).toHaveBeenCalledTimes(1);
  });

  // ── Story 10.11 AC3b: makeTaskAuditData includes error field ──────────────

  it('task.failed audit data includes error: TASK_OOM_KILLED when result.errorCode is TASK_OOM_KILLED', async () => {
    const t1 = makeTask('oom-1', 1);
    const { queueManager } = createQueueManager([t1]);

    const oomResult: TaskResult = {
      taskId: t1.id,
      status: 'failed',
      startedAt: new Date(),
      completedAt: new Date(),
      durationMs: 22000,
      stdout: '',
      stderr: '',
      exitCode: 137,
      error: 'Container was killed due to insufficient memory',
      errorCode: 'TASK_OOM_KILLED',
    };

    const taskExecutor: TaskExecutor = {
      execute: vi.fn(async () => oomResult),
    };

    const dispatcher = new Dispatcher({ queueManager, taskExecutor, logger });
    await dispatcher.dispatch();

    // Find the task.failed log call
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const taskFailedCall = warnCalls.find((call: unknown[]) => call[0] === 'task.failed');
    expect(taskFailedCall).toBeDefined();
    const auditData = taskFailedCall![1] as Record<string, unknown>;
    // Verify full makeTaskAuditData shape so regressions in any field are caught
    expect(auditData['taskId']).toBe('oom-1');
    expect(auditData['taskName']).toBe('task-oom-1');
    expect(auditData['type']).toBe('custom');
    expect(auditData['templateName']).toBeNull();
    expect(auditData['durationMs']).toBe(22000);
    expect(auditData['outcome']).toBe('failed');
    expect(auditData['exitCode']).toBe(137);
    expect(auditData['error']).toBe('TASK_OOM_KILLED');
  });

  it('task.failed audit data includes error: null when result.errorCode is null', async () => {
    const t1 = makeTask('fail-null-1', 1);
    const { queueManager } = createQueueManager([t1]);

    const failResult: TaskResult = {
      taskId: t1.id,
      status: 'failed',
      startedAt: new Date(),
      completedAt: new Date(),
      durationMs: 5000,
      stdout: '',
      stderr: '',
      exitCode: 1,
      error: 'Process exited with code 1',
      errorCode: null,
    };

    const taskExecutor: TaskExecutor = {
      execute: vi.fn(async () => failResult),
    };

    const dispatcher = new Dispatcher({ queueManager, taskExecutor, logger });
    await dispatcher.dispatch();

    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const taskFailedCall = warnCalls.find((call: unknown[]) => call[0] === 'task.failed');
    expect(taskFailedCall).toBeDefined();
    const auditData = taskFailedCall![1] as Record<string, unknown>;
    // Verify full makeTaskAuditData shape so regressions in any field are caught
    expect(auditData['taskId']).toBe('fail-null-1');
    expect(auditData['taskName']).toBe('task-fail-null-1');
    expect(auditData['type']).toBe('custom');
    expect(auditData['templateName']).toBeNull();
    expect(auditData['durationMs']).toBe(5000);
    expect(auditData['outcome']).toBe('failed');
    expect(auditData['exitCode']).toBe(1);
    expect(auditData['error']).toBeNull();
  });

  it('task.completed audit data includes error: null for successful tasks', async () => {
    const t1 = makeTask('done-1', 1);
    const { queueManager } = createQueueManager([t1]);

    const taskExecutor: TaskExecutor = {
      execute: vi.fn(async (task) => makeResult(task, 'done')),
    };

    const dispatcher = new Dispatcher({ queueManager, taskExecutor, logger });
    await dispatcher.dispatch();

    const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls;
    const taskCompletedCall = infoCalls.find((call: unknown[]) => call[0] === 'task.completed');
    expect(taskCompletedCall).toBeDefined();
    const auditData = taskCompletedCall![1] as Record<string, unknown>;
    // Verify full makeTaskAuditData shape so regressions in any field are caught
    expect(auditData['taskId']).toBe('done-1');
    expect(auditData['taskName']).toBe('task-done-1');
    expect(auditData['type']).toBe('custom');
    expect(auditData['templateName']).toBeNull();
    expect(typeof auditData['durationMs']).toBe('number');
    expect(auditData['outcome']).toBe('done');
    expect(auditData['exitCode']).toBe(0);
    expect(auditData['error']).toBeNull();
  });
});
