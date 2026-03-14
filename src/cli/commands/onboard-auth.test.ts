/** Unit tests for onboard-auth helpers — binary detection, auth validation, config persistence. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile, readFile, access } from 'node:fs/promises';

// Pre-import actual modules synchronously for use in mocks
const actualUtils =
  await vi.importActual<typeof import('../../utils/index.js')>('../../utils/index.js');
const actualFsPromises =
  await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const actualProviders = await vi.importActual<
  typeof import('../../providers/claude-code/index.js')
>('../../providers/claude-code/index.js');

/** Helper: build a partial utils mock preserving actual exports plus overrides. */
function buildUtilsMock(overrides: Record<string, unknown>) {
  return { ...actualUtils, ...overrides };
}

describe('detectClaudeBinary()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns found=true with absolute path when claude is on PATH', async () => {
    const spawnMock = vi.fn().mockResolvedValue({
      stdout: '/usr/local/bin/claude\n',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      aborted: false,
      enoent: false,
    });
    vi.doMock('../../utils/index.js', () =>
      buildUtilsMock({
        spawnWithGuardrails: spawnMock,
        logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      }),
    );
    vi.doMock('node:fs/promises', () => ({
      ...actualFsPromises,
      access: vi.fn().mockResolvedValue(undefined),
    }));
    const { detectClaudeBinary } = await import('./onboard-auth.js');
    const result = await detectClaudeBinary();
    expect(result.found).toBe(true);
    expect(result.absolutePath).toBeTruthy();
    expect(result.error).toBeNull();
  });

  it('returns found=false when which returns ENOENT (which itself not found)', async () => {
    const spawnMock = vi.fn().mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: false,
      aborted: false,
      enoent: true,
    });
    vi.doMock('../../utils/index.js', () =>
      buildUtilsMock({
        spawnWithGuardrails: spawnMock,
        logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      }),
    );
    const { detectClaudeBinary } = await import('./onboard-auth.js');
    const result = await detectClaudeBinary();
    expect(result.found).toBe(false);
    expect(result.absolutePath).toBeNull();
    expect(result.error).toContain('not found');
  });

  it('returns found=false when claude is not on PATH (exit code != 0)', async () => {
    const spawnMock = vi.fn().mockResolvedValue({
      stdout: '',
      stderr: 'not found',
      exitCode: 1,
      timedOut: false,
      aborted: false,
      enoent: false,
    });
    vi.doMock('../../utils/index.js', () =>
      buildUtilsMock({
        spawnWithGuardrails: spawnMock,
        logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      }),
    );
    const { detectClaudeBinary } = await import('./onboard-auth.js');
    const result = await detectClaudeBinary();
    expect(result.found).toBe(false);
    expect(result.absolutePath).toBeNull();
  });

  it('returns found=false when path is not executable', async () => {
    const spawnMock = vi.fn().mockResolvedValue({
      stdout: '/usr/local/bin/claude\n',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      aborted: false,
      enoent: false,
    });
    vi.doMock('../../utils/index.js', () =>
      buildUtilsMock({
        spawnWithGuardrails: spawnMock,
        logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      }),
    );
    vi.doMock('node:fs/promises', () => ({
      ...actualFsPromises,
      access: vi.fn().mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' })),
    }));
    const { detectClaudeBinary } = await import('./onboard-auth.js');
    const result = await detectClaudeBinary();
    expect(result.found).toBe(false);
    expect(result.absolutePath).toBeNull();
    expect(result.error).toContain('not executable');
  });

  it('returns found=false when which times out', async () => {
    const spawnMock = vi.fn().mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: true,
      aborted: false,
      enoent: false,
    });
    vi.doMock('../../utils/index.js', () =>
      buildUtilsMock({
        spawnWithGuardrails: spawnMock,
        logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      }),
    );
    const { detectClaudeBinary } = await import('./onboard-auth.js');
    const result = await detectClaudeBinary();
    expect(result.found).toBe(false);
    expect(result.error).toContain('timed out');
  });
});

