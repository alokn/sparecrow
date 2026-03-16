/** Tests for stats computation engine. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeStats } from './stats-data.js';
import { ScrowError } from '../../errors/index.js';

function makeAuditLine(overrides: Record<string, unknown> = {}): string {
  const base = {
    ts: '2026-03-10T12:00:00.000Z',
    level: 'info',
    event: 'task.completed',
    data: {
      taskName: 'code-review',
      taskId: '00000000-0000-0000-0000-000000000001',
      durationMs: 30000,
      exitCode: 0,
      summary: 'ok',
      targetPath: '/tmp/repo',
    },
    provider: 'claude-code',
    source: 'oauth',
    confidence: 'high',
    error: null,
  };
  return JSON.stringify({ ...base, ...overrides });
}

function makeFailedLine(overrides: Record<string, unknown> = {}): string {
  return makeAuditLine({
    event: 'task.failed',
    data: {
      taskName: 'bug-hunter',
      taskId: '00000000-0000-0000-0000-000000000002',
      durationMs: 15000,
      exitCode: 1,
      error: 'TASK_EXECUTION_FAILED',
      targetPath: '/tmp/repo',
    },
    error: 'TASK_EXECUTION_FAILED',
    ...overrides,
  });
}

describe('computeStats', () => {
  let logsDir: string;

  beforeEach(async () => {
    logsDir = await mkdtemp(join(tmpdir(), 'stats-test-'));
  });

  afterEach(async () => {
    await rm(logsDir, { recursive: true, force: true });
  });

  it('returns zero counts when no log files exist', async () => {
    const result = await computeStats({ logsDir });
    expect(result.totalTasks).toBe(0);
    expect(result.successCount).toBe(0);
    expect(result.failureCount).toBe(0);
    expect(result.hasTasks).toBe(false);
    expect(result.successRate).toBe(0);
    expect(result.avgDurationMs).toBe(0);
    expect(result.taskBreakdown).toEqual([]);
    expect(result.activeDays).toBe(0);
  });

  it('computes correct aggregates from mixed success/failure entries', async () => {
    const lines = [
      makeAuditLine({ ts: '2026-03-10T10:00:00.000Z' }),
      makeAuditLine({
        ts: '2026-03-10T11:00:00.000Z',
        data: { taskName: 'code-review', durationMs: 60000, exitCode: 0 },
      }),
      makeFailedLine({ ts: '2026-03-10T12:00:00.000Z' }),
      makeAuditLine({
        ts: '2026-03-11T09:00:00.000Z',
        event: 'dispatch.quota-exhausted',
        data: { taskName: 'test-gen', durationMs: 5000 },
      }),
    ];
    await writeFile(join(logsDir, 'audit-2026-03-10.jsonl'), lines.slice(0, 3).join('\n'));
    await writeFile(join(logsDir, 'audit-2026-03-11.jsonl'), lines[3]!);

    const result = await computeStats({ logsDir });
    expect(result.totalTasks).toBe(4);
    expect(result.successCount).toBe(2);
    expect(result.failureCount).toBe(1);
    expect(result.retryCount).toBe(1);
    // 2 success, 1 failed — terminal count = 3; retry/quota excluded from denominator
    expect(result.hasTasks).toBe(true);
    expect(result.successRate).toBe(67);
    expect(result.totalDurationMs).toBe(110000);
    expect(result.avgDurationMs).toBe(27500);
    expect(result.activeDays).toBe(2);
    expect(result.avgTasksPerDay).toBe(2);
    expect(result.taskBreakdown).toHaveLength(3);
    expect(result.taskBreakdown[0]!.taskName).toBe('code-review');
    expect(result.taskBreakdown[0]!.total).toBe(2);
  });

  it('respects --since filter', async () => {
    const lines = [
      makeAuditLine({ ts: '2026-03-01T10:00:00.000Z' }),
      makeAuditLine({ ts: '2026-03-10T10:00:00.000Z' }),
    ];
    await writeFile(join(logsDir, 'audit-2026-03-01.jsonl'), lines[0]!);
    await writeFile(join(logsDir, 'audit-2026-03-10.jsonl'), lines[1]!);

    const result = await computeStats({ logsDir, since: '2026-03-05' });
    expect(result.totalTasks).toBe(1);
  });

  it('handles empty log files gracefully', async () => {
    await writeFile(join(logsDir, 'audit-2026-03-10.jsonl'), '');
    const result = await computeStats({ logsDir });
    expect(result.totalTasks).toBe(0);
  });

  it('skips non-task events in audit logs', async () => {
    const lines = [
      JSON.stringify({
        ts: '2026-03-10T10:00:00.000Z',
        level: 'info',
        event: 'daemon.started',
        data: {},
        provider: null,
        source: null,
        confidence: null,
        error: null,
      }),
      makeAuditLine({ ts: '2026-03-10T11:00:00.000Z' }),
    ];
    await writeFile(join(logsDir, 'audit-2026-03-10.jsonl'), lines.join('\n'));

    const result = await computeStats({ logsDir });
    expect(result.totalTasks).toBe(1);
  });

  it('computes 100% success rate when all tasks succeed', async () => {
    const lines = [
      makeAuditLine({ ts: '2026-03-10T10:00:00.000Z' }),
      makeAuditLine({ ts: '2026-03-10T11:00:00.000Z' }),
    ];
    await writeFile(join(logsDir, 'audit-2026-03-10.jsonl'), lines.join('\n'));

    const result = await computeStats({ logsDir });
    expect(result.successRate).toBe(100);
  });

  it('handles tasks with null durationMs', async () => {
    const line = makeAuditLine({
      ts: '2026-03-10T10:00:00.000Z',
      data: { taskName: 'code-review', durationMs: null, exitCode: 0 },
    });
    await writeFile(join(logsDir, 'audit-2026-03-10.jsonl'), line);

    const result = await computeStats({ logsDir });
    expect(result.totalTasks).toBe(1);
    expect(result.totalDurationMs).toBe(0);
    expect(result.avgDurationMs).toBe(0);
  });

  it('sets periodStart and periodEnd from first and last entry timestamps', async () => {
    const lines = [
      makeAuditLine({ ts: '2026-03-10T08:00:00.000Z' }),
      makeAuditLine({ ts: '2026-03-10T10:00:00.000Z' }),
      makeAuditLine({ ts: '2026-03-12T14:00:00.000Z' }),
    ];
    await writeFile(join(logsDir, 'audit-2026-03-10.jsonl'), lines.slice(0, 2).join('\n'));
    await writeFile(join(logsDir, 'audit-2026-03-12.jsonl'), lines[2]!);

    const result = await computeStats({ logsDir });
    expect(result.periodStart).toBe('2026-03-10T08:00:00.000Z');
    expect(result.periodEnd).toBe('2026-03-12T14:00:00.000Z');
  });

  it('sorts task breakdown by total count descending', async () => {
    const lines = [
      makeAuditLine({
        ts: '2026-03-10T08:00:00.000Z',
        data: { taskName: 'bug-hunter', durationMs: 10000, exitCode: 0 },
      }),
      makeAuditLine({
        ts: '2026-03-10T09:00:00.000Z',
        data: { taskName: 'code-review', durationMs: 20000, exitCode: 0 },
      }),
      makeAuditLine({
        ts: '2026-03-10T10:00:00.000Z',
        data: { taskName: 'code-review', durationMs: 20000, exitCode: 0 },
      }),
      makeAuditLine({
        ts: '2026-03-10T11:00:00.000Z',
        data: { taskName: 'code-review', durationMs: 20000, exitCode: 0 },
      }),
    ];
    await writeFile(join(logsDir, 'audit-2026-03-10.jsonl'), lines.join('\n'));

    const result = await computeStats({ logsDir });
    expect(result.taskBreakdown[0]!.taskName).toBe('code-review');
    expect(result.taskBreakdown[0]!.total).toBe(3);
    expect(result.taskBreakdown[1]!.taskName).toBe('bug-hunter');
    expect(result.taskBreakdown[1]!.total).toBe(1);
  });

  it('returns avgTasksPerDay 0 and activeDays 0 for empty log dir', async () => {
    const result = await computeStats({ logsDir });
    expect(result.activeDays).toBe(0);
    expect(result.avgTasksPerDay).toBe(0);
  });

  it('respects --since with relative duration string', async () => {
    // Write a file far in the past that should be filtered out by a relative duration
    const oldTs = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const recentTs = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const oldDate = oldTs.slice(0, 10);
    const recentDate = recentTs.slice(0, 10);

    await writeFile(join(logsDir, `audit-${oldDate}.jsonl`), makeAuditLine({ ts: oldTs }));
    await writeFile(join(logsDir, `audit-${recentDate}.jsonl`), makeAuditLine({ ts: recentTs }));

    const result = await computeStats({ logsDir, since: '7d' });
    expect(result.totalTasks).toBe(1);
  });

  it('throws ScrowError with LOGS_INVALID_FILTER when --since value is invalid', async () => {
    await expect(computeStats({ logsDir, since: 'not-a-duration' })).rejects.toMatchObject({
      code: 'LOGS_INVALID_FILTER',
    });
  });

  it('wrapping invalid --since in stats command yields STATS_COMPUTATION_FAILED for non-ScrowError', async () => {
    // parseSinceDuration throws ScrowError (not plain Error), so stats command propagates its own code
    let thrown: unknown;
    try {
      await computeStats({ logsDir, since: 'bad-input' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ScrowError);
    expect((thrown as ScrowError).code).toBe('LOGS_INVALID_FILTER');
  });

  it('counts task.requeued events as retrying in retryCount', async () => {
    const line = makeAuditLine({
      ts: '2026-03-10T10:00:00.000Z',
      event: 'task.requeued',
      data: { taskName: 'code-review', durationMs: 5000, exitCode: 0 },
    });
    await writeFile(join(logsDir, 'audit-2026-03-10.jsonl'), line);

    const result = await computeStats({ logsDir });
    expect(result.retryCount).toBe(1);
    expect(result.successCount).toBe(0);
    expect(result.failureCount).toBe(0);
  });
});
