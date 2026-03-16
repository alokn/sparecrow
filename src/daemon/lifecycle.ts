/** Daemon lifecycle service — start, stop, restart, reload, and status operations. */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ScrowError } from '../errors/index.js';
import { ErrorCode } from '../errors/index.js';
import { getPaths, ensureDirectories } from '../platform/index.js';
import { safeReadJson, isRecord, logger } from '../utils/index.js';
import {
  checkPidStatus,
  removePid,
  readPid,
  processExists,
  DAEMON_STATUS_FILENAME,
  DAEMON_IDENTITY_ENV,
  DAEMON_IDENTITY_VALUE,
  getProcessName,
} from './pid-manager.js';
import { PidLock } from './pid-lock.js';
import type { DaemonStatusInfo } from '../types/index.js';

/** Time in milliseconds to wait for daemon process to exit before escalating to SIGKILL. */
export const DAEMON_STOP_TIMEOUT_MS = 5000;

/** Time in milliseconds to wait for daemon to write its PID after spawning. */
const DAEMON_START_WAIT_MS = 3000;
/** Polling interval for checking daemon startup PID write. */
const DAEMON_START_POLL_INTERVAL_MS = 50;

/** Internal CLI flag used to mark the process as the sparecrow daemon runner.
 *  Must match what runner.ts inserts into the process command line. */
export const DAEMON_RUNNER_FLAG = '--daemon-runner';

/** Environment variable names injected by Claude Code that cause nested-session errors. */
const CLAUDE_CODE_POISONED_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_ENTRYPOINT',
] as const;

/** Pattern matching any additional Claude Code session variable. */
const CLAUDE_CODE_PREFIX_PATTERN = /^CLAUDE_CODE_/;

/**
 * Clones `process.env`, strips any Claude Code session env vars that would cause
 * nested-session errors in the daemon subprocess, and returns the sanitized copy.
 * Logs the names (never the values) of stripped variables at debug level.
 */
export function sanitizeDaemonEnv(): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = { ...process.env };
  const stripped: string[] = [];

  for (const key of Object.keys(sanitized)) {
    const isPoisoned =
      (CLAUDE_CODE_POISONED_VARS as readonly string[]).includes(key) ||
      CLAUDE_CODE_PREFIX_PATTERN.test(key);
    if (isPoisoned) {
      delete sanitized[key];
      stripped.push(key);
    }
  }

  if (stripped.length > 0) {
    void logger.debug('lifecycle.sanitize_daemon_env.stripped', { keys: stripped });
  }

  return sanitized;
}

/**
 * Builds a DAEMON_ALREADY_RUNNING ScrowError enriched with the process name for a given PID.
 * Consolidates the identical error-construction logic used in both the advisory-lock path
 * and the PID-file path of startDaemon(), ensuring the two paths stay in sync.
 */
async function buildAlreadyRunningError(pid: number): Promise<ScrowError> {
  const procName = await getProcessName(pid);
  const procInfo = procName ? ` (${procName})` : '';
  return new ScrowError(
    ErrorCode.DAEMON_ALREADY_RUNNING,
    `Daemon is already running with PID ${pid}${procInfo}. ` +
      `Run \`sparecrow daemon stop\` to stop it first.`,
  );
}

/** Spawns the daemon process in detached mode.
 *  Returns the child PID immediately; daemon manages its own PID file. */
