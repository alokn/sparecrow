/** Status state snapshot — reads local files to build status data without daemon RPC or network calls. */
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getPaths } from '../../platform/index.js';
import { safeReadJson, isRecord, logger } from '../../utils/index.js';
import { checkPidStatus, DAEMON_STATUS_FILENAME, formatUptime } from '../../daemon/index.js';
// Re-export formatUptime so consumers of status-state can access it (it is now canonical in daemon module)
export { formatUptime };
import { asAuditRecord, asString } from './audit-parsing.js';
import { formatRelativeTime } from '../../ui/index.js';
export { formatRelativeTime };
import { loadConfig, resolveConfigFilePath } from '../../config/index.js';
import type {
  StatusSnapshot,
  StatusHealth,
  StatusUsage,
  StatusQueue,
  StatusActivity,
  StatusDispatchRow,
  DaemonState,
  AuthState,
  DaemonBackendState,
  DaemonLastError,
} from '../../types/index.js';
import { EventName } from '../../types/index.js';

const MAX_AUDIT_LINES = 1000;
const MAX_QUEUE_NAMES = 20;
const MAX_RECENT_DISPATCHES = 10;
const AUDIT_TAIL_CHUNK_BYTES = 16 * 1024;
const MAX_AUDIT_TAIL_BYTES = 512 * 1024;
const EPOCH_MILLISECONDS_THRESHOLD = 1_000_000_000_000;
const DEFAULT_CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json');
const CREDENTIALS_PATH_ENV = 'SPARECROW_CREDENTIALS_PATH';
const ACTIVITY_EVENTS = new Set<string>([
  EventName.TASK_COMPLETED,
  EventName.TASK_FAILED,
  EventName.TASK_REQUEUED,
]);

export async function loadStatusSnapshot(): Promise<StatusSnapshot> {
  const paths = getPaths();
  const [health, usage, queue, activity] = await Promise.all([
    loadHealth(paths.data),
    loadUsage(paths.data),
    loadQueue(paths.data),
    loadActivity(paths.logs),
  ]);
  const backendState = await loadBackendState(paths.data);

  // Load idleHoursSchedule from config — non-fatal if config unavailable.
  // Note: this config read runs on every `sparecrow status` invocation regardless of flags,
  // because `loadStatusSnapshot` does not receive CLI options. The idle hours schedule is shown
  // in --all view only, but the read is cheap (local YAML file) and non-blocking. If this becomes
  // a latency concern in future, consider threading `options` through or caching the config.
  let idleHoursSchedule: string | null = null;
  try {
    const configPath = resolveConfigFilePath(paths.config);
    const cfg = await loadConfig(configPath);
    if (cfg.trigger.idleHours.length > 0) {
      idleHoursSchedule = cfg.trigger.idleHours
        .map((e) => {
          const days = e.days && e.days.length > 0 ? ` (${e.days.join(', ')})` : ' daily';
          return `${e.start}-${e.end}${days}`;
        })
        .join(', ');
    }
  } catch {
    // config load failure is non-fatal for status display
  }

  return {
    health,
    usage: { ...usage, idleHoursSchedule },
    queue,
    activity,
    backendState,
  };
}

async function loadHealth(dataDir: string): Promise<StatusHealth> {
  const [daemonInfo, auth] = await Promise.all([getDaemonState(dataDir), getAuthState()]);

  // AC3: Prioritize daemon runtime auth failure signal from daemon-status.json.
  // When the daemon reports AUTH_TOKEN_EXPIRED/DAEMON_AUTH_FAILED at runtime, surface it even if
  // the credential file alone appears valid (e.g. stale refresh token stored on disk).
  const runtimeAuthState = await getDaemonRuntimeAuthState(dataDir);
  const effectiveAuth = runtimeAuthState !== null ? runtimeAuthState : auth;

  // Story 10.6: Read lastErrorDetail from daemon-status.json for health card display
  const lastErrorDetail = await loadLastErrorDetail(dataDir);

  return {
    daemon: daemonInfo.state,
    auth: effectiveAuth,
    pid: daemonInfo.pid,
    uptime: daemonInfo.uptime,
    lastErrorDetail,
  };
}

/** Reads daemon-status.json and returns a runtime-derived auth state if the daemon has reported
 *  an explicit auth failure. Returns null if no runtime auth failure is detected. */
export async function getDaemonRuntimeAuthState(dataDir: string): Promise<AuthState | null> {
  const statusPath = join(dataDir, 'daemon-status.json');
  const status = await safeReadJson<unknown>(statusPath);
  if (!isRecord(status)) return null;

  const lastErrorDetail = status['lastErrorDetail'];
  if (!isRecord(lastErrorDetail)) return null;

  const code = lastErrorDetail['code'];
  if (code === 'DAEMON_AUTH_FAILED' || code === 'AUTH_TOKEN_EXPIRED') {
    return 'expired';
  }
  if (code === 'AUTH_TOKEN_MISSING') {
    return 'missing';
  }
  return null;
}

