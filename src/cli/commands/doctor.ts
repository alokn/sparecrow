/** Doctor command — run diagnostic health checks. */
import type { Command } from 'commander';
import chalk from 'chalk';
import { isJsonMode } from '../index.js';
import { printJson, getRenderContext } from '../../ui/index.js';
import { jsonOk } from '../../types/index.js';
import { runDiagnostics } from './doctor-runner.js';
import type { DoctorFinding, DoctorSummary } from '../../types/index.js';

/** Severity indicator mapping for human output. */
function severityIcon(
  severity: DoctorFinding['severity'],
  ctx: { noColor: boolean; useUnicode: boolean },
): string {
  if (severity === 'critical') {
    const icon = ctx.useUnicode ? '\u2717' : 'FAIL';
    return ctx.noColor ? icon : chalk.red(icon);
  }
  if (severity === 'warning') {
    const icon = ctx.useUnicode ? '\u26A0' : 'WARN';
    return ctx.noColor ? icon : chalk.yellow(icon);
  }
  const icon = ctx.useUnicode ? '\u2713' : 'OK';
  return ctx.noColor ? icon : chalk.green(icon);
}

/** Renders a single finding in human-readable format. */
function renderFinding(
  finding: DoctorFinding,
  verbose: boolean,
  ctx: { noColor: boolean; useUnicode: boolean },
): string {
  const lines: string[] = [];
  const icon = severityIcon(finding.severity, ctx);
  lines.push(`  ${icon} ${finding.checkName}: ${finding.message}`);

  if (finding.fixCommand && finding.severity !== 'ok') {
    const arrow = ctx.useUnicode ? '\u2192' : '->';
    lines.push(`    ${arrow} Fix: ${finding.fixCommand}`);
  }

  if (verbose) {
    lines.push(`    (${finding.durationMs}ms)`);
  }

  if (verbose && finding.details) {
    lines.push(`    Details: ${finding.details}`);
  }

  return lines.join('\n');
}

/** Renders the summary block. */
function renderSummary(
  summary: DoctorSummary,
  ctx: { noColor: boolean; useUnicode: boolean },
): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('  Summary:');

  const critLabel = ctx.noColor
    ? `${summary.criticalCount} critical`
    : chalk.red(`${summary.criticalCount} critical`);
  const warnLabel = ctx.noColor
    ? `${summary.warningCount} warning`
    : chalk.yellow(`${summary.warningCount} warning`);
  const okLabel = ctx.noColor ? `${summary.okCount} ok` : chalk.green(`${summary.okCount} ok`);

  lines.push(`    ${critLabel}, ${warnLabel}, ${okLabel} (${summary.totalChecks} checks)`);

  if (summary.criticalCount > 0) {
    lines.push('');
    lines.push('  Fix critical issues first, then run doctor again.');
  } else if (summary.warningCount > 0) {
    lines.push('');
    lines.push('  Address warnings to ensure optimal operation.');
  } else {
    lines.push('');
    lines.push('  All checks passed — no issues detected.');
  }

  return lines.join('\n');
}

export function registerDoctor(program: Command): void {
  program
    .command('doctor')
    .description('run diagnostic health checks')
    .option('--verbose', 'show per-check timing and failure details')
    .action(async (opts: { verbose?: boolean }) => {
      const verbose = opts.verbose ?? false;
      const result = await runDiagnostics(verbose);

      if (isJsonMode()) {
        printJson(jsonOk(result));
        if (result.summary.criticalCount > 0) {
          process.exitCode = 1;
        }
        return;
      }

      const ctx = getRenderContext();

      process.stdout.write('\n  Doctor — Diagnostic Health Check\n\n');

      for (const finding of result.findings) {
        process.stdout.write(renderFinding(finding, verbose, ctx) + '\n');
      }

      process.stdout.write(renderSummary(result.summary, ctx) + '\n\n');

      if (result.summary.criticalCount > 0) {
        process.exitCode = 1;
      }
    });
}