describe('validateAuth()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns valid=true with tier from claude auth status --json', async () => {
    const validateMock = vi.fn().mockResolvedValue(true);
    vi.doMock('../../providers/claude-code/index.js', () => ({
      ...actualProviders,
      ClaudeCodeAuthManager: class {
        validate = validateMock;
      },
    }));
    const spawnMock = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ loggedIn: true, subscriptionType: 'max5' }),
      stderr: '',
      exitCode: 0,
      timedOut: false,
      aborted: false,
      enoent: false,
    });
    vi.doMock('../../utils/index.js', () =>
      buildUtilsMock({
        spawnWithGuardrails: spawnMock,
        logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      }),
    );
    const { validateAuth } = await import('./onboard-auth.js');
    const result = await validateAuth('/usr/local/bin/claude');
    expect(result.valid).toBe(true);
    expect(result.tier).toBe('max5');
  });

  it('returns valid=false when credential file is missing', async () => {
    const validateMock = vi.fn().mockResolvedValue(false);
    vi.doMock('../../providers/claude-code/index.js', () => ({
      ...actualProviders,
      ClaudeCodeAuthManager: class {
        validate = validateMock;
      },
    }));
    vi.doMock('../../utils/index.js', () =>
      buildUtilsMock({
        spawnWithGuardrails: vi.fn(),
        logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      }),
    );
    const { validateAuth } = await import('./onboard-auth.js');
    const result = await validateAuth('/usr/local/bin/claude');
    expect(result.valid).toBe(false);
  });

  it('returns valid=false with unknown tier when auth status JSON is malformed', async () => {
    const validateMock = vi.fn().mockResolvedValue(true);
    vi.doMock('../../providers/claude-code/index.js', () => ({
      ...actualProviders,
      ClaudeCodeAuthManager: class {
        validate = validateMock;
      },
    }));
    const spawnMock = vi.fn().mockResolvedValue({
      stdout: 'not-json{{{',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      aborted: false,
      enoent: false,
    });
    vi.doMock('../../utils/index.js', () =>
      buildUtilsMock({
        spawnWithGuardrails: spawnMock,
        logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      }),
    );
    const { validateAuth } = await import('./onboard-auth.js');
    const result = await validateAuth('/usr/local/bin/claude');
    // malformed JSON → parseAuthStatusOutput returns authenticated=false → valid=false
    expect(result.valid).toBe(false);
    expect(result.tier).toBe('unknown');
  });

  it('returns valid=false when auth status output is empty', async () => {
    const validateMock = vi.fn().mockResolvedValue(true);
    vi.doMock('../../providers/claude-code/index.js', () => ({
      ...actualProviders,
      ClaudeCodeAuthManager: class {
        validate = validateMock;
      },
    }));
    const spawnMock = vi.fn().mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      aborted: false,
      enoent: false,
    });
    vi.doMock('../../utils/index.js', () =>
      buildUtilsMock({
        spawnWithGuardrails: spawnMock,
        logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      }),
    );
    const { validateAuth } = await import('./onboard-auth.js');
    const result = await validateAuth('/usr/local/bin/claude');
    // empty output → authenticated: false → valid: false
    expect(result.valid).toBe(false);
  });

  it('returns valid=false with unknown tier when auth status check command fails (exit != 0)', async () => {
    const validateMock = vi.fn().mockResolvedValue(true);
    vi.doMock('../../providers/claude-code/index.js', () => ({
      ...actualProviders,
      ClaudeCodeAuthManager: class {
        validate = validateMock;
      },
    }));
    const spawnMock = vi.fn().mockResolvedValue({
      stdout: '',
      stderr: 'error',
      exitCode: 1,
      timedOut: false,
      aborted: false,
      enoent: false,
    });
    vi.doMock('../../utils/index.js', () =>
      buildUtilsMock({
        spawnWithGuardrails: spawnMock,
        logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      }),
    );
    const { validateAuth } = await import('./onboard-auth.js');
    const result = await validateAuth('/usr/local/bin/claude');
    // subprocess failure (network/transient) → treat as invalid to trigger remediation
    expect(result.valid).toBe(false);
    expect(result.tier).toBe('unknown');
  });

  it('returns valid=true with unknown tier when plan is missing from auth status', async () => {
    const validateMock = vi.fn().mockResolvedValue(true);
    vi.doMock('../../providers/claude-code/index.js', () => ({
      ...actualProviders,
      ClaudeCodeAuthManager: class {
        validate = validateMock;
      },
    }));
    const spawnMock = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ loggedIn: true }),
      stderr: '',
      exitCode: 0,
      timedOut: false,
      aborted: false,
      enoent: false,
    });
    vi.doMock('../../utils/index.js', () =>
      buildUtilsMock({
        spawnWithGuardrails: spawnMock,
        logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      }),
    );
    const { validateAuth } = await import('./onboard-auth.js');
    const result = await validateAuth('/usr/local/bin/claude');
    expect(result.valid).toBe(true);
    expect(result.tier).toBe('unknown');
  });
});

