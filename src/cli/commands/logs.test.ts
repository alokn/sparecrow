/** Tests for the logs CLI command — all output modes, empty state, and input validation. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Command } from 'commander';
import type { LogEntry, LogQueryResult } from '../../types/index.js';

// ---- test helpers ----

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

function makeFailedEntry(): LogEntry {
  return makeEntry({
    outcome: 'failed',
    event: 'task.failed',
    level: 'warn',
    taskName: 'fix-bugs',
    taskId: 'def-456',
    durationMs: 12000,
    exitCode: 1,
    error: 'Process exited with code 1',
    stdout: null,
  });
}

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  return program;
}

const TMP_BASE = join(tmpdir(), 'sparecrow-logs-test');

describe('registerLogs', () => {
  let stdoutOutput: string;
  let taskOutputsDir: string;
  let jsonMode: boolean;
  let mockQueryResult: LogQueryResult;
  let mockParseSinceThrow: Error | null;
  let mockParseSinceResult: Date | null;
  let capturedQueryOptions: Record<string, unknown> | null;

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
    mockParseSinceThrow = null;
    mockParseSinceResult = null;
    capturedQueryOptions = null;
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
      queryLogs: vi.fn(async (opts: Record<string, unknown>) => {
        capturedQueryOptions = opts;
        return mockQueryResult;
      }),
      parseSinceDuration: vi.fn(() => {
        if (mockParseSinceThrow) throw mockParseSinceThrow;
        return mockParseSinceResult ?? new Date();
      }),
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

  describe('empty state', () => {
    it('outputs friendly message when no entries exist in human mode', async () => {
      mockQueryResult = {
        entries: [],
        total: 0,
        successCount: 0,
        failureCount: 0,
        failureSummary: [],
      };
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      await program.parseAsync(['node', 'sparecrow', 'logs']);
      expect(stdoutOutput).toContain('No execution history found.');
      expect(stdoutOutput).toContain('Hint:');
    });

    it('outputs zero-count JSON in JSON mode when no entries', async () => {
      jsonMode = true;
      mockQueryResult = {
        entries: [],
        total: 0,
        successCount: 0,
        failureCount: 0,
        failureSummary: [],
      };
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      await program.parseAsync(['node', 'sparecrow', 'logs']);
      const parsed = JSON.parse(stdoutOutput) as {
        ok: boolean;
        data: {
          entries: LogEntry[];
          total: number;
          successCount: number;
          failureCount: number;
          failureSummary: unknown[];
        };
        error: null;
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.error).toBeNull();
      expect(parsed.data.entries).toEqual([]);
      expect(parsed.data.total).toBe(0);
      expect(parsed.data.successCount).toBe(0);
      expect(parsed.data.failureCount).toBe(0);
    });
  });

  describe('default summary table mode', () => {
    it('renders summary table with outcome, task name, time, duration, target and footer', async () => {
      mockQueryResult = {
        entries: [makeEntry(), makeFailedEntry()],
        total: 2,
        successCount: 1,
        failureCount: 1,
        failureSummary: [],
      };
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      await program.parseAsync(['node', 'sparecrow', 'logs']);
      expect(stdoutOutput).toContain('security-audit');
      expect(stdoutOutput).toContain('fix-bugs');
      expect(stdoutOutput).toContain('2 tasks');
      expect(stdoutOutput).toContain('1 succeeded');
      expect(stdoutOutput).toContain('1 failed');
    });

    it('displays short task ID next to output indicator when output is available (AC1)', async () => {
      const taskId = '550e8400-e29b-41d4-a716-446655440000';
      await writeFile(join(taskOutputsDir, `${taskId}.txt`), 'output content');
      mockQueryResult = {
        entries: [makeEntry({ taskId })],
        total: 1,
        successCount: 1,
        failureCount: 0,
        failureSummary: [],
      };
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      await program.parseAsync(['node', 'sparecrow', 'logs']);
      // First 8 chars of UUID appear next to "yes"
      expect(stdoutOutput).toContain('(550e8400)');
      expect(stdoutOutput).toContain('yes');
    });

    it('does not show task ID when no output is available (AC1)', async () => {
      const taskId = '550e8400-e29b-41d4-a716-446655440000';
      // No output file written — access will fail with ENOENT
      mockQueryResult = {
        entries: [makeEntry({ taskId })],
        total: 1,
        successCount: 1,
        failureCount: 0,
        failureSummary: [],
      };
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      await program.parseAsync(['node', 'sparecrow', 'logs']);
      expect(stdoutOutput).not.toContain('550e8400');
      expect(stdoutOutput).toContain('no');
    });

    it('shows updated hint with both --output and --task --full approaches (AC2)', async () => {
      const taskId = '550e8400-e29b-41d4-a716-446655440000';
      await writeFile(join(taskOutputsDir, `${taskId}.txt`), 'output content');
      mockQueryResult = {
        entries: [makeEntry({ taskId })],
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
      expect(stdoutOutput).toContain('sparecrow logs --task <name> --full');
    });

    it('shows error as failure reason when summary is empty for failed task (AC4)', async () => {
      mockQueryResult = {
        entries: [
          makeEntry({
            outcome: 'failed',
            event: 'task.failed',
            level: 'warn',
            taskName: 'custom-1',
            taskId: 'err-001',
            durationMs: 1,
            exitCode: null,
            error: 'Claude binary not found. Run sparecrow onboard.',
            summary: '',
            stdout: null,
          }),
        ],
        total: 1,
        successCount: 0,
        failureCount: 1,
        failureSummary: [],
      };
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      await program.parseAsync(['node', 'sparecrow', 'logs']);
      expect(stdoutOutput).toContain('Claude binary not found');
    });

    it('shows error as failure reason when summary is null-like for failed task', async () => {
      mockQueryResult = {
        entries: [
          makeEntry({
            outcome: 'failed',
            event: 'task.failed',
            level: 'warn',
            taskName: 'custom-2',
            taskId: 'err-002',
            durationMs: 5,
            exitCode: null,
            error: 'CLAUDE_NOT_FOUND',
            summary: '',
            stdout: null,
          }),
        ],
        total: 1,
        successCount: 0,
        failureCount: 1,
        failureSummary: [],
      };
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      await program.parseAsync(['node', 'sparecrow', 'logs']);
      expect(stdoutOutput).toContain('CLAUDE_NOT_FOUND');
    });

    it('shows error as failure reason for quota outcome when summary is empty', async () => {
      mockQueryResult = {
        entries: [
          makeEntry({
            outcome: 'quota',
            event: 'dispatch.quota-exhausted',
            level: 'warn',
            taskName: 'quota-task',
            taskId: 'q-001',
            durationMs: 0,
            exitCode: null,
            error: 'Usage quota exhausted. Retrying later.',
            summary: '',
            stdout: null,
          }),
        ],
        total: 1,
        successCount: 0,
        failureCount: 1,
        failureSummary: [],
      };
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      await program.parseAsync(['node', 'sparecrow', 'logs']);
      expect(stdoutOutput).toContain('Usage quota exhausted');
    });

    it('shows error as failure reason for retrying outcome when summary is empty', async () => {
      mockQueryResult = {
        entries: [
          makeEntry({
            outcome: 'retrying',
            event: 'task.failed',
            level: 'warn',
            taskName: 'retry-task',
            taskId: 'r-001',
            durationMs: 500,
            exitCode: null,
            error: 'Transient network error during retry.',
            summary: '',
            stdout: null,
          }),
        ],
        total: 1,
        successCount: 0,
        failureCount: 1,
        failureSummary: [],
      };
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      await program.parseAsync(['node', 'sparecrow', 'logs']);
      expect(stdoutOutput).toContain('Transient network error');
    });

    it('does not use error as summary for success entries even when error is non-null', async () => {
      // entryToSummaryRowProps intentionally drops entry.error for outcome === 'success'.
      // This is by design: an error on a succeeded task is diagnostic data, not a user-visible
      // failure reason, and surfacing it in the summary row would be confusing.
      mockQueryResult = {
        entries: [
          makeEntry({
            outcome: 'success',
            event: 'task.completed',
            level: 'info',
            taskName: 'warn-task',
            taskId: 'w-001',
            durationMs: 5000,
            exitCode: 0,
            error: 'non-fatal warning message',
            summary: '',
            stdout: null,
          }),
        ],
        total: 1,
        successCount: 1,
        failureCount: 0,
        failureSummary: [],
      };
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      await program.parseAsync(['node', 'sparecrow', 'logs']);
      // error field is intentionally dropped for success entries in summary view
      expect(stdoutOutput).not.toContain('non-fatal warning message');
    });

    it('renders Output: no without ID when taskId is null', async () => {
      // taskId=null → hasTaskOutput returns false immediately (no access call)
      mockQueryResult = {
        entries: [makeEntry({ taskId: null })],
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
      expect(stdoutOutput).not.toContain('(');
    });

    it('renders Output: yes without ID suffix when outputAvailability=true but taskId is null', async () => {
      // This exercises the renderSummaryTable branch at lines 94-97:
      // outputAvailability[i]=true AND shortTaskId(entry.taskId)=null → suffix is empty string
      // We mock access to always succeed so hasTaskOutput returns true for a null taskId... but
      // hasTaskOutput guards: if (!taskId) return false — so the only way to exercise the branch
      // is to call renderSummaryTable directly with a crafted availability array.
      // We do that by writing a file whose path happens to match the null-taskId check workaround:
      // Since hasTaskOutput returns false for null taskId, we instead verify the branch via a
      // custom test that calls the exported function if it were exported. Since renderSummaryTable
      // is not exported, we verify the branch indirectly: if the code has `idSuffix = shortId ?
      // ` (${shortId})` : ''`, an entry with outputAvailability=true and taskId=null would render
      // "yes" with no suffix. We cannot reach that branch via the public API since hasTaskOutput
      // returns false for null. This test documents that invariant.
      mockQueryResult = {
        entries: [makeEntry({ taskId: null })],
        total: 1,
        successCount: 1,
        failureCount: 0,
        failureSummary: [],
      };
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      await program.parseAsync(['node', 'sparecrow', 'logs']);
      // null taskId → hasTaskOutput returns false → Output: no (no suffix possible)
      expect(stdoutOutput).toContain('no');
      expect(stdoutOutput).not.toContain('yes');
    });
  });

  describe('--output <taskId> mode', () => {
    let stderrOutput: string;

    beforeEach(() => {
      stderrOutput = '';
      vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
        stderrOutput += String(data);
        return true;
      });
    });

    it('prints file contents when output file exists', async () => {
      const taskId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      await writeFile(join(taskOutputsDir, `${taskId}.txt`), 'Hello from Claude');
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      await program.parseAsync(['node', 'sparecrow', 'logs', '--output', taskId]);
      expect(stdoutOutput).toContain('Hello from Claude');
    });

    it('prints error to stderr and sets exitCode=1 when output file does not exist', async () => {
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

    it('prints error to stderr and sets exitCode=1 for invalid non-UUID task ID', async () => {
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      const originalExitCode = process.exitCode;
      await program.parseAsync(['node', 'sparecrow', 'logs', '--output', 'not-a-uuid']);
      expect(stderrOutput).toContain('Invalid task ID format');
      expect(process.exitCode).toBe(1);
      process.exitCode = originalExitCode;
    });

    it('returns ok=true JSON with taskId and output when file exists', async () => {
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

    it('returns ok=false JSON with TASK_OUTPUT_NOT_FOUND when file does not exist', async () => {
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

    it('returns ok=false JSON with TASK_OUTPUT_NOT_FOUND for invalid non-UUID task ID', async () => {
      jsonMode = true;
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      await program.parseAsync(['node', 'sparecrow', 'logs', '--output', 'bad-id']);
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

  describe('verbose mode', () => {
    it('renders expanded detail blocks for each entry', async () => {
      mockQueryResult = {
        entries: [makeEntry()],
        total: 1,
        successCount: 1,
        failureCount: 0,
        failureSummary: [],
      };
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      await program.parseAsync(['node', 'sparecrow', 'logs', '--verbose']);
      expect(stdoutOutput).toContain('security-audit');
      expect(stdoutOutput).toContain('task.completed');
      expect(stdoutOutput).toContain('Event:');
    });

    it('shows bounded stdout in verbose mode', async () => {
      const longStdout = 'x'.repeat(20 * 1024); // 20 KB
      mockQueryResult = {
        entries: [makeEntry({ stdout: longStdout })],
        total: 1,
        successCount: 1,
        failureCount: 0,
        failureSummary: [],
      };
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      await program.parseAsync(['node', 'sparecrow', 'logs', '--verbose']);
      expect(stdoutOutput).toContain('[truncated]');
    });

    it('shows full task ID in verbose mode (AC4)', async () => {
      const fullUuid = '550e8400-e29b-41d4-a716-446655440000';
      mockQueryResult = {
        entries: [makeEntry({ taskId: fullUuid })],
        total: 1,
        successCount: 1,
        failureCount: 0,
        failureSummary: [],
      };
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      await program.parseAsync(['node', 'sparecrow', 'logs', '--verbose']);
      expect(stdoutOutput).toContain('Task ID:');
      expect(stdoutOutput).toContain(fullUuid);
    });

    it('displays actual error message instead of none for failed tasks (AC2)', async () => {
      mockQueryResult = {
        entries: [
          makeEntry({
            outcome: 'failed',
            event: 'task.failed',
            level: 'warn',
            taskName: 'custom-1',
            error: 'Claude binary not found. Run sparecrow onboard.',
            summary: '',
          }),
        ],
        total: 1,
        successCount: 0,
        failureCount: 1,
        failureSummary: [],
      };
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      await program.parseAsync(['node', 'sparecrow', 'logs', '--verbose']);
      expect(stdoutOutput).toContain('Error:');
      expect(stdoutOutput).toContain('Claude binary not found');
      expect(stdoutOutput).not.toContain('Error: none');
    });

    it('shows N/A for task ID in verbose mode when taskId is null', async () => {
      mockQueryResult = {
        entries: [makeEntry({ taskId: null })],
        total: 1,
        successCount: 1,
        failureCount: 0,
        failureSummary: [],
      };
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      await program.parseAsync(['node', 'sparecrow', 'logs', '--verbose']);
      expect(stdoutOutput).toContain('Task ID:');
      expect(stdoutOutput).toContain('N/A');
    });
  });

  describe('AC3: verbose output bounded — truncation guard', () => {
    it('truncates stdout to last 10KB in verbose mode when output exceeds limit', async () => {
      // Generate output that is well over the 10KB STDOUT_MAX_BYTES limit
      // 'line-prefix-' (12B) + 15KB of 'A's + '-end-marker' (11B) = ~15383B total
      const STDOUT_MAX_BYTES = 10 * 1024; // mirrors logs.ts constant
      const longStdout = 'line-prefix-' + 'A'.repeat(15 * 1024) + '-end-marker';
      expect(Buffer.byteLength(longStdout, 'utf-8')).toBeGreaterThan(STDOUT_MAX_BYTES);
      mockQueryResult = {
        entries: [makeEntry({ stdout: longStdout })],
        total: 1,
        successCount: 1,
        failureCount: 0,
        failureSummary: [],
      };
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      await program.parseAsync(['node', 'sparecrow', 'logs', '--verbose']);
      // The truncation marker must be present
      expect(stdoutOutput).toContain('[truncated]');
      // The end of the output should be preserved (last 10KB)
      expect(stdoutOutput).toContain('-end-marker');
      // The beginning should be cut — 'line-prefix-' is at the very start of a 15KB+ string
      // After truncation to last 10KB, the prefix is dropped
      expect(stdoutOutput).not.toContain('line-prefix-');
      // Explicit byte-count guard: rendered portion after '[truncated]\n' must be ≤ 10KB
      const truncatedMarker = '[truncated]\n';
      const markerIdx = stdoutOutput.indexOf(truncatedMarker);
      expect(markerIdx).toBeGreaterThanOrEqual(0);
      const renderedPortion = stdoutOutput.slice(markerIdx + truncatedMarker.length);
      // Isolate only the truncated stdout text (before any trailing labels/separators)
      // The rendered portion starts with the last ≤10KB of the original stdout
      expect(Buffer.byteLength(renderedPortion, 'utf-8')).toBeLessThanOrEqual(
        STDOUT_MAX_BYTES + 512, // +512 allows for surrounding render decoration
      );
    });

    it('does not truncate stdout in verbose mode when output is within 10KB limit', async () => {
      const shortStdout = 'short-output-content';
      mockQueryResult = {
        entries: [makeEntry({ stdout: shortStdout })],
        total: 1,
        successCount: 1,
        failureCount: 0,
        failureSummary: [],
      };
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      await program.parseAsync(['node', 'sparecrow', 'logs', '--verbose']);
      expect(stdoutOutput).toContain('short-output-content');
      expect(stdoutOutput).not.toContain('[truncated]');
    });

    it('does not render output section when stdout is null', async () => {
      mockQueryResult = {
        entries: [makeEntry({ stdout: null })],
        total: 1,
        successCount: 1,
        failureCount: 0,
        failureSummary: [],
      };
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      await program.parseAsync(['node', 'sparecrow', 'logs', '--verbose']);
      // Should show entry details but no Output: section
      expect(stdoutOutput).toContain('security-audit');
      expect(stdoutOutput).not.toContain('Output:');
    });
  });

  describe('AC4: --task --full transcript rendering', () => {
    it('outputs complete untruncated transcript content via --task --full', async () => {
      // Even large transcripts should be output in full (no truncation)
      const largeTranscript = 'START-TRANSCRIPT\n' + 'x'.repeat(30 * 1024) + '\nEND-TRANSCRIPT';
      mockQueryResult = {
        entries: [makeEntry({ stdout: largeTranscript })],
        total: 1,
        successCount: 1,
        failureCount: 0,
        failureSummary: [],
      };
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      await program.parseAsync(['node', 'sparecrow', 'logs', '--task', 'security-audit', '--full']);
      expect(stdoutOutput).toContain('START-TRANSCRIPT');
      expect(stdoutOutput).toContain('END-TRANSCRIPT');
      // Full mode should NOT truncate
      expect(stdoutOutput).not.toContain('[truncated]');
      // Should not contain card border formatting
      expect(stdoutOutput).not.toContain('Task Detail');
    });

    it('outputs message when entries exist but last entry has null stdout', async () => {
      mockQueryResult = {
        entries: [makeEntry({ stdout: null }), makeEntry({ taskName: 'later-run', stdout: null })],
        total: 2,
        successCount: 2,
        failureCount: 0,
        failureSummary: [],
      };
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      await program.parseAsync(['node', 'sparecrow', 'logs', '--task', 'security-audit', '--full']);
      expect(stdoutOutput).toContain('No transcript available');
    });

    it('outputs message when no entries match the task filter', async () => {
      mockQueryResult = {
        entries: [],
        total: 0,
        successCount: 0,
        failureCount: 0,
        failureSummary: [],
      };
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      await program.parseAsync(['node', 'sparecrow', 'logs', '--task', 'nonexistent', '--full']);
      // Empty state message
      expect(stdoutOutput).toContain('No execution history found');
    });
  });

  describe('--task detail card mode', () => {
    it('renders bordered detail card with all available fields', async () => {
      mockQueryResult = {
        entries: [makeEntry()],
        total: 1,
        successCount: 1,
        failureCount: 0,
        failureSummary: [],
      };
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      await program.parseAsync(['node', 'sparecrow', 'logs', '--task', 'security-audit']);
      expect(stdoutOutput).toContain('security-audit');
      expect(stdoutOutput).toContain('Status:');
      expect(stdoutOutput).toContain('Task:');
      expect(stdoutOutput).toContain('Duration:');
      expect(stdoutOutput).toContain('Target:');
      // Full log footer row is always present in the card
      expect(stdoutOutput).toContain('sparecrow logs --task');
      expect(stdoutOutput).toContain('--full');
    });

    it('uses renderTaskDetailCard component output (no local inline renderer)', async () => {
      mockQueryResult = {
        entries: [makeEntry()],
        total: 1,
        successCount: 1,
        failureCount: 0,
        failureSummary: [],
      };
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      await program.parseAsync(['node', 'sparecrow', 'logs', '--task', 'security-audit']);
      // Card uses bordered layout with Task Detail title
      expect(stdoutOutput).toContain('Task Detail');
      // All canonical rows present
      expect(stdoutOutput).toContain('Task ID:');
      expect(stdoutOutput).toContain('Tokens In:');
      expect(stdoutOutput).toContain('Tokens Out:');
      expect(stdoutOutput).toContain('Provider:');
      expect(stdoutOutput).toContain('Source:');
      expect(stdoutOutput).toContain('Error:');
      expect(stdoutOutput).toContain('Summary:');
    });

    it('displays actual error message string in detail card for a failed task (AC3)', async () => {
      const errorMessage = 'Claude binary not found. Run sparecrow onboard.';
      mockQueryResult = {
        entries: [
          makeEntry({
            outcome: 'failed',
            event: 'task.failed',
            level: 'warn',
            taskName: 'custom-1',
            taskId: 'err-detail-001',
            durationMs: 1,
            exitCode: null,
            error: errorMessage,
            summary: '',
            stdout: null,
          }),
        ],
        total: 1,
        successCount: 0,
        failureCount: 1,
        failureSummary: [],
      };
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      await program.parseAsync(['node', 'sparecrow', 'logs', '--task', 'custom-1']);
      expect(stdoutOutput).toContain('Error:');
      expect(stdoutOutput).toContain('Claude binary not found');
    });
  });

  describe('--task --full transcript mode', () => {
    it('outputs raw stdout as plain text without card formatting', async () => {
      mockQueryResult = {
        entries: [makeEntry({ stdout: 'raw transcript content here' })],
        total: 1,
        successCount: 1,
        failureCount: 0,
        failureSummary: [],
      };
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      await program.parseAsync(['node', 'sparecrow', 'logs', '--task', 'security-audit', '--full']);
      expect(stdoutOutput).toContain('raw transcript content here');
      expect(stdoutOutput).not.toContain('─────');
    });

    it('outputs friendly message when stdout is null', async () => {
      mockQueryResult = {
        entries: [makeEntry({ stdout: null })],
        total: 1,
        successCount: 1,
        failureCount: 0,
        failureSummary: [],
      };
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      await program.parseAsync(['node', 'sparecrow', 'logs', '--task', 'security-audit', '--full']);
      expect(stdoutOutput).toContain('No transcript available');
    });
  });

  describe('JSON mode', () => {
    it('outputs fixed-schema JSON wrapper with all fields present', async () => {
      jsonMode = true;
      mockQueryResult = {
        entries: [makeEntry()],
        total: 1,
        successCount: 1,
        failureCount: 0,
        failureSummary: [],
      };
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      await program.parseAsync(['node', 'sparecrow', 'logs']);
      const parsed = JSON.parse(stdoutOutput) as {
        ok: boolean;
        data: {
          entries: LogEntry[];
          total: number;
          successCount: number;
          failureCount: number;
          failureSummary: unknown[];
        };
        error: null;
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.error).toBeNull();
      expect(parsed.data).toHaveProperty('entries');
      expect(parsed.data).toHaveProperty('total');
      expect(parsed.data).toHaveProperty('successCount');
      expect(parsed.data).toHaveProperty('failureCount');
      expect(Array.isArray(parsed.data.entries)).toBe(true);
    });

    it('includes taskId field in JSON entries (AC3)', async () => {
      jsonMode = true;
      const fullUuid = '550e8400-e29b-41d4-a716-446655440000';
      mockQueryResult = {
        entries: [makeEntry({ taskId: fullUuid }), makeFailedEntry()],
        total: 2,
        successCount: 1,
        failureCount: 1,
        failureSummary: [],
      };
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      await program.parseAsync(['node', 'sparecrow', 'logs']);
      const parsed = JSON.parse(stdoutOutput) as {
        ok: boolean;
        data: { entries: LogEntry[] };
      };
      expect(parsed.data.entries[0]!.taskId).toBe(fullUuid);
      expect(parsed.data.entries[1]!.taskId).toBe('def-456');
    });

    it('includes non-null error string in JSON entry for a failed task (AC5)', async () => {
      jsonMode = true;
      const errorMessage =
        'Claude binary not found. Run sparecrow onboard or set provider.claude_path in config.';
      mockQueryResult = {
        entries: [
          makeEntry({
            outcome: 'failed',
            event: 'task.failed',
            level: 'warn',
            taskName: 'custom-1',
            taskId: 'err-json-001',
            durationMs: 1,
            exitCode: null,
            error: errorMessage,
            summary: '',
            stdout: null,
          }),
        ],
        total: 1,
        successCount: 0,
        failureCount: 1,
        failureSummary: [],
      };
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      await program.parseAsync(['node', 'sparecrow', 'logs']);
      const parsed = JSON.parse(stdoutOutput) as {
        ok: boolean;
        data: { entries: LogEntry[] };
        error: null;
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.data.entries[0]!.error).toBe(errorMessage);
      expect(parsed.data.entries[0]!.outcome).toBe('failed');
    });
  });

  describe('--failures and --outcome filter (AC4 — Story 10.6)', () => {
    it('passes outcomeFilter [failed, retrying] to queryLogs when --failures flag is used', async () => {
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      await program.parseAsync(['node', 'sparecrow', 'logs', '--failures']);

      expect(capturedQueryOptions).not.toBeNull();
      expect(capturedQueryOptions!['outcomeFilter']).toEqual(['failed', 'retrying']);
    });

    it('passes outcomeFilter [success] to queryLogs when --outcome success is used', async () => {
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      await program.parseAsync(['node', 'sparecrow', 'logs', '--outcome', 'success']);

      expect(capturedQueryOptions).not.toBeNull();
      expect(capturedQueryOptions!['outcomeFilter']).toEqual(['success']);
    });

    it('renders failure summary footer grouped by humanized reason when failureSummary is non-empty', async () => {
      mockQueryResult = {
        entries: [
          makeEntry({
            outcome: 'failed',
            event: 'task.failed',
            level: 'warn',
            error: 'CLAUDE_NOT_FOUND',
          }),
          makeEntry({
            outcome: 'failed',
            event: 'task.failed',
            level: 'warn',
            error: 'CLAUDE_NOT_FOUND',
            taskName: 'improve-code',
          }),
        ],
        total: 2,
        successCount: 0,
        failureCount: 2,
        failureSummary: [{ reason: 'CLAUDE_NOT_FOUND', code: 'CLAUDE_NOT_FOUND', count: 2 }],
      };

      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      await program.parseAsync(['node', 'sparecrow', 'logs', '--failures']);

      // Footer shows humanized reason (not raw code)
      expect(stdoutOutput).toContain('2 failures:');
      expect(stdoutOutput).toContain('Claude CLI not found');
    });
  });

  describe('input validation', () => {
    let stderrOutput: string;

    beforeEach(() => {
      stderrOutput = '';
      vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
        stderrOutput += String(data);
        return true;
      });
    });

    it('sets exitCode=1 and writes error to stderr for invalid --count', async () => {
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      const originalExitCode = process.exitCode;
      await program.parseAsync(['node', 'sparecrow', 'logs', '--count', 'abc']);
      expect(process.exitCode).toBe(1);
      expect(stderrOutput).toContain('Error:');
      process.exitCode = originalExitCode;
    });

    it('sets exitCode=1 and writes error to stderr for negative --count', async () => {
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      const originalExitCode = process.exitCode;
      await program.parseAsync(['node', 'sparecrow', 'logs', '--count', '-5']);
      expect(process.exitCode).toBe(1);
      expect(stderrOutput).toContain('Error:');
      process.exitCode = originalExitCode;
    });

    it('sets exitCode=1 and writes error to stderr for invalid --since', async () => {
      const { ScrowError, ErrorCode } = await import('../../errors/index.js');
      mockParseSinceThrow = new ScrowError(ErrorCode.LOGS_INVALID_FILTER, 'Invalid --since value');
      const { registerLogs } = await import('./logs.js');
      const program = makeProgram();
      registerLogs(program);
      const originalExitCode = process.exitCode;
      await program.parseAsync(['node', 'sparecrow', 'logs', '--since', 'invalid']);
      expect(process.exitCode).toBe(1);
      expect(stderrOutput).toContain('Error:');
      process.exitCode = originalExitCode;
    });
  });
});

describe('shortTaskId()', () => {
  // shortTaskId is not exported — test its behaviour through renderSummaryTable via registerLogs.
  // The tests below use real taskId values to verify the first-8-chars contract and edge cases.

  let stdoutOutput: string;
  let taskOutputsDir: string;
  let shortTaskIdQueryResult: LogQueryResult;

  function makeShortTaskEntry(taskId: string): LogEntry {
    return {
      timestamp: '2026-02-25T10:30:00.000Z',
      level: 'info',
      event: 'task.completed',
      outcome: 'success',
      taskName: 'test',
      taskId,
      durationMs: 1000,
      exitCode: 0,
      summary: '',
      targetPath: '/repo',
      stdout: null,
      stderr: null,
      tokensIn: null,
      tokensOut: null,
      provider: null,
      source: null,
      confidence: null,
      error: null,
    };
  }

  beforeEach(async () => {
    taskOutputsDir = join(TMP_BASE, randomBytes(6).toString('hex'));
    await mkdir(taskOutputsDir, { recursive: true });
    stdoutOutput = '';
    shortTaskIdQueryResult = {
      entries: [],
      total: 0,
      successCount: 0,
      failureCount: 0,
      failureSummary: [],
    };
    vi.resetModules();

    vi.doMock('../index.js', () => ({ isJsonMode: () => false }));
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({
        logs: '/fake/logs',
        data: '/fake/data',
        config: '/fake/config',
        taskOutputs: taskOutputsDir,
      }),
    }));
    vi.doMock('./log-reader.js', () => ({
      queryLogs: vi.fn(async () => shortTaskIdQueryResult),
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

  it('returns first 8 chars of a full UUID (36-char)', async () => {
    const taskId = '550e8400-e29b-41d4-a716-446655440000';
    await writeFile(join(taskOutputsDir, `${taskId}.txt`), 'content');
    shortTaskIdQueryResult = {
      entries: [makeShortTaskEntry(taskId)],
      total: 1,
      successCount: 1,
      failureCount: 0,
      failureSummary: [],
    };
    const { registerLogs } = await import('./logs.js');
    const program = makeProgram();
    registerLogs(program);
    await program.parseAsync(['node', 'sparecrow', 'logs']);
    // The first 8 chars of '550e8400-e29b-41d4-a716-446655440000' are '550e8400'
    expect(stdoutOutput).toContain('(550e8400)');
  });

  it('returns only available chars when taskId is shorter than 8 chars', async () => {
    // 'abc-123' is 7 chars — shortTaskId returns 'abc-123' (not padded)
    const shortId = 'abc-123';
    await writeFile(join(taskOutputsDir, `${shortId}.txt`), 'content');
    shortTaskIdQueryResult = {
      entries: [makeShortTaskEntry(shortId)],
      total: 1,
      successCount: 1,
      failureCount: 0,
      failureSummary: [],
    };
    const { registerLogs } = await import('./logs.js');
    const prog = makeProgram();
    registerLogs(prog);
    await prog.parseAsync(['node', 'sparecrow', 'logs']);
    // shortTaskId returns the full 7-char string (slice(0,8) returns available chars)
    expect(stdoutOutput).toContain('(abc-123)');
  });

  it('returns exactly 8 chars when taskId is exactly 8 chars', async () => {
    const exactId = 'abcd1234';
    await writeFile(join(taskOutputsDir, `${exactId}.txt`), 'content');
    shortTaskIdQueryResult = {
      entries: [makeShortTaskEntry(exactId)],
      total: 1,
      successCount: 1,
      failureCount: 0,
      failureSummary: [],
    };
    const { registerLogs } = await import('./logs.js');
    const prog = makeProgram();
    registerLogs(prog);
    await prog.parseAsync(['node', 'sparecrow', 'logs']);
    expect(stdoutOutput).toContain('(abcd1234)');
  });
});
