/** Tests for action-inference — truncation fallback action block inference. */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { InferenceFrontmatter } from './action-inference.js';
import type { ActionType } from '../types/index.js';

type ExecFileResult = { stdout: string; stderr: string };
// execFile callback: (file, args, opts, cb)
type MockExecFileFn = Mock<
  (file: string, args: string[], opts: Record<string, unknown>) => Promise<ExecFileResult>
>;

/** Builds a minimal valid frontmatter with overrides. */
function makeFrontmatter(overrides: Partial<InferenceFrontmatter> = {}): InferenceFrontmatter {
  return {
    task_id: 'abc1234',
    template: 'fix-bugs',
    repo: '/home/user/my-repo',
    dispatched_at: '2026-03-09T10:00:00.000Z',
    completed_at: '2026-03-09T10:30:00.000Z',
    exit_code: 0,
    branch: 'sparecrow/fix-bugs-abc1234',
    ...overrides,
  };
}

/** Sets up execFile mock using promisify-compatible callback style. */
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

describe('inferActions', () => {
  let inferActions: (
    frontmatter: InferenceFrontmatter,
    templateActions: ActionType[],
    baseBranch?: string,
  ) => Promise<import('../types/index.js').ActionBlock | null>;
  let mockDebug: ReturnType<typeof vi.fn>;
  let mockInfo: ReturnType<typeof vi.fn>;
  let mockWarn: ReturnType<typeof vi.fn>;
  let mockExecFileAsync: MockExecFileFn;

  beforeEach(async () => {
    vi.resetModules();
    mockDebug = vi.fn().mockResolvedValue(undefined);
    mockInfo = vi.fn().mockResolvedValue(undefined);
    mockWarn = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../utils/index.js', () => ({
      logger: {
        debug: mockDebug,
        info: mockInfo,
        warn: mockWarn,
        error: vi.fn().mockResolvedValue(undefined),
      },
    }));
    // Default: 2 commits ahead on branch
    mockExecFileAsync = vi
      .fn<
        (file: string, args: string[], opts: Record<string, unknown>) => Promise<ExecFileResult>
      >()
      .mockResolvedValue({
        stdout: 'abc1234 Fix bug in login flow\ndef5678 Add unit tests for login\n',
        stderr: '',
      });
    vi.doMock('node:child_process', () => ({
      execFile: makeExecFileMock(mockExecFileAsync),
    }));
    const mod = await import('./action-inference.js');
    inferActions = mod.inferActions;
  });

  describe('AC3 — returns null on non-zero exit code', () => {
    it('returns null when exit_code is 1', async () => {
      const fm = makeFrontmatter({ exit_code: 1 });
      const result = await inferActions(fm, ['git-push', 'pr-create']);
      expect(result).toBeNull();
    });

    it('returns null when exit_code is 2', async () => {
      const fm = makeFrontmatter({ exit_code: 2 });
      const result = await inferActions(fm, ['git-push']);
      expect(result).toBeNull();
    });

    it('logs debug when skipping due to non-zero exit', async () => {
      const fm = makeFrontmatter({ exit_code: 1 });
      await inferActions(fm, ['git-push']);
      expect(mockDebug).toHaveBeenCalledWith(
        'action-inference.skipped-nonzero-exit',
        expect.objectContaining({ taskId: fm.task_id, exitCode: 1 }),
      );
    });
  });

  describe('AC4 — returns null when no branch or no commits', () => {
    it('returns null when branch is null', async () => {
      const fm = makeFrontmatter({ branch: null });
      const result = await inferActions(fm, ['git-push', 'pr-create']);
      expect(result).toBeNull();
    });

    it('returns null when branch is empty string', async () => {
      const fm = makeFrontmatter({ branch: '' });
      const result = await inferActions(fm, ['git-push', 'pr-create']);
      expect(result).toBeNull();
    });

    it('logs debug when skipping due to no branch (null)', async () => {
      const fm = makeFrontmatter({ branch: null });
      await inferActions(fm, ['git-push']);
      expect(mockDebug).toHaveBeenCalledWith(
        'action-inference.skipped-no-branch',
        expect.objectContaining({ taskId: fm.task_id }),
      );
    });

    it('logs debug when skipping due to no branch (empty string)', async () => {
      const fm = makeFrontmatter({ branch: '' });
      await inferActions(fm, ['git-push']);
      expect(mockDebug).toHaveBeenCalledWith(
        'action-inference.skipped-no-branch',
        expect.objectContaining({ taskId: fm.task_id }),
      );
    });

    it('returns null when no commits exist on branch', async () => {
      // Override execFile to return empty stdout (no commits ahead)
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
      const fm = makeFrontmatter();
      const result = await inferActions(fm, ['git-push', 'pr-create']);
      expect(result).toBeNull();
    });

    it('logs debug when skipping due to no commits', async () => {
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
      const fm = makeFrontmatter();
      await inferActions(fm, ['git-push']);
      expect(mockDebug).toHaveBeenCalledWith(
        'action-inference.skipped-no-commits',
        expect.objectContaining({ taskId: fm.task_id }),
      );
    });

    it('returns null when templateActions is empty', async () => {
      const fm = makeFrontmatter();
      const result = await inferActions(fm, []);
      expect(result).toBeNull();
    });

    it('returns null when templateActions has no infer-able types', async () => {
      const fm = makeFrontmatter();
      const result = await inferActions(fm, ['notify', 'issue-create']);
      expect(result).toBeNull();
    });

    it('logs warn when templateActions has no infer-able types', async () => {
      const fm = makeFrontmatter();
      await inferActions(fm, ['notify', 'issue-create']);
      expect(mockWarn).toHaveBeenCalledWith(
        'action-inference.no-infer-able-actions',
        expect.objectContaining({
          taskId: fm.task_id,
          nonInferableTypes: expect.arrayContaining(['notify', 'issue-create']),
        }),
      );
    });
  });

  describe('AC1 — infers git-push from branch', () => {
    it('returns ActionBlock with git-push when exit_code=0, branch present, commits exist, git-push declared', async () => {
      const fm = makeFrontmatter();
      const result = await inferActions(fm, ['git-push']);
      expect(result).not.toBeNull();
      expect(result?.actions).toHaveLength(1);
      expect(result?.actions[0]).toEqual({
        type: 'git-push',
        branch: 'sparecrow/fix-bugs-abc1234',
      });
    });

    it('uses the branch from frontmatter in the git-push action', async () => {
      const fm = makeFrontmatter({ branch: 'sparecrow/improve-code-xyz9999' });
      const result = await inferActions(fm, ['git-push']);
      expect(result?.actions[0]).toMatchObject({
        type: 'git-push',
        branch: 'sparecrow/improve-code-xyz9999',
      });
    });

    it('logs info after successful inference', async () => {
      const fm = makeFrontmatter();
      await inferActions(fm, ['git-push']);
      expect(mockInfo).toHaveBeenCalledWith(
        'action-inference.inferred',
        expect.objectContaining({
          taskId: fm.task_id,
          branch: fm.branch,
          commitCount: 2,
          actionCount: 1,
        }),
      );
    });
  });

  describe('AC2 — infers pr-create from commits', () => {
    it('returns ActionBlock with pr-create when exit_code=0, commits exist, pr-create declared', async () => {
      const fm = makeFrontmatter();
      const result = await inferActions(fm, ['pr-create']);
      expect(result).not.toBeNull();
      expect(result?.actions).toHaveLength(1);
      const prAction = result?.actions[0];
      expect(prAction?.type).toBe('pr-create');
    });

    it('pr-create has draft: true (conservative inferred PR)', async () => {
      const fm = makeFrontmatter();
      const result = await inferActions(fm, ['pr-create']);
      expect(result?.actions[0]).toMatchObject({ draft: true });
    });

    it('pr-create title includes template name and date', async () => {
      const fm = makeFrontmatter({
        template: 'fix-bugs',
        completed_at: '2026-03-09T10:30:00.000Z',
      });
      const result = await inferActions(fm, ['pr-create']);
      const prAction = result?.actions[0];
      expect(prAction?.type).toBe('pr-create');
      if (prAction?.type === 'pr-create') {
        expect(prAction.title).toContain('fix-bugs');
        expect(prAction.title).toContain('2026-03-09');
      }
    });

    it('pr-create body contains commit messages', async () => {
      const fm = makeFrontmatter();
      const result = await inferActions(fm, ['pr-create']);
      const prAction = result?.actions[0];
      expect(prAction?.type).toBe('pr-create');
      if (prAction?.type === 'pr-create') {
        expect(prAction.body).toContain('Fix bug in login flow');
        expect(prAction.body).toContain('Add unit tests for login');
      }
    });

    it('pr-create body contains template name', async () => {
      const fm = makeFrontmatter({ template: 'write-tests' });
      const result = await inferActions(fm, ['pr-create']);
      const prAction = result?.actions[0];
      if (prAction?.type === 'pr-create') {
        expect(prAction.body).toContain('write-tests');
      }
    });

    it('pr-create does not include base_branch when baseBranch is default (main)', async () => {
      const fm = makeFrontmatter();
      const result = await inferActions(fm, ['pr-create']);
      const prAction = result?.actions[0];
      expect(prAction?.type).toBe('pr-create');
      if (prAction?.type === 'pr-create') {
        expect(prAction.base_branch).toBeUndefined();
      }
    });

    it('pr-create includes base_branch when custom baseBranch is passed', async () => {
      const fm = makeFrontmatter();
      const result = await inferActions(fm, ['pr-create'], 'develop');
      const prAction = result?.actions[0];
      expect(prAction?.type).toBe('pr-create');
      if (prAction?.type === 'pr-create') {
        expect(prAction.base_branch).toBe('develop');
      }
    });
  });

  describe('combined git-push + pr-create inference', () => {
    it('returns both git-push and pr-create when both declared', async () => {
      const fm = makeFrontmatter();
      const result = await inferActions(fm, ['git-push', 'pr-create']);
      expect(result?.actions).toHaveLength(2);
      const types = result?.actions.map((a) => a.type);
      expect(types).toContain('git-push');
      expect(types).toContain('pr-create');
    });

    it('git-push appears before pr-create in the inferred block', async () => {
      const fm = makeFrontmatter();
      const result = await inferActions(fm, ['git-push', 'pr-create']);
      expect(result?.actions[0]?.type).toBe('git-push');
      expect(result?.actions[1]?.type).toBe('pr-create');
    });
  });

  describe('git-log error handling', () => {
    it('returns null when git log fails (no commits reachable)', async () => {
      mockExecFileAsync.mockRejectedValue(new Error('fatal: not a git repository'));
      const fm = makeFrontmatter();
      const result = await inferActions(fm, ['git-push', 'pr-create']);
      expect(result).toBeNull();
    });

    it('logs warn on git log failure', async () => {
      mockExecFileAsync.mockRejectedValue(new Error('fatal: no such branch'));
      const fm = makeFrontmatter();
      await inferActions(fm, ['git-push']);
      expect(mockWarn).toHaveBeenCalledWith(
        'action-inference.git-log-failed',
        expect.objectContaining({ error: 'fatal: no such branch' }),
      );
    });
  });

  describe('custom baseBranch', () => {
    it('passes custom baseBranch to git log command', async () => {
      const fm = makeFrontmatter();
      await inferActions(fm, ['git-push'], 'develop');
      // execFile is called with array args: ['log', '--oneline', 'develop..<branch>']
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['log', '--oneline', expect.stringContaining('develop..')]),
        expect.any(Object),
      );
    });
  });
});

