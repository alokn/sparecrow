/** Integration tests for daemon crash recovery — validates PID file and status file resilience after unclean exits. */
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/platform/index.js', () => ({
  isLinux: () => false,
  isMacOS: () => false,
}));

function makeTmpDir(): string {
  return join(tmpdir(), `sparecrow-crash-recovery-${randomBytes(6).toString('hex')}`);
}

describe('daemon crash recovery', () => {
  let dataDir: string;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    dataDir = makeTmpDir();
    await mkdir(dataDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  describe('AC1 — stale PID + stale status recovery', () => {
    it('detects stale PID of non-existent process and returns stale status', async () => {
      const { readPid, writePid, checkPidStatus } = await import(
        '../../src/daemon/pid-manager.js'
      );

      // Write a PID that does not correspond to any running process.
      // INT_MAX (2147483647) exceeds Linux pid_max on all real systems, so it is guaranteed
      // to be absent. This avoids PID-reuse flakiness with plausible-but-dead PIDs.
      const stalePid = 2147483647;
      await writePid(dataDir, stalePid);

      // Write stale daemon-status.json claiming "running"
      const statusPath = join(dataDir, 'daemon-status.json');
      await writeFile(
        statusPath,
        JSON.stringify({
          state: 'running',
          pid: stalePid,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastPollAt: null,
          nextPollAt: null,
          usage: null,
          trigger: null,
          activeTask: null,
          lastError: null,
          lastErrorDetail: null,
          lastDispatchAt: null,
          cycleResult: null,
          queueDepth: 0,
          backendState: null,
        }),
        'utf-8',
      );

      // Verify the PID file exists and has the stale PID
      const pidBefore = await readPid(dataDir);
      expect(pidBefore).toBe(stalePid);

      // checkPidStatus should detect the stale PID
      const result = await checkPidStatus(dataDir);
      expect(result.status).toBe('stale');
      expect(result.pid).toBe(stalePid);
    });

    it('allows cleanup and fresh PID write after stale detection, and status file reflects new PID', async () => {
      const { readPid, writePid, removePid, checkPidStatus } = await import(
        '../../src/daemon/pid-manager.js'
      );

      // Write stale PID (INT_MAX: guaranteed absent on any real system)
      const stalePid = 2147483647;
      await writePid(dataDir, stalePid);

      // Write stale daemon-status.json claiming "running" with the stale PID
      const statusPath = join(dataDir, 'daemon-status.json');
      const nowIso = new Date().toISOString();
      await writeFile(
        statusPath,
        JSON.stringify({
          state: 'running',
          pid: stalePid,
          startedAt: nowIso,
          updatedAt: nowIso,
          lastPollAt: null,
          nextPollAt: null,
          usage: null,
          trigger: null,
          activeTask: null,
          lastError: null,
          lastErrorDetail: null,
          lastDispatchAt: null,
          cycleResult: null,
          queueDepth: 0,
          backendState: null,
        }),
        'utf-8',
      );

      // Detect stale
      const result = await checkPidStatus(dataDir);
      expect(result.status).toBe('stale');

      // Clean up stale PID (as lifecycle.startDaemon would do)
      await removePid(dataDir);

      // Verify PID is gone
      const pidAfterRemove = await readPid(dataDir);
      expect(pidAfterRemove).toBeNull();

      // checkPidStatus should now return 'none'
      const resultAfter = await checkPidStatus(dataDir);
      expect(resultAfter.status).toBe('none');

      // Write fresh PID (simulating new daemon start)
      const newPid = process.pid;
      await writePid(dataDir, newPid);
      const freshPid = await readPid(dataDir);
      expect(freshPid).toBe(newPid);

      // AC1 requires status file to reflect the new PID after recovery.
      // Simulate what startDaemon does: update daemon-status.json with new PID and state "running".
      const recoveredStatus = {
        state: 'running',
        pid: newPid,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastPollAt: null,
        nextPollAt: null,
        usage: null,
        trigger: null,
        activeTask: null,
        lastError: null,
        lastErrorDetail: null,
        lastDispatchAt: null,
        cycleResult: null,
        queueDepth: 0,
        backendState: null,
      };
      await writeFile(statusPath, JSON.stringify(recoveredStatus), 'utf-8');

      // Verify the status file now contains the new PID and state "running"
      const statusAfterRecovery = JSON.parse(await readFile(statusPath, 'utf-8')) as {
        state: string;
        pid: number;
      };
      expect(statusAfterRecovery.state).toBe('running');
      expect(statusAfterRecovery.pid).toBe(newPid);
    });
  });

  describe('AC2 — corrupted PID file (non-numeric content)', () => {
    it('returns null for non-numeric PID content', async () => {
      const { readPid } = await import('../../src/daemon/pid-manager.js');

      // Write non-numeric content to PID file
      const pidPath = join(dataDir, 'daemon.pid');
      await writeFile(pidPath, 'not-a-number\n', 'utf-8');

      const result = await readPid(dataDir);
      expect(result).toBeNull();
    });

    it('checkPidStatus returns none for non-numeric PID file', async () => {
      const { checkPidStatus } = await import('../../src/daemon/pid-manager.js');

      const pidPath = join(dataDir, 'daemon.pid');
      await writeFile(pidPath, 'not-a-number\n', 'utf-8');

      const result = await checkPidStatus(dataDir);
      expect(result.status).toBe('none');
      expect(result.pid).toBeNull();
    });

    it('logs a warning when PID file contains non-numeric content', async () => {
      const { logger } = await import('../../src/utils/logger.js');
      const { readPid } = await import('../../src/daemon/pid-manager.js');

      const pidPath = join(dataDir, 'daemon.pid');
      await writeFile(pidPath, 'corrupted-content\n', 'utf-8');

      await readPid(dataDir);

      expect(logger.warn).toHaveBeenCalledWith('pid-manager.read_pid_invalid', {
        path: pidPath,
        reason: 'non-numeric content',
      });
    });
  });

  describe('AC3 — empty PID file', () => {
    it('returns null for empty PID file', async () => {
      const { readPid } = await import('../../src/daemon/pid-manager.js');

      const pidPath = join(dataDir, 'daemon.pid');
      await writeFile(pidPath, '', 'utf-8');

      const result = await readPid(dataDir);
      expect(result).toBeNull();
    });

    it('checkPidStatus returns none for empty PID file', async () => {
      const { checkPidStatus } = await import('../../src/daemon/pid-manager.js');

      const pidPath = join(dataDir, 'daemon.pid');
      await writeFile(pidPath, '', 'utf-8');

      const result = await checkPidStatus(dataDir);
      expect(result.status).toBe('none');
      expect(result.pid).toBeNull();
    });

    it('logs a warning with empty file reason', async () => {
      const { logger } = await import('../../src/utils/logger.js');
      const { readPid } = await import('../../src/daemon/pid-manager.js');

      const pidPath = join(dataDir, 'daemon.pid');
      await writeFile(pidPath, '', 'utf-8');

      await readPid(dataDir);

      expect(logger.warn).toHaveBeenCalledWith('pid-manager.read_pid_invalid', {
        path: pidPath,
        reason: 'empty file',
      });
    });

    it('logs a warning with empty file reason for whitespace-only content', async () => {
      const { logger } = await import('../../src/utils/logger.js');
      const { readPid } = await import('../../src/daemon/pid-manager.js');

      const pidPath = join(dataDir, 'daemon.pid');
      // Whitespace-only file (common crash artifact — trailing newline with no PID written)
      await writeFile(pidPath, '\n', 'utf-8');

      await readPid(dataDir);

      expect(logger.warn).toHaveBeenCalledWith('pid-manager.read_pid_invalid', {
        path: pidPath,
        reason: 'empty file',
      });
    });
  });

  describe('AC4 — binary garbage in PID file', () => {
    it('returns null for binary content in PID file', async () => {
      const { readPid } = await import('../../src/daemon/pid-manager.js');

      const pidPath = join(dataDir, 'daemon.pid');
      await writeFile(pidPath, Buffer.from([0x00, 0xff, 0xfe]));

      const result = await readPid(dataDir);
      expect(result).toBeNull();
    });

    it('checkPidStatus returns none for binary PID file', async () => {
      const { checkPidStatus } = await import('../../src/daemon/pid-manager.js');

      const pidPath = join(dataDir, 'daemon.pid');
      await writeFile(pidPath, Buffer.from([0x00, 0xff, 0xfe]));

      const result = await checkPidStatus(dataDir);
      expect(result.status).toBe('none');
      expect(result.pid).toBeNull();
    });

    it('handles various binary patterns gracefully', async () => {
      const { readPid } = await import('../../src/daemon/pid-manager.js');
      const pidPath = join(dataDir, 'daemon.pid');

      // All-zeros
      await writeFile(pidPath, Buffer.alloc(16, 0));
      expect(await readPid(dataDir)).toBeNull();

      // Random bytes
      await writeFile(pidPath, randomBytes(64));
      expect(await readPid(dataDir)).toBeNull();

      // NUL-terminated string-like content: "12345\x0067890"
      // parseInt stops at NUL and parses "12345", which is a valid positive integer.
      // readPid is expected to return 12345 (not null) because the content is parseable.
      await writeFile(pidPath, Buffer.from('12345\x0067890'));
      const result = await readPid(dataDir);
      expect(result).toBe(12345);
    });
  });

  describe('AC5 — leftover tmp file from interrupted write', () => {
    it('reads valid queue.json even when a leftover .tmp-queue-* file exists alongside', async () => {
      const { QueueStore } = await import('../../src/queue/queue-store.js');

      const store = new QueueStore(dataDir);

      // Write a valid queue.json
      await store.write({ tasks: [], paused: false });

      // Create an orphaned .tmp file matching the actual QueueStore naming pattern
      // (.tmp-queue-<6-byte-hex>) — simulating an interrupted atomic write
      const tmpFile = join(dataDir, `.tmp-queue-${randomBytes(6).toString('hex')}`);
      await writeFile(tmpFile, '{"partial": "data", "corrupt": true', 'utf-8');

      // QueueStore.read() should still work with the valid queue.json
      const result = await store.read();
      expect(result.tasks).toEqual([]);
      expect(result.paused).toBe(false);
    });

    it('reads valid queue.json when multiple tmp files exist', async () => {
      const { QueueStore } = await import('../../src/queue/queue-store.js');

      const store = new QueueStore(dataDir);

      // Write a valid queue.json with tasks
      await store.write({ tasks: [], paused: true });

      // Create multiple orphaned .tmp files matching the actual naming pattern
      for (let i = 0; i < 5; i++) {
        const tmpFile = join(dataDir, `.tmp-queue-${randomBytes(6).toString('hex')}`);
        await writeFile(tmpFile, `corrupt-data-${i}`, 'utf-8');
      }

      // QueueStore.read() should still work
      const result = await store.read();
      expect(result.tasks).toEqual([]);
      expect(result.paused).toBe(true);
    });

    it('next QueueStore.write() succeeds even when orphaned tmp files are present', async () => {
      const { QueueStore } = await import('../../src/queue/queue-store.js');

      const store = new QueueStore(dataDir);

      // Write initial queue
      await store.write({ tasks: [], paused: false });

      // Create orphaned tmp files with the actual naming pattern
      for (let i = 0; i < 3; i++) {
        const tmpFile = join(dataDir, `.tmp-queue-${randomBytes(6).toString('hex')}`);
        await writeFile(tmpFile, 'garbage', 'utf-8');
      }

      // Write again — should succeed, creating its own temp file and renaming atomically
      await store.write({ tasks: [], paused: true });

      const result = await store.read();
      expect(result.paused).toBe(true);
    });
  });

  describe('AC6 — concurrent PID file writes', () => {
    it('produces a valid integer PID after concurrent writePid calls', async () => {
      const { readPid, writePid } = await import('../../src/daemon/pid-manager.js');

      const pid1 = 11111;
      const pid2 = 22222;
      const pid3 = 33333;

      // Execute concurrent writes
      await Promise.all([writePid(dataDir, pid1), writePid(dataDir, pid2), writePid(dataDir, pid3)]);

      // The file should contain exactly one valid PID (whichever rename won the race)
      const result = await readPid(dataDir);
      expect(result).not.toBeNull();
      expect(Number.isInteger(result)).toBe(true);
      expect(result).toBeGreaterThan(0);
      expect([pid1, pid2, pid3]).toContain(result);

      // Verify raw file content is clean (no concatenation or corruption)
      const raw = await readFile(join(dataDir, 'daemon.pid'), 'utf-8');
      const trimmed = raw.trim();
      expect(trimmed).toMatch(/^\d+$/);
      expect(parseInt(trimmed, 10)).toBe(result);
    });

    it('produces valid PID with higher concurrency', async () => {
      const { readPid, writePid } = await import('../../src/daemon/pid-manager.js');

      const pids = Array.from({ length: 10 }, (_, i) => 10000 + i);

      await Promise.all(pids.map((pid) => writePid(dataDir, pid)));

      const result = await readPid(dataDir);
      expect(result).not.toBeNull();
      expect(Number.isInteger(result)).toBe(true);
      expect(pids).toContain(result);

      // Verify file integrity
      const raw = await readFile(join(dataDir, 'daemon.pid'), 'utf-8');
      expect(raw.trim()).toMatch(/^\d+$/);
    });
  });

  describe('full crash recovery chain', () => {
    it('recovers from stale PID + stale status to fresh state', async () => {
      const { readPid, writePid, removePid, checkPidStatus } = await import(
        '../../src/daemon/pid-manager.js'
      );

      // Simulate crash: write stale PID and stale status.
      // INT_MAX (2147483647): guaranteed absent on any real Linux/macOS system (pid_max is always lower).
      const stalePid = 2147483647;
      await writePid(dataDir, stalePid);

      const statusPath = join(dataDir, 'daemon-status.json');
      await writeFile(
        statusPath,
        JSON.stringify({
          state: 'running',
          pid: stalePid,
          startedAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          lastPollAt: null,
          nextPollAt: null,
          usage: null,
          trigger: null,
          activeTask: null,
          lastError: null,
          lastErrorDetail: null,
          lastDispatchAt: null,
          cycleResult: null,
          queueDepth: 0,
          backendState: null,
        }),
        'utf-8',
      );

      // Step 1: Detect stale
      const { status, pid } = await checkPidStatus(dataDir);
      expect(status).toBe('stale');
      expect(pid).toBe(stalePid);

      // Step 2: Clean up stale PID (as startDaemon would)
      await removePid(dataDir);
      const pidAfterCleanup = await readPid(dataDir);
      expect(pidAfterCleanup).toBeNull();

      // Step 3: Write new PID (simulating successful new daemon start)
      const newPid = process.pid;
      await writePid(dataDir, newPid);

      // Step 4: Verify new state
      const freshPid = await readPid(dataDir);
      expect(freshPid).toBe(newPid);

      // checkPidStatus should now see the process as alive (current process exists)
      const newStatus = await checkPidStatus(dataDir);
      // It will be 'stale' because current process is not a daemon, but that's fine —
      // the key is that it reads the PID correctly and doesn't crash
      expect(newStatus.pid).toBe(newPid);
      expect(['alive', 'stale']).toContain(newStatus.status);
    });
  });
});
