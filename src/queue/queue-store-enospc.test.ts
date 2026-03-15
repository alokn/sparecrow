/** ENOSPC and EACCES filesystem error tests for QueueStore atomic writes. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { TaskDefinition } from '../types/index.js';

function makeTmpDir(): string {
  return join(tmpdir(), `sparecrow-enospc-test-${randomBytes(6).toString('hex')}`);
}

function makeTask(overrides?: Partial<TaskDefinition>): TaskDefinition {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Test Task',
    type: 'template',
    templateName: 'improve-code',
    status: 'pending',
    prompt: '',
    targetPath: '/some/repo',
    priority: 1,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    timeoutMs: 3600000,
    actions: [],
    ...overrides,
  };
}

function makeEnospcError(message = 'ENOSPC: no space left on device'): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code: 'ENOSPC' });
}

function makeEaccesError(message = 'EACCES: permission denied'): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code: 'EACCES' });
}

describe('QueueStore ENOSPC handling (AC1, AC6)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws QUEUE_WRITE_FAILED when writeFile fails with ENOSPC and preserves original queue.json', async () => {
    const dataDir = makeTmpDir();
    await mkdir(dataDir, { recursive: true });

    try {
      // Write a valid queue.json first using real fs
      const originalContent = JSON.stringify({ version: 1, tasks: [], paused: false }, null, 2);
      await writeFile(join(dataDir, 'queue.json'), originalContent, 'utf-8');

      // Now mock fs to inject ENOSPC on writeFile
      const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      const unlinkSpy = vi.fn().mockResolvedValue(undefined);
      vi.doMock('node:fs/promises', () => ({
        ...actualFs,
        writeFile: vi.fn().mockRejectedValue(makeEnospcError()),
        unlink: unlinkSpy,
        // Keep real mkdir and rename
        mkdir: actualFs.mkdir,
        rename: actualFs.rename,
        readFile: actualFs.readFile,
      }));

      const { QueueStore } = await import('./queue-store.js');
      const store = new QueueStore(dataDir);

      // Attempt write — should throw QUEUE_WRITE_FAILED
      await expect(store.write({ tasks: [makeTask()], paused: false })).rejects.toMatchObject({
        code: 'QUEUE_WRITE_FAILED',
      });

      // AC1: Original queue.json content must be unchanged
      const preserved = await readFile(join(dataDir, 'queue.json'), 'utf-8');
      expect(preserved).toBe(originalContent);

      // AC6: unlink was called to clean up orphaned tmp file
      expect(unlinkSpy).toHaveBeenCalledTimes(1);
      const unlinkPath = unlinkSpy.mock.calls[0]![0] as string;
      expect(unlinkPath).toContain('.tmp-queue-');
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('throws QUEUE_WRITE_FAILED when rename fails with ENOSPC and cleans up tmp file', async () => {
    const dataDir = makeTmpDir();
    await mkdir(dataDir, { recursive: true });

    try {
      const originalContent = JSON.stringify({ version: 1, tasks: [], paused: false }, null, 2);
      await writeFile(join(dataDir, 'queue.json'), originalContent, 'utf-8');

      const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      const unlinkSpy = vi.fn().mockResolvedValue(undefined);
      vi.doMock('node:fs/promises', () => ({
        ...actualFs,
        writeFile: actualFs.writeFile,
        rename: vi.fn().mockRejectedValue(makeEnospcError()),
        unlink: unlinkSpy,
        mkdir: actualFs.mkdir,
        readFile: actualFs.readFile,
      }));

      const { QueueStore } = await import('./queue-store.js');
      const store = new QueueStore(dataDir);

      await expect(store.write({ tasks: [makeTask()], paused: false })).rejects.toMatchObject({
        code: 'QUEUE_WRITE_FAILED',
      });

      // AC1: Original content preserved
      const preserved = await readFile(join(dataDir, 'queue.json'), 'utf-8');
      expect(preserved).toBe(originalContent);

      // AC6: Orphaned tmp file cleaned up
      expect(unlinkSpy).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('leaves no orphaned .tmp files after ENOSPC on real filesystem', async () => {
    const dataDir = makeTmpDir();
    await mkdir(dataDir, { recursive: true });

    try {
      // Write valid queue.json
      await writeFile(
        join(dataDir, 'queue.json'),
        JSON.stringify({ version: 1, tasks: [], paused: false }),
        'utf-8',
      );

      const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      vi.doMock('node:fs/promises', () => ({
        ...actualFs,
        writeFile: vi.fn().mockRejectedValue(makeEnospcError()),
        // Use real unlink so the cleanup actually happens
        unlink: actualFs.unlink,
        mkdir: actualFs.mkdir,
        rename: actualFs.rename,
        readFile: actualFs.readFile,
      }));

      const { QueueStore } = await import('./queue-store.js');
      const store = new QueueStore(dataDir);

      // AC6: Assert that write() rejects (not just swallow the error silently)
      await expect(store.write({ tasks: [], paused: false })).rejects.toMatchObject({
        code: 'QUEUE_WRITE_FAILED',
      });

      // AC6: No .tmp files left behind after the error and cleanup
      const files = await readdir(dataDir);
      const tmpFiles = files.filter((f) => f.startsWith('.tmp-'));
      expect(tmpFiles).toHaveLength(0);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe('QueueStore EACCES handling (AC5)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws QUEUE_WRITE_FAILED when writeFile fails with EACCES', async () => {
    const dataDir = makeTmpDir();
    await mkdir(dataDir, { recursive: true });

    try {
      const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      vi.doMock('node:fs/promises', () => ({
        ...actualFs,
        writeFile: vi.fn().mockRejectedValue(makeEaccesError()),
        unlink: vi.fn().mockResolvedValue(undefined),
        mkdir: actualFs.mkdir,
        rename: actualFs.rename,
        readFile: actualFs.readFile,
      }));

      const { QueueStore } = await import('./queue-store.js');
      const store = new QueueStore(dataDir);

      await expect(store.write({ tasks: [], paused: false })).rejects.toMatchObject({
        code: 'QUEUE_WRITE_FAILED',
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
