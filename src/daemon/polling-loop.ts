/** Daemon polling loop — poll -> evaluate -> dispatch -> state write -> sleep cycle. */
import { setTimeout as sleep } from 'node:timers/promises';
import type {
  UsageMonitor,
  CapacitySnapshot,
  TriggerResult,
  DispatchAdapter,
  DaemonUsageState,
  DaemonTriggerState,
  DaemonActiveTaskState,
  DaemonLastError,
  DaemonBackendState,
  DispatchCycleResult,
  ScrowConfig,
  TaskDefinition,
  TaskResult,
} from '../types/index.js';
import { EventName } from '../types/index.js';
import type { TriggerEngine } from '../trigger/index.js';
import { ScrowError, ErrorCode } from '../errors/index.js';
import { logger, retryWithBackoff } from '../utils/index.js';
import { writeCycleStatus, buildLastErrorDetail } from './state-writer.js';
import { writeSummaryFile } from './summary-writer.js';
import { writeTaskOutput } from './task-output-writer.js';
import { PartialOutputWriter } from './partial-output-writer.js';
import { writeResultArtifact } from '../queue/index.js';
import { getPaths } from '../platform/index.js';
import { ACTIVE_TEMPLATE_NAMES, extractBranchFromStdout } from '../templates/index.js';
import { runActionPipeline } from './action-pipeline.js';

/** Config fields that cannot be hot-applied — require daemon restart.
 *
 * NOTE: `auth.*` / credential paths are also restart-required per spec, but the current
 * `ScrowConfig` type has no explicit top-level `auth` field. When auth configuration is added,
 * its keys must be added here to prevent silent hot-apply of security-sensitive changes.
 * The `diffConfig` function also performs a catch-all check on any unclassified top-level
 * changes and routes them to `hotApply` (conservative default), so new fields will be
 * hot-applied until explicitly listed here. Reviewers adding auth fields should update this
 * list before merging.
 */
export const RESTART_REQUIRED_KEYS: readonly string[] = [
  'provider',
  'provider.name',
  'provider.claudePath',
  'provider.allowDangerouslySkipPermissions',
  // auth.* fields are restart-required but not yet present in ScrowConfig — add here when introduced
];

/** Hot-apply safe config fields.
 *
 * These keys are explicitly checked in diffConfig() to classify new top-level fields
 * consistently: any field listed here is routed to hotApply rather than falling through
 * to the conservative default. New fields added to ScrowConfig should be listed in EITHER
 * HOT_APPLY_KEYS (safe to hot-apply) or RESTART_REQUIRED_KEYS (requires restart) to
 * prevent silent documentation/implementation drift.
 */
export const HOT_APPLY_KEYS: readonly string[] = [
  'pollingInterval',
  'trigger',
  'tasks',
  'logRetentionDays',
  'lastSummaryEnabled',
];

/** Dependencies injected into PollingLoop. */
export interface PollingLoopDeps {
  usageMonitor: UsageMonitor;
  triggerEngine: TriggerEngine;
  dispatchAdapter: DispatchAdapter;
  getConfig: () => ScrowConfig;
  startedAt: string;
  /**
   * Returns the current pending queue depth for status writes.
   * Optional — defaults to async () => 0 when not provided.
   * Story 3.6 will inject the real implementation; the no-op stub preserves correctness today.
   */
  getQueueDepth?: () => Promise<number>;
  /**
   * PID of the daemon process to preserve in cycle status writes.
   * Optional — defaults to process.pid when not provided.
   */
  pid?: number | null;
  /**
   * Detected subscription tier (rateLimitTier) from credentials.
   * Populated at daemon startup; written to daemon-status.json usage.subscriptionTier.
   * Optional — defaults to null when not provided (AC5).
   */
  subscriptionTier?: string | null;
  /**
   * Returns the current backend state for status writes.
   * Optional — defaults to async () => null when not provided (backward compatibility).
   */
  getBackendState?: () => Promise<DaemonBackendState | null>;
  /**
   * Performs a fresh availability probe of the execution backend and returns whether
   * dispatch should proceed. Calls ContainerBackendWrapper.available() directly so
   * that the runtime detection cache is invalidated before each cycle (AC1).
   * Optional -- when not provided, dispatch proceeds unconditionally (backward compat).
   */
  checkBackendAvailable?: () => Promise<boolean>;
  /**
   * Callback invoked when a config reload detects restart-required provider changes.
   * The runner implements this to reconstruct the provider bundle with the new config.
   * When not provided, the loop falls back to the legacy behavior of logging a warning
   * and keeping old values (backward compatibility).
   */
  onRestartRequired?: (newConfig: ScrowConfig, changedFields: string[]) => Promise<void>;
}

