/** Atomic daemon state writer — writes daemon-status.json with all required fields always present. */
import { join } from 'node:path';
import type {
  DaemonStatusFile,
  DaemonLastError,
  DaemonLifecycleState,
  DaemonUsageState,
  DaemonTriggerState,
  DaemonActiveTaskState,
  DaemonBackendState,
  DispatchCycleResult,
} from '../types/index.js';
import { getPaths } from '../platform/index.js';
import { atomicWrite } from '../utils/index.js';

const DAEMON_STATUS_FILE = 'daemon-status.json';

/** Writes the full daemon status to daemon-status.json atomically. */
export async function writeDaemonStatus(state: DaemonStatusFile): Promise<void> {
  const targetPath = join(getPaths().data, DAEMON_STATUS_FILE);
  const content = JSON.stringify(state, null, 2);
  await atomicWrite(targetPath, content);
}

/** Helper: build a baseline status with all required fields present.
 *  pid defaults to null (absent/not-running); pass pid in overrides when known. */
function buildStatus(
  state: DaemonLifecycleState,
  startedAt: string | null,
  overrides: Partial<Omit<DaemonStatusFile, 'state' | 'startedAt' | 'updatedAt'>>,
): DaemonStatusFile {
  const now = new Date().toISOString();
  return {
    state,
    startedAt,
    lastPollAt: null,
    nextPollAt: null,
    usage: null,
    trigger: null,
    activeTask: null,
    lastError: null,
    lastErrorDetail: null,
    updatedAt: now,
    lastDispatchAt: null,
    cycleResult: null,
    queueDepth: 0,
    pid: null,
    backendState: null,
    ...overrides,
  };
}

/** Build a structured DaemonLastError from code, message, and optional recovery command. */
export function buildLastErrorDetail(
  code: string,
  message: string,
  recoveryCommand: string | null = null,
): DaemonLastError {
  return { code, message, recoveryCommand };
}

/** Write initial running state at daemon bootstrap. */
export async function writeRunningStatus(startedAt: string, pid: number): Promise<void> {
  await writeDaemonStatus(buildStatus('running', startedAt, { pid }));
}

/** Read and validate the existing daemon-status.json, returning null on any failure.
 *  Uses a dynamic import for Vitest module isolation compatibility.
 *  Validates that all required DaemonStatusFile fields are present so that the
 *  spread-into-output pattern never produces undefined for required fields. */
export async function readExistingStatus(targetPath: string): Promise<DaemonStatusFile | null> {
  try {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(targetPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'state' in (parsed as object) &&
      'startedAt' in (parsed as object) &&
      'queueDepth' in (parsed as object) &&
      'updatedAt' in (parsed as object) &&
      'lastPollAt' in (parsed as object) &&
      'nextPollAt' in (parsed as object) &&
      'lastDispatchAt' in (parsed as object) &&
      'cycleResult' in (parsed as object) &&
      'pid' in (parsed as object) &&
      'usage' in (parsed as object) &&
      'trigger' in (parsed as object) &&
      'activeTask' in (parsed as object) &&
      'lastError' in (parsed as object) &&
      'lastErrorDetail' in (parsed as object) &&
      'backendState' in (parsed as object)
    ) {
      return parsed as DaemonStatusFile;
    }
    return null;
  } catch {
    // File missing, unreadable, or unparseable — caller falls back to nulls
    return null;
  }
}

/** Write running state after a successful in-process provider restart (AC4 / Story 10.4).
 *  Reads the current daemon-status.json and updates only state + updatedAt, preserving
 *  live cycle metrics (lastPollAt, queueDepth, usage, trigger, etc.) that were accumulated
 *  before the restart. Unlike writeRunningStatus(), this does NOT reset all fields to null. */
export async function writeRestartCompletedStatus(startedAt: string, pid: number): Promise<void> {
  const targetPath = join(getPaths().data, DAEMON_STATUS_FILE);
  const existing = await readExistingStatus(targetPath);

  if (existing !== null) {
    // Preserve all existing fields, only update state and updatedAt
    await writeDaemonStatus({
      ...existing,
      state: 'running',
      startedAt,
      pid,
      updatedAt: new Date().toISOString(),
    });
  } else {
    // Fallback: clean bootstrap status (acceptable for first-restart or missing status file)
    await writeDaemonStatus(buildStatus('running', startedAt, { pid }));
  }
}

/** Write restarting state when a config-driven provider restart is in progress (AC4). */
export async function writeRestartingStatus(
  startedAt: string | null,
  pid: number | null,
): Promise<void> {
  await writeDaemonStatus(buildStatus('restarting', startedAt, { pid }));
}

