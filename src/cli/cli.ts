/** CLI framework entry: Commander program setup, global options, command registration. */
import { Command, CommanderError } from 'commander';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setRenderContext, printJson } from '../ui/index.js';
import { jsonError } from '../types/index.js';
import { ScrowError } from '../errors/index.js';
import { getErrorMessage } from '../errors/index.js';
import { ErrorCode } from '../errors/index.js';
import { logger } from '../utils/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Exit code constants — exported for use in command handlers. */
export const EXIT = {
  SUCCESS: 0,
  ERROR: 1,
  DAEMON_NOT_RUNNING: 2,
  AUTH_OR_CONFIG: 3,
} as const;

/** Module-level JSON mode flag — set before commands run via preAction hook. */
let _jsonMode = false;
/** Optional config path override from global --config option. */
let _configPath: string | undefined;

/** Hint line appended to non-JSON error output (AC7 of story 18.6).
 *  Suppressed for --json mode and for CommanderError (user input errors where doctor would not help). */
export const DOCTOR_HINT = '\nRun `sparecrow doctor` for a full diagnostic report.\n';

/** Returns true when the --json global flag was passed. */
export const isJsonMode = (): boolean => _jsonMode;
/** Returns config path from --config when provided. */
export const getConfigPath = (): string | undefined => _configPath;

/** Returns true when running in an interactive TTY and not in JSON mode.
 *  Shared by command handlers that need to gate confirmation prompts.
 */
export const isInteractive = (): boolean =>
  !_jsonMode && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1]![j - 1]!
          : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[m]![n]!;
}

function findClosestCommand(program: Command, input: string): string | null {
  const names = program.commands.map((c) => c.name());
  let best: string | null = null;
  let bestDist = Infinity;
  for (const name of names) {
    const dist = levenshtein(input.toLowerCase(), name.toLowerCase());
    if (dist < bestDist && dist <= 3) {
      bestDist = dist;
      best = name;
    }
  }
  return best;
}

/** Auth/config error codes that map to exit code 3. */
const AUTH_CONFIG_CODES = new Set([
  'AUTH_TOKEN_EXPIRED',
  'AUTH_TOKEN_MISSING',
  'AUTH_TOKEN_FORMAT_CHANGED',
  'CONFIG_INVALID',
  'CONFIG_NOT_FOUND',
  'CLAUDE_NOT_FOUND',
  'AUTH_RECONNECT_FAILED',
  'AUTH_RECONNECT_CANCELED',
]);

/** Daemon error codes that map to exit code 2. */
const DAEMON_CODES = new Set(['DAEMON_NOT_RUNNING']);

