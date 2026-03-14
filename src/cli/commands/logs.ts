/** Logs command — view task execution history from audit JSONL records. */
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command } from 'commander';
import { isJsonMode } from '../index.js';
import { printJson, color } from '../../ui/index.js';
import { jsonOk, jsonError } from '../../types/index.js';
import { ScrowError, ErrorCode } from '../../errors/index.js';
import { getPaths } from '../../platform/index.js';
import {
  renderLogSummaryRow,
  renderTaskDetailCard,
  getRenderContext,
  humanizeErrorCode,
} from '../../ui/index.js';
import { queryLogs, parseSinceDuration } from './log-reader.js';
import { formatRelativeTime } from '../../ui/index.js';
import type {
  LogEntry,
  LogOutcome,
  LogQueryOptions,
  FailureSummaryEntry,
} from '../../types/index.js';

const STDOUT_MAX_BYTES = 10 * 1024; // 10 KB

/**
 * Formats a duration in milliseconds as "Xm Ys" or "-" if null.
 * Intentional divergence from `formatDuration` in `task-detail-card.ts` (which returns "N/A"):
 * the summary row variant uses dash-style formatting consistent with other summary columns.
 */
function formatDuration(ms: number | null): string {
  if (ms === null || ms < 0) return '-';
  const totalSec = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** Maps a LogOutcome to the LogSummaryRowOutcome accepted by renderLogSummaryRow. */
function toRowOutcome(outcome: LogOutcome): 'success' | 'failed' | 'retrying' {
  if (outcome === 'success') return 'success';
  if (outcome === 'retrying' || outcome === 'quota') return 'retrying';
  return 'failed';
}

/** Builds renderLogSummaryRow props from a LogEntry. */
function entryToSummaryRowProps(entry: LogEntry) {
  const base = {
    outcome: toRowOutcome(entry.outcome),
    taskName: entry.taskName,
    relativeTime: formatRelativeTime(entry.timestamp),
    duration: formatDuration(entry.durationMs),
    targetPath: entry.targetPath ?? '-',
    variant: 'summary' as const,
  };
  if (entry.outcome === 'success' && entry.summary) {
    return { ...base, summary: entry.summary };
  }
  if (entry.outcome !== 'success' && entry.summary) {
    return { ...base, failureReason: entry.summary };
  }
  if (entry.outcome !== 'success' && entry.error) {
    return { ...base, failureReason: entry.error };
  }
  // Intentional: entry.error is not surfaced for success entries in the summary row —
  // a non-null error on a succeeded task is diagnostic data, not a user-visible failure reason.
  return base;
}

/** Truncates a string to the last maxBytes bytes. */
function truncateToLastBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.length <= maxBytes) return text;
  const truncated = buf.subarray(buf.length - maxBytes).toString('utf-8');
  return `... [truncated]\n${truncated}`;
}

/** Checks whether a task output file exists for the given task ID. */
async function hasTaskOutput(taskOutputsDir: string, taskId: string | null): Promise<boolean> {
  if (!taskId) return false;
  try {
    await access(join(taskOutputsDir, `${taskId}.txt`));
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    // Unexpected I/O error (EACCES, EMFILE, etc.) — log and propagate
    throw err;
  }
}

/** Returns the first 8 characters of a task ID for compact display, or null if unavailable. */
function shortTaskId(taskId: string | null): string | null {
  if (!taskId) return null;
  return taskId.slice(0, 8);
}

/**
 * Renders the default summary mode using renderLogSummaryRow for consistent formatting.
 *
 * Invariant: `outputAvailability.length === entries.length`. Both arrays are built from the same
 * `entries` array via `Promise.all(entries.map(...))` in the caller and must always have the same
 * length. If they diverge, entries at indexes beyond `outputAvailability` will silently render as
 * 'Output: no' — callers must not break this invariant.
 */
function renderSummaryTable(
  entries: LogEntry[],
  total: number,
  successCount: number,
  failureCount: number,
  outputAvailability: boolean[],
): void {
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const row = renderLogSummaryRow(entryToSummaryRowProps(entry));
    if (outputAvailability[i]) {
      const shortId = shortTaskId(entry.taskId);
      const idSuffix = shortId ? ` (${shortId})` : '';
      process.stdout.write(`${row}  ${color.dim('Output:')} ${color.green('yes')}${idSuffix}\n`);
    } else {
      process.stdout.write(`${row}  ${color.dim('Output:')} ${color.dim('no')}\n`);
    }
  }

  process.stdout.write(
    color.dim(`${total} tasks | ${successCount} succeeded | ${failureCount} failed`) + '\n',
  );

  // Show hint when at least one entry has output available
  if (outputAvailability.some(Boolean)) {
    process.stdout.write(
      color.dim(
        "Hint: use 'sparecrow logs --output <task-id>' or 'sparecrow logs --task <name> --full' to view task output.",
      ) + '\n',
    );
  }
}

