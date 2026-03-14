/** Soak test — OAuth token expiry recovery (AC2, Story 18.5). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type {
  CapacitySnapshot,
  TriggerResult,
  ScrowConfig,
  DispatchAdapter,
} from '../../src/types/index.js';

// Mock state-writer, summary-writer, task-output-writer to avoid filesystem I/O
vi.mock('../../src/daemon/state-writer.js', () => ({
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

const TOTAL_CYCLES = 15;
const ERROR_START = 5;
const ERROR_END = 10;

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
  reason: 'above threshold',
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

const makeDispatchAdapter = (): DispatchAdapter => ({
  dispatchIfTriggered: vi.fn().mockResolvedValue(null),
});

describe('oauth-expiry-recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    'daemon recovers from AUTH_TOKEN_EXPIRED errors on cycles 5-10 and resumes normal polling',
    { timeout: 60000 },
    async () => {
      const { ScrowError, ErrorCode } = await import('../../src/errors/index.js');
      const { PollingLoop } = await import('../../src/daemon/polling-loop.js');
      const { logger } = await import('../../src/utils/index.js');
      const loggerWarnSpy = vi.spyOn(logger, 'warn').mockResolvedValue(undefined);

      let cycleCount = 0;
      let loopRef: InstanceType<typeof PollingLoop> | null = null;

      const mockUsageMonitor = {
        poll: vi.fn().mockImplementation(async () => {
          cycleCount++;
          if (cycleCount >= ERROR_START && cycleCount <= ERROR_END) {
            throw new ScrowError(ErrorCode.AUTH_TOKEN_EXPIRED, 'Token expired for test');
          }
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

      const loop = new PollingLoop({
        usageMonitor: mockUsageMonitor as never,
        triggerEngine: mockTriggerEngine as never,
        dispatchAdapter: makeDispatchAdapter(),
        getConfig: makeConfig,
        startedAt: new Date().toISOString(),
      });
      loopRef = loop;

      await loop.start();

      // Loop did not crash — ran all 15 cycles
      expect(cycleCount).toBeGreaterThanOrEqual(TOTAL_CYCLES);

      // Verify logger.warn was called with 'polling-loop.auth-failed-degraded' during error cycles
      const authWarnCalls = loggerWarnSpy.mock.calls.filter(
        (call) => call[0] === 'polling-loop.auth-failed-degraded',
      );
      // Exactly one warn per failed cycle (cycles 5-10 = 6 calls)
      expect(authWarnCalls.length).toBe(ERROR_END - ERROR_START + 1);

      // Verify triggerEngine.evaluate was NOT called during error cycles (poll failed before trigger)
      // It should be called for cycles 1-4 (4 calls) and 11-15 (5 calls) = 9 calls
      const evaluateCalls = mockTriggerEngine.evaluate.mock.calls.length;
      expect(evaluateCalls).toBe(TOTAL_CYCLES - (ERROR_END - ERROR_START + 1));

      // Verify evaluate IS called again after recovery (cycle 11+)
      expect(evaluateCalls).toBeGreaterThanOrEqual(5);
    },
  );
});
