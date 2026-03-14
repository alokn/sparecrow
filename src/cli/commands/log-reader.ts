/** Audit log query engine — file discovery, JSONL parsing, filtering for sparecrow logs. */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../../utils/index.js';
import { AUDIT_LOG_FILENAME_REGEX } from '../../utils/index.js';
import { ScrowError, ErrorCode } from '../../errors/index.js';
import { EventName } from '../../types/index.js';
import { asAuditRecord, asNumber, asString } from './audit-parsing.js';
import type {
  LogEntry,
  LogQueryOptions,
  LogQueryResult,
  LogOutcome,
  FailureSummaryEntry,
} from '../../types/index.js';

/** Task-related events included in sparecrow logs output — matches status-state.ts ACTIVITY_EVENTS pattern. */
const TASK_EVENTS = new Set<string>([
  EventName.TASK_COMPLETED,
  EventName.TASK_FAILED,
  EventName.DISPATCH_QUOTA_EXHAUSTED,
  EventName.TASK_REQUEUED,
]);

/** Discovers audit-YYYY-MM-DD.jsonl files in logsDir, optionally filtering by since date.
 *  Returns file paths sorted newest-first. */
export async function discoverLogFiles(logsDir: string, since?: Date): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(logsDir);
  } catch {
    return [];
  }

  const matched: Array<{ path: string; date: string }> = [];

  for (const name of entries) {
    const m = AUDIT_LOG_FILENAME_REGEX.exec(name);
    if (!m || !m[1]) continue;
    const dateStr = m[1];
    // If since is provided, skip files whose date is before the since date (date string comparison works for YYYY-MM-DD)
    if (since !== undefined) {
      const fileDate = new Date(`${dateStr}T00:00:00.000Z`);
      // Include files from the same day as `since` (i.e. fileDate >= since day)
      const sinceDay = new Date(`${since.toISOString().slice(0, 10)}T00:00:00.000Z`);
      if (fileDate < sinceDay) continue;
    }
    matched.push({ path: join(logsDir, name), date: dateStr });
  }

  // Sort newest-first (descending by date string — lexicographic works for ISO dates)
  matched.sort((a, b) => b.date.localeCompare(a.date));
  return matched.map((m) => m.path);
}

/** Maps an event string to a log outcome. */
function eventToOutcome(event: string): LogOutcome {
  if (event === EventName.TASK_COMPLETED) return 'success';
  if (event === EventName.TASK_FAILED) return 'failed';
  if (event === EventName.DISPATCH_QUOTA_EXHAUSTED) return 'quota';
  if (event === EventName.TASK_REQUEUED) return 'retrying';
  return 'unknown';
}

/** Parses a single JSONL audit log file into LogEntry objects.
 *  Malformed lines are silently skipped with a debug log. */
export async function parseLogFile(filePath: string): Promise<LogEntry[]> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf-8');
  } catch {
    return [];
  }

  const lines = text.split('\n');
  const entries: LogEntry[] = [];

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const rawLine = lines[lineNum];
    if (rawLine === undefined) continue;
    const line = rawLine.trim();
    if (line.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      const record = asAuditRecord(parsed);
      if (record === null) {
        void logger.debug('logs.parse.skip', { file: filePath, line: lineNum + 1 });
        continue;
      }

      const event = record.event;

      // Only include task-related events — skip daemon lifecycle noise (daemon.started, usage.polled, etc.)
      if (!TASK_EVENTS.has(event)) continue;

      const data = record.data;

      const entry: LogEntry = {
        timestamp: record.ts,
        level: record.level,
        event,
        outcome: eventToOutcome(event),
        taskName: asString(data['taskName']) ?? asString(data['name']) ?? 'unknown',
        taskId: asString(data['taskId']),
        durationMs: asNumber(data['durationMs']),
        exitCode: asNumber(data['exitCode']),
        summary: asString(data['summary']) ?? '',
        targetPath: asString(data['targetPath']),
        stdout: asString(data['stdout']),
        stderr: asString(data['stderr']),
        tokensIn: asNumber(data['tokensIn']),
        tokensOut: asNumber(data['tokensOut']),
        provider: record.provider,
        source: record.source,
        confidence: record.confidence,
        error: record.error ?? asString(data['error']),
      };
      entries.push(entry);
    } catch {
      void logger.debug('logs.parse.skip', { file: filePath, line: lineNum + 1 });
    }
  }

  return entries;
}

/** Parses a relative duration string (7d, 24h, 30m) or ISO 8601 date string into a Date.
 *  Throws ScrowError(LOGS_INVALID_FILTER) on invalid input. */
