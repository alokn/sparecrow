/** Queue command — manage the task queue (add, remove, reorder, clear, list, history). */
import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import Table from 'cli-table3';
import type { TaskDefinition } from '../../types/index.js';
import { jsonOk, jsonError } from '../../types/index.js';
import { ScrowError, ErrorCode } from '../../errors/index.js';
import { getPaths } from '../../platform/index.js';
import { validateRepository } from '../../utils/index.js';
import { QueueStore, QueueManager, nextCustomIndex } from '../../queue/index.js';
import { loadBuiltins, resolveTemplateOrCustom, type Template } from '../../templates/index.js';
import { loadConfig, resolveConfigFilePath } from '../../config/index.js';
import { isJsonMode, getConfigPath } from '../index.js';
import { printJson, color, humanizeErrorCode } from '../../ui/index.js';
import type { HumanizeContext } from '../../ui/index.js';
import { getRecentTaskFailures } from './log-reader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Returns true when running in an interactive TTY and not in JSON mode. Requires both stdin and stdout to be TTY. */
function isInteractive(): boolean {
  return !isJsonMode() && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

/** Formats a timeout in milliseconds to a human-readable string. Exported for testing.
 * Sub-minute positive values are rounded up to "1m".
 * 0 means "no limit" (display-only — raw wire format is timeoutMs: 0, not this string). */
export function formatTimeout(timeoutMs: number): string {
  if (timeoutMs === 0) return 'no limit';
  const minutes = Math.max(1, Math.round(timeoutMs / (60 * 1000)));
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/** Renders the task list as a CLI table string. Exported for isolated unit testing.
 *  Optional failureMap adds dimmed sub-rows for tasks with recent failures.
 *  Optional humanizeCtx is forwarded to humanizeErrorCode so OOM messages
 *  reflect the actual configured memory limit rather than a hardcoded default. */
export function renderTable(
  tasks: TaskDefinition[],
  failureMap?: Map<string, string>,
  humanizeCtx?: HumanizeContext,
): string {
  const table = new Table({
    head: ['#', 'Name', 'Status', 'Type', 'Timeout', 'Target'],
    style: { head: [], border: [] },
    colWidths: [null, null, null, null, null, null],
  });
  for (const task of tasks) {
    table.push([
      String(task.priority),
      task.name,
      task.status,
      task.type,
      formatTimeout(task.timeoutMs),
      task.targetPath,
    ]);
    // Story 10.6 AC3: Show failure context as sub-row
    const errorCode = failureMap?.get(task.name);
    if (errorCode) {
      const humanMsg = humanizeErrorCode(errorCode, humanizeCtx);
      table.push([{ colSpan: 6, content: color.dim(`   \u2514 Last failure: ${humanMsg}`) }]);
    }
  }
  return table.toString();
}

/** Live task statuses shown in the default `queue list` view. */
const LIVE_STATUSES = new Set<string>(['pending', 'in-progress', 'failed_quota']);

/** Historical task statuses shown in `queue history`. */
const HISTORY_STATUSES = new Set<string>(['done', 'failed', 'skipped']);

/** Renders the live view: RUNNING section (in-progress) + QUEUE section (pending/failed_quota).
 *  Returns the rendered string. Exported for isolated unit testing. */
export function renderLiveTable(
  tasks: TaskDefinition[],
  failureMap?: Map<string, string>,
  humanizeCtx?: HumanizeContext,
): string {
  const running = tasks.filter((t) => t.status === 'in-progress');
  const queued = tasks.filter((t) => t.status === 'pending' || t.status === 'failed_quota');

  const sections: string[] = [];

  // RUNNING section
  if (running.length > 0) {
    const table = new Table({
      head: ['', 'Name', 'Status', 'Type', 'Timeout', 'Target'],
      style: { head: [], border: [] },
      colWidths: [null, null, null, null, null, null],
    });
    for (const task of running) {
      table.push([
        '\u25b6',
        task.name,
        task.status,
        task.type,
        formatTimeout(task.timeoutMs),
        task.targetPath,
      ]);
      const errorCode = failureMap?.get(task.name);
      if (errorCode) {
        const humanMsg = humanizeErrorCode(errorCode, humanizeCtx);
        table.push([{ colSpan: 6, content: color.dim(`   \u2514 Last failure: ${humanMsg}`) }]);
      }
    }
    sections.push('RUNNING\n' + table.toString());
  }

  // QUEUE section
  if (queued.length > 0) {
    const sorted = [...queued].sort((a, b) => a.priority - b.priority);
    const table = new Table({
      head: ['#', 'Name', 'Status', 'Type', 'Timeout', 'Target'],
      style: { head: [], border: [] },
      colWidths: [null, null, null, null, null, null],
    });
    for (let i = 0; i < sorted.length; i++) {
      const task = sorted[i]!;
      table.push([
        String(i + 1),
        task.name,
        task.status,
        task.type,
        formatTimeout(task.timeoutMs),
        task.targetPath,
      ]);
      const errorCode = failureMap?.get(task.name);
      if (errorCode) {
        const humanMsg = humanizeErrorCode(errorCode, humanizeCtx);
        table.push([{ colSpan: 6, content: color.dim(`   \u2514 Last failure: ${humanMsg}`) }]);
      }
    }
    sections.push(
      `QUEUE  (${sorted.length} task${sorted.length === 1 ? '' : 's'})\n` + table.toString(),
    );
  }

  return sections.join('\n\n');
}

/** Builds the history footer line for the live view.
 *  Returns empty string if no historical tasks exist (or only skipped). Exported for testing. */
export function buildHistoryFooter(allTasks: TaskDefinition[]): string {
  let doneCount = 0;
  let failedCount = 0;
  for (const t of allTasks) {
    if (t.status === 'done') doneCount++;
    else if (t.status === 'failed') failedCount++;
  }

  if (doneCount === 0 && failedCount === 0) return '';

  const parts: string[] = [];
  if (doneCount > 0) parts.push(`${doneCount} completed`);
  if (failedCount > 0) parts.push(`${failedCount} failed`);

  return `  ${parts.join(' \u00b7 ')}  \u2014  run \`sparecrow queue history\` to view`;
}

/** Renders the history table: done/failed/skipped tasks with status icons.
 *  Sorted by createdAt descending. Exported for isolated unit testing. */
export function renderHistoryTable(
  tasks: TaskDefinition[],
  failureMap?: Map<string, string>,
  humanizeCtx?: HumanizeContext,
): string {
  if (tasks.length === 0) return 'No history.';

  const sorted = [...tasks].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  const table = new Table({
    head: ['', 'Name', 'Status', 'Type', 'Completed', 'Target'],
    style: { head: [], border: [] },
    colWidths: [null, null, null, null, null, null],
  });

  for (const task of sorted) {
    const icon = task.status === 'done' ? '\u2713' : task.status === 'failed' ? '\u2717' : '\u2013';
    const completedDisplay = task.completedAt
      ? task.completedAt
          .toISOString()
          .replace('T', ' ')
          .replace(/\.\d{3}Z$/, ' UTC')
      : '—';
    table.push([icon, task.name, task.status, task.type, completedDisplay, task.targetPath]);
    const errorCode = failureMap?.get(task.name);
    if (errorCode) {
      const humanMsg = humanizeErrorCode(errorCode, humanizeCtx);
      table.push([{ colSpan: 6, content: color.dim(`   \u2514 Last failure: ${humanMsg}`) }]);
    }
  }

  return 'HISTORY\n' + table.toString();
}

/** Creates a fresh QueueManager backed by platform data dir. */
function makeManager(): QueueManager {
  const store = new QueueStore(getPaths().data);
  return new QueueManager(store);
}

/**
 * Validates --target path per AC5.
 * Throws QUEUE_ADD_TARGET_INVALID with a specific message for each failure case.
 */
async function validateTarget(target: string): Promise<void> {
  if (!target || !target.trim()) {
    throw new ScrowError(
      ErrorCode.QUEUE_ADD_TARGET_INVALID,
      'Target path must not be empty or whitespace.',
    );
  }

  const result = await validateRepository(target);
  if (!result.valid) {
    throw new ScrowError(
      ErrorCode.QUEUE_ADD_TARGET_INVALID,
      result.error ?? `Target path is not a valid git repository: ${target}`,
    );
  }
}

/** Writes the UX-spec failure output and sets exitCode=1 (human mode). */
function writeAddError(message: string, usageLines: string[]): void {
  const lines = [`\u2717 ${message}`, ...usageLines.map((l) => `  \u2192 ${l}`)].join('\n');
  process.stderr.write(lines + '\n');
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerQueue(program: Command): void {
  const queue = program.command('queue').description('manage the task queue');

  // ── list (default bare queue action) ─────────────────────────────────────

  async function listAction(opts: { includeHistory?: boolean } = {}): Promise<void> {
    const manager = makeManager();
    const tasks = await manager.list();

    // Story 10.6 AC3: Look up recent failures for all task names from today's audit log
    const taskNames = tasks.map((t) => t.name);
    const paths = getPaths();
    let failureMap: Map<string, string>;
    try {
      failureMap = await getRecentTaskFailures(paths.logs, taskNames);
    } catch {
      failureMap = new Map();
    }

    // Story 10.11: Resolve actual memory limit from config so OOM messages
    // show the real configured value rather than a hardcoded default.
    let memoryLimitMb: number | undefined;
    try {
      const configPath = resolveConfigFilePath(getPaths().config, getConfigPath());
      const cfg = await loadConfig(configPath);
      memoryLimitMb = cfg.provider.container?.memoryLimitMb;
    } catch {
      // Config unavailable — humanizeErrorCode will fall back to 512 MB default
    }
    const humanizeCtx: HumanizeContext = memoryLimitMb !== undefined ? { memoryLimitMb } : {};

    // Story 10.12: --include-history shows full unfiltered table (backwards compat)
    if (opts.includeHistory) {
      if (isJsonMode()) {
        const tasksWithFailures = tasks.map((t) => {
          const errorCode = failureMap.get(t.name);
          return {
            ...t,
            lastFailure: errorCode
              ? { code: errorCode, message: humanizeErrorCode(errorCode, humanizeCtx) }
              : null,
          };
        });
        printJson(jsonOk({ tasks: tasksWithFailures }));
        return;
      }
      if (tasks.length === 0) {
        process.stdout.write(
          'Queue is empty.\n  Hint: use `sparecrow queue add --template <name> --target <path>` or `sparecrow templates` to see available templates.\n',
        );
        return;
      }
      process.stdout.write(renderTable(tasks, failureMap, humanizeCtx) + '\n');
      if (failureMap.size > 0) {
        process.stdout.write(
          color.dim("  Hint: run 'sparecrow logs --task <name>' for failure history") + '\n',
        );
      }
      return;
    }

    // Story 10.12: Default live view — only live tasks (pending, in-progress, failed_quota)
    const liveTasks = tasks.filter((t) => LIVE_STATUSES.has(t.status));

    if (isJsonMode()) {
      const tasksWithFailures = liveTasks.map((t) => {
        const errorCode = failureMap.get(t.name);
        return {
          ...t,
          lastFailure: errorCode
            ? { code: errorCode, message: humanizeErrorCode(errorCode, humanizeCtx) }
            : null,
        };
      });
      printJson(jsonOk({ tasks: tasksWithFailures }));
      return;
    }

    const footer = buildHistoryFooter(tasks);

    if (liveTasks.length === 0) {
      process.stdout.write(
        'Queue is empty.\n  Hint: use `sparecrow queue add --template <name> --target <path>` or `sparecrow templates` to see available templates.\n',
      );
      if (footer) {
        process.stdout.write('\n' + footer + '\n');
      }
      return;
    }

    process.stdout.write(renderLiveTable(liveTasks, failureMap, humanizeCtx) + '\n');

    // History footer
    if (footer) {
      process.stdout.write('\n' + footer + '\n');
    }

    // Story 10.6 AC3/AC6: Show hint when any failure sub-rows are present
    if (failureMap.size > 0) {
      process.stdout.write(
        color.dim("  Hint: run 'sparecrow logs --task <name>' for failure history") + '\n',
      );
    }
  }

  queue
    .command('list')
    .alias('ls')
    .description('list all queued tasks')
    .option('--include-history', 'show all tasks including completed/failed/skipped')
    .action(listAction);

  // Default bare `queue` action also lists
  queue.action(listAction);

  // ── history ──────────────────────────────────────────────────────────────

  queue
    .command('history')
    .description('show completed, failed, and skipped tasks')
    .action(async () => {
      const manager = makeManager();
      const tasks = await manager.list();

      const historical = tasks.filter((t) => HISTORY_STATUSES.has(t.status));

      // Look up recent failures for historical tasks
      const taskNames = historical.map((t) => t.name);
      const paths = getPaths();
      let failureMap: Map<string, string>;
      try {
        failureMap = await getRecentTaskFailures(paths.logs, taskNames);
      } catch {
        failureMap = new Map();
      }

      // Resolve humanize context for OOM messages
      let memoryLimitMb: number | undefined;
      try {
        const configPath = resolveConfigFilePath(getPaths().config, getConfigPath());
        const cfg = await loadConfig(configPath);
        memoryLimitMb = cfg.provider.container?.memoryLimitMb;
      } catch {
        // Config unavailable — humanizeErrorCode will fall back to 512 MB default
      }
      const humanizeCtx: HumanizeContext = memoryLimitMb !== undefined ? { memoryLimitMb } : {};

      if (historical.length === 0) {
        if (isJsonMode()) {
          printJson(jsonOk({ tasks: [] }));
        } else {
          process.stdout.write('No history.\n');
        }
        return;
      }

      if (isJsonMode()) {
        const sorted = [...historical].sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );
        const tasksWithFailures = sorted.map((t) => {
          const errorCode = failureMap.get(t.name);
          return {
            ...t,
            lastFailure: errorCode
              ? { code: errorCode, message: humanizeErrorCode(errorCode, humanizeCtx) }
              : null,
          };
        });
        printJson(jsonOk({ tasks: tasksWithFailures }));
        return;
      }

      process.stdout.write(renderHistoryTable(historical, failureMap, humanizeCtx) + '\n');
    });

  // ── add ────────────────────────────────────────────────────────────────────

  queue
    .command('add')
    .description('add a task to the queue')
    .option('--template <name>', 'pre-built or config custom template name')
    .option('--prompt <text>', 'custom prompt text for an ad-hoc task')
    .option('--target <path>', 'target repository path (required)')
    .option('--timeout <minutes>', 'task execution timeout in minutes (0 = no timeout)')
    .option('--dry-run', 'show what would be added without modifying queue')
    .action(
      async (opts: {
        template?: string;
        prompt?: string;
        target?: string;
        timeout?: string;
        dryRun?: boolean;
      }) => {
        const hasTemplate = opts.template !== undefined && opts.template !== '';
        const hasPrompt = opts.prompt !== undefined && opts.prompt !== '';

        // AC4: enforce exactly one mode
        if (!hasTemplate && !hasPrompt) {
          const msg = 'queue add requires exactly one of --template or --prompt';
          if (isJsonMode()) {
            printJson(jsonError(ErrorCode.QUEUE_ADD_INVALID_MODE, msg));
            return;
          }
          writeAddError(msg, [
            'Usage: sparecrow queue add --template <name> --target <path>',
            'Usage: sparecrow queue add --prompt "<text>" --target <path>',
          ]);
          return;
        }

        if (hasTemplate && hasPrompt) {
          const msg = 'queue add requires exactly one of --template or --prompt';
          if (isJsonMode()) {
            printJson(jsonError(ErrorCode.QUEUE_ADD_INVALID_MODE, msg));
            return;
          }
          writeAddError(msg, [
            'Usage: sparecrow queue add --template <name> --target <path>',
            'Usage: sparecrow queue add --prompt "<text>" --target <path>',
          ]);
          return;
        }

        // --target is always required
        if (!opts.target) {
          const msg = '--target <path> is required';
          if (isJsonMode()) {
            printJson(jsonError(ErrorCode.QUEUE_ADD_TARGET_INVALID, msg));
            return;
          }
          writeAddError(msg, [
            'Usage: sparecrow queue add --template <name> --target <path>',
            'Usage: sparecrow queue add --prompt "<text>" --target <path>',
          ]);
          return;
        }

        // AC5: validate target path
        try {
          await validateTarget(opts.target);
        } catch (err) {
          const message = err instanceof ScrowError ? err.message : String(err);
          const code = err instanceof ScrowError ? err.code : ErrorCode.QUEUE_ADD_TARGET_INVALID;
          if (isJsonMode()) {
            printJson(jsonError(code, message));
            return;
          }
          writeAddError(message, []);
          return;
        }

        // Validate --timeout flag if present.
        // Reject scientific notation (e.g. "1e3") — require a plain decimal integer string.
        let cliTimeoutMinutes: number | undefined;
        if (opts.timeout !== undefined) {
          const isPlainInteger = /^\d+$/.test(opts.timeout.trim());
          const parsed = Number(opts.timeout);
          if (!isPlainInteger || !Number.isInteger(parsed) || parsed < 0) {
            const msg = '--timeout must be a non-negative integer (minutes, 0 = no timeout)';
            if (isJsonMode()) {
              printJson(jsonError(ErrorCode.QUEUE_ADD_TIMEOUT_INVALID, msg));
              return;
            }
            writeAddError(msg, []);
            return;
          }
          cliTimeoutMinutes = parsed;
        }

        // Resolve the template/prompt to a task definition input
        let taskType: 'template' | 'custom';
        let taskName: string | undefined;
        let templateName: string | undefined;
        let promptText: string;
        let templateTimeoutMinutes: number | undefined;
        let templateActions: ReadonlyArray<import('../../types/index.js').ActionType> = [];
        let isAdHocPrompt = false; // true only for --prompt path (shows Hint line)

        // Load config for task_timeout_minutes default and custom tasks
        let configTimeoutMinutes: number | undefined;
        let configCustomTasks: Array<{ name: string; prompt: string }> = [];
        try {
          const config = await loadConfig(
            resolveConfigFilePath(getPaths().config, getConfigPath()),
          );
          configTimeoutMinutes = config.taskTimeoutMinutes;
          configCustomTasks = config.tasks.map((t) => ({ name: t.name, prompt: t.prompt }));
        } catch (err) {
          if (err instanceof ScrowError && err.code === ErrorCode.CONFIG_NOT_FOUND) {
            // config file absent — use defaults
          } else {
            // CONFIG_INVALID or other error — fail fast per AC2
            const message = err instanceof ScrowError ? err.message : String(err);
            const code = err instanceof ScrowError ? err.code : ErrorCode.CONFIG_INVALID;
            if (isJsonMode()) {
              printJson(jsonError(code, message));
              return;
            }
            writeAddError(message, []);
            return;
          }
        }

        if (hasTemplate && opts.template) {
          // AC15: resolve --template against built-ins AND config custom tasks
          let builtins: Template[] = [];
          try {
            builtins = await loadBuiltins();
          } catch (err) {
            if (err instanceof ScrowError && err.code === ErrorCode.TEMPLATE_LOAD_ERROR) {
              // built-in files not found — fall through to config custom tasks only
            } else {
              // template corruption — surface real error (AC12: no silent failures)
              const message = err instanceof ScrowError ? err.message : String(err);
              const code = err instanceof ScrowError ? err.code : ErrorCode.TEMPLATE_LOAD_ERROR;
              if (isJsonMode()) {
                printJson(jsonError(code, message));
                return;
              }
              writeAddError(message, []);
              return;
            }
          }

          let resolved;
          try {
            resolved = resolveTemplateOrCustom(opts.template, builtins, configCustomTasks);
          } catch (err) {
            const message = err instanceof ScrowError ? err.message : String(err);
            // Re-wrap TEMPLATE_NOT_FOUND to queue-specific code at CLI boundary
            const code =
              err instanceof ScrowError && err.code === ErrorCode.TEMPLATE_NOT_FOUND
                ? ErrorCode.QUEUE_ADD_TEMPLATE_NOT_FOUND
                : err instanceof ScrowError
                  ? err.code
                  : ErrorCode.QUEUE_ADD_TEMPLATE_NOT_FOUND;
            if (isJsonMode()) {
              printJson(jsonError(code, message));
              return;
            }
            writeAddError(message, ["Run 'sparecrow templates' to see available templates"]);
            return;
          }

          if (resolved.type === 'built-in') {
            taskType = 'template';
            taskName = resolved.template.name;
            templateName = resolved.template.name;
            promptText = resolved.template.prompt;
            templateTimeoutMinutes = resolved.template.timeoutMinutes;
            templateActions = resolved.template.actions;
          } else {
            // config custom task resolved via --template
            taskType = 'custom';
            taskName = resolved.name;
            promptText = resolved.prompt;
            templateActions = resolved.actions;
          }
        } else {
          // ad-hoc --prompt path
          taskType = 'custom';
          promptText = opts.prompt ?? '';
          isAdHocPrompt = true;
          // custom-<N> name computed after we know the queue size
        }

        // Resolve timeout precedence: CLI flag > template > config > hardcoded 60 min
        const resolvedTimeoutMinutes =
          cliTimeoutMinutes ?? templateTimeoutMinutes ?? configTimeoutMinutes ?? 60;
        // Convert minutes to milliseconds; 0 means "no timeout"
        const timeoutMs = resolvedTimeoutMinutes === 0 ? 0 : resolvedTimeoutMinutes * 60 * 1000;

        const manager = makeManager();

        if (opts.dryRun) {
          // For --prompt dry-run, peek at queue (read-only) to compute preview name
          let previewName: string | undefined = taskName;
          if (isAdHocPrompt) {
            const existing = await manager.list();
            previewName = `custom-${nextCustomIndex(existing)}`;
          }
          const preview = {
            type: taskType,
            ...(templateName !== undefined ? { templateName } : {}),
            ...(previewName !== undefined ? { name: previewName } : {}),
            targetPath: opts.target,
          };
          if (isJsonMode()) {
            printJson(jsonOk({ dryRun: true, preview }));
            return;
          }
          const label =
            previewName ??
            `--prompt "${promptText.slice(0, 40)}${promptText.length > 40 ? '\u2026' : ''}"`;
          process.stdout.write(
            `[dry-run] Would add ${taskType} task '${label}' targeting ${opts.target}\n`,
          );
          return;
        }

        // For ad-hoc custom tasks, auto-naming (custom-<N>) is handled inside
        // QueueManager.add() under its serial lock — prevents race conditions and
        // duplicate names after task removals (uses max-existing-N + 1, not length + 1).

        const result = await manager.add({
          type: taskType,
          ...(taskName !== undefined ? { name: taskName } : {}),
          ...(templateName !== undefined ? { templateName } : {}),
          prompt: promptText,
          targetPath: opts.target,
          timeoutMs,
          actions: templateActions,
        });

        const isAdHocCustom = isAdHocPrompt;

        if (isJsonMode()) {
          printJson(jsonOk({ task: result.task, position: result.position }));
          return;
        }

        // AC6: UX-spec success output
        const displayName = result.task.name;
        process.stdout.write(
          `\u2713 Added: ${displayName} \u2192 ${opts.target}\n  Queue position: #${result.position}\n`,
        );
        if (isAdHocCustom) {
          process.stdout.write(`  Hint: 'queue reorder' to prioritize\n`);
        }
      },
    );

  // ── remove ─────────────────────────────────────────────────────────────────

  queue
    .command('remove <position>')
    .description('remove a task by position number')
    .option('--yes', 'skip confirmation prompt (required in JSON/non-interactive mode)')
    .action(async (positionArg: string, opts: { yes?: boolean }) => {
      const position = Number(positionArg);

      if (!Number.isInteger(position) || position < 1) {
        const msg = `Invalid position '${positionArg}': must be a positive integer.`;
        if (isJsonMode()) {
          printJson(jsonError(ErrorCode.QUEUE_INVALID_POSITION, msg));
          return;
        }
        process.stderr.write(`error: ${msg}\n`);
        process.exitCode = 1;
        return;
      }

      if (!isInteractive() && !opts.yes) {
        throw new ScrowError(
          ErrorCode.QUEUE_CONFIRMATION_REQUIRED,
          'Pass --yes to confirm queue remove in non-interactive or JSON mode.',
        );
      }

      if (isInteractive() && !opts.yes) {
        const confirmed = await confirm(`Remove task at position ${position}? [y/N] `);
        if (!confirmed) {
          process.stdout.write('Cancelled.\n');
          return;
        }
      }

      const manager = makeManager();

      // Resolve display position to task ID: list all tasks, filter to live
      // statuses (matching renderLiveTable), sort by priority, pick by position.
      const allTasks = await manager.list();
      const liveTasks = allTasks
        .filter((t) => LIVE_STATUSES.has(t.status))
        .sort((a, b) => a.priority - b.priority);

      if (position > liveTasks.length) {
        const msg = `Invalid position ${position}: must be between 1 and ${liveTasks.length}.`;
        if (isJsonMode()) {
          printJson(jsonError(ErrorCode.QUEUE_INVALID_POSITION, msg));
          return;
        }
        throw new ScrowError(ErrorCode.QUEUE_INVALID_POSITION, msg);
      }

      const target = liveTasks[position - 1]!;
      const removed = await manager.removeById(target.id);

      if (isJsonMode()) {
        printJson(jsonOk({ removed }));
        return;
      }
      process.stdout.write(`Removed task at position ${position}: ${removed.name}\n`);
    });

  // ── clear ──────────────────────────────────────────────────────────────────

  queue
    .command('clear')
    .description('remove all tasks from the queue')
    .option('--yes', 'skip confirmation prompt (required in JSON/non-interactive mode)')
    .action(async (opts: { yes?: boolean }) => {
      if (!isInteractive() && !opts.yes) {
        throw new ScrowError(
          ErrorCode.QUEUE_CONFIRMATION_REQUIRED,
          'Pass --yes to confirm queue clear in non-interactive or JSON mode.',
        );
      }

      const manager = makeManager();

      if (isInteractive() && !opts.yes) {
        const tasks = await manager.list();
        const confirmed = await confirm(`Clear all ${tasks.length} task(s) from the queue? [y/N] `);
        if (!confirmed) {
          process.stdout.write('Cancelled.\n');
          return;
        }
      }

      const count = await manager.clear();

      if (isJsonMode()) {
        printJson(jsonOk({ cleared: count }));
        return;
      }
      process.stdout.write(`Cleared ${count} task(s) from the queue.\n`);
    });

  // ── reorder ────────────────────────────────────────────────────────────────

  const reorder = queue.command('reorder').description('reorder tasks in the queue');

  reorder
    .command('move <from> <to>')
    .description('move task at position <from> to position <to>')
    .action(async (fromArg: string, toArg: string) => {
      const from = Number(fromArg);
      const to = Number(toArg);

      if (!Number.isInteger(from) || from < 1) {
        const msg = `Invalid from position '${fromArg}': must be a positive integer.`;
        if (isJsonMode()) {
          printJson(jsonError(ErrorCode.QUEUE_INVALID_POSITION, msg));
          return;
        }
        process.stderr.write(`error: ${msg}\n`);
        process.exitCode = 1;
        return;
      }

      if (!Number.isInteger(to) || to < 1) {
        const msg = `Invalid to position '${toArg}': must be a positive integer.`;
        if (isJsonMode()) {
          printJson(jsonError(ErrorCode.QUEUE_INVALID_POSITION, msg));
          return;
        }
        process.stderr.write(`error: ${msg}\n`);
        process.exitCode = 1;
        return;
      }

      const manager = makeManager();
      const updated = await manager.reorder(from, to);

      if (isJsonMode()) {
        printJson(jsonOk({ tasks: updated }));
        return;
      }
      process.stdout.write(`Moved task from position ${from} to position ${to}.\n`);
    });

  // ── pause / resume ─────────────────────────────────────────────────────────

  queue
    .command('pause')
    .description('pause task dispatch without stopping the daemon')
    .action(async () => {
      const manager = makeManager();
      let result;
      try {
        result = await manager.pause();
      } catch (err) {
        if (err instanceof ScrowError) {
          if (isJsonMode()) {
            printJson(jsonError(err.code, err.message));
            return;
          }
          process.stderr.write(`error: ${err.message}\n`);
          process.exitCode = 1;
          return;
        }
        throw err;
      }

      const message = result.changed
        ? 'Queue paused (daemon will not dispatch)'
        : 'Queue already paused (no change)';

      if (isJsonMode()) {
        printJson(jsonOk({ paused: result.paused, changed: result.changed, message }));
        return;
      }
      process.stdout.write(`\u2713 ${message}\n`);
    });

  queue
    .command('resume')
    .description('resume task dispatch')
    .action(async () => {
      const manager = makeManager();
      let result;
      try {
        result = await manager.resume();
      } catch (err) {
        if (err instanceof ScrowError) {
          if (isJsonMode()) {
            printJson(jsonError(err.code, err.message));
            return;
          }
          process.stderr.write(`error: ${err.message}\n`);
          process.exitCode = 1;
          return;
        }
        throw err;
      }

      const message = result.changed
        ? 'Queue resumed (daemon will dispatch)'
        : 'Queue already resumed (no change)';

      if (isJsonMode()) {
        printJson(jsonOk({ paused: result.paused, changed: result.changed, message }));
        return;
      }
      process.stdout.write(`\u2713 ${message}\n`);
    });
}