describe('buildPrTitle', () => {
  let buildPrTitle: (templateName: string, completedAt: string) => string;
  let mockWarn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    mockWarn = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../utils/index.js', () => ({
      logger: {
        debug: vi.fn().mockResolvedValue(undefined),
        info: vi.fn().mockResolvedValue(undefined),
        warn: mockWarn,
        error: vi.fn().mockResolvedValue(undefined),
      },
    }));
    const mod = await import('./action-inference.js');
    buildPrTitle = mod.buildPrTitle;
  });

  it('includes template name in title', () => {
    const title = buildPrTitle('fix-bugs', '2026-03-09T10:30:00.000Z');
    expect(title).toContain('fix-bugs');
  });

  it('includes date in YYYY-MM-DD format', () => {
    const title = buildPrTitle('improve-code', '2026-03-09T10:30:00.000Z');
    expect(title).toContain('2026-03-09');
  });

  it('uses today fallback for invalid date', () => {
    const title = buildPrTitle('fix-bugs', 'not-a-date');
    // Should still produce a valid title string without throwing
    expect(title).toContain('fix-bugs');
    expect(title).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('logs warn when completed_at is invalid', () => {
    buildPrTitle('fix-bugs', 'not-a-date');
    expect(mockWarn).toHaveBeenCalledWith(
      'action-inference.invalid-completed-at',
      expect.objectContaining({ completedAt: 'not-a-date' }),
    );
  });
});

