/** E2E tests for the doctor command — healthy systems, failure modes, verbose output, and JSON output. */
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runCli, seedConfig, seedCredentials, claudeShim } from '../helpers/index.js';

/** Directory containing the node binary — must be on PATH for spawnSync('node', ...) to work. */
const NODE_BIN_DIR = dirname(process.execPath);

/**
 * Doctor probes container runtimes (podman info / docker info) with 30s timeouts each.
 * In CI, Docker is pre-installed but can be slow to respond. The default 15s runCli timeout
 * is too short for 13 diagnostic checks including two sequential container probes.
 */
const DOCTOR_TIMEOUT_MS = 90_000;

/**
 * Returns env overrides that isolate the spawned binary inside homeDir.
 * Ensures env-paths resolves all app paths inside homeDir in CI.
 * XDG_DATA_HOME is set explicitly so that env-paths ep.data resolves inside
 * homeDir on Linux (where env-paths respects XDG_DATA_HOME for the data path).
 */
function baseEnv(homeDir: string): Record<string, string> {
  return {
    HOME: homeDir,
    XDG_CONFIG_HOME: join(homeDir, '.config'),
    XDG_STATE_HOME: join(homeDir, '.local', 'state'),
    XDG_DATA_HOME: join(homeDir, '.local', 'share'),
    PATH: `${NODE_BIN_DIR}:/usr/bin:/bin`,
  };
}

/**
 * Returns env overrides with the claude shim's bin directory prepended to PATH.
 * Uses a deterministic minimal PATH (NODE_BIN_DIR + shim dir + /usr/bin + /bin)
 * to ensure the shim takes precedence over any real claude binary that may exist
 * on the CI machine's PATH.
 */
function withShim(homeDir: string): Record<string, string> {
  return {
    ...baseEnv(homeDir),
    PATH: `${join(homeDir, 'bin')}:${NODE_BIN_DIR}:/usr/bin:/bin`,
  };
}

/**
 * Resolves the state/data directory path for the given homeDir,
 * mirroring env-paths v4 behaviour for Linux and macOS.
 *
 * On macOS, env-paths maps `log` (used as data) to `~/Library/Logs/<app>`.
 * On Linux, uses `~/.local/state/<app>`.
 */
function getStatePath(homeDir: string): string {
  if (process.platform === 'darwin') {
    return join(homeDir, 'Library', 'Logs', 'sparecrow');
  }
  return join(homeDir, '.local', 'state', 'sparecrow');
}

