/** E2E full install round-trip smoke regression test (suite 11). @slow */
import { mkdtemp, rm, mkdir, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  runCli,
  runPty,
  seedConfig,
  seedCredentials,
  shimEnv,
  containerShim,
} from '../helpers/index.js';
import { ScrowError, ErrorCode } from '../../../src/errors/index.js';

/** Returns env overrides that isolate the spawned binary inside homeDir. */
function buildEnv(dir: string): Record<string, string> {
  return {
    ...shimEnv(dir, join(dir, 'bin')),
    NO_COLOR: '1',
    TERM: 'dumb',
  };
}

/**
 * Sets up all test prerequisites: config, shims, credentials, and git repo.
 * Writes a multi-mode claude shim that handles both `auth status` and dispatch calls.
 */
async function setupTestEnv(dir: string): Promise<void> {
  // Seed a valid config (includes trigger/provider keys)
  await seedConfig(dir);

  // Create bin directory for shims
  await mkdir(join(dir, 'bin'), { recursive: true });

  // Write multi-mode claude shim that handles auth status and dispatch calls
  const claudeShimScript = `#!/usr/bin/env bash
# E2E multi-mode claude shim for smoke regression
if echo "$*" | grep -q "auth status"; then
  echo '{"loggedIn":true,"subscriptionType":"claude_pro"}'
  exit 0
fi
echo '{"type":"result","subtype":"success","result":"E2E mock response","is_error":false,"usage":{"input_tokens":10,"output_tokens":20}}'
exit 0
`;
  await writeFile(join(dir, 'bin', 'claude'), claudeShimScript, 'utf8');
  await chmod(join(dir, 'bin', 'claude'), 0o755);

  // Write OS service command shim (systemctl on Linux, launchctl on macOS)
  const serviceCmdName = process.platform === 'darwin' ? 'launchctl' : 'systemctl';
  const serviceCmdShim = `#!/usr/bin/env bash
exit 0
`;
  await writeFile(join(dir, 'bin', serviceCmdName), serviceCmdShim, 'utf8');
  await chmod(join(dir, 'bin', serviceCmdName), 0o755);

  // Create container shims: docker responds as available, podman exits 1 (unavailable).
  // This prevents runContainerDetectionStage() from running real Docker/Podman commands.
  await containerShim(dir);

  // Create git repository at dir/repo
  await mkdir(join(dir, 'repo'), { recursive: true });
  const gitResult = spawnSync('git', ['init', join(dir, 'repo')]);
  if (gitResult.status !== 0) {
    throw new ScrowError(
      ErrorCode.TASK_EXECUTION_FAILED,
      `git init failed: ${gitResult.stderr?.toString() ?? 'unknown error'}`,
    );
  }

  // Seed fake credentials with both accessToken and refreshToken as specified in AC
  await seedCredentials(dir, { accessToken: 'test-token-e2e' });
  // Write credentials again with the full required format (accessToken + refreshToken: null)
  const credPath = join(dir, '.claude', '.credentials.json');
  await writeFile(credPath, JSON.stringify({ accessToken: 'test-token-e2e', refreshToken: null }), {
    mode: 0o600,
  });
}

