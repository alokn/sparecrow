/** Unit tests for the onboard command — TTY gating, JSON mode, and wizard flow (Stories 5.1 + 5.2 + 5.3). */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

/** Default Story 5.2 stage mocks for tests where the wizard reaches trigger/template stages. */
function mockTriggerTemplateDefaults() {
  return {
    runTriggerStage: vi.fn().mockResolvedValue({
      triggerThresholdPercentage: 80,
      triggerTimeBeforeResetMinutes: 60,
      pollingInterval: 300,
    }),
    runTemplateStage: vi
      .fn()
      .mockResolvedValue(['security-audit', 'improve-code', 'fix-bugs', 'write-tests']),
    runPermissionConsentStage: vi.fn().mockResolvedValue(false),
    persistOnboardingConfig: vi.fn().mockResolvedValue(undefined),
    renderTemplateLoadError: vi.fn().mockReturnValue('TEMPLATE ERROR'),
    renderConfigPersistError: vi.fn().mockReturnValue('CONFIG PERSIST ERROR'),
  };
}

/** Default Story 5.3 stage mocks for tests where the wizard reaches repo/daemon stages. */
function mockRepoDaemonDefaults() {
  return {
    runRepoStage: vi.fn().mockResolvedValue({ targetPath: '/tmp/test-repo' }),
    runSummaryStage: vi.fn().mockResolvedValue('confirm'),
    runEditStageSelector: vi.fn().mockResolvedValue('done'),
    promptInstallDaemon: vi.fn().mockResolvedValue(false),
    seedQueue: vi.fn().mockResolvedValue({
      seeded: 2,
      skipped: 0,
      seededTemplates: ['improve-code', 'security-audit'],
    }),
    persistFullConfig: vi.fn().mockResolvedValue(undefined),
    installAndStartDaemon: vi.fn().mockResolvedValue({ healthy: true, pid: 1234 }),
    captureSnapshots: vi.fn().mockResolvedValue({
      configSnapshot: null,
      queueSnapshot: null,
      configPath: '/tmp/config.yaml',
      queuePath: '/tmp/queue.json',
    }),
    rollbackSnapshots: vi.fn().mockResolvedValue(true),
    cleanupServiceArtifacts: vi.fn().mockResolvedValue(undefined),
    detectExistingConfig: vi.fn().mockResolvedValue(false),
    promptReconfigure: vi.fn().mockResolvedValue('reconfigure'),
    renderFirstDispatchMessage: vi
      .fn()
      .mockReturnValue('Daemon monitoring. First task will dispatch when surplus detected.'),
    verifyDaemonHealth: vi.fn().mockResolvedValue({ healthy: true, pid: 1234 }),
  };
}

/** Default Story 12.3 container detection mock for tests where the wizard reaches container stage. */
function mockContainerDefaults() {
  return {
    runContainerDetectionStage: vi.fn().mockResolvedValue({
      containerRuntime: 'docker',
      containerRuntimeVersion: '24.0.1',
    }),
    autoSelectExecutionBackend: vi.fn().mockResolvedValue({
      containerRuntime: 'docker',
      containerRuntimeVersion: '24.0.1',
    }),
    runContainerValidationTest: vi.fn().mockResolvedValue({ success: true }),
  };
}

/** Helper to build a Commander program with exitOverride for test safety. */
function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  return program;
}