/** Builds a DaemonUsageState from a CapacitySnapshot for status writes. */
export function buildUsageState(
  snapshot: CapacitySnapshot,
  degradedReason?: string | null,
  subscriptionTier?: string | null,
): DaemonUsageState {
  // Rate windows contain the 5-hour session; take the first one if present.
  const sessionWindow = snapshot.rateWindows.length > 0 ? snapshot.rateWindows[0] : null;

  // Prefer an aggregate weekly window (no `.model` field) over per-model windows.
  // Multi-model subscriptions (e.g. Max 5x) may return only per-model `seven_day_*` windows
  // when the base `seven_day` key is null; `parseWeeklyBuckets()` synthesises an aggregate in
  // that case. This find() prefers a window without a model tag so the status display and
  // `daemon-status.json` reflect overall subscription utilisation, not a single model's usage.
  // Falls back to first budget window if no aggregate is found (defensive).
  const weeklyWindowAggregate = snapshot.budgetWindows.find((w) => !w.model);
  const weeklyWindow = weeklyWindowAggregate ?? snapshot.budgetWindows[0] ?? null;

  const isDegraded = snapshot.source === 'stale' || degradedReason != null;

  return {
    sessionUtilization: sessionWindow?.utilization ?? null,
    weeklyUtilization: weeklyWindow?.utilization ?? null,
    sessionResetsAt: sessionWindow?.resetsAt?.toISOString() ?? null,
    weeklyResetsAt: weeklyWindow?.resetsAt?.toISOString() ?? null,
    source: snapshot.source,
    confidence: snapshot.confidence,
    subscriptionTier: subscriptionTier ?? null,
    degradedReason: isDegraded
      ? (degradedReason ?? `operating on ${snapshot.source} source`)
      : null,
  };
}

/** Builds a structured DaemonLastError for auth expiry failures. */
function buildAuthErrorDetail(): DaemonLastError {
  return buildLastErrorDetail(
    ErrorCode.DAEMON_AUTH_FAILED,
    'OAuth token refresh failed. Daemon is operating in degraded mode.',
    'sparecrow config --reconnect',
  );
}

/** Builds a DaemonTriggerState from a TriggerResult. */
export function buildTriggerState(result: TriggerResult): DaemonTriggerState {
  return {
    shouldDispatch: result.shouldDispatch,
    reason: result.reason,
    evaluatedAt: result.evaluatedAt.toISOString(),
    snapshotSource: result.snapshotSource,
    wastePotential: result.wastePotential,
    effectiveReserve: result.effectiveReserve,
    availableBudget: result.availableBudget,
    isIdleHours: result.isIdleHours,
    rateHeadroom: result.rateHeadroom,
    perModelWaste: result.perModelWaste,
  };
}

/** Computes the next poll time and compensated sleep duration based on wall-clock time.
 *
 *  After a long dispatch cycle, `cycleStart + intervalMs` may be in the past.
 *  This helper uses `Date.now()` to compute a wall-clock-accurate `nextPollAt`
 *  and reduces the sleep duration by the time already elapsed during the cycle.
 *  If the cycle took longer than `intervalMs`, sleepMs is clamped to 0. */
export function computeNextPollAt(
  cycleStart: Date,
  intervalMs: number,
): { nextPollAt: string; sleepMs: number } {
  const now = Date.now();
  const elapsed = now - cycleStart.getTime();
  const sleepMs = Math.max(0, intervalMs - elapsed);
  const nextPollAt = new Date(now + sleepMs).toISOString();
  return { nextPollAt, sleepMs };
}

/** Computes an informational nextPollAt estimate for mid-cycle status writes.
 *  Uses `now() + intervalMs` since these are rough estimates shown during active dispatch. */
function computeMidCycleNextPollAt(intervalMs: number): string {
  return new Date(Date.now() + intervalMs).toISOString();
}

/** Returns true if this is an AbortError thrown by timers/promises or AbortController. */
function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === 'AbortError' ||
    (err as NodeJS.ErrnoException).code === 'ABORT_ERR' ||
    ('cause' in err && (err as { cause?: unknown }).cause instanceof DOMException)
  );
}

/** Computes restart-required vs hot-apply delta between two configs. */
export function diffConfig(
  oldConfig: ScrowConfig,
  newConfig: ScrowConfig,
): { restartRequiredKeys: string[]; hotApplyKeys: string[] } {
  const restartRequired: string[] = [];
  const hotApply: string[] = [];

  // Check top-level scalar fields.
  // Uses both HOT_APPLY_KEYS and RESTART_REQUIRED_KEYS to classify changes explicitly,
  // so that HOT_APPLY_KEYS stays the authoritative documentation of hot-apply-safe fields
  // rather than being a passive comment. New fields added to either constant are automatically
  // classified; unrecognised fields fall back to hotApply (conservative default).
  const checkKey = (key: string, oldVal: unknown, newVal: unknown): void => {
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      if (RESTART_REQUIRED_KEYS.includes(key)) {
        restartRequired.push(key);
      } else if (HOT_APPLY_KEYS.includes(key)) {
        hotApply.push(key);
      } else {
        // Unknown key — conservative default: treat as hot-apply.
        // Reviewers should classify new fields in HOT_APPLY_KEYS or RESTART_REQUIRED_KEYS.
        hotApply.push(key);
      }
    }
  };

  checkKey('pollingInterval', oldConfig.pollingInterval, newConfig.pollingInterval);
  checkKey('logRetentionDays', oldConfig.logRetentionDays, newConfig.logRetentionDays);
  checkKey('lastSummaryEnabled', oldConfig.lastSummaryEnabled, newConfig.lastSummaryEnabled);

  // Provider sub-fields
  if (JSON.stringify(oldConfig.provider) !== JSON.stringify(newConfig.provider)) {
    restartRequired.push('provider');
  }

  // Trigger — routed through checkKey() for consistent classification
  checkKey('trigger', oldConfig.trigger, newConfig.trigger);

  // Tasks — routed through checkKey() for consistent classification
  checkKey('tasks', oldConfig.tasks, newConfig.tasks);

  return { restartRequiredKeys: restartRequired, hotApplyKeys: hotApply };
}

