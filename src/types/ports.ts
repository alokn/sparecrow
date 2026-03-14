/** Port seam interfaces shared across module boundaries. */

/**
 * Seam contract for re-queuing tasks that fail due to quota exhaustion.
 * The executor calls this when a task exits with failed_quota status.
 */
export interface RequeuePort {
  requeue(taskId: string): Promise<void>;
}

/**
 * No-op adapter satisfying RequeuePort contract.
 * Used in contract tests and as a placeholder where real re-queue logic is not needed.
 */
export class NoOpRequeueAdapter implements RequeuePort {
  async requeue(_taskId: string): Promise<void> {
    // No-op: quota re-queue is handled directly by the Dispatcher via queueManager.setTaskStatus
  }
}
