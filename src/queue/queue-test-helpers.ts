/** Shared test helpers for queue-related unit tests. */
import type { QueueManager } from './queue-manager.js';

/**
 * Transitions a pending task to a terminal/non-pending status through valid intermediate states.
 * Extracted as a shared helper to avoid duplication between queue-manager.test.ts and queue.test.ts.
 */
export async function transitionTo(
  mgr: QueueManager,
  taskId: string,
  target: 'done' | 'failed' | 'failed_quota' | 'skipped',
): Promise<void> {
  if (target === 'skipped') {
    await mgr.setTaskStatus(taskId, 'skipped');
    return;
  }
  await mgr.setTaskStatus(taskId, 'in-progress');
  await mgr.setTaskStatus(taskId, target);
}
