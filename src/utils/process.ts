/** Subprocess guardrail utility — spawn with timeout, output capture, and AbortSignal cancellation. */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { logger } from './logger.js';
import { EventName } from '../types/index.js';

/**
 * Maximum bytes preserved from stdout/stderr on failure paths (10 KB).
 * Public API — re-exported from the utils barrel for use by other modules
 * (e.g. ContainerExecutionBackend output bounding).
 */
export const MAX_OUTPUT_BYTES = 10 * 1024;

/**
 * Maximum bytes preserved from stdout/stderr on success paths (50 KB).
 * Public API — re-exported from the utils barrel for use by other modules
 * (e.g. ContainerExecutionBackend output bounding).
 */
export const MAX_OUTPUT_BYTES_SUCCESS = 50 * 1024;

/** Grace period in ms between SIGTERM and SIGKILL during forced shutdown. */
const SIGKILL_GRACE_MS = 5000;

/** Grace period in ms after `exit` event before resolving without `close`. */
const EXIT_CLOSE_GRACE_MS = 5000;

/** Final deadline in ms after SIGKILL before force-resolving the Promise. */
const FINAL_DEADLINE_MS = 10000;

/** Default health check interval in ms — child process idle detection. */
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 60_000;

/** Number of consecutive idle checks before emitting a warning. */
const IDLE_CHECK_THRESHOLD = 2;

/**
 * Truncates a string to the last maxBytes bytes to bound accumulated output.
 * Skips past UTF-8 continuation bytes (0x80–0xBF) at the slice boundary to avoid
 * producing replacement characters from split multi-byte sequences.
 */
export function boundOutput(raw: string, maxBytes: number = MAX_OUTPUT_BYTES): string {
  if (Buffer.byteLength(raw, 'utf-8') <= maxBytes) return raw;
  const buf = Buffer.from(raw, 'utf-8');
  let start = buf.length - maxBytes;
  // Advance past any UTF-8 continuation bytes (0x80–0xBF) at the cut point
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) {
    start++;
  }
  return buf.subarray(start).toString('utf-8');
}

/**
 * Reads /proc/<pid>/stat to capture CPU time (utime + stime in clock ticks) and RSS (pages).
 * Returns null on non-Linux or if /proc is unavailable.
 */
async function readProcStat(
  pid: number,
): Promise<{ utimeTicks: number; stimeTicks: number; rssPages: number } | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf-8');
    // Fields: pid (comm) state ... field[13]=utime field[14]=stime ... field[23]=rss
    // The comm field can contain spaces/parens, so find the closing paren first
    const closeParen = stat.lastIndexOf(')');
    if (closeParen === -1) return null;
    const fields = stat.slice(closeParen + 2).split(' ');
    // fields[0]=state, fields[11]=utime, fields[12]=stime, fields[21]=rss (0-indexed after state)
    const utime = Number(fields[11]);
    const stime = Number(fields[12]);
    const rss = Number(fields[21]);
    if (Number.isNaN(utime) || Number.isNaN(stime) || Number.isNaN(rss)) return null;
    return { utimeTicks: utime, stimeTicks: stime, rssPages: rss };
  } catch {
    return null;
  }
}

export interface SpawnGuardrailOptions {
  /** Working directory for the child process. */
  cwd?: string;
  /** Timeout in milliseconds; child is killed and timedOut is set when exceeded. */
  timeoutMs: number;
  /** Optional external AbortSignal; child is killed on abort and aborted is set. */
  signal?: AbortSignal;
  /**
   * Explicit environment map for the child process.
   * When provided, replaces process.env entirely (Node.js spawn behavior).
   * When undefined, the child inherits process.env unchanged (default).
   */
  env?: Record<string, string>;
  /**
   * Grace period in ms between SIGTERM and SIGKILL during forced shutdown.
   * Defaults to 5000ms. Increase on systems with slow process cleanup.
   */
  sigkillGraceMs?: number;
  /**
   * Grace period in ms after `exit` event before resolving without `close`.
   * Defaults to 5000ms. Handles grandchild processes holding stdio open.
   */
  exitCloseGraceMs?: number;
  /**
   * Final deadline in ms after SIGKILL before force-resolving the Promise.
   * Defaults to 10000ms. Worst-case additional blocking after timeout fires is
   * sigkillGraceMs + finalDeadlineMs (default: 5s + 10s = 15s).
   */
  finalDeadlineMs?: number;
  /**
   * Interval in ms for periodic child process health checks.
   * Defaults to 60000ms (60 seconds). Set to 0 to disable health checks.
   * Health checks sample CPU time and output activity to detect stalled children.
   * Note: the first check establishes a CPU baseline, so the earliest a warning
   * can fire is after 3 intervals (baseline check + 2 consecutive idle checks).
   */
  healthCheckIntervalMs?: number;
  /**
   * Optional callback invoked for each stdout/stderr chunk as it arrives.
   * Called synchronously inside the data event handler before chunk accumulation.
   * Errors thrown by this callback are swallowed to prevent breaking the spawn cycle.
   * Used by the daemon's partial output writer for live task output streaming (AC1).
   */
  onChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void;
}

