/** Queue business logic: list/add/remove/reorder/clear with priority normalization. */
import { randomUUID } from 'node:crypto';
import type { TaskDefinition, TaskStatus, QueueDispatchPort, ActionType } from '../types/index.js';
import { ScrowError, ErrorCode } from '../errors/index.js';
import { logger } from '../utils/index.js';
import type { QueueStore } from './queue-store.js';
import { DEFAULT_TIMEOUT_MS } from './queue-store.js';

export interface AddTaskOptions {
  type: 'template' | 'custom';
  /** Explicit display name for the task. For custom tasks, defaults to `custom-<N>`. */
  name?: string;
  templateName?: string;
  /** Prompt text — never logged to prevent accidental secret exposure. */
  prompt: string;
  targetPath: string;
  timeoutMs?: number;
  /** Declared action types from the template manifest. Defaults to [] when not provided. */
  actions?: ReadonlyArray<ActionType>;
}

export interface AddTaskResult {
  task: TaskDefinition;
  /** 1-based position in the queue after insertion. */
  position: number;
}

export interface PauseResumeResult {
  paused: boolean;
  changed: boolean;
}

/** Normalizes priorities to contiguous integers starting at 1, based on array order. */
function normalizePriorities(tasks: TaskDefinition[]): TaskDefinition[] {
  return tasks.map((task, idx) => ({ ...task, priority: idx + 1 }));
}

/**
 * Computes the next auto-generated custom task index using max-existing-N + 1.
 * Uses the maximum existing custom-<N> index rather than queue length to avoid
 * duplicate names after task removals.
 */
export function nextCustomIndex(tasks: ReadonlyArray<{ name: string }>): number {
  let max = 0;
  for (const task of tasks) {
    const match = /^custom-(\d+)$/.exec(task.name);
    if (match) {
      max = Math.max(max, parseInt(match[1]!, 10));
    }
  }
  return max + 1;
}

/**
 * Valid task status transitions. Terminal states (done, failed, skipped) have no outgoing transitions.
 * Note: in-progress -> pending is handled by resetInProgressTasks() which bypasses setTaskStatus().
 * Note: Self-transitions (e.g. pending -> pending) are not listed and will be rejected as invalid.
 */
export const VALID_TRANSITIONS: Readonly<Record<TaskStatus, ReadonlySet<TaskStatus>>> = {
  pending: new Set<TaskStatus>(['in-progress', 'skipped']),
  'in-progress': new Set<TaskStatus>(['done', 'failed', 'failed_quota']),
  failed_quota: new Set<TaskStatus>(['in-progress', 'pending']),
  done: new Set<TaskStatus>(),
  failed: new Set<TaskStatus>(),
  skipped: new Set<TaskStatus>(),
};

/** Throws QUEUE_INVALID_TRANSITION if the from -> to status transition is not allowed. */
function assertValidTransition(from: TaskStatus, to: TaskStatus): void {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed.has(to)) {
    const validTargets = [...allowed];
    const hint =
      validTargets.length > 0
        ? ` Valid targets from '${from}': ${validTargets.join(', ')}`
        : ` '${from}' is a terminal state with no valid outgoing transitions.`;
    throw new ScrowError(
      ErrorCode.QUEUE_INVALID_TRANSITION,
      `Invalid task status transition: ${from} -> ${to}.${hint}`,
    );
  }
}

/** Throws QUEUE_INVALID_POSITION if position is not a valid 1-based queue index. */
function assertValidPosition(position: number, queueLength: number): void {
  if (!Number.isInteger(position) || position < 1 || position > queueLength) {
    throw new ScrowError(
      ErrorCode.QUEUE_INVALID_POSITION,
      `Invalid position ${position}: must be between 1 and ${queueLength}.`,
    );
  }
}

/** Manages all queue mutations; delegates persistence to QueueStore. Serializes mutations via async lock. */
export class QueueManager implements QueueDispatchPort {
  private _lockPromise: Promise<void> = Promise.resolve();

  constructor(private readonly store: QueueStore) {}

  /** Acquires a serial lock — concurrent callers wait for prior mutation to complete. */
  private _withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this._lockPromise.then(fn, fn);
    this._lockPromise = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  /** Returns all queued tasks in priority order. */
  async list(): Promise<TaskDefinition[]> {
    return this._withLock(async () => {
      const { tasks } = await this.store.read();
      return tasks;
    });
  }

