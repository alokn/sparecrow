/** Tests for sparecrow stats CLI command. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { StatsData } from './stats-data.js';

const MOCK_STATS: StatsData = {
  periodStart: '2026-03-01T10:00:00.000Z',
  periodEnd: '2026-03-10T15:00:00.000Z',
  totalTasks: 10,
  successCount: 8,
  failureCount: 1,
  retryCount: 1,
  hasTasks: true,
  successRate: 89,
  totalDurationMs: 300000,
  avgDurationMs: 30000,
  taskBreakdown: [
    { taskName: 'code-review', total: 6, succeeded: 5, failed: 1, retried: 0 },
    { taskName: 'bug-hunter', total: 4, succeeded: 3, failed: 0, retried: 1 },
  ],
  activeDays: 5,
  avgTasksPerDay: 2,
};

const EMPTY_STATS: StatsData = {
  periodStart: new Date().toISOString(),
  periodEnd: new Date().toISOString(),
  totalTasks: 0,
  successCount: 0,
  failureCount: 0,
  retryCount: 0,
  hasTasks: false,
  successRate: 0,
  totalDurationMs: 0,
  avgDurationMs: 0,
  taskBreakdown: [],
  activeDays: 0,
  avgTasksPerDay: 0,
};

describe('registerStats', () => {
  let mockProgram: {
    command: ReturnType<typeof vi.fn>;
  };
  let actionHandler: (options: Record<string, unknown>) => Promise<void>;

  afterEach(() => {
    process.exitCode = undefined;
  });

  beforeEach(async () => {
    vi.resetModules();

    vi.doMock('../index.js', () => ({
      isJsonMode: vi.fn(() => false),
    }));

    vi.doMock('../../ui/index.js', () => ({
      printJson: vi.fn((obj: unknown) => {
        process.stdout.write(JSON.stringify(obj));
      }),
      color: {
        bold: (s: string) => s,
        dim: (s: string) => s,
        green: (s: string) => s,
        red: (s: string) => s,
        yellow: (s: string) => s,
      },
    }));

    vi.doMock('../../types/index.js', () => ({
      jsonOk: (data: unknown) => ({ ok: true, data, error: null }),
      jsonError: (code: string, message: string) => ({
        ok: false,
        data: null,
        error: { code, message },
      }),
    }));

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({
        logs: '/tmp/fake-logs',
        data: '/tmp/fake-data',
        config: '/tmp/fake-config',
        taskOutputs: '/tmp/fake-outputs',
      }),
    }));

    vi.doMock('../../errors/index.js', () => {
      class ScrowError extends Error {
        code: string;
        constructor(code: string, message: string) {
          super(message);
          this.code = code;
        }
      }
      return {
        ScrowError,
        ErrorCode: { STATS_COMPUTATION_FAILED: 'STATS_COMPUTATION_FAILED' },
      };
    });

    vi.doMock('./stats-data.js', () => ({
      computeStats: vi.fn().mockResolvedValue(MOCK_STATS),
    }));

    const commandObj = {
      description: vi.fn().mockReturnThis(),
      option: vi.fn().mockReturnThis(),
      action: vi.fn().mockImplementation((fn: unknown) => {
        actionHandler = fn as (options: Record<string, unknown>) => Promise<void>;
        return commandObj;
      }),
    };

    mockProgram = {
      command: vi.fn(() => commandObj),
    };

    const { registerStats } = await import('./stats.js');
    registerStats(mockProgram as never);
  });

  it('registers the stats command', () => {
    expect(mockProgram.command).toHaveBeenCalledWith('stats');
  });

  it('renders human output with task data', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await actionHandler({});
    const output = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('Usage Statistics');
    expect(output).toContain('Total tasks:');
    expect(output).toContain('10');
    expect(output).toContain('89%');
    expect(output).toContain('code-review');
    writeSpy.mockRestore();
  });

  it('renders empty state message when no tasks', async () => {
    const { computeStats } = await import('./stats-data.js');
    vi.mocked(computeStats).mockResolvedValue(EMPTY_STATS);

    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await actionHandler({});
    const output = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('No task executions found');
    writeSpy.mockRestore();
  });

  it('outputs JSON when json mode is enabled', async () => {
    const { isJsonMode } = await import('../index.js');
    vi.mocked(isJsonMode).mockReturnValue(true);

    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await actionHandler({});
    const output = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    const parsed = JSON.parse(output) as { ok: boolean; data: StatsData };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.totalTasks).toBe(10);
    writeSpy.mockRestore();
  });

  it('handles computation errors gracefully', async () => {
    const { computeStats } = await import('./stats-data.js');
    vi.mocked(computeStats).mockRejectedValue(new Error('disk failure'));

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await actionHandler({});
    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('disk failure');
    expect(process.exitCode).toBe(1);
    stderrSpy.mockRestore();
  });

  it('passes --since option to computeStats', async () => {
    const { computeStats } = await import('./stats-data.js');
    await actionHandler({ since: '7d' });
    expect(computeStats).toHaveBeenCalledWith({ logsDir: '/tmp/fake-logs', since: '7d' });
  });

  it('omits since from computeStats call when not provided', async () => {
    const { computeStats } = await import('./stats-data.js');
    await actionHandler({});
    expect(computeStats).toHaveBeenCalledWith({ logsDir: '/tmp/fake-logs' });
  });

  it('outputs JSON error when computation fails in json mode', async () => {
    const { computeStats } = await import('./stats-data.js');
    vi.mocked(computeStats).mockRejectedValue(new Error('io error'));

    const { isJsonMode } = await import('../index.js');
    vi.mocked(isJsonMode).mockReturnValue(true);

    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await actionHandler({});
    const output = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    const parsed = JSON.parse(output) as { ok: boolean; error: { code: string; message: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe('STATS_COMPUTATION_FAILED');
    writeSpy.mockRestore();
  });

  it('propagates ScrowError code unchanged (e.g. LOGS_INVALID_FILTER from parseSinceDuration)', async () => {
    const { computeStats } = await import('./stats-data.js');
    const { ScrowError } = await import('../../errors/index.js');
    vi.mocked(computeStats).mockRejectedValue(
      new ScrowError('LOGS_INVALID_FILTER', 'Invalid --since value: "bad"'),
    );

    const { isJsonMode } = await import('../index.js');
    vi.mocked(isJsonMode).mockReturnValue(true);

    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await actionHandler({ since: 'bad' });
    const output = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    const parsed = JSON.parse(output) as { ok: boolean; error: { code: string; message: string } };
    expect(parsed.ok).toBe(false);
    // ScrowError from parseSinceDuration is re-thrown as-is, preserving LOGS_INVALID_FILTER code
    expect(parsed.error.code).toBe('LOGS_INVALID_FILTER');
    writeSpy.mockRestore();
  });

  it('handles ScrowError in json mode with its own error code', async () => {
    const { computeStats } = await import('./stats-data.js');
    const { ScrowError, ErrorCode } = await import('../../errors/index.js');
    vi.mocked(computeStats).mockRejectedValue(
      new ScrowError(ErrorCode.STATS_COMPUTATION_FAILED, 'something failed'),
    );

    const { isJsonMode } = await import('../index.js');
    vi.mocked(isJsonMode).mockReturnValue(true);

    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await actionHandler({});
    const output = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    const parsed = JSON.parse(output) as { ok: boolean; error: { code: string; message: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe('STATS_COMPUTATION_FAILED');
    writeSpy.mockRestore();
  });

  it('renders retry/quota count when retryCount is positive', async () => {
    const { computeStats } = await import('./stats-data.js');
    vi.mocked(computeStats).mockResolvedValue({ ...MOCK_STATS, retryCount: 3 });

    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await actionHandler({});
    const output = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('Retried/Quota');
    expect(output).toContain('3');
    writeSpy.mockRestore();
  });

  it('shows N/A for success rate and avg duration when hasTasks is false', async () => {
    const { computeStats } = await import('./stats-data.js');
    vi.mocked(computeStats).mockResolvedValue({
      ...MOCK_STATS,
      hasTasks: false,
      successRate: 0,
      avgDurationMs: 0,
      totalTasks: 5,
    });

    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await actionHandler({});
    const output = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('N/A');
    writeSpy.mockRestore();
  });
});
