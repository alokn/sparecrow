/** E2E tests for the onboard interactive wizard (suite 09). */
import { mkdtemp, rm, readFile, mkdir, chmod, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { stringify } from 'yaml';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  runCli,
  runPty,
  seedConfig,
  claudeShim,
  osCmdShim,
  containerShim,
  seedCredentials,
} from '../helpers/index.js';

/** Returns env overrides that isolate the spawned binary inside homeDir (non-PTY). */
function baseEnv(dir: string): Record<string, string> {
  return {
    HOME: dir,
    XDG_CONFIG_HOME: join(dir, '.config'),
    XDG_STATE_HOME: join(dir, '.local', 'state'),
    XDG_DATA_HOME: join(dir, '.local', 'share'),
    XDG_CACHE_HOME: join(dir, '.cache'),
  };
}

/** Returns env overrides for PTY tests with PATH prepended and TERM set. */
function ptyEnv(dir: string): Record<string, string> {
  return {
    ...baseEnv(dir),
    PATH: join(dir, 'bin') + ':' + join(dir, 'os-bin') + ':' + (process.env['PATH'] ?? ''),
    TERM: 'xterm-256color',
  };
}

/**
 * Seeds a minimal config WITHOUT trigger/provider keys so detectExistingConfig() returns false.
 * This avoids the reconfigure prompt in fresh-onboard tests.
 */
async function seedFreshConfig(dir: string): Promise<string> {
  const configDir = join(dir, '.config', 'sparecrow');
  const configPath = join(configDir, 'config.yaml');
  await mkdir(configDir, { recursive: true });
  const minimal = {
    polling_interval: 300,
    log_retention_days: 30,
    last_summary_enabled: false,
    tasks: [],
  };
  await writeFile(configPath, stringify(minimal), 'utf8');
  return configPath;
}

/**
 * Creates an auth-aware claude shim that responds differently to `auth status` vs other args.
 * mode 'ok': auth status returns logged-in JSON; other args return generic success.
 * mode 'auth-fail': always exits 1 with 'not logged in' on stderr.
 */
async function authAwareClaudeShim(dir: string, mode: 'ok' | 'auth-fail'): Promise<string> {
  const binDir = join(dir, 'bin');
  const shimPath = join(binDir, 'claude');
  await mkdir(binDir, { recursive: true });

  if (mode === 'ok') {
    await writeFile(
      shimPath,
      `#!/usr/bin/env bash
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  echo '{"loggedIn":true,"subscriptionType":"max5"}'
  exit 0
fi
echo '{"type":"result","subtype":"success","result":"E2E mock response","is_error":false,"usage":{"input_tokens":10,"output_tokens":20}}'
exit 0
`,
    );
  } else {
    await writeFile(
      shimPath,
      `#!/usr/bin/env bash
echo 'not logged in' >&2
exit 1
`,
    );
  }

  await chmod(shimPath, 0o755);
  return shimPath;
}

