/** Utils module barrel — re-exports all foundational utilities. */

export { retryWithBackoff } from './retry.js';
export type { RetryOptions } from './retry.js';

export { logger, setLogLevel, enableFileLogging, setLogDir, resetLoggerState } from './logger.js';
export type { LogLevel, AuditRecord, AuditMeta } from '../types/index.js';

export { atomicWrite, safeReadJson, AUDIT_LOG_FILENAME_REGEX } from './fs.js';

export { isRecord } from './type-guards.js';

export { VERSION } from './version.js';

export {
  spawnWithGuardrails,
  boundOutput,
  MAX_OUTPUT_BYTES,
  MAX_OUTPUT_BYTES_SUCCESS,
} from './process.js';
export type { SpawnGuardrailOptions, SpawnGuardrailResult } from './process.js';

export { validateRepository } from './repo-validation.js';
export type { RepoValidationResult } from './repo-validation.js';
