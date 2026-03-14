/** Queue module barrel — exports store, manager, schema types, and port seam for cross-module use. */

export { QueueStore, DEFAULT_TIMEOUT_MS } from './queue-store.js';
export { QueueManager, nextCustomIndex } from './queue-manager.js';
export type { AddTaskOptions, AddTaskResult, PauseResumeResult } from './queue-manager.js';
export { QueuePayloadSchema, PersistedTaskSchema } from './queue-schema.js';
export type { PersistedTask, QueuePayload } from './queue-schema.js';
export type { QueuePort } from './queue-port.js';
export { InMemoryQueueAdapter } from './queue-port.js';

export type { RequeuePort } from './requeue-port.js';
export { NoOpRequeueAdapter } from './requeue-port.js';

export {
  writeResultArtifact,
  formatTimestamp,
  buildFilename,
  buildFrontmatter,
  buildResultContent,
  ensureGitignore,
  formatDispatchNotification,
  toRelativePath,
  SCROW_DIR,
} from './result-writer.js';
export type { ResultArtifactInput, ResultArtifactOutput } from './result-writer.js';