/** Reads lastErrorDetail from daemon-status.json for health card rendering (Story 10.6 AC1). */
export async function loadLastErrorDetail(dataDir: string): Promise<DaemonLastError | null> {
  const statusPath = join(dataDir, 'daemon-status.json');
  const status = await safeReadJson<unknown>(statusPath);
  if (!isRecord(status)) return null;

  const detail = status['lastErrorDetail'];
  if (!isRecord(detail)) return null;

  const code = typeof detail['code'] === 'string' ? detail['code'] : null;
  const message = typeof detail['message'] === 'string' ? detail['message'] : null;
  if (code === null || message === null) return null;

  return {
    code,
    message,
    recoveryCommand:
      typeof detail['recoveryCommand'] === 'string' ? detail['recoveryCommand'] : null,
  };
}

export async function getDaemonState(dataDir: string): Promise<{
  state: DaemonState;
  pid: number | null;
  uptime: string | null;
}> {
  const statusPath = join(dataDir, DAEMON_STATUS_FILENAME);

  const { status, pid } = await checkPidStatus(dataDir);

  if (status === 'alive' && pid !== null) {
    const statusData = await safeReadJson<unknown>(statusPath);
    let uptime: string | null = null;
    if (isRecord(statusData) && typeof statusData['startedAt'] === 'string') {
      uptime = formatUptime(statusData['startedAt']);
    }
    // AC4: Read the actual state field from daemon-status.json so transient states like
    // 'restarting' are surfaced by `sparecrow status`. The PID being alive confirms the
    // daemon process is running; the state field reflects its current lifecycle phase.
    // Falls back to 'running' when daemon-status.json is missing or has no state field
    // (e.g. very early in bootstrap before the first status write).
    const daemonState: DaemonState =
      isRecord(statusData) &&
      typeof statusData['state'] === 'string' &&
      ['running', 'stopping', 'restarting', 'error'].includes(statusData['state'])
        ? (statusData['state'] as DaemonState)
        : 'running';
    return { state: daemonState, pid, uptime };
  }

  if (status === 'stale') {
    return { state: 'stopped', pid: null, uptime: null };
  }

  // No PID file — check if daemon-status.json exists (was started before)
  const statusData = await safeReadJson<unknown>(statusPath);
  if (statusData !== null) {
    return { state: 'stopped', pid: null, uptime: null };
  }

  return { state: 'not-started', pid: null, uptime: null };
}

