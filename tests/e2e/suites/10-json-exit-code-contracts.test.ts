/** E2E tests for JSON envelope schema compliance and exit code contracts (suite 10). */
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runCli, seedConfig } from '../helpers/index.js';

interface JsonEnvelope {
  ok: boolean;
  data: unknown;
  error: { code: string; message: string } | null;
}

// [AI-Review][Low] Strengthened to validate the full error field shape per Data Format Rules.
// The error field must be null OR an object with non-empty string `code` and `message` fields.
// A production regression where `error` is a bare string would be caught here.
function assertJsonEnvelope(raw: string): JsonEnvelope {
  const parsed: unknown = JSON.parse(raw);
  expect(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)).toBe(true);
  const obj = parsed as Record<string, unknown>;
  expect('ok' in obj).toBe(true);
  expect('data' in obj).toBe(true);
  expect('error' in obj).toBe(true);
  expect(typeof obj['ok']).toBe('boolean');

  // Validate error field shape: must be null or { code: string, message: string }
  const errorField = obj['error'];
  if (errorField !== null) {
    expect(
      typeof errorField === 'object' && !Array.isArray(errorField),
      `error field must be null or an object, got: ${typeof errorField}`,
    ).toBe(true);
    const errObj = errorField as Record<string, unknown>;
    expect(
      typeof errObj['code'] === 'string' && errObj['code'].length > 0,
      'error.code must be a non-empty string',
    ).toBe(true);
    expect(
      typeof errObj['message'] === 'string' && errObj['message'].length > 0,
      'error.message must be a non-empty string',
    ).toBe(true);
  }

  return parsed as JsonEnvelope;
}

// [AI-Review][High] Include PATH from the current process so that `git` and `node` are
// always available regardless of the test execution environment. Other E2E suites (03, 04)
// explicitly pass NODE_BIN_DIR to guarantee deterministic PATH resolution; here we propagate
// the inherited PATH so that validateRepository → git rev-parse works consistently.
function baseEnv(dir: string): Record<string, string> {
  return {
    HOME: dir,
    XDG_CONFIG_HOME: join(dir, '.config'),
    XDG_STATE_HOME: join(dir, '.local', 'state'),
    NO_COLOR: '1',
    TERM: 'dumb',
    ...(process.env['PATH'] ? { PATH: process.env['PATH'] } : {}),
  };
}

// [AI-Review][Medium] EXIT_0_COMMANDS moved to module scope (outside any describe block)
// so it cannot accidentally be refactored to reference lazily-initialized describe-scope
// variables like homeDir.
const EXIT_0_COMMANDS: [string, string[]][] = [
  ['--json status', ['--json', 'status']],
  ['--json queue list', ['--json', 'queue', 'list']],
  ['--json daemon status', ['--json', 'daemon', 'status']],
  ['--json config', ['--json', 'config']],
  ['--json templates', ['--json', 'templates']],
  ['--json logs', ['--json', 'logs']],
];

