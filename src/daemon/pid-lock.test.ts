/** Unit tests for PidLock — advisory file locking to prevent concurrent daemon instances. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PidLock, PID_LOCK_FILENAME } from './pid-lock.js';

describe('PidLock', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'sparecrow-pid-lock-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  describe('acquire()', () => {
    it('acquires lock and writes PID to lock file', async () => {
      const lock = new PidLock(dataDir);
      const result = await lock.acquire(12345);

      expect(result).toBe(true);

      const content = await readFile(join(dataDir, PID_LOCK_FILENAME), 'utf-8');
      expect(content.trim()).toBe('12345');

      await lock.release();
    });

    it('returns false when lock is held by a live process', async () => {
      const lock1 = new PidLock(dataDir);
      // Acquire with our own PID (guaranteed to be alive)
      const acquired1 = await lock1.acquire(process.pid);
      expect(acquired1).toBe(true);

      const lock2 = new PidLock(dataDir);
      const acquired2 = await lock2.acquire(99999);
      expect(acquired2).toBe(false);

      await lock1.release();
    });

    it('recovers from stale lock file (dead process crash simulation)', async () => {
      // Simulate a daemon crash: write a lock file with a dead PID directly,
      // without going through PidLock.release() (a crash leaves the file intact with no cleanup).
      // PID 999999 is chosen as a dead PID (will not exist on any reasonable system).
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(dataDir, PID_LOCK_FILENAME), '999999\n');

      // A new lock should detect the dead owner PID and recover via stale-lock removal.
      const lock2 = new PidLock(dataDir);
      const acquired2 = await lock2.acquire(process.pid);
      expect(acquired2).toBe(true);

      await lock2.release();
    });

    it('recovers from stale lock file with corrupt/empty content (ownerPid is null)', async () => {
      // Write a lock file with corrupt content — ownerPid will parse as null.
      // The acquire() stale-recovery branch treats null ownerPid as a dead/stale lock
      // and must remove it and re-acquire successfully.
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(dataDir, PID_LOCK_FILENAME), 'corrupt-content\n');

      const lock = new PidLock(dataDir);
      const acquired = await lock.acquire(process.pid);
      expect(acquired).toBe(true);

      // Verify the lock file now contains the new PID (not the corrupt content)
      const content = await readFile(join(dataDir, PID_LOCK_FILENAME), 'utf-8');
      expect(content.trim()).toBe(String(process.pid));

      await lock.release();
    });

    it('returns false when stale lock is removed but another process wins the race', async () => {
      // Simulate the race scenario: two processes both detect stale lock,
      // one wins the exclusive create. We test this by:
      // 1. Creating a stale lock (dead PID)
      // 2. Having a first lock acquire (succeeds — removes stale + creates new)
      // 3. Having a second lock try to acquire (fails — first lock holds it)
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(dataDir, PID_LOCK_FILENAME), '999999\n');

      // First lock acquires successfully (stale recovery)
      const lock1 = new PidLock(dataDir);
      const acquired1 = await lock1.acquire(process.pid);
      expect(acquired1).toBe(true);

      // Second lock should fail — first lock holds the file
      const lock2 = new PidLock(dataDir);
      const acquired2 = await lock2.acquire(12345);
      expect(acquired2).toBe(false);

      await lock1.release();
    });
  });

  describe('release()', () => {
    it('removes lock file and closes handle', async () => {
      const lock = new PidLock(dataDir);
      await lock.acquire(process.pid);
      await lock.release();

      const { access } = await import('node:fs/promises');
      await expect(access(join(dataDir, PID_LOCK_FILENAME))).rejects.toThrow();
    });

    it('is idempotent — second call does not throw', async () => {
      const lock = new PidLock(dataDir);
      await lock.acquire(process.pid);
      await lock.release();
      await lock.release(); // Should not throw
    });
  });

  describe('isHeld()', () => {
    it('returns true when lock is held by a live process', async () => {
      const lock = new PidLock(dataDir);
      await lock.acquire(process.pid);

      const checker = new PidLock(dataDir);
      expect(await checker.isHeld()).toBe(true);

      await lock.release();
    });

    it('returns false when no lock file exists', async () => {
      const lock = new PidLock(dataDir);
      expect(await lock.isHeld()).toBe(false);
    });

    it('returns false when lock file contains dead PID', async () => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(dataDir, PID_LOCK_FILENAME), '999999\n');

      const lock = new PidLock(dataDir);
      expect(await lock.isHeld()).toBe(false);
    });

    it('returns false when lock file has invalid content', async () => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(dataDir, PID_LOCK_FILENAME), 'not-a-number\n');

      const lock = new PidLock(dataDir);
      expect(await lock.isHeld()).toBe(false);
    });
  });

  describe('readOwnerPid()', () => {
    it('returns PID from lock file', async () => {
      const lock = new PidLock(dataDir);
      await lock.acquire(42);

      const reader = new PidLock(dataDir);
      expect(await reader.readOwnerPid()).toBe(42);

      await lock.release();
    });

    it('returns null when lock file does not exist', async () => {
      const lock = new PidLock(dataDir);
      expect(await lock.readOwnerPid()).toBeNull();
    });

    it('returns null for invalid content', async () => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(dataDir, PID_LOCK_FILENAME), 'garbage\n');

      const lock = new PidLock(dataDir);
      expect(await lock.readOwnerPid()).toBeNull();
    });

    it('returns null for empty file', async () => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(dataDir, PID_LOCK_FILENAME), '');

      const lock = new PidLock(dataDir);
      expect(await lock.readOwnerPid()).toBeNull();
    });
  });

  describe('PID_LOCK_FILENAME', () => {
    it('is daemon.pid.lock', () => {
      expect(PID_LOCK_FILENAME).toBe('daemon.pid.lock');
    });
  });
});
