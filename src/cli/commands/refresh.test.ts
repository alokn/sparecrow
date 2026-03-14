/** Tests for the refresh command — one-shot usage poll, trigger evaluation, and dispatch cycle. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import type { CapacitySnapshot, TriggerResult, DaemonStatusFile } from '../../types/index.js';

/* ── shared mutable state (reset per test) ── */
let jsonMode = false;
let stdoutOutput = '';
let stderrOutput = '';

/* ── mock stubs ── */
const mockPoll = vi.fn<() => Promise<CapacitySnapshot>>();
const mockEvaluate = vi.fn<(snapshot: CapacitySnapshot, conditions: unknown) => TriggerResult>();
const mockDispatch = vi.fn<
  () => Promise<{
    tasksAttempted: number;
    tasksSucceeded: number;
    tasksFailed: number;
    stoppedByQuota: boolean;
    startedAt: string;
    completedAt: string;
    durationMs: number;
  }>
>();
const mockWriteDaemonStatus = vi.fn<(state: DaemonStatusFile) => Promise<void>>();
const mockReadExistingStatus = vi.fn<(path: string) => Promise<DaemonStatusFile | null>>();
const mockLoadStatusSnapshot = vi.fn();
const mockListDispatchable = vi.fn<() => Promise<unknown[]>>();
const mockCountWorkload = vi.fn<() => Promise<number>>();
const mockAccess = vi.fn<(path: string) => Promise<void>>();

/* ── test fixtures ── */
const NOW = new Date('2026-03-12T10:00:00.000Z');

function makeSnapshot(): CapacitySnapshot {
  return {
    budgetWindows: [
      {
        id: 'weekly',
        kind: 'budget',
        utilization: 0.4,
        resetsAt: new Date('2026-03-19T00:00:00.000Z'),
        windowDurationHours: 168,
      },
    ],
    rateWindows: [
      {
        id: 'session',
        kind: 'rate',
        utilization: 0.3,
        resetsAt: new Date('2026-03-12T15:00:00.000Z'),
        windowDurationHours: 5,
      },
    ],
    provider: 'claude-code',
    fetchedAt: NOW,
    source: 'oauth',
    confidence: 'high',
  };
}

function makeTriggerResult(shouldDispatch: boolean): TriggerResult {
  return {
    shouldDispatch,
    reason: shouldDispatch
      ? 'waste potential 55.0% exceeds threshold 50%'
      : 'waste below threshold',
    evaluatedAt: NOW,
    snapshotSource: 'oauth',
    wastePotential: shouldDispatch ? 0.55 : 0.2,
    effectiveReserve: 0.1,
    availableBudget: 0.5,
    isIdleHours: false,
    rateHeadroom: true,
    perModelWaste: null,
  };
}

function makeExistingStatus(overrides: Partial<DaemonStatusFile> = {}): DaemonStatusFile {
  return {
    state: 'running',
    startedAt: '2026-03-12T08:00:00.000Z',
    lastPollAt: '2026-03-12T09:00:00.000Z',
    nextPollAt: '2026-03-12T09:05:00.000Z',
    usage: null,
    trigger: null,
    activeTask: null,
    lastError: null,
    lastErrorDetail: null,
    updatedAt: '2026-03-12T09:00:00.000Z',
    lastDispatchAt: null,
    cycleResult: null,
    queueDepth: 0,
    pid: 12345,
    backendState: null,
    ...overrides,
  };
}

function makeStatusSnapshot() {
  return {
    health: { daemon: 'running', auth: 'valid', pid: 12345, uptime: '2h', lastErrorDetail: null },
    usage: {
      sessionUtilization: 0.3,
      weeklyUtilization: 0.4,
      sessionResetsAt: null,
      weeklyResetsAt: null,
      source: 'oauth',
      confidence: 'high',
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
    },
    queue: { pendingCount: 0, runningCount: 0, taskNames: [] },
    activity: {
      dispatchCount: 0,
      successRate: null,
      dollarValueRecovered: null,
      recentDispatches: [],
    },
    backendState: null,
  };
}

/* ── module mocks ── */
vi.mock('node:fs/promises', () => ({
  access: (...args: Parameters<typeof mockAccess>) => mockAccess(...args),
}));