describe('runAuthLogin()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true when auth login succeeds', async () => {
    const spawnMock = vi.fn().mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      aborted: false,
      enoent: false,
    });
    vi.doMock('../../utils/index.js', () =>
      buildUtilsMock({
        spawnWithGuardrails: spawnMock,
        logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      }),
    );
    const { runAuthLogin } = await import('./onboard-auth.js');
    const result = await runAuthLogin('/usr/local/bin/claude');
    expect(result).toBe(true);
  });

  it('returns false when auth login fails (exit code != 0)', async () => {
    const spawnMock = vi.fn().mockResolvedValue({
      stdout: '',
      stderr: 'error',
      exitCode: 1,
      timedOut: false,
      aborted: false,
      enoent: false,
    });
    vi.doMock('../../utils/index.js', () =>
      buildUtilsMock({
        spawnWithGuardrails: spawnMock,
        logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      }),
    );
    const { runAuthLogin } = await import('./onboard-auth.js');
    const result = await runAuthLogin('/usr/local/bin/claude');
    expect(result).toBe(false);
  });

  it('returns false when auth login times out', async () => {
    const spawnMock = vi.fn().mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: true,
      aborted: false,
      enoent: false,
    });
    vi.doMock('../../utils/index.js', () =>
      buildUtilsMock({
        spawnWithGuardrails: spawnMock,
        logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      }),
    );
    const { runAuthLogin } = await import('./onboard-auth.js');
    const result = await runAuthLogin('/usr/local/bin/claude');
    expect(result).toBe(false);
  });
});

describe('persistClaudePath()', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = join(tmpdir(), 'onboard-auth-test-' + randomBytes(6).toString('hex'));
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.doUnmock('node:fs/promises');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('writes claude_path to new config file', async () => {
    const configPath = join(tmpDir, 'config.yaml');
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => configPath,
    }));
    vi.doMock('../../utils/index.js', () =>
      buildUtilsMock({
        logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      }),
    );
    const { persistClaudePath } = await import('./onboard-auth.js');
    await persistClaudePath('/usr/local/bin/claude');
    const content = await readFile(configPath, 'utf-8');
    expect(content).toContain('claude_path');
    expect(content).toContain('/usr/local/bin/claude');
  });

  it('preserves existing config keys when writing claude_path', async () => {
    const configPath = join(tmpDir, 'config.yaml');
    await writeFile(configPath, 'polling_interval: 120\nprovider:\n  name: claude-code\n', 'utf-8');
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => configPath,
    }));
    vi.doMock('../../utils/index.js', () =>
      buildUtilsMock({
        logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      }),
    );
    const { persistClaudePath } = await import('./onboard-auth.js');
    await persistClaudePath('/usr/local/bin/claude');
    const content = await readFile(configPath, 'utf-8');
    expect(content).toContain('polling_interval: 120');
    expect(content).toContain('claude_path');
  });

  it('skips write when claude_path is already set to same value (idempotent)', async () => {
    const configPath = join(tmpDir, 'config.yaml');
    await writeFile(
      configPath,
      'provider:\n  name: claude-code\n  claude_path: /usr/local/bin/claude\n',
      'utf-8',
    );
    const atomicWriteMock = vi.fn();
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => configPath,
    }));
    vi.doMock('../../utils/index.js', () =>
      buildUtilsMock({
        atomicWrite: atomicWriteMock,
        logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      }),
    );
    const { persistClaudePath } = await import('./onboard-auth.js');
    await persistClaudePath('/usr/local/bin/claude');
    expect(atomicWriteMock).not.toHaveBeenCalled();
  });

  it('throws CONFIG_INVALID when config file is unreadable (not ENOENT)', async () => {
    const configPath = join(tmpDir, 'config.yaml');
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => configPath,
    }));
    vi.doMock('node:fs/promises', () => ({
      ...actualFsPromises,
      readFile: vi.fn().mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' })),
    }));
    vi.doMock('../../utils/index.js', () =>
      buildUtilsMock({
        logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      }),
    );
    const { persistClaudePath } = await import('./onboard-auth.js');
    await expect(persistClaudePath('/usr/local/bin/claude')).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
  });

  it('uses getConfigPath() override when provided', async () => {
    const overridePath = join(tmpDir, 'custom-config.yaml');
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => overridePath,
    }));
    vi.doMock('../../utils/index.js', () =>
      buildUtilsMock({
        logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      }),
    );
    const { persistClaudePath } = await import('./onboard-auth.js');
    await persistClaudePath('/usr/local/bin/claude');
    const content = await readFile(overridePath, 'utf-8');
    expect(content).toContain('claude_path');
  });

  it('resolves config from platform path when --config flag is not set (getConfigPath returns null)', async () => {
    // Simulate the common production case: no --config flag, getConfigPath() returns null.
    // The ?? fallback must use join(getPaths().config, 'config.yaml') — a file path.
    const platformConfigDir = tmpDir;
    const expectedConfigPath = join(platformConfigDir, 'config.yaml');

    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => null,
    }));
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ config: platformConfigDir, data: platformConfigDir }),
    }));
    vi.doMock('../../utils/index.js', () =>
      buildUtilsMock({
        logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      }),
    );

    const { persistClaudePath } = await import('./onboard-auth.js');
    await persistClaudePath('/usr/local/bin/claude');

    // Config must have been written to the file path (not the directory)
    const content = await readFile(expectedConfigPath, 'utf-8');
    expect(content).toContain('claude_path');
    expect(content).toContain('/usr/local/bin/claude');
  });
});