export async function getAuthState(
  credentialsPath: string = getCredentialsPath(),
): Promise<AuthState> {
  try {
    const raw = await safeReadJson<unknown>(credentialsPath);

    if (raw === null) return 'missing';
    if (!isRecord(raw)) return 'unknown';

    // Check for access token in known credential shapes
    const hasTopLevel = typeof raw['accessToken'] === 'string' && raw['accessToken'].length > 0;
    const oauthSection = isRecord(raw['claudeAiOauth'])
      ? (raw['claudeAiOauth'] as Record<string, unknown>)
      : null;
    const hasNested =
      oauthSection !== null &&
      typeof oauthSection['accessToken'] === 'string' &&
      oauthSection['accessToken'].length > 0;

    if (!hasTopLevel && !hasNested) return 'missing';

    // Check expiry if available — use the section that has the token
    const tokenSection = hasNested ? oauthSection : raw;
    const expiresAt = tokenSection?.['expiresAt'];
    if (expiresAt === undefined || expiresAt === null) return 'unknown';

    const expiryMs = parseExpiresAt(expiresAt);
    if (expiryMs === null) return 'unknown';
    if (expiryMs < Date.now()) return 'expired';

    return 'valid';
  } catch (err: unknown) {
    void logger.debug('status.auth_check_error', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 'unknown';
  }
}

export async function loadUsage(dataDir: string): Promise<StatusUsage> {
  const statusPath = join(dataDir, 'daemon-status.json');
  const status = await safeReadJson<unknown>(statusPath);

  if (!isRecord(status)) {
    return emptyUsage();
  }

  const usage = status['usage'];
  if (!isRecord(usage)) {
    return emptyUsage();
  }

  // Read capacity fields from the trigger section (same status object — no second file read)
  const trigger = status['trigger'];
  let wastePotential: number | null = null;
  let effectiveReserve: number | null = null;
  let availableBudget: number | null = null;
  let isIdleHours: boolean | null = null;
  let rateHeadroom: boolean | null = null;
  let dispatchReason: string | null = null;
  let shouldDispatch: boolean | null = null;
  let perModelWaste: Array<{ model: string; waste: number }> | null = null;

  if (isRecord(trigger)) {
    wastePotential = asFiniteNumber(trigger['wastePotential']);
    effectiveReserve = asFiniteNumber(trigger['effectiveReserve']);
    availableBudget = asFiniteNumber(trigger['availableBudget']);
    isIdleHours = typeof trigger['isIdleHours'] === 'boolean' ? trigger['isIdleHours'] : null;
    rateHeadroom = typeof trigger['rateHeadroom'] === 'boolean' ? trigger['rateHeadroom'] : null;
    dispatchReason = asString(trigger['reason']);
    shouldDispatch =
      typeof trigger['shouldDispatch'] === 'boolean' ? trigger['shouldDispatch'] : null;
    if (Array.isArray(trigger['perModelWaste'])) {
      const raw = trigger['perModelWaste'] as unknown[];
      perModelWaste = raw
        .filter(
          (entry): entry is { model: string; waste: number } =>
            isRecord(entry) &&
            typeof entry['model'] === 'string' &&
            typeof entry['waste'] === 'number' &&
            Number.isFinite(entry['waste']),
        )
        .map((entry) => ({ model: entry.model, waste: entry.waste }));
    }
  }

  return {
    sessionUtilization: asFiniteNumber(usage['sessionUtilization']),
    weeklyUtilization: asFiniteNumber(usage['weeklyUtilization']),
    sessionResetsAt: asString(usage['sessionResetsAt']),
    weeklyResetsAt: asString(usage['weeklyResetsAt']),
    source: asString(usage['source']),
    confidence: asString(usage['confidence']),
    subscriptionTier: asString(usage['subscriptionTier']),
    degradedReason: asString(usage['degradedReason']),
    wastePotential,
    effectiveReserve,
    availableBudget,
    isIdleHours,
    rateHeadroom,
    dispatchReason,
    shouldDispatch,
    idleHoursSchedule: null, // populated in loadStatusSnapshot()
    perModelWaste,
    lastPolledAt: asString(status['lastPollAt']),
  };
}

function emptyUsage(): StatusUsage {
  return {
    sessionUtilization: null,
    weeklyUtilization: null,
    sessionResetsAt: null,
    weeklyResetsAt: null,
    source: null,
    confidence: null,
    subscriptionTier: null,
    degradedReason: null,
    wastePotential: null,
    effectiveReserve: null,
    availableBudget: null,
    isIdleHours: null,
    rateHeadroom: null,
    dispatchReason: null,
    shouldDispatch: null,
    idleHoursSchedule: null,
    perModelWaste: null,
    lastPolledAt: null,
  };
}

export async function loadQueue(dataDir: string): Promise<StatusQueue> {
  const queuePath = join(dataDir, 'queue.json');
  const raw = await safeReadJson<unknown>(queuePath);

  if (!isRecord(raw)) {
    return { pendingCount: 0, runningCount: 0, taskNames: [] };
  }

  const tasks = raw['tasks'];
  if (!Array.isArray(tasks)) {
    return { pendingCount: 0, runningCount: 0, taskNames: [] };
  }

  const pending = tasks.filter((t: unknown) => isRecord(t) && t['status'] === 'pending');
  // Story 10.9 AC4: Count in-progress tasks separately
  const running = tasks.filter((t: unknown) => isRecord(t) && t['status'] === 'in-progress');
  const names = pending
    .map((t: unknown) => (isRecord(t) ? asString(t['name']) : null))
    .filter((n): n is string => n !== null)
    .slice(0, MAX_QUEUE_NAMES);

  return { pendingCount: pending.length, runningCount: running.length, taskNames: names };
}

export async function loadBackendState(dataDir: string): Promise<DaemonBackendState | null> {
  const statusPath = join(dataDir, 'daemon-status.json');
  const status = await safeReadJson<unknown>(statusPath);

  if (!isRecord(status)) {
    return null;
  }

  const bs = status['backendState'];
  if (!isRecord(bs)) {
    return null;
  }

  return {
    name: typeof bs['name'] === 'string' ? bs['name'] : 'unknown',
    runtime: typeof bs['runtime'] === 'string' ? bs['runtime'] : null,
    version: typeof bs['version'] === 'string' ? bs['version'] : null,
    available: typeof bs['available'] === 'boolean' ? bs['available'] : false,
  };
}

export async function loadActivity(
  logsDir: string,
  now: Date = new Date(),
): Promise<StatusActivity> {
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  const logPath = join(logsDir, `audit-${today}.jsonl`);
  const yesterdayLogPath = join(logsDir, `audit-${yesterday}.jsonl`);

  let lines = await readLastLines(logPath, MAX_AUDIT_LINES);
  if (lines.length === 0) {
    lines = await readLastLines(yesterdayLogPath, MAX_AUDIT_LINES);
  }

  const dispatches: StatusDispatchRow[] = [];
  let dispatchCount = 0;
  let successCount = 0;

  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line);
      const record = asAuditRecord(parsed);
      if (record === null) continue;
      if (!ACTIVITY_EVENTS.has(record.event)) continue;

      if (record.event === EventName.TASK_COMPLETED || record.event === EventName.TASK_FAILED) {
        dispatchCount++;
        if (record.event === EventName.TASK_COMPLETED) successCount++;
      }

      const data = record.data;
      const ts = record.ts;

      const outcome: 'success' | 'failed' | 'retrying' =
        record.event === EventName.TASK_COMPLETED
          ? 'success'
          : record.event === EventName.TASK_REQUEUED
            ? 'retrying'
            : 'failed';

      // Story 10.6 AC2: Extract error code from audit entry data.error or top-level error field
      const errorCode = asString(data['error']) ?? asString(record.error);

      dispatches.push({
        outcome,
        task: asString(data['taskName']) ?? asString(data['name']) ?? 'unknown',
        relativeTime: ts ? formatRelativeTime(ts) : 'unknown',
        duration: asString(data['duration']) ?? '-',
        summary: asString(data['summary']) ?? '-',
        targetPath: asString(data['repoPath']) ?? asString(data['targetPath']) ?? '-',
        errorCode: outcome !== 'success' ? errorCode : null,
      });
    } catch {
      // Skip malformed JSONL lines
    }
  }

  const recentDispatches = dispatches.slice(-MAX_RECENT_DISPATCHES).reverse();

  return {
    dispatchCount,
    successRate: dispatchCount > 0 ? successCount / dispatchCount : null,
    dollarValueRecovered: null,
    recentDispatches,
  };
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

