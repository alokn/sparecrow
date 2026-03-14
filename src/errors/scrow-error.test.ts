/** Unit tests for the ScrowError class. */
import { describe, it, expect } from 'vitest';
import { ScrowError } from './scrow-error.js';
import { ErrorCode } from './error-codes.js';

describe('ScrowError', () => {
  it('sets code, message, and name correctly', () => {
    const err = new ScrowError(ErrorCode.CONFIG_INVALID, 'bad value');
    expect(err.code).toBe('CONFIG_INVALID');
    expect(err.message).toBe('bad value');
    expect(err.name).toBe('ScrowError');
  });

  it('passes instanceof checks after prototype fix', () => {
    const err = new ScrowError(ErrorCode.QUEUE_EMPTY, 'empty');
    expect(err instanceof ScrowError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });

  it('preserves cause chain', () => {
    const cause = new Error('original');
    const err = new ScrowError(ErrorCode.PROVIDER_UNREACHABLE, 'wrapped', cause);
    expect(err.cause).toBe(cause);
  });

  it('has undefined cause when not provided', () => {
    const err = new ScrowError(ErrorCode.CONFIG_INVALID, 'no cause');
    expect(err.cause).toBeUndefined();
  });

  it('does not expose credentials in message', () => {
    // Developers must never pass tokens in the message — this test documents the rule
    const err = new ScrowError(ErrorCode.AUTH_TOKEN_EXPIRED, 'Token expired');
    expect(err.message).not.toMatch(/eyJ|Bearer|sk-ant/); // no token patterns
  });

  it('has a stack trace', () => {
    const err = new ScrowError(ErrorCode.CONFIG_INVALID, 'test');
    expect(err.stack).toBeDefined();
    expect(typeof err.stack).toBe('string');
  });
});
