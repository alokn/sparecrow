/** Unit tests for shared type guard utilities. */
import { describe, it, expect } from 'vitest';
import { isRecord } from './type-guards.js';

describe('isRecord()', () => {
  it('returns true for a plain object', () => {
    expect(isRecord({ key: 'value' })).toBe(true);
  });

  it('returns true for an empty object', () => {
    expect(isRecord({})).toBe(true);
  });

  it('returns true for an object with nested properties', () => {
    expect(isRecord({ a: { b: 1 }, c: [1, 2] })).toBe(true);
  });

  it('returns true for Object.create(null)', () => {
    expect(isRecord(Object.create(null) as unknown)).toBe(true);
  });

  it('returns false for null', () => {
    expect(isRecord(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isRecord(undefined)).toBe(false);
  });

  it('returns false for an array', () => {
    expect(isRecord([1, 2, 3])).toBe(false);
  });

  it('returns false for an empty array', () => {
    expect(isRecord([])).toBe(false);
  });

  it('returns false for a string', () => {
    expect(isRecord('hello')).toBe(false);
  });

  it('returns false for a number', () => {
    expect(isRecord(42)).toBe(false);
  });

  it('returns false for a boolean', () => {
    expect(isRecord(true)).toBe(false);
  });

  it('returns false for a function', () => {
    expect(isRecord(() => undefined)).toBe(false);
  });

  it('returns false for a symbol', () => {
    expect(isRecord(Symbol('test'))).toBe(false);
  });

  it('returns false for a bigint', () => {
    expect(isRecord(BigInt(9007199254740991))).toBe(false);
  });

  it('narrows the type to Record<string, unknown>', () => {
    const value: unknown = { foo: 'bar' };
    if (isRecord(value)) {
      // TypeScript should allow property access after narrowing
      const result: unknown = value['foo'];
      expect(result).toBe('bar');
    } else {
      throw new Error('Expected isRecord to return true');
    }
  });
});