export function parseSinceDuration(input: string): Date {
  if (!input || input.trim().length === 0) {
    throw new ScrowError(ErrorCode.LOGS_INVALID_FILTER, `Invalid --since value: "${input}"`);
  }

  const trimmed = input.trim();

  // Relative duration: Nd, Nh, Nm (N must be a positive integer)
  const durationMatch = /^(\d+)(d|h|m)$/.exec(trimmed);
  if (durationMatch) {
    const nStr = durationMatch[1] ?? '';
    const unit = durationMatch[2] ?? '';
    const n = parseInt(nStr, 10);
    if (n <= 0) {
      throw new ScrowError(ErrorCode.LOGS_INVALID_FILTER, `Invalid --since value: "${input}"`);
    }
    const now = Date.now();
    let ms: number;
    if (unit === 'd') ms = n * 24 * 60 * 60 * 1000;
    else if (unit === 'h') ms = n * 60 * 60 * 1000;
    else ms = n * 60 * 1000;
    return new Date(now - ms);
  }

  // ISO 8601 date string — require YYYY-MM-DD format to reject nonsensical inputs like "1", "99999"
  const iso8601DateRegex = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;
  if (!iso8601DateRegex.test(trimmed)) {
    throw new ScrowError(ErrorCode.LOGS_INVALID_FILTER, `Invalid --since value: "${input}"`);
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throw new ScrowError(ErrorCode.LOGS_INVALID_FILTER, `Invalid --since value: "${input}"`);
  }

  return new Date(parsed);
}

/** Orchestrates log discovery, parsing, filtering, and aggregation. */
export async function queryLogs(options: LogQueryOptions): Promise<LogQueryResult> {
  const { logsDir, since, count, taskFilter, outcomeFilter } = options;

  const files = await discoverLogFiles(logsDir, since);

  const allEntries: LogEntry[] = [];
  for (const file of files) {
    const entries = await parseLogFile(file);
    allEntries.push(...entries);
  }

  // Apply since filter on the timestamp level (file-level filter already handled dates, but intra-day filtering needs timestamp comparison)
  let filtered = since ? allEntries.filter((e) => new Date(e.timestamp) >= since) : allEntries;

  // Apply task filter (case-insensitive match on taskName or taskId)
  if (taskFilter) {
    const lower = taskFilter.toLowerCase();
    filtered = filtered.filter(
      (e) =>
        e.taskName.toLowerCase().includes(lower) ||
        (e.taskId !== null && e.taskId.toLowerCase().includes(lower)),
    );
  }

  // Story 10.6 AC4: Apply outcome filter
  if (outcomeFilter && outcomeFilter.length > 0) {
    const outcomeSet = new Set(outcomeFilter);
    filtered = filtered.filter((e) => outcomeSet.has(e.outcome));
  }

  // Compute aggregates before slice
  const total = filtered.length;
  const successCount = filtered.filter((e) => e.outcome === 'success').length;
  const failureCount = filtered.filter((e) => e.outcome === 'failed').length;

  // Story 10.6: Build failure summary grouped by error reason
  const failureSummary = buildFailureSummary(filtered);

  let entries: LogEntry[];
  if (taskFilter) {
    // Task filter: return ALL matching entries sorted chronologically (oldest first)
    entries = filtered.sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
  } else {
    // Default: sort descending (newest first), then slice to count
    entries = filtered
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, count);
  }

  return { entries, total, successCount, failureCount, failureSummary };
}

/** Builds a failure summary grouped by error code from filtered entries.
 *  The `reason` field stores the raw error code — callers in the rendering layer
 *  should apply `humanizeErrorCode(reason)` for human-readable display. */
function buildFailureSummary(entries: LogEntry[]): FailureSummaryEntry[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.outcome === 'failed' || entry.outcome === 'retrying') {
      const code = entry.error ?? 'UNKNOWN';
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries()).map(([code, count]) => ({
    reason: code,
    code,
    count,
  }));
}

/** Maximum number of lines to scan backward for recent task failures. */
const MAX_FAILURE_SCAN_LINES = 200;

/**
 * Scans today's audit file backward for the most recent TASK_FAILED event per task name.
 * Returns a map of taskName to error code. Bounded to MAX_FAILURE_SCAN_LINES for performance.
 * Returns empty map on any I/O error (graceful degradation for queue list display).
 */
export async function getRecentTaskFailures(
  logsDir: string,
  taskNames: string[],
  now: Date = new Date(),
): Promise<Map<string, string>> {
  if (taskNames.length === 0) return new Map();

  const result = new Map<string, string>();
  const remaining = new Set(taskNames);

  const today = now.toISOString().slice(0, 10);
  const logPath = join(logsDir, `audit-${today}.jsonl`);

  let text: string;
  try {
    text = await readFile(logPath, 'utf-8');
  } catch {
    return result;
  }

  const lines = text.split('\n');
  let scanned = 0;

  // Scan backward from end
  for (
    let i = lines.length - 1;
    i >= 0 && remaining.size > 0 && scanned < MAX_FAILURE_SCAN_LINES;
    i--
  ) {
    const rawLine = lines[i];
    if (rawLine === undefined) continue;
    const line = rawLine.trim();
    if (line.length === 0) continue;
    scanned++;

    try {
      const parsed: unknown = JSON.parse(line);
      const record = asAuditRecord(parsed);
      if (record === null) continue;
      if (record.event !== EventName.TASK_FAILED) continue;

      const data = record.data;
      const taskName = asString(data['taskName']) ?? asString(data['name']);
      if (taskName === null || !remaining.has(taskName)) continue;

      const errorCode = asString(data['error']) ?? asString(record.error) ?? 'UNKNOWN';
      result.set(taskName, errorCode);
      remaining.delete(taskName);
    } catch {
      // Skip malformed lines
    }
  }

  return result;
}
