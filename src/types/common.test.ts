/** Unit tests for JsonResponse utility functions. */
import { describe, it, expect } from 'vitest';
import { jsonOk, jsonError } from './common.js';

describe('jsonOk()', () => {
  it('returns ok:true with data and null error', () => {
    const result = jsonOk({ value: 42 });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ value: 42 });
    expect(result.error).toBeNull();
  });

  it('works with string data', () => {
    const result = jsonOk('hello');
    expect(result.ok).toBe(true);
    expect(result.data).toBe('hello');
  });

  it('works with null data', () => {
    const result = jsonOk(null);
    expect(result.ok).toBe(true);
    expect(result.data).toBeNull();
  });
});

describe('jsonError()', () => {
  it('returns ok:false with null data and error details', () => {
    const result = jsonError('CONFIG_INVALID', 'Bad config');
    expect(result.ok).toBe(false);
    expect(result.data).toBeNull();
    expect(result.error).toEqual({ code: 'CONFIG_INVALID', message: 'Bad config' });
  });

  it('preserves error code and message exactly', () => {
    const result = jsonError('AUTH_FAILED', 'Token expired');
    expect(result.error?.code).toBe('AUTH_FAILED');
    expect(result.error?.message).toBe('Token expired');
  });
});
