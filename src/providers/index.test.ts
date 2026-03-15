/** Unit tests for the provider registry factory. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ErrorCode } from '../errors/index.js';

/** Mock the container backend to always be available (no Docker/Podman required for unit tests). */
function mockContainerBackendAvailable() {
  vi.doMock('./backends/container/detect-runtime.js', () => ({
    detectContainerRuntime: vi.fn().mockResolvedValue({ name: 'docker', available: vi.fn() }),
  }));
}

/** Mock the container backend to be unavailable (no runtime found). */
function mockContainerBackendUnavailable() {
  vi.doMock('./backends/container/detect-runtime.js', () => ({
    detectContainerRuntime: vi.fn().mockResolvedValue(null),
  }));
}

describe('createProvider', () => {
  beforeEach(() => {
    vi.resetModules();
    mockContainerBackendAvailable();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a Promise that resolves to a provider bundle for claude-code', async () => {
    const { createProvider } = await import('./index.js');
    const provider = await createProvider('claude-code');
    expect(provider).toHaveProperty('usageMonitor');
    expect(provider).toHaveProperty('taskExecutor');
    expect(provider).toHaveProperty('authManager');
  });

  it('throws PROVIDER_NOT_FOUND for an unknown provider', async () => {
    const { createProvider } = await import('./index.js');
    await expect(createProvider('openai')).rejects.toMatchObject({
      code: ErrorCode.PROVIDER_NOT_FOUND,
    });
  });

  it('throws PROVIDER_NOT_FOUND for an empty provider name', async () => {
    const { createProvider } = await import('./index.js');
    await expect(createProvider('')).rejects.toMatchObject({
      code: ErrorCode.PROVIDER_NOT_FOUND,
    });
  });

  it('throws CONTAINER_RUNTIME_NOT_FOUND when container runtime is unavailable', async () => {
    vi.resetModules();
    mockContainerBackendUnavailable();
    const { createProvider } = await import('./index.js');
    await expect(
      createProvider('claude-code', {
        name: 'claude-code',
        allowDangerouslySkipPermissions: false,
        executionBackend: 'container',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.CONTAINER_RUNTIME_NOT_FOUND });
  });

  it('reuses provided authManager instance in claude-code provider', async () => {
    const { createProvider } = await import('./index.js');
    const { ClaudeCodeAuthManager } = await import('./claude-code/index.js');
    const authManager = new ClaudeCodeAuthManager();
    const provider = await createProvider('claude-code', undefined, { authManager });
    expect(provider.authManager).toBe(authManager);
  });

  it('discards options and creates provider successfully when options fail type guard (non-object value)', async () => {
    const { createProvider } = await import('./index.js');
    // A string is not a valid ClaudeCodeProviderOptions — guard returns false, options discarded.
    await expect(
      createProvider('claude-code', undefined, 'invalid-options'),
    ).resolves.toBeDefined();
  });
});

describe('validateProviderBackend', () => {
  beforeEach(() => {
    vi.resetModules();
    mockContainerBackendAvailable();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves without error for claude-code when container backend is available', async () => {
    const { validateProviderBackend } = await import('./index.js');
    await expect(validateProviderBackend('claude-code')).resolves.toBeUndefined();
  });

  it('resolves without error for claude-code when explicit config is provided', async () => {
    const { validateProviderBackend } = await import('./index.js');
    await expect(
      validateProviderBackend('claude-code', {
        name: 'claude-code',
        allowDangerouslySkipPermissions: false,
        executionBackend: 'container',
      }),
    ).resolves.toBeUndefined();
  });

  it('throws CONTAINER_RUNTIME_NOT_FOUND when container backend is unavailable', async () => {
    vi.resetModules();
    mockContainerBackendUnavailable();
    const { validateProviderBackend } = await import('./index.js');
    await expect(validateProviderBackend('claude-code')).rejects.toMatchObject({
      code: ErrorCode.CONTAINER_RUNTIME_NOT_FOUND,
    });
  });

  it('throws PROVIDER_NOT_FOUND for an unknown provider name', async () => {
    const { validateProviderBackend } = await import('./index.js');
    await expect(validateProviderBackend('openai')).rejects.toMatchObject({
      code: ErrorCode.PROVIDER_NOT_FOUND,
    });
  });
});
