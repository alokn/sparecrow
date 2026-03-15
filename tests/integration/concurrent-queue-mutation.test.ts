/** Integration tests for concurrent queue mutations — verifies queue safety under parallel access. */
import { mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueueManager, QueueStore } from '../../src/queue/index.js';
import { DEFAULT_TIMEOUT_MS } from '../../src/queue/queue-store.js';
import type { TaskDefinition } from '../../src/types/index.js';

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function makeTmpDir(): string {
  return join(tmpdir(), `sparecrow-concurrent-queue-${randomBytes(6).toString('hex')}`);
}

describe('concurrent queue mutations', () => {
  let dataDir: string;
  let store: QueueStore;
  let manager: QueueManager;

  beforeEach(async () => {
    dataDir = makeTmpDir();
    await mkdir(dataDir, { recursive: true });
    store = new QueueStore(dataDir);
    manager = new QueueManager(store);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Reads queue.json and asserts it is valid JSON and parses successfully. */
  async function assertValidQueueFile(): Promise<Record<string, unknown>> {
    const raw = await readFile(store.filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed).toBeDefined();
    expect(parsed['version']).toBe(1);
    expect(Array.isArray(parsed['tasks'])).toBe(true);
    return parsed;
  }

  /**
   * Asserts that tasks have contiguous 1-based priorities.
   * Tasks are sorted by priority before checking to avoid ordering assumptions
   * about how list() returns items after concurrent last-writer-wins mutations.
   */
  function assertContiguousPriorities(tasks: Array<{ priority: number }>): void {
    const sorted = [...tasks].sort((a, b) => a.priority - b.priority);
    for (let i = 0; i < sorted.length; i++) {
      expect(sorted[i]!.priority).toBe(i + 1);
    }
  }

  /**
   * Seeds N pending tasks directly via QueueStore.write() to decouple test setup
   * from the QueueManager under test — a bug in add() won't corrupt baseline state.
   */
  async function seedTasks(count: number): Promise<string[]> {
    const ids: string[] = [];
    const tasks: TaskDefinition[] = [];
    for (let i = 0; i < count; i++) {
      const id = randomUUID();
      ids.push(id);
      tasks.push({
        id,
        type: 'custom',
        name: `task-${i}`,
        status: 'pending',
        prompt: `task-${i}`,
        targetPath: `/repo/${i}`,
        priority: i + 1,
        createdAt: new Date(),
        timeoutMs: DEFAULT_TIMEOUT_MS,
        actions: [],
      });
    }
    await store.write({ tasks, paused: false });
    return ids;
  }

  describe('AC1 — concurrent add during dispatch (setTaskStatus)', () => {
    it('preserves queue integrity when add and status-change race', async () => {
      const ITERATIONS = 10;

      for (let iter = 0; iter < ITERATIONS; iter++) {
        // Reset queue for each iteration
        await manager.clear();
        const ids = await seedTasks(3);

        // Simulate daemon dispatching task 1 (setting to in-progress) AND CLI adding a task concurrently
        await Promise.all([
          manager.setTaskStatus(ids[0]!, 'in-progress'),
          manager.add({
            type: 'custom',
            prompt: 'concurrent-add',
            targetPath: '/repo/concurrent',
          }),
        ]);

        // Now simulate task 1 completing (done)
        await manager.setTaskStatus(ids[0]!, 'done');

        const tasks = await manager.list();
        // Should have original 3 + 1 new = 4 tasks total (the done one is still in the list)
        expect(tasks.length).toBe(4);

        // The newly added task should be present
        const concurrentTask = tasks.find((t) => t.prompt === 'concurrent-add');
        expect(concurrentTask).toBeDefined();

        // Priorities should be contiguous
        assertContiguousPriorities(tasks);

        // File should be valid JSON
        await assertValidQueueFile();
      }
    });
  });

  describe('AC2 — two concurrent add operations', () => {
    it('preserves both tasks with unique IDs after concurrent adds', async () => {
      const ITERATIONS = 10;

      for (let iter = 0; iter < ITERATIONS; iter++) {
        await manager.clear();

        const [result1, result2] = await Promise.all([
          manager.add({
            type: 'custom',
            prompt: 'add-a',
            targetPath: '/repo/a',
          }),
          manager.add({
            type: 'custom',
            prompt: 'add-b',
            targetPath: '/repo/b',
          }),
        ]);

        // Both tasks should exist
        const tasks = await manager.list();
        expect(tasks.length).toBe(2);

        // IDs should be unique
        expect(result1.task.id).not.toBe(result2.task.id);

        // Both prompts should be present
        const prompts = tasks.map((t) => t.prompt);
        expect(prompts).toContain('add-a');
        expect(prompts).toContain('add-b');

        // Priorities should be contiguous 1-based
        assertContiguousPriorities(tasks);

        // File should be valid JSON
        await assertValidQueueFile();
      }
    });
  });

  describe('AC3 — concurrent add during remove', () => {
    it('preserves queue consistency when add and remove race', async () => {
      const ITERATIONS = 10;

      for (let iter = 0; iter < ITERATIONS; iter++) {
        await manager.clear();
        const ids = await seedTasks(5);

        // Remove task at position 3 and add a new task concurrently
        await Promise.all([
          manager.remove(3),
          manager.add({
            type: 'custom',
            prompt: 'concurrent-add-during-remove',
            targetPath: '/repo/concurrent-remove',
          }),
        ]);

        const tasks = await manager.list();

        // Should have 5 - 1 + 1 = 5 tasks
        expect(tasks.length).toBe(5);

        // The removed task (originally at position 3, id = ids[2]) should be gone
        const removedTask = tasks.find((t) => t.id === ids[2]);
        expect(removedTask).toBeUndefined();

        // The added task should be present
        const addedTask = tasks.find((t) => t.prompt === 'concurrent-add-during-remove');
        expect(addedTask).toBeDefined();

        // Priorities should be contiguous
        assertContiguousPriorities(tasks);

        // File should be valid JSON
        await assertValidQueueFile();
      }
    });
  });

  describe('AC4 — repeated iteration stability (covered by 10 iterations in AC1-AC3)', () => {
    it('all concurrent scenarios produce valid state across 10 iterations via serialized lock', async () => {
      // Stress test: add + remove + setTaskStatus submitted concurrently.
      // Note: QueueManager._withLock() serialises these operations — Promise.all exercises
      // locking correctness (no lost updates, contiguous priorities after each mutation) rather
      // than true concurrent I/O interleaving. The serialised execution is the intended behaviour.
      const ITERATIONS = 10;

      for (let iter = 0; iter < ITERATIONS; iter++) {
        await manager.clear();
        const ids = await seedTasks(3);

        await Promise.all([
          manager.add({
            type: 'custom',
            prompt: `stress-add-${iter}`,
            targetPath: `/repo/stress/${iter}`,
          }),
          manager.setTaskStatus(ids[0]!, 'in-progress'),
          manager.remove(2),
        ]);

        const tasks = await manager.list();
        // Should be 3 - 1 + 1 = 3 tasks
        expect(tasks.length).toBe(3);
        assertContiguousPriorities(tasks);

        const parsed = await assertValidQueueFile();
        const fileTasks = parsed['tasks'] as Array<Record<string, unknown>>;
        expect(fileTasks.length).toBe(3);
      }
    });
  });
});