vi.mock('../index.js', () => ({
  isJsonMode: () => jsonMode,
  getConfigPath: () => undefined,
}));

vi.mock('../../platform/index.js', () => ({
  getPaths: () => ({ data: '/mock/data', config: '/mock/config', logs: '/mock/logs' }),
}));

vi.mock('../../config/index.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    pollingInterval: 300,
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
  }),
  resolveConfigFilePath: (_dir: string, override?: string) =>
    override ?? '/mock/config/config.yaml',
}));

vi.mock('../../providers/index.js', () => ({
  createProvider: vi.fn().mockResolvedValue({
    usageMonitor: { poll: mockPoll },
    taskExecutor: { execute: vi.fn() },
    authManager: { getToken: vi.fn(), refresh: vi.fn(), validate: vi.fn() },
  }),
}));

vi.mock('../../trigger/index.js', () => {
  return {
    TriggerEngine: class MockTriggerEngine {
      evaluate = mockEvaluate;
      resetDispatchState = vi.fn();
    },
  };
});

vi.mock('../../queue/index.js', () => ({
  QueueStore: class MockQueueStore {},
  QueueManager: class MockQueueManager {
    listDispatchable = mockListDispatchable;
    countWorkload = mockCountWorkload;
    setTaskStatus = vi.fn();
  },
}));

vi.mock('../../daemon/index.js', () => ({
  writeDaemonStatus: mockWriteDaemonStatus,
  readExistingStatus: mockReadExistingStatus,
  buildUsageState: vi.fn().mockReturnValue({
    sessionUtilization: 0.3,
    weeklyUtilization: 0.4,
    sessionResetsAt: null,
    weeklyResetsAt: null,
    source: 'oauth',
    confidence: 'high',
    subscriptionTier: null,
    degradedReason: null,
  }),
  buildTriggerState: vi.fn().mockReturnValue({
    shouldDispatch: false,
    reason: 'waste below threshold',
    evaluatedAt: '2026-03-12T10:00:00.000Z',
    snapshotSource: 'oauth',
    wastePotential: 0.2,
    effectiveReserve: 0.1,
    availableBudget: 0.5,
    isIdleHours: false,
    rateHeadroom: true,
    perModelWaste: null,
  }),
  Dispatcher: class MockDispatcher {
    dispatch = mockDispatch;
  },
}));

vi.mock('./status-state.js', () => ({
  loadStatusSnapshot: mockLoadStatusSnapshot,
}));

const mockRenderStatusOutput = vi.fn<() => string>();
vi.mock('./status-presenter.js', () => ({
  renderStatusOutput: (...args: Parameters<typeof mockRenderStatusOutput>) =>
    mockRenderStatusOutput(...args),
}));

vi.mock('../../utils/index.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  AUDIT_LOG_FILENAME_REGEX: /^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/,
  isRecord: (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value),
  retryWithBackoff: vi.fn(),
  setLogLevel: vi.fn(),
  enableFileLogging: vi.fn(),
  setLogDir: vi.fn(),
  resetLoggerState: vi.fn(),
  atomicWrite: vi.fn(),
  safeReadJson: vi.fn(),
  VERSION: '0.0.0-test',
  spawnWithGuardrails: vi.fn(),
  validateRepository: vi.fn(),
}));

/* ── helpers ── */
function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  return program;
}

function parseJsonOutput(): { ok: boolean; data: unknown; error: unknown } {
  return JSON.parse(stdoutOutput) as { ok: boolean; data: unknown; error: unknown };
}

