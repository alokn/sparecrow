/** Results command — list and view .scrow/ result artifacts across all repos. */
import type { Command } from 'commander';
import Table from 'cli-table3';
import { isJsonMode } from '../index.js';
import { printJson, color } from '../../ui/index.js';
import { jsonOk, jsonError } from '../../types/index.js';
import type { ActionPipelineResult } from '../../types/index.js';
import { ScrowError, ErrorCode } from '../../errors/index.js';
import { getPaths } from '../../platform/index.js';
import {
  discoverRepoPaths,
  discoverResultFiles,
  filterResults,
  findResultByTaskId,
  getLatestResult,
  toRelativeHomePath,
  readActionCompanion,
} from './results-reader.js';
import type { ResultEntry } from './results-reader.js';

/**
 * Formats a completed_at ISO string for display.
 * Times are shown in UTC (matching the ISO 8601 audit log timestamps stored by the daemon)
 * with a trailing "Z" to make the timezone explicit.
 */
function formatCompletedAt(isoString: string): string {
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return isoString;
    // Format as "YYYY-MM-DD HH:MMZ" — UTC with explicit Z suffix
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    const hh = String(date.getUTCHours()).padStart(2, '0');
    const min = String(date.getUTCMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${min}Z`;
  } catch {
    return isoString;
  }
}

/**
 * Formats action summary for table column from companion data.
 * Returns "N ok / N fail / N skip" combining non-zero counters, "-" when no companion.
 */
function formatActionsColumn(companion: ActionPipelineResult | null): string {
  if (companion === null) return '-';
  const ok = companion.actions_executed;
  const fail = companion.actions_failed;
  const skip = companion.actions_skipped;
  const parts: string[] = [];
  if (ok > 0 || (fail === 0 && skip === 0)) parts.push(`${ok} ok`);
  if (fail > 0) parts.push(`${fail} fail`);
  if (skip > 0) parts.push(`${skip} skip`);
  return parts.join(' / ');
}

/** Renders the result list as a CLI table. Reads companion files in parallel (O(N) I/O). */
async function renderTableAsync(entries: ResultEntry[]): Promise<string> {
  const table = new Table({
    head: ['TASK ID', 'TEMPLATE', 'REPO', 'COMPLETED', 'FILE', 'ACTIONS'],
    style: { head: [], border: [] },
  });

  // Read all companion files in parallel
  const companions = await Promise.all(entries.map((e) => readActionCompanion(e.filePath)));

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const companion = companions[i] ?? null;
    const fm = entry.frontmatter;
    const repoDisplay = toRelativeHomePath(fm.repo);
    const fileDisplay = toRelativeHomePath(entry.filePath);
    table.push([
      fm.task_id,
      fm.template,
      repoDisplay,
      formatCompletedAt(fm.completed_at),
      fileDisplay,
      formatActionsColumn(companion),
    ]);
  }

  return table.toString();
}

/** Converts a ResultEntry to JSON-serializable format with optional companion data. */
function entryToJson(
  entry: ResultEntry,
  companion: ActionPipelineResult | null = null,
): Record<string, unknown> {
  return {
    task_id: entry.frontmatter.task_id,
    template: entry.frontmatter.template,
    repo: entry.frontmatter.repo,
    dispatched_at: entry.frontmatter.dispatched_at,
    completed_at: entry.frontmatter.completed_at,
    exit_code: entry.frontmatter.exit_code,
    branch: entry.frontmatter.branch,
    file_path: entry.filePath,
    actions: companion,
  };
}

/**
 * Formats action outcomes for single-result view (AC5).
 * Returns null when no companion data exists.
 */
function formatActionOutcomes(companion: ActionPipelineResult): string {
  if (companion.actions_requested === 0) return '';
  const lines: string[] = [`\nActions (${companion.actions_requested} requested):`];
  for (const r of companion.results) {
    const icon = r.status === 'success' ? '\u2713' : r.status === 'failed' ? '\u2717' : '-';
    const detail =
      r.status === 'success' && r.url
        ? `  ${r.url}`
        : r.error
          ? `  ${r.error}`
          : r.reason
            ? `  ${r.reason}`
            : '';
    lines.push(`  ${icon} ${r.type.padEnd(14)} ${r.status}${detail}`);
  }
  return lines.join('\n') + '\n';
}

export function registerResults(program: Command): void {
  program
    .command('results')
    .description('list and view task result artifacts across repos')
    .option('--repo <path>', 'filter results by repo path')
    .option('--template <name>', 'filter results by template name')
    .option('--latest', 'view the most recent result')
    .option('--task <id>', 'view result for a specific task ID')
    .action(
      async (options: { repo?: string; template?: string; latest?: boolean; task?: string }) => {
        try {
          const paths = getPaths();
          const jsonMode = isJsonMode();

          // Step 1: Discover repos from audit logs (AC7)
          const repoPaths = await discoverRepoPaths(paths.logs);

          // If --repo is specified, include it in the discovery set even if not in audit logs
          if (options.repo) {
            const normalizedRepo = options.repo.replace(/\/+$/, '');
            if (!repoPaths.includes(normalizedRepo)) {
              repoPaths.push(normalizedRepo);
            }
          }

          // Step 2: Discover all result files across repos
          const allResults = await discoverResultFiles(repoPaths);

          // Step 3: Handle --task mode — view specific result (AC5).
          // Apply --repo and --template filters first so that combined flags work correctly.
          if (options.task) {
            const filteredForTask = filterResults(allResults, {
              repo: options.repo,
              template: options.template,
            });
            const match = findResultByTaskId(filteredForTask, options.task);
            if (!match) {
              const message = `No result found for task ID "${options.task}"`;
              if (jsonMode) {
                printJson(jsonError(ErrorCode.RESULTS_NOT_FOUND, message));
                return;
              }
              process.stderr.write(`Error: ${message}\n`);
              process.exitCode = 1;
              return;
            }

            const matchCompanion = await readActionCompanion(match.filePath);

            if (jsonMode) {
              printJson(jsonOk(entryToJson(match, matchCompanion)));
              return;
            }

            process.stdout.write(match.rawContent);
            if (matchCompanion !== null) {
              process.stdout.write(formatActionOutcomes(matchCompanion));
            }
            return;
          }

          // Step 4: Handle --latest mode (AC4)
          if (options.latest) {
            // Apply filters before selecting latest
            const filtered = filterResults(allResults, {
              repo: options.repo,
              template: options.template,
            });
            const latest = getLatestResult(filtered);
            if (!latest) {
              const message = 'No results found. Try running a task first.';
              if (jsonMode) {
                printJson(jsonError(ErrorCode.RESULTS_NOT_FOUND, message));
                return;
              }
              process.stdout.write(message + '\n');
              return;
            }

            const latestCompanion = await readActionCompanion(latest.filePath);

            if (jsonMode) {
              printJson(jsonOk(entryToJson(latest, latestCompanion)));
              return;
            }

            process.stdout.write(latest.rawContent);
            if (latestCompanion !== null) {
              process.stdout.write(formatActionOutcomes(latestCompanion));
            }
            return;
          }

          // Step 5: Apply filters (AC2, AC3)
          const filtered = filterResults(allResults, {
            repo: options.repo,
            template: options.template,
          });

          // Step 6: Handle empty state (AC8)
          if (filtered.length === 0) {
            const message = 'No results found. Try running a task first.';
            if (jsonMode) {
              printJson(jsonOk({ results: [], count: 0 }));
              return;
            }
            process.stdout.write(message + '\n');
            process.stdout.write(
              color.dim(
                "Hint: use 'sparecrow queue add --template <name> --target <path>' to queue a task.",
              ) + '\n',
            );
            return;
          }

          // Step 7: JSON output (AC6) — read companion files for all entries in parallel
          if (jsonMode) {
            const companions = await Promise.all(
              filtered.map((e) => readActionCompanion(e.filePath)),
            );
            printJson(
              jsonOk({
                results: filtered.map((e, i) => entryToJson(e, companions[i] ?? null)),
                count: filtered.length,
              }),
            );
            return;
          }

          // Step 8: Default table output (AC1)
          process.stdout.write((await renderTableAsync(filtered)) + '\n');
          process.stdout.write(color.dim(`${filtered.length} result(s) found`) + '\n');
        } catch (err) {
          const typedErr =
            err instanceof ScrowError
              ? err
              : new ScrowError(
                  ErrorCode.RESULTS_NOT_FOUND,
                  err instanceof Error ? err.message : String(err),
                  err instanceof Error ? err : undefined,
                );

          if (isJsonMode()) {
            printJson(jsonError(typedErr.code, typedErr.message));
            return;
          }

          process.stderr.write(`Error: ${typedErr.message}\n`);
          process.exitCode = 1;
        }
      },
    );
}
