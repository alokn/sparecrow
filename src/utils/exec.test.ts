/** Unit tests for sanitizeArgs and formatArgsForError. */
import { describe, it, expect } from 'vitest';
import { sanitizeArgs, formatArgsForError } from './exec.js';

describe('sanitizeArgs', () => {
  it('passes through safe arguments unchanged', () => {
    const args = ['run', '--detach', '--workdir', '/app', 'ubuntu:22.04'];
    expect(sanitizeArgs(args)).toEqual(args);
  });

  it('redacts --token value in two-element form', () => {
    const args = ['--token', 'sk-secret-123', '--other', 'safe'];
    expect(sanitizeArgs(args)).toEqual(['--token', '[REDACTED]', '--other', 'safe']);
  });

  it('redacts --token=value in single-element form', () => {
    const args = ['--token=sk-secret-123', '--other', 'safe'];
    expect(sanitizeArgs(args)).toEqual(['--token=[REDACTED]', '--other', 'safe']);
  });

  it('redacts --password value', () => {
    expect(sanitizeArgs(['--password', 'hunter2'])).toEqual(['--password', '[REDACTED]']);
  });

  it('redacts --secret value', () => {
    expect(sanitizeArgs(['--secret', 'abc'])).toEqual(['--secret', '[REDACTED]']);
  });

  it('redacts --auth value', () => {
    expect(sanitizeArgs(['--auth', 'mytoken'])).toEqual(['--auth', '[REDACTED]']);
  });

  it('redacts --credential value', () => {
    expect(sanitizeArgs(['--credential', 'cred'])).toEqual(['--credential', '[REDACTED]']);
  });

  it('redacts --api-key value', () => {
    expect(sanitizeArgs(['--api-key', 'key123'])).toEqual(['--api-key', '[REDACTED]']);
  });

  it('redacts --apikey value', () => {
    expect(sanitizeArgs(['--apikey', 'key123'])).toEqual(['--apikey', '[REDACTED]']);
  });

  it('redacts arguments containing Bearer (case-insensitive)', () => {
    expect(sanitizeArgs(['Authorization: Bearer abc123'])).toEqual(['[REDACTED]']);
    expect(sanitizeArgs(['bearer token'])).toEqual(['[REDACTED]']);
  });

  it('is case-insensitive for flag names', () => {
    expect(sanitizeArgs(['--TOKEN', 'secret'])).toEqual(['--TOKEN', '[REDACTED]']);
    expect(sanitizeArgs(['--Token=val'])).toEqual(['--Token=[REDACTED]']);
  });

  it('handles sensitive flag at end of args (no following value)', () => {
    // --token at end with no value: flag stays, redactNext is true but loop ends
    const result = sanitizeArgs(['--token']);
    expect(result).toEqual(['--token']);
  });

  it('handles multiple sensitive flags', () => {
    const args = ['--token', 'tk1', '--password', 'pw1', '--safe', 'ok'];
    expect(sanitizeArgs(args)).toEqual([
      '--token',
      '[REDACTED]',
      '--password',
      '[REDACTED]',
      '--safe',
      'ok',
    ]);
  });

  it('returns same-length array as input', () => {
    const args = ['--token', 'secret', '--password=pass', 'safe'];
    const result = sanitizeArgs(args);
    expect(result).toHaveLength(args.length);
  });

  it('preserves flag name when --flag=value has a Bearer value', () => {
    // The --flag= prefix check runs first, so the flag name is retained
    expect(sanitizeArgs(['--token=bearer_abc'])).toEqual(['--token=[REDACTED]']);
  });
});

describe('formatArgsForError', () => {
  it('returns sanitized args joined by space when under 200 chars', () => {
    const args = ['run', '--detach', 'ubuntu'];
    expect(formatArgsForError(args)).toBe('run --detach ubuntu');
  });

  it('truncates with suffix when joined args exceed 200 chars', () => {
    const longArg = 'a'.repeat(250);
    const result = formatArgsForError([longArg]);
    expect(result.length).toBe(200 + '...[truncated]'.length);
    expect(result).toContain('...[truncated]');
    expect(result.startsWith('a'.repeat(200))).toBe(true);
  });

  it('applies both redaction and truncation', () => {
    const longSafeArg = 'x'.repeat(250);
    const result = formatArgsForError(['--token', 'secret', longSafeArg]);
    expect(result).toContain('[REDACTED]');
    expect(result).toContain('...[truncated]');
    expect(result).not.toContain('secret');
  });

  it('returns identical output for safe short args (AC3)', () => {
    const args = ['logs', 'abc123'];
    expect(formatArgsForError(args)).toBe('logs abc123');
  });
});
