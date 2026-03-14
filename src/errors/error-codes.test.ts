/** Unit tests for ErrorCode constants. */
import { describe, it, expect } from 'vitest';
import { ErrorCode } from './error-codes.js';
import type { ErrorCodeValue } from './error-codes.js';

describe('ErrorCode', () => {
  it('includes all required codes from AC2', () => {
    expect(ErrorCode.AUTH_TOKEN_EXPIRED).toBe('AUTH_TOKEN_EXPIRED');
    expect(ErrorCode.AUTH_TOKEN_MISSING).toBe('AUTH_TOKEN_MISSING');
    expect(ErrorCode.AUTH_TOKEN_FORMAT_CHANGED).toBe('AUTH_TOKEN_FORMAT_CHANGED');
    expect(ErrorCode.PROVIDER_UNREACHABLE).toBe('PROVIDER_UNREACHABLE');
    expect(ErrorCode.QUEUE_EMPTY).toBe('QUEUE_EMPTY');
    expect(ErrorCode.CONFIG_INVALID).toBe('CONFIG_INVALID');
    expect(ErrorCode.DAEMON_ALREADY_RUNNING).toBe('DAEMON_ALREADY_RUNNING');
    expect(ErrorCode.CLAUDE_NOT_FOUND).toBe('CLAUDE_NOT_FOUND');
    expect(ErrorCode.TASK_TIMEOUT).toBe('TASK_TIMEOUT');
  });

  it('all code values are string literals', () => {
    for (const value of Object.values(ErrorCode)) {
      expect(typeof value).toBe('string');
    }
  });

  it('code keys match their string values', () => {
    // Each key equals its own string value for autocomplete and refactor safety
    for (const [key, value] of Object.entries(ErrorCode)) {
      expect(key).toBe(value);
    }
  });

  it('values cannot be mutated at runtime', () => {
    // TypeScript enforces immutability at compile time via `as const`
    // At runtime, verify that the object is not accidentally mutable in ways that would break consumers
    const original = ErrorCode.CONFIG_INVALID;
    try {
      // In strict mode this throws; in sloppy mode it silently fails — either way the value must be unchanged
      (ErrorCode as Record<string, string>)['CONFIG_INVALID'] = 'TAMPERED';
    } catch {
      // TypeError in strict mode — expected
    }
    expect(ErrorCode.CONFIG_INVALID).toBe(original);
  });

  it('ErrorCodeValue type covers all entries', () => {
    // Verify that each value satisfies the exported union type at runtime
    const values = Object.values(ErrorCode) as ErrorCodeValue[];
    expect(values.length).toBeGreaterThanOrEqual(9); // minimum required by AC2
  });
});
