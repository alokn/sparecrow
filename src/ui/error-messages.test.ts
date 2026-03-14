/** Tests for error-messages.ts — humanizeErrorCode mapping and fallback. */
import { describe, it, expect } from 'vitest';
import { humanizeErrorCode } from './error-messages.js';

describe('humanizeErrorCode', () => {
  it('maps AUTH_TOKEN_EXPIRED to human-readable message', () => {
    expect(humanizeErrorCode('AUTH_TOKEN_EXPIRED')).toBe('authentication token expired');
  });

  it('maps AUTH_TOKEN_MISSING to human-readable message', () => {
    expect(humanizeErrorCode('AUTH_TOKEN_MISSING')).toBe('authentication not configured');
  });

  it('maps CLAUDE_NOT_FOUND to human-readable message', () => {
    expect(humanizeErrorCode('CLAUDE_NOT_FOUND')).toBe('Claude CLI not found');
  });

  it('maps TASK_EXECUTION_FAILED to human-readable message', () => {
    expect(humanizeErrorCode('TASK_EXECUTION_FAILED')).toBe('task execution failed');
  });

  it('maps DAEMON_AUTH_FAILED to human-readable message', () => {
    expect(humanizeErrorCode('DAEMON_AUTH_FAILED')).toBe('daemon authentication failed');
  });

  it('maps PROVIDER_UNREACHABLE to human-readable message', () => {
    expect(humanizeErrorCode('PROVIDER_UNREACHABLE')).toBe('usage provider unreachable');
  });

  it('maps CONFIG_INVALID to human-readable message', () => {
    expect(humanizeErrorCode('CONFIG_INVALID')).toBe('configuration error');
  });

  it('maps TASK_TIMEOUT to human-readable message', () => {
    expect(humanizeErrorCode('TASK_TIMEOUT')).toBe('task execution timed out');
  });

  it('maps QUOTA_EXHAUSTED to human-readable message', () => {
    expect(humanizeErrorCode('QUOTA_EXHAUSTED')).toBe('quota or rate limit reached');
  });

  it('maps CONTAINER_RUNTIME_NOT_FOUND to human-readable message', () => {
    expect(humanizeErrorCode('CONTAINER_RUNTIME_NOT_FOUND')).toBe('container runtime not found');
  });

  it('falls back to lowercase-with-spaces for unknown codes', () => {
    expect(humanizeErrorCode('SOME_NEW_CODE')).toBe('some new code');
  });

  it('falls back for single-word unknown code', () => {
    expect(humanizeErrorCode('UNKNOWN')).toBe('unknown');
  });

  it('falls back for multi-word unknown code', () => {
    expect(humanizeErrorCode('SOMETHING_VERY_SPECIFIC_HERE')).toBe('something very specific here');
  });

  // Story 10.11 AC2: TASK_OOM_KILLED mapping
  it('maps TASK_OOM_KILLED to human-readable OOM message using schema default (512 MB) when no context provided', () => {
    expect(humanizeErrorCode('TASK_OOM_KILLED')).toBe(
      'container ran out of memory (512 MB limit) — increase: `scrow config set provider.container.memory_limit_mb 1024`',
    );
  });

  it('maps TASK_OOM_KILLED with custom memoryLimitMb to reflect actual configured limit', () => {
    expect(humanizeErrorCode('TASK_OOM_KILLED', { memoryLimitMb: 256 })).toBe(
      'container ran out of memory (256 MB limit) — increase: `scrow config set provider.container.memory_limit_mb 512`',
    );
  });

  it('maps TASK_OOM_KILLED with 2048 MB configured limit', () => {
    expect(humanizeErrorCode('TASK_OOM_KILLED', { memoryLimitMb: 2048 })).toBe(
      'container ran out of memory (2048 MB limit) — increase: `scrow config set provider.container.memory_limit_mb 4096`',
    );
  });
});