/** Renders verbose mode — summary row plus expanded detail block per entry. */
function renderVerbose(
  entries: LogEntry[],
  total: number,
  successCount: number,
  failureCount: number,
): void {
  for (const entry of entries) {
    const row = renderLogSummaryRow(entryToSummaryRowProps(entry));
    process.stdout.write(row + '\n');

    // Expanded detail block
    const fields: Array<[string, string]> = [
      ['Task ID', entry.taskId ?? 'N/A'],
      ['Event', entry.event],
      ['Exit Code', entry.exitCode !== null ? String(entry.exitCode) : 'N/A'],
      ['Error', entry.error ?? 'none'],
      ['Summary', entry.summary || 'none'],
      ['Provider', entry.provider ?? 'N/A'],
      ['Source', entry.source ?? 'N/A'],
    ];
    for (const [label, value] of fields) {
      process.stdout.write(`  ${color.dim(label + ':')} ${value}\n`);
    }

    if (entry.stdout) {
      const bounded = truncateToLastBytes(entry.stdout, STDOUT_MAX_BYTES);
      process.stdout.write(`  ${color.dim('Output:')}\n`);
      for (const line of bounded.split('\n')) {
        process.stdout.write(`    ${line}\n`);
      }
    }
    process.stdout.write('\n');
  }

  process.stdout.write(
    color.dim(`${total} tasks | ${successCount} succeeded | ${failureCount} failed`) + '\n',
  );
}

/** Renders a bordered detail card for a single task entry using TaskDetailCard component. */
function renderDetailCard(entry: LogEntry): void {
  const card = renderTaskDetailCard({
    timestamp: entry.timestamp,
    outcome: entry.outcome,
    taskName: entry.taskName,
    taskId: entry.taskId,
    targetPath: entry.targetPath,
    durationMs: entry.durationMs,
    exitCode: entry.exitCode,
    tokensIn: entry.tokensIn,
    tokensOut: entry.tokensOut,
    provider: entry.provider,
    source: entry.source,
    error: entry.error,
    summary: entry.summary,
  });
  process.stdout.write(card + '\n');
}

/** Story 10.6 AC4: Renders failure summary footer grouped by humanized error reason.
 *  `failureSummary[].reason` holds the raw error code; humanizeErrorCode is applied here
 *  in the rendering layer (not in the data-access layer). */
function renderFailureSummaryFooter(failureSummary: FailureSummaryEntry[], verbose: boolean): void {
  if (failureSummary.length === 0) return;

  const totalFailures = failureSummary.reduce((sum, f) => sum + f.count, 0);
  const parts = failureSummary.map((f) => {
    const humanMsg = humanizeErrorCode(f.reason);
    return verbose ? `${f.count} ${humanMsg} (${f.code})` : `${f.count} ${humanMsg}`;
  });

  process.stdout.write(`\n${totalFailures} failures: ${parts.join(', ')}\n`);
  // Story 10.6 AC6: Hints suppressed in non-TTY output (piped mode)
  const ctx = getRenderContext();
  if (ctx.isTTY) {
    process.stdout.write(color.dim("  Hint: run 'sparecrow doctor' to check system health") + '\n');
  }
}

