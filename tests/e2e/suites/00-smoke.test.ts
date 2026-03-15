/** Smoke tests for basic CLI contract: version, help, unknown command, missing argument. */
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { access, constants } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runCli } from '../helpers/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..', '..');

/**
 * Runs `scrow` via `npx` with the same environment guards as `runCli`:
 * strips XDG_* vars, sets NO_COLOR/TERM, and throws on spawn error or signal kill.
 */
function runScrow(
  args: string[],
  envOverrides?: Record<string, string>,
  timeoutMs = 15000,
): { stdout: string; stderr: string; exitCode: number } {
  const {
    XDG_CONFIG_HOME: _xdgConfigHome,
    XDG_STATE_HOME: _xdgStateHome,
    XDG_DATA_HOME: _xdgDataHome,
    XDG_CACHE_HOME: _xdgCacheHome,
    ...cleanEnv
  } = process.env;

  const result = spawnSync('npx', ['scrow', ...args], {
    encoding: 'utf8',
    env: {
      ...cleanEnv,
      NO_COLOR: '1',
      TERM: 'dumb',
      ...envOverrides,
    },
    cwd: PROJECT_ROOT,
    timeout: timeoutMs,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.signal !== null && result.signal !== undefined) {
    throw new Error(
      `scrow process was killed by signal ${result.signal} (args: ${JSON.stringify(args)})`,
    );
  }

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

describe('CLI smoke contract', () => {
  let homeDir: string | undefined;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'sparecrow-smoke-'));
  });

  afterEach(async () => {
    if (homeDir !== undefined) {
      await rm(homeDir, { recursive: true, force: true });
      homeDir = undefined;
    }
  });

  it('exits 0 and prints version string for --version', () => {
    const result = runCli(['--version'], { HOME: homeDir! });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
  });

  it('exits 0 and lists all top-level commands for --help', () => {
    const result = runCli(['--help'], { HOME: homeDir! });

    expect(result.exitCode).toBe(0);

    const expectedCommands = [
      'status',
      'queue',
      'daemon',
      'config',
      'doctor',
      'onboard',
      'templates',
      'logs',
      'report',
      'completions',
    ];

    for (const cmd of expectedCommands) {
      expect(result.stdout).toContain(cmd);
    }
  });

  it('exits 1 and mentions unknown command in stderr', () => {
    const result = runCli(['unknowncmd'], { HOME: homeDir! });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('error:');
    expect(result.stderr).toContain('unknowncmd');
  });

  it('exits 1 when queue remove is called without a position argument', () => {
    const result = runCli(['queue', 'remove'], { HOME: homeDir! });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('position');
  });
});

describe('scrow alias contract', () => {
  it('package.json bin maps scrow to the same entry point as sparecrow, and the binary file exists and is executable', async () => {
    const pkgJson = JSON.parse(await readFile(resolve(PROJECT_ROOT, 'package.json'), 'utf8')) as {
      bin: Record<string, string>;
    };

    expect(pkgJson.bin).toHaveProperty('scrow');
    expect(pkgJson.bin).toHaveProperty('sparecrow');
    expect(pkgJson.bin['scrow']).toBe(pkgJson.bin['sparecrow']);

    // Verify the dist entry point actually exists and is executable,
    // confirming the binary is not just declared in JSON but is present on disk.
    const entryPoint = resolve(PROJECT_ROOT, pkgJson.bin['scrow']!);
    await expect(access(entryPoint, constants.F_OK)).resolves.toBeUndefined();
    await expect(access(entryPoint, constants.X_OK)).resolves.toBeUndefined();
  });

  describe('with isolated home directory', () => {
    let homeDir: string | undefined;

    beforeEach(async () => {
      homeDir = await mkdtemp(join(tmpdir(), 'sparecrow-scrow-alias-'));
    });

    afterEach(async () => {
      if (homeDir !== undefined) {
        await rm(homeDir, { recursive: true, force: true });
        homeDir = undefined;
      }
    });

    it('scrow --version exits 0 and matches sparecrow --version output', () => {
      const sparecrowResult = runCli(['--version'], { HOME: homeDir! });
      expect(sparecrowResult.exitCode).toBe(0);

      const scrowResult = runScrow(['--version'], { HOME: homeDir! });

      expect(scrowResult.exitCode).toBe(0);
      expect(scrowResult.stdout.trim()).toBe(sparecrowResult.stdout.trim());
    });

    it('scrow --help exits 0 and lists all top-level commands', () => {
      const scrowResult = runScrow(['--help'], { HOME: homeDir! });

      expect(scrowResult.exitCode).toBe(0);

      const expectedCommands = [
        'status',
        'queue',
        'daemon',
        'config',
        'doctor',
        'onboard',
        'templates',
        'logs',
        'report',
        'completions',
      ];

      for (const cmd of expectedCommands) {
        expect(scrowResult.stdout).toContain(cmd);
      }
    });
  });
});
