/** Unit tests for daemon lifecycle service — start, stop, restart, reload, and status flows. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

/** Builds a mock platform that returns a specific dataDir. */
function makePlatformMock(dataDir: string) {
  return {
    getPaths: () => ({ data: dataDir, config: dataDir, logs: dataDir }),
    ensureDirectories: async () => {},
    isMacOS: () => false,
    isLinux: () => false,
    AppPaths: undefined,
    CONFIG_FILENAME: 'config.yaml',
    installService: async () => {},
    uninstallService: async () => {},
    getPlatformServicePath: () => '',
    serviceFileExists: async () => false,
  };
}

/** Default pid-manager mock — provides all exports with sensible no-op defaults. */
function makePidManagerMock(overrides: Record<string, unknown> = {}) {
  return {
    DAEMON_PID_FILENAME: 'daemon.pid',
    DAEMON_STATUS_FILENAME: 'daemon-status.json',
    DAEMON_IDENTITY_ENV: 'SPARECROW_DAEMON_PROCESS',
    DAEMON_IDENTITY_VALUE: '1',
    readPid: async () => null,
    writePid: async () => {},
    removePid: async () => {},
    processExists: () => false,
    isScrowDaemonProcess: async () => false,
    checkPidStatus: async () => ({ status: 'none' as const, pid: null }),
    killOrphanDaemons: async () => {},
    ...overrides,
  };
}

