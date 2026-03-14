/** Soak test — container runtime unavailability recovery (AC3, Story 18.5). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type {
  CapacitySnapshot,
  TriggerResult,
  ScrowConfig,
  DispatchAdapter,
} from '../../src/types/index.js';
import { logger } from '../../src/utils/index.js';

// Mock state-writer, summary-writer, task-output-writer to avoid filesystem I/O
vi.mock('../../src/daemon/state-writer.js', () => ({
  writeCycleStatus: vi.fn().mockResolvedValue(undefined),
  writeStoppingStatus: vi.fn().mockResolvedValue(undefined),
  writeStoppedStatus: vi.fn().mockResolvedValue(undefined),
  writeErrorStatus: vi.fn().mockResolvedValue(undefined),
  buildLastErrorDetail: vi.fn().mockReturnValue({ code: 'TEST', message: 'test', recoveryCommand: null }),
}));

vi.mock('../../src/daemon/summary-writer.js', () => ({
  writeSummaryFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/daemon/task-output-writer.js', () => ({
  writeTaskOutput: vi.fn().mockResolvedValue(undefined),
}));

// Mock node:timers/promises to eliminate real sleeps
vi.mock('node:timers/promises', () => ({
  setTimeout: vi.fn(async (_ms?: number, _value?: unknown, options?: { signal?: AbortSignal }) => {
    if (options?.signal?.aborted) {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    }
    return undefined;
  }),
}));

const TOTAL_CYCLES = 12;
const UNAVAILABLE_START = 3;
const UNAVAILABLE_END = 8;

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
  shouldDispatch: true, // Must be true to exercise checkBackendAvailable path
  reason: 'below threshold',
  evaluatedAt: new Date(),
  snapshotSource: 'oauth',
});

const makeConfig = (): ScrowConfig => ({
  pollingInterval: 1,
  logRetentionDays: 30,
  taskTimeoutMinutes: 60,
  provider: { name: 'claude-code', allowDangerouslySkipPermissions: false, executionBackend: 'container' },
  trigger: { maxWastePercentage: 50, weeklyReservePercentage: 30, idleHours: [] },
  tasks: [],
  lastSummaryEnabled: false,
});

describe('container-unavailable-recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    'daemon skips dispatch when checkBackendAvailable returns false, resumes when available',
    { timeout: 60000 },
    async () => {
      const { PollingLoop } = await import('../../src/daemon/polling-loop.js');

      const warnSpy = vi.spyOn(logger, 'warn');

      let cycleCount = 0;
      let loopRef: InstanceType<typeof PollingLoop> | null = null;

      const mockUsageMonitor = {
        poll: vi.fn().mockImplementation(async () => {
          cycleCount++;
          if (cycleCount >= TOTAL_CYCLES && loopRef) {
            void loopRef.stop();
          }
          return makeSnapshot();
        }),
      };

      const mockTriggerEngine = {
        evaluate: vi.fn().mockReturnValue(makeTriggerResult()),
        resetDispatchState: vi.fn(),
      };

      const mockDispatchAdapter: DispatchAdapter = {
        dispatchIfTriggered: vi.fn().mockResolvedValue({
          tasksAttempted: 1,
          tasksSucceeded: 1,
          tasksFailed: 0,
          stoppedByQuota: false,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 10,
        }),
      };

      const checkBackendAvailable = vi.fn().mockImplementation(async () => {
        // Return false for cycles 3-8, true otherwise
        return cycleCount < UNAVAILABLE_START || cycleCount > UNAVAILABLE_END;
      });

      const loop = new PollingLoop({
        usageMonitor: mockUsageMonitor as never,
        triggerEngine: mockTriggerEngine as never,
        dispatchAdapter: mockDispatchAdapter,
        getConfig: makeConfig,
        startedAt: new Date().toISOString(),
        checkBackendAvailable,
      });
      loopRef = loop;

      await loop.start();

      // All cycles ran
      expect(cycleCount).toBeGreaterThanOrEqual(TOTAL_CYCLES);

      // checkBackendAvailable called on every cycle (shouldDispatch is always true)
      expect(checkBackendAvailable).toHaveBeenCalledTimes(TOTAL_CYCLES);

      // dispatchAdapter.dispatchIfTriggered NOT called during cycles 3-8
      // Called on: cycles 1-2 (2) + cycles 9-12 (4) = 6
      const dispatchCalls = (mockDispatchAdapter.dispatchIfTriggered as ReturnType<typeof vi.fn>).mock.calls.length;
      const unavailableCycleCount = UNAVAILABLE_END - UNAVAILABLE_START + 1;
      expect(dispatchCalls).toBe(TOTAL_CYCLES - unavailableCycleCount);

      // AC3: daemon must log backend unavailability at warn level during cycles 3-8
      const backendWarnCalls = warnSpy.mock.calls.filter(
        (args) => args[0] === 'polling-loop.backend-unavailable',
      );
      expect(backendWarnCalls.length).toBe(unavailableCycleCount);
    },
  );

  it(
    'daemon handles checkBackendAvailable throwing without crashing',
    { timeout: 60000 },
    async () => {
      const { PollingLoop } = await import('../../src/daemon/polling-loop.js');

      let cycleCount = 0;
      const throwCycles = [3, 4, 5];
      const totalCycles = 8;
      let loopRef: InstanceType<typeof PollingLoop> | null = null;

      const mockUsageMonitor = {
        poll: vi.fn().mockImplementation(async () => {
          cycleCount++;
          if (cycleCount >= totalCycles && loopRef) {
            void loopRef.stop();
          }
          return makeSnapshot();
        }),
      };

      const mockTriggerEngine = {
        evaluate: vi.fn().mockReturnValue(makeTriggerResult()),
        resetDispatchState: vi.fn(),
      };

      const mockDispatchAdapter: DispatchAdapter = {
        dispatchIfTriggered: vi.fn().mockResolvedValue({
          tasksAttempted: 1,
          tasksSucceeded: 1,
          tasksFailed: 0,
          stoppedByQuota: false,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 10,
        }),
      };

      const checkBackendAvailable = vi.fn().mockImplementation(async () => {
        if (throwCycles.includes(cycleCount)) {
          throw new Error('Docker socket not responding');
        }
        return true;
      });

      const loop = new PollingLoop({
        usageMonitor: mockUsageMonitor as never,
        triggerEngine: mockTriggerEngine as never,
        dispatchAdapter: mockDispatchAdapter,
        getConfig: makeConfig,
        startedAt: new Date().toISOString(),
        checkBackendAvailable,
      });
      loopRef = loop;

      await loop.start();

      expect(cycleCount).toBeGreaterThanOrEqual(totalCycles);

      // Dispatch NOT called during throw cycles (3,4,5) but called on all others
      const dispatchCalls = (mockDispatchAdapter.dispatchIfTriggered as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(dispatchCalls).toBe(totalCycles - throwCycles.length);
    },
  );
});
