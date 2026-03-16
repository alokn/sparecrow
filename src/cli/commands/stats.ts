/** Stats command — view personal usage analytics from audit log history. */
import type { Command } from 'commander';
import { isJsonMode } from '../index.js';
import { printJson, color } from '../../ui/index.js';
import { jsonOk, jsonError } from '../../types/index.js';
import { getPaths } from '../../platform/index.js';
import { ScrowError, ErrorCode } from '../../errors/index.js';
import { computeStats } from './stats-data.js';
import type { StatsData } from './stats-data.js';

/** Formats milliseconds as a human-readable duration string. */
function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const hours = Math.floor(minutes / 60);
  const seconds = totalSec % 60;
  const remainMinutes = minutes % 60;
  if (hours > 0) return `${hours}h ${remainMinutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** Renders the human-mode stats output. */
function renderHumanStats(data: StatsData): void {
  if (data.totalTasks === 0) {
    process.stdout.write('No task executions found.\n');
    process.stdout.write(
      'Hint: Tasks are logged after the daemon dispatches them. Run: sparecrow daemon start\n',
    );
    return;
  }

  process.stdout.write(color.bold('Usage Statistics') + '\n');
  process.stdout.write(
    color.dim(`Period: ${data.periodStart.slice(0, 10)} — ${data.periodEnd.slice(0, 10)}`) + '\n\n',
  );

  process.stdout.write(`Total tasks:      ${data.totalTasks}\n`);
  process.stdout.write(`  Succeeded:      ${color.green(String(data.successCount))}\n`);
  process.stdout.write(`  Failed:         ${color.red(String(data.failureCount))}\n`);
  if (data.retryCount > 0) {
    process.stdout.write(`  Retried/Quota:  ${color.yellow(String(data.retryCount))}\n`);
  }
  process.stdout.write(`Success rate:     ${data.hasTasks ? `${data.successRate}%` : 'N/A'}\n`);
  process.stdout.write(`Total duration:   ${formatMs(data.totalDurationMs)}\n`);
  process.stdout.write(
    `Avg duration:     ${data.avgDurationMs > 0 ? formatMs(data.avgDurationMs) : 'N/A'}\n`,
  );
  process.stdout.write(`Active days:      ${data.activeDays}\n`);
  process.stdout.write(
    `Avg tasks/day:    ${data.activeDays > 0 ? String(data.avgTasksPerDay) : 'N/A'}\n`,
  );

  if (data.taskBreakdown.length > 0) {
    process.stdout.write(color.bold('\nTask Breakdown') + '\n');
    for (const row of data.taskBreakdown) {
      const successPart = row.succeeded > 0 ? color.green(`${row.succeeded} ok`) : '';
      const failPart = row.failed > 0 ? color.red(`${row.failed} fail`) : '';
      const parts = [successPart, failPart].filter(Boolean).join(', ');
      process.stdout.write(`  ${row.taskName}: ${row.total} (${parts})\n`);
    }
  }
}

export function registerStats(program: Command): void {
  program
    .command('stats')
    .description('view personal usage analytics')
    .option('--since <duration>', 'filter period (7d, 24h, 30d, or ISO 8601 date)')
    .action(async (options: { since?: string }) => {
      const paths = getPaths();
      const jsonMode = isJsonMode();

      try {
        const statsOpts = {
          logsDir: paths.logs,
          ...(options.since !== undefined ? { since: options.since } : {}),
        };
        const statsData = await computeStats(statsOpts);

        if (jsonMode) {
          printJson(jsonOk(statsData));
          return;
        }

        renderHumanStats(statsData);
      } catch (err) {
        if (err instanceof ScrowError) {
          if (jsonMode) {
            printJson(jsonError(err.code, err.message));
            return;
          }
          process.stderr.write(`Error: ${err.message}\n`);
          process.exitCode = 1;
          return;
        }

        const typedErr = new ScrowError(
          ErrorCode.STATS_COMPUTATION_FAILED,
          err instanceof Error ? err.message : String(err),
          err instanceof Error ? err : undefined,
        );

        if (jsonMode) {
          printJson(jsonError(typedErr.code, typedErr.message));
          return;
        }

        process.stderr.write(`Error: ${typedErr.message}\n`);
        process.exitCode = 1;
      }
    });
}