export function registerLogs(program: Command): void {
  program
    .command('logs')
    .description('view execution history and audit log')
    .option('--since <date>', 'filter by date (ISO 8601) or relative duration (7d, 24h, 30m)')
    .option('--count <n>', 'number of entries to show', '20')
    .option('--verbose', 'show full entry details')
    .option('--task <id>', 'filter by task name or ID')
    .option('--full', 'show complete log without truncation')
    .option('--output <taskId>', 'print full output for a specific task')
    .option('--outcome <types>', 'filter by outcome type (failed, success, retrying, quota)')
    .option(
      '--failures',
      'show only failed and retrying entries (alias for --outcome failed,retrying)',
    )
    .action(
      async (options: {
        since?: string;
        count?: string;
        verbose?: boolean;
        task?: string;
        full?: boolean;
        output?: string;
        outcome?: string;
        failures?: boolean;
      }) => {
        try {
          // --output <taskId>: read and display persisted task output file
          if (options.output) {
            const taskId = options.output;
            // Validate taskId is a UUID to prevent path traversal attacks.
            // node:path join() resolves '..' segments, so without validation a user-supplied
            // taskId like '../daemon-status' would read files outside task-outputs/.
            const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            if (!UUID_REGEX.test(taskId)) {
              const message = `Invalid task ID format: "${taskId}". Must be a UUID.`;
              if (isJsonMode()) {
                printJson(jsonError(ErrorCode.TASK_OUTPUT_NOT_FOUND, message));
                return;
              }
              process.stderr.write(`Error: ${message}\n`);
              process.exitCode = 1;
              return;
            }
            const outputPath = join(getPaths().taskOutputs, `${taskId}.txt`);
            try {
              const content = await readFile(outputPath, 'utf-8');
              if (isJsonMode()) {
                printJson(jsonOk({ taskId, output: content }));
                return;
              }
              process.stdout.write(content + '\n');
              return;
            } catch (err) {
              const code = (err as NodeJS.ErrnoException).code;
              if (code === 'ENOENT') {
                const message = `No output found for task ${taskId}`;
                if (isJsonMode()) {
                  printJson(jsonError(ErrorCode.TASK_OUTPUT_NOT_FOUND, message));
                  return;
                }
                process.stderr.write(`Error: ${message}\n`);
                process.exitCode = 1;
                return;
              }
              throw err;
            }
          }

          // Input validation: --count
          const rawCount = options.count ?? '20';
          const countNum = parseInt(rawCount, 10);
          if (isNaN(countNum) || countNum < 0 || String(countNum) !== rawCount) {
            throw new ScrowError(
              ErrorCode.LOGS_INVALID_FILTER,
              `Invalid --count value: "${rawCount}". Must be a non-negative integer.`,
            );
          }

          // Input validation: --since
          let sinceDate: Date | undefined;
          if (options.since) {
            sinceDate = parseSinceDuration(options.since);
          }

          // Story 10.6 AC4: Parse --outcome and --failures flags
          let outcomeFilter: LogOutcome[] | undefined;
          if (options.failures) {
            outcomeFilter = ['failed', 'retrying'];
          } else if (options.outcome) {
            const validOutcomes = new Set<string>(['failed', 'success', 'retrying', 'quota']);
            const parts = options.outcome.split(',').map((s) => s.trim());
            const invalid = parts.filter((p) => !validOutcomes.has(p));
            if (invalid.length > 0) {
              throw new ScrowError(
                ErrorCode.LOGS_INVALID_FILTER,
                `Invalid --outcome value(s): ${invalid.join(', ')}. Valid values: failed, success, retrying, quota`,
              );
            }
            outcomeFilter = parts as LogOutcome[];
          }

          const logsDir = getPaths().logs;
          const queryOptions: LogQueryOptions = {
            logsDir,
            count: countNum,
            ...(sinceDate !== undefined ? { since: sinceDate } : {}),
            ...(options.task !== undefined ? { taskFilter: options.task } : {}),
            ...(options.verbose !== undefined ? { verbose: options.verbose } : {}),
            ...(options.full !== undefined ? { full: options.full } : {}),
            ...(outcomeFilter !== undefined ? { outcomeFilter } : {}),
          };
          const result = await queryLogs(queryOptions);

          const { entries, total, successCount, failureCount, failureSummary } = result;

          // JSON mode
          if (isJsonMode()) {
            // Story 10.6 AC7: Include failureSummary in JSON output
            printJson(jsonOk({ entries, total, successCount, failureCount, failureSummary }));
            return;
          }

          // Empty state
          if (entries.length === 0) {
            process.stdout.write('No execution history found.\n');
            process.stdout.write('Hint: Tasks are logged after the daemon dispatches them.\n');
            return;
          }

          // --task --full: raw transcript
          if (options.task && options.full) {
            const entry = entries[entries.length - 1] ?? null;
            if (!entry || !entry.stdout) {
              process.stdout.write('No transcript available for this execution.\n');
            } else {
              process.stdout.write(entry.stdout + '\n');
            }
            return;
          }

          // --task: bordered detail card (most recent match)
          if (options.task) {
            const entry = entries[entries.length - 1] ?? null;
            if (entry) renderDetailCard(entry);
            return;
          }

          // --verbose: expanded detail blocks
          if (options.verbose) {
            renderVerbose(entries, total, successCount, failureCount);
            // Story 10.6: Failure summary footer in verbose mode too
            renderFailureSummaryFooter(failureSummary, true);
            return;
          }

          // Default: summary rows using renderLogSummaryRow for consistent formatting (AC7)
          const taskOutputsDir = getPaths().taskOutputs;
          const outputAvailability = await Promise.all(
            entries.map((e) => hasTaskOutput(taskOutputsDir, e.taskId)),
          );
          renderSummaryTable(entries, total, successCount, failureCount, outputAvailability);

          // Story 10.6 AC4: Failure summary footer when failures are present
          renderFailureSummaryFooter(failureSummary, Boolean(options.verbose));
        } catch (err) {
          const typedErr =
            err instanceof ScrowError
              ? err
              : new ScrowError(
                  ErrorCode.LOGS_INVALID_FILTER,
                  err instanceof Error ? err.message : String(err),
                  err instanceof Error ? err : undefined,
                );

          if (isJsonMode()) {
            if (typedErr.code === ErrorCode.TASK_OUTPUT_NOT_FOUND) {
              printJson(jsonError(typedErr.code, typedErr.message));
            } else {
              printJson(
                jsonError(
                  typedErr.code,
                  `${typedErr.message} — Use a positive integer for --count and an ISO date or duration (7d, 24h) for --since. Run: sparecrow logs --help`,
                ),
              );
            }
            return;
          }

          process.stderr.write(
            `Error: ${typedErr.message}\n  -> Check filter values. Run: sparecrow logs --help for usage\n`,
          );
          process.exitCode = 1;
        }
      },
    );
}
