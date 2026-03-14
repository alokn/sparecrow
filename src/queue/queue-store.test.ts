/** Unit tests for QueueStore — atomic writes, zod validation, and corruption recovery. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, readFile, readdir, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { TaskDefinition } from '../types/index.js';
import { QueueStore, DEFAULT_TIMEOUT_MS } from './queue-store.js';

function makeTmpDir(): string {
  return join(tmpdir(), `sparecrow-queue-store-test-${randomBytes(6).toString('hex')}`);
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

describe('QueueStore', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = makeTmpDir();
    await mkdir(dataDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('read()', () => {
    it('returns empty tasks and paused=false when queue.json does not exist', async () => {
      const store = new QueueStore(dataDir);
      const result = await store.read();
      expect(result).toEqual({ tasks: [], paused: false });
    });

    it('returns tasks from a valid queue.json', async () => {
      const store = new QueueStore(dataDir);
      const task = makeTask();
      await store.write({ tasks: [task], paused: false });

      const result = await store.read();
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0]!.id).toBe('00000000-0000-4000-8000-000000000001');
      expect(result.tasks[0]!.name).toBe('Test Task');
      expect(result.tasks[0]!.type).toBe('template');
      expect(result.tasks[0]!.status).toBe('pending');
      expect(result.tasks[0]!.createdAt).toBeInstanceOf(Date);
    });

    it('deserializes createdAt ISO string back to Date', async () => {
      const store = new QueueStore(dataDir);
      const task = makeTask({ createdAt: new Date('2026-02-15T12:00:00.000Z') });
      await store.write({ tasks: [task], paused: false });

      const result = await store.read();
      expect(result.tasks[0]!.createdAt).toBeInstanceOf(Date);
      expect(result.tasks[0]!.createdAt.toISOString()).toBe('2026-02-15T12:00:00.000Z');
    });

    it('returns empty tasks and creates timestamped backup on corrupt JSON', async () => {
      const filePath = join(dataDir, 'queue.json');
      await writeFile(filePath, 'not-valid-json', 'utf-8');

      const store = new QueueStore(dataDir);
      const result = await store.read();

      expect(result).toEqual({ tasks: [], paused: false });
      const files = await readdir(dataDir);
      const backupFile = files.find((f) => f.startsWith('queue.json.backup-'));
      expect(backupFile).toBeDefined();
      const backup = await readFile(join(dataDir, backupFile!), 'utf-8');
      expect(backup).toBe('not-valid-json');
    });

    it('returns empty tasks and creates timestamped backup when schema validation fails', async () => {
      const filePath = join(dataDir, 'queue.json');
      // Valid JSON but wrong schema (missing required fields)
      await writeFile(filePath, JSON.stringify({ version: 1, tasks: [{ bad: 'data' }] }), 'utf-8');

      const store = new QueueStore(dataDir);
      const result = await store.read();

      expect(result).toEqual({ tasks: [], paused: false });
      const files = await readdir(dataDir);
      const backupFile = files.find((f) => f.startsWith('queue.json.backup-'));
      expect(backupFile).toBeDefined();
      const backup = await readFile(join(dataDir, backupFile!), 'utf-8');
      expect(backup).toContain('"bad"');
    });

    it('returns empty tasks on unknown version in queue file (schema mismatch)', async () => {
      const filePath = join(dataDir, 'queue.json');
      await writeFile(filePath, JSON.stringify({ version: 99, tasks: [] }), 'utf-8');

      const store = new QueueStore(dataDir);
      const result = await store.read();
      // version: 99 fails z.literal(1) → treated as corrupt
      expect(result).toEqual({ tasks: [], paused: false });
    });

    it('rejects non-ISO createdAt as schema validation failure', async () => {
      const filePath = join(dataDir, 'queue.json');
      const payload = {
        version: 1,
        tasks: [
          {
            id: 'x',
            name: 'Task',
            type: 'template',
            templateName: 'lint',
            prompt: '',
            targetPath: '/r',
            priority: 1,
            createdAt: 'not-a-date',
            timeoutMs: 3600000,
          },
        ],
      };
      await writeFile(filePath, JSON.stringify(payload), 'utf-8');

      const store = new QueueStore(dataDir);
      const result = await store.read();
      expect(result).toEqual({ tasks: [], paused: false });
    });

    it('rejects template task without templateName via discriminated union', async () => {
      const filePath = join(dataDir, 'queue.json');
      const payload = {
        version: 1,
        tasks: [
          {
            id: 'x',
            name: 'Task',
            type: 'template',
            prompt: '',
            targetPath: '/r',
            priority: 1,
            createdAt: '2026-01-01T00:00:00.000Z',
            timeoutMs: 3600000,
          },
        ],
      };
      await writeFile(filePath, JSON.stringify(payload), 'utf-8');

      const store = new QueueStore(dataDir);
      const result = await store.read();
      // Missing templateName on template type → corrupt
      expect(result).toEqual({ tasks: [], paused: false });
    });

    it('defaults legacy records without status to pending on read', async () => {
      const filePath = join(dataDir, 'queue.json');
      const payload = {
        version: 1,
        tasks: [
          {
            id: '00000000-0000-4000-8000-000000000010',
            name: 'Legacy Task',
            type: 'custom',
            prompt: 'legacy prompt',
            targetPath: '/legacy',
            priority: 1,
            createdAt: '2026-01-01T00:00:00.000Z',
            timeoutMs: 3600000,
          },
        ],
      };

      await writeFile(filePath, JSON.stringify(payload), 'utf-8');

      const store = new QueueStore(dataDir);
      const result = await store.read();

      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0]!.id).toBe('00000000-0000-4000-8000-000000000010');
      expect(result.tasks[0]!.status).toBe('pending');
    });

    it('creates distinct backup files for consecutive corruptions', async () => {
      const filePath = join(dataDir, 'queue.json');

      await writeFile(filePath, 'corrupt-1', 'utf-8');
      const store = new QueueStore(dataDir);
      await store.read();

      // Small delay to ensure different timestamp
      await new Promise((r) => setTimeout(r, 10));

      await writeFile(filePath, 'corrupt-2', 'utf-8');
      await store.read();

      const files = await readdir(dataDir);
      const backups = files.filter((f) => f.startsWith('queue.json.backup-'));
      expect(backups.length).toBeGreaterThanOrEqual(2);
    });

    it('reads paused=true from queue.json when paused flag is set', async () => {
      const store = new QueueStore(dataDir);
      const task = makeTask();
      await store.write({ tasks: [task], paused: true });

      const result = await store.read();
      expect(result.paused).toBe(true);
      expect(result.tasks).toHaveLength(1);
    });

    it('defaults legacy queue.json without paused field to paused=false', async () => {
      const filePath = join(dataDir, 'queue.json');
      // Legacy payload without paused field
      const payload = {
        version: 1,
        tasks: [
          {
            id: '00000000-0000-4000-8000-000000000011',
            name: 'Legacy Task',
            type: 'custom',
            prompt: 'do something',
            targetPath: '/repo',
            priority: 1,
            createdAt: '2026-01-01T00:00:00.000Z',
            timeoutMs: 3600000,
          },
        ],
      };
      await writeFile(filePath, JSON.stringify(payload), 'utf-8');

      const store = new QueueStore(dataDir);
      const result = await store.read();
      expect(result.paused).toBe(false);
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0]!.id).toBe('00000000-0000-4000-8000-000000000011');
    });
  });

  describe('write()', () => {
    it('persists tasks to queue.json', async () => {
      const store = new QueueStore(dataDir);
      const task = makeTask();
      await store.write({ tasks: [task], paused: false });

      const content = await readFile(join(dataDir, 'queue.json'), 'utf-8');
      const parsed = JSON.parse(content) as { version: number; tasks: unknown[]; paused: boolean };
      expect(parsed.version).toBe(1);
      expect(parsed.tasks).toHaveLength(1);
    });

    it('writes empty tasks array for clear', async () => {
      const store = new QueueStore(dataDir);
      await store.write({ tasks: [makeTask()], paused: false });
      await store.write({ tasks: [], paused: false });

      const content = await readFile(join(dataDir, 'queue.json'), 'utf-8');
      const parsed = JSON.parse(content) as { tasks: unknown[] };
      expect(parsed.tasks).toHaveLength(0);
    });

    it('serializes createdAt as ISO 8601 string', async () => {
      const store = new QueueStore(dataDir);
      const task = makeTask({ createdAt: new Date('2026-03-01T09:00:00.000Z') });
      await store.write({ tasks: [task], paused: false });

      const content = await readFile(join(dataDir, 'queue.json'), 'utf-8');
      expect(content).toContain('2026-03-01T09:00:00.000Z');
    });

    it('persists task status field for dispatch lifecycle tracking', async () => {
      const store = new QueueStore(dataDir);
      await store.write({ tasks: [makeTask({ status: 'failed_quota' })], paused: false });

      const content = await readFile(join(dataDir, 'queue.json'), 'utf-8');
      expect(content).toContain('"status": "failed_quota"');
    });

    it('creates data directory if it does not exist', async () => {
      const nestedDir = join(dataDir, 'nested', 'path');
      const store = new QueueStore(nestedDir);
      await store.write({ tasks: [], paused: false });

      const content = await readFile(join(nestedDir, 'queue.json'), 'utf-8');
      expect(content).toContain('"version": 1');
    });

    it('round-trips template task with optional templateName', async () => {
      const store = new QueueStore(dataDir);
      const task = makeTask({ type: 'template', templateName: 'improve-code' });
      await store.write({ tasks: [task], paused: false });

      const result = await store.read();
      expect(result.tasks[0]!.templateName).toBe('improve-code');
    });

    it('round-trips custom task without templateName', async () => {
      const store = new QueueStore(dataDir);
      const task = makeTask({ type: 'custom', prompt: 'do the thing' });
      // Remove the inherited templateName from the base fixture
      delete (task as Partial<typeof task>).templateName;
      await store.write({ tasks: [task], paused: false });

      const result = await store.read();
      expect(result.tasks[0]!.templateName).toBeUndefined();
      expect(result.tasks[0]!.type).toBe('custom');
    });

    it('persists paused=true in queue.json', async () => {
      const store = new QueueStore(dataDir);
      await store.write({ tasks: [], paused: true });

      const content = await readFile(join(dataDir, 'queue.json'), 'utf-8');
      const parsed = JSON.parse(content) as { paused: boolean };
      expect(parsed.paused).toBe(true);
    });

    it('round-trips paused=true through write and read', async () => {
      const store = new QueueStore(dataDir);
      const task = makeTask();
      await store.write({ tasks: [task], paused: true });

      const result = await store.read();
      expect(result.paused).toBe(true);
      expect(result.tasks).toHaveLength(1);
    });

    it('backfills paused=false in persisted payload when writing after legacy read', async () => {
      // Simulate reading a legacy file (no paused field), then writing
      const filePath = join(dataDir, 'queue.json');
      const legacyPayload = {
        version: 1,
        tasks: [],
      };
      await writeFile(filePath, JSON.stringify(legacyPayload), 'utf-8');

      const store = new QueueStore(dataDir);
      const { tasks, paused } = await store.read();
      expect(paused).toBe(false);

      // Write back (simulating backfill on next mutation)
      await store.write({ tasks, paused });

      const content = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content) as { paused: boolean };
      // paused field is now explicitly present
      expect(Object.prototype.hasOwnProperty.call(parsed, 'paused')).toBe(true);
      expect(parsed.paused).toBe(false);
    });
  });

  describe('atomic write safety', () => {
    it('queue file does not contain tmp file after successful write', async () => {
      const store = new QueueStore(dataDir);
      await store.write({ tasks: [makeTask()], paused: false });

      const files = await readdir(dataDir);
      const tmpFiles = files.filter((f) => f.startsWith('.tmp-queue-'));
      expect(tmpFiles).toHaveLength(0);
    });

    it('near-simultaneous writes do not corrupt the queue', async () => {
      const store = new QueueStore(dataDir);

      const t1 = makeTask({
        id: '00000000-0000-4000-8000-00000000000a',
        name: 'Task A',
        priority: 1,
      });
      const t2 = makeTask({
        id: '00000000-0000-4000-8000-00000000000b',
        name: 'Task B',
        priority: 1,
      });

      // Two concurrent writes — last one wins but neither corrupts
      await Promise.all([
        store.write({ tasks: [t1], paused: false }),
        store.write({ tasks: [t2], paused: false }),
      ]);

      const result = await store.read();
      // The queue should contain exactly one write result (no corruption)
      expect(result.tasks).toHaveLength(1);
      const id = result.tasks[0]!.id;
      expect([
        '00000000-0000-4000-8000-00000000000a',
        '00000000-0000-4000-8000-00000000000b',
      ]).toContain(id);
    });
  });

  describe('error paths', () => {
    it('throws QUEUE_CORRUPT ScrowError when readFile fails with a non-ENOENT error', async () => {
      const filePath = join(dataDir, 'queue.json');
      await writeFile(filePath, '{}', 'utf-8');
      // Remove read permission — causes EACCES, not ENOENT
      await chmod(filePath, 0o000);

      const store = new QueueStore(dataDir);
      try {
        await expect(store.read()).rejects.toMatchObject({ code: 'QUEUE_CORRUPT' });
      } finally {
        await chmod(filePath, 0o644);
      }
    });

    it('throws QUEUE_WRITE_FAILED ScrowError and cleans up temp file when write fails', async () => {
      const store = new QueueStore(dataDir);
      // Remove write permission on directory — temp file creation fails
      await chmod(dataDir, 0o555);

      try {
        await expect(store.write({ tasks: [], paused: false })).rejects.toMatchObject({
          code: 'QUEUE_WRITE_FAILED',
        });
        // Verify no orphaned tmp files remain (unlink attempted in catch)
        const files = await readdir(dataDir).catch(() => [] as string[]);
        const tmpFiles = files.filter((f) => f.startsWith('.tmp-queue-'));
        expect(tmpFiles).toHaveLength(0);
      } finally {
        await chmod(dataDir, 0o755);
      }
    });
  });

  // ── Backward compatibility: existing timeoutMs: 1800000 (Story 7.19 — AC8) ──

  describe('backward compatibility (timeoutMs)', () => {
    it('reads existing queue.json with timeoutMs: 1800000 (backward compatible)', async () => {
      const store = new QueueStore(dataDir);
      const payload = {
        version: 1,
        tasks: [
          {
            id: '00000000-0000-4000-8000-000000000012',
            name: 'legacy-task',
            type: 'template',
            templateName: 'improve-code',
            status: 'pending',
            prompt: 'review code',
            targetPath: '/repo',
            priority: 1,
            createdAt: '2026-01-01T00:00:00.000Z',
            timeoutMs: 1800000,
          },
        ],
        paused: false,
      };
      await writeFile(join(dataDir, 'queue.json'), JSON.stringify(payload));
      const result = await store.read();
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0]!.timeoutMs).toBe(1800000);
    });

    it('reads queue.json with timeoutMs: 0 (no-timeout sentinel)', async () => {
      const store = new QueueStore(dataDir);
      const payload = {
        version: 1,
        tasks: [
          {
            id: '00000000-0000-4000-8000-000000000013',
            name: 'long-task',
            type: 'custom',
            status: 'pending',
            prompt: 'do long thing',
            targetPath: '/repo',
            priority: 1,
            createdAt: '2026-01-01T00:00:00.000Z',
            timeoutMs: 0,
          },
        ],
        paused: false,
      };
      await writeFile(join(dataDir, 'queue.json'), JSON.stringify(payload));
      const result = await store.read();
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0]!.timeoutMs).toBe(0);
    });

    it('round-trips timeoutMs: 0 through write then read', async () => {
      const store = new QueueStore(dataDir);
      const task = makeTask({ timeoutMs: 0 });
      await store.write({ tasks: [task], paused: false });
      const result = await store.read();
      expect(result.tasks[0]!.timeoutMs).toBe(0);
    });
  });
});

describe('QueueStore — backup failure path (mocked fs)', () => {
  afterEach(() => {
    vi.unmock('node:fs/promises');
    vi.resetModules();
  });

  it('continues and returns empty tasks when backup write fails during corruption recovery', async () => {
    vi.resetModules();

    const corruptContent = 'not-valid-json';
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.doMock('node:fs/promises', () => ({
      ...actualFs,
      readFile: vi.fn().mockResolvedValue(corruptContent),
      writeFile: vi.fn().mockRejectedValue(new Error('disk full')),
      mkdir: vi.fn().mockResolvedValue(undefined),
    }));

    const { QueueStore: MockedQueueStore } = await import('./queue-store.js');
    const store = new MockedQueueStore('/any/dir');
    const result = await store.read();

    // Does not throw — returns empty gracefully despite backup write failure
    expect(result).toEqual({ tasks: [], paused: false });
  });

  describe('DEFAULT_TIMEOUT_MS', () => {
    it('equals 60 * 60 * 1000 (3600000ms)', () => {
      expect(DEFAULT_TIMEOUT_MS).toBe(60 * 60 * 1000);
    });
  });
});