/** Daemon polling loop. Runs poll -> evaluate -> dispatch -> state write -> sleep cycles. */
export class PollingLoop {
  private _running = false;
  private _stopController: AbortController | null = null;
  private _loopPromise: Promise<void> | null = null;
  private readonly _deps: PollingLoopDeps;
  private _config: ScrowConfig;
  /** ISO 8601 timestamp of the last completed poll cycle, or null if no cycle has completed. */
  private _lastPollAt: string | null = null;

  /** Per-sleep AbortController — aborted by reload() to interrupt the active sleep
   *  when the polling interval decreases. Separate from _stopController which is for
   *  daemon shutdown. null when not sleeping. */
  private _sleepController: AbortController | null = null;
  /** Set to true by reload() before aborting _sleepController. Checked in the sleep loop
   *  to distinguish reload-triggered interrupts from daemon shutdown aborts (AC1/AC3). */
  private _reloadInterruptPending = false;
  /** Interval values stored by reload() so _runLoop can emit the sleep-rescheduled audit
   *  event with the authoritative remainingMs computed after abort propagation. */
  private _reloadEventData: { oldIntervalMs: number; newIntervalMs: number } | null = null;

  /** Returns the timestamp of the last completed poll cycle, or null if no cycle has run. */
  get lastPollAt(): string | null {
    return this._lastPollAt;
  }

  constructor(deps: PollingLoopDeps) {
    this._deps = deps;
    this._config = deps.getConfig();
  }

  /** Start the polling loop. Resolves when loop exits (after stop() or fatal error). */
  start(): Promise<void> {
    if (this._running) {
      void logger.warn('polling-loop.already-running', {});
      return this._loopPromise ?? Promise.resolve();
    }
    this._running = true;
    this._stopController = new AbortController();
    this._loopPromise = this._runLoop(this._stopController.signal);
    return this._loopPromise;
  }

  /** Request graceful stop. Returns a promise that resolves when the loop exits. */
  stop(): Promise<void> {
    if (!this._running || this._stopController === null) {
      return Promise.resolve();
    }
    void logger.debug('polling-loop.stop-requested', {});
    this._stopController.abort();
    return this._loopPromise ?? Promise.resolve();
  }

  /** Update the config reference atomically. Next cycle picks up new values.
   *  When restart-required fields change and an onRestartRequired callback is provided,
   *  the callback is invoked asynchronously to reconstruct the provider bundle.
   *  The config is applied immediately (including provider fields) — the callback is
   *  responsible for swapping the executor/backend references. */
  reload(newConfig: ScrowConfig): void {
    const oldConfig = this._config;
    const { restartRequiredKeys, hotApplyKeys } = diffConfig(oldConfig, newConfig);

    if (restartRequiredKeys.length > 0) {
      const onRestart = this._deps.onRestartRequired;
      if (onRestart) {
        // Apply the full new config immediately — the restart callback will reconstruct
        // provider objects to match. This avoids the stale-config problem where the loop
        // keeps old provider values indefinitely.
        this._config = newConfig;
        void logger.info(EventName.DAEMON_CONFIG_RESTART_INITIATED, {
          fields: restartRequiredKeys,
          note: 'Provider config changed — initiating in-process restart.',
        });
        // Fire-and-forget: the callback runs between dispatch cycles (safe by design).
        // Errors are handled by the callback itself (runner logs + falls back to old provider).
        void onRestart(newConfig, restartRequiredKeys);
      } else {
        // Legacy fallback when no restart callback is provided (backward compatibility).
        void logger.warn('polling-loop.reload-restart-required', {
          fields: restartRequiredKeys,
          note: 'These changes require a daemon restart. Running with previous values.',
        });
        const partial: ScrowConfig = {
          ...newConfig,
          provider: oldConfig.provider,
        };
        this._config = partial;
      }
    } else {
      this._config = newConfig;
    }

    if (hotApplyKeys.length > 0) {
      void logger.debug('polling-loop.reload-hot-applied', { fields: hotApplyKeys });
    }

    // AC1: Interrupt the active inter-cycle sleep when the polling interval decreases.
    // When the new interval is shorter than the old one and we are currently sleeping,
    // abort the sleep so _runLoop can reschedule with the correct remaining time.
    // AC2: When the interval increases or stays the same, do nothing — the current
    // sleep continues and the new interval takes effect on the next cycle.
    const oldIntervalMs = oldConfig.pollingInterval * 1000;
    const newIntervalMs = newConfig.pollingInterval * 1000;
    if (newIntervalMs < oldIntervalMs && this._sleepController !== null) {
      // Store interval data so _runLoop can emit the sleep-rescheduled event with the
      // authoritative remainingMs — computed after abort propagation, not here.
      this._reloadEventData = { oldIntervalMs, newIntervalMs };
      // Set the flag BEFORE aborting so the sleep loop can distinguish reload from stop.
      this._reloadInterruptPending = true;
      this._sleepController.abort();
    }
  }