export interface SpawnGuardrailResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** True when the child was terminated due to timeout. */
  timedOut: boolean;
  /** True when the child was terminated due to external abort signal. */
  aborted: boolean;
  /** True when the binary was not found (ENOENT at spawn time). */
  enoent: boolean;
}

/**
 * Spawns a child process with guardrails: timeout enforcement, AbortSignal cancellation,
 * and bounded output capture. Never uses `shell: true` — args must be a pre-split array.
 *
 * On timeout or abort, sends SIGTERM first and escalates to SIGKILL after a grace period
 * to allow the child process to clean up before forced termination.
 *
 * If both signals fail and the process never exits, a final deadline resolves the Promise
 * with timedOut: true to prevent indefinite blocking.
 */
export async function spawnWithGuardrails(
  command: string,
  args: string[],
  options: SpawnGuardrailOptions,
): Promise<SpawnGuardrailResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let stdoutChunks = '';
    let stderrChunks = '';
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let finalDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let exitGraceTimer: ReturnType<typeof setTimeout> | undefined;
    let exitCode: number | null = null;

    /** Timestamp of the last data received on stdout or stderr. */
    let lastDataReceivedAt: number | null = null;

    const sigkillGraceMs = options.sigkillGraceMs ?? SIGKILL_GRACE_MS;
    const exitCloseGraceMs = options.exitCloseGraceMs ?? EXIT_CLOSE_GRACE_MS;
    const finalDeadlineMs = options.finalDeadlineMs ?? FINAL_DEADLINE_MS;
    const healthCheckIntervalMs = options.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS;

    // --- Health check state ---
    /** Whether stdout/stderr data was received since the last health check. */
    let outputReceivedSinceLastCheck = false;
    /** Previous CPU time sample from /proc/<pid>/stat (utime + stime). */
    let prevCpuTicks: number | null = null;
    /** True once a CPU baseline has been established via a successful /proc read. */
    let procBaselineEstablished = false;
    /** Number of consecutive health checks where the child appeared idle. */
    let consecutiveIdleChecks = 0;
    /** Whether we already emitted a warning for the current sustained idle period. */
    let idleWarningEmitted = false;
    /** Timestamp when the idle period started (first idle check). */
    let idleStartedAt: number | null = null;
    /** Reference to the health check interval timer. */
    let healthCheckTimer: ReturnType<typeof setInterval> | undefined;
    /** Guard to prevent overlapping async health check invocations. */
    let healthCheckInProgress = false;
    /** Whether the /proc-unavailable debug message has already been logged once. */
    let procUnavailableLogged = false;

    // stdio defaults to ['pipe', 'pipe', 'pipe'] when shell: false — no inherited FDs beyond stdin/stdout/stderr.
    // detached is not set — parent manages child lifecycle (AC3, Story 12.6).
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      ...(options.env !== undefined ? { env: options.env } : {}),
    });

    const childPid = child.pid;

    function settle(code: number | null): void {
      if (settled) return;
      settled = true;
      cleanup();

      if ((timedOut || aborted) && childPid !== undefined) {
        void logger.info(EventName.PROCESS_CHILD_EXITED, {
          pid: childPid,
          exitCode: code,
          timedOut,
          aborted,
        });
      }

      // On failure paths, bound output to last 10 KB; on success, cap at 50 KB
      const isFailure = code !== 0 || timedOut || aborted;
      resolve({
        stdout: isFailure
          ? boundOutput(stdoutChunks, MAX_OUTPUT_BYTES)
          : boundOutput(stdoutChunks, MAX_OUTPUT_BYTES_SUCCESS),
        stderr: isFailure
          ? boundOutput(stderrChunks, MAX_OUTPUT_BYTES)
          : boundOutput(stderrChunks, MAX_OUTPUT_BYTES_SUCCESS),
        exitCode: code,
        timedOut,
        aborted,
        enoent: false,
      });
    }

    /**
     * Collects child process diagnostics for kill-path logging.
     * Reads /proc/<pid>/stat for CPU time and RSS.
     * Returns an empty object on non-Linux or if unavailable.
     * NOTE: /proc/<pid>/net/tcp is network-namespace-scoped (not process-scoped) and
     * therefore not included — it would show all system TCP connections, not the child's.
     */
    async function collectProcessDiagnostics(pid: number): Promise<Record<string, unknown>> {
      const diagnostics: Record<string, unknown> = {};

      const procStat = await readProcStat(pid);
      if (procStat !== null) {
        diagnostics.utimeTicks = procStat.utimeTicks;
        diagnostics.stimeTicks = procStat.stimeTicks;
        diagnostics.rssPages = procStat.rssPages;
      }

      if (lastDataReceivedAt !== null) {
        diagnostics.lastOutputAgoMs = Date.now() - lastDataReceivedAt;
      }

      return diagnostics;
    }

    /**
     * Periodic health check — samples CPU time and output activity to detect stalled children.
     * After IDLE_CHECK_THRESHOLD consecutive idle checks, emits a warning-level log entry.
     * Best-effort: failures reading /proc are logged at debug level (first occurrence only)
     * and do not affect execution.
     */
    async function performHealthCheck(): Promise<void> {
      if (settled || childPid === undefined) return;

      // Concurrency guard — skip this invocation if a previous async check is still in flight.
      // This prevents shared mutable state from being accessed by overlapping setInterval callbacks
      // when readProcStat takes longer than healthCheckIntervalMs.
      if (healthCheckInProgress) return;
      healthCheckInProgress = true;

      try {
        // Sample CPU time from /proc/<pid>/stat
        const procStat = await readProcStat(childPid);
        let cpuIdle = false;

        if (procStat !== null) {
          const currentCpuTicks = procStat.utimeTicks + procStat.stimeTicks;
          if (procBaselineEstablished && currentCpuTicks === prevCpuTicks) {
            cpuIdle = true;
          }
          prevCpuTicks = currentCpuTicks;
          procBaselineEstablished = true;
        } else {
          // /proc unavailable (macOS, permission error) — log at debug on first occurrence only
          if (!procUnavailableLogged) {
            procUnavailableLogged = true;
            void logger.debug(EventName.TASK_EXECUTOR_PROC_UNAVAILABLE, {
              pid: childPid,
              message: '/proc stat unavailable, relying on output activity only',
            });
          }
          // When /proc is unavailable, consider CPU as idle so output-only check still works.
          // On the very first check there is no baseline yet, so skip the idle increment.
          if (procBaselineEstablished) {
            cpuIdle = true;
          } else {
            procBaselineEstablished = true;
          }
        }

        const outputIdle = !outputReceivedSinceLastCheck;

        // Reset the output flag for the next check interval
        outputReceivedSinceLastCheck = false;

        if (cpuIdle && outputIdle) {
          consecutiveIdleChecks++;
          if (idleStartedAt === null) {
            idleStartedAt = Date.now() - healthCheckIntervalMs;
          }

          if (consecutiveIdleChecks >= IDLE_CHECK_THRESHOLD && !idleWarningEmitted) {
            idleWarningEmitted = true;
            const idleDurationMs = Date.now() - idleStartedAt;
            void logger.warn(EventName.TASK_EXECUTOR_CHILD_IDLE, {
              pid: childPid,
              idleDurationMs,
              lastOutputAt:
                lastDataReceivedAt !== null ? new Date(lastDataReceivedAt).toISOString() : null,
              consecutiveIdleChecks,
              rssPages: procStat?.rssPages ?? null,
            });
          }
        } else {
          // Child is active — reset idle tracking
          consecutiveIdleChecks = 0;
          idleWarningEmitted = false;
          idleStartedAt = null;
        }
      } finally {
        healthCheckInProgress = false;
      }
    }

    async function killChild(): Promise<void> {
      const pid = childPid;

      // Send SIGTERM FIRST — do not await diagnostics before delivering the signal.
      // Async I/O can stall on an overloaded system, delaying the very termination we need.
      try {
        child.kill('SIGTERM');
        void logger.info(EventName.PROCESS_SIGTERM_SENT, { pid: pid ?? null });
      } catch (err: unknown) {
        const errObj = err instanceof Error ? err : new Error(String(err));
        const errCode = (err as NodeJS.ErrnoException).code ?? null;
        void logger.error(
          EventName.PROCESS_SIGTERM_FAILED,
          {
            pid: pid ?? null,
            errorCode: errCode,
            errorMessage: errObj.message,
          },
          errObj,
        );
      }

      // Collect diagnostics asynchronously and log timeout/abort fired AFTER SIGTERM.
      // This way SIGTERM is never blocked by slow /proc reads.
      if (pid !== undefined) {
        void collectProcessDiagnostics(pid).then((diagnostics) => {
          // Log timeout or abort fired (both paths deserve a log entry per AC4)
          if (timedOut || aborted) {
            void logger.warn(EventName.PROCESS_TIMEOUT_FIRED, {
              pid: pid ?? null,
              command,
              timeoutMs: options.timeoutMs,
              timedOut,
              aborted,
              ...diagnostics,
            });
          }
        });
      } else if (timedOut || aborted) {
        // No PID available — log without diagnostics
        void logger.warn(EventName.PROCESS_TIMEOUT_FIRED, {
          pid: null,
          command,
          timeoutMs: options.timeoutMs,
          timedOut,
          aborted,
        });
      }

      // SIGKILL escalation — always scheduled regardless of SIGTERM outcome
      graceTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
          void logger.info(EventName.PROCESS_SIGKILL_SENT, { pid: pid ?? null });
        } catch (err: unknown) {
          const errObj = err instanceof Error ? err : new Error(String(err));
          const errCode = (err as NodeJS.ErrnoException).code ?? null;
          void logger.error(
            EventName.PROCESS_SIGKILL_FAILED,
            {
              pid: pid ?? null,
              errorCode: errCode,
              errorMessage: errObj.message,
            },
            errObj,
          );
        }

        // Final deadline — resolve the Promise even if close/exit never fire after SIGKILL
        finalDeadlineTimer = setTimeout(() => {
          settle(exitCode);
        }, finalDeadlineMs);
      }, sigkillGraceMs);
    }

    // Timeout enforcement — timeoutMs === 0 means "no timeout", child runs until natural exit or abort.
    const timeoutId =
      options.timeoutMs > 0
        ? setTimeout(() => {
            if (!settled) {
              timedOut = true;
              void killChild();
            }
          }, options.timeoutMs)
        : undefined;

    // External abort signal forwarding
    let externalAbortListener: (() => void) | undefined;
    if (options.signal) {
      if (options.signal.aborted) {
        aborted = true;
        // Will be killed after spawn completes — handled in error/close
        setTimeout(() => void killChild(), 0);
      } else {
        externalAbortListener = () => {
          if (!settled) {
            aborted = true;
            void killChild();
          }
        };
        options.signal.addEventListener('abort', externalAbortListener, { once: true });
      }
    }

    function cleanup(): void {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      if (finalDeadlineTimer !== undefined) clearTimeout(finalDeadlineTimer);
      if (exitGraceTimer !== undefined) clearTimeout(exitGraceTimer);
      if (healthCheckTimer !== undefined) clearInterval(healthCheckTimer);
      if (options.signal && externalAbortListener) {
        options.signal.removeEventListener('abort', externalAbortListener);
      }
    }

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      stdoutChunks += text;
      lastDataReceivedAt = Date.now();
      outputReceivedSinceLastCheck = true;
      if (options.onChunk) {
        try {
          options.onChunk(text, 'stdout');
        } catch {
          // Non-fatal: swallow errors from the chunk callback to protect the spawn cycle.
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      stderrChunks += text;
      lastDataReceivedAt = Date.now();
      outputReceivedSinceLastCheck = true;
      if (options.onChunk) {
        try {
          options.onChunk(text, 'stderr');
        } catch {
          // Non-fatal: swallow errors from the chunk callback to protect the spawn cycle.
        }
      }
    });

    // Listen for `exit` event as a fallback — if `close` doesn't follow within
    // EXIT_CLOSE_GRACE_MS, resolve the Promise with the exit code from `exit`.
    child.on('exit', (code: number | null) => {
      exitCode = code;
      // Give `close` a chance to fire (it normally follows `exit` quickly)
      exitGraceTimer = setTimeout(() => {
        settle(code);
      }, exitCloseGraceMs);
    });

    child.on('close', (code: number | null) => {
      settle(code);
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;

      // ENOENT means binary not found — resolve with enoent flag so caller can distinguish
      if (err.code === 'ENOENT') {
        settled = true;
        cleanup();
        resolve({
          stdout: '',
          stderr: '',
          exitCode: null,
          timedOut: false,
          aborted: false,
          enoent: true,
        });
      }
      // Other errors (e.g. EPERM): 'close' will still fire, let it resolve the promise
    });

    // Start periodic health check if enabled (healthCheckIntervalMs > 0) and child has a PID
    if (healthCheckIntervalMs > 0 && childPid !== undefined) {
      healthCheckTimer = setInterval(() => {
        void performHealthCheck();
      }, healthCheckIntervalMs);
    }
  });
}
