/** Writes per-task stdout/stderr output to individual files for later retrieval. */
import { join } from 'node:path';
import { atomicWrite } from '../utils/index.js';
import { logger } from '../utils/index.js';
import type { TaskResult } from '../types/index.js';

/** Separator between stdout and stderr sections in the output file. */
const STDERR_DELIMITER = '\n--- stderr ---\n';

/** Regex matching task output filenames: strict UUID v4 format <uuid>.txt.
 *  Exported so log-retention.ts can reuse the same pattern — avoids silent divergence
 *  if the filename scheme changes. */
export const TASK_OUTPUT_FILENAME_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.txt$/i;

/** Builds the output file content from a TaskResult.
 *  Combines stdout and (if non-empty) stderr with a delimiter. */
export function buildOutputContent(result: TaskResult): string {
  let content = result.stdout;
  if (result.stderr && result.stderr.length > 0) {
    content += STDERR_DELIMITER + result.stderr;
  }
  return content;
}

/** Writes the task output file to <outputDir>/<taskId>.txt.
 *  Non-fatal: logs a warning on failure and does not rethrow. */
export async function writeTaskOutput(outputDir: string, result: TaskResult): Promise<void> {
  const filePath = join(outputDir, `${result.taskId}.txt`);
  const content = buildOutputContent(result);

  try {
    await atomicWrite(filePath, content);
    void logger.debug('task-output-writer.written', { taskId: result.taskId, filePath });
  } catch (err) {
    // Non-fatal: log warning and continue — must not break dispatch cycle
    void logger.warn('task-output-writer.write-failed', {
      taskId: result.taskId,
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