describe('onboard interactive (suite 09)', () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'sparecrow-onboard-'));
  });

  afterEach(async () => {
    // Restore permissions for AC9 before cleanup.
    // ENOENT is expected (directory never created in tests that exit early) — ignore it.
    // Re-throw unexpected errors so cleanup failures are visible in the test runner output.
    await chmod(join(homeDir, '.config', 'sparecrow'), 0o755).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    });
    // Best-effort stop any orphaned daemon spawned during install-daemon test.
    // Poll for the daemon to exit (up to 3s) rather than using a fixed 300ms wait,
    // to avoid ENOTEMPTY failures when the daemon still has open file handles.
    try {
      const pidPath = join(homeDir, '.local', 'state', 'sparecrow', 'daemon.pid');
      const pidContent = await readFile(pidPath, 'utf-8').catch(() => '');
      const pid = parseInt(pidContent.trim(), 10);
      if (Number.isFinite(pid) && pid > 0) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          /* process may not exist */
        }
        // Poll until the process exits (up to 3s) before attempting cleanup
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          try {
            process.kill(pid, 0); // throws ESRCH if process no longer exists
            await new Promise<void>((r) => setTimeout(r, 100));
          } catch {
            break; // process is gone
          }
        }
      }
    } catch {
      /* ignore */
    }
    await rm(homeDir, { recursive: true, force: true });
  });

  // Task 4 (AC: 1)
  it('exits 1 with TTY guidance in non-TTY environment', async () => {
    await seedConfig(homeDir);
    const result = runCli(['onboard'], baseEnv(homeDir));

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('interactive terminal');
  });

  // Task 5 (AC: 2)
  it('exits 1 with JSON CONFIG_INVALID error when --json passed', async () => {
    await seedConfig(homeDir);
    const result = runCli(['--json', 'onboard'], baseEnv(homeDir));

    expect(result.exitCode).toBe(1);

    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      data: unknown;
      error: { code: string; message: string } | null;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.data).toBeNull();
    expect(parsed.error).not.toBeNull();
    expect(parsed.error!.code).toBe('CONFIG_INVALID');
    expect(parsed.error!.message).toContain('interactive');
  });

  // Task 6 (AC: 3)
  it('completes happy path without daemon — exits 0 and writes config', async () => {
    // Seed config WITHOUT trigger/provider to avoid reconfigure prompt
    await seedFreshConfig(homeDir);
    await authAwareClaudeShim(homeDir, 'ok');
    await containerShim(homeDir);
    await seedCredentials(homeDir);
    await mkdir(join(homeDir, 'repo'), { recursive: true });
    execSync('git init', { cwd: join(homeDir, 'repo'), stdio: 'ignore' });

    const result = await runPty(['onboard'], {
      env: ptyEnv(homeDir),
      keystrokes: [
        '\r', // idle hours (skip)
        '\r', // accept strategy (Balanced default)
        '\r', // accept polling interval (300 default)
        'a', // toggle all templates off
        '\r', // submit multiselect (0 selected)
        'y', // confirm proceeding without templates (y auto-submits in @clack/prompts)
        '\r', // decline dangerous permissions (default false)
        join(homeDir, 'repo'), // type repo path
        '\r', // submit repo path
        '\r', // confirm summary
        '\r', // decline telemetry (default: no)
        '\r', // decline shell completions (default: no)
      ],
      keystrokeDelayMs: 150,
      timeoutMs: 25000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Setup complete!');

    // Config file exists and contains trigger
    const configPath = join(homeDir, '.config', 'sparecrow', 'config.yaml');
    const configContent = await readFile(configPath, 'utf-8');
    expect(configContent).toContain('trigger');

    // Queue file should NOT exist (zero templates selected)
    const queuePath = join(homeDir, '.local', 'state', 'sparecrow', 'queue.json');
    const queueExists = await stat(queuePath).then(
      () => true,
      () => false,
    );
    expect(queueExists).toBe(false);
  }, 35000);

  // Task 7 (AC: 4)
  it('seeds queue with 2 tasks when 2 templates selected', async () => {
    // Seed config WITHOUT trigger/provider to avoid reconfigure prompt
    await seedFreshConfig(homeDir);
    await authAwareClaudeShim(homeDir, 'ok');
    await containerShim(homeDir);
    await seedCredentials(homeDir);
    await mkdir(join(homeDir, 'repo'), { recursive: true });
    execSync('git init', { cwd: join(homeDir, 'repo'), stdio: 'ignore' });

    const result = await runPty(['onboard'], {
      env: ptyEnv(homeDir),
      keystrokes: [
        '\r', // idle hours (skip)
        '\r', // accept strategy (Balanced default)
        '\r', // accept polling interval (300 default)
        'a', // toggle all off first
        ' ', // re-select first item (fix-bugs, cursor is on it)
        '\x1b[B', // ArrowDown to second (improve-code)
        '\x1b[B', // ArrowDown to third (write-tests)
        '\x1b[B', // ArrowDown to fourth (security-audit)
        ' ', // select fourth item (security-audit)
        '\r', // submit multiselect (2 selected: fix-bugs + security-audit)
        '\r', // decline dangerous permissions (default false)
        join(homeDir, 'repo'), // type repo path
        '\r', // submit repo path
        '\r', // confirm summary
        '\r', // decline telemetry (default: no)
        '\r', // decline shell completions (default: no)
      ],
      keystrokeDelayMs: 150,
      timeoutMs: 25000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Setup complete!');

    const queuePath = join(homeDir, '.local', 'state', 'sparecrow', 'queue.json');
    const queueContent = await readFile(queuePath, 'utf-8');
    const parsed = JSON.parse(queueContent) as {
      tasks: Array<{
        type: string;
        status: string;
        targetPath: string;
        templateName?: string;
      }>;
    };

    expect(parsed.tasks.length).toBe(2);
    expect(parsed.tasks.every((t) => t.type === 'template')).toBe(true);
    expect(parsed.tasks.every((t) => t.status === 'pending')).toBe(true);
    expect(parsed.tasks.every((t) => t.targetPath === join(homeDir, 'repo'))).toBe(true);
    // Assert the two selected templates are fix-bugs and security-audit
    const templateNames = parsed.tasks.map((t) => t.templateName).sort();
    expect(templateNames).toEqual(['fix-bugs', 'security-audit']);
  }, 35000);

  // Task 8 (AC: 5)
  it('installs service file with --install-daemon', { timeout: 48000 }, async () => {
    // Seed config WITHOUT trigger/provider to avoid reconfigure prompt
    await seedFreshConfig(homeDir);
    await authAwareClaudeShim(homeDir, 'ok');
    await containerShim(homeDir);
    await seedCredentials(homeDir);
    await mkdir(join(homeDir, 'repo'), { recursive: true });
    execSync('git init', { cwd: join(homeDir, 'repo'), stdio: 'ignore' });
    // Use shared osCmdShim helper (validates --user / load|unload argument correctness)
    await osCmdShim(homeDir, 'ok');

    // Ensure the state directory exists before the test runs.
    // Note: pre-seeding daemon.pid alone is insufficient to prevent a real daemon spawn —
    // checkPidStatus() additionally calls isScrowDaemonProcess() which checks /proc/<pid>/cmdline
    // for the '--daemon-runner' flag. Since process.ppid points to a non-daemon process,
    // it returns 'stale', the stale PID gets cleaned up, and startDaemon() proceeds normally.
    // The afterEach block handles cleanup of any spawned daemon process.
    const stateDir = join(homeDir, '.local', 'state', 'sparecrow');
    await mkdir(stateDir, { recursive: true });

    const result = await runPty(['onboard', '--install-daemon'], {
      env: ptyEnv(homeDir),
      keystrokes: [
        '\r', // idle hours (skip)
        '\r', // accept strategy (Balanced default)
        '\r', // accept polling interval (300 default)
        '\r', // accept all templates (default: all 4 selected)
        '\r', // decline permissions (default false)
        join(homeDir, 'repo'), // type repo path
        '\r', // submit repo path
        '\r', // confirm summary
        '\r', // decline telemetry (default: no)
        '\r', // decline shell completions (default: no)
      ],
      keystrokeDelayMs: 150,
      timeoutMs: 38000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Setup complete!');
    expect(result.output).toContain('Daemon is running');

    // Assert service file exists at platform-specific path
    if (process.platform === 'linux') {
      const servicePath = join(homeDir, '.config', 'systemd', 'user', 'sparecrow.service');
      const serviceExists = await stat(servicePath).then(
        () => true,
        () => false,
      );
      expect(serviceExists).toBe(true);
    } else if (process.platform === 'darwin') {
      const servicePath = join(homeDir, 'Library', 'LaunchAgents', 'com.sparecrow.daemon.plist');
      const serviceExists = await stat(servicePath).then(
        () => true,
        () => false,
      );
      expect(serviceExists).toBe(true);
    }
  });

  // Task 9 (AC: 6)
  it('reconfigures existing config successfully', async () => {
    // Seed config with trigger/provider keys to trigger reconfigure detection
    await seedConfig(homeDir, {
      trigger: { max_waste_percentage: 30, weekly_reserve_percentage: 20 },
      provider: { claude_path: join(homeDir, 'bin', 'claude') },
    });
    await authAwareClaudeShim(homeDir, 'ok');
    await containerShim(homeDir);
    await seedCredentials(homeDir);
    await mkdir(join(homeDir, 'repo'), { recursive: true });
    execSync('git init', { cwd: join(homeDir, 'repo'), stdio: 'ignore' });

    const result = await runPty(['onboard'], {
      env: ptyEnv(homeDir),
      keystrokes: [
        '\r', // select reconfigure (first option, Enter)
        '\r', // idle hours (skip)
        '\r', // accept strategy (Balanced default)
        '\r', // accept polling interval (300 default)
        '\r', // accept all templates (default: all 4)
        '\r', // decline dangerous permissions (default false)
        join(homeDir, 'repo'), // type repo path
        '\r', // submit repo path
        '\r', // confirm summary
        '\r', // decline telemetry (default: no)
        '\r', // decline shell completions (default: no)
      ],
      keystrokeDelayMs: 150,
      timeoutMs: 25000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Setup complete!');

    // Config file still exists
    const configPath = join(homeDir, '.config', 'sparecrow', 'config.yaml');
    const configExists = await stat(configPath).then(
      () => true,
      () => false,
    );
    expect(configExists).toBe(true);
  }, 35000);

  // Task 10 (AC: 7)
  it('exits without change when exit option selected', async () => {
    // Seed config with trigger/provider keys for reconfigure detection
    await seedConfig(homeDir, {
      trigger: { max_waste_percentage: 30, weekly_reserve_percentage: 20 },
      provider: { claude_path: join(homeDir, 'bin', 'claude') },
    });

    const configPath = join(homeDir, '.config', 'sparecrow', 'config.yaml');
    const before = await readFile(configPath, 'utf-8');

    // Install claude shim (needed for PATH in env, even if not invoked)
    await claudeShim(homeDir, 'ok');

    const result = await runPty(['onboard'], {
      env: ptyEnv(homeDir),
      keystrokes: [
        '\x1b[B', // ArrowDown to navigate to 'exit' option
        '\r', // confirm exit
      ],
      keystrokeDelayMs: 150,
      timeoutMs: 15000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Exiting without changes.');

    const after = await readFile(configPath, 'utf-8');
    expect(before).toBe(after);
  }, 25000);

  // Task 11 (AC: 8)
  it('exits 1 on auth failure without writing config', async () => {
    // Seed config WITHOUT trigger/provider to avoid reconfigure prompt
    await seedFreshConfig(homeDir);
    await claudeShim(homeDir, 'auth-fail');
    // Use shared seedCredentials so validate() returns true, then shim exits 1 for auth status
    await seedCredentials(homeDir);

    const result = await runPty(['onboard'], {
      env: ptyEnv(homeDir),
      keystrokes: [
        'n', // decline running claude auth login
        '\r', // submit negative response
      ],
      keystrokeDelayMs: 150,
      timeoutMs: 15000,
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Setup cancelled.');

    // Config should not have trigger/provider from the wizard
    const configPath = join(homeDir, '.config', 'sparecrow', 'config.yaml');
    const configContent = await readFile(configPath, 'utf-8');
    // seedFreshConfig has no trigger/provider — verify wizard didn't write them
    expect(configContent).not.toContain('max_waste_percentage');
  }, 25000);

  // Task 12 (AC: 9)
  it('rolls back on apply failure with non-writable config dir', async () => {
    // Skip if running as root (chmod won't prevent writes for root)
    if (process.getuid && process.getuid() === 0) {
      return;
    }

    // Seed config with trigger/provider keys for reconfigure path
    await seedConfig(homeDir, {
      trigger: { max_waste_percentage: 30, weekly_reserve_percentage: 20 },
      provider: { claude_path: join(homeDir, 'bin', 'claude') },
    });

    await authAwareClaudeShim(homeDir, 'ok');
    await containerShim(homeDir);
    await seedCredentials(homeDir);
    await mkdir(join(homeDir, 'repo'), { recursive: true });
    execSync('git init', { cwd: join(homeDir, 'repo'), stdio: 'ignore' });

    // Make config directory non-writable to cause apply failure
    await chmod(join(homeDir, '.config', 'sparecrow'), 0o555);

    const result = await runPty(['onboard'], {
      env: ptyEnv(homeDir),
      keystrokes: [
        '\r', // select reconfigure (first option)
        '\r', // idle hours (skip)
        '\r', // accept strategy (Balanced default)
        '\r', // accept polling interval (300 default)
        '\r', // accept all templates (default)
        '\r', // decline permissions (default false)
        join(homeDir, 'repo'), // type repo path
        '\r', // submit repo path
        '\r', // confirm summary
        '\r', // decline telemetry (default: no) — triggers apply → write fails
      ],
      keystrokeDelayMs: 150,
      timeoutMs: 30000,
    });

    // Restore permissions before assertions so afterEach cleanup works
    await chmod(join(homeDir, '.config', 'sparecrow'), 0o755);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Setup failed');
    expect(result.output).toContain('Could not fully restore');
  }, 40000);
});
