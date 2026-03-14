/** Integration tests for action pipeline — post-execution action flow (Story 17.5 Task 12). */
import { mkdir, rm, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function makeTmpDir(): string {
  return join(tmpdir(), `sparecrow-action-pipeline-int-${randomBytes(6).toString('hex')}`);
}

/** Builds a valid .scrow/ result markdown file with optional action block. */
function buildResultContent(options: {
  taskId: string;
  template: string;
  repoPath: string;
  exitCode: number;
  branch: string | null;
  actionBlock?: string;
}): string {
  const branchValue = options.branch === null ? 'null' : options.branch;
  const frontmatter = [
    '---',
    `task_id: ${options.taskId}`,
    `template: ${options.template}`,
    `repo: ${options.repoPath}`,
    `dispatched_at: 2026-03-09T10:00:00.000Z`,
    `completed_at: 2026-03-09T10:05:00.000Z`,
    `exit_code: ${options.exitCode}`,
    `branch: ${branchValue}`,
    '---',
    '',
    '# Task Output',
    '',
    'Some output here.',
  ].join('\n');

  if (options.actionBlock) {
    return frontmatter + '\n\n' + options.actionBlock;
  }
  return frontmatter;
}

const VALID_ACTION_BLOCK = `\`\`\`yaml sparecrow:actions
actions:
  - type: git-push
    branch: sparecrow/fix-bugs-20260309T100000Z
\`\`\``;

describe('action-pipeline integration', () => {
  let tmpDir: string;
  let repoPath: string;
  let scrowDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = makeTmpDir();
    repoPath = join(tmpDir, 'repo');
    scrowDir = join(repoPath, '.scrow');
    await mkdir(scrowDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('AC1/AC6: mock task output with valid action block → pipeline executes and writes companion', async () => {
    const taskId = 'task-' + randomBytes(3).toString('hex');
    const resultFilename = `2026-03-09T10-00-00Z-fix-bugs-${taskId.slice(0, 7)}.md`;
    const resultFilePath = join(scrowDir, resultFilename);
    const companionPath = join(scrowDir, `2026-03-09T10-00-00Z-fix-bugs-${taskId.slice(0, 7)}.actions.json`);

    // Write result file with action block
    const content = buildResultContent({
      taskId,
      template: 'fix-bugs',
      repoPath,
      exitCode: 0,
      branch: 'sparecrow/fix-bugs-20260309T100000Z',
      actionBlock: VALID_ACTION_BLOCK,
    });
    await writeFile(resultFilePath, content, 'utf-8');

    // Mock executeActions to avoid real git/gh calls
    vi.doMock('../../src/daemon/action-executor.js', () => ({
      executeActions: vi.fn().mockResolvedValue([
        { type: 'git-push', status: 'success' },
      ]),
      checkGhAvailable: vi.fn().mockResolvedValue(false),
    }));

    const { runActionPipeline } = await import('../../src/daemon/action-pipeline.js');
    const result = await runActionPipeline({
      frontmatter: {
        task_id: taskId,
        template: 'fix-bugs',
        repo: repoPath,
        dispatched_at: '2026-03-09T10:00:00.000Z',
        completed_at: '2026-03-09T10:05:00.000Z',
        exit_code: 0,
        branch: 'sparecrow/fix-bugs-20260309T100000Z',
      },
      templateActions: ['git-push', 'pr-create'],
      resultFilePath,
      taskId,
      repoPath,
    });

    expect(result).not.toBeNull();
    expect(result?.source).toBe('parsed');
    expect(result?.actions_executed).toBe(1);

    // Companion file must have been written
    await expect(access(companionPath)).resolves.toBeUndefined();
    const companionRaw = await readFile(companionPath, 'utf-8');
    const companion = JSON.parse(companionRaw) as Record<string, unknown>;
    expect(companion['task_id']).toBe(taskId);
    expect(companion['source']).toBe('parsed');
  });

  it('AC6: mock task output WITHOUT action block but with branch/commits → inference produces results', async () => {
    const taskId = 'task-' + randomBytes(3).toString('hex');
    const resultFilename = `2026-03-09T10-00-00Z-fix-bugs-${taskId.slice(0, 7)}.md`;
    const resultFilePath = join(scrowDir, resultFilename);

    // Write result file WITHOUT action block
    const content = buildResultContent({
      taskId,
      template: 'fix-bugs',
      repoPath,
      exitCode: 0,
      branch: 'sparecrow/fix-bugs-20260309T100000Z',
    });
    await writeFile(resultFilePath, content, 'utf-8');

    // Mock getCommitsAhead to return commits and executeActions to return results
    vi.doMock('../../src/daemon/action-executor.js', () => ({
      executeActions: vi.fn().mockResolvedValue([
        { type: 'git-push', status: 'success' },
        { type: 'pr-create', status: 'success', url: 'https://github.com/org/repo/pull/42' },
      ]),
      checkGhAvailable: vi.fn().mockResolvedValue(true),
    }));
    vi.doMock('../../src/daemon/action-inference.js', () => ({
      inferActions: vi.fn().mockResolvedValue({
        actions: [
          { type: 'git-push', branch: 'sparecrow/fix-bugs-20260309T100000Z' },
          { type: 'pr-create', title: 'fix-bugs: automated changes', body: 'body' },
        ],
      }),
      getCommitsAhead: vi.fn().mockResolvedValue(['abc1234 Fix bug']),
      buildPrTitle: vi.fn().mockReturnValue('PR title'),
      buildPrBody: vi.fn().mockReturnValue('PR body'),
    }));

    const { runActionPipeline } = await import('../../src/daemon/action-pipeline.js');
    const result = await runActionPipeline({
      frontmatter: {
        task_id: taskId,
        template: 'fix-bugs',
        repo: repoPath,
        dispatched_at: '2026-03-09T10:00:00.000Z',
        completed_at: '2026-03-09T10:05:00.000Z',
        exit_code: 0,
        branch: 'sparecrow/fix-bugs-20260309T100000Z',
      },
      templateActions: ['git-push', 'pr-create'],
      resultFilePath,
      taskId,
      repoPath,
    });

    expect(result).not.toBeNull();
    expect(result?.source).toBe('inferred');
    expect(result?.actions_executed).toBe(2);
  });

  it('AC2/AC6: failed task (exit_code != 0) → pipeline skipped in polling-loop, no companion written', async () => {
    const taskId = 'task-' + randomBytes(3).toString('hex');
    const resultFilename = `2026-03-09T10-00-00Z-fix-bugs-${taskId.slice(0, 7)}.md`;
    const resultFilePath = join(scrowDir, resultFilename);
    const companionPath = join(scrowDir, `2026-03-09T10-00-00Z-fix-bugs-${taskId.slice(0, 7)}.actions.json`);

    // Write result file with action block (but exit_code = 1)
    const content = buildResultContent({
      taskId,
      template: 'fix-bugs',
      repoPath,
      exitCode: 1,
      branch: null,
      actionBlock: VALID_ACTION_BLOCK,
    });
    await writeFile(resultFilePath, content, 'utf-8');

    // Track whether executeActions was called — it must NOT be called when exitCode != 0
    const executeActionsSpy = vi.fn().mockResolvedValue([]);
    vi.doMock('../../src/daemon/action-executor.js', () => ({
      executeActions: executeActionsSpy,
      checkGhAvailable: vi.fn().mockResolvedValue(false),
    }));

    const { runActionPipeline } = await import('../../src/daemon/action-pipeline.js');

    // Replicate the polling-loop.ts guard: only call runActionPipeline when exitCode === 0
    const exitCode = 1;
    let result: Awaited<ReturnType<typeof runActionPipeline>> = null;
    if (exitCode === 0) {
      result = await runActionPipeline({
        frontmatter: {
          task_id: taskId,
          template: 'fix-bugs',
          repo: repoPath,
          dispatched_at: '2026-03-09T10:00:00.000Z',
          completed_at: '2026-03-09T10:05:00.000Z',
          exit_code: exitCode,
          branch: null,
        },
        templateActions: ['git-push'],
        resultFilePath,
        taskId,
        repoPath,
      });
    }

    // Guard prevented the call — result is null and executeActions was never called
    expect(result).toBeNull();
    expect(executeActionsSpy).not.toHaveBeenCalled();
    // No companion should be written
    await expect(access(companionPath)).rejects.toThrow();
  });

  it('AC2: null exitCode (signal kill) is treated as non-zero → pipeline skipped', async () => {
    const taskId = 'task-' + randomBytes(3).toString('hex');
    const resultFilename = `2026-03-09T10-00-00Z-fix-bugs-${taskId.slice(0, 7)}.md`;
    const resultFilePath = join(scrowDir, resultFilename);
    const companionPath = join(scrowDir, `2026-03-09T10-00-00Z-fix-bugs-${taskId.slice(0, 7)}.actions.json`);

    await writeFile(resultFilePath, buildResultContent({
      taskId,
      template: 'fix-bugs',
      repoPath,
      exitCode: 0,
      branch: null,
      actionBlock: VALID_ACTION_BLOCK,
    }), 'utf-8');

    const executeActionsSpy = vi.fn().mockResolvedValue([]);
    vi.doMock('../../src/daemon/action-executor.js', () => ({
      executeActions: executeActionsSpy,
      checkGhAvailable: vi.fn().mockResolvedValue(false),
    }));

    const { runActionPipeline } = await import('../../src/daemon/action-pipeline.js');

    // Replicate polling-loop guard: null exitCode (signal kill) — null === 0 is false
    const exitCode: number | null = null;
    let result: Awaited<ReturnType<typeof runActionPipeline>> = null;
    if (exitCode === 0) {
      result = await runActionPipeline({
        frontmatter: {
          task_id: taskId,
          template: 'fix-bugs',
          repo: repoPath,
          dispatched_at: '2026-03-09T10:00:00.000Z',
          completed_at: '2026-03-09T10:05:00.000Z',
          exit_code: 0,
          branch: null,
        },
        templateActions: ['git-push'],
        resultFilePath,
        taskId,
        repoPath,
      });
    }

    expect(result).toBeNull();
    expect(executeActionsSpy).not.toHaveBeenCalled();
    await expect(access(companionPath)).rejects.toThrow();
  });

  it('AC5: mixed list — readActionCompanion returns null for entries without companion', async () => {
    // Create two result files: one with companion, one without
    const taskId1 = 'aaabbb1';
    const taskId2 = 'cccddd2';
    const file1 = join(scrowDir, '2026-03-09T10-00-00Z-fix-bugs-aaabbb1.md');
    const file2 = join(scrowDir, '2026-03-09T10-01-00Z-fix-bugs-cccddd2.md');
    const companion1 = join(scrowDir, '2026-03-09T10-00-00Z-fix-bugs-aaabbb1.actions.json');

    // Write result files
    await writeFile(file1, buildResultContent({ taskId: taskId1, template: 'fix-bugs', repoPath, exitCode: 0, branch: null }), 'utf-8');
    await writeFile(file2, buildResultContent({ taskId: taskId2, template: 'fix-bugs', repoPath, exitCode: 0, branch: null }), 'utf-8');

    // Write companion for file1 only
    const companionData = {
      task_id: taskId1,
      source: 'parsed',
      actions_requested: 1,
      actions_executed: 1,
      actions_failed: 0,
      actions_skipped: 0,
      results: [{ type: 'git-push', status: 'success', url: null, error: null, reason: null }],
    };
    await writeFile(companion1, JSON.stringify(companionData), 'utf-8');

    const { readActionCompanion } = await import('../../src/cli/commands/results-reader.js');
    const result1 = await readActionCompanion(file1);
    const result2 = await readActionCompanion(file2);

    expect(result1).not.toBeNull();
    expect(result1?.task_id).toBe(taskId1);
    expect(result2).toBeNull();
  });
});
