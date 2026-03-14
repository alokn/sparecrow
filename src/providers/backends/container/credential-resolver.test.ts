/** Unit tests for CredentialResolver. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { EventName } from '../../../types/index.js';

let resolveContainerCredentials: typeof import('./credential-resolver.js').resolveContainerCredentials;
let mockAccess: ReturnType<typeof vi.fn>;
let loggerDebugSpy: ReturnType<typeof vi.fn>;
let loggerWarnSpy: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();

  // Default: credentials file exists (used as probe for the .claude/ directory)
  mockAccess = vi.fn().mockResolvedValue(undefined);

  vi.doMock('node:fs/promises', () => ({
    access: mockAccess,
    constants: { R_OK: 4 },
  }));

  loggerDebugSpy = vi.fn().mockResolvedValue(undefined);
  loggerWarnSpy = vi.fn().mockResolvedValue(undefined);

  vi.doMock('../../../utils/index.js', () => ({
    logger: {
      info: vi.fn().mockResolvedValue(undefined),
      warn: loggerWarnSpy,
      error: vi.fn().mockResolvedValue(undefined),
      debug: loggerDebugSpy,
    },
  }));

  vi.doMock('node:os', () => ({
    homedir: () => '/home/testuser',
  }));

  const mod = await import('./credential-resolver.js');
  resolveContainerCredentials = mod.resolveContainerCredentials;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveContainerCredentials', () => {
  // 5.2: returns a directory mount when ~/.claude/.credentials.json exists
  it('returns credentials mount when ~/.claude/.credentials.json exists', async () => {
    const result = await resolveContainerCredentials({
      hostHomedir: '/home/testuser',
    });

    // Both .claude/ dir mount and .claude.json file mount (default mock resolves all access calls)
    expect(result.mounts).toHaveLength(2);
    expect(result.mounts[0]!.source).toBe('/home/testuser/.claude');
  });

  // 5.3: directory mount is read-write (so Claude can create plugins/, etc.)
  it('returns credentials mount as read-write (readonly: false)', async () => {
    const result = await resolveContainerCredentials({
      hostHomedir: '/home/testuser',
    });

    expect(result.mounts[0]!.readonly).toBe(false);
  });

  // 5.4: directory mount target is $containerHome/.claude (not a file path)
  it('returns mount target path as /root/.claude directory', async () => {
    const result = await resolveContainerCredentials({
      hostHomedir: '/home/testuser',
    });

    expect(result.mounts[0]!.target).toBe('/root/.claude');
  });

  // 5.8: directory mount + .claude.json file mount when both exist
  it('returns directory mount and .claude.json file mount when both credentials and config exist', async () => {
    const result = await resolveContainerCredentials({
      hostHomedir: '/home/testuser',
    });

    expect(result.mounts).toHaveLength(2);
    expect(result.mounts[0]!.source).toBe('/home/testuser/.claude');
    expect(result.mounts[0]!.target).toBe('/root/.claude');
    expect(result.mounts[1]!.source).toBe('/home/testuser/.claude.json');
    expect(result.mounts[1]!.target).toBe('/root/.claude.json');
  });

  // 5.9: returns empty mounts when neither .credentials.json nor .claude.json exist
  it('returns empty mounts when neither .credentials.json nor .claude.json exist', async () => {
    mockAccess.mockRejectedValue(new Error('ENOENT'));

    const result = await resolveContainerCredentials({
      hostHomedir: '/home/testuser',
    });

    expect(result.mounts).toHaveLength(0);
  });

  // 5.10: env always contains HOME: '/root'
  it('always includes HOME: /root in env', async () => {
    const result = await resolveContainerCredentials({
      hostHomedir: '/home/testuser',
    });

    expect(result.env).toEqual({ HOME: '/root' });
  });

  // 5.11: custom hostHomedir overrides homedir()
  it('uses custom hostHomedir option for credential path resolution', async () => {
    const result = await resolveContainerCredentials({
      hostHomedir: '/custom/home',
    });

    expect(result.mounts).toHaveLength(2);
    expect(result.mounts[0]!.source).toBe('/custom/home/.claude');
    expect(result.mounts[1]!.source).toBe('/custom/home/.claude.json');
  });

  // 5.12: custom containerHome overrides /root for both mount targets and HOME env
  it('uses custom containerHome option for container mount targets and HOME env', async () => {
    const result = await resolveContainerCredentials({
      hostHomedir: '/home/testuser',
      containerHome: '/home/node',
    });

    expect(result.mounts).toHaveLength(2);
    expect(result.mounts[0]!.target).toBe('/home/node/.claude');
    expect(result.mounts[1]!.target).toBe('/home/node/.claude.json');
    expect(result.env).toEqual({ HOME: '/home/node' });
  });

  // 5.13: logs CONTAINER_CREDENTIALS_MISSING when credentials file missing
  it('logs CONTAINER_CREDENTIALS_MISSING at debug level when credentials file is missing', async () => {
    mockAccess.mockRejectedValue(new Error('ENOENT'));

    await resolveContainerCredentials({
      hostHomedir: '/home/testuser',
    });

    expect(loggerDebugSpy).toHaveBeenCalledWith(
      EventName.CONTAINER_CREDENTIALS_MISSING,
      expect.objectContaining({
        expectedPath: '/home/testuser/.claude/.credentials.json',
      }),
    );
  });

  // 5.14: does NOT log warning when credentials file exists
  it('does not log CONTAINER_CREDENTIALS_MISSING when credentials file exists', async () => {
    await resolveContainerCredentials({
      hostHomedir: '/home/testuser',
    });

    expect(loggerDebugSpy).not.toHaveBeenCalledWith(
      EventName.CONTAINER_CREDENTIALS_MISSING,
      expect.anything(),
    );
  });

  // 5.15: does not throw when access() fails
  it('does not throw when access() fails -- returns empty mounts gracefully', async () => {
    mockAccess.mockRejectedValue(new Error('ENOENT'));

    const result = await resolveContainerCredentials({
      hostHomedir: '/home/testuser',
    });

    expect(result.mounts).toHaveLength(0);
    expect(result.env).toEqual({ HOME: '/root' });
  });

  // 5.16: never throws even on unexpected errors (top-level try/catch)
  it('never throws even on unexpected errors -- wraps in try/catch', async () => {
    vi.resetModules();

    // Re-mock node:path after resetModules() to keep the test stable; pass through the real join.
    // Without this, node:path is unregistered and a divergence in join() behavior could break this test.
    const { join: realJoin } = await import('node:path');
    vi.doMock('node:path', () => ({
      join: realJoin,
    }));

    // Mock homedir() to throw an unexpected error
    vi.doMock('node:os', () => ({
      homedir: () => {
        throw new Error('unexpected homedir failure');
      },
    }));

    vi.doMock('node:fs/promises', () => ({
      access: vi.fn().mockResolvedValue(undefined),
      constants: { R_OK: 4 },
    }));

    const localWarnSpy = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../../../utils/index.js', () => ({
      logger: {
        info: vi.fn().mockResolvedValue(undefined),
        warn: localWarnSpy,
        error: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
    }));

    const mod = await import('./credential-resolver.js');

    // Should NOT throw
    const result = await mod.resolveContainerCredentials();

    expect(result.mounts).toHaveLength(0);
    expect(result.env).toEqual({ HOME: '/root' });
    expect(localWarnSpy).toHaveBeenCalled();
  });

  // 5.17: mount sources are absolute paths based on hostHomedir
  it('returns mount sources as absolute paths based on hostHomedir', async () => {
    const result = await resolveContainerCredentials({
      hostHomedir: '/home/testuser',
    });

    expect(result.mounts).toHaveLength(2);
    expect(result.mounts[0]!.source.startsWith('/')).toBe(true);
    expect(result.mounts[0]!.source).toBe(join('/home/testuser', '.claude'));
    expect(result.mounts[1]!.source.startsWith('/')).toBe(true);
    expect(result.mounts[1]!.source).toBe(join('/home/testuser', '.claude.json'));
  });

  // 5.18: returns directory mount even when settings.json does not exist
  // (settings no longer probed separately — directory mount covers all config files)
  it('returns directory mount even when settings.json does not exist alongside credentials', async () => {
    // Only credentials and .claude.json probes are performed; settings.json absence is irrelevant
    mockAccess.mockImplementation((path: string) => {
      if (path.endsWith('settings.json')) {
        return Promise.reject(new Error('ENOENT'));
      }
      return Promise.resolve(undefined);
    });

    const result = await resolveContainerCredentials({
      hostHomedir: '/home/testuser',
    });

    // Both .claude/ dir and .claude.json file mounts (neither is settings.json)
    expect(result.mounts).toHaveLength(2);
    expect(result.mounts[0]!.source).toBe('/home/testuser/.claude');
    expect(result.mounts[0]!.readonly).toBe(false);
  });

  // 5.19: when .credentials.json missing but .claude.json exists, only .claude.json mount is returned
  it('returns only .claude.json mount when .credentials.json does not exist but .claude.json does', async () => {
    mockAccess.mockImplementation((path: string) => {
      if (path.endsWith('.credentials.json')) {
        return Promise.reject(new Error('ENOENT'));
      }
      return Promise.resolve(undefined);
    });

    const result = await resolveContainerCredentials({
      hostHomedir: '/home/testuser',
    });

    expect(result.mounts).toHaveLength(1);
    expect(result.mounts[0]!.target).toBe('/root/.claude.json');
  });

  // ─── Story 12.2: mountClaudeConfig option tests ──────────────────────────

  // 12.2 6.1: When mountClaudeConfig === false, skip ~/.claude/ mounts
  it('returns empty mounts when mountClaudeConfig is false (skips all credential probes)', async () => {
    const result = await resolveContainerCredentials({
      hostHomedir: '/home/testuser',
      mountClaudeConfig: false,
    });

    expect(result.mounts).toHaveLength(0);
    expect(result.env).toEqual({ HOME: '/root' });
    // access() should not have been called at all (no filesystem probes)
    expect(mockAccess).not.toHaveBeenCalled();
  });

  // 12.2 6.2: mountClaudeConfig: true (default) still produces mounts
  it('produces credential mounts when mountClaudeConfig is true (explicit)', async () => {
    const result = await resolveContainerCredentials({
      hostHomedir: '/home/testuser',
      mountClaudeConfig: true,
    });

    expect(result.mounts.length).toBeGreaterThan(0);
  });

  // 12.2 6.3: mountClaudeConfig defaults to true when not specified
  it('defaults mountClaudeConfig to true (produces mounts when option is omitted)', async () => {
    const result = await resolveContainerCredentials({
      hostHomedir: '/home/testuser',
    });

    // Default behavior: mounts should be produced (credentials file mocked as accessible)
    expect(result.mounts.length).toBeGreaterThan(0);
  });

  // mountClaudeConfig: false with custom containerHome
  it('uses custom containerHome in env even when mountClaudeConfig is false', async () => {
    const result = await resolveContainerCredentials({
      hostHomedir: '/home/testuser',
      containerHome: '/home/node',
      mountClaudeConfig: false,
    });

    expect(result.mounts).toHaveLength(0);
    expect(result.env).toEqual({ HOME: '/home/node' });
  });

  // ─── Story 10.10: .claude.json mount tests ──────────────────────────────

  // 10.10 AC1: .claude.json mount included when both files exist
  it('includes .claude.json file mount when both .credentials.json and .claude.json exist on host', async () => {
    const result = await resolveContainerCredentials({
      hostHomedir: '/home/testuser',
    });

    expect(result.mounts).toHaveLength(2);
    const claudeJsonMount = result.mounts.find((m) => m.target.endsWith('.claude.json'));
    expect(claudeJsonMount).toBeDefined();
    expect(claudeJsonMount!.source).toBe('/home/testuser/.claude.json');
    expect(claudeJsonMount!.target).toBe('/root/.claude.json');
    expect(claudeJsonMount!.readonly).toBe(false);
  });

  // 10.10 AC2: .claude.json mount omitted when .claude.json does not exist
  it('omits .claude.json mount when .claude.json does not exist but .credentials.json does', async () => {
    mockAccess.mockImplementation((path: string) =>
      path.endsWith('.claude.json')
        ? Promise.reject(new Error('ENOENT'))
        : Promise.resolve(undefined),
    );

    const result = await resolveContainerCredentials({
      hostHomedir: '/home/testuser',
    });

    expect(result.mounts).toHaveLength(1);
    expect(result.mounts[0]!.target).toBe('/root/.claude');
    const claudeJsonMount = result.mounts.find((m) => m.target.endsWith('.claude.json'));
    expect(claudeJsonMount).toBeUndefined();
  });

  // 10.10 AC2 variant: no mounts when neither file exists
  it('returns empty mounts when neither .credentials.json nor .claude.json exist', async () => {
    mockAccess.mockRejectedValue(new Error('ENOENT'));

    const result = await resolveContainerCredentials({
      hostHomedir: '/home/testuser',
    });

    expect(result.mounts).toHaveLength(0);
  });

  // 10.10 AC3: mountClaudeConfig: false skips .claude.json mount too
  it('skips .claude.json mount when mountClaudeConfig is false', async () => {
    const result = await resolveContainerCredentials({
      hostHomedir: '/home/testuser',
      mountClaudeConfig: false,
    });

    expect(result.mounts).toHaveLength(0);
    const claudeJsonMount = result.mounts.find((m) => m.target.endsWith('.claude.json'));
    expect(claudeJsonMount).toBeUndefined();
    expect(mockAccess).not.toHaveBeenCalled();
  });

  // 10.10: .claude.json mount uses custom containerHome
  it('uses custom containerHome for .claude.json mount target', async () => {
    const result = await resolveContainerCredentials({
      hostHomedir: '/home/testuser',
      containerHome: '/home/node',
    });

    const claudeJsonMount = result.mounts.find((m) => m.target.endsWith('.claude.json'));
    expect(claudeJsonMount).toBeDefined();
    expect(claudeJsonMount!.target).toBe('/home/node/.claude.json');
  });

  // 10.10: debug log emitted when .claude.json missing (uses CONTAINER_CONFIG_FILE_MISSING, not CONTAINER_CREDENTIALS_MISSING)
  it('logs CONTAINER_CONFIG_FILE_MISSING at debug level when .claude.json does not exist on host', async () => {
    mockAccess.mockImplementation((path: string) =>
      path.endsWith('.claude.json')
        ? Promise.reject(new Error('ENOENT'))
        : Promise.resolve(undefined),
    );

    await resolveContainerCredentials({
      hostHomedir: '/home/testuser',
    });

    expect(loggerDebugSpy).toHaveBeenCalledWith(
      EventName.CONTAINER_CONFIG_FILE_MISSING,
      expect.objectContaining({
        expectedPath: '/home/testuser/.claude.json',
      }),
    );
  });

  // 10.10 Low: homedir() fallback branch — no hostHomedir option, uses mocked homedir()
  it('uses homedir() fallback when hostHomedir option is not provided', async () => {
    // node:os is mocked in beforeEach to return '/home/testuser'
    const result = await resolveContainerCredentials();

    // Should use /home/testuser (from mocked homedir()) for source paths
    expect(result.mounts).toHaveLength(2);
    expect(result.mounts[0]!.source).toBe('/home/testuser/.claude');
    expect(result.mounts[1]!.source).toBe('/home/testuser/.claude.json');
  });

  // 10.10 Low: String(err) catch branch — non-Error thrown value exercises String(err) path
  it('logs warning and returns empty mounts when a non-Error value is thrown internally', async () => {
    vi.resetModules();

    const { join: realJoin } = await import('node:path');
    vi.doMock('node:path', () => ({ join: realJoin }));

    // homedir() throws a raw string (not an Error instance) to trigger the String(err) branch
    vi.doMock('node:os', () => ({
      homedir: () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw 'homedir-string-error';
      },
    }));

    vi.doMock('node:fs/promises', () => ({
      access: vi.fn().mockResolvedValue(undefined),
      constants: { R_OK: 4 },
    }));

    const localWarnSpy = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../../../utils/index.js', () => ({
      logger: {
        info: vi.fn().mockResolvedValue(undefined),
        warn: localWarnSpy,
        error: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
    }));

    const mod = await import('./credential-resolver.js');
    const result = await mod.resolveContainerCredentials();

    expect(result.mounts).toHaveLength(0);
    expect(result.env).toEqual({ HOME: '/root' });
    expect(localWarnSpy).toHaveBeenCalled();
  });
});
