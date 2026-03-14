/** Manages incremental writes of live task stdout/stderr to a .partial.txt file during execution. */
import { createWriteStream, type WriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../utils/index.js';

/** Debounce interval in ms — flush accumulated chunks to disk at most once per interval. */
const DEFAULT_DEBOUNCE_MS = 3000;

/** Regex matching partial output filenames: <uuid>.partial.txt */
export const TASK_PARTIAL_OUTPUT_FILENAME_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.partial\.txt$/i;

/** Returns the path for the in-progress partial output file for a given task. */
export function partialOutputPath(outputDir: string, taskId: string): string {
  return join(outputDir, `${taskId}.partial.txt`);
}

/** Returns the path for the final output file for a given task. */
export function finalOutputPath(outputDir: string, taskId: string): string {
  return join(outputDir, `${taskId}.txt`);
}

/**
 * PartialOutputWriter streams chunks to a .partial.txt file during task execution.
 * It buffers incoming chunks and flushes to disk on a debounced interval to avoid
 * excessive I/O. The partial file is an append-only stream — safe to read concurrently.
 *
 * Lifecycle:
 *  1. open() — creates/opens the WriteStream
 *  2. write(chunk) — buffers and schedules a debounced flush
 *  3. close() — flushes remaining data, closes the stream
 *  4. finalize(finalPath) — atomically renames .partial.txt to the final .txt file
 *  5. cleanup() — removes the .partial.txt file (called on task failure/abort)
 */
export class PartialOutputWriter {
  private readonly _path: string;
  private _stream: WriteStream | null = null;
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;
  private _pendingBuffer = '';
  private _closed = false;
  private readonly _debounceMs: number;

  constructor(outputDir: string, taskId: string, debounceMs: number = DEFAULT_DEBOUNCE_MS) {
    this._path = partialOutputPath(outputDir, taskId);
    this._debounceMs = debounceMs;
  }

  /** Returns the path to the partial output file. */
  get path(): string {
    return this._path;
  }

  /** Opens the append WriteStream. Must be called before write(). Non-fatal on error. */
  open(): void {
    if (this._stream !== null || this._closed) return;
    try {
      // 'a' flag: append-only, creates file if absent. Safe for concurrent reads.
      this._stream = createWriteStream(this._path, { flags: 'a', encoding: 'utf-8', mode: 0o600 });
      this._stream.on('error', (err) => {
        void logger.warn('partial-output-writer.stream-error', {
          path: this._path,
          error: err.message,
        });
      });
    } catch (err) {
      // Non-fatal — live streaming is best-effort; task dispatch must not be blocked.
      void logger.warn('partial-output-writer.open-failed', {
        path: this._path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Appends a chunk to the internal buffer and schedules a debounced flush. Non-fatal on error. */
  write(chunk: string): void {
    if (this._closed || this._stream === null) return;
    this._pendingBuffer += chunk;
    this._scheduledFlush();
  }

  /** Schedules a flush after debounceMs if none is pending. */
  private _scheduledFlush(): void {
    if (this._flushTimer !== null) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this._flushNow();
    }, this._debounceMs);
  }

  /** Immediately flushes the pending buffer to the WriteStream. Non-fatal. */
  private _flushNow(): void {
    if (this._stream === null || this._pendingBuffer.length === 0) return;
    const data = this._pendingBuffer;
    this._pendingBuffer = '';
    // WriteStream.write() is asynchronous and non-blocking — errors surface via 'error' event.
    this._stream.write(data);
  }

  /**
   * Flushes remaining data and closes the WriteStream.
   * Must be awaited before calling finalize() or cleanup().
   */
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;

    // Cancel any pending debounce timer and flush immediately.
    if (this._flushTimer !== null) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    this._flushNow();

    await new Promise<void>((resolve) => {
      if (this._stream === null) {
        resolve();
        return;
      }
      this._stream.end(() => resolve());
    });
    this._stream = null;
  }

  /**
   * Removes the partial output file. Call on task failure or abort (AC3).
   * Non-fatal: logs warning on unexpected errors, ignores ENOENT.
   */
  async cleanup(): Promise<void> {
    try {
      await unlink(this._path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        void logger.warn('partial-output-writer.cleanup-failed', {
          path: this._path,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
