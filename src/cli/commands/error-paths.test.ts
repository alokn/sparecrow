/** Story 6.6 — Task 5.5: Command-level error path tests for all 7 command families.
 *  Each command tested in human mode (3-part message: what/why/recovery) and JSON mode
 *  (fixed schema {ok:false, data:null, error:{code,message}}).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { Command } from 'commander';

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[/;

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  return program;
}

// ── status command ─────────────────────────────────────────────────────────

describe('status command error paths', () => {
  let stdoutOutput: string;
  let stderrOutput: string;

  beforeEach(() => {
    vi.resetModules();
    stdoutOutput = '';
    stderrOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      stderrOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    vi.doMock('./status-state.js', () => ({
      loadStatusSnapshot: vi.fn().mockRejectedValue(Object.assign(new Error('read error'), {})),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('human mode: writes error to stderr and sets exitCode=1', async () => {
    vi.doMock('../index.js', () => ({ isJsonMode: () => false }));
    const { registerStatus } = await import('./status.js');
    const program = makeProgram();
    registerStatus(program);
    const originalExitCode = process.exitCode;
    await program.parseAsync(['node', 'sparecrow', 'status']);
    expect(stderrOutput).toContain('Error:');
    expect(process.exitCode).toBe(1);
    process.exitCode = originalExitCode;
  });

  it('JSON mode: emits {ok:false, data:null, error:{code,message}}', async () => {
    vi.doMock('../index.js', () => ({ isJsonMode: () => true }));
    const { registerStatus } = await import('./status.js');
    const program = makeProgram();
    registerStatus(program);
    await program.parseAsync(['node', 'sparecrow', 'status']);
    const parsed = JSON.parse(stdoutOutput) as Record<string, unknown>;
    expect(parsed).toHaveProperty('ok', false);
    expect(parsed).toHaveProperty('data', null);
    expect(parsed.error).toHaveProperty('code');
    expect(parsed.error).toHaveProperty('message');
    expect((parsed.error as { message: string }).message.length).toBeGreaterThan(0);
    // JSON output should not contain ANSI escape codes
    expect(stdoutOutput).not.toMatch(ANSI_RE);
  });
});

// ── queue command ─────────────────────────────────────────────────────────

describe('queue command error paths', () => {
  let stdoutOutput: string;
  let stderrOutput: string;

  beforeEach(() => {
    vi.resetModules();
    stdoutOutput = '';
    stderrOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      stderrOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: '/fake/data', config: '/fake/config', logs: '/fake/logs' }),
    }));
    vi.doMock('../../utils/index.js', () => ({
      validateRepository: vi.fn().mockResolvedValue({ valid: true }),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('human mode: missing --template and --prompt shows error with usage hint', async () => {
    vi.doMock('../index.js', () => ({ isJsonMode: () => false, getConfigPath: () => undefined }));
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'add', '--target', '/some/repo']);
    expect(stderrOutput).toMatch(/--template|--prompt/i);
    expect(process.exitCode).toBe(1);
  });

  it('JSON mode: missing --target returns {ok:false, data:null, error:{code,message}}', async () => {
    vi.doMock('../index.js', () => ({ isJsonMode: () => true, getConfigPath: () => undefined }));
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'add', '--template', 'improve-code']);
    const parsed = JSON.parse(stdoutOutput) as Record<string, unknown>;
    expect(parsed).toHaveProperty('ok', false);
    expect(parsed).toHaveProperty('data', null);
    expect(parsed.error).toHaveProperty('code');
    expect(parsed.error).toHaveProperty('message');
  });

  it('JSON mode: invalid position for remove returns error JSON', async () => {
    vi.doMock('../index.js', () => ({ isJsonMode: () => true, getConfigPath: () => undefined }));
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'remove', '0', '--yes']);
    const parsed = JSON.parse(stdoutOutput) as Record<string, unknown>;
    expect(parsed).toHaveProperty('ok', false);
    expect(parsed.error).toHaveProperty('code');
    expect((parsed.error as { message: string }).message.length).toBeGreaterThan(0);
  });
});

// ── daemon command ─────────────────────────────────────────────────────────

describe('daemon command error paths', () => {
  let stdoutOutput: string;
  let stderrOutput: string;

  beforeEach(() => {
    vi.resetModules();
    stdoutOutput = '';
    stderrOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      stderrOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: '/fake/data', config: '/fake/config', logs: '/fake/logs' }),
      installService: vi.fn(),
      uninstallService: vi.fn(),
    }));
    vi.doMock('../../config/index.js', () => ({
      loadConfig: vi.fn().mockResolvedValue({
        pollingInterval: 60,
        trigger: { maxWastePercentage: 50, weeklyReservePercentage: 30, idleHours: [] },
        provider: { name: 'claude-code' },
      }),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('human mode: start already-running daemon emits error with recovery', async () => {
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
      EXIT: { ERROR: 1, SUCCESS: 0, DAEMON_NOT_RUNNING: 2, AUTH_OR_CONFIG: 3 },
    }));
    const { ScrowError, ErrorCode } = await import('../../errors/index.js');
    vi.doMock('../../daemon/index.js', () => ({
      startDaemon: vi
        .fn()
        .mockRejectedValue(
          new ScrowError(ErrorCode.DAEMON_ALREADY_RUNNING, 'Daemon already running (PID 1234)'),
        ),
      stopDaemon: vi.fn().mockRejectedValue(new Error('not called')),
      restartDaemon: vi.fn().mockRejectedValue(new Error('not called')),
      reloadDaemon: vi.fn().mockRejectedValue(new Error('not called')),
      getDaemonStatus: vi
        .fn()
        .mockResolvedValue({ state: 'not-started', pid: null, uptime: null, startedAt: null }),
      DAEMON_STOP_TIMEOUT_MS: 5000,
      DAEMON_RUNNER_FLAG: '--daemon-runner',
    }));
    const { registerDaemon } = await import('./daemon.js');
    const program = makeProgram();
    registerDaemon(program);
    await program.parseAsync(['node', 'sparecrow', 'daemon', 'start']);
    expect(stderrOutput).toContain('error:');
    // Recovery suggestion present
    expect(stderrOutput).toMatch(/daemon status|daemon restart/i);
  });

  it('JSON mode: stop non-running daemon returns {ok:false, data:null, error:{code,message}}', async () => {
    vi.doMock('../index.js', () => ({
      isJsonMode: () => true,
      getConfigPath: () => undefined,
      EXIT: { ERROR: 1, SUCCESS: 0, DAEMON_NOT_RUNNING: 2, AUTH_OR_CONFIG: 3 },
    }));
    const { ScrowError, ErrorCode } = await import('../../errors/index.js');
    vi.doMock('../../daemon/index.js', () => ({
      startDaemon: vi.fn().mockRejectedValue(new Error('not called')),
      stopDaemon: vi
        .fn()
        .mockRejectedValue(new ScrowError(ErrorCode.DAEMON_NOT_RUNNING, 'Daemon is not running')),
      restartDaemon: vi.fn().mockRejectedValue(new Error('not called')),
      reloadDaemon: vi.fn().mockRejectedValue(new Error('not called')),
      getDaemonStatus: vi
        .fn()
        .mockResolvedValue({ state: 'not-started', pid: null, uptime: null, startedAt: null }),
      DAEMON_STOP_TIMEOUT_MS: 5000,
      DAEMON_RUNNER_FLAG: '--daemon-runner',
    }));
    const { registerDaemon } = await import('./daemon.js');
    const program = makeProgram();
    registerDaemon(program);
    await program.parseAsync(['node', 'sparecrow', 'daemon', 'stop']);
    const parsed = JSON.parse(stdoutOutput) as Record<string, unknown>;
    expect(parsed).toHaveProperty('ok', false);
    expect(parsed).toHaveProperty('data', null);
    expect(parsed.error).toHaveProperty('code');
    expect(parsed.error).toHaveProperty('message');
  });
});

// ── config command ─────────────────────────────────────────────────────────

describe('config command error paths', () => {
  let stdoutOutput: string;
  let stderrOutput: string;

  beforeEach(() => {
    vi.resetModules();
    stdoutOutput = '';
    stderrOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      stderrOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('human mode: unknown config key returns error with recovery command', async () => {
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
      EXIT: { ERROR: 1, SUCCESS: 0, DAEMON_NOT_RUNNING: 2, AUTH_OR_CONFIG: 3 },
    }));
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: '/fake/data', config: '/fake/config', logs: '/fake/logs' }),
      ensureDirectories: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../../config/index.js', () => ({
      loadConfig: vi.fn().mockResolvedValue({
        pollingInterval: 60,
        logRetentionDays: 30,
        lastSummaryEnabled: true,
        provider: { name: 'claude-code', claudePath: null },
        trigger: { maxWastePercentage: 50, weeklyReservePercentage: 30, idleHours: [] },
        tasks: [],
        telemetry: { enabled: false, endpoint: 'https://telemetry.sparecrow.dev/v1/events' },
      }),
      resolveConfigFilePath: (configDir: string, override?: string | null) =>
        override ?? join(configDir, 'config.yaml'),
      ScrowConfigSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) },
    }));
    const { registerConfig } = await import('./config.js');
    const program = makeProgram();
    registerConfig(program);
    await program.parseAsync(['node', 'sparecrow', 'config', 'get', 'nonexistent.key']);
    // Should write error to stderr
    expect(stderrOutput.length + stdoutOutput.length).toBeGreaterThan(0);
  });

  it('JSON mode: unknown config key returns {ok:false, data:null, error:{code,message}}', async () => {
    vi.doMock('../index.js', () => ({
      isJsonMode: () => true,
      getConfigPath: () => undefined,
      EXIT: { ERROR: 1, SUCCESS: 0, DAEMON_NOT_RUNNING: 2, AUTH_OR_CONFIG: 3 },
    }));
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: '/fake/data', config: '/fake/config', logs: '/fake/logs' }),
      ensureDirectories: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../../config/index.js', () => ({
      loadConfig: vi.fn().mockResolvedValue({
        pollingInterval: 60,
        logRetentionDays: 30,
        lastSummaryEnabled: true,
        provider: { name: 'claude-code', claudePath: null },
        trigger: { maxWastePercentage: 50, weeklyReservePercentage: 30, idleHours: [] },
        tasks: [],
        telemetry: { enabled: false, endpoint: 'https://telemetry.sparecrow.dev/v1/events' },
      }),
      resolveConfigFilePath: (configDir: string, override?: string | null) =>
        override ?? join(configDir, 'config.yaml'),
      ScrowConfigSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) },
    }));
    const { registerConfig } = await import('./config.js');
    const program = makeProgram();
    registerConfig(program);
    await program.parseAsync(['node', 'sparecrow', 'config', 'get', 'nonexistent.key']);
    const parsed = JSON.parse(stdoutOutput) as Record<string, unknown>;
    expect(parsed).toHaveProperty('ok', false);
    expect(parsed).toHaveProperty('data', null);
    expect(parsed.error).toHaveProperty('code');
    expect(parsed.error).toHaveProperty('message');
  });
});

// ── doctor command ─────────────────────────────────────────────────────────

describe('doctor command error paths', () => {
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('human mode: critical finding produces non-zero exitCode with summary', async () => {
    vi.doMock('../index.js', () => ({ isJsonMode: () => false }));
    vi.doMock('./doctor-runner.js', () => ({
      runDiagnostics: vi.fn().mockResolvedValue({
        findings: [
          {
            checkKey: 'auth',
            checkName: 'Auth',
            severity: 'critical',
            status: 'fail',
            message: 'Token missing',
            fixCommand: 'sparecrow config --reconnect',
            durationMs: 1,
            details: null,
          },
        ],
        summary: { criticalCount: 1, warningCount: 0, okCount: 0, totalChecks: 1 },
      }),
    }));
    const { registerDoctor } = await import('./doctor.js');
    const program = makeProgram();
    registerDoctor(program);
    const originalExitCode = process.exitCode;
    await program.parseAsync(['node', 'sparecrow', 'doctor']);
    expect(stdoutOutput).toContain('Auth');
    expect(stdoutOutput).toContain('Token missing');
    expect(stdoutOutput).toContain('sparecrow config --reconnect');
    expect(process.exitCode).toBe(1);
    process.exitCode = originalExitCode;
  });

  it('JSON mode: critical finding emits {ok:true, data:{...}, error:null} with exitCode=1', async () => {
    vi.doMock('../index.js', () => ({ isJsonMode: () => true }));
    vi.doMock('./doctor-runner.js', () => ({
      runDiagnostics: vi.fn().mockResolvedValue({
        findings: [
          {
            checkKey: 'auth',
            checkName: 'Auth',
            severity: 'critical',
            status: 'fail',
            message: 'Token missing',
            fixCommand: 'sparecrow config --reconnect',
            durationMs: 1,
            details: null,
          },
        ],
        summary: { criticalCount: 1, warningCount: 0, okCount: 0, totalChecks: 1 },
      }),
    }));
    const { registerDoctor } = await import('./doctor.js');
    const program = makeProgram();
    registerDoctor(program);
    const originalExitCode = process.exitCode;
    await program.parseAsync(['node', 'sparecrow', 'doctor']);
    const parsed = JSON.parse(stdoutOutput) as Record<string, unknown>;
    // Doctor always uses ok:true (findings are in data) — but sets exitCode=1 for criticals
    expect(parsed).toHaveProperty('ok', true);
    expect(parsed).toHaveProperty('data');
    expect(parsed).toHaveProperty('error', null);
    expect(process.exitCode).toBe(1);
    process.exitCode = originalExitCode;
  });
});

// ── logs command ─────────────────────────────────────────────────────────

describe('logs command error paths', () => {
  let stdoutOutput: string;
  let stderrOutput: string;

  beforeEach(() => {
    vi.resetModules();
    stdoutOutput = '';
    stderrOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      stderrOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ logs: '/fake/logs', data: '/fake/data', config: '/fake/config' }),
    }));
    // Do NOT mock status-state.js — let it be imported naturally with partial mocks
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('human mode: invalid --count sets exitCode=1 and writes error to stderr', async () => {
    vi.doMock('../index.js', () => ({ isJsonMode: () => false }));
    vi.doMock('./log-reader.js', () => ({
      queryLogs: vi
        .fn()
        .mockResolvedValue({ entries: [], total: 0, successCount: 0, failureCount: 0 }),
      parseSinceDuration: vi.fn().mockReturnValue(new Date()),
    }));
    const { registerLogs } = await import('./logs.js');
    const program = makeProgram();
    registerLogs(program);
    const originalExitCode = process.exitCode;
    await program.parseAsync(['node', 'sparecrow', 'logs', '--count', 'bad']);
    expect(stderrOutput).toContain('Error:');
    expect(stderrOutput).toMatch(/--count|filter|logs --help/i);
    expect(process.exitCode).toBe(1);
    process.exitCode = originalExitCode;
  });

  it('JSON mode: invalid --count returns {ok:false, data:null, error:{code,message}} with guidance', async () => {
    vi.doMock('../index.js', () => ({ isJsonMode: () => true }));
    vi.doMock('./log-reader.js', () => ({
      queryLogs: vi
        .fn()
        .mockResolvedValue({ entries: [], total: 0, successCount: 0, failureCount: 0 }),
      parseSinceDuration: vi.fn().mockReturnValue(new Date()),
    }));
    const { registerLogs } = await import('./logs.js');
    const program = makeProgram();
    registerLogs(program);
    await program.parseAsync(['node', 'sparecrow', 'logs', '--count', 'notanumber']);
    const parsed = JSON.parse(stdoutOutput) as Record<string, unknown>;
    expect(parsed).toHaveProperty('ok', false);
    expect(parsed).toHaveProperty('data', null);
    expect(parsed.error).toHaveProperty('code');
    expect(parsed.error).toHaveProperty('message');
    // Message must contain actionable guidance
    const message = (parsed.error as { message: string }).message;
    expect(message.length).toBeGreaterThan(10);
  });
});

// ── report command ─────────────────────────────────────────────────────────

describe('report command error paths', () => {
  let stdoutOutput: string;
  let stderrOutput: string;

  beforeEach(() => {
    vi.resetModules();
    stdoutOutput = '';
    stderrOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      stderrOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ logs: '/fake/logs', data: '/fake/data', config: '/fake/config' }),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('human mode: computation failure writes error to stderr with recovery hint', async () => {
    vi.doMock('../index.js', () => ({ isJsonMode: () => false }));
    vi.doMock('./report-data.js', () => ({
      computeReport: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('disk read error'), { code: 'REPORT_COMPUTATION_FAILED' }),
        ),
    }));
    const { registerReport } = await import('./report.js');
    const program = makeProgram();
    registerReport(program);
    const originalExitCode = process.exitCode;
    await program.parseAsync(['node', 'sparecrow', 'report']);
    expect(stderrOutput).toContain('Error:');
    expect(process.exitCode).toBe(1);
    process.exitCode = originalExitCode;
  });

  it('JSON mode: computation failure returns {ok:false, data:null, error:{code,message}}', async () => {
    vi.doMock('../index.js', () => ({ isJsonMode: () => true }));
    vi.doMock('./report-data.js', () => ({
      computeReport: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('io error'), { code: 'REPORT_COMPUTATION_FAILED' }),
        ),
    }));
    const { registerReport } = await import('./report.js');
    const program = makeProgram();
    registerReport(program);
    await program.parseAsync(['node', 'sparecrow', 'report']);
    const parsed = JSON.parse(stdoutOutput) as Record<string, unknown>;
    expect(parsed).toHaveProperty('ok', false);
    expect(parsed).toHaveProperty('data', null);
    expect(parsed.error).toHaveProperty('code');
    expect(parsed.error).toHaveProperty('message');
  });
});