  /** Returns tasks eligible for dispatch (`pending` and `failed_quota`) in priority order. If paused, returns []. */
  async listDispatchable(): Promise<TaskDefinition[]> {
    return this._withLock(async () => {
      const { tasks, paused } = await this.store.read();
      if (paused) {
        return [];
      }
      return tasks.filter((task) => task.status === 'pending' || task.status === 'failed_quota');
    });
  }

  /** Returns whether the queue is currently paused. */
  async isPaused(): Promise<boolean> {
    return this._withLock(async () => {
      const { paused } = await this.store.read();
      return paused;
    });
  }

  /** Pauses task dispatch. Returns { paused: true, changed: true } if state changed, or { paused: true, changed: false } if already paused. */
  async pause(): Promise<PauseResumeResult> {
    return this._withLock(async () => {
      const { tasks, paused } = await this.store.read();
      if (paused) {
        return { paused: true, changed: false };
      }
      await this.store.write({ tasks, paused: true });
      void logger.info('queue.paused', {});
      return { paused: true, changed: true };
    });
  }

  /** Resumes task dispatch. Returns { paused: false, changed: true } if state changed, or { paused: false, changed: false } if already resumed. */
  async resume(): Promise<PauseResumeResult> {
    return this._withLock(async () => {
      const { tasks, paused } = await this.store.read();
      if (!paused) {
        return { paused: false, changed: false };
      }
      await this.store.write({ tasks, paused: false });
      void logger.info('queue.resumed', {});
      return { paused: false, changed: true };
    });
  }

  /** Appends a new task to the end of the queue. */
  async add(opts: AddTaskOptions): Promise<AddTaskResult> {
    return this._withLock(async () => {
      const { tasks, paused } = await this.store.read();

      const id = randomUUID();
      const name =
        opts.name ??
        (opts.type === 'template'
          ? (opts.templateName ?? 'Unknown Template')
          : `custom-${nextCustomIndex(tasks)}`);

      const newTask: TaskDefinition = {
        id,
        name,
        type: opts.type,
        ...(opts.templateName !== undefined ? { templateName: opts.templateName } : {}),
        status: 'pending',
        prompt: opts.prompt,
        targetPath: opts.targetPath,
        priority: tasks.length + 1,
        createdAt: new Date(),
        timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        actions: opts.actions ?? [],
      };

      const updated = normalizePriorities([...tasks, newTask]);
      await this.store.write({ tasks: updated, paused });

      void logger.info('queue.task_added', { id, type: opts.type, targetPath: opts.targetPath });

      const position = updated.length;
      return { task: updated[position - 1]!, position };
    });
  }

  /** Removes the task at the given 1-based position. Returns the removed task. */
  async remove(position: number): Promise<TaskDefinition> {
    return this._withLock(async () => {
      const { tasks, paused } = await this.store.read();
      assertValidPosition(position, tasks.length);

      const idx = position - 1;
      const removed = tasks[idx]!;
      const remaining = [...tasks.slice(0, idx), ...tasks.slice(idx + 1)];
      const updated = normalizePriorities(remaining);

      await this.store.write({ tasks: updated, paused });
      void logger.info('queue.task_removed', { id: removed.id, position });
      return removed;
    });
  }

  /** Updates the persisted status of a task by ID. */
  async setTaskStatus(taskId: string, status: TaskStatus): Promise<void> {
    return this._withLock(async () => {
      const { tasks, paused } = await this.store.read();
      const taskIndex = tasks.findIndex((task) => task.id === taskId);

      if (taskIndex < 0) {
        throw new ScrowError(ErrorCode.QUEUE_TASK_NOT_FOUND, `Task not found in queue: ${taskId}`);
      }

      assertValidTransition(tasks[taskIndex]!.status, status);

      const isTerminal = status === 'done' || status === 'failed' || status === 'skipped';
      let updated = tasks.map((task, index) =>
        index === taskIndex
          ? { ...task, status, ...(isTerminal ? { completedAt: new Date() } : {}) }
          : task,
      );

      // Story 10.12 AC5: Auto-purge historical entries when transitioning to a terminal state
      if (isTerminal) {
        updated = QueueManager._pruneHistory(updated);
      }

      await this.store.write({ tasks: updated, paused });
      void logger.info('queue.task_status_updated', { id: taskId, status });
    });
  }

  /** Historical task statuses eligible for auto-purge. */
  private static readonly HISTORY_STATUSES = new Set<string>(['done', 'failed', 'skipped']);

