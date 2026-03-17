/** Custom error class with typed error codes for structured error handling. */
import type { ErrorCodeValue } from './error-codes.js';

/**
 * Typed error class used throughout sparecrow for structured error handling.
 *
 * Every error thrown in the application must be a `ScrowError` with a typed
 * {@link ErrorCodeValue} so that CLI commands can produce deterministic exit
 * codes and JSON error envelopes.
 *
 * @example
 * ```ts
 * // Import ErrorCode from the errors barrel to get typed error codes:
 * // import { ErrorCode } from './errors/index.js';
 * throw new ScrowError('CONFIG_INVALID', 'polling_interval must be >= 60');
 * ```
 */
export class ScrowError extends Error {
  /**
   * @param code - Typed error code from {@link ErrorCodeValue} for programmatic handling.
   * @param message - Human-readable description of the error.
   * @param cause - Optional underlying error that triggered this one.
   */
  constructor(
    public readonly code: ErrorCodeValue,
    message: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'ScrowError';
    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
