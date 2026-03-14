/** Unit tests for the doctor diagnostic runner — covers each check with ok/warning/critical outcomes. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return join(tmpdir(), 'doctor-runner-' + randomBytes(6).toString('hex'));
}

let testDir: string;

describe('redactSecrets', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('redacts token-like strings starting with sk-ant-', async () => {
    const { redactSecrets } = await import('./doctor-runner.js');
    expect(redactSecrets('Token: sk-ant-abc123-secret')).toContain('[REDACTED]');
    expect(redactSecrets('Token: sk-ant-abc123-secret')).not.toContain('sk-ant-');
  });

  it('redacts Bearer token strings', async () => {
    const { redactSecrets } = await import('./doctor-runner.js');
    expect(redactSecrets('Authorization: Bearer eyJhbGciOiJ')).toContain('[REDACTED]');
    expect(redactSecrets('Authorization: Bearer eyJhbGciOiJ')).not.toContain('eyJhbGciOiJ');
  });

  it('preserves non-secret text', async () => {
    const { redactSecrets } = await import('./doctor-runner.js');
    expect(redactSecrets('Normal text here')).toBe('Normal text here');
  });

  it('does not redact container IDs (pure hex strings)', async () => {
    // Container IDs are 64-char lowercase hex and must not be redacted — they appear in
    // verbose output and error messages and are not secrets (AI-Review finding: SECRET_PATTERN fix).
    const { redactSecrets } = await import('./doctor-runner.js');
    const containerId = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    const msg = `No such container: ${containerId}`;
    expect(redactSecrets(msg)).toContain(containerId);
    expect(redactSecrets(msg)).not.toContain('[REDACTED]');
  });
});

describe('computeSummary', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('counts severity levels correctly', async () => {
    const { computeSummary } = await import('./doctor-runner.js');
    const findings = [
      { severity: 'critical' as const },
      { severity: 'critical' as const },
      { severity: 'warning' as const },
      { severity: 'ok' as const },
      { severity: 'ok' as const },
      { severity: 'ok' as const },
    ];
    const summary = computeSummary(findings as Parameters<typeof computeSummary>[0]);
    expect(summary).toEqual({
      criticalCount: 2,
      warningCount: 1,
      okCount: 3,
      totalChecks: 6,
    });
  });

  it('returns zero counts for empty array', async () => {
    const { computeSummary } = await import('./doctor-runner.js');
    const summary = computeSummary([]);
    expect(summary).toEqual({
      criticalCount: 0,
      warningCount: 0,
      okCount: 0,
      totalChecks: 0,
    });
  });
});

describe('runDiagnostics', () => {
  beforeEach(async () => {
    vi.resetModules();
    testDir = tmpDir();
    await mkdir(testDir, { recursive: true });

    // Mock platform paths to use test dir
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({
        config: join(testDir, 'config.yaml'),
        data: testDir,
        logs: join(testDir, 'logs'),
      }),
      isLinux: () => false,
      isMacOS: () => false,
    }));

    // Mock CLI index to provide getConfigPath
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(testDir, 'config.yaml'),
    }));

    // Suppress stderr output from logger
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns 13 findings in deterministic order (container checks always included)', async () => {
    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);

    expect(result.findings).toHaveLength(13);
    expect(result.findings[0]!.checkKey).toBe('auth-token-validity');
    expect(result.findings[1]!.checkKey).toBe('claude-installation');
    expect(result.findings[2]!.checkKey).toBe('usage-endpoint-connectivity');
    expect(result.findings[3]!.checkKey).toBe('config-validity');
    expect(result.findings[4]!.checkKey).toBe('service-installation-state');
    expect(result.findings[5]!.checkKey).toBe('target-repo-accessibility');
    expect(result.findings[6]!.checkKey).toBe('queue-file-integrity');
    expect(result.findings[7]!.checkKey).toBe('log-directory-permissions');
    expect(result.findings[8]!.checkKey).toBe('container-runtime-detection');
    expect(result.findings[9]!.checkKey).toBe('container-rootless-mode');
    expect(result.findings[10]!.checkKey).toBe('container-test-run');
    expect(result.findings[11]!.checkKey).toBe('container-credential-mount');
    expect(result.findings[12]!.checkKey).toBe('container-custom-image-claude');
  }, 30000);

  it('includes summary with correct total', async () => {
    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);

    expect(result.summary.totalChecks).toBe(13);
    expect(
      result.summary.criticalCount + result.summary.warningCount + result.summary.okCount,
    ).toBe(13);
  }, 30000);

  it('strips details in non-verbose mode', async () => {
    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);

    for (const finding of result.findings) {
      expect(finding.details).toBeNull();
    }
  }, 30000);

  it('all finding fields are always present', async () => {
    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);

    for (const finding of result.findings) {
      expect(finding).toHaveProperty('checkKey');
      expect(finding).toHaveProperty('checkName');
      expect(finding).toHaveProperty('severity');
      expect(finding).toHaveProperty('status');
      expect(finding).toHaveProperty('message');
      expect(finding).toHaveProperty('fixCommand');
      expect(finding).toHaveProperty('durationMs');
      expect(finding).toHaveProperty('details');
      expect(typeof finding.durationMs).toBe('number');
    }
  }, 30000);

  it('non-ok findings include fixCommand', async () => {
    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);

    for (const finding of result.findings) {
      if (finding.severity !== 'ok') {
        expect(finding.fixCommand).not.toBeNull();
        expect(typeof finding.fixCommand).toBe('string');
        expect(finding.fixCommand!.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('runDiagnostics — auth-token-validity', () => {
  beforeEach(async () => {
    vi.resetModules();
    testDir = tmpDir();
    await mkdir(testDir, { recursive: true });

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({
        config: join(testDir, 'config.yaml'),
        data: testDir,
        logs: join(testDir, 'logs'),
      }),
      isLinux: () => false,
      isMacOS: () => false,
    }));

    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(testDir, 'config.yaml'),
    }));

    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
  });

  it('reports critical when credentials file is missing', async () => {
    vi.doMock('node:os', () => ({ homedir: () => testDir }));

    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);
    const finding = result.findings.find((f) => f.checkKey === 'auth-token-validity')!;
    expect(finding.severity).toBe('critical');
    expect(finding.fixCommand).toBe('claude auth login');
    expect(finding.message).toContain('No Claude Code credentials found');
  });

  it('reports critical when credentials file contains invalid JSON', async () => {
    await mkdir(join(testDir, '.claude'), { recursive: true });
    await writeFile(join(testDir, '.claude', '.credentials.json'), '{ invalid json }');

    vi.doMock('node:os', () => ({ homedir: () => testDir }));

    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);
    const finding = result.findings.find((f) => f.checkKey === 'auth-token-validity')!;
    expect(finding.severity).toBe('critical');
    expect(finding.message).toContain('invalid JSON');
  });

  it('reports ok for valid credentials file with future expiry (epoch-ms)', async () => {
    await mkdir(join(testDir, '.claude'), { recursive: true });
    const futureMs = Date.now() + 3_600_000;
    await writeFile(
      join(testDir, '.claude', '.credentials.json'),
      JSON.stringify({ accessToken: 'test-token-abc123', expiresAt: futureMs }),
    );

    vi.doMock('node:os', () => ({ homedir: () => testDir }));

    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);
    const finding = result.findings.find((f) => f.checkKey === 'auth-token-validity')!;
    expect(finding.severity).toBe('ok');
  });

  it('reports critical for expired token (epoch-seconds format)', async () => {
    await mkdir(join(testDir, '.claude'), { recursive: true });
    // epoch-seconds in the past (1 hour ago)
    const pastSeconds = Math.floor((Date.now() - 3_600_000) / 1000);
    await writeFile(
      join(testDir, '.claude', '.credentials.json'),
      JSON.stringify({ accessToken: 'test-token-abc123', expiresAt: pastSeconds }),
    );

    vi.doMock('node:os', () => ({ homedir: () => testDir }));

    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);
    const finding = result.findings.find((f) => f.checkKey === 'auth-token-validity')!;
    expect(finding.severity).toBe('critical');
    expect(finding.message).toContain('expired');
    expect(finding.fixCommand).toBe('sparecrow config --reconnect');
  });

  it('reports critical for expired token (epoch-milliseconds format)', async () => {
    await mkdir(join(testDir, '.claude'), { recursive: true });
    const pastMs = Date.now() - 3_600_000;
    await writeFile(
      join(testDir, '.claude', '.credentials.json'),
      JSON.stringify({ accessToken: 'test-token-abc123', expiresAt: pastMs }),
    );

    vi.doMock('node:os', () => ({ homedir: () => testDir }));

    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);
    const finding = result.findings.find((f) => f.checkKey === 'auth-token-validity')!;
    expect(finding.severity).toBe('critical');
    expect(finding.message).toContain('expired');
  });

  it('reports critical for expired token (ISO string format)', async () => {
    await mkdir(join(testDir, '.claude'), { recursive: true });
    const pastIso = new Date(Date.now() - 3_600_000).toISOString();
    await writeFile(
      join(testDir, '.claude', '.credentials.json'),
      JSON.stringify({ accessToken: 'test-token-abc123', expiresAt: pastIso }),
    );

    vi.doMock('node:os', () => ({ homedir: () => testDir }));

    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);
    const finding = result.findings.find((f) => f.checkKey === 'auth-token-validity')!;
    expect(finding.severity).toBe('critical');
    expect(finding.message).toContain('expired');
  });
});

describe('runDiagnostics — queue-file-integrity', () => {
  beforeEach(async () => {
    vi.resetModules();
    testDir = tmpDir();
    await mkdir(testDir, { recursive: true });
    await mkdir(join(testDir, 'logs'), { recursive: true });

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({
        config: join(testDir, 'config.yaml'),
        data: testDir,
        logs: join(testDir, 'logs'),
      }),
      isLinux: () => false,
      isMacOS: () => false,
    }));

    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(testDir, 'config.yaml'),
    }));

    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
  });

  it('reports ok when queue file is absent', async () => {
    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);
    const finding = result.findings.find((f) => f.checkKey === 'queue-file-integrity')!;
    expect(finding.severity).toBe('ok');
    expect(finding.message).toContain('empty queue');
  });

  it('reports ok for valid queue file', async () => {
    await writeFile(
      join(testDir, 'queue.json'),
      JSON.stringify({
        version: 1,
        tasks: [
          {
            id: '00000000-0000-4000-8000-000000000001',
            name: 'test',
            status: 'pending',
            type: 'custom',
            prompt: 'test prompt',
            targetPath: '/tmp/repo',
            priority: 1,
            createdAt: new Date().toISOString(),
            timeoutMs: 60000,
          },
        ],
      }),
    );

    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);
    const finding = result.findings.find((f) => f.checkKey === 'queue-file-integrity')!;
    expect(finding.severity).toBe('ok');
    expect(finding.message).toContain('1 task');
  });

  it('reports critical for invalid JSON in queue file', async () => {
    await writeFile(join(testDir, 'queue.json'), '{ not valid json }}}');

    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);
    const finding = result.findings.find((f) => f.checkKey === 'queue-file-integrity')!;
    expect(finding.severity).toBe('critical');
    expect(finding.fixCommand).toBe('sparecrow queue clear --yes');
  });

  it('reports critical for schema-invalid queue file', async () => {
    await writeFile(
      join(testDir, 'queue.json'),
      JSON.stringify({ version: 99, tasks: 'not-an-array' }),
    );

    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);
    const finding = result.findings.find((f) => f.checkKey === 'queue-file-integrity')!;
    expect(finding.severity).toBe('critical');
    expect(finding.fixCommand).toBe('sparecrow queue clear --yes');
  });
});

describe('runDiagnostics — log-directory-permissions', () => {
  beforeEach(async () => {
    vi.resetModules();
    testDir = tmpDir();
    await mkdir(testDir, { recursive: true });

    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(testDir, 'config.yaml'),
    }));

    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
  });

  it('reports ok when logs directory exists and is writable', async () => {
    const logsDir = join(testDir, 'logs');
    await mkdir(logsDir, { recursive: true });

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({
        config: join(testDir, 'config.yaml'),
        data: testDir,
        logs: logsDir,
      }),
      isLinux: () => false,
      isMacOS: () => false,
    }));

    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);
    const finding = result.findings.find((f) => f.checkKey === 'log-directory-permissions')!;
    expect(finding.severity).toBe('ok');
  });

  it('reports warning when logs directory does not exist', async () => {
    const logsDir = join(testDir, 'nonexistent-logs');

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({
        config: join(testDir, 'config.yaml'),
        data: testDir,
        logs: logsDir,
      }),
      isLinux: () => false,
      isMacOS: () => false,
    }));

    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);
    const finding = result.findings.find((f) => f.checkKey === 'log-directory-permissions')!;
    expect(finding.severity).toBe('warning');
    expect(finding.fixCommand).toContain('mkdir');
  });
});

describe('runDiagnostics — config-validity', () => {
  beforeEach(async () => {
    vi.resetModules();
    testDir = tmpDir();
    await mkdir(testDir, { recursive: true });
    await mkdir(join(testDir, 'logs'), { recursive: true });

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({
        config: join(testDir, 'config.yaml'),
        data: testDir,
        logs: join(testDir, 'logs'),
      }),
      isLinux: () => false,
      isMacOS: () => false,
    }));

    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
  });

  it('reports ok when config file is absent (defaults apply)', async () => {
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(testDir, 'config.yaml'),
    }));

    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);
    const finding = result.findings.find((f) => f.checkKey === 'config-validity')!;
    expect(finding.severity).toBe('ok');
    expect(finding.message).toContain('defaults');
  });

  it('reports ok for valid config', async () => {
    await writeFile(join(testDir, 'config.yaml'), 'polling_interval: 300\n');

    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(testDir, 'config.yaml'),
    }));

    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);
    const finding = result.findings.find((f) => f.checkKey === 'config-validity')!;
    expect(finding.severity).toBe('ok');
  });

  it('reports critical for invalid config', async () => {
    await writeFile(join(testDir, 'config.yaml'), 'polling_interval: -1\n');

    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(testDir, 'config.yaml'),
    }));

    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);
    const finding = result.findings.find((f) => f.checkKey === 'config-validity')!;
    expect(finding.severity).toBe('critical');
    expect(finding.fixCommand).toBe('sparecrow config validate');
  });
});

describe('runDiagnostics — service-installation-state', () => {
  beforeEach(async () => {
    vi.resetModules();
    testDir = tmpDir();
    await mkdir(testDir, { recursive: true });
    await mkdir(join(testDir, 'logs'), { recursive: true });

    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(testDir, 'config.yaml'),
    }));

    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
  });

  it('reports warning for unsupported platform', async () => {
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({
        config: join(testDir, 'config.yaml'),
        data: testDir,
        logs: join(testDir, 'logs'),
      }),
      isLinux: () => false,
      isMacOS: () => false,
    }));

    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);
    const finding = result.findings.find((f) => f.checkKey === 'service-installation-state')!;
    expect(finding.severity).toBe('warning');
    expect(finding.fixCommand).toBe('sparecrow daemon start');
  });
});

describe('runDiagnostics — target-repo-accessibility', () => {
  beforeEach(async () => {
    vi.resetModules();
    testDir = tmpDir();
    await mkdir(testDir, { recursive: true });
    await mkdir(join(testDir, 'logs'), { recursive: true });

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({
        config: join(testDir, 'config.yaml'),
        data: testDir,
        logs: join(testDir, 'logs'),
      }),
      isLinux: () => false,
      isMacOS: () => false,
    }));

    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(testDir, 'config.yaml'),
    }));

    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
  });

  it('reports warning when no targets configured', async () => {
    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);
    const finding = result.findings.find((f) => f.checkKey === 'target-repo-accessibility')!;
    expect(finding.severity).toBe('warning');
    expect(finding.fixCommand).toContain('sparecrow queue add');
  });
});

describe('runDiagnostics — verbose mode', () => {
  beforeEach(async () => {
    vi.resetModules();
    testDir = tmpDir();
    await mkdir(testDir, { recursive: true });
    await mkdir(join(testDir, 'logs'), { recursive: true });

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({
        config: join(testDir, 'config.yaml'),
        data: testDir,
        logs: join(testDir, 'logs'),
      }),
      isLinux: () => false,
      isMacOS: () => false,
    }));

    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(testDir, 'config.yaml'),
    }));

    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
  });

  it('includes details for non-ok findings in verbose mode', async () => {
    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(true);

    const nonOkFindings = result.findings.filter((f) => f.severity !== 'ok');
    // At minimum some checks will fail in test env (no real credentials)
    expect(nonOkFindings.length).toBeGreaterThan(0);

    // At least some non-ok findings should have details in verbose mode
    const withDetails = nonOkFindings.filter((f) => f.details !== null);
    expect(withDetails.length).toBeGreaterThan(0);
  });

  it('includes timing for all findings in verbose mode', async () => {
    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(true);

    for (const finding of result.findings) {
      expect(finding.durationMs).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('runDiagnostics — config path fallback (getConfigPath returns undefined)', () => {
  // These tests exercise the nullish coalescing fallback: when getConfigPath() returns
  // undefined, the code must append 'config.yaml' to getPaths().config (a directory).

  beforeEach(async () => {
    vi.resetModules();
    testDir = tmpDir();
    await mkdir(testDir, { recursive: true });
    await mkdir(join(testDir, 'logs'), { recursive: true });

    // getPaths().config is a directory (as in production), NOT a file path
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({
        config: testDir,
        data: testDir,
        logs: join(testDir, 'logs'),
      }),
      isLinux: () => false,
      isMacOS: () => false,
    }));

    // getConfigPath() returns undefined — exercises the ?? fallback branch
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
    }));

    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
  });

  it('resolves config path to config.yaml inside the config directory when getConfigPath returns undefined', async () => {
    // Config file does not exist — checkConfigValidity should report ok (using defaults)
    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);
    const finding = result.findings.find((f) => f.checkKey === 'config-validity')!;
    // The check must succeed (file not found → ok with defaults), not fail with EISDIR
    expect(finding.severity).toBe('ok');
    expect(finding.message).toContain('defaults');
  });

  it('uses valid config file when getConfigPath is undefined and config.yaml exists in config directory', async () => {
    // Write a valid config file in testDir/config.yaml (testDir is the config directory)
    await writeFile(join(testDir, 'config.yaml'), 'polling_interval: 300\n');

    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);
    const finding = result.findings.find((f) => f.checkKey === 'config-validity')!;
    expect(finding.severity).toBe('ok');
    expect(finding.message).toContain('valid');
  });
});

describe('runDiagnostics — regression guard: loadConfig receives config.yaml path (not directory)', () => {
  // Regression guard (Finding 6): asserts loadConfig always receives a path ending in
  // 'config.yaml', not a bare directory. This prevents reintroduction of the EISDIR bug.

  beforeEach(async () => {
    vi.resetModules();
    testDir = tmpDir();
    await mkdir(testDir, { recursive: true });
    await mkdir(join(testDir, 'logs'), { recursive: true });

    // getPaths().config is a directory (as in production), NOT a file path
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({
        config: testDir,
        data: testDir,
        logs: join(testDir, 'logs'),
      }),
      isLinux: () => false,
      isMacOS: () => false,
    }));

    // getConfigPath() returns undefined — exercises the ?? fallback branch
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
    }));

    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
  });

  it('passes path ending in config.yaml to loadConfig when getConfigPath returns undefined', async () => {
    // Spy on loadConfig to assert it receives a path ending in 'config.yaml', not a directory
    const loadedPaths: string[] = [];
    vi.doMock('../../config/index.js', () => ({
      loadConfig: async (path: string) => {
        loadedPaths.push(path);
        // Simulate ENOENT to avoid real filesystem read
        const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        throw err;
      },
      resolveConfigFilePath: (configDir: string, override?: string | null) =>
        override ?? join(configDir, 'config.yaml'),
    }));

    const { runDiagnostics } = await import('./doctor-runner.js');
    await runDiagnostics(false);

    // At least one loadConfig call must have been made with a path ending in 'config.yaml'
    expect(loadedPaths.length).toBeGreaterThan(0);
    for (const p of loadedPaths) {
      expect(p).toMatch(/config\.yaml$/);
    }
  });
});

describe('runDiagnostics — config-validity verbose details', () => {
  // Tests that AC2 is met: verbose mode shows config file path when config is valid

  beforeEach(async () => {
    vi.resetModules();
    testDir = tmpDir();
    await mkdir(testDir, { recursive: true });
    await mkdir(join(testDir, 'logs'), { recursive: true });

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({
        config: testDir,
        data: testDir,
        logs: join(testDir, 'logs'),
      }),
      isLinux: () => false,
      isMacOS: () => false,
    }));

    // Re-register config/index.js to use the real module, clearing any mock factory
    // left by previous describe blocks that may have mocked it.
    const actualConfig =
      await vi.importActual<typeof import('../../config/index.js')>('../../config/index.js');
    vi.doMock('../../config/index.js', () => actualConfig);

    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
  });

  it('populates details with config file path in verbose mode when config is valid', async () => {
    await writeFile(join(testDir, 'config.yaml'), 'polling_interval: 300\n');

    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(testDir, 'config.yaml'),
    }));

    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(true);
    const finding = result.findings.find((f) => f.checkKey === 'config-validity')!;
    expect(finding.severity).toBe('ok');
    expect(finding.details).not.toBeNull();
    expect(finding.details).toContain('config.yaml');
  });

  it('details is null for config-validity when non-verbose and config is valid', async () => {
    await writeFile(join(testDir, 'config.yaml'), 'polling_interval: 300\n');

    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(testDir, 'config.yaml'),
    }));

    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);
    const finding = result.findings.find((f) => f.checkKey === 'config-validity')!;
    expect(finding.severity).toBe('ok');
    expect(finding.details).toBeNull();
  });
});

// ─── Task 7: Container doctor check tests ─────────────────────────────────────

describe('runDiagnostics — container checks with execution_backend: container', () => {
  beforeEach(async () => {
    vi.resetModules();
    testDir = tmpDir();
    await mkdir(testDir, { recursive: true });
    await mkdir(join(testDir, 'logs'), { recursive: true });

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({
        config: join(testDir, 'config.yaml'),
        data: testDir,
        logs: join(testDir, 'logs'),
      }),
      isLinux: () => false,
      isMacOS: () => false,
    }));

    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(testDir, 'config.yaml'),
    }));

    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
  });

  it('includes all 4 container checks and totalChecks is 12 when execution_backend: container (7.1)', async () => {
    await writeFile(join(testDir, 'config.yaml'), 'provider:\n  execution_backend: container\n');

    const mockRuntime = {
      name: 'docker',
      available: vi.fn().mockResolvedValue(true),
      info: vi.fn().mockResolvedValue({ version: '24.0.1', rootless: true }),
      run: vi.fn().mockResolvedValue({ containerId: 'test-123' }),
      wait: vi.fn().mockResolvedValue({ exitCode: 0, oomKilled: false }),
      logs: vi.fn().mockResolvedValue({ stdout: 'sparecrow-container-test\n', stderr: '' }),
      remove: vi.fn().mockResolvedValue(undefined),
      stats: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
    };

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue(mockRuntime),
    }));

    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);

    expect(result.findings).toHaveLength(13);
    expect(result.summary.totalChecks).toBe(13);

    const containerKeys = [
      'container-runtime-detection',
      'container-rootless-mode',
      'container-test-run',
      'container-credential-mount',
      'container-custom-image-claude',
    ];
    for (const key of containerKeys) {
      const finding = result.findings.find((f) => f.checkKey === key);
      expect(finding).toBeDefined();
    }
  });

  it('includes container checks when config file is missing because default is container (7.2)', async () => {
    // No config file → loadConfig falls back to defaults where execution_backend: 'container'
    // So isContainerBackendConfigured() returns true and container checks are included
    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);

    expect(result.findings).toHaveLength(13);
    expect(result.summary.totalChecks).toBe(13);

    const containerKeys = [
      'container-runtime-detection',
      'container-rootless-mode',
      'container-test-run',
      'container-credential-mount',
    ];
    for (const key of containerKeys) {
      const finding = result.findings.find((f) => f.checkKey === key);
      expect(finding).toBeDefined();
    }
  });

  it('checkContainerRuntimeDetection reports pass with version when runtime detected (7.3)', async () => {
    await writeFile(join(testDir, 'config.yaml'), 'provider:\n  execution_backend: container\n');

    const mockRuntime = {
      name: 'docker',
      available: vi.fn().mockResolvedValue(true),
      info: vi.fn().mockResolvedValue({ version: '24.0.1', rootless: true }),
      run: vi.fn().mockResolvedValue({ containerId: 'test-123' }),
      wait: vi.fn().mockResolvedValue({ exitCode: 0, oomKilled: false }),
      logs: vi.fn().mockResolvedValue({ stdout: 'sparecrow-container-test\n', stderr: '' }),
      remove: vi.fn().mockResolvedValue(undefined),
      stats: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
    };

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue(mockRuntime),
    }));

    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);
    const finding = result.findings.find((f) => f.checkKey === 'container-runtime-detection')!;

    expect(finding.status).toBe('pass');
    expect(finding.severity).toBe('ok');
    expect(finding.message).toContain('docker');
    expect(finding.message).toContain('24.0.1');
  });

  it('checkContainerRuntimeDetection reports fail when no runtime detected (7.4)', async () => {
    await writeFile(join(testDir, 'config.yaml'), 'provider:\n  execution_backend: container\n');

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue(null),
    }));

    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);
    const finding = result.findings.find((f) => f.checkKey === 'container-runtime-detection')!;

    expect(finding.status).toBe('fail');
    expect(finding.severity).toBe('critical');
    expect(finding.message).toContain('No container runtime detected');
    expect(finding.message).toContain('execution_backend: direct');
  });

  it('checkContainerRootlessMode reports pass when rootless is true (7.5)', async () => {
    await writeFile(join(testDir, 'config.yaml'), 'provider:\n  execution_backend: container\n');

    const mockRuntime = {
      name: 'docker',
      available: vi.fn().mockResolvedValue(true),
      info: vi.fn().mockResolvedValue({ version: '24.0.1', rootless: true }),
      run: vi.fn().mockResolvedValue({ containerId: 'test-123' }),
      wait: vi.fn().mockResolvedValue({ exitCode: 0, oomKilled: false }),
      logs: vi.fn().mockResolvedValue({ stdout: 'sparecrow-container-test\n', stderr: '' }),
      remove: vi.fn().mockResolvedValue(undefined),
      stats: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
    };

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue(mockRuntime),
    }));

    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);
    const finding = result.findings.find((f) => f.checkKey === 'container-rootless-mode')!;

    expect(finding.status).toBe('pass');
    expect(finding.message).toContain('rootless');
  });

  it('checkContainerRootlessMode reports warning when rootless is false (7.6)', async () => {
    await writeFile(join(testDir, 'config.yaml'), 'provider:\n  execution_backend: container\n');

    const mockRuntime = {
      name: 'docker',
      available: vi.fn().mockResolvedValue(true),
      info: vi.fn().mockResolvedValue({ version: '24.0.1', rootless: false }),
      run: vi.fn().mockResolvedValue({ containerId: 'test-123' }),
      wait: vi.fn().mockResolvedValue({ exitCode: 0, oomKilled: false }),
      logs: vi.fn().mockResolvedValue({ stdout: 'sparecrow-container-test\n', stderr: '' }),
      remove: vi.fn().mockResolvedValue(undefined),
      stats: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
    };

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue(mockRuntime),
    }));

    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);
    const finding = result.findings.find((f) => f.checkKey === 'container-rootless-mode')!;

    expect(finding.status).toBe('warn');
    expect(finding.severity).toBe('warning');
    expect(finding.message).toContain('root');
  });

  it('checkContainerRootlessMode reports warning when no runtime detected (7.7)', async () => {
    await writeFile(join(testDir, 'config.yaml'), 'provider:\n  execution_backend: container\n');

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue(null),
    }));

    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);
    const finding = result.findings.find((f) => f.checkKey === 'container-rootless-mode')!;

    expect(finding.status).toBe('warn');
    expect(finding.message).toContain('no runtime detected');
  });

  it('checkContainerTestRun reports pass when test succeeds (7.8)', async () => {
    await writeFile(join(testDir, 'config.yaml'), 'provider:\n  execution_backend: container\n');

    const mockRuntime = {
      name: 'docker',
      available: vi.fn().mockResolvedValue(true),
      info: vi.fn().mockResolvedValue({ version: '24.0.1', rootless: true }),
      run: vi.fn().mockResolvedValue({ containerId: 'test-123' }),
      wait: vi.fn().mockResolvedValue({ exitCode: 0, oomKilled: false }),
      logs: vi.fn().mockResolvedValue({ stdout: 'sparecrow-container-test\n', stderr: '' }),
      remove: vi.fn().mockResolvedValue(undefined),
      stats: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
    };

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue(mockRuntime),
    }));

    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);
    const finding = result.findings.find((f) => f.checkKey === 'container-test-run')!;

    expect(finding.status).toBe('pass');
    expect(finding.severity).toBe('ok');
  });

  it('checkContainerTestRun uses configured container image, not hardcoded node:lts-slim (7.8b)', async () => {
    // Verifies fix for AI-Review finding: doctor check must use configured image to be consistent
    // with `sparecrow container test` which also reads image from config.
    await writeFile(
      join(testDir, 'config.yaml'),
      'provider:\n  execution_backend: container\n  container:\n    image: "alpine:3.18"\n',
    );

    const mockRuntime = {
      name: 'docker',
      available: vi.fn().mockResolvedValue(true),
      info: vi.fn().mockResolvedValue({ version: '24.0.1', rootless: true }),
      run: vi.fn().mockResolvedValue({ containerId: 'test-123' }),
      wait: vi.fn().mockResolvedValue({ exitCode: 0, oomKilled: false }),
      logs: vi.fn().mockResolvedValue({ stdout: 'sparecrow-container-test\n', stderr: '' }),
      remove: vi.fn().mockResolvedValue(undefined),
      stats: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
    };

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue(mockRuntime),
    }));

    const { runDiagnostics } = await import('./doctor-runner.js');
    await runDiagnostics(false);

    expect(mockRuntime.run).toHaveBeenCalledWith(expect.objectContaining({ image: 'alpine:3.18' }));
  });

  it('checkContainerTestRun reports fail when exit code is non-zero (7.9)', async () => {
    await writeFile(join(testDir, 'config.yaml'), 'provider:\n  execution_backend: container\n');

    const mockRuntime = {
      name: 'docker',
      available: vi.fn().mockResolvedValue(true),
      info: vi.fn().mockResolvedValue({ version: '24.0.1', rootless: true }),
      run: vi.fn().mockResolvedValue({ containerId: 'test-123' }),
      wait: vi.fn().mockResolvedValue({ exitCode: 1, oomKilled: false }),
      logs: vi.fn().mockResolvedValue({ stdout: '', stderr: 'error occurred' }),
      remove: vi.fn().mockResolvedValue(undefined),
      stats: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
    };

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue(mockRuntime),
    }));

    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);
    const finding = result.findings.find((f) => f.checkKey === 'container-test-run')!;

    expect(finding.status).toBe('fail');
    expect(finding.severity).toBe('critical');
  });

  it('checkContainerTestRun reports fail gracefully when runtime.run() throws (7.10)', async () => {
    await writeFile(join(testDir, 'config.yaml'), 'provider:\n  execution_backend: container\n');

    const mockRuntime = {
      name: 'docker',
      available: vi.fn().mockResolvedValue(true),
      info: vi.fn().mockResolvedValue({ version: '24.0.1', rootless: true }),
      run: vi.fn().mockRejectedValue(new Error('image not found')),
      wait: vi.fn().mockResolvedValue({ exitCode: 0, oomKilled: false }),
      logs: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      remove: vi.fn().mockResolvedValue(undefined),
      stats: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
    };

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue(mockRuntime),
    }));

    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);
    const finding = result.findings.find((f) => f.checkKey === 'container-test-run')!;

    expect(finding.status).toBe('fail');
    expect(finding.severity).toBe('critical');
  });

  it('checkContainerTestRun always removes container in finally block (7.11)', async () => {
    await writeFile(join(testDir, 'config.yaml'), 'provider:\n  execution_backend: container\n');

    const mockRuntime = {
      name: 'docker',
      available: vi.fn().mockResolvedValue(true),
      info: vi.fn().mockResolvedValue({ version: '24.0.1', rootless: true }),
      run: vi.fn().mockResolvedValue({ containerId: 'cleanup-test-123' }),
      wait: vi.fn().mockRejectedValue(new Error('wait failed')),
      logs: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      remove: vi.fn().mockResolvedValue(undefined),
      stats: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
    };

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue(mockRuntime),
    }));

    const { runDiagnostics } = await import('./doctor-runner.js');
    await runDiagnostics(false);

    expect(mockRuntime.remove).toHaveBeenCalledWith('cleanup-test-123');
  });

  it('checkContainerCredentialMount reports pass when credentials readable (7.12)', async () => {
    await writeFile(join(testDir, 'config.yaml'), 'provider:\n  execution_backend: container\n');

    // Create mock credentials file
    await mkdir(join(testDir, '.claude'), { recursive: true });
    await writeFile(join(testDir, '.claude', '.credentials.json'), '{"accessToken":"test"}');

    vi.doMock('node:os', () => ({ homedir: () => testDir }));

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue({
        name: 'docker',
        available: vi.fn().mockResolvedValue(true),
        info: vi.fn().mockResolvedValue({ version: '24.0.1', rootless: true }),
        run: vi.fn().mockResolvedValue({ containerId: 'test-123' }),
        wait: vi.fn().mockResolvedValue({ exitCode: 0, oomKilled: false }),
        logs: vi.fn().mockResolvedValue({ stdout: 'sparecrow-container-test\n', stderr: '' }),
        remove: vi.fn().mockResolvedValue(undefined),
        stats: vi.fn().mockResolvedValue(null),
        list: vi.fn().mockResolvedValue([]),
      }),
    }));

    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);
    const finding = result.findings.find((f) => f.checkKey === 'container-credential-mount')!;

    expect(finding.status).toBe('pass');
    expect(finding.message).toContain('readable');
  });

  it('checkContainerCredentialMount reports warning when credentials not found (7.13)', async () => {
    await writeFile(join(testDir, 'config.yaml'), 'provider:\n  execution_backend: container\n');

    // No .claude directory → credentials missing
    vi.doMock('node:os', () => ({ homedir: () => testDir }));

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue({
        name: 'docker',
        available: vi.fn().mockResolvedValue(true),
        info: vi.fn().mockResolvedValue({ version: '24.0.1', rootless: true }),
        run: vi.fn().mockResolvedValue({ containerId: 'test-123' }),
        wait: vi.fn().mockResolvedValue({ exitCode: 0, oomKilled: false }),
        logs: vi.fn().mockResolvedValue({ stdout: 'sparecrow-container-test\n', stderr: '' }),
        remove: vi.fn().mockResolvedValue(undefined),
        stats: vi.fn().mockResolvedValue(null),
        list: vi.fn().mockResolvedValue([]),
      }),
    }));

    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);
    const finding = result.findings.find((f) => f.checkKey === 'container-credential-mount')!;

    expect(finding.status).toBe('warn');
    expect(finding.message).toContain('not found');
    expect(finding.fixCommand).toBe('claude auth login');
  });

  it('doctor JSON output includes container checks when configured (7.14)', async () => {
    await writeFile(join(testDir, 'config.yaml'), 'provider:\n  execution_backend: container\n');

    const mockRuntime = {
      name: 'docker',
      available: vi.fn().mockResolvedValue(true),
      info: vi.fn().mockResolvedValue({ version: '24.0.1', rootless: true }),
      run: vi.fn().mockResolvedValue({ containerId: 'test-123' }),
      wait: vi.fn().mockResolvedValue({ exitCode: 0, oomKilled: false }),
      logs: vi.fn().mockResolvedValue({ stdout: 'sparecrow-container-test\n', stderr: '' }),
      remove: vi.fn().mockResolvedValue(undefined),
      stats: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
    };

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue(mockRuntime),
    }));

    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);

    // All findings should have the standard shape
    for (const finding of result.findings) {
      expect(finding).toHaveProperty('checkKey');
      expect(finding).toHaveProperty('checkName');
      expect(finding).toHaveProperty('severity');
      expect(finding).toHaveProperty('status');
      expect(finding).toHaveProperty('message');
      expect(finding).toHaveProperty('fixCommand');
      expect(finding).toHaveProperty('durationMs');
      expect(finding).toHaveProperty('details');
    }
  });

  it('doctor summary counts include container check results (7.15)', async () => {
    await writeFile(join(testDir, 'config.yaml'), 'provider:\n  execution_backend: container\n');

    const mockRuntime = {
      name: 'docker',
      available: vi.fn().mockResolvedValue(true),
      info: vi.fn().mockResolvedValue({ version: '24.0.1', rootless: true }),
      run: vi.fn().mockResolvedValue({ containerId: 'test-123' }),
      wait: vi.fn().mockResolvedValue({ exitCode: 0, oomKilled: false }),
      logs: vi.fn().mockResolvedValue({ stdout: 'sparecrow-container-test\n', stderr: '' }),
      remove: vi.fn().mockResolvedValue(undefined),
      stats: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
    };

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue(mockRuntime),
    }));

    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);

    const { criticalCount, warningCount, okCount, totalChecks } = result.summary;
    expect(criticalCount + warningCount + okCount).toBe(totalChecks);
    expect(totalChecks).toBe(13);
  });

  // ─── Story 10.7: Custom image claude availability check ──────────────────

  it('reports ok for custom image check when default image is used (10.7 4.7a)', async () => {
    // Config with container backend but default image (no custom image override)
    await writeFile(
      join(testDir, 'config.yaml'),
      'provider:\n  execution_backend: container\n  container:\n    image: "node:lts-slim"\n',
    );

    const mockRuntime = {
      name: 'docker',
      available: vi.fn().mockResolvedValue(true),
      info: vi.fn().mockResolvedValue({ version: '24.0.1', rootless: true }),
      run: vi.fn().mockResolvedValue({ containerId: 'test-123' }),
      wait: vi.fn().mockResolvedValue({ exitCode: 0, oomKilled: false }),
      logs: vi.fn().mockResolvedValue({ stdout: 'sparecrow-container-test\n', stderr: '' }),
      remove: vi.fn().mockResolvedValue(undefined),
      stats: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
    };

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue(mockRuntime),
    }));

    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);

    const customImageFinding = result.findings.find(
      (f) => f.checkKey === 'container-custom-image-claude',
    );
    expect(customImageFinding).toBeDefined();
    expect(customImageFinding!.severity).toBe('ok');
    expect(customImageFinding!.status).toBe('pass');
    expect(customImageFinding!.message).toContain('Default image');
  });

  it('reports ok when custom image has claude available (10.7 4.7b)', async () => {
    await writeFile(
      join(testDir, 'config.yaml'),
      'provider:\n  execution_backend: container\n  container:\n    image: "ghcr.io/13rac1/openclaw-claude-code:latest"\n',
    );

    const mockRuntime = {
      name: 'docker',
      available: vi.fn().mockResolvedValue(true),
      info: vi.fn().mockResolvedValue({ version: '24.0.1', rootless: true }),
      run: vi.fn().mockImplementation((opts: { command: string[] }) => {
        // Return different container IDs for test-run vs claude-check
        if (opts.command[0] === 'claude') {
          return Promise.resolve({ containerId: 'claude-check-123' });
        }
        return Promise.resolve({ containerId: 'test-123' });
      }),
      wait: vi.fn().mockResolvedValue({ exitCode: 0, oomKilled: false }),
      logs: vi.fn().mockImplementation((id: string) => {
        if (id === 'claude-check-123') {
          return Promise.resolve({ stdout: '2.1.63\n', stderr: '' });
        }
        return Promise.resolve({ stdout: 'sparecrow-container-test\n', stderr: '' });
      }),
      remove: vi.fn().mockResolvedValue(undefined),
      stats: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
    };

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue(mockRuntime),
    }));

    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);

    const customImageFinding = result.findings.find(
      (f) => f.checkKey === 'container-custom-image-claude',
    );
    expect(customImageFinding).toBeDefined();
    expect(customImageFinding!.severity).toBe('ok');
    expect(customImageFinding!.status).toBe('pass');
    expect(customImageFinding!.message).toContain('Custom image has claude available');
  });

  it('reports warning when custom image does not have claude (10.7 4.7c)', async () => {
    await writeFile(
      join(testDir, 'config.yaml'),
      'provider:\n  execution_backend: container\n  container:\n    image: "my-minimal:latest"\n',
    );

    const mockRuntime = {
      name: 'docker',
      available: vi.fn().mockResolvedValue(true),
      info: vi.fn().mockResolvedValue({ version: '24.0.1', rootless: true }),
      run: vi.fn().mockResolvedValue({ containerId: 'test-123' }),
      wait: vi.fn().mockImplementation((_id: string) => {
        // Simulate different exit codes for different checks by tracking calls
        return Promise.resolve({ exitCode: 1, oomKilled: false });
      }),
      logs: vi.fn().mockResolvedValue({ stdout: '', stderr: 'claude: not found\n' }),
      remove: vi.fn().mockResolvedValue(undefined),
      stats: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
    };

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue(mockRuntime),
    }));

    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);

    const customImageFinding = result.findings.find(
      (f) => f.checkKey === 'container-custom-image-claude',
    );
    expect(customImageFinding).toBeDefined();
    expect(customImageFinding!.severity).toBe('warning');
    expect(customImageFinding!.status).toBe('warn');
    expect(customImageFinding!.message).toContain("does not have 'claude' in PATH");
    expect(customImageFinding!.fixCommand).toBe('mount_claude_binary: true');
  });

  it('reports warning when custom image check throws an error (10.7 4.7d)', async () => {
    await writeFile(
      join(testDir, 'config.yaml'),
      'provider:\n  execution_backend: container\n  container:\n    image: "nonexistent-image:latest"\n',
    );

    const mockRuntime = {
      name: 'docker',
      available: vi.fn().mockResolvedValue(true),
      info: vi.fn().mockResolvedValue({ version: '24.0.1', rootless: true }),
      run: vi.fn().mockImplementation((opts: { command: string[] }) => {
        if (opts.command[0] === 'claude') {
          return Promise.reject(new Error('Unable to pull image'));
        }
        return Promise.resolve({ containerId: 'test-123' });
      }),
      wait: vi.fn().mockResolvedValue({ exitCode: 0, oomKilled: false }),
      logs: vi.fn().mockResolvedValue({ stdout: 'sparecrow-container-test\n', stderr: '' }),
      remove: vi.fn().mockResolvedValue(undefined),
      stats: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
    };

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue(mockRuntime),
    }));

    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);

    const customImageFinding = result.findings.find(
      (f) => f.checkKey === 'container-custom-image-claude',
    );
    expect(customImageFinding).toBeDefined();
    expect(customImageFinding!.severity).toBe('warning');
    expect(customImageFinding!.status).toBe('warn');
    expect(customImageFinding!.message).toContain("does not have 'claude' in PATH");
  });

  // AI-Review finding 2 (High): when mount_claude_binary: true, doctor should skip
  // the claude-version probe and report pass — host binary will be mounted.
  it('skips custom image claude probe and reports pass when mount_claude_binary: true (10.7 AI-Review 2)', async () => {
    await writeFile(
      join(testDir, 'config.yaml'),
      'provider:\n  execution_backend: container\n  container:\n    image: "my-custom:latest"\n    mount_claude_binary: true\n',
    );

    const mockRuntime = {
      name: 'docker',
      available: vi.fn().mockResolvedValue(true),
      info: vi.fn().mockResolvedValue({ version: '24.0.1', rootless: true }),
      run: vi.fn().mockResolvedValue({ containerId: 'test-123' }),
      wait: vi.fn().mockResolvedValue({ exitCode: 0, oomKilled: false }),
      logs: vi.fn().mockResolvedValue({ stdout: 'sparecrow-container-test\n', stderr: '' }),
      remove: vi.fn().mockResolvedValue(undefined),
      stats: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
    };

    // Mock node:os so checkUsageEndpointConnectivity reads from testDir
    // (no .claude directory → no credentials → no real network call).
    vi.doMock('node:os', () => ({ homedir: () => testDir }));

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue(mockRuntime),
    }));

    const { runDiagnostics } = await import('./doctor-runner.js');
    const result = await runDiagnostics(false);

    const customImageFinding = result.findings.find(
      (f) => f.checkKey === 'container-custom-image-claude',
    );
    expect(customImageFinding).toBeDefined();
    // Host binary will be mounted — no need to probe the image for claude
    expect(customImageFinding!.severity).toBe('ok');
    expect(customImageFinding!.status).toBe('pass');
    expect(customImageFinding!.message).toContain('Host binary mount forced');
    // The probe (runtime.run) should only be called once — for checkTestRun, not twice
    // (no extra call for checkCustomImageClaude since it returns early)
    const runCalls = mockRuntime.run.mock.calls as Array<Array<{ command: string[] }>>;
    const claudeVersionCalls = runCalls.filter((call) => call[0]?.command?.[0] === 'claude');
    expect(claudeVersionCalls).toHaveLength(0);
  });
});
