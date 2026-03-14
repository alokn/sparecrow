/** E2E tests for daemon service round-trip lifecycle (suite 06). */
import { mkdtemp, rm, access, constants } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  runCli,
  seedConfig,
  osCmdShim,
  shimEnv,
  platformServicePath,
  containerShim,
} from '../helpers/index.js';

/**
 * Returns true if the file at `filePath` is definitely absent (ENOENT).
 * Throws on any other error (e.g. EACCES — permission denied) so permission failures
 * are not silently misreported as absence.
 */
async function fileIsAbsent(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return false;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return true;
    throw err;
  }
}

describe('daemon service round-trip', () => {
  let homeDir: string;
  let configPath: string;
  let shimBinPath: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'sparecrow-rt-'));
    configPath = await seedConfig(homeDir);
    shimBinPath = await osCmdShim(homeDir, 'ok');
    // Write docker/podman shims alongside OS service shims so the daemon process
    // uses the mock docker binary during startup and config reload (SIGHUP), making
    // container runtime detection deterministic without real Docker/Podman in CI.
    await containerShim(homeDir, shimBinPath);
  });

  afterEach(async () => {
    // Best-effort stop any running daemon before cleaning up homeDir.
    // The daemon subprocess writes to files inside homeDir — removing homeDir
    // before the daemon exits causes EBUSY errors on Linux.
    // Only attempt stop if a daemon might still be running; runCli is synchronous
    // so no additional sleep is needed after the stop call completes.
    try {
      runCli(['daemon', 'stop'], shimEnv(homeDir, shimBinPath));
    } catch {
      /* daemon may not be running — ignore */
    }
    await rm(homeDir, { recursive: true, force: true });
  });

  // Task 3 (AC: 1) — Full round-trip lifecycle
  it('completes full install start stop uninstall round-trip', async () => {
    // Step 1: Install the service file
    const installResult = runCli(['daemon', 'install', '--yes'], shimEnv(homeDir, shimBinPath));
    expect(installResult.exitCode).toBe(0);
    expect(installResult.stdout).toContain('Service installed');

    // Step 2: Assert service file exists
    let svcExists = false;
    try {
      await access(platformServicePath(homeDir));
      svcExists = true;
    } catch {
      /* file does not exist */
    }
    expect(svcExists).toBe(true);

    // Step 3: Start the daemon process
    const startResult = runCli(['daemon', 'start'], shimEnv(homeDir, shimBinPath));
    expect(startResult.exitCode).toBe(0);
    expect(startResult.stdout).toContain('Daemon started (PID');

    // Step 4: Status confirms daemon is running; assert stderr is empty to catch partial failures
    const statusAfterStart = runCli(['daemon', 'status'], shimEnv(homeDir, shimBinPath));
    expect(statusAfterStart.exitCode).toBe(0);
    expect(statusAfterStart.stdout).toContain('running (PID');
    expect(statusAfterStart.stderr).toBe('');

    // Step 5: Stop the daemon process
    const stopResult = runCli(['daemon', 'stop'], shimEnv(homeDir, shimBinPath));
    expect(stopResult.exitCode).toBe(0);
    expect(stopResult.stdout).toContain('Daemon stopped');

    // Step 6: Uninstall the service file
    const uninstallResult = runCli(['daemon', 'uninstall', '--yes'], shimEnv(homeDir, shimBinPath));
    expect(uninstallResult.exitCode).toBe(0);
    expect(uninstallResult.stdout).toMatch(/Service uninstalled|No service file found/);

    // Step 7: Status after uninstall — daemon is not running
    const statusAfterUninstall = runCli(['daemon', 'status'], shimEnv(homeDir, shimBinPath));
    expect(statusAfterUninstall.exitCode).toBe(0);
    expect(statusAfterUninstall.stdout).not.toContain('running');

    // Step 8: Assert service file no longer exists (throws on EACCES — only ENOENT counts as gone)
    expect(await fileIsAbsent(platformServicePath(homeDir))).toBe(true);
  });

  // Task 4 (AC: 2) — Config reload does not crash running daemon
  it('keeps same PID after config set and daemon reload', async () => {
    // Step 1: Install the service file
    const installResult = runCli(['daemon', 'install', '--yes'], shimEnv(homeDir, shimBinPath));
    expect(installResult.exitCode).toBe(0);

    // Step 2: Start the daemon and extract initial PID
    const startResult = runCli(['daemon', 'start'], shimEnv(homeDir, shimBinPath));
    expect(startResult.exitCode).toBe(0);

    const initialPid = /PID (\d+)/.exec(startResult.stdout)?.[1];
    expect(initialPid).toBeTruthy();
    expect(Number(initialPid)).toBeGreaterThan(0);

    // Step 3: Mutate config on disk
    const setResult = runCli(
      ['config', 'set', 'polling_interval', '120', '--config', configPath],
      shimEnv(homeDir, shimBinPath),
    );
    expect(setResult.exitCode).toBe(0);

    // Step 4: Reload the daemon (sends SIGHUP)
    const reloadResult = runCli(['daemon', 'reload'], shimEnv(homeDir, shimBinPath));
    expect(reloadResult.exitCode).toBe(0);
    expect(reloadResult.stdout).toContain('Configuration reloaded');

    // Step 5: Check daemon status after reload; PID must be unchanged (no restart)
    const statusResult = runCli(['daemon', 'status'], shimEnv(homeDir, shimBinPath));
    expect(statusResult.exitCode).toBe(0);
    expect(statusResult.stdout).toContain('running (PID');

    const statusPid = /PID (\d+)/.exec(statusResult.stdout)?.[1];
    expect(statusPid).toBe(initialPid);

    // Step 6: Verify config change is observable after reload — polling_interval must be 120
    const configGetResult = runCli(
      ['config', 'get', 'polling_interval', '--config', configPath],
      shimEnv(homeDir, shimBinPath),
    );
    expect(configGetResult.exitCode).toBe(0);
    expect(configGetResult.stdout).toContain('120');

    // Explicit cleanup — daemon is still running; check exit code to detect orphan
    const stopResult = runCli(['daemon', 'stop'], shimEnv(homeDir, shimBinPath));
    expect(stopResult.exitCode).toBe(0);
  });

  // Task 5 (AC: 3) — Uninstall stops running daemon
  it('stops running daemon and removes service file on uninstall', async () => {
    // Step 1: Install the service file
    const installResult = runCli(['daemon', 'install', '--yes'], shimEnv(homeDir, shimBinPath));
    expect(installResult.exitCode).toBe(0);

    // Step 2: Start the daemon
    const startResult = runCli(['daemon', 'start'], shimEnv(homeDir, shimBinPath));
    expect(startResult.exitCode).toBe(0);
    expect(startResult.stdout).toContain('Daemon started (PID');

    // Step 3: Confirm daemon is running
    const statusResult = runCli(['daemon', 'status'], shimEnv(homeDir, shimBinPath));
    expect(statusResult.stdout).toContain('running (PID');

    // Step 4: Uninstall — should stop daemon as part of uninstall
    const uninstallResult = runCli(['daemon', 'uninstall', '--yes'], shimEnv(homeDir, shimBinPath));
    expect(uninstallResult.exitCode).toBe(0);
    expect(uninstallResult.stdout).toContain('Service uninstalled');

    // Step 5: Status after uninstall — daemon is not running
    const statusAfterUninstall = runCli(['daemon', 'status'], shimEnv(homeDir, shimBinPath));
    expect(statusAfterUninstall.exitCode).toBe(0);
    expect(statusAfterUninstall.stdout).not.toContain('running');

    // Step 6: Service file no longer exists (throws on EACCES — only ENOENT counts as gone)
    expect(await fileIsAbsent(platformServicePath(homeDir))).toBe(true);
  });
});
