/** Unit tests for daemon runner bootstrap — isDaemonRunner, runDaemon entry path, and createDispatchAdapter. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { DispatchCycleResult } from '../types/index.js';
import type { TriggerResult } from '../types/index.js';
import { ScrowError, ErrorCode } from '../errors/index.js';

// ---------------------------------------------------------------------------
// Shared mock-setup helper
// Eliminates ~130 lines of verbatim duplication between runDaemon() tests.
// Each test calls setupRunDaemonMocks() after vi.resetModules() and can
// optionally override individual mocks by passing an overrides object.
// ---------------------------------------------------------------------------

interface MockOverrides {
  /** Override the platform.getPaths() return value. */
  getPaths?: () => { data: string; config: string; logs: string; taskOutputs: string };
  /** Override the QueueStore class constructor to spy on args or capture state. */
  QueueStoreImpl?: new (dir: string) => { filePath?: string };
  /** Override QueueManager class. */
  QueueManagerImpl?: new (...args: unknown[]) => { listDispatchable: () => Promise<unknown[]> };
  /** Override Dispatcher class. */
  DispatcherImpl?: new (...args: unknown[]) => { dispatch: () => Promise<unknown> };
  /** Override PollingLoop class. */
  PollingLoopImpl?: new (...args: unknown[]) => {
    readonly lastPollAt: string | null;
    reload: () => void;
    start: () => Promise<void>;
    stop: () => Promise<void>;
  };
  /** Override loadConfig return value. */
  loadConfigResult?: object;
  /** Override loadConfig to throw. */
  loadConfigThrows?: Error;
  /** Override loadConfig with a custom function (takes precedence over loadConfigThrows). */
  loadConfigFn?: (configPath: string) => Promise<object>;
  /** Override createProvider to throw. */
  createProviderThrows?: Error;
  /** Override atomicWrite. */
  atomicWrite?: (_path: string, content: string) => Promise<void>;
  /** Override enableFileLogging to spy on calls. Defaults to a no-op to prevent real filesystem I/O. */
  enableFileLogging?: () => void;
  /** Override setLogDir to spy on calls. Defaults to a no-op. */
  setLogDir?: (dir: string) => void;
  /** Called when ensureDirectories is invoked. */
  onEnsureDirectories?: () => void;
  /** Spy on writtenPids. */
  writtenPids?: Array<[string, number]>;
  /** Override removePid to spy or throw. */
  removePidImpl?: (dir: string) => Promise<void>;
  /**
   * Override retryWithBackoff with a no-delay implementation.
   * When set to true, replaces retryWithBackoff with a version that retries immediately
   * (no setTimeout delays) — prevents real-time wait during retry exhaustion tests.
   * CLAUDE.md §6: "Mock external I/O at test boundaries."
   */
  useInstantRetry?: boolean;
  createConfigWatcher?: (...args: unknown[]) => { close: () => void };
  skipSignalHandlerMock?: boolean;
  providersMock?: Record<string, unknown>;
  /** Full config mock object — when provided, replaces the entire ../config/index.js mock. */
  configMock?: Record<string, unknown>;
  /** Override PidLock.acquire() return value (default: true — lock acquired). */
  pidLockAcquireResult?: boolean;
}

/**
 * Registers all vi.doMock() calls needed for runDaemon() tests.
 * Must be called AFTER vi.resetModules() and BEFORE importing runner.js.
 *
 * @param dataDir - The temp directory to use as paths.data / paths.config / paths.logs
 * @param overrides - Optional per-test overrides for individual mocks
 */
function setupRunDaemonMocks(dataDir: string, overrides: MockOverrides = {}): void {
  const defaultConfig = {
    pollingInterval: 300,
    logRetentionDays: 30,
    taskTimeoutMinutes: 60,
    provider: {
      name: 'claude-code',
      allowDangerouslySkipPermissions: false,
      executionBackend: 'container',
    },
    trigger: { maxWastePercentage: 50, weeklyReservePercentage: 30, idleHours: [] },
    tasks: [],
    lastSummaryEnabled: false,
  };

  vi.doMock('../platform/index.js', () => ({
    getPaths:
      overrides.getPaths ??
      (() => ({
        data: dataDir,
        config: dataDir,
        logs: dataDir,
        taskOutputs: dataDir,
      })),
    ensureDirectories: async () => {
      overrides.onEnsureDirectories?.();
    },
    isMacOS: () => false,
    isLinux: () => false,
    AppPaths: undefined,
  }));

  const QueueStoreImpl =
    overrides.QueueStoreImpl ??
    class DefaultMockQueueStore {
      constructor(_dir: string) {}
    };

  const QueueManagerImpl =
    overrides.QueueManagerImpl ??
    class DefaultMockQueueManager {
      constructor() {}
      async listDispatchable() {
        return [];
      }
      async resetInProgressTasks() {
        return 0;
      }
      async countInProgress() {
        return 0;
      }
      async countWorkload() {
        return 0;
      }
    };

  vi.doMock('../queue/index.js', () => ({
    QueueStore: QueueStoreImpl,
    QueueManager: QueueManagerImpl,
  }));

  const DispatcherImpl =
    overrides.DispatcherImpl ??
    class DefaultMockDispatcher {
      constructor() {}
      async dispatch() {
        return null;
      }
    };

  vi.doMock('./dispatcher.js', () => ({
    Dispatcher: DispatcherImpl,
  }));

  // MockPollingLoop always includes stop() to prevent unhandled rejection errors
  // when signal handlers call pollingLoop.stop() during test teardown (Finding 1 fix).
  const PollingLoopImpl =
    overrides.PollingLoopImpl ??
    class DefaultMockPollingLoop {
      readonly lastPollAt: string | null = null;
      reload() {}
      async start() {}
      async stop() {}
    };

  vi.doMock('./polling-loop.js', () => ({
    PollingLoop: PollingLoopImpl,
    diffConfig: () => ({ restartRequiredKeys: [], hotApplyKeys: [] }),
    RESTART_REQUIRED_KEYS: [],
    HOT_APPLY_KEYS: [],
  }));

  if (!overrides.skipSignalHandlerMock) {
    vi.doMock('./signal-handler.js', () => ({
      registerSignalHandlers: () => {},
      unregisterSignalHandlers: () => {},
    }));
  }

  vi.doMock('./pid-manager.js', () => ({
    writePid: async (dir: string, pid: number) => {
      overrides.writtenPids?.push([dir, pid]);
    },
    removePid: overrides.removePidImpl ?? (async () => {}),
    killOrphanDaemons: async () => {},
    DAEMON_STATUS_FILENAME: 'daemon-status.json',
    readPid: async () => null,
  }));

  // Mock PidLock to prevent real lock file creation in dataDir during tests.
  // The pidLockAcquireResult override allows testing the lock-contention exit path.
  const acquireResult = overrides.pidLockAcquireResult ?? true;
  vi.doMock('./pid-lock.js', () => ({
    PID_LOCK_FILENAME: 'daemon.pid.lock',
    PidLock: class MockPidLock {
      constructor(_dataDir: string) {}
      async acquire(_pid: number): Promise<boolean> {
        return acquireResult;
      }
      async release(): Promise<void> {}
      async readOwnerPid(): Promise<number | null> {
        return acquireResult ? null : 99999;
      }
    },
  }));

  if (overrides.configMock) {
    vi.doMock('../config/index.js', () => overrides.configMock!);
  } else {
    const configMock: Record<string, unknown> = {
      CONFIG_FALLBACK: defaultConfig,
      createConfigWatcher:
        overrides.createConfigWatcher ??
        ((_path: string, _onReload: () => Promise<void>) => ({ close: () => {} })),
    };
    if (overrides.loadConfigFn) {
      configMock.loadConfig = overrides.loadConfigFn;
    } else if (overrides.loadConfigThrows) {
      const err = overrides.loadConfigThrows;
      configMock.loadConfig = async () => {
        throw err;
      };
    } else {
      configMock.loadConfig = async () => overrides.loadConfigResult ?? defaultConfig;
    }
    vi.doMock('../config/index.js', () => configMock);
  }

  // defaultSnapshot matches the CapacitySnapshot interface (provider.ts UsageMonitor.poll() contract).
  // The PollingLoop is mocked separately so this snapshot is not exercised by the real poll() path,
  // but the shape must be correct so TypeScript and any future test evolution stays aligned.
  const defaultSnapshot = {
    budgetWindows: [
      {
        id: 'weekly',
        kind: 'budget' as const,
        utilization: 0,
        resetsAt: new Date('2026-01-01T00:00:00.000Z'),
        windowDurationHours: 168,
      },
    ],
    rateWindows: [
      {
        id: 'session',
        kind: 'rate' as const,
        utilization: 0,
        resetsAt: new Date('2026-01-01T05:00:00.000Z'),
        windowDurationHours: 5,
      },
    ],
    provider: 'claude-code',
    fetchedAt: new Date(),
    source: 'oauth' as const,
    confidence: 'high' as const,
  };

  if (overrides.providersMock) {
    vi.doMock('../providers/index.js', () => overrides.providersMock!);
  } else {
    const providersMock: Record<string, unknown> = {
      validateProviderBackend: async () => {},
    };
    if (overrides.createProviderThrows) {
      const err = overrides.createProviderThrows;
      providersMock.createProvider = async () => {
        throw err;
      };
    } else {
      providersMock.createProvider = async () => ({
        usageMonitor: {
          poll: async () => defaultSnapshot,
        },
        taskExecutor: { _type: 'TaskExecutor' },
        authManager: {
          getToken: async () => 'token',
          refresh: async () => undefined,
          validate: async () => true,
        },
      });
    }
    vi.doMock('../providers/index.js', () => providersMock);
  }

  vi.doMock('../providers/claude-code/index.js', () => ({
    ClaudeCodeAuthManager: class {
      async readSubscriptionTier() {
        return { rateLimitTier: null };
      }
    },
  }));

  // Always mock ../utils/index.js to prevent real filesystem I/O.
  // Uses a synchronous factory (no importOriginal) to avoid vitest async mock race conditions.
  // The mock logger writes to process.stderr like the real one (tests spy on stderr.write).
  const LEVELS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  const mockWriteRecord = (level: string, event: string, data: Record<string, unknown> = {}) => {
    if (LEVELS[level]! >= LEVELS['info']!) {
      const prefix = level.toUpperCase().padEnd(5);
      process.stderr.write(`[${prefix}] ${event}: ${JSON.stringify(data)}\n`);
    }
  };
  const noopLogger = {
    debug: (event: string, data?: Record<string, unknown>) => mockWriteRecord('debug', event, data),
    info: (event: string, data?: Record<string, unknown>) => mockWriteRecord('info', event, data),
    warn: (event: string, data?: Record<string, unknown>) => mockWriteRecord('warn', event, data),
    error: (event: string, data?: Record<string, unknown>) => mockWriteRecord('error', event, data),
  };

  // Default retryWithBackoff: real retry semantics with exponential backoff.
  // When useInstantRetry=true, replaced with a no-delay implementation that
  // still honours maxRetries and retryOn, preventing real ~700ms wait in retry tests.
  let retryFn: unknown = async <T>(
    fn: () => Promise<T>,
    opts: { maxRetries?: number; initialDelayMs?: number; retryOn?: (e: Error) => boolean } = {},
  ): Promise<T> => {
    const maxRetries = opts.maxRetries ?? 3;
    const retryOn = opts.retryOn ?? (() => true);
    let lastError!: Error;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt === maxRetries || !retryOn(lastError)) throw lastError;
        // Yield to event loop to keep async ordering realistic (no real timer)
        await Promise.resolve();
      }
    }
    throw lastError!;
  };

  if (overrides.useInstantRetry) {
    retryFn = async <T>(
      fn: () => Promise<T>,
      opts: { maxRetries?: number; retryOn?: (e: Error) => boolean } = {},
    ): Promise<T> => {
      const maxRetries = opts.maxRetries ?? 3;
      const retryOn = opts.retryOn ?? (() => false);
      let lastError!: Error;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          return await fn();
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (attempt === maxRetries || !retryOn(lastError)) throw lastError;
        }
      }
      throw lastError!;
    };
  }

  const utilsMock: Record<string, unknown> = {
    logger: noopLogger,
    enableFileLogging: overrides.enableFileLogging ?? (() => {}),
    setLogDir: overrides.setLogDir ?? ((_dir: string) => {}),
    setLogLevel: () => {},
    resetLoggerState: () => {},
    retryWithBackoff: retryFn,
    atomicWrite: overrides.atomicWrite ?? (async () => {}),
    safeReadJson: async () => null,
    isRecord: (value: unknown): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null && !Array.isArray(value),
    AUDIT_LOG_FILENAME_REGEX: /^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/,
    VERSION: '0.0.0-test',
    spawnWithGuardrails: async () => ({
      stdout: '',
      stderr: '',
      exitCode: 1,
      timedOut: false,
      aborted: false,
      oomKilled: false,
    }),
    boundOutput: (s: string) => s,
    MAX_OUTPUT_BYTES: 1_048_576,
    MAX_OUTPUT_BYTES_SUCCESS: 524_288,
    validateRepository: async () => ({ valid: true, errors: [] }),
  };
  vi.doMock('../utils/index.js', () => utilsMock);
}

