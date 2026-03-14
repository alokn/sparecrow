/** Unit tests for repository path validation helper. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

describe('validateRepository()', () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = join(tmpdir(), 'repo-val-' + randomBytes(6).toString('hex'));
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns valid=true for a real git repository', async () => {
    const { validateRepository } = await import('./repo-validation.js');
    // The test worktree root itself is a git repo
    const result = await validateRepository(process.cwd());
    expect(result.valid).toBe(true);
    expect(result.error).toBeNull();
    expect(result.absolutePath).toBeTruthy();
  });

  it('returns valid=false with "Path does not exist" for non-existent path', async () => {
    const { validateRepository } = await import('./repo-validation.js');
    const result = await validateRepository(join(tempDir, 'does-not-exist'));
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Path does not exist');
  });

  it('returns valid=false with "Path is not a directory" for a file', async () => {
    const filePath = join(tempDir, 'file.txt');
    await writeFile(filePath, 'content');
    const { validateRepository } = await import('./repo-validation.js');
    const result = await validateRepository(filePath);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Path is not a directory');
  });

  it('returns valid=false with "Not a git repository" for a non-git directory', async () => {
    const { validateRepository } = await import('./repo-validation.js');
    const result = await validateRepository(tempDir);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Not a git repository');
  });

  it('normalizes path to absolute', async () => {
    const { validateRepository } = await import('./repo-validation.js');
    const result = await validateRepository('.');
    expect(result.absolutePath).toBe(process.cwd());
  });

  it('returns valid=false when git binary is not found', async () => {
    vi.doMock('./process.js', () => ({
      spawnWithGuardrails: vi.fn().mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: null,
        timedOut: false,
        aborted: false,
        enoent: true,
      }),
    }));
    const { validateRepository } = await import('./repo-validation.js');
    const result = await validateRepository(tempDir);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('git is not installed or not in PATH');
  });

  it('returns valid=false when git check times out', async () => {
    vi.doMock('./process.js', () => ({
      spawnWithGuardrails: vi.fn().mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: null,
        timedOut: true,
        aborted: false,
        enoent: false,
      }),
    }));
    const { validateRepository } = await import('./repo-validation.js');
    const result = await validateRepository(tempDir);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('timed out');
  });
});
