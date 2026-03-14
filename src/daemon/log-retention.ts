/** Log retention cleanup — deletes audit JSONL files and task output files older than the configured retention period. */
import { readdir, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../utils/index.js';
import { AUDIT_LOG_FILENAME_REGEX } from '../utils/index.js';
import { TASK_OUTPUT_FILENAME_REGEX } from './task-output-writer.js';

/** Deletes audit log files in logsDir that are older than retentionDays.
 *  Returns lists of deleted and retained filenames. Idempotent: ENOENT on delete is not an error. */
export async function cleanExpiredLogs(
  logsDir: string,
  retentionDays: number,
): Promise<{ deleted: string[]; retained: string[] }> {
  let entries: string[];
  try {
    entries = await readdir(logsDir);
  } catch {
    return { deleted: [], retained: [] };
  }

  const today = new Date();
  // Compute the cutoff date at start-of-day UTC
  const cutoff = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);

  const deleted: string[] = [];
  const retained: string[] = [];

  for (const name of entries) {
    const m = AUDIT_LOG_FILENAME_REGEX.exec(name);
    if (!m) continue;

    const fileDate = new Date(`${m[1]}T00:00:00.000Z`);
    const ageMs = cutoff.getTime() - fileDate.getTime();
    const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));

    if (fileDate < cutoff) {
      const filePath = join(logsDir, name);
      try {
        await unlink(filePath);
        void logger.info('logs.retention.deleted', { file: name, age: ageDays });
        deleted.push(name);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          // Already deleted — idempotent, treat as successfully deleted
          deleted.push(name);
        } else {
          // Permission error or other unexpected failure — warn and skip (do NOT count as deleted)
          void logger.warn('logs.retention.unlink-failed', { file: name, code: code ?? 'UNKNOWN' });
        }
      }
    } else {
      retained.push(name);
    }
  }

  void logger.info('logs.retention.complete', {
    deleted: deleted.length,
    retained: retained.length,
  });

  return { deleted, retained };
}

/** Deletes task output files in taskOutputsDir that are older than retentionDays.
 *  Uses file mtime for age determination since output files are named by UUID (no embedded date).
 *  Returns lists of deleted and retained filenames. Non-fatal: errors are logged and skipped. */
export async function cleanExpiredTaskOutputs(
  taskOutputsDir: string,
  retentionDays: number,
): Promise<{ deleted: string[]; retained: string[] }> {
  let entries: string[];
  try {
    entries = await readdir(taskOutputsDir);
  } catch {
    return { deleted: [], retained: [] };
  }

  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const deleted: string[] = [];
  const retained: string[] = [];

  for (const name of entries) {
    if (!TASK_OUTPUT_FILENAME_REGEX.test(name)) continue;

    const filePath = join(taskOutputsDir, name);
    try {
      const fileStat = await stat(filePath);
      if (fileStat.mtimeMs < cutoffMs) {
        await unlink(filePath);
        void logger.info('task-outputs.retention.deleted', { file: name });
        deleted.push(name);
      } else {
        retained.push(name);
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        deleted.push(name);
      } else {
        void logger.warn('task-outputs.retention.failed', { file: name, code: code ?? 'UNKNOWN' });
      }
    }
  }

  void logger.info('task-outputs.retention.complete', {
    deleted: deleted.length,
    retained: retained.length,
  });

  return { deleted, retained };
}