function getCredentialsPath(): string {
  const configuredPath = process.env[CREDENTIALS_PATH_ENV];
  if (typeof configuredPath === 'string' && configuredPath.trim().length > 0) {
    return configuredPath;
  }
  return DEFAULT_CREDENTIALS_PATH;
}

function parseExpiresAt(expiresAt: unknown): number | null {
  if (typeof expiresAt === 'number' && Number.isFinite(expiresAt)) {
    // Claude credentials may encode expiry in epoch seconds or epoch milliseconds.
    return expiresAt > EPOCH_MILLISECONDS_THRESHOLD ? expiresAt : expiresAt * 1000;
  }
  if (typeof expiresAt === 'string') {
    const numeric = Number(expiresAt);
    if (Number.isFinite(numeric) && expiresAt.trim() !== '') {
      return numeric > EPOCH_MILLISECONDS_THRESHOLD ? numeric : numeric * 1000;
    }
    const parsed = Date.parse(expiresAt);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

async function readLastLines(filePath: string, maxLines: number): Promise<string[]> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(filePath, 'r');
    const stats = await handle.stat();
    if (stats.size === 0) {
      return [];
    }

    let position = stats.size;
    let bytesReadTotal = 0;
    let newlineCount = 0;
    const chunks: Buffer[] = [];

    while (position > 0 && newlineCount <= maxLines && bytesReadTotal < MAX_AUDIT_TAIL_BYTES) {
      const remainingBudget = MAX_AUDIT_TAIL_BYTES - bytesReadTotal;
      const bytesToRead = Math.min(AUDIT_TAIL_CHUNK_BYTES, position, remainingBudget);
      const start = position - bytesToRead;
      const buffer = Buffer.allocUnsafe(bytesToRead);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, start);
      if (bytesRead <= 0) break;

      const chunk = buffer.subarray(0, bytesRead);
      chunks.unshift(chunk);
      position = start;
      bytesReadTotal += bytesRead;
      newlineCount += countNewlines(chunk);
    }

    if (chunks.length === 0) return [];

    const text = Buffer.concat(chunks).toString('utf-8');
    const parsedLines = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    // If we did not reach the beginning of the file, the first line may be truncated.
    const hasPartialFirstLine = position > 0 && !text.startsWith('\n') && !text.startsWith('\r\n');
    if (hasPartialFirstLine && parsedLines.length > 0) {
      parsedLines.shift();
    }

    return parsedLines.length > maxLines ? parsedLines.slice(-maxLines) : parsedLines;
  } catch {
    return [];
  } finally {
    await handle?.close();
  }
}

function countNewlines(value: Buffer): number {
  let count = 0;
  for (const byte of value) {
    if (byte === 10) count += 1;
  }
  return count;
}
