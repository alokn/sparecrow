/** Unit tests for status-state loaders and parsers. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  open: vi.fn(),
  access: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  unlink: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
}));

vi.mock('../../platform/index.js', () => ({
  getPaths: vi.fn(),
  ensureDirectories: vi.fn().mockResolvedValue(undefined),
  isLinux: vi.fn().mockReturnValue(false),
  isMacOS: vi.fn().mockReturnValue(false),
}));

vi.mock('../../daemon/pid-manager.js', () => ({
  DAEMON_PID_FILENAME: 'daemon.pid',
  DAEMON_STATUS_FILENAME: 'daemon-status.json',
  DAEMON_IDENTITY_ENV: 'SPARECROW_DAEMON_PROCESS',
  DAEMON_IDENTITY_VALUE: '1',
  readPid: vi.fn(),
  writePid: vi.fn(),
  removePid: vi.fn(),
  processExists: vi.fn(),
  isScrowDaemonProcess: vi.fn(),
  checkPidStatus: vi.fn(),
  killOrphanDaemons: vi.fn(),
}));

vi.mock('../../utils/index.js', () => ({
  retryWithBackoff: vi.fn(),
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  setLogLevel: vi.fn(),
  enableFileLogging: vi.fn(),
  setLogDir: vi.fn(),
  resetLoggerState: vi.fn(),
  atomicWrite: vi.fn(),
  safeReadJson: vi.fn(),
  AUDIT_LOG_FILENAME_REGEX: /^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/,
  isRecord: (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value),
  VERSION: '0.0.0-test',
  spawnWithGuardrails: vi.fn(),
  validateRepository: vi.fn(),
}));

vi.mock('../../config/index.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    trigger: { idleHours: [], maxWastePercentage: 50, weeklyReservePercentage: 30 },
    pollingInterval: 60,
    logRetentionDays: 30,
    taskTimeoutMinutes: 60,
    provider: {
      name: 'claude-code',
      allowDangerouslySkipPermissions: false,
      executionBackend: 'process',
    },
    tasks: [],
    lastSummaryEnabled: false,
  }),
  resolveConfigFilePath: vi.fn().mockReturnValue('/tmp/config/config.yaml'),
  ScrowConfigSchema: {},
  ContainerConfigSchema: {},
  CONFIG_DEFAULTS: {},
  CONFIG_FALLBACK: {},
  createConfigWatcher: vi.fn(),
}));

type StatusStateModule = typeof import('./status-state.js');

type OpenHandle = {
  stat: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

let statusState: StatusStateModule;
let readFileMock: ReturnType<typeof vi.fn>;
let openMock: ReturnType<typeof vi.fn>;
let getPathsMock: ReturnType<typeof vi.fn>;
let safeReadJsonMock: ReturnType<typeof vi.fn>;
let loggerDebugMock: ReturnType<typeof vi.fn>;
let checkPidStatusMock: ReturnType<typeof vi.fn>;
let loadConfigMock: ReturnType<typeof vi.fn>;

function makeErrno(code: string): NodeJS.ErrnoException {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function makeOpenHandle(content: string): OpenHandle {
  const bytes = Buffer.from(content, 'utf-8');

  return {
    stat: vi.fn().mockResolvedValue({ size: bytes.length }),
    read: vi
      .fn()
      .mockImplementation(
        async (buffer: Buffer, offset: number, length: number, position: number) => {
          if (position >= bytes.length) {
            return { bytesRead: 0, buffer };
          }

          const end = Math.min(position + length, bytes.length);
          bytes.copy(buffer, offset, position, end);
          return { bytesRead: end - position, buffer };
        },
      ),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function auditLine(
  event: string,
  taskName: string,
  isoTs: string,
  summary = 'summary',
  duration = '30s',
): string {
  return JSON.stringify({
    ts: isoTs,
    event,
    data: {
      taskName,
      summary,
      duration,
    },
  });
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();

  const fs = await import('node:fs/promises');
  readFileMock = vi.mocked(fs.readFile);
  openMock = vi.mocked(fs.open);

  const platform = await import('../../platform/index.js');
  getPathsMock = vi.mocked(platform.getPaths);

  const utils = await import('../../utils/index.js');
  safeReadJsonMock = vi.mocked(utils.safeReadJson);
  loggerDebugMock = vi.mocked(utils.logger.debug);

  const pidManager = await import('../../daemon/pid-manager.js');
  checkPidStatusMock = vi.mocked(pidManager.checkPidStatus);
  // Default: no PID file
  checkPidStatusMock.mockResolvedValue({ status: 'none', pid: null });

  readFileMock.mockRejectedValue(makeErrno('ENOENT'));
  openMock.mockRejectedValue(makeErrno('ENOENT'));
  safeReadJsonMock.mockResolvedValue(null);
  getPathsMock.mockReturnValue({
    config: '/tmp/config',
    data: '/tmp/state',
    logs: '/tmp/state/logs',
  });

  const configModule = await import('../../config/index.js');
  loadConfigMock = vi.mocked(configModule.loadConfig);
  // Default: config loads successfully with no idle hours
  loadConfigMock.mockResolvedValue({
    trigger: { idleHours: [], maxWastePercentage: 50, weeklyReservePercentage: 30 },
    pollingInterval: 60,
    logRetentionDays: 30,
    taskTimeoutMinutes: 60,
    provider: {
      name: 'claude-code',
      allowDangerouslySkipPermissions: false,
      executionBackend: 'process',
    },
    tasks: [],
    lastSummaryEnabled: false,
  });

  statusState = await import('./status-state.js');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadStatusSnapshot', () => {
  it('loads health, usage, queue, and activity using configured paths', async () => {
    const snapshot = await statusState.loadStatusSnapshot();

    expect(snapshot.health).toEqual({
      daemon: 'not-started',
      auth: 'missing',
      pid: null,
      uptime: null,
      lastErrorDetail: null,
    });
    expect(snapshot.usage.source).toBeNull();
    expect(snapshot.queue).toEqual({ pendingCount: 0, runningCount: 0, taskNames: [] });
    expect(snapshot.activity.dispatchCount).toBe(0);
  });

  it('sets idleHoursSchedule from config when idle hours are configured', async () => {
    loadConfigMock.mockResolvedValue({
      trigger: {
        idleHours: [{ start: '00:00', end: '06:00' }],
        maxWastePercentage: 50,
        weeklyReservePercentage: 30,
      },
      pollingInterval: 60,
      logRetentionDays: 30,
      taskTimeoutMinutes: 60,
      provider: {
        name: 'claude-code',
        allowDangerouslySkipPermissions: false,
        executionBackend: 'process',
      },
      tasks: [],
      lastSummaryEnabled: false,
    });

    const snapshot = await statusState.loadStatusSnapshot();
    expect(snapshot.usage.idleHoursSchedule).toBe('00:00-06:00 daily');
  });

  it('sets idleHoursSchedule to null when no idle hours configured', async () => {
    // loadConfigMock already defaults to no idle hours
    const snapshot = await statusState.loadStatusSnapshot();
    expect(snapshot.usage.idleHoursSchedule).toBeNull();
  });

  it('sets idleHoursSchedule to null when loadConfig throws', async () => {
    loadConfigMock.mockRejectedValue(new Error('config read failed'));
    const snapshot = await statusState.loadStatusSnapshot();
    expect(snapshot.usage.idleHoursSchedule).toBeNull();
    // No error is propagated — status command must not crash
  });
});

describe('getDaemonState', () => {
  it('returns running when PID exists and process is alive', async () => {
    checkPidStatusMock.mockResolvedValue({ status: 'alive', pid: 321 });
    safeReadJsonMock.mockResolvedValue({
      startedAt: new Date(Date.now() - 90 * 60_000).toISOString(),
    });

    const result = await statusState.getDaemonState('/tmp/state');

    expect(result.state).toBe('running');
    expect(result.pid).toBe(321);
    expect(result.uptime).not.toBeNull();
  });

  it('returns stopped when PID is stale', async () => {
    checkPidStatusMock.mockResolvedValue({ status: 'stale', pid: 654 });

    const result = await statusState.getDaemonState('/tmp/state');

    expect(result).toEqual({ state: 'stopped', pid: null, uptime: null });
  });

  it('returns stopped when PID is missing but daemon-status exists', async () => {
    checkPidStatusMock.mockResolvedValue({ status: 'none', pid: null });
    safeReadJsonMock.mockResolvedValue({ daemon: 'previously-running' });

    const result = await statusState.getDaemonState('/tmp/state');

    expect(result).toEqual({ state: 'stopped', pid: null, uptime: null });
  });

  it('returns not-started when no PID or daemon status exists', async () => {
    checkPidStatusMock.mockResolvedValue({ status: 'none', pid: null });
    safeReadJsonMock.mockResolvedValue(null);

    const result = await statusState.getDaemonState('/tmp/state');

    expect(result).toEqual({ state: 'not-started', pid: null, uptime: null });
  });

  it('AC4: returns restarting when PID is alive and daemon-status.json has state: restarting', async () => {
    // Finding 3 fix: getDaemonState() must read the state field from daemon-status.json
    // when the PID is alive so transient states like 'restarting' are surfaced by `sparecrow status`.
    checkPidStatusMock.mockResolvedValue({ status: 'alive', pid: 321 });
    safeReadJsonMock.mockResolvedValue({
      state: 'restarting',
      startedAt: new Date(Date.now() - 30_000).toISOString(),
    });

    const result = await statusState.getDaemonState('/tmp/state');

    expect(result.state).toBe('restarting');
    expect(result.pid).toBe(321);
  });

  it('AC4: returns stopping when PID is alive and daemon-status.json has state: stopping', async () => {
    checkPidStatusMock.mockResolvedValue({ status: 'alive', pid: 777 });
    safeReadJsonMock.mockResolvedValue({
      state: 'stopping',
      startedAt: new Date(Date.now() - 5_000).toISOString(),
    });

    const result = await statusState.getDaemonState('/tmp/state');

    expect(result.state).toBe('stopping');
    expect(result.pid).toBe(777);
  });

  it('AC4: falls back to running when PID is alive but state field is absent from daemon-status.json', async () => {
    // When daemon-status.json has no state field (early bootstrap), default to 'running'
    checkPidStatusMock.mockResolvedValue({ status: 'alive', pid: 111 });
    safeReadJsonMock.mockResolvedValue({
      startedAt: new Date(Date.now() - 10_000).toISOString(),
      // No 'state' field
    });

    const result = await statusState.getDaemonState('/tmp/state');

    expect(result.state).toBe('running');
    expect(result.pid).toBe(111);
  });

  it('AC4: falls back to running when PID is alive but state field is an unknown value', async () => {
    // When state is an unrecognised string (e.g. from a future daemon version), default to 'running'
    checkPidStatusMock.mockResolvedValue({ status: 'alive', pid: 222 });
    safeReadJsonMock.mockResolvedValue({
      state: 'unknown-future-state',
      startedAt: new Date(Date.now() - 10_000).toISOString(),
    });

    const result = await statusState.getDaemonState('/tmp/state');

    // Falls back to 'running' for unrecognised states when PID is alive
    expect(result.state).toBe('running');
    expect(result.pid).toBe(222);
  });
});

describe('getAuthState', () => {
  it('returns missing when credential file is absent', async () => {
    safeReadJsonMock.mockResolvedValue(null);

    await expect(statusState.getAuthState('/tmp/creds.json')).resolves.toBe('missing');
    expect(safeReadJsonMock).toHaveBeenCalledWith('/tmp/creds.json');
  });

  it('returns unknown when token exists but expiresAt is absent', async () => {
    safeReadJsonMock.mockResolvedValue({ accessToken: 'token-value' });

    await expect(statusState.getAuthState('/tmp/creds.json')).resolves.toBe('unknown');
  });

  it('returns expired when expiresAt is in epoch seconds and already elapsed', async () => {
    const expiredSeconds = Math.floor((Date.now() - 60_000) / 1000);
    safeReadJsonMock.mockResolvedValue({ accessToken: 'token-value', expiresAt: expiredSeconds });

    await expect(statusState.getAuthState('/tmp/creds.json')).resolves.toBe('expired');
  });

  it('returns valid when nested oauth token expires in the future', async () => {
    safeReadJsonMock.mockResolvedValue({
      claudeAiOauth: {
        accessToken: 'token-value',
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      },
    });

    await expect(statusState.getAuthState('/tmp/creds.json')).resolves.toBe('valid');
  });

  it('returns unknown and logs debug when credential read throws', async () => {
    safeReadJsonMock.mockRejectedValue(new Error('read failure'));

    await expect(statusState.getAuthState('/tmp/creds.json')).resolves.toBe('unknown');
    expect(loggerDebugMock).toHaveBeenCalledWith(
      'status.auth_check_error',
      expect.objectContaining({ error: 'read failure' }),
    );
  });
});

describe('loadUsage', () => {
  it('returns empty usage when daemon status is missing', async () => {
    safeReadJsonMock.mockResolvedValue(null);

    const usage = await statusState.loadUsage('/tmp/state');

    expect(usage).toEqual({
      sessionUtilization: null,
      weeklyUtilization: null,
      sessionResetsAt: null,
      weeklyResetsAt: null,
      source: null,
      confidence: null,
      subscriptionTier: null,
      degradedReason: null,
      wastePotential: null,
      effectiveReserve: null,
      availableBudget: null,
      isIdleHours: null,
      rateHeadroom: null,
      dispatchReason: null,
      shouldDispatch: null,
      idleHoursSchedule: null,
      perModelWaste: null,
      lastPolledAt: null,
    });
  });

  it('parses only valid usage fields and nulls malformed values', async () => {
    safeReadJsonMock.mockResolvedValue({
      usage: {
        sessionUtilization: 0.55,
        weeklyUtilization: 'not-a-number',
        sessionResetsAt: '2026-02-25T01:00:00.000Z',
        weeklyResetsAt: '',
        source: 'oauth',
        confidence: 'high',
        subscriptionTier: 'pro',
        degradedReason: 123,
      },
    });

    const usage = await statusState.loadUsage('/tmp/state');

    expect(usage).toEqual({
      sessionUtilization: 0.55,
      weeklyUtilization: null,
      sessionResetsAt: '2026-02-25T01:00:00.000Z',
      weeklyResetsAt: null,
      source: 'oauth',
      confidence: 'high',
      subscriptionTier: 'pro',
      degradedReason: null,
      wastePotential: null,
      effectiveReserve: null,
      availableBudget: null,
      isIdleHours: null,
      rateHeadroom: null,
      dispatchReason: null,
      shouldDispatch: null,
      idleHoursSchedule: null,
      perModelWaste: null,
      lastPolledAt: null,
    });
  });

  it('reads trigger section capacity fields from daemon-status.json', async () => {
    safeReadJsonMock.mockResolvedValue({
      usage: {
        sessionUtilization: 0.4,
        weeklyUtilization: 0.35,
        sessionResetsAt: null,
        weeklyResetsAt: null,
        source: 'oauth',
        confidence: 'high',
        subscriptionTier: null,
        degradedReason: null,
      },
      trigger: {
        shouldDispatch: false,
        reason: 'waste potential 12.0% below threshold 50%',
        evaluatedAt: '2026-03-06T10:00:00.000Z',
        snapshotSource: 'oauth',
        wastePotential: 0.12,
        effectiveReserve: 0.114,
        availableBudget: 0.536,
        isIdleHours: false,
        rateHeadroom: true,
        perModelWaste: [{ model: 'claude-3-5-sonnet', waste: 0.15 }],
      },
    });

    const usage = await statusState.loadUsage('/tmp/state');

    expect(usage.wastePotential).toBe(0.12);
    expect(usage.effectiveReserve).toBe(0.114);
    expect(usage.availableBudget).toBe(0.536);
    expect(usage.isIdleHours).toBe(false);
    expect(usage.rateHeadroom).toBe(true);
    expect(usage.dispatchReason).toBe('waste potential 12.0% below threshold 50%');
    expect(usage.shouldDispatch).toBe(false);
    expect(usage.perModelWaste).toEqual([{ model: 'claude-3-5-sonnet', waste: 0.15 }]);
  });

  it('returns null for capacity fields when trigger section is absent', async () => {
    safeReadJsonMock.mockResolvedValue({
      usage: {
        sessionUtilization: 0.4,
        weeklyUtilization: 0.35,
        sessionResetsAt: null,
        weeklyResetsAt: null,
        source: 'oauth',
        confidence: 'high',
        subscriptionTier: null,
        degradedReason: null,
      },
      // no trigger section
    });

    const usage = await statusState.loadUsage('/tmp/state');

    expect(usage.wastePotential).toBeNull();
    expect(usage.effectiveReserve).toBeNull();
    expect(usage.availableBudget).toBeNull();
    expect(usage.isIdleHours).toBeNull();
    expect(usage.rateHeadroom).toBeNull();
    expect(usage.dispatchReason).toBeNull();
    expect(usage.shouldDispatch).toBeNull();
  });

  it('returns 0 (not null) when trigger.wastePotential is exactly 0', async () => {
    safeReadJsonMock.mockResolvedValue({
      usage: {
        sessionUtilization: 0.1,
        weeklyUtilization: 0.0,
        sessionResetsAt: null,
        weeklyResetsAt: null,
        source: 'oauth',
        confidence: 'high',
        subscriptionTier: null,
        degradedReason: null,
      },
      trigger: {
        shouldDispatch: false,
        reason: 'test',
        evaluatedAt: '2026-03-06T00:00:00Z',
        snapshotSource: 'oauth',
        wastePotential: 0,
        effectiveReserve: 0,
        availableBudget: 0.5,
        isIdleHours: false,
        rateHeadroom: true,
        perModelWaste: [],
      },
    });

    const usage = await statusState.loadUsage('/tmp/state');
    expect(usage.wastePotential).toBe(0);
    expect(usage.effectiveReserve).toBe(0);
  });

  it('returns null when trigger.wastePotential is NaN or Infinity', async () => {
    safeReadJsonMock.mockResolvedValue({
      usage: {
        sessionUtilization: 0.1,
        weeklyUtilization: 0.0,
        sessionResetsAt: null,
        weeklyResetsAt: null,
        source: 'oauth',
        confidence: 'high',
        subscriptionTier: null,
        degradedReason: null,
      },
      trigger: {
        shouldDispatch: false,
        reason: 'test',
        evaluatedAt: '2026-03-06T00:00:00Z',
        snapshotSource: 'oauth',
        wastePotential: NaN,
        effectiveReserve: Infinity,
        availableBudget: null,
        isIdleHours: false,
        rateHeadroom: true,
        perModelWaste: null,
      },
    });

    const usage = await statusState.loadUsage('/tmp/state');
    expect(usage.wastePotential).toBeNull();
    expect(usage.effectiveReserve).toBeNull();
  });

  it('emptyUsage returns null for all new capacity fields', async () => {
    safeReadJsonMock.mockResolvedValue(null);
    const usage = await statusState.loadUsage('/tmp/state');
    // emptyUsage() is returned when status is null
    expect(usage.wastePotential).toBeNull();
    expect(usage.effectiveReserve).toBeNull();
    expect(usage.availableBudget).toBeNull();
    expect(usage.isIdleHours).toBeNull();
    expect(usage.rateHeadroom).toBeNull();
    expect(usage.dispatchReason).toBeNull();
    expect(usage.shouldDispatch).toBeNull();
    expect(usage.idleHoursSchedule).toBeNull();
    expect(usage.perModelWaste).toBeNull();
    expect(usage.lastPolledAt).toBeNull();
  });

  it('AC2: maps lastPollAt from daemon-status.json top-level to lastPolledAt', async () => {
    safeReadJsonMock.mockResolvedValue({
      lastPollAt: '2026-03-10T08:00:00.000Z',
      usage: {
        sessionUtilization: 0.4,
        weeklyUtilization: 0.35,
        sessionResetsAt: null,
        weeklyResetsAt: null,
        source: 'oauth',
        confidence: 'high',
        subscriptionTier: null,
        degradedReason: null,
      },
    });

    const usage = await statusState.loadUsage('/tmp/state');
    expect(usage.lastPolledAt).toBe('2026-03-10T08:00:00.000Z');
  });

  it('AC2: sets lastPolledAt to null when lastPollAt is absent from daemon-status.json', async () => {
    safeReadJsonMock.mockResolvedValue({
      // no lastPollAt field
      usage: {
        sessionUtilization: 0.4,
        weeklyUtilization: 0.35,
        sessionResetsAt: null,
        weeklyResetsAt: null,
        source: 'oauth',
        confidence: 'high',
        subscriptionTier: null,
        degradedReason: null,
      },
    });

    const usage = await statusState.loadUsage('/tmp/state');
    expect(usage.lastPolledAt).toBeNull();
  });
});

describe('loadQueue', () => {
  it('returns empty queue when queue file is missing', async () => {
    safeReadJsonMock.mockResolvedValue(null);

    await expect(statusState.loadQueue('/tmp/state')).resolves.toEqual({
      pendingCount: 0,
      runningCount: 0,
      taskNames: [],
    });
  });

  it('counts only pending tasks and caps task names to 20', async () => {
    const pending = Array.from({ length: 25 }, (_, i) => ({
      status: 'pending',
      name: `task-${i + 1}`,
    }));

    safeReadJsonMock.mockResolvedValue({
      tasks: [...pending, { status: 'done', name: 'completed-task' }],
    });

    const queue = await statusState.loadQueue('/tmp/state');

    expect(queue.pendingCount).toBe(25);
    expect(queue.runningCount).toBe(0);
    expect(queue.taskNames).toHaveLength(20);
    expect(queue.taskNames[0]).toBe('task-1');
    expect(queue.taskNames[19]).toBe('task-20');
  });

  it('counts in-progress tasks into runningCount separately from pendingCount', async () => {
    safeReadJsonMock.mockResolvedValue({
      tasks: [
        { status: 'pending', name: 'task-a' },
        { status: 'in-progress', name: 'task-b' },
        { status: 'done', name: 'task-c' },
        { status: 'in-progress', name: 'task-d' },
      ],
    });

    const queue = await statusState.loadQueue('/tmp/state');

    expect(queue.pendingCount).toBe(1);
    expect(queue.runningCount).toBe(2);
    expect(queue.taskNames).toEqual(['task-a']);
  });

  it('returns runningCount 0 when no in-progress tasks exist', async () => {
    safeReadJsonMock.mockResolvedValue({
      tasks: [
        { status: 'pending', name: 'task-a' },
        { status: 'done', name: 'task-b' },
      ],
    });

    const queue = await statusState.loadQueue('/tmp/state');

    expect(queue.runningCount).toBe(0);
    expect(queue.pendingCount).toBe(1);
  });
});

describe('loadActivity', () => {
  it('counts only completed and failed events in dispatch metrics', async () => {
    const now = new Date('2026-02-24T12:00:00.000Z');
    const content = [
      auditLine('task.dispatched', 'queued-task', '2026-02-24T11:57:00.000Z'),
      auditLine('task.completed', 'done-task', '2026-02-24T11:58:00.000Z', 'ok', '20s'),
      auditLine('task.failed', 'failed-task', '2026-02-24T11:59:00.000Z', 'boom', '10s'),
      auditLine('task.requeued', 'retry-task', '2026-02-24T12:00:00.000Z', '-', '5s'),
    ].join('\n');

    openMock.mockResolvedValue(makeOpenHandle(content) as unknown);

    const activity = await statusState.loadActivity('/tmp/state/logs', now);

    // Requeued entries are shown in recent activity but do not count toward success-rate denominator.
    expect(activity.dispatchCount).toBe(2);
    expect(activity.successRate).toBe(0.5);
    expect(activity.recentDispatches).toHaveLength(3);
    expect(activity.recentDispatches[0]?.outcome).toBe('retrying');
    expect(activity.recentDispatches[1]?.outcome).toBe('failed');
    expect(activity.recentDispatches[2]?.outcome).toBe('success');
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("falls back to yesterday's log when today's log is missing", async () => {
    const now = new Date('2026-02-24T01:00:00.000Z');
    const yesterday = auditLine('task.completed', 'yesterday-task', '2026-02-23T23:55:00.000Z');

    openMock.mockImplementation(async (path: string) => {
      if (path.endsWith('audit-2026-02-24.jsonl')) {
        throw makeErrno('ENOENT');
      }
      if (path.endsWith('audit-2026-02-23.jsonl')) {
        return makeOpenHandle(yesterday) as unknown;
      }
      throw makeErrno('ENOENT');
    });

    const activity = await statusState.loadActivity('/tmp/state/logs', now);

    expect(activity.dispatchCount).toBe(1);
    expect(activity.recentDispatches[0]?.task).toBe('yesterday-task');
    expect(openMock).toHaveBeenCalledTimes(2);
  });

  it('skips malformed JSONL lines and returns safe output', async () => {
    const now = new Date('2026-02-24T12:00:00.000Z');
    const content = [
      'not-json-at-all',
      auditLine('task.completed', 'good-task', '2026-02-24T11:00:00.000Z'),
      '{bad-json',
    ].join('\n');

    openMock.mockResolvedValue(makeOpenHandle(content) as unknown);

    const activity = await statusState.loadActivity('/tmp/state/logs', now);

    expect(activity.dispatchCount).toBe(1);
    expect(activity.successRate).toBe(1);
    expect(activity.recentDispatches[0]?.task).toBe('good-task');
  });

  it('limits scan to the last 1000 lines', async () => {
    const now = new Date('2026-02-24T12:00:00.000Z');
    const lines = Array.from({ length: 1200 }, (_, index) =>
      auditLine(
        'task.completed',
        `task-${index + 1}`,
        `2026-02-24T10:${String(index % 60).padStart(2, '0')}:00.000Z`,
      ),
    );

    openMock.mockResolvedValue(makeOpenHandle(lines.join('\n')) as unknown);

    const activity = await statusState.loadActivity('/tmp/state/logs', now);

    expect(activity.dispatchCount).toBe(1000);
    expect(activity.successRate).toBe(1);
    expect(activity.recentDispatches).toHaveLength(10);
    expect(activity.recentDispatches[0]?.task).toBe('task-1200');
  });
});
