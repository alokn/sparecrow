/** Daemon runtime bootstrap — internal entry path for the background daemon child process. */
import { join } from 'node:path';
import { getPaths, ensureDirectories } from '../platform/index.js';
import { logger, enableFileLogging, setLogDir, retryWithBackoff } from '../utils/index.js';
import { loadConfig, CONFIG_FALLBACK } from '../config/index.js';
import { createProvider, validateProviderBackend } from '../providers/index.js';
import { ClaudeCodeAuthManager } from '../providers/claude-code/index.js';
import { TriggerEngine } from '../trigger/index.js';
import { QueueStore, QueueManager } from '../queue/index.js';
import { writePid, removePid, killOrphanDaemons } from './pid-manager.js';
import { PidLock } from './pid-lock.js';
import {
  writeRunningStatus,
  writeRestartingStatus,
  writeRestartCompletedStatus,
  writeDegradedStatus,
  writeDaemonStatus,
  writeUnexpectedExitStatus,
  buildLastErrorDetail,
} from './state-writer.js';
import { PollingLoop, diffConfig } from './polling-loop.js';
import { Dispatcher } from './dispatcher.js';
import { cleanExpiredLogs, cleanExpiredTaskOutputs } from './log-retention.js';
import { registerSignalHandlers, unregisterSignalHandlers } from './signal-handler.js';
import { createConfigWatcher } from '../config/index.js';
import { ScrowError, ErrorCode } from '../errors/index.js';
import type {
  DispatchAdapter,
  DispatchCycleResult,
  ScrowConfig,
  DispatchAdapterOptions,
  DaemonBackendState,
  Provider,
} from '../types/index.js';
import { EventName } from '../types/index.js';
import type { TriggerResult } from '../types/index.js';
import { ContainerBackendWrapper } from '../providers/backends/index.js';

/**
 * Transient filesystem error codes that warrant retrying config load.
 * NOTE: ENOENT is intentionally excluded — loader.ts:28 silently catches ENOENT
 * and returns an empty raw config (falling back to schema defaults), so loadConfig()
 * never throws for ENOENT. Only EACCES and EPERM reach the throw path and are
 * retryable here.
 */
const TRANSIENT_FS_CODES = new Set(['EACCES', 'EPERM']);

/** Guard flag: set to true once bootstrap has run. Prevents recursive respawn. */
let _bootstrapped = false;

/** Returns true when the current process was spawned as the sparecrow daemon runner.
 *  Checks for the --daemon-runner CLI flag in process.argv. */
export function isDaemonRunner(): boolean {
  return process.argv.includes('--daemon-runner');
}

/** Creates a real DispatchAdapter that delegates to Dispatcher.dispatch() when triggered.
 *
 * Note: the polling loop (polling-loop.ts) already guards on `triggerResult.shouldDispatch`
 * before calling this adapter. The guard below is a defensive belt-and-suspenders check so
 * that the adapter is safe to call in isolation (e.g. tests, future callers). Ownership of
 * the primary guard belongs to the polling loop; this adapter's guard is secondary.
 */
export function createDispatchAdapter(dispatcher: Dispatcher): DispatchAdapter {
  return {
    async dispatchIfTriggered(
      triggerResult: TriggerResult,
      options?: DispatchAdapterOptions,
    ): Promise<DispatchCycleResult | null> {
      // Secondary guard — primary check is in polling-loop.ts before this is called.
      if (!triggerResult.shouldDispatch) {
        return null;
      }
      // DispatchAdapterOptions extends DispatchOptions so options is directly compatible.
      // Pass undefined when no options have meaningful values — avoids allocating an empty object
      // that would change dispatch() behaviour (e.g. options?.signal check would get {}.signal).
      if (
        options === undefined ||
        (options.signal === undefined &&
          options.onTaskStart === undefined &&
          options.onTaskComplete === undefined)
      ) {
        return dispatcher.dispatch(undefined);
      }
      return dispatcher.dispatch(options);
    },
  };
}

