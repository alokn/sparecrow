/** Unit tests for the Claude Code provider bundle wiring. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ErrorCode } from '../../errors/index.js';
import type { TaskDefinition, ProviderConfig } from '../../types/index.js';

// ---------------------------------------------------------------------------
// isClaudeCodeProviderOptions — dedicated unit tests (Finding 2 + Finding 5)
// ---------------------------------------------------------------------------

describe('isClaudeCodeProviderOptions', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true for an empty object (all fields optional)', async () => {
    const { isClaudeCodeProviderOptions } = await import('./index.js');
    expect(isClaudeCodeProviderOptions({})).toBe(true);
  });

  it('returns false for null', async () => {
    const { isClaudeCodeProviderOptions } = await import('./index.js');
    expect(isClaudeCodeProviderOptions(null)).toBe(false);
  });

  it('returns false for undefined', async () => {
    const { isClaudeCodeProviderOptions } = await import('./index.js');
    expect(isClaudeCodeProviderOptions(undefined)).toBe(false);
  });

  it('returns false for a string', async () => {
    const { isClaudeCodeProviderOptions } = await import('./index.js');
    expect(isClaudeCodeProviderOptions('not-an-object')).toBe(false);
  });

  it('returns false for a number', async () => {
    const { isClaudeCodeProviderOptions } = await import('./index.js');
    expect(isClaudeCodeProviderOptions(42)).toBe(false);
  });

  it('returns false for an array', async () => {
    const { isClaudeCodeProviderOptions } = await import('./index.js');
    expect(isClaudeCodeProviderOptions([1, 2, 3])).toBe(false);
  });

  it('returns true when an extra unknown field is present (only authManager is validated)', async () => {
    const { isClaudeCodeProviderOptions } = await import('./index.js');
    expect(isClaudeCodeProviderOptions({ someUnknownField: 42 })).toBe(true);
  });

  it('returns false when authManager is a plain object with correct shape but not instanceof ClaudeCodeAuthManager', async () => {
    const { isClaudeCodeProviderOptions } = await import('./index.js');
    // A plain object that looks like an authManager but is not an actual instance
    // (simulates cross-ESM-registry or vi.resetModules() scenario — Finding 5).
    const fakeAuthManager = { readSubscriptionTier: async () => ({ rateLimitTier: null }) };
    expect(isClaudeCodeProviderOptions({ authManager: fakeAuthManager })).toBe(false);
  });

  it('returns true when authManager is an actual ClaudeCodeAuthManager instance', async () => {
    const { isClaudeCodeProviderOptions, ClaudeCodeAuthManager } = await import('./index.js');
    const authManager = new ClaudeCodeAuthManager();
    expect(isClaudeCodeProviderOptions({ authManager })).toBe(true);
  });

  it('returns false when authManager is a string', async () => {
    const { isClaudeCodeProviderOptions } = await import('./index.js');
    expect(isClaudeCodeProviderOptions({ authManager: 'bad-value' })).toBe(false);
  });
});

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    name: 'claude-code',
    allowDangerouslySkipPermissions: false,
    executionBackend: 'container',
    ...overrides,
  };
}

function createTaskDefinition(): TaskDefinition {
  return {
    id: 'task-1',
    name: 'stub task',
    type: 'custom',
    status: 'pending',
    prompt: 'Run a stub task',
    targetPath: '.',
    priority: 1,
    createdAt: new Date(),
    timeoutMs: 1000,
    actions: [],
  };
}

/** Mock the container backend to always be available (no Docker/Podman required for unit tests). */
function mockContainerBackendAvailable() {
  vi.doMock('../backends/container/index.js', () => ({
    ContainerExecutionBackend: class {
      readonly name = 'container';
      async available() {
        return true;
      }
      resetAvailabilityCache() {}
      async getRuntimeInfo() {
        return null;
      }
      async execute() {
        return {
          stdout: '',
          stderr: '',
          exitCode: 0,
          timedOut: false,
          aborted: false,
          oomKilled: false,
        };
      }
    },
  }));
}

