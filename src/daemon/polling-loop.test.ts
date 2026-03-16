/** Unit tests for PollingLoop — cycle order, dispatch, state writes, resilience. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type {
  CapacitySnapshot,
  TriggerResult,
  DispatchCycleResult,
  ScrowConfig,
  DispatchAdapter,
  DispatchAdapterOptions,
  TaskDefinition,
} from '../types/index.js';

vi.mock('../utils/index.js', () => ({
  retryWithBackoff: vi.fn((fn: () => Promise<unknown>) => fn()),
  logger: {
    debug: vi.fn().mockResolvedValue(undefined),
    info: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('./state-writer.js', () => ({
  writeCycleStatus: vi.fn().mockResolvedValue(undefined),
  writeStoppingStatus: vi.fn().mockResolvedValue(undefined),
  writeStoppedStatus: vi.fn().mockResolvedValue(undefined),
  writeErrorStatus: vi.fn().mockResolvedValue(undefined),
  buildLastErrorDetail: vi.fn((code: string, message: string, recoveryCommand: string | null) => ({
    code,
    message,
    recoveryCommand,
  })),
}));

// Mock task-output-writer to prevent real filesystem writes in dispatch callback tests.
// Without this mock, the non-fatal try/catch in onTaskComplete silently swallows write
// failures against a non-existent path, giving false confidence in dispatch integration tests.
vi.mock('./task-output-writer.js', () => ({
  writeTaskOutput: vi.fn().mockResolvedValue(undefined),
}));

// Mock result-writer to prevent real filesystem writes to /tmp/repo/.scrow/ during
// dispatch integration tests. Without this, the non-fatal catch in writeResultArtifact
// silently swallows failures, hiding test isolation violations.
vi.mock('../queue/index.js', () => ({
  writeResultArtifact: vi.fn().mockResolvedValue(null),
}));

// Mock platform/index.js to provide a taskOutputs path for the onTaskComplete callback.
vi.mock('../platform/index.js', () => ({
  getPaths: vi.fn(() => ({
    data: '/tmp/sparecrow-test',
    config: '/tmp/sparecrow-test',
    logs: '/tmp/sparecrow-test',
    taskOutputs: '/tmp/sparecrow-test/task-outputs',
  })),
}));

// Mock summary-writer to allow spying on writeSummaryFile invocation in gating tests.
vi.mock('./summary-writer.js', () => ({
  writeSummaryFile: vi.fn().mockResolvedValue(undefined),
}));

// Mock node:timers/promises to control sleep behavior
vi.mock('node:timers/promises', () => ({
  setTimeout: vi.fn().mockResolvedValue(undefined),
}));

const makeSnapshot = (): CapacitySnapshot => ({
  budgetWindows: [],
  rateWindows: [
    {
      id: 'session',
      kind: 'rate',
      utilization: 0.3,
      resetsAt: new Date(Date.now() + 3_600_000),
      windowDurationHours: 5,
    },
  ],
  provider: 'claude-code',
  fetchedAt: new Date(),
  source: 'oauth',
  confidence: 'high',
});

const makeTriggerResult = (shouldDispatch = false): TriggerResult => ({
  shouldDispatch,
  reason: shouldDispatch ? 'waste potential exceeded' : 'waste potential below threshold',
  evaluatedAt: new Date(),
  snapshotSource: 'oauth',
  wastePotential: shouldDispatch ? 0.65 : 0.2,
  effectiveReserve: 0.15,
  availableBudget: shouldDispatch ? 0.35 : 0.35,
  isIdleHours: false,
  rateHeadroom: true,
  perModelWaste: null,
});

const makeCycleResult = (): DispatchCycleResult => ({
  tasksAttempted: 1,
  tasksSucceeded: 1,
  tasksFailed: 0,
  stoppedByQuota: false,
  startedAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
  durationMs: 100,
});

const makeConfig = (overrides: Partial<ScrowConfig> = {}): ScrowConfig => ({
  pollingInterval: 10,
  logRetentionDays: 30,
  taskTimeoutMinutes: 60,
  provider: {
    name: 'claude-code',
    allowDangerouslySkipPermissions: false,
    executionBackend: 'container',
  },
  trigger: {
    maxWastePercentage: 50,
    weeklyReservePercentage: 30,
    idleHours: [],
  },
  tasks: [],
  lastSummaryEnabled: false,
  wslMountPrefix: '/mnt/',
  telemetry: { enabled: false, endpoint: 'https://telemetry.sparecrow.dev/v1/events' },
  ...overrides,
});

/** Build a typed DispatchAdapter mock. */
function makeDispatchAdapter(
  impl: (
    t: TriggerResult,
    o?: DispatchAdapterOptions,
  ) => Promise<DispatchCycleResult | null> = async () => null,
): DispatchAdapter & { dispatchIfTriggered: ReturnType<typeof vi.fn> } {
  const mock = vi.fn().mockImplementation(impl);
  return { dispatchIfTriggered: mock } as unknown as DispatchAdapter & {
    dispatchIfTriggered: ReturnType<typeof vi.fn>;
  };
}

/** Make a minimal TaskDefinition for callback tests. */
function makeTestTask(id: string): TaskDefinition {
  return {
    id,
    name: `task-${id}`,
    type: 'template',
    status: 'pending',
    prompt: 'test-prompt',
    targetPath: '/tmp/repo',
    priority: 1,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    timeoutMs: 60 * 60 * 1000,
    actions: [],
  };
}

