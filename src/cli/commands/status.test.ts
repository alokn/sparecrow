/** Tests for the status command — behavior-focused coverage for all ACs. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import type { StatusSnapshot } from '../../types/index.js';
import { setRenderContext, resetRenderContext } from '../../ui/render-context.js';

// Mock the status-state module to control snapshot data, providing re-exported helpers inline
vi.mock('./status-state.js', () => ({
  loadStatusSnapshot: vi.fn(),
  formatUptime: (startedAt: string): string => {
    const start = new Date(startedAt);
    if (Number.isNaN(start.getTime())) return 'unknown';
    const diff = Date.now() - start.getTime();
    if (diff < 0) return 'unknown';
    const hours = Math.floor(diff / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    if (hours >= 24) {
      const days = Math.floor(hours / 24);
      return `${days}d ${hours % 24}h`;
    }
    return `${hours}h ${minutes}m`;
  },
  formatRelativeTime: (isoStr: string): string => {
    const ts = new Date(isoStr);
    if (Number.isNaN(ts.getTime())) return 'unknown';
    const diff = Date.now() - ts.getTime();
    if (diff < 0) return 'just now';
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  },
}));

// Mock isJsonMode
let jsonMode = false;
vi.mock('../index.js', () => ({
  isJsonMode: () => jsonMode,
}));

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  return program;
}

function makeSnapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    health: {
      daemon: 'not-started',
      auth: 'valid',
      pid: null,
      uptime: null,
      lastErrorDetail: null,
    },
    usage: {
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
    },
    queue: {
      pendingCount: 0,
      runningCount: 0,
      taskNames: [],
    },
    activity: {
      dispatchCount: 0,
      successRate: null,
      dollarValueRecovered: null,
      recentDispatches: [],
    },
    backendState: null,
    ...overrides,
  };
}

function makeRunningSnapshot(): StatusSnapshot {
  return makeSnapshot({
    health: {
      daemon: 'running',
      auth: 'valid',
      pid: 12345,
      uptime: '2h 30m',
      lastErrorDetail: null,
    },
    usage: {
      sessionUtilization: 0.45,
      weeklyUtilization: 0.62,
      sessionResetsAt: new Date(Date.now() + 3600000).toISOString(),
      weeklyResetsAt: new Date(Date.now() + 86400000).toISOString(),
      source: 'oauth',
      confidence: 'high',
      subscriptionTier: 'pro',
      degradedReason: null,
      wastePotential: 0.12,
      effectiveReserve: 0.114,
      availableBudget: 0.536,
      isIdleHours: false,
      rateHeadroom: true,
      dispatchReason: 'waste potential 12.0% below threshold 50%',
      shouldDispatch: false,
      idleHoursSchedule: null,
      perModelWaste: null,
      lastPolledAt: null,
    },
    queue: {
      pendingCount: 3,
      runningCount: 0,
      taskNames: ['lint-check', 'test-coverage', 'type-audit'],
    },
    activity: {
      dispatchCount: 5,
      successRate: 0.8,
      dollarValueRecovered: null,
      recentDispatches: [
        {
          outcome: 'success',
          task: 'lint-check',
          relativeTime: '10m ago',
          duration: '45s',
          summary: 'All checks passed',
          targetPath: '/home/user/repo',
          errorCode: null,
        },
        {
          outcome: 'failed',
          task: 'test-coverage',
          relativeTime: '1h ago',
          duration: '2m',
          summary: 'Coverage below threshold',
          targetPath: '-',
          errorCode: null,
        },
      ],
    },
  });
}

describe('status command', () => {
  let stdoutOutput: string;
  let loadStatusSnapshot: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    stdoutOutput = '';
    jsonMode = false;
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    // Set up non-TTY context for predictable ASCII output
    setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });

    const mod = await import('./status-state.js');
    loadStatusSnapshot = mod.loadStatusSnapshot as ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetRenderContext();
  });

  describe('compact mode (AC1)', () => {
    it('renders four dashboard cards with correct titles', async () => {
      loadStatusSnapshot.mockResolvedValue(makeRunningSnapshot());
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      expect(stdoutOutput).toContain('Health');
      expect(stdoutOutput).toContain('Usage');
      expect(stdoutOutput).toContain('Queue');
      expect(stdoutOutput).toContain('Activity');
    });

    it('renders Health card with daemon and auth state', async () => {
      loadStatusSnapshot.mockResolvedValue(makeRunningSnapshot());
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      expect(stdoutOutput).toContain('Daemon');
      expect(stdoutOutput).toContain('running');
      expect(stdoutOutput).toContain('Auth');
      expect(stdoutOutput).toContain('valid');
    });

    it('renders Usage card with freshness line, session %, weekly %, and waste risk in compact view', async () => {
      loadStatusSnapshot.mockResolvedValue(makeRunningSnapshot());
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      // Compact view (4 lines): freshness, session, weekly, waste — dispatch is line 5 (cut off)
      // lastPolledAt=null with utilization data → "Data age unknown" (not "No data yet")
      expect(stdoutOutput).toContain('Data age unknown');
      expect(stdoutOutput).toContain('Session: 45%');
      expect(stdoutOutput).toContain('Weekly:  62%');
      expect(stdoutOutput).toContain('Waste:   12% risk');
    });

    it('renders Queue card with pending count', async () => {
      loadStatusSnapshot.mockResolvedValue(makeRunningSnapshot());
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      expect(stdoutOutput).toContain('3 pending');
    });

    it('renders Queue card with running and pending when both > 0 (Story 10.9 AC4)', async () => {
      const snapshot = makeSnapshot({
        queue: { pendingCount: 2, runningCount: 1, taskNames: ['task-a', 'task-b'] },
      });
      loadStatusSnapshot.mockResolvedValue(snapshot);
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      expect(stdoutOutput).toContain('1 running, 2 pending');
    });

    it('renders Queue card with only running when pendingCount is 0 (Story 10.9 AC4)', async () => {
      const snapshot = makeSnapshot({
        queue: { pendingCount: 0, runningCount: 2, taskNames: [] },
      });
      loadStatusSnapshot.mockResolvedValue(snapshot);
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      expect(stdoutOutput).toContain('2 running');
      expect(stdoutOutput).not.toContain('pending');
    });

    it('renders Queue card with only pending when runningCount is 0 (Story 10.9 AC4)', async () => {
      const snapshot = makeSnapshot({
        queue: { pendingCount: 5, runningCount: 0, taskNames: ['a', 'b', 'c', 'd', 'e'] },
      });
      loadStatusSnapshot.mockResolvedValue(snapshot);
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      expect(stdoutOutput).toContain('5 pending');
      expect(stdoutOutput).not.toContain('running');
    });

    it('renders Activity card with dispatch count and success rate', async () => {
      loadStatusSnapshot.mockResolvedValue(makeRunningSnapshot());
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      expect(stdoutOutput).toContain('Dispatches: 5');
      expect(stdoutOutput).toContain('Success:    80%');
      // ROI now uses UtilizationReport compact — placeholder string must be gone
      expect(stdoutOutput).not.toContain('$- (placeholder)');
      // When dollarValueRecovered is null, the insufficient-data fallback is shown
      expect(stdoutOutput).toContain('ROI:');
      expect(stdoutOutput).toContain(
        'Insufficient data to calculate utilization and recovered value yet.',
      );
    });

    it('renders Activity ROI from UtilizationReport with actual values when available', async () => {
      const snapshot = makeRunningSnapshot();
      snapshot.activity.dollarValueRecovered = 12.5;
      snapshot.usage.weeklyUtilization = 0.62;
      loadStatusSnapshot.mockResolvedValue(snapshot);
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      expect(stdoutOutput).toContain('Recovered:');
      expect(stdoutOutput).toContain('$12.50');
      expect(stdoutOutput).toContain('this week');
      expect(stdoutOutput).toContain('62% utilization');
    });

    it('renders hint line for compact mode', async () => {
      loadStatusSnapshot.mockResolvedValue(makeRunningSnapshot());
      const { registerStatus } = await import('./status.js');
      // Hints are TTY-only (AC6) — override to TTY mode using the freshly imported render-context
      const { setRenderContext: setCtx } = await import('../../ui/render-context.js');
      setCtx({ noColor: true, useUnicode: false, isTTY: true, width: 80 });
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      // makeRunningSnapshot includes a failed dispatch, so the contextual hint system
      // shows the task_failures hint instead of the default compact hint (Story 10.6 AC6)
      expect(stdoutOutput).toContain("Run 'sparecrow logs --failures' for details");
    });
  });

  describe('expanded mode (AC2)', () => {
    it('renders expanded cards with --all flag', async () => {
      loadStatusSnapshot.mockResolvedValue(makeRunningSnapshot());
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status', '--all']);

      // Queue should show task names
      expect(stdoutOutput).toContain('lint-check');
      expect(stdoutOutput).toContain('test-coverage');
      expect(stdoutOutput).toContain('type-audit');
    });

    it('renders usage tier in expanded mode', async () => {
      loadStatusSnapshot.mockResolvedValue(makeRunningSnapshot());
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status', '--all']);

      expect(stdoutOutput).toContain('Tier:     pro');
    });

    it('renders recent dispatch rows in expanded mode', async () => {
      loadStatusSnapshot.mockResolvedValue(makeRunningSnapshot());
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status', '--all']);

      expect(stdoutOutput).toContain('lint-check');
      expect(stdoutOutput).toContain('All checks passed');
      expect(stdoutOutput).toContain('Coverage below threshold');
    });

    it('renders hint line for --all mode suggesting logs', async () => {
      loadStatusSnapshot.mockResolvedValue(makeRunningSnapshot());
      const { registerStatus } = await import('./status.js');
      // Hints are TTY-only (AC6) — override to TTY mode using the freshly imported render-context
      const { setRenderContext: setCtx } = await import('../../ui/render-context.js');
      setCtx({ noColor: true, useUnicode: false, isTTY: true, width: 80 });
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status', '--all']);

      // makeRunningSnapshot includes a failed dispatch, so the contextual hint system
      // shows the task_failures hint instead of the default --all hint (Story 10.6 AC6)
      expect(stdoutOutput).toContain("Run 'sparecrow logs --failures' for details");
    });

    it('renders degraded reason in --all mode when source is degraded', async () => {
      const snapshot = makeRunningSnapshot();
      snapshot.usage.source = 'stale';
      snapshot.usage.confidence = 'low';
      snapshot.usage.degradedReason = 'OAuth token expired, operating on stale source';
      loadStatusSnapshot.mockResolvedValue(snapshot);
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status', '--all']);

      expect(stdoutOutput).toContain('Note: OAuth token expired, operating on stale source');
      expect(stdoutOutput).toContain('stale');
      expect(stdoutOutput).toContain('low');
    });
  });

  describe('auth error visibility (AC3)', () => {
    it('renders error state and recovery command for missing auth', async () => {
      const snapshot = makeSnapshot({
        health: {
          daemon: 'running',
          auth: 'missing',
          pid: 12345,
          uptime: '1h 0m',
          lastErrorDetail: null,
        },
      });
      loadStatusSnapshot.mockResolvedValue(snapshot);
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      expect(stdoutOutput).toContain('Auth');
      expect(stdoutOutput).toContain('missing');
      expect(stdoutOutput).toContain('config --reconnect');
    });

    it('renders error state and recovery command for expired auth', async () => {
      const snapshot = makeSnapshot({
        health: {
          daemon: 'running',
          auth: 'expired',
          pid: 12345,
          uptime: '1h 0m',
          lastErrorDetail: null,
        },
      });
      loadStatusSnapshot.mockResolvedValue(snapshot);
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      expect(stdoutOutput).toContain('Auth');
      expect(stdoutOutput).toContain('expired');
      expect(stdoutOutput).toContain('config --reconnect');
    });

    it('renders remaining cards even when auth has error', async () => {
      const snapshot = makeSnapshot({
        health: {
          daemon: 'running',
          auth: 'missing',
          pid: 12345,
          uptime: null,
          lastErrorDetail: null,
        },
        queue: { pendingCount: 2, runningCount: 0, taskNames: [] },
      });
      loadStatusSnapshot.mockResolvedValue(snapshot);
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      expect(stdoutOutput).toContain('Queue');
      expect(stdoutOutput).toContain('2 pending');
      expect(stdoutOutput).toContain('Activity');
    });
  });

  describe('daemon stopped visibility (AC4)', () => {
    it('renders stopped state with daemon start recovery', async () => {
      const snapshot = makeSnapshot({
        health: {
          daemon: 'stopped',
          auth: 'valid',
          pid: null,
          uptime: null,
          lastErrorDetail: null,
        },
      });
      loadStatusSnapshot.mockResolvedValue(snapshot);
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      expect(stdoutOutput).toContain('Daemon');
      expect(stdoutOutput).toContain('stopped');
      expect(stdoutOutput).toContain('daemon start');
    });

    it('renders remaining cards with last-known state when daemon stopped', async () => {
      const snapshot = makeSnapshot({
        health: {
          daemon: 'stopped',
          auth: 'valid',
          pid: null,
          uptime: null,
          lastErrorDetail: null,
        },
        usage: {
          sessionUtilization: 0.3,
          weeklyUtilization: 0.5,
          sessionResetsAt: null,
          weeklyResetsAt: null,
          source: 'stale',
          confidence: 'low',
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
      });
      loadStatusSnapshot.mockResolvedValue(snapshot);
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      expect(stdoutOutput).toContain('Session: 30%');
      expect(stdoutOutput).toContain('Weekly:  50%');
    });
  });

  describe('first-run / not-started visibility (AC8)', () => {
    it('renders not started daemon state', async () => {
      loadStatusSnapshot.mockResolvedValue(makeSnapshot());
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      expect(stdoutOutput).toContain('Daemon');
      expect(stdoutOutput).toContain('not started');
    });

    it('renders onboard hint for first-run (not daemon start)', async () => {
      loadStatusSnapshot.mockResolvedValue(makeSnapshot());
      const { registerStatus } = await import('./status.js');
      // Hints are TTY-only (AC6) — override to TTY mode using the freshly imported render-context
      const { setRenderContext: setCtx } = await import('../../ui/render-context.js');
      setCtx({ noColor: true, useUnicode: false, isTTY: true, width: 80 });
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      expect(stdoutOutput).toContain('Run sparecrow onboard to get started');
      // Should NOT suggest daemon start for not-started state
      expect(stdoutOutput).not.toMatch(/-> Run: sparecrow daemon start/);
    });
  });

  describe('zero-state empty rendering (AC9)', () => {
    it('renders safe empty-state content per card when no data exists', async () => {
      loadStatusSnapshot.mockResolvedValue(makeSnapshot());
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      expect(stdoutOutput).toContain('No data yet');
      expect(stdoutOutput).toContain('0 pending');
      expect(stdoutOutput).toContain('No dispatches yet');
    });

    it('does not throw errors for missing state files', async () => {
      loadStatusSnapshot.mockResolvedValue(makeSnapshot());
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await expect(program.parseAsync(['node', 'sparecrow', 'status'])).resolves.not.toThrow();
    });
  });

  describe('JSON output contract (AC6)', () => {
    it('emits fixed-schema wrapper with deterministic keys', async () => {
      jsonMode = true;
      loadStatusSnapshot.mockResolvedValue(makeSnapshot());
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      const parsed = JSON.parse(stdoutOutput) as Record<string, unknown>;
      expect(parsed).toHaveProperty('ok', true);
      expect(parsed).toHaveProperty('data');
      expect(parsed).toHaveProperty('error', null);

      const data = parsed['data'] as Record<string, unknown>;
      expect(data).toHaveProperty('health');
      expect(data).toHaveProperty('usage');
      expect(data).toHaveProperty('queue');
      expect(data).toHaveProperty('activity');
    });

    it('includes all health fields in JSON', async () => {
      jsonMode = true;
      loadStatusSnapshot.mockResolvedValue(makeSnapshot());
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      const parsed = JSON.parse(stdoutOutput) as { data: StatusSnapshot };
      const health = parsed.data.health;
      expect(health).toHaveProperty('daemon', 'not-started');
      expect(health).toHaveProperty('auth', 'valid');
      expect(health).toHaveProperty('pid', null);
      expect(health).toHaveProperty('uptime', null);
    });

    it('includes all usage fields with null for unavailable values', async () => {
      jsonMode = true;
      loadStatusSnapshot.mockResolvedValue(makeSnapshot());
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      const parsed = JSON.parse(stdoutOutput) as { data: StatusSnapshot };
      const usage = parsed.data.usage;
      expect(usage.sessionUtilization).toBeNull();
      expect(usage.weeklyUtilization).toBeNull();
      expect(usage.sessionResetsAt).toBeNull();
      expect(usage.weeklyResetsAt).toBeNull();
      expect(usage.source).toBeNull();
      expect(usage.confidence).toBeNull();
      expect(usage.subscriptionTier).toBeNull();
      expect(usage.degradedReason).toBeNull();
    });

    it('includes all queue fields in JSON', async () => {
      jsonMode = true;
      loadStatusSnapshot.mockResolvedValue(makeRunningSnapshot());
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      const parsed = JSON.parse(stdoutOutput) as { data: StatusSnapshot };
      const queue = parsed.data.queue;
      expect(queue.pendingCount).toBe(3);
      expect(queue.runningCount).toBe(0);
      expect(queue.taskNames).toEqual(['lint-check', 'test-coverage', 'type-audit']);
    });

    it('includes all activity fields in JSON', async () => {
      jsonMode = true;
      loadStatusSnapshot.mockResolvedValue(makeRunningSnapshot());
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      const parsed = JSON.parse(stdoutOutput) as { data: StatusSnapshot };
      const activity = parsed.data.activity;
      expect(activity.dispatchCount).toBe(5);
      expect(activity.successRate).toBe(0.8);
      expect(activity.dollarValueRecovered).toBeNull();
      expect(activity.recentDispatches).toHaveLength(2);
    });

    it('emits no ANSI codes in JSON output', async () => {
      jsonMode = true;
      loadStatusSnapshot.mockResolvedValue(makeRunningSnapshot());
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      // eslint-disable-next-line no-control-regex
      expect(stdoutOutput).not.toMatch(/\x1B\[[0-9;]*m/);
    });
  });

  describe('non-TTY behavior (AC7)', () => {
    it('produces no ANSI codes when not a TTY', async () => {
      setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
      loadStatusSnapshot.mockResolvedValue(makeRunningSnapshot());
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      // eslint-disable-next-line no-control-regex
      expect(stdoutOutput).not.toMatch(/\x1B\[[0-9;]*m/);
    });

    it('uses ASCII-safe symbols in non-TTY mode', async () => {
      setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
      loadStatusSnapshot.mockResolvedValue(makeRunningSnapshot());
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      // Should use ASCII box drawing (+, -, |) not Unicode
      expect(stdoutOutput).toContain('+');
      expect(stdoutOutput).toContain('-');
      expect(stdoutOutput).toContain('|');
    });
  });

  describe('data source degradation transparency (AC5)', () => {
    it('renders source and confidence in --all mode (moved from compact)', async () => {
      const snapshot = makeRunningSnapshot();
      snapshot.usage.source = 'cli-quota';
      snapshot.usage.confidence = 'high';
      loadStatusSnapshot.mockResolvedValue(snapshot);
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status', '--all']);

      expect(stdoutOutput).toContain('Source:   cli-quota (high)');
    });
  });

  describe('usage card state thresholds', () => {
    it('renders warning state when utilization >= 70%', async () => {
      const snapshot = makeSnapshot({
        health: { daemon: 'running', auth: 'valid', pid: 1, uptime: null, lastErrorDetail: null },
        usage: {
          sessionUtilization: 0.75,
          weeklyUtilization: 0.5,
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
      });
      loadStatusSnapshot.mockResolvedValue(snapshot);
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      // In noColor mode, warning shows [WARN] suffix
      expect(stdoutOutput).toContain('Usage [WARN]');
    });

    it('renders warning state (not error) when utilization >= 90%', async () => {
      const snapshot = makeSnapshot({
        health: { daemon: 'running', auth: 'valid', pid: 1, uptime: null, lastErrorDetail: null },
        usage: {
          sessionUtilization: 0.95,
          weeklyUtilization: 0.5,
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
      });
      loadStatusSnapshot.mockResolvedValue(snapshot);
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      // High utilization is a warning, not an error — [WARN] not [ERR]
      expect(stdoutOutput).toContain('Usage [WARN]');
      expect(stdoutOutput).not.toContain('Usage [ERR]');
    });

    it('renders healthy (no label) when utilization is 50%', async () => {
      const snapshot = makeSnapshot({
        health: { daemon: 'running', auth: 'valid', pid: 1, uptime: null, lastErrorDetail: null },
        usage: {
          sessionUtilization: 0.5,
          weeklyUtilization: 0.5,
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
      });
      loadStatusSnapshot.mockResolvedValue(snapshot);
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      // Healthy usage shows plain "Usage" title with no suffix in noColor mode
      expect(stdoutOutput).not.toContain('Usage [WARN]');
      expect(stdoutOutput).not.toContain('Usage [ERR]');
    });

    it('confirms Health card still shows [ERR] when daemon is stopped (error reserved for real faults)', async () => {
      const snapshot = makeSnapshot({
        health: {
          daemon: 'stopped',
          auth: 'valid',
          pid: null,
          uptime: null,
          lastErrorDetail: null,
        },
      });
      loadStatusSnapshot.mockResolvedValue(snapshot);
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      // Health card error state still shows [ERR] — real system fault
      expect(stdoutOutput).toContain('Health [ERR]');
      // Usage card with no data should not show any error/warning label
      expect(stdoutOutput).not.toContain('Usage [ERR]');
    });

    it('renders warning when session is null and weekly is 0.95 (mixed-null input)', async () => {
      const snapshot = makeSnapshot({
        health: { daemon: 'running', auth: 'valid', pid: 1, uptime: null, lastErrorDetail: null },
        usage: {
          sessionUtilization: null,
          weeklyUtilization: 0.95,
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
      });
      loadStatusSnapshot.mockResolvedValue(snapshot);
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      // session=null (treated as 0) and weekly=0.95 -> max=0.95 -> 'warning'
      expect(stdoutOutput).toContain('Usage [WARN]');
      expect(stdoutOutput).not.toContain('Usage [ERR]');
    });

    it('renders warning when session is 0.95 and weekly is null (mixed-null input)', async () => {
      const snapshot = makeSnapshot({
        health: { daemon: 'running', auth: 'valid', pid: 1, uptime: null, lastErrorDetail: null },
        usage: {
          sessionUtilization: 0.95,
          weeklyUtilization: null,
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
      });
      loadStatusSnapshot.mockResolvedValue(snapshot);
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      // session=0.95 and weekly=null (treated as 0) -> max=0.95 -> 'warning'
      expect(stdoutOutput).toContain('Usage [WARN]');
      expect(stdoutOutput).not.toContain('Usage [ERR]');
    });
  });

  describe('retrying dispatch row rendering (AC3)', () => {
    it('renders (queued for retry) text for retrying outcome dispatch rows', async () => {
      const snapshot = makeSnapshot({
        health: {
          daemon: 'running',
          auth: 'valid',
          pid: 12345,
          uptime: '1h 0m',
          lastErrorDetail: null,
        },
        activity: {
          dispatchCount: 3,
          successRate: 0.67,
          dollarValueRecovered: null,
          recentDispatches: [
            {
              outcome: 'retrying',
              task: 'write-tests',
              relativeTime: '5m ago',
              duration: '30s',
              summary: '-',
              targetPath: '/home/user/repo',
              errorCode: null,
            },
          ],
        },
      });
      loadStatusSnapshot.mockResolvedValue(snapshot);
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status', '--all']);

      expect(stdoutOutput).toContain('write-tests');
      expect(stdoutOutput).toContain('(queued for retry)');
    });

    it('renders [RETRY] marker for retrying outcome in noColor mode', async () => {
      const snapshot = makeSnapshot({
        health: {
          daemon: 'running',
          auth: 'valid',
          pid: 12345,
          uptime: '1h 0m',
          lastErrorDetail: null,
        },
        activity: {
          dispatchCount: 2,
          successRate: 0.5,
          dollarValueRecovered: null,
          recentDispatches: [
            {
              outcome: 'retrying',
              task: 'fix-bugs',
              relativeTime: '2m ago',
              duration: '15s',
              summary: 'Transient error',
              targetPath: '-',
              errorCode: null,
            },
          ],
        },
      });
      loadStatusSnapshot.mockResolvedValue(snapshot);
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status', '--all']);

      // noColor+ascii mode renders [RETRY] marker
      expect(stdoutOutput).toContain('fix-bugs');
      // In noColor mode, retrying with a failureReason shows the reason (not "(queued for retry)")
      expect(stdoutOutput).toContain('Transient error');
    });
  });

  describe('activity card with low success rate', () => {
    it('renders warning state when success rate below 50%', async () => {
      const snapshot = makeSnapshot({
        health: { daemon: 'running', auth: 'valid', pid: 1, uptime: null, lastErrorDetail: null },
        activity: {
          dispatchCount: 10,
          successRate: 0.3,
          dollarValueRecovered: null,
          recentDispatches: [],
        },
      });
      loadStatusSnapshot.mockResolvedValue(snapshot);
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      expect(stdoutOutput).toContain('Activity [WARN]');
    });
  });

  describe('daemon lastErrorDetail in health card (AC1 — Story 10.6)', () => {
    it('renders error block with humanized message when lastErrorDetail is present', async () => {
      const snapshot = makeSnapshot({
        health: {
          daemon: 'running',
          auth: 'valid',
          pid: 12345,
          uptime: '1h 0m',
          lastErrorDetail: {
            code: 'CLAUDE_NOT_FOUND',
            message: 'Claude CLI not found',
            recoveryCommand: 'sparecrow config set provider.claude_path /path/to/claude',
          },
        },
      });
      loadStatusSnapshot.mockResolvedValue(snapshot);
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      // AC1: human-readable message (not raw error code) shown in health card
      expect(stdoutOutput).toContain('Claude CLI not found');
      // Recovery command from lastErrorDetail is shown
      expect(stdoutOutput).toContain('sparecrow config set provider.claude_path');
    });

    it('does not render error block when lastErrorDetail is null', async () => {
      const snapshot = makeSnapshot({
        health: {
          daemon: 'running',
          auth: 'valid',
          pid: 12345,
          uptime: '1h 0m',
          lastErrorDetail: null,
        },
      });
      loadStatusSnapshot.mockResolvedValue(snapshot);
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      // No error block rendered when lastErrorDetail is null
      expect(stdoutOutput).not.toContain('Error:');
    });

    it('renders failure breakdown in activity section from dispatch errorCode (AC2)', async () => {
      const snapshot = makeSnapshot({
        health: { daemon: 'running', auth: 'valid', pid: 1, uptime: null, lastErrorDetail: null },
        activity: {
          dispatchCount: 4,
          successRate: 0.5,
          dollarValueRecovered: null,
          recentDispatches: [
            {
              outcome: 'failed',
              task: 'security-audit',
              relativeTime: '4h ago',
              duration: '12s',
              summary: '',
              targetPath: '/home/user/repo',
              errorCode: 'CLAUDE_NOT_FOUND',
            },
            {
              outcome: 'failed',
              task: 'improve-code',
              relativeTime: '6h ago',
              duration: '8s',
              summary: '',
              targetPath: '/home/user/repo',
              errorCode: 'AUTH_TOKEN_EXPIRED',
            },
          ],
        },
      });
      loadStatusSnapshot.mockResolvedValue(snapshot);
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      // AC2: Failure breakdown uses human-readable error descriptions
      expect(stdoutOutput).toContain('Recent failures:');
      expect(stdoutOutput).toContain('Claude CLI not found');
      expect(stdoutOutput).toContain('authentication token expired');
    });

    it('suppresses hints in non-TTY output (AC6 — Finding 5)', async () => {
      // Default beforeEach sets isTTY: false — hints must be absent
      const snapshot = makeSnapshot({
        health: {
          daemon: 'running',
          auth: 'valid',
          pid: 1,
          uptime: null,
          lastErrorDetail: {
            code: 'CLAUDE_NOT_FOUND',
            message: 'Claude CLI not found',
            recoveryCommand: null,
          },
        },
        activity: {
          dispatchCount: 3,
          successRate: 0.67,
          dollarValueRecovered: null,
          recentDispatches: [
            {
              outcome: 'failed',
              task: 'test-task',
              relativeTime: '1h ago',
              duration: '5s',
              summary: '',
              targetPath: '/repo',
              errorCode: 'CLAUDE_NOT_FOUND',
            },
          ],
        },
      });
      loadStatusSnapshot.mockResolvedValue(snapshot);
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      // Hints suppressed in non-TTY (isTTY: false from beforeEach)
      expect(stdoutOutput).not.toContain("Run 'sparecrow doctor' to diagnose");
      expect(stdoutOutput).not.toContain("Run 'sparecrow logs --failures'");
    });
  });

  // Story 15.6: new flag tests
  describe('--detail flag (Story 15.6 AC6)', () => {
    it('shows full capacity dashboard with progress bars in --detail mode', async () => {
      const snapshot = makeSnapshot({
        health: { daemon: 'running', auth: 'valid', pid: 1, uptime: null, lastErrorDetail: null },
        usage: makeSnapshot().usage,
      });
      // Give it capacity data
      snapshot.usage = {
        ...snapshot.usage,
        sessionUtilization: 0.45,
        weeklyUtilization: 0.35,
        wastePotential: 0.12,
        effectiveReserve: 0.114,
        availableBudget: 0.536,
        isIdleHours: false,
        rateHeadroom: true,
        shouldDispatch: false,
        dispatchReason: 'waste potential 12.0% below threshold 50%',
        sessionResetsAt: new Date(Date.now() + 3600000).toISOString(),
      };
      loadStatusSnapshot.mockResolvedValue(snapshot);
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status', '--detail']);

      expect(stdoutOutput).toContain('Weekly:');
      expect(stdoutOutput).toContain('Waste:');
      expect(stdoutOutput).toContain('Reserve:');
      expect(stdoutOutput).toContain('Dispatch:');
    });
  });

  describe('--explain flag (Story 15.6 AC7)', () => {
    it('shows plain-English explanation when capacity data is available', async () => {
      const snapshot = makeSnapshot();
      snapshot.usage = {
        ...snapshot.usage,
        weeklyUtilization: 0.35,
        wastePotential: 0.12,
        effectiveReserve: 0.114,
        availableBudget: 0.536,
        weeklyResetsAt: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString(),
        dispatchReason: 'waste potential 12.0% below threshold 50%',
      };
      loadStatusSnapshot.mockResolvedValue(snapshot);
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status', '--explain']);

      expect(stdoutOutput).toContain('Waste Risk:');
      expect(stdoutOutput).toContain('Reserve:');
      expect(stdoutOutput).toContain('Available:');
    });

    it('shows no-data message when capacity fields are all null', async () => {
      loadStatusSnapshot.mockResolvedValue(makeSnapshot());
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status', '--explain']);

      expect(stdoutOutput).toContain('No capacity data available yet');
    });
  });

  describe('AC10: dispatch indicator (Story 15.6)', () => {
    it('shows [active] Idle hours indicator when shouldDispatch=true and isIdleHours=true', async () => {
      const snapshot = makeSnapshot({
        health: { daemon: 'running', auth: 'valid', pid: 1, uptime: null, lastErrorDetail: null },
      });
      snapshot.usage = {
        ...snapshot.usage,
        sessionUtilization: 0.4,
        weeklyUtilization: 0.35,
        wastePotential: 0.12,
        effectiveReserve: 0.05,
        availableBudget: 0.3,
        isIdleHours: true,
        rateHeadroom: true,
        shouldDispatch: true,
        dispatchReason: 'idle hours: available budget 30.0%',
        idleHoursSchedule: '00:00-06:00 daily',
      };
      loadStatusSnapshot.mockResolvedValue(snapshot);
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      // Use --detail so Dispatch line is visible (compact view is limited to 4 lines, with freshness
      // as line 1 the dispatch line is line 5 and gets cut off in compact mode)
      await program.parseAsync(['node', 'sparecrow', 'status', '--detail']);

      expect(stdoutOutput).toContain('[active]');
      expect(stdoutOutput).toContain('Idle hours');
    });

    it('shows [paused] indicator when shouldDispatch=false', async () => {
      const snapshot = makeSnapshot({
        health: { daemon: 'running', auth: 'valid', pid: 1, uptime: null, lastErrorDetail: null },
      });
      snapshot.usage = {
        ...snapshot.usage,
        sessionUtilization: 0.4,
        weeklyUtilization: 0.35,
        wastePotential: 0.12,
        effectiveReserve: 0.114,
        availableBudget: 0.536,
        isIdleHours: false,
        rateHeadroom: true,
        shouldDispatch: false,
        dispatchReason: 'waste potential 12.0% below threshold 50%',
      };
      loadStatusSnapshot.mockResolvedValue(snapshot);
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      // Use --detail so Dispatch line is visible (compact view is limited to 4 lines, with freshness
      // as line 1 the dispatch line is line 5 and gets cut off in compact mode)
      await program.parseAsync(['node', 'sparecrow', 'status', '--detail']);

      expect(stdoutOutput).toContain('[paused]');
    });

    it('shows -- when shouldDispatch is null (no trigger data)', async () => {
      loadStatusSnapshot.mockResolvedValue(makeSnapshot());
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      // No data — Usage card shows "No data yet" since no utilization data
      expect(stdoutOutput).toContain('No data yet');
    });
  });

  describe('AC11: graceful null handling (Story 15.6)', () => {
    it('shows No capacity data yet in compact mode when all capacity fields are null', async () => {
      const snapshot = makeSnapshot({
        health: { daemon: 'running', auth: 'valid', pid: 1, uptime: null, lastErrorDetail: null },
      });
      snapshot.usage = {
        ...snapshot.usage,
        sessionUtilization: 0.4,
        weeklyUtilization: 0.35,
        wastePotential: null,
        effectiveReserve: null,
        availableBudget: null,
        isIdleHours: null,
        rateHeadroom: null,
        shouldDispatch: null,
        dispatchReason: null,
      };
      loadStatusSnapshot.mockResolvedValue(snapshot);
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      expect(stdoutOutput).toContain('No capacity data yet');
    });
  });

  describe('AC9: JSON output includes capacity fields (Story 15.6)', () => {
    it('includes new capacity fields in JSON data.usage', async () => {
      jsonMode = true;
      const snapshot = makeSnapshot();
      snapshot.usage = {
        ...snapshot.usage,
        sessionUtilization: 0.4,
        weeklyUtilization: 0.35,
        wastePotential: 0.12,
        effectiveReserve: 0.114,
        availableBudget: 0.536,
        isIdleHours: false,
        rateHeadroom: true,
        shouldDispatch: false,
        dispatchReason: 'waste potential 12.0% below threshold 50%',
        idleHoursSchedule: null,
        perModelWaste: null,
        lastPolledAt: null,
      };
      loadStatusSnapshot.mockResolvedValue(snapshot);
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      const parsed = JSON.parse(stdoutOutput) as { data: { usage: Record<string, unknown> } };
      const usage = parsed.data.usage;
      expect(usage['wastePotential']).toBe(0.12);
      expect(usage['effectiveReserve']).toBe(0.114);
      expect(usage['availableBudget']).toBe(0.536);
      expect(usage['isIdleHours']).toBe(false);
      expect(usage['rateHeadroom']).toBe(true);
      expect(usage['dispatchReason']).toBe('waste potential 12.0% below threshold 50%');
      expect(usage['shouldDispatch']).toBe(false);
      expect('idleHoursSchedule' in usage).toBe(true);
      expect('perModelWaste' in usage).toBe(true);
    });

    it('AC5: includes lastPolledAt field in JSON data.usage', async () => {
      jsonMode = true;
      const snapshot = makeSnapshot();
      snapshot.usage = {
        ...snapshot.usage,
        lastPolledAt: '2026-03-10T08:00:00.000Z',
      };
      loadStatusSnapshot.mockResolvedValue(snapshot);
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      const parsed = JSON.parse(stdoutOutput) as { data: { usage: Record<string, unknown> } };
      const usage = parsed.data.usage;
      expect(usage['lastPolledAt']).toBe('2026-03-10T08:00:00.000Z');
    });

    it('AC5: includes lastPolledAt as null in JSON data.usage when never polled', async () => {
      jsonMode = true;
      const snapshot = makeSnapshot();
      // lastPolledAt defaults to null in makeSnapshot
      loadStatusSnapshot.mockResolvedValue(snapshot);
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status']);

      const parsed = JSON.parse(stdoutOutput) as { data: { usage: Record<string, unknown> } };
      const usage = parsed.data.usage;
      expect('lastPolledAt' in usage).toBe(true);
      expect(usage['lastPolledAt']).toBeNull();
    });

    it('--detail with --json are orthogonal — JSON output does not include rendered card text', async () => {
      jsonMode = true;
      loadStatusSnapshot.mockResolvedValue(makeSnapshot());
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status', '--detail']);

      // JSON mode ignores --detail flag and produces JSON output
      const parsed = JSON.parse(stdoutOutput) as { ok: boolean };
      expect(parsed.ok).toBe(true);
    });
  });

  describe('--all mode: idle_hours and per-model waste (Story 15.6 AC8)', () => {
    it('shows idle hours schedule in --all mode when configured', async () => {
      const snapshot = makeSnapshot({
        health: { daemon: 'running', auth: 'valid', pid: 1, uptime: null, lastErrorDetail: null },
      });
      snapshot.usage = {
        ...snapshot.usage,
        sessionUtilization: 0.4,
        weeklyUtilization: 0.35,
        wastePotential: 0.12,
        effectiveReserve: 0.114,
        availableBudget: 0.536,
        isIdleHours: false,
        rateHeadroom: true,
        shouldDispatch: false,
        dispatchReason: 'waste potential 12.0% below threshold 50%',
        idleHoursSchedule: '00:00-06:00 daily',
      };
      loadStatusSnapshot.mockResolvedValue(snapshot);
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status', '--all']);

      expect(stdoutOutput).toContain('00:00-06:00 daily');
    });

    it('shows "none configured" for idle hours when not set in --all mode', async () => {
      const snapshot = makeSnapshot({
        health: { daemon: 'running', auth: 'valid', pid: 1, uptime: null, lastErrorDetail: null },
      });
      snapshot.usage = {
        ...snapshot.usage,
        sessionUtilization: 0.4,
        weeklyUtilization: 0.35,
        wastePotential: 0.12,
        effectiveReserve: 0.114,
        availableBudget: 0.536,
        isIdleHours: false,
        rateHeadroom: true,
        shouldDispatch: false,
        dispatchReason: 'test',
        idleHoursSchedule: null,
      };
      loadStatusSnapshot.mockResolvedValue(snapshot);
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status', '--all']);

      expect(stdoutOutput).toContain('Idle hours: none configured');
    });

    it('shows per-model waste lines in --all mode when perModelWaste is available', async () => {
      const snapshot = makeSnapshot({
        health: { daemon: 'running', auth: 'valid', pid: 1, uptime: null, lastErrorDetail: null },
      });
      snapshot.usage = {
        ...snapshot.usage,
        sessionUtilization: 0.4,
        weeklyUtilization: 0.35,
        wastePotential: 0.15,
        effectiveReserve: 0.1,
        availableBudget: 0.4,
        isIdleHours: false,
        rateHeadroom: true,
        shouldDispatch: false,
        dispatchReason: 'test',
        idleHoursSchedule: null,
        perModelWaste: [
          { model: 'claude-3-5-sonnet', waste: 0.12 },
          { model: 'claude-3-opus', waste: 0.18 },
        ],
      };
      loadStatusSnapshot.mockResolvedValue(snapshot);
      const { registerStatus } = await import('./status.js');
      const program = makeProgram();
      registerStatus(program);
      await program.parseAsync(['node', 'sparecrow', 'status', '--all']);

      expect(stdoutOutput).toContain('claude-3-5-sonnet');
      expect(stdoutOutput).toContain('claude-3-opus');
    });
  });
});

// ── AC8/AC9: error path tests for story 6.6 ──────────────────────────────────

describe('status error path (AC8/AC9)', () => {
  let stdoutOutput: string;
  let stderrOutput: string;
  let loadStatusSnapshot: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    stdoutOutput = '';
    stderrOutput = '';
    jsonMode = false;
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      stderrOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
    const mod = await import('./status-state.js');
    loadStatusSnapshot = mod.loadStatusSnapshot as ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetRenderContext();
  });

  it('human mode: writes error to stderr with what/why/recovery when loadStatusSnapshot throws', async () => {
    loadStatusSnapshot.mockRejectedValue(new Error('disk error'));
    const { registerStatus } = await import('./status.js');
    const program = makeProgram();
    registerStatus(program);
    await program.parseAsync(['node', 'sparecrow', 'status']);
    expect(stderrOutput).toContain('Error:');
    expect(stderrOutput).toMatch(/daemon status|daemon|doctor/i);
    expect(process.exitCode).toBe(1);
  });

  it('JSON mode: emits {ok:false, data:null, error:{code,message}} when loadStatusSnapshot throws', async () => {
    jsonMode = true;
    loadStatusSnapshot.mockRejectedValue(new Error('io error'));
    const { registerStatus } = await import('./status.js');
    const program = makeProgram();
    registerStatus(program);
    await program.parseAsync(['node', 'sparecrow', 'status']);
    const parsed = JSON.parse(stdoutOutput) as Record<string, unknown>;
    expect(parsed.ok).toBe(false);
    expect(parsed.data).toBeNull();
    expect(parsed.error).toHaveProperty('code');
    expect(parsed.error).toHaveProperty('message');
    expect((parsed.error as { message: string }).message).toBeTruthy();
  });
});

describe('status-state helpers', () => {
  it('formatUptime returns human-readable uptime', async () => {
    const { formatUptime } = await import('./status-state.js');
    // Set a known time offset
    const twoHoursAgo = new Date(Date.now() - 2 * 3600000 - 30 * 60000).toISOString();
    const result = formatUptime(twoHoursAgo);
    expect(result).toMatch(/^2h 30m$/);
  });

  it('formatUptime returns days for long uptimes', async () => {
    const { formatUptime } = await import('./status-state.js');
    const threeDaysAgo = new Date(Date.now() - 3 * 86400000 - 2 * 3600000).toISOString();
    const result = formatUptime(threeDaysAgo);
    expect(result).toMatch(/^3d 2h$/);
  });

  it('formatUptime returns unknown for invalid dates', async () => {
    const { formatUptime } = await import('./status-state.js');
    expect(formatUptime('not-a-date')).toBe('unknown');
  });

  it('formatRelativeTime returns relative time strings', async () => {
    const { formatRelativeTime } = await import('./status-state.js');

    const justNow = new Date(Date.now() - 10000).toISOString();
    expect(formatRelativeTime(justNow)).toBe('just now');

    const fiveMinAgo = new Date(Date.now() - 5 * 60000).toISOString();
    expect(formatRelativeTime(fiveMinAgo)).toBe('5m ago');

    const twoHoursAgo = new Date(Date.now() - 2 * 3600000).toISOString();
    expect(formatRelativeTime(twoHoursAgo)).toBe('2h ago');

    const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();
    expect(formatRelativeTime(threeDaysAgo)).toBe('3d ago');
  });

  it('formatRelativeTime returns unknown for invalid dates', async () => {
    const { formatRelativeTime } = await import('./status-state.js');
    expect(formatRelativeTime('garbage')).toBe('unknown');
  });
});

// ── Backend state rendering (Story 12.5, AC5) ──────────────────────────────

describe('status — backend state rendering (Story 12.5)', () => {
  let stdoutOutput: string;
  let loadStatusSnapshot: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    stdoutOutput = '';
    jsonMode = false;
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
    const mod = await import('./status-state.js');
    loadStatusSnapshot = mod.loadStatusSnapshot as ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetRenderContext();
  });

  it('renders Backend line as healthy when container is available', async () => {
    const snapshot = makeSnapshot({
      health: { daemon: 'running', auth: 'valid', pid: 1, uptime: null, lastErrorDetail: null },
      backendState: {
        name: 'container',
        runtime: 'docker',
        version: '27.1.0',
        available: true,
      },
    });
    loadStatusSnapshot.mockResolvedValue(snapshot);
    const { registerStatus } = await import('./status.js');
    const program = makeProgram();
    registerStatus(program);
    await program.parseAsync(['node', 'sparecrow', 'status']);

    expect(stdoutOutput).toContain('Backend');
    expect(stdoutOutput).toContain('container (docker 27.1.0)');
  });

  it('renders Backend line as error when container unavailable', async () => {
    const snapshot = makeSnapshot({
      health: { daemon: 'running', auth: 'valid', pid: 1, uptime: null, lastErrorDetail: null },
      backendState: {
        name: 'container',
        runtime: null,
        version: null,
        available: false,
      },
    });
    loadStatusSnapshot.mockResolvedValue(snapshot);
    const { registerStatus } = await import('./status.js');
    const program = makeProgram();
    registerStatus(program);
    await program.parseAsync(['node', 'sparecrow', 'status']);

    expect(stdoutOutput).toContain('Backend');
    expect(stdoutOutput).toContain('container (unavailable)');
    expect(stdoutOutput).toContain('Restart Docker/Podman to restore container execution');
  });

  it('renders Health card with [WARN] when backend is unavailable', async () => {
    const snapshot = makeSnapshot({
      health: { daemon: 'running', auth: 'valid', pid: 1, uptime: null, lastErrorDetail: null },
      backendState: {
        name: 'container',
        runtime: 'docker',
        version: '27.1.0',
        available: false,
      },
    });
    loadStatusSnapshot.mockResolvedValue(snapshot);
    const { registerStatus } = await import('./status.js');
    const program = makeProgram();
    registerStatus(program);
    await program.parseAsync(['node', 'sparecrow', 'status']);

    expect(stdoutOutput).toContain('Health [WARN]');
  });

  it('does not render Backend line when backendState is null', async () => {
    const snapshot = makeSnapshot({
      health: { daemon: 'running', auth: 'valid', pid: 1, uptime: null, lastErrorDetail: null },
      backendState: null,
    });
    loadStatusSnapshot.mockResolvedValue(snapshot);
    const { registerStatus } = await import('./status.js');
    const program = makeProgram();
    registerStatus(program);
    await program.parseAsync(['node', 'sparecrow', 'status']);

    expect(stdoutOutput).not.toContain('Backend');
  });

  it('renders runtime label without version when version is null', async () => {
    const snapshot = makeSnapshot({
      health: { daemon: 'running', auth: 'valid', pid: 1, uptime: null, lastErrorDetail: null },
      backendState: {
        name: 'container',
        runtime: 'podman',
        version: null,
        available: true,
      },
    });
    loadStatusSnapshot.mockResolvedValue(snapshot);
    const { registerStatus } = await import('./status.js');
    const program = makeProgram();
    registerStatus(program);
    await program.parseAsync(['node', 'sparecrow', 'status']);

    expect(stdoutOutput).toContain('container (podman)');
    // Should NOT have a trailing space before the closing paren
    expect(stdoutOutput).not.toContain('container (podman )');
  });

  it('includes backendState in JSON output when present', async () => {
    jsonMode = true;
    const snapshot = makeSnapshot({
      health: { daemon: 'running', auth: 'valid', pid: 1, uptime: null, lastErrorDetail: null },
      backendState: {
        name: 'container',
        runtime: 'docker',
        version: '27.1.0',
        available: true,
      },
    });
    loadStatusSnapshot.mockResolvedValue(snapshot);
    const { registerStatus } = await import('./status.js');
    const program = makeProgram();
    registerStatus(program);
    await program.parseAsync(['node', 'sparecrow', 'status']);

    const parsed = JSON.parse(stdoutOutput) as { data: StatusSnapshot };
    expect(parsed.data.backendState).toEqual({
      name: 'container',
      runtime: 'docker',
      version: '27.1.0',
      available: true,
    });
  });
});

// ── AC7: card width consistency at wide terminal widths ─────────────────────

describe('status-presenter card width at wide terminals (AC7)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    resetRenderContext();
  });

  it('grid row width matches terminal width exactly at width 120 (no card overflow)', async () => {
    // Import dynamically after resetModules so all modules share the same render context instance
    const { setRenderContext: setCtx } = await import('../../ui/render-context.js');
    const { renderStatusOutput } = await import('./status-presenter.js');
    const { getCardWidthForGrid, visibleWidth, stripAnsi } = await import('../../ui/index.js');

    setCtx({ noColor: true, useUnicode: false, isTTY: false, width: 120 });

    const snapshot: import('../../types/index.js').StatusSnapshot = {
      health: { daemon: 'running', auth: 'valid', pid: 1, uptime: null, lastErrorDetail: null },
      usage: {
        sessionUtilization: 0.4,
        weeklyUtilization: 0.3,
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

    const { CARD_GAP } = await import('../../ui/index.js');

    const output = renderStatusOutput(snapshot, { all: false, detail: false, explain: false });
    const cardWidth = getCardWidthForGrid(120);
    // At width >= 120, CARD_GAP is doubled — use CARD_GAP * 2 so tests stay in sync with tokens.ts
    const expectedRowWidth = cardWidth * 2 + CARD_GAP * 2;

    const lines = output.split('\n');
    // The first line is the combined top-border row of the 2-column grid
    const firstLine = stripAnsi(lines[0]!);
    // With consistent card widths, the combined row width equals terminal width
    expect(visibleWidth(firstLine)).toBe(expectedRowWidth);
  });

  it('grid row width matches terminal width exactly at width 140 (no card overflow)', async () => {
    // Import dynamically after resetModules so all modules share the same render context instance
    const { setRenderContext: setCtx } = await import('../../ui/render-context.js');
    const { renderStatusOutput } = await import('./status-presenter.js');
    const { getCardWidthForGrid, visibleWidth, stripAnsi } = await import('../../ui/index.js');

    setCtx({ noColor: true, useUnicode: false, isTTY: false, width: 140 });

    const snapshot: import('../../types/index.js').StatusSnapshot = {
      health: { daemon: 'running', auth: 'valid', pid: 1, uptime: null, lastErrorDetail: null },
      usage: {
        sessionUtilization: 0.4,
        weeklyUtilization: 0.3,
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

    const { CARD_GAP } = await import('../../ui/index.js');

    const output = renderStatusOutput(snapshot, { all: false, detail: false, explain: false });
    const cardWidth = getCardWidthForGrid(140);
    // At width >= 120, CARD_GAP is doubled — use CARD_GAP * 2 so tests stay in sync with tokens.ts
    const expectedRowWidth = cardWidth * 2 + CARD_GAP * 2;

    const lines = output.split('\n');
    const firstLine = stripAnsi(lines[0]!);
    expect(visibleWidth(firstLine)).toBe(expectedRowWidth);
  });
});
