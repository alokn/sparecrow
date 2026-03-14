/** Unit tests for the daemon CLI command — lifecycle subcommands, status, JSON output. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { Command } from 'commander';
import { formatElapsed } from './daemon.js';

const actualFsPromises =
  await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const actualErrors =
  await vi.importActual<typeof import('../../errors/index.js')>('../../errors/index.js');
const { ScrowError, ErrorCode } = actualErrors;

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  return program;
}

describe('registerDaemon()', () => {
  let stdoutOutput: string;
  let stderrOutput: string;

  beforeEach(() => {
    vi.resetModules();
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
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- Status subcommand ----

  describe('daemon status', () => {
    it('shows not-started when daemon has never run', async () => {
      vi.resetModules();
      vi.doMock('../index.js', () => ({
        isJsonMode: () => false,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        getDaemonStatus: async () => ({
          state: 'not-started',
          pid: null,
          uptime: null,
          startedAt: null,
        }),
        startDaemon: async () => {
          throw new Error('should not be called');
        },
        stopDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
      }));
      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'status']);
      expect(stdoutOutput).toContain('not started');
    });

    it('shows running state with PID and uptime', async () => {
      vi.resetModules();
      vi.doMock('../index.js', () => ({
        isJsonMode: () => false,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        getDaemonStatus: async () => ({
          state: 'running',
          pid: 12345,
          uptime: '1h 30m',
          startedAt: '2026-01-01T00:00:00.000Z',
          activeTask: null,
        }),
        startDaemon: async () => {
          throw new Error('should not be called');
        },
        stopDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
      }));
      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'status']);
      expect(stdoutOutput).toContain('running');
      expect(stdoutOutput).toContain('12345');
      expect(stdoutOutput).toContain('1h 30m');
    });

    it('shows active task name and elapsed time when a task is executing (AC6)', async () => {
      vi.resetModules();
      // Use a startedAt 90 seconds ago so formatElapsed produces "1m 30s"
      const taskStartedAt = new Date(Date.now() - 90_000).toISOString();
      vi.doMock('../index.js', () => ({
        isJsonMode: () => false,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        getDaemonStatus: async () => ({
          state: 'running',
          pid: 12345,
          uptime: '0h 5m',
          startedAt: '2026-01-01T00:00:00.000Z',
          activeTask: { taskName: 'security-audit', startedAt: taskStartedAt },
        }),
        startDaemon: async () => {
          throw new Error('should not be called');
        },
        stopDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
      }));
      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'status']);
      expect(stdoutOutput).toContain('running');
      expect(stdoutOutput).toContain('Active task: security-audit');
      expect(stdoutOutput).toContain('running for');
    });

    it('does not show active task line when no task is executing', async () => {
      vi.resetModules();
      vi.doMock('../index.js', () => ({
        isJsonMode: () => false,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        getDaemonStatus: async () => ({
          state: 'running',
          pid: 12345,
          uptime: '0h 5m',
          startedAt: '2026-01-01T00:00:00.000Z',
          activeTask: null,
        }),
        startDaemon: async () => {
          throw new Error('should not be called');
        },
        stopDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
      }));
      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'status']);
      expect(stdoutOutput).toContain('running');
      // Story 10.6: daemon status now always shows "Active task: none" when running with no active task
      expect(stdoutOutput).toContain('Active task: none');
    });

    it('includes activeTask in JSON output when task is executing', async () => {
      vi.resetModules();
      const taskStartedAt = new Date(Date.now() - 30_000).toISOString();
      vi.doMock('../index.js', () => ({
        isJsonMode: () => true,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        getDaemonStatus: async () => ({
          state: 'running',
          pid: 12345,
          uptime: '0h 5m',
          startedAt: '2026-01-01T00:00:00.000Z',
          activeTask: { taskName: 'improve-code', startedAt: taskStartedAt },
        }),
        startDaemon: async () => {
          throw new Error('should not be called');
        },
        stopDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
      }));
      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'status']);
      const parsed = JSON.parse(stdoutOutput) as {
        ok: boolean;
        data: { state: string; activeTask: { taskName: string; startedAt: string } | null };
        error: null;
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.data.state).toBe('running');
      expect(parsed.data.activeTask).not.toBeNull();
      expect(parsed.data.activeTask!.taskName).toBe('improve-code');
    });

    it('shows stopped state', async () => {
      vi.resetModules();
      vi.doMock('../index.js', () => ({
        isJsonMode: () => false,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        getDaemonStatus: async () => ({
          state: 'stopped',
          pid: null,
          uptime: null,
          startedAt: null,
        }),
        startDaemon: async () => {
          throw new Error('should not be called');
        },
        stopDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
      }));
      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'status']);
      expect(stdoutOutput).toContain('stopped');
    });
  });

  // ---- Story 10.6 AC5: daemon status shows lastErrorDetail for degraded state ----

  describe('daemon status with lastErrorDetail (AC5 — Story 10.6)', () => {
    it('displays humanized error message and recovery command when lastErrorDetail is present', async () => {
      vi.resetModules();
      vi.doMock('../index.js', () => ({
        isJsonMode: () => false,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        getDaemonStatus: async () => ({
          state: 'running',
          pid: 12345,
          uptime: '1h 0m',
          startedAt: '2026-01-01T00:00:00.000Z',
          activeTask: null,
        }),
        startDaemon: async () => {
          throw new Error('should not be called');
        },
        stopDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
        DAEMON_RUNNER_FLAG: '--daemon',
      }));
      vi.doMock('../../platform/index.js', () => ({
        getPaths: () => ({ data: '/fake/data', config: '/fake/config', logs: '/fake/logs' }),
        installService: async () => {
          throw new Error('should not be called');
        },
        uninstallService: async () => {
          throw new Error('should not be called');
        },
      }));
      vi.doMock('./status-state.js', () => ({
        loadLastErrorDetail: async () => ({
          code: 'CLAUDE_NOT_FOUND',
          message: 'Claude CLI not found',
          recoveryCommand: 'sparecrow config set provider.claude_path /path/to/claude',
        }),
        loadStatusSnapshot: async () => {
          throw new Error('should not be called');
        },
        formatUptime: () => '1h 0m',
        formatRelativeTime: () => '1h ago',
        loadActivity: async () => {
          throw new Error('should not be called');
        },
      }));
      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'status']);

      // AC5: humanized message shown (not raw code)
      expect(stdoutOutput).toContain('Claude CLI not found');
      // Recovery command shown
      expect(stdoutOutput).toContain('sparecrow config set provider.claude_path');
      // Hint to run doctor shown
      expect(stdoutOutput).toContain('sparecrow doctor');
    });

    it('does not display error section when lastErrorDetail is null', async () => {
      vi.resetModules();
      vi.doMock('../index.js', () => ({
        isJsonMode: () => false,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        getDaemonStatus: async () => ({
          state: 'running',
          pid: 12345,
          uptime: '1h 0m',
          startedAt: '2026-01-01T00:00:00.000Z',
          activeTask: null,
        }),
        startDaemon: async () => {
          throw new Error('should not be called');
        },
        stopDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
        DAEMON_RUNNER_FLAG: '--daemon',
      }));
      vi.doMock('../../platform/index.js', () => ({
        getPaths: () => ({ data: '/fake/data', config: '/fake/config', logs: '/fake/logs' }),
        installService: async () => {
          throw new Error('should not be called');
        },
        uninstallService: async () => {
          throw new Error('should not be called');
        },
      }));
      vi.doMock('./status-state.js', () => ({
        loadLastErrorDetail: async () => null,
        loadStatusSnapshot: async () => {
          throw new Error('should not be called');
        },
        formatUptime: () => '1h 0m',
        formatRelativeTime: () => '1h ago',
        loadActivity: async () => {
          throw new Error('should not be called');
        },
      }));
      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'status']);

      // No error section when lastErrorDetail is null
      expect(stdoutOutput).not.toContain('Last error:');
      expect(stdoutOutput).toContain('running');
      expect(stdoutOutput).toContain('Active task: none');
    });

    it('includes lastError in JSON output with code, message, recoveryCommand (AC7)', async () => {
      vi.resetModules();
      vi.doMock('../index.js', () => ({
        isJsonMode: () => true,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        getDaemonStatus: async () => ({
          state: 'running',
          pid: 12345,
          uptime: '1h 0m',
          startedAt: '2026-01-01T00:00:00.000Z',
          activeTask: null,
        }),
        startDaemon: async () => {
          throw new Error('should not be called');
        },
        stopDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
        DAEMON_RUNNER_FLAG: '--daemon',
      }));
      vi.doMock('../../platform/index.js', () => ({
        getPaths: () => ({ data: '/fake/data', config: '/fake/config', logs: '/fake/logs' }),
        installService: async () => {
          throw new Error('should not be called');
        },
        uninstallService: async () => {
          throw new Error('should not be called');
        },
      }));
      vi.doMock('./status-state.js', () => ({
        loadLastErrorDetail: async () => ({
          code: 'AUTH_TOKEN_EXPIRED',
          message: 'Authentication token expired',
          recoveryCommand: 'sparecrow config --reconnect',
        }),
        loadStatusSnapshot: async () => {
          throw new Error('should not be called');
        },
        formatUptime: () => '1h 0m',
        formatRelativeTime: () => '1h ago',
        loadActivity: async () => {
          throw new Error('should not be called');
        },
      }));
      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'status']);

      const parsed = JSON.parse(stdoutOutput) as {
        ok: boolean;
        data: { lastError: { code: string; message: string; recoveryCommand: string } | null };
        error: null;
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.data.lastError).not.toBeNull();
      expect(parsed.data.lastError!.code).toBe('AUTH_TOKEN_EXPIRED');
      expect(parsed.data.lastError!.message).toBe('Authentication token expired');
      expect(parsed.data.lastError!.recoveryCommand).toBe('sparecrow config --reconnect');
    });
  });

  // ---- Bare daemon command delegates to status ----

  describe('bare daemon command', () => {
    it('delegates to status behavior in human mode', async () => {
      vi.resetModules();
      vi.doMock('../index.js', () => ({
        isJsonMode: () => false,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        getDaemonStatus: async () => ({
          state: 'running',
          pid: 5555,
          uptime: '0h 5m',
          startedAt: '2026-01-01T00:00:00.000Z',
          activeTask: null,
        }),
        startDaemon: async () => {
          throw new Error('should not be called');
        },
        stopDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
      }));
      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon']);
      expect(stdoutOutput).toContain('running');
      expect(stdoutOutput).toContain('5555');
    });

    it('delegates to status behavior in JSON mode', async () => {
      vi.resetModules();
      vi.doMock('../index.js', () => ({
        isJsonMode: () => true,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        getDaemonStatus: async () => ({
          state: 'not-started',
          pid: null,
          uptime: null,
          startedAt: null,
        }),
        startDaemon: async () => {
          throw new Error('should not be called');
        },
        stopDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
      }));
      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon']);
      const parsed = JSON.parse(stdoutOutput) as { ok: boolean; data: unknown; error: unknown };
      expect(parsed.ok).toBe(true);
      expect(parsed.error).toBeNull();
      expect(parsed.data).toBeDefined();
    });
  });

  // ---- Start subcommand ----

  describe('daemon start', () => {
    it('outputs success message with PID in human mode', async () => {
      vi.resetModules();
      vi.doMock('../index.js', () => ({
        isJsonMode: () => false,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        startDaemon: async () => ({ pid: 99999, dataDir: '/tmp/test' }),
        stopDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        getDaemonStatus: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
      }));
      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'start']);
      expect(stdoutOutput).toContain('Daemon started');
      expect(stdoutOutput).toContain('99999');
    });

    it('outputs valid JSON wrapper on start success', async () => {
      vi.resetModules();
      vi.doMock('../index.js', () => ({
        isJsonMode: () => true,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        startDaemon: async () => ({ pid: 88888, dataDir: '/tmp/test' }),
        stopDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        getDaemonStatus: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
      }));
      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'start']);
      const parsed = JSON.parse(stdoutOutput) as {
        ok: boolean;
        data: { pid: number };
        error: null;
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.data.pid).toBe(88888);
      expect(parsed.error).toBeNull();
    });

    it('handles DAEMON_ALREADY_RUNNING with PID in human mode', async () => {
      vi.resetModules();
      vi.doMock('../../errors/index.js', () => actualErrors);
      vi.doMock('../index.js', () => ({
        isJsonMode: () => false,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        startDaemon: async () => {
          throw new ScrowError(
            ErrorCode.DAEMON_ALREADY_RUNNING,
            'Daemon is already running with PID 77777',
          );
        },
        stopDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        getDaemonStatus: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
      }));
      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'start']);
      expect(stderrOutput).toContain('already running');
      expect(stderrOutput).toContain('77777');
    });

    it('handles DAEMON_ALREADY_RUNNING in JSON mode with PID', async () => {
      vi.resetModules();
      vi.doMock('../../errors/index.js', () => actualErrors);
      vi.doMock('../index.js', () => ({
        isJsonMode: () => true,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        startDaemon: async () => {
          throw new ScrowError(
            ErrorCode.DAEMON_ALREADY_RUNNING,
            'Daemon is already running with PID 66666',
          );
        },
        stopDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        getDaemonStatus: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
      }));
      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'start']);
      const parsed = JSON.parse(stdoutOutput) as {
        ok: boolean;
        data: null;
        error: { code: string; message: string };
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.data).toBeNull();
      expect(parsed.error.code).toBe('DAEMON_ALREADY_RUNNING');
      expect(parsed.error.message).toContain('66666');
    });
  });

  // ---- Stop subcommand ----

  describe('daemon stop', () => {
    it('outputs success on clean stop in human mode', async () => {
      vi.resetModules();
      vi.doMock('../index.js', () => ({
        isJsonMode: () => false,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        stopDaemon: async () => ({ forced: false }),
        startDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        getDaemonStatus: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
      }));
      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'stop']);
      expect(stdoutOutput).toContain('Daemon stopped');
    });

    it('outputs forced-stop message when SIGKILL was used', async () => {
      vi.resetModules();
      vi.doMock('../index.js', () => ({
        isJsonMode: () => false,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        stopDaemon: async () => ({ forced: true }),
        startDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        getDaemonStatus: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
      }));
      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'stop']);
      expect(stdoutOutput).toContain('forced');
    });

    it('outputs JSON with forced=false on clean stop', async () => {
      vi.resetModules();
      vi.doMock('../index.js', () => ({
        isJsonMode: () => true,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        stopDaemon: async () => ({ forced: false }),
        startDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        getDaemonStatus: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
      }));
      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'stop']);
      const parsed = JSON.parse(stdoutOutput) as {
        ok: boolean;
        data: { forced: boolean };
        error: null;
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.data.forced).toBe(false);
      expect(parsed.error).toBeNull();
    });

    it('handles DAEMON_NOT_RUNNING in human mode with exit code 2', async () => {
      vi.resetModules();
      vi.doMock('../../errors/index.js', () => actualErrors);
      vi.doMock('../index.js', () => ({
        isJsonMode: () => false,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        stopDaemon: async () => {
          throw new ScrowError(ErrorCode.DAEMON_NOT_RUNNING, 'Daemon is not running');
        },
        startDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        getDaemonStatus: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
      }));
      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'stop']);
      expect(stderrOutput).toContain('not running');
      expect(process.exitCode).toBe(2);
    });

    it('handles DAEMON_NOT_RUNNING in JSON mode', async () => {
      vi.resetModules();
      vi.doMock('../../errors/index.js', () => actualErrors);
      vi.doMock('../index.js', () => ({
        isJsonMode: () => true,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        stopDaemon: async () => {
          throw new ScrowError(ErrorCode.DAEMON_NOT_RUNNING, 'Daemon is not running');
        },
        startDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        getDaemonStatus: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
      }));
      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'stop']);
      const parsed = JSON.parse(stdoutOutput) as {
        ok: boolean;
        data: null;
        error: { code: string };
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.data).toBeNull();
      expect(parsed.error.code).toBe('DAEMON_NOT_RUNNING');
    });
  });

  // ---- Restart subcommand ----

  describe('daemon restart', () => {
    it('shows restart message when daemon was running', async () => {
      vi.resetModules();
      vi.doMock('../index.js', () => ({
        isJsonMode: () => false,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        restartDaemon: async () => ({ pid: 11111, wasRunning: true, dataDir: '/tmp/test' }),
        startDaemon: async () => {
          throw new Error('should not be called');
        },
        stopDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        getDaemonStatus: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
      }));
      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'restart']);
      expect(stdoutOutput).toContain('restarted');
      expect(stdoutOutput).toContain('11111');
    });

    it('shows not-running message when daemon was not running', async () => {
      vi.resetModules();
      vi.doMock('../index.js', () => ({
        isJsonMode: () => false,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        restartDaemon: async () => ({ pid: 22222, wasRunning: false, dataDir: '/tmp/test' }),
        startDaemon: async () => {
          throw new Error('should not be called');
        },
        stopDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        getDaemonStatus: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
      }));
      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'restart']);
      expect(stdoutOutput).toContain('was not running');
    });

    it('outputs valid JSON on restart when running', async () => {
      vi.resetModules();
      vi.doMock('../index.js', () => ({
        isJsonMode: () => true,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        restartDaemon: async () => ({ pid: 33333, wasRunning: true, dataDir: '/tmp/test' }),
        startDaemon: async () => {
          throw new Error('should not be called');
        },
        stopDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        getDaemonStatus: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
      }));
      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'restart']);
      const parsed = JSON.parse(stdoutOutput) as {
        ok: boolean;
        data: { pid: number; wasRunning: boolean };
        error: null;
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.data.pid).toBe(33333);
      expect(parsed.data.wasRunning).toBe(true);
      expect(parsed.error).toBeNull();
    });
  });

  // ---- Reload subcommand ----

  describe('daemon reload', () => {
    it('shows success message in human mode', async () => {
      vi.resetModules();
      vi.doMock('../index.js', () => ({
        isJsonMode: () => false,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        reloadDaemon: async () => {},
        startDaemon: async () => {
          throw new Error('should not be called');
        },
        stopDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        getDaemonStatus: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
      }));
      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'reload']);
      expect(stdoutOutput).toContain('reloaded');
    });

    it('outputs valid JSON on reload success', async () => {
      vi.resetModules();
      vi.doMock('../index.js', () => ({
        isJsonMode: () => true,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        reloadDaemon: async () => {},
        startDaemon: async () => {
          throw new Error('should not be called');
        },
        stopDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        getDaemonStatus: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
      }));
      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'reload']);
      const parsed = JSON.parse(stdoutOutput) as {
        ok: boolean;
        data: { message: string };
        error: null;
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.data.message).toContain('reloaded');
      expect(parsed.error).toBeNull();
    });

    it('handles DAEMON_NOT_RUNNING with exit code 2 in human mode', async () => {
      vi.resetModules();
      vi.doMock('../../errors/index.js', () => actualErrors);
      vi.doMock('../index.js', () => ({
        isJsonMode: () => false,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        reloadDaemon: async () => {
          throw new ScrowError(ErrorCode.DAEMON_NOT_RUNNING, 'Daemon is not running');
        },
        startDaemon: async () => {
          throw new Error('should not be called');
        },
        stopDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        getDaemonStatus: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
      }));
      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'reload']);
      expect(stderrOutput).toContain('not running');
      expect(process.exitCode).toBe(2);
    });

    it('handles DAEMON_NOT_RUNNING in JSON mode', async () => {
      vi.resetModules();
      vi.doMock('../../errors/index.js', () => actualErrors);
      vi.doMock('../index.js', () => ({
        isJsonMode: () => true,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        reloadDaemon: async () => {
          throw new ScrowError(ErrorCode.DAEMON_NOT_RUNNING, 'Daemon is not running');
        },
        startDaemon: async () => {
          throw new Error('should not be called');
        },
        stopDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        getDaemonStatus: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
      }));
      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'reload']);
      const parsed = JSON.parse(stdoutOutput) as {
        ok: boolean;
        data: null;
        error: { code: string };
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.data).toBeNull();
      expect(parsed.error.code).toBe('DAEMON_NOT_RUNNING');
    });
  });

  // ---- Stale PID path ----

  describe('stale PID handling via start', () => {
    it('start succeeds after cleaning stale PID', async () => {
      vi.resetModules();
      vi.doMock('../index.js', () => ({
        isJsonMode: () => false,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        // Stale PID is handled inside startDaemon — returns new PID
        startDaemon: async () => ({ pid: 55555, dataDir: '/tmp/test' }),
        stopDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        getDaemonStatus: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
      }));
      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'start']);
      expect(stdoutOutput).toContain('Daemon started');
      expect(stdoutOutput).toContain('55555');
    });
  });

  // ---- Status JSON output ----

  describe('daemon status JSON', () => {
    it('outputs valid JSON with all required fields', async () => {
      vi.resetModules();
      vi.doMock('../index.js', () => ({
        isJsonMode: () => true,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        getDaemonStatus: async () => ({
          state: 'running',
          pid: 12345,
          uptime: '2h 10m',
          startedAt: '2026-01-01T00:00:00.000Z',
        }),
        startDaemon: async () => {
          throw new Error('should not be called');
        },
        stopDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
      }));
      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'status']);
      const parsed = JSON.parse(stdoutOutput) as {
        ok: boolean;
        data: { state: string; pid: number };
        error: null;
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.data.state).toBe('running');
      expect(parsed.data.pid).toBe(12345);
      expect(parsed.error).toBeNull();
    });
  });

  // ---- Install subcommand ----

  describe('daemon install', () => {
    it('outputs success message in human mode when no existing file', async () => {
      vi.resetModules();
      vi.doMock('../index.js', () => ({
        isJsonMode: () => false,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        startDaemon: async () => {
          throw new Error('should not be called');
        },
        stopDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        getDaemonStatus: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
        DAEMON_RUNNER_FLAG: '--daemon-runner',
      }));
      vi.doMock('../../platform/index.js', () => ({
        installService: async () => ({
          platform: 'linux',
          serviceFilePath: '/home/user/.config/systemd/user/sparecrow.service',
          method: 'systemd',
          overwritten: false,
          started: false,
        }),
        uninstallService: async () => {
          throw new Error('should not be called');
        },
      }));
      // Mock fs access to indicate no existing file
      vi.doMock('node:fs/promises', () => ({
        ...actualFsPromises,
        access: async () => {
          throw new Error('ENOENT');
        },
      }));
      vi.doMock('node:os', () => ({
        homedir: () => '/home/user',
        userInfo: () => ({ username: 'testuser' }),
      }));

      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'install']);
      expect(stdoutOutput).toContain('Service installed');
    });

    it('outputs JSON with { ok: true, data: ServiceInstallResult } in JSON mode', async () => {
      vi.resetModules();
      vi.doMock('../index.js', () => ({
        isJsonMode: () => true,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        startDaemon: async () => {
          throw new Error('should not be called');
        },
        stopDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        getDaemonStatus: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
        DAEMON_RUNNER_FLAG: '--daemon-runner',
      }));
      const installResult = {
        platform: 'linux',
        serviceFilePath: '/home/user/.config/systemd/user/sparecrow.service',
        method: 'systemd',
        overwritten: false,
        started: false,
      };
      vi.doMock('../../platform/index.js', () => ({
        installService: async () => installResult,
        uninstallService: async () => {
          throw new Error('should not be called');
        },
      }));
      vi.doMock('node:fs/promises', () => ({
        ...actualFsPromises,
        access: async () => {
          throw new Error('ENOENT');
        },
      }));
      vi.doMock('node:os', () => ({
        homedir: () => '/home/user',
        userInfo: () => ({ username: 'testuser' }),
      }));

      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'install']);

      const parsed = JSON.parse(stdoutOutput) as {
        ok: boolean;
        data: {
          platform: string;
          serviceFilePath: string;
          method: string;
          overwritten: boolean;
          started: boolean;
        };
        error: null;
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.data.platform).toBe('linux');
      expect(parsed.data.started).toBe(false);
      expect(parsed.data.overwritten).toBe(false);
      expect(parsed.error).toBeNull();
    });

    it('JSON result always has started: false', async () => {
      vi.resetModules();
      vi.doMock('../index.js', () => ({
        isJsonMode: () => true,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        startDaemon: async () => {
          throw new Error('should not be called');
        },
        stopDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        getDaemonStatus: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
        DAEMON_RUNNER_FLAG: '--daemon-runner',
      }));
      vi.doMock('../../platform/index.js', () => ({
        installService: async () => ({
          platform: 'darwin',
          serviceFilePath: '/Users/user/Library/LaunchAgents/com.sparecrow.daemon.plist',
          method: 'launchd',
          overwritten: true,
          started: false,
        }),
        uninstallService: async () => {
          throw new Error('should not be called');
        },
      }));
      vi.doMock('node:fs/promises', () => ({
        ...actualFsPromises,
        access: async () => {
          throw new Error('ENOENT');
        },
      }));
      vi.doMock('node:os', () => ({
        homedir: () => '/Users/user',
        userInfo: () => ({ username: 'testuser' }),
      }));

      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'install', '--yes']);

      const parsed = JSON.parse(stdoutOutput) as { ok: boolean; data: { started: boolean } };
      expect(parsed.data.started).toBe(false);
    });

    it('throws SERVICE_INSTALL_CONFIRMATION_REQUIRED in non-interactive mode without --yes when file exists', async () => {
      vi.resetModules();
      vi.doMock('../index.js', () => ({
        isJsonMode: () => false,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        startDaemon: async () => {
          throw new Error('should not be called');
        },
        stopDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        getDaemonStatus: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
        DAEMON_RUNNER_FLAG: '--daemon-runner',
      }));
      vi.doMock('../../platform/index.js', () => ({
        installService: async () => {
          throw new Error('should not be called');
        },
        uninstallService: async () => {
          throw new Error('should not be called');
        },
      }));
      // Simulate existing file
      vi.doMock('node:fs/promises', () => ({
        ...actualFsPromises,
        access: async () => {}, // access succeeds = file exists
      }));
      vi.doMock('node:os', () => ({
        homedir: () => '/home/user',
        userInfo: () => ({ username: 'testuser' }),
      }));
      // process.stdin.isTTY is undefined in test env → isInteractive() returns false

      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'install']);
      // Should output error about confirmation required (error message or code)
      expect(stderrOutput).toContain('already exists');
      expect(process.exitCode).toBe(1);
    });

    it('proceeds with --yes flag when file exists without prompting', async () => {
      vi.resetModules();
      vi.doMock('../index.js', () => ({
        isJsonMode: () => false,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        startDaemon: async () => {
          throw new Error('should not be called');
        },
        stopDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        getDaemonStatus: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
        DAEMON_RUNNER_FLAG: '--daemon-runner',
      }));
      let installCalled = false;
      vi.doMock('../../platform/index.js', () => ({
        installService: async () => {
          installCalled = true;
          return {
            platform: 'linux',
            serviceFilePath: '/home/user/.config/systemd/user/sparecrow.service',
            method: 'systemd',
            overwritten: true,
            started: false,
          };
        },
        uninstallService: async () => {
          throw new Error('should not be called');
        },
      }));
      // Simulate existing file
      vi.doMock('node:fs/promises', () => ({
        ...actualFsPromises,
        access: async () => {},
      }));
      vi.doMock('node:os', () => ({
        homedir: () => '/home/user',
        userInfo: () => ({ username: 'testuser' }),
      }));

      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'install', '--yes']);
      expect(installCalled).toBe(true);
      expect(stdoutOutput).toContain('Service installed');
    });

    it('shows reinstall restart hint in human mode when service file was overwritten (Task 3.3)', async () => {
      vi.resetModules();
      vi.doMock('../index.js', () => ({
        isJsonMode: () => false,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        startDaemon: async () => {
          throw new Error('should not be called');
        },
        stopDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        getDaemonStatus: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
        DAEMON_RUNNER_FLAG: '--daemon-runner',
      }));
      vi.doMock('../../platform/index.js', () => ({
        installService: async () => ({
          platform: 'linux',
          serviceFilePath: '/home/user/.config/systemd/user/sparecrow.service',
          method: 'systemd',
          overwritten: true,
          started: false,
        }),
        uninstallService: async () => {
          throw new Error('should not be called');
        },
      }));
      vi.doMock('node:fs/promises', () => ({
        ...actualFsPromises,
        access: async () => {}, // file exists
      }));
      vi.doMock('node:os', () => ({
        homedir: () => '/home/user',
        userInfo: () => ({ username: 'testuser' }),
      }));

      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'install', '--yes']);

      // Task 3.3: reinstall note must be shown when existing file was overwritten
      expect(stdoutOutput).toContain('existing service file was updated');
      expect(stdoutOutput).toContain('sparecrow daemon restart');
    });

    it('does not show reinstall hint when service file is newly created (not overwritten)', async () => {
      vi.resetModules();
      vi.doMock('../index.js', () => ({
        isJsonMode: () => false,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        startDaemon: async () => {
          throw new Error('should not be called');
        },
        stopDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        getDaemonStatus: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
        DAEMON_RUNNER_FLAG: '--daemon-runner',
      }));
      vi.doMock('../../platform/index.js', () => ({
        installService: async () => ({
          platform: 'linux',
          serviceFilePath: '/home/user/.config/systemd/user/sparecrow.service',
          method: 'systemd',
          overwritten: false,
          started: false,
        }),
        uninstallService: async () => {
          throw new Error('should not be called');
        },
      }));
      vi.doMock('node:fs/promises', () => ({
        ...actualFsPromises,
        access: async () => {
          throw new Error('ENOENT');
        },
      }));
      vi.doMock('node:os', () => ({
        homedir: () => '/home/user',
        userInfo: () => ({ username: 'testuser' }),
      }));

      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'install']);

      // Task 3.3: no reinstall note when the file was freshly created
      expect(stdoutOutput).not.toContain('existing service file was updated');
      expect(stdoutOutput).toContain('Service installed');
    });

    it('outputs overwritten: true in JSON mode when file was overwritten', async () => {
      vi.resetModules();
      vi.doMock('../index.js', () => ({
        isJsonMode: () => true,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        startDaemon: async () => {
          throw new Error('should not be called');
        },
        stopDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        getDaemonStatus: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
        DAEMON_RUNNER_FLAG: '--daemon-runner',
      }));
      vi.doMock('../../platform/index.js', () => ({
        installService: async () => ({
          platform: 'linux',
          serviceFilePath: '/home/user/.config/systemd/user/sparecrow.service',
          method: 'systemd',
          overwritten: true,
          started: false,
        }),
        uninstallService: async () => {
          throw new Error('should not be called');
        },
      }));
      vi.doMock('node:fs/promises', () => ({
        ...actualFsPromises,
        access: async () => {}, // file exists
      }));
      vi.doMock('node:os', () => ({
        homedir: () => '/home/user',
        userInfo: () => ({ username: 'testuser' }),
      }));

      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'install', '--yes']);

      const parsed = JSON.parse(stdoutOutput) as {
        ok: boolean;
        data: { overwritten: boolean };
        error: null;
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.data.overwritten).toBe(true);
    });
  });

  // ---- Uninstall subcommand ----

  describe('daemon uninstall', () => {
    it('calls stopDaemon before uninstallService and outputs success message', async () => {
      vi.resetModules();
      vi.doMock('../index.js', () => ({
        isJsonMode: () => false,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      const callOrder: string[] = [];
      vi.doMock('../../daemon/index.js', () => ({
        startDaemon: async () => {
          throw new Error('should not be called');
        },
        stopDaemon: async () => {
          callOrder.push('stopDaemon');
          return { forced: false };
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        getDaemonStatus: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
        DAEMON_RUNNER_FLAG: '--daemon-runner',
      }));
      vi.doMock('../../platform/index.js', () => ({
        installService: async () => {
          throw new Error('should not be called');
        },
        uninstallService: async () => {
          callOrder.push('uninstallService');
          return {
            platform: 'linux',
            serviceFilePath: '/home/user/.config/systemd/user/sparecrow.service',
            stopped: false,
            removed: true,
          };
        },
      }));

      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'uninstall']);
      expect(callOrder).toEqual(['stopDaemon', 'uninstallService']);
      expect(stdoutOutput).toContain('Service uninstalled');
    });

    it('sets stopped: true in JSON result when daemon was running', async () => {
      vi.resetModules();
      vi.doMock('../index.js', () => ({
        isJsonMode: () => true,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        startDaemon: async () => {
          throw new Error('should not be called');
        },
        stopDaemon: async () => ({ forced: false }),
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        getDaemonStatus: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
        DAEMON_RUNNER_FLAG: '--daemon-runner',
      }));
      vi.doMock('../../platform/index.js', () => ({
        installService: async () => {
          throw new Error('should not be called');
        },
        uninstallService: async () => ({
          platform: 'linux',
          serviceFilePath: '/home/user/.config/systemd/user/sparecrow.service',
          stopped: false, // CLI layer merges actual value
          removed: true,
        }),
      }));

      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'uninstall']);

      const parsed = JSON.parse(stdoutOutput) as {
        ok: boolean;
        data: { stopped: boolean; removed: boolean };
        error: null;
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.data.stopped).toBe(true); // CLI sets true because stopDaemon succeeded
      expect(parsed.data.removed).toBe(true);
    });

    it('sets stopped: false in JSON result when daemon was not running (DAEMON_NOT_RUNNING treated as non-error)', async () => {
      vi.resetModules();
      vi.doMock('../../errors/index.js', () => actualErrors);
      vi.doMock('../index.js', () => ({
        isJsonMode: () => true,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        startDaemon: async () => {
          throw new Error('should not be called');
        },
        stopDaemon: async () => {
          throw new ScrowError(ErrorCode.DAEMON_NOT_RUNNING, 'Daemon is not running');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        getDaemonStatus: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
        DAEMON_RUNNER_FLAG: '--daemon-runner',
      }));
      vi.doMock('../../platform/index.js', () => ({
        installService: async () => {
          throw new Error('should not be called');
        },
        uninstallService: async () => ({
          platform: 'linux',
          serviceFilePath: '/home/user/.config/systemd/user/sparecrow.service',
          stopped: false,
          removed: true,
        }),
      }));

      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'uninstall']);

      const parsed = JSON.parse(stdoutOutput) as {
        ok: boolean;
        data: { stopped: boolean; removed: boolean };
        error: null;
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.data.stopped).toBe(false); // DAEMON_NOT_RUNNING → stopped: false
      expect(parsed.data.removed).toBe(true);
    });

    it('outputs no-service message when service was not installed', async () => {
      vi.resetModules();
      vi.doMock('../../errors/index.js', () => actualErrors);
      vi.doMock('../index.js', () => ({
        isJsonMode: () => false,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        startDaemon: async () => {
          throw new Error('should not be called');
        },
        stopDaemon: async () => {
          throw new ScrowError(ErrorCode.DAEMON_NOT_RUNNING, 'Daemon is not running');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        getDaemonStatus: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
        DAEMON_RUNNER_FLAG: '--daemon-runner',
      }));
      vi.doMock('../../platform/index.js', () => ({
        installService: async () => {
          throw new Error('should not be called');
        },
        uninstallService: async () => ({
          platform: 'linux',
          serviceFilePath: '/home/user/.config/systemd/user/sparecrow.service',
          stopped: false,
          removed: false,
        }),
      }));

      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'uninstall']);
      expect(stdoutOutput).toContain('Nothing to uninstall');
    });
  });

  // ---- daemon start --dry-run ----

  describe('daemon start --dry-run', () => {
    const MOCK_CONFIG = {
      pollingInterval: 300,
      logRetentionDays: 30,
      lastSummaryEnabled: false,
      provider: {
        name: 'claude-code',
        allowDangerouslySkipPermissions: false,
        executionBackend: 'container' as const,
      },
      trigger: { maxWastePercentage: 50, weeklyReservePercentage: 30, idleHours: [] },
      tasks: [],
    };

    it('outputs human preview with all 5 AC7 fields and does not call startDaemon', async () => {
      vi.resetModules();
      const startDaemonMock = vi.fn().mockRejectedValue(new Error('should not be called'));
      vi.doMock('../index.js', () => ({
        isJsonMode: () => false,
        getConfigPath: () => undefined,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        startDaemon: startDaemonMock,
        stopDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        getDaemonStatus: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
        DAEMON_RUNNER_FLAG: '--daemon-runner',
      }));
      vi.doMock('../../platform/index.js', () => ({
        getPaths: () => ({ config: '/mock/config.yaml', data: '/mock/data', logs: '/mock/logs' }),
        installService: async () => {
          throw new Error('should not be called');
        },
        uninstallService: async () => {
          throw new Error('should not be called');
        },
      }));
      vi.doMock('../../config/index.js', () => ({
        loadConfig: vi.fn().mockResolvedValue(MOCK_CONFIG),
        resolveConfigFilePath: (configDir: string, override?: string | null) =>
          override ?? join(configDir, 'config.yaml'),
      }));

      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'start', '--dry-run']);

      expect(stdoutOutput).toContain('configPath');
      expect(stdoutOutput).toContain('pollingIntervalSeconds');
      expect(stdoutOutput).toContain('triggerMaxWastePercentage');
      expect(stdoutOutput).toContain('triggerWeeklyReservePercentage');
      expect(stdoutOutput).toContain('providerName');
      expect(startDaemonMock).not.toHaveBeenCalled();
    });

    it('outputs JSON preview with dryRun: true and all 5 AC7 fields', async () => {
      vi.resetModules();
      const startDaemonMock = vi.fn().mockRejectedValue(new Error('should not be called'));
      vi.doMock('../index.js', () => ({
        isJsonMode: () => true,
        getConfigPath: () => undefined,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        startDaemon: startDaemonMock,
        stopDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        getDaemonStatus: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
        DAEMON_RUNNER_FLAG: '--daemon-runner',
      }));
      vi.doMock('../../platform/index.js', () => ({
        getPaths: () => ({ config: '/mock/config', data: '/mock/data', logs: '/mock/logs' }),
        installService: async () => {
          throw new Error('should not be called');
        },
        uninstallService: async () => {
          throw new Error('should not be called');
        },
      }));
      vi.doMock('../../config/index.js', () => ({
        loadConfig: vi.fn().mockResolvedValue(MOCK_CONFIG),
        resolveConfigFilePath: (configDir: string, override?: string | null) =>
          override ?? join(configDir, 'config.yaml'),
      }));

      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'start', '--dry-run']);

      const parsed = JSON.parse(stdoutOutput) as {
        ok: boolean;
        data: {
          dryRun: boolean;
          configPath: string;
          pollingIntervalSeconds: number;
          triggerMaxWastePercentage: number;
          triggerWeeklyReservePercentage: number;
          providerName: string;
        };
        error: null;
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.error).toBeNull();
      expect(parsed.data.dryRun).toBe(true);
      expect(parsed.data.configPath).toBe('/mock/config/config.yaml');
      expect(parsed.data.pollingIntervalSeconds).toBe(300);
      expect(parsed.data.triggerMaxWastePercentage).toBe(50);
      expect(parsed.data.triggerWeeklyReservePercentage).toBe(30);
      expect(parsed.data.providerName).toBe('claude-code');
      expect(startDaemonMock).not.toHaveBeenCalled();
    });

    it('returns CONFIG_NOT_FOUND error in JSON mode when config is missing', async () => {
      vi.resetModules();
      vi.doMock('../../errors/index.js', () => actualErrors);
      const startDaemonMock = vi.fn().mockRejectedValue(new Error('should not be called'));
      vi.doMock('../index.js', () => ({
        isJsonMode: () => true,
        getConfigPath: () => undefined,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        startDaemon: startDaemonMock,
        stopDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        getDaemonStatus: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
        DAEMON_RUNNER_FLAG: '--daemon-runner',
      }));
      vi.doMock('../../platform/index.js', () => ({
        getPaths: () => ({
          config: '/no/such/config.yaml',
          data: '/mock/data',
          logs: '/mock/logs',
        }),
        installService: async () => {
          throw new Error('should not be called');
        },
        uninstallService: async () => {
          throw new Error('should not be called');
        },
      }));
      vi.doMock('../../config/index.js', () => ({
        loadConfig: vi
          .fn()
          .mockRejectedValue(new ScrowError(ErrorCode.CONFIG_NOT_FOUND, 'Config file not found')),
        resolveConfigFilePath: (configDir: string, override?: string | null) =>
          override ?? join(configDir, 'config.yaml'),
      }));

      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'start', '--dry-run']);

      const parsed = JSON.parse(stdoutOutput) as {
        ok: boolean;
        data: null;
        error: { code: string; message: string };
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.data).toBeNull();
      expect(parsed.error.code).toBe('CONFIG_NOT_FOUND');
      expect(startDaemonMock).not.toHaveBeenCalled();
    });

    it('returns CONFIG_INVALID error in JSON mode when config is invalid', async () => {
      vi.resetModules();
      vi.doMock('../../errors/index.js', () => actualErrors);
      const startDaemonMock = vi.fn().mockRejectedValue(new Error('should not be called'));
      vi.doMock('../index.js', () => ({
        isJsonMode: () => true,
        getConfigPath: () => undefined,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        startDaemon: startDaemonMock,
        stopDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        getDaemonStatus: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
        DAEMON_RUNNER_FLAG: '--daemon-runner',
      }));
      vi.doMock('../../platform/index.js', () => ({
        getPaths: () => ({ config: '/mock/config.yaml', data: '/mock/data', logs: '/mock/logs' }),
        installService: async () => {
          throw new Error('should not be called');
        },
        uninstallService: async () => {
          throw new Error('should not be called');
        },
      }));
      vi.doMock('../../config/index.js', () => ({
        loadConfig: vi
          .fn()
          .mockRejectedValue(
            new ScrowError(ErrorCode.CONFIG_INVALID, 'polling_interval is invalid'),
          ),
        resolveConfigFilePath: (configDir: string, override?: string | null) =>
          override ?? join(configDir, 'config.yaml'),
      }));

      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'start', '--dry-run']);

      const parsed = JSON.parse(stdoutOutput) as {
        ok: boolean;
        data: null;
        error: { code: string; message: string };
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.data).toBeNull();
      expect(parsed.error.code).toBe('CONFIG_INVALID');
      expect(startDaemonMock).not.toHaveBeenCalled();
    });

    it('dry-run JSON wrapper always has ok/data/error fields', async () => {
      vi.resetModules();
      vi.doMock('../index.js', () => ({
        isJsonMode: () => true,
        getConfigPath: () => undefined,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        startDaemon: vi.fn(),
        stopDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        getDaemonStatus: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
        DAEMON_RUNNER_FLAG: '--daemon-runner',
      }));
      vi.doMock('../../platform/index.js', () => ({
        getPaths: () => ({ config: '/mock/config.yaml', data: '/mock/data', logs: '/mock/logs' }),
        installService: async () => {
          throw new Error('should not be called');
        },
        uninstallService: async () => {
          throw new Error('should not be called');
        },
      }));
      vi.doMock('../../config/index.js', () => ({
        loadConfig: vi.fn().mockResolvedValue(MOCK_CONFIG),
        resolveConfigFilePath: (configDir: string, override?: string | null) =>
          override ?? join(configDir, 'config.yaml'),
      }));

      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'start', '--dry-run']);

      const parsed = JSON.parse(stdoutOutput) as Record<string, unknown>;
      expect(Object.keys(parsed)).toContain('ok');
      expect(Object.keys(parsed)).toContain('data');
      expect(Object.keys(parsed)).toContain('error');
    });

    it('uses getConfigPath() override when provided instead of getPaths().config', async () => {
      vi.resetModules();
      const loadConfigMock = vi.fn().mockResolvedValue(MOCK_CONFIG);
      vi.doMock('../index.js', () => ({
        isJsonMode: () => true,
        getConfigPath: () => '/custom/path/config.yaml',
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        startDaemon: vi.fn(),
        stopDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        getDaemonStatus: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
        DAEMON_RUNNER_FLAG: '--daemon-runner',
      }));
      vi.doMock('../../platform/index.js', () => ({
        getPaths: () => ({
          config: '/platform/config.yaml',
          data: '/mock/data',
          logs: '/mock/logs',
        }),
        installService: async () => {
          throw new Error('should not be called');
        },
        uninstallService: async () => {
          throw new Error('should not be called');
        },
      }));
      vi.doMock('../../config/index.js', () => ({
        loadConfig: loadConfigMock,
        resolveConfigFilePath: (configDir: string, override?: string | null) =>
          override ?? join(configDir, 'config.yaml'),
      }));

      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'start', '--dry-run']);

      // loadConfig should have been called with the custom path
      expect(loadConfigMock).toHaveBeenCalledWith('/custom/path/config.yaml');

      const parsed = JSON.parse(stdoutOutput) as { ok: boolean; data: { configPath: string } };
      expect(parsed.data.configPath).toBe('/custom/path/config.yaml');
    });

    it('writes error to stderr with suggestion in human mode when config is missing', async () => {
      vi.resetModules();
      vi.doMock('../../errors/index.js', () => actualErrors);
      const startDaemonMock = vi.fn().mockRejectedValue(new Error('should not be called'));
      vi.doMock('../index.js', () => ({
        isJsonMode: () => false,
        getConfigPath: () => undefined,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        startDaemon: startDaemonMock,
        stopDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        getDaemonStatus: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
        DAEMON_RUNNER_FLAG: '--daemon-runner',
      }));
      vi.doMock('../../platform/index.js', () => ({
        getPaths: () => ({
          config: '/no/such/config.yaml',
          data: '/mock/data',
          logs: '/mock/logs',
        }),
        installService: async () => {
          throw new Error('should not be called');
        },
        uninstallService: async () => {
          throw new Error('should not be called');
        },
      }));
      vi.doMock('../../config/index.js', () => ({
        loadConfig: vi
          .fn()
          .mockRejectedValue(new ScrowError(ErrorCode.CONFIG_NOT_FOUND, 'Config file not found')),
        resolveConfigFilePath: (configDir: string, override?: string | null) =>
          override ?? join(configDir, 'config.yaml'),
      }));

      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'start', '--dry-run']);

      expect(stderrOutput).toContain('error:');
      expect(stderrOutput).toContain('Config file not found');
      expect(stderrOutput).toContain('->');
      expect(stdoutOutput).toBe('');
      expect(startDaemonMock).not.toHaveBeenCalled();
    });

    it('writes error to stderr with suggestion in human mode when config is invalid', async () => {
      vi.resetModules();
      vi.doMock('../../errors/index.js', () => actualErrors);
      const startDaemonMock = vi.fn().mockRejectedValue(new Error('should not be called'));
      vi.doMock('../index.js', () => ({
        isJsonMode: () => false,
        getConfigPath: () => undefined,
        EXIT: { ERROR: 1, DAEMON_NOT_RUNNING: 2 },
      }));
      vi.doMock('../../daemon/index.js', () => ({
        startDaemon: startDaemonMock,
        stopDaemon: async () => {
          throw new Error('should not be called');
        },
        restartDaemon: async () => {
          throw new Error('should not be called');
        },
        reloadDaemon: async () => {
          throw new Error('should not be called');
        },
        getDaemonStatus: async () => {
          throw new Error('should not be called');
        },
        DAEMON_STOP_TIMEOUT_MS: 5000,
        DAEMON_RUNNER_FLAG: '--daemon-runner',
      }));
      vi.doMock('../../platform/index.js', () => ({
        getPaths: () => ({ config: '/mock/config.yaml', data: '/mock/data', logs: '/mock/logs' }),
        installService: async () => {
          throw new Error('should not be called');
        },
        uninstallService: async () => {
          throw new Error('should not be called');
        },
      }));
      vi.doMock('../../config/index.js', () => ({
        loadConfig: vi
          .fn()
          .mockRejectedValue(
            new ScrowError(ErrorCode.CONFIG_INVALID, 'polling_interval is invalid'),
          ),
        resolveConfigFilePath: (configDir: string, override?: string | null) =>
          override ?? join(configDir, 'config.yaml'),
      }));

      const { registerDaemon } = await import('./daemon.js');
      const program = makeProgram();
      registerDaemon(program);
      await program.parseAsync(['node', 'sparecrow', 'daemon', 'start', '--dry-run']);

      expect(stderrOutput).toContain('error:');
      expect(stderrOutput).toContain('polling_interval is invalid');
      expect(stderrOutput).toContain('->');
      expect(stdoutOutput).toBe('');
      expect(startDaemonMock).not.toHaveBeenCalled();
    });
  });
});

// ---- formatElapsed() unit tests (AC6) ----

describe('formatElapsed()', () => {
  it('returns "0s" for a future startedAt timestamp', () => {
    const future = new Date(Date.now() + 5000).toISOString();
    expect(formatElapsed(future)).toBe('0s');
  });

  it('returns "0s" for an invalid timestamp', () => {
    expect(formatElapsed('not-a-date')).toBe('0s');
  });

  it('returns seconds-only format for elapsed < 60 seconds', () => {
    const startedAt = new Date(Date.now() - 45_000).toISOString();
    const result = formatElapsed(startedAt);
    expect(result).toMatch(/^\d+s$/);
    expect(result).toBe('45s');
  });

  it('returns minutes and seconds for elapsed between 1 and 60 minutes', () => {
    const startedAt = new Date(Date.now() - 90_000).toISOString();
    const result = formatElapsed(startedAt);
    // 90 seconds = 1m 30s
    expect(result).toBe('1m 30s');
  });

  it('returns hours and minutes for elapsed >= 60 minutes', () => {
    const startedAt = new Date(Date.now() - 3_720_000).toISOString();
    const result = formatElapsed(startedAt);
    // 3720 seconds = 62 minutes = 1h 2m
    expect(result).toBe('1h 2m');
  });

  it('returns "0s" for exactly now', () => {
    const startedAt = new Date().toISOString();
    const result = formatElapsed(startedAt);
    expect(result).toMatch(/^\d+s$/);
  });
});
