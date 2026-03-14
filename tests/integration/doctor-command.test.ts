/** Integration test for the doctor command — validates deterministic findings on controlled fixture state. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function tmpDir(): string {
  return join(tmpdir(), 'doctor-int-' + randomBytes(6).toString('hex'));
}

let testDir: string;

describe('doctor command — integration', () => {
  beforeEach(async () => {
    vi.resetModules();
    testDir = tmpDir();
    await mkdir(testDir, { recursive: true });
    await mkdir(join(testDir, 'logs'), { recursive: true });

    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns deterministic finding count with valid queue fixture', async () => {
    // Create valid queue file
    await writeFile(
      join(testDir, 'queue.json'),
      JSON.stringify({
        version: 1,
        tasks: [],
      }),
    );

    // Create valid config
    await writeFile(join(testDir, 'config.yaml'), 'polling_interval: 300\n');

    vi.doMock('../../src/platform/index.js', () => ({
      getPaths: () => ({
        config: join(testDir, 'config.yaml'),
        data: testDir,
        logs: join(testDir, 'logs'),
      }),
      isLinux: () => false,
      isMacOS: () => false,
    }));

    vi.doMock('../../src/cli/index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(testDir, 'config.yaml'),
    }));

    const { runDiagnostics } = await import('../../src/cli/commands/doctor-runner.js');
    const result = await runDiagnostics(false);

    expect(result.summary.totalChecks).toBe(8);
    expect(result.findings).toHaveLength(8);

    // Queue file integrity should be ok with valid empty queue
    const queueFinding = result.findings.find((f) => f.checkKey === 'queue-file-integrity')!;
    expect(queueFinding.severity).toBe('ok');

    // Config should be ok with valid config
    const configFinding = result.findings.find((f) => f.checkKey === 'config-validity')!;
    expect(configFinding.severity).toBe('ok');

    // Log directory should be ok since we created it
    const logFinding = result.findings.find((f) => f.checkKey === 'log-directory-permissions')!;
    expect(logFinding.severity).toBe('ok');

    // Service check should be warning on non-linux/non-macos mock
    const serviceFinding = result.findings.find(
      (f) => f.checkKey === 'service-installation-state',
    )!;
    expect(serviceFinding.severity).toBe('warning');

    // Target repos should be warning since no targets configured
    const repoFinding = result.findings.find(
      (f) => f.checkKey === 'target-repo-accessibility',
    )!;
    expect(repoFinding.severity).toBe('warning');
  });

  it('returns deterministic counts with corrupt queue fixture', async () => {
    await writeFile(join(testDir, 'queue.json'), '{corrupted data}}}}');

    vi.doMock('../../src/platform/index.js', () => ({
      getPaths: () => ({
        config: join(testDir, 'config.yaml'),
        data: testDir,
        logs: join(testDir, 'logs'),
      }),
      isLinux: () => false,
      isMacOS: () => false,
    }));

    vi.doMock('../../src/cli/index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(testDir, 'config.yaml'),
    }));

    const { runDiagnostics } = await import('../../src/cli/commands/doctor-runner.js');
    const result = await runDiagnostics(false);

    const queueFinding = result.findings.find((f) => f.checkKey === 'queue-file-integrity')!;
    expect(queueFinding.severity).toBe('critical');
    expect(queueFinding.fixCommand).toBe('sparecrow queue clear --yes');
  });

  it('JSON output has stable shape', async () => {
    vi.doMock('../../src/platform/index.js', () => ({
      getPaths: () => ({
        config: join(testDir, 'config.yaml'),
        data: testDir,
        logs: join(testDir, 'logs'),
      }),
      isLinux: () => false,
      isMacOS: () => false,
    }));

    vi.doMock('../../src/cli/index.js', () => ({
      isJsonMode: () => true,
      getConfigPath: () => join(testDir, 'config.yaml'),
    }));

    const { runDiagnostics } = await import('../../src/cli/commands/doctor-runner.js');
    const result = await runDiagnostics(false);

    // Verify JSON serialization roundtrips cleanly
    const json = JSON.stringify({ ok: true, data: result, error: null });
    const parsed = JSON.parse(json) as { ok: boolean; data: typeof result; error: null };

    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeNull();
    expect(Array.isArray(parsed.data.findings)).toBe(true);
    expect(parsed.data.summary).toHaveProperty('criticalCount');
    expect(parsed.data.summary).toHaveProperty('warningCount');
    expect(parsed.data.summary).toHaveProperty('okCount');
    expect(parsed.data.summary).toHaveProperty('totalChecks');
  });

  it('verbose mode includes details for failed checks', async () => {
    await writeFile(join(testDir, 'queue.json'), 'invalid json {{{');

    vi.doMock('../../src/platform/index.js', () => ({
      getPaths: () => ({
        config: join(testDir, 'config.yaml'),
        data: testDir,
        logs: join(testDir, 'logs'),
      }),
      isLinux: () => false,
      isMacOS: () => false,
    }));

    vi.doMock('../../src/cli/index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(testDir, 'config.yaml'),
    }));

    const { runDiagnostics } = await import('../../src/cli/commands/doctor-runner.js');
    const result = await runDiagnostics(true);

    const queueFinding = result.findings.find((f) => f.checkKey === 'queue-file-integrity')!;
    expect(queueFinding.details).not.toBeNull();
    expect(queueFinding.details).toContain('JSON');
  });
});

describe('doctor command — subprocess pipeline', () => {
  let testDir: string;
  const tsxBin = join(process.cwd(), 'node_modules', '.bin', 'tsx');
  const cliEntry = join(process.cwd(), 'src', 'index.ts');

  beforeEach(async () => {
    testDir = join(tmpdir(), 'doctor-sub-' + randomBytes(6).toString('hex'));
    await mkdir(join(testDir, 'config', 'sparecrow'), { recursive: true });
    await mkdir(join(testDir, 'state', 'sparecrow', 'logs'), { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('subprocess: doctor --json produces valid { ok, data, error } envelope', async () => {
    const env = {
      ...process.env,
      XDG_CONFIG_HOME: join(testDir, 'config'),
      XDG_STATE_HOME: join(testDir, 'state'),
    };

    let stdoutOutput = '';
    try {
      const result = await execFileAsync(tsxBin, [cliEntry, 'doctor', '--json'], {
        env,
        timeout: 20_000,
      });
      stdoutOutput = result.stdout;
    } catch (err: unknown) {
      // Non-zero exit is expected when critical findings exist; stdout still has JSON
      stdoutOutput = (err as { stdout?: string }).stdout ?? '';
    }

    const parsed = JSON.parse(stdoutOutput.trim()) as {
      ok: boolean;
      data: { findings: unknown[]; summary: Record<string, number> } | null;
      error: unknown;
    };

    expect(parsed).toHaveProperty('ok');
    expect(parsed).toHaveProperty('data');
    expect(parsed).toHaveProperty('error');
    expect(Array.isArray(parsed.data?.findings)).toBe(true);
    expect(parsed.data?.findings).toHaveLength(8);
    expect(parsed.data?.summary).toHaveProperty('criticalCount');
    expect(parsed.data?.summary).toHaveProperty('warningCount');
    expect(parsed.data?.summary).toHaveProperty('okCount');
    expect(parsed.data?.summary).toHaveProperty('totalChecks');
    expect(parsed.data?.summary.totalChecks).toBe(8);
  });
});