/** Write stopping state when shutdown is initiated. */
export async function writeStoppingStatus(startedAt: string | null): Promise<void> {
  await writeDaemonStatus(buildStatus('stopping', startedAt, {}));
}

/** Write stopped state after graceful shutdown. */
export async function writeStoppedStatus(startedAt: string | null): Promise<void> {
  await writeDaemonStatus(buildStatus('stopped', startedAt, {}));
}

/** Write error state when a fatal polling error occurs. */
export async function writeErrorStatus(
  startedAt: string | null,
  lastError: string,
  lastErrorDetail?: DaemonLastError | null,
): Promise<void> {
  await writeDaemonStatus(
    buildStatus('error', startedAt, {
      lastError,
      lastErrorDetail: lastErrorDetail ?? null,
    }),
  );
}

/** Write stopped status on unexpected loop exit, preserving last-known usage data (Story 14.3).
 *  Reads the current daemon-status.json via readExistingStatus() and preserves accumulated
 *  metrics (usage, trigger, lastDispatchAt, cycleResult, queueDepth, backendState) from the
 *  last successful cycle.  Falls back to nulls when the status file is missing or corrupted (AC2). */
export async function writeUnexpectedExitStatus(
  startedAt: string,
  lastPollAt: string | null,
  lastError: string,
  lastErrorDetail: DaemonLastError,
): Promise<void> {
  const targetPath = join(getPaths().data, DAEMON_STATUS_FILE);
  const existing = await readExistingStatus(targetPath);

  if (existing !== null) {
    // AC1: Preserve usage, trigger, lastDispatchAt, cycleResult, queueDepth, backendState
    // AC3: Set pid to null, nextPollAt to null, activeTask to null
    await writeDaemonStatus({
      ...existing,
      state: 'stopped',
      startedAt,
      lastPollAt,
      nextPollAt: null,
      activeTask: null,
      lastError,
      lastErrorDetail,
      updatedAt: new Date().toISOString(),
      pid: null,
    });
  } else {
    // AC2: Fallback — no existing status to preserve
    await writeDaemonStatus({
      state: 'stopped',
      startedAt,
      lastPollAt,
      nextPollAt: null,
      usage: null,
      trigger: null,
      activeTask: null,
      lastError,
      lastErrorDetail,
      updatedAt: new Date().toISOString(),
      lastDispatchAt: null,
      cycleResult: null,
      queueDepth: 0,
      pid: null,
      backendState: null,
    });
  }
}

/** Write degraded state for non-fatal conditions where the daemon continues running.
 *  Preserves state as 'running' so CLI does not misreport daemon as errored/stopped. */
export async function writeDegradedStatus(
  startedAt: string | null,
  lastError: string,
  lastErrorDetail?: DaemonLastError | null,
): Promise<void> {
  await writeDaemonStatus(
    buildStatus('running', startedAt, {
      lastError,
      lastErrorDetail: lastErrorDetail ?? null,
    }),
  );
}

/** Write full cycle state after a poll/evaluate/dispatch cycle. */
export async function writeCycleStatus(opts: {
  startedAt: string | null;
  lastPollAt: string;
  nextPollAt: string;
  usage: DaemonUsageState | null;
  trigger: DaemonTriggerState | null;
  activeTask: DaemonActiveTaskState | null;
  lastError: string | null;
  lastErrorDetail?: DaemonLastError | null;
  lastDispatchAt: string | null;
  cycleResult: DispatchCycleResult | null;
  queueDepth: number;
  /** PID of the running daemon process. Preserves the pid set at bootstrap on each cycle write. */
  pid?: number | null;
  /** Backend state for container execution. null before first backend probe. */
  backendState?: DaemonBackendState | null;
}): Promise<void> {
  await writeDaemonStatus({
    state: 'running',
    startedAt: opts.startedAt,
    lastPollAt: opts.lastPollAt,
    nextPollAt: opts.nextPollAt,
    usage: opts.usage,
    trigger: opts.trigger,
    activeTask: opts.activeTask,
    lastError: opts.lastError,
    lastErrorDetail: opts.lastErrorDetail ?? null,
    updatedAt: new Date().toISOString(),
    lastDispatchAt: opts.lastDispatchAt,
    cycleResult: opts.cycleResult,
    queueDepth: opts.queueDepth,
    pid: opts.pid ?? null,
    backendState: opts.backendState ?? null,
  });
}
