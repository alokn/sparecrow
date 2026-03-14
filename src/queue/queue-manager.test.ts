/** Unit tests for QueueManager — add/remove/reorder/clear semantics and edge cases. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { QueueStore } from './queue-store.js';
import { QueueManager } from './queue-manager.js';
import { ScrowError, ErrorCode } from '../errors/index.js';

function makeTmpDir(): string {
  return join(tmpdir(), `sparecrow-queue-mgr-test-${randomBytes(6).toString('hex')}`);
}

describe('QueueManager', () => {
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
    vi.restoreAllMocks();
  });

  // ── list ─────────────────────────────────────────────────────────────────

  describe('list()', () => {
    it('returns empty array for a fresh queue', async () => {
      const result = await manager.list();
      expect(result).toEqual([]);
    });

    it('returns tasks in priority order after adds', async () => {
      await manager.add({ type: 'template', templateName: 'lint', prompt: '', targetPath: '/a' });
      await manager.add({ type: 'template', templateName: 'test', prompt: '', targetPath: '/b' });

      const tasks = await manager.list();
      expect(tasks).toHaveLength(2);
      expect(tasks[0]!.priority).toBe(1);
      expect(tasks[1]!.priority).toBe(2);
      expect(tasks[0]!.status).toBe('pending');
      expect(tasks[1]!.status).toBe('pending');
    });
  });

  describe('listDispatchable()', () => {
    it('returns only pending and failed_quota tasks in priority order', async () => {
      const first = await manager.add({
        type: 'template',
        templateName: 'lint',
        prompt: '',
        targetPath: '/a',
      });
      const second = await manager.add({
        type: 'template',
        templateName: 'test',
        prompt: '',
        targetPath: '/b',
      });
      const third = await manager.add({
        type: 'template',
        templateName: 'build',
        prompt: '',
        targetPath: '/c',
      });

      await manager.setTaskStatus(second.task.id, 'failed_quota');
      await manager.setTaskStatus(third.task.id, 'done');

      const tasks = await manager.listDispatchable();
      expect(tasks.map((task) => task.id)).toEqual([first.task.id, second.task.id]);
      expect(tasks[0]!.status).toBe('pending');
      expect(tasks[1]!.status).toBe('failed_quota');
    });

    it('returns empty array when all tasks are non-dispatchable', async () => {
      const first = await manager.add({
        type: 'template',
        templateName: 'lint',
        prompt: '',
        targetPath: '/a',
      });
      await manager.setTaskStatus(first.task.id, 'done');

      const tasks = await manager.listDispatchable();
      expect(tasks).toEqual([]);
    });

    it('returns empty array while queue is paused even if tasks are dispatchable', async () => {
      await manager.add({ type: 'template', templateName: 'lint', prompt: '', targetPath: '/a' });
      await manager.pause();

      const tasks = await manager.listDispatchable();
      expect(tasks).toEqual([]);
    });

    it('returns dispatchable tasks after resume', async () => {
      await manager.add({ type: 'template', templateName: 'lint', prompt: '', targetPath: '/a' });
      await manager.pause();
      await manager.resume();

      const tasks = await manager.listDispatchable();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.status).toBe('pending');
    });
  });

  describe('setTaskStatus()', () => {
    it('updates task status by task id', async () => {
      const added = await manager.add({
        type: 'template',
        templateName: 'lint',
        prompt: '',
        targetPath: '/a',
      });

      await manager.setTaskStatus(added.task.id, 'failed');

      const tasks = await manager.list();
      expect(tasks[0]!.status).toBe('failed');
    });

    it('throws QUEUE_TASK_NOT_FOUND when task id is not found', async () => {
      await expect(manager.setTaskStatus('missing-task-id', 'done')).rejects.toMatchObject({
        code: ErrorCode.QUEUE_TASK_NOT_FOUND,
      });
    });
  });

  // ── pause / resume ────────────────────────────────────────────────────────

  describe('pause()', () => {
    it('pauses the queue and returns { paused: true, changed: true }', async () => {
      const result = await manager.pause();
      expect(result).toEqual({ paused: true, changed: true });
    });

    it('persists paused=true to queue.json', async () => {
      await manager.pause();
      const { paused } = await store.read();
      expect(paused).toBe(true);
    });

    it('is idempotent: returns { paused: true, changed: false } when already paused', async () => {
      await manager.pause();
      const result = await manager.pause();
      expect(result).toEqual({ paused: true, changed: false });
    });

    it('does not change tasks when pausing', async () => {
      await manager.add({ type: 'template', templateName: 'lint', prompt: '', targetPath: '/a' });
      await manager.pause();

      const tasks = await manager.list();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.status).toBe('pending');
    });
  });

  describe('resume()', () => {
    it('resumes the queue and returns { paused: false, changed: true }', async () => {
      await manager.pause();
      const result = await manager.resume();
      expect(result).toEqual({ paused: false, changed: true });
    });

    it('persists paused=false to queue.json', async () => {
      await manager.pause();
      await manager.resume();
      const { paused } = await store.read();
      expect(paused).toBe(false);
    });

    it('is idempotent: returns { paused: false, changed: false } when already resumed', async () => {
      const result = await manager.resume();
      expect(result).toEqual({ paused: false, changed: false });
    });

    it('does not change tasks when resuming', async () => {
      await manager.add({ type: 'template', templateName: 'lint', prompt: '', targetPath: '/a' });
      await manager.pause();
      await manager.resume();

      const tasks = await manager.list();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.status).toBe('pending');
    });
  });

  describe('isPaused()', () => {
    it('returns false for a fresh queue', async () => {
      expect(await manager.isPaused()).toBe(false);
    });

    it('returns true after pause', async () => {
      await manager.pause();
      expect(await manager.isPaused()).toBe(true);
    });

    it('returns false after resume', async () => {
      await manager.pause();
      await manager.resume();
      expect(await manager.isPaused()).toBe(false);
    });
  });

  // ── paused state preservation across mutations ────────────────────────────

  describe('paused state preservation', () => {
    it('preserves paused=true after add', async () => {
      await manager.pause();
      await manager.add({ type: 'template', templateName: 'lint', prompt: '', targetPath: '/a' });
      expect(await manager.isPaused()).toBe(true);
    });

    it('preserves paused=true after remove', async () => {
      await manager.add({ type: 'template', templateName: 'lint', prompt: '', targetPath: '/a' });
      await manager.pause();
      await manager.remove(1);
      expect(await manager.isPaused()).toBe(true);
    });

    it('preserves paused=true after reorder', async () => {
      await manager.add({ type: 'template', templateName: 'a', prompt: '', targetPath: '/a' });
      await manager.add({ type: 'template', templateName: 'b', prompt: '', targetPath: '/b' });
      await manager.pause();
      await manager.reorder(1, 2);
      expect(await manager.isPaused()).toBe(true);
    });

    it('preserves paused=true after clear', async () => {
      await manager.add({ type: 'template', templateName: 'lint', prompt: '', targetPath: '/a' });
      await manager.pause();
      await manager.clear();
      expect(await manager.isPaused()).toBe(true);
    });

    it('preserves paused=true after setTaskStatus', async () => {
      const added = await manager.add({
        type: 'template',
        templateName: 'lint',
        prompt: '',
        targetPath: '/a',
      });
      await manager.pause();
      await manager.setTaskStatus(added.task.id, 'done');
      expect(await manager.isPaused()).toBe(true);
    });
  });

  // ── add ──────────────────────────────────────────────────────────────────

  describe('add()', () => {
    it('adds a template task and returns position 1 for first item', async () => {
      const result = await manager.add({
        type: 'template',
        templateName: 'improve-code',
        prompt: '',
        targetPath: '/repo',
      });

      expect(result.position).toBe(1);
      expect(result.task.type).toBe('template');
      expect(result.task.templateName).toBe('improve-code');
      expect(result.task.name).toBe('improve-code');
      expect(result.task.targetPath).toBe('/repo');
    });

    it('generates a unique ID for each task', async () => {
      const r1 = await manager.add({
        type: 'template',
        templateName: 'a',
        prompt: '',
        targetPath: '/x',
      });
      const r2 = await manager.add({
        type: 'template',
        templateName: 'b',
        prompt: '',
        targetPath: '/x',
      });
      expect(r1.task.id).not.toBe(r2.task.id);
    });

    it('auto-generates custom-1 name for first custom task when no name provided', async () => {
      const result = await manager.add({
        type: 'custom',
        prompt: 'a'.repeat(60),
        targetPath: '/repo',
      });
      expect(result.task.type).toBe('custom');
      expect(result.task.name).toBe('custom-1');
    });

    it('auto-generates custom-2 for second custom task when no name provided', async () => {
      await manager.add({ type: 'custom', prompt: 'first', targetPath: '/repo' });
      const result = await manager.add({ type: 'custom', prompt: 'second', targetPath: '/repo' });
      expect(result.task.name).toBe('custom-2');
    });

    it('generates non-duplicate name after task removal (uses max-index+1 not length+1)', async () => {
      // Add custom-1 and custom-2, then remove custom-1 so queue has only custom-2
      await manager.add({ type: 'custom', prompt: 'first', targetPath: '/repo' });
      await manager.add({ type: 'custom', prompt: 'second', targetPath: '/repo' });
      await manager.remove(1); // removes custom-1, leaving [custom-2]

      // length is now 1, so length+1 = 2, which would collide with existing 'custom-2'
      // max-index+1 = 2+1 = 3, which is unique
      const result = await manager.add({ type: 'custom', prompt: 'third', targetPath: '/repo' });
      expect(result.task.name).toBe('custom-3');
    });

    it('uses explicit name when name option is provided', async () => {
      const result = await manager.add({
        type: 'custom',
        name: 'my-custom-task',
        prompt: 'short prompt',
        targetPath: '/repo',
      });
      expect(result.task.name).toBe('my-custom-task');
    });

    it('appends to end and assigns contiguous priorities', async () => {
      await manager.add({ type: 'template', templateName: 'a', prompt: '', targetPath: '/x' });
      const r2 = await manager.add({
        type: 'template',
        templateName: 'b',
        prompt: '',
        targetPath: '/y',
      });
      const r3 = await manager.add({
        type: 'template',
        templateName: 'c',
        prompt: '',
        targetPath: '/z',
      });

      expect(r2.position).toBe(2);
      expect(r3.position).toBe(3);

      const tasks = await manager.list();
      expect(tasks.map((t) => t.priority)).toEqual([1, 2, 3]);
    });

    it('sets timeoutMs to default when not specified', async () => {
      const result = await manager.add({
        type: 'template',
        templateName: 'x',
        prompt: '',
        targetPath: '/r',
      });
      expect(result.task.timeoutMs).toBe(60 * 60 * 1000);
    });

    it('uses provided timeoutMs when specified', async () => {
      const result = await manager.add({
        type: 'template',
        templateName: 'x',
        prompt: '',
        targetPath: '/r',
        timeoutMs: 5000,
      });
      expect(result.task.timeoutMs).toBe(5000);
    });

    it('accepts timeoutMs: 0 to disable timeout', async () => {
      const result = await manager.add({
        type: 'template',
        templateName: 'x',
        prompt: '',
        targetPath: '/r',
        timeoutMs: 0,
      });
      expect(result.task.timeoutMs).toBe(0);
    });

    it('persists timeoutMs: 0 through store round-trip', async () => {
      await manager.add({
        type: 'template',
        templateName: 'x',
        prompt: '',
        targetPath: '/r',
        timeoutMs: 0,
      });
      const tasks = await manager.list();
      expect(tasks[0]!.timeoutMs).toBe(0);
    });

    it('sets createdAt to a recent Date', async () => {
      const before = new Date();
      const result = await manager.add({
        type: 'template',
        templateName: 'x',
        prompt: '',
        targetPath: '/r',
      });
      const after = new Date();
      expect(result.task.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(result.task.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

  // ── remove ───────────────────────────────────────────────────────────────

  describe('remove()', () => {
    it('removes the task at position 1 from a single-item queue', async () => {
      await manager.add({ type: 'template', templateName: 'x', prompt: '', targetPath: '/r' });
      const removed = await manager.remove(1);

      expect(removed.templateName).toBe('x');
      const tasks = await manager.list();
      expect(tasks).toHaveLength(0);
    });

    it('removes middle task and renormalizes priorities', async () => {
      await manager.add({ type: 'template', templateName: 'a', prompt: '', targetPath: '/a' });
      await manager.add({ type: 'template', templateName: 'b', prompt: '', targetPath: '/b' });
      await manager.add({ type: 'template', templateName: 'c', prompt: '', targetPath: '/c' });

      await manager.remove(2);

      const tasks = await manager.list();
      expect(tasks).toHaveLength(2);
      expect(tasks[0]!.priority).toBe(1);
      expect(tasks[1]!.priority).toBe(2);
      expect(tasks[0]!.templateName).toBe('a');
      expect(tasks[1]!.templateName).toBe('c');
    });

    it('throws QUEUE_INVALID_POSITION for position 0', async () => {
      await manager.add({ type: 'template', templateName: 'x', prompt: '', targetPath: '/r' });
      await expect(manager.remove(0)).rejects.toMatchObject({
        code: ErrorCode.QUEUE_INVALID_POSITION,
      });
    });

    it('throws QUEUE_INVALID_POSITION for negative position', async () => {
      await manager.add({ type: 'template', templateName: 'x', prompt: '', targetPath: '/r' });
      await expect(manager.remove(-1)).rejects.toMatchObject({
        code: ErrorCode.QUEUE_INVALID_POSITION,
      });
    });

    it('throws QUEUE_INVALID_POSITION for out-of-range position', async () => {
      await manager.add({ type: 'template', templateName: 'x', prompt: '', targetPath: '/r' });
      await expect(manager.remove(5)).rejects.toMatchObject({
        code: ErrorCode.QUEUE_INVALID_POSITION,
      });
    });

    it('throws QUEUE_INVALID_POSITION on empty queue', async () => {
      await expect(manager.remove(1)).rejects.toMatchObject({
        code: ErrorCode.QUEUE_INVALID_POSITION,
      });
    });

    it('throws ScrowError for non-integer position', async () => {
      await manager.add({ type: 'template', templateName: 'x', prompt: '', targetPath: '/r' });
      await expect(manager.remove(1.5)).rejects.toBeInstanceOf(ScrowError);
    });
  });

  // ── reorder ──────────────────────────────────────────────────────────────

  describe('reorder()', () => {
    it('moves task from position 1 to position 3', async () => {
      await manager.add({ type: 'template', templateName: 'a', prompt: '', targetPath: '/a' });
      await manager.add({ type: 'template', templateName: 'b', prompt: '', targetPath: '/b' });
      await manager.add({ type: 'template', templateName: 'c', prompt: '', targetPath: '/c' });

      const updated = await manager.reorder(1, 3);

      expect(updated[0]!.templateName).toBe('b');
      expect(updated[1]!.templateName).toBe('c');
      expect(updated[2]!.templateName).toBe('a');
      expect(updated.map((t) => t.priority)).toEqual([1, 2, 3]);
    });

    it('moves task from position 3 to position 1', async () => {
      await manager.add({ type: 'template', templateName: 'a', prompt: '', targetPath: '/a' });
      await manager.add({ type: 'template', templateName: 'b', prompt: '', targetPath: '/b' });
      await manager.add({ type: 'template', templateName: 'c', prompt: '', targetPath: '/c' });

      const updated = await manager.reorder(3, 1);

      expect(updated[0]!.templateName).toBe('c');
      expect(updated[1]!.templateName).toBe('a');
      expect(updated[2]!.templateName).toBe('b');
    });

    it('is a no-op when from equals to', async () => {
      await manager.add({ type: 'template', templateName: 'a', prompt: '', targetPath: '/a' });
      await manager.add({ type: 'template', templateName: 'b', prompt: '', targetPath: '/b' });

      const beforeNames = (await manager.list()).map((t) => t.templateName);
      await manager.reorder(1, 1);
      const afterNames = (await manager.list()).map((t) => t.templateName);

      expect(afterNames).toEqual(beforeNames);
    });

    it('renormalizes priorities after reorder', async () => {
      await manager.add({ type: 'template', templateName: 'a', prompt: '', targetPath: '/a' });
      await manager.add({ type: 'template', templateName: 'b', prompt: '', targetPath: '/b' });
      await manager.add({ type: 'template', templateName: 'c', prompt: '', targetPath: '/c' });

      const updated = await manager.reorder(2, 1);
      expect(updated.map((t) => t.priority)).toEqual([1, 2, 3]);
    });

    it('throws QUEUE_INVALID_POSITION for from=0', async () => {
      await manager.add({ type: 'template', templateName: 'a', prompt: '', targetPath: '/a' });
      await expect(manager.reorder(0, 1)).rejects.toMatchObject({
        code: ErrorCode.QUEUE_INVALID_POSITION,
      });
    });

    it('throws QUEUE_INVALID_POSITION for to out of range', async () => {
      await manager.add({ type: 'template', templateName: 'a', prompt: '', targetPath: '/a' });
      await expect(manager.reorder(1, 5)).rejects.toMatchObject({
        code: ErrorCode.QUEUE_INVALID_POSITION,
      });
    });

    it('throws QUEUE_INVALID_POSITION for negative from', async () => {
      await manager.add({ type: 'template', templateName: 'a', prompt: '', targetPath: '/a' });
      await expect(manager.reorder(-1, 1)).rejects.toMatchObject({
        code: ErrorCode.QUEUE_INVALID_POSITION,
      });
    });
  });

  // ── clear ─────────────────────────────────────────────────────────────────

  describe('clear()', () => {
    it('clears all tasks and returns the count', async () => {
      await manager.add({ type: 'template', templateName: 'a', prompt: '', targetPath: '/a' });
      await manager.add({ type: 'template', templateName: 'b', prompt: '', targetPath: '/b' });

      const count = await manager.clear();

      expect(count).toBe(2);
      const tasks = await manager.list();
      expect(tasks).toHaveLength(0);
    });

    it('returns 0 when queue is already empty', async () => {
      const count = await manager.clear();
      expect(count).toBe(0);
    });

    it('allows adding tasks after clear', async () => {
      await manager.add({ type: 'template', templateName: 'a', prompt: '', targetPath: '/a' });
      await manager.clear();
      const result = await manager.add({
        type: 'template',
        templateName: 'b',
        prompt: '',
        targetPath: '/b',
      });

      expect(result.position).toBe(1);
    });
  });

  // ── resetInProgressTasks ────────────────────────────────────────────────

  describe('resetInProgressTasks()', () => {
    it('resets all in-progress tasks to pending and returns count', async () => {
      const t1 = await manager.add({
        type: 'template',
        templateName: 'lint',
        prompt: '',
        targetPath: '/a',
      });
      const t2 = await manager.add({
        type: 'template',
        templateName: 'test',
        prompt: '',
        targetPath: '/b',
      });
      await manager.add({
        type: 'template',
        templateName: 'build',
        prompt: '',
        targetPath: '/c',
      });

      await manager.setTaskStatus(t1.task.id, 'in-progress');
      await manager.setTaskStatus(t2.task.id, 'in-progress');

      const count = await manager.resetInProgressTasks();

      expect(count).toBe(2);
      const tasks = await manager.list();
      expect(tasks[0]!.status).toBe('pending');
      expect(tasks[1]!.status).toBe('pending');
      expect(tasks[2]!.status).toBe('pending');
    });

    it('returns 0 when no tasks are in-progress', async () => {
      await manager.add({
        type: 'template',
        templateName: 'lint',
        prompt: '',
        targetPath: '/a',
      });

      const count = await manager.resetInProgressTasks();

      expect(count).toBe(0);
    });

    it('is a no-op on an empty queue', async () => {
      const count = await manager.resetInProgressTasks();

      expect(count).toBe(0);
    });

    it('does not affect tasks with other statuses', async () => {
      const t1 = await manager.add({
        type: 'template',
        templateName: 'lint',
        prompt: '',
        targetPath: '/a',
      });
      const t2 = await manager.add({
        type: 'template',
        templateName: 'test',
        prompt: '',
        targetPath: '/b',
      });
      const t3 = await manager.add({
        type: 'template',
        templateName: 'build',
        prompt: '',
        targetPath: '/c',
      });

      await manager.setTaskStatus(t1.task.id, 'done');
      await manager.setTaskStatus(t2.task.id, 'in-progress');
      await manager.setTaskStatus(t3.task.id, 'failed');

      const count = await manager.resetInProgressTasks();

      expect(count).toBe(1);
      const tasks = await manager.list();
      expect(tasks[0]!.status).toBe('done');
      expect(tasks[1]!.status).toBe('pending');
      expect(tasks[2]!.status).toBe('failed');
    });
  });

  // ── countInProgress ────────────────────────────────────────────────────

  describe('countInProgress()', () => {
    it('returns 0 when no tasks are in-progress', async () => {
      await manager.add({
        type: 'template',
        templateName: 'lint',
        prompt: '',
        targetPath: '/a',
      });

      const count = await manager.countInProgress();

      expect(count).toBe(0);
    });

    it('returns correct count when some tasks are in-progress', async () => {
      const t1 = await manager.add({
        type: 'template',
        templateName: 'lint',
        prompt: '',
        targetPath: '/a',
      });
      const t2 = await manager.add({
        type: 'template',
        templateName: 'test',
        prompt: '',
        targetPath: '/b',
      });
      await manager.add({
        type: 'template',
        templateName: 'build',
        prompt: '',
        targetPath: '/c',
      });

      await manager.setTaskStatus(t1.task.id, 'in-progress');
      await manager.setTaskStatus(t2.task.id, 'in-progress');

      const count = await manager.countInProgress();

      expect(count).toBe(2);
    });

    it('returns 0 on an empty queue', async () => {
      const count = await manager.countInProgress();

      expect(count).toBe(0);
    });
  });

  // ── countWorkload ──────────────────────────────────────────────────────

  describe('countWorkload()', () => {
    it('returns 0 on an empty queue', async () => {
      const count = await manager.countWorkload();

      expect(count).toBe(0);
    });

    it('counts only pending and failed_quota as dispatchable when no in-progress tasks', async () => {
      const t1 = await manager.add({
        type: 'template',
        templateName: 'lint',
        prompt: '',
        targetPath: '/a',
      });
      const t2 = await manager.add({
        type: 'template',
        templateName: 'test',
        prompt: '',
        targetPath: '/b',
      });
      await manager.add({
        type: 'template',
        templateName: 'build',
        prompt: '',
        targetPath: '/c',
      });

      await manager.setTaskStatus(t1.task.id, 'done');
      await manager.setTaskStatus(t2.task.id, 'failed_quota');

      // 1 pending + 1 failed_quota = 2 dispatchable; 0 in-progress
      const count = await manager.countWorkload();

      expect(count).toBe(2);
    });

    it('sums dispatchable and in-progress tasks atomically', async () => {
      const t1 = await manager.add({
        type: 'template',
        templateName: 'lint',
        prompt: '',
        targetPath: '/a',
      });
      const t2 = await manager.add({
        type: 'template',
        templateName: 'test',
        prompt: '',
        targetPath: '/b',
      });
      await manager.add({
        type: 'template',
        templateName: 'build',
        prompt: '',
        targetPath: '/c',
      });

      await manager.setTaskStatus(t1.task.id, 'in-progress');
      await manager.setTaskStatus(t2.task.id, 'done');

      // 1 pending + 1 in-progress = 2 total workload
      const count = await manager.countWorkload();

      expect(count).toBe(2);
    });

    it('returns 0 when all tasks are done or failed (no remaining workload)', async () => {
      const t1 = await manager.add({
        type: 'template',
        templateName: 'lint',
        prompt: '',
        targetPath: '/a',
      });
      const t2 = await manager.add({
        type: 'template',
        templateName: 'test',
        prompt: '',
        targetPath: '/b',
      });

      await manager.setTaskStatus(t1.task.id, 'done');
      await manager.setTaskStatus(t2.task.id, 'failed');

      const count = await manager.countWorkload();

      expect(count).toBe(0);
    });
  });

  // ── resetInProgressTasks (mixed-status) ──────────────────────────────────

  describe('resetInProgressTasks() mixed-status scenarios', () => {
    it('resets a task that transitioned failed_quota -> in-progress to pending on restart', async () => {
      // Simulate the crash-recovery scenario: a task was originally failed_quota, then a new
      // dispatch cycle set it to in-progress before the daemon crashed. On startup,
      // resetInProgressTasks() brings it back to pending so it can be retried.
      const t1 = await manager.add({
        type: 'template',
        templateName: 'lint',
        prompt: '',
        targetPath: '/a',
      });
      const t2 = await manager.add({
        type: 'template',
        templateName: 'test',
        prompt: '',
        targetPath: '/b',
      });

      // Simulate: t1 was failed_quota, then re-dispatched and set to in-progress before crash
      await manager.setTaskStatus(t1.task.id, 'failed_quota');
      await manager.setTaskStatus(t1.task.id, 'in-progress');
      // t2 is actively in-progress from a normal dispatch
      await manager.setTaskStatus(t2.task.id, 'in-progress');

      const count = await manager.resetInProgressTasks();

      expect(count).toBe(2);
      const tasks = await manager.list();
      // Both tasks reset to pending regardless of prior status — pending allows retry
      expect(tasks.find((t) => t.id === t1.task.id)!.status).toBe('pending');
      expect(tasks.find((t) => t.id === t2.task.id)!.status).toBe('pending');
    });
  });

  // ── pruneHistory ──────────────────────────────────────────────────────

  describe('pruneHistory()', () => {
    it('removes oldest historical tasks when count exceeds 50', async () => {
      // Add 52 tasks and set them all to 'done'
      const ids: string[] = [];
      for (let i = 0; i < 52; i++) {
        const result = await manager.add({
          type: 'template',
          templateName: `task-${i}`,
          prompt: '',
          targetPath: '/a',
        });
        ids.push(result.task.id);
      }
      // Set all to 'done' — pruneHistory will fire on each transition
      for (const id of ids) {
        await manager.setTaskStatus(id, 'done');
      }

      const tasks = await manager.list();
      const historical = tasks.filter(
        (t) => t.status === 'done' || t.status === 'failed' || t.status === 'skipped',
      );
      expect(historical.length).toBe(50);
    });

    it('does not affect live tasks during pruning', async () => {
      // Add 52 tasks: 51 done + 1 pending
      const ids: string[] = [];
      for (let i = 0; i < 52; i++) {
        const result = await manager.add({
          type: 'template',
          templateName: `task-${i}`,
          prompt: '',
          targetPath: '/a',
        });
        ids.push(result.task.id);
      }
      // Set 51 to done, leave last one as pending
      for (let i = 0; i < 51; i++) {
        await manager.setTaskStatus(ids[i]!, 'done');
      }

      const tasks = await manager.list();
      const pending = tasks.filter((t) => t.status === 'pending');
      const historical = tasks.filter(
        (t) => t.status === 'done' || t.status === 'failed' || t.status === 'skipped',
      );
      expect(pending.length).toBe(1);
      expect(historical.length).toBe(50);
    });

    it('is a no-op when historical count is exactly 50', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 50; i++) {
        const result = await manager.add({
          type: 'template',
          templateName: `task-${i}`,
          prompt: '',
          targetPath: '/a',
        });
        ids.push(result.task.id);
      }
      for (const id of ids) {
        await manager.setTaskStatus(id, 'done');
      }

      const tasks = await manager.list();
      const historical = tasks.filter((t) => t.status === 'done');
      expect(historical.length).toBe(50);
    });

    it('is a no-op when historical count is below 50', async () => {
      const result = await manager.add({
        type: 'template',
        templateName: 'lint',
        prompt: '',
        targetPath: '/a',
      });
      await manager.setTaskStatus(result.task.id, 'done');

      const tasks = await manager.list();
      expect(tasks.length).toBe(1);
      expect(tasks[0]!.status).toBe('done');
    });

    it('is called when transitioning to done', async () => {
      const result = await manager.add({
        type: 'template',
        templateName: 'lint',
        prompt: '',
        targetPath: '/a',
      });
      // Spy on _pruneHistory to verify it's called
      const spy = vi.spyOn(QueueManager, '_pruneHistory' as never);
      await manager.setTaskStatus(result.task.id, 'done');
      expect(spy).toHaveBeenCalled();
    });

    it('is called when transitioning to failed', async () => {
      const result = await manager.add({
        type: 'template',
        templateName: 'lint',
        prompt: '',
        targetPath: '/a',
      });
      const spy = vi.spyOn(QueueManager, '_pruneHistory' as never);
      await manager.setTaskStatus(result.task.id, 'failed');
      expect(spy).toHaveBeenCalled();
    });

    it('is called when transitioning to skipped', async () => {
      const result = await manager.add({
        type: 'template',
        templateName: 'lint',
        prompt: '',
        targetPath: '/a',
      });
      const spy = vi.spyOn(QueueManager, '_pruneHistory' as never);
      await manager.setTaskStatus(result.task.id, 'skipped');
      expect(spy).toHaveBeenCalled();
    });

    it('is NOT called when transitioning to pending', async () => {
      const result = await manager.add({
        type: 'template',
        templateName: 'lint',
        prompt: '',
        targetPath: '/a',
      });
      await manager.setTaskStatus(result.task.id, 'in-progress');
      const spy = vi.spyOn(QueueManager, '_pruneHistory' as never);
      await manager.setTaskStatus(result.task.id, 'pending');
      expect(spy).not.toHaveBeenCalled();
    });

    it('is NOT called when transitioning to in-progress', async () => {
      const result = await manager.add({
        type: 'template',
        templateName: 'lint',
        prompt: '',
        targetPath: '/a',
      });
      const spy = vi.spyOn(QueueManager, '_pruneHistory' as never);
      await manager.setTaskStatus(result.task.id, 'in-progress');
      expect(spy).not.toHaveBeenCalled();
    });

    it('is NOT called when transitioning to failed_quota', async () => {
      const result = await manager.add({
        type: 'template',
        templateName: 'lint',
        prompt: '',
        targetPath: '/a',
      });
      const spy = vi.spyOn(QueueManager, '_pruneHistory' as never);
      await manager.setTaskStatus(result.task.id, 'failed_quota');
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // ── remove (additional gap coverage) ────────────────────────────────────

  describe('remove() — additional edge cases', () => {
    it('removes the last position in a multi-item queue', async () => {
      await manager.add({ type: 'template', templateName: 'a', prompt: '', targetPath: '/a' });
      await manager.add({ type: 'template', templateName: 'b', prompt: '', targetPath: '/b' });
      await manager.add({ type: 'template', templateName: 'c', prompt: '', targetPath: '/c' });

      const removed = await manager.remove(3);

      expect(removed.templateName).toBe('c');
      const tasks = await manager.list();
      expect(tasks).toHaveLength(2);
      expect(tasks[0]!.templateName).toBe('a');
      expect(tasks[1]!.templateName).toBe('b');
      expect(tasks.map((t) => t.priority)).toEqual([1, 2]);
    });

    it('returns full TaskDefinition fields on removed task', async () => {
      const added = await manager.add({
        type: 'template',
        templateName: 'lint',
        prompt: 'check lint',
        targetPath: '/repo',
        timeoutMs: 5000,
      });

      const removed = await manager.remove(1);

      expect(removed.id).toBe(added.task.id);
      expect(removed.name).toBe('lint');
      expect(removed.type).toBe('template');
      expect(removed.status).toBe('pending');
      expect(removed.prompt).toBe('check lint');
      expect(removed.targetPath).toBe('/repo');
      expect(removed.timeoutMs).toBe(5000);
      expect(removed.priority).toBe(1);
      expect(removed.createdAt).toBeInstanceOf(Date);
    });

    it('setTaskStatus throws QUEUE_TASK_NOT_FOUND for a removed task real ID', async () => {
      const added = await manager.add({
        type: 'template',
        templateName: 'lint',
        prompt: '',
        targetPath: '/a',
      });
      const removedId = added.task.id;
      await manager.remove(1);

      await expect(manager.setTaskStatus(removedId, 'done')).rejects.toMatchObject({
        code: ErrorCode.QUEUE_TASK_NOT_FOUND,
      });
    });

    it('removeById removes the correct task by UUID regardless of store position', async () => {
      // Setup: add 3 tasks, mark first two as 'done' (historical)
      const t1 = await manager.add({
        type: 'template',
        templateName: 'old-done-1',
        prompt: '',
        targetPath: '/a',
      });
      const t2 = await manager.add({
        type: 'template',
        templateName: 'old-done-2',
        prompt: '',
        targetPath: '/b',
      });
      const t3 = await manager.add({
        type: 'template',
        templateName: 'pending-task',
        prompt: '',
        targetPath: '/c',
      });

      await manager.setTaskStatus(t1.task.id, 'done');
      await manager.setTaskStatus(t2.task.id, 'done');

      // removeById targets the correct task even when historical tasks precede it
      const removed = await manager.removeById(t3.task.id);
      expect(removed.name).toBe('pending-task');

      // The historical tasks remain, the pending task is gone
      const tasks = await manager.list();
      expect(tasks.find((t) => t.name === 'pending-task')).toBeUndefined();
      expect(tasks.find((t) => t.name === 'old-done-1')).toBeDefined();
      expect(tasks.find((t) => t.name === 'old-done-2')).toBeDefined();
    });

    it('removeById throws QUEUE_TASK_NOT_FOUND for unknown ID', async () => {
      await manager.add({
        type: 'template',
        templateName: 'task-a',
        prompt: '',
        targetPath: '/a',
      });

      await expect(manager.removeById('nonexistent-uuid')).rejects.toMatchObject({
        code: ErrorCode.QUEUE_TASK_NOT_FOUND,
      });
    });

    it('removeById normalizes priorities after removal', async () => {
      const t1 = await manager.add({
        type: 'template',
        templateName: 'task-a',
        prompt: '',
        targetPath: '/a',
      });
      await manager.add({
        type: 'template',
        templateName: 'task-b',
        prompt: '',
        targetPath: '/b',
      });
      const t3 = await manager.add({
        type: 'template',
        templateName: 'task-c',
        prompt: '',
        targetPath: '/c',
      });

      await manager.removeById(t1.task.id);
      const tasks = await manager.list();

      expect(tasks).toHaveLength(2);
      expect(tasks[0]!.name).toBe('task-b');
      expect(tasks[0]!.priority).toBe(1);
      expect(tasks[1]!.name).toBe('task-c');
      expect(tasks[1]!.priority).toBe(2);
    });
  });

  // ── reorder — ID stability ────────────────────────────────────────────────

  describe('reorder() — ID stability', () => {
    it('preserves task UUIDs after reorder (only priorities change)', async () => {
      const r1 = await manager.add({
        type: 'template',
        templateName: 'a',
        prompt: '',
        targetPath: '/a',
      });
      const r2 = await manager.add({
        type: 'template',
        templateName: 'b',
        prompt: '',
        targetPath: '/b',
      });
      const r3 = await manager.add({
        type: 'template',
        templateName: 'c',
        prompt: '',
        targetPath: '/c',
      });

      const originalIds = new Set([r1.task.id, r2.task.id, r3.task.id]);
      const updated = await manager.reorder(1, 3);
      const reorderedIds = new Set(updated.map((t) => t.id));

      expect(reorderedIds).toEqual(originalIds);
      // Verify specific: task 'a' moved to end still has same ID
      expect(updated[2]!.id).toBe(r1.task.id);
      expect(updated[2]!.templateName).toBe('a');
    });
  });

  // ── pruneHistory — specificity ────────────────────────────────────────────

  describe('pruneHistory() — removal specificity', () => {
    it('removes the oldest historical tasks by createdAt (not newest)', async () => {
      // Add 52 tasks with distinct createdAt times
      const ids: string[] = [];
      const names: string[] = [];
      for (let i = 0; i < 52; i++) {
        const result = await manager.add({
          type: 'template',
          templateName: `task-${String(i).padStart(2, '0')}`,
          prompt: '',
          targetPath: '/a',
        });
        ids.push(result.task.id);
        names.push(result.task.name);
      }
      // Set all to 'done' — oldest are task-00, task-01
      for (const id of ids) {
        await manager.setTaskStatus(id, 'done');
      }

      const tasks = await manager.list();
      const remaining = tasks.map((t) => t.name);

      // The 2 oldest (task-00, task-01) should have been pruned
      expect(remaining).not.toContain('task-00');
      expect(remaining).not.toContain('task-01');
      // The newest should still be present
      expect(remaining).toContain('task-51');
      expect(remaining).toContain('task-50');
    });
  });

  // ── concurrency ────────────────────────────────────────────────────────

  describe('concurrency', () => {
    it('serializes concurrent add calls without lost updates', async () => {
      const results = await Promise.all([
        manager.add({ type: 'template', templateName: 'a', prompt: '', targetPath: '/a' }),
        manager.add({ type: 'template', templateName: 'b', prompt: '', targetPath: '/b' }),
        manager.add({ type: 'template', templateName: 'c', prompt: '', targetPath: '/c' }),
      ]);

      const tasks = await manager.list();
      expect(tasks).toHaveLength(3);
      expect(tasks.map((t) => t.priority)).toEqual([1, 2, 3]);

      // All three distinct IDs present
      const ids = new Set(results.map((r) => r.task.id));
      expect(ids.size).toBe(3);
    });
  });

  // ── priority invariants ──────────────────────────────────────────────────

  describe('priority invariants', () => {
    it('priorities are contiguous starting at 1 after add', async () => {
      await manager.add({ type: 'template', templateName: 'a', prompt: '', targetPath: '/a' });
      await manager.add({ type: 'template', templateName: 'b', prompt: '', targetPath: '/b' });
      await manager.add({ type: 'template', templateName: 'c', prompt: '', targetPath: '/c' });

      const tasks = await manager.list();
      expect(tasks.map((t) => t.priority)).toEqual([1, 2, 3]);
    });

    it('priorities are contiguous after remove', async () => {
      await manager.add({ type: 'template', templateName: 'a', prompt: '', targetPath: '/a' });
      await manager.add({ type: 'template', templateName: 'b', prompt: '', targetPath: '/b' });
      await manager.add({ type: 'template', templateName: 'c', prompt: '', targetPath: '/c' });
      await manager.remove(1);

      const tasks = await manager.list();
      expect(tasks.map((t) => t.priority)).toEqual([1, 2]);
    });
  });
});
