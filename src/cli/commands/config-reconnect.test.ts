/** Unit tests for the config --reconnect re-authentication flow. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

let tmpDir = '';

function createMockChildProcess(
  exitCode: number | null = 0,
  signal: string | null = null,
  emitError?: NodeJS.ErrnoException,
): EventEmitter {
  const child = new EventEmitter();
  process.nextTick(() => {
    if (emitError) {
      child.emit('error', emitError);
    } else {
      child.emit('close', exitCode, signal);
    }
  });
  return child;
}

/** Shared setup: creates mocks and imports module fresh. Returns the module + mock handles. */
async function setupReconnect(overrides?: {
  claudePath?: string;
  validateResult?: boolean;
  daemonState?: string;
  isJson?: boolean;
}) {
  vi.resetModules();

  const mockSpawn = vi.fn();
  vi.doMock('node:child_process', () => ({
    spawn: mockSpawn,
  }));

  vi.doMock('../../platform/index.js', () => ({
    getPaths: () => ({
      config: tmpDir + '/config',
      data: tmpDir + '/data',
      logs: tmpDir + '/data/logs',
    }),
    ensureDirectories: vi.fn(),
  }));

  const mockIsJsonMode = vi.fn(() => overrides?.isJson ?? false);
  vi.doMock('../index.js', () => ({
    isJsonMode: mockIsJsonMode,
    getConfigPath: vi.fn(() => undefined),
    EXIT: { SUCCESS: 0, ERROR: 1, DAEMON_NOT_RUNNING: 2, AUTH_OR_CONFIG: 3 },
  }));

  vi.doMock('../../config/index.js', () => ({
    loadConfig: vi.fn(async () => ({
      pollingInterval: 300,
      logRetentionDays: 30,
      lastSummaryEnabled: true,
      provider: { name: 'claude-code', claudePath: overrides?.claudePath ?? undefined },
      trigger: { maxWastePercentage: 50, weeklyReservePercentage: 30, idleHours: [] },
      tasks: [],
    })),
  }));

  const mockValidate = vi.fn(async () => overrides?.validateResult ?? true);
  vi.doMock('../../providers/claude-code/index.js', () => ({
    ClaudeCodeAuthManager: class {
      validate = mockValidate;
    },
  }));

  const daemonState = overrides?.daemonState ?? 'running';
  const mockGetDaemonState = vi.fn(async () => ({
    state: daemonState,
    pid: daemonState === 'running' ? 12345 : null,
    uptime: daemonState === 'running' ? '2h' : null,
  }));
  vi.doMock('./status-state.js', () => ({
    getDaemonState: mockGetDaemonState,
  }));

  const mod = await import('./config-reconnect.js');
  return { mod, mockSpawn, mockValidate, mockIsJsonMode, mockGetDaemonState };
}