describe('registerOnboard() — JSON mode rejection (AC3)', () => {
  let stdoutOutput: string;

  beforeEach(() => {
    vi.resetModules();
    stdoutOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    vi.doMock('../index.js', () => ({
      isJsonMode: () => true,
      getConfigPath: () => undefined,
    }));
    vi.doMock('./onboard-auth.js', () => ({
      detectClaudeBinary: vi.fn(),
      validateAuth: vi.fn(),
      runAuthLogin: vi.fn(),
      persistClaudePath: vi.fn(),
      renderClaudeNotFoundError: vi.fn(),
      renderAuthSuccess: vi.fn(),
      renderAuthFailedError: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns JSON error object when --json is passed', async () => {
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard']);
    const parsed = JSON.parse(stdoutOutput) as {
      ok: boolean;
      data: unknown;
      error: { code: string; message: string } | null;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.data).toBeNull();
    expect(parsed.error).not.toBeNull();
    expect(parsed.error?.code).toBe('CONFIG_INVALID');
    expect(parsed.error?.message).toContain('interactive TTY');
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('does not contain accessToken or refreshToken in JSON output', async () => {
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard']);
    expect(stdoutOutput).not.toMatch(/accessToken|refreshToken|Bearer/i);
  });
});

describe('registerOnboard() — Non-TTY gating (AC2)', () => {
  let stdoutOutput: string;

  beforeEach(() => {
    vi.resetModules();
    stdoutOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
    }));
    vi.doMock('./onboard-auth.js', () => ({
      detectClaudeBinary: vi.fn(),
      validateAuth: vi.fn(),
      runAuthLogin: vi.fn(),
      persistClaudePath: vi.fn(),
      renderClaudeNotFoundError: vi.fn(),
      renderAuthSuccess: vi.fn(),
      renderAuthFailedError: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints actionable guidance when stdin is not a TTY', async () => {
    // In test env, process.stdin.isTTY is undefined/false
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard']);
    expect(stdoutOutput).toContain('interactive terminal');
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('does not mutate config on non-TTY path', async () => {
    const onboardAuthMock = {
      detectClaudeBinary: vi.fn(),
      validateAuth: vi.fn(),
      runAuthLogin: vi.fn(),
      persistClaudePath: vi.fn(),
      renderClaudeNotFoundError: vi.fn(),
      renderAuthSuccess: vi.fn(),
      renderAuthFailedError: vi.fn(),
    };
    vi.doMock('./onboard-auth.js', () => onboardAuthMock);
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard']);
    expect(onboardAuthMock.persistClaudePath).not.toHaveBeenCalled();
  });
});

describe('registerOnboard() — Missing Claude CLI (AC5)', () => {
  let stdoutOutput: string;

  beforeEach(() => {
    vi.resetModules();
    stdoutOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    // Simulate TTY
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
    }));
    vi.doMock('@clack/prompts', () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      confirm: vi.fn(),
      isCancel: vi.fn().mockReturnValue(false),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('./onboard-repository-daemon.js', () => mockRepoDaemonDefaults());
    vi.doMock('./onboard-container.js', () => mockContainerDefaults());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Reset TTY properties
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
  });

  it('shows error block and exits with 1 when Claude is not found', async () => {
    vi.doMock('./onboard-auth.js', () => ({
      detectClaudeBinary: vi
        .fn()
        .mockResolvedValue({ found: false, absolutePath: null, error: 'not found' }),
      validateAuth: vi.fn(),
      runAuthLogin: vi.fn(),
      persistClaudePath: vi.fn(),
      renderClaudeNotFoundError: vi
        .fn()
        .mockReturnValue(
          'ERROR: Claude Code CLI not found. Install from https://claude.ai/download',
        ),
      renderAuthSuccess: vi.fn(),
      renderAuthFailedError: vi.fn(),
    }));
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard']);
    expect(stdoutOutput).toContain('Claude Code CLI not found');
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('does not persist config when Claude is not found', async () => {
    const persistMock = vi.fn();
    vi.doMock('./onboard-auth.js', () => ({
      detectClaudeBinary: vi
        .fn()
        .mockResolvedValue({ found: false, absolutePath: null, error: 'not found' }),
      validateAuth: vi.fn(),
      runAuthLogin: vi.fn(),
      persistClaudePath: persistMock,
      renderClaudeNotFoundError: vi.fn().mockReturnValue('ERROR: Claude Code CLI not found.'),
      renderAuthSuccess: vi.fn(),
      renderAuthFailedError: vi.fn(),
    }));
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard']);
    expect(persistMock).not.toHaveBeenCalled();
  });
});

describe('registerOnboard() — Happy path (AC1, AC6, AC9, AC11)', () => {
  let stdoutOutput: string;

  beforeEach(() => {
    vi.resetModules();
    stdoutOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
  });

  it('exits with 0 and renders auth success on happy path', async () => {
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
    }));
    vi.doMock('@clack/prompts', () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      confirm: vi.fn(),
      isCancel: vi.fn().mockReturnValue(false),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('./onboard-auth.js', () => ({
      detectClaudeBinary: vi
        .fn()
        .mockResolvedValue({ found: true, absolutePath: '/usr/bin/claude', error: null }),
      validateAuth: vi.fn().mockResolvedValue({ valid: true, tier: 'pro' }),
      runAuthLogin: vi.fn(),
      persistClaudePath: vi.fn().mockResolvedValue(undefined),
      renderClaudeNotFoundError: vi.fn(),
      renderAuthSuccess: vi.fn().mockReturnValue('AUTH OK: pro'),
      renderAuthFailedError: vi.fn(),
      renderConfigSaveError: vi.fn(),
    }));
    vi.doMock('./onboard-trigger-template.js', () => mockTriggerTemplateDefaults());
    vi.doMock('./onboard-repository-daemon.js', () => mockRepoDaemonDefaults());
    vi.doMock('./onboard-container.js', () => mockContainerDefaults());
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard']);
    expect(stdoutOutput).toContain('AUTH OK: pro');
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('does not output token material on success path', async () => {
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
    }));
    vi.doMock('@clack/prompts', () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      confirm: vi.fn(),
      isCancel: vi.fn().mockReturnValue(false),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('./onboard-auth.js', () => ({
      detectClaudeBinary: vi
        .fn()
        .mockResolvedValue({ found: true, absolutePath: '/usr/bin/claude', error: null }),
      validateAuth: vi.fn().mockResolvedValue({ valid: true, tier: 'max20' }),
      runAuthLogin: vi.fn(),
      persistClaudePath: vi.fn().mockResolvedValue(undefined),
      renderClaudeNotFoundError: vi.fn(),
      renderAuthSuccess: vi.fn().mockReturnValue('AUTH OK: max20'),
      renderAuthFailedError: vi.fn(),
      renderConfigSaveError: vi.fn(),
    }));
    vi.doMock('./onboard-trigger-template.js', () => mockTriggerTemplateDefaults());
    vi.doMock('./onboard-repository-daemon.js', () => mockRepoDaemonDefaults());
    vi.doMock('./onboard-container.js', () => mockContainerDefaults());
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard']);
    expect(stdoutOutput).not.toMatch(/accessToken|refreshToken|Bearer/i);
  });
});

describe('registerOnboard() — init alias parity (AC1)', () => {
  let stdoutOutput: string;

  beforeEach(() => {
    vi.resetModules();
    stdoutOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
    }));
    vi.doMock('./onboard-auth.js', () => ({
      detectClaudeBinary: vi.fn(),
      validateAuth: vi.fn(),
      runAuthLogin: vi.fn(),
      persistClaudePath: vi.fn(),
      renderClaudeNotFoundError: vi.fn(),
      renderAuthSuccess: vi.fn(),
      renderAuthFailedError: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('init alias triggers same behavior as onboard (non-TTY exit)', async () => {
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'init']);
    expect(stdoutOutput).toContain('interactive terminal');
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});

describe('registerOnboard() — auth retry flow (AC7, AC8)', () => {
  let stdoutOutput: string;

  beforeEach(() => {
    vi.resetModules();
    stdoutOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
  });

  it('exits cleanly when user declines auth login prompt', async () => {
    vi.doMock('@clack/prompts', () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      confirm: vi.fn().mockResolvedValue(false),
      isCancel: vi.fn().mockReturnValue(false),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('./onboard-auth.js', () => ({
      detectClaudeBinary: vi
        .fn()
        .mockResolvedValue({ found: true, absolutePath: '/usr/bin/claude', error: null }),
      validateAuth: vi.fn().mockResolvedValue({ valid: false, tier: 'unknown' }),
      runAuthLogin: vi.fn(),
      persistClaudePath: vi.fn(),
      renderClaudeNotFoundError: vi.fn(),
      renderAuthSuccess: vi.fn(),
      renderAuthFailedError: vi.fn().mockReturnValue('AUTH FAILED'),
    }));
    vi.doMock('./onboard-repository-daemon.js', () => mockRepoDaemonDefaults());
    vi.doMock('./onboard-container.js', () => mockContainerDefaults());
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard']);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('exits cleanly when user cancels auth login prompt (isCancel)', async () => {
    const cancelSymbol = Symbol('cancel');
    vi.doMock('@clack/prompts', () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      confirm: vi.fn().mockResolvedValue(cancelSymbol),
      isCancel: vi.fn().mockReturnValue(true),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('./onboard-auth.js', () => ({
      detectClaudeBinary: vi
        .fn()
        .mockResolvedValue({ found: true, absolutePath: '/usr/bin/claude', error: null }),
      validateAuth: vi.fn().mockResolvedValue({ valid: false, tier: 'unknown' }),
      runAuthLogin: vi.fn(),
      persistClaudePath: vi.fn(),
      renderClaudeNotFoundError: vi.fn(),
      renderAuthSuccess: vi.fn(),
      renderAuthFailedError: vi.fn(),
    }));
    vi.doMock('./onboard-repository-daemon.js', () => mockRepoDaemonDefaults());
    vi.doMock('./onboard-container.js', () => mockContainerDefaults());
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard']);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('exits with 1 when auth re-check fails after successful login', async () => {
    vi.doMock('@clack/prompts', () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      confirm: vi.fn().mockResolvedValue(true),
      isCancel: vi.fn().mockReturnValue(false),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('./onboard-auth.js', () => ({
      detectClaudeBinary: vi
        .fn()
        .mockResolvedValue({ found: true, absolutePath: '/usr/bin/claude', error: null }),
      validateAuth: vi
        .fn()
        .mockResolvedValueOnce({ valid: false, tier: 'unknown' }) // initial check fails
        .mockResolvedValueOnce({ valid: false, tier: 'unknown' }), // re-check also fails
      runAuthLogin: vi.fn().mockResolvedValue(true),
      persistClaudePath: vi.fn(),
      renderClaudeNotFoundError: vi.fn(),
      renderAuthSuccess: vi.fn(),
      renderAuthFailedError: vi.fn().mockReturnValue('AUTH FAILED AFTER RETRY'),
    }));
    vi.doMock('./onboard-repository-daemon.js', () => mockRepoDaemonDefaults());
    vi.doMock('./onboard-container.js', () => mockContainerDefaults());
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard']);
    expect(stdoutOutput).toContain('AUTH FAILED AFTER RETRY');
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('exits with 1 and does not write config when login subprocess fails', async () => {
    const persistMock = vi.fn();
    vi.doMock('@clack/prompts', () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      confirm: vi.fn().mockResolvedValue(true),
      isCancel: vi.fn().mockReturnValue(false),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('./onboard-auth.js', () => ({
      detectClaudeBinary: vi
        .fn()
        .mockResolvedValue({ found: true, absolutePath: '/usr/bin/claude', error: null }),
      validateAuth: vi.fn().mockResolvedValue({ valid: false, tier: 'unknown' }),
      runAuthLogin: vi.fn().mockResolvedValue(false), // login subprocess fails
      persistClaudePath: persistMock,
      renderClaudeNotFoundError: vi.fn(),
      renderAuthSuccess: vi.fn(),
      renderAuthFailedError: vi.fn().mockReturnValue('AUTH FAILED'),
    }));
    vi.doMock('./onboard-repository-daemon.js', () => mockRepoDaemonDefaults());
    vi.doMock('./onboard-container.js', () => mockContainerDefaults());
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard']);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(persistMock).not.toHaveBeenCalled();
  });

  it('exits with 0 after successful retry (retry success)', async () => {
    vi.doMock('@clack/prompts', () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      confirm: vi.fn().mockResolvedValue(true),
      isCancel: vi.fn().mockReturnValue(false),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('./onboard-auth.js', () => ({
      detectClaudeBinary: vi
        .fn()
        .mockResolvedValue({ found: true, absolutePath: '/usr/bin/claude', error: null }),
      validateAuth: vi
        .fn()
        .mockResolvedValueOnce({ valid: false, tier: 'unknown' }) // initial check fails
        .mockResolvedValueOnce({ valid: true, tier: 'pro' }), // re-check succeeds
      runAuthLogin: vi.fn().mockResolvedValue(true),
      persistClaudePath: vi.fn().mockResolvedValue(undefined),
      renderClaudeNotFoundError: vi.fn(),
      renderAuthSuccess: vi.fn().mockReturnValue('AUTH OK: pro'),
      renderAuthFailedError: vi.fn(),
      renderConfigSaveError: vi.fn(),
    }));
    vi.doMock('./onboard-trigger-template.js', () => mockTriggerTemplateDefaults());
    vi.doMock('./onboard-repository-daemon.js', () => mockRepoDaemonDefaults());
    vi.doMock('./onboard-container.js', () => mockContainerDefaults());
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard']);
    expect(stdoutOutput).toContain('AUTH OK: pro');
    expect(process.exit).toHaveBeenCalledWith(0);
  });
});

describe('registerOnboard() — config persistence failure (AC9, AC10)', () => {
  let stdoutOutput: string;

  beforeEach(() => {
    vi.resetModules();
    stdoutOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
  });

  it('shows renderErrorBlock output and exits with 1 when persistClaudePath throws', async () => {
    vi.doMock('@clack/prompts', () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      confirm: vi.fn(),
      isCancel: vi.fn().mockReturnValue(false),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('./onboard-auth.js', () => ({
      detectClaudeBinary: vi
        .fn()
        .mockResolvedValue({ found: true, absolutePath: '/usr/bin/claude', error: null }),
      validateAuth: vi.fn().mockResolvedValue({ valid: true, tier: 'pro' }),
      runAuthLogin: vi.fn(),
      persistClaudePath: vi.fn().mockRejectedValue(new Error('EACCES: permission denied')),
      renderClaudeNotFoundError: vi.fn(),
      renderAuthSuccess: vi.fn().mockReturnValue('AUTH OK: pro'),
      renderAuthFailedError: vi.fn(),
      renderConfigSaveError: vi
        .fn()
        .mockReturnValue('ERROR: Failed to save configuration: EACCES: permission denied'),
    }));
    vi.doMock('./onboard-repository-daemon.js', () => mockRepoDaemonDefaults());
    vi.doMock('./onboard-container.js', () => mockContainerDefaults());
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard']);
    expect(stdoutOutput).toContain('Failed to save configuration');
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('does not output token material on config persistence failure path', async () => {
    vi.doMock('@clack/prompts', () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      confirm: vi.fn(),
      isCancel: vi.fn().mockReturnValue(false),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('./onboard-auth.js', () => ({
      detectClaudeBinary: vi
        .fn()
        .mockResolvedValue({ found: true, absolutePath: '/usr/bin/claude', error: null }),
      validateAuth: vi.fn().mockResolvedValue({ valid: true, tier: 'pro' }),
      runAuthLogin: vi.fn(),
      persistClaudePath: vi.fn().mockRejectedValue(new Error('disk full')),
      renderClaudeNotFoundError: vi.fn(),
      renderAuthSuccess: vi.fn().mockReturnValue('AUTH OK: pro'),
      renderAuthFailedError: vi.fn(),
      renderConfigSaveError: vi
        .fn()
        .mockReturnValue('ERROR: Failed to save configuration: disk full'),
    }));
    vi.doMock('./onboard-repository-daemon.js', () => mockRepoDaemonDefaults());
    vi.doMock('./onboard-container.js', () => mockContainerDefaults());
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard']);
    expect(stdoutOutput).not.toMatch(/accessToken|refreshToken|Bearer/i);
  });
});

describe('registerOnboard() — security: no credential material in output (AC10)', () => {
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
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not output token material in non-TTY failure path', async () => {
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard']);
    expect(stdoutOutput + stderrOutput).not.toMatch(/accessToken|refreshToken|Bearer/i);
  });
});

// ── Story 5.2 Tests ─────────────────────────────────────────────────

const cancelSymbol = Symbol('cancel');

function happyAuthMock() {
  return {
    detectClaudeBinary: vi
      .fn()
      .mockResolvedValue({ found: true, absolutePath: '/usr/bin/claude', error: null }),
    validateAuth: vi.fn().mockResolvedValue({ valid: true, tier: 'pro' }),
    runAuthLogin: vi.fn(),
    persistClaudePath: vi.fn().mockResolvedValue(undefined),
    renderClaudeNotFoundError: vi.fn(),
    renderAuthSuccess: vi.fn().mockReturnValue('AUTH OK: pro'),
    renderAuthFailedError: vi.fn(),
    renderConfigSaveError: vi.fn(),
  };
}

describe('registerOnboard() — Story 5.2: trigger cancellation', () => {
  let stdoutOutput: string;

  beforeEach(() => {
    vi.resetModules();
    stdoutOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
  });

  it('exits with 1 when user cancels at trigger stage', async () => {
    vi.doMock('@clack/prompts', () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      confirm: vi.fn(),
      isCancel: vi.fn((v: unknown) => v === cancelSymbol),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('./onboard-auth.js', () => happyAuthMock());
    vi.doMock('./onboard-trigger-template.js', () => ({
      ...mockTriggerTemplateDefaults(),
      runTriggerStage: vi.fn().mockResolvedValue(cancelSymbol),
    }));
    vi.doMock('./onboard-repository-daemon.js', () => mockRepoDaemonDefaults());
    vi.doMock('./onboard-container.js', () => mockContainerDefaults());
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard']);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('does not persist config when trigger is cancelled', async () => {
    const triggerTemplateMock = {
      ...mockTriggerTemplateDefaults(),
      runTriggerStage: vi.fn().mockResolvedValue(cancelSymbol),
    };
    vi.doMock('@clack/prompts', () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      confirm: vi.fn(),
      isCancel: vi.fn((v: unknown) => v === cancelSymbol),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('./onboard-auth.js', () => happyAuthMock());
    vi.doMock('./onboard-trigger-template.js', () => triggerTemplateMock);
    vi.doMock('./onboard-repository-daemon.js', () => mockRepoDaemonDefaults());
    vi.doMock('./onboard-container.js', () => mockContainerDefaults());
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard']);
    expect(triggerTemplateMock.persistOnboardingConfig).not.toHaveBeenCalled();
  });
});

describe('registerOnboard() — Story 5.2: template cancellation and failure', () => {
  let stdoutOutput: string;

  beforeEach(() => {
    vi.resetModules();
    stdoutOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
  });

  it('exits with 1 when template loading fails', async () => {
    vi.doMock('@clack/prompts', () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      confirm: vi.fn(),
      isCancel: vi.fn().mockReturnValue(false),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('./onboard-auth.js', () => happyAuthMock());
    vi.doMock('./onboard-trigger-template.js', () => ({
      ...mockTriggerTemplateDefaults(),
      runTemplateStage: vi.fn().mockRejectedValue(new Error('built-in template file not found')),
      renderTemplateLoadError: vi.fn().mockReturnValue('TEMPLATE LOAD ERR'),
      renderConfigPersistError: vi.fn(),
    }));
    vi.doMock('./onboard-repository-daemon.js', () => mockRepoDaemonDefaults());
    vi.doMock('./onboard-container.js', () => mockContainerDefaults());
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard']);
    expect(stdoutOutput).toContain('TEMPLATE LOAD ERR');
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('exits with 1 when user cancels at template stage', async () => {
    vi.doMock('@clack/prompts', () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      confirm: vi.fn(),
      isCancel: vi.fn((v: unknown) => v === cancelSymbol),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('./onboard-auth.js', () => happyAuthMock());
    vi.doMock('./onboard-trigger-template.js', () => ({
      ...mockTriggerTemplateDefaults(),
      runTemplateStage: vi.fn().mockResolvedValue(cancelSymbol),
    }));
    vi.doMock('./onboard-repository-daemon.js', () => mockRepoDaemonDefaults());
    vi.doMock('./onboard-container.js', () => mockContainerDefaults());
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard']);
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});

describe('registerOnboard() — Story 5.2: permission consent cancellation', () => {
  let stdoutOutput: string;

  beforeEach(() => {
    vi.resetModules();
    stdoutOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
  });

  it('exits with 1 when user cancels at permission consent', async () => {
    vi.doMock('@clack/prompts', () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      confirm: vi.fn(),
      isCancel: vi.fn((v: unknown) => v === cancelSymbol),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('./onboard-auth.js', () => happyAuthMock());
    vi.doMock('./onboard-trigger-template.js', () => ({
      ...mockTriggerTemplateDefaults(),
      runPermissionConsentStage: vi.fn().mockResolvedValue(cancelSymbol),
    }));
    vi.doMock('./onboard-repository-daemon.js', () => mockRepoDaemonDefaults());
    vi.doMock('./onboard-container.js', () => mockContainerDefaults());
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard']);
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});

describe('registerOnboard() — Story 5.2: config persistence failure', () => {
  let stdoutOutput: string;

  beforeEach(() => {
    vi.resetModules();
    stdoutOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
  });

  it('exits with 1 when apply-phase config persistence fails and rolls back', async () => {
    const repoDaemonMock = {
      ...mockRepoDaemonDefaults(),
      persistFullConfig: vi.fn().mockRejectedValue(new Error('write failed')),
    };
    vi.doMock('@clack/prompts', () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      confirm: vi.fn(),
      isCancel: vi.fn().mockReturnValue(false),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('./onboard-auth.js', () => happyAuthMock());
    vi.doMock('./onboard-trigger-template.js', () => mockTriggerTemplateDefaults());
    vi.doMock('./onboard-repository-daemon.js', () => repoDaemonMock);
    vi.doMock('./onboard-container.js', () => mockContainerDefaults());
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard']);
    expect(stdoutOutput).toContain('write failed');
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(repoDaemonMock.rollbackSnapshots).toHaveBeenCalledTimes(1);
  });
});

describe('registerOnboard() — Story 5.2+5.3: full flow success', () => {
  let stdoutOutput: string;

  beforeEach(() => {
    vi.resetModules();
    stdoutOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
  });

  it('runs full flow (auth + trigger + template + repo + summary) and exits 0', async () => {
    const repoDaemonMock = mockRepoDaemonDefaults();
    vi.doMock('@clack/prompts', () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      confirm: vi.fn(),
      isCancel: vi.fn().mockReturnValue(false),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('./onboard-auth.js', () => happyAuthMock());
    vi.doMock('./onboard-trigger-template.js', () => mockTriggerTemplateDefaults());
    vi.doMock('./onboard-repository-daemon.js', () => repoDaemonMock);
    vi.doMock('./onboard-container.js', () => mockContainerDefaults());
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard']);
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(repoDaemonMock.runRepoStage).toHaveBeenCalledTimes(1);
    expect(repoDaemonMock.runSummaryStage).toHaveBeenCalledTimes(1);
    expect(repoDaemonMock.persistFullConfig).toHaveBeenCalledTimes(1);
    expect(repoDaemonMock.seedQueue).toHaveBeenCalledTimes(1);
  });

  it('passes consent=true through to persistFullConfig', async () => {
    const repoDaemonMock = mockRepoDaemonDefaults();
    vi.doMock('@clack/prompts', () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      confirm: vi.fn(),
      isCancel: vi.fn().mockReturnValue(false),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('./onboard-auth.js', () => happyAuthMock());
    vi.doMock('./onboard-trigger-template.js', () => ({
      ...mockTriggerTemplateDefaults(),
      runPermissionConsentStage: vi.fn().mockResolvedValue(true),
    }));
    vi.doMock('./onboard-repository-daemon.js', () => repoDaemonMock);
    vi.doMock('./onboard-container.js', () => mockContainerDefaults());
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard']);
    expect(repoDaemonMock.persistFullConfig).toHaveBeenCalledWith(
      expect.objectContaining({ allowDangerouslySkipPermissions: true }),
      '/tmp/test-repo',
    );
    expect(process.exit).toHaveBeenCalledWith(0);
  });
});

describe('registerOnboard() — Story 5.3: boundary enforcement', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
  });

  it('does not invoke daemon install when --install-daemon is not passed', async () => {
    const repoDaemonMock = mockRepoDaemonDefaults();
    vi.doMock('@clack/prompts', () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      confirm: vi.fn(),
      isCancel: vi.fn().mockReturnValue(false),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('./onboard-auth.js', () => happyAuthMock());
    vi.doMock('./onboard-trigger-template.js', () => mockTriggerTemplateDefaults());
    vi.doMock('./onboard-repository-daemon.js', () => repoDaemonMock);
    vi.doMock('./onboard-container.js', () => mockContainerDefaults());
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard']);
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(repoDaemonMock.installAndStartDaemon).not.toHaveBeenCalled();
  });

  it('invokes repo stage, summary, and queue seeding in order', async () => {
    const repoDaemonMock = mockRepoDaemonDefaults();
    vi.doMock('@clack/prompts', () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      confirm: vi.fn(),
      isCancel: vi.fn().mockReturnValue(false),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('./onboard-auth.js', () => happyAuthMock());
    vi.doMock('./onboard-trigger-template.js', () => mockTriggerTemplateDefaults());
    vi.doMock('./onboard-repository-daemon.js', () => repoDaemonMock);
    vi.doMock('./onboard-container.js', () => mockContainerDefaults());
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard']);
    expect(repoDaemonMock.runRepoStage).toHaveBeenCalledTimes(1);
    expect(repoDaemonMock.runSummaryStage).toHaveBeenCalledTimes(1);
    expect(repoDaemonMock.captureSnapshots).toHaveBeenCalledTimes(1);
    expect(repoDaemonMock.persistFullConfig).toHaveBeenCalledTimes(1);
    expect(repoDaemonMock.seedQueue).toHaveBeenCalledWith(
      ['security-audit', 'improve-code', 'fix-bugs', 'write-tests'],
      '/tmp/test-repo',
    );
  });

  it('exits with 1 when repo stage is cancelled', async () => {
    const repoDaemonMock = {
      ...mockRepoDaemonDefaults(),
      runRepoStage: vi.fn().mockResolvedValue(cancelSymbol),
    };
    vi.doMock('@clack/prompts', () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      confirm: vi.fn(),
      isCancel: vi.fn((v: unknown) => v === cancelSymbol),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('./onboard-auth.js', () => happyAuthMock());
    vi.doMock('./onboard-trigger-template.js', () => mockTriggerTemplateDefaults());
    vi.doMock('./onboard-repository-daemon.js', () => repoDaemonMock);
    vi.doMock('./onboard-container.js', () => mockContainerDefaults());
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard']);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(repoDaemonMock.persistFullConfig).not.toHaveBeenCalled();
  });

  it('exits with 1 when summary is cancelled', async () => {
    const repoDaemonMock = {
      ...mockRepoDaemonDefaults(),
      runSummaryStage: vi.fn().mockResolvedValue(cancelSymbol),
    };
    vi.doMock('@clack/prompts', () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      confirm: vi.fn(),
      isCancel: vi.fn((v: unknown) => v === cancelSymbol),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('./onboard-auth.js', () => happyAuthMock());
    vi.doMock('./onboard-trigger-template.js', () => mockTriggerTemplateDefaults());
    vi.doMock('./onboard-repository-daemon.js', () => repoDaemonMock);
    vi.doMock('./onboard-container.js', () => mockContainerDefaults());
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard']);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(repoDaemonMock.persistFullConfig).not.toHaveBeenCalled();
  });
});

describe('registerOnboard() — Story 5.3: existing config detection (AC8)', () => {
  let stdoutOutput: string;

  beforeEach(() => {
    vi.resetModules();
    stdoutOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
  });

  it('exits with 0 when user chooses exit on existing config', async () => {
    const repoDaemonMock = {
      ...mockRepoDaemonDefaults(),
      detectExistingConfig: vi.fn().mockResolvedValue(true),
      promptReconfigure: vi.fn().mockResolvedValue('exit'),
    };
    vi.doMock('@clack/prompts', () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      confirm: vi.fn(),
      isCancel: vi.fn().mockReturnValue(false),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
      select: vi.fn(),
    }));
    vi.doMock('./onboard-auth.js', () => happyAuthMock());
    vi.doMock('./onboard-trigger-template.js', () => mockTriggerTemplateDefaults());
    vi.doMock('./onboard-repository-daemon.js', () => repoDaemonMock);
    vi.doMock('./onboard-container.js', () => mockContainerDefaults());
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard']);
    expect(process.exit).toHaveBeenCalledWith(0);
    // Auth should NOT have been invoked since we exit early
    expect(repoDaemonMock.persistFullConfig).not.toHaveBeenCalled();
  });
});

describe('registerOnboard() — Story 12.3: container stage cancellation (H2)', () => {
  let stdoutOutput: string;

  beforeEach(() => {
    vi.resetModules();
    stdoutOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
  });

  it('exits with 1 when container detection stage is cancelled', async () => {
    const containerCancelSymbol = Symbol('cancel');
    vi.doMock('@clack/prompts', () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      confirm: vi.fn(),
      isCancel: vi.fn((v: unknown) => v === containerCancelSymbol),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('./onboard-auth.js', () => happyAuthMock());
    vi.doMock('./onboard-trigger-template.js', () => mockTriggerTemplateDefaults());
    vi.doMock('./onboard-repository-daemon.js', () => mockRepoDaemonDefaults());
    vi.doMock('./onboard-container.js', () => ({
      ...mockContainerDefaults(),
      runContainerDetectionStage: vi.fn().mockResolvedValue(containerCancelSymbol),
    }));
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard']);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('does not persist config when container stage is cancelled', async () => {
    const containerCancelSymbol = Symbol('cancel');
    const repoDaemonMock = mockRepoDaemonDefaults();
    vi.doMock('@clack/prompts', () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      confirm: vi.fn(),
      isCancel: vi.fn((v: unknown) => v === containerCancelSymbol),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('./onboard-auth.js', () => happyAuthMock());
    vi.doMock('./onboard-trigger-template.js', () => mockTriggerTemplateDefaults());
    vi.doMock('./onboard-repository-daemon.js', () => repoDaemonMock);
    vi.doMock('./onboard-container.js', () => ({
      ...mockContainerDefaults(),
      runContainerDetectionStage: vi.fn().mockResolvedValue(containerCancelSymbol),
    }));
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard']);
    expect(repoDaemonMock.persistFullConfig).not.toHaveBeenCalled();
  });
});

describe('registerOnboard() — Story 10-13: backend edit stage removed', () => {
  let stdoutOutput: string;

  beforeEach(() => {
    vi.resetModules();
    stdoutOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
  });

  it('passes containerRuntime to persistFullConfig from container detection result', async () => {
    const containerResult = {
      containerRuntime: 'docker' as const,
      containerRuntimeVersion: '24.0.1',
    };

    const repoDaemonMock = {
      ...mockRepoDaemonDefaults(),
      runSummaryStage: vi.fn().mockResolvedValue('confirm'),
    };

    vi.doMock('@clack/prompts', () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      confirm: vi.fn(),
      isCancel: vi.fn().mockReturnValue(false),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('./onboard-auth.js', () => happyAuthMock());
    vi.doMock('./onboard-trigger-template.js', () => mockTriggerTemplateDefaults());
    vi.doMock('./onboard-repository-daemon.js', () => repoDaemonMock);
    vi.doMock('./onboard-container.js', () => ({
      ...mockContainerDefaults(),
      runContainerDetectionStage: vi.fn().mockResolvedValue(containerResult),
    }));
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard']);
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(repoDaemonMock.persistFullConfig).toHaveBeenCalledWith(
      expect.objectContaining({ containerRuntime: 'docker' }),
      expect.any(String),
    );
  });
});

describe('registerOnboard() — Story 5.3: daemon install path (H2)', () => {
  let stdoutOutput: string;

  beforeEach(() => {
    vi.resetModules();
    stdoutOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
  });

  it('installs daemon and exits 0 when --install-daemon is passed', async () => {
    const repoDaemonMock = {
      ...mockRepoDaemonDefaults(),
      installAndStartDaemon: vi.fn().mockResolvedValue({ healthy: true, pid: 9999 }),
    };
    vi.doMock('@clack/prompts', () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      confirm: vi.fn(),
      isCancel: vi.fn().mockReturnValue(false),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('./onboard-auth.js', () => happyAuthMock());
    vi.doMock('./onboard-trigger-template.js', () => mockTriggerTemplateDefaults());
    vi.doMock('./onboard-repository-daemon.js', () => repoDaemonMock);
    vi.doMock('./onboard-container.js', () => mockContainerDefaults());
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard', '--install-daemon']);
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(repoDaemonMock.installAndStartDaemon).toHaveBeenCalledTimes(1);
  });

  it('exits 1 when daemon health verification fails after install', async () => {
    const repoDaemonMock = {
      ...mockRepoDaemonDefaults(),
      installAndStartDaemon: vi.fn().mockResolvedValue({ healthy: false, pid: null }),
      rollbackSnapshots: vi.fn().mockResolvedValue(true),
      cleanupServiceArtifacts: vi.fn().mockResolvedValue(undefined),
    };
    vi.doMock('@clack/prompts', () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      confirm: vi.fn(),
      isCancel: vi.fn().mockReturnValue(false),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('./onboard-auth.js', () => happyAuthMock());
    vi.doMock('./onboard-trigger-template.js', () => mockTriggerTemplateDefaults());
    vi.doMock('./onboard-repository-daemon.js', () => repoDaemonMock);
    vi.doMock('./onboard-container.js', () => mockContainerDefaults());
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard', '--install-daemon']);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(repoDaemonMock.cleanupServiceArtifacts).toHaveBeenCalledTimes(1);
  });

  it('shows warning when rollback fails during apply phase error', async () => {
    const repoDaemonMock = {
      ...mockRepoDaemonDefaults(),
      persistFullConfig: vi.fn().mockRejectedValue(new Error('disk full')),
      rollbackSnapshots: vi.fn().mockResolvedValue(false),
      cleanupServiceArtifacts: vi.fn().mockResolvedValue(undefined),
    };
    vi.doMock('@clack/prompts', () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      confirm: vi.fn(),
      isCancel: vi.fn().mockReturnValue(false),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('./onboard-auth.js', () => happyAuthMock());
    vi.doMock('./onboard-trigger-template.js', () => mockTriggerTemplateDefaults());
    vi.doMock('./onboard-repository-daemon.js', () => repoDaemonMock);
    vi.doMock('./onboard-container.js', () => mockContainerDefaults());
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard']);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(stdoutOutput).toContain('Could not fully restore prior state');
  });

  it('calls cleanupServiceArtifacts when wantInstallDaemon is true and apply fails', async () => {
    const repoDaemonMock = {
      ...mockRepoDaemonDefaults(),
      persistFullConfig: vi.fn().mockRejectedValue(new Error('write error')),
      rollbackSnapshots: vi.fn().mockResolvedValue(true),
      cleanupServiceArtifacts: vi.fn().mockResolvedValue(undefined),
    };
    vi.doMock('@clack/prompts', () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      confirm: vi.fn(),
      isCancel: vi.fn().mockReturnValue(false),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('./onboard-auth.js', () => happyAuthMock());
    vi.doMock('./onboard-trigger-template.js', () => mockTriggerTemplateDefaults());
    vi.doMock('./onboard-repository-daemon.js', () => repoDaemonMock);
    vi.doMock('./onboard-container.js', () => mockContainerDefaults());
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard', '--install-daemon']);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(repoDaemonMock.cleanupServiceArtifacts).toHaveBeenCalledTimes(1);
  });

  it('exits 1 when installAndStartDaemon throws during install', async () => {
    const repoDaemonMock = {
      ...mockRepoDaemonDefaults(),
      installAndStartDaemon: vi.fn().mockRejectedValue(new Error('systemd failure')),
      rollbackSnapshots: vi.fn().mockResolvedValue(true),
      cleanupServiceArtifacts: vi.fn().mockResolvedValue(undefined),
    };
    vi.doMock('@clack/prompts', () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      confirm: vi.fn(),
      isCancel: vi.fn().mockReturnValue(false),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('./onboard-auth.js', () => happyAuthMock());
    vi.doMock('./onboard-trigger-template.js', () => mockTriggerTemplateDefaults());
    vi.doMock('./onboard-repository-daemon.js', () => repoDaemonMock);
    vi.doMock('./onboard-container.js', () => mockContainerDefaults());
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard', '--install-daemon']);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(stdoutOutput).toContain('systemd failure');
    expect(repoDaemonMock.cleanupServiceArtifacts).toHaveBeenCalledTimes(1);
  });
});

describe('registerOnboard() — Story 5.3: edit loop template/repo/permissions/daemon stages (H2)', () => {
  let stdoutOutput: string;

  beforeEach(() => {
    vi.resetModules();
    stdoutOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
  });

  it('re-runs template stage when user edits templates in edit loop', async () => {
    const newTemplates = ['security-audit'];
    const runTemplateStageMock = vi
      .fn()
      .mockResolvedValueOnce(['improve-code'])
      .mockResolvedValueOnce(newTemplates);

    const repoDaemonMock = {
      ...mockRepoDaemonDefaults(),
      runSummaryStage: vi.fn().mockResolvedValueOnce('edit').mockResolvedValueOnce('confirm'),
      runEditStageSelector: vi.fn().mockResolvedValue('templates'),
    };

    vi.doMock('@clack/prompts', () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      confirm: vi.fn(),
      isCancel: vi.fn().mockReturnValue(false),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('./onboard-auth.js', () => happyAuthMock());
    vi.doMock('./onboard-trigger-template.js', () => ({
      ...mockTriggerTemplateDefaults(),
      runTemplateStage: runTemplateStageMock,
    }));
    vi.doMock('./onboard-repository-daemon.js', () => repoDaemonMock);
    vi.doMock('./onboard-container.js', () => mockContainerDefaults());
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard']);
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(runTemplateStageMock).toHaveBeenCalledTimes(2);
    expect(repoDaemonMock.persistFullConfig).toHaveBeenCalledWith(
      expect.objectContaining({ selectedTemplates: newTemplates }),
      expect.any(String),
    );
  });

  it('re-runs repo stage when user edits repo in edit loop', async () => {
    const repoDaemonMock = {
      ...mockRepoDaemonDefaults(),
      runSummaryStage: vi.fn().mockResolvedValueOnce('edit').mockResolvedValueOnce('confirm'),
      runEditStageSelector: vi.fn().mockResolvedValue('repo'),
      runRepoStage: vi
        .fn()
        .mockResolvedValueOnce({ targetPath: '/tmp/test-repo' })
        .mockResolvedValueOnce({ targetPath: '/tmp/new-repo' }),
    };

    vi.doMock('@clack/prompts', () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      confirm: vi.fn(),
      isCancel: vi.fn().mockReturnValue(false),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('./onboard-auth.js', () => happyAuthMock());
    vi.doMock('./onboard-trigger-template.js', () => mockTriggerTemplateDefaults());
    vi.doMock('./onboard-repository-daemon.js', () => repoDaemonMock);
    vi.doMock('./onboard-container.js', () => mockContainerDefaults());
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard']);
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(repoDaemonMock.runRepoStage).toHaveBeenCalledTimes(2);
    expect(repoDaemonMock.persistFullConfig).toHaveBeenCalledWith(
      expect.any(Object),
      '/tmp/new-repo',
    );
  });

  it('re-runs permissions stage when user edits permissions in edit loop', async () => {
    const runPermissionConsentStageMock = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const repoDaemonMock = {
      ...mockRepoDaemonDefaults(),
      runSummaryStage: vi.fn().mockResolvedValueOnce('edit').mockResolvedValueOnce('confirm'),
      runEditStageSelector: vi.fn().mockResolvedValue('permissions'),
    };

    vi.doMock('@clack/prompts', () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      confirm: vi.fn(),
      isCancel: vi.fn().mockReturnValue(false),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('./onboard-auth.js', () => happyAuthMock());
    vi.doMock('./onboard-trigger-template.js', () => ({
      ...mockTriggerTemplateDefaults(),
      runPermissionConsentStage: runPermissionConsentStageMock,
    }));
    vi.doMock('./onboard-repository-daemon.js', () => repoDaemonMock);
    vi.doMock('./onboard-container.js', () => mockContainerDefaults());
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard']);
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(runPermissionConsentStageMock).toHaveBeenCalledTimes(2);
    expect(repoDaemonMock.persistFullConfig).toHaveBeenCalledWith(
      expect.objectContaining({ allowDangerouslySkipPermissions: true }),
      expect.any(String),
    );
  });

  it('toggles daemon install when user edits daemon in edit loop', async () => {
    const repoDaemonMock = {
      ...mockRepoDaemonDefaults(),
      runSummaryStage: vi.fn().mockResolvedValueOnce('edit').mockResolvedValueOnce('confirm'),
      runEditStageSelector: vi.fn().mockResolvedValue('daemon'),
      promptInstallDaemon: vi.fn().mockResolvedValue(true),
      installAndStartDaemon: vi.fn().mockResolvedValue({ healthy: true, pid: 1234 }),
    };

    vi.doMock('@clack/prompts', () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      confirm: vi.fn(),
      isCancel: vi.fn().mockReturnValue(false),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('./onboard-auth.js', () => happyAuthMock());
    vi.doMock('./onboard-trigger-template.js', () => mockTriggerTemplateDefaults());
    vi.doMock('./onboard-repository-daemon.js', () => repoDaemonMock);
    vi.doMock('./onboard-container.js', () => mockContainerDefaults());
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard']);
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(repoDaemonMock.installAndStartDaemon).toHaveBeenCalledTimes(1);
  });

  it('exits with 1 when templates re-selection throws in edit loop', async () => {
    const runTemplateStageMock = vi
      .fn()
      .mockResolvedValueOnce(['improve-code'])
      .mockRejectedValueOnce(new Error('template read error'));

    const repoDaemonMock = {
      ...mockRepoDaemonDefaults(),
      runSummaryStage: vi.fn().mockResolvedValue('edit'),
      runEditStageSelector: vi.fn().mockResolvedValue('templates'),
    };

    vi.doMock('@clack/prompts', () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      confirm: vi.fn(),
      isCancel: vi.fn().mockReturnValue(false),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('./onboard-auth.js', () => happyAuthMock());
    vi.doMock('./onboard-trigger-template.js', () => ({
      ...mockTriggerTemplateDefaults(),
      runTemplateStage: runTemplateStageMock,
      renderTemplateLoadError: vi.fn().mockReturnValue('TEMPLATE LOAD ERROR'),
    }));
    vi.doMock('./onboard-repository-daemon.js', () => repoDaemonMock);
    vi.doMock('./onboard-container.js', () => mockContainerDefaults());
    const { registerOnboard } = await import('./onboard.js');
    const program = makeProgram();
    registerOnboard(program);
    await program.parseAsync(['node', 'sparecrow', 'onboard']);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(stdoutOutput).toContain('TEMPLATE LOAD ERROR');
  });
});
