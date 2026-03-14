/** Report command — view utilization and ROI summary. */
import type { Command } from 'commander';
import { isJsonMode } from '../index.js';
import { printJson } from '../../ui/index.js';
import { jsonOk, jsonError } from '../../types/index.js';
import { getPaths } from '../../platform/index.js';
import { ScrowError, ErrorCode } from '../../errors/index.js';
import { computeReport } from './report-data.js';
import type { ReportData } from '../../types/index.js';

/** Insufficient-data fallback message — exact string per AC4. */
const INSUFFICIENT_DATA_MSG = 'Insufficient data to calculate utilization and recovered value yet.';

/** Renders the human-mode detailed report. */
function renderHumanReport(data: ReportData): void {
  if (data.insufficientData) {
    process.stdout.write(`${INSUFFICIENT_DATA_MSG}\n`);
    return;
  }

  const pct = (v: number | null): string => (v !== null ? `${String(v)}%` : 'N/A');
  const usd = (v: number | null): string => (v !== null ? `$${String(v)}` : 'N/A');

  process.stdout.write('Utilization Report\n');
  process.stdout.write(`Period: ${data.periodStart} — ${data.periodEnd}\n`);
  process.stdout.write(`Before utilization:    ${pct(data.beforeUtilization)}\n`);
  process.stdout.write(`Current utilization:   ${pct(data.currentUtilization)}\n`);
  process.stdout.write(`Utilization delta:     ${pct(data.deltaUtilization)}\n`);
  process.stdout.write(`Value recovered:       ${usd(data.estimatedValueRecoveredUsd)}\n`);
  process.stdout.write(`Tasks completed:       ${String(data.tasksCompleted)}\n`);

  if (data.breakdownByTaskType.length > 0) {
    process.stdout.write('\nBreakdown by task type:\n');
    for (const row of data.breakdownByTaskType) {
      process.stdout.write(
        `  ${row.taskType}: ${String(row.tasksCompleted)} task(s), ${usd(row.estimatedValueRecoveredUsd)}\n`,
      );
    }
  }

  if (data.attribution !== null) {
    process.stdout.write(`\n${data.attribution}\n`);
  }
}

export function registerReport(program: Command): void {
  program
    .command('report')
    .description('view utilization and ROI summary')
    .action(async () => {
      const paths = getPaths();
      const jsonMode = isJsonMode();

      try {
        const reportData = await computeReport(paths.logs);

        if (jsonMode) {
          printJson(jsonOk(reportData));
          return;
        }

        renderHumanReport(reportData);
      } catch (err) {
        const typedErr =
          err instanceof ScrowError
            ? err
            : new ScrowError(
                ErrorCode.REPORT_COMPUTATION_FAILED,
                err instanceof Error ? err.message : String(err),
                err instanceof Error ? err : undefined,
              );

        if (jsonMode) {
          printJson(jsonError(typedErr.code, typedErr.message));
          return;
        }

        // Human mode: sanitized error, non-zero exit (consistent with doctor.ts / queue.ts pattern)
        process.stderr.write(`Error: ${typedErr.message}\n`);
        process.exitCode = 1;
      }
    });
}
