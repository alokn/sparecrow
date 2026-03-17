/** ENOSPC filesystem error tests for result artifact writer (AC4). */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { TaskDefinition, TaskResult } from '../types/index.js';
import { validateSlug } from '../utils/index.js';

function makeTask(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    name: 'improve-code',
    type: 'template',
    templateName: 'improve-code',
    status: 'done',
    prompt: 'Review the code',
    targetPath: '/tmp/test-repo',
    priority: 1,
    createdAt: new Date('2026-03-04T10:00:00.000Z'),
    timeoutMs: 3600000,
    actions: [],
    ...overrides,
  };
}

function makeResult(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    taskId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    status: 'done',
    startedAt: new Date('2026-03-04T14:00:00.000Z'),
    completedAt: new Date('2026-03-04T14:30:00.000Z'),
    durationMs: 1800000,
    stdout: 'Review complete.',
    stderr: '',
    exitCode: 0,
    error: null,
    errorCode: null,
    ...overrides,
  };
}

type ResultArtifactInput = { task: TaskDefinition; result: TaskResult; branch: string | null };

function makeInput(overrides: Partial<ResultArtifactInput> = {}): ResultArtifactInput {
  return {
    task: makeTask(),
    result: makeResult(),
    branch: null,
    ...overrides,
  };
}

describe('writeResultArtifact ENOSPC handling (AC4)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = join(tmpdir(), 'sparecrow-result-enospc-' + randomBytes(6).toString('hex'));
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns null and logs warning when atomicWrite throws ENOSPC', async () => {
    const enospcError = Object.assign(new Error('ENOSPC: no space left on device'), {
      code: 'ENOSPC',
    });

    const mockWarn = vi.fn().mockResolvedValue(undefined);

    vi.doMock('../utils/index.js', () => ({
      atomicWrite: vi.fn().mockRejectedValue(enospcError),
      validateSlug,
      logger: {
        debug: vi.fn().mockResolvedValue(undefined),
        info: vi.fn().mockResolvedValue(undefined),
        warn: mockWarn,
        error: vi.fn().mockResolvedValue(undefined),
      },
    }));

    const { writeResultArtifact } = await import('./result-writer.js');

    const task = makeTask({ targetPath: tmpDir });
    const input = makeInput({ task });

    // AC4: writeResultArtifact is non-fatal — returns null on failure
    const output = await writeResultArtifact(input);
    expect(output).toBeNull();

    // AC4: Error is logged as warning
    expect(mockWarn).toHaveBeenCalledWith(
      'RESULT_WRITE_FAILED',
      expect.objectContaining({
        taskId: task.id,
        templateName: 'improve-code',
        repoPath: tmpDir,
      }),
    );
  });

  it('allows daemon to continue after ENOSPC on result write', async () => {
    const enospcError = Object.assign(new Error('ENOSPC: no space left on device'), {
      code: 'ENOSPC',
    });

    const atomicWriteMock = vi.fn().mockRejectedValueOnce(enospcError).mockResolvedValue(undefined);

    vi.doMock('../utils/index.js', () => ({
      atomicWrite: atomicWriteMock,
      validateSlug,
      logger: {
        debug: vi.fn().mockResolvedValue(undefined),
        info: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
      },
    }));

    const { writeResultArtifact } = await import('./result-writer.js');

    const task1 = makeTask({ targetPath: tmpDir, id: 'task-1-fail' });
    const input1 = makeInput({ task: task1 });

    const output1 = await writeResultArtifact(input1);
    expect(output1).toBeNull();

    // Second write after ENOSPC — daemon can still operate
    const task2Dir = join(tmpDir, 'repo2');
    await mkdir(task2Dir, { recursive: true });
    const task2 = makeTask({ targetPath: task2Dir, id: 'task-2-success' });
    const input2 = makeInput({ task: task2 });

    const output2 = await writeResultArtifact(input2);
    expect(output2).not.toBeNull();
  });

  it('returns null and logs warning when mkdir throws ENOSPC creating .scrow/ directory', async () => {
    // This test exercises the mkdir ENOSPC path directly — distinct from atomicWrite ENOSPC.
    const enospcError = Object.assign(new Error('ENOSPC: no space left on device'), {
      code: 'ENOSPC',
    });

    const mockWarn = vi.fn().mockResolvedValue(undefined);

    vi.doMock('../utils/index.js', () => ({
      atomicWrite: vi.fn().mockResolvedValue(undefined),
      validateSlug,
      logger: {
        debug: vi.fn().mockResolvedValue(undefined),
        info: vi.fn().mockResolvedValue(undefined),
        warn: mockWarn,
        error: vi.fn().mockResolvedValue(undefined),
      },
    }));

    // Mock node:fs/promises to inject ENOSPC specifically on mkdir
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.doMock('node:fs/promises', () => ({
      ...actualFs,
      mkdir: vi.fn().mockRejectedValue(enospcError),
    }));

    const { writeResultArtifact } = await import('./result-writer.js');

    const task = makeTask({ targetPath: tmpDir });
    const input = makeInput({ task });

    // AC4: writeResultArtifact is non-fatal — mkdir ENOSPC is caught and returns null
    const output = await writeResultArtifact(input);
    expect(output).toBeNull();

    // AC4: Error is logged as warning
    expect(mockWarn).toHaveBeenCalledWith(
      'RESULT_WRITE_FAILED',
      expect.objectContaining({
        taskId: task.id,
        repoPath: tmpDir,
      }),
    );
  });
});
