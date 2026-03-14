/** Unit tests for error-to-user-message mapping. */
import { describe, it, expect } from 'vitest';
import { getErrorMessage } from './messages.js';
import { ErrorCode } from './error-codes.js';
import type { ErrorCodeValue } from './error-codes.js';

describe('getErrorMessage()', () => {
  it('returns userMessage and suggestion for AUTH_TOKEN_EXPIRED', () => {
    const result = getErrorMessage(ErrorCode.AUTH_TOKEN_EXPIRED);
    expect(result.userMessage).toContain('expired');
    expect(result.suggestion).toContain('sparecrow');
  });

  it('returns userMessage and suggestion for AUTH_TOKEN_MISSING', () => {
    const result = getErrorMessage(ErrorCode.AUTH_TOKEN_MISSING);
    expect(result.userMessage).toContain('not found');
    expect(result.suggestion).toContain('claude auth login');
  });

  it('returns userMessage and suggestion for CONFIG_INVALID', () => {
    const result = getErrorMessage(ErrorCode.CONFIG_INVALID);
    expect(result.userMessage).toContain('invalid');
    expect(result.suggestion).toContain('validate');
  });

  it('returns userMessage and suggestion for CONFIG_NOT_FOUND', () => {
    const result = getErrorMessage(ErrorCode.CONFIG_NOT_FOUND);
    expect(result.userMessage).toContain('not found');
    expect(result.suggestion).toContain('onboard');
  });

  it('returns userMessage and suggestion for DAEMON_ALREADY_RUNNING', () => {
    const result = getErrorMessage(ErrorCode.DAEMON_ALREADY_RUNNING);
    expect(result.userMessage).toContain('already running');
    expect(result.suggestion).toContain('daemon');
  });

  it('returns userMessage and suggestion for CLAUDE_NOT_FOUND', () => {
    const result = getErrorMessage(ErrorCode.CLAUDE_NOT_FOUND);
    expect(result.userMessage).toContain('not found');
    expect(result.suggestion).toContain('Claude Code');
  });

  it('returns userMessage and suggestion for TASK_TIMEOUT', () => {
    const result = getErrorMessage(ErrorCode.TASK_TIMEOUT);
    expect(result.userMessage).toContain('timeout');
    expect(result.suggestion).toBeTruthy();
  });

  it('covers all defined ErrorCode values', () => {
    for (const code of Object.values(ErrorCode)) {
      const result = getErrorMessage(code as ErrorCodeValue);
      expect(result).toHaveProperty('userMessage');
      expect(result).toHaveProperty('suggestion');
      expect(typeof result.userMessage).toBe('string');
      expect(typeof result.suggestion).toBe('string');
    }
  });

  it('returns fallback message for unknown code', () => {
    const result = getErrorMessage('UNKNOWN_CODE' as ErrorCodeValue);
    expect(result.userMessage).toContain('UNKNOWN_CODE');
    expect(result.suggestion).toContain('doctor');
  });

  it('includes reconnect hint in AUTH_TOKEN_EXPIRED suggestion', () => {
    const result = getErrorMessage(ErrorCode.AUTH_TOKEN_EXPIRED);
    expect(result.suggestion).toContain('--reconnect');
  });

  it('includes platform install hint for CONTAINER_RUNTIME_NOT_FOUND', () => {
    const result = getErrorMessage(ErrorCode.CONTAINER_RUNTIME_NOT_FOUND);
    expect(result.userMessage).toContain('Checked: Docker, Podman');
    expect(result.suggestion).toContain('execution_backend: direct');
  });

  it('includes path and install URL in CLAUDE_NOT_FOUND message', () => {
    const result = getErrorMessage(ErrorCode.CLAUDE_NOT_FOUND);
    expect(result.userMessage).toContain('https://claude.ai/download');
    expect(result.userMessage).toContain('provider.claude_path');
  });

  it('includes config edit hint in CONFIG_INVALID suggestion', () => {
    const result = getErrorMessage(ErrorCode.CONFIG_INVALID);
    expect(result.suggestion).toContain('sparecrow config edit');
  });
});