export async function startDaemon(): Promise<{ pid: number; dataDir: string }> {
  await ensureDirectories();
  const paths = getPaths();
  const dataDir = paths.data;

  // AC1/AC2: Check advisory lock before PID file check to eliminate TOCTOU race.
  // The lock is a pre-flight check only — the daemon runner process acquires and holds
  // its own lock for its lifetime. Here we just verify no other daemon holds the lock.
  // Single readOwnerPid() + processExists() call avoids a TOCTOU window that would arise
  // from separate isHeld() then readOwnerPid() calls (the lock could be released between them).
  const preFlightLock = new PidLock(dataDir);
  const ownerPid = await preFlightLock.readOwnerPid();
  if (ownerPid !== null && processExists(ownerPid)) {
    throw await buildAlreadyRunningError(ownerPid);
  }

  // Check if daemon is already running (PID file check — secondary to lock check)
  const { status, pid: existingPid } = await checkPidStatus(dataDir);
  if (status === 'alive' && existingPid !== null) {
    throw await buildAlreadyRunningError(existingPid);
  }

  // Clean up stale PID file if present
  if (status === 'stale') {
    void logger.debug('lifecycle.start_daemon.stale_pid_cleanup', { pid: existingPid });
    await removePid(dataDir);
  }

  // Entrypoint is always the currently-running script — correct in both dev and production
  const entrypoint = process.argv[1];
  if (entrypoint === undefined) {
    throw new ScrowError(
      ErrorCode.DAEMON_SPAWN_FAILED,
      'Cannot determine daemon entrypoint: process.argv[1] is undefined',
    );
  }
  // In dev mode, forward tsx/loader flags so the subprocess can execute TS source
  const execLoaderArgs = process.execArgv.filter(
    (arg) => arg.includes('tsx') || arg.startsWith('--loader') || arg.startsWith('--import'),
  );

  const child = spawn(process.execPath, [...execLoaderArgs, entrypoint, DAEMON_RUNNER_FLAG], {
    detached: true,
    // `as const` is required: TypeScript cannot narrow the string literal overload without it
    // when args is a spread expression, causing a union-type resolution error.
    stdio: 'ignore' as const,
    env: {
      ...sanitizeDaemonEnv(),
      [DAEMON_IDENTITY_ENV]: DAEMON_IDENTITY_VALUE,
    },
  });

  child.unref();

  const childPid = child.pid;
  if (childPid === undefined) {
    throw new ScrowError(ErrorCode.DAEMON_SPAWN_FAILED, 'Failed to spawn daemon process');
  }

  // Wait for the daemon to write its PID file (confirms bootstrap)
  const deadline = Date.now() + DAEMON_START_WAIT_MS;
  while (Date.now() < deadline) {
    const writtenPid = await readPid(dataDir);
    if (writtenPid !== null && writtenPid === childPid) {
      break;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, DAEMON_START_POLL_INTERVAL_MS));
  }

  // Confirm the daemon actually bootstrapped
  const confirmedPid = await readPid(dataDir);
  if (confirmedPid === null || confirmedPid !== childPid) {
    throw new ScrowError(
      ErrorCode.DAEMON_SPAWN_FAILED,
      'Daemon process did not write PID file within timeout — it may have crashed immediately',
    );
  }

  return { pid: childPid, dataDir };
}

/** Stops the daemon process: sends SIGTERM, waits up to DAEMON_STOP_TIMEOUT_MS, then SIGKILL.
 *  Removes the PID file after successful stop. */
export async function stopDaemon(): Promise<{ forced: boolean }> {
  const paths = getPaths();
  const dataDir = paths.data;

  const { status, pid } = await checkPidStatus(dataDir);

  if (status === 'none' || pid === null) {
    // Also check raw PID in case stale file with dead process
    const rawPid = await readPid(dataDir);
    if (rawPid === null || !processExists(rawPid)) {
      throw new ScrowError(ErrorCode.DAEMON_NOT_RUNNING, 'Daemon is not running');
    }
    // Stale PID that's a non-sparecrow process — still treat as not running
    throw new ScrowError(ErrorCode.DAEMON_NOT_RUNNING, 'Daemon is not running');
  }

  if (status === 'stale') {
    // Process is dead — just clean up
    await removePid(dataDir);
    throw new ScrowError(ErrorCode.DAEMON_NOT_RUNNING, 'Daemon is not running (stale PID cleaned)');
  }

  // Send SIGTERM and wait for process to exit
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      await removePid(dataDir);
      throw new ScrowError(ErrorCode.DAEMON_NOT_RUNNING, 'Daemon process disappeared during stop');
    }
    throw err;
  }

  // Poll for exit
  const deadline = Date.now() + DAEMON_STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    if (!processExists(pid)) {
      await removePid(dataDir);
      return { forced: false };
    }
  }

  // Timeout expired — escalate to SIGKILL
  void logger.debug('lifecycle.stop_daemon.sigkill_escalation', { pid });
  try {
    process.kill(pid, 'SIGKILL');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') throw err;
  }

  // AC5: Verify the process is actually dead after SIGKILL + 500ms wait
  await new Promise<void>((resolve) => setTimeout(resolve, 500));
  if (processExists(pid)) {
    void logger.warn('lifecycle.stop_daemon.process_survived_sigkill', {
      pid,
      message: `Process ${pid} is still alive after SIGKILL. Investigate manually.`,
    });
  }

  await removePid(dataDir);
  return { forced: true };
}

