/** E2E tests for daemon lifecycle commands (suite 05). */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runCli, seedConfig, containerShim } from '../helpers/index.js';

/** Directory containing the node binary — must be on PATH for spawnSync('node', ...) to work. */
const NODE_BIN_DIR = dirname(process.execPath);

/** Returns env overrides that isolate the spawned binary inside homeDir,
 *  with container shims on PATH so daemon start can detect a container runtime. */
function baseEnv(homeDir: string): Record<string, string> {
  const shimBin = join(homeDir, 'bin');
  return {
    HOME: homeDir,
    XDG_CONFIG_HOME: join(homeDir, '.config'),
    XDG_STATE_HOME: join(homeDir, '.local', 'state'),
    PATH: `${shimBin}:${NODE_BIN_DIR}:/usr/bin:/bin`,
  };
}

/**
 * Safely parses JSON from CLI stdout, throwing a descriptive error if parsing fails.
 * Prevents opaque `SyntaxError: Unexpected token` when the CLI emits a non-JSON crash trace.
 */
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw.trim());
  } catch {
    throw new Error(`Failed to parse CLI output as JSON. Raw output:\n${raw}`);
  }
}

describe('daemon lifecycle (suite 05)', () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'sparecrow-dlc-'));
    await containerShim(homeDir);
  });

  afterEach(async () => {
    // Best-effort stop any running daemon before cleaning up homeDir.
    // runCli is synchronous (spawnSync) so it blocks until daemon stop completes.
    // A short wait allows the daemon process to fully exit and release file handles
    // before rm() removes the directory, preventing EBUSY errors on Linux.
    try {
      runCli(['daemon', 'stop'], baseEnv(homeDir));
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
    } catch {
      /* daemon may not be running — ignore */
    }
    await rm(homeDir, { recursive: true, force: true });
  });

  // Task 2 (AC: 1) — Status when not started
  it('exits 0 and prints not started on fresh homeDir', async () => {
    await seedConfig(homeDir);

    const result = runCli(['daemon', 'status'], baseEnv(homeDir));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('not started');
  });

  // Task 3 (AC: 2) — Status JSON not started
  it('returns not-started JSON status on fresh homeDir', async () => {
    await seedConfig(homeDir);

    const result = runCli(['daemon', 'status', '--json'], baseEnv(homeDir));

    expect(result.exitCode).toBe(0);

    const parsed = parseJson(result.stdout) as {
      ok: boolean;
      data: { state: string; pid: number | null; uptime: string | null; startedAt: string | null };
      error: null;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.state).toBe('not-started');
    expect(parsed.data.pid).toBeNull();
    expect(parsed.data.uptime).toBeNull();
    expect(parsed.data.startedAt).toBeNull();
    expect(parsed.error).toBeNull();
  });

  // Task 4 (AC: 3, 4) — Start daemon and verify status shows running
  it('starts daemon and status shows running', async () => {
    await seedConfig(homeDir);

    const startResult = runCli(['daemon', 'start'], baseEnv(homeDir));

    expect(startResult.exitCode).toBe(0);
    expect(startResult.stdout).toContain('Daemon started (PID');

    const statusResult = runCli(['daemon', 'status'], baseEnv(homeDir));

    expect(statusResult.exitCode).toBe(0);
    expect(statusResult.stdout).toContain('running (PID');

    // Explicit cleanup within test body
    runCli(['daemon', 'stop'], baseEnv(homeDir));
  });

  // Task 5 (AC: 5) — Start when already running
  it('exits 1 with already running message on duplicate start', async () => {
    await seedConfig(homeDir);

    const firstStart = runCli(['daemon', 'start'], baseEnv(homeDir));
    expect(firstStart.exitCode).toBe(0);

    const result = runCli(['daemon', 'start'], baseEnv(homeDir));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('already running');

    // Explicit cleanup
    runCli(['daemon', 'stop'], baseEnv(homeDir));
  });

  // Task 6 (AC: 6) — Stop daemon
  it('exits 0 with Daemon stopped message on stop', async () => {
    await seedConfig(homeDir);

    const startResult = runCli(['daemon', 'start'], baseEnv(homeDir));
    expect(startResult.exitCode).toBe(0);

    const result = runCli(['daemon', 'stop'], baseEnv(homeDir));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Daemon stopped');
  });

  // Task 7 (AC: 7) — Stop when not running
  it('exits 2 with not running message when stopping non-running daemon', async () => {
    await seedConfig(homeDir);

    const result = runCli(['daemon', 'stop'], baseEnv(homeDir));

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('not running');
  });

  // Task 8 (AC: 8) — Restart from running
  it('exits 0 with Daemon restarted message on restart from running', async () => {
    await seedConfig(homeDir);

    const startResult = runCli(['daemon', 'start'], baseEnv(homeDir));
    expect(startResult.exitCode).toBe(0);

    const result = runCli(['daemon', 'restart'], baseEnv(homeDir));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Daemon restarted (PID');

    // Explicit cleanup — new daemon process after restart
    runCli(['daemon', 'stop'], baseEnv(homeDir));
  });

  // Task 9 (AC: 9) — Restart from stopped
  it('exits 0 with was not running message on restart from stopped', async () => {
    await seedConfig(homeDir);

    const result = runCli(['daemon', 'restart'], baseEnv(homeDir));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Daemon started (was not running)');

    // Explicit cleanup — daemon was started by restart
    runCli(['daemon', 'stop'], baseEnv(homeDir));
  });

  // Task 10 (AC: 10) — Reload running daemon
  it('exits 0 with Configuration reloaded message on reload', async () => {
    await seedConfig(homeDir);

    const startResult = runCli(['daemon', 'start'], baseEnv(homeDir));
    expect(startResult.exitCode).toBe(0);

    const result = runCli(['daemon', 'reload'], baseEnv(homeDir));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Configuration reloaded');

    // Explicit cleanup
    runCli(['daemon', 'stop'], baseEnv(homeDir));
  });

  // Task 11 (AC: 11) — Reload not running
  it('exits 2 with not running message when reloading non-running daemon', async () => {
    await seedConfig(homeDir);

    const result = runCli(['daemon', 'reload'], baseEnv(homeDir));

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('not running');
  });

  // Task 12 (AC: 12) — Start dry-run
  it('shows config preview on dry-run without starting daemon', async () => {
    await seedConfig(homeDir);

    const dryResult = runCli(['daemon', 'start', '--dry-run'], baseEnv(homeDir));

    expect(dryResult.exitCode).toBe(0);
    expect(dryResult.stdout).toContain('[dry-run]');
    expect(dryResult.stdout).toContain('configPath');

    const statusResult = runCli(['daemon', 'status'], baseEnv(homeDir));
    expect(statusResult.exitCode).toBe(0);
    expect(statusResult.stdout).toContain('not started');
  });

  // Task 13 (AC: 13) — Start JSON output
  it('returns pid and message in JSON on daemon start', async () => {
    await seedConfig(homeDir);

    const result = runCli(['daemon', 'start', '--json'], baseEnv(homeDir));

    expect(result.exitCode).toBe(0);

    const parsed = parseJson(result.stdout) as {
      ok: boolean;
      data: { pid: number; message: string };
      error: null;
    };
    expect(parsed.ok).toBe(true);
    expect(typeof parsed.data.pid).toBe('number');
    expect(parsed.data.pid).toBeGreaterThan(0);
    expect(parsed.data.message).toContain('Daemon started with PID');
    expect(parsed.error).toBeNull();

    // Explicit cleanup
    runCli(['daemon', 'stop'], baseEnv(homeDir));
  });

  // Task 14 (AC: 14) — Stop JSON output
  it('returns forced false and stopped message in JSON on daemon stop', async () => {
    await seedConfig(homeDir);

    const startResult = runCli(['daemon', 'start'], baseEnv(homeDir));
    expect(startResult.exitCode).toBe(0);

    const result = runCli(['daemon', 'stop', '--json'], baseEnv(homeDir));

    expect(result.exitCode).toBe(0);

    const parsed = parseJson(result.stdout) as {
      ok: boolean;
      data: { forced: boolean; message: string };
      error: null;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.forced).toBe(false);
    expect(parsed.data.message).toBe('Daemon stopped.');
    expect(parsed.error).toBeNull();
  });

  // Task 14a (AC: 14a) — Stop JSON when not running
  it('returns ok false with DAEMON_NOT_RUNNING in JSON on stop when not running', async () => {
    await seedConfig(homeDir);

    const result = runCli(['daemon', 'stop', '--json'], baseEnv(homeDir));

    expect(result.exitCode).toBe(0);

    const parsed = parseJson(result.stdout) as {
      ok: boolean;
      data: null;
      error: { code: string; message: string } | null;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.data).toBeNull();
    expect(parsed.error).not.toBeNull();
    expect(parsed.error!.code).toBe('DAEMON_NOT_RUNNING');
  });

  // [AI-Review][Medium] — daemon start --json when already running returns ok false with exit 0
  it('returns ok false in JSON on daemon start when already running', async () => {
    await seedConfig(homeDir);

    const firstStart = runCli(['daemon', 'start'], baseEnv(homeDir));
    expect(firstStart.exitCode).toBe(0);

    const result = runCli(['daemon', 'start', '--json'], baseEnv(homeDir));

    // JSON mode does NOT set process.exitCode for DAEMON_ALREADY_RUNNING — exits 0
    expect(result.exitCode).toBe(0);

    const parsed = parseJson(result.stdout) as {
      ok: boolean;
      data: null;
      error: { code: string; message: string } | null;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.data).toBeNull();
    expect(parsed.error).not.toBeNull();
    expect(parsed.error!.code).toBe('DAEMON_ALREADY_RUNNING');

    // Explicit cleanup — original daemon still running
    runCli(['daemon', 'stop'], baseEnv(homeDir));
  });

  // [AI-Review][Medium] — daemon restart --json when running returns pid, wasRunning, message
  it('returns pid and wasRunning true in JSON on daemon restart from running', async () => {
    await seedConfig(homeDir);

    const startResult = runCli(['daemon', 'start'], baseEnv(homeDir));
    expect(startResult.exitCode).toBe(0);

    const result = runCli(['daemon', 'restart', '--json'], baseEnv(homeDir));

    expect(result.exitCode).toBe(0);

    const parsed = parseJson(result.stdout) as {
      ok: boolean;
      data: { pid: number; wasRunning: boolean; message: string };
      error: null;
    };
    expect(parsed.ok).toBe(true);
    expect(typeof parsed.data.pid).toBe('number');
    expect(parsed.data.pid).toBeGreaterThan(0);
    expect(parsed.data.wasRunning).toBe(true);
    expect(parsed.error).toBeNull();

    // Explicit cleanup — new daemon process after restart
    runCli(['daemon', 'stop'], baseEnv(homeDir));
  });

  // [AI-Review][Medium] — daemon reload --json when running returns message
  it('returns message in JSON on daemon reload when running', async () => {
    await seedConfig(homeDir);

    const startResult = runCli(['daemon', 'start'], baseEnv(homeDir));
    expect(startResult.exitCode).toBe(0);

    const result = runCli(['daemon', 'reload', '--json'], baseEnv(homeDir));

    expect(result.exitCode).toBe(0);

    const parsed = parseJson(result.stdout) as {
      ok: boolean;
      data: { message: string };
      error: null;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.message).toContain('reloaded');
    expect(parsed.error).toBeNull();

    // Explicit cleanup
    runCli(['daemon', 'stop'], baseEnv(homeDir));
  });
});
