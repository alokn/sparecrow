/** Daemon command — manage the background daemon lifecycle. */
import { createInterface } from 'node:readline';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, userInfo } from 'node:os';
import type { Command } from 'commander';
import { isJsonMode, getConfigPath } from '../index.js';
import { printJson } from '../../ui/index.js';
import { jsonOk, jsonError } from '../../types/index.js';
import { ScrowError } from '../../errors/index.js';
import { ErrorCode } from '../../errors/index.js';
import { getErrorMessage } from '../../errors/index.js';
import {
  startDaemon,
  stopDaemon,
  restartDaemon,
  reloadDaemon,
  getDaemonStatus,
  DAEMON_STOP_TIMEOUT_MS,
  DAEMON_RUNNER_FLAG,
} from '../../daemon/index.js';
import { installService, uninstallService, getPaths } from '../../platform/index.js';
import { loadConfig, resolveConfigFilePath } from '../../config/index.js';
import { EXIT } from '../index.js';
import { loadLastErrorDetail } from './status-state.js';
import { humanizeErrorCode } from '../../ui/index.js';

/** Returns true when running in an interactive TTY and not in JSON mode. */
function isInteractive(): boolean {
  return !isJsonMode() && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

/** Prompts for y/n confirmation in interactive mode. Returns true if confirmed. */
async function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

/** Returns true if a file exists at the given path. Delegates to service-paths logic pattern. */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Returns the canonical systemd service file path (Linux). */
function getSystemdServicePath(): string {
  return join(homedir(), '.config', 'systemd', 'user', 'sparecrow.service');
}

/** Returns the canonical launchd plist path (macOS). */
function getLaunchAgentPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', 'com.sparecrow.daemon.plist');
}

/** Returns the service file path for the current platform (for pre-flight checks). */
function getPlatformServicePath(): string {
  const { platform } = process;
  if (platform === 'linux') return getSystemdServicePath();
  if (platform === 'darwin') return getLaunchAgentPath();
  return getSystemdServicePath(); // fallback (installService will throw UNSUPPORTED_PLATFORM)
}

/** Formats elapsed time from an ISO timestamp to a human-readable string.
 *  Exported for unit testing. */
