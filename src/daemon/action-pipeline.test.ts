/** Unit tests for action-pipeline.ts — post-execution action pipeline orchestration. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { ActionPipelineParams } from './action-pipeline.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return join(tmpdir(), 'action-pipeline-test-' + randomBytes(6).toString('hex'));
}

function makeDefaultParams(overrides: Partial<ActionPipelineParams> = {}): ActionPipelineParams {
  return {
    frontmatter: {
      task_id: 'task-abc123',
      template: 'fix-bugs',
      repo: '/repo',
      dispatched_at: '2026-03-09T10:00:00.000Z',
      completed_at: '2026-03-09T10:05:00.000Z',
      exit_code: 0,
      branch: 'sparecrow/fix-bugs-20260309T100000Z',
    },
    templateActions: ['git-push', 'pr-create'],
    resultFilePath: '/repo/.scrow/2026-03-09T10-00-00Z-fix-bugs-abc1234.md',
    taskId: 'task-abc123',
    repoPath: '/repo',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runActionPipeline', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    await mkdir(tmpDir, { recursive: true });
    vi.resetModules();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns null when resultFilePath cannot be read', async () => {
    vi.resetModules();
    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
    }));
    vi.doMock('../utils/index.js', () => ({
      logger: {
        warn: vi.fn().mockResolvedValue(undefined),
        info: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      atomicWrite: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('./action-parser.js', () => ({ parseActionBlock: vi.fn().mockReturnValue(null) }));
    vi.doMock('./action-inference.js', () => ({ inferActions: vi.fn().mockResolvedValue(null) }));
    vi.doMock('./action-executor.js', () => ({ executeActions: vi.fn().mockResolvedValue([]) }));

    const { runActionPipeline } = await import('./action-pipeline.js');
    const result = await runActionPipeline(makeDefaultParams());
    expect(result).toBeNull();
  });

  it('returns null when parseActionBlock returns null AND inferActions returns null', async () => {
    vi.resetModules();
    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn().mockResolvedValue('file content without action block'),
    }));
    vi.doMock('../utils/index.js', () => ({
      logger: {
        warn: vi.fn().mockResolvedValue(undefined),
        info: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      atomicWrite: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('./action-parser.js', () => ({ parseActionBlock: vi.fn().mockReturnValue(null) }));
    vi.doMock('./action-inference.js', () => ({ inferActions: vi.fn().mockResolvedValue(null) }));
    vi.doMock('./action-executor.js', () => ({ executeActions: vi.fn().mockResolvedValue([]) }));

    const { runActionPipeline } = await import('./action-pipeline.js');
    const result = await runActionPipeline(makeDefaultParams());
    expect(result).toBeNull();
  });

  it('AC1: runs pipeline when action block is present (source = parsed)', async () => {
    vi.resetModules();
    const mockAtomicWrite = vi.fn().mockResolvedValue(undefined);
    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn().mockResolvedValue('file content with action block'),
    }));
    vi.doMock('../utils/index.js', () => ({
      logger: {
        warn: vi.fn().mockResolvedValue(undefined),
        info: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      atomicWrite: mockAtomicWrite,
    }));
    vi.doMock('./action-parser.js', () => ({
      parseActionBlock: vi.fn().mockReturnValue({
        actions: [{ type: 'git-push', branch: 'main' }],
      }),
    }));
    vi.doMock('./action-inference.js', () => ({ inferActions: vi.fn().mockResolvedValue(null) }));
    vi.doMock('./action-executor.js', () => ({
      executeActions: vi.fn().mockResolvedValue([{ type: 'git-push', status: 'success' }]),
    }));

    const { runActionPipeline } = await import('./action-pipeline.js');
    const result = await runActionPipeline(makeDefaultParams());

    expect(result).not.toBeNull();
    expect(result?.source).toBe('parsed');
    expect(result?.task_id).toBe('task-abc123');
    expect(result?.actions_requested).toBe(1);
    expect(result?.actions_executed).toBe(1);
    expect(result?.actions_failed).toBe(0);
    expect(result?.actions_skipped).toBe(0);
    expect(mockAtomicWrite).toHaveBeenCalled();
  });

  it('source field is inferred when parseActionBlock returns null and inferActions returns non-null', async () => {
    vi.resetModules();
    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn().mockResolvedValue('file content'),
    }));
    vi.doMock('../utils/index.js', () => ({
      logger: {
        warn: vi.fn().mockResolvedValue(undefined),
        info: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      atomicWrite: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('./action-parser.js', () => ({ parseActionBlock: vi.fn().mockReturnValue(null) }));
    vi.doMock('./action-inference.js', () => ({
      inferActions: vi.fn().mockResolvedValue({
        actions: [{ type: 'pr-create', title: 'PR', body: 'body' }],
      }),
    }));
    vi.doMock('./action-executor.js', () => ({
      executeActions: vi
        .fn()
        .mockResolvedValue([
          { type: 'pr-create', status: 'success', url: 'https://github.com/pr/1' },
        ]),
    }));

    const { runActionPipeline } = await import('./action-pipeline.js');
    const result = await runActionPipeline(makeDefaultParams());

    expect(result?.source).toBe('inferred');
  });

  it('AC3: companion file schema — all fields present including null url/error/reason', async () => {
    vi.resetModules();
    let capturedJson = '';
    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn().mockResolvedValue('content'),
    }));
    vi.doMock('../utils/index.js', () => ({
      logger: {
        warn: vi.fn().mockResolvedValue(undefined),
        info: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      atomicWrite: vi.fn().mockImplementation((_path: string, json: string) => {
        capturedJson = json;
        return Promise.resolve();
      }),
    }));
    vi.doMock('./action-parser.js', () => ({
      parseActionBlock: vi.fn().mockReturnValue({
        actions: [{ type: 'git-push', branch: 'main' }],
      }),
    }));
    vi.doMock('./action-inference.js', () => ({ inferActions: vi.fn().mockResolvedValue(null) }));
    vi.doMock('./action-executor.js', () => ({
      executeActions: vi.fn().mockResolvedValue([{ type: 'git-push', status: 'success' }]),
    }));

    const { runActionPipeline } = await import('./action-pipeline.js');
    await runActionPipeline(makeDefaultParams());

    const parsed = JSON.parse(capturedJson) as Record<string, unknown>;
    expect(parsed['task_id']).toBe('task-abc123');
    expect(parsed['source']).toBe('parsed');
    expect(typeof parsed['actions_requested']).toBe('number');
    expect(typeof parsed['actions_executed']).toBe('number');
    expect(typeof parsed['actions_failed']).toBe('number');
    expect(typeof parsed['actions_skipped']).toBe('number');
    expect(Array.isArray(parsed['results'])).toBe(true);

    // Check that url/error/reason are null (not undefined) in the record
    const results = parsed['results'] as Array<Record<string, unknown>>;
    expect(results[0]?.['url']).toBeNull();
    expect(results[0]?.['error']).toBeNull();
    expect(results[0]?.['reason']).toBeNull();
  });

  it('AC3: zero results case — actions_requested: 0 companion is valid and written', async () => {
    vi.resetModules();
    const mockAtomicWrite = vi.fn().mockResolvedValue(undefined);
    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn().mockResolvedValue('content'),
    }));
    vi.doMock('../utils/index.js', () => ({
      logger: {
        warn: vi.fn().mockResolvedValue(undefined),
        info: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      atomicWrite: mockAtomicWrite,
    }));
    vi.doMock('./action-parser.js', () => ({
      parseActionBlock: vi.fn().mockReturnValue({ actions: [] }),
    }));
    vi.doMock('./action-inference.js', () => ({ inferActions: vi.fn().mockResolvedValue(null) }));
    vi.doMock('./action-executor.js', () => ({
      executeActions: vi.fn().mockResolvedValue([]),
    }));

    const { runActionPipeline } = await import('./action-pipeline.js');
    const result = await runActionPipeline(makeDefaultParams());

    expect(result).not.toBeNull();
    expect(result?.actions_requested).toBe(0);
    expect(mockAtomicWrite).toHaveBeenCalled();
  });

  it('AC4: audit log entries emitted per action with url: null when no URL', async () => {
    vi.resetModules();
    const mockInfo = vi.fn().mockResolvedValue(undefined);
    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn().mockResolvedValue('content'),
    }));
    vi.doMock('../utils/index.js', () => ({
      logger: {
        warn: vi.fn().mockResolvedValue(undefined),
        info: mockInfo,
        debug: vi.fn().mockResolvedValue(undefined),
      },
      atomicWrite: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('./action-parser.js', () => ({
      parseActionBlock: vi.fn().mockReturnValue({
        actions: [{ type: 'git-push', branch: 'main' }],
      }),
    }));
    vi.doMock('./action-inference.js', () => ({ inferActions: vi.fn().mockResolvedValue(null) }));
    vi.doMock('./action-executor.js', () => ({
      executeActions: vi.fn().mockResolvedValue([{ type: 'git-push', status: 'success' }]),
    }));

    const { runActionPipeline } = await import('./action-pipeline.js');
    await runActionPipeline(makeDefaultParams());

    expect(mockInfo).toHaveBeenCalledWith(
      'action.executed',
      expect.objectContaining({
        taskId: 'task-abc123',
        actionType: 'git-push',
        status: 'success',
        url: null,
      }),
      expect.objectContaining({
        provider: null,
        source: null,
        confidence: null,
        error: null,
      }),
    );
  });

  it('AC4: emits action.failed for non-success statuses', async () => {
    vi.resetModules();
    const mockInfo = vi.fn().mockResolvedValue(undefined);
    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn().mockResolvedValue('content'),
    }));
    vi.doMock('../utils/index.js', () => ({
      logger: {
        warn: vi.fn().mockResolvedValue(undefined),
        info: mockInfo,
        debug: vi.fn().mockResolvedValue(undefined),
      },
      atomicWrite: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('./action-parser.js', () => ({
      parseActionBlock: vi.fn().mockReturnValue({
        actions: [{ type: 'pr-create', title: 'PR', body: 'body' }],
      }),
    }));
    vi.doMock('./action-inference.js', () => ({ inferActions: vi.fn().mockResolvedValue(null) }));
    vi.doMock('./action-executor.js', () => ({
      executeActions: vi
        .fn()
        .mockResolvedValue([{ type: 'pr-create', status: 'skipped', reason: 'gh not available' }]),
    }));

    const { runActionPipeline } = await import('./action-pipeline.js');
    await runActionPipeline(makeDefaultParams());

    expect(mockInfo).toHaveBeenCalledWith(
      'action.failed',
      expect.objectContaining({
        status: 'skipped',
        url: null,
      }),
      expect.objectContaining({
        provider: null,
        source: null,
        confidence: null,
      }),
    );
  });

  it('AC7: companion file write fails → error logged, pipeline returns ActionPipelineResult (non-fatal)', async () => {
    vi.resetModules();
    const mockWarn = vi.fn().mockResolvedValue(undefined);
    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn().mockResolvedValue('content'),
    }));
    vi.doMock('../utils/index.js', () => ({
      logger: {
        warn: mockWarn,
        info: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      atomicWrite: vi.fn().mockRejectedValue(new Error('disk full')),
    }));
    vi.doMock('./action-parser.js', () => ({
      parseActionBlock: vi.fn().mockReturnValue({
        actions: [{ type: 'git-push', branch: 'main' }],
      }),
    }));
    vi.doMock('./action-inference.js', () => ({ inferActions: vi.fn().mockResolvedValue(null) }));
    vi.doMock('./action-executor.js', () => ({
      executeActions: vi.fn().mockResolvedValue([{ type: 'git-push', status: 'success' }]),
    }));

    const { runActionPipeline } = await import('./action-pipeline.js');
    const result = await runActionPipeline(makeDefaultParams());

    // Result is still returned even when write fails
    expect(result).not.toBeNull();
    expect(result?.actions_requested).toBe(1);
    // Warn was called for the write failure
    expect(mockWarn).toHaveBeenCalledWith(
      'action-pipeline.companion-write-failed',
      expect.objectContaining({ error: 'disk full' }),
    );
  });

  it('dryRun: true parameter is forwarded to executeActions', async () => {
    vi.resetModules();
    const mockExecuteActions = vi
      .fn()
      .mockResolvedValue([{ type: 'git-push', status: 'dry-run', reason: 'dry-run mode active' }]);
    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn().mockResolvedValue('content'),
    }));
    vi.doMock('../utils/index.js', () => ({
      logger: {
        warn: vi.fn().mockResolvedValue(undefined),
        info: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      atomicWrite: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('./action-parser.js', () => ({
      parseActionBlock: vi.fn().mockReturnValue({
        actions: [{ type: 'git-push', branch: 'main' }],
      }),
    }));
    vi.doMock('./action-inference.js', () => ({ inferActions: vi.fn().mockResolvedValue(null) }));
    vi.doMock('./action-executor.js', () => ({ executeActions: mockExecuteActions }));

    const { runActionPipeline } = await import('./action-pipeline.js');
    await runActionPipeline({ ...makeDefaultParams(), dryRun: true });

    expect(mockExecuteActions).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ dryRun: true }),
    );
  });

  it('counts actions correctly: executed=success, failed=failed, skipped=skipped+dry-run', async () => {
    vi.resetModules();
    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn().mockResolvedValue('content'),
    }));
    vi.doMock('../utils/index.js', () => ({
      logger: {
        warn: vi.fn().mockResolvedValue(undefined),
        info: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      atomicWrite: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('./action-parser.js', () => ({
      parseActionBlock: vi.fn().mockReturnValue({
        actions: [
          { type: 'git-push', branch: 'main' },
          { type: 'pr-create', title: 'PR', body: 'body' },
          { type: 'notify', message: 'done' },
          { type: 'issue-create', title: 'issue', body: 'body' },
        ],
      }),
    }));
    vi.doMock('./action-inference.js', () => ({ inferActions: vi.fn().mockResolvedValue(null) }));
    vi.doMock('./action-executor.js', () => ({
      executeActions: vi.fn().mockResolvedValue([
        { type: 'git-push', status: 'success' },
        { type: 'pr-create', status: 'failed', error: 'err' },
        { type: 'notify', status: 'skipped', reason: 'not declared' },
        { type: 'issue-create', status: 'dry-run', reason: 'dry-run' },
      ]),
    }));

    const { runActionPipeline } = await import('./action-pipeline.js');
    const result = await runActionPipeline(makeDefaultParams());

    expect(result?.actions_requested).toBe(4);
    expect(result?.actions_executed).toBe(1);
    expect(result?.actions_failed).toBe(1);
    expect(result?.actions_skipped).toBe(2);
  });
});