/** Bootstrap the daemon runtime:
 *  1. Guard against re-entry
 *  2. Ensure required directories exist
 *  3. Write PID file
 *  4. Write initial daemon-status.json
 *  5. Register signal handlers
 *  6. Start polling loop
 *  7. Watch config file for changes
 */
export async function runDaemon(): Promise<void> {
  if (_bootstrapped) {
    void logger.warn('runner.already_bootstrapped', { reason: 'runDaemon called more than once' });
    return;
  }
  _bootstrapped = true;

  // Resolve platform paths first — needed to inject the log directory into the logger.
  const paths = getPaths();
  const dataDir = paths.data;

  // Inject log directory into logger before enabling file logging.
  // This breaks the circular utils↔platform dependency: logger no longer imports platform;
  // instead, the daemon bootstrap (which is allowed to import both) wires them together.
  setLogDir(paths.logs);

  // Create log directory (and other required dirs) before activating file logging.
  // appendFile will silently fail if the directory does not yet exist; creating it first
  // ensures the very first audit write succeeds.
  await ensureDirectories();

  // Enable file-based audit logging after the log directory has been created.
  // The daemon's stderr is routed to /dev/null (stdio: 'ignore' in lifecycle.ts),
  // so file logging is the only persistent output path for the daemon process.
  enableFileLogging();
  // join() here is correct: loadConfig expects a *file* path, unlike QueueStore which expects
  // a *directory* (QueueStore appends 'queue.json' internally). Passing paths.config directly
  // would point loadConfig at the directory, causing a read error.
  const configPath = join(paths.config, 'config.yaml');
  const pid = process.pid;

  void logger.debug('runner.starting', { pid });

  // AC1: Acquire advisory lock before writing PID file.
  // The lock is held for the daemon's lifetime. On crash, the OS closes the
  // file handle and the stale lock is recovered on next startup (AC3).
  const pidLock = new PidLock(dataDir);
  const lockAcquired = await pidLock.acquire(pid);
  if (!lockAcquired) {
    const ownerPid = await pidLock.readOwnerPid();
    void logger.error('runner.lock_contention', {
      pid,
      ownerPid,
      reason: 'Another daemon instance holds the PID lock',
    });
    process.exit(1);
    return;
  }

  // Write PID file so the parent CLI can confirm startup
  await writePid(dataDir, pid);

  // Scan for and kill orphan daemon processes left behind by previous versions (AC1–AC4).
  // Runs after PID write so the new daemon is visible, before polling loop starts.
  // Non-fatal: errors are logged and swallowed (AC2).
  await killOrphanDaemons(pid);

  // Write initial daemon-status.json — must include startedAt for status-state.ts uptime calc
  const startedAt = new Date().toISOString();
  await writeRunningStatus(startedAt, pid);

  void logger.debug('runner.bootstrap_complete', { pid, startedAt });

  // Load config with retry on transient FS errors (Story 14.1 AC1).
  // Falls back to CONFIG_FALLBACK (a fully-typed ScrowConfig) if all retries are exhausted (AC2).
  let config: ScrowConfig;
  try {
    config = await retryWithBackoff(() => loadConfig(configPath), {
      maxRetries: 3,
      baseDelayMs: 100,
      maxDelayMs: 2000,
      retryOn: (error: Error) => {
        // Retry on transient filesystem errors: EACCES, EPERM.
        // loadConfig wraps FS errors in ScrowError(CONFIG_INVALID, msg, cause) —
        // the transient FS code lives on error.cause.code, not error.code.
        // ENOENT is NOT retried — loader.ts silently catches ENOENT and falls
        // back to schema defaults, so loadConfig never throws for ENOENT.
        const cause = error.cause as NodeJS.ErrnoException | undefined;
        if (cause && typeof cause.code === 'string' && TRANSIENT_FS_CODES.has(cause.code)) {
          return true;
        }
        // Also check top-level error.code for raw FS errors not wrapped in ScrowError
        if ('code' in error) {
          const topCode = (error as NodeJS.ErrnoException).code;
          if (typeof topCode === 'string' && TRANSIENT_FS_CODES.has(topCode)) {
            return true;
          }
        }
        return false;
      },
    });
  } catch (err) {
    // AC2: Log warning with fallback field details
    void logger.warn('runner.config_fallback_used', {
      error: err instanceof Error ? err.message : String(err),
      fallbackFields: {
        pollingInterval: CONFIG_FALLBACK.pollingInterval,
        logRetentionDays: CONFIG_FALLBACK.logRetentionDays,
        taskTimeoutMinutes: CONFIG_FALLBACK.taskTimeoutMinutes,
      },
    });
    // Use CONFIG_FALLBACK when config file is unreadable after retries.
    // CONFIG_FALLBACK is a properly typed ScrowConfig constant — no assertion needed.
    config = CONFIG_FALLBACK;
  }

  // Run retention cleanup using configured logRetentionDays (AC6 — non-fatal).
  try {
    await cleanExpiredLogs(paths.logs, config.logRetentionDays);
  } catch (err) {
    void logger.warn('runner.retention_cleanup_failed', {
      target: 'logs',
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    await cleanExpiredTaskOutputs(paths.taskOutputs, config.logRetentionDays);
  } catch (err) {
    void logger.warn('runner.retention_cleanup_failed', {
      target: 'task-outputs',
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Read subscription tier from credentials.
  // The same authManager instance is reused by createProvider to avoid duplicate instantiation.
  // Declared as `let` so onRestartRequired can replace it when wslMountPrefix changes in config.
  let authManager = new ClaudeCodeAuthManager({ wslMountPrefix: config.wslMountPrefix });
  const subscriptionMeta = await authManager.readSubscriptionTier();
  void logger.debug('runner.subscription_tier_resolved', {
    rateLimitTier: subscriptionMeta.rateLimitTier,
  });

  // Create provider + trigger engine
  let provider: Provider;
  try {
    provider = await createProvider(config.provider.name, config.provider, {
      authManager,
    });
  } catch (err) {
    const providerInitErrMsg = err instanceof Error ? err.message : String(err);
    void logger.error('runner.provider_init_failed', {
      error: providerInitErrMsg,
      errorCode: err instanceof ScrowError ? err.code : undefined,
    });
    await writeDaemonStatus({
      state: 'stopped',
      startedAt,
      lastPollAt: null,
      nextPollAt: null,
      usage: null,
      trigger: null,
      activeTask: null,
      lastError: providerInitErrMsg,
      lastErrorDetail: buildLastErrorDetail(
        err instanceof ScrowError ? err.code : ErrorCode.PROVIDER_NOT_FOUND,
        providerInitErrMsg,
        'sparecrow doctor',
      ),
      updatedAt: new Date().toISOString(),
      lastDispatchAt: null,
      cycleResult: null,
      queueDepth: 0,
      pid: null,
      backendState: null,
    });
    await removePid(dataDir);
    // Release advisory lock before exiting — prevents stale lock blocking next startup.
    try {
      await pidLock.release();
    } catch (lockErr) {
      void logger.error('runner.provider_init_lock_release_failed', {
        error: lockErr instanceof Error ? lockErr.message : String(lockErr),
      });
    }
    process.exit(1);
    return;
  }

  // Extract backend state callback for polling loop (AC5, Task 7.4)
  const getBackendState = async (): Promise<DaemonBackendState | null> => {
    if (provider.backend && 'getBackendState' in provider.backend) {
      return (provider.backend as ContainerBackendWrapper).getBackendState();
    }
    return null;
  };

  // Fresh availability probe callback for pre-dispatch gate.
  // Calls ContainerBackendWrapper.available() directly so that:
  // (a) resetAvailabilityCache() is triggered → fresh runtime probe each cycle (AC1)
  // (b) returns the actual container runtime availability status (AC2)
  const checkBackendAvailable = async (): Promise<boolean> => {
    if (provider.backend) {
      return provider.backend.available();
    }
    return false; // no backend means not available
  };

  const triggerEngine = new TriggerEngine();

  // Build the real dispatch adapter — wires QueueManager + TaskExecutor into Dispatcher
  const queueStore = new QueueStore(paths.data);
  const queueManager = new QueueManager(queueStore);
  const dispatcher = new Dispatcher({
    queueManager,
    taskExecutor: provider.taskExecutor,
  });
  const dispatchAdapter = createDispatchAdapter(dispatcher);

  // Mutable config ref for reload
  let currentConfig = config;

  // Guard flag: prevents concurrent in-process restarts when rapid config changes are detected.
  // onRestartRequired is invoked via fire-and-forget from polling-loop.ts; without this guard,
  // two rapid config file changes could trigger concurrent createProvider() executions and
  // racing dispatcher.replaceExecutor() calls.
  let _restartInProgress = false;

  // Provider self-restart callback (Story 10.4, AC1–AC7).
  // Invoked by PollingLoop.reload() when restart-required provider fields change.
  // Runs between dispatch cycles so _dispatching is always false — safe to swap executor.
  async function onRestartRequired(newConfig: ScrowConfig, changedFields: string[]): Promise<void> {
    // NOTE: DAEMON_CONFIG_RESTART_INITIATED is already emitted by polling-loop.ts before
    // invoking this callback — do NOT emit it here to avoid duplicate audit log entries.

    // Concurrency guard: skip if a restart is already in progress.
    if (_restartInProgress) {
      void logger.warn('runner.restart_already_in_progress', {
        fields: changedFields,
        note: 'Skipping concurrent restart request — a restart is already in progress.',
      });
      return;
    }
    _restartInProgress = true;

    try {
      // AC4: Write restarting status during transition
      try {
        await writeRestartingStatus(startedAt, pid);
      } catch (writeErr) {
        void logger.error('runner.restart_status_write_failed', {
          error: writeErr instanceof Error ? writeErr.message : String(writeErr),
        });
      }

      // Pre-check backend availability before constructing the full provider bundle.
      // This mirrors the guard in reloadConfig() so that an unavailable container runtime
      // is caught here rather than surfacing a cryptic createProvider() failure (AC6 path).
      await validateProviderBackend(newConfig.provider.name, newConfig.provider);

      // Propagate updated wslMountPrefix to authManager so that a live config change to
      // wsl_mount_prefix is not silently ignored for the lifetime of the daemon process.
      if (newConfig.wslMountPrefix !== currentConfig.wslMountPrefix) {
        authManager = new ClaudeCodeAuthManager({ wslMountPrefix: newConfig.wslMountPrefix });
        void logger.debug('runner.auth_manager_recreated', {
          wslMountPrefix: newConfig.wslMountPrefix,
        });
      }

      const newProvider = await createProvider(newConfig.provider.name, newConfig.provider, {
        authManager,
      });

      // Swap the executor in the existing dispatcher (safe — between dispatch cycles)
      dispatcher.replaceExecutor(newProvider.taskExecutor);

      // Update the mutable provider reference so getBackendState/checkBackendAvailable
      // closures use the new backend.
      provider = newProvider;
      // Update currentConfig here (deferred from reloadConfig) now that the provider
      // is successfully reconstructed — avoids split state on AC6 (failed restart) path.
      currentConfig = newConfig;

      void logger.info(EventName.DAEMON_CONFIG_RESTART_COMPLETED, {
        fields: changedFields,
        provider: newConfig.provider.name,
      });

      // AC4: Restore running status after successful restart.
      // Uses writeRestartCompletedStatus (not writeRunningStatus) to preserve live cycle
      // metrics accumulated before the restart — avoids wiping lastPollAt, queueDepth, etc.
      await writeRestartCompletedStatus(startedAt, pid);
    } catch (err) {
      // AC6: Failed provider reconstruction — preserve last-known-good provider and continue.
      const msg = err instanceof Error ? err.message : String(err);
      void logger.error(EventName.DAEMON_CONFIG_RESTART_FAILED, {
        error: msg,
        errorCode: err instanceof ScrowError ? err.code : undefined,
        note: 'Falling back to previous provider config. Daemon continues running.',
      });

      // Write degraded status with the error (daemon continues running)
      try {
        await writeDegradedStatus(
          startedAt,
          `Provider restart failed: ${msg}`,
          buildLastErrorDetail(
            err instanceof ScrowError ? err.code : ErrorCode.PROVIDER_NOT_FOUND,
            `Provider restart failed: ${msg}`,
            'sparecrow config validate',
          ),
        );
      } catch (writeErr) {
        void logger.error('runner.restart_degraded_status_write_failed', {
          error: writeErr instanceof Error ? writeErr.message : String(writeErr),
        });
      }
    } finally {
      // Always clear the flag so subsequent restarts are allowed after this one completes.
      _restartInProgress = false;
    }
  }

  // Reset any stale in-progress tasks left over from a previous crash.
  // Runs after QueueManager is instantiated and before PollingLoop starts.
  // Non-fatal: errors are caught, logged at warn, and startup continues.
  try {
    const resetCount = await queueManager.resetInProgressTasks();
    if (resetCount > 0) {
      void logger.warn('runner.reset_stale_in_progress', { count: resetCount });
    }
  } catch (err) {
    void logger.warn('runner.reset_stale_in_progress_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const loop = new PollingLoop({
    usageMonitor: provider.usageMonitor,
    triggerEngine,
    dispatchAdapter,
    getConfig: () => currentConfig,
    // Queue depth is the total remaining workload — dispatchable tasks (pending / failed_quota)
    // plus any actively-executing (in-progress) tasks. countWorkload() acquires the serial lock
    // once to avoid a TOCTOU window between two separate lock acquisitions.
    getQueueDepth: async () => queueManager.countWorkload(),
    startedAt,
    pid,
    subscriptionTier: subscriptionMeta.rateLimitTier,
    getBackendState,
    checkBackendAvailable,
    onRestartRequired,
  });

  // Config reload callback (shared by SIGHUP and file watcher)
  // AC5: On corrupt/invalid config reload, preserve last-known-good config and surface warning.
  // H1 fix: re-apply the fail-fast backend guard on reload so that a hot switch to an
  // unsupported backend ('container') is caught here, not silently accepted.
  // Uses validateProviderBackend() rather than the full createProvider() to avoid wastefully
  // constructing ClaudeCodeAuthManager, ClaudeCodeUsageMonitor, and
  // ClaudeCodeTaskExecutor on every config reload — only the backend availability is checked.
  async function reloadConfig(): Promise<void> {
    try {
      // Apply the same transient-FS retry logic used at startup (Story 14.1).
      // A momentary EACCES/EPERM during hot-reload (SIGHUP or file-watcher event) should
      // be retried rather than immediately falling through to config_reload_preserved.
      const newConfig = await retryWithBackoff(() => loadConfig(configPath), {
        maxRetries: 3,
        baseDelayMs: 100,
        maxDelayMs: 2000,
        retryOn: (error: Error) => {
          const cause = error.cause as NodeJS.ErrnoException | undefined;
          if (cause && typeof cause.code === 'string' && TRANSIENT_FS_CODES.has(cause.code)) {
            return true;
          }
          if ('code' in error) {
            const topCode = (error as NodeJS.ErrnoException).code;
            if (typeof topCode === 'string' && TRANSIENT_FS_CODES.has(topCode)) {
              return true;
            }
          }
          return false;
        },
      });
      // Validate the new backend availability without constructing the full provider.
      // Throws CONTAINER_RUNTIME_NOT_FOUND if the container runtime is unavailable.
      await validateProviderBackend(newConfig.provider.name, newConfig.provider);
      const oldConfig = currentConfig;
      // Only update currentConfig immediately for hot-apply-safe changes.
      // When restart-required fields change, defer the update to onRestartRequired —
      // updating eagerly here would leave currentConfig holding the new config while the
      // running provider still uses the old one if createProvider() fails (AC6 path).
      const { restartRequiredKeys } = diffConfig(oldConfig, newConfig);
      if (restartRequiredKeys.length === 0) {
        currentConfig = newConfig;
      }
      // Always reload the loop — it handles restart-required vs hot-apply internally
      // and invokes onRestartRequired when needed (which will update currentConfig on success).
      loop.reload(newConfig);
      void logger.debug('runner.config_reloaded', {
        oldPollingInterval: oldConfig.pollingInterval,
        newPollingInterval: newConfig.pollingInterval,
      });
    } catch (err) {
      // Preserve last-known-good config — do NOT update currentConfig or reload the loop.
      const msg = err instanceof Error ? err.message : String(err);
      void logger.warn('runner.config_reload_preserved', {
        error: msg,
        note: 'Daemon continues with last valid configuration. Fix config file and reload again.',
        recoveryCommand: 'sparecrow config validate',
        errorCode: ErrorCode.CONFIG_RELOAD_PRESERVED,
      });
      // Write a degraded status update surfacing the config reload warning for `sparecrow status`.
      // Daemon continues running — use writeDegradedStatus to preserve state:'running'.
      try {
        await writeDegradedStatus(
          startedAt,
          msg,
          buildLastErrorDetail(
            ErrorCode.CONFIG_RELOAD_PRESERVED,
            'Config reload failed — daemon continues with last valid configuration.',
            'sparecrow config validate',
          ),
        );
      } catch (writeErr) {
        void logger.error('runner.config_reload_status_write_failed', {
          error: writeErr instanceof Error ? writeErr.message : String(writeErr),
        });
      }
    }
  }

  // AC4: Top-level runtime exception containment.
  // These handlers act as safety nets for unexpected exceptions that escape cycle boundaries.
  // They write diagnostic logs and sanitized daemon status, then allow the loop to continue.
  // Stack traces are logged but NEVER exposed in user-facing daemon-status.json output.
  const uncaughtHandler = (err: unknown): void => {
    const msg = err instanceof Error ? err.message : String(err);
    void logger.error('runner.uncaught_exception', {
      error: msg,
      // Stack is written to structured log only — not persisted to daemon-status.json
      stack: err instanceof Error ? (err.stack ?? '(no stack)') : '(no stack)',
      errorCode: ErrorCode.TASK_EXECUTION_FAILED,
    });
    // Write sanitized (no stack) degraded status — daemon continues running, state remains 'running'.
    void writeDegradedStatus(
      startedAt,
      `Uncaught exception: ${msg}`,
      buildLastErrorDetail(
        ErrorCode.TASK_EXECUTION_FAILED,
        `Daemon encountered an unexpected error: ${msg}`,
        'sparecrow doctor',
      ),
    ).catch((writeErr: unknown) => {
      void logger.error('runner.uncaught_exception_status_write_failed', {
        error: writeErr instanceof Error ? writeErr.message : String(writeErr),
      });
    });
    // Do NOT call process.exit — allow the polling loop to continue.
  };

  const unhandledRejectionHandler = (reason: unknown): void => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? (reason.stack ?? '(no stack)') : '(no stack)';
    void logger.error('runner.unhandled_rejection', {
      error: msg,
      // Stack is written to structured log only — not persisted to daemon-status.json
      stack,
      errorCode: ErrorCode.TASK_EXECUTION_FAILED,
    });
    // Write sanitized (no stack) degraded status — daemon continues running, state remains 'running'.
    void writeDegradedStatus(
      startedAt,
      `Unhandled promise rejection: ${msg}`,
      buildLastErrorDetail(
        ErrorCode.TASK_EXECUTION_FAILED,
        `Daemon encountered an unhandled promise rejection: ${msg}`,
        'sparecrow doctor',
      ),
    ).catch((writeErr: unknown) => {
      void logger.error('runner.unhandled_rejection_status_write_failed', {
        error: writeErr instanceof Error ? writeErr.message : String(writeErr),
      });
    });
    // Do NOT call process.exit — allow the polling loop to continue.
  };

  process.on('uncaughtException', uncaughtHandler);
  process.on('unhandledRejection', unhandledRejectionHandler);

  // AbortController used to signal that the clean-shutdown path (via signal handler) has
  // completed. When aborted, the unexpected-exit path below must not run — the signal handler
  // has already written stopped status and called process.exit(0). Using an AbortController
  // instead of a boolean flag ensures that any future code that awaits between setting and
  // checking the flag will still observe the correct state, avoiding the race condition that
  // arises with mutable boolean flags in async code.
  const cleanShutdownController = new AbortController();

  // Register signal handlers
  registerSignalHandlers({
    dataDir,
    startedAt,
    pollingLoop: loop,
    onReload: reloadConfig,
    onShutdownComplete: () => {
      cleanShutdownController.abort();
      // Release PID advisory lock on clean shutdown — fire-and-forget since we're exiting.
      void pidLock.release();
      process.removeListener('uncaughtException', uncaughtHandler);
      process.removeListener('unhandledRejection', unhandledRejectionHandler);
      unregisterSignalHandlers();
      process.exit(0);
    },
  });

  // Start config file watcher
  const watcher = createConfigWatcher(configPath, reloadConfig);

  // Start polling loop (blocking until stopped by signal or fatal error).
  // Captures rejection error (if any) for inclusion in the stopped-status write.
  let loopExitError: Error | null = null;
  try {
    await loop.start();
  } catch (loopErr) {
    loopExitError = loopErr instanceof Error ? loopErr : new Error(String(loopErr));
  } finally {
    watcher.close();
  }

  // If the clean-shutdown path already ran (signal handler completed), nothing more to do.
  if (cleanShutdownController.signal.aborted) {
    return;
  }

  // Unexpected loop exit — the polling loop exited without a clean signal-based shutdown.
  // Emit structured audit event, write stopped status, clean up PID, and exit with code 1
  // so service managers (systemd/launchd) can auto-restart.
  const exitReason = loopExitError !== null ? loopExitError.message : 'loop exited without signal';
  const uptimeMs = Date.now() - new Date(startedAt).getTime();
  const lastPollAtFromLoop = loop.lastPollAt;

  // Await the logger write directly so the audit trail is flushed before process.exit(1).
  await logger.error('runner.loop_exited_unexpectedly', {
    reason: exitReason,
    lastPollAt: lastPollAtFromLoop,
    uptime: uptimeMs,
  });

  try {
    const lastError =
      loopExitError !== null
        ? loopExitError.message
        : 'Polling loop exited unexpectedly without a signal-based shutdown.';
    const lastErrorDetail = buildLastErrorDetail(
      ErrorCode.DAEMON_LOOP_EXITED,
      lastError,
      'sparecrow daemon restart',
    );
    // Story 14.3: Preserve last-known usage data on unexpected exit.
    // writeUnexpectedExitStatus reads the existing daemon-status.json and preserves
    // accumulated metrics (usage, trigger, lastDispatchAt, cycleResult, queueDepth,
    // backendState) from the last successful cycle. Falls back to nulls if the file
    // is missing or corrupted (AC2).
    await writeUnexpectedExitStatus(startedAt, lastPollAtFromLoop, lastError, lastErrorDetail);
  } catch (writeErr) {
    void logger.error('runner.loop_exit_status_write_failed', {
      error: writeErr instanceof Error ? writeErr.message : String(writeErr),
    });
  }

  try {
    await removePid(dataDir);
  } catch (pidErr) {
    void logger.error('runner.loop_exit_pid_remove_failed', {
      error: pidErr instanceof Error ? pidErr.message : String(pidErr),
    });
  }

  // Release PID advisory lock on unexpected exit
  try {
    await pidLock.release();
  } catch (lockErr) {
    void logger.error('runner.loop_exit_lock_release_failed', {
      error: lockErr instanceof Error ? lockErr.message : String(lockErr),
    });
  }

  process.removeListener('uncaughtException', uncaughtHandler);
  process.removeListener('unhandledRejection', unhandledRejectionHandler);
  unregisterSignalHandlers();

  process.exit(1);
}
