/** E2E tests for auth token validation, config path resolution, and config reconnect rejection. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runCli, seedConfig, seedCredentials } from '../helpers/index.js';

/** Directory containing the node binary — must be on PATH for spawnSync('node', ...) to work. */
const NODE_BIN_DIR = dirname(process.execPath);

/**
 * Returns env overrides that isolate the spawned binary inside homeDir.
 * PATH includes the node binary dir plus minimal system dirs so doctor's
 * claude-installation check behaves deterministically in both CI and developer environments.
 */
function baseEnv(homeDir: string): Record<string, string> {
  return {
    HOME: homeDir,
    XDG_CONFIG_HOME: join(homeDir, '.config'),
    XDG_STATE_HOME: join(homeDir, '.local', 'state'),
    PATH: `${NODE_BIN_DIR}:/usr/bin:/bin`,
  };
}

describe('auth and config path bootstrap', () => {
  let homeDir: string | undefined;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'sparecrow-auth-'));
  });

  afterEach(async () => {
    if (homeDir !== undefined) {
      try {
        await rm(homeDir, { recursive: true, force: true });
      } catch {
        // Podman container storage creates user-namespace files that need podman unshare to remove
        try {
          execSync(
            `podman unshare rm -rf "${homeDir}" 2>/dev/null; rm -rf "${homeDir}" 2>/dev/null || true`,
            { shell: '/bin/sh' },
          );
        } catch {
          // Best-effort; leave dir if cleanup fails
        }
      }
      homeDir = undefined;
    }
  });

  // Task 3 (AC: 1)
  it('exits 0 and shows config and state paths on fresh HOME', async () => {
    const result = runCli(['config', 'path'], baseEnv(homeDir!));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Config file:');
    expect(result.stdout).toContain('sparecrow');
    expect(result.stdout).toContain('State directory:');
    expect(result.stdout).toContain('Logs directory:');
  });

  // Task 4 (AC: 2)
  it('JSON output has configPath, dataPath, logsPath on fresh HOME', async () => {
    const result = runCli(['--json', 'config', 'path'], baseEnv(homeDir!));

    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout.trim());

    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeNull();
    expect(typeof parsed.data.configPath).toBe('string');
    expect(parsed.data.configPath.length).toBeGreaterThan(0);
    expect(typeof parsed.data.dataPath).toBe('string');
    expect(parsed.data.dataPath.length).toBeGreaterThan(0);
    expect(typeof parsed.data.logsPath).toBe('string');
    expect(parsed.data.logsPath.length).toBeGreaterThan(0);
    expect(parsed.data.configPath).toContain('sparecrow');
    expect(parsed.data.dataPath).toContain('sparecrow');
    expect(parsed.data.logsPath).toContain('sparecrow');
  });

  // Task 5 (AC: 3)
  it('config path reflects custom --config override', async () => {
    const customPath = join(homeDir!, 'custom.yaml');
    // Raw YAML string is used intentionally here: resolveConfigFilePath returns the override
    // path directly without parsing it, so the content does not need to be produced via the
    // yaml package. This keeps the test lean and avoids an unnecessary serialisation round-trip.
    await writeFile(customPath, 'polling_interval: 300\n');

    const result = runCli(['--config', customPath, 'config', 'path'], baseEnv(homeDir!));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(customPath);
  });

  // Task 6 (AC: 4)
  it('doctor shows auth-token-validity pass when credentials file exists', async () => {
    await seedConfig(homeDir!);
    await seedCredentials(homeDir!, { accessToken: 'e2e-test-token' });

    const result = runCli(['doctor'], baseEnv(homeDir!));

    expect(result.stdout).toContain('Auth Token Validity');
    expect(result.stdout).not.toContain('No Claude Code credentials found.');

    const authLine = result.stdout.split('\n').find((l) => l.includes('Auth Token Validity'));
    expect(authLine).toBeDefined();
    expect(authLine).toContain('Auth token is valid.');
  });

  // Task 7 (AC: 5)
  it('doctor shows auth-token-validity fail when credentials file is absent', async () => {
    await seedConfig(homeDir!);

    const result = runCli(['doctor'], baseEnv(homeDir!));

    expect(result.stdout).toContain('Auth Token Validity');
    expect(result.stdout).toContain('No Claude Code credentials found.');
    expect(result.stdout).toContain('claude auth login');

    const authLine = result.stdout.split('\n').find((l) => l.includes('Auth Token Validity'));
    expect(authLine).toBeDefined();
    expect(authLine).toContain('FAIL');
  });

  // Task 8 (AC: 6)
  it('config --reconnect exits 3 with interactive-terminal message in non-TTY context', async () => {
    await seedConfig(homeDir!);

    const result = runCli(['config', '--reconnect'], baseEnv(homeDir!));

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('interactive');
  });
});
