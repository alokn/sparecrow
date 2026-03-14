/** Tests for task-output-writer — per-task output file persistence. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { TaskResult } from '../types/index.js';

vi.mock('../utils/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/index.js')>();
  return {
    ...actual,
    logger: {
      debug: vi.fn().mockResolvedValue(undefined),
      info: vi.fn().mockResolvedValue(undefined),
      warn: vi.fn().mockResolvedValue(undefined),
      error: vi.fn().mockResolvedValue(undefined),
    },
  };
});

import { writeTaskOutput, buildOutputContent } from './task-output-writer.js';

function makeResult(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    taskId: 'test-task-id-001',
    status: 'done',
    startedAt: new Date(),
    completedAt: new Date(),
    durationMs: 5000,
    stdout: 'Hello from Claude',
    stderr: '',
    exitCode: 0,
    error: null,
    errorCode: null,
    ...overrides,
  };
}

describe('buildOutputContent', () => {
  it('returns stdout only when stderr is empty', () => {
    const result = makeResult({ stdout: 'output text', stderr: '' });
    expect(buildOutputContent(result)).toBe('output text');
  });

  it('appends stderr with delimiter when stderr is non-empty', () => {
    const result = makeResult({ stdout: 'main output', stderr: 'error output' });
    const content = buildOutputContent(result);
    expect(content).toBe('main output\n--- stderr ---\nerror output');
  });

  it('returns empty string when both stdout and stderr are empty', () => {
    const result = makeResult({ stdout: '', stderr: '' });
    expect(buildOutputContent(result)).toBe('');
  });
});

describe('writeTaskOutput', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), 'sparecrow-output-' + randomBytes(6).toString('hex'));
    await mkdir(tmpDir, { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('writes stdout-only content to <taskId>.txt', async () => {
    const result = makeResult({ taskId: 'abc-123', stdout: 'task output', stderr: '' });
    await writeTaskOutput(tmpDir, result);

    const content = await readFile(join(tmpDir, 'abc-123.txt'), 'utf-8');
    expect(content).toBe('task output');
  });

  it('writes stdout+stderr with delimiter to <taskId>.txt', async () => {
    const result = makeResult({
      taskId: 'def-456',
      stdout: 'main output',
      stderr: 'error info',
    });
    await writeTaskOutput(tmpDir, result);

    const content = await readFile(join(tmpDir, 'def-456.txt'), 'utf-8');
    expect(content).toBe('main output\n--- stderr ---\nerror info');
  });

  it('writes zero-byte file when stdout is empty', async () => {
    const result = makeResult({ taskId: 'empty-out', stdout: '', stderr: '' });
    await writeTaskOutput(tmpDir, result);

    const content = await readFile(join(tmpDir, 'empty-out.txt'), 'utf-8');
    expect(content).toBe('');
  });

  it('logs warning and does not throw on write failure', async () => {
    // Write to a non-existent deeply nested path that will fail at the atomicWrite level
    // because atomicWrite creates the parent dir, but we can simulate failure by using
    // a path where mkdir will fail. Instead, we use a valid directory but mock atomicWrite.
    vi.resetModules();

    vi.doMock('../utils/index.js', () => ({
      logger: {
        debug: vi.fn().mockResolvedValue(undefined),
        info: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
      },
      atomicWrite: vi.fn().mockRejectedValue(new Error('EACCES: permission denied')),
    }));

    const { writeTaskOutput: freshWrite } = await import('./task-output-writer.js');
    const { logger: freshLogger } = await import('../utils/index.js');

    const result = makeResult({ taskId: 'fail-write' });
    // Should not throw
    await expect(freshWrite(tmpDir, result)).resolves.toBeUndefined();

    expect(freshLogger.warn).toHaveBeenCalledWith(
      'task-output-writer.write-failed',
      expect.objectContaining({
        taskId: 'fail-write',
        error: 'EACCES: permission denied',
      }),
    );

    vi.resetModules();
  });
});