describe('renderClaudeNotFoundError()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders error block with install link', async () => {
    const { renderClaudeNotFoundError } = await import('./onboard-auth.js');
    const result = renderClaudeNotFoundError();
    expect(result).toContain('Claude Code CLI not found');
    expect(result).toContain('https://claude.ai/download');
  });

  it('does not contain token or credential material', async () => {
    const { renderClaudeNotFoundError } = await import('./onboard-auth.js');
    const result = renderClaudeNotFoundError();
    expect(result).not.toMatch(/accessToken|refreshToken|Bearer/i);
  });
});

describe('renderAuthSuccess()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders status indicator with tier', async () => {
    const { renderAuthSuccess } = await import('./onboard-auth.js');
    const result = renderAuthSuccess('pro');
    expect(result).toContain('Auth');
    expect(result).toContain('pro');
  });

  it('does not contain token or credential material', async () => {
    const { renderAuthSuccess } = await import('./onboard-auth.js');
    const result = renderAuthSuccess('max5');
    expect(result).not.toMatch(/accessToken|refreshToken|Bearer/i);
  });
});

describe('renderConfigSaveError()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders error block with failure reason and recovery hint', async () => {
    const { renderConfigSaveError } = await import('./onboard-auth.js');
    const result = renderConfigSaveError('EACCES: permission denied');
    expect(result).toContain('Failed to save configuration');
    expect(result).toContain('EACCES: permission denied');
    expect(result).toContain('sparecrow doctor');
  });

  it('does not contain token or credential material', async () => {
    const { renderConfigSaveError } = await import('./onboard-auth.js');
    const result = renderConfigSaveError('disk error');
    expect(result).not.toMatch(/accessToken|refreshToken|Bearer/i);
  });
});

describe('renderAuthFailedError()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders error block with auth recovery hint', async () => {
    const { renderAuthFailedError } = await import('./onboard-auth.js');
    const result = renderAuthFailedError();
    expect(result).toContain('Authentication failed after retry');
    expect(result).toContain('claude auth login');
  });

  it('does not contain token or credential material', async () => {
    const { renderAuthFailedError } = await import('./onboard-auth.js');
    const result = renderAuthFailedError();
    expect(result).not.toMatch(/accessToken|refreshToken|Bearer/i);
  });
});