describe('buildPrBody', () => {
  let buildPrBody: (templateName: string, commits: string[]) => string;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('../utils/index.js', () => ({
      logger: {
        debug: vi.fn().mockResolvedValue(undefined),
        info: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
      },
    }));
    const mod = await import('./action-inference.js');
    buildPrBody = mod.buildPrBody;
  });

  it('includes template name in body', () => {
    const body = buildPrBody('write-tests', ['abc1234 Add tests']);
    expect(body).toContain('write-tests');
  });

  it('includes all commit messages for small commit lists', () => {
    const commits = ['abc1234 Fix login bug', 'def5678 Add tests'];
    const body = buildPrBody('fix-bugs', commits);
    expect(body).toContain('Fix login bug');
    expect(body).toContain('Add tests');
  });

  it('truncates to 20 commits when list exceeds limit', () => {
    const commits = Array.from(
      { length: 25 },
      (_, i) => `${i.toString().padStart(7, '0')} Commit ${i}`,
    );
    const body = buildPrBody('fix-bugs', commits);
    // Should mention truncation note
    expect(body).toContain('5 more commits not shown');
  });

  it('does not include truncation note for exactly 20 commits', () => {
    const commits = Array.from(
      { length: 20 },
      (_, i) => `${i.toString().padStart(7, '0')} Commit ${i}`,
    );
    const body = buildPrBody('fix-bugs', commits);
    expect(body).not.toContain('more commits not shown');
  });

  it('formats commits as bullet list', () => {
    const commits = ['abc1234 Fix bug'];
    const body = buildPrBody('fix-bugs', commits);
    expect(body).toContain('- abc1234 Fix bug');
  });

  it('handles empty commits array without malformed output', () => {
    const body = buildPrBody('fix-bugs', []);
    expect(body).toContain('fix-bugs');
    expect(body).toContain('_(no commits)_');
  });
});

