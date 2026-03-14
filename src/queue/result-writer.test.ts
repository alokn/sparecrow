/** Tests for result-writer — .scrow/ result artifact file persistence. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { TaskDefinition, TaskResult } from '../types/index.js';
import { EventName } from '../types/index.js';

vi.mock('../utils/index.js', () => ({
  atomicWrite: vi.fn(async (filePath: string, content: string) => {
    const { writeFile, mkdir: mkdirFn } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdirFn(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, { encoding: 'utf-8', mode: 0o600 });
  }),
  logger: {
    debug: vi.fn().mockResolvedValue(undefined),
    info: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
  },
}));

import {
  formatTimestamp,
  buildFilename,
  buildFrontmatter,
  buildResultContent,
  ensureGitignore,
  writeResultArtifact,
  formatDispatchNotification,
  toRelativePath,
  SCROW_DIR,
} from './result-writer.js';
import type { ResultArtifactInput } from './result-writer.js';

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
    stdout: 'Review complete. Found 3 issues.',
    stderr: '',
    exitCode: 0,
    error: null,
    errorCode: null,
    ...overrides,
  };
}

function makeInput(overrides: Partial<ResultArtifactInput> = {}): ResultArtifactInput {
  return {
    task: makeTask(),
    result: makeResult(),
    branch: null,
    ...overrides,
  };
}

describe('formatTimestamp', () => {
  it('converts ISO timestamp to hyphenated format', () => {
    const date = new Date('2026-03-04T14:30:00.000Z');
    expect(formatTimestamp(date)).toBe('2026-03-04T14-30-00Z');
  });

  it('handles midnight timestamps', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    expect(formatTimestamp(date)).toBe('2026-01-01T00-00-00Z');
  });

  it('removes milliseconds from timestamp', () => {
    const date = new Date('2026-03-04T14:30:45.123Z');
    expect(formatTimestamp(date)).toBe('2026-03-04T14-30-45Z');
  });
});

describe('buildFilename', () => {
  it('generates correct filename format', () => {
    const completedAt = new Date('2026-03-04T14:30:00.000Z');
    const result = buildFilename(
      completedAt,
      'improve-code',
      'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    );
    expect(result).toBe('2026-03-04T14-30-00Z-improve-code-a1b2c3d.md');
  });

  it('uses first 7 characters of task ID', () => {
    const completedAt = new Date('2026-03-04T14:30:00.000Z');
    const result = buildFilename(completedAt, 'fix-bugs', 'abcdefg-1234-5678-9012-hijklmnopqrs');
    expect(result).toBe('2026-03-04T14-30-00Z-fix-bugs-abcdefg.md');
  });

  it('handles short template slugs', () => {
    const completedAt = new Date('2026-03-04T14:30:00.000Z');
    const result = buildFilename(completedAt, 'a', '1234567890');
    expect(result).toBe('2026-03-04T14-30-00Z-a-1234567.md');
  });
});

describe('buildFrontmatter', () => {
  it('includes all 7 required fields', () => {
    const input = makeInput();
    const fm = buildFrontmatter(input);

    expect(fm).toContain('task_id: "a1b2c3d"');
    expect(fm).toContain('template: "improve-code"');
    expect(fm).toContain('repo: "/tmp/test-repo"');
    expect(fm).toContain('dispatched_at: "2026-03-04T10:00:00.000Z"');
    expect(fm).toContain('completed_at: "2026-03-04T14:30:00.000Z"');
    expect(fm).toContain('exit_code: 0');
    expect(fm).toContain('branch: null');
  });

  it('wraps in YAML frontmatter delimiters', () => {
    const input = makeInput();
    const fm = buildFrontmatter(input);
    expect(fm).toMatch(/^---\n/);
    expect(fm).toMatch(/\n---$/);
  });

  it('renders branch as quoted string when present', () => {
    const input = makeInput({ branch: 'sparecrow/improve-code-20260304T143000Z' });
    const fm = buildFrontmatter(input);
    expect(fm).toContain('branch: "sparecrow/improve-code-20260304T143000Z"');
  });

  it('renders branch as null when absent', () => {
    const input = makeInput({ branch: null });
    const fm = buildFrontmatter(input);
    expect(fm).toContain('branch: null');
  });

  it('uses task name when templateName is not set', () => {
    const base = makeTask({ name: 'custom-task' });
    delete (base as unknown as Record<string, unknown>).templateName;
    const input = makeInput({ task: base });
    const fm = buildFrontmatter(input);
    expect(fm).toContain('template: "custom-task"');
  });

  it('uses exit_code 1 when exitCode is null', () => {
    const result = makeResult({ exitCode: null });
    const input = makeInput({ result });
    const fm = buildFrontmatter(input);
    expect(fm).toContain('exit_code: 1');
  });

  it('reflects failure exit code', () => {
    const result = makeResult({ exitCode: 137, status: 'failed' });
    const input = makeInput({ result });
    const fm = buildFrontmatter(input);
    expect(fm).toContain('exit_code: 137');
  });
});

describe('buildResultContent', () => {
  it('combines frontmatter with raw stdout body', () => {
    const input = makeInput();
    const content = buildResultContent(input);
    expect(content).toContain('---\n');
    expect(content).toContain('Review complete. Found 3 issues.');
  });

  it('separates frontmatter from body with blank line', () => {
    const input = makeInput();
    const content = buildResultContent(input);
    expect(content).toContain('---\n\n');
  });

  it('handles empty stdout', () => {
    const result = makeResult({ stdout: '' });
    const input = makeInput({ result });
    const content = buildResultContent(input);
    expect(content).toMatch(/---\n\n$/);
  });
});

describe('ensureGitignore', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), 'sparecrow-gitignore-' + randomBytes(6).toString('hex'));
    await mkdir(tmpDir, { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('creates new .gitignore with .scrow/ when none exists', async () => {
    const updated = await ensureGitignore(tmpDir);
    expect(updated).toBe(true);

    const content = await readFile(join(tmpDir, '.gitignore'), 'utf-8');
    expect(content).toBe('.scrow/\n');
  });

  it('appends .scrow/ to existing .gitignore without it', async () => {
    await writeFile(join(tmpDir, '.gitignore'), 'node_modules/\n.env\n', 'utf-8');

    const updated = await ensureGitignore(tmpDir);
    expect(updated).toBe(true);

    const content = await readFile(join(tmpDir, '.gitignore'), 'utf-8');
    expect(content).toBe('node_modules/\n.env\n.scrow/\n');
  });

  it('appends with preceding newline when file lacks trailing newline', async () => {
    await writeFile(join(tmpDir, '.gitignore'), 'node_modules/', 'utf-8');

    const updated = await ensureGitignore(tmpDir);
    expect(updated).toBe(true);

    const content = await readFile(join(tmpDir, '.gitignore'), 'utf-8');
    expect(content).toBe('node_modules/\n.scrow/\n');
  });

  it('skips when .scrow/ is already present', async () => {
    await writeFile(join(tmpDir, '.gitignore'), 'node_modules/\n.scrow/\n', 'utf-8');

    const updated = await ensureGitignore(tmpDir);
    expect(updated).toBe(false);

    const content = await readFile(join(tmpDir, '.gitignore'), 'utf-8');
    expect(content).toBe('node_modules/\n.scrow/\n');
  });

  it('skips when .scrow (without trailing slash) is already present', async () => {
    await writeFile(join(tmpDir, '.gitignore'), 'node_modules/\n.scrow\n', 'utf-8');

    const updated = await ensureGitignore(tmpDir);
    expect(updated).toBe(false);
  });

  it('skips when .scrow/ is present with surrounding whitespace', async () => {
    await writeFile(join(tmpDir, '.gitignore'), 'node_modules/\n  .scrow/  \n', 'utf-8');

    const updated = await ensureGitignore(tmpDir);
    expect(updated).toBe(false);
  });

  it('logs info with action=created when .gitignore is created', async () => {
    const { logger: mockLogger } = await import('../utils/index.js');

    await ensureGitignore(tmpDir);

    expect(mockLogger.info).toHaveBeenCalledWith('result-writer.gitignore-updated', {
      repoPath: tmpDir,
      action: 'created',
    });
  });

  it('logs info with action=appended when .scrow/ is appended to existing .gitignore', async () => {
    const { logger: mockLogger } = await import('../utils/index.js');
    await writeFile(join(tmpDir, '.gitignore'), 'node_modules/\n', 'utf-8');

    await ensureGitignore(tmpDir);

    expect(mockLogger.info).toHaveBeenCalledWith('result-writer.gitignore-updated', {
      repoPath: tmpDir,
      action: 'appended',
    });
  });
});

describe('toRelativePath', () => {
  it('converts path under $HOME to tilde-relative', () => {
    const home = homedir();
    const absPath = join(home, 'projects', 'my-repo', '.scrow', 'result.md');
    expect(toRelativePath(absPath)).toBe('~/projects/my-repo/.scrow/result.md');
  });

  it('returns absolute path when outside $HOME', () => {
    const absPath = '/opt/system/repo/.scrow/result.md';
    expect(toRelativePath(absPath)).toBe('/opt/system/repo/.scrow/result.md');
  });
});

describe('formatDispatchNotification', () => {
  it('formats active template success notification', () => {
    const input = makeInput({ branch: 'sparecrow/improve-code-20260304T143000Z' });
    const notification = formatDispatchNotification(input, '/home/user/repo/.scrow/result.md');
    expect(notification).toContain('\u2713 improve-code complete');
    expect(notification).toContain('branch sparecrow/improve-code-20260304T143000Z');
    expect(notification).toContain('Results \u2192');
  });

  it('formats passive template success notification', () => {
    const input = makeInput({ branch: null });
    const notification = formatDispatchNotification(input, '/home/user/repo/.scrow/result.md');
    expect(notification).toContain('\u2713 improve-code complete');
    expect(notification).toContain('report only, no code changes made');
    expect(notification).toContain('Results \u2192');
  });

  it('formats failure notification', () => {
    const result = makeResult({ status: 'failed', exitCode: 1 });
    const input = makeInput({ result });
    const notification = formatDispatchNotification(input, '/home/user/repo/.scrow/result.md');
    expect(notification).toContain('\u2717 improve-code failed (exit 1)');
    expect(notification).toContain('Results \u2192');
  });

  it('uses exit code 1 when exitCode is null on failure', () => {
    const result = makeResult({ status: 'failed', exitCode: null });
    const input = makeInput({ result });
    const notification = formatDispatchNotification(input, '/home/user/repo/.scrow/result.md');
    expect(notification).toContain('failed (exit 1)');
  });

  it('uses task name when templateName is not set', () => {
    const base = makeTask({ name: 'my-custom-task' });
    delete (base as unknown as Record<string, unknown>).templateName;
    const input = makeInput({ task: base });
    const notification = formatDispatchNotification(input, '/tmp/result.md');
    expect(notification).toContain('my-custom-task complete');
  });
});

describe('writeResultArtifact', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), 'sparecrow-result-' + randomBytes(6).toString('hex'));
    await mkdir(tmpDir, { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('creates .scrow/ directory if missing', async () => {
    const task = makeTask({ targetPath: tmpDir });
    const input = makeInput({ task });

    await writeResultArtifact(input);

    // Verify .scrow/ dir was created
    await expect(access(join(tmpDir, SCROW_DIR))).resolves.toBeUndefined();
  });

  it('writes result file on task success', async () => {
    const task = makeTask({ targetPath: tmpDir });
    const result = makeResult({ exitCode: 0, status: 'done' });
    const input = makeInput({ task, result });

    const output = await writeResultArtifact(input);

    expect(output).not.toBeNull();
    expect(output!.filePath).toContain(SCROW_DIR);
    expect(output!.filePath).toMatch(/\.md$/);

    const content = await readFile(output!.filePath, 'utf-8');
    expect(content).toContain('---');
    expect(content).toContain('task_id: "a1b2c3d"');
    expect(content).toContain('exit_code: 0');
    expect(content).toContain('Review complete. Found 3 issues.');
  });

  it('writes result file on task failure (AC3)', async () => {
    const task = makeTask({ targetPath: tmpDir });
    const result = makeResult({
      status: 'failed',
      exitCode: 1,
      stdout: 'Partial output before failure',
    });
    const input = makeInput({ task, result });

    const output = await writeResultArtifact(input);

    expect(output).not.toBeNull();

    const content = await readFile(output!.filePath, 'utf-8');
    expect(content).toContain('exit_code: 1');
    expect(content).toContain('Partial output before failure');
  });

  it('creates .gitignore when none exists (AC4)', async () => {
    const task = makeTask({ targetPath: tmpDir });
    const input = makeInput({ task });

    await writeResultArtifact(input);

    const gitignore = await readFile(join(tmpDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.scrow/');
  });

  it('does not duplicate .scrow/ in existing .gitignore (AC4)', async () => {
    await writeFile(join(tmpDir, '.gitignore'), 'node_modules/\n.scrow/\n', 'utf-8');
    const task = makeTask({ targetPath: tmpDir });
    const input = makeInput({ task });

    await writeResultArtifact(input);

    const gitignore = await readFile(join(tmpDir, '.gitignore'), 'utf-8');
    const matches = gitignore.split('.scrow/').length - 1;
    expect(matches).toBe(1);
  });

  it('generates correct filename format (AC1)', async () => {
    const task = makeTask({ targetPath: tmpDir });
    const result = makeResult({
      completedAt: new Date('2026-03-04T14:30:00.000Z'),
    });
    const input = makeInput({ task, result });

    const output = await writeResultArtifact(input);

    expect(output).not.toBeNull();
    const filename = output!.filePath.split('/').pop();
    expect(filename).toBe('2026-03-04T14-30-00Z-improve-code-a1b2c3d.md');
  });

  it('includes all 7 frontmatter fields (AC2)', async () => {
    const task = makeTask({ targetPath: tmpDir });
    const input = makeInput({ task, branch: 'sparecrow/improve-code-20260304' });

    const output = await writeResultArtifact(input);
    expect(output).not.toBeNull();

    const content = await readFile(output!.filePath, 'utf-8');
    expect(content).toContain('task_id:');
    expect(content).toContain('template:');
    expect(content).toContain('repo:');
    expect(content).toContain('dispatched_at:');
    expect(content).toContain('completed_at:');
    expect(content).toContain('exit_code:');
    expect(content).toContain('branch:');
  });

  it('logs to audit log after writing (AC5)', async () => {
    const { logger: mockLogger } = await import('../utils/index.js');
    const task = makeTask({ targetPath: tmpDir });
    const input = makeInput({ task });

    await writeResultArtifact(input);

    expect(mockLogger.info).toHaveBeenCalledWith(
      EventName.RESULT_ARTIFACT_WRITTEN,
      expect.objectContaining({
        taskId: task.id,
        templateName: 'improve-code',
        repoPath: tmpDir,
      }),
    );
  });

  it('writes notification to stdout when TTY is attached (AC5)', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    try {
      const task = makeTask({ targetPath: tmpDir });
      const input = makeInput({ task });

      await writeResultArtifact(input);

      expect(writeSpy).toHaveBeenCalledOnce();
      const firstCall = writeSpy.mock.calls[0];
      expect(firstCall).toBeDefined();
      const writtenArg = firstCall![0] as string;
      expect(writtenArg).toContain('improve-code complete');
      expect(writtenArg).toContain('Results →');
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', {
        value: originalIsTTY,
        configurable: true,
      });
      writeSpy.mockRestore();
    }
  });

  it('does not write to stdout when TTY is not attached (AC5)', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

    try {
      const task = makeTask({ targetPath: tmpDir });
      const input = makeInput({ task });

      await writeResultArtifact(input);

      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
      writeSpy.mockRestore();
    }
  });

  it('returns null and logs warning on write failure (non-fatal)', async () => {
    const { logger: mockLogger } = await import('../utils/index.js');
    // Use a path that will fail — a file rather than a directory
    const badPath = join(tmpDir, 'not-a-directory-file.txt');
    await writeFile(badPath, 'content', 'utf-8');
    // Now try to use it as a repo path — mkdir will work since it uses recursive,
    // but we create a scenario where the .scrow path is actually a file
    await mkdir(join(tmpDir, 'broken-repo'), { recursive: true });
    // Create a file named .scrow to prevent mkdir .scrow/ from working
    await writeFile(join(tmpDir, 'broken-repo', SCROW_DIR), 'block', 'utf-8');

    const task = makeTask({ targetPath: join(tmpDir, 'broken-repo') });
    const input = makeInput({ task });

    const output = await writeResultArtifact(input);
    expect(output).toBeNull();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      'RESULT_WRITE_FAILED',
      expect.objectContaining({
        taskId: task.id,
      }),
    );
  });

  it('uses custom task name when no templateName set', async () => {
    const task = makeTask({
      targetPath: tmpDir,
      name: 'custom-prompt-task',
      type: 'custom',
    });
    delete (task as unknown as Record<string, unknown>).templateName;
    const input = makeInput({ task });

    const output = await writeResultArtifact(input);
    expect(output).not.toBeNull();

    const content = await readFile(output!.filePath, 'utf-8');
    expect(content).toContain('template: "custom-prompt-task"');

    const filename = output!.filePath.split('/').pop();
    expect(filename).toContain('custom-prompt-task');
  });
});
