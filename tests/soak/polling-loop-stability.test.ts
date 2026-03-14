/** Soak test — 1,000-cycle polling loop heap stability (AC1, Story 18.5). */
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
  buildLastErrorDetail: vi.fn().mockReturnValue({ code: 'TEST', message: 'test', recoveryCommand: null }),
}));

vi.mock('../../src/daemon/summary-writer.js', () => ({
  writeSummaryFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/daemon/task-output-writer.js', () => ({
  writeTaskOutput: vi.fn().mockResolvedValue(undefined),
}));

// Mock node:timers/promises to eliminate real sleeps — resolve immediately but respect abort signal
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

const MAX_HEAP_DELTA_BYTES = 10 * 1024 * 1024; // 10 MB
const TOTAL_CYCLES = 1000;
const BASELINE_CYCLE = 10;

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

describe('polling-loop-stability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    'heapUsed delta stays within 10MB over 1,000 cycles with no ScrowError thrown',
    { timeout: 90000 },
    async () => {
      const { PollingLoop } = await import('../../src/daemon/polling-loop.js');

      const mockUsageMonitor = {
        poll: vi.fn().mockResolvedValue(makeSnapshot()),
      };
      const mockTriggerEngine = {
        evaluate: vi.fn().mockReturnValue(makeTriggerResult()),
        resetDispatchState: vi.fn(),
      };

      let cycleCount = 0;
      let heapAtBaseline = 0;
      let heapAtEnd = 0;
      let errorsThrown = 0;
      let loopRef: InstanceType<typeof PollingLoop> | null = null;

      // Track cycle count via poll calls and stop after TOTAL_CYCLES
      mockUsageMonitor.poll.mockImplementation(async () => {
        cycleCount++;
        if (cycleCount === BASELINE_CYCLE) {
          heapAtBaseline = process.memoryUsage().heapUsed;
        }
        if (cycleCount === TOTAL_CYCLES) {
          // Record heap at the final cycle — before teardown — to avoid GC deflation
          heapAtEnd = process.memoryUsage().heapUsed;
        }
        if (cycleCount >= TOTAL_CYCLES && loopRef) {
          // Capture ref locally and call stop() synchronously after this mock
          // returns. stop() is non-blocking: it aborts the stopController and
          // returns _loopPromise without awaiting it here. The loop will observe
          // the aborted signal at the next sleep checkpoint and exit cleanly.
          // Awaiting stop() here would deadlock because stop() resolves only when
          // _loopPromise resolves, which requires this poll mock to return first.
          const ref = loopRef;
          void ref.stop();
        }
        return makeSnapshot();
      });

      const loop = new PollingLoop({
        usageMonitor: mockUsageMonitor as never,
        triggerEngine: mockTriggerEngine as never,
        dispatchAdapter: makeDispatchAdapter(),
        getConfig: makeConfig,
        startedAt: new Date().toISOString(),
      });
      loopRef = loop;

      try {
        await loop.start();
      } catch (err) {
        if (err instanceof Error && err.name !== 'AbortError') {
          errorsThrown++;
        }
      }

      const heapDelta = heapAtEnd - heapAtBaseline;

      expect(cycleCount).toBeGreaterThanOrEqual(TOTAL_CYCLES);
      expect(heapAtBaseline).toBeGreaterThan(0);
      expect(heapDelta).toBeLessThan(MAX_HEAP_DELTA_BYTES);
      expect(errorsThrown).toBe(0);
    },
  );
});