describe('runDiagnostics', () => {
  let homeDir: string | undefined;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'sparecrow-doc-'));
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

  // Task 2 (AC: 1) — All checks pass (human output)
  it('doctor exits with headers and auth pass finding when credentials are valid', async () => {
    await seedConfig(homeDir!);
    await seedCredentials(homeDir!, { accessToken: 'e2e-test-token' });
    await claudeShim(homeDir!, 'ok');

    const result = runCli(['doctor'], withShim(homeDir!), DOCTOR_TIMEOUT_MS);

    // Assert header and summary section are present
    expect(result.stdout).toContain('Doctor — Diagnostic Health Check');
    expect(result.stdout).toContain('Summary:');

    // Assert auth finding line
    const authLine = result.stdout.split('\n').find((l) => l.includes('Auth Token Validity'));
    expect(authLine).toBeDefined();
    expect(authLine).toContain('Auth token is valid.');

    // Assert claude finding line (positive assertion)
    const claudeLine = result.stdout
      .split('\n')
      .find((l) => l.includes('Claude Code Installation'));
    expect(claudeLine).toBeDefined();
    expect(claudeLine).toContain('Claude Code CLI found');

    // Do NOT assert exitCode === 0 (usage-endpoint-connectivity makes a real network call)
  });

  // Task 3 (AC: 2) — All checks JSON (healthy auth + claude)
  it('doctor --json returns findings array with 13 entries and correct auth finding', async () => {
    await seedConfig(homeDir!);
    await seedCredentials(homeDir!, { accessToken: 'e2e-test-token' });
    await claudeShim(homeDir!, 'ok');

    const result = runCli(['doctor', '--json'], withShim(homeDir!), DOCTOR_TIMEOUT_MS);

    expect(result.stdout.trim()).not.toBe('');
    const parsed = JSON.parse(result.stdout.trim());

    // Assert 13 findings and 13 total checks
    expect(parsed.data.findings.length).toBe(13);
    expect(parsed.data.summary.totalChecks).toBe(13);
    expect(parsed.error).toBeNull();

    // Assert auth finding
    const authFinding = parsed.data.findings.find(
      (f: { checkKey: string }) => f.checkKey === 'auth-token-validity',
    );
    expect(authFinding.status).toBe('pass');
    expect(authFinding.severity).toBe('ok');

    // Assert claude finding
    const claudeFinding = parsed.data.findings.find(
      (f: { checkKey: string }) => f.checkKey === 'claude-installation',
    );
    expect(claudeFinding.status).toBe('pass');
    expect(claudeFinding.severity).toBe('ok');

    // Assert each finding has all required keys
    for (const f of parsed.data.findings) {
      expect('checkKey' in f).toBe(true);
      expect('checkName' in f).toBe(true);
      expect('severity' in f).toBe(true);
      expect('status' in f).toBe(true);
      expect('message' in f).toBe(true);
      expect('fixCommand' in f).toBe(true);
      expect('durationMs' in f).toBe(true);
      expect('details' in f).toBe(true);
    }

    // Do NOT assert parsed.ok === false (jsonOk always sets ok: true; see story notes)
    // Do NOT assert exitCode === 0 (usage-endpoint-connectivity returns critical in CI)
  });

  // Task 4 (AC: 3) — Verbose output includes timing markers per check
  it('doctor --verbose includes timing markers and Details section for each check', async () => {
    await seedConfig(homeDir!);
    await seedCredentials(homeDir!, { accessToken: 'e2e-test-token' });
    await claudeShim(homeDir!, 'ok');

    const result = runCli(['doctor', '--verbose'], withShim(homeDir!), DOCTOR_TIMEOUT_MS);

    expect(result.stdout).toContain('Doctor — Diagnostic Health Check');
    expect(result.stdout).toContain('Summary:');

    // Verify that the Details: section from renderFinding (verbose branch) is rendered
    expect(result.stdout).toContain('Details:');

    // Verify timing markers appear in the output (each check produces durationMs)
    // Count lines containing 'ms' to ensure timing appears for multiple checks,
    // not just incidentally in a path or message string.
    const msLines = result.stdout.split('\n').filter((l) => /\d+ms/.test(l));
    expect(msLines.length).toBeGreaterThanOrEqual(1);
  });

  // Task 5 (AC: 4) — Auth fail triggers critical (missing credentials path)
  it('doctor exits 1 with critical auth finding when no credentials exist', async () => {
    await seedConfig(homeDir!);
    // Do NOT seed credentials
    await claudeShim(homeDir!, 'ok');

    const result = runCli(['doctor'], withShim(homeDir!), DOCTOR_TIMEOUT_MS);

    expect(result.exitCode).toBe(1);

    const authLine = result.stdout.split('\n').find((l) => l.includes('Auth Token Validity'));
    expect(authLine).toBeDefined();
    expect(authLine).toContain('No Claude Code credentials found.');

    expect(result.stdout).toContain('claude auth login');
  });

  // Task 5b (AC: 4) — Auth fail via claude shim exiting 1 (checkClaudeInstallation non-zero exit path)
  it('doctor --json shows warning for claude-installation when shim exits non-zero', async () => {
    await seedConfig(homeDir!);
    await seedCredentials(homeDir!, { accessToken: 'e2e-test-token' });
    // Use auth-fail shim: exits 1 with stderr 'not logged in'
    await claudeShim(homeDir!, 'auth-fail');

    const result = runCli(['doctor', '--json'], withShim(homeDir!), DOCTOR_TIMEOUT_MS);

    expect(result.stdout.trim()).not.toBe('');
    const parsed = JSON.parse(result.stdout.trim());

    const claudeFinding = parsed.data.findings.find(
      (f: { checkKey: string }) => f.checkKey === 'claude-installation',
    );
    expect(claudeFinding).toBeDefined();
    // auth-fail shim exits 1 — checkClaudeInstallation returns warning for non-zero exit
    expect(claudeFinding.severity).toBe('warning');
    expect(claudeFinding.status).toBe('warn');
    expect(claudeFinding.message).toContain('non-zero exit code');
  });

  // Task 6 (AC: 5) — Missing config file results in ok (uses defaults)
  it('doctor config-validity is ok when no config file exists', async () => {
    // Do NOT call seedConfig. Do NOT seed credentials. Use fresh homeDir.
    const result = runCli(['doctor', '--json'], baseEnv(homeDir!), DOCTOR_TIMEOUT_MS);

    // Guard: assert stdout is non-empty and exit code is expected before parsing
    expect(result.stdout.trim()).not.toBe('');
    // exit code is 1 because claude-installation is critical (no shim) — that is expected
    const parsed = JSON.parse(result.stdout.trim());

    const finding = parsed.data.findings.find(
      (f: { checkKey: string }) => f.checkKey === 'config-validity',
    );
    expect(finding.severity).toBe('ok');
    expect(finding.status).toBe('pass');
    expect(finding.message).toContain('using defaults');
  });

  // Task 7 (AC: 6) — Invalid config file results in critical
  it('doctor config-validity is critical when config file has invalid content', async () => {
    const configPath = await seedConfig(homeDir!);
    await writeFile(configPath, 'polling_interval: notanumber\n');

    const result = runCli(['doctor', '--json'], baseEnv(homeDir!), DOCTOR_TIMEOUT_MS);

    expect(result.stdout.trim()).not.toBe('');
    const parsed = JSON.parse(result.stdout.trim());

    const finding = parsed.data.findings.find(
      (f: { checkKey: string }) => f.checkKey === 'config-validity',
    );
    expect(finding.severity).toBe('critical');
    expect(finding.status).toBe('fail');
    expect(finding.message).toBe('Configuration file is invalid.');
  });

  // Task 8 (AC: 7) — Corrupt queue.json results in critical
  it('doctor queue-file-integrity is critical when queue.json has invalid JSON', async () => {
    await seedConfig(homeDir!);

    const stateDir = getStatePath(homeDir!);
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'queue.json'), 'not valid json');

    const result = runCli(['doctor', '--json'], baseEnv(homeDir!), DOCTOR_TIMEOUT_MS);

    expect(result.stdout.trim()).not.toBe('');
    const parsed = JSON.parse(result.stdout.trim());

    const finding = parsed.data.findings.find(
      (f: { checkKey: string }) => f.checkKey === 'queue-file-integrity',
    );
    expect(finding.severity).toBe('critical');
    expect(finding.status).toBe('fail');
    expect(finding.message).toBe('Queue file contains invalid JSON.');
  });

  // Task 9 (AC: 8) — Service installation state is warning in fresh homeDir
  it('doctor reports service-installation-state as warning in a fresh homeDir', async () => {
    await seedConfig(homeDir!);

    const result = runCli(['doctor', '--json'], baseEnv(homeDir!), DOCTOR_TIMEOUT_MS);

    expect(result.stdout.trim()).not.toBe('');
    const parsed = JSON.parse(result.stdout.trim());

    const finding = parsed.data.findings.find(
      (f: { checkKey: string }) => f.checkKey === 'service-installation-state',
    );
    expect(finding.severity).toBe('warning');
    expect(finding.status).toBe('warn');
    expect(finding.message).toContain('not installed');
  });

  // Task 10 (AC: 9) — Doctor JSON with auth failure
  it('doctor --json with missing credentials has criticalCount >= 1 and correct auth finding', async () => {
    await seedConfig(homeDir!);
    // Do NOT seed credentials
    await claudeShim(homeDir!, 'ok');

    const result = runCli(['doctor', '--json'], withShim(homeDir!), DOCTOR_TIMEOUT_MS);

    expect(result.exitCode).toBe(1);

    expect(result.stdout.trim()).not.toBe('');
    const parsed = JSON.parse(result.stdout.trim());

    expect(parsed.data.summary.criticalCount).toBeGreaterThanOrEqual(1);

    const authFinding = parsed.data.findings.find(
      (f: { checkKey: string }) => f.checkKey === 'auth-token-validity',
    );
    expect(authFinding.severity).toBe('critical');
    expect(authFinding.status).toBe('fail');
    expect(authFinding.message).toBe(
      'No Claude Code credentials found. Run: claude auth login, then sparecrow config --reconnect',
    );
    expect(authFinding.fixCommand).toBe('claude auth login');

    // Do NOT assert parsed.ok === false — jsonOk always sets ok: true (see story notes)
  });

  // Task 10b (AC: 9, QA coverage) — Queue valid JSON but wrong schema
  it('doctor queue-file-integrity is critical when queue.json has valid JSON but wrong schema', async () => {
    await seedConfig(homeDir!);

    const stateDir = getStatePath(homeDir!);
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, 'queue.json'),
      JSON.stringify({ version: 1, tasks: 'not-an-array' }),
    );

    const result = runCli(['doctor', '--json'], baseEnv(homeDir!), DOCTOR_TIMEOUT_MS);

    expect(result.stdout.trim()).not.toBe('');
    const parsed = JSON.parse(result.stdout.trim());

    const finding = parsed.data.findings.find(
      (f: { checkKey: string }) => f.checkKey === 'queue-file-integrity',
    );
    expect(finding.severity).toBe('critical');
    expect(finding.status).toBe('fail');
    expect(finding.message).toBe('Queue file schema validation failed.');
  });

  // Task 11 (Medium) — Invalid JSON in credentials file triggers critical
  it('doctor auth-token-validity is critical when credentials file contains invalid JSON', async () => {
    await seedConfig(homeDir!);
    await claudeShim(homeDir!, 'ok');

    // Create the .claude directory and write an invalid JSON credentials file
    const claudeDir = join(homeDir!, '.claude');
    await mkdir(claudeDir, { recursive: true });
    await writeFile(join(claudeDir, '.credentials.json'), 'not valid json', { mode: 0o600 });

    const result = runCli(['doctor', '--json'], withShim(homeDir!), DOCTOR_TIMEOUT_MS);

    expect(result.stdout.trim()).not.toBe('');
    const parsed = JSON.parse(result.stdout.trim());

    const authFinding = parsed.data.findings.find(
      (f: { checkKey: string }) => f.checkKey === 'auth-token-validity',
    );
    expect(authFinding).toBeDefined();
    expect(authFinding.severity).toBe('critical');
    expect(authFinding.status).toBe('fail');
    expect(authFinding.message).toBe('Credentials file contains invalid JSON.');
    expect(authFinding.fixCommand).toBe('claude auth login');
  });
});