describe('createClaudeCodeProvider', () => {
  beforeEach(() => {
    vi.resetModules();
    mockContainerBackendAvailable();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a bundle with authManager, usageMonitor, and taskExecutor', async () => {
    const { createClaudeCodeProvider } = await import('./index.js');
    const { ClaudeCodeAuthManager } = await import('./auth-manager.js');
    const { ClaudeCodeUsageMonitor } = await import('./usage-monitor.js');
    const { ClaudeCodeTaskExecutor } = await import('./task-executor.js');
    const provider = await createClaudeCodeProvider(makeConfig());
    expect(provider).toHaveProperty('authManager');
    expect(provider).toHaveProperty('usageMonitor');
    expect(provider).toHaveProperty('taskExecutor');
    expect(provider.authManager).toBeInstanceOf(ClaudeCodeAuthManager);
    expect(provider.usageMonitor).toBeInstanceOf(ClaudeCodeUsageMonitor);
    expect(provider.taskExecutor).toBeInstanceOf(ClaudeCodeTaskExecutor);
  });

  it('throws CLAUDE_NOT_FOUND when claudePath is not configured', async () => {
    const { createClaudeCodeProvider } = await import('./index.js');
    const provider = await createClaudeCodeProvider(makeConfig());
    await expect(provider.taskExecutor.execute(createTaskDefinition())).rejects.toMatchObject({
      code: ErrorCode.CLAUDE_NOT_FOUND,
    });
  });

  it('exposes a usageMonitor with a poll function', async () => {
    const { createClaudeCodeProvider } = await import('./index.js');
    const provider = await createClaudeCodeProvider(makeConfig());
    expect(typeof provider.usageMonitor.poll).toBe('function');
  });

  it('throws ScrowError from taskExecutor when claudePath is missing', async () => {
    const { createClaudeCodeProvider } = await import('./index.js');
    const provider = await createClaudeCodeProvider(makeConfig());
    await expect(provider.taskExecutor.execute(createTaskDefinition())).rejects.toMatchObject({
      code: ErrorCode.CLAUDE_NOT_FOUND,
    });
  });

  it('accepts TaskDefinition with type: "custom" — throws CLAUDE_NOT_FOUND (not type error)', async () => {
    const { createClaudeCodeProvider } = await import('./index.js');
    const provider = await createClaudeCodeProvider(makeConfig());
    const customTask: TaskDefinition = {
      id: 'custom-task-1',
      name: 'custom-1',
      type: 'custom',
      status: 'pending',
      prompt: 'Review API error handling patterns in this repository',
      targetPath: '/tmp/myrepo',
      priority: 1,
      createdAt: new Date(),
      timeoutMs: 30_000,
      actions: [],
    };
    await expect(provider.taskExecutor.execute(customTask)).rejects.toMatchObject({
      code: ErrorCode.CLAUDE_NOT_FOUND,
    });
  });

  it('accepts TaskDefinition with type: "template" — throws CLAUDE_NOT_FOUND', async () => {
    const { createClaudeCodeProvider } = await import('./index.js');
    const provider = await createClaudeCodeProvider(makeConfig());
    const templateTask: TaskDefinition = {
      id: 'template-task-1',
      name: 'improve-code',
      type: 'template',
      status: 'pending',
      templateName: 'improve-code',
      prompt: 'Review code for bugs and quality issues.',
      targetPath: '/tmp/myrepo',
      priority: 1,
      createdAt: new Date(),
      timeoutMs: 30_000,
      actions: [],
    };
    await expect(provider.taskExecutor.execute(templateTask)).rejects.toMatchObject({
      code: ErrorCode.CLAUDE_NOT_FOUND,
    });
  });

  it('reuses provided authManager instance instead of creating a new one', async () => {
    const { createClaudeCodeProvider } = await import('./index.js');
    const { ClaudeCodeAuthManager } = await import('./auth-manager.js');
    const existingAuthManager = new ClaudeCodeAuthManager();
    const provider = await createClaudeCodeProvider(makeConfig(), {
      authManager: existingAuthManager,
    });
    expect(provider.authManager).toBe(existingAuthManager);
  });

  it('creates a new authManager when none is provided in options', async () => {
    const { createClaudeCodeProvider } = await import('./index.js');
    const { ClaudeCodeAuthManager } = await import('./auth-manager.js');
    const provider = await createClaudeCodeProvider(makeConfig());
    expect(provider.authManager).toBeInstanceOf(ClaudeCodeAuthManager);
  });

  // ─── Container backend wiring ──────────────

  it('throws CONTAINER_RUNTIME_NOT_FOUND when runtime is unavailable', async () => {
    vi.resetModules();
    vi.doMock('../backends/container/index.js', () => ({
      ContainerExecutionBackend: class {
        readonly name = 'container';
        async available() {
          return false;
        }
        resetAvailabilityCache() {}
        async getRuntimeInfo() {
          return null;
        }
      },
    }));
    const { createClaudeCodeProvider } = await import('./index.js');
    await expect(
      createClaudeCodeProvider(makeConfig({ executionBackend: 'container' })),
    ).rejects.toMatchObject({ code: ErrorCode.CONTAINER_RUNTIME_NOT_FOUND });
  });

  it('passes config.container to ContainerExecutionBackend constructor when present', async () => {
    vi.resetModules();
    let capturedConfig: unknown;
    vi.doMock('../backends/container/index.js', () => ({
      ContainerExecutionBackend: class {
        readonly name = 'container';
        constructor(config?: unknown) {
          capturedConfig = config;
        }
        async available() {
          return true;
        }
        resetAvailabilityCache() {}
        async getRuntimeInfo() {
          return null;
        }
      },
    }));
    const { createClaudeCodeProvider } = await import('./index.js');
    const containerConfig = {
      runtime: 'docker' as const,
      image: 'ubuntu:22.04',
      memoryLimitMb: 1024,
      cpuLimit: 2.0,
      networkMode: 'none' as const,
      mountClaudeConfig: false,
    };
    await createClaudeCodeProvider(
      makeConfig({
        executionBackend: 'container',
        container: containerConfig,
      }),
    );

    expect(capturedConfig).toEqual(containerConfig);
  });

  it('passes config.container to ContainerExecutionBackend in validateClaudeCodeBackend', async () => {
    vi.resetModules();
    let capturedConfig: unknown;
    vi.doMock('../backends/container/index.js', () => ({
      ContainerExecutionBackend: class {
        readonly name = 'container';
        constructor(config?: unknown) {
          capturedConfig = config;
        }
        async available() {
          return true;
        }
      },
    }));
    const { validateClaudeCodeBackend } = await import('./index.js');
    const containerConfig = {
      runtime: 'podman' as const,
      image: 'node:lts-slim',
      memoryLimitMb: 512,
      cpuLimit: 1.0,
      networkMode: 'bridge' as const,
      mountClaudeConfig: true,
    };
    await validateClaudeCodeBackend(
      makeConfig({
        executionBackend: 'container',
        container: containerConfig,
      }),
    );

    expect(capturedConfig).toEqual(containerConfig);
  });

  it('creates ContainerExecutionBackend with undefined config when container section is absent', async () => {
    vi.resetModules();
    let capturedConfig: unknown = 'NOT_SET';
    vi.doMock('../backends/container/index.js', () => ({
      ContainerExecutionBackend: class {
        readonly name = 'container';
        constructor(config?: unknown) {
          capturedConfig = config;
        }
        async available() {
          return true;
        }
        resetAvailabilityCache() {}
        async getRuntimeInfo() {
          return null;
        }
      },
    }));
    const { createClaudeCodeProvider } = await import('./index.js');
    await createClaudeCodeProvider(makeConfig({ executionBackend: 'container' }));

    expect(capturedConfig).toBeUndefined();
  });
});
