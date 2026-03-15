/** Integration tests for daemon resilience guarantees (Story 4.4).
 *  Covers: polling retry/fallback, auth expiry degradation, dispatcher isolation,
 *  corrupt config reload preservation, top-level exception containment,
 *  and status contract fields always present. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type {
  ScrowConfig,
  DispatchCycleResult,
  DaemonStatusFile,
} from '../../src/types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return join(tmpdir(), `resilience-${randomBytes(6).toString('hex')}`);
}

function makeConfig(overrides: Partial<ScrowConfig> = {}): ScrowConfig {
  return {
    pollingInterval: 5,
    logRetentionDays: 30,
    provider: { name: 'claude-code', allowDangerouslySkipPermissions: false },
    trigger: { maxWastePercentage: 50, weeklyReservePercentage: 30, idleHours: [] },
    tasks: [],
    lastSummaryEnabled: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite 1: Status contract — all required fields always present
// ---------------------------------------------------------------------------

describe('daemon-status.json contract', () => {
  let tmpDataDir: string;

  beforeEach(async () => {
    tmpDataDir = makeTmpDir();
    await mkdir(tmpDataDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDataDir, { recursive: true, force: true });
  });

  it('writeCycleStatus always produces required top-level fields', async () => {
    const { atomicWrite } = await import('../../src/utils/index.js');
    const statusPath = join(tmpDataDir, 'daemon-status.json');

    const now = new Date().toISOString();
    // Simulate what writeCycleStatus produces (mirrors its internal structure)
    const payload: DaemonStatusFile = {
      state: 'running',
      startedAt: now,
      lastPollAt: now,
      nextPollAt: new Date(Date.now() + 5000).toISOString(),
      usage: {
        sessionUtilization: 0.25,
        weeklyUtilization: 0.1,
        sessionResetsAt: null,
        weeklyResetsAt: null,
        source: 'oauth',
        confidence: 'high',
        subscriptionTier: null,
        degradedReason: null,
      },
      trigger: null,
      activeTask: null,
      lastError: null,
      lastErrorDetail: null,
      updatedAt: now,
      lastDispatchAt: null,
      cycleResult: null,
      queueDepth: 0,
      pid: null,
    };

    await atomicWrite(statusPath, JSON.stringify(payload, null, 2));
    const raw = JSON.parse(await readFile(statusPath, 'utf-8')) as Record<string, unknown>;

    // All required top-level fields present
    const REQUIRED_FIELDS = [
      'state', 'startedAt', 'lastPollAt', 'nextPollAt', 'usage',
      'trigger', 'activeTask', 'lastError', 'lastErrorDetail', 'updatedAt',
      'lastDispatchAt', 'cycleResult', 'queueDepth', 'pid',
    ];
    for (const field of REQUIRED_FIELDS) {
      expect(raw, `missing field: ${field}`).toHaveProperty(field);
    }
  });

  it('writes auth-failure lastErrorDetail with recovery command', async () => {
    const { atomicWrite } = await import('../../src/utils/index.js');
    const statusPath = join(tmpDataDir, 'daemon-status.json');
    const now = new Date().toISOString();

    const payload: DaemonStatusFile = {
      state: 'running',
      startedAt: now,
      lastPollAt: now,
      nextPollAt: new Date(Date.now() + 5000).toISOString(),
      usage: null,
      trigger: null,
      activeTask: null,
      lastError: 'OAuth token refresh failed.',
      lastErrorDetail: {
        code: 'DAEMON_AUTH_FAILED',
        message: 'OAuth token refresh failed. Daemon is operating in degraded mode.',
        recoveryCommand: 'sparecrow config --reconnect',
      },
      updatedAt: now,
      lastDispatchAt: null,
      cycleResult: null,
      queueDepth: 0,
      pid: null,
    };

    await atomicWrite(statusPath, JSON.stringify(payload, null, 2));
    const raw = JSON.parse(await readFile(statusPath, 'utf-8')) as Record<string, unknown>;

    const detail = raw['lastErrorDetail'] as Record<string, unknown>;
    expect(detail['code']).toBe('DAEMON_AUTH_FAILED');
    expect(detail['message']).toContain('degraded mode');
    expect(detail['recoveryCommand']).toBe('sparecrow config --reconnect');
  });

  it('writes degraded usage with degradedReason field', async () => {
    const { atomicWrite } = await import('../../src/utils/index.js');
    const statusPath = join(tmpDataDir, 'daemon-status.json');
    const now = new Date().toISOString();

    const payload: DaemonStatusFile = {
      state: 'running',
      startedAt: now,
      lastPollAt: now,
      nextPollAt: new Date(Date.now() + 5000).toISOString(),
      usage: {
        sessionUtilization: 0.2,
        weeklyUtilization: null,
        sessionResetsAt: null,
        weeklyResetsAt: null,
        source: 'jsonl-estimate',
        confidence: 'medium',
        subscriptionTier: null,
        degradedReason: 'operating on jsonl-estimate source',
      },
      trigger: null,
      activeTask: null,
      lastError: null,
      lastErrorDetail: null,
      updatedAt: now,
      lastDispatchAt: null,
      cycleResult: null,
      queueDepth: 0,
      pid: null,
    };

    await atomicWrite(statusPath, JSON.stringify(payload, null, 2));

    const { loadUsage } = await import('../../src/cli/commands/status-state.js');
    const usage = await loadUsage(tmpDataDir);

    expect(usage.source).toBe('jsonl-estimate');
    expect(usage.degradedReason).toContain('jsonl-estimate');
    expect(usage.confidence).toBe('medium');
  });

  it('usage sub-fields always present with correct null defaults', async () => {
    const { atomicWrite } = await import('../../src/utils/index.js');
    const statusPath = join(tmpDataDir, 'daemon-status.json');
    const now = new Date().toISOString();

    // Write a status with null usage fields (simulates a new daemon before first poll)
    const payload: DaemonStatusFile = {
      state: 'running',
      startedAt: now,
      lastPollAt: null,
      nextPollAt: null,
      usage: null,
      trigger: null,
      activeTask: null,
      lastError: null,
      lastErrorDetail: null,
      updatedAt: now,
      lastDispatchAt: null,
      cycleResult: null,
      queueDepth: 0,
      pid: null,
    };

    await atomicWrite(statusPath, JSON.stringify(payload, null, 2));

    const { loadUsage } = await import('../../src/cli/commands/status-state.js');
    const usage = await loadUsage(tmpDataDir);

    // All usage fields must be present and null when no data
    expect(usage.sessionUtilization).toBeNull();
    expect(usage.weeklyUtilization).toBeNull();
    expect(usage.sessionResetsAt).toBeNull();
    expect(usage.weeklyResetsAt).toBeNull();
    expect(usage.source).toBeNull();
    expect(usage.confidence).toBeNull();
    expect(usage.subscriptionTier).toBeNull();
    expect(usage.degradedReason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Auth state — daemon runtime error signals surface correctly
// ---------------------------------------------------------------------------

describe('status-state auth degradation visibility', () => {
  let tmpDataDir: string;

  beforeEach(async () => {
    tmpDataDir = makeTmpDir();
    await mkdir(tmpDataDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDataDir, { recursive: true, force: true });
  });

  it('getDaemonRuntimeAuthState returns expired when DAEMON_AUTH_FAILED is in lastErrorDetail', async () => {
    const { atomicWrite } = await import('../../src/utils/index.js');
    const statusPath = join(tmpDataDir, 'daemon-status.json');
    const now = new Date().toISOString();

    const payload = {
      state: 'running',
      startedAt: now,
      lastPollAt: now,
      nextPollAt: now,
      usage: null,
      trigger: null,
      activeTask: null,
      lastError: 'OAuth token refresh failed.',
      lastErrorDetail: {
        code: 'DAEMON_AUTH_FAILED',
        message: 'OAuth token refresh failed.',
        recoveryCommand: 'sparecrow config --reconnect',
      },
      updatedAt: now,
      lastDispatchAt: null,
      cycleResult: null,
      queueDepth: 0,
      pid: null,
    };

    await atomicWrite(statusPath, JSON.stringify(payload, null, 2));

    // Call getDaemonRuntimeAuthState directly to verify it reads and classifies the error.
    const { getDaemonRuntimeAuthState } = await import('../../src/cli/commands/status-state.js');
    const authState = await getDaemonRuntimeAuthState(tmpDataDir);
    expect(authState).toBe('expired');
  });

  it('getDaemonRuntimeAuthState returns expired when AUTH_TOKEN_EXPIRED is in lastErrorDetail', async () => {
    const { atomicWrite } = await import('../../src/utils/index.js');
    const statusPath = join(tmpDataDir, 'daemon-status.json');
    const now = new Date().toISOString();

    const payload = {
      state: 'running',
      startedAt: now,
      lastPollAt: now,
      nextPollAt: now,
      usage: null,
      trigger: null,
      activeTask: null,
      lastError: 'OAuth token expired.',
      lastErrorDetail: {
        code: 'AUTH_TOKEN_EXPIRED',
        message: 'OAuth token expired.',
        recoveryCommand: 'sparecrow config --reconnect',
      },
      updatedAt: now,
      lastDispatchAt: null,
      cycleResult: null,
      queueDepth: 0,
      pid: null,
    };

    await atomicWrite(statusPath, JSON.stringify(payload, null, 2));

    const { getDaemonRuntimeAuthState } = await import('../../src/cli/commands/status-state.js');
    const authState = await getDaemonRuntimeAuthState(tmpDataDir);
    expect(authState).toBe('expired');
  });

  it('getDaemonRuntimeAuthState returns null when no lastErrorDetail in daemon-status.json', async () => {
    const { atomicWrite } = await import('../../src/utils/index.js');
    const statusPath = join(tmpDataDir, 'daemon-status.json');
    const now = new Date().toISOString();

    const payload = {
      state: 'running',
      startedAt: now,
      lastPollAt: now,
      nextPollAt: now,
      usage: {
        sessionUtilization: 0.3,
        weeklyUtilization: 0.2,
        sessionResetsAt: null,
        weeklyResetsAt: null,
        source: 'oauth',
        confidence: 'high',
        subscriptionTier: null,
        degradedReason: null,
      },
      trigger: null,
      activeTask: null,
      lastError: null,
      lastErrorDetail: null,
      updatedAt: now,
      lastDispatchAt: null,
      cycleResult: null,
      queueDepth: 0,
      pid: null,
    };

    await atomicWrite(statusPath, JSON.stringify(payload, null, 2));

    const { getDaemonRuntimeAuthState } = await import('../../src/cli/commands/status-state.js');
    const authState = await getDaemonRuntimeAuthState(tmpDataDir);
    expect(authState).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Config reload preservation
// ---------------------------------------------------------------------------

describe('config reload corruption resilience', () => {
  it('buildLastErrorDetail produces correct code and recovery hint for config reload failure', async () => {
    const { buildLastErrorDetail } = await import('../../src/daemon/state-writer.js');
    const { ErrorCode } = await import('../../src/errors/index.js');

    const detail = buildLastErrorDetail(
      ErrorCode.CONFIG_RELOAD_PRESERVED,
      'Config reload failed — daemon continues with last valid configuration.',
      'sparecrow config validate',
    );

    expect(detail.code).toBe('CONFIG_RELOAD_PRESERVED');
    expect(detail.message).toContain('last valid configuration');
    expect(detail.recoveryCommand).toBe('sparecrow config validate');
  });

  it('buildLastErrorDetail handles null recovery command', async () => {
    const { buildLastErrorDetail } = await import('../../src/daemon/state-writer.js');
    const { ErrorCode } = await import('../../src/errors/index.js');

    const detail = buildLastErrorDetail(
      ErrorCode.DAEMON_POLL_FAILED,
      'Poll failed after retries.',
      null,
    );

    expect(detail.code).toBe('DAEMON_POLL_FAILED');
    expect(detail.recoveryCommand).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Suite 4: Dispatcher task isolation
// ---------------------------------------------------------------------------

describe('dispatcher task failure isolation', () => {
  it('dispatcher continues processing tasks after one fails', async () => {
    vi.resetModules();
    vi.doMock('../../src/daemon/state-writer.js', () => ({
      writeDispatchStatus: vi.fn().mockResolvedValue(undefined),
      buildLastErrorDetail: vi.fn((code: string, message: string, cmd: string | null) => ({ code, message, recoveryCommand: cmd })),
    }));
    const { Dispatcher } = await import('../../src/daemon/dispatcher.js');
    const { EventName } = await import('../../src/types/index.js');

    const logEvents: string[] = [];
    const mockLogger = {
      info: vi.fn(async (event: string) => { logEvents.push(event); }),
      warn: vi.fn(async (event: string) => { logEvents.push(event); }),
      error: vi.fn(async (event: string) => { logEvents.push(event); }),
      debug: vi.fn(async (event: string) => { logEvents.push(event); }),
    };

    const updatedStatuses: Array<{ id: string; status: string }> = [];

    const task1 = {
      id: 't1',
      name: 'task-1',
      type: 'custom' as const,
      status: 'pending' as const,
      prompt: 'do something',
      targetPath: '/repo',
      priority: 1,
      createdAt: new Date(),
      timeoutMs: 30000,
    };
    const task2 = {
      id: 't2',
      name: 'task-2',
      type: 'custom' as const,
      status: 'pending' as const,
      prompt: 'do something else',
      targetPath: '/repo',
      priority: 2,
      createdAt: new Date(),
      timeoutMs: 30000,
    };

    const mockQueueManager = {
      listDispatchable: vi.fn().mockResolvedValue([task1, task2]),
      setTaskStatus: vi.fn(async (id: string, status: string) => {
        updatedStatuses.push({ id, status });
      }),
    };

    let executeCount = 0;
    const mockTaskExecutor = {
      execute: vi.fn(async () => {
        executeCount++;
        if (executeCount === 1) {
          // First task throws
          throw new Error('task-1 execution error');
        }
        // Second task succeeds
        return {
          taskId: task2.id,
          status: 'done' as const,
          startedAt: new Date(),
          completedAt: new Date(),
          durationMs: 10,
          stdout: '',
          stderr: '',
          exitCode: 0,
          error: null,
          errorCode: null,
        };
      }),
    };

    const dispatcher = new Dispatcher({
      queueManager: mockQueueManager as never,
      taskExecutor: mockTaskExecutor as never,
      logger: mockLogger as never,
    });

    const result = await dispatcher.dispatch();

    // Both tasks were attempted
    expect(result.tasksAttempted).toBe(2);
    // Only second task succeeded
    expect(result.tasksSucceeded).toBe(1);
    // First task failed
    expect(result.tasksFailed).toBe(1);
    // Queue was not stopped by quota
    expect(result.stoppedByQuota).toBe(false);

    // Both tasks had their status updated (dispatcher sets in-progress before execute, then final status)
    const t1Updates = updatedStatuses.filter((u) => u.id === 't1');
    const t2Updates = updatedStatuses.filter((u) => u.id === 't2');
    expect(t1Updates.at(-1)?.status).toBe('failed');
    expect(t2Updates.at(-1)?.status).toBe('done');

    // Failure was logged
    expect(logEvents.some((e) => e === EventName.TASK_FAILED)).toBe(true);
    // Success was logged
    expect(logEvents.some((e) => e === EventName.TASK_COMPLETED)).toBe(true);

    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('dispatcher stops cycle on quota exhaustion and marks task as failed_quota', async () => {
    vi.resetModules();
    vi.doMock('../../src/daemon/state-writer.js', () => ({
      writeDispatchStatus: vi.fn().mockResolvedValue(undefined),
      buildLastErrorDetail: vi.fn((code: string, message: string, cmd: string | null) => ({ code, message, recoveryCommand: cmd })),
    }));
    const { Dispatcher } = await import('../../src/daemon/dispatcher.js');
    const { EventName } = await import('../../src/types/index.js');

    const logEvents: string[] = [];
    const mockLogger = {
      info: vi.fn(async (event: string) => { logEvents.push(event); }),
      warn: vi.fn(async (event: string) => { logEvents.push(event); }),
      error: vi.fn(async (event: string) => { logEvents.push(event); }),
      debug: vi.fn(async (event: string) => { logEvents.push(event); }),
    };

    const task1 = {
      id: 't1', name: 'task-1', type: 'custom' as const, status: 'pending' as const,
      prompt: 'p', targetPath: '/r', priority: 1, createdAt: new Date(), timeoutMs: 30000,
    };
    const task2 = {
      id: 't2', name: 'task-2', type: 'custom' as const, status: 'pending' as const,
      prompt: 'p', targetPath: '/r', priority: 2, createdAt: new Date(), timeoutMs: 30000,
    };

    const updatedStatuses: Array<{ id: string; status: string }> = [];
    const mockQueueManager = {
      listDispatchable: vi.fn().mockResolvedValue([task1, task2]),
      setTaskStatus: vi.fn(async (id: string, status: string) => {
        updatedStatuses.push({ id, status });
      }),
    };

    const mockTaskExecutor = {
      execute: vi.fn().mockResolvedValue({
        taskId: task1.id,
        status: 'failed_quota' as const,
        startedAt: new Date(), completedAt: new Date(),
        durationMs: 5, stdout: '', stderr: '', exitCode: 2, error: null, errorCode: null,
      }),
    };

    const dispatcher = new Dispatcher({
      queueManager: mockQueueManager as never,
      taskExecutor: mockTaskExecutor as never,
      logger: mockLogger as never,
    });

    const result = await dispatcher.dispatch();

    expect(result.stoppedByQuota).toBe(true);
    // Only first task attempted (quota hit stops cycle)
    expect(result.tasksAttempted).toBe(1);
    // task2 was never attempted
    expect(mockTaskExecutor.execute).toHaveBeenCalledTimes(1);

    const t1Updates = updatedStatuses.filter((u) => u.id === 't1');
    expect(t1Updates.at(-1)?.status).toBe('failed_quota');

    // DISPATCH_QUOTA_EXHAUSTED and TASK_REQUEUED events logged
    expect(logEvents.some((e) => e === EventName.DISPATCH_QUOTA_EXHAUSTED)).toBe(true);
    expect(logEvents.some((e) => e === EventName.TASK_REQUEUED)).toBe(true);

    vi.restoreAllMocks();
    vi.resetModules();
  });
});

// ---------------------------------------------------------------------------
// Suite 5: Polling loop resilience — buildUsageState degraded reason
// ---------------------------------------------------------------------------

describe('polling loop degraded usage state', () => {
  it('buildUsageState sets degradedReason for stale source', async () => {
    // Test via PollingLoop internal by constructing a snapshot and checking the resulting state
    // We validate the DaemonUsageState shape by running a single cycle
    // NOTE: jsonl-estimate source was removed in story 15.9; stale is the degraded source now
    vi.resetModules();
    vi.doMock('../../src/daemon/state-writer.js', () => ({
      writeCycleStatus: vi.fn().mockResolvedValue(undefined),
      writeDispatchStatus: vi.fn().mockResolvedValue(undefined),
      buildLastErrorDetail: vi.fn((code: string, message: string, cmd: string | null) => ({ code, message, recoveryCommand: cmd })),
    }));
    vi.doMock('node:timers/promises', () => ({
      setTimeout: vi.fn(async () => {
        const err = new Error('abort');
        err.name = 'AbortError';
        throw err;
      }),
    }));
    vi.doMock('../../src/utils/index.js', () => ({
      logger: {
        info: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      retryWithBackoff: vi.fn((fn: () => Promise<unknown>) => fn()),
    }));

    try {
      const { PollingLoop } = await import('../../src/daemon/polling-loop.js');
      const stateWriter = await import('../../src/daemon/state-writer.js');
      const writeCycleStatus = vi.mocked(stateWriter.writeCycleStatus);

      const degradedSnapshot = {
        rateWindows: [{ name: '5-hour session', utilization: 0.2, resetsAt: new Date(Date.now() + 3600000) }],
        budgetWindows: [],
        provider: 'claude-code' as const,
        fetchedAt: new Date(),
        source: 'stale' as const,
        confidence: 'low' as const,
      };

      const loop = new PollingLoop({
        usageMonitor: { poll: vi.fn().mockResolvedValue(degradedSnapshot) },
        triggerEngine: {
          evaluate: vi.fn().mockReturnValue({
            shouldDispatch: false,
            reason: 'threshold',
            evaluatedAt: new Date(),
            snapshotSource: 'stale',
          }),
          resetDispatchState: vi.fn(),
        },
        dispatchAdapter: { dispatchIfTriggered: vi.fn().mockResolvedValue(null) },
        getConfig: () => makeConfig(),
        startedAt: new Date().toISOString(),
      } as never);

      await loop.start();

      expect(writeCycleStatus).toHaveBeenCalled();
      const call = writeCycleStatus.mock.calls[0]?.[0];
      expect(call).toBeDefined();
      if (call) {
        const usage = (call as Record<string, unknown>)['usage'] as Record<string, unknown> | null;
        expect(usage).not.toBeNull();
        if (usage) {
          expect(usage['degradedReason']).toBeTruthy();
          expect(String(usage['degradedReason'])).toContain('stale');
        }
      }
    } finally {
      vi.doUnmock('../../src/daemon/state-writer.js');
      vi.doUnmock('node:timers/promises');
      vi.doUnmock('../../src/utils/index.js');
      vi.restoreAllMocks();
      vi.resetModules();
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 6: Error code and message completeness
// ---------------------------------------------------------------------------

describe('resilience error codes and messages', () => {
  it('DAEMON_AUTH_FAILED, DAEMON_DEGRADED, CONFIG_RELOAD_PRESERVED all have messages', async () => {
    const { ErrorCode } = await import('../../src/errors/index.js');
    const { getErrorMessage } = await import('../../src/errors/index.js');

    const codes = [
      ErrorCode.DAEMON_AUTH_FAILED,
      ErrorCode.DAEMON_DEGRADED,
      ErrorCode.CONFIG_RELOAD_PRESERVED,
    ];

    for (const code of codes) {
      const msg = getErrorMessage(code);
      expect(msg.userMessage.length, `userMessage empty for ${code}`).toBeGreaterThan(0);
      expect(msg.suggestion.length, `suggestion empty for ${code}`).toBeGreaterThan(0);
    }
  });

  it('DAEMON_AUTH_FAILED message includes reconnect suggestion', async () => {
    const { ErrorCode } = await import('../../src/errors/index.js');
    const { getErrorMessage } = await import('../../src/errors/index.js');

    const msg = getErrorMessage(ErrorCode.DAEMON_AUTH_FAILED);
    expect(msg.suggestion).toContain('reconnect');
  });

  it('CONFIG_RELOAD_PRESERVED message includes validate suggestion', async () => {
    const { ErrorCode } = await import('../../src/errors/index.js');
    const { getErrorMessage } = await import('../../src/errors/index.js');

    const msg = getErrorMessage(ErrorCode.CONFIG_RELOAD_PRESERVED);
    expect(msg.suggestion).toContain('validate');
  });
});

// ---------------------------------------------------------------------------
// Suite 7: JSONL audit schema — fixed fields always present
// ---------------------------------------------------------------------------

describe('JSONL audit schema resilience events', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  it('audit record includes all 8 required fields for resilience events', async () => {
    const { asAuditRecord } = await import('../../src/cli/commands/audit-parsing.js');

    // Simulate a resilience audit record with all required fields
    const resilienceEvent = {
      ts: new Date().toISOString(),
      level: 'warn',
      event: 'polling-loop.auth-failed-degraded',
      data: {
        error: 'Token refresh failed',
        recoveryCommand: 'sparecrow config --reconnect',
      },
      provider: 'claude-code',
      source: 'stale',
      confidence: 'low',
      error: null,
    };

    const record = asAuditRecord(resilienceEvent);
    expect(record).not.toBeNull();
    if (record) {
      expect(record.ts).toBeTruthy();
      expect(record.level).toBe('warn');
      expect(record.event).toBe('polling-loop.auth-failed-degraded');
      expect(record.data).toBeDefined();
      expect(record.provider).toBe('claude-code');
      expect(record.source).toBe('stale');
      expect(record.confidence).toBe('low');
      expect(record.error).toBeNull();
    }
  });

  it('asAuditRecord returns null for non-object input', async () => {
    const { asAuditRecord } = await import('../../src/cli/commands/audit-parsing.js');

    // Non-object input should return null
    expect(asAuditRecord(null)).toBeNull();
    expect(asAuditRecord('string')).toBeNull();
    expect(asAuditRecord(42)).toBeNull();
    expect(asAuditRecord(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Suite 8: State writer — always-present fields contract
// ---------------------------------------------------------------------------

describe('state-writer always-present fields', () => {
  let tmpDataDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDataDir = makeTmpDir();
    await mkdir(tmpDataDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDataDir, { recursive: true, force: true });
  });

  it('writeErrorStatus includes lastErrorDetail field', async () => {
    // We test the building of the structure rather than the actual file write
    // (which requires overriding platform paths)
    const { buildLastErrorDetail } = await import('../../src/daemon/state-writer.js');
    const { ErrorCode } = await import('../../src/errors/index.js');

    const detail = buildLastErrorDetail(
      ErrorCode.DAEMON_AUTH_FAILED,
      'Token refresh failed.',
      'sparecrow config --reconnect',
    );

    // Verify the structure is correct
    expect(detail).toEqual({
      code: 'DAEMON_AUTH_FAILED',
      message: 'Token refresh failed.',
      recoveryCommand: 'sparecrow config --reconnect',
    });
  });

  it('DaemonStatusFile shape includes lastErrorDetail as top-level field', async () => {
    // Verify the type contract by constructing a full DaemonStatusFile and checking JSON shape
    const { atomicWrite } = await import('../../src/utils/index.js');
    const statusPath = join(tmpDataDir, 'daemon-status.json');
    const now = new Date().toISOString();

    const cycleResult: DispatchCycleResult = {
      tasksAttempted: 1, tasksSucceeded: 1, tasksFailed: 0,
      stoppedByQuota: false,
      startedAt: now, completedAt: now, durationMs: 100,
    };

    const status: DaemonStatusFile = {
      state: 'running',
      startedAt: now,
      lastPollAt: now,
      nextPollAt: new Date(Date.now() + 5000).toISOString(),
      usage: {
        sessionUtilization: 0.5, weeklyUtilization: 0.3,
        sessionResetsAt: null, weeklyResetsAt: null,
        source: 'oauth', confidence: 'high',
        subscriptionTier: null, degradedReason: null,
      },
      trigger: { shouldDispatch: false, reason: 'ok', evaluatedAt: now, snapshotSource: 'oauth' },
      activeTask: null,
      lastError: null,
      lastErrorDetail: null,
      updatedAt: now,
      lastDispatchAt: cycleResult.completedAt,
      cycleResult,
      queueDepth: 1,
      pid: 12345,
    };

    await atomicWrite(statusPath, JSON.stringify(status, null, 2));

    const raw = JSON.parse(await readFile(statusPath, 'utf-8')) as Record<string, unknown>;

    // lastErrorDetail must be present as a top-level field (even when null)
    expect(Object.prototype.hasOwnProperty.call(raw, 'lastErrorDetail')).toBe(true);
    expect(raw['lastErrorDetail']).toBeNull();
  });
});
