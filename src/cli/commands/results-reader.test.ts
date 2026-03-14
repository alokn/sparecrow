/** Tests for results-reader — result artifact discovery and frontmatter parsing. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  discoverRepoPaths,
  parseFrontmatter,
  discoverResultFiles,
  filterResults,
  findResultByTaskId,
  getLatestResult,
  toRelativeHomePath,
  readActionCompanion,
} from './results-reader.js';
import type { ResultEntry } from './results-reader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return join(tmpdir(), `results-test-${randomBytes(6).toString('hex')}`);
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
// discoverRepoPaths tests
// ---------------------------------------------------------------------------

describe('discoverRepoPaths', () => {
  let logsDir: string;

  beforeEach(async () => {
    logsDir = makeTempDir();
    await mkdir(logsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(logsDir, { recursive: true, force: true });
  });

  it('returns empty array when logs directory does not exist', async () => {
    const missing = join(tmpdir(), `missing-${randomBytes(4).toString('hex')}`);
    const result = await discoverRepoPaths(missing);
    expect(result).toEqual([]);
  });

  it('returns empty array when no audit files exist', async () => {
    const result = await discoverRepoPaths(logsDir);
    expect(result).toEqual([]);
  });

  it('extracts unique repo paths from RESULT_ARTIFACT_WRITTEN events', async () => {
    const lines = [
      makeAuditLine('result.artifact-written', {
        taskId: 't1',
        repoPath: '/home/user/repo-a',
      }),
      makeAuditLine('result.artifact-written', {
        taskId: 't2',
        repoPath: '/home/user/repo-b',
      }),
      makeAuditLine('result.artifact-written', {
        taskId: 't3',
        repoPath: '/home/user/repo-a', // duplicate
      }),
    ];
    await writeFile(join(logsDir, 'audit-2026-03-04.jsonl'), lines.join('\n') + '\n', 'utf-8');
    const result = await discoverRepoPaths(logsDir);
    expect(result).toHaveLength(2);
    expect(result).toContain('/home/user/repo-a');
    expect(result).toContain('/home/user/repo-b');
  });

  it('extracts repo paths from task.completed events with targetPath', async () => {
    const lines = [
      makeAuditLine('task.completed', {
        taskId: 't1',
        targetPath: '/home/user/repo-c',
      }),
    ];
    await writeFile(join(logsDir, 'audit-2026-03-04.jsonl'), lines.join('\n') + '\n', 'utf-8');
    const result = await discoverRepoPaths(logsDir);
    expect(result).toContain('/home/user/repo-c');
  });

  it('handles malformed JSONL lines gracefully', async () => {
    const lines = [
      'not valid json',
      makeAuditLine('result.artifact-written', {
        taskId: 't1',
        repoPath: '/home/user/repo-good',
      }),
      '{incomplete',
    ];
    await writeFile(join(logsDir, 'audit-2026-03-04.jsonl'), lines.join('\n') + '\n', 'utf-8');
    const result = await discoverRepoPaths(logsDir);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('/home/user/repo-good');
  });

  it('scans multiple audit files', async () => {
    await writeFile(
      join(logsDir, 'audit-2026-03-03.jsonl'),
      makeAuditLine('result.artifact-written', { repoPath: '/repo-1' }) + '\n',
      'utf-8',
    );
    await writeFile(
      join(logsDir, 'audit-2026-03-04.jsonl'),
      makeAuditLine('result.artifact-written', { repoPath: '/repo-2' }) + '\n',
      'utf-8',
    );
    const result = await discoverRepoPaths(logsDir);
    expect(result).toHaveLength(2);
    expect(result).toContain('/repo-1');
    expect(result).toContain('/repo-2');
  });

  it('ignores non-audit files', async () => {
    await writeFile(
      join(logsDir, 'not-an-audit-file.txt'),
      makeAuditLine('result.artifact-written', { repoPath: '/should-not-appear' }) + '\n',
      'utf-8',
    );
    const result = await discoverRepoPaths(logsDir);
    expect(result).toEqual([]);
  });

  it('ignores events without repoPath or targetPath', async () => {
    const lines = [
      makeAuditLine('result.artifact-written', { taskId: 't1' }), // no repoPath
      makeAuditLine('usage.polled', { weeklyUtilization: 0.5 }), // irrelevant event
    ];
    await writeFile(join(logsDir, 'audit-2026-03-04.jsonl'), lines.join('\n') + '\n', 'utf-8');
    const result = await discoverRepoPaths(logsDir);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseFrontmatter tests
// ---------------------------------------------------------------------------

describe('parseFrontmatter', () => {
  it('parses all 7 frontmatter fields correctly', () => {
    const content = makeResultContent({
      task_id: 'abc1234',
      template: 'security-audit',
      repo: '/home/user/my-repo',
      dispatched_at: '2026-03-04T10:00:00.000Z',
      completed_at: '2026-03-04T10:30:00.000Z',
      exit_code: 0,
      branch: null,
    });
    const fm = parseFrontmatter(content);
    expect(fm).not.toBeNull();
    expect(fm!.task_id).toBe('abc1234');
    expect(fm!.template).toBe('security-audit');
    expect(fm!.repo).toBe('/home/user/my-repo');
    expect(fm!.dispatched_at).toBe('2026-03-04T10:00:00.000Z');
    expect(fm!.completed_at).toBe('2026-03-04T10:30:00.000Z');
    expect(fm!.exit_code).toBe(0);
    expect(fm!.branch).toBeNull();
  });

  it('parses branch as string when not null', () => {
    const content = makeResultContent({
      branch: 'sparecrow/fix-bugs-20260304T143000Z',
    });
    const fm = parseFrontmatter(content);
    expect(fm).not.toBeNull();
    expect(fm!.branch).toBe('sparecrow/fix-bugs-20260304T143000Z');
  });

  it('parses non-zero exit code', () => {
    const content = makeResultContent({ exit_code: 1 });
    const fm = parseFrontmatter(content);
    expect(fm).not.toBeNull();
    expect(fm!.exit_code).toBe(1);
  });

  it('returns null for content without frontmatter delimiters', () => {
    const fm = parseFrontmatter('Just plain text with no frontmatter.');
    expect(fm).toBeNull();
  });

  it('returns null for content with incomplete frontmatter', () => {
    const content = '---\ntask_id: "abc"\n---';
    const fm = parseFrontmatter(content);
    expect(fm).toBeNull(); // missing required fields
  });

  it('returns null for non-numeric exit_code', () => {
    const content = [
      '---',
      'task_id: "abc"',
      'template: "test"',
      'repo: "/repo"',
      'dispatched_at: "2026-03-04T10:00:00.000Z"',
      'completed_at: "2026-03-04T10:30:00.000Z"',
      'exit_code: not-a-number',
      'branch: null',
      '---',
    ].join('\n');
    const fm = parseFrontmatter(content);
    expect(fm).toBeNull();
  });

  it('handles empty body after frontmatter', () => {
    const content = makeResultContent({}, '');
    const fm = parseFrontmatter(content);
    expect(fm).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// discoverResultFiles tests
// ---------------------------------------------------------------------------

describe('discoverResultFiles', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = makeTempDir();
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('discovers files across multiple repos', async () => {
    const repo1 = join(tempDir, 'repo1');
    const repo2 = join(tempDir, 'repo2');
    await mkdir(join(repo1, '.scrow'), { recursive: true });
    await mkdir(join(repo2, '.scrow'), { recursive: true });

    await writeFile(
      join(repo1, '.scrow', '2026-03-04T10-00-00Z-improve-code-abc1234.md'),
      makeResultContent({
        task_id: 'abc1234',
        repo: repo1,
        completed_at: '2026-03-04T10:00:00.000Z',
      }),
      'utf-8',
    );
    await writeFile(
      join(repo2, '.scrow', '2026-03-04T11-00-00Z-security-audit-def5678.md'),
      makeResultContent({
        task_id: 'def5678',
        template: 'security-audit',
        repo: repo2,
        completed_at: '2026-03-04T11:00:00.000Z',
      }),
      'utf-8',
    );

    const results = await discoverResultFiles([repo1, repo2]);
    expect(results).toHaveLength(2);
    // Sorted by completed_at descending — def5678 (11:00) first, abc1234 (10:00) second
    expect(results[0]!.frontmatter.task_id).toBe('def5678');
    expect(results[1]!.frontmatter.task_id).toBe('abc1234');
  });

  it('handles missing repo gracefully', async () => {
    const missingRepo = join(tempDir, 'does-not-exist');
    const results = await discoverResultFiles([missingRepo]);
    expect(results).toEqual([]);
  });

  it('handles repo with no .scrow/ directory', async () => {
    const repoNoScrow = join(tempDir, 'repo-no-scrow');
    await mkdir(repoNoScrow, { recursive: true });
    const results = await discoverResultFiles([repoNoScrow]);
    expect(results).toEqual([]);
  });

  it('skips non-.md files in .scrow/ directory', async () => {
    const repo = join(tempDir, 'repo');
    await mkdir(join(repo, '.scrow'), { recursive: true });

    await writeFile(join(repo, '.scrow', 'not-a-result.txt'), 'just text', 'utf-8');
    await writeFile(
      join(repo, '.scrow', '2026-03-04T10-00-00Z-improve-code-abc1234.md'),
      makeResultContent({ task_id: 'abc1234', repo }),
      'utf-8',
    );

    const results = await discoverResultFiles([repo]);
    expect(results).toHaveLength(1);
    expect(results[0]!.frontmatter.task_id).toBe('abc1234');
  });

  it('skips .md files with malformed frontmatter', async () => {
    const repo = join(tempDir, 'repo');
    await mkdir(join(repo, '.scrow'), { recursive: true });

    await writeFile(join(repo, '.scrow', 'bad-file.md'), 'No frontmatter here.', 'utf-8');
    await writeFile(
      join(repo, '.scrow', 'good-file.md'),
      makeResultContent({ task_id: 'good123', repo }),
      'utf-8',
    );

    const results = await discoverResultFiles([repo]);
    expect(results).toHaveLength(1);
    expect(results[0]!.frontmatter.task_id).toBe('good123');
  });

  it('returns results sorted by completed_at descending', async () => {
    const repo = join(tempDir, 'repo');
    await mkdir(join(repo, '.scrow'), { recursive: true });

    await writeFile(
      join(repo, '.scrow', 'file-old.md'),
      makeResultContent({
        task_id: 'old1234',
        repo,
        completed_at: '2026-03-01T10:00:00.000Z',
      }),
      'utf-8',
    );
    await writeFile(
      join(repo, '.scrow', 'file-new.md'),
      makeResultContent({
        task_id: 'new1234',
        repo,
        completed_at: '2026-03-04T10:00:00.000Z',
      }),
      'utf-8',
    );
    await writeFile(
      join(repo, '.scrow', 'file-mid.md'),
      makeResultContent({
        task_id: 'mid1234',
        repo,
        completed_at: '2026-03-02T10:00:00.000Z',
      }),
      'utf-8',
    );

    const results = await discoverResultFiles([repo]);
    expect(results).toHaveLength(3);
    expect(results[0]!.frontmatter.task_id).toBe('new1234');
    expect(results[1]!.frontmatter.task_id).toBe('mid1234');
    expect(results[2]!.frontmatter.task_id).toBe('old1234');
  });
});

// ---------------------------------------------------------------------------
// filterResults tests
// ---------------------------------------------------------------------------

describe('filterResults', () => {
  const makeEntry = (taskId: string, template: string, repo: string): ResultEntry => ({
    frontmatter: {
      task_id: taskId,
      template,
      repo,
      dispatched_at: '2026-03-04T10:00:00.000Z',
      completed_at: '2026-03-04T10:30:00.000Z',
      exit_code: 0,
      branch: null,
    },
    filePath: `${repo}/.scrow/file.md`,
    rawContent: 'content',
  });

  // Each test creates its own fresh entries array to avoid shared mutable state.
  let entries: ResultEntry[];

  beforeEach(() => {
    entries = [
      makeEntry('abc', 'improve-code', '/home/user/repo-a'),
      makeEntry('def', 'security-audit', '/home/user/repo-b'),
      makeEntry('ghi', 'improve-code', '/home/user/repo-b'),
    ];
  });

  it('returns all results when no filters applied', () => {
    const result = filterResults(entries, {});
    expect(result).toHaveLength(3);
  });

  it('filters by repo path', () => {
    const result = filterResults(entries, { repo: '/home/user/repo-b' });
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.frontmatter.repo === '/home/user/repo-b')).toBe(true);
  });

  it('filters by template name', () => {
    const result = filterResults(entries, { template: 'improve-code' });
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.frontmatter.template === 'improve-code')).toBe(true);
  });

  it('filters by both repo and template', () => {
    const result = filterResults(entries, {
      repo: '/home/user/repo-b',
      template: 'improve-code',
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.frontmatter.task_id).toBe('ghi');
  });

  it('template filter is case-insensitive', () => {
    const result = filterResults(entries, { template: 'IMPROVE-CODE' });
    expect(result).toHaveLength(2);
  });

  it('normalizes trailing slashes in repo filter', () => {
    const result = filterResults(entries, { repo: '/home/user/repo-a/' });
    expect(result).toHaveLength(1);
    expect(result[0]!.frontmatter.task_id).toBe('abc');
  });
});

// ---------------------------------------------------------------------------
// findResultByTaskId tests
// ---------------------------------------------------------------------------

describe('findResultByTaskId', () => {
  const makeEntry = (taskId: string): ResultEntry => ({
    frontmatter: {
      task_id: taskId,
      template: 'improve-code',
      repo: '/repo',
      dispatched_at: '2026-03-04T10:00:00.000Z',
      completed_at: '2026-03-04T10:30:00.000Z',
      exit_code: 0,
      branch: null,
    },
    filePath: '/repo/.scrow/file.md',
    rawContent: 'content',
  });

  // Each test creates its own fresh entries array to avoid shared mutable state.
  let entries: ResultEntry[];

  beforeEach(() => {
    entries = [makeEntry('abc1234'), makeEntry('def5678'), makeEntry('ghi9012')];
  });

  it('finds matching result by full task ID', () => {
    const result = findResultByTaskId(entries, 'abc1234');
    expect(result).not.toBeNull();
    expect(result!.frontmatter.task_id).toBe('abc1234');
  });

  it('finds matching result by prefix', () => {
    const result = findResultByTaskId(entries, 'def');
    expect(result).not.toBeNull();
    expect(result!.frontmatter.task_id).toBe('def5678');
  });

  it('returns null for unknown task ID', () => {
    const result = findResultByTaskId(entries, 'zzz');
    expect(result).toBeNull();
  });

  it('is case-insensitive', () => {
    const result = findResultByTaskId(entries, 'ABC1234');
    expect(result).not.toBeNull();
    expect(result!.frontmatter.task_id).toBe('abc1234');
  });

  it('returns null for empty entries', () => {
    const result = findResultByTaskId([], 'abc');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getLatestResult tests
// ---------------------------------------------------------------------------

describe('getLatestResult', () => {
  it('returns first entry (most recent) from sorted results', () => {
    const entries: ResultEntry[] = [
      {
        frontmatter: {
          task_id: 'latest',
          template: 'improve-code',
          repo: '/repo',
          dispatched_at: '2026-03-04T10:00:00.000Z',
          completed_at: '2026-03-04T11:00:00.000Z',
          exit_code: 0,
          branch: null,
        },
        filePath: '/repo/.scrow/latest.md',
        rawContent: 'latest content',
      },
      {
        frontmatter: {
          task_id: 'older',
          template: 'improve-code',
          repo: '/repo',
          dispatched_at: '2026-03-04T09:00:00.000Z',
          completed_at: '2026-03-04T10:00:00.000Z',
          exit_code: 0,
          branch: null,
        },
        filePath: '/repo/.scrow/older.md',
        rawContent: 'older content',
      },
    ];

    const result = getLatestResult(entries);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.task_id).toBe('latest');
  });

  it('returns null for empty results', () => {
    const result = getLatestResult([]);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// toRelativeHomePath tests
// ---------------------------------------------------------------------------

describe('toRelativeHomePath', () => {
  it('converts home-prefixed path to ~/ path', () => {
    const home = process.env['HOME'] ?? '/home/user';
    const result = toRelativeHomePath(`${home}/my-repo/.scrow/file.md`);
    expect(result).toMatch(/^~\//);
    expect(result).toContain('my-repo/.scrow/file.md');
  });

  it('returns absolute path when not under $HOME', () => {
    const result = toRelativeHomePath('/tmp/some-repo/.scrow/file.md');
    expect(result).toBe('/tmp/some-repo/.scrow/file.md');
  });
});

// ---------------------------------------------------------------------------
// readActionCompanion tests (Story 17.5 Task 11)
// ---------------------------------------------------------------------------

describe('readActionCompanion', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), 'companion-test-' + randomBytes(6).toString('hex'));
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns parsed result on valid companion file', async () => {
    const resultFilePath = join(tmpDir, '2026-03-09T10-00-00Z-fix-bugs-abc1234.md');
    const companionPath = join(tmpDir, '2026-03-09T10-00-00Z-fix-bugs-abc1234.actions.json');
    const validCompanion = {
      task_id: 'task-abc',
      source: 'parsed',
      actions_requested: 1,
      actions_executed: 1,
      actions_failed: 0,
      actions_skipped: 0,
      results: [{ type: 'git-push', status: 'success', url: null, error: null, reason: null }],
    };
    await writeFile(companionPath, JSON.stringify(validCompanion), 'utf-8');
    const result = await readActionCompanion(resultFilePath);
    expect(result).not.toBeNull();
    expect(result?.task_id).toBe('task-abc');
    expect(result?.source).toBe('parsed');
  });

  it('returns null when companion file does not exist', async () => {
    const resultFilePath = join(tmpDir, 'nonexistent.md');
    const result = await readActionCompanion(resultFilePath);
    expect(result).toBeNull();
  });

  it('returns null on malformed JSON', async () => {
    const resultFilePath = join(tmpDir, 'result.md');
    const companionPath = join(tmpDir, 'result.actions.json');
    await writeFile(companionPath, 'not valid json {{{', 'utf-8');
    const result = await readActionCompanion(resultFilePath);
    expect(result).toBeNull();
  });

  it('returns null on valid JSON with wrong shape (missing required fields)', async () => {
    const resultFilePath = join(tmpDir, 'result.md');
    const companionPath = join(tmpDir, 'result.actions.json');
    // Missing actions_requested, actions_executed, etc.
    const wrongShape = { task_id: 'x', source: 'parsed' };
    await writeFile(companionPath, JSON.stringify(wrongShape), 'utf-8');
    const result = await readActionCompanion(resultFilePath);
    expect(result).toBeNull();
  });

  it('returns null when source field is invalid value', async () => {
    const resultFilePath = join(tmpDir, 'result.md');
    const companionPath = join(tmpDir, 'result.actions.json');
    const invalidSource = {
      task_id: 'x',
      source: 'unknown-source', // not 'parsed' | 'inferred'
      actions_requested: 0,
      actions_executed: 0,
      actions_failed: 0,
      actions_skipped: 0,
      results: [],
    };
    await writeFile(companionPath, JSON.stringify(invalidSource), 'utf-8');
    const result = await readActionCompanion(resultFilePath);
    expect(result).toBeNull();
  });
});