describe('PollingLoop', () => {
  let mockUsageMonitor: { poll: ReturnType<typeof vi.fn> };
  let mockTriggerEngine: {
    evaluate: ReturnType<typeof vi.fn>;
    resetDispatchState: ReturnType<typeof vi.fn>;
  };
  let mockDispatchAdapter: DispatchAdapter & { dispatchIfTriggered: ReturnType<typeof vi.fn> };
  let writeCycleStatus: ReturnType<typeof vi.fn>;
  let sleepMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockUsageMonitor = { poll: vi.fn().mockResolvedValue(makeSnapshot()) };
    mockTriggerEngine = {
      evaluate: vi.fn().mockReturnValue(makeTriggerResult(false)),
      resetDispatchState: vi.fn(),
    };
    mockDispatchAdapter = makeDispatchAdapter(async () => null);

    const stateWriter = await import('./state-writer.js');
    writeCycleStatus = vi.mocked(stateWriter.writeCycleStatus);

    const timers = await import('node:timers/promises');
    sleepMock = vi.mocked(timers.setTimeout);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('executes cycle in correct order: poll -> evaluate -> dispatch check -> state write -> sleep', async () => {
    const callOrder: string[] = [];
    mockUsageMonitor.poll.mockImplementation(async () => {
      callOrder.push('poll');
      return makeSnapshot();
    });
    mockTriggerEngine.evaluate.mockImplementation(() => {
      callOrder.push('evaluate');
      return makeTriggerResult(false);
    });
    writeCycleStatus.mockImplementation(async () => {
      callOrder.push('state-write');
    });
    sleepMock.mockImplementation(
      async (_ms: unknown, _val: unknown, opts: { signal?: AbortSignal } = {}) => {
        callOrder.push('sleep');
        void opts;
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      },
    );

    const { PollingLoop } = await import('./polling-loop.js');
    const loop = new PollingLoop({
      usageMonitor: mockUsageMonitor as never,
      triggerEngine: mockTriggerEngine as never,
      dispatchAdapter: mockDispatchAdapter,
      getConfig: () => makeConfig(),
      startedAt: new Date().toISOString(),
    });

    await loop.start();

    expect(callOrder[0]).toBe('poll');
    expect(callOrder[1]).toBe('evaluate');
    expect(callOrder[2]).toBe('state-write');
    expect(callOrder[3]).toBe('sleep');
  });

  it('dispatches only when trigger fires', async () => {
    mockTriggerEngine.evaluate.mockReturnValue(makeTriggerResult(true));
    const cycleResult = makeCycleResult();
    mockDispatchAdapter.dispatchIfTriggered.mockResolvedValue(cycleResult);

    sleepMock.mockImplementation(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    const { PollingLoop } = await import('./polling-loop.js');
    const loop = new PollingLoop({
      usageMonitor: mockUsageMonitor as never,
      triggerEngine: mockTriggerEngine as never,
      dispatchAdapter: mockDispatchAdapter,
      getConfig: () => makeConfig(),
      startedAt: new Date().toISOString(),
    });

    await loop.start();

    expect(mockDispatchAdapter.dispatchIfTriggered).toHaveBeenCalledTimes(1);
    expect(writeCycleStatus).toHaveBeenCalledWith(expect.objectContaining({ cycleResult }));
  });

  it('does not dispatch when trigger does not fire', async () => {
    mockTriggerEngine.evaluate.mockReturnValue(makeTriggerResult(false));

    sleepMock.mockImplementation(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    const { PollingLoop } = await import('./polling-loop.js');
    const loop = new PollingLoop({
      usageMonitor: mockUsageMonitor as never,
      triggerEngine: mockTriggerEngine as never,
      dispatchAdapter: mockDispatchAdapter,
      getConfig: () => makeConfig(),
      startedAt: new Date().toISOString(),
    });

    await loop.start();

    expect(mockDispatchAdapter.dispatchIfTriggered).not.toHaveBeenCalled();
  });

  it('writes state on every cycle including error state', async () => {
    mockUsageMonitor.poll.mockRejectedValue(new Error('network error'));

    let sleepCallCount = 0;
    sleepMock.mockImplementation(async () => {
      sleepCallCount++;
      if (sleepCallCount >= 1) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
    });

    const { PollingLoop } = await import('./polling-loop.js');
    const loop = new PollingLoop({
      usageMonitor: mockUsageMonitor as never,
      triggerEngine: mockTriggerEngine as never,
      dispatchAdapter: mockDispatchAdapter,
      getConfig: () => makeConfig(),
      startedAt: new Date().toISOString(),
    });

    await loop.start();

    expect(writeCycleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ lastError: 'network error' }),
    );
  });

  it('continues loop after transient poll failure', async () => {
    let pollCount = 0;
    mockUsageMonitor.poll.mockImplementation(async () => {
      pollCount++;
      if (pollCount === 1) throw new Error('transient error');
      return makeSnapshot();
    });

    let sleepCallCount = 0;
    sleepMock.mockImplementation(async () => {
      sleepCallCount++;
      if (sleepCallCount >= 2) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
    });

    const { PollingLoop } = await import('./polling-loop.js');
    const loop = new PollingLoop({
      usageMonitor: mockUsageMonitor as never,
      triggerEngine: mockTriggerEngine as never,
      dispatchAdapter: mockDispatchAdapter,
      getConfig: () => makeConfig(),
      startedAt: new Date().toISOString(),
    });

    await loop.start();

    expect(pollCount).toBeGreaterThanOrEqual(2);
  });

  it('continues loop after trigger failure', async () => {
    let triggerCallCount = 0;
    mockTriggerEngine.evaluate.mockImplementation(() => {
      triggerCallCount++;
      if (triggerCallCount === 1) throw new Error('trigger error');
      return makeTriggerResult(false);
    });

    let sleepCallCount = 0;
    sleepMock.mockImplementation(async () => {
      sleepCallCount++;
      if (sleepCallCount >= 2) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
    });

    const { PollingLoop } = await import('./polling-loop.js');
    const loop = new PollingLoop({
      usageMonitor: mockUsageMonitor as never,
      triggerEngine: mockTriggerEngine as never,
      dispatchAdapter: mockDispatchAdapter,
      getConfig: () => makeConfig(),
      startedAt: new Date().toISOString(),
    });

    await loop.start();

    expect(triggerCallCount).toBeGreaterThanOrEqual(2);
  });

  it('continues loop after dispatch failure', async () => {
    mockTriggerEngine.evaluate.mockReturnValue(makeTriggerResult(true));
    let dispatchCallCount = 0;
    mockDispatchAdapter.dispatchIfTriggered.mockImplementation(async () => {
      dispatchCallCount++;
      if (dispatchCallCount === 1) throw new Error('dispatch error');
      return null;
    });

    let sleepCallCount = 0;
    sleepMock.mockImplementation(async () => {
      sleepCallCount++;
      if (sleepCallCount >= 2) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
    });

    const { PollingLoop } = await import('./polling-loop.js');
    const loop = new PollingLoop({
      usageMonitor: mockUsageMonitor as never,
      triggerEngine: mockTriggerEngine as never,
      dispatchAdapter: mockDispatchAdapter,
      getConfig: () => makeConfig(),
      startedAt: new Date().toISOString(),
    });

    await loop.start();

    expect(dispatchCallCount).toBeGreaterThanOrEqual(2);
  });

  it('AbortError clean-exit path: final state is stopped, no error logged', async () => {
    sleepMock.mockImplementation(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    const { PollingLoop } = await import('./polling-loop.js');
    const loop = new PollingLoop({
      usageMonitor: mockUsageMonitor as never,
      triggerEngine: mockTriggerEngine as never,
      dispatchAdapter: mockDispatchAdapter,
      getConfig: () => makeConfig(),
      startedAt: new Date().toISOString(),
    });

    await loop.start();

    const cycleCalls = writeCycleStatus.mock.calls;
    if (cycleCalls.length > 0) {
      const lastCall = cycleCalls[cycleCalls.length - 1]![0] as Record<string, unknown>;
      expect(lastCall['lastError']).toBeNull();
    }
  });

  it('stop() resolves when loop exits', async () => {
    sleepMock.mockImplementation(
      async (_ms: unknown, _val: unknown, opts: { signal?: AbortSignal } = {}) => {
        if (opts.signal) {
          await new Promise<void>((resolve) => {
            opts.signal!.addEventListener('abort', () => resolve(), { once: true });
          });
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }
      },
    );

    const { PollingLoop } = await import('./polling-loop.js');
    const loop = new PollingLoop({
      usageMonitor: mockUsageMonitor as never,
      triggerEngine: mockTriggerEngine as never,
      dispatchAdapter: mockDispatchAdapter,
      getConfig: () => makeConfig(),
      startedAt: new Date().toISOString(),
    });

    const loopDone = loop.start();
    // Yield to the event loop so the async loop starts before we call stop().
    // Uses resolved-promise microtask instead of real setTimeout.
    await Promise.resolve();
    await Promise.resolve();

    const stopDone = loop.stop();
    await Promise.all([loopDone, stopDone]);
  });

  it('usage fields always written in cycle state', async () => {
    sleepMock.mockImplementation(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    const { PollingLoop } = await import('./polling-loop.js');
    const loop = new PollingLoop({
      usageMonitor: mockUsageMonitor as never,
      triggerEngine: mockTriggerEngine as never,
      dispatchAdapter: mockDispatchAdapter,
      getConfig: () => makeConfig(),
      startedAt: new Date().toISOString(),
    });

    await loop.start();

    const cycleCalls = writeCycleStatus.mock.calls;
    expect(cycleCalls.length).toBeGreaterThan(0);
    const call = cycleCalls[0]![0] as Record<string, unknown>;
    expect('usage' in call).toBe(true);
    expect('trigger' in call).toBe(true);
    expect('lastPollAt' in call).toBe(true);
    expect('nextPollAt' in call).toBe(true);
  });
});

// Story 7.17: polling-loop callback wiring tests (AC7)
describe('PollingLoop — dispatch callback wiring (AC7)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes onTaskStart and onTaskComplete callbacks to dispatchAdapter.dispatchIfTriggered()', async () => {
    const sleepMock = vi.mocked((await import('node:timers/promises')).setTimeout);
    sleepMock.mockImplementation(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    let capturedOptions: DispatchAdapterOptions | undefined;
    const adapter = makeDispatchAdapter(async (_t, opts) => {
      capturedOptions = opts;
      return null;
    });

    const triggerEngine = {
      evaluate: vi.fn().mockReturnValue(makeTriggerResult(true)),
      resetDispatchState: vi.fn(),
    };

    const { PollingLoop } = await import('./polling-loop.js');
    const loop = new PollingLoop({
      usageMonitor: { poll: vi.fn().mockResolvedValue(makeSnapshot()) } as never,
      triggerEngine: triggerEngine as never,
      dispatchAdapter: adapter,
      getConfig: () => makeConfig(),
      startedAt: new Date().toISOString(),
    });

    await loop.start();

    expect(adapter.dispatchIfTriggered).toHaveBeenCalledTimes(1);
    expect(capturedOptions).toBeDefined();
    expect(typeof capturedOptions!.onTaskStart).toBe('function');
    expect(typeof capturedOptions!.onTaskComplete).toBe('function');
  });

  it('invokes writeCycleStatus with non-null activeTask when onTaskStart callback fires', async () => {
    const writeCycleStatusMock = vi.mocked((await import('./state-writer.js')).writeCycleStatus);
    const sleepMock = vi.mocked((await import('node:timers/promises')).setTimeout);
    sleepMock.mockImplementation(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    const testTask = makeTestTask('task-cb-1');

    const adapter = makeDispatchAdapter(async (_t, opts) => {
      // Simulate the dispatcher invoking onTaskStart before execution
      if (opts?.onTaskStart) {
        await opts.onTaskStart(testTask);
      }
      return makeCycleResult();
    });

    const triggerEngine = {
      evaluate: vi.fn().mockReturnValue(makeTriggerResult(true)),
      resetDispatchState: vi.fn(),
    };

    const { PollingLoop } = await import('./polling-loop.js');
    const loop = new PollingLoop({
      usageMonitor: { poll: vi.fn().mockResolvedValue(makeSnapshot()) } as never,
      triggerEngine: triggerEngine as never,
      dispatchAdapter: adapter,
      getConfig: () => makeConfig(),
      startedAt: new Date().toISOString(),
    });

    await loop.start();

    // Find a writeCycleStatus call that has non-null activeTask (written by onTaskStart)
    const callsWithActiveTask = writeCycleStatusMock.mock.calls.filter((call) => {
      const arg = call[0] as Record<string, unknown>;
      return arg['activeTask'] !== null && arg['activeTask'] !== undefined;
    });

    expect(callsWithActiveTask.length).toBeGreaterThan(0);
    const activeTaskArg = (callsWithActiveTask[0]![0] as Record<string, unknown>)[
      'activeTask'
    ] as Record<string, unknown>;
    expect(activeTaskArg['taskId']).toBe('task-cb-1');
    expect(activeTaskArg['taskName']).toBe('task-task-cb-1');
    expect(typeof activeTaskArg['startedAt']).toBe('string');
  });

  it('invokes writeCycleStatus with activeTask null when onTaskComplete callback fires', async () => {
    const writeCycleStatusMock = vi.mocked((await import('./state-writer.js')).writeCycleStatus);
    const writeTaskOutputMock = vi.mocked(
      (await import('./task-output-writer.js')).writeTaskOutput,
    );
    const sleepMock = vi.mocked((await import('node:timers/promises')).setTimeout);
    sleepMock.mockImplementation(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    const testTask = makeTestTask('task-cb-2');
    const fakeResult = {
      taskId: testTask.id,
      status: 'done' as const,
      startedAt: new Date(),
      completedAt: new Date(),
      durationMs: 100,
      stdout: 'hello output',
      stderr: '',
      exitCode: 0,
      error: null,
      errorCode: null,
    };

    const adapter = makeDispatchAdapter(async (_t, opts) => {
      if (opts?.onTaskStart) await opts.onTaskStart(testTask);
      if (opts?.onTaskComplete) await opts.onTaskComplete(testTask, fakeResult);
      return makeCycleResult();
    });

    const triggerEngine = {
      evaluate: vi.fn().mockReturnValue(makeTriggerResult(true)),
      resetDispatchState: vi.fn(),
    };

    const { PollingLoop } = await import('./polling-loop.js');
    const loop = new PollingLoop({
      usageMonitor: { poll: vi.fn().mockResolvedValue(makeSnapshot()) } as never,
      triggerEngine: triggerEngine as never,
      dispatchAdapter: adapter,
      getConfig: () => makeConfig(),
      startedAt: new Date().toISOString(),
    });

    await loop.start();

    // The onTaskComplete write sets activeTask: null
    // Find writeCycleStatus calls after the onTaskStart call — the onTaskComplete write clears it
    const calls = writeCycleStatusMock.mock.calls.map(
      (call) => (call[0] as Record<string, unknown>)['activeTask'],
    );
    // There should be at least one call with activeTask: null from onTaskComplete
    expect(calls.some((v) => v === null)).toBe(true);

    // Assert writeTaskOutput was called with the task result — verifies dispatch integration
    expect(writeTaskOutputMock).toHaveBeenCalledWith(
      '/tmp/sparecrow-test/task-outputs',
      expect.objectContaining({ taskId: testTask.id }),
    );
  });

  it('writes partial cycleResult after onTaskComplete with accumulated task counts (AC4)', async () => {
    const writeCycleStatusMock = vi.mocked((await import('./state-writer.js')).writeCycleStatus);
    const sleepMock = vi.mocked((await import('node:timers/promises')).setTimeout);
    sleepMock.mockImplementation(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    const t1 = makeTestTask('t1');
    const t2 = makeTestTask('t2');
    const makeTaskResult = (
      task: TaskDefinition,
      status: 'done' | 'failed',
    ): Parameters<NonNullable<DispatchAdapterOptions['onTaskComplete']>>[1] => ({
      taskId: task.id,
      status,
      startedAt: new Date(),
      completedAt: new Date(),
      durationMs: 10,
      stdout: '',
      stderr: '',
      exitCode: status === 'done' ? 0 : 1,
      error: null,
      errorCode: null,
    });

    const adapter = makeDispatchAdapter(async (_t, opts) => {
      if (opts?.onTaskStart) await opts.onTaskStart(t1);
      if (opts?.onTaskComplete) await opts.onTaskComplete(t1, makeTaskResult(t1, 'done'));
      if (opts?.onTaskStart) await opts.onTaskStart(t2);
      if (opts?.onTaskComplete) await opts.onTaskComplete(t2, makeTaskResult(t2, 'failed'));
      return makeCycleResult();
    });

    const triggerEngine = {
      evaluate: vi.fn().mockReturnValue(makeTriggerResult(true)),
      resetDispatchState: vi.fn(),
    };

    const { PollingLoop } = await import('./polling-loop.js');
    const loop = new PollingLoop({
      usageMonitor: { poll: vi.fn().mockResolvedValue(makeSnapshot()) } as never,
      triggerEngine: triggerEngine as never,
      dispatchAdapter: adapter,
      getConfig: () => makeConfig(),
      startedAt: new Date().toISOString(),
    });

    await loop.start();

    // Find writeCycleStatus calls where cycleResult shows both tasks attempted.
    // The onTaskComplete callback for t2 writes tasksAttempted=2, which can only
    // come from the partial-progress accumulator (not from the dispatch adapter return
    // which has makeCycleResult() with tasksAttempted=1, or the pre-dispatch null).
    const callsWithBothTasks = writeCycleStatusMock.mock.calls.filter((call) => {
      const arg = call[0] as Record<string, unknown>;
      const cr = arg['cycleResult'] as Record<string, unknown> | null | undefined;
      return cr != null && cr['tasksAttempted'] === 2;
    });

    // After the second task completes: tasksAttempted=2, tasksSucceeded=1, tasksFailed=1
    expect(callsWithBothTasks.length).toBeGreaterThanOrEqual(1);
    const cr = (callsWithBothTasks[0]![0] as Record<string, unknown>)['cycleResult'] as Record<
      string,
      unknown
    >;
    expect(cr['tasksAttempted']).toBe(2);
    expect(cr['tasksSucceeded']).toBe(1);
    expect(cr['tasksFailed']).toBe(1);
  });
});

describe('diffConfig', () => {
  it('detects pollingInterval as hot-apply (AC5 — no longer restart-required)', async () => {
    const { diffConfig } = await import('./polling-loop.js');
    const old = makeConfig({ pollingInterval: 30 });
    const next = makeConfig({ pollingInterval: 60 });
    const { restartRequiredKeys, hotApplyKeys } = diffConfig(old, next);
    expect(restartRequiredKeys).not.toContain('pollingInterval');
    expect(hotApplyKeys).toContain('pollingInterval');
  });

  it('detects trigger changes as hot-apply', async () => {
    const { diffConfig } = await import('./polling-loop.js');
    const old = makeConfig({
      trigger: {
        maxWastePercentage: 50,
        weeklyReservePercentage: 30,
        idleHours: [],
      },
    });
    const next = makeConfig({
      trigger: {
        maxWastePercentage: 40,
        weeklyReservePercentage: 30,
        idleHours: [],
      },
    });
    const { restartRequiredKeys, hotApplyKeys } = diffConfig(old, next);
    expect(restartRequiredKeys).not.toContain('trigger');
    expect(hotApplyKeys).toContain('trigger');
  });

  it('detects provider changes as restart-required', async () => {
    const { diffConfig } = await import('./polling-loop.js');
    const old = makeConfig({
      provider: {
        name: 'claude-code',
        allowDangerouslySkipPermissions: false,
        executionBackend: 'container',
      },
    });
    const next = makeConfig({
      provider: {
        name: 'other',
        allowDangerouslySkipPermissions: false,
        executionBackend: 'container',
      },
    });
    const { restartRequiredKeys } = diffConfig(old, next);
    expect(restartRequiredKeys).toContain('provider');
  });

  it('detects weeklyReservePercentage change as hot-apply', async () => {
    const { diffConfig } = await import('./polling-loop.js');
    const old = makeConfig({
      trigger: {
        maxWastePercentage: 50,
        weeklyReservePercentage: 30,
        idleHours: [],
      },
    });
    const next = makeConfig({
      trigger: {
        maxWastePercentage: 50,
        weeklyReservePercentage: 20,
        idleHours: [],
      },
    });
    const { restartRequiredKeys, hotApplyKeys } = diffConfig(old, next);
    expect(restartRequiredKeys).not.toContain('trigger');
    expect(hotApplyKeys).toContain('trigger');
  });

  it('returns empty arrays when config unchanged', async () => {
    const { diffConfig } = await import('./polling-loop.js');
    const cfg = makeConfig();
    const { restartRequiredKeys, hotApplyKeys } = diffConfig(cfg, { ...cfg });
    expect(restartRequiredKeys).toHaveLength(0);
    expect(hotApplyKeys).toHaveLength(0);
  });

  it('detects logRetentionDays change as hot-apply (Finding 9 coverage)', async () => {
    const { diffConfig } = await import('./polling-loop.js');
    const old = makeConfig({ logRetentionDays: 30 });
    const next = makeConfig({ logRetentionDays: 60 });
    const { restartRequiredKeys, hotApplyKeys } = diffConfig(old, next);
    expect(restartRequiredKeys).not.toContain('logRetentionDays');
    expect(hotApplyKeys).toContain('logRetentionDays');
  });
});

describe('buildUsageState — weekly window selection for multi-model tiers', () => {
  // These tests verify AC-4: buildUsageState() preferentially selects the aggregate (non-model)
  // weekly window and falls back to the first matching window when no aggregate exists.
  // We test this by asserting weeklyUtilization values written to writeCycleStatus.

  beforeEach(async () => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('selects aggregate weekly window (no model field) over per-model windows', async () => {
    // Snapshot has: aggregate window (21% — the "overall"), opus per-model (50%), sonnet (30%)
    const multiModelSnapshot: CapacitySnapshot = {
      rateWindows: [
        {
          id: 'session',
          kind: 'rate',
          utilization: 0.03,
          resetsAt: new Date(Date.now() + 3_600_000),
          windowDurationHours: 5,
        },
      ],
      budgetWindows: [
        // Aggregate window — no model field
        {
          id: 'weekly',
          kind: 'budget',
          utilization: 0.21,
          resetsAt: new Date(Date.now() + 86_400_000),
          windowDurationHours: 168,
        },
        // Per-model windows
        {
          id: 'weekly:opus',
          kind: 'budget',
          utilization: 0.5,
          resetsAt: new Date(Date.now() + 86_400_000),
          windowDurationHours: 168,
          model: 'opus',
        },
        {
          id: 'weekly:sonnet',
          kind: 'budget',
          utilization: 0.3,
          resetsAt: new Date(Date.now() + 86_400_000),
          windowDurationHours: 168,
          model: 'sonnet',
        },
      ],
      provider: 'claude-code',
      fetchedAt: new Date(),
      source: 'oauth',
      confidence: 'high',
    };

    const sleepMock = vi.mocked((await import('node:timers/promises')).setTimeout);
    const writeCycleStatusMock = vi.mocked((await import('./state-writer.js')).writeCycleStatus);

    const mockMonitor = { poll: vi.fn().mockResolvedValue(multiModelSnapshot) };
    const mockTrigger = {
      evaluate: vi.fn().mockReturnValue({
        shouldDispatch: false,
        reason: 'ok',
        evaluatedAt: new Date(),
        snapshotSource: 'oauth',
      }),
      resetDispatchState: vi.fn(),
    };
    const mockAdapter = makeDispatchAdapter(async () => null);

    sleepMock.mockImplementation(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    const { PollingLoop } = await import('./polling-loop.js');
    const loop = new PollingLoop({
      usageMonitor: mockMonitor as never,
      triggerEngine: mockTrigger as never,
      dispatchAdapter: mockAdapter,
      getConfig: () => makeConfig(),
      startedAt: new Date().toISOString(),
    });

    await loop.start();

    // buildUsageState should prefer aggregate (0.21), not the first opus window (0.50)
    const cycleCall = writeCycleStatusMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(cycleCall).toBeDefined();
    const usage = cycleCall['usage'] as Record<string, unknown> | null;
    expect(usage).not.toBeNull();
    expect(usage!['weeklyUtilization']).toBeCloseTo(0.21);
  });

  it('falls back to first matching weekly window when no aggregate window is present', async () => {
    // NOTE: This test exercises a DEFENSIVE-ONLY fallback path.
    // In the real pipeline, `parseWeeklyBuckets()` always synthesises a no-model aggregate window
    // when all parsed buckets are per-model (i.e. base `seven_day` is null), so a snapshot
    // without any aggregate window should never reach `buildUsageState()` through normal operation.
    // This test guards against future regressions where the synthesis logic is bypassed or
    // a snapshot is constructed externally without an aggregate window.
    const perModelOnlySnapshot: CapacitySnapshot = {
      rateWindows: [
        {
          id: 'session',
          kind: 'rate',
          utilization: 0.03,
          resetsAt: new Date(Date.now() + 3_600_000),
          windowDurationHours: 5,
        },
      ],
      budgetWindows: [
        {
          id: 'weekly:opus',
          kind: 'budget',
          utilization: 0.5,
          resetsAt: new Date(Date.now() + 86_400_000),
          windowDurationHours: 168,
          model: 'opus',
        },
        {
          id: 'weekly:sonnet',
          kind: 'budget',
          utilization: 0.3,
          resetsAt: new Date(Date.now() + 86_400_000),
          windowDurationHours: 168,
          model: 'sonnet',
        },
      ],
      provider: 'claude-code',
      fetchedAt: new Date(),
      source: 'oauth',
      confidence: 'high',
    };

    const sleepMock = vi.mocked((await import('node:timers/promises')).setTimeout);
    const writeCycleStatusMock = vi.mocked((await import('./state-writer.js')).writeCycleStatus);

    const mockMonitor = { poll: vi.fn().mockResolvedValue(perModelOnlySnapshot) };
    const mockTrigger = {
      evaluate: vi.fn().mockReturnValue({
        shouldDispatch: false,
        reason: 'ok',
        evaluatedAt: new Date(),
        snapshotSource: 'oauth',
      }),
      resetDispatchState: vi.fn(),
    };
    const mockAdapter = makeDispatchAdapter(async () => null);

    sleepMock.mockImplementation(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    const { PollingLoop } = await import('./polling-loop.js');
    const loop = new PollingLoop({
      usageMonitor: mockMonitor as never,
      triggerEngine: mockTrigger as never,
      dispatchAdapter: mockAdapter,
      getConfig: () => makeConfig(),
      startedAt: new Date().toISOString(),
    });

    await loop.start();

    // Falls back to first weekly window — opus at 0.5
    const cycleCall = writeCycleStatusMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(cycleCall).toBeDefined();
    const usage = cycleCall['usage'] as Record<string, unknown> | null;
    expect(usage).not.toBeNull();
    expect(usage!['weeklyUtilization']).toBeCloseTo(0.5);
  });

  it('returns sessionUtilization null when rateWindows is empty (AC5 no active session)', async () => {
    const emptyRateSnapshot: CapacitySnapshot = {
      rateWindows: [],
      budgetWindows: [
        {
          id: 'weekly',
          kind: 'budget',
          utilization: 0.35,
          resetsAt: new Date(Date.now() + 86_400_000),
          windowDurationHours: 168,
        },
      ],
      provider: 'claude-code',
      fetchedAt: new Date(),
      source: 'oauth',
      confidence: 'high',
    };

    const sleepMock = vi.mocked((await import('node:timers/promises')).setTimeout);
    const writeCycleStatusMock = vi.mocked((await import('./state-writer.js')).writeCycleStatus);

    const mockMonitor = { poll: vi.fn().mockResolvedValue(emptyRateSnapshot) };
    const mockTrigger = {
      evaluate: vi.fn().mockReturnValue({
        shouldDispatch: false,
        reason: 'ok',
        evaluatedAt: new Date(),
        snapshotSource: 'oauth',
      }),
      resetDispatchState: vi.fn(),
    };
    const mockAdapter = makeDispatchAdapter(async () => null);

    sleepMock.mockImplementation(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    const { PollingLoop } = await import('./polling-loop.js');
    const loop = new PollingLoop({
      usageMonitor: mockMonitor as never,
      triggerEngine: mockTrigger as never,
      dispatchAdapter: mockAdapter,
      getConfig: () => makeConfig(),
      startedAt: new Date().toISOString(),
    });

    await loop.start();

    const cycleCall = writeCycleStatusMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(cycleCall).toBeDefined();
    const usage = cycleCall['usage'] as Record<string, unknown> | null;
    expect(usage).not.toBeNull();
    expect(usage!['sessionUtilization']).toBeNull();
    expect(usage!['sessionResetsAt']).toBeNull();
    expect(usage!['weeklyUtilization']).toBeCloseTo(0.35);
  });
});

describe('PollingLoop.reload', () => {
  it('hot-applies trigger threshold without affecting polling interval', async () => {
    const config = makeConfig();
    const currentConfig = config;

    const { PollingLoop } = await import('./polling-loop.js');
    const adapter = makeDispatchAdapter(async () => null);
    const loop = new PollingLoop({
      usageMonitor: { poll: vi.fn().mockResolvedValue(makeSnapshot()) } as never,
      triggerEngine: {
        evaluate: vi.fn().mockReturnValue(makeTriggerResult(false)),
        resetDispatchState: vi.fn(),
      } as never,
      dispatchAdapter: adapter,
      getConfig: () => currentConfig,
      startedAt: new Date().toISOString(),
    });

    const newConfig = makeConfig({
      trigger: {
        maxWastePercentage: 40,
        weeklyReservePercentage: 30,
        idleHours: [],
      },
    });
    loop.reload(newConfig);

    // Should not throw — reload only updates config reference
    expect(() => loop.reload(newConfig)).not.toThrow();
  });

  it('pollingInterval change is hot-applied immediately (AC5)', async () => {
    const { PollingLoop } = await import('./polling-loop.js');
    const adapter = makeDispatchAdapter(async () => null);
    const oldConfig = makeConfig({ pollingInterval: 30 });
    const loop = new PollingLoop({
      usageMonitor: { poll: vi.fn().mockResolvedValue(makeSnapshot()) } as never,
      triggerEngine: {
        evaluate: vi.fn().mockReturnValue(makeTriggerResult(false)),
        resetDispatchState: vi.fn(),
      } as never,
      dispatchAdapter: adapter,
      getConfig: () => oldConfig,
      startedAt: new Date().toISOString(),
    });

    const newConfig = makeConfig({ pollingInterval: 60 });
    // Should not throw — pollingInterval is now hot-apply safe
    expect(() => loop.reload(newConfig)).not.toThrow();
  });

  it('applies new pollingInterval immediately via hot-apply (AC5, 6.2)', async () => {
    // Verify that after reload with changed pollingInterval, the loop uses the new value.
    // We observe this by capturing the sleep duration from the mocked setTimeout.
    const config = makeConfig({ pollingInterval: 10 });
    let currentConfig = config;

    const { PollingLoop } = await import('./polling-loop.js');
    const timers = await import('node:timers/promises');
    const localSleepMock = vi.mocked(timers.setTimeout);

    const localUsageMonitor = { poll: vi.fn().mockResolvedValue(makeSnapshot()) };
    const localTriggerEngine = {
      evaluate: vi.fn().mockReturnValue(makeTriggerResult(false)),
      resetDispatchState: vi.fn(),
    };

    const adapter = makeDispatchAdapter(async () => null);
    const loop = new PollingLoop({
      usageMonitor: localUsageMonitor as never,
      triggerEngine: localTriggerEngine as never,
      dispatchAdapter: adapter,
      getConfig: () => currentConfig,
      startedAt: new Date().toISOString(),
    });

    // Reload with new pollingInterval (only pollingInterval changed — hot-apply, no restart)
    const newConfig = makeConfig({ pollingInterval: 60 });
    currentConfig = newConfig;
    loop.reload(newConfig);

    // Verify the loop picks up the new interval by running one cycle and checking sleep
    let sleepDuration: unknown = null;
    let cycleCount = 0;
    localSleepMock.mockImplementation(async (ms?: number) => {
      sleepDuration = ms;
      cycleCount += 1;
      if (cycleCount >= 1) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
    });

    await loop.start();

    // The sleep duration should be based on the new interval (60 * 1000 = 60000),
    // minus any elapsed cycle time. It should NOT be 10 * 1000 = 10000.
    expect(typeof sleepDuration).toBe('number');
    // Assert close to 60_000 ms: cycle execution is near-instant in tests with mocked I/O,
    // so elapsed time is negligible and sleep should be >= 55_000 ms (AC5 verification).
    // A weak assertion like `> 10_000` would pass even if the old 10-second interval were used.
    expect(sleepDuration as number).toBeGreaterThanOrEqual(55_000);
  });

  it('invokes onRestartRequired callback when provider config changes (6.3)', async () => {
    const config = makeConfig();
    const { PollingLoop } = await import('./polling-loop.js');

    const restartCallback = vi.fn().mockResolvedValue(undefined);

    const localUsageMonitor = { poll: vi.fn().mockResolvedValue(makeSnapshot()) };
    const localTriggerEngine = {
      evaluate: vi.fn().mockReturnValue(makeTriggerResult(false)),
      resetDispatchState: vi.fn(),
    };

    const adapter = makeDispatchAdapter(async () => null);
    const loop = new PollingLoop({
      usageMonitor: localUsageMonitor as never,
      triggerEngine: localTriggerEngine as never,
      dispatchAdapter: adapter,
      getConfig: () => config,
      startedAt: new Date().toISOString(),
      onRestartRequired: restartCallback,
    });

    const newConfig = makeConfig({
      provider: {
        name: 'claude-code',
        claudePath: '/usr/local/bin/claude',
        allowDangerouslySkipPermissions: false,
        executionBackend: 'container',
      },
    });

    loop.reload(newConfig);

    // onRestartRequired should have been called with the new config and changed fields
    expect(restartCallback).toHaveBeenCalledTimes(1);
    expect(restartCallback).toHaveBeenCalledWith(newConfig, ['provider']);
  });

  it('falls back to legacy behavior when no onRestartRequired callback (backward compat)', async () => {
    const config = makeConfig();
    const { PollingLoop } = await import('./polling-loop.js');

    const localUsageMonitor = { poll: vi.fn().mockResolvedValue(makeSnapshot()) };
    const localTriggerEngine = {
      evaluate: vi.fn().mockReturnValue(makeTriggerResult(false)),
      resetDispatchState: vi.fn(),
    };

    const adapter = makeDispatchAdapter(async () => null);
    const loop = new PollingLoop({
      usageMonitor: localUsageMonitor as never,
      triggerEngine: localTriggerEngine as never,
      dispatchAdapter: adapter,
      getConfig: () => config,
      startedAt: new Date().toISOString(),
      // No onRestartRequired callback
    });

    const newConfig = makeConfig({
      provider: {
        name: 'other-provider',
        allowDangerouslySkipPermissions: false,
        executionBackend: 'container',
      },
    });

    // Should not throw — falls back to legacy warning + keeps old provider
    expect(() => loop.reload(newConfig)).not.toThrow();
  });
});

// Story 7.21: computeNextPollAt unit tests
describe('computeNextPollAt', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns future nextPollAt and full intervalMs when cycle just started', async () => {
    const { computeNextPollAt } = await import('./polling-loop.js');
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const cycleStart = new Date(now - 100); // 100ms ago
    const intervalMs = 10_000;

    const result = computeNextPollAt(cycleStart, intervalMs);

    expect(result.sleepMs).toBe(9_900); // 10000 - 100
    expect(result.nextPollAt).toBe(new Date(now + 9_900).toISOString());
  });

  it('returns sleepMs clamped to 0 when cycle exceeds intervalMs', async () => {
    const { computeNextPollAt } = await import('./polling-loop.js');
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    // Cycle started 20 seconds ago, interval is 10 seconds — cycle exceeded interval
    const cycleStart = new Date(now - 20_000);
    const intervalMs = 10_000;

    const result = computeNextPollAt(cycleStart, intervalMs);

    expect(result.sleepMs).toBe(0);
    // nextPollAt should be "now" (immediate poll)
    expect(result.nextPollAt).toBe(new Date(now).toISOString());
  });

  it('returns correct values when cycle takes exactly intervalMs', async () => {
    const { computeNextPollAt } = await import('./polling-loop.js');
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const cycleStart = new Date(now - 10_000); // Exactly intervalMs ago
    const intervalMs = 10_000;

    const result = computeNextPollAt(cycleStart, intervalMs);

    expect(result.sleepMs).toBe(0);
    expect(result.nextPollAt).toBe(new Date(now).toISOString());
  });
});

// Story 7.21: Polling loop stale nextPollAt integration tests (AC1-6)
describe('PollingLoop — stale nextPollAt fix (Story 7.21)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes wall-clock-accurate nextPollAt after a simulated long dispatch (AC1)', async () => {
    const writeCycleStatusMock = vi.mocked((await import('./state-writer.js')).writeCycleStatus);
    const sleepMock = vi.mocked((await import('node:timers/promises')).setTimeout);

    // Simulate a dispatch that takes 15 minutes (900_000ms) with a 5-minute interval (300_000ms)
    const intervalSeconds = 300; // 5 minutes
    const fakeNow = new Date('2026-03-01T12:00:00.000Z').getTime();

    // Track time progression: cycle starts at T+0
    let currentTime = fakeNow;
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => currentTime);

    // Also mock new Date() to use our controlled time
    const OrigDate = globalThis.Date;
    const MockDate = class extends OrigDate {
      constructor(...args: Parameters<DateConstructor>) {
        if (args.length === 0) {
          super(currentTime);
        } else {
          super(...(args as unknown as [number]));
        }
      }
    } as DateConstructor;
    MockDate.now = () => currentTime;
    MockDate.parse = OrigDate.parse;
    MockDate.UTC = OrigDate.UTC;
    globalThis.Date = MockDate;

    let allCalls: typeof writeCycleStatusMock.mock.calls;
    try {
      const mockUsageMonitor = { poll: vi.fn().mockResolvedValue(makeSnapshot()) };
      const mockTriggerEngine = {
        evaluate: vi.fn().mockReturnValue(makeTriggerResult(true)),
        resetDispatchState: vi.fn(),
      };

      // Dispatch takes 15 minutes (advance time during dispatch)
      const mockAdapter = makeDispatchAdapter(async () => {
        // Simulate 15 minutes passing during dispatch
        currentTime = fakeNow + 900_000;
        return makeCycleResult();
      });

      // Sleep aborts on first call to exit the loop
      sleepMock.mockImplementation(async () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      });

      const { PollingLoop } = await import('./polling-loop.js');
      const loop = new PollingLoop({
        usageMonitor: mockUsageMonitor as never,
        triggerEngine: mockTriggerEngine as never,
        dispatchAdapter: mockAdapter,
        getConfig: () => makeConfig({ pollingInterval: intervalSeconds }),
        startedAt: new Date(fakeNow).toISOString(),
      });

      await loop.start();
      allCalls = writeCycleStatusMock.mock.calls;
    } finally {
      // Always restore Date even if loop.start() throws or an assertion fails
      globalThis.Date = OrigDate;
      dateNowSpy.mockRestore();
    }

    // Find the end-of-cycle writeCycleStatus call (the last one before sleep).
    // It should have a nextPollAt that is NOT in the past.
    expect(allCalls.length).toBeGreaterThan(0);

    // The end-of-cycle write is the one with cycleResult !== null and trigger !== null
    const endCycleCalls = allCalls.filter((call) => {
      const arg = call[0] as Record<string, unknown>;
      return arg['trigger'] !== null;
    });
    expect(endCycleCalls.length).toBeGreaterThan(0);

    // Get the last such call (end-of-cycle state write)
    const lastEndCycleArg = endCycleCalls[endCycleCalls.length - 1]![0] as Record<string, unknown>;
    const nextPollAt = lastEndCycleArg['nextPollAt'] as string;

    // nextPollAt should be at or after the dispatch completion time (T+15min = fakeNow + 900_000)
    // Since cycle exceeded interval, sleepMs=0, so nextPollAt = now = T+15min
    const nextPollTime = new Date(nextPollAt).getTime();
    expect(nextPollTime).toBeGreaterThanOrEqual(fakeNow + 900_000);
  });

  it('passes compensated sleep duration to setTimeout after long cycle (AC2)', async () => {
    const sleepMock = vi.mocked((await import('node:timers/promises')).setTimeout);

    // Simulate a cycle that takes 3 minutes with a 5-minute interval
    const intervalSeconds = 300; // 5 minutes = 300_000ms
    const intervalMs = intervalSeconds * 1000;
    const fakeNow = new Date('2026-03-01T12:00:00.000Z').getTime();
    const cycleElapsedMs = 180_000; // 3 minutes
    const expectedSleepMs = intervalMs - cycleElapsedMs; // 120_000ms (2 min)

    let currentTime = fakeNow;
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => currentTime);

    const OrigDate = globalThis.Date;
    const MockDate = class extends OrigDate {
      constructor(...args: Parameters<DateConstructor>) {
        if (args.length === 0) {
          super(currentTime);
        } else {
          super(...(args as unknown as [number]));
        }
      }
    } as DateConstructor;
    MockDate.now = () => currentTime;
    MockDate.parse = OrigDate.parse;
    MockDate.UTC = OrigDate.UTC;
    globalThis.Date = MockDate;

    let capturedSleepMs: number | undefined;
    try {
      const mockUsageMonitor = { poll: vi.fn().mockResolvedValue(makeSnapshot()) };
      const mockTriggerEngine = {
        evaluate: vi.fn().mockReturnValue(makeTriggerResult(false)),
        resetDispatchState: vi.fn(),
      };
      const mockAdapter = makeDispatchAdapter(async () => null);

      // After poll + trigger eval, advance time by 3 minutes
      mockUsageMonitor.poll.mockImplementation(async () => {
        // Advance time to simulate a slow poll/evaluate phase
        currentTime = fakeNow + cycleElapsedMs;
        return makeSnapshot();
      });

      sleepMock.mockImplementation(async (ms: unknown) => {
        capturedSleepMs = ms as number;
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      });

      const { PollingLoop } = await import('./polling-loop.js');
      const loop = new PollingLoop({
        usageMonitor: mockUsageMonitor as never,
        triggerEngine: mockTriggerEngine as never,
        dispatchAdapter: mockAdapter,
        getConfig: () => makeConfig({ pollingInterval: intervalSeconds }),
        startedAt: new Date(fakeNow).toISOString(),
      });

      await loop.start();
    } finally {
      // Always restore Date even if loop.start() throws or an assertion fails
      globalThis.Date = OrigDate;
      dateNowSpy.mockRestore();
    }

    // The compensated sleep should be exactly intervalMs - elapsed = 300000 - 180000 = 120000ms.
    // Upper-bound: must be strictly less than the full intervalMs (compensation applied).
    // Lower-bound: must be > 0 (cycle did not exceed the interval) and close to expectedSleepMs
    // to catch regressions where compensation over-subtracts or uses the wrong elapsed value.
    expect(capturedSleepMs).toBeDefined();
    expect(capturedSleepMs!).toBeGreaterThan(0);
    expect(capturedSleepMs!).toBeGreaterThanOrEqual(expectedSleepMs - 1); // ±1ms tolerance for wall-clock jitter
    expect(capturedSleepMs!).toBeLessThanOrEqual(expectedSleepMs);
    // It should not be the full intervalMs
    expect(capturedSleepMs!).toBeLessThan(intervalMs);
  });

  it('skips sleep entirely when cycle duration exceeds intervalMs (AC2)', async () => {
    const sleepMock = vi.mocked((await import('node:timers/promises')).setTimeout);
    const writeCycleStatusMock = vi.mocked((await import('./state-writer.js')).writeCycleStatus);

    // Simulate a cycle that takes 10 minutes with a 5-minute interval
    const intervalSeconds = 300; // 5 minutes
    const fakeNow = new Date('2026-03-01T12:00:00.000Z').getTime();
    const cycleElapsedMs = 600_000; // 10 minutes — exceeds the 5 minute interval

    let currentTime = fakeNow;
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => currentTime);

    const OrigDate = globalThis.Date;
    const MockDate = class extends OrigDate {
      constructor(...args: Parameters<DateConstructor>) {
        if (args.length === 0) {
          super(currentTime);
        } else {
          super(...(args as unknown as [number]));
        }
      }
    } as DateConstructor;
    MockDate.now = () => currentTime;
    MockDate.parse = OrigDate.parse;
    MockDate.UTC = OrigDate.UTC;
    globalThis.Date = MockDate;

    let endCycleCalls: typeof writeCycleStatusMock.mock.calls;
    try {
      const mockUsageMonitor = { poll: vi.fn().mockResolvedValue(makeSnapshot()) };
      const mockTriggerEngine = {
        evaluate: vi.fn().mockReturnValue(makeTriggerResult(true)),
        resetDispatchState: vi.fn(),
      };

      const { PollingLoop } = await import('./polling-loop.js');
      let loopRef: InstanceType<typeof PollingLoop> | null = null;

      // Dispatch advances time past the interval, then stops the loop
      const mockAdapter = makeDispatchAdapter(async () => {
        currentTime = fakeNow + cycleElapsedMs;
        // Schedule stop so the while-check at top of next iteration sees aborted
        void loopRef?.stop();
        return makeCycleResult();
      });

      // If sleep IS called (it should not be), track it
      sleepMock.mockImplementation(async () => {
        // Sleep should not be called since cycle exceeded interval
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      });

      loopRef = new PollingLoop({
        usageMonitor: mockUsageMonitor as never,
        triggerEngine: mockTriggerEngine as never,
        dispatchAdapter: mockAdapter,
        getConfig: () => makeConfig({ pollingInterval: intervalSeconds }),
        startedAt: new Date(fakeNow).toISOString(),
      });

      await loopRef.start();
      endCycleCalls = writeCycleStatusMock.mock.calls.filter((call) => {
        const arg = call[0] as Record<string, unknown>;
        return arg['trigger'] !== null && arg['cycleResult'] !== null;
      });
    } finally {
      // Always restore Date even if loop.start() throws or an assertion fails
      globalThis.Date = OrigDate;
      dateNowSpy.mockRestore();
    }

    // The end-of-cycle sleep should have been skipped entirely because
    // compensatedSleepMs = max(0, 300000 - 600000) = 0.
    // Sleep should not have been called at all for this cycle.
    expect(sleepMock).not.toHaveBeenCalled();

    // Verify the end-of-cycle write has nextPollAt at "now" (not stale)
    expect(endCycleCalls!.length).toBeGreaterThan(0);
    const nextPollAt = (endCycleCalls![0]![0] as Record<string, unknown>)['nextPollAt'] as string;
    const nextPollTime = new Date(nextPollAt).getTime();
    // nextPollAt should be at dispatch completion time, not cycleStart + intervalMs
    expect(nextPollTime).toBeGreaterThanOrEqual(fakeNow + cycleElapsedMs);
  });

  it('mid-cycle writes use now() + intervalMs for informational nextPollAt (AC3)', async () => {
    const writeCycleStatusMock = vi.mocked((await import('./state-writer.js')).writeCycleStatus);
    const sleepMock = vi.mocked((await import('node:timers/promises')).setTimeout);

    const intervalSeconds = 300; // 5 minutes = 300_000ms
    const intervalMs = intervalSeconds * 1000;
    const fakeNow = new Date('2026-03-01T12:00:00.000Z').getTime();
    // onTaskStart fires at T+5min, so mid-cycle nextPollAt = T+5min + 5min = T+10min
    const taskStartTime = fakeNow + 300_000;
    const expectedTaskStartNextPollAt = taskStartTime + intervalMs; // fakeNow + 600_000
    // onTaskComplete fires at T+7min, so mid-cycle nextPollAt = T+7min + 5min = T+12min
    const taskCompleteTime = fakeNow + 420_000;
    const expectedTaskCompleteNextPollAt = taskCompleteTime + intervalMs; // fakeNow + 720_000

    let currentTime = fakeNow;
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => currentTime);

    const OrigDate = globalThis.Date;
    const MockDate = class extends OrigDate {
      constructor(...args: Parameters<DateConstructor>) {
        if (args.length === 0) {
          super(currentTime);
        } else {
          super(...(args as unknown as [number]));
        }
      }
    } as DateConstructor;
    MockDate.now = () => currentTime;
    MockDate.parse = OrigDate.parse;
    MockDate.UTC = OrigDate.UTC;
    globalThis.Date = MockDate;

    let taskStartCalls: typeof writeCycleStatusMock.mock.calls;
    let taskCompleteCalls: typeof writeCycleStatusMock.mock.calls;
    try {
      const testTask = makeTestTask('mid-cycle-1');
      const fakeResult = {
        taskId: testTask.id,
        status: 'done' as const,
        startedAt: new Date(),
        completedAt: new Date(),
        durationMs: 100,
        stdout: '',
        stderr: '',
        exitCode: 0,
        error: null,
        errorCode: null,
      };

      // Dispatch advances time by 7 minutes (past interval), calling callbacks mid-dispatch
      const adapter = makeDispatchAdapter(async (_t, opts) => {
        // 5 minutes into dispatch
        currentTime = taskStartTime;
        if (opts?.onTaskStart) await opts.onTaskStart(testTask);

        // 7 minutes into dispatch (past interval)
        currentTime = taskCompleteTime;
        if (opts?.onTaskComplete) await opts.onTaskComplete(testTask, fakeResult);

        return makeCycleResult();
      });

      const mockUsageMonitor = { poll: vi.fn().mockResolvedValue(makeSnapshot()) };
      const mockTriggerEngine = {
        evaluate: vi.fn().mockReturnValue(makeTriggerResult(true)),
        resetDispatchState: vi.fn(),
      };

      sleepMock.mockImplementation(async () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      });

      const { PollingLoop } = await import('./polling-loop.js');
      const loop = new PollingLoop({
        usageMonitor: mockUsageMonitor as never,
        triggerEngine: mockTriggerEngine as never,
        dispatchAdapter: adapter,
        getConfig: () => makeConfig({ pollingInterval: intervalSeconds }),
        startedAt: new Date(fakeNow).toISOString(),
      });

      await loop.start();

      // Find the onTaskStart write (has non-null activeTask)
      taskStartCalls = writeCycleStatusMock.mock.calls.filter((call) => {
        const arg = call[0] as Record<string, unknown>;
        return arg['activeTask'] !== null && arg['activeTask'] !== undefined;
      });

      // Find the onTaskComplete write (has cycleResult with tasksAttempted >= 1 and activeTask null)
      taskCompleteCalls = writeCycleStatusMock.mock.calls.filter((call) => {
        const arg = call[0] as Record<string, unknown>;
        const cr = arg['cycleResult'] as Record<string, unknown> | null;
        return cr !== null && cr !== undefined && (cr['tasksAttempted'] as number) >= 1;
      });
    } finally {
      // Always restore Date even if loop.start() throws or an assertion fails
      globalThis.Date = OrigDate;
      dateNowSpy.mockRestore();
    }

    expect(taskStartCalls!.length).toBeGreaterThan(0);
    const taskStartNextPollAt = (taskStartCalls![0]![0] as Record<string, unknown>)[
      'nextPollAt'
    ] as string;
    const taskStartNextPollTime = new Date(taskStartNextPollAt).getTime();
    // Mid-cycle nextPollAt at T+5min should be now() + intervalMs = T+5min + 5min = T+10min.
    // The lower bound is strict: a broken implementation returning the dispatch start time
    // (fakeNow) would fail because expectedTaskStartNextPollAt = fakeNow + 600_000 > fakeNow.
    expect(taskStartNextPollTime).toBeGreaterThanOrEqual(expectedTaskStartNextPollAt);

    expect(taskCompleteCalls!.length).toBeGreaterThan(0);
    const taskCompleteNextPollAt = (taskCompleteCalls![0]![0] as Record<string, unknown>)[
      'nextPollAt'
    ] as string;
    const taskCompleteNextPollTime = new Date(taskCompleteNextPollAt).getTime();
    // Mid-cycle nextPollAt at T+7min should be now() + intervalMs = T+7min + 5min = T+12min.
    expect(taskCompleteNextPollTime).toBeGreaterThanOrEqual(expectedTaskCompleteNextPollAt);
  });

  it('error-path nextPollAt uses wall-clock time after a long poll failure (AC4)', async () => {
    // Verifies that the poll-failed catch block uses compensated nextPollAt (computeNextPollAt),
    // not the stale cycleStart + intervalMs formula.
    const writeCycleStatusMock = vi.mocked((await import('./state-writer.js')).writeCycleStatus);
    const sleepMock = vi.mocked((await import('node:timers/promises')).setTimeout);

    const intervalSeconds = 300; // 5 minutes = 300_000ms
    const intervalMs = intervalSeconds * 1000;
    const fakeNow = new Date('2026-03-01T12:00:00.000Z').getTime();
    // Simulate poll taking 10 minutes — longer than the interval
    const pollElapsedMs = 600_000;

    let currentTime = fakeNow;
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => currentTime);

    const OrigDate = globalThis.Date;
    const MockDate = class extends OrigDate {
      constructor(...args: Parameters<DateConstructor>) {
        if (args.length === 0) {
          super(currentTime);
        } else {
          super(...(args as unknown as [number]));
        }
      }
    } as DateConstructor;
    MockDate.now = () => currentTime;
    MockDate.parse = OrigDate.parse;
    MockDate.UTC = OrigDate.UTC;
    globalThis.Date = MockDate;

    let pollFailCalls: typeof writeCycleStatusMock.mock.calls;
    try {
      // Poll fails after 10 minutes — advance time RELATIVE to current to simulate wall-clock
      // progression across multiple calls. The first call advances by pollElapsedMs; subsequent
      // calls abort the loop via sleep so only one poll-failed status write is relevant.
      const mockUsageMonitor = {
        poll: vi.fn().mockImplementation(async () => {
          currentTime += pollElapsedMs;
          throw new Error('simulated poll failure after long delay');
        }),
      };
      const mockTriggerEngine = {
        evaluate: vi.fn(),
        resetDispatchState: vi.fn(),
      };
      const mockAdapter = makeDispatchAdapter(async () => null);

      // On the first (and only relevant) sleep call — which only happens when sleepMs > 0 —
      // abort the loop. If sleepMs = 0 the loop continues, so we also abort after the first
      // poll by stopping the loop after it writes status. Using a counter to stop after 1 cycle.
      const { PollingLoop } = await import('./polling-loop.js');
      let loopRef: InstanceType<typeof PollingLoop> | null = null;
      let pollCalls = 0;
      mockUsageMonitor.poll.mockImplementation(async () => {
        pollCalls += 1;
        currentTime += pollElapsedMs;
        const err = new Error('simulated poll failure after long delay');
        // After first poll failure, schedule loop stop so we only exercise one error cycle
        if (pollCalls === 1) {
          void loopRef?.stop();
        }
        throw err;
      });

      sleepMock.mockImplementation(async () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      });

      loopRef = new PollingLoop({
        usageMonitor: mockUsageMonitor as never,
        triggerEngine: mockTriggerEngine as never,
        dispatchAdapter: mockAdapter,
        getConfig: () => makeConfig({ pollingInterval: intervalSeconds }),
        startedAt: new Date(fakeNow).toISOString(),
      });

      await loopRef.start();

      // The poll-failed path writes status with trigger: null and usage: null
      pollFailCalls = writeCycleStatusMock.mock.calls.filter((call) => {
        const arg = call[0] as Record<string, unknown>;
        return arg['trigger'] === null && arg['usage'] === null;
      });
    } finally {
      globalThis.Date = OrigDate;
      dateNowSpy.mockRestore();
    }

    expect(pollFailCalls!.length).toBeGreaterThan(0);
    const firstPollFailArg = pollFailCalls![0]![0] as Record<string, unknown>;
    const nextPollAt = firstPollFailArg['nextPollAt'] as string;
    const nextPollTime = new Date(nextPollAt).getTime();

    // After a 10-minute poll with a 5-minute interval:
    // - Stale formula: cycleStart + intervalMs = fakeNow + 300_000 (10 min in the past by poll end)
    // - Correct formula: now (sleepMs clamped to 0 since elapsed > interval)
    // nextPollAt must be >= poll completion time (fakeNow + pollElapsedMs), not the stale past value.
    const pollCompletionTime = fakeNow + pollElapsedMs;
    expect(nextPollTime).toBeGreaterThanOrEqual(pollCompletionTime);
    // Sanity: nextPollAt must be strictly after the stale cycleStart + intervalMs value
    expect(nextPollTime).toBeGreaterThan(fakeNow + intervalMs);
  });
});

