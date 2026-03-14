/** E2E tests for daemon service install and uninstall commands. */
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runCli, seedConfig, osCmdShim, shimEnv, platformServicePath } from '../helpers/index.js';

describe('daemon service install/uninstall', () => {
  // [AI-Review][High] Use string | undefined so afterEach can guard against beforeEach failure
  let homeDir: string | undefined;
  let shimBinPath: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'sparecrow-svc-'));
    await seedConfig(homeDir);
    shimBinPath = await osCmdShim(homeDir, 'ok');
  });

  afterEach(async () => {
    // [AI-Review][High] Guard against beforeEach failure so rm() never receives 'undefined'
    if (homeDir !== undefined) {
      await rm(homeDir, { recursive: true, force: true });
      homeDir = undefined;
    }
  });

  // Task 3 (AC: 1, 2)
  it('exits 0 and creates service file on first install', async () => {
    const result = runCli(['daemon', 'install', '--yes'], shimEnv(homeDir!, shimBinPath));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Service installed');

    // Service file should exist at the expected platform path
    await access(platformServicePath(homeDir!));
  });

  // Task 4 (AC: 2) — Linux-only
  it('service file contains required directives on Linux', async () => {
    if (process.platform !== 'linux') return;

    const result = runCli(['daemon', 'install', '--yes'], shimEnv(homeDir!, shimBinPath));
    expect(result.exitCode).toBe(0);

    const content = await readFile(platformServicePath(homeDir!), 'utf8');

    expect(content).toContain('--daemon-runner');
    expect(content).toContain('WantedBy=default.target');
    expect(content).toContain('SPARECROW_CONFIG_PATH=');
    expect(content).toContain('SPARECROW_DATA_PATH=');
  });

  // Task 5 (AC: 3)
  it('exits 1 with already-exists message when service file exists and --yes is omitted', () => {
    // First install to create the service file
    const firstResult = runCli(['daemon', 'install', '--yes'], shimEnv(homeDir!, shimBinPath));
    // [AI-Review][Low] Assert both exit code AND stdout to catch early-return regressions
    expect(firstResult.exitCode).toBe(0);
    expect(firstResult.stdout).toContain('Service installed');

    // Second install without --yes should fail
    const result = runCli(['daemon', 'install'], shimEnv(homeDir!, shimBinPath));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('already exists');
  });

  // Task 6 (AC: 4)
  it('exits 0 on reinstall with --yes and service file still valid', async () => {
    // First install
    const firstResult = runCli(['daemon', 'install', '--yes'], shimEnv(homeDir!, shimBinPath));
    expect(firstResult.exitCode).toBe(0);

    // Second install with --yes
    const secondResult = runCli(['daemon', 'install', '--yes'], shimEnv(homeDir!, shimBinPath));
    expect(secondResult.exitCode).toBe(0);
    expect(secondResult.stdout).toContain('Service installed');

    // On Linux, verify the file content is still valid
    if (process.platform === 'linux') {
      const content = await readFile(platformServicePath(homeDir!), 'utf8');
      expect(content).toContain('--daemon-runner');
    }
  });

  // Task 7 (AC: 5)
  it('exits 0 and removes service file on uninstall', async () => {
    // Install first
    const installResult = runCli(['daemon', 'install', '--yes'], shimEnv(homeDir!, shimBinPath));
    expect(installResult.exitCode).toBe(0);

    // Verify service file exists before uninstall
    await access(platformServicePath(homeDir!));

    // Uninstall
    const result = runCli(['daemon', 'uninstall', '--yes'], shimEnv(homeDir!, shimBinPath));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Service uninstalled');

    // Verify service file no longer exists
    let fileExists = false;
    try {
      await access(platformServicePath(homeDir!));
      fileExists = true;
    } catch {
      /* expected — file was removed */
    }
    expect(fileExists).toBe(false);
  });

  // Task 8 (AC: 6)
  it('exits 0 with no-service message when uninstalling on fresh HOME', () => {
    const result = runCli(['daemon', 'uninstall', '--yes'], shimEnv(homeDir!, shimBinPath));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No service file found');
  });

  // [AI-Review][Medium] Test uninstall without --yes to guard against confirmation gate regression
  it('exits 0 on uninstall without --yes (--yes is accepted for scripting parity, does not gate)', () => {
    // Per daemon.ts implementation, --yes is not required for uninstall (no confirmation gate)
    const result = runCli(['daemon', 'uninstall'], shimEnv(homeDir!, shimBinPath));

    // Fresh HOME with no service file — exits 0 with no-service message regardless of --yes
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No service file found');
  });

  // Task 9 (AC: 7)
  it('JSON install output has correct shape with started: false', () => {
    const result = runCli(['daemon', 'install', '--yes', '--json'], shimEnv(homeDir!, shimBinPath));

    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout.trim());

    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeNull();
    // [AI-Review][High] Cross-validate serviceFilePath against platformServicePath(homeDir)
    expect(parsed.data.serviceFilePath).toBe(platformServicePath(homeDir!));
    expect(parsed.data.platform).toBe(process.platform === 'darwin' ? 'darwin' : 'linux');
    expect(parsed.data.started).toBe(false);
    expect(parsed.data.overwritten).toBe(false);
    // [AI-Review][High] Assert actual method value, not just typeof string
    expect(parsed.data.method).toBe(process.platform === 'darwin' ? 'launchd' : 'systemd');
  });

  // Task 10 (AC: 8)
  it('JSON uninstall output has correct shape with removed: true', () => {
    // Install first so there is a service file to uninstall
    const installResult = runCli(['daemon', 'install', '--yes'], shimEnv(homeDir!, shimBinPath));
    expect(installResult.exitCode).toBe(0);

    // Uninstall with JSON output
    const result = runCli(
      ['daemon', 'uninstall', '--yes', '--json'],
      shimEnv(homeDir!, shimBinPath),
    );

    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout.trim());

    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeNull();
    expect(parsed.data.removed).toBe(true);
    expect(parsed.data.stopped).toBe(false);
    // [AI-Review][High] Cross-validate serviceFilePath against platformServicePath(homeDir)
    expect(parsed.data.serviceFilePath).toBe(platformServicePath(homeDir!));
    expect(parsed.data.platform).toBe(process.platform === 'darwin' ? 'darwin' : 'linux');
  });
});
