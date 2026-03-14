/** Status command — show daemon health, usage, queue depth, and recent activity. */
import type { Command } from 'commander';
import { isJsonMode } from '../index.js';
import { printJson } from '../../ui/index.js';
import { jsonOk, jsonError } from '../../types/index.js';
import type { FailureSummaryEntry } from '../../types/index.js';
import { ScrowError, ErrorCode } from '../../errors/index.js';
import { humanizeErrorCode } from '../../ui/index.js';
import { loadStatusSnapshot } from './status-state.js';
import { renderStatusOutput } from './status-presenter.js';

export function registerStatus(program: Command): void {
  program
    .command('status')
    .description('show daemon health, usage, queue depth, and recent activity')
    .option('--all', 'expand all cards to full detail')
    .option('--detail', 'show full capacity dashboard')
    .option('--explain', 'show plain-English explanation of dispatch decision')
    .action(async (options: { all?: boolean; detail?: boolean; explain?: boolean }) => {
      try {
        const snapshot = await loadStatusSnapshot();

        if (isJsonMode()) {
          // Story 10.6 AC7: Include failureSummary with both human-readable and error codes
          const failureSummary = buildJsonFailureSummary(snapshot.activity.recentDispatches);
          const enriched = {
            ...snapshot,
            activity: {
              ...snapshot.activity,
              failureSummary,
            },
          };
          printJson(jsonOk(enriched));
          return;
        }

        const output = renderStatusOutput(snapshot, {
          all: Boolean(options.all),
          detail: Boolean(options.detail),
          explain: Boolean(options.explain),
        });
        process.stdout.write(output + '\n');
      } catch (err) {
        const typedErr =
          err instanceof ScrowError
            ? err
            : new ScrowError(
                ErrorCode.DAEMON_DEGRADED,
                err instanceof Error ? err.message : String(err),
                err instanceof Error ? err : undefined,
              );

        if (isJsonMode()) {
          printJson(
            jsonError(
              typedErr.code,
              `${typedErr.message} — Check daemon state with: sparecrow daemon status`,
            ),
          );
          return;
        }

        process.stderr.write(
          `Error: ${typedErr.message}\n  -> Failed to read status snapshot. Run: sparecrow daemon status or sparecrow doctor\n`,
        );
        process.exitCode = 1;
      }
    });
}

/** Builds failure summary with human-readable messages and error codes for JSON output (AC7). */
function buildJsonFailureSummary(
  dispatches: Array<{ outcome: string; errorCode: string | null }>,
): FailureSummaryEntry[] {
  const counts = new Map<string, number>();
  for (const row of dispatches) {
    if (row.outcome !== 'success' && row.errorCode) {
      counts.set(row.errorCode, (counts.get(row.errorCode) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries()).map(([code, count]) => ({
    reason: humanizeErrorCode(code),
    code,
    count,
  }));
}