describe('config-reconnect', () => {
  let stdoutOutput: string;
  let stderrOutput: string;
  let originalIsTTY: boolean | undefined;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), 'sparecrow-reconnect-test-' + randomBytes(6).toString('hex'));
    await mkdir(join(tmpDir, 'config'), { recursive: true });
    await mkdir(join(tmpDir, 'data'), { recursive: true });

    stdoutOutput = '';
    stderrOutput = '';

    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      stderrOutput += String(data);
      return true;
    });

    originalIsTTY = process.stdin.isTTY;
  });

  afterEach(async () => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalIsTTY,
      writable: true,
      configurable: true,
    });
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── Success path ────────────────────────────────────────────────────────

  describe('success path', () => {
    it('completes successfully when auth login exits 0 and validate returns true', async () => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        writable: true,
        configurable: true,
      });
      const { mod, mockSpawn } = await setupReconnect();
      mockSpawn.mockReturnValue(createMockChildProcess(0));

      await mod.handleReconnect();

      expect(stdoutOutput).toContain('Re-authentication successful');
      expect(stdoutOutput).toContain('resumes on next poll cycle');
    });

    it('shows on-start message when daemon is stopped', async () => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        writable: true,
        configurable: true,
      });
      const { mod, mockSpawn } = await setupReconnect({ daemonState: 'stopped' });
      mockSpawn.mockReturnValue(createMockChildProcess(0));

      await mod.handleReconnect();

      expect(stdoutOutput).toContain('Re-authentication successful');
      expect(stdoutOutput).toContain('resumes when daemon is started');
    });

    it('shows start command guidance when daemon state is not-started', async () => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        writable: true,
        configurable: true,
      });
      const { mod, mockSpawn } = await setupReconnect({ daemonState: 'not-started' });
      mockSpawn.mockReturnValue(createMockChildProcess(0));

      await mod.handleReconnect();

      expect(stdoutOutput).toContain('Re-authentication successful');
      expect(stdoutOutput).toContain('sparecrow daemon start');
    });

    it('shows start command guidance when daemon state is unknown', async () => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        writable: true,
        configurable: true,
      });
      const { mod, mockSpawn } = await setupReconnect({ daemonState: 'unknown' });
      mockSpawn.mockReturnValue(createMockChildProcess(0));

      await mod.handleReconnect();

      expect(stdoutOutput).toContain('sparecrow daemon start');
    });
  });

  // ── Non-interactive failure ─────────────────────────────────────────────

  describe('non-interactive context', () => {
    it('fails immediately when process.stdin.isTTY is undefined', async () => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: undefined,
        writable: true,
        configurable: true,
      });
      const { mod } = await setupReconnect();

      await expect(mod.handleReconnect()).rejects.toMatchObject({
        code: 'AUTH_RECONNECT_FAILED',
      });
    });

    it('fails with guidance to use interactive terminal', async () => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: undefined,
        writable: true,
        configurable: true,
      });
      const { mod } = await setupReconnect();

      try {
        await mod.handleReconnect();
        expect.unreachable('should have thrown');
      } catch (err: unknown) {
        expect((err as Error).message).toContain('interactive terminal');
      }
    });

    it('fails when process.stdin.isTTY is false', async () => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: false,
        writable: true,
        configurable: true,
      });
      const { mod } = await setupReconnect();

      await expect(mod.handleReconnect()).rejects.toMatchObject({
        code: 'AUTH_RECONNECT_FAILED',
      });
    });
  });

  // ── Claude binary missing ──────────────────────────────────────────────

  describe('missing Claude binary', () => {
    it('throws CLAUDE_NOT_FOUND when spawn emits ENOENT', async () => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        writable: true,
        configurable: true,
      });
      const enoentError = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
      const { mod, mockSpawn } = await setupReconnect();
      mockSpawn.mockReturnValue(
        createMockChildProcess(null, null, enoentError as NodeJS.ErrnoException),
      );

      await expect(mod.handleReconnect()).rejects.toMatchObject({
        code: 'CLAUDE_NOT_FOUND',
      });
    });

    it('throws CLAUDE_NOT_FOUND when spawn emits EACCES', async () => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        writable: true,
        configurable: true,
      });
      const eaccesError = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
      const { mod, mockSpawn } = await setupReconnect();
      mockSpawn.mockReturnValue(
        createMockChildProcess(null, null, eaccesError as NodeJS.ErrnoException),
      );

      await expect(mod.handleReconnect()).rejects.toMatchObject({
        code: 'CLAUDE_NOT_FOUND',
      });
    });
  });

  // ── Auth command non-zero exit ─────────────────────────────────────────

  describe('auth command non-zero exit', () => {
    it('throws AUTH_RECONNECT_FAILED when auth exits with code 1', async () => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        writable: true,
        configurable: true,
      });
      const { mod, mockSpawn } = await setupReconnect();
      mockSpawn.mockReturnValue(createMockChildProcess(1));

      await expect(mod.handleReconnect()).rejects.toMatchObject({
        code: 'AUTH_RECONNECT_FAILED',
      });
    });

    it('includes exit code in error message', async () => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        writable: true,
        configurable: true,
      });
      const { mod, mockSpawn } = await setupReconnect();
      mockSpawn.mockReturnValue(createMockChildProcess(2));

      try {
        await mod.handleReconnect();
        expect.unreachable('should have thrown');
      } catch (err: unknown) {
        expect((err as Error).message).toContain('2');
      }
    });
  });

  // ── Canceled login ─────────────────────────────────────────────────────

  describe('canceled login', () => {
    it('throws AUTH_RECONNECT_CANCELED when exit code is 130', async () => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        writable: true,
        configurable: true,
      });
      const { mod, mockSpawn } = await setupReconnect();
      mockSpawn.mockReturnValue(createMockChildProcess(130));

      await expect(mod.handleReconnect()).rejects.toMatchObject({
        code: 'AUTH_RECONNECT_CANCELED',
      });
    });

    it('throws AUTH_RECONNECT_CANCELED when signal is SIGINT', async () => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        writable: true,
        configurable: true,
      });
      const { mod, mockSpawn } = await setupReconnect();
      mockSpawn.mockReturnValue(createMockChildProcess(null, 'SIGINT'));

      await expect(mod.handleReconnect()).rejects.toMatchObject({
        code: 'AUTH_RECONNECT_CANCELED',
      });
    });
  });

  // ── Post-login validation failure ──────────────────────────────────────

  describe('post-login validation failure', () => {
    it('throws AUTH_TOKEN_MISSING when validate() returns false after auth exits 0', async () => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        writable: true,
        configurable: true,
      });
      const { mod, mockSpawn } = await setupReconnect({ validateResult: false });
      mockSpawn.mockReturnValue(createMockChildProcess(0));

      await expect(mod.handleReconnect()).rejects.toMatchObject({
        code: 'AUTH_TOKEN_MISSING',
      });
    });

    it('includes doctor guidance in validation failure message', async () => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        writable: true,
        configurable: true,
      });
      const { mod, mockSpawn } = await setupReconnect({ validateResult: false });
      mockSpawn.mockReturnValue(createMockChildProcess(0));

      try {
        await mod.handleReconnect();
        expect.unreachable('should have thrown');
      } catch (err: unknown) {
        expect((err as Error).message).toContain('sparecrow doctor');
      }
    });
  });

  // ── Daemon state mapping ───────────────────────────────────────────────

  describe('daemon state mapping (mapDaemonResumeMode)', () => {
    it('maps running to next-poll', async () => {
      const { mod } = await setupReconnect();
      expect(mod.mapDaemonResumeMode('running')).toBe('next-poll');
    });

    it('maps stopped to on-start', async () => {
      const { mod } = await setupReconnect();
      expect(mod.mapDaemonResumeMode('stopped')).toBe('on-start');
    });

    it('maps not-started to unknown', async () => {
      const { mod } = await setupReconnect();
      expect(mod.mapDaemonResumeMode('not-started')).toBe('unknown');
    });

    it('maps unknown to unknown', async () => {
      const { mod } = await setupReconnect();
      expect(mod.mapDaemonResumeMode('unknown')).toBe('unknown');
    });
  });

  // ── JSON mode output ───────────────────────────────────────────────────

  describe('JSON mode', () => {
    it('outputs valid JSON with reauthenticated and daemonResumeMode on success', async () => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        writable: true,
        configurable: true,
      });
      const { mod, mockSpawn } = await setupReconnect({ isJson: true, daemonState: 'running' });
      mockSpawn.mockReturnValue(createMockChildProcess(0));

      await mod.handleReconnect();

      const parsed = JSON.parse(stdoutOutput) as {
        ok: boolean;
        data: { reauthenticated: boolean; daemonResumeMode: string } | null;
        error: { code: string; message: string } | null;
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.data).not.toBeNull();
      expect(parsed.data?.reauthenticated).toBe(true);
      expect(parsed.data?.daemonResumeMode).toBe('next-poll');
      expect(parsed.error).toBeNull();
    });

    it('outputs on-start daemonResumeMode when daemon is stopped', async () => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        writable: true,
        configurable: true,
      });
      const { mod, mockSpawn } = await setupReconnect({ isJson: true, daemonState: 'stopped' });
      mockSpawn.mockReturnValue(createMockChildProcess(0));

      await mod.handleReconnect();

      const parsed = JSON.parse(stdoutOutput) as {
        ok: boolean;
        data: { daemonResumeMode: string } | null;
        error: null;
      };
      expect(parsed.data?.daemonResumeMode).toBe('on-start');
    });

    it('outputs unknown daemonResumeMode when daemon has not started', async () => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        writable: true,
        configurable: true,
      });
      const { mod, mockSpawn } = await setupReconnect({ isJson: true, daemonState: 'not-started' });
      mockSpawn.mockReturnValue(createMockChildProcess(0));

      await mod.handleReconnect();

      const parsed = JSON.parse(stdoutOutput) as {
        ok: boolean;
        data: { daemonResumeMode: string } | null;
        error: null;
      };
      expect(parsed.data?.daemonResumeMode).toBe('unknown');
    });

    it('suppresses human-readable output in JSON mode', async () => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        writable: true,
        configurable: true,
      });
      const { mod, mockSpawn } = await setupReconnect({ isJson: true, daemonState: 'running' });
      mockSpawn.mockReturnValue(createMockChildProcess(0));

      await mod.handleReconnect();

      // stdout should contain exactly one JSON object, no extra text
      const parsed = JSON.parse(stdoutOutput);
      expect(parsed).toBeTruthy();
      expect(stdoutOutput).not.toContain('Re-authentication successful');
    });

    it('emits parse-safe JSON with all three top-level fields', async () => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        writable: true,
        configurable: true,
      });
      const { mod, mockSpawn } = await setupReconnect({ isJson: true, daemonState: 'running' });
      mockSpawn.mockReturnValue(createMockChildProcess(0));

      await mod.handleReconnect();

      const parsed = JSON.parse(stdoutOutput) as Record<string, unknown>;
      expect('ok' in parsed).toBe(true);
      expect('data' in parsed).toBe(true);
      expect('error' in parsed).toBe(true);
    });
  });

  // ── Secret hygiene ─────────────────────────────────────────────────────

  describe('secret hygiene', () => {
    it('does not expose token-like strings in success output', async () => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        writable: true,
        configurable: true,
      });
      const { mod, mockSpawn } = await setupReconnect({ daemonState: 'running' });
      mockSpawn.mockReturnValue(createMockChildProcess(0));

      await mod.handleReconnect();

      expect(stdoutOutput).not.toMatch(/ey[A-Za-z0-9_-]{20,}/);
      expect(stderrOutput).not.toMatch(/ey[A-Za-z0-9_-]{20,}/);
    });

    it('does not expose token-like strings in JSON success output', async () => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        writable: true,
        configurable: true,
      });
      const { mod, mockSpawn } = await setupReconnect({ isJson: true, daemonState: 'running' });
      mockSpawn.mockReturnValue(createMockChildProcess(0));

      await mod.handleReconnect();

      expect(stdoutOutput).not.toMatch(/ey[A-Za-z0-9_-]{20,}/);
      expect(stdoutOutput).not.toMatch(/[A-Za-z0-9+/]{40,}={0,2}/);
    });

    it('does not expose token-like strings in error output', async () => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        writable: true,
        configurable: true,
      });
      const { mod, mockSpawn } = await setupReconnect();
      mockSpawn.mockReturnValue(createMockChildProcess(1));

      try {
        await mod.handleReconnect();
      } catch {
        // expected
      }

      expect(stdoutOutput).not.toMatch(/ey[A-Za-z0-9_-]{20,}/);
      expect(stderrOutput).not.toMatch(/ey[A-Za-z0-9_-]{20,}/);
    });
  });

  // ── Configured Claude binary path ──────────────────────────────────────

  describe('Claude binary resolution', () => {
    it('uses configured provider.claudePath when set', async () => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        writable: true,
        configurable: true,
      });
      const { mod, mockSpawn } = await setupReconnect({ claudePath: '/custom/claude' });
      mockSpawn.mockReturnValue(createMockChildProcess(0));

      await mod.handleReconnect();

      expect(mockSpawn).toHaveBeenCalledWith('/custom/claude', ['auth', 'login'], {
        stdio: 'inherit',
      });
    });

    it('falls back to "claude" when provider.claudePath is not set', async () => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        writable: true,
        configurable: true,
      });
      const { mod, mockSpawn } = await setupReconnect();
      mockSpawn.mockReturnValue(createMockChildProcess(0));

      await mod.handleReconnect();

      expect(mockSpawn).toHaveBeenCalledWith('claude', ['auth', 'login'], { stdio: 'inherit' });
    });
  });

  // ── Spawn error handling ───────────────────────────────────────────────

  describe('spawn error handling', () => {
    it('throws AUTH_RECONNECT_FAILED for unexpected spawn errors', async () => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        writable: true,
        configurable: true,
      });
      const unknownError = Object.assign(new Error('unexpected'), { code: 'UNKNOWN' });
      const { mod, mockSpawn } = await setupReconnect();
      mockSpawn.mockReturnValue(
        createMockChildProcess(null, null, unknownError as NodeJS.ErrnoException),
      );

      await expect(mod.handleReconnect()).rejects.toMatchObject({
        code: 'AUTH_RECONNECT_FAILED',
      });
    });

    it('sanitizes error details in spawn failure messages', async () => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        writable: true,
        configurable: true,
      });
      const detailedError = Object.assign(new Error('spawn /usr/local/bin/claude ENOTDIR'), {
        code: 'ENOTDIR',
      });
      const { mod, mockSpawn } = await setupReconnect();
      mockSpawn.mockReturnValue(
        createMockChildProcess(null, null, detailedError as NodeJS.ErrnoException),
      );

      try {
        await mod.handleReconnect();
        expect.unreachable('should have thrown');
      } catch (err: unknown) {
        // File path should be sanitized
        expect((err as Error).message).not.toContain('/usr/local/bin/claude');
      }
    });
  });
});
