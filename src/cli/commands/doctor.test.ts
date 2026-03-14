/** Unit tests for the doctor CLI command — human output, JSON mode, and verbose behavior. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  return program;
}

describe('registerDoctor — human output', () => {
  let stdoutOutput: string;

  beforeEach(() => {
    vi.resetModules();
    stdoutOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
    }));

    // Mock runDiagnostics to return controlled findings
    vi.doMock('./doctor-runner.js', () => ({
      runDiagnostics: vi.fn().mockResolvedValue({
        findings: [
          {
            checkKey: 'auth-token-validity',
            checkName: 'Auth Token Validity',
            severity: 'ok',
            status: 'pass',
            message: 'Auth token is valid.',
            fixCommand: null,
            durationMs: 5,
            details: null,
          },
          {
            checkKey: 'claude-installation',
            checkName: 'Claude Code Installation',
            severity: 'warning',
            status: 'warn',
            message: 'Claude Code CLI probe timed out.',
            fixCommand: 'Check system resources and retry',
            durationMs: 5000,
            details: null,
          },
          {
            checkKey: 'config-validity',
            checkName: 'Configuration Validity',
            severity: 'critical',
            status: 'fail',
            message: 'Configuration file is invalid.',
            fixCommand: 'sparecrow config validate',
            durationMs: 2,
            details: null,
          },
        ],
        summary: {
          criticalCount: 1,
          warningCount: 1,
          okCount: 1,
          totalChecks: 3,
        },
      }),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders severity indicators and finding messages', async () => {
    const { registerDoctor } = await import('./doctor.js');
    const program = makeProgram();
    registerDoctor(program);
    await program.parseAsync(['node', 'sparecrow', 'doctor']);

    expect(stdoutOutput).toContain('Auth Token Validity');
    expect(stdoutOutput).toContain('Auth token is valid.');
    expect(stdoutOutput).toContain('Claude Code Installation');
    expect(stdoutOutput).toContain('Configuration Validity');
  });

  it('renders fix commands for non-ok findings', async () => {
    const { registerDoctor } = await import('./doctor.js');
    const program = makeProgram();
    registerDoctor(program);
    await program.parseAsync(['node', 'sparecrow', 'doctor']);

    expect(stdoutOutput).toContain('Fix: sparecrow config validate');
    expect(stdoutOutput).toContain('Fix: Check system resources and retry');
  });

  it('renders summary counts', async () => {
    const { registerDoctor } = await import('./doctor.js');
    const program = makeProgram();
    registerDoctor(program);
    await program.parseAsync(['node', 'sparecrow', 'doctor']);

    expect(stdoutOutput).toContain('Summary');
    expect(stdoutOutput).toContain('1 critical');
    expect(stdoutOutput).toContain('1 warning');
    expect(stdoutOutput).toContain('1 ok');
    expect(stdoutOutput).toContain('3 checks');
  });

  it('renders fix-critical guidance when criticals present', async () => {
    const { registerDoctor } = await import('./doctor.js');
    const program = makeProgram();
    registerDoctor(program);
    await program.parseAsync(['node', 'sparecrow', 'doctor']);

    expect(stdoutOutput).toContain('Fix critical issues first');
  });

  it('sets exitCode 1 when critical findings exist', async () => {
    const { registerDoctor } = await import('./doctor.js');
    const program = makeProgram();
    registerDoctor(program);
    await program.parseAsync(['node', 'sparecrow', 'doctor']);

    expect(process.exitCode).toBe(1);
  });
});

describe('registerDoctor — all ok', () => {
  let stdoutOutput: string;

  beforeEach(() => {
    vi.resetModules();
    stdoutOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
    }));

    vi.doMock('./doctor-runner.js', () => ({
      runDiagnostics: vi.fn().mockResolvedValue({
        findings: [
          {
            checkKey: 'auth-token-validity',
            checkName: 'Auth Token Validity',
            severity: 'ok',
            status: 'pass',
            message: 'Auth token is valid.',
            fixCommand: null,
            durationMs: 2,
            details: null,
          },
        ],
        summary: {
          criticalCount: 0,
          warningCount: 0,
          okCount: 1,
          totalChecks: 1,
        },
      }),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('renders all-clear message when no issues', async () => {
    const { registerDoctor } = await import('./doctor.js');
    const program = makeProgram();
    registerDoctor(program);
    await program.parseAsync(['node', 'sparecrow', 'doctor']);

    expect(stdoutOutput).toContain('All checks passed');
  });

  it('does not set exitCode when all ok', async () => {
    process.exitCode = undefined;
    const { registerDoctor } = await import('./doctor.js');
    const program = makeProgram();
    registerDoctor(program);
    await program.parseAsync(['node', 'sparecrow', 'doctor']);

    expect(process.exitCode).toBeUndefined();
  });
});

describe('registerDoctor — JSON mode', () => {
  let stdoutOutput: string;

  beforeEach(() => {
    vi.resetModules();
    stdoutOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    vi.doMock('../index.js', () => ({
      isJsonMode: () => true,
      getConfigPath: () => undefined,
    }));

    vi.doMock('./doctor-runner.js', () => ({
      runDiagnostics: vi.fn().mockResolvedValue({
        findings: [
          {
            checkKey: 'auth-token-validity',
            checkName: 'Auth Token Validity',
            severity: 'critical',
            status: 'fail',
            message: 'No credentials found.',
            fixCommand: 'claude auth login',
            durationMs: 3,
            details: null,
          },
          {
            checkKey: 'config-validity',
            checkName: 'Configuration Validity',
            severity: 'ok',
            status: 'pass',
            message: 'Configuration is valid.',
            fixCommand: null,
            durationMs: 1,
            details: null,
          },
        ],
        summary: {
          criticalCount: 1,
          warningCount: 0,
          okCount: 1,
          totalChecks: 2,
        },
      }),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('outputs JSON with ok/data/error wrapper', async () => {
    const { registerDoctor } = await import('./doctor.js');
    const program = makeProgram();
    registerDoctor(program);
    await program.parseAsync(['node', 'sparecrow', 'doctor']);

    const parsed = JSON.parse(stdoutOutput) as Record<string, unknown>;
    expect(parsed).toHaveProperty('ok', true);
    expect(parsed).toHaveProperty('data');
    expect(parsed).toHaveProperty('error', null);
  });

  it('includes findings array and summary in data', async () => {
    const { registerDoctor } = await import('./doctor.js');
    const program = makeProgram();
    registerDoctor(program);
    await program.parseAsync(['node', 'sparecrow', 'doctor']);

    const parsed = JSON.parse(stdoutOutput) as {
      ok: boolean;
      data: { findings: unknown[]; summary: Record<string, number> };
    };
    expect(Array.isArray(parsed.data.findings)).toBe(true);
    expect(parsed.data.findings).toHaveLength(2);
    expect(parsed.data.summary).toEqual({
      criticalCount: 1,
      warningCount: 0,
      okCount: 1,
      totalChecks: 2,
    });
  });

  it('finding objects contain all deterministic fields', async () => {
    const { registerDoctor } = await import('./doctor.js');
    const program = makeProgram();
    registerDoctor(program);
    await program.parseAsync(['node', 'sparecrow', 'doctor']);

    const parsed = JSON.parse(stdoutOutput) as {
      data: { findings: Record<string, unknown>[] };
    };
    for (const finding of parsed.data.findings) {
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

  it('sets exitCode 1 when findings include non-ok', async () => {
    const { registerDoctor } = await import('./doctor.js');
    const program = makeProgram();
    registerDoctor(program);
    await program.parseAsync(['node', 'sparecrow', 'doctor']);

    expect(process.exitCode).toBe(1);
  });
});

describe('registerDoctor — verbose mode', () => {
  let stdoutOutput: string;

  beforeEach(() => {
    vi.resetModules();
    stdoutOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
    }));

    vi.doMock('./doctor-runner.js', () => ({
      runDiagnostics: vi.fn().mockResolvedValue({
        findings: [
          {
            checkKey: 'auth-token-validity',
            checkName: 'Auth Token Validity',
            severity: 'critical',
            status: 'fail',
            message: 'No credentials found.',
            fixCommand: 'claude auth login',
            durationMs: 5,
            details: 'Credentials file not found at ~/.claude/.credentials.json',
          },
        ],
        summary: {
          criticalCount: 1,
          warningCount: 0,
          okCount: 0,
          totalChecks: 1,
        },
      }),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('renders timing and details in verbose mode', async () => {
    const { registerDoctor } = await import('./doctor.js');
    const program = makeProgram();
    registerDoctor(program);
    await program.parseAsync(['node', 'sparecrow', 'doctor', '--verbose']);

    expect(stdoutOutput).toContain('5ms');
    expect(stdoutOutput).toContain('Details:');
    expect(stdoutOutput).toContain('Credentials file not found');
  });
});

describe('registerDoctor — redaction in JSON', () => {
  let stdoutOutput: string;

  beforeEach(() => {
    vi.resetModules();
    stdoutOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    vi.doMock('../index.js', () => ({
      isJsonMode: () => true,
      getConfigPath: () => undefined,
    }));

    vi.doMock('./doctor-runner.js', () => ({
      runDiagnostics: vi.fn().mockResolvedValue({
        findings: [
          {
            checkKey: 'auth-token-validity',
            checkName: 'Auth Token Validity',
            severity: 'ok',
            status: 'pass',
            message: 'Auth token is valid.',
            fixCommand: null,
            durationMs: 2,
            details: null,
          },
        ],
        summary: {
          criticalCount: 0,
          warningCount: 0,
          okCount: 1,
          totalChecks: 1,
        },
      }),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('JSON output never contains token-like strings', async () => {
    const { registerDoctor } = await import('./doctor.js');
    const program = makeProgram();
    registerDoctor(program);
    await program.parseAsync(['node', 'sparecrow', 'doctor']);

    expect(stdoutOutput).not.toMatch(/sk-ant-/);
    expect(stdoutOutput).not.toMatch(/Bearer\s+\S{20,}/);
  });
});

describe('registerDoctor — warnings only', () => {
  let stdoutOutput: string;

  beforeEach(() => {
    vi.resetModules();
    stdoutOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
    }));

    vi.doMock('./doctor-runner.js', () => ({
      runDiagnostics: vi.fn().mockResolvedValue({
        findings: [
          {
            checkKey: 'service-installation-state',
            checkName: 'Service Installation State',
            severity: 'warning',
            status: 'warn',
            message: 'Service file not installed.',
            fixCommand: 'sparecrow daemon install',
            durationMs: 1,
            details: null,
          },
        ],
        summary: {
          criticalCount: 0,
          warningCount: 1,
          okCount: 0,
          totalChecks: 1,
        },
      }),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('renders warning guidance when only warnings present', async () => {
    const { registerDoctor } = await import('./doctor.js');
    const program = makeProgram();
    registerDoctor(program);
    await program.parseAsync(['node', 'sparecrow', 'doctor']);

    expect(stdoutOutput).toContain('Address warnings');
  });
});