describe('JSON envelope and exit code contracts (suite 10)', () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'sparecrow-contracts-'));
    await seedConfig(homeDir);
  });

  afterEach(async () => {
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
  });

  // Task 3 (AC: 2, 10)
  it('status --json returns valid envelope with health, queue, usage, and activity fields', () => {
    const result = runCli(['--json', 'status'], baseEnv(homeDir));

    expect(result.exitCode).toBe(0);

    const parsed = assertJsonEnvelope(result.stdout);

    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeNull();

    // [AI-Review][Medium] Use separate assertions for typeof and null checks for clearer
    // failure messages instead of compound boolean expressions.
    expect(parsed.data).toBeDefined();
    expect(parsed.data).not.toBeNull();

    const data = parsed.data as Record<string, unknown>;

    // Assert health field
    expect(data['health']).toBeDefined();
    expect(data['health']).not.toBeNull();
    expect(typeof data['health']).toBe('object');

    const health = data['health'] as Record<string, unknown>;
    expect(typeof health['daemon']).toBe('string');
    // [AI-Review][High] AC2 requires asserting both `daemon` and `auth` fields on health.
    expect(typeof health['auth']).toBe('string');

    // Assert usage field
    expect(data['usage']).toBeDefined();
    expect(data['usage']).not.toBeNull();
    expect(typeof data['usage']).toBe('object');

    // Assert queue field
    expect(data['queue']).toBeDefined();
    expect(data['queue']).not.toBeNull();
    expect(typeof data['queue']).toBe('object');
    const queue = data['queue'] as Record<string, unknown>;
    expect(typeof queue['pendingCount']).toBe('number');

    // Assert activity field
    expect(data['activity']).toBeDefined();
    expect(data['activity']).not.toBeNull();
    expect(typeof data['activity']).toBe('object');
    const activity = data['activity'] as Record<string, unknown>;
    expect(Array.isArray(activity['recentDispatches'])).toBe(true);
  });

  // Task 4 (AC: 3, 10)
  it('queue list --json returns valid envelope with empty tasks array', () => {
    const result = runCli(['--json', 'queue', 'list'], baseEnv(homeDir));

    expect(result.exitCode).toBe(0);

    const parsed = assertJsonEnvelope(result.stdout);

    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeNull();

    const data = parsed.data as Record<string, unknown>;
    expect(Array.isArray(data['tasks'])).toBe(true);
    expect((data['tasks'] as unknown[]).length).toBe(0);
  });

  // Task 5 (AC: 4, 10)
  it('daemon status --json returns valid envelope with not-started state', () => {
    const result = runCli(['--json', 'daemon', 'status'], baseEnv(homeDir));

    expect(result.exitCode).toBe(0);

    const parsed = assertJsonEnvelope(result.stdout);

    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeNull();

    const data = parsed.data as Record<string, unknown>;
    expect(data['state']).toBe('not-started');
  });

  // Task 6 (AC: 5, 10)
  it('config --json returns valid envelope with config object', () => {
    const result = runCli(['--json', 'config'], baseEnv(homeDir));

    expect(result.exitCode).toBe(0);

    const parsed = assertJsonEnvelope(result.stdout);

    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeNull();

    // [AI-Review][Medium] Use separate assertions for clearer failure messages.
    const data = parsed.data as Record<string, unknown>;
    expect(data['config']).toBeDefined();
    expect(data['config']).not.toBeNull();
    expect(typeof data['config']).toBe('object');

    const cfg = data['config'] as Record<string, unknown>;
    expect(typeof cfg['polling_interval']).toBe('number');
    expect(cfg['provider']).toBeDefined();
    expect(cfg['provider']).not.toBeNull();
    expect(typeof cfg['provider']).toBe('object');
    expect(cfg['trigger']).toBeDefined();
    expect(cfg['trigger']).not.toBeNull();
    expect(typeof cfg['trigger']).toBe('object');
  });

  // Task 7 (AC: 6)
  it('doctor --json returns valid envelope with findings and summary', () => {
    const result = runCli(['--json', 'doctor'], baseEnv(homeDir));

    // Do NOT assert a specific exit code (may be 0 or 1 depending on critical findings)

    const parsed = assertJsonEnvelope(result.stdout);

    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeNull();

    // [AI-Review][Medium] Use separate assertions for clearer failure messages.
    const data = parsed.data as Record<string, unknown>;
    expect(Array.isArray(data['findings'])).toBe(true);
    expect(data['summary']).toBeDefined();
    expect(data['summary']).not.toBeNull();
    expect(typeof data['summary']).toBe('object');

    const summary = data['summary'] as Record<string, unknown>;
    expect(typeof summary['criticalCount']).toBe('number');
    expect(typeof summary['warningCount']).toBe('number');
    expect(typeof summary['okCount']).toBe('number');
    expect(typeof summary['totalChecks']).toBe('number');
  });

  // Task 8 (AC: 7, 10)
  it('templates --json returns valid envelope with 4 built-ins', () => {
    const result = runCli(['--json', 'templates'], baseEnv(homeDir));

    expect(result.exitCode).toBe(0);

    const parsed = assertJsonEnvelope(result.stdout);

    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeNull();

    const data = parsed.data as Record<string, unknown>;
    expect(Array.isArray(data['templates'])).toBe(true);
    expect((data['templates'] as unknown[]).length).toBe(4);
    expect(typeof data['customCount']).toBe('number');
    expect(data['customCount']).toBe(0);

    for (const entry of data['templates'] as Array<Record<string, unknown>>) {
      expect(typeof entry['name']).toBe('string');
      expect(typeof entry['type']).toBe('string');
      expect(typeof entry['description']).toBe('string');
    }
  });

  // Task 9 (AC: 8, 10)
  it('logs --json returns valid envelope with empty entries', () => {
    const result = runCli(['--json', 'logs'], baseEnv(homeDir));

    expect(result.exitCode).toBe(0);

    const parsed = assertJsonEnvelope(result.stdout);

    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeNull();

    const data = parsed.data as Record<string, unknown>;
    expect(Array.isArray(data['entries'])).toBe(true);
    expect((data['entries'] as unknown[]).length).toBe(0);
    expect(data['total']).toBe(0);
    expect(typeof data['successCount']).toBe('number');
    expect(typeof data['failureCount']).toBe('number');
  });

  // Task 10 (AC: 9, 13) — error path tests
  // Note: AC9 specifies CONFIG_NOT_FOUND from a missing config file, but loadConfig() in
  // src/config/loader.ts catches ENOENT and falls back to defaults (does not throw). There
  // is no production code path that throws CONFIG_NOT_FOUND via the CLI binary. The
  // CONFIG_NOT_FOUND code exists in AUTH_CONFIG_CODES for future use (e.g. when --config
  // flag points to a nonexistent file, which currently also falls back to defaults).
  // To trigger exit code 3 via E2E, we use an INVALID config file (polling_interval:
  // notanumber) which causes CONFIG_INVALID — also in AUTH_CONFIG_CODES — yielding exit 3.
  // This is the correct E2E approach given the current implementation.
  //
  // [AI-Review][High] This deviation from AC9 is now explicitly documented here and in the
  // story completion notes. CONFIG_INVALID is used (not CONFIG_NOT_FOUND) because
  // loadConfig() never throws CONFIG_NOT_FOUND for a missing file — it falls back to
  // defaults. The exit-code-3 contract (AC13) is still exercised correctly.
  //
  // [AI-Review][Medium] The former duplicate test (AC13) has been removed. The single test
  // below covers both AC9 (error envelope shape) and AC13 (exit code 3 contract) by asserting
  // exitCode === 3, ok === false, data === null, and error.code === 'CONFIG_INVALID'
  // (which is in AUTH_CONFIG_CODES). This eliminates the redundant second test that only
  // added a weaker `AUTH_CONFIG_CODES.includes(code)` check.
  describe('error paths', () => {
    let homeDir2: string;

    beforeEach(async () => {
      homeDir2 = await mkdtemp(join(tmpdir(), 'sparecrow-badconfig-'));
      // Seed an invalid config to trigger CONFIG_INVALID (exit code 3)
      const configDir = join(homeDir2, '.config', 'sparecrow');
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, 'config.yaml'), 'polling_interval: notanumber\n');
    });

    afterEach(async () => {
      await rm(homeDir2, { recursive: true, force: true });
    });

    // AC9 + AC13: Tests both envelope shape and exit code 3 contract.
    // CONFIG_INVALID (invalid YAML value) triggers exit 3 because it is in AUTH_CONFIG_CODES.
    it('config --json with invalid config exits 3 with CONFIG_INVALID error envelope', () => {
      const result = runCli(['--json', 'config'], {
        ...baseEnv(homeDir2),
      });

      // AC13: exit code 3 for AUTH_CONFIG_CODES errors
      expect(result.exitCode).toBe(3);

      // [AI-Review][Medium] Use type-narrowing local variable instead of non-null assertion.
      const parsed = assertJsonEnvelope(result.stdout);

      // AC9: error envelope shape
      expect(parsed.ok).toBe(false);
      expect(parsed.data).toBeNull();
      expect(parsed.error).not.toBeNull();

      // Narrow type — assertJsonEnvelope + the not.toBeNull() above guarantee non-null here
      const error = parsed.error as { code: string; message: string };
      expect(error.code).toBe('CONFIG_INVALID');
      expect(typeof error.message).toBe('string');
      expect(error.message.length).toBeGreaterThan(0);
    });
  });

  // Task 11 (AC: 11)
  it('queue add --json with invalid target returns JSON error envelope', () => {
    const result = runCli(
      ['--json', 'queue', 'add', '--template', 'improve-code', '--target', '/not/a/valid/path'],
      baseEnv(homeDir),
    );

    // In --json mode, the validateTarget catch block calls printJson(jsonError(...)) + return.
    // process.exitCode is never set, so the process exits with the default code 0.
    expect(result.exitCode).toBe(0);

    const parsed = assertJsonEnvelope(result.stdout);

    expect(parsed.ok).toBe(false);
    expect(parsed.error).not.toBeNull();

    // [AI-Review][Medium] Use type-narrowing local variable instead of non-null assertion.
    const error = parsed.error as { code: string; message: string };
    expect(error.code).toBe('QUEUE_ADD_TARGET_INVALID');
  });

  // Task 12 (AC: 12)
  it('daemon stop --json when daemon not running exits 0 with DAEMON_NOT_RUNNING envelope', () => {
    const result = runCli(['--json', 'daemon', 'stop'], baseEnv(homeDir));

    // In --json mode, the local catch block calls printJson(jsonError(...)) + return.
    // process.exitCode is never set, so the process exits with the default code 0.
    expect(result.exitCode).toBe(0);

    const parsed = assertJsonEnvelope(result.stdout);

    expect(parsed.ok).toBe(false);
    expect(parsed.error).not.toBeNull();

    // [AI-Review][Medium] Use type-narrowing local variable instead of non-null assertion.
    const error = parsed.error as { code: string; message: string };
    expect(error.code).toBe('DAEMON_NOT_RUNNING');
  });

  // Task 13 (AC: 10) — table-driven exit code 0 test
  // [AI-Review][Medium] EXIT_0_COMMANDS is declared at module scope (above this describe
  // block) to avoid the fragility of declaring it inside the describe block where it could
  // accidentally reference lazily-initialized variables like homeDir.
  describe('exit code 0 across all non-error commands', () => {
    it.each(EXIT_0_COMMANDS)('%s exits 0', (_label, args) => {
      const result = runCli(args, baseEnv(homeDir));

      expect(result.exitCode).toBe(0);
      assertJsonEnvelope(result.stdout);
    });
  });
});
