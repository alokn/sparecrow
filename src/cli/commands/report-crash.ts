/** Report-crash command — review and submit structured crash reports as GitHub issues. */
import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { isJsonMode, isInteractive } from '../index.js';
import { printJson } from '../../ui/index.js';
import { jsonOk, jsonError } from '../../types/index.js';
import { ScrowError, ErrorCode } from '../../errors/index.js';
import { logger } from '../../utils/index.js';
import type { CrashReport } from '../../utils/index.js';

const REPO_URL = 'https://github.com/alokn/sparecrow';

/** Build a GitHub issue URL with pre-filled title and body. */
function buildIssueUrl(report: CrashReport): string {
  const title = `Crash: ${report.errorCode}`;
  const body = [
    '## Crash Report',
    '',
    `**sparecrow version:** ${report.sparecrowVersion}`,
    `**Node.js version:** ${report.nodeVersion}`,
    `**OS:** ${report.osPlatform} ${report.osArch}`,
    `**Error code:** ${report.errorCode}`,
    `**Error message:** ${report.errorMessage}`,
    `**Timestamp:** ${report.timestamp}`,
    '',
    '### Config Summary',
    `- Polling interval: ${report.configSummary.pollingInterval ?? 'N/A'}`,
    `- Execution backend: ${report.configSummary.executionBackend ?? 'N/A'}`,
    `- Trigger max waste %: ${report.configSummary.triggerMaxWastePercentage ?? 'N/A'}`,
    '',
    '### Recent Audit Entries',
    ...(report.recentAuditEntries.length > 0
      ? report.recentAuditEntries.map(
          (e) => `- [${e.ts}] ${e.level}: ${e.event}${e.error ? ` (error: ${e.error})` : ''}`,
        )
      : ['None']),
  ].join('\n');

  const params = new URLSearchParams({ title, body, labels: 'bug,crash-report' });
  return `${REPO_URL}/issues/new?${params.toString()}`;
}

/** Renders crash report for human review. */
function renderReport(report: CrashReport): void {
  process.stdout.write('\n--- Crash Report ---\n');
  process.stdout.write(`Timestamp:      ${report.timestamp}\n`);
  process.stdout.write(`Version:        ${report.sparecrowVersion}\n`);
  process.stdout.write(`Node.js:        ${report.nodeVersion}\n`);
  process.stdout.write(`OS:             ${report.osPlatform} ${report.osArch}\n`);
  process.stdout.write(`Error code:     ${report.errorCode}\n`);
  process.stdout.write(`Error message:  ${report.errorMessage}\n`);
  process.stdout.write(
    `\nConfig: polling=${String(report.configSummary.pollingInterval ?? 'N/A')}`,
  );
  process.stdout.write(` backend=${report.configSummary.executionBackend ?? 'N/A'}`);
  process.stdout.write(
    ` maxWaste=${String(report.configSummary.triggerMaxWastePercentage ?? 'N/A')}\n`,
  );

  if (report.recentAuditEntries.length > 0) {
    process.stdout.write('\nRecent audit entries:\n');
    for (const entry of report.recentAuditEntries) {
      process.stdout.write(
        `  [${entry.ts}] ${entry.level}: ${entry.event}${entry.error ? ` (${entry.error})` : ''}\n`,
      );
    }
  }
  process.stdout.write('--- End Report ---\n\n');
}

/** Prompts user for yes/no confirmation. Returns true on yes. */
async function confirmSubmit(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>((resolve) => {
    rl.question('Submit this report as a GitHub issue? (y/N) ', (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

export function registerReportCrash(program: Command): void {
  program
    .command('report-crash <path>')
    .description('review and submit a crash report as a GitHub issue')
    .action(async (filePath: string) => {
      const jsonMode = isJsonMode();

      try {
        const content = await readFile(filePath, 'utf-8');
        const report = JSON.parse(content) as CrashReport;

        // Basic validation — guard all required top-level fields
        if (
          !report.timestamp ||
          !report.errorCode ||
          !report.errorMessage ||
          report.configSummary === null ||
          typeof report.configSummary !== 'object' ||
          !Array.isArray(report.recentAuditEntries)
        ) {
          throw new ScrowError(
            ErrorCode.CRASH_REPORT_INVALID,
            'File does not contain a valid crash report',
          );
        }

        if (jsonMode) {
          const issueUrl = buildIssueUrl(report);
          printJson(jsonOk({ report, issueUrl }));
          return;
        }

        renderReport(report);

        const issueUrl = buildIssueUrl(report);

        if (!isInteractive()) {
          process.stdout.write(`To report this crash, open:\n  ${issueUrl}\n`);
          return;
        }

        const confirmed = await confirmSubmit();
        if (!confirmed) {
          process.stdout.write('Report not submitted.\n');
          return;
        }

        // Try to open browser
        try {
          const { execFile } = await import('node:child_process');
          const openCmd =
            process.platform === 'darwin'
              ? 'open'
              : process.platform === 'win32'
                ? 'start'
                : 'xdg-open';
          execFile(openCmd, [issueUrl], (err) => {
            if (err) {
              void logger.warn('report-crash.browser-open-failed', {
                reason: err.message,
              });
            }
          });
          process.stdout.write('Opening browser to create GitHub issue...\n');
        } catch {
          process.stdout.write(`Could not open browser. Open this URL manually:\n  ${issueUrl}\n`);
        }
      } catch (err) {
        if (err instanceof ScrowError) throw err;

        const isNotFound =
          err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';

        if (isNotFound) {
          const error = new ScrowError(
            ErrorCode.CRASH_REPORT_NOT_FOUND,
            `Crash report not found: ${filePath}`,
          );
          if (jsonMode) {
            printJson(jsonError(error.code, error.message));
            process.exitCode = 1;
            return;
          }
          throw error;
        }

        const error = new ScrowError(
          ErrorCode.CRASH_REPORT_INVALID,
          `Failed to read crash report: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (jsonMode) {
          printJson(jsonError(error.code, error.message));
          process.exitCode = 1;
          return;
        }
        throw error;
      }
    });
}
