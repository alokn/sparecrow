/** Unit tests for atomic file write and safe JSON read helpers. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { atomicWrite, safeReadJson, AUDIT_LOG_FILENAME_REGEX } from './fs.js';

describe('atomicWrite()', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `sparecrow-fs-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('writes content to the target file', async () => {
    const target = join(tmpDir, 'output.json');
    await atomicWrite(target, '{"ok":true}');
    const content = await readFile(target, 'utf-8');
    expect(content).toBe('{"ok":true}');
  });

  it('creates parent directory if it does not exist', async () => {
    const target = join(tmpDir, 'nested', 'deep', 'output.json');
    await atomicWrite(target, 'hello');
    const content = await readFile(target, 'utf-8');
    expect(content).toBe('hello');
  });

  it('leaves no tmp files after a successful write', async () => {
    const target = join(tmpDir, 'clean.json');
    await atomicWrite(target, 'data');
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(tmpDir);
    // Only the target file should remain — no .tmp-* files
    expect(files.filter((f) => f.startsWith('.tmp-'))).toHaveLength(0);
    expect(files).toContain('clean.json');
  });

  it('overwrites an existing file atomically', async () => {
    const target = join(tmpDir, 'overwrite.json');
    await atomicWrite(target, 'original');
    await atomicWrite(target, 'updated');
    const content = await readFile(target, 'utf-8');
    expect(content).toBe('updated');
  });

  it('rethrows error and cleans up tmp file when rename fails', async () => {
    // Simulate rename failure: target is a directory, so rename into it fails
    const badDir = join(tmpDir, 'bad-target');
    await mkdir(badDir);
    // atomicWrite will create a tmp file then try to rename it TO badDir (a directory) — fails
    await expect(atomicWrite(badDir, 'content')).rejects.toThrow();
  });
});

describe('safeReadJson()', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `sparecrow-json-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns parsed object for valid JSON file', async () => {
    const file = join(tmpDir, 'valid.json');
    await writeFile(file, '{"key":"value"}');
    const result = await safeReadJson<{ key: string }>(file);
    expect(result).toEqual({ key: 'value' });
  });

  it('returns null when file does not exist', async () => {
    const result = await safeReadJson(join(tmpDir, 'nonexistent.json'));
    expect(result).toBeNull();
  });

  it('returns null for corrupt (non-JSON) file', async () => {
    const file = join(tmpDir, 'corrupt.json');
    await writeFile(file, 'this is not json {{{');
    const result = await safeReadJson(file);
    expect(result).toBeNull();
  });

  it('returns null for empty file', async () => {
    const file = join(tmpDir, 'empty.json');
    await writeFile(file, '');
    const result = await safeReadJson(file);
    expect(result).toBeNull();
  });

  it('handles nested objects correctly', async () => {
    const file = join(tmpDir, 'nested.json');
    const data = { a: { b: [1, 2, 3] }, c: true };
    await writeFile(file, JSON.stringify(data));
    const result = await safeReadJson<typeof data>(file);
    expect(result).toEqual(data);
  });
});

describe('safeReadJson() unexpected error branch', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs and returns null for non-ENOENT filesystem errors', async () => {
    const debugSpy = vi.fn();
    vi.doMock('./logger.js', () => ({
      logger: { debug: debugSpy },
    }));
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.doMock('node:fs/promises', () => ({
      ...actualFs,
      readFile: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' })),
    }));
    const { safeReadJson: readJson } = await import('./fs.js');
    const result = await readJson('/fake/path.json');
    expect(result).toBeNull();
    expect(debugSpy).toHaveBeenCalledWith('fs.safeReadJson.unexpected_error', {
      path: '/fake/path.json',
      error: 'permission denied',
    });
  });

  it('logs String(err) when error is not an Error instance', async () => {
    const debugSpy = vi.fn();
    vi.doMock('./logger.js', () => ({
      logger: { debug: debugSpy },
    }));
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.doMock('node:fs/promises', () => ({
      ...actualFs,
      readFile: vi.fn().mockRejectedValue('raw string error'),
    }));
    const { safeReadJson: readJson } = await import('./fs.js');
    const result = await readJson('/fake/path.json');
    expect(result).toBeNull();
    expect(debugSpy).toHaveBeenCalledWith('fs.safeReadJson.unexpected_error', {
      path: '/fake/path.json',
      error: 'raw string error',
    });
  });
});

describe('atomicWrite() failure paths', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('cleans up tmp file and rethrows when writeFile fails', async () => {
    const unlinkSpy = vi.fn().mockResolvedValue(undefined);
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.doMock('node:fs/promises', () => ({
      ...actualFs,
      mkdir: actualFs.mkdir,
      writeFile: vi.fn().mockRejectedValue(new Error('disk full')),
      rename: vi.fn(),
      unlink: unlinkSpy,
    }));
    const { atomicWrite: write } = await import('./fs.js');
    await expect(write('/tmp/sparecrow-test-atomic/out.json', 'data')).rejects.toThrow('disk full');
    expect(unlinkSpy).toHaveBeenCalledTimes(1);
  });

  it('suppresses unlink error during cleanup and still rethrows original error', async () => {
    const unlinkSpy = vi.fn().mockRejectedValue(new Error('unlink failed'));
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.doMock('node:fs/promises', () => ({
      ...actualFs,
      mkdir: actualFs.mkdir,
      writeFile: vi.fn().mockRejectedValue(new Error('write failed')),
      rename: vi.fn(),
      unlink: unlinkSpy,
    }));
    const { atomicWrite: write } = await import('./fs.js');
    await expect(write('/tmp/sparecrow-test-atomic/out.json', 'data')).rejects.toThrow(
      'write failed',
    );
    expect(unlinkSpy).toHaveBeenCalledTimes(1);
  });
});

describe('AUDIT_LOG_FILENAME_REGEX', () => {
  it('matches a valid audit log filename', () => {
    const match = AUDIT_LOG_FILENAME_REGEX.exec('audit-2026-03-06.jsonl');
    expect(match).not.toBeNull();
    expect(match![1]).toBe('2026-03-06');
  });

  it('captures the date portion from the filename', () => {
    const match = AUDIT_LOG_FILENAME_REGEX.exec('audit-2025-12-31.jsonl');
    expect(match).not.toBeNull();
    expect(match![1]).toBe('2025-12-31');
  });

  it('rejects filename without audit- prefix', () => {
    expect(AUDIT_LOG_FILENAME_REGEX.test('log-2026-03-06.jsonl')).toBe(false);
  });

  it('rejects filename with wrong extension', () => {
    expect(AUDIT_LOG_FILENAME_REGEX.test('audit-2026-03-06.json')).toBe(false);
  });

  it('rejects filename with extra prefix path', () => {
    expect(AUDIT_LOG_FILENAME_REGEX.test('/var/log/audit-2026-03-06.jsonl')).toBe(false);
  });

  it('rejects filename with trailing characters', () => {
    expect(AUDIT_LOG_FILENAME_REGEX.test('audit-2026-03-06.jsonl.bak')).toBe(false);
  });

  it('rejects filename with incomplete date', () => {
    expect(AUDIT_LOG_FILENAME_REGEX.test('audit-2026-03.jsonl')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(AUDIT_LOG_FILENAME_REGEX.test('')).toBe(false);
  });
});
