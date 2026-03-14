/** Tests for sparecrow results command. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Command } from 'commander';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return join(tmpdir(), `results-cmd-test-${randomBytes(6).toString('hex')}`);
}

function makeAuditLine(event: string, data: Record<string, unknown>): string {
  return JSON.stringify({
    ts: '2026-03-04T10:00:00.000Z',
    level: 'info',
    event,
    data,
    provider: 'claude-code',
    source: 'executor',
    confidence: 'high',
    error: null,
  });
}

function makeResultContent(
  fields: {
    task_id?: string;
    template?: string;
    repo?: string;
    dispatched_at?: string;
    completed_at?: string;
    exit_code?: number;
    branch?: string | null;
  },
  body?: string,
): string {
  const fm = {
    task_id: fields.task_id ?? 'abc1234',
    template: fields.template ?? 'improve-code',
    repo: fields.repo ?? '/home/user/my-repo',
    dispatched_at: fields.dispatched_at ?? '2026-03-04T10:00:00.000Z',
    completed_at: fields.completed_at ?? '2026-03-04T10:30:00.000Z',
    exit_code: fields.exit_code ?? 0,
    branch: fields.branch === undefined ? null : fields.branch,
  };

  const branchValue = fm.branch === null ? 'null' : `"${fm.branch}"`;

  const lines = [
    '---',
    `task_id: "${fm.task_id}"`,
    `template: "${fm.template}"`,
    `repo: "${fm.repo}"`,
    `dispatched_at: "${fm.dispatched_at}"`,
    `completed_at: "${fm.completed_at}"`,
    `exit_code: ${fm.exit_code}`,
    `branch: ${branchValue}`,
    '---',
    '',
    body ?? 'Task output here.',
  ];

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Human mode tests
// ---------------------------------------------------------------------------

describe('registerResults — human mode', () => {
  let stdoutOutput: string;
  let stderrOutput: string;
  let logsDir: string;
  let repoDir: string;

  beforeEach(async () => {
    vi.resetModules();
    logsDir = makeTempDir();
    repoDir = makeTempDir();
    await mkdir(logsDir, { recursive: true });
    await mkdir(join(repoDir, '.scrow'), { recursive: true });
    stdoutOutput = '';
    stderrOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      stderrOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
    }));
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({
        logs: logsDir,
        data: logsDir,
        config: logsDir,
        taskOutputs: logsDir,
      }),
    }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    await rm(logsDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  });

  it('renders empty state message when no results exist (AC8)', async () => {
    const { registerResults } = await import('./results.js');
    const program = new Command();
    program.exitOverride();
    registerResults(program);
    await program.parseAsync(['node', 'sparecrow', 'results']);
    expect(stdoutOutput).toContain('No results found. Try running a task first.');
    expect(stdoutOutput).toContain('Hint:');
  });

  it('renders table with results (AC1)', async () => {
    // Set up audit log to discover repo
    await writeFile(
      join(logsDir, 'audit-2026-03-04.jsonl'),
      makeAuditLine('result.artifact-written', { repoPath: repoDir }) + '\n',
      'utf-8',
    );

    // Create result file
    await writeFile(
      join(repoDir, '.scrow', '2026-03-04T10-30-00Z-improve-code-abc1234.md'),
      makeResultContent({
        task_id: 'abc1234',
        template: 'improve-code',
        repo: repoDir,
        completed_at: '2026-03-04T10:30:00.000Z',
      }),
      'utf-8',
    );

    const { registerResults } = await import('./results.js');
    const program = new Command();
    program.exitOverride();
    registerResults(program);
    await program.parseAsync(['node', 'sparecrow', 'results']);

    expect(stdoutOutput).toContain('abc1234');
    expect(stdoutOutput).toContain('improve-code');
    expect(stdoutOutput).toContain('1 result(s) found');
  });

  it('filters by --repo (AC2)', async () => {
    const repo2 = makeTempDir();
    await mkdir(join(repo2, '.scrow'), { recursive: true });

    // Audit log with both repos
    const lines = [
      makeAuditLine('result.artifact-written', { repoPath: repoDir }),
      makeAuditLine('result.artifact-written', { repoPath: repo2 }),
    ];
    await writeFile(join(logsDir, 'audit-2026-03-04.jsonl'), lines.join('\n') + '\n', 'utf-8');

    // Results in both repos
    await writeFile(
      join(repoDir, '.scrow', 'file1.md'),
      makeResultContent({ task_id: 'aaa1111', repo: repoDir }),
      'utf-8',
    );
    await writeFile(
      join(repo2, '.scrow', 'file2.md'),
      makeResultContent({ task_id: 'bbb2222', repo: repo2 }),
      'utf-8',
    );

    const { registerResults } = await import('./results.js');
    const program = new Command();
    program.exitOverride();
    registerResults(program);
    await program.parseAsync(['node', 'sparecrow', 'results', '--repo', repoDir]);

    expect(stdoutOutput).toContain('aaa1111');
    expect(stdoutOutput).not.toContain('bbb2222');
    expect(stdoutOutput).toContain('1 result(s) found');

    await rm(repo2, { recursive: true, force: true });
  });

  it('filters by --template (AC3)', async () => {
    await writeFile(
      join(logsDir, 'audit-2026-03-04.jsonl'),
      makeAuditLine('result.artifact-written', { repoPath: repoDir }) + '\n',
      'utf-8',
    );

    await writeFile(
      join(repoDir, '.scrow', 'file1.md'),
      makeResultContent({ task_id: 'aaa1111', template: 'improve-code', repo: repoDir }),
      'utf-8',
    );
    await writeFile(
      join(repoDir, '.scrow', 'file2.md'),
      makeResultContent({ task_id: 'bbb2222', template: 'security-audit', repo: repoDir }),
      'utf-8',
    );

    const { registerResults } = await import('./results.js');
    const program = new Command();
    program.exitOverride();
    registerResults(program);
    await program.parseAsync(['node', 'sparecrow', 'results', '--template', 'security-audit']);

    expect(stdoutOutput).toContain('bbb2222');
    expect(stdoutOutput).not.toContain('aaa1111');
    expect(stdoutOutput).toContain('1 result(s) found');
  });

  it('outputs raw content with --latest (AC4)', async () => {
    await writeFile(
      join(logsDir, 'audit-2026-03-04.jsonl'),
      makeAuditLine('result.artifact-written', { repoPath: repoDir }) + '\n',
      'utf-8',
    );

    const latestContent = makeResultContent(
      {
        task_id: 'latest1',
        repo: repoDir,
        completed_at: '2026-03-04T12:00:00.000Z',
      },
      'Latest output body.',
    );
    await writeFile(join(repoDir, '.scrow', 'latest.md'), latestContent, 'utf-8');

    const olderContent = makeResultContent(
      {
        task_id: 'older11',
        repo: repoDir,
        completed_at: '2026-03-03T12:00:00.000Z',
      },
      'Older output body.',
    );
    await writeFile(join(repoDir, '.scrow', 'older.md'), olderContent, 'utf-8');

    const { registerResults } = await import('./results.js');
    const program = new Command();
    program.exitOverride();
    registerResults(program);
    await program.parseAsync(['node', 'sparecrow', 'results', '--latest']);

    expect(stdoutOutput).toContain('Latest output body.');
    expect(stdoutOutput).not.toContain('Older output body.');
  });

  it('outputs raw content with --task (AC5)', async () => {
    await writeFile(
      join(logsDir, 'audit-2026-03-04.jsonl'),
      makeAuditLine('result.artifact-written', { repoPath: repoDir }) + '\n',
      'utf-8',
    );

    const content = makeResultContent(
      {
        task_id: 'xyz9876',
        repo: repoDir,
      },
      'Specific task output.',
    );
    await writeFile(join(repoDir, '.scrow', 'specific.md'), content, 'utf-8');

    const { registerResults } = await import('./results.js');
    const program = new Command();
    program.exitOverride();
    registerResults(program);
    await program.parseAsync(['node', 'sparecrow', 'results', '--task', 'xyz9876']);

    expect(stdoutOutput).toContain('Specific task output.');
  });

  it('shows error for --task with unknown ID (AC5)', async () => {
    const { registerResults } = await import('./results.js');
    const program = new Command();
    program.exitOverride();
    registerResults(program);
    await program.parseAsync(['node', 'sparecrow', 'results', '--task', 'nonexist']);

    expect(stderrOutput).toContain('No result found for task ID "nonexist"');
    expect(process.exitCode).toBe(1);
  });

  it('--task with --repo from a different repo returns not found', async () => {
    // Set up a result in repoDir
    await writeFile(
      join(logsDir, 'audit-2026-03-04.jsonl'),
      makeAuditLine('result.artifact-written', { repoPath: repoDir }) + '\n',
      'utf-8',
    );

    const content = makeResultContent({
      task_id: 'abc9999',
      repo: repoDir,
    });
    await writeFile(join(repoDir, '.scrow', 'specific.md'), content, 'utf-8');

    const { registerResults } = await import('./results.js');
    const program = new Command();
    program.exitOverride();
    registerResults(program);

    // Specify a --repo that does NOT match the result's repo — should be not found
    await program.parseAsync([
      'node',
      'sparecrow',
      'results',
      '--task',
      'abc9999',
      '--repo',
      '/some/other/repo',
    ]);

    // The result belongs to repoDir, not /some/other/repo, so filter should exclude it
    expect(stderrOutput).toContain('No result found for task ID "abc9999"');
    expect(process.exitCode).toBe(1);
  });

  it('shows empty state with --latest when no results exist', async () => {
    const { registerResults } = await import('./results.js');
    const program = new Command();
    program.exitOverride();
    registerResults(program);
    await program.parseAsync(['node', 'sparecrow', 'results', '--latest']);

    expect(stdoutOutput).toContain('No results found. Try running a task first.');
  });
});

// ---------------------------------------------------------------------------
// JSON mode tests
// ---------------------------------------------------------------------------

describe('registerResults — JSON mode', () => {
  let stdoutOutput: string;
  let logsDir: string;
  let repoDir: string;

  beforeEach(async () => {
    vi.resetModules();
    logsDir = makeTempDir();
    repoDir = makeTempDir();
    await mkdir(logsDir, { recursive: true });
    await mkdir(join(repoDir, '.scrow'), { recursive: true });
    stdoutOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((_data) => {
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    vi.doMock('../index.js', () => ({
      isJsonMode: () => true,
      getConfigPath: () => undefined,
    }));
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({
        logs: logsDir,
        data: logsDir,
        config: logsDir,
        taskOutputs: logsDir,
      }),
    }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(logsDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  });

  function parseOutput(): { ok: boolean; data: unknown; error: unknown } {
    return JSON.parse(stdoutOutput) as { ok: boolean; data: unknown; error: unknown };
  }

  it('outputs standard JSON envelope for list mode (AC6)', async () => {
    await writeFile(
      join(logsDir, 'audit-2026-03-04.jsonl'),
      makeAuditLine('result.artifact-written', { repoPath: repoDir }) + '\n',
      'utf-8',
    );

    await writeFile(
      join(repoDir, '.scrow', 'file.md'),
      makeResultContent({ task_id: 'abc1234', repo: repoDir }),
      'utf-8',
    );

    const { registerResults } = await import('./results.js');
    const program = new Command();
    program.exitOverride();
    registerResults(program);
    await program.parseAsync(['node', 'sparecrow', 'results']);

    const parsed = parseOutput();
    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeNull();

    const data = parsed.data as { results: unknown[]; count: number };
    expect(data.count).toBe(1);
    expect(data.results).toHaveLength(1);

    const result = data.results[0] as Record<string, unknown>;
    expect(result).toHaveProperty('task_id');
    expect(result).toHaveProperty('template');
    expect(result).toHaveProperty('repo');
    expect(result).toHaveProperty('dispatched_at');
    expect(result).toHaveProperty('completed_at');
    expect(result).toHaveProperty('exit_code');
    expect(result).toHaveProperty('branch');
    expect(result).toHaveProperty('file_path');
  });

  it('outputs JSON with ok:true and empty results for empty state (AC6, AC8)', async () => {
    const { registerResults } = await import('./results.js');
    const program = new Command();
    program.exitOverride();
    registerResults(program);
    await program.parseAsync(['node', 'sparecrow', 'results']);

    const parsed = parseOutput();
    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeNull();
    const data = parsed.data as { results: unknown[]; count: number };
    expect(data.results).toEqual([]);
    expect(data.count).toBe(0);
  });

  it('outputs JSON error for --task with unknown ID', async () => {
    const { registerResults } = await import('./results.js');
    const program = new Command();
    program.exitOverride();
    registerResults(program);
    await program.parseAsync(['node', 'sparecrow', 'results', '--task', 'zzz']);

    const parsed = parseOutput();
    expect(parsed.ok).toBe(false);
    expect(parsed.data).toBeNull();
    expect(parsed.error).not.toBeNull();
    const err = parsed.error as { code: string; message: string };
    expect(err.code).toBe('RESULTS_NOT_FOUND');
  });

  it('outputs JSON for --latest with result data', async () => {
    await writeFile(
      join(logsDir, 'audit-2026-03-04.jsonl'),
      makeAuditLine('result.artifact-written', { repoPath: repoDir }) + '\n',
      'utf-8',
    );

    await writeFile(
      join(repoDir, '.scrow', 'file.md'),
      makeResultContent({ task_id: 'abc1234', repo: repoDir }),
      'utf-8',
    );

    const { registerResults } = await import('./results.js');
    const program = new Command();
    program.exitOverride();
    registerResults(program);
    await program.parseAsync(['node', 'sparecrow', 'results', '--latest']);

    const parsed = parseOutput();
    expect(parsed.ok).toBe(true);
    const data = parsed.data as Record<string, unknown>;
    expect(data['task_id']).toBe('abc1234');
    expect(data['file_path']).toBeDefined();
  });

  it('outputs JSON error for --latest with no results', async () => {
    const { registerResults } = await import('./results.js');
    const program = new Command();
    program.exitOverride();
    registerResults(program);
    await program.parseAsync(['node', 'sparecrow', 'results', '--latest']);

    const parsed = parseOutput();
    expect(parsed.ok).toBe(false);
    expect(parsed.data).toBeNull();
    const err = parsed.error as { code: string; message: string };
    expect(err.code).toBe('RESULTS_NOT_FOUND');
  });

  it('outputs JSON for --task with matching result', async () => {
    await writeFile(
      join(logsDir, 'audit-2026-03-04.jsonl'),
      makeAuditLine('result.artifact-written', { repoPath: repoDir }) + '\n',
      'utf-8',
    );

    await writeFile(
      join(repoDir, '.scrow', 'file.md'),
      makeResultContent({ task_id: 'xyz7890', repo: repoDir }),
      'utf-8',
    );

    const { registerResults } = await import('./results.js');
    const program = new Command();
    program.exitOverride();
    registerResults(program);
    await program.parseAsync(['node', 'sparecrow', 'results', '--task', 'xyz7890']);

    const parsed = parseOutput();
    expect(parsed.ok).toBe(true);
    const data = parsed.data as Record<string, unknown>;
    expect(data['task_id']).toBe('xyz7890');
  });
});

// ---------------------------------------------------------------------------
// Error handling tests
// ---------------------------------------------------------------------------

describe('registerResults — error handling', () => {
  let stdoutOutput: string;
  let stderrOutput: string;

  beforeEach(async () => {
    vi.resetModules();
    stdoutOutput = '';
    stderrOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      stderrOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Reset process.exitCode so stale exit code does not bleed into subsequent tests.
    process.exitCode = undefined;
  });

  it('handles getPaths throwing in human mode', async () => {
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
    }));
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => {
        throw new Error('paths unavailable');
      },
    }));

    const { registerResults } = await import('./results.js');
    const program = new Command();
    program.exitOverride();
    registerResults(program);
    await program.parseAsync(['node', 'sparecrow', 'results']);

    expect(stderrOutput).toContain('paths unavailable');
    expect(process.exitCode).toBe(1);
  });

  it('handles getPaths throwing in JSON mode', async () => {
    vi.doMock('../index.js', () => ({
      isJsonMode: () => true,
      getConfigPath: () => undefined,
    }));
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => {
        throw new Error('paths unavailable');
      },
    }));

    const { registerResults } = await import('./results.js');
    const program = new Command();
    program.exitOverride();
    registerResults(program);
    await program.parseAsync(['node', 'sparecrow', 'results']);

    const parsed = JSON.parse(stdoutOutput) as { ok: boolean; error: unknown };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).not.toBeNull();
  });
});
