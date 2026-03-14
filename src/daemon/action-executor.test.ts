/** Tests for action-executor — sequential action execution with manifest validation and dry-run. */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { ActionBlock, ActionExecutorContext, ActionType } from '../types/index.js';

type ExecFileResult = { stdout: string; stderr: string };
type MockExecFileFn = Mock<
  (file: string, args: string[], opts: Record<string, unknown>) => Promise<ExecFileResult>
>;

/** Builds a promisify-compatible execFile mock from a Promise-based mock function. */
function makeExecFileMock(
  mockFn: MockExecFileFn,
): (
  file: string,
  args: string[],
  opts: Record<string, unknown>,
  cb: (err: Error | null, result: ExecFileResult) => void,
) => object {
  return (
    file: string,
    args: string[],
    opts: Record<string, unknown>,
    cb: (err: Error | null, result: ExecFileResult) => void,
  ) => {
    mockFn(file, args, opts)
      .then((r) => cb(null, r))
      .catch((e: Error) => cb(e, { stdout: '', stderr: '' }));
    return { on: vi.fn(), kill: vi.fn() };
  };
}

/** Builds a minimal valid ActionExecutorContext with overrides. */
function makeContext(overrides: Partial<ActionExecutorContext> = {}): ActionExecutorContext {
  return {
    repoPath: '/home/user/my-repo',
    templateActions: ['git-push', 'pr-create', 'notify', 'issue-create'] as ActionType[],
    taskId: 'task-abc123',
    ...overrides,
  };
}

