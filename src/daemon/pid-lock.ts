/** Advisory PID file lock — prevents concurrent daemon instances via exclusive file lock. */
import { open, unlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import { logger } from '../utils/index.js';
import { processExists } from './pid-manager.js';

/** Lock file name — adjacent to daemon.pid in the data directory. */
export const PID_LOCK_FILENAME = 'daemon.pid.lock';

/**
 * PidLock provides advisory file locking for the daemon PID file.
 *
 * It uses O_EXCL (exclusive create) to atomically acquire a lock file.
 * The file handle is kept open for the daemon's lifetime. On process crash,
 * the OS closes the handle and the stale lock file is detected via PID check.
 *
 * This eliminates the TOCTOU race in the check-then-write PID pattern.
 */
export class PidLock {
  private readonly lockPath: string;
  private handle: FileHandle | null = null;
  /** True once acquire() has succeeded — prevents spurious release log on never-acquired locks. */
  private acquired = false;

  constructor(dataDir: string) {
    this.lockPath = join(dataDir, PID_LOCK_FILENAME);
  }

  /**
   * Acquires the advisory lock for the given PID.
   *
   * Uses O_EXCL (exclusive create) to atomically create the lock file.
   * If the lock file exists, checks if the owning process is still alive:
   * - If alive: throws (another daemon is running)
   * - If dead: removes stale lock and retries (crash recovery)
   *
   * The file handle is kept open for the daemon lifetime. The OS releases
   * it automatically on process exit or crash.
   *
   * @returns true if lock was acquired, false if another live process holds the lock
   */
  async acquire(pid: number): Promise<boolean> {
    try {
      // Atomic exclusive create — fails with EEXIST if file already exists
      const handle = await open(this.lockPath, 'wx');
      await handle.write(String(pid) + '\n');
      await handle.sync();
      this.handle = handle;
      this.acquired = true;
      void logger.debug('pid-lock.acquired', { pid, lockPath: this.lockPath });
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        throw err;
      }

      // Lock file exists — check if the owning process is still alive
      const ownerPid = await this.readOwnerPid();

      if (ownerPid !== null && processExists(ownerPid)) {
        // Another live daemon holds the lock
        void logger.debug('pid-lock.contention', {
          ownerPid,
          requestingPid: pid,
          lockPath: this.lockPath,
        });
        return false;
      }

      // Stale lock — previous daemon crashed without cleanup
      void logger.debug('pid-lock.stale_recovery', {
        stalePid: ownerPid,
        newPid: pid,
        lockPath: this.lockPath,
      });
      await this.removeStale();

      // Retry acquisition after stale removal
      try {
        const handle = await open(this.lockPath, 'wx');
        await handle.write(String(pid) + '\n');
        await handle.sync();
        this.handle = handle;
        this.acquired = true;
        void logger.debug('pid-lock.acquired_after_stale_recovery', {
          pid,
          lockPath: this.lockPath,
        });
        return true;
      } catch (retryErr) {
        const retryCode = (retryErr as NodeJS.ErrnoException).code;
        if (retryCode === 'EEXIST') {
          // Another process won the race between our unlink and re-create
          void logger.debug('pid-lock.race_lost', { pid, lockPath: this.lockPath });
          return false;
        }
        throw retryErr;
      }
    }
  }

  /**
   * Releases the advisory lock.
   * Closes the file handle and removes the lock file.
   * Safe to call multiple times (idempotent).
   */
  async release(): Promise<void> {
    if (this.handle !== null) {
      try {
        await this.handle.close();
      } catch {
        // Handle may already be closed — ignore
      }
      this.handle = null;
    }

    try {
      await unlink(this.lockPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        void logger.debug('pid-lock.release_unlink_error', {
          error: err instanceof Error ? err.message : String(err),
          lockPath: this.lockPath,
        });
      }
    }

    // Only emit 'released' log when the lock was successfully acquired — avoids spurious
    // audit entries when release() is called on a never-acquired lock (e.g. after contention).
    if (this.acquired) {
      void logger.debug('pid-lock.released', { lockPath: this.lockPath });
    }
  }

  /**
   * Checks if the lock is currently held by a live process.
   * Does NOT acquire the lock — read-only check.
   *
   * @returns true if lock file exists and owning process is alive
   */
  async isHeld(): Promise<boolean> {
    const ownerPid = await this.readOwnerPid();
    if (ownerPid === null) return false;
    return processExists(ownerPid);
  }

  /**
   * Returns the PID of the process holding the lock, or null if no lock file exists
   * or the lock file content is invalid.
   */
  async readOwnerPid(): Promise<number | null> {
    try {
      const content = await readFile(this.lockPath, 'utf-8');
      const parsed = parseInt(content.trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Removes a stale lock file. Used during crash recovery.
   */
  private async removeStale(): Promise<void> {
    try {
      await unlink(this.lockPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw err;
      }
    }
  }
}
