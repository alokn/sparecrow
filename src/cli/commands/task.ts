/** Task command — inspect and tail in-progress task output. */
import { readFile, access } from 'node:fs/promises';
import type { Command } from 'commander';
import { isJsonMode } from '../index.js';
import { printJson, color } from '../../ui/index.js';
import { jsonOk, jsonError } from '../../types/index.js';
import { ScrowError, ErrorCode } from '../../errors/index.js';
import { getPaths } from '../../platform/index.js';
import { QueueStore, QueueManager } from '../../queue/index.js';
import { partialOutputPath, finalOutputPath } from '../../daemon/partial-output-writer.js';

/** UUID regex for validating task IDs (path traversal prevention). */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Polling interval in ms for the fallback polling tail (when fs.watch is unavailable). */
const POLL_INTERVAL_MS = 500;

/** Default timeout in ms for tailWithPolling — prevents hanging forever if output never appears. */
const TAIL_TIMEOUT_MS = 30_000;

/** Creates a fresh QueueManager backed by platform data dir. */
function makeManager(): QueueManager {
  const store = new QueueStore(getPaths().data);
  return new QueueManager(store);
}

/**
 * Finds the active in-progress task ID.
 * Returns the task ID if exactly one task is in-progress.
 * Returns null if no in-progress task is found.
 * Throws TASK_PARTIAL_OUTPUT_NOT_FOUND if multiple tasks are in-progress (ambiguous).
 */
async function findActiveTaskId(): Promise<string | null> {
  const manager = makeManager();
  const tasks = await manager.list();
  const inProgress = tasks.filter((t) => t.status === 'in-progress');
  if (inProgress.length === 0) return null;
  if (inProgress.length === 1) return inProgress[0]!.id;
  // Multiple in-progress tasks — caller must specify which one
  throw new ScrowError(
    ErrorCode.TASK_AMBIGUOUS,
    `Multiple tasks are in-progress. Specify a task ID: ${inProgress.map((t) => t.id.slice(0, 8)).join(', ')}`,
  );
}

/**
 * Streams a partial output file to stdout, starting from `offset` characters.
 * Returns the new character offset after reading.
 * Non-fatal on ENOENT — returns offset unchanged.
 *
 * Offset is tracked in characters (string length), not bytes, so that
 * content.slice(offset) correctly handles multi-byte UTF-8 sequences
 * (e.g. emoji or non-ASCII output from Claude).
 */
async function streamFrom(partialPath: string, offset: number): Promise<number> {
  let content: string;
  try {
    content = await readFile(partialPath, 'utf-8');
  } catch {
    return offset;
  }

  if (content.length <= offset) return offset;

  const newContent = content.slice(offset);
  if (newContent.length > 0) {
    process.stdout.write(newContent);
  }
  return offset + newContent.length;
}

/**
 * Tails a partial output file until it disappears (task completed) or until the
 * finalPath appears (task completed and output promoted/written).
 * Uses fs.watch (callback-based) with a polling fallback.
 */
async function tailPartialFile(
  partialPath: string,
  finalPath: string,
  jsonMode: boolean,
  signal?: AbortSignal,
): Promise<void> {
  if (jsonMode) {
    // JSON mode: emit newline-delimited JSON chunks as data arrives
    await tailPartialJson(partialPath, finalPath, signal);
    return;
  }

  // Human-readable mode: always use polling-based tail for reliability.
  // fs.watch has platform-specific issues on Linux (inotify limits, WSL quirks);
  // polling at 500ms is responsive enough for a monitoring command.
  await tailWithPolling(partialPath, finalPath, signal);
}

/** Pure polling fallback for environments where fs.watch is unavailable.
 * Exported for unit testing of the timeout path.
 */
