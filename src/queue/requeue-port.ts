/** RequeuePort — seam interface for re-queuing quota-exhausted tasks. Re-exports from types. */

// The canonical definitions live in src/types/ports.ts to keep the providers module DAG-compliant.
// The queue module re-exports them here for consumers that import from the queue barrel.
export type { RequeuePort } from '../types/index.js';
export { NoOpRequeueAdapter } from '../types/index.js';
