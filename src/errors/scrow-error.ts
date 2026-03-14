/** Custom error class with typed error codes for structured error handling. */
import type { ErrorCodeValue } from './error-codes.js';

export class ScrowError extends Error {
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