describe('executeActions', () => {
  let executeActions: (
    block: ActionBlock,
    context: ActionExecutorContext,
  ) => Promise<import('../types/index.js').ActionExecutionResult[]>;
  let mockExecFileAsync: MockExecFileFn;
  let mockInfo: ReturnType<typeof vi.fn>;
  let mockWarn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    mockInfo = vi.fn().mockResolvedValue(undefined);
    mockWarn = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../utils/index.js', () => ({
      logger: {
        debug: vi.fn().mockResolvedValue(undefined),
        info: mockInfo,
        warn: mockWarn,
        error: vi.fn().mockResolvedValue(undefined),
      },
    }));
    mockExecFileAsync = vi
      .fn<
        (file: string, args: string[], opts: Record<string, unknown>) => Promise<ExecFileResult>
      >()
      .mockResolvedValue({ stdout: '', stderr: '' });
    vi.doMock('node:child_process', () => ({
      execFile: makeExecFileMock(mockExecFileAsync),
    }));
    const mod = await import('./action-executor.js');
    executeActions = mod.executeActions;
  });

  // AC1 — git-push executor
  describe('AC1 — git-push executor', () => {
    it('returns success when git push succeeds', async () => {
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
      const block: ActionBlock = {
        actions: [{ type: 'git-push', branch: 'sparecrow/fix-bugs-abc123' }],
      };
      const results = await executeActions(block, makeContext());
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ type: 'git-push', status: 'success' });
    });

    it('calls git push with correct branch and default origin remote', async () => {
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
      const block: ActionBlock = {
        actions: [{ type: 'git-push', branch: 'my-branch' }],
      };
      await executeActions(block, makeContext());
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        'git',
        ['push', '-u', '--', 'origin', 'my-branch'],
        expect.any(Object),
      );
    });

    it('uses custom remote when remote field is present', async () => {
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
      const block: ActionBlock = {
        actions: [{ type: 'git-push', branch: 'my-branch', remote: 'upstream' }],
      };
      await executeActions(block, makeContext());
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        'git',
        ['push', '-u', '--', 'upstream', 'my-branch'],
        expect.any(Object),
      );
    });

    it('adds --force-with-lease before branch operand when force: true', async () => {
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
      const block: ActionBlock = {
        actions: [{ type: 'git-push', branch: 'my-branch', force: true }],
      };
      await executeActions(block, makeContext());
      const call = mockExecFileAsync.mock.calls[0];
      const args = call?.[1] ?? [];
      const forceLeaseIdx = args.indexOf('--force-with-lease');
      const branchIdx = args.indexOf('my-branch');
      expect(forceLeaseIdx).toBeGreaterThanOrEqual(0);
      // --force-with-lease must appear before the branch operand
      expect(forceLeaseIdx).toBeLessThan(branchIdx);
    });

    it('passes timeout option to git push call', async () => {
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
      const block: ActionBlock = {
        actions: [{ type: 'git-push', branch: 'my-branch' }],
      };
      await executeActions(block, makeContext());
      const call = mockExecFileAsync.mock.calls[0];
      expect(call?.[2]).toMatchObject({ timeout: expect.any(Number) });
    });

    it('does not add --force-with-lease when force: false', async () => {
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
      const block: ActionBlock = {
        actions: [{ type: 'git-push', branch: 'my-branch', force: false }],
      };
      await executeActions(block, makeContext());
      const call = mockExecFileAsync.mock.calls[0];
      expect(call?.[1]).not.toContain('--force-with-lease');
    });

    it('returns failed with error message when git push throws', async () => {
      mockExecFileAsync.mockRejectedValue(new Error('remote rejected'));
      const block: ActionBlock = {
        actions: [{ type: 'git-push', branch: 'my-branch' }],
      };
      const results = await executeActions(block, makeContext());
      expect(results[0]).toMatchObject({
        type: 'git-push',
        status: 'failed',
        error: 'remote rejected',
      });
    });
  });

  // AC2 — pr-create executor
  describe('AC2 — pr-create executor', () => {
    it('returns success with PR URL when gh create succeeds', async () => {
      mockExecFileAsync
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // gh auth status
        .mockResolvedValueOnce({ stdout: 'https://github.com/owner/repo/pull/42\n', stderr: '' }); // gh pr create
      const block: ActionBlock = {
        actions: [{ type: 'pr-create', title: 'My PR', body: 'Description' }],
      };
      const results = await executeActions(block, makeContext());
      expect(results[0]).toMatchObject({
        type: 'pr-create',
        status: 'success',
        url: 'https://github.com/owner/repo/pull/42',
      });
    });

    it('calls gh pr create with title and body', async () => {
      mockExecFileAsync
        .mockResolvedValueOnce({ stdout: '', stderr: '' })
        .mockResolvedValueOnce({ stdout: 'https://github.com/owner/repo/pull/1\n', stderr: '' });
      const block: ActionBlock = {
        actions: [{ type: 'pr-create', title: 'My PR', body: 'The body' }],
      };
      await executeActions(block, makeContext());
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        'gh',
        expect.arrayContaining(['pr', 'create', '--title', 'My PR', '--body', 'The body']),
        expect.any(Object),
      );
    });

    it('passes --base when base_branch is present', async () => {
      mockExecFileAsync
        .mockResolvedValueOnce({ stdout: '', stderr: '' })
        .mockResolvedValueOnce({ stdout: 'https://github.com/owner/repo/pull/5\n', stderr: '' });
      const block: ActionBlock = {
        actions: [{ type: 'pr-create', title: 'My PR', body: 'Body', base_branch: 'develop' }],
      };
      await executeActions(block, makeContext());
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        'gh',
        expect.arrayContaining(['--base', 'develop']),
        expect.any(Object),
      );
    });

    it('passes --draft when draft: true', async () => {
      mockExecFileAsync
        .mockResolvedValueOnce({ stdout: '', stderr: '' })
        .mockResolvedValueOnce({ stdout: 'https://github.com/owner/repo/pull/3\n', stderr: '' });
      const block: ActionBlock = {
        actions: [{ type: 'pr-create', title: 'My PR', body: 'Body', draft: true }],
      };
      await executeActions(block, makeContext());
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        'gh',
        expect.arrayContaining(['--draft']),
        expect.any(Object),
      );
    });

    it('passes --label for each label in labels array', async () => {
      mockExecFileAsync
        .mockResolvedValueOnce({ stdout: '', stderr: '' })
        .mockResolvedValueOnce({ stdout: 'https://github.com/owner/repo/pull/7\n', stderr: '' });
      const block: ActionBlock = {
        actions: [{ type: 'pr-create', title: 'My PR', body: 'Body', labels: ['bug', 'p1'] }],
      };
      await executeActions(block, makeContext());
      const call = mockExecFileAsync.mock.calls[1]; // second call is gh pr create
      expect(call?.[1]).toContain('--label');
      expect(call?.[1]).toContain('bug');
      expect(call?.[1]).toContain('p1');
      // Verify two --label entries
      const labelIndices = call?.[1]?.reduce<number[]>((acc, arg, i) => {
        if (arg === '--label') acc.push(i);
        return acc;
      }, []);
      expect(labelIndices).toHaveLength(2);
    });

    it('does not add --label args when labels is empty array', async () => {
      mockExecFileAsync
        .mockResolvedValueOnce({ stdout: '', stderr: '' })
        .mockResolvedValueOnce({ stdout: 'https://github.com/owner/repo/pull/2\n', stderr: '' });
      const block: ActionBlock = {
        actions: [{ type: 'pr-create', title: 'My PR', body: 'Body', labels: [] }],
      };
      await executeActions(block, makeContext());
      const call = mockExecFileAsync.mock.calls[1];
      expect(call?.[1]).not.toContain('--label');
    });

    it('parses PR URL from last non-empty line of stdout', async () => {
      mockExecFileAsync.mockResolvedValueOnce({ stdout: '', stderr: '' }).mockResolvedValueOnce({
        stdout: 'Creating PR...\nhttps://github.com/owner/repo/pull/10\n\n',
        stderr: '',
      });
      const block: ActionBlock = {
        actions: [{ type: 'pr-create', title: 'My PR', body: 'Body' }],
      };
      const results = await executeActions(block, makeContext());
      expect(results[0]).toMatchObject({ url: 'https://github.com/owner/repo/pull/10' });
    });

    it('returns success with url empty string when gh pr create stdout is blank', async () => {
      mockExecFileAsync
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // gh auth status
        .mockResolvedValueOnce({ stdout: '', stderr: '' }); // gh pr create — blank stdout
      const block: ActionBlock = {
        actions: [{ type: 'pr-create', title: 'My PR', body: 'Body' }],
      };
      const results = await executeActions(block, makeContext());
      expect(results[0]).toMatchObject({ type: 'pr-create', status: 'success', url: '' });
    });

    it('returns failed with error when gh pr create throws after gh is available', async () => {
      mockExecFileAsync
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // gh auth status succeeds
        .mockRejectedValueOnce(new Error('No commits on branch')); // gh pr create fails
      const block: ActionBlock = {
        actions: [{ type: 'pr-create', title: 'My PR', body: 'Body' }],
      };
      const results = await executeActions(block, makeContext());
      expect(results[0]).toMatchObject({
        type: 'pr-create',
        status: 'failed',
        error: 'No commits on branch',
      });
    });

    it('passes timeout option to gh pr create call', async () => {
      mockExecFileAsync
        .mockResolvedValueOnce({ stdout: '', stderr: '' })
        .mockResolvedValueOnce({ stdout: 'https://github.com/owner/repo/pull/1\n', stderr: '' });
      const block: ActionBlock = {
        actions: [{ type: 'pr-create', title: 'My PR', body: 'Body' }],
      };
      await executeActions(block, makeContext());
      const prCreateCall = mockExecFileAsync.mock.calls[1];
      expect(prCreateCall?.[2]).toMatchObject({ timeout: expect.any(Number) });
    });
  });

  // AC3 — pr-create fallback when gh not available
  describe('AC3 — pr-create fallback', () => {
    it('returns skipped when checkGhAvailable returns false', async () => {
      mockExecFileAsync.mockRejectedValueOnce(new Error('gh: command not found')); // gh auth status fails
      const block: ActionBlock = {
        actions: [{ type: 'pr-create', title: 'My PR', body: 'Body' }],
      };
      const results = await executeActions(block, makeContext());
      expect(results[0]).toMatchObject({
        type: 'pr-create',
        status: 'skipped',
        reason: 'gh CLI not available or not authenticated',
      });
    });

    it('logs a warning when gh not available', async () => {
      mockExecFileAsync.mockRejectedValueOnce(new Error('not found'));
      const block: ActionBlock = {
        actions: [{ type: 'pr-create', title: 'My PR', body: 'Body' }],
      };
      await executeActions(block, makeContext());
      expect(mockWarn).toHaveBeenCalledWith(
        'action-executor.gh-not-available',
        expect.objectContaining({ suggestion: expect.stringContaining('gh auth login') }),
      );
    });

    it('does not throw when gh not available', async () => {
      mockExecFileAsync.mockRejectedValueOnce(new Error('not found'));
      const block: ActionBlock = {
        actions: [{ type: 'pr-create', title: 'My PR', body: 'Body' }],
      };
      await expect(executeActions(block, makeContext())).resolves.toBeDefined();
    });
  });

  // AC4 — notify executor
  describe('AC4 — notify executor', () => {
    it('returns success for notify action', async () => {
      const block: ActionBlock = {
        actions: [{ type: 'notify', message: 'Task complete!' }],
      };
      const results = await executeActions(block, makeContext());
      expect(results[0]).toMatchObject({ type: 'notify', status: 'success' });
    });

    it('logs the notification message at info level', async () => {
      const block: ActionBlock = {
        actions: [{ type: 'notify', message: 'Hello world' }],
      };
      await executeActions(block, makeContext());
      expect(mockInfo).toHaveBeenCalledWith(
        'action-executor.notify',
        expect.objectContaining({ message: 'Hello world' }),
      );
    });
  });

  // AC5 — Sequential execution with independent failures
  describe('AC5 — sequential execution with independent failures', () => {
    it('executes notify after git-push fails', async () => {
      mockExecFileAsync.mockRejectedValueOnce(new Error('push failed'));
      const block: ActionBlock = {
        actions: [
          { type: 'git-push', branch: 'my-branch' },
          { type: 'notify', message: 'Done!' },
        ],
      };
      const results = await executeActions(block, makeContext());
      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({ type: 'git-push', status: 'failed' });
      expect(results[1]).toMatchObject({ type: 'notify', status: 'success' });
    });

    it('records individual status for each action', async () => {
      mockExecFileAsync
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git push succeeds
        .mockRejectedValueOnce(new Error('gh not found')); // gh auth status fails
      const block: ActionBlock = {
        actions: [
          { type: 'git-push', branch: 'my-branch' },
          { type: 'pr-create', title: 'PR', body: 'Body' },
        ],
      };
      const results = await executeActions(block, makeContext());
      expect(results[0]).toMatchObject({ status: 'success' });
      expect(results[1]).toMatchObject({ status: 'skipped' });
    });
  });

  // AC6 — Manifest validation
  describe('AC6 — manifest validation', () => {
    it('rejects action type not in templateActions with skipped result', async () => {
      const block: ActionBlock = {
        actions: [{ type: 'notify', message: 'Hello' }],
      };
      const ctx = makeContext({ templateActions: ['git-push'] as ActionType[] });
      const results = await executeActions(block, ctx);
      expect(results[0]).toMatchObject({
        type: 'notify',
        status: 'skipped',
        reason: 'action type not declared in template manifest',
      });
    });

    it('logs warning when action type rejected by manifest validation', async () => {
      const block: ActionBlock = {
        actions: [{ type: 'notify', message: 'Hello' }],
      };
      const ctx = makeContext({ templateActions: ['git-push'] as ActionType[] });
      await executeActions(block, ctx);
      expect(mockWarn).toHaveBeenCalledWith(
        'action-executor.manifest-validation-rejected',
        expect.objectContaining({ type: 'notify' }),
      );
    });

    it('still executes valid actions after rejecting an invalid one', async () => {
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
      const block: ActionBlock = {
        actions: [
          { type: 'notify', message: 'Hello' }, // not in templateActions
          { type: 'git-push', branch: 'my-branch' }, // valid
        ],
      };
      const ctx = makeContext({ templateActions: ['git-push'] as ActionType[] });
      const results = await executeActions(block, ctx);
      expect(results[0]).toMatchObject({ status: 'skipped' });
      expect(results[1]).toMatchObject({ status: 'success' });
    });
  });

  // AC7 — Dry-run support
  describe('AC7 — dry-run support', () => {
    it('returns dry-run status for valid actions when dryRun: true', async () => {
      const block: ActionBlock = {
        actions: [{ type: 'git-push', branch: 'my-branch' }],
      };
      const ctx = makeContext({ dryRun: true });
      const results = await executeActions(block, ctx);
      expect(results[0]).toMatchObject({ type: 'git-push', status: 'dry-run' });
    });

    it('does not call execFile for subprocess actions when dryRun: true', async () => {
      // This test uses git-push (which calls execFile in live mode) and pr-create
      // (which calls execFile for gh auth status AND gh pr create in live mode).
      // Including both ensures dry-run suppression is meaningfully tested for subprocess actions.
      const block: ActionBlock = {
        actions: [
          { type: 'git-push', branch: 'my-branch' },
          { type: 'pr-create', title: 'My PR', body: 'Body' },
        ],
      };
      const ctx = makeContext({ dryRun: true });
      await executeActions(block, ctx);
      expect(mockExecFileAsync).not.toHaveBeenCalled();
    });

    it('returns skipped (not dry-run) for invalid actions even when dryRun: true', async () => {
      const block: ActionBlock = {
        actions: [{ type: 'notify', message: 'Hello' }],
      };
      const ctx = makeContext({ templateActions: ['git-push'] as ActionType[], dryRun: true });
      const results = await executeActions(block, ctx);
      expect(results[0]).toMatchObject({
        type: 'notify',
        status: 'skipped',
        reason: 'action type not declared in template manifest',
      });
    });

    it('logs dry-run info for each valid action when dryRun: true', async () => {
      const block: ActionBlock = {
        actions: [{ type: 'git-push', branch: 'my-branch' }],
      };
      const ctx = makeContext({ dryRun: true });
      await executeActions(block, ctx);
      expect(mockInfo).toHaveBeenCalledWith(
        'action-executor.dry-run',
        expect.objectContaining({ type: 'git-push' }),
      );
    });
  });

  // AC8 — Unhandled action type issue-create
  describe('AC8 — unhandled action type issue-create', () => {
    it('returns skipped with executor-not-implemented reason for issue-create', async () => {
      const block: ActionBlock = {
        actions: [{ type: 'issue-create', title: 'Bug', body: 'Description' }],
      };
      const results = await executeActions(block, makeContext());
      expect(results[0]).toMatchObject({
        type: 'issue-create',
        status: 'skipped',
        reason: 'executor not implemented for action type: issue-create',
      });
    });

    it('logs warning for issue-create', async () => {
      const block: ActionBlock = {
        actions: [{ type: 'issue-create', title: 'Bug', body: 'Description' }],
      };
      await executeActions(block, makeContext());
      expect(mockWarn).toHaveBeenCalledWith(
        'action-executor.unimplemented-type',
        expect.objectContaining({ type: 'issue-create', taskId: 'task-abc123' }),
      );
    });

    it('does not throw for issue-create action', async () => {
      const block: ActionBlock = {
        actions: [{ type: 'issue-create', title: 'Bug', body: 'Description' }],
      };
      await expect(executeActions(block, makeContext())).resolves.toBeDefined();
    });
  });

  // Additional edge case: empty block
  describe('empty block', () => {
    it('returns empty array for empty action block', async () => {
      const block: ActionBlock = { actions: [] };
      const results = await executeActions(block, makeContext());
      expect(results).toEqual([]);
    });
  });

  // gh availability cache per-call
  describe('gh availability cache', () => {
    it('calls checkGhAvailable only once for multiple pr-create actions', async () => {
      mockExecFileAsync
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // gh auth status (cached after this)
        .mockResolvedValue({ stdout: 'https://github.com/owner/repo/pull/1\n', stderr: '' }); // gh pr create x2
      const block: ActionBlock = {
        actions: [
          { type: 'pr-create', title: 'PR 1', body: 'Body 1' },
          { type: 'pr-create', title: 'PR 2', body: 'Body 2' },
        ],
      };
      await executeActions(block, makeContext());
      // gh auth status called once; gh pr create called twice
      const ghAuthCalls = mockExecFileAsync.mock.calls.filter(
        (c) => c[0] === 'gh' && c[1]?.[0] === 'auth',
      );
      expect(ghAuthCalls).toHaveLength(1);
    });
  });
});

