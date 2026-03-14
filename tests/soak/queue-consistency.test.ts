/** Soak test — 50-task sequential dispatch queue consistency (AC5, Story 18.5). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type {
  TaskResult,
  TaskDefinition,
  QueueDispatchPort,
  DispatchLogger,
  TaskExecutor,
} from '../../src/types/index.js';

// Mock state-writer to avoid filesystem I/O from dispatcher
vi.mock('../../src/daemon/state-writer.js', () => ({
  writeCycleStatus: vi.fn().mockResolvedValue(undefined),
  writeDispatchStatus: vi.fn().mockResolvedValue(undefined),
  writeStoppingStatus: vi.fn().mockResolvedValue(undefined),
  writeStoppedStatus: vi.fn().mockResolvedValue(undefined),
  writeErrorStatus: vi.fn().mockResolvedValue(undefined),
  buildLastErrorDetail: vi.fn().mockReturnValue({ code: 'TEST', message: 'test', recoveryCommand: null }),
}));

const TASK_COUNT = 50;

function makeTaskResult(task: TaskDefinition): TaskResult {
  return {
    taskId: task.id,
    status: 'done',
    startedAt: new Date(),
    completedAt: new Date(),
    durationMs: 0,
    stdout: '',
    stderr: '',
    exitCode: 0,
    error: null,
    errorCode: null,
  };
}

describe('queue-consistency', () => {
  let tmpDataDir: string;

  beforeEach(async () => {
    tmpDataDir = join(tmpdir(), `soak-queue-${randomBytes(6).toString('hex')}`);
    await mkdir(tmpDataDir, { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(tmpDataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('50 tasks dispatch in order with no duplicates and correct priority normalization', async () => {
    const { QueueStore } = await import('../../src/queue/queue-store.js');
    const { QueueManager } = await import('../../src/queue/queue-manager.js');
    const { Dispatcher } = await import('../../src/daemon/dispatcher.js');

    const store = new QueueStore(tmpDataDir);
    const manager = new QueueManager(store);

    // Seed queue with 50 tasks via QueueManager.add
    const taskIds: string[] = [];
    for (let i = 0; i < TASK_COUNT; i++) {
      const result = await manager.add({
        type: 'custom',
        name: `task-${i + 1}`,
        prompt: `Do task ${i + 1}`,
        targetPath: '/tmp/repo',
        timeoutMs: 30000,
      });
      taskIds.push(result.task.id);
    }

    // Verify all 50 tasks are in the queue with contiguous priorities
    const preDispatchTasks = await manager.list();
    expect(preDispatchTasks.length).toBe(TASK_COUNT);
    for (let i = 0; i < TASK_COUNT; i++) {
      expect(preDispatchTasks[i]!.priority).toBe(i + 1);
    }

    // Verify no duplicate IDs
    const uniqueIds = new Set(preDispatchTasks.map((t) => t.id));
    expect(uniqueIds.size).toBe(TASK_COUNT);

    // Capture queue state snapshots after each setTaskStatus('done') call to
    // assert AC5: priorities of remaining pending tasks are contiguous after each removal.
    const prioritySnapshotsAfterDone: number[][] = [];
    const originalSetTaskStatus = manager.setTaskStatus.bind(manager);
    vi.spyOn(manager, 'setTaskStatus').mockImplementation(
      async (taskId: string, status: Parameters<QueueDispatchPort['setTaskStatus']>[1]) => {
        await originalSetTaskStatus(taskId, status);
        if (status === 'done') {
          const remaining = await manager.list();
          const pendingPriorities = remaining
            .filter((t) => t.status === 'pending')
            .map((t) => t.priority);
          prioritySnapshotsAfterDone.push(pendingPriorities);
        }
      },
    );

    // Track execution order
    const executedTaskIds: string[] = [];

    // Create mocked executor that returns 'done' for each task
    const mockTaskExecutor: TaskExecutor = {
      execute: vi.fn().mockImplementation(async (task: TaskDefinition) => {
        executedTaskIds.push(task.id);
        return makeTaskResult(task);
      }),
    };

    const mockLogger: DispatchLogger = {
      info: vi.fn().mockResolvedValue(undefined),
      warn: vi.fn().mockResolvedValue(undefined),
      error: vi.fn().mockResolvedValue(undefined),
      debug: vi.fn().mockResolvedValue(undefined),
    };

    const dispatcher = new Dispatcher({
      queueManager: manager as QueueDispatchPort,
      taskExecutor: mockTaskExecutor,
      logger: mockLogger,
    });

    // Single dispatch() call drains all 50 tasks
    const result = await dispatcher.dispatch();

    expect(result.tasksAttempted).toBe(TASK_COUNT);
    expect(result.tasksSucceeded).toBe(TASK_COUNT);
    expect(result.tasksFailed).toBe(0);
    expect(result.stoppedByQuota).toBe(false);

    // All tasks were executed
    expect(executedTaskIds.length).toBe(TASK_COUNT);

    // Tasks were executed in priority order (same order as added)
    expect(executedTaskIds).toEqual(taskIds);

    // AC5: Verify per-removal priority contiguity — after each task marked done,
    // the remaining pending tasks must have contiguous ascending priorities with no gaps.
    // Note: setTaskStatus does not renumber priorities; remaining tasks retain their
    // original consecutive priority values (e.g. 2,3,4,... after task-1 completes).
    expect(prioritySnapshotsAfterDone.length).toBe(TASK_COUNT);
    for (let i = 0; i < prioritySnapshotsAfterDone.length; i++) {
      const snapshot = prioritySnapshotsAfterDone[i]!;
      const expectedCount = TASK_COUNT - (i + 1);
      expect(snapshot.length).toBe(expectedCount);
      // Priorities are contiguous ascending integers with step 1 (no gaps or duplicates)
      for (let j = 1; j < snapshot.length; j++) {
        expect(snapshot[j]).toBe(snapshot[j - 1]! + 1);
      }
    }

    // After dispatch, read the raw queue file to verify state
    const rawQueue = JSON.parse(await readFile(store.filePath, 'utf-8')) as {
      tasks: Array<{ id: string; status: string; priority: number }>;
    };

    // All tasks should be in 'done' status (history-capped to 50 which is exactly HISTORY_CAP)
    const doneTasks = rawQueue.tasks.filter((t) => t.status === 'done');
    const pendingTasks = rawQueue.tasks.filter((t) => t.status === 'pending');
    expect(pendingTasks.length).toBe(0);
    expect(doneTasks.length).toBe(TASK_COUNT);

    // Verify no duplicate IDs in the final queue state
    const finalIds = new Set(rawQueue.tasks.map((t) => t.id));
    expect(finalIds.size).toBe(rawQueue.tasks.length);
  });
});