describe('full install round-trip smoke regression (suite 11)', () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'sparecrow-smoke-'));
    await setupTestEnv(homeDir);
  });

  afterEach(async () => {
    // Best-effort stop any running daemon before cleanup — errors are expected when daemon is
    // already stopped; suppress them intentionally for cleanup robustness.
    try {
      runCli(['daemon', 'stop'], buildEnv(homeDir));
    } catch (err) {
      // Intentionally ignored: daemon may not be running; cleanup must always proceed.
      // Log to stderr for diagnostics without blocking cleanup.
      process.stderr.write(`afterEach daemon stop (best-effort): ${String(err)}\n`);
    }
    // Wait briefly for daemon process to fully exit before removing homeDir
    await new Promise<void>((r) => setTimeout(r, 300));
    await rm(homeDir, { recursive: true, force: true });
  });

  // @slow
  it('executes full install round-trip lifecycle in order', async () => {
    // ── Step 1: sparecrow --version ──────────────────────────────────────
    const r1 = runCli(['--version'], buildEnv(homeDir));
    expect(r1.exitCode).toBe(0);
    expect(r1.stdout).toMatch(/\d+\.\d+\.\d+/);

    // ── Step 2: sparecrow doctor (pre-onboard) ───────────────────────────
    const r2 = runCli(['doctor'], buildEnv(homeDir), 90_000);
    expect([0, 1]).toContain(r2.exitCode);
    expect(r2.stdout.length).toBeGreaterThan(0);

    // ── Step 3: sparecrow onboard (PTY) ─────────────────────────────────
    // seedConfig writes trigger/provider keys, so detectExistingConfig() returns true.
    // Prepend '\r' for the reconfigure prompt (select 'reconfigure' — first option).
    const onboardKeys = [
      '\r', // select reconfigure (first option, Enter)
      '\r', // idle hours (skip)
      '\r', // accept strategy (Balanced default)
      '\r', // accept polling interval (300 default)
      '\r', // submit multiselect (all 4 templates selected by default)
      '\r', // decline dangerous permissions (default: false)
      `${join(homeDir, 'repo')}\r`, // type repo path and confirm in one atomic keystroke
      '\r', // confirm summary
    ];

    const r3 = await runPty(['onboard'], {
      env: {
        ...buildEnv(homeDir),
        TERM: 'xterm-256color',
      },
      keystrokes: onboardKeys,
      keystrokeDelayMs: 150,
      timeoutMs: 30000,
    });

    expect(r3.exitCode).toBe(0);
    expect(r3.output).toContain('Setup complete!');

    // Verify queue seeded with 4 tasks after onboard
    const queuePath = join(homeDir, '.local', 'state', 'sparecrow', 'queue.json');
    const queueRaw = await readFile(queuePath, 'utf-8');
    const queue = JSON.parse(queueRaw) as {
      tasks: Array<{ type: string; status: string }>;
    };
    expect(queue.tasks.length).toBe(4);
    expect(queue.tasks.every((t) => t.type === 'template')).toBe(true);
    expect(queue.tasks.every((t) => t.status === 'pending')).toBe(true);

    // ── Step 4: sparecrow doctor (post-onboard) ──────────────────────────
    const r4 = runCli(['doctor'], buildEnv(homeDir), 90_000);
    expect([0, 1]).toContain(r4.exitCode);
    expect(r4.stdout.length).toBeGreaterThan(0);

    // ── Step 5: sparecrow config validate ────────────────────────────────
    const r5 = runCli(['config', 'validate'], buildEnv(homeDir));
    expect(r5.exitCode).toBe(0);

    // ── Step 6: sparecrow config get provider.name ───────────────────────
    const r6 = runCli(['config', 'get', 'provider.name'], buildEnv(homeDir));
    expect(r6.exitCode).toBe(0);
    expect(r6.stdout).toContain('claude-code');

    // ── Step 7: sparecrow config set polling_interval 60 ─────────────────
    const r7 = runCli(['config', 'set', 'polling_interval', '60'], buildEnv(homeDir));
    expect(r7.exitCode).toBe(0);

    // Verify config set round-trip
    const r7v = runCli(['config', 'get', 'polling_interval'], buildEnv(homeDir));
    expect(r7v.exitCode).toBe(0);
    expect(r7v.stdout).toContain('60');

    // ── Step 8: sparecrow templates ──────────────────────────────────────
    const r8 = runCli(['templates'], buildEnv(homeDir));
    expect(r8.exitCode).toBe(0);
    expect(r8.stdout).toContain('security-audit');
    expect(r8.stdout).toContain('improve-code');
    expect(r8.stdout).toContain('fix-bugs');
    expect(r8.stdout).toContain('write-tests');

    // ── Step 9: sparecrow queue list ─────────────────────────────────────
    const r9 = runCli(['queue', 'list'], buildEnv(homeDir));
    expect(r9.exitCode).toBe(0);
    expect(r9.stdout.length).toBeGreaterThan(0);
    expect(r9.stdout).toMatch(/security-audit|improve-code|fix-bugs|write-tests/);

    // ── Step 10: sparecrow daemon install --yes ──────────────────────────
    const r10 = runCli(['daemon', 'install', '--yes'], buildEnv(homeDir));
    expect(r10.exitCode).toBe(0);
    expect(r10.stdout).toContain('Service installed');

    // ── Step 11: sparecrow daemon start ──────────────────────────────────
    const r11 = runCli(['daemon', 'start'], buildEnv(homeDir));
    expect(r11.exitCode).toBe(0);
    expect(r11.stdout).toContain('Daemon started (PID');

    // ── Step 12: sparecrow daemon status (running) ───────────────────────
    const r12 = runCli(['daemon', 'status'], buildEnv(homeDir));
    expect(r12.exitCode).toBe(0);
    expect(r12.stdout).toContain('running (PID');

    // ── Step 13: sparecrow daemon reload ─────────────────────────────────
    const r13 = runCli(['daemon', 'reload'], buildEnv(homeDir));
    expect(r13.exitCode).toBe(0);
    expect(r13.stdout).toContain('Configuration reloaded');

    // Allow daemon to process SIGHUP before stopping
    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    // ── Step 14: sparecrow daemon stop ───────────────────────────────────
    const r14 = runCli(['daemon', 'stop'], buildEnv(homeDir));
    expect(r14.exitCode).toBe(0);
    expect(r14.stdout).toContain('Daemon stopped');

    // ── Step 15: sparecrow daemon restart (was stopped) ──────────────────
    const r15 = runCli(['daemon', 'restart'], buildEnv(homeDir));
    expect(r15.exitCode).toBe(0);
    expect(r15.stdout).toContain('Daemon started (was not running)');

    // Allow daemon to fully initialize signal handlers before stopping
    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    // ── Step 16: sparecrow daemon stop ───────────────────────────────────
    const r16 = runCli(['daemon', 'stop'], buildEnv(homeDir));
    expect(r16.exitCode).toBe(0);
    expect(r16.stdout).toContain('Daemon stopped');

    // ── Step 17: sparecrow daemon uninstall --yes ────────────────────────
    const r17 = runCli(['daemon', 'uninstall', '--yes'], buildEnv(homeDir));
    expect(r17.exitCode).toBe(0);
    expect(r17.stdout).toContain('Service uninstalled');

    // ── Step 18: sparecrow doctor (post-uninstall) ───────────────────────
    const r18 = runCli(['doctor'], buildEnv(homeDir), 90_000);
    expect([0, 1]).toContain(r18.exitCode);
    expect(r18.stdout.length).toBeGreaterThan(0);
  }, 60000);
});
