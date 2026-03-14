/** Errors module barrel — exports ScrowError class, ErrorCode constants, and user messages. */

export { ScrowError } from './scrow-error.js';
export { ErrorCode } from './error-codes.js';
export type { ErrorCodeValue } from './error-codes.js';
export { getErrorMessage } from './messages.js';
export type { ErrorUserMessage } from './messages.js';