// ─── Backend state integration (Story 12.5) ───────────────────────────────
describe('PollingLoop — backend state integration (Story 12.5)', () => {
  let mockUsageMonitor: { poll: ReturnType<typeof vi.fn> };
  let mockTriggerEngine: {
    evaluate: ReturnType<typeof vi.fn>;
    resetDispatchState: ReturnType<typeof vi.fn>;
  };
  let mockDispatchAdapter: DispatchAdapter & { dispatchIfTriggered: ReturnType<typeof vi.fn> };
  let writeCycleStatusMock: ReturnType<typeof vi.fn>;
  let sleepMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockUsageMonitor = { poll: vi.fn().mockResolvedValue(makeSnapshot()) };
    mockTriggerEngine = {
      evaluate: vi.fn().mockReturnValue(makeTriggerResult(false)),
      resetDispatchState: vi.fn(),
    };
    mockDispatchAdapter = makeDispatchAdapter(async () => null);

    const stateWriter = await import('./state-writer.js');
    writeCycleStatusMock = vi.mocked(stateWriter.writeCycleStatus);

    const timers = await import('node:timers/promises');
    sleepMock = vi.mocked(timers.setTimeout);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips dispatch when checkBackendAvailable returns false (strict mode unavailable)', async () => {
    mockTriggerEngine.evaluate.mockReturnValue(makeTriggerResult(true));
    const cycleResult = makeCycleResult();
    mockDispatchAdapter.dispatchIfTriggered.mockResolvedValue(cycleResult);

    // checkBackendAvailable returns false — runtime unavailable, strict mode
    const checkBackendAvailable = vi.fn().mockResolvedValue(false);
    const backendState = {
      name: 'container',
      runtime: 'docker',
      version: '27.1.0',
      available: false,
    };
    const getBackendState = vi.fn().mockResolvedValue(backendState);

    sleepMock.mockImplementation(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    const { PollingLoop } = await import('./polling-loop.js');
    const loop = new PollingLoop({
      usageMonitor: mockUsageMonitor as never,
      triggerEngine: mockTriggerEngine as never,
      dispatchAdapter: mockDispatchAdapter,
      getConfig: () => makeConfig(),
      startedAt: new Date().toISOString(),
      checkBackendAvailable,
      getBackendState,
    });

    await loop.start();

    // Dispatch must NOT have been called
    expect(mockDispatchAdapter.dispatchIfTriggered).not.toHaveBeenCalled();
    // writeCycleStatus must include backendState from getBackendState
    expect(writeCycleStatusMock).toHaveBeenCalledWith(expect.objectContaining({ backendState }));
  });

  it('proceeds with dispatch when checkBackendAvailable returns true even if getBackendState.available is false (fallback-direct fix, High-2)', async () => {
    // High-2 correctness fix: in fallback-direct mode, getBackendState().available is false
    // (because _previouslyUnavailable = true) but available() returns true. The gate must use
    // checkBackendAvailable (available()) not getBackendState().available.
    mockTriggerEngine.evaluate.mockReturnValue(makeTriggerResult(true));
    const cycleResult = makeCycleResult();
    mockDispatchAdapter.dispatchIfTriggered.mockResolvedValue(cycleResult);

    // checkBackendAvailable returns true — fallback is active, dispatch should proceed
    const checkBackendAvailable = vi.fn().mockResolvedValue(true);
    // getBackendState reports available: false (as the old buggy code would return)
    const backendState = {
      name: 'container',
      runtime: 'docker',
      version: '27.1.0',
      available: false, // stale _previouslyUnavailable state — should NOT gate dispatch
    };
    const getBackendState = vi.fn().mockResolvedValue(backendState);

    sleepMock.mockImplementation(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    const { PollingLoop } = await import('./polling-loop.js');
    const loop = new PollingLoop({
      usageMonitor: mockUsageMonitor as never,
      triggerEngine: mockTriggerEngine as never,
      dispatchAdapter: mockDispatchAdapter,
      getConfig: () => makeConfig(),
      startedAt: new Date().toISOString(),
      checkBackendAvailable,
      getBackendState,
    });

    await loop.start();

    // Dispatch MUST have been called — fallback-direct allows dispatch even when runtime is down
    expect(mockDispatchAdapter.dispatchIfTriggered).toHaveBeenCalledTimes(1);
  });

  it('proceeds with dispatch when checkBackendAvailable returns true (container available)', async () => {
    mockTriggerEngine.evaluate.mockReturnValue(makeTriggerResult(true));
    const cycleResult = makeCycleResult();
    mockDispatchAdapter.dispatchIfTriggered.mockResolvedValue(cycleResult);

    // checkBackendAvailable returns true — runtime available, dispatch should proceed
    const checkBackendAvailable = vi.fn().mockResolvedValue(true);
    const backendState = {
      name: 'container',
      runtime: 'docker',
      version: '27.1.0',
      available: true,
    };
    const getBackendState = vi.fn().mockResolvedValue(backendState);

    sleepMock.mockImplementation(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    const { PollingLoop } = await import('./polling-loop.js');
    const loop = new PollingLoop({
      usageMonitor: mockUsageMonitor as never,
      triggerEngine: mockTriggerEngine as never,
      dispatchAdapter: mockDispatchAdapter,
      getConfig: () => makeConfig(),
      startedAt: new Date().toISOString(),
      checkBackendAvailable,
      getBackendState,
    });

    await loop.start();

    // Dispatch must have been called
    expect(mockDispatchAdapter.dispatchIfTriggered).toHaveBeenCalledTimes(1);
    // End-of-cycle writeCycleStatus must include backendState
    expect(writeCycleStatusMock).toHaveBeenCalledWith(expect.objectContaining({ backendState }));
  });

  it('skips dispatch when checkBackendAvailable throws (exception safety)', async () => {
    // High-1 fix: the fresh probe is performed by checkBackendAvailable, not getBackendState.
    // When checkBackendAvailable throws (e.g., runtime binary exec failure), dispatch is skipped.
    mockTriggerEngine.evaluate.mockReturnValue(makeTriggerResult(true));
    const cycleResult = makeCycleResult();
    mockDispatchAdapter.dispatchIfTriggered.mockResolvedValue(cycleResult);

    // checkBackendAvailable throws — simulates a runtime probe failure
    const checkBackendAvailable = vi.fn().mockRejectedValue(new Error('docker daemon not running'));
    // getBackendState still succeeds (used only for status write)
    const getBackendState = vi.fn().mockResolvedValue(null);

    sleepMock.mockImplementation(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    const { PollingLoop } = await import('./polling-loop.js');
    const loop = new PollingLoop({
      usageMonitor: mockUsageMonitor as never,
      triggerEngine: mockTriggerEngine as never,
      dispatchAdapter: mockDispatchAdapter,
      getConfig: () => makeConfig(),
      startedAt: new Date().toISOString(),
      checkBackendAvailable,
      getBackendState,
    });

    await loop.start();

    // Dispatch skipped due to availability probe exception
    expect(mockDispatchAdapter.dispatchIfTriggered).not.toHaveBeenCalled();
    // writeCycleStatus must include backendState: null (getBackendState returned null)
    expect(writeCycleStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({ backendState: null }),
    );
  });

  it('proceeds normally when getBackendState is not provided (backward compatibility)', async () => {
    mockTriggerEngine.evaluate.mockReturnValue(makeTriggerResult(true));
    const cycleResult = makeCycleResult();
    mockDispatchAdapter.dispatchIfTriggered.mockResolvedValue(cycleResult);

    sleepMock.mockImplementation(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    const { PollingLoop } = await import('./polling-loop.js');
    const loop = new PollingLoop({
      usageMonitor: mockUsageMonitor as never,
      triggerEngine: mockTriggerEngine as never,
      dispatchAdapter: mockDispatchAdapter,
      getConfig: () => makeConfig(),
      startedAt: new Date().toISOString(),
      // No getBackendState provided
    });

    await loop.start();

    // Dispatch must proceed normally
    expect(mockDispatchAdapter.dispatchIfTriggered).toHaveBeenCalledTimes(1);
  });

  it('writes backendState: null in end-of-cycle status when getBackendState is not provided', async () => {
    mockTriggerEngine.evaluate.mockReturnValue(makeTriggerResult(false));

    sleepMock.mockImplementation(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    const { PollingLoop } = await import('./polling-loop.js');
    const loop = new PollingLoop({
      usageMonitor: mockUsageMonitor as never,
      triggerEngine: mockTriggerEngine as never,
      dispatchAdapter: mockDispatchAdapter,
      getConfig: () => makeConfig(),
      startedAt: new Date().toISOString(),
      // No getBackendState provided
    });

    await loop.start();

    // End-of-cycle status write must include backendState (null since no provider)
    expect(writeCycleStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({ backendState: null }),
    );
  });

  it('resets dispatch state when backend is unavailable and trigger fires', async () => {
    mockTriggerEngine.evaluate.mockReturnValue(makeTriggerResult(true));

    // checkBackendAvailable returns false to trigger the skip path
    const checkBackendAvailable = vi.fn().mockResolvedValue(false);
    const backendState = {
      name: 'container',
      runtime: null,
      version: null,
      available: false,
    };
    const getBackendState = vi.fn().mockResolvedValue(backendState);

    sleepMock.mockImplementation(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    const { PollingLoop } = await import('./polling-loop.js');
    const loop = new PollingLoop({
      usageMonitor: mockUsageMonitor as never,
      triggerEngine: mockTriggerEngine as never,
      dispatchAdapter: mockDispatchAdapter,
      getConfig: () => makeConfig(),
      startedAt: new Date().toISOString(),
      checkBackendAvailable,
      getBackendState,
    });

    await loop.start();

    expect(mockTriggerEngine.resetDispatchState).toHaveBeenCalled();
  });
});

// Story 14.4: Decouple backend availability probe from dispatch trigger
describe('PollingLoop — decoupled backend availability probe (Story 14.4)', () => {
  let mockUsageMonitor: { poll: ReturnType<typeof vi.fn> };
  let mockTriggerEngine: {
    evaluate: ReturnType<typeof vi.fn>;
    resetDispatchState: ReturnType<typeof vi.fn>;
  };
  let mockDispatchAdapter: DispatchAdapter & { dispatchIfTriggered: ReturnType<typeof vi.fn> };
  let writeCycleStatusMock: ReturnType<typeof vi.fn>;
  let sleepMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    mockUsageMonitor = { poll: vi.fn().mockResolvedValue(makeSnapshot()) };
    mockTriggerEngine = {
      evaluate: vi.fn().mockReturnValue(makeTriggerResult(false)),
      resetDispatchState: vi.fn(),
    };
    mockDispatchAdapter = makeDispatchAdapter(async () => null);

    const stateWriter = await import('./state-writer.js');
    writeCycleStatusMock = vi.mocked(stateWriter.writeCycleStatus);

    const timers = await import('node:timers/promises');
    sleepMock = vi.mocked(timers.setTimeout);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes accurate backendState when shouldDispatch is false (AC1)', async () => {
    // Trigger says shouldDispatch: false — but getBackendState should still be called
    // and its result included in the status write.
    mockTriggerEngine.evaluate.mockReturnValue(makeTriggerResult(false));

    const backendState = {
      name: 'container',
      runtime: 'docker',
      version: '27.1.0',
      available: true,
    };
    const getBackendState = vi.fn().mockResolvedValue(backendState);

    sleepMock.mockImplementation(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    const { PollingLoop } = await import('./polling-loop.js');
    const loop = new PollingLoop({
      usageMonitor: mockUsageMonitor as never,
      triggerEngine: mockTriggerEngine as never,
      dispatchAdapter: mockDispatchAdapter,
      getConfig: () => makeConfig(),
      startedAt: new Date().toISOString(),
      getBackendState,
    });

    await loop.start();

    // getBackendState must have been called even though shouldDispatch is false
    expect(getBackendState).toHaveBeenCalled();
    // writeCycleStatus must include the backendState
    expect(writeCycleStatusMock).toHaveBeenCalledWith(expect.objectContaining({ backendState }));
  });

  it('writes backendState on poll-failure path (AC3)', async () => {
    // Make poll fail
    mockUsageMonitor.poll.mockRejectedValue(new Error('network error'));

    const backendState = {
      name: 'container',
      runtime: 'podman',
      version: '5.0.0',
      available: true,
    };
    const getBackendState = vi.fn().mockResolvedValue(backendState);

    sleepMock.mockImplementation(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    const { PollingLoop } = await import('./polling-loop.js');
    const loop = new PollingLoop({
      usageMonitor: mockUsageMonitor as never,
      triggerEngine: mockTriggerEngine as never,
      dispatchAdapter: mockDispatchAdapter,
      getConfig: () => makeConfig(),
      startedAt: new Date().toISOString(),
      getBackendState,
    });

    await loop.start();

    // writeCycleStatus on poll-failure path must include backendState (not null/undefined)
    expect(getBackendState).toHaveBeenCalled();
    expect(writeCycleStatusMock).toHaveBeenCalledWith(expect.objectContaining({ backendState }));
  });

  it('writes backendState on trigger-failure path (AC3)', async () => {
    // Make trigger evaluation throw
    mockTriggerEngine.evaluate.mockImplementation(() => {
      throw new Error('trigger evaluation failed');
    });

    const backendState = {
      name: 'container',
      runtime: 'docker',
      version: '27.1.0',
      available: false,
    };
    const getBackendState = vi.fn().mockResolvedValue(backendState);

    sleepMock.mockImplementation(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    const { PollingLoop } = await import('./polling-loop.js');
    const loop = new PollingLoop({
      usageMonitor: mockUsageMonitor as never,
      triggerEngine: mockTriggerEngine as never,
      dispatchAdapter: mockDispatchAdapter,
      getConfig: () => makeConfig(),
      startedAt: new Date().toISOString(),
      getBackendState,
    });

    await loop.start();

    // writeCycleStatus on trigger-failure path must include backendState (not null/undefined)
    expect(getBackendState).toHaveBeenCalled();
    expect(writeCycleStatusMock).toHaveBeenCalledWith(expect.objectContaining({ backendState }));
  });

  it('still skips dispatch when shouldDispatch is true and backend is unavailable (AC5 regression)', async () => {
    mockTriggerEngine.evaluate.mockReturnValue(makeTriggerResult(true));
    const cycleResult = makeCycleResult();
    mockDispatchAdapter.dispatchIfTriggered.mockResolvedValue(cycleResult);

    const checkBackendAvailable = vi.fn().mockResolvedValue(false);
    const backendState = {
      name: 'container',
      runtime: 'docker',
      version: '27.1.0',
      available: false,
    };
    const getBackendState = vi.fn().mockResolvedValue(backendState);

    sleepMock.mockImplementation(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    const { PollingLoop } = await import('./polling-loop.js');
    const loop = new PollingLoop({
      usageMonitor: mockUsageMonitor as never,
      triggerEngine: mockTriggerEngine as never,
      dispatchAdapter: mockDispatchAdapter,
      getConfig: () => makeConfig(),
      startedAt: new Date().toISOString(),
      checkBackendAvailable,
      getBackendState,
    });

    await loop.start();

    // Dispatch must NOT have been called — backend unavailable
    expect(mockDispatchAdapter.dispatchIfTriggered).not.toHaveBeenCalled();
    // But backendState must still be written
    expect(writeCycleStatusMock).toHaveBeenCalledWith(expect.objectContaining({ backendState }));
    // Dispatch state must be reset
    expect(mockTriggerEngine.resetDispatchState).toHaveBeenCalled();
  });

  it('writes backendState: null on poll-failure path when getBackendState is not provided', async () => {
    // Make poll fail
    mockUsageMonitor.poll.mockRejectedValue(new Error('network error'));

    sleepMock.mockImplementation(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    const { PollingLoop } = await import('./polling-loop.js');
    const loop = new PollingLoop({
      usageMonitor: mockUsageMonitor as never,
      triggerEngine: mockTriggerEngine as never,
      dispatchAdapter: mockDispatchAdapter,
      getConfig: () => makeConfig(),
      startedAt: new Date().toISOString(),
      // No getBackendState provided
    });

    await loop.start();

    // writeCycleStatus must include backendState: null (not undefined/missing)
    expect(writeCycleStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({ backendState: null }),
    );
  });

  it('writes backendState: null on trigger-failure path when getBackendState is not provided', async () => {
    // Make trigger evaluation throw
    mockTriggerEngine.evaluate.mockImplementation(() => {
      throw new Error('trigger evaluation failed');
    });

    sleepMock.mockImplementation(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    const { PollingLoop } = await import('./polling-loop.js');
    const loop = new PollingLoop({
      usageMonitor: mockUsageMonitor as never,
      triggerEngine: mockTriggerEngine as never,
      dispatchAdapter: mockDispatchAdapter,
      getConfig: () => makeConfig(),
      startedAt: new Date().toISOString(),
      // No getBackendState provided
    });

    await loop.start();

    // writeCycleStatus must include backendState: null (not undefined/missing)
    expect(writeCycleStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({ backendState: null }),
    );
  });
});

// Story 14.2: Interrupt active sleep on polling interval hot-reload
describe('PollingLoop — sleep interruption on interval hot-reload (Story 14.2)', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('interrupts sleep when polling interval decreases via reload (AC1)', async () => {
    const sleepMock = vi.mocked((await import('node:timers/promises')).setTimeout);

    // Track sleep calls and their durations to verify interrupt + reschedule behavior.
    const sleepDurations: number[] = [];
    let sleepCallCount = 0;

    // Config starts at 300s (5 min), will be reloaded to 60s during sleep.
    let currentConfig = makeConfig({ pollingInterval: 300 });

    const { PollingLoop } = await import('./polling-loop.js');
    const adapter = makeDispatchAdapter(async () => null);

    const loop = new PollingLoop({
      usageMonitor: { poll: vi.fn().mockResolvedValue(makeSnapshot()) } as never,
      triggerEngine: {
        evaluate: vi.fn().mockReturnValue(makeTriggerResult(false)),
        resetDispatchState: vi.fn(),
      } as never,
      dispatchAdapter: adapter,
      getConfig: () => currentConfig,
      startedAt: new Date().toISOString(),
    });

    sleepMock.mockImplementation(async (ms?: number) => {
      sleepCallCount++;
      sleepDurations.push(ms as number);

      if (sleepCallCount === 1) {
        // First sleep call — simulate reload with shorter interval.
        // This triggers the _reloadInterruptPending path.
        const newConfig = makeConfig({ pollingInterval: 60 });
        currentConfig = newConfig;
        loop.reload(newConfig);
        // The reload aborted the sleep controller, which throws AbortError.
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }

      if (sleepCallCount === 2) {
        // Second sleep (rescheduled) — exit the loop.
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
    });

    await loop.start();

    // First sleep should be based on old interval (~300_000ms).
    expect(sleepDurations[0]).toBeGreaterThanOrEqual(295_000);
    // Second sleep should be based on new interval (~60_000ms), minus any elapsed time.
    // Since the test mock returns instantly (no real time passes), remaining should be ~60_000ms.
    // Lower-bound check ensures a broken 0ms reschedule (skipped by while guard) cannot pass.
    expect(sleepDurations[1]).toBeGreaterThan(0);
    expect(sleepDurations[1]).toBeLessThanOrEqual(60_000);
    expect(sleepCallCount).toBe(2);
  });

  it('does not interrupt sleep when polling interval increases (AC2)', async () => {
    const sleepMock = vi.mocked((await import('node:timers/promises')).setTimeout);

    let sleepCallCount = 0;
    let currentConfig = makeConfig({ pollingInterval: 60 });

    const { PollingLoop } = await import('./polling-loop.js');
    const adapter = makeDispatchAdapter(async () => null);

    const loop = new PollingLoop({
      usageMonitor: { poll: vi.fn().mockResolvedValue(makeSnapshot()) } as never,
      triggerEngine: {
        evaluate: vi.fn().mockReturnValue(makeTriggerResult(false)),
        resetDispatchState: vi.fn(),
      } as never,
      dispatchAdapter: adapter,
      getConfig: () => currentConfig,
      startedAt: new Date().toISOString(),
    });

    sleepMock.mockImplementation(async () => {
      sleepCallCount++;

      if (sleepCallCount === 1) {
        // During first sleep, reload with LARGER interval — should NOT interrupt.
        const newConfig = makeConfig({ pollingInterval: 300 });
        currentConfig = newConfig;
        loop.reload(newConfig);
        // Sleep should continue normally (resolve without error).
        return;
      }

      // Second cycle's sleep — exit.
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    await loop.start();

    // The sleep should have continued normally (no rescheduling).
    // Two sleep calls: first completed normally, second aborted to exit.
    expect(sleepCallCount).toBe(2);
  });

  it('does not interrupt sleep when polling interval stays the same (AC2)', async () => {
    const sleepMock = vi.mocked((await import('node:timers/promises')).setTimeout);

    let sleepCallCount = 0;
    let currentConfig = makeConfig({ pollingInterval: 60 });

    const { PollingLoop } = await import('./polling-loop.js');
    const adapter = makeDispatchAdapter(async () => null);

    const loop = new PollingLoop({
      usageMonitor: { poll: vi.fn().mockResolvedValue(makeSnapshot()) } as never,
      triggerEngine: {
        evaluate: vi.fn().mockReturnValue(makeTriggerResult(false)),
        resetDispatchState: vi.fn(),
      } as never,
      dispatchAdapter: adapter,
      getConfig: () => currentConfig,
      startedAt: new Date().toISOString(),
    });

    sleepMock.mockImplementation(async () => {
      sleepCallCount++;

      if (sleepCallCount === 1) {
        // Reload with same interval — should NOT interrupt.
        const newConfig = makeConfig({ pollingInterval: 60 });
        currentConfig = newConfig;
        loop.reload(newConfig);
        return;
      }

      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    await loop.start();

    expect(sleepCallCount).toBe(2);
  });

  it('computes correct remaining duration for rescheduled sleep (AC1)', async () => {
    const sleepMock = vi.mocked((await import('node:timers/promises')).setTimeout);

    const sleepDurations: number[] = [];
    let sleepCallCount = 0;
    let currentConfig = makeConfig({ pollingInterval: 300 });

    // Control time to verify remaining calculation.
    const fakeNow = new Date('2026-03-05T12:00:00.000Z').getTime();
    let currentTime = fakeNow;
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => currentTime);

    // Also mock new Date() to use our controlled time (same pattern as stale-nextPollAt tests).
    const OrigDate = globalThis.Date;
    const MockDate = class extends OrigDate {
      constructor(...args: Parameters<DateConstructor>) {
        if (args.length === 0) {
          super(currentTime);
        } else {
          super(...(args as unknown as [number]));
        }
      }
    } as DateConstructor;
    MockDate.now = () => currentTime;
    MockDate.parse = OrigDate.parse;
    MockDate.UTC = OrigDate.UTC;
    globalThis.Date = MockDate;

    try {
      const { PollingLoop } = await import('./polling-loop.js');
      const adapter = makeDispatchAdapter(async () => null);

      const loop = new PollingLoop({
        usageMonitor: { poll: vi.fn().mockResolvedValue(makeSnapshot()) } as never,
        triggerEngine: {
          evaluate: vi.fn().mockReturnValue(makeTriggerResult(false)),
          resetDispatchState: vi.fn(),
        } as never,
        dispatchAdapter: adapter,
        getConfig: () => currentConfig,
        startedAt: new OrigDate(fakeNow).toISOString(),
      });

      sleepMock.mockImplementation(async (ms?: number) => {
        sleepCallCount++;
        sleepDurations.push(ms as number);

        if (sleepCallCount === 1) {
          // Simulate 20 seconds elapsed during the first sleep before reload.
          currentTime = fakeNow + 20_000;

          // Reload with 60s interval. Elapsed is 20s, so remaining should be 40s.
          const newConfig = makeConfig({ pollingInterval: 60 });
          currentConfig = newConfig;
          loop.reload(newConfig);

          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }

        // Second sleep — exit.
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      });

      await loop.start();
    } finally {
      globalThis.Date = OrigDate;
      dateNowSpy.mockRestore();
    }

    // First sleep: based on 300s interval (300_000ms, since cycle is instant in mocked time).
    expect(sleepDurations[0]).toBe(300_000);
    // Second sleep: newInterval(60_000) - elapsed(20_000) = 40_000ms.
    expect(sleepDurations[1]).toBe(40_000);
  });

  it('runs exactly one poll cycle after sleep interruption — no double-poll (AC3, Story 21.1)', async () => {
    // AC3: When a config reload interrupts the sleep between polls, the loop must fire
    // exactly one poll on the next cycle — never two. Also asserts that triggerEngine.evaluate
    // is called once per poll (not duplicated), verifying the full cycle contract.
    const sleepMock = vi.mocked((await import('node:timers/promises')).setTimeout);
    const pollMock = vi.fn().mockResolvedValue(makeSnapshot());
    const evaluateMock = vi.fn().mockReturnValue(makeTriggerResult(false));

    let sleepCallCount = 0;
    let currentConfig = makeConfig({ pollingInterval: 300 });

    const { PollingLoop } = await import('./polling-loop.js');
    const adapter = makeDispatchAdapter(async () => null);

    const loop = new PollingLoop({
      usageMonitor: { poll: pollMock } as never,
      triggerEngine: {
        evaluate: evaluateMock,
        resetDispatchState: vi.fn(),
      } as never,
      dispatchAdapter: adapter,
      getConfig: () => currentConfig,
      startedAt: new Date().toISOString(),
    });

    sleepMock.mockImplementation(async () => {
      sleepCallCount++;

      if (sleepCallCount === 1) {
        // Interrupt with shorter interval.
        const newConfig = makeConfig({ pollingInterval: 60 });
        currentConfig = newConfig;
        loop.reload(newConfig);
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }

      if (sleepCallCount === 2) {
        // Rescheduled sleep completes normally (no error).
        return;
      }

      // Third sleep — after the second full cycle — exit.
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    await loop.start();

    // After the first cycle + interrupt + rescheduled sleep, exactly one more cycle runs.
    // Total: cycle 1 poll + cycle 2 poll = 2 polls.
    // If there were a double-poll race, we would see 3+ polls.
    expect(pollMock).toHaveBeenCalledTimes(2);
    // Three sleep calls: first (interrupted), second (rescheduled, completes), third (exits loop).
    expect(sleepCallCount).toBe(3);
    // Exactly 2 evaluate calls — one per poll cycle (no duplicates)
    expect(evaluateMock).toHaveBeenCalledTimes(2);
  });

  it('daemon shutdown still works during rescheduled sleep (AC4)', async () => {
    const sleepMock = vi.mocked((await import('node:timers/promises')).setTimeout);

    let sleepCallCount = 0;
    let currentConfig = makeConfig({ pollingInterval: 300 });

    const { PollingLoop } = await import('./polling-loop.js');
    const adapter = makeDispatchAdapter(async () => null);

    const loop = new PollingLoop({
      usageMonitor: { poll: vi.fn().mockResolvedValue(makeSnapshot()) } as never,
      triggerEngine: {
        evaluate: vi.fn().mockReturnValue(makeTriggerResult(false)),
        resetDispatchState: vi.fn(),
      } as never,
      dispatchAdapter: adapter,
      getConfig: () => currentConfig,
      startedAt: new Date().toISOString(),
    });

    // Semaphore: resolves when the mock enters the rescheduled sleep (sleepCallCount === 2).
    // This eliminates the real setTimeout(resolve, 20) timing dependency — the test only
    // calls stop() after the loop has deterministically reached the rescheduled sleep.
    let rescheduledSleepResolve!: () => void;
    const rescheduledSleepEntered = new Promise<void>((resolve) => {
      rescheduledSleepResolve = resolve;
    });

    sleepMock.mockImplementation(async (_ms?: number, _val?: unknown, options?: unknown) => {
      const opts = (options ?? {}) as { signal?: AbortSignal };
      sleepCallCount++;

      if (sleepCallCount === 1) {
        // First sleep — interrupt with shorter interval.
        const newConfig = makeConfig({ pollingInterval: 60 });
        currentConfig = newConfig;
        loop.reload(newConfig);
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }

      if (sleepCallCount === 2) {
        // Rescheduled sleep — signal that we've reached this point, then wait for stop.
        rescheduledSleepResolve();
        if (opts.signal) {
          await new Promise<void>((resolve) => {
            opts.signal!.addEventListener('abort', () => resolve(), { once: true });
          });
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }
      }
    });

    const loopDone = loop.start();
    // Wait until the loop has deterministically reached the rescheduled sleep before stopping.
    await rescheduledSleepEntered;

    // Call stop() to trigger daemon shutdown during the rescheduled sleep.
    const stopDone = loop.stop();
    await Promise.all([loopDone, stopDone]);

    // Loop should have exited cleanly.
    expect(sleepCallCount).toBe(2);
  });

  it('emits polling-loop.sleep-rescheduled debug event with correct fields (AC1)', async () => {
    // This test verifies the logger.debug call in reload() with the expected event data.
    const sleepMock = vi.mocked((await import('node:timers/promises')).setTimeout);
    const { logger: loggerMock } = await import('../utils/index.js');
    const debugSpy = vi.spyOn(loggerMock, 'debug');

    let sleepCallCount = 0;
    let currentConfig = makeConfig({ pollingInterval: 300 });

    const { PollingLoop } = await import('./polling-loop.js');
    const adapter = makeDispatchAdapter(async () => null);

    const loop = new PollingLoop({
      usageMonitor: { poll: vi.fn().mockResolvedValue(makeSnapshot()) } as never,
      triggerEngine: {
        evaluate: vi.fn().mockReturnValue(makeTriggerResult(false)),
        resetDispatchState: vi.fn(),
      } as never,
      dispatchAdapter: adapter,
      getConfig: () => currentConfig,
      startedAt: new Date().toISOString(),
    });

    sleepMock.mockImplementation(async () => {
      sleepCallCount++;

      if (sleepCallCount === 1) {
        const newConfig = makeConfig({ pollingInterval: 60 });
        currentConfig = newConfig;
        loop.reload(newConfig);
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }

      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    await loop.start();

    // Verify the debug event was emitted.
    const rescheduledCalls = debugSpy.mock.calls.filter(
      (call) => call[0] === 'polling-loop.sleep-rescheduled',
    );
    expect(rescheduledCalls.length).toBe(1);
    const eventData = rescheduledCalls[0]![1] as Record<string, unknown>;
    expect(eventData['oldIntervalMs']).toBe(300_000);
    expect(eventData['newIntervalMs']).toBe(60_000);
    expect(typeof eventData['remainingMs']).toBe('number');
    expect(eventData['remainingMs']).toBeLessThanOrEqual(60_000);
  });

  it('proceeds immediately when new interval has already elapsed (AC1 edge case)', async () => {
    const sleepMock = vi.mocked((await import('node:timers/promises')).setTimeout);

    const sleepDurations: number[] = [];
    let sleepCallCount = 0;
    let currentConfig = makeConfig({ pollingInterval: 300 });

    // Control time: simulate 120s elapsed before reload to 60s interval.
    const fakeNow = new Date('2026-03-05T12:00:00.000Z').getTime();
    let currentTime = fakeNow;
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => currentTime);

    // Also mock new Date() to use our controlled time (same pattern as stale-nextPollAt tests).
    const OrigDate = globalThis.Date;
    const MockDate = class extends OrigDate {
      constructor(...args: Parameters<DateConstructor>) {
        if (args.length === 0) {
          super(currentTime);
        } else {
          super(...(args as unknown as [number]));
        }
      }
    } as DateConstructor;
    MockDate.now = () => currentTime;
    MockDate.parse = OrigDate.parse;
    MockDate.UTC = OrigDate.UTC;
    globalThis.Date = MockDate;

    try {
      const { PollingLoop } = await import('./polling-loop.js');
      const adapter = makeDispatchAdapter(async () => null);

      const loop = new PollingLoop({
        usageMonitor: { poll: vi.fn().mockResolvedValue(makeSnapshot()) } as never,
        triggerEngine: {
          evaluate: vi.fn().mockReturnValue(makeTriggerResult(false)),
          resetDispatchState: vi.fn(),
        } as never,
        dispatchAdapter: adapter,
        getConfig: () => currentConfig,
        startedAt: new OrigDate(fakeNow).toISOString(),
      });

      sleepMock.mockImplementation(async (ms?: number) => {
        sleepCallCount++;
        sleepDurations.push(ms as number);

        if (sleepCallCount === 1) {
          // Simulate 120s elapsed during sleep, then reload to 60s.
          // newInterval(60s) - elapsed(120s) = -60s => clamped to 0 => immediate proceed.
          currentTime = fakeNow + 120_000;
          const newConfig = makeConfig({ pollingInterval: 60 });
          currentConfig = newConfig;
          loop.reload(newConfig);
          const abortErr = new Error('aborted');
          abortErr.name = 'AbortError';
          throw abortErr;
        }

        // Second sleep is from the NEXT cycle (after immediate proceed).
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      });

      await loop.start();
    } finally {
      globalThis.Date = OrigDate;
      dateNowSpy.mockRestore();
    }

    // Only two sleeps: first (interrupted, no reschedule because remaining <= 0),
    // second (next cycle's sleep, exits).
    expect(sleepCallCount).toBe(2);
    // No rescheduled sleep — the second sleep is from the next cycle.
  });
});

// Story 15.6: buildTriggerState maps new TriggerResult fields to DaemonTriggerState
describe('PollingLoop — buildTriggerState new fields (Story 15.6)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes wastePotential, effectiveReserve, availableBudget to cycle status trigger field', async () => {
    const sleepMock = vi.mocked((await import('node:timers/promises')).setTimeout);
    sleepMock.mockImplementation(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    const triggerResult: TriggerResult = {
      shouldDispatch: false,
      reason: 'waste potential 12.0% below threshold 50%',
      evaluatedAt: new Date(),
      snapshotSource: 'oauth',
      wastePotential: 0.12,
      effectiveReserve: 0.114,
      availableBudget: 0.536,
      isIdleHours: false,
      rateHeadroom: true,
      perModelWaste: [{ model: 'sonnet', waste: 0.15 }],
    };

    const mockTrigger = {
      evaluate: vi.fn().mockReturnValue(triggerResult),
      resetDispatchState: vi.fn(),
    };
    const mockMonitor = { poll: vi.fn().mockResolvedValue(makeSnapshot()) };
    const { writeCycleStatus: wcs } = await import('./state-writer.js');
    const wcsMock = vi.mocked(wcs);

    const { PollingLoop } = await import('./polling-loop.js');
    const loop = new PollingLoop({
      usageMonitor: mockMonitor as never,
      triggerEngine: mockTrigger as never,
      dispatchAdapter: makeDispatchAdapter(),
      getConfig: () => ({
        pollingInterval: 10,
        logRetentionDays: 30,
        taskTimeoutMinutes: 60,
        provider: {
          name: 'claude-code',
          allowDangerouslySkipPermissions: false,
          executionBackend: 'container',
        },
        trigger: { maxWastePercentage: 50, weeklyReservePercentage: 30, idleHours: [] },
        tasks: [],
        lastSummaryEnabled: false,
        wslMountPrefix: '/mnt/',
        telemetry: { enabled: false, endpoint: 'https://telemetry.sparecrow.dev/v1/events' },
      }),
      startedAt: new Date().toISOString(),
    });
    await loop.start();

    const calls = wcsMock.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const triggerWritten = (calls[0]![0] as Record<string, unknown>)['trigger'] as Record<
      string,
      unknown
    >;
    expect(triggerWritten).toBeDefined();
    expect(triggerWritten['wastePotential']).toBe(0.12);
    expect(triggerWritten['effectiveReserve']).toBe(0.114);
    expect(triggerWritten['availableBudget']).toBe(0.536);
    expect(triggerWritten['isIdleHours']).toBe(false);
    expect(triggerWritten['rateHeadroom']).toBe(true);
    expect(triggerWritten['perModelWaste']).toEqual([{ model: 'sonnet', waste: 0.15 }]);
  });
});

describe('PollingLoop — writeSummaryFile gating (Story 21.2)', () => {
  // Tests verify the real gating branch in polling-loop.ts:
  //   if (config.lastSummaryEnabled && cycleResult !== null) { await writeSummaryFile(...) }
  // Uses the actual PollingLoop class — no inline simulation.

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls writeSummaryFile when lastSummaryEnabled=true and dispatch cycle returns a result', async () => {
    const sleepMock = vi.mocked((await import('node:timers/promises')).setTimeout);
    sleepMock.mockImplementation(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    const { writeSummaryFile } = await import('./summary-writer.js');
    const writeSpy = vi.mocked(writeSummaryFile);

    const cycleResult = makeCycleResult();
    const triggerResult = makeTriggerResult(true);

    const mockTrigger = {
      evaluate: vi.fn().mockReturnValue(triggerResult),
      resetDispatchState: vi.fn(),
    };
    const mockMonitor = { poll: vi.fn().mockResolvedValue(makeSnapshot()) };
    const adapter = makeDispatchAdapter(async () => cycleResult);

    const { PollingLoop } = await import('./polling-loop.js');
    const loop = new PollingLoop({
      usageMonitor: mockMonitor as never,
      triggerEngine: mockTrigger as never,
      dispatchAdapter: adapter,
      getConfig: () => makeConfig({ lastSummaryEnabled: true }),
      startedAt: new Date().toISOString(),
    });
    await loop.start();

    expect(writeSpy).toHaveBeenCalledOnce();
    expect(writeSpy).toHaveBeenCalledWith('/tmp/sparecrow-test', cycleResult.tasksSucceeded);
  });

  it('does not call writeSummaryFile when lastSummaryEnabled=false even if dispatch cycle returns a result', async () => {
    const sleepMock = vi.mocked((await import('node:timers/promises')).setTimeout);
    sleepMock.mockImplementation(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    const { writeSummaryFile } = await import('./summary-writer.js');
    const writeSpy = vi.mocked(writeSummaryFile);

    const cycleResult = makeCycleResult();
    const triggerResult = makeTriggerResult(true);

    const mockTrigger = {
      evaluate: vi.fn().mockReturnValue(triggerResult),
      resetDispatchState: vi.fn(),
    };
    const mockMonitor = { poll: vi.fn().mockResolvedValue(makeSnapshot()) };
    const adapter = makeDispatchAdapter(async () => cycleResult);

    const { PollingLoop } = await import('./polling-loop.js');
    const loop = new PollingLoop({
      usageMonitor: mockMonitor as never,
      triggerEngine: mockTrigger as never,
      dispatchAdapter: adapter,
      getConfig: () => makeConfig({ lastSummaryEnabled: false }),
      startedAt: new Date().toISOString(),
    });
    await loop.start();

    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('does not call writeSummaryFile when dispatch adapter returns null (no dispatch cycle)', async () => {
    const sleepMock = vi.mocked((await import('node:timers/promises')).setTimeout);
    sleepMock.mockImplementation(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    const { writeSummaryFile } = await import('./summary-writer.js');
    const writeSpy = vi.mocked(writeSummaryFile);

    const triggerResult = makeTriggerResult(false);

    const mockTrigger = {
      evaluate: vi.fn().mockReturnValue(triggerResult),
      resetDispatchState: vi.fn(),
    };
    const mockMonitor = { poll: vi.fn().mockResolvedValue(makeSnapshot()) };
    // Adapter returns null — no dispatch cycle ran
    const adapter = makeDispatchAdapter(async () => null);

    const { PollingLoop } = await import('./polling-loop.js');
    const loop = new PollingLoop({
      usageMonitor: mockMonitor as never,
      triggerEngine: mockTrigger as never,
      dispatchAdapter: adapter,
      getConfig: () => makeConfig({ lastSummaryEnabled: true }),
      startedAt: new Date().toISOString(),
    });
    await loop.start();

    expect(writeSpy).not.toHaveBeenCalled();
  });
});
