/** Tests for `sparecrow logs --output <taskId>` and output column in summary table. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Command } from 'commander';
import type { LogQueryResult, LogEntry } from '../../types/index.js';

// ---- shared test state ----
let jsonMode = false;
let taskOutputsDir: string;
let mockQueryResult: LogQueryResult;

// Set up temp dir for task outputs before module-level mocks
const TMP_BASE = join(tmpdir(), 'sparecrow-logs-output-test');

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  return program;
}

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    timestamp: '2026-02-25T10:30:00.000Z',
    level: 'info',
    event: 'task.completed',
    outcome: 'success',
    taskName: 'security-audit',
    taskId: 'abc-123',
    durationMs: 45000,
    exitCode: 0,
    summary: 'Found 2 issues',
    targetPath: '/home/user/repo',
    stdout: 'Task output here',
    stderr: null,
    tokensIn: null,
    tokensOut: null,
    provider: 'claude-code',
    source: 'executor',
    confidence: 'high',
    error: null,
    ...overrides,
  };
}

describe('logs --output', () => {
  let stdoutOutput: string;
  let stderrOutput: string;

  beforeEach(async () => {
    taskOutputsDir = join(TMP_BASE, randomBytes(6).toString('hex'));
    await mkdir(taskOutputsDir, { recursive: true });
    jsonMode = false;
    mockQueryResult = {
      entries: [],
      total: 0,
      successCount: 0,
      failureCount: 0,
      failureSummary: [],
    };
    stdoutOutput = '';
    stderrOutput = '';
    vi.resetModules();

    vi.doMock('../index.js', () => ({
      isJsonMode: () => jsonMode,
    }));

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({
        logs: '/fake/logs',
        data: '/fake/data',
        config: '/fake/config',
        taskOutputs: taskOutputsDir,
      }),
    }));

    vi.doMock('./log-reader.js', () => ({
      queryLogs: vi.fn(async () => mockQueryResult),
      parseSinceDuration: vi.fn(() => new Date()),
    }));

    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      stderrOutput += String(data);
      return true;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(TMP_BASE, { recursive: true, force: true }).catch(() => {});
  });

  describe('human mode', () => {
    it('prints file contents when output file exists', async () => {
      const taskId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      await writeFile(join(taskOutputsDir, `${taskId}.txt`), 'Hello from Claude');
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      await program.parseAsync(['node', 'sparecrow', 'logs', '--output', taskId]);
      expect(stdoutOutput).toContain('Hello from Claude');
    });

    it('prints error to stderr and sets exitCode=1 when file does not exist', async () => {
      const taskId = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      const originalExitCode = process.exitCode;
      await program.parseAsync(['node', 'sparecrow', 'logs', '--output', taskId]);
      expect(stderrOutput).toContain(`No output found for task ${taskId}`);
      expect(process.exitCode).toBe(1);
      process.exitCode = originalExitCode;
    });

    it('prints error to stderr and sets exitCode=1 for invalid (non-UUID) task ID', async () => {
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      const originalExitCode = process.exitCode;
      await program.parseAsync(['node', 'sparecrow', 'logs', '--output', 'nonexistent-id']);
      expect(stderrOutput).toContain('Invalid task ID format');
      expect(process.exitCode).toBe(1);
      process.exitCode = originalExitCode;
    });
  });

  describe('JSON mode', () => {
    it('returns ok=true with taskId and output when file exists', async () => {
      jsonMode = true;
      const taskId = 'c3d4e5f6-a7b8-9012-cdef-123456789012';
      await writeFile(join(taskOutputsDir, `${taskId}.txt`), 'JSON output content');
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      await program.parseAsync(['node', 'sparecrow', 'logs', '--output', taskId]);
      const parsed = JSON.parse(stdoutOutput) as {
        ok: boolean;
        data: { taskId: string; output: string };
        error: null;
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.data.taskId).toBe(taskId);
      expect(parsed.data.output).toBe('JSON output content');
      expect(parsed.error).toBeNull();
    });

    it('returns ok=false with TASK_OUTPUT_NOT_FOUND when file does not exist', async () => {
      jsonMode = true;
      const taskId = 'd4e5f6a7-b8c9-0123-defa-234567890123';
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      await program.parseAsync(['node', 'sparecrow', 'logs', '--output', taskId]);
      const parsed = JSON.parse(stdoutOutput) as {
        ok: boolean;
        data: null;
        error: { code: string; message: string };
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.data).toBeNull();
      expect(parsed.error.code).toBe('TASK_OUTPUT_NOT_FOUND');
      expect(parsed.error.message).toContain(`No output found for task ${taskId}`);
    });

    it('returns ok=false with TASK_OUTPUT_NOT_FOUND for invalid (non-UUID) task ID', async () => {
      jsonMode = true;
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      await program.parseAsync(['node', 'sparecrow', 'logs', '--output', 'missing-task']);
      const parsed = JSON.parse(stdoutOutput) as {
        ok: boolean;
        data: null;
        error: { code: string; message: string };
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.data).toBeNull();
      expect(parsed.error.code).toBe('TASK_OUTPUT_NOT_FOUND');
      expect(parsed.error.message).toContain('Invalid task ID format');
    });
  });
});

describe('logs summary table output column', () => {
  let stdoutOutput: string;

  beforeEach(async () => {
    taskOutputsDir = join(TMP_BASE, randomBytes(6).toString('hex'));
    await mkdir(taskOutputsDir, { recursive: true });
    jsonMode = false;
    mockQueryResult = {
      entries: [],
      total: 0,
      successCount: 0,
      failureCount: 0,
      failureSummary: [],
    };
    stdoutOutput = '';
    vi.resetModules();

    vi.doMock('../index.js', () => ({
      isJsonMode: () => jsonMode,
    }));

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({
        logs: '/fake/logs',
        data: '/fake/data',
        config: '/fake/config',
        taskOutputs: taskOutputsDir,
      }),
    }));

    vi.doMock('./log-reader.js', () => ({
      queryLogs: vi.fn(async () => mockQueryResult),
      parseSinceDuration: vi.fn(() => new Date()),
    }));

    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(TMP_BASE, { recursive: true, force: true }).catch(() => {});
  });

  it('shows Output: yes when task output file exists', async () => {
    await writeFile(join(taskOutputsDir, 'abc-123.txt'), 'output content');
    mockQueryResult = {
      entries: [makeEntry({ taskId: 'abc-123' })],
      total: 1,
      successCount: 1,
      failureCount: 0,
      failureSummary: [],
    };
    const { registerLogs } = await import('./logs.js');
    const program = makeProgram();
    registerLogs(program);
    await program.parseAsync(['node', 'sparecrow', 'logs']);
    expect(stdoutOutput).toContain('yes');
    expect(stdoutOutput).toContain('Output:');
  });

  it('shows Output: no when task output file does not exist', async () => {
    mockQueryResult = {
      entries: [makeEntry({ taskId: 'no-output-task' })],
      total: 1,
      successCount: 1,
      failureCount: 0,
      failureSummary: [],
    };
    const { registerLogs } = await import('./logs.js');
    const program = makeProgram();
    registerLogs(program);
    await program.parseAsync(['node', 'sparecrow', 'logs']);
    expect(stdoutOutput).toContain('no');
    expect(stdoutOutput).toContain('Output:');
  });

  it('shows hint line when at least one entry has output available', async () => {
    await writeFile(join(taskOutputsDir, 'abc-123.txt'), 'output content');
    mockQueryResult = {
      entries: [makeEntry({ taskId: 'abc-123' })],
      total: 1,
      successCount: 1,
      failureCount: 0,
      failureSummary: [],
    };
    const { registerLogs } = await import('./logs.js');
    const program = makeProgram();
    registerLogs(program);
    await program.parseAsync(['node', 'sparecrow', 'logs']);
    expect(stdoutOutput).toContain('sparecrow logs --output <task-id>');
  });

  it('does not show hint line when no entries have output', async () => {
    mockQueryResult = {
      entries: [makeEntry({ taskId: 'no-output' })],
      total: 1,
      successCount: 1,
      failureCount: 0,
      failureSummary: [],
    };
    const { registerLogs } = await import('./logs.js');
    const program = makeProgram();
    registerLogs(program);
    await program.parseAsync(['node', 'sparecrow', 'logs']);
    expect(stdoutOutput).not.toContain('sparecrow logs --output <task-id>');
  });
});
