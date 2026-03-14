/** Integration tests for end-to-end poll-evaluate-dispatch workflow (Story 4.2). */
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../../src/daemon/index.js';
import { QueueManager, QueueStore } from '../../src/queue/index.js';
import { TriggerEngine } from '../../src/trigger/index.js';
import { EventName } from '../../src/types/index.js';
import type {
  CapacitySnapshot,
  DispatchCycleResult,
  DispatchLogger,
  TaskExecutor,
  TaskResult,
  TriggerCondition,
  TriggerResult,
  UsageMonitor,
} from '../../src/types/index.js';


interface CapturedEvent {
  level: 'info' | 'warn' | 'error';
  event: string;
  data: Record<string, unknown>;
}

function makeTmpDir(): string {
  return join(tmpdir(), `sparecrow-dispatch-cycle-int-${randomBytes(6).toString('hex')}`);
}

function makeSnapshot(utilization: number): CapacitySnapshot {
  const resetsAt = new Date(Date.now() + 10 * 60_000);
  return {
    budgetWindows: [
      {
        id: 'weekly',
        kind: 'budget',
        utilization,
        resetsAt,
        windowDurationHours: 168,
      },
    ],
    rateWindows: [
      {
        id: 'session',
        kind: 'rate',
        utilization,
        resetsAt,
        windowDurationHours: 5,
      },
    ],
    provider: 'claude-code',
    fetchedAt: new Date(),
    source: 'oauth',
    confidence: 'high',
  };
}

function makeTaskResult(
  taskId: string,
  status: 'done' | 'failed' | 'failed_quota',
  durationMs = 25,
): TaskResult {
  const startedAt = new Date();
  const completedAt = new Date(startedAt.getTime() + durationMs);
  return {
    taskId,
    status,
    startedAt,
    completedAt,
    durationMs,
    stdout: '',
    stderr: '',
    exitCode: status === 'done' ? 0 : 1,
    error: status === 'done' ? null : `${status}: task failed`,
    errorCode: status === 'failed_quota' ? 'QUOTA_EXHAUSTED' : status === 'failed' ? 'TASK_EXECUTION_FAILED' : null,
  };
}

function createTestLogger(): { logger: DispatchLogger; events: CapturedEvent[] } {
  const events: CapturedEvent[] = [];

  const logger: DispatchLogger = {
    info: vi.fn(async (event: string, data: Record<string, unknown> = {}) => {
      events.push({ level: 'info', event, data });
    }),
    warn: vi.fn(async (event: string, data: Record<string, unknown> = {}) => {
      events.push({ level: 'warn', event, data });
    }),
    error: vi.fn(async (event: string, data: Record<string, unknown> = {}) => {
      events.push({ level: 'error', event, data });
    }),
  };

  return { logger, events };
}

async function runDispatchCycle(
  usageMonitor: UsageMonitor,
  triggerEngine: TriggerEngine,
  dispatcher: Dispatcher,
  conditions: TriggerCondition,
): Promise<{ decision: TriggerResult; dispatchResult: DispatchCycleResult | null }> {
  const snapshot = await usageMonitor.poll();
  const decision = triggerEngine.evaluate(snapshot, conditions);
  if (!decision.shouldDispatch) {
    return { decision, dispatchResult: null };
  }

  try {
    const dispatchResult = await dispatcher.dispatch();
    return { decision, dispatchResult };
  } finally {
    triggerEngine.resetDispatchState();
  }
}

describe('dispatch-cycle integration', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = makeTmpDir();
    await mkdir(dataDir, { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('runs poll-evaluate-dispatch cycle and updates queue statuses from dispatcher outcomes', async () => {
    const queueStore = new QueueStore(dataDir);
    const queueManager = new QueueManager(queueStore);
    await queueManager.add({
      type: 'custom',
      name: 'task-a',
      prompt: 'prompt-a',
      targetPath: '/repo-a',
    });
    await queueManager.add({
      type: 'custom',
      name: 'task-b',
      prompt: 'prompt-b',
      targetPath: '/repo-b',
    });

    const poll = vi.fn(async () => makeSnapshot(0.4));
    const usageMonitor: UsageMonitor = { poll };

    const execute = vi.fn(async (task) =>
      task.name === 'task-a' ? makeTaskResult(task.id, 'done') : makeTaskResult(task.id, 'failed_quota'),
    );
    const taskExecutor: TaskExecutor = { execute };

    const { logger, events } = createTestLogger();
    const triggerEngine = new TriggerEngine({ logger });
    const dispatcher = new Dispatcher({ queueManager, taskExecutor, logger });
    const conditions: TriggerCondition = {
      maxWastePercentage: 50,
      weeklyReservePercentage: 30,
      idleHours: [],
    };

    const { decision, dispatchResult } = await runDispatchCycle(
      usageMonitor,
      triggerEngine,
      dispatcher,
      conditions,
    );

    expect(poll).toHaveBeenCalledTimes(1);
    expect(decision.shouldDispatch).toBe(true);
    expect(dispatchResult).toMatchObject({
      tasksAttempted: 2,
      tasksSucceeded: 1,
      tasksFailed: 0,
      stoppedByQuota: true,
    });
    expect(execute).toHaveBeenCalledTimes(2);

    const statusByTaskName = new Map(
      (await queueManager.list()).map((task) => [task.name, task.status] as const),
    );
    expect(statusByTaskName.get('task-a')).toBe('done');
    expect(statusByTaskName.get('task-b')).toBe('failed_quota');

    expect(events.some((entry) => entry.event === EventName.TRIGGER_FIRED)).toBe(true);
    expect(events.some((entry) => entry.event === EventName.TASK_COMPLETED)).toBe(true);
    expect(events.some((entry) => entry.event === EventName.DISPATCH_QUOTA_EXHAUSTED)).toBe(true);
    expect(events.some((entry) => entry.event === EventName.TASK_REQUEUED)).toBe(true);
  });

  it('skips dispatcher execution when trigger evaluation does not meet conditions', async () => {
    const queueStore = new QueueStore(dataDir);
    const queueManager = new QueueManager(queueStore);
    await queueManager.add({
      type: 'custom',
      name: 'task-only',
      prompt: 'prompt-only',
      targetPath: '/repo',
    });

    const poll = vi.fn(async () => makeSnapshot(0.95));
    const usageMonitor: UsageMonitor = { poll };

    const execute = vi.fn(async (task) => makeTaskResult(task.id, 'done'));
    const taskExecutor: TaskExecutor = { execute };

    const { logger, events } = createTestLogger();
    const triggerEngine = new TriggerEngine({ logger });
    const dispatcher = new Dispatcher({ queueManager, taskExecutor, logger });
    const conditions: TriggerCondition = {
      maxWastePercentage: 50,
      weeklyReservePercentage: 30,
      idleHours: [],
    };

    const { decision, dispatchResult } = await runDispatchCycle(
      usageMonitor,
      triggerEngine,
      dispatcher,
      conditions,
    );

    expect(poll).toHaveBeenCalledTimes(1);
    expect(decision.shouldDispatch).toBe(false);
    expect(dispatchResult).toBeNull();
    expect(execute).not.toHaveBeenCalled();

    const queued = await queueManager.list();
    expect(queued[0]?.status).toBe('pending');

    expect(events.some((entry) => entry.event === EventName.TRIGGER_SKIPPED)).toBe(true);
    expect(events.some((entry) => entry.event === EventName.TASK_COMPLETED)).toBe(false);
    expect(events.some((entry) => entry.event === EventName.TASK_FAILED)).toBe(false);
  });
});
