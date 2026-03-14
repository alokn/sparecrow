/** PID file management — read, write (atomic), remove, stale-PID detection, and orphan scan for the daemon. */
import { readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { atomicWrite } from '../utils/index.js';
import { isLinux, isMacOS } from '../platform/index.js';
import { logger } from '../utils/index.js';
import { EventName } from '../types/index.js';

const execFileAsync = promisify(execFile);

/** Filename constant for the PID file — prevents path drift across modules. */
export const DAEMON_PID_FILENAME = 'daemon.pid';
/** Filename constant for the daemon status JSON file. */
export const DAEMON_STATUS_FILENAME = 'daemon-status.json';

/** Marker environment variable set in daemon child process for identity validation. */
export const DAEMON_IDENTITY_ENV = 'SPARECROW_DAEMON_PROCESS';
/** Marker value for identity validation. */
export const DAEMON_IDENTITY_VALUE = '1';

/** Reads the PID from the pid file. Returns null if file is missing or contains invalid content. */
export async function readPid(dataDir: string): Promise<number | null> {
  const pidPath = join(dataDir, DAEMON_PID_FILENAME);
  try {
    const content = await readFile(pidPath, 'utf-8');
    const parsed = parseInt(content.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    return null;
  } catch {
    return null;
  }
}

/** Atomically writes the given PID to the pid file. */
export async function writePid(dataDir: string, pid: number): Promise<void> {
  const pidPath = join(dataDir, DAEMON_PID_FILENAME);
  await atomicWrite(pidPath, String(pid) + '\n');
}

/** Removes the PID file. Silently succeeds if already absent. */
export async function removePid(dataDir: string): Promise<void> {
  const pidPath = join(dataDir, DAEMON_PID_FILENAME);
  try {
    await unlink(pidPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      void logger.debug('pid-manager.remove_pid_error', {
        path: pidPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Checks whether a process with the given PID currently exists.
 *  Returns true if the process is alive (including EPERM — exists but not signable).
 *  Returns false if ESRCH — process does not exist. */
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true; // process exists, no permission to signal
    return false; // ESRCH — no such process
  }
}

/** Validates that the process at the given PID is a sparecrow daemon process.
 *  Uses cmdline inspection (/proc/<pid>/cmdline on Linux, ps on macOS) to check
 *  for the daemon entry marker. Falls back to environment variable check if cmdline read fails.
 *  Returns true if the process appears to be a sparecrow daemon, false if not or uncertain. */
export async function isScrowDaemonProcess(pid: number): Promise<boolean> {
  // Fast path: /proc/<pid>/cmdline on Linux
  if (isLinux()) {
    try {
      const content = await readFile(`/proc/${pid}/cmdline`, 'utf-8');
      // cmdline is NUL-separated; check for daemon marker in the command line
      return content.includes('--daemon-runner') || content.includes(DAEMON_IDENTITY_ENV);
    } catch {
      // Fall through to ps approach
    }
  }

  // macOS or Linux fallback: ps (use execFile to avoid shell interpretation)
  // Use -o args= (not command=) to get the full argument list — command= may truncate long cmdlines
  if (isMacOS() || isLinux()) {
    try {
      const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'args=']);
      return stdout.includes('--daemon-runner');
    } catch {
      // ps failed — process may have exited during check; be conservative
      return false;
    }
  }

  return false;
}

/** Checks whether the PID file contains a stale PID (process no longer exists or not sparecrow daemon).
 *  Returns: 'alive' | 'stale' | 'none'
 *  - 'alive': PID file exists, process alive, and is sparecrow daemon
 *  - 'stale': PID file exists but process is dead or not a sparecrow daemon
 *  - 'none': no PID file */
export async function checkPidStatus(
  dataDir: string,
): Promise<{ status: 'alive' | 'stale' | 'none'; pid: number | null }> {
  const pid = await readPid(dataDir);
  if (pid === null) return { status: 'none', pid: null };

  if (!processExists(pid)) {
    return { status: 'stale', pid };
  }

  const isAuo = await isScrowDaemonProcess(pid);
  if (!isAuo) {
    void logger.debug('pid-manager.non_scrow_process', {
      pid,
      reason: 'process exists but does not match sparecrow daemon identity',
    });
    return { status: 'stale', pid };
  }

  return { status: 'alive', pid };
}

/**
 * Scans for orphan sparecrow daemon processes and kills them with SIGKILL.
 * Excludes the caller's own PID. Non-fatal: all errors are logged and swallowed
 * so the daemon continues startup regardless of scan outcome.
 *
 * On Linux, scans /proc for numeric PID directories and reads cmdline to identify daemons.
 * On macOS, falls back to `ps` via isScrowDaemonProcess().
 */
export async function killOrphanDaemons(ownPid: number): Promise<void> {
  try {
    const candidatePids = await findDaemonCandidatePids();

    for (const pid of candidatePids) {
      if (pid === ownPid) continue;

      try {
        // candidatePids are already filtered by --daemon-runner presence in findDaemonCandidatePids()
        // so no secondary isScrowDaemonProcess() call needed (avoids double cmdline read).

        // Send SIGKILL — orphans have already proven they survive SIGTERM
        process.kill(pid, 'SIGKILL');

        void logger.warn(EventName.DAEMON_ORPHAN_KILL_SENT, {
          orphanPid: pid,
          signal: 'SIGKILL',
          reason: 'orphan-daemon-on-startup',
        });
      } catch (err) {
        // EPERM (no permission) or ESRCH (already gone) — log and continue
        const code = (err as NodeJS.ErrnoException).code;
        void logger.warn('pid-manager.orphan_kill_failed', {
          pid,
          error: err instanceof Error ? err.message : String(err),
          errno: code ?? 'unknown',
        });
      }
    }
  } catch (err) {
    // Top-level guard: entire scan failure is non-fatal (AC2)
    void logger.warn('pid-manager.orphan_scan_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Finds candidate PIDs that might be sparecrow daemon processes.
 * On Linux, reads /proc to enumerate all running processes.
 * On macOS, uses `ps` to list all processes.
 * Returns an array of PIDs to check further.
 */
async function findDaemonCandidatePids(): Promise<number[]> {
  if (isLinux()) {
    return findCandidatesFromProc();
  }

  if (isMacOS()) {
    return findCandidatesFromPs();
  }

  return [];
}

/** Maximum concurrent /proc/PID/cmdline reads — prevents too many open file handles on busy hosts. */
const PROC_SCAN_CONCURRENCY = 64;

/** Scans /proc for numeric PID directories, reads cmdline in parallel (bounded), and returns PIDs containing --daemon-runner. */
async function findCandidatesFromProc(): Promise<number[]> {
  const entries = await readdir('/proc');

  // Filter to numeric PID entries upfront
  const pids = entries.map((e) => parseInt(e, 10)).filter((p) => Number.isFinite(p) && p > 0);

  // Read cmdline files with bounded concurrency to avoid opening too many file handles
  const candidates: number[] = [];

  for (let i = 0; i < pids.length; i += PROC_SCAN_CONCURRENCY) {
    const chunk = pids.slice(i, i + PROC_SCAN_CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (pid) => {
        try {
          const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf-8');
          return cmdline.includes('--daemon-runner') ? pid : null;
        } catch {
          // Process may have exited between readdir and readFile — skip
          return null;
        }
      }),
    );
    for (const pid of results) {
      if (pid !== null) candidates.push(pid);
    }
  }

  return candidates;
}

/** Uses `ps` to find processes containing --daemon-runner in their command line. */
async function findCandidatesFromPs(): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync('ps', ['ax', '-o', 'pid=,command=']);
    const candidates: number[] = [];
    const lines = stdout.split('\n');

    for (const line of lines) {
      if (!line.includes('--daemon-runner')) continue;
      const trimmed = line.trim();
      const spaceIdx = trimmed.indexOf(' ');
      if (spaceIdx <= 0) continue;
      const pid = parseInt(trimmed.substring(0, spaceIdx), 10);
      if (Number.isFinite(pid) && pid > 0) {
        candidates.push(pid);
      }
    }

    return candidates;
  } catch {
    return [];
  }
}