export async function tailWithPolling(
  partialPath: string,
  finalPath: string,
  signal?: AbortSignal,
  timeoutMs: number = TAIL_TIMEOUT_MS,
): Promise<void> {
  let offset = 0;
  let running = true;
  const deadline = Date.now() + timeoutMs;

  while (running) {
    if (signal?.aborted) break;

    if (Date.now() >= deadline) {
      process.stderr.write(
        `sparecrow: task tail timed out after ${timeoutMs}ms — final output never appeared\n`,
      );
      break;
    }

    offset = await streamFrom(partialPath, offset);

    // Check if task completed (final file exists)
    try {
      await access(finalPath);
      running = false;
      break;
    } catch {
      // Continue polling
    }

    // Check if partial file disappeared
    try {
      await access(partialPath);
    } catch {
      running = false;
      break;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/** JSON mode tail: emits newline-delimited JSON chunks from the partial file. */
async function tailPartialJson(
  partialPath: string,
  finalPath: string,
  signal?: AbortSignal,
): Promise<void> {
  // Offset is tracked in characters (string length) to correctly handle multi-byte UTF-8.
  let offset = 0;

  const emitChunk = async (): Promise<void> => {
    let content: string;
    try {
      content = await readFile(partialPath, 'utf-8');
    } catch {
      return;
    }

    if (content.length <= offset) return;

    const newContent = content.slice(offset);
    if (newContent.length === 0) return;

    offset += newContent.length;
    // The partial file interleaves stdout and stderr from the subprocess without
    // stream-origin markers. We default to 'stdout' as the file primarily captures
    // stdout content (stderr is also written to the same file by the daemon).
    const record: { ts: string; stream: 'stdout' | 'stderr'; data: string } = {
      ts: new Date().toISOString(),
      stream: 'stdout',
      data: newContent,
    };
    process.stdout.write(JSON.stringify(record) + '\n');
  };

  await emitChunk();

  let running = true;
  while (running) {
    if (signal?.aborted) break;

    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    await emitChunk();

    try {
      await access(finalPath);
      running = false;
    } catch {
      // Continue
    }

    try {
      await access(partialPath);
    } catch {
      running = false;
    }
  }
}

export function registerTask(program: Command): void {
  const task = program.command('task').description('inspect and monitor in-progress tasks');

  // sparecrow task tail [task-id]
  task
    .command('tail [task-id]')
    .description('stream live output from an in-progress task')
    .action(async (taskIdArg: string | undefined) => {
      const jsonMode = isJsonMode();

      try {
        let taskId: string;

        if (taskIdArg !== undefined) {
          // Validate UUID format
          if (!UUID_REGEX.test(taskIdArg)) {
            const message = `Invalid task ID format: "${taskIdArg}". Must be a UUID.`;
            if (jsonMode) {
              printJson(jsonError(ErrorCode.INVALID_ARGUMENT, message));
              return;
            }
            process.stderr.write(`Error: ${message}\n`);
            process.exitCode = 1;
            return;
          }
          taskId = taskIdArg;
        } else {
          // Auto-detect active task
          const activeId = await findActiveTaskId();
          if (activeId === null) {
            const message =
              'No in-progress task found. Start a task via the daemon or specify a task ID.';
            if (jsonMode) {
              printJson(jsonError(ErrorCode.TASK_PARTIAL_OUTPUT_NOT_FOUND, message));
              return;
            }
            process.stdout.write(`${message}\n`);
            process.stdout.write(
              `  Hint: run 'sparecrow queue' to see queued tasks or 'sparecrow daemon start' to begin dispatch.\n`,
            );
            return;
          }
          taskId = activeId;
        }

        const taskOutputsDir = getPaths().taskOutputs;
        const partialPath = partialOutputPath(taskOutputsDir, taskId);
        const finalPath = finalOutputPath(taskOutputsDir, taskId);

        // Check if partial file exists
        try {
          await access(partialPath);
        } catch {
          // Partial file not found — check if the task even exists in the queue
          const manager = makeManager();
          const tasks = await manager.list();
          const task = tasks.find((t) => t.id === taskId);

          if (!task) {
            const message = `No task found with ID ${taskId.slice(0, 8)}.`;
            if (jsonMode) {
              printJson(jsonError(ErrorCode.TASK_PARTIAL_OUTPUT_NOT_FOUND, message));
              return;
            }
            process.stderr.write(`Error: ${message}\n`);
            process.exitCode = 1;
            return;
          }

          if (task.status !== 'in-progress') {
            // Task is in queue but not running — no partial output yet
            const message = `Task '${task.name}' is ${task.status}, not in-progress. No live output available.`;
            if (jsonMode) {
              printJson(jsonError(ErrorCode.TASK_PARTIAL_OUTPUT_NOT_FOUND, message));
              return;
            }
            process.stdout.write(`${message}\n`);
            if (task.status === 'done' || task.status === 'failed') {
              process.stdout.write(
                `  Hint: run 'sparecrow logs --output ${taskId}' to view the completed output.\n`,
              );
            }
            return;
          }

          // Task is in-progress but partial file doesn't exist yet — it may be starting up
          if (jsonMode) {
            printJson(
              jsonError(
                ErrorCode.TASK_PARTIAL_OUTPUT_NOT_FOUND,
                `No live output yet for task ${taskId.slice(0, 8)}. The daemon may still be initializing the task.`,
              ),
            );
            return;
          }
          process.stdout.write(color.dim(`Waiting for task '${task.name}' to produce output...\n`));
          // Fall through to tail (will poll until partial file appears or task completes)
        }

        if (!jsonMode) {
          // Find the task name for display purposes (best-effort)
          let taskName = taskId.slice(0, 8);
          try {
            const manager = makeManager();
            const tasks = await manager.list();
            const t = tasks.find((t) => t.id === taskId);
            if (t) taskName = t.name;
          } catch {
            // ignore
          }
          process.stdout.write(
            color.dim(`Tailing output for task '${taskName}' (${taskId.slice(0, 8)})...\n`),
          );
          process.stdout.write(color.dim('Press Ctrl+C to stop tailing.\n\n'));
        }

        // Install SIGINT handler so Ctrl+C prints a clean exit message before terminating.
        const abortController = new AbortController();
        const sigintHandler = (): void => {
          abortController.abort();
          if (!jsonMode) {
            process.stdout.write(color.dim('\n[Task output stream ended]\n'));
            process.stdout.write(
              color.dim(
                `  Hint: run 'sparecrow logs --output ${taskId}' to view the complete output.\n`,
              ),
            );
          }
          process.exit(0);
        };
        process.once('SIGINT', sigintHandler);

        await tailPartialFile(partialPath, finalPath, jsonMode, abortController.signal);

        // Remove SIGINT handler if polling ended naturally (task completed).
        process.removeListener('SIGINT', sigintHandler);

        if (!jsonMode) {
          process.stdout.write(color.dim('\n[Task output stream ended]\n'));
        }

        // Show hint to view full output
        if (!jsonMode) {
          process.stdout.write(
            color.dim(
              `  Hint: run 'sparecrow logs --output ${taskId}' to view the complete output.\n`,
            ),
          );
        } else {
          // JSON mode: emit a final summary record
          printJson(jsonOk({ taskId, status: 'tail-completed' }));
        }
      } catch (err) {
        const typedErr =
          err instanceof ScrowError
            ? err
            : new ScrowError(
                ErrorCode.TASK_EXECUTION_FAILED,
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