export async function run(): Promise<void> {
  // Reset per-invocation flags for testability and repeated runs in-process.
  _jsonMode = false;
  _configPath = undefined;

  // Resolve package.json: try dist/ path first (production bundle), then src/cli/ path (tsx dev)
  let pkg: { version: string } = { version: '0.0.0' };
  let versionLoaded = false;
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      pkg = JSON.parse(readFileSync(join(__dirname, rel), 'utf-8')) as { version: string };
      versionLoaded = true;
      break;
    } catch {
      /* try next candidate */
    }
  }
  if (!versionLoaded) {
    void logger.warn('version.fallback', {
      reason: 'package.json not found in any candidate path',
    });
  }

  const program = new Command();

  program
    .name('sparecrow')
    .description('sparecrow — put spare Claude capacity to work')
    .version(pkg.version, '--version', 'output the current version')
    .option('--json', 'output as JSON (machine-readable)')
    .option('--quiet', 'suppress non-essential output')
    .option('--config <path>', 'path to config.yaml (overrides default)')
    .allowUnknownOption(false);

  // Apply global flags before any subcommand runs
  program.hook('preAction', (_thisCommand) => {
    const opts = program.opts<{ json?: boolean; config?: string }>();
    if (opts['json']) {
      _jsonMode = true;
      setRenderContext({ noColor: true, useUnicode: false });
    }
    _configPath = opts['config'];
    if (!process.stdout.isTTY) {
      setRenderContext({ noColor: true, useUnicode: false, isTTY: false });
    }
  });

  // Record command_run telemetry after each command completes (fire-and-forget).
  // Errors are silently swallowed — telemetry must never affect CLI behaviour.
  program.hook('postAction', (thisCommand) => {
    void (async () => {
      try {
        const { loadConfig, resolveConfigFilePath } = await import('../config/index.js');
        const { getPaths } = await import('../platform/index.js');
        const { recordTelemetryEvent } = await import('../telemetry/index.js');
        const paths = getPaths();
        const configPath = resolveConfigFilePath(paths.config, _configPath);
        const cfg = await loadConfig(configPath);
        if (cfg.telemetry.enabled) {
          await recordTelemetryEvent(
            { version: pkg.version, config: cfg, stateDir: paths.data },
            'command_run',
            thisCommand.name(),
          );
        }
      } catch {
        // Telemetry errors must never surface to the user
      }
    })();
  });

  // Register all command modules
  const { registerStatus } = await import('./commands/status.js');
  const { registerQueue } = await import('./commands/queue.js');
  const { registerLogs } = await import('./commands/logs.js');
  const { registerConfig } = await import('./commands/config.js');
  const { registerDaemon } = await import('./commands/daemon.js');
  const { registerDoctor } = await import('./commands/doctor.js');
  const { registerContainer } = await import('./commands/container.js');
  const { registerOnboard } = await import('./commands/onboard.js');
  const { registerTemplates } = await import('./commands/templates.js');
  const { registerReport } = await import('./commands/report.js');
  const { registerCompletions } = await import('./commands/completions.js');
  const { registerResults } = await import('./commands/results.js');
  const { registerTask } = await import('./commands/task.js');
  const { registerWhy } = await import('./commands/why.js');
  const { registerRefresh } = await import('./commands/refresh.js');
  const { registerQuickstart } = await import('./commands/quickstart.js');
  const { registerExamples } = await import('./commands/examples.js');
  const { registerStats } = await import('./commands/stats.js');
  const { registerReportCrash } = await import('./commands/report-crash.js');

  registerStatus(program);
  registerQueue(program);
  registerLogs(program);
  registerConfig(program);
  registerDaemon(program);
  registerDoctor(program);
  registerContainer(program);
  registerOnboard(program);
  registerTemplates(program);
  registerReport(program);
  registerCompletions(program);
  registerResults(program);
  registerTask(program);
  registerWhy(program);
  registerRefresh(program);
  registerQuickstart(program);
  registerExamples(program);
  registerStats(program);
  registerReportCrash(program);

  // Unknown command handler with fuzzy matching
  program.on('command:*', (operands: string[]) => {
    const unknown = operands[0] ?? '';
    const suggestion = findClosestCommand(program, unknown);
    const msg = suggestion
      ? `Unknown command '${unknown}'. Did you mean '${suggestion}'?`
      : `Unknown command '${unknown}'. Run 'sparecrow --help' for available commands.`;

    // preAction hook does not fire for unknown commands, so check opts directly
    const isJson = _jsonMode || Boolean(program.opts<{ json?: boolean }>()['json']);
    if (isJson) {
      printJson(jsonError(ErrorCode.UNKNOWN_COMMAND, msg));
    } else {
      process.stderr.write(`error: ${msg}\n`);
    }
    process.exit(EXIT.ERROR);
  });

  // Global error handler: map ScrowError codes → exit codes; wrap CommanderError in JSON when --json
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof ScrowError) {
      const { userMessage, suggestion } = getErrorMessage(err.code);
      if (_jsonMode) {
        printJson(jsonError(err.code, userMessage));
      } else {
        process.stderr.write(`error: ${userMessage}\n  → ${suggestion}\n`);
        process.stderr.write(DOCTOR_HINT);
      }
      if (AUTH_CONFIG_CODES.has(err.code)) process.exit(EXIT.AUTH_OR_CONFIG);
      if (DAEMON_CODES.has(err.code)) process.exit(EXIT.DAEMON_NOT_RUNNING);
      process.exit(EXIT.ERROR);
    }
    if (err instanceof CommanderError && _jsonMode) {
      printJson(jsonError(ErrorCode.INVALID_ARGUMENT, err.message));
      process.exit(EXIT.ERROR);
    }
    if (err instanceof CommanderError) {
      // No doctor hint for user input errors (invalid flags, unknown options, etc.)
      process.stderr.write(`error: ${err.message}\n`);
      process.exit(EXIT.ERROR);
    }
    process.stderr.write(`Unexpected error: ${(err as Error).message}\n`);
    if (!_jsonMode) {
      process.stderr.write(DOCTOR_HINT);
    }
    process.exit(EXIT.ERROR);
  }
}
