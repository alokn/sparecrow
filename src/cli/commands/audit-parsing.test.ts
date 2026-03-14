/** Unit tests for audit-parsing helpers: asString, asNumber, asAuditRecord. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asString, asNumber, asAuditRecord } from './audit-parsing.js';

describe('asString', () => {
  it('returns a non-empty string unchanged', () => {
    expect(asString('hello')).toBe('hello');
  });

  it('returns null for an empty string', () => {
    expect(asString('')).toBeNull();
  });

  it('returns null for null', () => {
    expect(asString(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(asString(undefined)).toBeNull();
  });

  it('returns null for a number', () => {
    expect(asString(42)).toBeNull();
  });

  it('returns null for an object', () => {
    expect(asString({ key: 'value' })).toBeNull();
  });

  it('returns null for an array', () => {
    expect(asString(['a', 'b'])).toBeNull();
  });

  it('returns null for a boolean', () => {
    expect(asString(true)).toBeNull();
  });

  it('returns a whitespace-only string (length > 0)', () => {
    // A string of spaces has length > 0 so it is returned as-is
    expect(asString('   ')).toBe('   ');
  });
});

describe('asNumber', () => {
  it('returns a finite integer', () => {
    expect(asNumber(42)).toBe(42);
  });

  it('returns a finite float', () => {
    expect(asNumber(3.14)).toBe(3.14);
  });

  it('returns zero', () => {
    expect(asNumber(0)).toBe(0);
  });

  it('returns a negative finite number', () => {
    expect(asNumber(-5.5)).toBe(-5.5);
  });

  it('returns null for Infinity', () => {
    expect(asNumber(Infinity)).toBeNull();
  });

  it('returns null for -Infinity', () => {
    expect(asNumber(-Infinity)).toBeNull();
  });

  it('returns null for NaN', () => {
    expect(asNumber(NaN)).toBeNull();
  });

  it('returns null for a numeric string', () => {
    expect(asNumber('42')).toBeNull();
  });

  it('returns null for null', () => {
    expect(asNumber(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(asNumber(undefined)).toBeNull();
  });

  it('returns null for an object', () => {
    expect(asNumber({})).toBeNull();
  });
});

describe('asAuditRecord', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('parses a fully-populated valid record', () => {
    const input = {
      ts: '2026-01-15T09:00:00.000Z',
      level: 'info',
      event: 'usage.polled',
      data: { weeklyUtilization: 0.4 },
      provider: 'claude-code',
      source: 'oauth',
      confidence: 'high',
      error: null,
    };
    const result = asAuditRecord(input);
    expect(result).not.toBeNull();
    expect(result!.ts).toBe('2026-01-15T09:00:00.000Z');
    expect(result!.level).toBe('info');
    expect(result!.event).toBe('usage.polled');
    expect(result!.data).toEqual({ weeklyUtilization: 0.4 });
    expect(result!.provider).toBe('claude-code');
    expect(result!.source).toBe('oauth');
    expect(result!.confidence).toBe('high');
    expect(result!.error).toBeNull();
  });

  it('returns null for a non-object (string input)', () => {
    expect(asAuditRecord('not an object')).toBeNull();
  });

  it('returns null for null', () => {
    expect(asAuditRecord(null)).toBeNull();
  });

  it('returns null for an array', () => {
    expect(asAuditRecord([1, 2, 3])).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(asAuditRecord(undefined)).toBeNull();
  });

  it('defaults ts to current ISO timestamp when missing', () => {
    const result = asAuditRecord({ level: 'info', event: 'test', data: {} });
    expect(result).not.toBeNull();
    expect(result!.ts).toBe('2026-01-15T10:00:00.000Z');
  });

  it('defaults level to "info" when missing', () => {
    const result = asAuditRecord({ ts: '2026-01-15T09:00:00.000Z', event: 'test', data: {} });
    expect(result).not.toBeNull();
    expect(result!.level).toBe('info');
  });

  it('defaults level to "info" for an invalid level value', () => {
    const result = asAuditRecord({
      ts: '2026-01-15T09:00:00.000Z',
      level: 'verbose',
      event: 'test',
      data: {},
    });
    expect(result).not.toBeNull();
    expect(result!.level).toBe('info');
  });

  it('accepts all valid log levels', () => {
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      const result = asAuditRecord({
        ts: '2026-01-15T09:00:00.000Z',
        level,
        event: 'test',
        data: {},
      });
      expect(result!.level).toBe(level);
    }
  });

  it('defaults event to empty string when missing', () => {
    const result = asAuditRecord({ ts: '2026-01-15T09:00:00.000Z', level: 'info', data: {} });
    expect(result).not.toBeNull();
    expect(result!.event).toBe('');
  });

  it('defaults data to empty object when missing', () => {
    const result = asAuditRecord({ ts: '2026-01-15T09:00:00.000Z', level: 'info', event: 'test' });
    expect(result).not.toBeNull();
    expect(result!.data).toEqual({});
  });

  it('defaults data to empty object when it is a non-record (array)', () => {
    const result = asAuditRecord({
      ts: '2026-01-15T09:00:00.000Z',
      level: 'info',
      event: 'test',
      data: [1, 2],
    });
    expect(result).not.toBeNull();
    expect(result!.data).toEqual({});
  });

  it('sets optional fields to null when not present', () => {
    const result = asAuditRecord({
      ts: '2026-01-15T09:00:00.000Z',
      level: 'info',
      event: 'test',
      data: {},
    });
    expect(result).not.toBeNull();
    expect(result!.provider).toBeNull();
    expect(result!.source).toBeNull();
    expect(result!.confidence).toBeNull();
    expect(result!.error).toBeNull();
  });

  it('sets optional fields to null when they are empty strings', () => {
    const result = asAuditRecord({
      ts: '2026-01-15T09:00:00.000Z',
      level: 'info',
      event: 'test',
      data: {},
      provider: '',
      source: '',
      confidence: '',
      error: '',
    });
    expect(result).not.toBeNull();
    expect(result!.provider).toBeNull();
    expect(result!.source).toBeNull();
    expect(result!.confidence).toBeNull();
    expect(result!.error).toBeNull();
  });

  it('populates the error field when it is a non-empty string', () => {
    const result = asAuditRecord({
      ts: '2026-01-15T09:00:00.000Z',
      level: 'error',
      event: 'task.failed',
      data: {},
      error: 'Something went wrong',
    });
    expect(result).not.toBeNull();
    expect(result!.error).toBe('Something went wrong');
  });
});