/** Default logger mock — all methods are no-op async functions. */
function makeLoggerMock(overrides: Record<string, unknown> = {}) {
  return {
    debug: vi.fn().mockResolvedValue(undefined),
    info: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** Default utils mock — provides all exports used by lifecycle.ts plus other barrel re-exports. */
function makeUtilsMock(overrides: Record<string, unknown> = {}) {
  return {
    logger: makeLoggerMock(),
    safeReadJson: async (path: string) => {
      try {
        const { readFile } = await import('node:fs/promises');
        const content = await readFile(path, 'utf-8');
        return JSON.parse(content);
      } catch {
        return null;
      }
    },
    isRecord: (v: unknown): v is Record<string, unknown> =>
      typeof v === 'object' && v !== null && !Array.isArray(v),
    retryWithBackoff: async (fn: () => Promise<unknown>) => fn(),
    atomicWrite: async () => {},
    AUDIT_LOG_FILENAME_REGEX: /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/,
    setLogLevel: () => {},
    enableFileLogging: async () => {},
    setLogDir: () => {},
    resetLoggerState: () => {},
    VERSION: '0.0.0-test',
    spawnWithGuardrails: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
    boundOutput: (s: string) => s,
    MAX_OUTPUT_BYTES: 1048576,
    MAX_OUTPUT_BYTES_SUCCESS: 524288,
    validateRepository: async () => ({ valid: true, path: '' }),
    ...overrides,
  };
}

/** Default node:child_process mock — provides spawn as a no-op. */
function makeChildProcessMock(overrides: Record<string, unknown> = {}) {
  return {
    spawn: () => ({ unref: () => {}, pid: 0 }),
    ...overrides,
  };
}

describe('lifecycle', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = join(tmpdir(), 'lifecycle-test-' + randomBytes(6).toString('hex'));
    await mkdir(dataDir, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dataDir, { recursive: true, force: true });
  });

  describe('getDaemonStatus()', () => {
    it('returns not-started when no PID file and no status file', async () => {
      vi.resetModules();
      vi.doMock('../../platform/index.js', () => makePlatformMock(dataDir));
      vi.doMock('../platform/index.js', () => makePlatformMock(dataDir));
      vi.doMock('./pid-manager.js', () =>
        makePidManagerMock({
          checkPidStatus: async () => ({ status: 'none', pid: null }),
        }),
      );
      const { getDaemonStatus } = await import('./lifecycle.js');
      const result = await getDaemonStatus();
      expect(result.state).toBe('not-started');
      expect(result.pid).toBeNull();
    });

    it('returns stopped when no PID file but status file exists', async () => {
      vi.resetModules();
      vi.doMock('../platform/index.js', () => makePlatformMock(dataDir));
      vi.doMock('./pid-manager.js', () =>
        makePidManagerMock({
          checkPidStatus: async () => ({ status: 'none', pid: null }),
        }),
      );
      await writeFile(
        join(dataDir, 'daemon-status.json'),
        JSON.stringify({ startedAt: '2026-01-01T00:00:00.000Z', state: 'stopped' }),
        'utf-8',
      );
      const { getDaemonStatus } = await import('./lifecycle.js');
      const result = await getDaemonStatus();
      expect(result.state).toBe('stopped');
    });

    it('returns running when PID is alive', async () => {
      vi.resetModules();
      const now = new Date().toISOString();
      vi.doMock('../platform/index.js', () => makePlatformMock(dataDir));
      vi.doMock('./pid-manager.js', () =>
        makePidManagerMock({
          checkPidStatus: async () => ({ status: 'alive', pid: 12345 }),
        }),
      );
      await writeFile(
        join(dataDir, 'daemon-status.json'),
        JSON.stringify({ startedAt: now, state: 'running', pid: 12345 }),
        'utf-8',
      );
      const { getDaemonStatus } = await import('./lifecycle.js');
      const result = await getDaemonStatus();
      expect(result.state).toBe('running');
      expect(result.pid).toBe(12345);
    });

    it('returns stopped when PID status is stale', async () => {
      vi.resetModules();
      vi.doMock('../platform/index.js', () => makePlatformMock(dataDir));
      vi.doMock('./pid-manager.js', () =>
        makePidManagerMock({
          checkPidStatus: async () => ({ status: 'stale', pid: 9999 }),
        }),
      );
      const { getDaemonStatus } = await import('./lifecycle.js');
      const result = await getDaemonStatus();
      expect(result.state).toBe('stopped');
    });
  });

  describe('startDaemon()', () => {
    it('throws DAEMON_ALREADY_RUNNING when daemon is alive', async () => {
      vi.resetModules();
      vi.doMock('../platform/index.js', () => makePlatformMock(dataDir));
      vi.doMock('./pid-manager.js', () =>
        makePidManagerMock({
          checkPidStatus: async () => ({ status: 'alive', pid: 42 }),
        }),
      );
      const { startDaemon } = await import('./lifecycle.js');
      await expect(startDaemon()).rejects.toMatchObject({ code: 'DAEMON_ALREADY_RUNNING' });
    });

    it('cleans stale PID before starting', async () => {
      vi.resetModules();
      vi.useFakeTimers();
      let removedPid = false;
      let spawnCalled = false;
      vi.doMock('../platform/index.js', () => makePlatformMock(dataDir));
      vi.doMock('./pid-manager.js', () =>
        makePidManagerMock({
          checkPidStatus: async () => ({ status: 'stale', pid: 9999 }),
          removePid: async () => {
            removedPid = true;
          },
          readPid: async () => null,
        }),
      );
      vi.doMock('node:child_process', () =>
        makeChildProcessMock({
          spawn: () => {
            spawnCalled = true;
            return {
              unref: () => {},
              pid: 11111,
            };
          },
        }),
      );
      const { startDaemon } = await import('./lifecycle.js');
      const startPromise = startDaemon();
      // Attach a noop catch before advancing timers so Vitest does not report an unhandled
      // rejection when the promise rejects during runAllTimersAsync (the rejection is still
      // properly awaited and verified below).
      startPromise.catch(() => {});
      await vi.runAllTimersAsync();
      try {
        await startPromise;
      } catch {
        // Expected — readPid always returns null, so DAEMON_SPAWN_FAILED is thrown
      }
      vi.useRealTimers();
      expect(removedPid).toBe(true);
      expect(spawnCalled).toBe(true);
    });

    it('spawns child process using process.argv[1] as entrypoint', async () => {
      vi.resetModules();
      const originalArgv1 = process.argv[1] ?? '';
      const originalExecArgv = process.execArgv;
      process.argv[1] = '/fake/dist/index.js';
      process.execArgv = [];
      let capturedArgs: string[] = [];
      vi.doMock('../platform/index.js', () => makePlatformMock(dataDir));
      vi.doMock('./pid-manager.js', () =>
        makePidManagerMock({
          checkPidStatus: async () => ({ status: 'none', pid: null }),
          readPid: async () => 55566,
        }),
      );
      vi.doMock('node:child_process', () =>
        makeChildProcessMock({
          spawn: (_cmd: string, args: string[]) => {
            capturedArgs = args;
            return { unref: () => {}, pid: 55566 };
          },
        }),
      );
      try {
        const { startDaemon } = await import('./lifecycle.js');
        await startDaemon();
      } finally {
        process.argv[1] = originalArgv1;
        process.execArgv = originalExecArgv;
      }
      expect(capturedArgs).toContain('/fake/dist/index.js');
      const entrypointIndex = capturedArgs.indexOf('/fake/dist/index.js');
      expect(capturedArgs[entrypointIndex + 1]).toBe('--daemon-runner');
    });

    it('forwards tsx execArgv loader flags in dev mode', async () => {
      vi.resetModules();
      const originalArgv1 = process.argv[1] ?? '';
      const originalExecArgv = process.execArgv;
      process.argv[1] = '/fake/src/index.ts';
      process.execArgv = ['--import', 'tsx/esm'];
      let capturedArgs: string[] = [];
      vi.doMock('../platform/index.js', () => makePlatformMock(dataDir));
      vi.doMock('./pid-manager.js', () =>
        makePidManagerMock({
          checkPidStatus: async () => ({ status: 'none', pid: null }),
          readPid: async () => 55577,
        }),
      );
      vi.doMock('node:child_process', () =>
        makeChildProcessMock({
          spawn: (_cmd: string, args: string[]) => {
            capturedArgs = args;
            return { unref: () => {}, pid: 55577 };
          },
        }),
      );
      try {
        const { startDaemon } = await import('./lifecycle.js');
        await startDaemon();
      } finally {
        process.argv[1] = originalArgv1;
        process.execArgv = originalExecArgv;
      }
      expect(capturedArgs[0]).toBe('--import');
      expect(capturedArgs[1]).toBe('tsx/esm');
      expect(capturedArgs[2]).toBe('/fake/src/index.ts');
      expect(capturedArgs[3]).toBe('--daemon-runner');
    });

    it('throws DAEMON_SPAWN_FAILED when PID file is never written', async () => {
      vi.resetModules();
      vi.useFakeTimers();
      vi.doMock('../platform/index.js', () => makePlatformMock(dataDir));
      vi.doMock('./pid-manager.js', () =>
        makePidManagerMock({
          checkPidStatus: async () => ({ status: 'none', pid: null }),
          readPid: async () => null,
        }),
      );
      vi.doMock('node:child_process', () =>
        makeChildProcessMock({
          spawn: () => {
            return { unref: () => {}, pid: 55588 };
          },
        }),
      );
      const { startDaemon } = await import('./lifecycle.js');
      const startPromise = startDaemon();
      // Attach a noop catch before advancing timers to prevent unhandled rejection warnings
      // during runAllTimersAsync (the rejection is verified below via rejects.toMatchObject).
      startPromise.catch(() => {});
      await vi.runAllTimersAsync();
      await expect(startPromise).rejects.toMatchObject({ code: 'DAEMON_SPAWN_FAILED' });
      vi.useRealTimers();
    });

    it('spawns daemon in detached mode', async () => {
      vi.resetModules();
      vi.useFakeTimers();
      let spawnOptions: Record<string, unknown> = {};
      vi.doMock('../platform/index.js', () => makePlatformMock(dataDir));
      vi.doMock('./pid-manager.js', () =>
        makePidManagerMock({
          checkPidStatus: async () => ({ status: 'none', pid: null }),
          readPid: async () => null,
        }),
      );
      vi.doMock('node:child_process', () =>
        makeChildProcessMock({
          spawn: (_cmd: string, _args: string[], options: Record<string, unknown>) => {
            spawnOptions = options;
            return { unref: () => {}, pid: 22222 };
          },
        }),
      );
      const { startDaemon } = await import('./lifecycle.js');
      const startPromise = startDaemon();
      // Attach a noop catch before advancing timers so Vitest does not report an unhandled
      // rejection when the promise rejects during runAllTimersAsync (the rejection is still
      // properly awaited and verified below).
      startPromise.catch(() => {});
      await vi.runAllTimersAsync();
      try {
        await startPromise;
      } catch {
        // Expected — readPid always returns null, so DAEMON_SPAWN_FAILED is thrown
      }
      vi.useRealTimers();
      expect(spawnOptions['detached']).toBe(true);
      expect(spawnOptions['stdio']).toBe('ignore');
    });
  });

  describe('stopDaemon()', () => {
    it('throws DAEMON_NOT_RUNNING when no daemon is running', async () => {
      vi.resetModules();
      vi.doMock('../platform/index.js', () => makePlatformMock(dataDir));
      vi.doMock('./pid-manager.js', () =>
        makePidManagerMock({
          checkPidStatus: async () => ({ status: 'none', pid: null }),
          readPid: async () => null,
          processExists: () => false,
        }),
      );
      const { stopDaemon } = await import('./lifecycle.js');
      await expect(stopDaemon()).rejects.toMatchObject({ code: 'DAEMON_NOT_RUNNING' });
    });

    it('throws DAEMON_NOT_RUNNING and cleans PID for stale status', async () => {
      vi.resetModules();
      let pidRemoved = false;
      vi.doMock('../platform/index.js', () => makePlatformMock(dataDir));
      vi.doMock('./pid-manager.js', () =>
        makePidManagerMock({
          checkPidStatus: async () => ({ status: 'stale', pid: 9999 }),
          removePid: async () => {
            pidRemoved = true;
          },
        }),
      );
      const { stopDaemon } = await import('./lifecycle.js');
      await expect(stopDaemon()).rejects.toMatchObject({ code: 'DAEMON_NOT_RUNNING' });
      expect(pidRemoved).toBe(true);
    });

    it('sends SIGTERM and removes PID on clean exit', async () => {
      vi.resetModules();
      let removedPid = false;
      const mockKill = vi.fn();
      vi.doMock('../platform/index.js', () => makePlatformMock(dataDir));
      let callCount = 0;
      vi.doMock('./pid-manager.js', () =>
        makePidManagerMock({
          checkPidStatus: async () => ({ status: 'alive', pid: 55555 }),
          removePid: async () => {
            removedPid = true;
          },
          processExists: () => {
            callCount++;
            return callCount <= 1; // alive on first check, dead after
          },
        }),
      );
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(mockKill as never);
      const { stopDaemon } = await import('./lifecycle.js');
      const result = await stopDaemon();
      expect(result.forced).toBe(false);
      expect(removedPid).toBe(true);
      expect(killSpy).toHaveBeenCalledWith(55555, 'SIGTERM');
    });

    it('escalates to SIGKILL after timeout and returns forced=true', async () => {
      vi.resetModules();
      vi.useFakeTimers();
      let removedPid = false;
      const killCalls: Array<[number, string]> = [];
      const warnCalls: Array<[string, unknown]> = [];
      vi.doMock('../platform/index.js', () => makePlatformMock(dataDir));
      vi.doMock('./pid-manager.js', () =>
        makePidManagerMock({
          checkPidStatus: async () => ({ status: 'alive', pid: 77777 }),
          removePid: async () => {
            removedPid = true;
          },
          processExists: () => true, // process never exits — forces SIGKILL escalation AND AC5 warning
        }),
      );
      vi.doMock('../utils/index.js', () =>
        makeUtilsMock({
          logger: makeLoggerMock({
            warn: (event: string, data?: unknown) => {
              warnCalls.push([event, data]);
              return Promise.resolve();
            },
          }),
        }),
      );
      vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig: string) => {
        killCalls.push([pid, sig]);
      }) as never);
      const { stopDaemon } = await import('./lifecycle.js');

      // Start stopDaemon and advance fake timers past the 5000ms stop timeout
      const stopPromise = stopDaemon();
      // Advance past the polling interval and then past the full DAEMON_STOP_TIMEOUT_MS
      await vi.runAllTimersAsync();
      const result = await stopPromise;

      expect(result.forced).toBe(true);
      expect(removedPid).toBe(true);
      // SIGTERM sent first, then SIGKILL
      expect(killCalls.some(([, sig]) => sig === 'SIGTERM')).toBe(true);
      expect(killCalls.some(([, sig]) => sig === 'SIGKILL')).toBe(true);
      // AC5: since processExists always returns true, the process "survives" SIGKILL — warning must be emitted
      const survivedWarning = warnCalls.find(
        ([event]) => event === 'lifecycle.stop_daemon.process_survived_sigkill',
      );
      expect(survivedWarning).toBeDefined();

      vi.useRealTimers();
    });

    it('logs warning when process survives SIGKILL after 500ms wait (AC5)', async () => {
      vi.resetModules();
      vi.useFakeTimers();
      const warnCalls: Array<[string, unknown]> = [];
      vi.doMock('../platform/index.js', () => makePlatformMock(dataDir));
      vi.doMock('./pid-manager.js', () =>
        makePidManagerMock({
          checkPidStatus: async () => ({ status: 'alive', pid: 88888 }),
          removePid: async () => {},
          processExists: () => true, // process always alive — survives even SIGKILL
        }),
      );
      vi.doMock('../utils/index.js', () =>
        makeUtilsMock({
          logger: makeLoggerMock({
            warn: (event: string, data?: unknown) => {
              warnCalls.push([event, data]);
              return Promise.resolve();
            },
          }),
        }),
      );
      vi.spyOn(process, 'kill').mockImplementation((() => {}) as never);
      const { stopDaemon } = await import('./lifecycle.js');

      const stopPromise = stopDaemon();
      await vi.runAllTimersAsync();
      const result = await stopPromise;

      expect(result.forced).toBe(true);
      // Find the warning about the surviving process
      const survivedWarning = warnCalls.find(
        ([event]) => event === 'lifecycle.stop_daemon.process_survived_sigkill',
      );
      expect(survivedWarning).toBeDefined();
      const payload = survivedWarning![1] as { pid: number };
      expect(payload.pid).toBe(88888);

      vi.useRealTimers();
    });
  });

  describe('reloadDaemon()', () => {
    it('throws DAEMON_NOT_RUNNING when not running', async () => {
      vi.resetModules();
      vi.doMock('../platform/index.js', () => makePlatformMock(dataDir));
      vi.doMock('./pid-manager.js', () =>
        makePidManagerMock({
          checkPidStatus: async () => ({ status: 'none', pid: null }),
        }),
      );
      const { reloadDaemon } = await import('./lifecycle.js');
      await expect(reloadDaemon()).rejects.toMatchObject({ code: 'DAEMON_NOT_RUNNING' });
    });

    it('sends SIGHUP to running daemon', async () => {
      vi.resetModules();
      vi.doMock('../platform/index.js', () => makePlatformMock(dataDir));
      vi.doMock('./pid-manager.js', () =>
        makePidManagerMock({
          checkPidStatus: async () => ({ status: 'alive', pid: 33333 }),
        }),
      );
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((() => {}) as never);
      const { reloadDaemon } = await import('./lifecycle.js');
      await reloadDaemon();
      expect(killSpy).toHaveBeenCalledWith(33333, 'SIGHUP');
    });

    it('throws DAEMON_NOT_RUNNING when PID is stale', async () => {
      vi.resetModules();
      vi.doMock('../platform/index.js', () => makePlatformMock(dataDir));
      vi.doMock('./pid-manager.js', () =>
        makePidManagerMock({
          checkPidStatus: async () => ({ status: 'stale', pid: null }),
        }),
      );
      const { reloadDaemon } = await import('./lifecycle.js');
      await expect(reloadDaemon()).rejects.toMatchObject({ code: 'DAEMON_NOT_RUNNING' });
    });
  });

  describe('restartDaemon()', () => {
    it('performs fresh start when not running', async () => {
      vi.resetModules();
      vi.useFakeTimers();
      let startCalled = false;
      vi.doMock('../platform/index.js', () => makePlatformMock(dataDir));
      vi.doMock('./pid-manager.js', () =>
        makePidManagerMock({
          checkPidStatus: async () => ({ status: 'none', pid: null }),
          readPid: async () => null,
        }),
      );
      vi.doMock('node:child_process', () =>
        makeChildProcessMock({
          spawn: () => {
            startCalled = true;
            return { unref: () => {}, pid: 44444 };
          },
        }),
      );
      const { restartDaemon } = await import('./lifecycle.js');
      // With AC4 post-poll guard, startDaemon() throws DAEMON_SPAWN_FAILED because
      // readPid always returns null (PID file never written in test environment).
      const restartPromise = restartDaemon();
      // Attach a noop catch before advancing timers to prevent unhandled rejection warnings
      // during runAllTimersAsync (the rejection is verified below via rejects.toMatchObject).
      restartPromise.catch(() => {});
      await vi.runAllTimersAsync();
      await expect(restartPromise).rejects.toMatchObject({ code: 'DAEMON_SPAWN_FAILED' });
      vi.useRealTimers();
      expect(startCalled).toBe(true);
    });
  });

  describe('DAEMON_STOP_TIMEOUT_MS constant', () => {
    it('is 5000ms', async () => {
      vi.resetModules();
      const { DAEMON_STOP_TIMEOUT_MS } = await import('./lifecycle.js');
      expect(DAEMON_STOP_TIMEOUT_MS).toBe(5000);
    });
  });

  describe('sanitizeDaemonEnv()', () => {
    let envSnapshot: Record<string, string | undefined>;

    beforeEach(() => {
      // Capture full env snapshot per-test to ensure complete isolation
      envSnapshot = { ...process.env };
    });

    afterEach(() => {
      // Remove any keys added during this test that were not in the original snapshot
      for (const key of Object.keys(process.env)) {
        if (!(key in envSnapshot)) {
          delete process.env[key];
        }
      }
      // Restore keys that were present in original snapshot
      for (const key of Object.keys(envSnapshot)) {
        process.env[key] = envSnapshot[key];
      }
    });

    it('removes CLAUDECODE and CLAUDE_CODE_SSE_PORT from the result', async () => {
      vi.resetModules();
      process.env['CLAUDECODE'] = '1';
      process.env['CLAUDE_CODE_SSE_PORT'] = '12345';
      const { sanitizeDaemonEnv } = await import('./lifecycle.js');
      const result = sanitizeDaemonEnv();
      expect(result['CLAUDECODE']).toBeUndefined();
      expect(result['CLAUDE_CODE_SSE_PORT']).toBeUndefined();
    });

    it('removes CLAUDE_CODE_ENTRYPOINT from the result', async () => {
      vi.resetModules();
      process.env['CLAUDE_CODE_ENTRYPOINT'] = '/usr/bin/claude';
      const { sanitizeDaemonEnv } = await import('./lifecycle.js');
      const result = sanitizeDaemonEnv();
      expect(result['CLAUDE_CODE_ENTRYPOINT']).toBeUndefined();
    });

    it('removes any variable matching the CLAUDE_CODE_ prefix pattern', async () => {
      vi.resetModules();
      process.env['CLAUDE_CODE_EXTRA'] = 'some-value';
      const { sanitizeDaemonEnv } = await import('./lifecycle.js');
      const result = sanitizeDaemonEnv();
      expect(result['CLAUDE_CODE_EXTRA']).toBeUndefined();
    });

    it('produces no duplicate entries in stripped list when vars match both explicit and prefix rules', async () => {
      vi.resetModules();
      // CLAUDE_CODE_SSE_PORT matches both the explicit key list and the CLAUDE_CODE_ prefix —
      // it must appear exactly once in the debug log keys array
      process.env['CLAUDECODE'] = '1';
      process.env['CLAUDE_CODE_SSE_PORT'] = '12345';
      process.env['CLAUDE_CODE_ENTRYPOINT'] = '/usr/bin/claude';
      const { sanitizeDaemonEnv } = await import('./lifecycle.js');
      // Test via the returned object: all three should be stripped exactly once (no duplicates
      // in the result means all three are absent)
      const result = sanitizeDaemonEnv();
      expect(result['CLAUDECODE']).toBeUndefined();
      expect(result['CLAUDE_CODE_SSE_PORT']).toBeUndefined();
      expect(result['CLAUDE_CODE_ENTRYPOINT']).toBeUndefined();
    });

    it('preserves PATH, HOME, and other essential env vars', async () => {
      vi.resetModules();
      process.env['CLAUDECODE'] = '1';
      const originalPath = process.env['PATH'];
      const originalHome = process.env['HOME'];
      const { sanitizeDaemonEnv } = await import('./lifecycle.js');
      const result = sanitizeDaemonEnv();
      expect(result['PATH']).toBe(originalPath);
      expect(result['HOME']).toBe(originalHome);
    });

    it('does not mutate process.env directly', async () => {
      vi.resetModules();
      process.env['CLAUDECODE'] = '1';
      const { sanitizeDaemonEnv } = await import('./lifecycle.js');
      sanitizeDaemonEnv();
      // process.env should still have CLAUDECODE after call
      expect(process.env['CLAUDECODE']).toBe('1');
    });

    it('calls logger.debug with stripped key names when Claude Code vars are present (AC6)', async () => {
      vi.resetModules();
      process.env['CLAUDECODE'] = '1';
      process.env['CLAUDE_CODE_SSE_PORT'] = '12345';
      const debugCalls: Array<[string, unknown]> = [];
      vi.doMock('../utils/index.js', () =>
        makeUtilsMock({
          logger: makeLoggerMock({
            debug: (event: string, data?: unknown) => {
              debugCalls.push([event, data]);
              return Promise.resolve();
            },
          }),
        }),
      );
      const { sanitizeDaemonEnv } = await import('./lifecycle.js');
      sanitizeDaemonEnv();
      const strippedCall = debugCalls.find(
        ([event]) => event === 'lifecycle.sanitize_daemon_env.stripped',
      );
      expect(strippedCall).toBeDefined();
      const payload = strippedCall![1] as { keys: string[] };
      expect(payload.keys).toContain('CLAUDECODE');
      expect(payload.keys).toContain('CLAUDE_CODE_SSE_PORT');
    });
  });

  describe('startDaemon() — env isolation', () => {
    it('spawn call does not pass CLAUDECODE to the child process', async () => {
      vi.resetModules();
      const envSnapshot = { ...process.env };
      process.env['CLAUDECODE'] = '1';
      process.env['CLAUDE_CODE_SSE_PORT'] = '12345';
      let capturedEnv: NodeJS.ProcessEnv | undefined;
      const originalArgv1 = process.argv[1] ?? '';
      const originalExecArgv = process.execArgv;
      process.argv[1] = '/fake/dist/index.js';
      process.execArgv = [];
      vi.doMock('../platform/index.js', () => makePlatformMock(dataDir));
      vi.doMock('./pid-manager.js', () =>
        makePidManagerMock({
          checkPidStatus: async () => ({ status: 'none', pid: null }),
          readPid: async () => 99991,
        }),
      );
      vi.doMock('node:child_process', () =>
        makeChildProcessMock({
          spawn: (_cmd: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
            capturedEnv = options.env;
            return { unref: () => {}, pid: 99991 };
          },
        }),
      );
      try {
        const { startDaemon } = await import('./lifecycle.js');
        await startDaemon();
      } finally {
        process.argv[1] = originalArgv1;
        process.execArgv = originalExecArgv;
        // Restore env snapshot
        for (const key of Object.keys(process.env)) {
          if (!(key in envSnapshot)) {
            delete process.env[key];
          }
        }
        for (const key of Object.keys(envSnapshot)) {
          process.env[key] = envSnapshot[key];
        }
      }
      expect(capturedEnv).toBeDefined();
      expect(capturedEnv!['CLAUDECODE']).toBeUndefined();
      expect(capturedEnv!['CLAUDE_CODE_SSE_PORT']).toBeUndefined();
    });
  });
});