describe('checkGhAvailable', () => {
  let checkGhAvailable: () => Promise<boolean>;
  let mockExecFileAsync: MockExecFileFn;
  let mockDebug: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    mockDebug = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../utils/index.js', () => ({
      logger: {
        debug: mockDebug,
        info: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
      },
    }));
    mockExecFileAsync =
      vi.fn<
        (file: string, args: string[], opts: Record<string, unknown>) => Promise<ExecFileResult>
      >();
    vi.doMock('node:child_process', () => ({
      execFile: makeExecFileMock(mockExecFileAsync),
    }));
    const mod = await import('./action-executor.js');
    checkGhAvailable = mod.checkGhAvailable;
  });

  it('returns true when gh auth status exits with code 0', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: 'Logged in to github.com\n', stderr: '' });
    const result = await checkGhAvailable();
    expect(result).toBe(true);
  });

  it('returns false when gh auth status fails (not authenticated)', async () => {
    mockExecFileAsync.mockRejectedValue(new Error('You are not logged into any GitHub hosts'));
    const result = await checkGhAvailable();
    expect(result).toBe(false);
  });

  it('returns false when gh is not installed', async () => {
    mockExecFileAsync.mockRejectedValue(new Error('gh: command not found'));
    const result = await checkGhAvailable();
    expect(result).toBe(false);
  });

  it('returns false on timeout', async () => {
    mockExecFileAsync.mockRejectedValue(
      Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    );
    const result = await checkGhAvailable();
    expect(result).toBe(false);
  });

  it('never throws', async () => {
    mockExecFileAsync.mockRejectedValue(new Error('unexpected failure'));
    await expect(checkGhAvailable()).resolves.toBeDefined();
  });

  it('logs debug message with reason when gh check fails', async () => {
    mockExecFileAsync.mockRejectedValue(new Error('You are not logged into any GitHub hosts'));
    await checkGhAvailable();
    expect(mockDebug).toHaveBeenCalledWith(
      'action-executor.gh-availability-check-failed',
      expect.objectContaining({ reason: expect.stringContaining('not logged') }),
    );
  });
});