/** Restarts the daemon: stops if running, then starts. */
export async function restartDaemon(): Promise<{
  pid: number;
  wasRunning: boolean;
  dataDir: string;
}> {
  const paths = getPaths();
  const dataDir = paths.data;

  const { status, pid: existingPid } = await checkPidStatus(dataDir);
  const wasRunning = status === 'alive' && existingPid !== null;

  if (wasRunning) {
    await stopDaemon();
  } else if (status === 'stale') {
    await removePid(dataDir);
  }

  const { pid } = await startDaemon();
  return { pid, wasRunning, dataDir };
}

/** Sends SIGHUP to the running daemon to trigger config reload. */
export async function reloadDaemon(): Promise<void> {
  const paths = getPaths();
  const dataDir = paths.data;

  const { status, pid } = await checkPidStatus(dataDir);

  if (status !== 'alive' || pid === null) {
    throw new ScrowError(ErrorCode.DAEMON_NOT_RUNNING, 'Daemon is not running');
  }

  try {
    process.kill(pid, 'SIGHUP');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      await removePid(dataDir);
      throw new ScrowError(ErrorCode.DAEMON_NOT_RUNNING, 'Daemon process is not running');
    }
    throw err;
  }
}

/** Formats a startedAt ISO string into a human-readable uptime string. */
export function formatUptime(startedAt: string): string {
  const start = new Date(startedAt);
  if (Number.isNaN(start.getTime())) return 'unknown';
  const diff = Date.now() - start.getTime();
  if (diff < 0) return 'unknown';
  const hours = Math.floor(diff / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  return `${hours}h ${minutes}m`;
}

/** Parses the activeTask field from a raw status JSON record, if present and valid. */
function parseActiveTask(statusData: unknown): { taskName: string; startedAt: string } | null {
  if (!isRecord(statusData)) return null;
  const activeTask = statusData['activeTask'];
  if (!isRecord(activeTask)) return null;
  const taskName = activeTask['taskName'];
  const startedAt = activeTask['startedAt'];
  if (typeof taskName !== 'string' || typeof startedAt !== 'string') return null;
  return { taskName, startedAt };
}

/** Returns current daemon status information. */
export async function getDaemonStatus(): Promise<DaemonStatusInfo> {
  const paths = getPaths();
  const dataDir = paths.data;

  const { status, pid } = await checkPidStatus(dataDir);

  if (status === 'alive' && pid !== null) {
    const statusPath = join(dataDir, DAEMON_STATUS_FILENAME);
    const statusData = await safeReadJson<unknown>(statusPath);
    let uptime: string | null = null;
    let startedAt: string | null = null;
    if (isRecord(statusData) && typeof statusData['startedAt'] === 'string') {
      startedAt = statusData['startedAt'];
      uptime = formatUptime(startedAt);
    }
    // Read activeTask from the same single status-file read — avoids a TOCTOU window
    // where state and activeTask could disagree across two separate reads.
    const activeTask = parseActiveTask(statusData);
    return { state: 'running', pid, uptime, startedAt, activeTask };
  }

  if (status === 'stale') {
    return { state: 'stopped', pid: null, uptime: null, startedAt: null, activeTask: null };
  }

  // No PID file — check daemon-status.json to distinguish stopped vs not-started
  const statusPath = join(dataDir, DAEMON_STATUS_FILENAME);
  const statusData = await safeReadJson<unknown>(statusPath);
  if (statusData !== null) {
    return { state: 'stopped', pid: null, uptime: null, startedAt: null, activeTask: null };
  }

  return { state: 'not-started', pid: null, uptime: null, startedAt: null, activeTask: null };
}
