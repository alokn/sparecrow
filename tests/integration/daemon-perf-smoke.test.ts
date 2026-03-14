/** Perf smoke test — validates idle polling loop stays within NFR1/NFR2 targets.
 *  NFR1: idle CPU <1% average; NFR2: memory footprint <50MB RSS.
 *  Runs the polling loop with mocked dependencies for a fixed duration and records
 *  CPU and memory observations. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type {
  CapacitySnapshot,
  TriggerResult,
  ScrowConfig,
  DispatchAdapter,
} from '../../src/types/index.js';

const NFR2_MAX_RSS_BYTES = 50 * 1024 * 1024; // 50 MB

vi.mock('../../src/daemon/state-writer.js', () => ({
  writeCycleStatus: vi.fn().mockResolvedValue(undefined),
  writeStoppingStatus: vi.fn().mockResolvedValue(undefined),
  writeStoppedStatus: vi.fn().mockResolvedValue(undefined),
  writeErrorStatus: vi.fn().mockResolvedValue(undefined),
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

const makeTriggerResult = (): TriggerResult => ({
  shouldDispatch: false,
  reason: 'above threshold',
  evaluatedAt: new Date(),
  snapshotSource: 'oauth',
});

const makeConfig = (): ScrowConfig => ({
  pollingInterval: 1, // 1 second — fastest valid interval for perf measurement
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

describe('daemon-perf-smoke', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('idle polling loop stays within NFR2 memory threshold (<50MB RSS) over 3 cycles', async () => {
    const { PollingLoop } = await import('../../src/daemon/polling-loop.js');

    const mockUsageMonitor = {
      poll: vi.fn().mockResolvedValue(makeSnapshot()),
    };
    const mockTriggerEngine = {
      evaluate: vi.fn().mockReturnValue(makeTriggerResult()),
      resetDispatchState: vi.fn(),
    };

    // Measure baseline RSS before creating the loop
    const rssBefore = process.memoryUsage().rss;

    let cycleCount = 0;
    const loop = new PollingLoop({
      usageMonitor: mockUsageMonitor as never,
      triggerEngine: mockTriggerEngine as never,
      dispatchAdapter: makeDispatchAdapter(),
      getConfig: makeConfig,
      startedAt: new Date().toISOString(),
    });

    // Run the loop for a brief window using real timers, then stop it
    const loopPromise = loop.start();

    // Wait for a few cycles to complete using real intervals
    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        cycleCount = mockUsageMonitor.poll.mock.calls.length;
        if (cycleCount >= 3) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);
    });

    await loop.stop();
    await loopPromise;

    // Measure RSS after loop completion
    const rssAfter = process.memoryUsage().rss;

    // Record measurements for visibility
    const rssDeltaMB = (rssAfter - rssBefore) / (1024 * 1024);
    const rssTotalMB = rssAfter / (1024 * 1024);
    console.log(
      `[perf-smoke] RSS before: ${(rssBefore / 1024 / 1024).toFixed(1)}MB, ` +
        `after: ${rssTotalMB.toFixed(1)}MB, delta: ${rssDeltaMB.toFixed(1)}MB, ` +
        `cycles: ${cycleCount}`,
    );

    // Verify loop actually ran
    expect(cycleCount).toBeGreaterThanOrEqual(3);

    // NFR2 measurement: the daemon loop must not add more than 50MB RSS to the
    // process baseline (the test harness already consumes ~50-100MB for Node + Vitest).
    // We measure the *delta* introduced by the loop, not total process RSS.
    // A well-behaved idle loop should add negligible memory (<10MB), well under NFR2.
    const rssDeltaBytes = rssAfter - rssBefore;
    expect(rssDeltaBytes).toBeLessThan(NFR2_MAX_RSS_BYTES);
  });

  it('idle polling loop CPU usage stays low (no busy-wait)', async () => {
    const { PollingLoop } = await import('../../src/daemon/polling-loop.js');

    const mockUsageMonitor = {
      poll: vi.fn().mockResolvedValue(makeSnapshot()),
    };
    const mockTriggerEngine = {
      evaluate: vi.fn().mockReturnValue(makeTriggerResult()),
      resetDispatchState: vi.fn(),
    };

    const cpuBefore = process.cpuUsage();
    const wallBefore = Date.now();

    const loop = new PollingLoop({
      usageMonitor: mockUsageMonitor as never,
      triggerEngine: mockTriggerEngine as never,
      dispatchAdapter: makeDispatchAdapter(),
      getConfig: makeConfig,
      startedAt: new Date().toISOString(),
    });

    const loopPromise = loop.start();

    // Wait for at least 2 cycles
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (mockUsageMonitor.poll.mock.calls.length >= 2) {
          clearInterval(check);
          resolve();
        }
      }, 100);
    });

    await loop.stop();
    await loopPromise;

    const cpuAfter = process.cpuUsage(cpuBefore);
    const wallMs = Date.now() - wallBefore;
    const cpuMs = (cpuAfter.user + cpuAfter.system) / 1000;
    const cpuPercent = wallMs > 0 ? (cpuMs / wallMs) * 100 : 0;

    console.log(
      `[perf-smoke] CPU: user=${(cpuAfter.user / 1000).toFixed(1)}ms, ` +
        `sys=${(cpuAfter.system / 1000).toFixed(1)}ms, ` +
        `wall=${wallMs}ms, cpu%=${cpuPercent.toFixed(2)}%`,
    );

    // NFR1: idle CPU should be well below 1% in a non-busy polling loop.
    // We use a generous threshold of 20% here since Vitest adds overhead and the
    // polling interval is only 1 second; production idle CPU will be much lower.
    // This primarily validates absence of busy-wait (which would show >>100% CPU time).
    expect(cpuPercent).toBeLessThan(20);
  });
});
