/** Async queue persistence: atomic write, zod-validated read, and corruption recovery. */
import { readFile, rename, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { TaskDefinition } from '../types/index.js';
import { ScrowError, ErrorCode } from '../errors/index.js';
import { logger } from '../utils/index.js';
import { QueuePayloadSchema, type PersistedTask } from './queue-schema.js';

const QUEUE_FILE = 'queue.json';
const QUEUE_VERSION = 1;

/** Default task timeout: 60 minutes in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

function toPersistedTask(task: TaskDefinition): PersistedTask {
  const createdAt =
    task.createdAt instanceof Date ? task.createdAt.toISOString() : String(task.createdAt);
  const completedAt =
    task.completedAt instanceof Date ? task.completedAt.toISOString() : task.completedAt;
  const base = {
    id: task.id,
    name: task.name,
    status: task.status,
    prompt: task.prompt,
    targetPath: task.targetPath,
    priority: task.priority,
    createdAt,
    ...(completedAt !== undefined ? { completedAt } : {}),
    timeoutMs: task.timeoutMs,
    actions: Array.from(task.actions),
  };
  if (task.type === 'template') {
    return { ...base, type: 'template', templateName: task.templateName ?? '' };
  }
  return { ...base, type: 'custom' };
}

function fromPersistedTask(pt: PersistedTask): TaskDefinition {
  const base = {
    id: pt.id,
    name: pt.name,
    status: pt.status,
    prompt: pt.prompt,
    targetPath: pt.targetPath,
    priority: pt.priority,
    createdAt: new Date(pt.createdAt),
    ...(pt.completedAt !== undefined ? { completedAt: new Date(pt.completedAt) } : {}),
    timeoutMs: pt.timeoutMs,
    actions: pt.actions ?? [],
  };
  if (pt.type === 'template') {
    return { ...base, type: 'template', templateName: pt.templateName };
  }
  return { ...base, type: 'custom' };
}

/** Manages reading and writing queue.json with atomic writes and corruption recovery. */
export class QueueStore {
  readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, QUEUE_FILE);
  }

  /** Reads and validates queue.json. Returns { tasks: [], paused: false } on missing file; logs, backs up, and returns { tasks: [], paused: false } on corruption. */
  async read(): Promise<{ tasks: TaskDefinition[]; paused: boolean }> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf-8');
    } catch (err) {
      const isNotFound = err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT';
      if (isNotFound) {
        return { tasks: [], paused: false };
      }
      throw new ScrowError(
        ErrorCode.QUEUE_CORRUPT,
        `Failed to read queue file: ${(err as Error).message}`,
        err as Error,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this._handleCorruption(raw, 'JSON parse failure');
      return { tasks: [], paused: false };
    }

    const result = QueuePayloadSchema.safeParse(parsed);
    if (!result.success) {
      await this._handleCorruption(raw, 'Schema validation failure');
      return { tasks: [], paused: false };
    }

    return {
      tasks: result.data.tasks.map(fromPersistedTask),
      paused: result.data.paused,
    };
  }

  /** Atomically writes tasks and paused state to queue.json via temp file + rename on same filesystem. */
  async write(data: { tasks: TaskDefinition[]; paused: boolean }): Promise<void> {
    const payload = {
      version: QUEUE_VERSION,
      tasks: data.tasks.map(toPersistedTask),
      paused: data.paused,
    };
    const content = JSON.stringify(payload, null, 2);

    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });

    const tmp = join(dir, `.tmp-queue-${randomBytes(6).toString('hex')}`);
    try {
      await writeFile(tmp, content, { encoding: 'utf-8', mode: 0o600 });
      await rename(tmp, this.filePath);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw new ScrowError(
        ErrorCode.QUEUE_WRITE_FAILED,
        `Failed to write queue file: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  private async _handleCorruption(raw: string, reason: string): Promise<void> {
    void logger.error('queue.corrupt', { reason, filePath: this.filePath });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${this.filePath}.backup-${timestamp}`;
    try {
      await writeFile(backupPath, raw, { encoding: 'utf-8', mode: 0o600 });
      void logger.info('queue.backup_created', { backupPath });
    } catch (backupErr) {
      void logger.error('queue.backup_failed', { backupPath }, backupErr as Error);
    }
  }
}