  /** Maximum number of historical tasks to retain. */
  private static readonly HISTORY_CAP = 50;

  /** Removes oldest historical tasks when count exceeds HISTORY_CAP. */
  private static _pruneHistory(tasks: TaskDefinition[]): TaskDefinition[] {
    const historical = tasks.filter((t) => QueueManager.HISTORY_STATUSES.has(t.status));
    if (historical.length <= QueueManager.HISTORY_CAP) return tasks;

    // Sort historical tasks by createdAt ascending (oldest first)
    const sorted = [...historical].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    const toRemove = sorted.length - QueueManager.HISTORY_CAP;
    const removeIds = new Set(sorted.slice(0, toRemove).map((t) => t.id));

    return tasks.filter((t) => !removeIds.has(t.id));
  }

  /** Removes the task with the given ID. Returns the removed task. */
  async removeById(taskId: string): Promise<TaskDefinition> {
    return this._withLock(async () => {
      const { tasks, paused } = await this.store.read();
      const idx = tasks.findIndex((t) => t.id === taskId);

      if (idx < 0) {
        throw new ScrowError(ErrorCode.QUEUE_TASK_NOT_FOUND, `Task not found in queue: ${taskId}`);
      }

      const removed = tasks[idx]!;
      const remaining = [...tasks.slice(0, idx), ...tasks.slice(idx + 1)];
      const updated = normalizePriorities(remaining);

      await this.store.write({ tasks: updated, paused });
      void logger.info('queue.task_removed', { id: removed.id });
      return removed;
    });
  }

  /** Moves the task at position `from` to position `to` (both 1-based). No-op when from === to. */
  async reorder(from: number, to: number): Promise<TaskDefinition[]> {
    return this._withLock(async () => {
      const { tasks, paused } = await this.store.read();
      assertValidPosition(from, tasks.length);
      assertValidPosition(to, tasks.length);

      if (from === to) {
        return tasks;
      }

      const reordered = [...tasks];
      const [moved] = reordered.splice(from - 1, 1);
      reordered.splice(to - 1, 0, moved!);

      const updated = normalizePriorities(reordered);
      await this.store.write({ tasks: updated, paused });
      void logger.info('queue.task_reordered', { from, to });
      return updated;
    });
  }

  /** Resets all in-progress tasks back to pending. Returns the count of tasks reset.
   *  Used on daemon startup to recover from crash-during-execution scenarios (Story 10.9 AC3). */
  async resetInProgressTasks(): Promise<number> {
    return this._withLock(async () => {
      const { tasks, paused } = await this.store.read();
      const inProgress = tasks.filter((task) => task.status === 'in-progress');
      if (inProgress.length === 0) {
        return 0;
      }
      const updated = tasks.map((task) =>
        task.status === 'in-progress' ? { ...task, status: 'pending' as const } : task,
      );
      await this.store.write({ tasks: updated, paused });
      return inProgress.length;
    });
  }

  /** Returns the count of tasks currently in-progress (Story 10.9 AC5). */
  async countInProgress(): Promise<number> {
    return this._withLock(async () => {
      const { tasks } = await this.store.read();
      return tasks.filter((task) => task.status === 'in-progress').length;
    });
  }

  /**
   * Atomically returns the total "remaining workload" count — the number of dispatchable tasks
   * (pending / failed_quota) plus in-progress tasks — under a single lock acquisition.
   * Used by `getQueueDepth` in runner.ts to avoid a TOCTOU window between two separate
   * lock acquisitions (Story 10.9 AC5). When the queue is paused, dispatchable tasks count as 0
   * but in-progress tasks (already executing) are still included.
   */
  async countWorkload(): Promise<number> {
    return this._withLock(async () => {
      const { tasks, paused } = await this.store.read();
      const dispatchable = paused
        ? 0
        : tasks.filter((t) => t.status === 'pending' || t.status === 'failed_quota').length;
      const inProgress = tasks.filter((t) => t.status === 'in-progress').length;
      return dispatchable + inProgress;
    });
  }

  /** Removes all tasks and returns the count of tasks that were cleared. */
  async clear(): Promise<number> {
    return this._withLock(async () => {
      const { tasks, paused } = await this.store.read();
      const count = tasks.length;
      await this.store.write({ tasks: [], paused });
      void logger.info('queue.cleared', { count });
      return count;
    });
  }
}
