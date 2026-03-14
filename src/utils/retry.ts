/** Shared retry utility with exponential backoff and jitter. */
import { ScrowError } from '../errors/index.js';

export interface RetryOptions {
  maxRetries?: number; // default 3
  baseDelayMs?: number; // default 1000ms
  maxDelayMs?: number; // default 30000ms
  retryOn?: (error: Error) => boolean; // default: retry on network errors (ECONNREFUSED, ETIMEDOUT, ENOTFOUND, fetch TypeError) only
}

function defaultRetryOn(error: Error): boolean {
  // Retry on network errors
  if (error instanceof TypeError && error.message.includes('fetch')) return true;
  if ('code' in error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ENOTFOUND') return true;
  }
  // ScrowError instances represent classified business errors — never retry by default
  if (error instanceof ScrowError) return false;
  return false;
}

function jitter(ms: number): number {
  return ms * (0.75 + Math.random() * 0.5); // ±25% jitter
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    retryOn = defaultRetryOn,
  } = options;

  let lastError!: Error;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt === maxRetries || !retryOn(lastError)) {
        throw lastError;
      }
      const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      await new Promise((resolve) => setTimeout(resolve, jitter(delay)));
    }
  }

  throw lastError!;
}