describe('getCommitsAhead', () => {
  let getCommitsAhead: (
    repoPath: string,
    taskBranch: string,
    baseBranch?: string,
  ) => Promise<string[]>;
  let mockExec: MockExecFileFn;
  let mockWarn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    mockExec =
      vi.fn<
        (file: string, args: string[], opts: Record<string, unknown>) => Promise<ExecFileResult>
      >();
    mockWarn = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../utils/index.js', () => ({
      logger: {
        debug: vi.fn().mockResolvedValue(undefined),
        info: vi.fn().mockResolvedValue(undefined),
        warn: mockWarn,
        error: vi.fn().mockResolvedValue(undefined),
      },
    }));
    vi.doMock('node:child_process', () => ({
      execFile: makeExecFileMock(mockExec),
    }));
    const mod = await import('./action-inference.js');
    getCommitsAhead = mod.getCommitsAhead;
  });

  it('returns array of commit lines from git log output', async () => {
    mockExec.mockResolvedValue({
      stdout: 'abc1234 Fix bug\ndef5678 Add test\n',
      stderr: '',
    });
    const commits = await getCommitsAhead('/repo', 'feature/my-branch');
    expect(commits).toEqual(['abc1234 Fix bug', 'def5678 Add test']);
  });

  it('returns empty array when git log returns empty output', async () => {
    mockExec.mockResolvedValue({ stdout: '', stderr: '' });
    const commits = await getCommitsAhead('/repo', 'feature/my-branch');
    expect(commits).toEqual([]);
  });

  it('returns empty array when git command throws', async () => {
    mockExec.mockRejectedValue(new Error('fatal: not a git repository'));
    const commits = await getCommitsAhead('/repo', 'feature/my-branch');
    expect(commits).toEqual([]);
  });

  it('uses main as default base branch', async () => {
    mockExec.mockResolvedValue({ stdout: '', stderr: '' });
    await getCommitsAhead('/repo', 'feature/my-branch');
    expect(mockExec).toHaveBeenCalledWith(
      'git',
      ['log', '--oneline', 'main..feature/my-branch'],
      expect.any(Object),
    );
  });

  it('uses custom base branch when provided', async () => {
    mockExec.mockResolvedValue({ stdout: '', stderr: '' });
    await getCommitsAhead('/repo', 'feature/my-branch', 'develop');
    expect(mockExec).toHaveBeenCalledWith(
      'git',
      ['log', '--oneline', 'develop..feature/my-branch'],
      expect.any(Object),
    );
  });

  it('filters out blank lines from git output', async () => {
    mockExec.mockResolvedValue({ stdout: 'abc1234 Fix bug\n\ndef5678 Add test\n\n', stderr: '' });
    const commits = await getCommitsAhead('/repo', 'feature/my-branch');
    expect(commits).toEqual(['abc1234 Fix bug', 'def5678 Add test']);
  });

  it('logs warn on git log failure', async () => {
    mockExec.mockRejectedValue(new Error('fatal: bad revision'));
    await getCommitsAhead('/repo', 'feature/my-branch');
    expect(mockWarn).toHaveBeenCalledWith(
      'action-inference.git-log-failed',
      expect.objectContaining({ error: 'fatal: bad revision' }),
    );
  });
});
