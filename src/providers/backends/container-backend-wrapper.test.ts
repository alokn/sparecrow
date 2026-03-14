/** Unit tests for ContainerBackendWrapper — container backend wrapping with availability and recovery logging. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BackendExecutionOptions, BackendExecutionResult } from '../../types/index.js';

function makeOptions(): BackendExecutionOptions {
  return { timeoutMs: 30000 };
}

function makeResult(overrides: Partial<BackendExecutionResult> = {}): BackendExecutionResult {
  return {
    stdout: 'ok',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    aborted: false,
    oomKilled: false,
    ...overrides,
  };
}

function makePrimary(
  overrides: {
    available?: boolean;
    executeResult?: BackendExecutionResult;
    runtimeInfo?: { name: string; version: string } | null;
  } = {},
) {
  return {
    name: 'container' as const,
    available: vi.fn().mockResolvedValue(overrides.available ?? true),
    execute: vi.fn().mockResolvedValue(overrides.executeResult ?? makeResult()),
    resetAvailabilityCache: vi.fn(),
    getRuntimeInfo: vi
      .fn()
      .mockResolvedValue(
        'runtimeInfo' in overrides ? overrides.runtimeInfo : { name: 'docker', version: '27.1.0' },
      ),
  };
}

describe('ContainerBackendWrapper', () => {
  /** Mutable reference shared between beforeEach and the logger mock factory closure.
   * Using a function wrapper rather than storing the mock directly avoids TypeScript
   * inference issues with MockInstance's call signatures in the factory closure. */
  const loggerProxy = {
    info: (..._args: unknown[]): Promise<undefined> => Promise.resolve(undefined),
    warn: (..._args: unknown[]): Promise<undefined> => Promise.resolve(undefined),
  };
  let mockLoggerInfo: ReturnType<typeof vi.fn>;
  let mockLoggerWarn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    mockLoggerInfo = vi.fn().mockResolvedValue(undefined);
    mockLoggerWarn = vi.fn().mockResolvedValue(undefined);
    loggerProxy.info = mockLoggerInfo as typeof loggerProxy.info;
    loggerProxy.warn = mockLoggerWarn as typeof loggerProxy.warn;
    vi.doMock('../../utils/index.js', () => ({
      logger: {
        info: (...args: unknown[]) => loggerProxy.info(...args),
        warn: (...args: unknown[]) => loggerProxy.warn(...args),
        debug: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
      },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true from available() when primary backend is available', async () => {
    const { ContainerBackendWrapper } = await import('./container-backend-wrapper.js');
    const primary = makePrimary({ available: true });
    const backend = new ContainerBackendWrapper(primary as never);

    const result = await backend.available();
    expect(result).toBe(true);
  });

  it('returns false from available() when primary is unavailable', async () => {
    const { ContainerBackendWrapper } = await import('./container-backend-wrapper.js');
    const primary = makePrimary({ available: false });
    const backend = new ContainerBackendWrapper(primary as never);

    const result = await backend.available();
    expect(result).toBe(false);
  });

  it('delegates execute() to primary always', async () => {
    const { ContainerBackendWrapper } = await import('./container-backend-wrapper.js');
    const primary = makePrimary({ available: true });
    const backend = new ContainerBackendWrapper(primary as never);

    await backend.available();
    await backend.execute('claude', ['--print'], makeOptions());

    expect(primary.execute).toHaveBeenCalled();
  });

  it('detects runtime recovery and logs CONTAINER_RUNTIME_RECOVERED', async () => {
    const { ContainerBackendWrapper } = await import('./container-backend-wrapper.js');
    const primary = makePrimary({ available: false });
    const backend = new ContainerBackendWrapper(primary as never);

    // First call: unavailable
    await backend.available();

    // Second call: recovered
    primary.available.mockResolvedValue(true);
    await backend.available();
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      'container.runtime-recovered',
      expect.objectContaining({ message: expect.stringContaining('recovered') }),
    );
  });

  it('returns correct DaemonBackendState', async () => {
    const { ContainerBackendWrapper } = await import('./container-backend-wrapper.js');
    const primary = makePrimary({
      available: true,
      runtimeInfo: { name: 'docker', version: '27.1.0' },
    });
    const backend = new ContainerBackendWrapper(primary as never);

    // Available state
    await backend.available();
    let state = await backend.getBackendState();
    expect(state).toEqual({
      name: 'container',
      runtime: 'docker',
      version: '27.1.0',
      available: true,
    });

    // Unavailable state
    primary.available.mockResolvedValue(false);
    await backend.available();
    state = await backend.getBackendState();
    expect(state.available).toBe(false);
  });

  it('calls resetAvailabilityCache() on primary before each available() check', async () => {
    const { ContainerBackendWrapper } = await import('./container-backend-wrapper.js');
    const primary = makePrimary({ available: true });
    const backend = new ContainerBackendWrapper(primary as never);

    await backend.available();
    expect(primary.resetAvailabilityCache).toHaveBeenCalledTimes(1);

    await backend.available();
    expect(primary.resetAvailabilityCache).toHaveBeenCalledTimes(2);
  });

  it('logs CONTAINER_DISPATCH_SKIPPED warning when unavailable', async () => {
    const { ContainerBackendWrapper } = await import('./container-backend-wrapper.js');
    const primary = makePrimary({ available: false });
    const backend = new ContainerBackendWrapper(primary as never);

    await backend.available();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'container.dispatch-skipped',
      expect.objectContaining({ message: expect.stringContaining('dispatch skipped') }),
    );
  });

  it('logs CONTAINER_DISPATCH_SKIPPED on every consecutive unavailable cycle', async () => {
    const { ContainerBackendWrapper } = await import('./container-backend-wrapper.js');
    const primary = makePrimary({ available: false });
    const backend = new ContainerBackendWrapper(primary as never);

    await backend.available(); // cycle 1
    await backend.available(); // cycle 2
    await backend.available(); // cycle 3

    const skipCalls = (mockLoggerWarn.mock.calls as unknown[][]).filter(
      (c: unknown[]) => c[0] === 'container.dispatch-skipped',
    );
    expect(skipCalls).toHaveLength(3);
  });

  it('getBackendState() self-probes and returns accurate availability when available() has never been called (AC2)', async () => {
    const { ContainerBackendWrapper } = await import('./container-backend-wrapper.js');
    const primary = {
      name: 'container' as const,
      available: vi.fn().mockResolvedValue(true),
      execute: vi.fn().mockResolvedValue({}),
      resetAvailabilityCache: vi.fn(),
      getRuntimeInfo: vi.fn().mockResolvedValue({ name: 'docker', version: '27.1.0' }),
    };

    const backend = new ContainerBackendWrapper(primary as never);

    // Call getBackendState() WITHOUT calling available() first —
    // self-probe runs internally and returns the actual availability (AC2).
    const state = await backend.getBackendState();
    expect(state.available).toBe(true);
    expect(state.runtime).toBe('docker');
    expect(state.version).toBe('27.1.0');

    // Primary's available() was called by the internal _probe()
    expect(primary.available).toHaveBeenCalledTimes(1);
    expect(primary.resetAvailabilityCache).toHaveBeenCalledTimes(1);
  });

  it('getBackendState() self-probe does NOT emit CONTAINER_DISPATCH_SKIPPED event (AC4)', async () => {
    const { ContainerBackendWrapper } = await import('./container-backend-wrapper.js');
    const primary = makePrimary({ available: false });
    const backend = new ContainerBackendWrapper(primary as never);

    // Call getBackendState() without calling available() — self-probe runs internally
    // but must NOT emit CONTAINER_DISPATCH_SKIPPED (that is dispatch-specific).
    const state = await backend.getBackendState();
    expect(state.available).toBe(false);

    // No warn-level events should have been emitted
    const skipCalls = (mockLoggerWarn.mock.calls as unknown[][]).filter(
      (c: unknown[]) => c[0] === 'container.dispatch-skipped',
    );
    expect(skipCalls).toHaveLength(0);

    // No info-level recovery events either
    const recoveryCalls = (mockLoggerInfo.mock.calls as unknown[][]).filter(
      (c: unknown[]) => c[0] === 'container.runtime-recovered',
    );
    expect(recoveryCalls).toHaveLength(0);
  });

  it('available() still emits CONTAINER_DISPATCH_SKIPPED when unavailable (AC5 regression)', async () => {
    const { ContainerBackendWrapper } = await import('./container-backend-wrapper.js');
    const primary = makePrimary({ available: false });
    const backend = new ContainerBackendWrapper(primary as never);

    // available() must still emit the dispatch-specific warn event
    await backend.available();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'container.dispatch-skipped',
      expect.objectContaining({ message: expect.stringContaining('dispatch skipped') }),
    );
  });

  it('getBackendState() self-probe returns available: false when runtime is unavailable', async () => {
    const { ContainerBackendWrapper } = await import('./container-backend-wrapper.js');
    const primary = makePrimary({ available: false, runtimeInfo: null });
    const backend = new ContainerBackendWrapper(primary as never);

    // Without calling available() first, getBackendState() self-probes
    const state = await backend.getBackendState();
    expect(state.available).toBe(false);
    expect(state.runtime).toBeNull();
    expect(state.version).toBeNull();
  });

  it('getBackendState() does not re-probe when available() has already been called', async () => {
    const { ContainerBackendWrapper } = await import('./container-backend-wrapper.js');
    const primary = makePrimary({ available: true });
    const backend = new ContainerBackendWrapper(primary as never);

    // First call through available() — probes
    await backend.available();
    expect(primary.available).toHaveBeenCalledTimes(1);
    expect(primary.resetAvailabilityCache).toHaveBeenCalledTimes(1);

    // getBackendState() should NOT re-probe because _availabilityProbed is already true
    await backend.getBackendState();
    expect(primary.available).toHaveBeenCalledTimes(1);
    expect(primary.resetAvailabilityCache).toHaveBeenCalledTimes(1);
  });

  it('returns version: null from getBackendState() when getRuntimeInfo() returns null', async () => {
    const { ContainerBackendWrapper } = await import('./container-backend-wrapper.js');
    const primary = makePrimary({ available: true, runtimeInfo: null });
    const backend = new ContainerBackendWrapper(primary as never);

    await backend.available();
    const state = await backend.getBackendState();
    expect(state.runtime).toBeNull();
    expect(state.version).toBeNull();
  });

  it('has name "container"', async () => {
    const { ContainerBackendWrapper } = await import('./container-backend-wrapper.js');
    const primary = makePrimary();
    const backend = new ContainerBackendWrapper(primary as never);
    expect(backend.name).toBe('container');
  });

  it('returns correct getBackendState for unavailable', async () => {
    const { ContainerBackendWrapper } = await import('./container-backend-wrapper.js');
    const primary = makePrimary({ available: false });
    const backend = new ContainerBackendWrapper(primary as never);

    await backend.available();
    const state = await backend.getBackendState();
    expect(state.available).toBe(false);
  });

  it('throws BACKEND_NOT_AVAILABLE when primary lacks resetAvailabilityCache()', async () => {
    const { ContainerBackendWrapper } = await import('./container-backend-wrapper.js');
    const badPrimary = {
      name: 'container',
      available: vi.fn().mockResolvedValue(true),
      execute: vi.fn().mockResolvedValue({}),
      // Missing: resetAvailabilityCache and getRuntimeInfo
    };

    expect(() => new ContainerBackendWrapper(badPrimary as never)).toThrow(
      expect.objectContaining({ code: 'BACKEND_NOT_AVAILABLE' }),
    );
  });

  it('sets _availabilityProbed = true even when _primary.available() throws inside _probe()', async () => {
    // Finding 1/2: if available() throws, the flag must still be set so subsequent
    // getBackendState() calls do NOT retry _probe() indefinitely.
    const { ContainerBackendWrapper } = await import('./container-backend-wrapper.js');
    const primary = {
      name: 'container' as const,
      available: vi.fn().mockRejectedValue(new Error('runtime error')),
      execute: vi.fn().mockResolvedValue({}),
      resetAvailabilityCache: vi.fn(),
      getRuntimeInfo: vi.fn().mockResolvedValue(null),
    };

    const backend = new ContainerBackendWrapper(primary as never);

    // available() throws — _probe() should propagate the error
    await expect(backend.available()).rejects.toThrow('runtime error');

    // _availabilityProbed must now be true (set in finally), so getBackendState()
    // does NOT call _probe() again
    await backend.getBackendState();
    // primary.available was called exactly once (from the first available() call);
    // getBackendState() must NOT have called it again
    expect(primary.available).toHaveBeenCalledTimes(1);
    expect(primary.resetAvailabilityCache).toHaveBeenCalledTimes(1);
  });

  it('getBackendState() self-probe propagates throw from _primary.available()', async () => {
    // Finding 2: getBackendState() calls _probe() which calls _primary.available();
    // if that throws, the error must propagate (not be swallowed silently).
    const { ContainerBackendWrapper } = await import('./container-backend-wrapper.js');
    const primary = {
      name: 'container' as const,
      available: vi.fn().mockRejectedValue(new Error('docker not found')),
      execute: vi.fn().mockResolvedValue({}),
      resetAvailabilityCache: vi.fn(),
      getRuntimeInfo: vi.fn().mockResolvedValue(null),
    };

    const backend = new ContainerBackendWrapper(primary as never);

    // getBackendState() triggers self-probe — should propagate the throw
    await expect(backend.getBackendState()).rejects.toThrow('docker not found');
  });
});
