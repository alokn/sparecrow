/** ENOSPC filesystem error tests for daemon state writer — verifies polling loop continues (AC2). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { CapacitySnapshot, TriggerResult, ScrowConfig } from '../types/index.js';

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

const makeTriggerResult = (): TriggerResult => ({
  shouldDispatch: false,
  reason: 'waste potential below threshold',
  evaluatedAt: new Date(),
  snapshotSource: 'oauth',
  wastePotential: 0.2,
  effectiveReserve: 0.15,
  availableBudget: 0.35,
  isIdleHours: false,
  rateHeadroom: true,
  perModelWaste: null,
});

const makeConfig = (): ScrowConfig => ({
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
});

describe('writeCycleStatus ENOSPC handling (AC2)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws when atomicWrite fails with ENOSPC during cycle status write', async () => {
    const enospcError = Object.assign(new Error('ENOSPC: no space left on device'), {
      code: 'ENOSPC',
    });

    vi.doMock('../platform/index.js', () => ({
      ensureDirectories: vi.fn().mockResolvedValue(undefined),
      getPaths: vi.fn().mockReturnValue({
        config: '/tmp/config',
        data: '/tmp/state',
        logs: '/tmp/state/logs',
        taskOutputs: '/tmp/state/task-outputs',
      }),
    }));

    vi.doMock('../utils/index.js', () => ({
      atomicWrite: vi.fn().mockRejectedValue(enospcError),
    }));

    const { writeCycleStatus } = await import('./state-writer.js');

    // writeCycleStatus propagates ENOSPC — the polling loop must catch and handle it
    await expect(
      writeCycleStatus({
        startedAt: '2026-03-15T10:00:00.000Z',
        lastPollAt: '2026-03-15T10:05:00.000Z',
        nextPollAt: '2026-03-15T10:10:00.000Z',
        usage: null,
        trigger: null,
        activeTask: null,
        lastError: null,
        lastDispatchAt: null,
        cycleResult: null,
        queueDepth: 0,
        pid: 1234,
      }),
    ).rejects.toThrow('ENOSPC');
  });

  it('polling loop logs warning and continues after writeCycleStatus throws ENOSPC', async () => {
    // AC2: when writeCycleStatus throws ENOSPC, the polling loop must catch the error,
    // log a warning, and continue to the next cycle rather than crashing.

    const enospcError = Object.assign(new Error('ENOSPC: no space left on device'), {
      code: 'ENOSPC',
    });

    const warnSpy = vi.fn().mockResolvedValue(undefined);

    // Mock writeCycleStatus to always throw ENOSPC
    vi.doMock('./state-writer.js', () => ({
      writeCycleStatus: vi.fn().mockRejectedValue(enospcError),
      writeDaemonStatus: vi.fn().mockResolvedValue(undefined),
      writeRunningStatus: vi.fn().mockResolvedValue(undefined),
      writeStoppingStatus: vi.fn().mockResolvedValue(undefined),
      writeStoppedStatus: vi.fn().mockResolvedValue(undefined),
      writeErrorStatus: vi.fn().mockResolvedValue(undefined),
      buildLastErrorDetail: vi
        .fn()
        .mockReturnValue({ code: 'ERR', message: 'err', recoveryCommand: null }),
    }));

    vi.doMock('../utils/index.js', () => ({
      logger: {
        debug: vi.fn().mockResolvedValue(undefined),
        info: vi.fn().mockResolvedValue(undefined),
        warn: warnSpy,
        error: vi.fn().mockResolvedValue(undefined),
      },
      retryWithBackoff: vi.fn().mockImplementation((fn: () => Promise<unknown>) => fn()),
      atomicWrite: vi.fn().mockResolvedValue(undefined),
    }));

    vi.doMock('../platform/index.js', () => ({
      ensureDirectories: vi.fn().mockResolvedValue(undefined),
      getPaths: vi.fn().mockReturnValue({
        config: '/tmp/config',
        data: '/tmp/state',
        logs: '/tmp/state/logs',
        taskOutputs: '/tmp/state/task-outputs',
      }),
    }));

    vi.doMock('./summary-writer.js', () => ({
      writeSummaryFile: vi.fn().mockResolvedValue(undefined),
    }));

    vi.doMock('./task-output-writer.js', () => ({
      writeTaskOutput: vi.fn().mockResolvedValue(undefined),
    }));

    vi.doMock('./partial-output-writer.js', () => ({
      PartialOutputWriter: vi.fn(),
    }));

    vi.doMock('../queue/index.js', () => ({
      writeResultArtifact: vi.fn().mockResolvedValue(null),
    }));

    vi.doMock('./action-pipeline.js', () => ({
      runActionPipeline: vi.fn().mockResolvedValue(undefined),
    }));

    vi.doMock('../templates/index.js', () => ({
      ACTIVE_TEMPLATE_NAMES: [],
      extractBranchFromStdout: vi.fn().mockReturnValue(null),
    }));

    // Sleep mock: abort after the first sleep to stop the loop
    let sleepCallCount = 0;
    vi.doMock('node:timers/promises', () => ({
      setTimeout: vi.fn().mockImplementation(async () => {
        sleepCallCount++;
        if (sleepCallCount >= 1) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }
      }),
    }));

    const { PollingLoop } = await import('./polling-loop.js');

    const mockUsageMonitor = {
      poll: vi.fn().mockResolvedValue(makeSnapshot()),
    };

    const mockTriggerEngine = {
      evaluate: vi.fn().mockReturnValue(makeTriggerResult()),
      resetDispatchState: vi.fn(),
    };

    const mockDispatchAdapter = {
      dispatchIfTriggered: vi.fn().mockResolvedValue(null),
    };

    const loop = new PollingLoop({
      usageMonitor: mockUsageMonitor as never,
      triggerEngine: mockTriggerEngine as never,
      dispatchAdapter: mockDispatchAdapter as never,
      getConfig: () => makeConfig(),
      startedAt: new Date().toISOString(),
    });

    // AC2: loop must complete without throwing even though writeCycleStatus throws ENOSPC
    await expect(loop.start()).resolves.toBeUndefined();

    // AC2: The warning must have been logged for the status write failure
    expect(warnSpy).toHaveBeenCalledWith(
      'polling-loop.status-write-failed',
      expect.objectContaining({ error: expect.stringContaining('ENOSPC') }),
    );
  });
});