  private async _runLoop(stopSignal: AbortSignal): Promise<void> {
    const { usageMonitor, triggerEngine, dispatchAdapter } = this._deps;
    const getQueueDepth = this._deps.getQueueDepth ?? (async () => 0);
    const startedAt = this._deps.startedAt;
    // Preserve pid across cycle status writes so it is not overwritten with null after bootstrap.
    const daemonPid = this._deps.pid ?? process.pid;
    // Preserve subscription tier for status writes (AC5).
    const subscriptionTier = this._deps.subscriptionTier ?? null;
    const getBackendState = this._deps.getBackendState;
    // Fresh availability probe — calls ContainerBackendWrapper.available() directly so the
    // runtime detection cache is invalidated before each dispatch cycle.
    const checkBackendAvailable = this._deps.checkBackendAvailable;

    void logger.debug('polling-loop.started', { startedAt });

    try {
      while (!stopSignal.aborted) {
        const config = this._config;
        const intervalMs = config.pollingInterval * 1000;
        const conditions = config.trigger;

        const cycleStart = new Date();
        let usageState: DaemonUsageState | null = null;
        let triggerState: DaemonTriggerState | null = null;
        let activeTaskState: DaemonActiveTaskState | null = null;
        let lastError: string | null = null;
        let lastErrorDetail: DaemonLastError | null = null;
        let lastDispatchAt: string | null = null;
        let cycleResult: DispatchCycleResult | null = null;
        // Hoisted so all code paths (poll-failure, trigger-failure, normal) can include
        // backendState in writeCycleStatus() calls. getBackendState() is self-probing
        // so calling it on any path will yield an accurate result (AC3, Story 14.4).
        let backendState: DaemonBackendState | null = null;
        // Hoisted so that the sleep step (outside the inner try block) can reuse the same
        // nextPollAt and sleepMs values that were written to daemon-status.json, ensuring
        // the displayed next-poll time and the actual sleep duration are always consistent.
        let endCycleNextPollAt = '';
        let compensatedSleepMs = intervalMs;

        // Create per-cycle abort controller to propagate shutdown into dispatch
        const cycleController = new AbortController();
        const cancelCycle = (): void => {
          cycleController.abort();
        };
        stopSignal.addEventListener('abort', cancelCycle, { once: true });

        try {
          // 1. Poll usage
          let snapshot: CapacitySnapshot;
          try {
            // Use the default retryWithBackoff predicate (retries transient non-ScrowError failures,
            // skips retrying ScrowError instances — which have already been classified by the provider).
            // The previous custom predicate `(err) => !(err instanceof ScrowError)` was inverted:
            // it retried JS bugs and skipped retrying actual transient provider errors.
            snapshot = await retryWithBackoff(() => usageMonitor.poll(), {
              maxRetries: 3,
              baseDelayMs: 2000,
            });
            usageState = buildUsageState(snapshot, null, subscriptionTier);
            // Emit usage.polled audit log so utilization history accumulates in the audit log files (JSONL format) for report window queries
            void logger.info(EventName.USAGE_POLLED, {
              weeklyUtilization: usageState?.weeklyUtilization ?? null,
              sessionUtilization: usageState?.sessionUtilization ?? null,
              source: snapshot.source,
              confidence: snapshot.confidence,
            });
          } catch (pollErr) {
            // Wrap in a typed ScrowError so daemon runtime failures carry typed error codes.
            const msg = pollErr instanceof Error ? pollErr.message : String(pollErr);
            const typedErr =
              pollErr instanceof ScrowError
                ? pollErr
                : new ScrowError(
                    ErrorCode.DAEMON_POLL_FAILED,
                    msg,
                    pollErr instanceof Error ? pollErr : undefined,
                  );
            lastError = typedErr.message;

            // Build structured error detail for auth failures so UI can render recovery hint.
            if (
              typedErr.code === ErrorCode.DAEMON_AUTH_FAILED ||
              typedErr.code === ErrorCode.AUTH_TOKEN_EXPIRED
            ) {
              lastErrorDetail = buildAuthErrorDetail();
              void logger.warn('polling-loop.auth-failed-degraded', {
                error: typedErr.message,
                recoveryCommand: 'sparecrow config --reconnect',
              });
            } else {
              lastErrorDetail = buildLastErrorDetail(typedErr.code, typedErr.message, null);
              void logger.error('polling-loop.poll-failed', { error: typedErr.message });
            }

            const { nextPollAt: pollFailNextPollAt, sleepMs: pollFailSleepMs } = computeNextPollAt(
              cycleStart,
              intervalMs,
            );
            const queueDepth = await getQueueDepth();
            // Fetch backend state for status write — getBackendState() is self-probing
            // so it returns accurate availability even on the poll-failure path (AC3).
            if (getBackendState) {
              try {
                backendState = await getBackendState();
              } catch {
                // Non-fatal: status write proceeds with null backendState
              }
            }
            await writeCycleStatus({
              startedAt,
              lastPollAt: cycleStart.toISOString(),
              nextPollAt: pollFailNextPollAt,
              usage: null,
              trigger: null,
              activeTask: null,
              lastError,
              lastErrorDetail,
              lastDispatchAt: null,
              cycleResult: null,
              queueDepth,
              pid: daemonPid,
              backendState,
            });

            // Sleep before next attempt (abortable), compensated for elapsed time
            if (pollFailSleepMs > 0) {
              try {
                await sleep(pollFailSleepMs, undefined, { signal: stopSignal });
              } catch (sleepErr) {
                if (isAbortError(sleepErr)) {
                  stopSignal.removeEventListener('abort', cancelCycle);
                  break;
                }
              }
            }
            stopSignal.removeEventListener('abort', cancelCycle);
            continue;
          }

          // 2. Evaluate trigger
          let triggerResult: TriggerResult;
          try {
            triggerResult = triggerEngine.evaluate(snapshot, conditions);
            triggerState = buildTriggerState(triggerResult);
          } catch (triggerErr) {
            const msg = triggerErr instanceof Error ? triggerErr.message : String(triggerErr);
            lastError = msg;
            const triggerErrCode =
              triggerErr instanceof ScrowError ? triggerErr.code : ErrorCode.DAEMON_POLL_FAILED;
            lastErrorDetail = buildLastErrorDetail(triggerErrCode, msg, null);
            void logger.error('polling-loop.trigger-failed', { error: msg });

            const { nextPollAt: trigFailNextPollAt, sleepMs: trigFailSleepMs } = computeNextPollAt(
              cycleStart,
              intervalMs,
            );
            const queueDepth = await getQueueDepth();
            // Fetch backend state for status write — getBackendState() is self-probing
            // so it returns accurate availability even on the trigger-failure path (AC3).
            if (getBackendState) {
              try {
                backendState = await getBackendState();
              } catch {
                // Non-fatal: status write proceeds with null backendState
              }
            }
            await writeCycleStatus({
              startedAt,
              lastPollAt: cycleStart.toISOString(),
              nextPollAt: trigFailNextPollAt,
              usage: usageState,
              trigger: null,
              activeTask: null,
              lastError,
              lastErrorDetail,
              lastDispatchAt: null,
              cycleResult: null,
              queueDepth,
              pid: daemonPid,
              backendState,
            });

            triggerEngine.resetDispatchState();

            if (trigFailSleepMs > 0) {
              try {
                await sleep(trigFailSleepMs, undefined, { signal: stopSignal });
              } catch (sleepErr) {
                if (isAbortError(sleepErr)) {
                  stopSignal.removeEventListener('abort', cancelCycle);
                  break;
                }
              }
            }
            stopSignal.removeEventListener('abort', cancelCycle);
            continue;
          }

          // 2b. Pre-dispatch backend availability check (AC1, AC2, AC3)
          //
          // Call checkBackendAvailable() — which delegates to
          // ContainerBackendWrapper.available() — so that resetAvailabilityCache() is
          // called and a fresh runtime probe is performed before each dispatch cycle.
          // Using getBackendState().available would read stale _previouslyUnavailable state
          // with no fresh probe.
          //
          // getBackendState() is still called separately for status writes after the
          // availability result is known.
          let backendAvailable = true; // default: allow dispatch when no backend check configured

          if (triggerResult.shouldDispatch && checkBackendAvailable) {
            try {
              backendAvailable = await checkBackendAvailable();
            } catch (bsErr) {
              const msg = bsErr instanceof Error ? bsErr.message : String(bsErr);
              lastError = `Backend state check failed: ${msg}`;
              lastErrorDetail = buildLastErrorDetail(
                ErrorCode.CONTAINER_RUNTIME_UNAVAILABLE,
                lastError,
                null,
              );
              backendAvailable = false;
            }
          }

          // Fetch backend state for status writes (separate from availability probe)
          if (getBackendState) {
            try {
              backendState = await getBackendState();
            } catch {
              // Non-fatal: status write proceeds with null backendState
            }
          }

          // Pre-dispatch availability gate: skip dispatch when backend is unavailable
          if (triggerResult.shouldDispatch && !backendAvailable) {
            void logger.warn('polling-loop.backend-unavailable', {
              reason: 'Container runtime unavailable — dispatch skipped',
            });
            if (!lastError) {
              lastError = 'Container runtime unavailable — dispatch skipped';
              lastErrorDetail = buildLastErrorDetail(
                ErrorCode.CONTAINER_RUNTIME_UNAVAILABLE,
                'Container runtime unavailable — dispatch skipped',
                'Restart Docker/Podman and run `sparecrow onboard` to reconfigure if needed',
              );
            }
            triggerEngine.resetDispatchState();

            const { nextPollAt: bsSkipNextPollAt, sleepMs: bsSkipSleepMs } = computeNextPollAt(
              cycleStart,
              intervalMs,
            );
            const queueDepth = await getQueueDepth();
            await writeCycleStatus({
              startedAt,
              lastPollAt: cycleStart.toISOString(),
              nextPollAt: bsSkipNextPollAt,
              usage: usageState,
              trigger: triggerState,
              activeTask: null,
              lastError,
              lastErrorDetail,
              lastDispatchAt: null,
              cycleResult: null,
              queueDepth,
              pid: daemonPid,
              backendState,
            });
            endCycleNextPollAt = bsSkipNextPollAt;
            compensatedSleepMs = bsSkipSleepMs;
            this._lastPollAt = cycleStart.toISOString();
            stopSignal.removeEventListener('abort', cancelCycle);
            if (stopSignal.aborted) break;
            if (compensatedSleepMs > 0) {
              try {
                await sleep(compensatedSleepMs, undefined, { signal: stopSignal });
              } catch (sleepErr) {
                if (isAbortError(sleepErr)) break;
              }
            }
            continue;
          }

          // 3. Dispatch if triggered
          if (triggerResult.shouldDispatch) {
            // Track partial dispatch progress — updated per-task in onTaskComplete (AC4).
            // These counters shadow the cycle-level variables so that status writes during
            // dispatch reflect real progress rather than the pre-dispatch null values.
            let partialAttempted = 0;
            let partialSucceeded = 0;
            let partialFailed = 0;
            const dispatchStartedAt = new Date().toISOString();

            // Partial output writer — created per task in onTaskStart, closed in onTaskComplete.
            // Mutable closure ref so onChunk lambda can write to the current task's writer.
            let currentPartialWriter: PartialOutputWriter | null = null;

            // Build status-writing callbacks so daemon-status.json reflects
            // real-time dispatch progress (AC1-4, Story 7.17).
            const onTaskStart = async (task: TaskDefinition): Promise<void> => {
              activeTaskState = {
                taskId: task.id,
                taskName: task.name,
                taskType: task.type,
                startedAt: new Date().toISOString(),
              };

              // Open a partial output writer for this task (AC1 — incremental output file).
              const writer = new PartialOutputWriter(getPaths().taskOutputs, task.id);
              writer.open();
              currentPartialWriter = writer;

              const currentQueueDepth = await getQueueDepth();
              await writeCycleStatus({
                startedAt,
                lastPollAt: cycleStart.toISOString(),
                nextPollAt: computeMidCycleNextPollAt(intervalMs),
                usage: usageState,
                trigger: triggerState,
                activeTask: activeTaskState,
                lastError,
                lastErrorDetail,
                lastDispatchAt,
                cycleResult,
                queueDepth: currentQueueDepth,
                pid: daemonPid,
                backendState,
              });
            };

            const onTaskComplete = async (
              task: TaskDefinition,
              result: TaskResult,
            ): Promise<void> => {
              activeTaskState = null;

              // Close and remove the partial output file for this task (AC3).
              // writeTaskOutput (below) writes the final <taskId>.txt atomically;
              // the .partial.txt is no longer needed once the task has completed.
              const writer = currentPartialWriter;
              currentPartialWriter = null;
              if (writer) {
                await writer.close();
                await writer.cleanup();
              }

              // Persist task output to disk (AC1, AC2, AC3 — non-fatal)
              await writeTaskOutput(getPaths().taskOutputs, result);
              // Write result artifact to target repo's .scrow/ directory (Story 13.1, non-fatal)
              // For active templates, extract the branch name from stdout (Story 13.4 AC6).
              // Passive templates (e.g. security-audit) always produce null.
              const templateName = task.templateName ?? task.name;
              const isActive = ACTIVE_TEMPLATE_NAMES.has(templateName);
              const branch = isActive ? extractBranchFromStdout(result.stdout) : null;
              const artifactOutput = await writeResultArtifact({
                task,
                result,
                branch,
              });
              // Run post-execution action pipeline when artifact was written and task succeeded (AC7)
              if (artifactOutput !== null && result.exitCode === 0) {
                try {
                  await runActionPipeline({
                    frontmatter: {
                      task_id: task.id,
                      template: templateName,
                      repo: task.targetPath,
                      dispatched_at: result.startedAt.toISOString(),
                      completed_at: result.completedAt.toISOString(),
                      exit_code: result.exitCode ?? 1,
                      branch,
                    },
                    templateActions: task.actions,
                    resultFilePath: artifactOutput.filePath,
                    taskId: task.id,
                    repoPath: task.targetPath,
                  });
                } catch (err) {
                  // AC7: pipeline failure must never interrupt the dispatch cycle
                  void logger.warn('action-pipeline.uncaught-error', {
                    taskId: task.id,
                    error: err instanceof Error ? err.message : String(err),
                  });
                }
              }
              // Accumulate partial cycle progress so AC4 ("partial cycleResult reflects progress")
              // is satisfied at each task boundary, not just at the end of the full cycle.
              partialAttempted += 1;
              if (result.status === 'done') {
                partialSucceeded += 1;
              } else if (result.status !== 'failed_quota') {
                partialFailed += 1;
              }
              const now = new Date().toISOString();
              const partialCycleResult: DispatchCycleResult = {
                tasksAttempted: partialAttempted,
                tasksSucceeded: partialSucceeded,
                tasksFailed: partialFailed,
                stoppedByQuota: result.status === 'failed_quota',
                startedAt: dispatchStartedAt,
                completedAt: now,
                durationMs: new Date(now).getTime() - new Date(dispatchStartedAt).getTime(),
              };
              const currentQueueDepth = await getQueueDepth();
              await writeCycleStatus({
                startedAt,
                lastPollAt: cycleStart.toISOString(),
                nextPollAt: computeMidCycleNextPollAt(intervalMs),
                usage: usageState,
                trigger: triggerState,
                activeTask: null,
                lastError,
                lastErrorDetail,
                lastDispatchAt: now,
                cycleResult: partialCycleResult,
                queueDepth: currentQueueDepth,
                pid: daemonPid,
                backendState,
              });
            };

            // onChunk: forward each chunk to the current task's partial output writer.
            // The writer ref is a mutable closure variable — safe because dispatch is sequential.
            const onChunk = (
              _taskId: string,
              chunk: string,
              _stream: 'stdout' | 'stderr',
            ): void => {
              currentPartialWriter?.write(chunk);
            };

            try {
              const dispatchedResult = await dispatchAdapter.dispatchIfTriggered(triggerResult, {
                signal: cycleController.signal,
                onTaskStart,
                onTaskComplete,
                onChunk,
              });
              if (dispatchedResult !== null) {
                cycleResult = dispatchedResult;
                lastDispatchAt = dispatchedResult.completedAt;
                activeTaskState = null;
              }
            } catch (dispatchErr) {
              if (isAbortError(dispatchErr)) {
                void logger.debug('polling-loop.dispatch-aborted', {});
              } else {
                const msg =
                  dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr);
                lastError = msg;
                void logger.error('polling-loop.dispatch-failed', { error: msg });
              }
            } finally {
              // If dispatch threw before onTaskComplete fired, the PartialOutputWriter stream
              // would be left open and the .partial.txt file would persist indefinitely.
              // Always close and clean up any writer that onTaskComplete did not already close.
              if (currentPartialWriter !== null) {
                // Snapshot into a widened variable to work around TS control-flow narrowing
                // that infers `never` when the variable is also assigned inside a closure.
                const leakedWriter = currentPartialWriter as PartialOutputWriter;
                currentPartialWriter = null;
                try {
                  await leakedWriter.close();
                  await leakedWriter.cleanup();
                } catch (cleanupErr) {
                  void logger.warn('polling-loop.partial-writer-cleanup-failed', {
                    error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
                  });
                }
              }
            }
            // Reset dispatch guard so next cycle can re-evaluate
            triggerEngine.resetDispatchState();
          }

          // 4. Write cycle state — compute nextPollAt and sleepMs once so the displayed
          // nextPollAt and the actual sleep duration are derived from the same wall-clock call.
          ({ nextPollAt: endCycleNextPollAt, sleepMs: compensatedSleepMs } = computeNextPollAt(
            cycleStart,
            intervalMs,
          ));
          const queueDepth = await getQueueDepth();
          const cycleLastPollAt = cycleStart.toISOString();
          await writeCycleStatus({
            startedAt,
            lastPollAt: cycleLastPollAt,
            nextPollAt: endCycleNextPollAt,
            usage: usageState,
            trigger: triggerState,
            activeTask: activeTaskState,
            lastError,
            lastErrorDetail,
            lastDispatchAt,
            cycleResult,
            queueDepth,
            pid: daemonPid,
            backendState,
          });
          // Update the observable lastPollAt for the runner to read on loop exit.
          this._lastPollAt = cycleLastPollAt;

          // 4b. Write last-summary.txt if enabled and a dispatch cycle completed
          // Failure is non-fatal: writeSummaryFile handles errors internally (AC14)
          if (config.lastSummaryEnabled && cycleResult !== null) {
            const dataDir = getPaths().data;
            await writeSummaryFile(dataDir, cycleResult.tasksSucceeded);
          }
        } finally {
          stopSignal.removeEventListener('abort', cancelCycle);
        }

        // 5. Sleep until next cycle (abortable), compensated for elapsed time.
        // compensatedSleepMs was already computed above alongside nextPollAt so that the
        // displayed next-poll time and the actual sleep duration are consistent.
        //
        // The sleep uses a per-sleep AbortController (_sleepController) that reload() can
        // abort to interrupt the sleep when the polling interval decreases (Story 14.2 AC1).
        // When the sleep is interrupted by reload, the loop re-sleeps for the remaining time
        // based on the new interval. The stop signal (daemon shutdown) takes priority and
        // always breaks out of the loop entirely (AC3: no duplicate polls after interrupt).
        if (stopSignal.aborted) break;
        // NOTE: Event name changed from 'polling-loop.sleeping' (pre-7.21) to
        // 'polling-loop.sleep-start' to pair with 'polling-loop.sleep-end'. Update any
        // monitoring dashboards or alert rules that reference the old event name.
        void logger.debug('polling-loop.sleep-start', {
          nextPollAt: endCycleNextPollAt,
          sleepMs: compensatedSleepMs,
          intervalMs,
        });

        if (compensatedSleepMs > 0) {
          let remainingSleepMs = compensatedSleepMs;
          // Tracks the planned duration for each sleep segment, used in sleep-end events.
          // Updated to remainingSleepMs after each reload interrupt so audit events reflect
          // the actual rescheduled target rather than the stale pre-reload duration.
          let currentExpectedMs = compensatedSleepMs;
          const overallSleepStartMs = Date.now();
          // Tracks whether an abort (non-reload) occurred during the sleep loop.
          // When true, the outer main loop should also break.
          let sleepAborted = false;

          // Sleep loop: allows reload() to interrupt and reschedule with a shorter interval.
          // Each iteration sleeps for remainingSleepMs. If interrupted by reload (not stop),
          // remainingSleepMs is recalculated from the new interval minus elapsed time.
          while (remainingSleepMs > 0) {
            if (stopSignal.aborted) {
              sleepAborted = true;
              break;
            }

            // Set up per-sleep abort controller so reload() can interrupt this sleep.
            const sleepController = new AbortController();
            this._sleepController = sleepController;

            // Bridge stop signal to sleep controller so daemon shutdown aborts the sleep.
            const onStop = (): void => {
              sleepController.abort();
            };
            stopSignal.addEventListener('abort', onStop, { once: true });

            try {
              await sleep(remainingSleepMs, undefined, { signal: sleepController.signal });
              // Sleep completed normally — clear state and exit sleep loop.
              stopSignal.removeEventListener('abort', onStop);
              this._sleepController = null;
              const actualSleepMs = Date.now() - overallSleepStartMs;
              void logger.debug('polling-loop.sleep-end', {
                expectedMs: currentExpectedMs,
                actualMs: actualSleepMs,
              });
              break;
            } catch (sleepErr) {
              stopSignal.removeEventListener('abort', onStop);
              this._sleepController = null;

              if (!isAbortError(sleepErr)) {
                // Non-abort error during sleep — log and continue to next cycle
                const actualSleepMs = Date.now() - overallSleepStartMs;
                void logger.debug('polling-loop.sleep-end', {
                  expectedMs: currentExpectedMs,
                  actualMs: actualSleepMs,
                });
                const msg = sleepErr instanceof Error ? sleepErr.message : String(sleepErr);
                void logger.error('polling-loop.sleep-error', { error: msg });
                break;
              }

              // AbortError — determine if this was from reload() or stop/other.
              // reload() sets _reloadInterruptPending = true before aborting.
              if (this._reloadInterruptPending) {
                this._reloadInterruptPending = false;

                // Interrupted by reload() — recalculate remaining sleep from the new interval.
                // elapsed is total time since the overall sleep started (not just this segment).
                const totalElapsed = Date.now() - overallSleepStartMs;
                const newIntervalMs = this._config.pollingInterval * 1000;
                remainingSleepMs = Math.max(0, newIntervalMs - totalElapsed);
                // Update currentExpectedMs so subsequent sleep-end events reflect the
                // rescheduled target duration, not the stale pre-reload planned duration.
                currentExpectedMs = remainingSleepMs;

                // Emit the sleep-rescheduled event here (not in reload()) so remainingMs is
                // the authoritative value actually used for the rescheduled sleep, not a
                // stale approximation computed before async abort propagation.
                const reloadEventData = this._reloadEventData;
                this._reloadEventData = null;
                void logger.debug('polling-loop.sleep-rescheduled', {
                  oldIntervalMs: reloadEventData?.oldIntervalMs ?? newIntervalMs,
                  newIntervalMs,
                  remainingMs: remainingSleepMs,
                });

                if (remainingSleepMs <= 0) {
                  // New interval has already elapsed — proceed to next cycle immediately.
                  const actualSleepMs = Date.now() - overallSleepStartMs;
                  void logger.debug('polling-loop.sleep-end', {
                    expectedMs: currentExpectedMs,
                    actualMs: actualSleepMs,
                  });
                  break;
                }
                // Continue the while loop to sleep for the remaining time.
              } else {
                // Not a reload interrupt — treat as daemon shutdown or external abort.
                sleepAborted = true;
                const actualSleepMs = Date.now() - overallSleepStartMs;
                void logger.debug('polling-loop.sleep-end', {
                  expectedMs: currentExpectedMs,
                  actualMs: actualSleepMs,
                });
                break;
              }
            }
          }

          // Break out of the main loop if sleep was aborted by stop signal or external abort.
          if (sleepAborted || stopSignal.aborted) break;
        } else {
          void logger.debug('polling-loop.sleep-skipped', {
            reason: 'cycle duration exceeded polling interval',
            intervalMs,
          });
        }
      }
    } catch (err) {
      // Unexpected fatal error escaping the loop — log and re-throw so the runner can
      // detect the rejection and transition daemon-status.json to state: "stopped".
      const msg = err instanceof Error ? err.message : String(err);
      void logger.error('polling-loop.fatal-error', { error: msg });
      throw err;
    } finally {
      this._running = false;
      this._sleepController = null;
      this._reloadInterruptPending = false;
      this._reloadEventData = null;
      void logger.debug('polling-loop.stopped', {});
    }
  }
}
