/** QueuePort — seam interface for queue operations used by CLI commands. */
import type { TaskDefinition } from '../types/index.js';

/**
 * Seam contract for queue operations.
 * CLI commands depend on this interface; the real implementation is QueueManager (Story 3.2).
 * An in-memory stub is provided for contract testing and environments where
 * the full queue persistence stack is unavailable.
 */
export interface QueuePort {
  enqueue(task: TaskDefinition): Promise<{ position: number }>;
  nextIndex(): Promise<number>;
}

/**
 * In-memory stub adapter satisfying QueuePort contract.
 * Used in contract tests and as a fallback seam when QueueManager is not wired.
 */
export class InMemoryQueueAdapter implements QueuePort {
  private readonly _tasks: TaskDefinition[] = [];

  async enqueue(task: TaskDefinition): Promise<{ position: number }> {
    this._tasks.push(task);
    return { position: this._tasks.length };
  }

  async nextIndex(): Promise<number> {
    return this._tasks.length + 1;
  }
}