describe('runner', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = join(tmpdir(), 'runner-test-' + randomBytes(6).toString('hex'));
    await mkdir(dataDir, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dataDir, { recursive: true, force: true });
  });

  describe('isDaemonRunner()', () => {
    it('returns false when --daemon-runner is not in process.argv', async () => {
      vi.resetModules();
      const originalArgv = process.argv;
      process.argv = ['node', 'index.js'];
      const { isDaemonRunner } = await import('./runner.js');
      const result = isDaemonRunner();
      process.argv = originalArgv;
      expect(result).toBe(false);
    });

    it('returns true when --daemon-runner is in process.argv', async () => {
      vi.resetModules();
      const originalArgv = process.argv;
      process.argv = ['node', 'index.js', '--daemon-runner'];
      const { isDaemonRunner } = await import('./runner.js');
      const result = isDaemonRunner();
      process.argv = originalArgv;
      expect(result).toBe(true);
    });
  });

  describe('runDaemon()', () => {
    it('calls enableFileLogging() before the polling loop starts (AC1: audit file logging in daemon)', async () => {
      vi.resetModules();

      let enableFileLoggingCalled = false;
      let enableFileLoggingCalledBeforeLoop = false;

      // Pass enableFileLogging spy via setupRunDaemonMocks overrides — this ensures the
      // same ../utils/index.js mock registration is used throughout (last-wins with vi.doMock).
      setupRunDaemonMocks(dataDir, {
        enableFileLogging: () => {
          enableFileLoggingCalled = true;
        },
        PollingLoopImpl: class EnableFileLoggingTestPollingLoop {
          readonly lastPollAt: string | null = null;
          reload() {}
          async start() {
            // Record whether enableFileLogging was called before the loop started
            enableFileLoggingCalledBeforeLoop = enableFileLoggingCalled;
          }
          async stop() {}
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      // enableFileLogging must have been called during daemon bootstrap
      expect(enableFileLoggingCalled).toBe(true);
      // It must have been called BEFORE the polling loop started
      expect(enableFileLoggingCalledBeforeLoop).toBe(true);
    });

    it('constructs QueueStore with paths.data (directory, not pre-joined file path) — AC1 and AC3', async () => {
      vi.resetModules();

      const queueStoreArgs: unknown[][] = [];
      const queueManagerArgs: unknown[][] = [];
      const dispatcherArgs: unknown[][] = [];

      // Sentinel objects so we can verify pass-through
      const fakeQueueStore = { _type: 'QueueStore' };
      const fakeQueueManager = { _type: 'QueueManager', listDispatchable: async () => [] };
      const fakeTaskExecutor = { _type: 'TaskExecutor' };

      setupRunDaemonMocks(dataDir, {
        providersMock: {
          createProvider: async () => ({
            usageMonitor: {
              getSnapshot: async () => ({
                sessionTokensUsed: 0,
                sessionTokensTotal: 1000,
                weeklyTokensUsed: 0,
                weeklyTokensTotal: 5000,
                usagePercentage: 0,
                capturedAt: new Date().toISOString(),
                source: 'test',
                confidence: 'high',
              }),
            },
            taskExecutor: fakeTaskExecutor,
          }),
          validateProviderBackend: async () => {},
        },
        QueueStoreImpl: class SpyQueueStore {
          constructor(...args: unknown[]) {
            queueStoreArgs.push(args);
            Object.assign(this, fakeQueueStore);
          }
        } as unknown as new (dir: string) => { filePath?: string },
        QueueManagerImpl: class SpyQueueManager {
          constructor(...args: unknown[]) {
            queueManagerArgs.push(args);
            Object.assign(this, fakeQueueManager);
          }
          async listDispatchable() {
            return [];
          }
          async resetInProgressTasks() {
            return 0;
          }
          async countInProgress() {
            return 0;
          }
        },
        DispatcherImpl: class SpyDispatcher {
          constructor(...args: unknown[]) {
            dispatcherArgs.push(args);
          }
          async dispatch() {
            return null;
          }
        },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      // AC1, AC5: QueueStore must receive paths.data (the directory), NOT a pre-joined path.
      // Regression guard: if runner passed join(paths.data, 'queue.json'), the store would
      // internally do join(that, 'queue.json') → double-join → non-existent path.
      expect(queueStoreArgs.length).toBe(1);
      const queueStoreArg = queueStoreArgs[0]?.[0];
      expect(typeof queueStoreArg).toBe('string');
      // Must NOT end with 'queue.json' — that would indicate the pre-join bug is back.
      expect(String(queueStoreArg)).not.toMatch(/queue\.json$/);
      // Must equal paths.data exactly (dataDir in this test).
      expect(String(queueStoreArg)).toBe(dataDir);

      // AC3 cross-reference: verify this is the SAME pattern the CLI uses.
      // queue.ts:50 uses `new QueueStore(getPaths().data)` — the arg is getPaths().data, not
      // join(getPaths().data, 'queue.json'). Both runner.ts and queue.ts must pass the directory.
      // Since getPaths() is mocked to return { data: dataDir }, the CLI pattern would also yield
      // dataDir — confirming the runner now matches the CLI's correct construction pattern.
      const expectedCliArg = dataDir; // == getPaths().data, the same value the CLI passes
      expect(String(queueStoreArg)).toBe(expectedCliArg);

      // QueueManager must be constructed with the QueueStore instance
      expect(queueManagerArgs.length).toBe(1);
      expect(queueManagerArgs[0]?.[0]).toMatchObject({ _type: 'QueueStore' });

      // Dispatcher must be constructed with { queueManager, taskExecutor } deps object
      expect(dispatcherArgs.length).toBe(1);
      const dispatcherDeps = dispatcherArgs[0]?.[0] as {
        queueManager?: unknown;
        taskExecutor?: unknown;
      };
      expect(dispatcherDeps).toBeDefined();
      expect(dispatcherDeps!.queueManager).toMatchObject({ _type: 'QueueManager' });
      expect(dispatcherDeps!.taskExecutor).toBe(fakeTaskExecutor);
    });

    it('QueueStore filePath is a single join of dataDir + queue.json (no double-join)', async () => {
      vi.resetModules();

      // Track the actual filePath set on the QueueStore instance to verify single-join.
      // If runner passes join(paths.data, 'queue.json') to QueueStore, the constructor does
      // join(that, 'queue.json') → double join → wrong path. This test catches that regression.
      let capturedFilePath: string | undefined;

      // Use the real QueueStore constructor logic to compute filePath from the argument.
      const QUEUE_FILE = 'queue.json';
      class RealLikeQueueStore {
        filePath: string;
        constructor(dir: string) {
          // Mirrors the real QueueStore constructor: join(dataDir, QUEUE_FILE)
          this.filePath = join(dir, QUEUE_FILE);
          capturedFilePath = this.filePath;
        }
      }

      setupRunDaemonMocks(dataDir, {
        QueueStoreImpl: RealLikeQueueStore,
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      // The QueueStore filePath must be exactly join(dataDir, 'queue.json') — a single join.
      // If the bug were present, filePath would be join(dataDir, 'queue.json', 'queue.json').
      expect(capturedFilePath).toBeDefined();
      expect(capturedFilePath).toBe(join(dataDir, 'queue.json'));
      expect(capturedFilePath).not.toBe(join(dataDir, 'queue.json', 'queue.json'));
    });

    it('calls ensureDirectories, writePid, and atomicWrite during bootstrap', async () => {
      vi.resetModules();

      let ensureCalled = false;
      const writtenPids: Array<[string, number]> = [];
      const atomicWrites: string[] = [];
      let resolved = false;

      setupRunDaemonMocks(dataDir, {
        onEnsureDirectories: () => {
          ensureCalled = true;
        },
        writtenPids,
        atomicWrite: async (_path: string, content: string) => {
          atomicWrites.push(content);
          resolved = true;
        },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const { runDaemon } = await import('./runner.js');

      // Run daemon in background — it blocks after bootstrap steps complete
      void runDaemon();

      // Wait for the bootstrap async steps to complete (ensureDirectories + writePid + atomicWrite)
      // These happen before the blocking loop
      const deadline = Date.now() + 2000;
      while (!resolved && Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, 10));
      }

      expect(ensureCalled).toBe(true);
      expect(writtenPids.length).toBe(1);
      const firstPidEntry = writtenPids[0];
      expect(firstPidEntry).toBeDefined();
      expect(firstPidEntry![1]).toBe(process.pid);
      // At least 1 write must have occurred (the bootstrap 'running' write).
      // A second write may occur if the polling loop exits unexpectedly (unexpected-exit path).
      expect(atomicWrites.length).toBeGreaterThanOrEqual(1);

      const rawStatus = atomicWrites[0];
      expect(rawStatus).toBeDefined();
      const status = JSON.parse(rawStatus!) as Record<string, unknown>;
      // The FIRST write must always be the bootstrap 'running' status.
      expect(status['state']).toBe('running');
      expect(status['pid']).toBe(process.pid);
      expect(typeof status['startedAt']).toBe('string');
    });

    it('calls resetInProgressTasks on startup and logs warn when count > 0 (Story 10.9 AC3)', async () => {
      vi.resetModules();

      let resetInProgressCalled = false;
      let resetInProgressCalledBeforeLoop = false;

      setupRunDaemonMocks(dataDir, {
        QueueManagerImpl: class ResetTrackingQueueManager {
          constructor() {}
          async listDispatchable() {
            return [];
          }
          async resetInProgressTasks() {
            resetInProgressCalled = true;
            return 2; // simulate 2 stale tasks
          }
          async countInProgress() {
            return 0;
          }
        },
        PollingLoopImpl: class ResetCheckPollingLoop {
          readonly lastPollAt: string | null = null;
          reload() {}
          async start() {
            // Verify resetInProgressTasks was called before the polling loop
            resetInProgressCalledBeforeLoop = resetInProgressCalled;
          }
          async stop() {}
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      expect(resetInProgressCalled).toBe(true);
      expect(resetInProgressCalledBeforeLoop).toBe(true);
    });

    it('continues startup when resetInProgressTasks throws (non-fatal, Story 10.9 AC3)', async () => {
      vi.resetModules();

      let loopStarted = false;

      setupRunDaemonMocks(dataDir, {
        QueueManagerImpl: class FailingResetQueueManager {
          constructor() {}
          async listDispatchable() {
            return [];
          }
          async resetInProgressTasks() {
            throw new Error('queue read failed');
          }
          async countInProgress() {
            return 0;
          }
        },
        PollingLoopImpl: class ContinueAfterResetFailPollingLoop {
          readonly lastPollAt: string | null = null;
          reload() {}
          async start() {
            loopStarted = true;
          }
          async stop() {}
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      // Polling loop must start even when resetInProgressTasks throws
      expect(loopStarted).toBe(true);
    });

    it('guards against recursive re-entry — second call returns immediately', async () => {
      vi.resetModules();

      let ensureCalledCount = 0;
      let atomicWriteCount = 0;

      setupRunDaemonMocks(dataDir, {
        onEnsureDirectories: () => {
          ensureCalledCount++;
        },
        atomicWrite: async () => {
          atomicWriteCount++;
        },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      const { runDaemon } = await import('./runner.js');

      // First call — await completion (with mocked process.exit the daemon runs through
      // the unexpected-exit path and resolves after writing stopped status).
      await runDaemon();

      const firstCallCount = ensureCalledCount;
      const firstWriteCount = atomicWriteCount;

      // Second call — _bootstrapped guard fires, returns immediately without any I/O.
      await runDaemon();

      // ensureDirectories and atomicWrite should NOT be called again
      expect(ensureCalledCount).toBe(firstCallCount);
      expect(atomicWriteCount).toBe(firstWriteCount);

      // The re-entry guard must emit the diagnostic warning log event so operators can
      // diagnose unexpected double-start without relying on filesystem or exit codes.
      const stderrOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(stderrOutput).toContain('runner.already_bootstrapped');
    });

    it('calls setLogDir then ensureDirectories then enableFileLogging (bootstrap ordering invariant)', async () => {
      vi.resetModules();

      // Ordering invariant: the safe bootstrap sequence is:
      //   1. setLogDir(paths.logs)  — injects log directory path into logger
      //   2. ensureDirectories()    — creates the logs/ directory on disk
      //   3. enableFileLogging()    — activates appendFile after directory exists
      //   4. logger.debug(...)      — first actual file write attempt (directory guaranteed to exist)
      //
      // setLogDir must precede enableFileLogging (enableFileLogging throws CONFIG_INVALID otherwise).
      // ensureDirectories must precede enableFileLogging so appendFile never targets a missing dir.
      const callOrder: string[] = [];
      let setLogDirValue: string | undefined;

      setupRunDaemonMocks(dataDir, {
        onEnsureDirectories: () => {
          callOrder.push('ensureDirectories');
        },
        enableFileLogging: () => {
          callOrder.push('enableFileLogging');
        },
        setLogDir: (dir: string) => {
          callOrder.push('setLogDir');
          setLogDirValue = dir;
        },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      // setLogDir must precede ensureDirectories and enableFileLogging.
      expect(callOrder.indexOf('setLogDir')).toBeLessThan(callOrder.indexOf('ensureDirectories'));
      expect(callOrder.indexOf('setLogDir')).toBeLessThan(callOrder.indexOf('enableFileLogging'));
      // ensureDirectories must precede enableFileLogging — directory created before first appendFile.
      expect(callOrder.indexOf('ensureDirectories')).toBeLessThan(
        callOrder.indexOf('enableFileLogging'),
      );
      // setLogDir must receive paths.logs (not paths.data or any other path).
      expect(setLogDirValue).toBe(dataDir);
    });

    it('registers SIGTERM, SIGINT, and SIGHUP signal handlers', async () => {
      vi.resetModules();

      const registeredSignals: string[] = [];

      // Use a blocking PollingLoop so runDaemon() stays suspended in loop.start()
      // and never reaches process.exit(1) after the test ends. Without this, the
      // fire-and-forget void runDaemon() below could race against afterEach's
      // vi.restoreAllMocks() (which restores process.exit) and call the real
      // process.exit(1), causing a spurious "process.exit unexpectedly called" error.
      // Mock signal-handler to capture which signals runner.ts requests via registerSignalHandlers.
      // This avoids depending on the real signal-handler module (which has module-level state
      // that can leak across tests) and instead verifies that runDaemon() calls registerSignalHandlers.
      let registerSignalHandlersCalled = false;

      setupRunDaemonMocks(dataDir, {
        skipSignalHandlerMock: true,
        PollingLoopImpl: class SignalTestPollingLoop {
          readonly lastPollAt: string | null = null;
          reload() {}
          async start() {
            // Never resolves — keeps runDaemon() suspended so it cannot reach
            // the process.exit(1) at the end of the unexpected-exit path.
            await new Promise<void>(() => {});
          }
          async stop() {}
        },
      });

      // Override signal-handler mock to verify registerSignalHandlers is called with correct deps
      vi.doMock('./signal-handler.js', () => ({
        registerSignalHandlers: (opts: Record<string, unknown>) => {
          registerSignalHandlersCalled = true;
          // Verify all required deps are passed
          if (
            opts.dataDir &&
            opts.startedAt &&
            opts.pollingLoop &&
            opts.onReload &&
            opts.onShutdownComplete
          ) {
            registeredSignals.push('SIGTERM', 'SIGINT', 'SIGHUP');
          }
        },
        unregisterSignalHandlers: () => {},
      }));

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const { runDaemon } = await import('./runner.js');
      void runDaemon();

      // Wait for registerSignalHandlers to be called
      const deadline = Date.now() + 3000;
      while (!registerSignalHandlersCalled && Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, 10));
      }

      expect(registerSignalHandlersCalled).toBe(true);
      expect(registeredSignals).toContain('SIGTERM');
      expect(registeredSignals).toContain('SIGINT');
      expect(registeredSignals).toContain('SIGHUP');
    });

    it('falls back to default config when loadConfig throws (error-path branch coverage)', async () => {
      vi.resetModules();

      // Track what config the PollingLoop receives via getConfig()
      let capturedPollingInterval: number | undefined;

      setupRunDaemonMocks(dataDir, {
        loadConfigThrows: new Error('ENOENT: config file missing'),
        PollingLoopImpl: class BranchCoveragePollingLoop {
          readonly lastPollAt: string | null = null;
          constructor(deps: { getConfig: () => { pollingInterval: number } }) {
            // Capture the pollingInterval from getConfig() to verify fallback defaults used
            capturedPollingInterval = deps.getConfig().pollingInterval;
          }
          reload() {}
          async start() {}
          async stop() {}
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      // Default config pollingInterval is 300 — confirms fallback path was exercised
      expect(capturedPollingInterval).toBe(300);
    });

    it('retries config load on transient FS error and succeeds on second attempt (Story 14.1 AC1)', async () => {
      vi.resetModules();

      let loadAttempts = 0;
      let capturedPollingInterval: number | undefined;
      const successConfig = {
        pollingInterval: 60,
        logRetentionDays: 30,
        taskTimeoutMinutes: 60,
        provider: {
          name: 'claude-code',
          allowDangerouslySkipPermissions: false,
          executionBackend: 'container',
        },
        trigger: { maxWastePercentage: 50, weeklyReservePercentage: 30, idleHours: [] },
        tasks: [],
        lastSummaryEnabled: false,
      };

      setupRunDaemonMocks(dataDir, {
        useInstantRetry: true,
        loadConfigFn: async () => {
          loadAttempts++;
          if (loadAttempts === 1) {
            // First attempt: transient EACCES error — loadConfig wraps FS errors in an Error with cause
            const fsErr = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
            fsErr.code = 'EACCES';
            const wrappedErr = new Error('Failed to read config file');
            wrappedErr.cause = fsErr;
            throw wrappedErr;
          }
          // Second attempt: success
          return successConfig;
        },
        PollingLoopImpl: class RetrySuccessPollingLoop {
          readonly lastPollAt: string | null = null;
          constructor(deps: { getConfig: () => { pollingInterval: number } }) {
            capturedPollingInterval = deps.getConfig().pollingInterval;
          }
          reload() {}
          async start() {}
          async stop() {}
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      // Config loaded successfully on second attempt — should use the real config, not defaults
      expect(loadAttempts).toBe(2);
      expect(capturedPollingInterval).toBe(60);
    });

    it('falls back to defaults after all retries exhausted on transient FS errors and emits runner.config_fallback_used (Story 14.1 AC1, AC2)', async () => {
      vi.resetModules();

      let loadAttempts = 0;
      let capturedPollingInterval: number | undefined;
      const stderrWrites: string[] = [];

      setupRunDaemonMocks(dataDir, {
        useInstantRetry: true,
        loadConfigFn: async () => {
          loadAttempts++;
          // Always throw a transient EACCES error — retries will be exhausted
          const fsErr = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
          fsErr.code = 'EACCES';
          const wrappedErr = new Error('Failed to read config file');
          wrappedErr.cause = fsErr;
          throw wrappedErr;
        },
        PollingLoopImpl: class RetryExhaustedPollingLoop {
          readonly lastPollAt: string | null = null;
          constructor(deps: { getConfig: () => { pollingInterval: number } }) {
            capturedPollingInterval = deps.getConfig().pollingInterval;
          }
          reload() {}
          async start() {}
          async stop() {}
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
        stderrWrites.push(typeof chunk === 'string' ? chunk : chunk.toString());
        return true;
      });

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      // retryWithBackoff: 1 initial + 3 retries = 4 attempts total
      expect(loadAttempts).toBe(4);
      // Should fall back to defaults (pollingInterval: 300)
      expect(capturedPollingInterval).toBe(300);
      // AC2: Verify runner.config_fallback_used warning was emitted with all fallback fields
      const fallbackLog = stderrWrites.find((w) => w.includes('runner.config_fallback_used'));
      expect(fallbackLog).toBeDefined();
      // All three explicitly-listed AC2 fallback fields must be present in the log payload
      expect(fallbackLog).toContain('pollingInterval');
      expect(fallbackLog).toContain('logRetentionDays');
      expect(fallbackLog).toContain('taskTimeoutMinutes');
    });

    it('does not retry on non-transient config errors (e.g., invalid YAML) (Story 14.1 AC1)', async () => {
      vi.resetModules();

      let loadAttempts = 0;
      let capturedPollingInterval: number | undefined;

      setupRunDaemonMocks(dataDir, {
        useInstantRetry: true,
        loadConfigFn: async () => {
          loadAttempts++;
          // Non-transient error: no FS error code, no cause with FS code
          throw new Error('Invalid configuration: bad YAML syntax');
        },
        PollingLoopImpl: class NoRetryPollingLoop {
          readonly lastPollAt: string | null = null;
          constructor(deps: { getConfig: () => { pollingInterval: number } }) {
            capturedPollingInterval = deps.getConfig().pollingInterval;
          }
          reload() {}
          async start() {}
          async stop() {}
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      // Should NOT retry — only 1 attempt
      expect(loadAttempts).toBe(1);
      // Falls back to defaults
      expect(capturedPollingInterval).toBe(300);
    });

    it('logs config load failure before falling back to defaults (Story 21.1 AC4)', async () => {
      // AC4: When the config file is temporarily unreadable and all retries are exhausted,
      // the daemon logs the failure and falls back to defaults. This test verifies both
      // the logging of the failure and the use of fallback config.
      vi.resetModules();

      let loadAttempts = 0;
      let capturedPollingInterval: number | undefined;
      const stderrWrites: string[] = [];

      setupRunDaemonMocks(dataDir, {
        useInstantRetry: true,
        loadConfigFn: async () => {
          loadAttempts++;
          // Simulate a transient permission error
          const fsErr = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
          fsErr.code = 'EACCES';
          const wrappedErr = new Error('Failed to read config file');
          wrappedErr.cause = fsErr;
          throw wrappedErr;
        },
        PollingLoopImpl: class ConfigRetryFallbackPollingLoop {
          readonly lastPollAt: string | null = null;
          constructor(deps: { getConfig: () => { pollingInterval: number } }) {
            capturedPollingInterval = deps.getConfig().pollingInterval;
          }
          reload() {}
          async start() {}
          async stop() {}
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
        stderrWrites.push(typeof chunk === 'string' ? chunk : chunk.toString());
        return true;
      });

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      // retryWithBackoff: 1 initial + 3 retries = 4 attempts total (matches adjacent test pattern)
      expect(loadAttempts).toBe(4);
      // Falls back to default config (pollingInterval: 300)
      expect(capturedPollingInterval).toBe(300);
      // Failure must be logged with the specific structured event — not any incidental EACCES string
      const fallbackLog = stderrWrites.find((w) => w.includes('runner.config_fallback_used'));
      expect(fallbackLog).toBeDefined();
    });

    it('writes stopped status and calls process.exit(1) when createProvider throws', async () => {
      vi.resetModules();

      const exitCodes: number[] = [];
      let stoppedStatusWritten = false;

      setupRunDaemonMocks(dataDir, {
        createProviderThrows: new Error('unsupported provider'),
        atomicWrite: async (_path: string, content: string) => {
          const parsed = JSON.parse(content) as Record<string, unknown>;
          if (parsed['state'] === 'stopped') {
            stoppedStatusWritten = true;
          }
        },
      });

      vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
        exitCodes.push(code);
      }) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      // Provider init failure branch: must write stopped status and exit(1)
      expect(stoppedStatusWritten).toBe(true);
      expect(exitCodes).toContain(1);
    });

    it('invokes uncaughtException handler: calls writeDegradedStatus', async () => {
      vi.resetModules();

      let uncaughtHandlerRef: ((err: unknown) => void) | undefined;
      let writeDegradedStatusCalled = false;
      let writeDegradedStatusMsg: string | undefined;

      // Mock state-writer directly — writeDegradedStatus is called from the handler
      // via a void promise chain, so mocking state-writer is more reliable than
      // intercepting atomicWrite through transitive import chains.
      vi.doMock('./state-writer.js', () => ({
        writeDaemonStatus: async () => {},
        writeRunningStatus: async () => {},
        writeStoppedStatus: async () => {},
        writeStoppingStatus: async () => {},
        writeErrorStatus: async () => {},
        writeUnexpectedExitStatus: async () => {},
        writeRestartingStatus: async () => {},
        writeRestartCompletedStatus: async () => {},
        writeCycleStatus: async () => {},
        readExistingStatus: async () => null,
        buildLastErrorDetail: (
          code: string,
          message: string,
          recoveryCommand: string | null = null,
        ) => ({
          code,
          message,
          recoveryCommand,
        }),
        writeDegradedStatus: async (_startedAt: string, lastError: string, _detail: unknown) => {
          writeDegradedStatusCalled = true;
          writeDegradedStatusMsg = lastError;
        },
      }));

      setupRunDaemonMocks(dataDir, {
        PollingLoopImpl: class UncaughtTestPollingLoop {
          readonly lastPollAt: string | null = null;
          reload() {}
          async start() {
            // Trigger the uncaughtException handler while the loop is "running"
            if (uncaughtHandlerRef) {
              uncaughtHandlerRef(new Error('test-uncaught'));
              // Give the void promise chain time to resolve
              await new Promise<void>((r) => setTimeout(r, 100));
            }
          }
          async stop() {}
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      // Capture the uncaughtException handler as it is registered on process
      const origOn = process.on.bind(process);
      vi.spyOn(process, 'on').mockImplementation(
        (event: string | symbol, handler: (...args: unknown[]) => void) => {
          if (event === 'uncaughtException') {
            uncaughtHandlerRef = handler as (err: unknown) => void;
          }
          return origOn(event as NodeJS.Signals, handler as NodeJS.SignalsListener);
        },
      );

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      // The uncaughtException handler must call writeDegradedStatus with the error message
      expect(writeDegradedStatusCalled).toBe(true);
      expect(writeDegradedStatusMsg).toContain('test-uncaught');
    });

    it('invokes unhandledRejection handler: calls writeDegradedStatus', async () => {
      vi.resetModules();

      let rejectionHandlerRef: ((reason: unknown) => void) | undefined;
      let writeDegradedStatusCalled = false;
      let writeDegradedStatusMsg: string | undefined;

      vi.doMock('./state-writer.js', () => ({
        writeDaemonStatus: async () => {},
        writeRunningStatus: async () => {},
        writeStoppedStatus: async () => {},
        writeStoppingStatus: async () => {},
        writeErrorStatus: async () => {},
        writeUnexpectedExitStatus: async () => {},
        writeRestartingStatus: async () => {},
        writeRestartCompletedStatus: async () => {},
        writeCycleStatus: async () => {},
        readExistingStatus: async () => null,
        buildLastErrorDetail: (
          code: string,
          message: string,
          recoveryCommand: string | null = null,
        ) => ({
          code,
          message,
          recoveryCommand,
        }),
        writeDegradedStatus: async (_startedAt: string, lastError: string, _detail: unknown) => {
          writeDegradedStatusCalled = true;
          writeDegradedStatusMsg = lastError;
        },
      }));

      setupRunDaemonMocks(dataDir, {
        PollingLoopImpl: class UnhandledRejectionTestPollingLoop {
          readonly lastPollAt: string | null = null;
          reload() {}
          async start() {
            // Trigger the unhandledRejection handler while the loop is "running"
            if (rejectionHandlerRef) {
              rejectionHandlerRef(new Error('test-rejection'));
              await new Promise<void>((r) => setTimeout(r, 100));
            }
          }
          async stop() {}
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const origOn = process.on.bind(process);
      vi.spyOn(process, 'on').mockImplementation(
        (event: string | symbol, handler: (...args: unknown[]) => void) => {
          if (event === 'unhandledRejection') {
            rejectionHandlerRef = handler as (reason: unknown) => void;
          }
          return origOn(event as NodeJS.Signals, handler as NodeJS.SignalsListener);
        },
      );

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      expect(writeDegradedStatusCalled).toBe(true);
      expect(writeDegradedStatusMsg).toContain('test-rejection');
    });

    it('falls back to string coercion when loadConfig catch receives a non-Error value', async () => {
      vi.resetModules();

      // Covers branch 3 (line 104): `err instanceof Error ? err.message : String(err)`
      // — the false branch where err is a plain string, not an Error instance.
      setupRunDaemonMocks(dataDir, {
        configMock: {
          CONFIG_FALLBACK: {
            pollingInterval: 300,
            logRetentionDays: 30,
            taskTimeoutMinutes: 60,
            provider: {
              name: 'claude-code',
              allowDangerouslySkipPermissions: false,
              executionBackend: 'container',
            },
            trigger: { maxWastePercentage: 50, weeklyReservePercentage: 30, idleHours: [] },
            tasks: [],
            lastSummaryEnabled: false,
          },
          createConfigWatcher: (_path: string, _onReload: () => Promise<void>) => ({
            close: () => {},
          }),
          loadConfig: async () => {
            // eslint-disable-next-line no-throw-literal
            throw 'plain string error'; // non-Error thrown value
          },
        },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      // Must NOT throw — the catch converts the non-Error to string and falls back to defaults
      const { runDaemon } = await import('./runner.js');
      await expect(runDaemon()).resolves.toBeUndefined();
    });

    it('reloadConfig catch path — preserves last-known-good config when reload throws', async () => {
      vi.resetModules();

      // Covers branches 5 (line 186) and 6 (line 207): the reloadConfig() catch block.
      // We capture the onReload callback via the config watcher mock, then call it from
      // the PollingLoop.start() to trigger the reload with a failing loadConfig.
      let reloadConfigRef: (() => Promise<void>) | undefined;
      let loadConfigCallCount = 0;
      let degradedWrittenOnReload = false;

      // Register all mocks before import — last registered for same path wins.
      setupRunDaemonMocks(dataDir, {
        configMock: {
          CONFIG_FALLBACK: {
            pollingInterval: 300,
            logRetentionDays: 30,
            taskTimeoutMinutes: 60,
            provider: {
              name: 'claude-code',
              allowDangerouslySkipPermissions: false,
              executionBackend: 'container',
            },
            trigger: { maxWastePercentage: 50, weeklyReservePercentage: 30, idleHours: [] },
            tasks: [],
            lastSummaryEnabled: false,
          },
          createConfigWatcher: (_path: string, onReload: () => Promise<void>) => {
            reloadConfigRef = onReload;
            return { close: () => {} };
          },
          loadConfig: async () => {
            loadConfigCallCount++;
            if (loadConfigCallCount > 1) {
              throw new Error('reload: bad config');
            }
            return {
              pollingInterval: 300,
              logRetentionDays: 30,
              provider: {
                name: 'claude-code',
                allowDangerouslySkipPermissions: false,
                executionBackend: 'container' as const,
              },
              trigger: { maxWastePercentage: 50, weeklyReservePercentage: 30, idleHours: [] },
              tasks: [],
              lastSummaryEnabled: false,
            };
          },
        },
        PollingLoopImpl: class ReloadTestPollingLoop {
          readonly lastPollAt: string | null = null;
          reload(_newConfig: unknown) {}
          async start() {
            if (reloadConfigRef) {
              await reloadConfigRef();
            }
          }
          async stop() {}
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
      });

      // Override state-writer to capture writeDegradedStatus from the reload error path.
      // Must be registered after setupRunDaemonMocks (which does NOT mock state-writer).
      vi.doMock('./state-writer.js', () => ({
        writeDaemonStatus: async () => {},
        writeRunningStatus: async () => {},
        writeStoppedStatus: async () => {},
        writeStoppingStatus: async () => {},
        writeErrorStatus: async () => {},
        writeUnexpectedExitStatus: async () => {},
        writeRestartingStatus: async () => {},
        writeRestartCompletedStatus: async () => {},
        writeCycleStatus: async () => {},
        readExistingStatus: async () => null,
        buildLastErrorDetail: (
          code: string,
          message: string,
          recoveryCommand: string | null = null,
        ) => ({
          code,
          message,
          recoveryCommand,
        }),
        writeDegradedStatus: async () => {
          degradedWrittenOnReload = true;
        },
      }));

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      // The reloadConfig() catch branch must have called writeDegradedStatus
      expect(degradedWrittenOnReload).toBe(true);
    });

    it('reloadConfig catch path with non-Error thrown value — string coercion branch', async () => {
      vi.resetModules();

      // Covers branch 5 (line 186) false branch: `String(err)` when err is not an Error instance.
      let reloadConfigRef: (() => Promise<void>) | undefined;
      let loadConfigCallCount = 0;
      let degradedWrittenOnReload = false;

      setupRunDaemonMocks(dataDir, {
        configMock: {
          CONFIG_FALLBACK: {
            pollingInterval: 300,
            logRetentionDays: 30,
            taskTimeoutMinutes: 60,
            provider: {
              name: 'claude-code',
              allowDangerouslySkipPermissions: false,
              executionBackend: 'container',
            },
            trigger: { maxWastePercentage: 50, weeklyReservePercentage: 30, idleHours: [] },
            tasks: [],
            lastSummaryEnabled: false,
          },
          createConfigWatcher: (_path: string, onReload: () => Promise<void>) => {
            reloadConfigRef = onReload;
            return { close: () => {} };
          },
          loadConfig: async () => {
            loadConfigCallCount++;
            if (loadConfigCallCount > 1) {
              // eslint-disable-next-line no-throw-literal
              throw 'non-error reload failure'; // non-Error to exercise String(err) branch
            }
            return {
              pollingInterval: 300,
              logRetentionDays: 30,
              provider: {
                name: 'claude-code',
                allowDangerouslySkipPermissions: false,
                executionBackend: 'container' as const,
              },
              trigger: { maxWastePercentage: 50, weeklyReservePercentage: 30, idleHours: [] },
              tasks: [],
              lastSummaryEnabled: false,
            };
          },
        },
        PollingLoopImpl: class ReloadNonErrorPollingLoop {
          readonly lastPollAt: string | null = null;
          reload(_newConfig: unknown) {}
          async start() {
            if (reloadConfigRef) {
              await reloadConfigRef();
            }
          }
          async stop() {}
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
      });

      vi.doMock('./state-writer.js', () => ({
        writeDaemonStatus: async () => {},
        writeRunningStatus: async () => {},
        writeStoppedStatus: async () => {},
        writeStoppingStatus: async () => {},
        writeErrorStatus: async () => {},
        writeUnexpectedExitStatus: async () => {},
        writeRestartingStatus: async () => {},
        writeRestartCompletedStatus: async () => {},
        writeCycleStatus: async () => {},
        readExistingStatus: async () => null,
        buildLastErrorDetail: (
          code: string,
          message: string,
          recoveryCommand: string | null = null,
        ) => ({
          code,
          message,
          recoveryCommand,
        }),
        writeDegradedStatus: async () => {
          degradedWrittenOnReload = true;
        },
      }));

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      expect(degradedWrittenOnReload).toBe(true);
    });

    it('uncaughtException handler handles non-Error thrown values (string coercion)', async () => {
      vi.resetModules();

      // Covers branches 7 (line 218), 8 (line 222): non-Error value passed to uncaughtHandler.
      // When err is not an Error instance, the handler uses String(err) and '(no stack)' fallbacks.
      let uncaughtHandlerRef: ((err: unknown) => void) | undefined;
      let writeDegradedStatusMsg: string | undefined;

      vi.doMock('./state-writer.js', () => ({
        writeDaemonStatus: async () => {},
        writeRunningStatus: async () => {},
        writeStoppedStatus: async () => {},
        writeStoppingStatus: async () => {},
        writeErrorStatus: async () => {},
        writeUnexpectedExitStatus: async () => {},
        writeRestartingStatus: async () => {},
        writeRestartCompletedStatus: async () => {},
        writeCycleStatus: async () => {},
        readExistingStatus: async () => null,
        buildLastErrorDetail: (
          code: string,
          message: string,
          recoveryCommand: string | null = null,
        ) => ({
          code,
          message,
          recoveryCommand,
        }),
        writeDegradedStatus: async (_startedAt: string, lastError: string) => {
          writeDegradedStatusMsg = lastError;
        },
      }));

      setupRunDaemonMocks(dataDir, {
        PollingLoopImpl: class NonErrorUncaughtPollingLoop {
          readonly lastPollAt: string | null = null;
          reload() {}
          async start() {
            if (uncaughtHandlerRef) {
              // Pass a plain string (non-Error) — exercises String(err) and '(no stack)' paths
              uncaughtHandlerRef('string-error-value');
              await new Promise<void>((r) => setTimeout(r, 100));
            }
          }
          async stop() {}
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const origOn = process.on.bind(process);
      vi.spyOn(process, 'on').mockImplementation(
        (event: string | symbol, handler: (...args: unknown[]) => void) => {
          if (event === 'uncaughtException') {
            uncaughtHandlerRef = handler as (err: unknown) => void;
          }
          return origOn(event as NodeJS.Signals, handler as NodeJS.SignalsListener);
        },
      );

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      // String(err) is used for msg → degradedStatus message contains the string value
      expect(writeDegradedStatusMsg).toContain('string-error-value');
    });

    it('unhandledRejection handler handles non-Error rejection reasons (string coercion)', async () => {
      vi.resetModules();

      // Covers branches 11 (line 243), 12 (line 244): non-Error reason passed to rejectionHandler.
      let rejectionHandlerRef: ((reason: unknown) => void) | undefined;
      let writeDegradedStatusMsg: string | undefined;

      vi.doMock('./state-writer.js', () => ({
        writeDaemonStatus: async () => {},
        writeRunningStatus: async () => {},
        writeStoppedStatus: async () => {},
        writeStoppingStatus: async () => {},
        writeErrorStatus: async () => {},
        writeUnexpectedExitStatus: async () => {},
        writeRestartingStatus: async () => {},
        writeRestartCompletedStatus: async () => {},
        writeCycleStatus: async () => {},
        readExistingStatus: async () => null,
        buildLastErrorDetail: (
          code: string,
          message: string,
          recoveryCommand: string | null = null,
        ) => ({
          code,
          message,
          recoveryCommand,
        }),
        writeDegradedStatus: async (_startedAt: string, lastError: string) => {
          writeDegradedStatusMsg = lastError;
        },
      }));

      setupRunDaemonMocks(dataDir, {
        PollingLoopImpl: class NonErrorRejectionPollingLoop {
          readonly lastPollAt: string | null = null;
          reload() {}
          async start() {
            if (rejectionHandlerRef) {
              // Pass a plain string — exercises String(reason) and '(no stack)' paths
              rejectionHandlerRef('string-rejection-value');
              await new Promise<void>((r) => setTimeout(r, 100));
            }
          }
          async stop() {}
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const origOn = process.on.bind(process);
      vi.spyOn(process, 'on').mockImplementation(
        (event: string | symbol, handler: (...args: unknown[]) => void) => {
          if (event === 'unhandledRejection') {
            rejectionHandlerRef = handler as (reason: unknown) => void;
          }
          return origOn(event as NodeJS.Signals, handler as NodeJS.SignalsListener);
        },
      );

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      expect(writeDegradedStatusMsg).toContain('string-rejection-value');
    });

    it('AC4 via runner.ts path — pending and in-progress tasks are counted by countWorkload()', async () => {
      vi.resetModules();

      // Seed a queue file with one pending task and one in-progress task.
      // This validates AC4 (queue path correctness) and AC5 (composite workload formula):
      // countWorkload() must include both dispatchable (pending) and in-progress tasks.
      //
      // Unlike dispatch-cycle.test.ts (which constructs QueueStore(dataDir) directly, bypassing
      // runner.ts), this test exercises the runner.ts construction path end-to-end. The
      // getQueueDepth callback passed to PollingLoop wraps queueManager.countWorkload(), so
      // we use a PollingLoop mock that calls getQueueDepth() during start().
      const queueFilePath = join(dataDir, 'queue.json');
      const pendingTask = {
        id: 'task-ac4-pending',
        name: 'ac4-pending-task',
        type: 'custom',
        prompt: 'test prompt',
        targetPath: dataDir,
        priority: 1,
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      const inProgressTask = {
        id: 'task-ac4-running',
        name: 'ac4-running-task',
        type: 'custom',
        prompt: 'test prompt 2',
        targetPath: dataDir,
        priority: 2,
        status: 'in-progress',
        createdAt: new Date().toISOString(),
      };
      await writeFile(
        queueFilePath,
        JSON.stringify({ tasks: [pendingTask, inProgressTask], paused: false }),
        'utf-8',
      );

      // Track whether countWorkload was called and what it returned
      let countWorkloadCalled = false;
      let countWorkloadResult = -1;

      // Use a real-like QueueStore that reads from the actual filesystem.
      // The runner must pass dataDir (not join(dataDir, 'queue.json')) for this to work:
      // if the double-join bug were present, filePath would be queue.json/queue.json (ENOENT).
      class AC4QueueStore {
        readonly filePath: string;
        constructor(dir: string) {
          this.filePath = join(dir, 'queue.json');
        }
        async read(): Promise<{ tasks: unknown[]; paused: boolean }> {
          try {
            const { readFile } = await import('node:fs/promises');
            const content = await readFile(this.filePath, 'utf-8');
            return JSON.parse(content) as { tasks: unknown[]; paused: boolean };
          } catch {
            return { tasks: [], paused: false };
          }
        }
      }

      class AC4QueueManager {
        private readonly store: AC4QueueStore;
        constructor(store: AC4QueueStore) {
          this.store = store;
        }
        async listDispatchable(): Promise<unknown[]> {
          const { tasks } = await this.store.read();
          return (tasks as Array<{ status: string }>).filter((t) => t.status === 'pending');
        }
        async resetInProgressTasks(): Promise<number> {
          return 0;
        }
        async countInProgress(): Promise<number> {
          const { tasks } = await this.store.read();
          return (tasks as Array<{ status: string }>).filter((t) => t.status === 'in-progress')
            .length;
        }
        async countWorkload(): Promise<number> {
          countWorkloadCalled = true;
          const { tasks, paused } = await this.store.read();
          const typedTasks = tasks as Array<{ status: string }>;
          const dispatchable = paused
            ? 0
            : typedTasks.filter((t) => t.status === 'pending' || t.status === 'failed_quota')
                .length;
          const inProgress = typedTasks.filter((t) => t.status === 'in-progress').length;
          countWorkloadResult = dispatchable + inProgress;
          return countWorkloadResult;
        }
      }

      // PollingLoop mock that calls getQueueDepth() during start() — this exercises the
      // runner.ts path: getQueueDepth: async () => queueManager.countWorkload()
      setupRunDaemonMocks(dataDir, {
        QueueStoreImpl: AC4QueueStore as unknown as new (dir: string) => { filePath?: string },
        QueueManagerImpl: AC4QueueManager as unknown as new (...args: unknown[]) => {
          listDispatchable: () => Promise<unknown[]>;
        },
        PollingLoopImpl: class AC4PollingLoop {
          readonly lastPollAt: string | null = null;
          private readonly getQueueDepth: () => Promise<number>;
          constructor(deps: { getQueueDepth: () => Promise<number> }) {
            this.getQueueDepth = deps.getQueueDepth;
          }
          reload() {}
          async start() {
            // Invoke getQueueDepth() to exercise the runner.ts → queueManager.countWorkload() path
            await this.getQueueDepth();
          }
          async stop() {}
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      // countWorkload() must be called (not the old two-lock approach) and must return
      // the sum of dispatchable (1 pending) + in-progress (1) = 2.
      expect(countWorkloadCalled).toBe(true);
      expect(countWorkloadResult).toBe(2);
    });

    it('writes state: "stopped" in daemon-status.json when loop resolves without a signal (AC6)', async () => {
      vi.resetModules();

      // Collect all atomic writes so we can verify a stopped-status write occurs.
      const writtenStatuses: Array<Record<string, unknown>> = [];

      // state-writer must be mocked to capture writeDaemonStatus calls.
      // writeUnexpectedExitStatus must also be overridden because the original function
      // (from importOriginal) calls the original writeDaemonStatus, not the mocked one.
      const mockedWriteDaemonStatus = async (state: Record<string, unknown>) => {
        writtenStatuses.push(state);
      };
      vi.doMock('./state-writer.js', () => ({
        writeDaemonStatus: mockedWriteDaemonStatus,
        writeRunningStatus: async () => {},
        writeStoppedStatus: async () => {},
        writeStoppingStatus: async () => {},
        writeErrorStatus: async () => {},
        writeRestartingStatus: async () => {},
        writeRestartCompletedStatus: async () => {},
        writeCycleStatus: async () => {},
        writeDegradedStatus: async () => {},
        readExistingStatus: async () => null,
        buildLastErrorDetail: (
          code: string,
          message: string,
          recoveryCommand: string | null = null,
        ) => ({
          code,
          message,
          recoveryCommand,
        }),
        writeUnexpectedExitStatus: async (
          startedAt: string,
          lastPollAt: string | null,
          lastError: string,
          lastErrorDetail: Record<string, unknown>,
        ) => {
          await mockedWriteDaemonStatus({
            state: 'stopped',
            startedAt,
            lastPollAt,
            lastError,
            lastErrorDetail,
            pid: null,
            nextPollAt: null,
            activeTask: null,
            updatedAt: new Date().toISOString(),
            usage: null,
            trigger: null,
            lastDispatchAt: null,
            cycleResult: null,
            queueDepth: 0,
            backendState: null,
          });
        },
      }));

      setupRunDaemonMocks(dataDir, {
        // Default PollingLoop mock: start() resolves immediately — simulates loop exit
        PollingLoopImpl: class ImmediateExitPollingLoop {
          readonly lastPollAt: string | null = null;
          reload() {}
          async start() {
            // Resolves immediately — no signal, simulates unexpected loop exit
          }
          async stop() {}
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      // At least one writeDaemonStatus call must have state: 'stopped'.
      const stoppedWrite = writtenStatuses.find((s) => s['state'] === 'stopped');
      if (!stoppedWrite) throw new Error('Expected a writeDaemonStatus call with state: stopped');
      expect(stoppedWrite['state']).toBe('stopped');
    });

    it('calls process.exit(1) after unexpected loop exit (AC7)', async () => {
      vi.resetModules();

      const exitCodes: number[] = [];

      vi.doMock('./state-writer.js', () => ({
        writeDaemonStatus: async () => {},
        writeRunningStatus: async () => {},
        writeStoppedStatus: async () => {},
        writeStoppingStatus: async () => {},
        writeErrorStatus: async () => {},
        writeUnexpectedExitStatus: async () => {},
        writeRestartingStatus: async () => {},
        writeRestartCompletedStatus: async () => {},
        writeCycleStatus: async () => {},
        writeDegradedStatus: async () => {},
        readExistingStatus: async () => null,
        buildLastErrorDetail: (
          code: string,
          message: string,
          recoveryCommand: string | null = null,
        ) => ({
          code,
          message,
          recoveryCommand,
        }),
      }));

      setupRunDaemonMocks(dataDir, {
        PollingLoopImpl: class ImmediateExitPollingLoop {
          readonly lastPollAt: string | null = null;
          reload() {}
          async start() {
            // Resolves immediately — simulates unexpected loop exit without a signal
          }
          async stop() {}
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
      });

      vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
        exitCodes.push(code);
      }) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      // Unexpected loop exit must trigger process.exit(1) to enable service manager restart.
      expect(exitCodes).toContain(1);
    });

    it('includes error message in daemon-status.json lastError when loop rejects (AC5, AC6)', async () => {
      vi.resetModules();

      const writtenStatuses: Array<Record<string, unknown>> = [];
      const fatalError = new Error('fatal-loop-error');

      const mockedWriteDaemonStatus2 = async (state: Record<string, unknown>) => {
        writtenStatuses.push(state);
      };
      vi.doMock('./state-writer.js', () => ({
        writeDaemonStatus: mockedWriteDaemonStatus2,
        writeRunningStatus: async () => {},
        writeStoppedStatus: async () => {},
        writeStoppingStatus: async () => {},
        writeErrorStatus: async () => {},
        writeRestartingStatus: async () => {},
        writeRestartCompletedStatus: async () => {},
        writeCycleStatus: async () => {},
        writeDegradedStatus: async () => {},
        readExistingStatus: async () => null,
        buildLastErrorDetail: (
          code: string,
          message: string,
          recoveryCommand: string | null = null,
        ) => ({
          code,
          message,
          recoveryCommand,
        }),
        writeUnexpectedExitStatus: async (
          startedAt: string,
          lastPollAt: string | null,
          lastError: string,
          lastErrorDetail: Record<string, unknown>,
        ) => {
          await mockedWriteDaemonStatus2({
            state: 'stopped',
            startedAt,
            lastPollAt,
            lastError,
            lastErrorDetail,
            pid: null,
            nextPollAt: null,
            activeTask: null,
            updatedAt: new Date().toISOString(),
            usage: null,
            trigger: null,
            lastDispatchAt: null,
            cycleResult: null,
            queueDepth: 0,
            backendState: null,
          });
        },
      }));

      setupRunDaemonMocks(dataDir, {
        PollingLoopImpl: class RejectingPollingLoop {
          readonly lastPollAt: string | null = null;
          reload() {}
          async start() {
            // Rejects with a fatal error — simulates polling-loop.ts fatal error re-throw
            throw fatalError;
          }
          async stop() {}
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      // The stopped status must include the error message from the fatal error.
      const stoppedWrite = writtenStatuses.find((s) => s['state'] === 'stopped');
      if (!stoppedWrite) throw new Error('Expected a writeDaemonStatus call with state: stopped');
      expect(stoppedWrite['lastError']).toBe('fatal-loop-error');
      // lastErrorDetail must also be populated.
      expect(stoppedWrite['lastErrorDetail']).not.toBeNull();
      const detail = stoppedWrite['lastErrorDetail'] as Record<string, unknown>;
      expect(detail['message']).toBe('fatal-loop-error');
    });

    it('skips unexpected-exit path when clean signal shutdown completed first (no double-exit)', async () => {
      vi.resetModules();

      const exitCodes: number[] = [];
      const writtenStatuses: Array<Record<string, unknown>> = [];

      vi.doMock('./state-writer.js', () => ({
        writeDaemonStatus: async (state: Record<string, unknown>) => {
          writtenStatuses.push(state);
        },
        writeRunningStatus: async () => {},
        writeStoppedStatus: async () => {
          writtenStatuses.push({ state: 'stopped', fromSignal: true });
        },
        writeStoppingStatus: async () => {},
        writeErrorStatus: async () => {},
        writeUnexpectedExitStatus: async () => {},
        writeRestartingStatus: async () => {},
        writeRestartCompletedStatus: async () => {},
        writeCycleStatus: async () => {},
        writeDegradedStatus: async () => {},
        readExistingStatus: async () => null,
        buildLastErrorDetail: (
          code: string,
          message: string,
          recoveryCommand: string | null = null,
        ) => ({
          code,
          message,
          recoveryCommand,
        }),
      }));

      // PollingLoop that simulates clean signal shutdown:
      // - The runner registers an onShutdownComplete callback that sets _cleanShutdownCompleted=true
      //   and calls process.exit(0).
      // - We capture onShutdownComplete and call it from start() before resolving.
      let capturedOnShutdownComplete: (() => void) | undefined;

      setupRunDaemonMocks(dataDir, {
        skipSignalHandlerMock: true,
        PollingLoopImpl: class CleanShutdownPollingLoop {
          readonly lastPollAt: string | null = null;
          reload() {}
          async start() {
            // Simulate clean shutdown: trigger onShutdownComplete (which aborts the
            // cleanShutdownController) before loop resolves, so runner sees the signal
            // as aborted and skips the unexpected-exit path.
            if (capturedOnShutdownComplete) {
              capturedOnShutdownComplete();
            }
          }
          async stop() {}
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
      });

      vi.doMock('./signal-handler.js', () => ({
        registerSignalHandlers: (opts: { onShutdownComplete?: () => void }) => {
          capturedOnShutdownComplete = opts.onShutdownComplete;
        },
        unregisterSignalHandlers: () => {},
      }));

      vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
        exitCodes.push(code);
      }) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      // Only exit(0) from clean shutdown — exit(1) from unexpected-exit must NOT be called.
      expect(exitCodes).toContain(0);
      expect(exitCodes).not.toContain(1);
      // No writeDaemonStatus call for state 'stopped' from unexpected-exit path.
      const unexpectedExitWrites = writtenStatuses.filter(
        (s) => s['state'] === 'stopped' && s['fromSignal'] !== true,
      );
      expect(unexpectedExitWrites.length).toBe(0);
    });

    it('continues to removePid and process.exit(1) when writeUnexpectedExitStatus throws', async () => {
      vi.resetModules();

      const exitCodes: number[] = [];
      const removePidCalls: string[] = [];

      vi.doMock('./state-writer.js', () => ({
        writeDaemonStatus: async () => {},
        writeRunningStatus: async () => {},
        writeStoppedStatus: async () => {},
        writeStoppingStatus: async () => {},
        writeErrorStatus: async () => {},
        writeRestartingStatus: async () => {},
        writeRestartCompletedStatus: async () => {},
        writeCycleStatus: async () => {},
        writeDegradedStatus: async () => {},
        readExistingStatus: async () => null,
        buildLastErrorDetail: (
          code: string,
          message: string,
          recoveryCommand: string | null = null,
        ) => ({
          code,
          message,
          recoveryCommand,
        }),
        writeUnexpectedExitStatus: async () => {
          throw new Error('status-write-failure');
        },
      }));

      setupRunDaemonMocks(dataDir, {
        removePidImpl: async (dir: string) => {
          removePidCalls.push(dir);
        },
        PollingLoopImpl: class ImmediateExitPollingLoop {
          readonly lastPollAt: string | null = null;
          reload() {}
          async start() {
            // Resolves immediately — simulates unexpected loop exit
          }
          async stop() {}
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
      });

      vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
        exitCodes.push(code);
      }) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      // Even when writeDaemonStatus throws, removePid must still be called and exit(1) reached.
      expect(removePidCalls.length).toBeGreaterThan(0);
      expect(exitCodes).toContain(1);
    });

    it('continues to process.exit(1) when removePid throws', async () => {
      vi.resetModules();

      const exitCodes: number[] = [];

      vi.doMock('./state-writer.js', () => ({
        writeDaemonStatus: async () => {},
        writeRunningStatus: async () => {},
        writeStoppedStatus: async () => {},
        writeStoppingStatus: async () => {},
        writeErrorStatus: async () => {},
        writeUnexpectedExitStatus: async () => {},
        writeRestartingStatus: async () => {},
        writeRestartCompletedStatus: async () => {},
        writeCycleStatus: async () => {},
        writeDegradedStatus: async () => {},
        readExistingStatus: async () => null,
        buildLastErrorDetail: (
          code: string,
          message: string,
          recoveryCommand: string | null = null,
        ) => ({
          code,
          message,
          recoveryCommand,
        }),
      }));

      setupRunDaemonMocks(dataDir, {
        removePidImpl: async () => {
          throw new Error('pid-remove-failure');
        },
        PollingLoopImpl: class ImmediateExitPollingLoop {
          readonly lastPollAt: string | null = null;
          reload() {}
          async start() {
            // Resolves immediately — simulates unexpected loop exit
          }
          async stop() {}
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
      });

      vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
        exitCodes.push(code);
      }) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      // Even when removePid throws, process.exit(1) must still be called.
      expect(exitCodes).toContain(1);
    });

    it('coerces non-Error loop rejection to string in lastError field', async () => {
      vi.resetModules();

      const writtenStatuses: Array<Record<string, unknown>> = [];

      const mockedWriteDaemonStatus3 = async (state: Record<string, unknown>) => {
        writtenStatuses.push(state);
      };
      vi.doMock('./state-writer.js', () => ({
        writeDaemonStatus: mockedWriteDaemonStatus3,
        writeRunningStatus: async () => {},
        writeStoppedStatus: async () => {},
        writeStoppingStatus: async () => {},
        writeErrorStatus: async () => {},
        writeRestartingStatus: async () => {},
        writeRestartCompletedStatus: async () => {},
        writeCycleStatus: async () => {},
        writeDegradedStatus: async () => {},
        readExistingStatus: async () => null,
        buildLastErrorDetail: (
          code: string,
          message: string,
          recoveryCommand: string | null = null,
        ) => ({
          code,
          message,
          recoveryCommand,
        }),
        writeUnexpectedExitStatus: async (
          startedAt: string,
          lastPollAt: string | null,
          lastError: string,
          lastErrorDetail: Record<string, unknown>,
        ) => {
          await mockedWriteDaemonStatus3({
            state: 'stopped',
            startedAt,
            lastPollAt,
            lastError,
            lastErrorDetail,
            pid: null,
            nextPollAt: null,
            activeTask: null,
            updatedAt: new Date().toISOString(),
            usage: null,
            trigger: null,
            lastDispatchAt: null,
            cycleResult: null,
            queueDepth: 0,
            backendState: null,
          });
        },
      }));

      setupRunDaemonMocks(dataDir, {
        PollingLoopImpl: class StringRejectingPollingLoop {
          readonly lastPollAt: string | null = null;
          reload() {}
          async start() {
            // Rejects with a non-Error value — exercises the String(loopErr) coercion path
            // eslint-disable-next-line @typescript-eslint/only-throw-error
            throw 'string-fatal-error';
          }
          async stop() {}
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      // The non-Error rejection value must be coerced to a string and appear in lastError.
      const stoppedWrite = writtenStatuses.find((s) => s['state'] === 'stopped');
      if (!stoppedWrite) throw new Error('Expected a writeDaemonStatus call with state: stopped');
      expect(stoppedWrite['lastError']).toBe('string-fatal-error');
    });

    it('calls writeUnexpectedExitStatus on unexpected loop exit with correct args (Story 14.3 AC1)', async () => {
      vi.resetModules();

      // Capture arguments passed to writeUnexpectedExitStatus by runner.ts.
      // This test verifies that runner.ts correctly delegates to the real function
      // (not re-implements it). The preservation logic is covered in state-writer.test.ts.
      type CallArgs = [string, string | null, string, Record<string, unknown>];
      const capturedCalls: CallArgs[] = [];

      vi.doMock('./state-writer.js', () => ({
        writeDaemonStatus: async () => {},
        writeRunningStatus: async () => {},
        writeStoppedStatus: async () => {},
        writeStoppingStatus: async () => {},
        writeErrorStatus: async () => {},
        writeRestartingStatus: async () => {},
        writeRestartCompletedStatus: async () => {},
        writeCycleStatus: async () => {},
        writeDegradedStatus: async () => {},
        readExistingStatus: async () => null,
        buildLastErrorDetail: (
          code: string,
          message: string,
          recoveryCommand: string | null = null,
        ) => ({
          code,
          message,
          recoveryCommand,
        }),
        writeUnexpectedExitStatus: async (
          startedAt: string,
          lastPollAt: string | null,
          lastError: string,
          lastErrorDetail: Record<string, unknown>,
        ) => {
          capturedCalls.push([startedAt, lastPollAt, lastError, lastErrorDetail]);
        },
      }));

      setupRunDaemonMocks(dataDir, {
        PollingLoopImpl: class ImmediateExitPollingLoop {
          readonly lastPollAt: string | null = null;
          reload() {}
          async start() {
            // Resolves immediately — simulates unexpected loop exit
          }
          async stop() {}
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      // Verify runner.ts called writeUnexpectedExitStatus exactly once
      expect(capturedCalls).toHaveLength(1);
      const [startedAt, lastPollAt, lastError, lastErrorDetail] = capturedCalls[0]!;

      // startedAt must be an ISO 8601 string
      expect(typeof startedAt).toBe('string');
      expect(startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      // lastPollAt is null when PollingLoop.lastPollAt is null (no cycle completed)
      expect(lastPollAt).toBeNull();

      // lastError must be a non-empty string describing the exit reason
      expect(typeof lastError).toBe('string');
      expect(lastError.length).toBeGreaterThan(0);

      // lastErrorDetail must be a structured error object with required fields
      expect(typeof lastErrorDetail).toBe('object');
      expect(lastErrorDetail).not.toBeNull();
      expect(typeof lastErrorDetail['code']).toBe('string');
      expect(typeof lastErrorDetail['message']).toBe('string');
    });

    it('calls writeUnexpectedExitStatus when no prior status file exists (Story 14.3 AC2)', async () => {
      vi.resetModules();

      // No pre-existing daemon-status.json in dataDir.
      // Verifies runner.ts calls writeUnexpectedExitStatus even when state file is absent.
      type CallArgs = [string, string | null, string, Record<string, unknown>];
      const capturedCalls: CallArgs[] = [];

      vi.doMock('./state-writer.js', () => ({
        writeDaemonStatus: async () => {},
        writeRunningStatus: async () => {},
        writeStoppedStatus: async () => {},
        writeStoppingStatus: async () => {},
        writeErrorStatus: async () => {},
        writeRestartingStatus: async () => {},
        writeRestartCompletedStatus: async () => {},
        writeCycleStatus: async () => {},
        writeDegradedStatus: async () => {},
        readExistingStatus: async () => null,
        buildLastErrorDetail: (
          code: string,
          message: string,
          recoveryCommand: string | null = null,
        ) => ({
          code,
          message,
          recoveryCommand,
        }),
        writeUnexpectedExitStatus: async (
          startedAt: string,
          lastPollAt: string | null,
          lastError: string,
          lastErrorDetail: Record<string, unknown>,
        ) => {
          capturedCalls.push([startedAt, lastPollAt, lastError, lastErrorDetail]);
        },
      }));

      setupRunDaemonMocks(dataDir, {
        PollingLoopImpl: class ImmediateExitPollingLoop {
          readonly lastPollAt: string | null = null;
          reload() {}
          async start() {
            // Resolves immediately — simulates unexpected loop exit
          }
          async stop() {}
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      // Verify runner.ts called writeUnexpectedExitStatus exactly once
      expect(capturedCalls).toHaveLength(1);
      const [startedAt, lastPollAt, lastError, lastErrorDetail] = capturedCalls[0]!;

      // startedAt must be an ISO 8601 string
      expect(typeof startedAt).toBe('string');
      expect(startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      // lastPollAt is null when no poll cycle has completed
      expect(lastPollAt).toBeNull();

      // lastError and lastErrorDetail are always set on unexpected exit
      expect(typeof lastError).toBe('string');
      expect(lastError.length).toBeGreaterThan(0);
      expect(typeof lastErrorDetail['code']).toBe('string');
    });

    it('reloadConfig re-applies fail-fast backend guard — preserves last-good config when validateProviderBackend throws on reload (H1)', async () => {
      vi.resetModules();

      // H1 fix: when reloadConfig() calls validateProviderBackend() with the new config and it
      // throws (e.g. CONTAINER_RUNTIME_NOT_FOUND for 'container'), the catch block must fire and
      // preserve last-known-good config (same as invalid YAML behaviour).
      // validateProviderBackend() is used instead of the full createProvider() to avoid
      // wastefully constructing the full provider bundle on every hot reload.
      let reloadConfigRef: (() => Promise<void>) | undefined;
      let loadConfigCallCount = 0;
      let degradedWrittenOnReload = false;
      let validateProviderBackendCallCount = 0;

      setupRunDaemonMocks(dataDir, {
        configMock: {
          CONFIG_FALLBACK: {
            pollingInterval: 300,
            logRetentionDays: 30,
            taskTimeoutMinutes: 60,
            provider: {
              name: 'claude-code',
              allowDangerouslySkipPermissions: false,
              executionBackend: 'container',
            },
            trigger: { maxWastePercentage: 50, weeklyReservePercentage: 30, idleHours: [] },
            tasks: [],
            lastSummaryEnabled: false,
          },
          createConfigWatcher: (_path: string, onReload: () => Promise<void>) => {
            reloadConfigRef = onReload;
            return { close: () => {} };
          },
          loadConfig: async () => {
            loadConfigCallCount++;
            return {
              pollingInterval: 300,
              logRetentionDays: 30,
              provider: {
                name: 'claude-code',
                allowDangerouslySkipPermissions: false,
                executionBackend: loadConfigCallCount > 1 ? 'container' : ('direct' as const),
              },
              trigger: { maxWastePercentage: 50, weeklyReservePercentage: 30, idleHours: [] },
              tasks: [],
              lastSummaryEnabled: false,
            };
          },
        },
        providersMock: {
          createProvider: async (..._args: unknown[]) => ({
            usageMonitor: {
              getSnapshot: async () => ({
                sessionTokensUsed: 0,
                sessionTokensTotal: 1000,
                weeklyTokensUsed: 0,
                weeklyTokensTotal: 5000,
                usagePercentage: 0,
                capturedAt: new Date().toISOString(),
                source: 'test',
                confidence: 'high',
              }),
            },
            taskExecutor: { _type: 'TaskExecutor' },
          }),
          validateProviderBackend: async (..._args: unknown[]) => {
            validateProviderBackendCallCount++;
            if (validateProviderBackendCallCount > 0) {
              throw new Error(
                "Container runtime not found. The 'container' execution backend requires Docker or Podman.",
              );
            }
          },
        },
        PollingLoopImpl: class H1TestPollingLoop {
          readonly lastPollAt: string | null = null;
          reload(_newConfig: unknown) {}
          async start() {
            if (reloadConfigRef) {
              await reloadConfigRef();
            }
          }
          async stop() {}
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
      });

      vi.doMock('./state-writer.js', () => ({
        writeDaemonStatus: async () => {},
        writeRunningStatus: async () => {},
        writeStoppedStatus: async () => {},
        writeStoppingStatus: async () => {},
        writeErrorStatus: async () => {},
        writeUnexpectedExitStatus: async () => {},
        writeRestartingStatus: async () => {},
        writeRestartCompletedStatus: async () => {},
        writeCycleStatus: async () => {},
        readExistingStatus: async () => null,
        buildLastErrorDetail: (
          code: string,
          message: string,
          recoveryCommand: string | null = null,
        ) => ({
          code,
          message,
          recoveryCommand,
        }),
        writeDegradedStatus: async () => {
          degradedWrittenOnReload = true;
        },
      }));

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      // validateProviderBackend must have been called once (on reload)
      expect(validateProviderBackendCallCount).toBe(1);
      // The reload must have fallen into the catch path (degraded status written)
      expect(degradedWrittenOnReload).toBe(true);
    });

    it('getBackendState returns backend state when provider.backend has getBackendState', async () => {
      vi.resetModules();

      const fakeBackendState = { runtime: 'docker', available: true };
      let capturedGetBackendState: (() => Promise<unknown>) | undefined;

      setupRunDaemonMocks(dataDir, {
        providersMock: {
          createProvider: async () => ({
            usageMonitor: { getSnapshot: async () => ({}) },
            taskExecutor: { _type: 'TaskExecutor' },
            backend: {
              available: async () => true,
              getBackendState: async () => fakeBackendState,
            },
          }),
          validateProviderBackend: async () => {},
        },
        PollingLoopImpl: class BackendStatePollingLoop {
          readonly lastPollAt: string | null = null;
          reload() {}
          async start() {}
          async stop() {}
          constructor(deps: { getBackendState?: () => Promise<unknown> }) {
            capturedGetBackendState = deps.getBackendState;
          }
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      expect(capturedGetBackendState).toBeDefined();
      const state = await capturedGetBackendState!();
      expect(state).toEqual(fakeBackendState);
    });

    it('getBackendState returns null when provider has no backend', async () => {
      vi.resetModules();

      let capturedGetBackendState: (() => Promise<unknown>) | undefined;

      setupRunDaemonMocks(dataDir, {
        providersMock: {
          createProvider: async () => ({
            usageMonitor: { getSnapshot: async () => ({}) },
            taskExecutor: { _type: 'TaskExecutor' },
          }),
          validateProviderBackend: async () => {},
        },
        PollingLoopImpl: class NoBackendPollingLoop {
          readonly lastPollAt: string | null = null;
          reload() {}
          async start() {}
          async stop() {}
          constructor(deps: { getBackendState?: () => Promise<unknown> }) {
            capturedGetBackendState = deps.getBackendState;
          }
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      expect(capturedGetBackendState).toBeDefined();
      const state = await capturedGetBackendState!();
      expect(state).toBeNull();
    });

    it('checkBackendAvailable returns true when provider.backend.available() returns true', async () => {
      vi.resetModules();

      let capturedCheckBackendAvailable: (() => Promise<boolean>) | undefined;

      setupRunDaemonMocks(dataDir, {
        providersMock: {
          createProvider: async () => ({
            usageMonitor: { getSnapshot: async () => ({}) },
            taskExecutor: { _type: 'TaskExecutor' },
            backend: {
              available: async () => true,
              getBackendState: async () => null,
            },
          }),
          validateProviderBackend: async () => {},
        },
        PollingLoopImpl: class CheckAvailPollingLoop {
          readonly lastPollAt: string | null = null;
          reload() {}
          async start() {}
          async stop() {}
          constructor(deps: { checkBackendAvailable?: () => Promise<boolean> }) {
            capturedCheckBackendAvailable = deps.checkBackendAvailable;
          }
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      expect(capturedCheckBackendAvailable).toBeDefined();
      const available = await capturedCheckBackendAvailable!();
      expect(available).toBe(true);
    });

    it('checkBackendAvailable returns false when provider has no backend', async () => {
      vi.resetModules();

      let capturedCheckBackendAvailable: (() => Promise<boolean>) | undefined;

      setupRunDaemonMocks(dataDir, {
        providersMock: {
          createProvider: async () => ({
            usageMonitor: { getSnapshot: async () => ({}) },
            taskExecutor: { _type: 'TaskExecutor' },
          }),
          validateProviderBackend: async () => {},
        },
        PollingLoopImpl: class NoBackendAvailPollingLoop {
          readonly lastPollAt: string | null = null;
          reload() {}
          async start() {}
          async stop() {}
          constructor(deps: { checkBackendAvailable?: () => Promise<boolean> }) {
            capturedCheckBackendAvailable = deps.checkBackendAvailable;
          }
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      expect(capturedCheckBackendAvailable).toBeDefined();
      const available = await capturedCheckBackendAvailable!();
      expect(available).toBe(false);
    });

    it('continues startup when cleanExpiredLogs throws (non-fatal retention cleanup)', async () => {
      vi.resetModules();

      let loopStarted = false;

      vi.doMock('./log-retention.js', () => ({
        cleanExpiredLogs: async () => {
          throw new Error('retention cleanup EACCES');
        },
        cleanExpiredTaskOutputs: async () => {},
      }));

      setupRunDaemonMocks(dataDir, {
        PollingLoopImpl: class RetentionFailPollingLoop {
          readonly lastPollAt: string | null = null;
          reload() {}
          async start() {
            loopStarted = true;
          }
          async stop() {}
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      expect(loopStarted).toBe(true);
    });

    it('continues startup when cleanExpiredTaskOutputs throws (non-fatal retention cleanup)', async () => {
      vi.resetModules();

      let loopStarted = false;

      vi.doMock('./log-retention.js', () => ({
        cleanExpiredLogs: async () => {},
        cleanExpiredTaskOutputs: async () => {
          throw new Error('task-outputs cleanup failed');
        },
      }));

      setupRunDaemonMocks(dataDir, {
        PollingLoopImpl: class TaskOutputRetentionFailPollingLoop {
          readonly lastPollAt: string | null = null;
          reload() {}
          async start() {
            loopStarted = true;
          }
          async stop() {}
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      expect(loopStarted).toBe(true);
    });

    it('writes ScrowError code in stopped status when createProvider throws a ScrowError', async () => {
      vi.resetModules();

      const statusWrites: Array<Record<string, unknown>> = [];

      vi.doMock('./state-writer.js', () => ({
        writeDaemonStatus: async (status: Record<string, unknown>) => {
          statusWrites.push(status);
        },
        writeRunningStatus: async () => {},
        writeStoppedStatus: async () => {},
        writeStoppingStatus: async () => {},
        writeErrorStatus: async () => {},
        writeUnexpectedExitStatus: async () => {},
        writeRestartingStatus: async () => {},
        writeRestartCompletedStatus: async () => {},
        writeCycleStatus: async () => {},
        writeDegradedStatus: async () => {},
        readExistingStatus: async () => null,
        buildLastErrorDetail: (
          code: string,
          message: string,
          recoveryCommand: string | null = null,
        ) => ({
          code,
          message,
          recoveryCommand,
        }),
      }));

      setupRunDaemonMocks(dataDir, {
        providersMock: {
          createProvider: async () => {
            const { ScrowError: SE, ErrorCode: EC } = await import('../errors/index.js');
            throw new SE(EC.PROVIDER_NOT_FOUND, 'Provider not found');
          },
          validateProviderBackend: async () => {},
        },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      // The stopped status must include the ScrowError code
      const stoppedWrite = statusWrites.find((s) => s['state'] === 'stopped');
      expect(stoppedWrite).toBeDefined();
      const detail = stoppedWrite!['lastErrorDetail'] as Record<string, unknown>;
      expect(detail['code']).toBe('PROVIDER_NOT_FOUND');
    });

    it('uncaughtException handler logs write failure when writeDegradedStatus rejects', async () => {
      vi.resetModules();

      let uncaughtHandlerRef: ((err: unknown) => void) | undefined;
      const stderrWrites: string[] = [];

      vi.doMock('./state-writer.js', () => ({
        writeDaemonStatus: async () => {},
        writeRunningStatus: async () => {},
        writeStoppedStatus: async () => {},
        writeStoppingStatus: async () => {},
        writeErrorStatus: async () => {},
        writeUnexpectedExitStatus: async () => {},
        writeRestartingStatus: async () => {},
        writeRestartCompletedStatus: async () => {},
        writeCycleStatus: async () => {},
        readExistingStatus: async () => null,
        buildLastErrorDetail: (
          code: string,
          message: string,
          recoveryCommand: string | null = null,
        ) => ({
          code,
          message,
          recoveryCommand,
        }),
        writeDegradedStatus: async () => {
          throw new Error('disk-full-write-failure');
        },
      }));

      setupRunDaemonMocks(dataDir, {
        PollingLoopImpl: class UncaughtWriteFailPollingLoop {
          readonly lastPollAt: string | null = null;
          reload() {}
          async start() {
            if (uncaughtHandlerRef) {
              uncaughtHandlerRef(new Error('test-uncaught-write-fail'));
              await new Promise<void>((r) => setTimeout(r, 200));
            }
          }
          async stop() {}
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
        stderrWrites.push(typeof chunk === 'string' ? chunk : chunk.toString());
        return true;
      });

      const origOn = process.on.bind(process);
      vi.spyOn(process, 'on').mockImplementation(
        (event: string | symbol, handler: (...args: unknown[]) => void) => {
          if (event === 'uncaughtException') {
            uncaughtHandlerRef = handler as (err: unknown) => void;
          }
          return origOn(event as NodeJS.Signals, handler as NodeJS.SignalsListener);
        },
      );

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      // The .catch() handler must log the write failure
      const writeFailLog = stderrWrites.find((w) =>
        w.includes('runner.uncaught_exception_status_write_failed'),
      );
      expect(writeFailLog).toBeDefined();
    });

    it('unhandledRejection handler logs write failure when writeDegradedStatus rejects', async () => {
      vi.resetModules();

      let rejectionHandlerRef: ((reason: unknown) => void) | undefined;
      const stderrWrites: string[] = [];

      vi.doMock('./state-writer.js', () => ({
        writeDaemonStatus: async () => {},
        writeRunningStatus: async () => {},
        writeStoppedStatus: async () => {},
        writeStoppingStatus: async () => {},
        writeErrorStatus: async () => {},
        writeUnexpectedExitStatus: async () => {},
        writeRestartingStatus: async () => {},
        writeRestartCompletedStatus: async () => {},
        writeCycleStatus: async () => {},
        readExistingStatus: async () => null,
        buildLastErrorDetail: (
          code: string,
          message: string,
          recoveryCommand: string | null = null,
        ) => ({
          code,
          message,
          recoveryCommand,
        }),
        writeDegradedStatus: async () => {
          throw new Error('disk-full-rejection-write');
        },
      }));

      setupRunDaemonMocks(dataDir, {
        PollingLoopImpl: class RejectionWriteFailPollingLoop {
          readonly lastPollAt: string | null = null;
          reload() {}
          async start() {
            if (rejectionHandlerRef) {
              rejectionHandlerRef(new Error('test-rejection-write-fail'));
              await new Promise<void>((r) => setTimeout(r, 200));
            }
          }
          async stop() {}
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
        stderrWrites.push(typeof chunk === 'string' ? chunk : chunk.toString());
        return true;
      });

      const origOn = process.on.bind(process);
      vi.spyOn(process, 'on').mockImplementation(
        (event: string | symbol, handler: (...args: unknown[]) => void) => {
          if (event === 'unhandledRejection') {
            rejectionHandlerRef = handler as (reason: unknown) => void;
          }
          return origOn(event as NodeJS.Signals, handler as NodeJS.SignalsListener);
        },
      );

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      const writeFailLog = stderrWrites.find((w) =>
        w.includes('runner.unhandled_rejection_status_write_failed'),
      );
      expect(writeFailLog).toBeDefined();
    });

    it('reloadConfig success path updates currentConfig and calls loop.reload when no restart-required keys', async () => {
      vi.resetModules();

      let reloadConfigRef: (() => Promise<void>) | undefined;
      let loadConfigCallCount = 0;
      let loopReloadCalled = false;
      let capturedGetConfig: (() => { pollingInterval: number }) | undefined;

      setupRunDaemonMocks(dataDir, {
        configMock: {
          CONFIG_FALLBACK: {
            pollingInterval: 300,
            logRetentionDays: 30,
            taskTimeoutMinutes: 60,
            provider: {
              name: 'claude-code',
              allowDangerouslySkipPermissions: false,
              executionBackend: 'container',
            },
            trigger: { maxWastePercentage: 50, weeklyReservePercentage: 30, idleHours: [] },
            tasks: [],
            lastSummaryEnabled: false,
          },
          createConfigWatcher: (_path: string, onReload: () => Promise<void>) => {
            reloadConfigRef = onReload;
            return { close: () => {} };
          },
          loadConfig: async () => {
            loadConfigCallCount++;
            return {
              pollingInterval: loadConfigCallCount > 1 ? 120 : 300,
              logRetentionDays: 30,
              provider: {
                name: 'claude-code',
                allowDangerouslySkipPermissions: false,
                executionBackend: 'container' as const,
              },
              trigger: { maxWastePercentage: 50, weeklyReservePercentage: 30, idleHours: [] },
              tasks: [],
              lastSummaryEnabled: false,
            };
          },
        },
        providersMock: {
          createProvider: async () => ({
            usageMonitor: { getSnapshot: async () => ({}) },
            taskExecutor: { _type: 'TaskExecutor' },
          }),
          validateProviderBackend: async () => {},
        },
        PollingLoopImpl: class ReloadSuccessPollingLoop {
          readonly lastPollAt: string | null = null;
          constructor(deps: { getConfig: () => { pollingInterval: number } }) {
            capturedGetConfig = deps.getConfig;
          }
          reload(_newConfig: unknown) {
            loopReloadCalled = true;
          }
          async start() {
            if (reloadConfigRef) {
              await reloadConfigRef();
            }
          }
          async stop() {}
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      // After reload, currentConfig should have the new pollingInterval
      expect(loopReloadCalled).toBe(true);
      expect(capturedGetConfig).toBeDefined();
      expect(capturedGetConfig!().pollingInterval).toBe(120);
    });

    it('reloadConfig catch path logs write failure when writeDegradedStatus throws', async () => {
      vi.resetModules();

      let reloadConfigRef: (() => Promise<void>) | undefined;
      let loadConfigCallCount = 0;
      const stderrWrites: string[] = [];

      setupRunDaemonMocks(dataDir, {
        configMock: {
          CONFIG_FALLBACK: {
            pollingInterval: 300,
            logRetentionDays: 30,
            taskTimeoutMinutes: 60,
            provider: {
              name: 'claude-code',
              allowDangerouslySkipPermissions: false,
              executionBackend: 'container',
            },
            trigger: { maxWastePercentage: 50, weeklyReservePercentage: 30, idleHours: [] },
            tasks: [],
            lastSummaryEnabled: false,
          },
          createConfigWatcher: (_path: string, onReload: () => Promise<void>) => {
            reloadConfigRef = onReload;
            return { close: () => {} };
          },
          loadConfig: async () => {
            loadConfigCallCount++;
            if (loadConfigCallCount > 1) {
              throw new Error('corrupt config');
            }
            return {
              pollingInterval: 300,
              logRetentionDays: 30,
              provider: {
                name: 'claude-code',
                allowDangerouslySkipPermissions: false,
                executionBackend: 'container' as const,
              },
              trigger: { maxWastePercentage: 50, weeklyReservePercentage: 30, idleHours: [] },
              tasks: [],
              lastSummaryEnabled: false,
            };
          },
        },
        PollingLoopImpl: class ReloadWriteFailPollingLoop {
          readonly lastPollAt: string | null = null;
          reload(_newConfig: unknown) {}
          async start() {
            if (reloadConfigRef) {
              await reloadConfigRef();
            }
          }
          async stop() {}
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
      });

      vi.doMock('./state-writer.js', () => ({
        writeDaemonStatus: async () => {},
        writeRunningStatus: async () => {},
        writeStoppedStatus: async () => {},
        writeStoppingStatus: async () => {},
        writeErrorStatus: async () => {},
        writeUnexpectedExitStatus: async () => {},
        writeRestartingStatus: async () => {},
        writeRestartCompletedStatus: async () => {},
        writeCycleStatus: async () => {},
        readExistingStatus: async () => null,
        buildLastErrorDetail: (
          code: string,
          message: string,
          recoveryCommand: string | null = null,
        ) => ({
          code,
          message,
          recoveryCommand,
        }),
        writeDegradedStatus: async () => {
          throw new Error('status write ENOSPC');
        },
      }));

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
        stderrWrites.push(typeof chunk === 'string' ? chunk : chunk.toString());
        return true;
      });

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      const writeFailLog = stderrWrites.find((w) =>
        w.includes('runner.config_reload_status_write_failed'),
      );
      expect(writeFailLog).toBeDefined();
    });

    it('onRestartRequired logs write failure when writeRestartingStatus throws (AC4 inner catch)', async () => {
      vi.resetModules();

      let capturedOnRestart: ((config: unknown, fields: string[]) => Promise<void>) | undefined;
      const stderrWrites: string[] = [];

      setupRunDaemonMocks(dataDir, {
        providersMock: {
          createProvider: async () => ({
            usageMonitor: { poll: async () => ({}) },
            taskExecutor: { _type: 'TaskExecutor' },
          }),
          validateProviderBackend: async () => {},
        },
        PollingLoopImpl: class RestartWriteFailPollingLoop {
          readonly lastPollAt: string | null = null;
          reload() {}
          async start() {}
          async stop() {}
          constructor(deps: {
            onRestartRequired?: (config: unknown, fields: string[]) => Promise<void>;
          }) {
            capturedOnRestart = deps.onRestartRequired;
          }
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
        DispatcherImpl: class SimpleDispatcher2 {
          constructor() {}
          async dispatch() {
            return null;
          }
          replaceExecutor() {}
        } as unknown as new (...args: unknown[]) => { dispatch: () => Promise<unknown> },
      });

      vi.doMock('./state-writer.js', () => ({
        writeDaemonStatus: async () => {},
        writeRunningStatus: async () => {},
        writeRestartingStatus: async () => {
          throw new Error('restart status write EACCES');
        },
        writeRestartCompletedStatus: async () => {},
        writeDegradedStatus: async () => {},
        writeStoppingStatus: async () => {},
        writeStoppedStatus: async () => {},
        writeUnexpectedExitStatus: async () => {},
        buildLastErrorDetail: (code: string, message: string, recoveryCommand: string | null) => ({
          code,
          message,
          recoveryCommand,
        }),
      }));

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
        stderrWrites.push(typeof chunk === 'string' ? chunk : chunk.toString());
        return true;
      });

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      expect(capturedOnRestart).toBeDefined();

      const newConfig = {
        pollingInterval: 300,
        logRetentionDays: 30,
        taskTimeoutMinutes: 60,
        provider: {
          name: 'claude-code',
          allowDangerouslySkipPermissions: false,
          executionBackend: 'container',
        },
        trigger: { maxWastePercentage: 50, weeklyReservePercentage: 30, idleHours: [] },
        tasks: [],
        lastSummaryEnabled: false,
      };
      await capturedOnRestart!(newConfig, ['provider']);

      const writeFailLog = stderrWrites.find((w) =>
        w.includes('runner.restart_status_write_failed'),
      );
      expect(writeFailLog).toBeDefined();
    });

    it('onRestartRequired catch path logs write failure when writeDegradedStatus throws', async () => {
      vi.resetModules();

      let capturedOnRestart: ((config: unknown, fields: string[]) => Promise<void>) | undefined;
      let createProviderCallCount = 0;
      const stderrWrites: string[] = [];

      setupRunDaemonMocks(dataDir, {
        providersMock: {
          createProvider: async () => {
            createProviderCallCount++;
            if (createProviderCallCount > 1) {
              throw new Error('provider restart failed');
            }
            return {
              usageMonitor: { poll: async () => ({}) },
              taskExecutor: { _type: 'TaskExecutor' },
            };
          },
          validateProviderBackend: async () => {},
        },
        PollingLoopImpl: class RestartDegradedWriteFailPollingLoop {
          readonly lastPollAt: string | null = null;
          reload() {}
          async start() {}
          async stop() {}
          constructor(deps: {
            onRestartRequired?: (config: unknown, fields: string[]) => Promise<void>;
          }) {
            capturedOnRestart = deps.onRestartRequired;
          }
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
        DispatcherImpl: class SimpleDispatcher3 {
          constructor() {}
          async dispatch() {
            return null;
          }
          replaceExecutor() {}
        } as unknown as new (...args: unknown[]) => { dispatch: () => Promise<unknown> },
      });

      vi.doMock('./state-writer.js', () => ({
        writeDaemonStatus: async () => {},
        writeRunningStatus: async () => {},
        writeRestartingStatus: async () => {},
        writeRestartCompletedStatus: async () => {},
        writeDegradedStatus: async () => {
          throw new Error('degraded write ENOSPC');
        },
        writeStoppingStatus: async () => {},
        writeStoppedStatus: async () => {},
        writeUnexpectedExitStatus: async () => {},
        buildLastErrorDetail: (code: string, message: string, recoveryCommand: string | null) => ({
          code,
          message,
          recoveryCommand,
        }),
      }));

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
        stderrWrites.push(typeof chunk === 'string' ? chunk : chunk.toString());
        return true;
      });

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      expect(capturedOnRestart).toBeDefined();

      const newConfig = {
        pollingInterval: 300,
        logRetentionDays: 30,
        taskTimeoutMinutes: 60,
        provider: {
          name: 'claude-code',
          allowDangerouslySkipPermissions: false,
          executionBackend: 'container',
        },
        trigger: { maxWastePercentage: 50, weeklyReservePercentage: 30, idleHours: [] },
        tasks: [],
        lastSummaryEnabled: false,
      };
      await capturedOnRestart!(newConfig, ['provider']);

      const writeFailLog = stderrWrites.find((w) =>
        w.includes('runner.restart_degraded_status_write_failed'),
      );
      expect(writeFailLog).toBeDefined();
    });

    it('retries config load on top-level EPERM error code (retryOn top-level code branch)', async () => {
      vi.resetModules();

      let loadAttempts = 0;
      let capturedPollingInterval: number | undefined;

      setupRunDaemonMocks(dataDir, {
        useInstantRetry: true,
        loadConfigFn: async () => {
          loadAttempts++;
          if (loadAttempts === 1) {
            // Top-level FS error code (not wrapped in cause) — exercises the
            // 'code' in error / topCode branch at lines 159-163
            const fsErr = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
            fsErr.code = 'EPERM';
            throw fsErr;
          }
          return {
            pollingInterval: 42,
            logRetentionDays: 30,
            taskTimeoutMinutes: 60,
            provider: {
              name: 'claude-code',
              allowDangerouslySkipPermissions: false,
              executionBackend: 'container',
            },
            trigger: { maxWastePercentage: 50, weeklyReservePercentage: 30, idleHours: [] },
            tasks: [],
            lastSummaryEnabled: false,
          };
        },
        PollingLoopImpl: class TopLevelCodePollingLoop {
          readonly lastPollAt: string | null = null;
          constructor(deps: { getConfig: () => { pollingInterval: number } }) {
            capturedPollingInterval = deps.getConfig().pollingInterval;
          }
          reload() {}
          async start() {}
          async stop() {}
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      // Should have retried and succeeded on second attempt
      expect(loadAttempts).toBe(2);
      expect(capturedPollingInterval).toBe(42);
    });

    it('continues startup when both retention cleanup functions throw (non-fatal)', async () => {
      vi.resetModules();

      let loopStarted = false;

      vi.doMock('./log-retention.js', () => ({
        cleanExpiredLogs: async () => {
          throw new Error('logs cleanup fail');
        },
        cleanExpiredTaskOutputs: async () => {
          throw new Error('task-outputs cleanup fail');
        },
      }));

      setupRunDaemonMocks(dataDir, {
        PollingLoopImpl: class BothRetentionFailPollingLoop {
          readonly lastPollAt: string | null = null;
          reload() {}
          async start() {
            loopStarted = true;
          }
          async stop() {}
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      expect(loopStarted).toBe(true);
    });

    it('reloadConfig retries on transient FS error with cause.code (reload retryOn cause branch)', async () => {
      vi.resetModules();

      let reloadConfigRef: (() => Promise<void>) | undefined;
      let loadConfigCallCount = 0;
      let loopReloadCalled = false;

      setupRunDaemonMocks(dataDir, {
        useInstantRetry: true,
        configMock: {
          CONFIG_FALLBACK: {
            pollingInterval: 300,
            logRetentionDays: 30,
            taskTimeoutMinutes: 60,
            provider: {
              name: 'claude-code',
              allowDangerouslySkipPermissions: false,
              executionBackend: 'container',
            },
            trigger: { maxWastePercentage: 50, weeklyReservePercentage: 30, idleHours: [] },
            tasks: [],
            lastSummaryEnabled: false,
          },
          createConfigWatcher: (_path: string, onReload: () => Promise<void>) => {
            reloadConfigRef = onReload;
            return { close: () => {} };
          },
          loadConfig: async () => {
            loadConfigCallCount++;
            if (loadConfigCallCount === 2) {
              const fsErr = new Error('EACCES') as NodeJS.ErrnoException;
              fsErr.code = 'EACCES';
              const wrappedErr = new Error('Config read failed');
              wrappedErr.cause = fsErr;
              throw wrappedErr;
            }
            return {
              pollingInterval: loadConfigCallCount > 2 ? 77 : 300,
              logRetentionDays: 30,
              provider: {
                name: 'claude-code',
                allowDangerouslySkipPermissions: false,
                executionBackend: 'container' as const,
              },
              trigger: { maxWastePercentage: 50, weeklyReservePercentage: 30, idleHours: [] },
              tasks: [],
              lastSummaryEnabled: false,
            };
          },
        },
        providersMock: {
          createProvider: async () => ({
            usageMonitor: { getSnapshot: async () => ({}) },
            taskExecutor: { _type: 'TaskExecutor' },
          }),
          validateProviderBackend: async () => {},
        },
        PollingLoopImpl: class ReloadRetryPollingLoop {
          readonly lastPollAt: string | null = null;
          reload(_newConfig: unknown) {
            loopReloadCalled = true;
          }
          async start() {
            if (reloadConfigRef) {
              await reloadConfigRef();
            }
          }
          async stop() {}
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      // loadConfig called: 1 (startup) + 2 (reload: first fails, second succeeds) = 3
      expect(loadConfigCallCount).toBe(3);
      expect(loopReloadCalled).toBe(true);
    });

    it('reloadConfig retries on top-level EPERM error code (reload retryOn top-level branch)', async () => {
      vi.resetModules();

      let reloadConfigRef: (() => Promise<void>) | undefined;
      let loadConfigCallCount = 0;
      let loopReloadCalled = false;

      setupRunDaemonMocks(dataDir, {
        useInstantRetry: true,
        configMock: {
          CONFIG_FALLBACK: {
            pollingInterval: 300,
            logRetentionDays: 30,
            taskTimeoutMinutes: 60,
            provider: {
              name: 'claude-code',
              allowDangerouslySkipPermissions: false,
              executionBackend: 'container',
            },
            trigger: { maxWastePercentage: 50, weeklyReservePercentage: 30, idleHours: [] },
            tasks: [],
            lastSummaryEnabled: false,
          },
          createConfigWatcher: (_path: string, onReload: () => Promise<void>) => {
            reloadConfigRef = onReload;
            return { close: () => {} };
          },
          loadConfig: async () => {
            loadConfigCallCount++;
            if (loadConfigCallCount === 2) {
              const fsErr = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
              fsErr.code = 'EPERM';
              throw fsErr;
            }
            return {
              pollingInterval: loadConfigCallCount > 2 ? 88 : 300,
              logRetentionDays: 30,
              provider: {
                name: 'claude-code',
                allowDangerouslySkipPermissions: false,
                executionBackend: 'container' as const,
              },
              trigger: { maxWastePercentage: 50, weeklyReservePercentage: 30, idleHours: [] },
              tasks: [],
              lastSummaryEnabled: false,
            };
          },
        },
        providersMock: {
          createProvider: async () => ({
            usageMonitor: { getSnapshot: async () => ({}) },
            taskExecutor: { _type: 'TaskExecutor' },
          }),
          validateProviderBackend: async () => {},
        },
        PollingLoopImpl: class ReloadTopCodePollingLoop {
          readonly lastPollAt: string | null = null;
          reload(_newConfig: unknown) {
            loopReloadCalled = true;
          }
          async start() {
            if (reloadConfigRef) {
              await reloadConfigRef();
            }
          }
          async stop() {}
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      expect(loadConfigCallCount).toBe(3);
      expect(loopReloadCalled).toBe(true);
    });

    it('onRestartRequired catch uses ScrowError code when provider restart fails with ScrowError', async () => {
      vi.resetModules();

      let capturedOnRestart: ((config: unknown, fields: string[]) => Promise<void>) | undefined;
      let createProviderCallCount = 0;
      const stderrWrites: string[] = [];

      setupRunDaemonMocks(dataDir, {
        providersMock: {
          createProvider: async () => {
            createProviderCallCount++;
            if (createProviderCallCount > 1) {
              const { ScrowError: SE, ErrorCode: EC } = await import('../errors/index.js');
              throw new SE(EC.CONTAINER_RUNTIME_NOT_FOUND, 'Docker not available');
            }
            return {
              usageMonitor: { poll: async () => ({}) },
              taskExecutor: { _type: 'TaskExecutor' },
            };
          },
          validateProviderBackend: async () => {},
        },
        PollingLoopImpl: class ScrowErrRestartPollingLoop {
          readonly lastPollAt: string | null = null;
          reload() {}
          async start() {}
          async stop() {}
          constructor(deps: {
            onRestartRequired?: (config: unknown, fields: string[]) => Promise<void>;
          }) {
            capturedOnRestart = deps.onRestartRequired;
          }
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
        DispatcherImpl: class SimpleDispatcher4 {
          constructor() {}
          async dispatch() {
            return null;
          }
          replaceExecutor() {}
        } as unknown as new (...args: unknown[]) => { dispatch: () => Promise<unknown> },
      });

      vi.doMock('./state-writer.js', () => ({
        writeDaemonStatus: async () => {},
        writeRunningStatus: async () => {},
        writeRestartingStatus: async () => {},
        writeRestartCompletedStatus: async () => {},
        writeDegradedStatus: async () => {},
        writeStoppingStatus: async () => {},
        writeStoppedStatus: async () => {},
        writeUnexpectedExitStatus: async () => {},
        buildLastErrorDetail: (code: string, message: string, recoveryCommand: string | null) => ({
          code,
          message,
          recoveryCommand,
        }),
      }));

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
        stderrWrites.push(typeof chunk === 'string' ? chunk : chunk.toString());
        return true;
      });

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      expect(capturedOnRestart).toBeDefined();

      const newConfig = {
        pollingInterval: 300,
        logRetentionDays: 30,
        taskTimeoutMinutes: 60,
        provider: {
          name: 'claude-code',
          allowDangerouslySkipPermissions: false,
          executionBackend: 'container',
        },
        trigger: { maxWastePercentage: 50, weeklyReservePercentage: 30, idleHours: [] },
        tasks: [],
        lastSummaryEnabled: false,
      };
      await capturedOnRestart!(newConfig, ['provider']);

      // The error log should include the ScrowError code
      const restartFailLog = stderrWrites.find((w) => w.includes('CONTAINER_RUNTIME_NOT_FOUND'));
      expect(restartFailLog).toBeDefined();
    });

    it('calls writeUnexpectedExitStatus to preserve cached usage data when polling loop crashes (Story 21.1 AC5)', async () => {
      // AC5: When an unexpected exit occurs, the daemon must write the cached usage data
      // to the status file so it is available after restart.
      // Placed in describe('runDaemon()') for correct discoverability.
      vi.resetModules();

      let writeUnexpectedExitCalled = false;
      let capturedLastError: string | undefined;
      let capturedLastErrorDetail: Record<string, unknown> | undefined;

      // Mock state-writer to capture writeUnexpectedExitStatus call.
      // Signature matches the real function: (startedAt, lastPollAt, lastError, lastErrorDetail)
      vi.doMock('./state-writer.js', () => ({
        writeDaemonStatus: async () => {},
        writeRunningStatus: async () => {},
        writeStoppedStatus: async () => {},
        writeStoppingStatus: async () => {},
        writeErrorStatus: async () => {},
        writeRestartingStatus: async () => {},
        writeRestartCompletedStatus: async () => {},
        writeCycleStatus: async () => {},
        readExistingStatus: async () => null,
        writeDegradedStatus: async () => {},
        writeUnexpectedExitStatus: async (
          _startedAt: string,
          _lastPollAt: string | null,
          lastError: string,
          lastErrorDetail: Record<string, unknown>,
        ) => {
          writeUnexpectedExitCalled = true;
          capturedLastError = lastError;
          capturedLastErrorDetail = lastErrorDetail;
        },
        buildLastErrorDetail: (code: string, message: string, recoveryCommand: string | null) => ({
          code,
          message,
          recoveryCommand,
        }),
      }));

      setupRunDaemonMocks(dataDir, {
        PollingLoopImpl: class CrashingPollingLoop {
          readonly lastPollAt: string | null = '2026-03-10T12:00:00.000Z';
          reload() {}
          async start() {
            // Simulate a fatal loop crash
            throw new Error('unexpected OOM crash');
          }
          async stop() {}
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      // writeUnexpectedExitStatus must have been called to preserve cached data
      expect(writeUnexpectedExitCalled).toBe(true);
      expect(capturedLastError).toContain('unexpected OOM crash');
      // The 4th argument (lastErrorDetail) must be passed — verifies the full contract
      expect(capturedLastErrorDetail).toBeDefined();
      expect(typeof capturedLastErrorDetail!['code']).toBe('string');
      expect(typeof capturedLastErrorDetail!['message']).toBe('string');
    });

    it('calls process.exit(1) when PidLock.acquire() returns false (lock contention path)', async () => {
      // Verifies the lock-contention early-exit path in runDaemon():
      //   acquire() returns false → log error → process.exit(1).
      // The PidLock mock (via pidLockAcquireResult: false) must be registered here so
      // the mocked PidLock class is used when runner.js imports ./pid-lock.js.
      vi.resetModules();

      const exitCodes: number[] = [];

      setupRunDaemonMocks(dataDir, { pidLockAcquireResult: false });

      vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
        exitCodes.push(code);
      }) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      // Lock contention must cause process.exit(1) before any polling loop is started.
      expect(exitCodes).toContain(1);
    });
  });

  describe('createDispatchAdapter()', () => {
    function makeCycleResult(overrides?: Partial<DispatchCycleResult>): DispatchCycleResult {
      return {
        tasksAttempted: 1,
        tasksSucceeded: 1,
        tasksFailed: 0,
        stoppedByQuota: false,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 50,
        ...overrides,
      };
    }

    function makeTriggerResult(shouldDispatch: boolean): TriggerResult {
      return {
        shouldDispatch,
        reason: shouldDispatch ? 'waste-potential-exceeded' : 'waste-potential-below-threshold',
        evaluatedAt: new Date(),
        snapshotSource: 'test',
        wastePotential: shouldDispatch ? 0.65 : 0.2,
        effectiveReserve: 0.15,
        availableBudget: 0.35,
        isIdleHours: false,
        rateHeadroom: true,
        perModelWaste: null,
      };
    }

    it('delegates to dispatcher.dispatch() and returns DispatchCycleResult when shouldDispatch is true', async () => {
      vi.resetModules();
      const expectedResult = makeCycleResult();
      const mockDispatch = vi.fn().mockResolvedValue(expectedResult);
      const mockDispatcher = {
        dispatch: mockDispatch,
      } as unknown as import('./dispatcher.js').Dispatcher;

      const { createDispatchAdapter } = await import('./runner.js');
      const adapter = createDispatchAdapter(mockDispatcher);
      const triggerResult = makeTriggerResult(true);

      const result = await adapter.dispatchIfTriggered(triggerResult);

      expect(mockDispatch).toHaveBeenCalledOnce();
      expect(result).toEqual(expectedResult);
    });

    it('returns a DispatchCycleResult with accurate task counts after a successful dispatch', async () => {
      vi.resetModules();
      const cycleResult = makeCycleResult({ tasksAttempted: 3, tasksSucceeded: 2, tasksFailed: 1 });
      const mockDispatch = vi.fn().mockResolvedValue(cycleResult);
      const mockDispatcher = {
        dispatch: mockDispatch,
      } as unknown as import('./dispatcher.js').Dispatcher;

      const { createDispatchAdapter } = await import('./runner.js');
      const adapter = createDispatchAdapter(mockDispatcher);
      const triggerResult = makeTriggerResult(true);

      const result = await adapter.dispatchIfTriggered(triggerResult);

      expect(result).not.toBeNull();
      expect(result!.tasksAttempted).toBe(3);
      expect(result!.tasksSucceeded).toBe(2);
      expect(result!.tasksFailed).toBe(1);
    });

    it('forwards the AbortSignal to dispatcher.dispatch()', async () => {
      vi.resetModules();
      const cycleResult = makeCycleResult();
      const mockDispatch = vi.fn().mockResolvedValue(cycleResult);
      const mockDispatcher = {
        dispatch: mockDispatch,
      } as unknown as import('./dispatcher.js').Dispatcher;

      const { createDispatchAdapter } = await import('./runner.js');
      const adapter = createDispatchAdapter(mockDispatcher);
      const triggerResult = makeTriggerResult(true);
      const controller = new AbortController();

      await adapter.dispatchIfTriggered(triggerResult, { signal: controller.signal });

      expect(mockDispatch).toHaveBeenCalledWith({ signal: controller.signal });
    });

    it('returns null without calling dispatcher when shouldDispatch is false', async () => {
      vi.resetModules();
      const mockDispatch = vi.fn();
      const mockDispatcher = {
        dispatch: mockDispatch,
      } as unknown as import('./dispatcher.js').Dispatcher;

      const { createDispatchAdapter } = await import('./runner.js');
      const adapter = createDispatchAdapter(mockDispatcher);
      const triggerResult = makeTriggerResult(false);

      const result = await adapter.dispatchIfTriggered(triggerResult);

      expect(result).toBeNull();
      expect(mockDispatch).not.toHaveBeenCalled();
    });

    it('calls dispatcher.dispatch() without signal option when no options are provided', async () => {
      vi.resetModules();
      const cycleResult = makeCycleResult();
      const mockDispatch = vi.fn().mockResolvedValue(cycleResult);
      const mockDispatcher = {
        dispatch: mockDispatch,
      } as unknown as import('./dispatcher.js').Dispatcher;

      const { createDispatchAdapter } = await import('./runner.js');
      const adapter = createDispatchAdapter(mockDispatcher);
      const triggerResult = makeTriggerResult(true);

      await adapter.dispatchIfTriggered(triggerResult);

      expect(mockDispatch).toHaveBeenCalledWith(undefined);
    });

    it('calls dispatcher.dispatch() with undefined when options object has no signal key', async () => {
      vi.resetModules();
      const cycleResult = makeCycleResult();
      const mockDispatch = vi.fn().mockResolvedValue(cycleResult);
      const mockDispatcher = {
        dispatch: mockDispatch,
      } as unknown as import('./dispatcher.js').Dispatcher;

      const { createDispatchAdapter } = await import('./runner.js');
      const adapter = createDispatchAdapter(mockDispatcher);
      const triggerResult = makeTriggerResult(true);

      // Pass empty options object — signal key absent, so options.signal is undefined
      await adapter.dispatchIfTriggered(triggerResult, {});

      // signal is undefined, so dispatch must be called with undefined (not { signal: undefined })
      expect(mockDispatch).toHaveBeenCalledWith(undefined);
    });

    it('propagates errors thrown by dispatcher.dispatch()', async () => {
      vi.resetModules();
      const mockDispatch = vi.fn().mockRejectedValue(new Error('dispatch failed'));
      const mockDispatcher = {
        dispatch: mockDispatch,
      } as unknown as import('./dispatcher.js').Dispatcher;

      const { createDispatchAdapter } = await import('./runner.js');
      const adapter = createDispatchAdapter(mockDispatcher);
      const triggerResult = makeTriggerResult(true);

      await expect(adapter.dispatchIfTriggered(triggerResult)).rejects.toThrow('dispatch failed');
    });

    it('passes options through to dispatcher.dispatch() when onTaskStart is defined', async () => {
      vi.resetModules();
      const cycleResult = makeCycleResult();
      const mockDispatch = vi.fn().mockResolvedValue(cycleResult);
      const mockDispatcher = {
        dispatch: mockDispatch,
      } as unknown as import('./dispatcher.js').Dispatcher;

      const { createDispatchAdapter } = await import('./runner.js');
      const adapter = createDispatchAdapter(mockDispatcher);
      const triggerResult = makeTriggerResult(true);
      const onTaskStart = vi.fn();

      await adapter.dispatchIfTriggered(triggerResult, { onTaskStart });

      // When onTaskStart is defined, options must be forwarded as-is (not undefined)
      expect(mockDispatch).toHaveBeenCalledWith({ onTaskStart });
    });

    it('passes options through to dispatcher.dispatch() when onTaskComplete is defined', async () => {
      vi.resetModules();
      const cycleResult = makeCycleResult();
      const mockDispatch = vi.fn().mockResolvedValue(cycleResult);
      const mockDispatcher = {
        dispatch: mockDispatch,
      } as unknown as import('./dispatcher.js').Dispatcher;

      const { createDispatchAdapter } = await import('./runner.js');
      const adapter = createDispatchAdapter(mockDispatcher);
      const triggerResult = makeTriggerResult(true);
      const onTaskComplete = vi.fn();

      await adapter.dispatchIfTriggered(triggerResult, { onTaskComplete });

      expect(mockDispatch).toHaveBeenCalledWith({ onTaskComplete });
    });

    it('passes options through when signal is defined alongside callbacks', async () => {
      vi.resetModules();
      const cycleResult = makeCycleResult();
      const mockDispatch = vi.fn().mockResolvedValue(cycleResult);
      const mockDispatcher = {
        dispatch: mockDispatch,
      } as unknown as import('./dispatcher.js').Dispatcher;

      const { createDispatchAdapter } = await import('./runner.js');
      const adapter = createDispatchAdapter(mockDispatcher);
      const triggerResult = makeTriggerResult(true);
      const controller = new AbortController();
      const onTaskStart = vi.fn();

      await adapter.dispatchIfTriggered(triggerResult, {
        signal: controller.signal,
        onTaskStart,
      });

      expect(mockDispatch).toHaveBeenCalledWith({
        signal: controller.signal,
        onTaskStart,
      });
    });
  });

  describe('onRestartRequired callback (Story 10.4)', () => {
    it('passes onRestartRequired to PollingLoop deps and reconstructs provider on invoke (6.4)', async () => {
      vi.resetModules();

      // Track the onRestartRequired callback passed to PollingLoop
      let capturedOnRestart: ((config: unknown, fields: string[]) => Promise<void>) | undefined;
      let createProviderCallCount = 0;
      const fakeNewTaskExecutor = { _type: 'NewTaskExecutor' };

      // Track Dispatcher.replaceExecutor calls
      let replaceExecutorCalled = false;
      let replaceExecutorArg: unknown = null;

      setupRunDaemonMocks(dataDir, {
        providersMock: {
          createProvider: async () => {
            createProviderCallCount += 1;
            if (createProviderCallCount === 1) {
              return {
                usageMonitor: { poll: async () => ({}) },
                taskExecutor: { _type: 'OldTaskExecutor' },
              };
            }
            return {
              usageMonitor: { poll: async () => ({}) },
              taskExecutor: fakeNewTaskExecutor,
            };
          },
          validateProviderBackend: async () => {},
        },
        PollingLoopImpl: class CapturePollingLoop {
          readonly lastPollAt: string | null = null;
          reload() {}
          async start() {}
          async stop() {}
          constructor(deps: {
            onRestartRequired?: (config: unknown, fields: string[]) => Promise<void>;
          }) {
            capturedOnRestart = deps.onRestartRequired;
          }
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
        DispatcherImpl: class ReplaceableDispatcher {
          constructor() {}
          async dispatch() {
            return null;
          }
          replaceExecutor(newExec: unknown) {
            replaceExecutorCalled = true;
            replaceExecutorArg = newExec;
          }
        } as unknown as new (...args: unknown[]) => { dispatch: () => Promise<unknown> },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      // PollingLoop must have been constructed with onRestartRequired callback
      expect(capturedOnRestart).toBeDefined();
      expect(typeof capturedOnRestart).toBe('function');

      // Simulate a provider config change by invoking the callback
      const newConfig = {
        pollingInterval: 300,
        logRetentionDays: 30,
        taskTimeoutMinutes: 60,
        provider: {
          name: 'claude-code',
          claudePath: '/usr/local/bin/claude',
          allowDangerouslySkipPermissions: false,
          executionBackend: 'container',
        },
        trigger: { maxWastePercentage: 50, weeklyReservePercentage: 30, idleHours: [] },
        tasks: [],
        lastSummaryEnabled: false,
      };
      await capturedOnRestart!(newConfig, ['provider']);

      // createProvider should have been called twice (initial + restart)
      expect(createProviderCallCount).toBe(2);

      // Dispatcher.replaceExecutor should have been called with the new executor
      expect(replaceExecutorCalled).toBe(true);
      expect(replaceExecutorArg).toBe(fakeNewTaskExecutor);
    });

    it('falls back to old provider when createProvider fails during restart (AC6, 6.5)', async () => {
      vi.resetModules();

      let capturedOnRestart: ((config: unknown, fields: string[]) => Promise<void>) | undefined;
      let createProviderCallCount = 0;
      let replaceExecutorCalled = false;
      const statusWrites: string[] = [];

      setupRunDaemonMocks(dataDir, {
        providersMock: {
          createProvider: async () => {
            createProviderCallCount += 1;
            if (createProviderCallCount === 1) {
              return {
                usageMonitor: { poll: async () => ({}) },
                taskExecutor: { _type: 'OldTaskExecutor' },
              };
            }
            throw new Error('Container runtime not found');
          },
          validateProviderBackend: async () => {},
        },
        PollingLoopImpl: class CapturePollingLoop {
          readonly lastPollAt: string | null = null;
          reload() {}
          async start() {}
          async stop() {}
          constructor(deps: {
            onRestartRequired?: (config: unknown, fields: string[]) => Promise<void>;
          }) {
            capturedOnRestart = deps.onRestartRequired;
          }
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
        DispatcherImpl: class NoReplaceDispatcher {
          constructor() {}
          async dispatch() {
            return null;
          }
          replaceExecutor() {
            replaceExecutorCalled = true;
          }
        } as unknown as new (...args: unknown[]) => { dispatch: () => Promise<unknown> },
      });

      // Mock state-writer.js directly to capture state transitions
      vi.doMock('./state-writer.js', () => ({
        writeDaemonStatus: async (status: { state?: string }) => {
          if (status.state) {
            statusWrites.push(status.state);
          }
        },
        writeRunningStatus: async (startedAt: string, pid: number) => {
          void startedAt;
          void pid;
          statusWrites.push('running');
        },
        writeRestartingStatus: async (startedAt: string | null, pid: number | null) => {
          void startedAt;
          void pid;
          statusWrites.push('restarting');
        },
        writeDegradedStatus: async (startedAt: string | null, lastError: string) => {
          void startedAt;
          void lastError;
          statusWrites.push('running');
        },
        writeStoppingStatus: async () => {},
        writeStoppedStatus: async () => {},
        writeErrorStatus: async () => {},
        writeCycleStatus: async () => {},
        writeUnexpectedExitStatus: async () => {
          statusWrites.push('stopped');
        },
        writeRestartCompletedStatus: async () => {},
        buildLastErrorDetail: (code: string, message: string, recoveryCommand: string | null) => ({
          code,
          message,
          recoveryCommand,
        }),
      }));

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      expect(capturedOnRestart).toBeDefined();

      // Clear initial status writes from bootstrap (writeRunningStatus in runDaemon)
      statusWrites.length = 0;

      // Invoke the restart callback with a config that will fail
      const newConfig = {
        pollingInterval: 300,
        logRetentionDays: 30,
        taskTimeoutMinutes: 60,
        provider: {
          name: 'claude-code',
          claudePath: '/usr/local/bin/claude',
          allowDangerouslySkipPermissions: false,
          executionBackend: 'container',
        },
        trigger: { maxWastePercentage: 50, weeklyReservePercentage: 30, idleHours: [] },
        tasks: [],
        lastSummaryEnabled: false,
      };
      await capturedOnRestart!(newConfig, ['provider']);

      // createProvider was called twice (initial + failed restart)
      expect(createProviderCallCount).toBe(2);

      // Dispatcher.replaceExecutor should NOT have been called (provider failed)
      expect(replaceExecutorCalled).toBe(false);

      // Status writes during restart: 'restarting' then 'running' (degraded fallback)
      expect(statusWrites).toContain('restarting');
      expect(statusWrites).toContain('running');
      // Restarting comes before the degraded running state
      const restartIdx = statusWrites.indexOf('restarting');
      const runningIdx = statusWrites.indexOf('running');
      expect(restartIdx).toBeLessThan(runningIdx);
    });

    it('calls validateProviderBackend before createProvider during restart (Finding 4)', async () => {
      vi.resetModules();

      let capturedOnRestart: ((config: unknown, fields: string[]) => Promise<void>) | undefined;
      let validateProviderBackendCallCount = 0;
      let createProviderCallCount = 0;

      setupRunDaemonMocks(dataDir, {
        providersMock: {
          createProvider: async () => {
            createProviderCallCount += 1;
            return {
              usageMonitor: { poll: async () => ({}) },
              taskExecutor: { _type: 'TaskExecutor' },
            };
          },
          validateProviderBackend: async (..._args: unknown[]) => {
            validateProviderBackendCallCount += 1;
          },
        },
        PollingLoopImpl: class CapturePollingLoop {
          readonly lastPollAt: string | null = null;
          reload() {}
          async start() {}
          async stop() {}
          constructor(deps: {
            onRestartRequired?: (config: unknown, fields: string[]) => Promise<void>;
          }) {
            capturedOnRestart = deps.onRestartRequired;
          }
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
        DispatcherImpl: class SimpleDispatcher {
          constructor() {}
          async dispatch() {
            return null;
          }
          replaceExecutor() {}
        } as unknown as new (...args: unknown[]) => { dispatch: () => Promise<unknown> },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      expect(capturedOnRestart).toBeDefined();

      // Initial validateProviderBackend call count from bootstrap/reloadConfig
      const initialValidateCount = validateProviderBackendCallCount;

      const newConfig = {
        pollingInterval: 300,
        logRetentionDays: 30,
        taskTimeoutMinutes: 60,
        provider: {
          name: 'claude-code',
          claudePath: '/usr/local/bin/claude',
          allowDangerouslySkipPermissions: false,
          executionBackend: 'container',
        },
        trigger: { maxWastePercentage: 50, weeklyReservePercentage: 30, idleHours: [] },
        tasks: [],
        lastSummaryEnabled: false,
      };
      await capturedOnRestart!(newConfig, ['provider']);

      // validateProviderBackend must have been called once inside onRestartRequired
      expect(validateProviderBackendCallCount).toBe(initialValidateCount + 1);
      // createProvider called for initial + restart
      expect(createProviderCallCount).toBe(2);
    });

    it('concurrent restart guard — skips second call when restart is already in progress (Finding 5)', async () => {
      vi.resetModules();

      let capturedOnRestart: ((config: unknown, fields: string[]) => Promise<void>) | undefined;
      let createProviderCallCount = 0;
      let replaceExecutorCallCount = 0;

      // Slow createProvider to simulate in-progress restart
      let resolveFirstRestart: (() => void) | undefined;
      const firstRestartBlocked = new Promise<void>((resolve) => {
        resolveFirstRestart = resolve;
      });

      setupRunDaemonMocks(dataDir, {
        providersMock: {
          createProvider: async () => {
            createProviderCallCount += 1;
            if (createProviderCallCount === 2) {
              // First restart call: block until we allow it to proceed
              await firstRestartBlocked;
            }
            return {
              usageMonitor: { poll: async () => ({}) },
              taskExecutor: { _type: 'TaskExecutor-' + createProviderCallCount },
            };
          },
          validateProviderBackend: async () => {},
        },
        PollingLoopImpl: class CapturePollingLoop {
          readonly lastPollAt: string | null = null;
          reload() {}
          async start() {}
          async stop() {}
          constructor(deps: {
            onRestartRequired?: (config: unknown, fields: string[]) => Promise<void>;
          }) {
            capturedOnRestart = deps.onRestartRequired;
          }
        } as unknown as new (...args: unknown[]) => {
          readonly lastPollAt: string | null;
          reload: () => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
        },
        DispatcherImpl: class TrackingDispatcher {
          constructor() {}
          async dispatch() {
            return null;
          }
          replaceExecutor() {
            replaceExecutorCallCount += 1;
          }
        } as unknown as new (...args: unknown[]) => { dispatch: () => Promise<unknown> },
      });

      vi.doMock('./state-writer.js', () => ({
        writeDaemonStatus: async () => {},
        writeRunningStatus: async () => {},
        writeRestartingStatus: async () => {},
        writeRestartCompletedStatus: async () => {},
        writeDegradedStatus: async () => {},
        writeStoppingStatus: async () => {},
        writeStoppedStatus: async () => {},
        writeErrorStatus: async () => {},
        writeCycleStatus: async () => {},
        writeUnexpectedExitStatus: async () => {},
        buildLastErrorDetail: (code: string, message: string, recoveryCommand: string | null) => ({
          code,
          message,
          recoveryCommand,
        }),
      }));

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      expect(capturedOnRestart).toBeDefined();

      const newConfig = {
        pollingInterval: 300,
        logRetentionDays: 30,
        taskTimeoutMinutes: 60,
        provider: {
          name: 'claude-code',
          claudePath: '/usr/local/bin/claude',
          allowDangerouslySkipPermissions: false,
          executionBackend: 'container',
        },
        trigger: { maxWastePercentage: 50, weeklyReservePercentage: 30, idleHours: [] },
        tasks: [],
        lastSummaryEnabled: false,
      };

      // Start first restart (will block at createProvider call 2)
      const firstRestart = capturedOnRestart!(newConfig, ['provider']);

      // Immediately fire second restart — should be skipped by the guard
      await capturedOnRestart!(newConfig, ['provider']);

      // Allow first restart to complete
      resolveFirstRestart!();
      await firstRestart;

      // createProvider should have been called exactly twice (initial + 1 restart, not 3)
      // The second concurrent restart call was skipped by the guard
      expect(createProviderCallCount).toBe(2);
      // replaceExecutor should have been called exactly once (from first restart)
      expect(replaceExecutorCallCount).toBe(1);
    });

    it('forwards authManager to createProvider (Finding 6)', async () => {
      vi.resetModules();

      // Capture all calls to createProvider with their arguments
      const createProviderCalls: unknown[][] = [];

      setupRunDaemonMocks(dataDir, {
        providersMock: {
          createProvider: async (...args: unknown[]) => {
            createProviderCalls.push(args);
            return {
              usageMonitor: {
                getSnapshot: async () => ({
                  sessionTokensUsed: 0,
                  sessionTokensTotal: 1000,
                  weeklyTokensUsed: 0,
                  weeklyTokensTotal: 5000,
                  usagePercentage: 0,
                  capturedAt: new Date().toISOString(),
                  source: 'test',
                  confidence: 'high',
                }),
              },
              taskExecutor: { _type: 'TaskExecutor' },
            };
          },
          validateProviderBackend: async () => {},
        },
      });

      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const { runDaemon } = await import('./runner.js');
      await runDaemon();

      // createProvider must have been called at least once during bootstrap
      expect(createProviderCalls.length).toBeGreaterThanOrEqual(1);
      const [, , options] = createProviderCalls[0] as [unknown, unknown, Record<string, unknown>];
      // The third argument must be an object containing authManager (JSONL caps removed in story 15.9)
      expect(options).toMatchObject({
        authManager: expect.objectContaining({ readSubscriptionTier: expect.any(Function) }),
      });
      // Confirm no JSONL cap fields are present
      expect(options).not.toHaveProperty('jsonlSessionTokenCap');
      expect(options).not.toHaveProperty('jsonlWeeklyTokenCap');
    });
  });
});