export function formatElapsed(startedAt: string): string {
  const elapsed = Date.now() - new Date(startedAt).getTime();
  if (elapsed < 0 || Number.isNaN(elapsed)) return '0s';
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

/** Runs the daemon status action, writing to stdout in human or JSON mode. */
async function runDaemonStatus(): Promise<void> {
  // getDaemonStatus() reads daemon-status.json once and includes activeTask in the result —
  // this avoids the TOCTOU window where a separate readActiveTask() call would create a second
  // read and potentially disagree with the already-read state field.
  const info = await getDaemonStatus();

  // Story 10.6 AC5: Read lastErrorDetail from daemon-status.json for degraded state display
  const paths = getPaths();
  const lastErrorDetail = await loadLastErrorDetail(paths.data);

  if (isJsonMode()) {
    // Story 10.6 AC7: Include lastError in JSON output
    printJson(
      jsonOk({
        ...info,
        lastError: lastErrorDetail
          ? {
              code: lastErrorDetail.code,
              message: lastErrorDetail.message,
              recoveryCommand: lastErrorDetail.recoveryCommand,
            }
          : null,
      }),
    );
    return;
  }

  const stateLabel =
    info.state === 'running'
      ? `running (PID ${info.pid}${info.uptime ? `, uptime ${info.uptime}` : ''})`
      : info.state === 'stopped'
        ? 'stopped'
        : 'not started';

  process.stdout.write(`Daemon: ${stateLabel}\n`);

  // AC6: Display active task name and elapsed time when a task is executing
  if (info.state === 'running' && info.activeTask !== null) {
    const elapsed = formatElapsed(info.activeTask.startedAt);
    process.stdout.write(`Active task: ${info.activeTask.taskName} (running for ${elapsed})\n`);
  } else if (info.state === 'running') {
    process.stdout.write(`Active task: none\n`);
  }

  // Story 10.6 AC5: Show last error with recovery command for degraded state
  if (lastErrorDetail !== null) {
    const humanMsg = humanizeErrorCode(lastErrorDetail.code);
    process.stdout.write(`\n\u26A0 Last error: ${humanMsg}\n`);
    if (lastErrorDetail.recoveryCommand) {
      process.stdout.write(`  \u2192 Run: ${lastErrorDetail.recoveryCommand}\n`);
    }
    process.stdout.write(`  Hint: run 'sparecrow doctor' for full diagnostic\n`);
  }
}

export function registerDaemon(program: Command): void {
  const daemon = program.command('daemon').description('manage the background daemon');

  daemon
    .command('start')
    .description('start the daemon in the background')
    .option('--dry-run', 'preview effective config without starting the daemon')
    .action(async (opts: { dryRun?: boolean }) => {
      if (opts.dryRun) {
        // Resolve config path: explicit --config override or platform default
        const configPath = resolveConfigFilePath(getPaths().config, getConfigPath());

        let config;
        try {
          config = await loadConfig(configPath);
        } catch (err) {
          if (err instanceof ScrowError) {
            if (isJsonMode()) {
              printJson(jsonError(err.code, err.message));
              return;
            }
            const { suggestion } = getErrorMessage(err.code);
            process.stderr.write(`error: ${err.message}\n  -> ${suggestion}\n`);
            process.exitCode = EXIT.ERROR;
            return;
          }
          throw err;
        }

        const preview = {
          dryRun: true,
          configPath,
          pollingIntervalSeconds: config.pollingInterval, // config.pollingInterval is already in seconds per config schema
          triggerMaxWastePercentage: config.trigger.maxWastePercentage,
          triggerWeeklyReservePercentage: config.trigger.weeklyReservePercentage,
          providerName: config.provider.name,
        };

        if (isJsonMode()) {
          printJson(jsonOk(preview));
          return;
        }

        process.stdout.write(`[dry-run] Daemon start preview:\n`);
        process.stdout.write(`  configPath: ${preview.configPath}\n`);
        process.stdout.write(`  pollingIntervalSeconds: ${preview.pollingIntervalSeconds}\n`);
        process.stdout.write(`  triggerMaxWastePercentage: ${preview.triggerMaxWastePercentage}\n`);
        process.stdout.write(
          `  triggerWeeklyReservePercentage: ${preview.triggerWeeklyReservePercentage}\n`,
        );
        process.stdout.write(`  providerName: ${preview.providerName}\n`);
        return;
      }

      try {
        const { pid } = await startDaemon();

        if (isJsonMode()) {
          printJson(jsonOk({ pid, message: `Daemon started with PID ${pid}.` }));
          return;
        }

        // polling_interval will be resolved from config in Story 4.2
        process.stdout.write(
          `\u2713 Daemon started (PID ${pid}). First evaluation pending config load.\n`,
        );
      } catch (err) {
        if (err instanceof ScrowError && err.code === ErrorCode.DAEMON_ALREADY_RUNNING) {
          if (isJsonMode()) {
            printJson(jsonError(err.code, err.message));
            return;
          }
          const { suggestion } = getErrorMessage(err.code);
          process.stderr.write(`error: ${err.message}\n  → ${suggestion}\n`);
          process.exitCode = EXIT.ERROR;
          return;
        }
        if (err instanceof ScrowError) {
          if (isJsonMode()) {
            printJson(jsonError(err.code, err.message));
            return;
          }
          const { suggestion } = getErrorMessage(err.code);
          process.stderr.write(`error: ${err.message}\n  → ${suggestion}\n`);
          // Story 10.6 AC6: Hint on daemon start failure
          process.stderr.write(`  Hint: run 'sparecrow doctor' to diagnose\n`);
          process.exitCode = EXIT.ERROR;
          return;
        }
        throw err;
      }
    });

  daemon
    .command('stop')
    .description('stop the running daemon')
    .action(async () => {
      try {
        const { forced } = await stopDaemon();

        if (isJsonMode()) {
          printJson(
            jsonOk({
              forced,
              message: forced ? 'Daemon force-stopped (SIGKILL).' : 'Daemon stopped.',
            }),
          );
          return;
        }

        if (forced) {
          process.stdout.write(
            `\u2713 Daemon stopped (forced — SIGKILL was required after ${DAEMON_STOP_TIMEOUT_MS}ms timeout).\n`,
          );
        } else {
          process.stdout.write('\u2713 Daemon stopped.\n');
        }
      } catch (err) {
        if (err instanceof ScrowError && err.code === ErrorCode.DAEMON_NOT_RUNNING) {
          if (isJsonMode()) {
            printJson(jsonError(err.code, err.message));
            return;
          }
          const { suggestion } = getErrorMessage(err.code);
          process.stderr.write(`error: ${err.message}\n  → ${suggestion}\n`);
          process.exitCode = EXIT.DAEMON_NOT_RUNNING;
          return;
        }
        throw err;
      }
    });

  daemon
    .command('restart')
    .description('restart the daemon')
    .action(async () => {
      try {
        const { pid, wasRunning } = await restartDaemon();

        if (isJsonMode()) {
          printJson(
            jsonOk({
              pid,
              wasRunning,
              message: wasRunning
                ? `Daemon restarted (PID ${pid}).`
                : `Daemon started (was not running).`,
            }),
          );
          return;
        }

        if (wasRunning) {
          process.stdout.write(`\u2713 Daemon restarted (PID ${pid}).\n`);
        } else {
          process.stdout.write(`\u2713 Daemon started (was not running).\n`);
        }
      } catch (err) {
        if (err instanceof ScrowError) {
          if (isJsonMode()) {
            printJson(jsonError(err.code, err.message));
            return;
          }
          const { suggestion } = getErrorMessage(err.code);
          process.stderr.write(`error: ${err.message}\n  → ${suggestion}\n`);
          process.exitCode = EXIT.ERROR;
          return;
        }
        throw err;
      }
    });

  daemon
    .command('reload')
    .description('reload daemon configuration without restart')
    .action(async () => {
      try {
        await reloadDaemon();

        if (isJsonMode()) {
          printJson(jsonOk({ message: 'Configuration reloaded.' }));
          return;
        }

        process.stdout.write('\u2713 Configuration reloaded.\n');
      } catch (err) {
        if (err instanceof ScrowError && err.code === ErrorCode.DAEMON_NOT_RUNNING) {
          if (isJsonMode()) {
            printJson(jsonError(err.code, err.message));
            return;
          }
          const { suggestion } = getErrorMessage(err.code);
          process.stderr.write(`error: ${err.message}\n  → ${suggestion}\n`);
          process.exitCode = EXIT.DAEMON_NOT_RUNNING;
          return;
        }
        throw err;
      }
    });

  daemon
    .command('status')
    .description('show daemon status and health')
    .action(async () => {
      await runDaemonStatus();
    });

  daemon
    .command('install')
    .description('install daemon as a system service (systemd on Linux, launchd on macOS)')
    .option('-y, --yes', 'skip overwrite confirmation prompt')
    .action(async (opts: { yes?: boolean }) => {
      try {
        const forceFlag = opts.yes === true;
        const serviceFilePath = getPlatformServicePath();
        const exists = await fileExists(serviceFilePath);

        // Overwrite confirmation logic (AC3)
        let userConfirmedOverwrite = false;
        if (exists && !forceFlag) {
          if (isInteractive()) {
            const confirmed = await confirm('Service file already exists. Overwrite? (y/N) ');
            if (!confirmed) {
              process.stdout.write('Installation aborted.\n');
              return;
            }
            userConfirmedOverwrite = true;
          } else {
            // Non-interactive and no --yes flag — throw confirmation required error
            throw new ScrowError(
              ErrorCode.SERVICE_INSTALL_CONFIRMATION_REQUIRED,
              'Service file already exists. Pass --yes to overwrite in non-interactive mode.',
            );
          }
        }

        const result = await installService({
          force: forceFlag || userConfirmedOverwrite,
          daemonRunnerFlag: DAEMON_RUNNER_FLAG,
        });

        if (isJsonMode()) {
          printJson(jsonOk(result));
          return;
        }

        process.stdout.write(
          `\u2713 Service installed and loaded. Daemon will start automatically on next boot.\n`,
        );
        process.stdout.write(`  Service file: ${result.serviceFilePath}\n`);

        // Task 3.3: When overwriting an existing service file, remind the user to restart
        // the daemon so new hardening settings (KillMode, TimeoutStopSec, ExitTimeOut) take effect.
        if (result.overwritten) {
          process.stdout.write(
            `  Note: existing service file was updated. Restart the daemon to apply the new service settings:\n`,
          );
          process.stdout.write(`    sparecrow daemon restart\n`);
        }

        // AC1: Linux linger hint
        if (result.platform === 'linux') {
          const username = userInfo().username;
          process.stdout.write(
            `  Tip: run 'loginctl enable-linger ${username}' to keep the daemon running without an active login session.\n`,
          );
        }
      } catch (err) {
        if (err instanceof ScrowError) {
          if (isJsonMode()) {
            printJson(jsonError(err.code, err.message));
            return;
          }
          const { suggestion } = getErrorMessage(err.code);
          process.stderr.write(`error: ${err.message}\n  \u2192 ${suggestion}\n`);
          process.exitCode = EXIT.ERROR;
          return;
        }
        throw err;
      }
    });

  daemon
    .command('uninstall')
    .description('uninstall the daemon system service and disable auto-start')
    .option('-y, --yes', 'accepted for scripting parity (does not gate execution)')
    .action(async () => {
      try {
        // Step 1: Try to stop the running daemon first (CLI layer owns this per module DAG)
        let stopped = false;
        try {
          await stopDaemon();
          stopped = true;
        } catch (err) {
          if (err instanceof ScrowError && err.code === ErrorCode.DAEMON_NOT_RUNNING) {
            // Daemon wasn't running — not an error for uninstall
            stopped = false;
          } else {
            throw err;
          }
        }

        // Step 2: Remove service file and disable OS service
        const uninstallResult = await uninstallService();

        // Step 3: Merge stopped value from step 1 into result
        const result = { ...uninstallResult, stopped };

        if (!result.removed) {
          if (isJsonMode()) {
            printJson(jsonOk(result));
            return;
          }
          process.stdout.write('No service file found. Nothing to uninstall.\n');
          return;
        }

        if (isJsonMode()) {
          printJson(jsonOk(result));
          return;
        }

        process.stdout.write('\u2713 Service uninstalled. Daemon will no longer auto-start.\n');
      } catch (err) {
        if (err instanceof ScrowError) {
          if (isJsonMode()) {
            printJson(jsonError(err.code, err.message));
            return;
          }
          const { suggestion } = getErrorMessage(err.code);
          process.stderr.write(`error: ${err.message}\n  \u2192 ${suggestion}\n`);
          process.exitCode = EXIT.ERROR;
          return;
        }
        throw err;
      }
    });

  // Bare `daemon` command delegates to status
  daemon.action(async () => {
    await runDaemonStatus();
  });
}