/* ── test suite ── */
describe('registerRefresh', () => {
  beforeEach(() => {
    jsonMode = false;
    stdoutOutput = '';
    stderrOutput = '';

    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      stderrOutput += String(data);
      return true;
    });

    // Clear all mock call counts before each test
    mockPoll.mockReset();
    mockEvaluate.mockReset();
    mockWriteDaemonStatus.mockReset();
    mockReadExistingStatus.mockReset();
    mockLoadStatusSnapshot.mockReset();
    mockListDispatchable.mockReset();
    mockCountWorkload.mockReset();
    mockAccess.mockReset();
    mockDispatch.mockReset();
    mockRenderStatusOutput.mockReset();

    // Default mocks for happy path
    mockPoll.mockResolvedValue(makeSnapshot());
    mockEvaluate.mockReturnValue(makeTriggerResult(false));
    mockWriteDaemonStatus.mockResolvedValue(undefined);
    mockReadExistingStatus.mockResolvedValue(null);
    mockLoadStatusSnapshot.mockResolvedValue(makeStatusSnapshot());
    mockListDispatchable.mockResolvedValue([]);
    mockCountWorkload.mockResolvedValue(0);
    mockAccess.mockResolvedValue(undefined);
    mockRenderStatusOutput.mockReturnValue('mock status output');
    mockDispatch.mockResolvedValue({
      tasksAttempted: 0,
      tasksSucceeded: 0,
      tasksFailed: 0,
      stoppedByQuota: false,
      startedAt: NOW.toISOString(),
      completedAt: NOW.toISOString(),
      durationMs: 0,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  // AC1 / Task 4.1: Command registration — refresh appears in command list with description
  it('registers refresh command with correct description and appears in --help output', async () => {
    const { registerRefresh } = await import('./refresh.js');
    const program = makeProgram();
    program.name('sparecrow');
    registerRefresh(program);

    const cmd = program.commands.find((c) => c.name() === 'refresh');
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toBe(
      'force a one-shot usage poll, trigger evaluation, and dispatch cycle',
    );

    // AC1: Verify 'refresh' appears in the --help output string with its description
    // (Commander may wrap long descriptions, so check for partial description)
    const helpText = program.helpInformation();
    expect(helpText).toContain('refresh');
    expect(helpText).toContain('force a one-shot usage poll');
  });

  // AC2 / Task 4.2: Successful refresh cycle
  it('fetches fresh usage data and writes updated status', async () => {
    const { registerRefresh } = await import('./refresh.js');
    const program = makeProgram();
    registerRefresh(program);

    await program.parseAsync(['node', 'sparecrow', 'refresh']);

    expect(mockPoll).toHaveBeenCalledOnce();
    expect(mockEvaluate).toHaveBeenCalledOnce();
    expect(mockWriteDaemonStatus).toHaveBeenCalledOnce();

    const writtenStatus = mockWriteDaemonStatus.mock.calls[0]![0] as DaemonStatusFile;
    expect(writtenStatus.usage).toBeDefined();
    expect(writtenStatus.trigger).toBeDefined();
    expect(writtenStatus.lastPollAt).toBeDefined();
    expect(writtenStatus.updatedAt).toBeDefined();
  });

  // AC2 / Task 4.3: Provider unreachable
  it('surfaces PROVIDER_UNREACHABLE error when provider fails', async () => {
    const { ScrowError, ErrorCode } = await import('../../errors/index.js');
    mockPoll.mockRejectedValue(
      new ScrowError(ErrorCode.PROVIDER_UNREACHABLE, 'Cannot reach provider'),
    );

    const { registerRefresh } = await import('./refresh.js');
    const program = makeProgram();
    registerRefresh(program);

    await expect(program.parseAsync(['node', 'sparecrow', 'refresh'])).rejects.toMatchObject({
      code: 'PROVIDER_UNREACHABLE',
    });
  });

  // AC7 / Task 4.4: Config not found — throws CONFIG_NOT_FOUND when config file is absent
  it('throws CONFIG_NOT_FOUND when config file does not exist', async () => {
    const enoent = Object.assign(new Error('ENOENT: no such file or directory'), {
      code: 'ENOENT',
    });
    mockAccess.mockRejectedValueOnce(enoent);

    const { registerRefresh } = await import('./refresh.js');
    const program = makeProgram();
    registerRefresh(program);

    await expect(program.parseAsync(['node', 'sparecrow', 'refresh'])).rejects.toMatchObject({
      code: 'CONFIG_NOT_FOUND',
    });
  });

  // AC4 / Task 4.5: Dispatch path — shouldDispatch true with tasks
  it('invokes dispatcher when trigger returns shouldDispatch true', async () => {
    mockEvaluate.mockReturnValue(makeTriggerResult(true));
    mockListDispatchable.mockResolvedValue([{ id: 'task-1', name: 'test-task' }]);

    const { buildTriggerState } = await import('../../daemon/index.js');
    vi.mocked(buildTriggerState).mockReturnValue({
      shouldDispatch: true,
      reason: 'waste potential 55.0% exceeds threshold 50%',
      evaluatedAt: '2026-03-12T10:00:00.000Z',
      snapshotSource: 'oauth',
      wastePotential: 0.55,
      effectiveReserve: 0.1,
      availableBudget: 0.5,
      isIdleHours: false,
      rateHeadroom: true,
      perModelWaste: null,
    });

    const { registerRefresh } = await import('./refresh.js');
    const program = makeProgram();
    registerRefresh(program);

    await program.parseAsync(['node', 'sparecrow', 'refresh']);

    expect(mockDispatch).toHaveBeenCalledOnce();
  });

  // Task 4.5b: Dispatch path — empty queue
  it('invokes dispatcher when shouldDispatch true but queue is empty and exits cleanly', async () => {
    mockEvaluate.mockReturnValue(makeTriggerResult(true));
    mockListDispatchable.mockResolvedValue([]);

    const { buildTriggerState } = await import('../../daemon/index.js');
    vi.mocked(buildTriggerState).mockReturnValue({
      shouldDispatch: true,
      reason: 'waste potential 55.0% exceeds threshold 50%',
      evaluatedAt: '2026-03-12T10:00:00.000Z',
      snapshotSource: 'oauth',
      wastePotential: 0.55,
      effectiveReserve: 0.1,
      availableBudget: 0.5,
      isIdleHours: false,
      rateHeadroom: true,
      perModelWaste: null,
    });

    const { registerRefresh } = await import('./refresh.js');
    const program = makeProgram();
    registerRefresh(program);

    // Should not throw
    await program.parseAsync(['node', 'sparecrow', 'refresh']);
    // Flush microtask queue so the post-dispatch cycleResult write can run
    await Promise.resolve();

    expect(mockDispatch).toHaveBeenCalledOnce();
    // writeDaemonStatus called at least once for initial write; a second call may follow
    // once dispatch resolves to persist cycleResult
    expect(mockWriteDaemonStatus.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  // Task 2.3 / dispatch .catch() error path
  it('logs error via logger when dispatch promise rejects without surfacing to caller', async () => {
    mockEvaluate.mockReturnValue(makeTriggerResult(true));
    mockDispatch.mockRejectedValue(new Error('dispatch internal failure'));

    const { logger: mockLogger } = await import('../../utils/index.js');
    const { registerRefresh } = await import('./refresh.js');
    const program = makeProgram();
    registerRefresh(program);

    // parseAsync completes without throwing (dispatch error is caught in .catch())
    await program.parseAsync(['node', 'sparecrow', 'refresh']);
    // Flush microtask queue so the .catch() handler has a chance to run
    await Promise.resolve();

    expect(mockLogger.error).toHaveBeenCalledWith('refresh.dispatch-failed', {
      error: 'dispatch internal failure',
    });
  });

  // AC4 / Task 4.6: No-dispatch path
  it('does not invoke dispatcher when trigger returns shouldDispatch false', async () => {
    mockEvaluate.mockReturnValue(makeTriggerResult(false));

    const { registerRefresh } = await import('./refresh.js');
    const program = makeProgram();
    registerRefresh(program);

    await program.parseAsync(['node', 'sparecrow', 'refresh']);

    expect(mockDispatch).not.toHaveBeenCalled();
  });

  // AC6 / Task 4.7: JSON output mode
  it('outputs jsonOk envelope with refreshed snapshot in JSON mode', async () => {
    jsonMode = true;

    const { registerRefresh } = await import('./refresh.js');
    const program = makeProgram();
    registerRefresh(program);

    await program.parseAsync(['node', 'sparecrow', 'refresh']);

    const parsed = parseJsonOutput();
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toBeDefined();
    expect(parsed.error).toBeNull();
  });

  // AC5 / Task 4.8: State preservation — existing daemon-status.json with state 'running'
  it('preserves lifecycle fields from existing daemon-status.json', async () => {
    const existingStatus = makeExistingStatus({ state: 'running', pid: 99999 });
    mockReadExistingStatus.mockResolvedValue(existingStatus);

    const { registerRefresh } = await import('./refresh.js');
    const program = makeProgram();
    registerRefresh(program);

    await program.parseAsync(['node', 'sparecrow', 'refresh']);

    expect(mockWriteDaemonStatus).toHaveBeenCalledOnce();
    const writtenStatus = mockWriteDaemonStatus.mock.calls[0]![0] as DaemonStatusFile;
    // Lifecycle fields preserved
    expect(writtenStatus.state).toBe('running');
    expect(writtenStatus.startedAt).toBe('2026-03-12T08:00:00.000Z');
    expect(writtenStatus.pid).toBe(99999);
    // Data fields updated
    expect(writtenStatus.usage).toBeDefined();
    expect(writtenStatus.trigger).toBeDefined();
    expect(writtenStatus.lastPollAt).toBeDefined();
  });

  // Task 4.8 supplement: No existing status file
  it('defaults to stopped state when no existing daemon-status.json exists', async () => {
    mockReadExistingStatus.mockResolvedValue(null);

    const { registerRefresh } = await import('./refresh.js');
    const program = makeProgram();
    registerRefresh(program);

    await program.parseAsync(['node', 'sparecrow', 'refresh']);

    expect(mockWriteDaemonStatus).toHaveBeenCalledOnce();
    const writtenStatus = mockWriteDaemonStatus.mock.calls[0]![0] as DaemonStatusFile;
    expect(writtenStatus.state).toBe('stopped');
    expect(writtenStatus.startedAt).toBeNull();
    expect(writtenStatus.pid).toBeNull();
  });

  // Finding 7 fix: lastError preserved — not cleared on successful refresh
  it('preserves lastError and lastErrorDetail from existing status on refresh', async () => {
    const errorDetail = {
      code: 'DAEMON_CRASH',
      message: 'Previous daemon error detail',
      recoveryCommand: null,
    };
    const existingStatus = makeExistingStatus({
      lastError: 'DAEMON_CRASH',
      lastErrorDetail: errorDetail,
    });
    mockReadExistingStatus.mockResolvedValue(existingStatus);

    const { registerRefresh } = await import('./refresh.js');
    const program = makeProgram();
    registerRefresh(program);

    await program.parseAsync(['node', 'sparecrow', 'refresh']);

    const writtenStatus = mockWriteDaemonStatus.mock.calls[0]![0] as DaemonStatusFile;
    expect(writtenStatus.lastError).toBe('DAEMON_CRASH');
    expect(writtenStatus.lastErrorDetail).toEqual(errorDetail);
  });

  // AC6: Human-readable output renders via renderStatusOutput
  it('renders human-readable status output in non-JSON mode', async () => {
    const snapshot = makeStatusSnapshot();
    mockLoadStatusSnapshot.mockResolvedValue(snapshot);
    mockRenderStatusOutput.mockReturnValue('rendered status output');

    const { registerRefresh } = await import('./refresh.js');
    const program = makeProgram();
    registerRefresh(program);

    await program.parseAsync(['node', 'sparecrow', 'refresh']);

    expect(mockLoadStatusSnapshot).toHaveBeenCalled();
    expect(mockRenderStatusOutput).toHaveBeenCalledOnce();
    expect(mockRenderStatusOutput).toHaveBeenCalledWith(snapshot, {
      all: false,
      detail: false,
      explain: false,
    });
    expect(stdoutOutput).toContain('rendered status output');
  });

  // Verify writeDaemonStatus is called (atomic write guard — Testing Strategy note)
  it('calls writeDaemonStatus for atomic write semantics', async () => {
    const { registerRefresh } = await import('./refresh.js');
    const program = makeProgram();
    registerRefresh(program);

    await program.parseAsync(['node', 'sparecrow', 'refresh']);

    expect(mockWriteDaemonStatus).toHaveBeenCalledOnce();
    const writtenStatus = mockWriteDaemonStatus.mock.calls[0]![0] as DaemonStatusFile;
    expect(writtenStatus).toHaveProperty('state');
    expect(writtenStatus).toHaveProperty('lastPollAt');
    expect(writtenStatus).toHaveProperty('updatedAt');
    expect(writtenStatus).toHaveProperty('usage');
    expect(writtenStatus).toHaveProperty('trigger');
    expect(writtenStatus).toHaveProperty('queueDepth');
  });
});
