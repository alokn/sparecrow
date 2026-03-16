/** Atomic file write and safe JSON read helpers. */
import { writeFile, rename, readFile, mkdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ZodType } from 'zod';
import { ScrowError, ErrorCode } from '../errors/index.js';

/** Shared regex for matching audit log filenames (audit-YYYY-MM-DD.jsonl). */
export const AUDIT_LOG_FILENAME_REGEX = /^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** Atomically writes content to path via temp file + rename.
 *  Guarantees no partial-write corruption on process crash mid-write. */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${randomBytes(6).toString('hex')}`);
  try {
    await writeFile(tmp, content, { encoding: 'utf-8', mode: 0o600 });
    await rename(tmp, filePath);
  } catch (err) {
    // Best-effort cleanup of tmp file
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/** Safely reads and JSON-parses a file. Returns null if file doesn't exist or is corrupt.
 *  When a Zod schema is provided, validates the parsed result and throws ScrowError on failure. */
export async function safeReadJson<T = unknown>(filePath: string): Promise<T | null>;
export async function safeReadJson<T>(filePath: string, schema: ZodType<T>): Promise<T | null>;
export async function safeReadJson<T = unknown>(
  filePath: string,
  schema?: ZodType<T>,
): Promise<T | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(content);
    if (schema) {
      const result = schema.safeParse(parsed);
      if (!result.success) {
        throw new ScrowError(
          ErrorCode.DATA_INVALID,
          `Invalid JSON at ${filePath}: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        );
      }
      return result.data;
    }
    return parsed as T;
  } catch (err) {
    if (err instanceof ScrowError) {
      throw err;
    }
    const isExpected =
      err instanceof SyntaxError ||
      (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT');
    if (!isExpected) {
      const { logger } = await import('./logger.js');
      void logger.debug('fs.safeReadJson.unexpected_error', {
        path: filePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }
}
