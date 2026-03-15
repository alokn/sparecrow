/** Unit tests for ContainerExecutionBackend. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ContainerRuntime } from './runtime.js';
import type { BackendExecutionOptions } from '../../../types/index.js';
import { ErrorCode } from '../../../errors/index.js';
import { EventName } from '../../../types/index.js';

// Default mock runtime shape
function createMockRuntime(overrides: Partial<ContainerRuntime> = {}): ContainerRuntime {
  return {
    name: 'mock',
    available: vi.fn().mockResolvedValue(true),
    info: vi.fn().mockResolvedValue({ version: '1.0.0', rootless: true }),
    run: vi.fn().mockResolvedValue({ containerId: 'test-container-123' }),
    wait: vi.fn().mockResolvedValue({ exitCode: 0, oomKilled: false }),
    logs: vi.fn().mockResolvedValue({ stdout: 'output', stderr: '' }),
    remove: vi.fn().mockResolvedValue(undefined),
    stats: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

let ContainerExecutionBackend: typeof import('./container-backend.js').ContainerExecutionBackend;
let mockDetect: ReturnType<typeof vi.fn>;
let mockResolveCredentials: ReturnType<typeof vi.fn>;
let mockResolveBinaryMount: ReturnType<typeof vi.fn>;
let loggerInfoSpy: ReturnType<typeof vi.fn>;
let loggerWarnSpy: ReturnType<typeof vi.fn>;
let loggerDebugSpy: ReturnType<typeof vi.fn>;

/** Default credential resolver result: no credential files found, just HOME env. */
const defaultCredentials = { mounts: [], env: { HOME: '/root' } };

/** Registers the standard utils/index.js mock (logger + boundOutput + output byte limits).
 * Call this after vi.resetModules() and before importing the module under test.
 * Reuse this helper in any test that needs a fresh module scope but does not need
 * custom logger behaviour — avoids duplicating the inline mock object literal.
 */
function mockStandardUtilsModule(): void {
  vi.doMock('../../../utils/index.js', () => ({
    logger: {
      info: vi.fn().mockResolvedValue(undefined),
      warn: vi.fn().mockResolvedValue(undefined),
      error: vi.fn().mockResolvedValue(undefined),
      debug: vi.fn().mockResolvedValue(undefined),
    },
    boundOutput: realBoundOutput,
    MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
    MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
  }));
}

/** Real boundOutput implementation for use in mocks -- truncates to last maxBytes UTF-8-safe. */
function realBoundOutput(raw: string, maxBytes: number = 10 * 1024): string {
  if (Buffer.byteLength(raw, 'utf-8') <= maxBytes) return raw;
  const buf = Buffer.from(raw, 'utf-8');
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) {
    start++;
  }
  return buf.subarray(start).toString('utf-8');
}

const REAL_MAX_OUTPUT_BYTES = 10 * 1024;
const REAL_MAX_OUTPUT_BYTES_SUCCESS = 50 * 1024;

beforeEach(async () => {
  vi.resetModules();

  const mockRuntime = createMockRuntime();
  mockDetect = vi.fn().mockResolvedValue(mockRuntime);
  mockResolveCredentials = vi.fn().mockResolvedValue(defaultCredentials);

  vi.doMock('./detect-runtime.js', () => ({
    detectContainerRuntime: mockDetect,
  }));

  vi.doMock('./credential-resolver.js', () => ({
    resolveContainerCredentials: mockResolveCredentials,
  }));

  mockResolveBinaryMount = vi.fn().mockResolvedValue(null);
  vi.doMock('./binary-resolver.js', () => ({
    resolveBinaryMount: mockResolveBinaryMount,
  }));

  vi.doMock('../../../utils/index.js', () => {
    loggerInfoSpy = vi.fn().mockResolvedValue(undefined);
    loggerWarnSpy = vi.fn().mockResolvedValue(undefined);
    loggerDebugSpy = vi.fn().mockResolvedValue(undefined);
    return {
      logger: {
        info: loggerInfoSpy,
        warn: loggerWarnSpy,
        error: vi.fn().mockResolvedValue(undefined),
        debug: loggerDebugSpy,
      },
      boundOutput: realBoundOutput,
      MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
    };
  });

  const mod = await import('./container-backend.js');
  ContainerExecutionBackend = mod.ContainerExecutionBackend;
});

afterEach(() => {
  vi.restoreAllMocks();
  // Always restore real timers — any test that calls vi.useFakeTimers() is covered,
  // including tests inside nested describes that have their own afterEach.
  vi.useRealTimers();
});

function makeOptions(overrides: Partial<BackendExecutionOptions> = {}): BackendExecutionOptions {
  return {
    cwd: '/home/user/my-repo',
    timeoutMs: 60000,
    ...overrides,
  };
}

describe('ContainerExecutionBackend', () => {
  // 6.2: name returns 'container'
  it('returns "container" as the backend name', () => {
    const backend = new ContainerExecutionBackend();
    expect(backend.name).toBe('container');
  });

  // 6.3: available() returns true when runtime found
  it('returns true from available() when detectContainerRuntime() finds a runtime', async () => {
    const backend = new ContainerExecutionBackend();
    const result = await backend.available();
    expect(result).toBe(true);
    expect(mockDetect).toHaveBeenCalledTimes(1);
  });

  // 6.4: available() returns false when no runtime
  it('returns false from available() when detectContainerRuntime() returns null', async () => {
    vi.resetModules();
    mockDetect = vi.fn().mockResolvedValue(null);
    vi.doMock('./detect-runtime.js', () => ({
      detectContainerRuntime: mockDetect,
    }));
    vi.doMock('./credential-resolver.js', () => ({
      resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
    }));
    vi.doMock('./binary-resolver.js', () => ({
      resolveBinaryMount: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('../../../utils/index.js', () => ({
      logger: {
        info: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      boundOutput: realBoundOutput,
      MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
    }));
    const mod = await import('./container-backend.js');
    const backend = new mod.ContainerExecutionBackend();
    const result = await backend.available();
    expect(result).toBe(false);
    expect(mockDetect).toHaveBeenCalledTimes(1);
  });

  // 6.5: available() caches the runtime
  it('caches the detection result -- second call does not invoke detectContainerRuntime() again', async () => {
    const backend = new ContainerExecutionBackend();
    await backend.available();
    await backend.available();
    expect(mockDetect).toHaveBeenCalledTimes(1);
  });

  // 6.6: execute() throws BACKEND_NOT_AVAILABLE when no runtime
  it('throws ScrowError(BACKEND_NOT_AVAILABLE) from execute() when no runtime is detected', async () => {
    vi.resetModules();
    mockDetect = vi.fn().mockResolvedValue(null);
    vi.doMock('./detect-runtime.js', () => ({
      detectContainerRuntime: mockDetect,
    }));
    vi.doMock('./credential-resolver.js', () => ({
      resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
    }));
    vi.doMock('./binary-resolver.js', () => ({
      resolveBinaryMount: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('../../../utils/index.js', () => ({
      logger: {
        info: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      boundOutput: realBoundOutput,
      MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
    }));
    const mod = await import('./container-backend.js');
    const backend = new mod.ContainerExecutionBackend();
    await expect(
      backend.execute('claude', ['--print', 'test'], makeOptions()),
    ).rejects.toMatchObject({
      code: ErrorCode.BACKEND_NOT_AVAILABLE,
    });
  });

  // 6.7: execute() creates container with correct options
  it('creates container via runtime.run() with correct options', async () => {
    const mockRuntime = createMockRuntime();
    vi.resetModules();
    mockDetect = vi.fn().mockResolvedValue(mockRuntime);
    vi.doMock('./detect-runtime.js', () => ({
      detectContainerRuntime: mockDetect,
    }));
    vi.doMock('./credential-resolver.js', () => ({
      resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
    }));
    vi.doMock('./binary-resolver.js', () => ({
      resolveBinaryMount: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('../../../utils/index.js', () => ({
      logger: {
        info: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      boundOutput: realBoundOutput,
      MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
    }));
    const mod = await import('./container-backend.js');
    const backend = new mod.ContainerExecutionBackend();

    await backend.execute(
      'claude',
      ['--print', 'Fix the bug'],
      makeOptions({
        cwd: '/home/user/my-repo',
        env: { MY_VAR: 'value' },
      }),
    );

    expect(mockRuntime.run).toHaveBeenCalledTimes(1);
    const runArgs = (mockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(runArgs.image).toBe('node:lts-slim');
    expect(runArgs.command).toEqual(['claude', '--print', 'Fix the bug']);
    expect(runArgs.cwd).toBe('/workspace');
    // HOME is /home/node when running as non-root on default image (AC8 — node:lts-slim node user)
    const expectedHome = (process.getuid?.() ?? 0) !== 0 ? '/home/node' : '/root';
    expect(runArgs.env).toEqual({
      HOME: expectedHome,
      MY_VAR: 'value',
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    });
    expect(runArgs.mounts).toEqual([
      { source: '/home/user/my-repo', target: '/workspace', readonly: false },
    ]);
    expect(runArgs.labels).toEqual({ 'sparecrow.managed': 'true' });
    // --user flag must be present when getuid/getgid are available (AC8)
    const hostUid = process.getuid?.();
    const hostGid = process.getgid?.();
    if (hostUid !== undefined && hostGid !== undefined) {
      expect(runArgs.user).toBe(`${hostUid}:${hostGid}`);
    }
    // Security fields must be present (Task 7.3 -- test updated for new fields)
    expect(runArgs.capDrop).toEqual(['ALL']);
    expect(runArgs.memoryLimitMb).toBe(512);
    expect(runArgs.cpuLimit).toBe(1.0);
    expect(runArgs.networkMode).toBe('bridge');
    expect(runArgs.securityOpts).toEqual(['no-new-privileges']);
    expect(runArgs.tmpfsMounts).toEqual(['/tmp:nosuid,noexec']);
  });

  // 6.8: execute() waits with timeout
  it('waits for container with runtime.wait() and passes through timeoutMs', async () => {
    const mockRuntime = createMockRuntime();
    vi.resetModules();
    mockDetect = vi.fn().mockResolvedValue(mockRuntime);
    vi.doMock('./detect-runtime.js', () => ({
      detectContainerRuntime: mockDetect,
    }));
    vi.doMock('./credential-resolver.js', () => ({
      resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
    }));
    vi.doMock('./binary-resolver.js', () => ({
      resolveBinaryMount: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('../../../utils/index.js', () => ({
      logger: {
        info: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      boundOutput: realBoundOutput,
      MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
    }));
    const mod = await import('./container-backend.js');
    const backend = new mod.ContainerExecutionBackend();

    await backend.execute('claude', ['--print', 'test'], makeOptions({ timeoutMs: 30000 }));

    expect(mockRuntime.wait).toHaveBeenCalledWith('test-container-123', 30000);
  });

  // 6.9: execute() captures output via runtime.logs()
  it('captures output via runtime.logs() after wait completes', async () => {
    const mockRuntime = createMockRuntime({
      logs: vi.fn().mockResolvedValue({ stdout: 'hello world', stderr: 'some warning' }),
    });
    vi.resetModules();
    mockDetect = vi.fn().mockResolvedValue(mockRuntime);
    vi.doMock('./detect-runtime.js', () => ({
      detectContainerRuntime: mockDetect,
    }));
    vi.doMock('./credential-resolver.js', () => ({
      resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
    }));
    vi.doMock('./binary-resolver.js', () => ({
      resolveBinaryMount: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('../../../utils/index.js', () => ({
      logger: {
        info: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      boundOutput: realBoundOutput,
      MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
    }));
    const mod = await import('./container-backend.js');
    const backend = new mod.ContainerExecutionBackend();

    const result = await backend.execute('claude', ['--print', 'test'], makeOptions());

    expect(mockRuntime.logs).toHaveBeenCalledWith('test-container-123');
    expect(result.stdout).toBe('hello world');
    expect(result.stderr).toBe('some warning');
  });

  // 6.10: execute() removes container in finally
  it('removes container in finally block via runtime.remove()', async () => {
    const mockRuntime = createMockRuntime();
    vi.resetModules();
    mockDetect = vi.fn().mockResolvedValue(mockRuntime);
    vi.doMock('./detect-runtime.js', () => ({
      detectContainerRuntime: mockDetect,
    }));
    vi.doMock('./credential-resolver.js', () => ({
      resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
    }));
    vi.doMock('./binary-resolver.js', () => ({
      resolveBinaryMount: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('../../../utils/index.js', () => ({
      logger: {
        info: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      boundOutput: realBoundOutput,
      MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
    }));
    const mod = await import('./container-backend.js');
    const backend = new mod.ContainerExecutionBackend();

    await backend.execute('claude', ['--print', 'test'], makeOptions());

    expect(mockRuntime.remove).toHaveBeenCalledWith('test-container-123');
  });

  // 6.11: execute() removes container even on error
  it('removes container even when runtime.wait throws a non-timeout error', async () => {
    const mockRuntime = createMockRuntime({
      wait: vi.fn().mockRejectedValue(new Error('unexpected error')),
    });
    vi.resetModules();
    mockDetect = vi.fn().mockResolvedValue(mockRuntime);
    vi.doMock('./detect-runtime.js', () => ({
      detectContainerRuntime: mockDetect,
    }));
    vi.doMock('./credential-resolver.js', () => ({
      resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
    }));
    vi.doMock('./binary-resolver.js', () => ({
      resolveBinaryMount: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('../../../utils/index.js', () => ({
      logger: {
        info: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      boundOutput: realBoundOutput,
      MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
    }));
    const mod = await import('./container-backend.js');
    const backend = new mod.ContainerExecutionBackend();

    await expect(backend.execute('claude', ['--print', 'test'], makeOptions())).rejects.toThrow(
      'unexpected error',
    );
    expect(mockRuntime.remove).toHaveBeenCalledWith('test-container-123');
  });

  // M4 fix: runtime.logs() must NOT be called on the non-timeout error re-throw path
  it('does not call runtime.logs() when runtime.wait() throws a non-timeout error', async () => {
    const mockRuntime = createMockRuntime({
      wait: vi.fn().mockRejectedValue(new Error('network failure')),
    });
    vi.resetModules();
    mockDetect = vi.fn().mockResolvedValue(mockRuntime);
    vi.doMock('./detect-runtime.js', () => ({
      detectContainerRuntime: mockDetect,
    }));
    vi.doMock('./credential-resolver.js', () => ({
      resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
    }));
    vi.doMock('./binary-resolver.js', () => ({
      resolveBinaryMount: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('../../../utils/index.js', () => ({
      logger: {
        info: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      boundOutput: realBoundOutput,
      MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
    }));
    const mod = await import('./container-backend.js');
    const backend = new mod.ContainerExecutionBackend();

    await expect(backend.execute('claude', ['--print', 'test'], makeOptions())).rejects.toThrow(
      'network failure',
    );
    // The non-timeout error re-throw path must NOT attempt to call runtime.logs()
    // (the container state is unknown; calling logs() could add noise or fail)
    expect(mockRuntime.logs).not.toHaveBeenCalled();
  });

  // 6.12: execute() handles timeout
  it('catches ScrowError(TASK_TIMEOUT), captures partial logs, returns timedOut: true', async () => {
    vi.resetModules();
    // Import ScrowError from the same module context as the re-imported container-backend
    const { ScrowError: FreshScrowError, ErrorCode: FreshErrorCode } =
      await import('../../../errors/index.js');
    const mockRuntime = createMockRuntime({
      wait: vi
        .fn()
        .mockRejectedValue(new FreshScrowError(FreshErrorCode.TASK_TIMEOUT, 'timed out')),
      logs: vi.fn().mockResolvedValue({ stdout: 'partial output', stderr: 'partial err' }),
    });
    mockDetect = vi.fn().mockResolvedValue(mockRuntime);
    vi.doMock('./detect-runtime.js', () => ({
      detectContainerRuntime: mockDetect,
    }));
    vi.doMock('./credential-resolver.js', () => ({
      resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
    }));
    vi.doMock('./binary-resolver.js', () => ({
      resolveBinaryMount: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('../../../utils/index.js', () => ({
      logger: {
        info: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      boundOutput: realBoundOutput,
      MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
    }));
    const mod = await import('./container-backend.js');
    const backend = new mod.ContainerExecutionBackend();

    const result = await backend.execute('claude', ['--print', 'test'], makeOptions());

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.aborted).toBe(false);
    expect(result.stdout).toBe('partial output');
    expect(result.stderr).toBe('partial err');
  });

  // 6.13: execute() removes container after timeout
  it('removes container in finally block after timeout', async () => {
    vi.resetModules();
    const { ScrowError: FreshScrowError, ErrorCode: FreshErrorCode } =
      await import('../../../errors/index.js');
    const mockRuntime = createMockRuntime({
      wait: vi
        .fn()
        .mockRejectedValue(new FreshScrowError(FreshErrorCode.TASK_TIMEOUT, 'timed out')),
    });
    mockDetect = vi.fn().mockResolvedValue(mockRuntime);
    vi.doMock('./detect-runtime.js', () => ({
      detectContainerRuntime: mockDetect,
    }));
    vi.doMock('./credential-resolver.js', () => ({
      resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
    }));
    vi.doMock('./binary-resolver.js', () => ({
      resolveBinaryMount: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('../../../utils/index.js', () => ({
      logger: {
        info: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      boundOutput: realBoundOutput,
      MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
    }));
    const mod = await import('./container-backend.js');
    const backend = new mod.ContainerExecutionBackend();

    await backend.execute('claude', ['--print', 'test'], makeOptions());

    expect(mockRuntime.remove).toHaveBeenCalledWith('test-container-123');
  });

  // 6.14: execute() handles abort — uses fake timers to avoid real-time flake risk
  it('returns aborted: true when signal fires during wait', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const mockRuntime = createMockRuntime({
        wait: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              // Simulate: abort fires at t=10, wait resolves at t=50
              setTimeout(() => {
                controller.abort();
              }, 10);
              setTimeout(() => {
                resolve({ exitCode: null, oomKilled: false });
              }, 50);
            }),
        ),
      });
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      const executePromise = backend.execute(
        'claude',
        ['--print', 'test'],
        makeOptions({
          signal: controller.signal,
          healthCheckIntervalMs: 0,
        }),
      );

      // Advance time: fire abort at 10ms, then resolve wait at 50ms
      await vi.advanceTimersByTimeAsync(100);

      const result = await executePromise;

      expect(result.aborted).toBe(true);
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBeNull();
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  // 6.15: abort listener removed after execution
  it('removes abort listener after execution completes', async () => {
    const controller = new AbortController();
    const removeListenerSpy = vi.spyOn(controller.signal, 'removeEventListener');
    const mockRuntime = createMockRuntime();
    vi.resetModules();
    mockDetect = vi.fn().mockResolvedValue(mockRuntime);
    vi.doMock('./detect-runtime.js', () => ({
      detectContainerRuntime: mockDetect,
    }));
    vi.doMock('./credential-resolver.js', () => ({
      resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
    }));
    vi.doMock('./binary-resolver.js', () => ({
      resolveBinaryMount: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('../../../utils/index.js', () => ({
      logger: {
        info: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      boundOutput: realBoundOutput,
      MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
    }));
    const mod = await import('./container-backend.js');
    const backend = new mod.ContainerExecutionBackend();

    await backend.execute(
      'claude',
      ['--print', 'test'],
      makeOptions({
        signal: controller.signal,
      }),
    );

    expect(removeListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  // 6.16: clean env with provided env + PATH added
  it('builds env from options.env and adds PATH when not present', async () => {
    const mockRuntime = createMockRuntime();
    vi.resetModules();
    mockDetect = vi.fn().mockResolvedValue(mockRuntime);
    vi.doMock('./detect-runtime.js', () => ({
      detectContainerRuntime: mockDetect,
    }));
    vi.doMock('./credential-resolver.js', () => ({
      resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
    }));
    vi.doMock('./binary-resolver.js', () => ({
      resolveBinaryMount: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('../../../utils/index.js', () => ({
      logger: {
        info: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      boundOutput: realBoundOutput,
      MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
    }));
    const mod = await import('./container-backend.js');
    const backend = new mod.ContainerExecutionBackend();

    await backend.execute(
      'claude',
      ['--print', 'test'],
      makeOptions({
        env: { NODE_ENV: 'test', CUSTOM: 'val' },
      }),
    );

    const runArgs = (mockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    // HOME is /home/node when running as non-root on default image (AC8 — node:lts-slim node user)
    const expectedHome = (process.getuid?.() ?? 0) !== 0 ? '/home/node' : '/root';
    expect(runArgs.env).toEqual({
      HOME: expectedHome,
      NODE_ENV: 'test',
      CUSTOM: 'val',
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    });
  });

  // 6.17: clean env when no env provided — only PATH
  it('sets only PATH in container env when options.env is undefined', async () => {
    const mockRuntime = createMockRuntime();
    vi.resetModules();
    mockDetect = vi.fn().mockResolvedValue(mockRuntime);
    vi.doMock('./detect-runtime.js', () => ({
      detectContainerRuntime: mockDetect,
    }));
    vi.doMock('./credential-resolver.js', () => ({
      resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
    }));
    vi.doMock('./binary-resolver.js', () => ({
      resolveBinaryMount: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('../../../utils/index.js', () => ({
      logger: {
        info: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      boundOutput: realBoundOutput,
      MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
    }));
    const mod = await import('./container-backend.js');
    const backend = new mod.ContainerExecutionBackend();

    await backend.execute('claude', ['--print', 'test'], makeOptions());

    const runArgs = (mockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    // HOME is /home/node when running as non-root on default image (AC8 — node:lts-slim node user)
    const expectedHome = (process.getuid?.() ?? 0) !== 0 ? '/home/node' : '/root';
    expect(runArgs.env).toEqual({
      HOME: expectedHome,
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    });
  });

  // 6.18: env includes PATH — not overridden
  it('does not override PATH when options.env already includes it', async () => {
    const mockRuntime = createMockRuntime();
    vi.resetModules();
    mockDetect = vi.fn().mockResolvedValue(mockRuntime);
    vi.doMock('./detect-runtime.js', () => ({
      detectContainerRuntime: mockDetect,
    }));
    vi.doMock('./credential-resolver.js', () => ({
      resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
    }));
    vi.doMock('./binary-resolver.js', () => ({
      resolveBinaryMount: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('../../../utils/index.js', () => ({
      logger: {
        info: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      boundOutput: realBoundOutput,
      MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
    }));
    const mod = await import('./container-backend.js');
    const backend = new mod.ContainerExecutionBackend();

    await backend.execute(
      'claude',
      ['--print', 'test'],
      makeOptions({
        env: { PATH: '/custom/path' },
      }),
    );

    const runArgs = (mockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(runArgs.env.PATH).toBe('/custom/path');
  });

  // 6.19: mounts options.cwd to /workspace read-write
  it('mounts options.cwd to /workspace read-write', async () => {
    const mockRuntime = createMockRuntime();
    vi.resetModules();
    mockDetect = vi.fn().mockResolvedValue(mockRuntime);
    vi.doMock('./detect-runtime.js', () => ({
      detectContainerRuntime: mockDetect,
    }));
    vi.doMock('./credential-resolver.js', () => ({
      resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
    }));
    vi.doMock('./binary-resolver.js', () => ({
      resolveBinaryMount: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('../../../utils/index.js', () => ({
      logger: {
        info: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      boundOutput: realBoundOutput,
      MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
    }));
    const mod = await import('./container-backend.js');
    const backend = new mod.ContainerExecutionBackend();

    await backend.execute(
      'claude',
      ['--print', 'test'],
      makeOptions({
        cwd: '/some/repo',
      }),
    );

    const runArgs = (mockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(runArgs.mounts).toEqual([
      { source: '/some/repo', target: '/workspace', readonly: false },
    ]);
  });

  // 6.20: uses process.cwd() when options.cwd is undefined
  it('uses process.cwd() when options.cwd is undefined', async () => {
    const mockRuntime = createMockRuntime();
    vi.resetModules();
    mockDetect = vi.fn().mockResolvedValue(mockRuntime);
    vi.doMock('./detect-runtime.js', () => ({
      detectContainerRuntime: mockDetect,
    }));
    vi.doMock('./credential-resolver.js', () => ({
      resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
    }));
    vi.doMock('./binary-resolver.js', () => ({
      resolveBinaryMount: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('../../../utils/index.js', () => ({
      logger: {
        info: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      boundOutput: realBoundOutput,
      MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
    }));
    const mod = await import('./container-backend.js');
    const backend = new mod.ContainerExecutionBackend();

    await backend.execute('claude', ['--print', 'test'], {
      timeoutMs: 60000,
      // cwd intentionally omitted
    });

    const runArgs = (mockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(runArgs.mounts[0].source).toBe(process.cwd());
  });

  // 6.21: logs container.task-started at info level
  it('logs container.task-started at info level', async () => {
    const backend = new ContainerExecutionBackend();
    await backend.execute('claude', ['--print', 'test'], makeOptions());

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      EventName.CONTAINER_TASK_STARTED,
      expect.objectContaining({
        containerId: 'test-container-123',
        image: 'node:lts-slim',
      }),
    );
  });

  // 6.22: logs container.task-completed at info level
  it('logs container.task-completed at info level', async () => {
    const backend = new ContainerExecutionBackend();
    await backend.execute('claude', ['--print', 'test'], makeOptions());

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      EventName.CONTAINER_TASK_COMPLETED,
      expect.objectContaining({
        containerId: 'test-container-123',
        exitCode: 0,
        timedOut: false,
        aborted: false,
      }),
    );
  });

  // 6.23: timeoutMs: 0 passes 0 to runtime.wait()
  it('passes timeoutMs: 0 to runtime.wait() for no-timeout semantics', async () => {
    const mockRuntime = createMockRuntime();
    vi.resetModules();
    mockDetect = vi.fn().mockResolvedValue(mockRuntime);
    vi.doMock('./detect-runtime.js', () => ({
      detectContainerRuntime: mockDetect,
    }));
    vi.doMock('./credential-resolver.js', () => ({
      resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
    }));
    vi.doMock('./binary-resolver.js', () => ({
      resolveBinaryMount: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('../../../utils/index.js', () => ({
      logger: {
        info: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      boundOutput: realBoundOutput,
      MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
    }));
    const mod = await import('./container-backend.js');
    const backend = new mod.ContainerExecutionBackend();

    await backend.execute('claude', ['--print', 'test'], makeOptions({ timeoutMs: 0 }));

    expect(mockRuntime.wait).toHaveBeenCalledWith('test-container-123', 0);
  });

  // 6.24: swallows runtime.remove() errors in finally
  it('swallows runtime.remove() errors in finally block and logs warning', async () => {
    const mockRuntime = createMockRuntime({
      remove: vi.fn().mockRejectedValue(new Error('remove failed')),
    });
    vi.resetModules();
    mockDetect = vi.fn().mockResolvedValue(mockRuntime);
    vi.doMock('./detect-runtime.js', () => ({
      detectContainerRuntime: mockDetect,
    }));
    vi.doMock('./credential-resolver.js', () => ({
      resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
    }));
    vi.doMock('./binary-resolver.js', () => ({
      resolveBinaryMount: vi.fn().mockResolvedValue(null),
    }));
    const localWarnSpy = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../../../utils/index.js', () => ({
      logger: {
        info: vi.fn().mockResolvedValue(undefined),
        warn: localWarnSpy,
        error: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      boundOutput: realBoundOutput,
      MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
    }));
    const mod = await import('./container-backend.js');
    const backend = new mod.ContainerExecutionBackend();

    // Should not throw even though remove fails
    const result = await backend.execute('claude', ['--print', 'test'], makeOptions());
    expect(result.exitCode).toBe(0);
    expect(localWarnSpy).toHaveBeenCalledWith(
      EventName.CONTAINER_REMOVE_FAILED,
      expect.objectContaining({
        containerId: 'test-container-123',
        error: 'remove failed',
      }),
    );
  });

  // 6.25: swallows runtime.logs() errors in timeout catch path
  it('swallows runtime.logs() errors in timeout catch path and returns empty strings', async () => {
    vi.resetModules();
    const { ScrowError: FreshScrowError, ErrorCode: FreshErrorCode } =
      await import('../../../errors/index.js');
    const mockRuntime = createMockRuntime({
      wait: vi
        .fn()
        .mockRejectedValue(new FreshScrowError(FreshErrorCode.TASK_TIMEOUT, 'timed out')),
      logs: vi.fn().mockRejectedValue(new Error('logs failed')),
    });
    mockDetect = vi.fn().mockResolvedValue(mockRuntime);
    vi.doMock('./detect-runtime.js', () => ({
      detectContainerRuntime: mockDetect,
    }));
    vi.doMock('./credential-resolver.js', () => ({
      resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
    }));
    vi.doMock('./binary-resolver.js', () => ({
      resolveBinaryMount: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('../../../utils/index.js', () => ({
      logger: {
        info: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      boundOutput: realBoundOutput,
      MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
    }));
    const mod = await import('./container-backend.js');
    const backend = new mod.ContainerExecutionBackend();

    const result = await backend.execute('claude', ['--print', 'test'], makeOptions());

    expect(result.timedOut).toBe(true);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  // 6.26: constructor accepts custom image
  it('creates container with custom image when provided to constructor', async () => {
    const mockRuntime = createMockRuntime();
    vi.resetModules();
    mockDetect = vi.fn().mockResolvedValue(mockRuntime);
    vi.doMock('./detect-runtime.js', () => ({
      detectContainerRuntime: mockDetect,
    }));
    vi.doMock('./credential-resolver.js', () => ({
      resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
    }));
    vi.doMock('./binary-resolver.js', () => ({
      resolveBinaryMount: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('../../../utils/index.js', () => ({
      logger: {
        info: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      boundOutput: realBoundOutput,
      MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
    }));
    const mod = await import('./container-backend.js');
    const backend = new mod.ContainerExecutionBackend({
      runtime: 'auto',
      image: 'ubuntu:22.04',
      memoryLimitMb: 512,
      cpuLimit: 1.0,
      networkMode: 'bridge',
      mountClaudeConfig: true,
    });

    await backend.execute('claude', ['--print', 'test'], makeOptions());

    const runArgs = (mockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(runArgs.image).toBe('ubuntu:22.04');
  });

  // 6.27: constructor uses default image 'node:lts-slim'
  it('uses default image node:lts-slim when no image provided', async () => {
    const mockRuntime = createMockRuntime();
    vi.resetModules();
    mockDetect = vi.fn().mockResolvedValue(mockRuntime);
    vi.doMock('./detect-runtime.js', () => ({
      detectContainerRuntime: mockDetect,
    }));
    vi.doMock('./credential-resolver.js', () => ({
      resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
    }));
    vi.doMock('./binary-resolver.js', () => ({
      resolveBinaryMount: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('../../../utils/index.js', () => ({
      logger: {
        info: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      boundOutput: realBoundOutput,
      MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
    }));
    const mod = await import('./container-backend.js');
    const backend = new mod.ContainerExecutionBackend();

    await backend.execute('claude', ['--print', 'test'], makeOptions());

    const runArgs = (mockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(runArgs.image).toBe('node:lts-slim');
  });

  // 6.28: pre-aborted signal returns immediately, no container created
  it('returns aborted: true immediately when signal is already aborted -- no container created', async () => {
    const controller = new AbortController();
    controller.abort();
    const mockRuntime = createMockRuntime();
    vi.resetModules();
    mockDetect = vi.fn().mockResolvedValue(mockRuntime);
    vi.doMock('./detect-runtime.js', () => ({
      detectContainerRuntime: mockDetect,
    }));
    vi.doMock('./credential-resolver.js', () => ({
      resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
    }));
    vi.doMock('./binary-resolver.js', () => ({
      resolveBinaryMount: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('../../../utils/index.js', () => ({
      logger: {
        info: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      boundOutput: realBoundOutput,
      MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
    }));
    const mod = await import('./container-backend.js');
    const backend = new mod.ContainerExecutionBackend();

    const result = await backend.execute(
      'claude',
      ['--print', 'test'],
      makeOptions({
        signal: controller.signal,
      }),
    );

    expect(result).toEqual({
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: false,
      aborted: true,
      oomKilled: false,
    });
    expect(mockRuntime.run).not.toHaveBeenCalled();
  });

  // 6.29: OOM kill surfaces as non-zero exit code
  it('propagates exitCode: 137 from OOM kill (oomKilled: true) without swallowing', async () => {
    const mockRuntime = createMockRuntime({
      wait: vi.fn().mockResolvedValue({ exitCode: 137, oomKilled: true }),
      logs: vi.fn().mockResolvedValue({ stdout: 'oom output', stderr: 'killed' }),
    });
    vi.resetModules();
    mockDetect = vi.fn().mockResolvedValue(mockRuntime);
    vi.doMock('./detect-runtime.js', () => ({
      detectContainerRuntime: mockDetect,
    }));
    vi.doMock('./credential-resolver.js', () => ({
      resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
    }));
    vi.doMock('./binary-resolver.js', () => ({
      resolveBinaryMount: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('../../../utils/index.js', () => ({
      logger: {
        info: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      boundOutput: realBoundOutput,
      MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
    }));
    const mod = await import('./container-backend.js');
    const backend = new mod.ContainerExecutionBackend();

    const result = await backend.execute('claude', ['--print', 'test'], makeOptions());

    expect(result.exitCode).toBe(137);
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
    expect(result.stdout).toBe('oom output');
    expect(result.stderr).toBe('killed');
  });

  // Story 10.11 AC1: oomKilled: true propagated through execute() result
  it('returns oomKilled: true in result when runtime reports OOM kill', async () => {
    const mockRuntime = createMockRuntime({
      wait: vi.fn().mockResolvedValue({ exitCode: 137, oomKilled: true }),
      logs: vi.fn().mockResolvedValue({ stdout: 'oom output', stderr: 'killed' }),
    });
    vi.resetModules();
    mockDetect = vi.fn().mockResolvedValue(mockRuntime);
    vi.doMock('./detect-runtime.js', () => ({
      detectContainerRuntime: mockDetect,
    }));
    vi.doMock('./credential-resolver.js', () => ({
      resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
    }));
    vi.doMock('./binary-resolver.js', () => ({
      resolveBinaryMount: vi.fn().mockResolvedValue(null),
    }));
    const localWarnSpy = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../../../utils/index.js', () => ({
      logger: {
        info: vi.fn().mockResolvedValue(undefined),
        warn: localWarnSpy,
        error: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      boundOutput: realBoundOutput,
      MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
    }));
    const mod = await import('./container-backend.js');
    const backend = new mod.ContainerExecutionBackend();

    const result = await backend.execute('claude', ['--print', 'test'], makeOptions());

    expect(result.oomKilled).toBe(true);
    expect(result.exitCode).toBe(137);
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
    // Assert the CONTAINER_OOM_KILLED warn event was emitted (side-effect coverage)
    const oomWarnCall = localWarnSpy.mock.calls.find(
      (call: unknown[]) => call[0] === EventName.CONTAINER_OOM_KILLED,
    );
    expect(oomWarnCall).toBeDefined();
  });

  // Story 10.11 AC1: oomKilled: false for normal exits
  it('returns oomKilled: false in result when runtime reports no OOM kill', async () => {
    const mockRuntime = createMockRuntime({
      wait: vi.fn().mockResolvedValue({ exitCode: 0, oomKilled: false }),
      logs: vi.fn().mockResolvedValue({ stdout: 'success', stderr: '' }),
    });
    vi.resetModules();
    mockDetect = vi.fn().mockResolvedValue(mockRuntime);
    vi.doMock('./detect-runtime.js', () => ({
      detectContainerRuntime: mockDetect,
    }));
    vi.doMock('./credential-resolver.js', () => ({
      resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
    }));
    vi.doMock('./binary-resolver.js', () => ({
      resolveBinaryMount: vi.fn().mockResolvedValue(null),
    }));
    const localWarnSpy = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../../../utils/index.js', () => ({
      logger: {
        info: vi.fn().mockResolvedValue(undefined),
        warn: localWarnSpy,
        error: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      boundOutput: realBoundOutput,
      MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
    }));
    const mod = await import('./container-backend.js');
    const backend = new mod.ContainerExecutionBackend();

    const result = await backend.execute('claude', ['--print', 'test'], makeOptions());

    expect(result.oomKilled).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
    // Assert the CONTAINER_OOM_KILLED warn event was NOT emitted for non-OOM exits
    const oomWarnCall = localWarnSpy.mock.calls.find(
      (call: unknown[]) => call[0] === EventName.CONTAINER_OOM_KILLED,
    );
    expect(oomWarnCall).toBeUndefined();
  });

  // 6.30: concurrent available() calls — detectContainerRuntime invoked exactly once
  it('invokes detectContainerRuntime exactly once when available() is called concurrently', async () => {
    // Use a delayed detection to ensure both calls are in-flight
    let resolveDetection: (value: ContainerRuntime) => void;
    const delayedDetection = new Promise<ContainerRuntime>((resolve) => {
      resolveDetection = resolve;
    });

    vi.resetModules();
    const concurrentDetect = vi.fn().mockReturnValue(delayedDetection);
    vi.doMock('./detect-runtime.js', () => ({
      detectContainerRuntime: concurrentDetect,
    }));
    vi.doMock('./credential-resolver.js', () => ({
      resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
    }));
    vi.doMock('./binary-resolver.js', () => ({
      resolveBinaryMount: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('../../../utils/index.js', () => ({
      logger: {
        info: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      boundOutput: realBoundOutput,
      MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
    }));
    const mod = await import('./container-backend.js');
    const backend = new mod.ContainerExecutionBackend();

    // Fire two calls without awaiting
    const promise1 = backend.available();
    const promise2 = backend.available();

    // Resolve the detection
    resolveDetection!(createMockRuntime());

    const [result1, result2] = await Promise.all([promise1, promise2]);

    expect(result1).toBe(true);
    expect(result2).toBe(true);
    expect(concurrentDetect).toHaveBeenCalledTimes(1);
  });

  // M2: execute() on fresh instance without prior available() call — covers the _runtimeDetection null-guard inside execute()
  it('detects runtime inside execute() when available() was never called', async () => {
    // Fresh backend — _runtimeDetection is null, so execute() must trigger detection itself
    const backend = new ContainerExecutionBackend();

    const result = await backend.execute('claude', ['--print', 'test'], makeOptions());

    // detection was triggered inside execute()
    expect(mockDetect).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(0);
  });

  // M3: runtime.remove() rejects with a plain string (not an Error instance) — covers String(e) else-branch
  it('handles runtime.remove() rejection with a plain string value', async () => {
    const mockRuntime = createMockRuntime({
      remove: vi.fn().mockRejectedValue('plain string error'),
    });
    vi.resetModules();
    mockDetect = vi.fn().mockResolvedValue(mockRuntime);
    vi.doMock('./detect-runtime.js', () => ({
      detectContainerRuntime: mockDetect,
    }));
    vi.doMock('./credential-resolver.js', () => ({
      resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
    }));
    vi.doMock('./binary-resolver.js', () => ({
      resolveBinaryMount: vi.fn().mockResolvedValue(null),
    }));
    const localWarnSpy = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../../../utils/index.js', () => ({
      logger: {
        info: vi.fn().mockResolvedValue(undefined),
        warn: localWarnSpy,
        error: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      boundOutput: realBoundOutput,
      MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
    }));
    const mod = await import('./container-backend.js');
    const backend = new mod.ContainerExecutionBackend();

    // Should not throw even though remove fails with a plain string
    const result = await backend.execute('claude', ['--print', 'test'], makeOptions());
    expect(result.exitCode).toBe(0);
    expect(localWarnSpy).toHaveBeenCalledWith(
      EventName.CONTAINER_REMOVE_FAILED,
      expect.objectContaining({
        containerId: 'test-container-123',
        error: 'plain string error',
      }),
    );
  });

  // L1: healthCheckIntervalMs is intentionally not forwarded to the container runtime
  it('does not forward healthCheckIntervalMs to runtime.run() options', async () => {
    const mockRuntime = createMockRuntime();
    vi.resetModules();
    mockDetect = vi.fn().mockResolvedValue(mockRuntime);
    vi.doMock('./detect-runtime.js', () => ({
      detectContainerRuntime: mockDetect,
    }));
    vi.doMock('./credential-resolver.js', () => ({
      resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
    }));
    vi.doMock('./binary-resolver.js', () => ({
      resolveBinaryMount: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('../../../utils/index.js', () => ({
      logger: {
        info: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      boundOutput: realBoundOutput,
      MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
    }));
    const mod = await import('./container-backend.js');
    const backend = new mod.ContainerExecutionBackend();

    await backend.execute(
      'claude',
      ['--print', 'test'],
      makeOptions({ healthCheckIntervalMs: 5000 }),
    );

    const runArgs = (mockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    // healthCheckIntervalMs must NOT be present in ContainerRunOptions
    expect(runArgs).not.toHaveProperty('healthCheckIntervalMs');
  });

  // --- Credential mounting integration tests (Story 11.4) ---

  // 6.2: execute() calls resolveContainerCredentials() and includes returned mounts
  it('calls resolveContainerCredentials() and includes returned mounts in ContainerRunOptions', async () => {
    const credentialMounts = [
      {
        source: '/home/user/.claude/.credentials.json',
        target: '/root/.claude/.credentials.json',
        readonly: false,
      },
      {
        source: '/home/user/.claude/settings.json',
        target: '/root/.claude/settings.json',
        readonly: true,
      },
    ];
    const mockRuntime = createMockRuntime();
    vi.resetModules();
    mockDetect = vi.fn().mockResolvedValue(mockRuntime);
    const localResolveCredentials = vi.fn().mockResolvedValue({
      mounts: credentialMounts,
      env: { HOME: '/root' },
    });
    vi.doMock('./detect-runtime.js', () => ({
      detectContainerRuntime: mockDetect,
    }));
    vi.doMock('./credential-resolver.js', () => ({
      resolveContainerCredentials: localResolveCredentials,
    }));
    vi.doMock('./binary-resolver.js', () => ({
      resolveBinaryMount: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('../../../utils/index.js', () => ({
      logger: {
        info: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      boundOutput: realBoundOutput,
      MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
    }));
    const mod = await import('./container-backend.js');
    const backend = new mod.ContainerExecutionBackend();

    await backend.execute('claude', ['--print', 'test'], makeOptions());

    expect(localResolveCredentials).toHaveBeenCalledTimes(1);
    const runArgs = (mockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    // Workspace mount first, then credential mounts
    expect(runArgs.mounts).toHaveLength(3);
    expect(runArgs.mounts[1]).toEqual(credentialMounts[0]);
    expect(runArgs.mounts[2]).toEqual(credentialMounts[1]);
  });

  // 6.3: execute() merges credential env (HOME) into container env
  it('merges credential resolver env (HOME) into container env', async () => {
    const mockRuntime = createMockRuntime();
    vi.resetModules();
    mockDetect = vi.fn().mockResolvedValue(mockRuntime);
    vi.doMock('./detect-runtime.js', () => ({
      detectContainerRuntime: mockDetect,
    }));
    vi.doMock('./credential-resolver.js', () => ({
      resolveContainerCredentials: vi.fn().mockResolvedValue({
        mounts: [],
        env: { HOME: '/root' },
      }),
    }));
    vi.doMock('./binary-resolver.js', () => ({
      resolveBinaryMount: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('../../../utils/index.js', () => ({
      logger: {
        info: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      boundOutput: realBoundOutput,
      MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
    }));
    const mod = await import('./container-backend.js');
    const backend = new mod.ContainerExecutionBackend();

    await backend.execute('claude', ['--print', 'test'], makeOptions());

    const runArgs = (mockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    // HOME is /home/node when running as non-root on default image (AC8 — node:lts-slim node user)
    const expectedHome = (process.getuid?.() ?? 0) !== 0 ? '/home/node' : '/root';
    expect(runArgs.env.HOME).toBe(expectedHome);
  });

  // 6.4: caller-provided env vars take precedence over credential resolver env
  it('gives precedence to caller-provided env vars over credential resolver env', async () => {
    const mockRuntime = createMockRuntime();
    vi.resetModules();
    mockDetect = vi.fn().mockResolvedValue(mockRuntime);
    vi.doMock('./detect-runtime.js', () => ({
      detectContainerRuntime: mockDetect,
    }));
    vi.doMock('./credential-resolver.js', () => ({
      resolveContainerCredentials: vi.fn().mockResolvedValue({
        mounts: [],
        env: { HOME: '/root' },
      }),
    }));
    vi.doMock('./binary-resolver.js', () => ({
      resolveBinaryMount: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('../../../utils/index.js', () => ({
      logger: {
        info: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      boundOutput: realBoundOutput,
      MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
    }));
    const mod = await import('./container-backend.js');
    const backend = new mod.ContainerExecutionBackend();

    await backend.execute(
      'claude',
      ['--print', 'test'],
      makeOptions({ env: { HOME: '/home/custom' } }),
    );

    const runArgs = (mockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(runArgs.env.HOME).toBe('/home/custom');
  });

  // 6.5: caller-provided ANTHROPIC_API_KEY is preserved
  it('preserves caller-provided ANTHROPIC_API_KEY in container env', async () => {
    const mockRuntime = createMockRuntime();
    vi.resetModules();
    mockDetect = vi.fn().mockResolvedValue(mockRuntime);
    vi.doMock('./detect-runtime.js', () => ({
      detectContainerRuntime: mockDetect,
    }));
    vi.doMock('./credential-resolver.js', () => ({
      resolveContainerCredentials: vi.fn().mockResolvedValue({
        mounts: [],
        env: { HOME: '/root' },
      }),
    }));
    vi.doMock('./binary-resolver.js', () => ({
      resolveBinaryMount: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('../../../utils/index.js', () => ({
      logger: {
        info: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      boundOutput: realBoundOutput,
      MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
    }));
    const mod = await import('./container-backend.js');
    const backend = new mod.ContainerExecutionBackend();

    await backend.execute(
      'claude',
      ['--print', 'test'],
      makeOptions({ env: { ANTHROPIC_API_KEY: 'sk-test-key-123' } }),
    );

    const runArgs = (mockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(runArgs.env.ANTHROPIC_API_KEY).toBe('sk-test-key-123');
  });

  // 6.6: credential mounts are appended after workspace mount
  it('appends credential mounts after the workspace mount', async () => {
    const credentialMounts = [
      {
        source: '/home/user/.claude/.credentials.json',
        target: '/root/.claude/.credentials.json',
        readonly: false,
      },
    ];
    const mockRuntime = createMockRuntime();
    vi.resetModules();
    mockDetect = vi.fn().mockResolvedValue(mockRuntime);
    vi.doMock('./detect-runtime.js', () => ({
      detectContainerRuntime: mockDetect,
    }));
    vi.doMock('./credential-resolver.js', () => ({
      resolveContainerCredentials: vi.fn().mockResolvedValue({
        mounts: credentialMounts,
        env: { HOME: '/root' },
      }),
    }));
    vi.doMock('./binary-resolver.js', () => ({
      resolveBinaryMount: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('../../../utils/index.js', () => ({
      logger: {
        info: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      boundOutput: realBoundOutput,
      MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
    }));
    const mod = await import('./container-backend.js');
    const backend = new mod.ContainerExecutionBackend();

    await backend.execute('claude', ['--print', 'test'], makeOptions({ cwd: '/some/repo' }));

    const runArgs = (mockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(runArgs.mounts[0]).toEqual({
      source: '/some/repo',
      target: '/workspace',
      readonly: false,
    });
    expect(runArgs.mounts[1]).toEqual(credentialMounts[0]);
  });

  // 6.7: no credential files + no API key => proceeds + logs warning
  it('proceeds without error and logs CONTAINER_CREDENTIALS_MISSING when no credentials available', async () => {
    const mockRuntime = createMockRuntime();
    vi.resetModules();
    mockDetect = vi.fn().mockResolvedValue(mockRuntime);
    vi.doMock('./detect-runtime.js', () => ({
      detectContainerRuntime: mockDetect,
    }));
    vi.doMock('./credential-resolver.js', () => ({
      resolveContainerCredentials: vi.fn().mockResolvedValue({
        mounts: [],
        env: { HOME: '/root' },
      }),
    }));
    vi.doMock('./binary-resolver.js', () => ({
      resolveBinaryMount: vi.fn().mockResolvedValue(null),
    }));
    const localWarnSpy = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../../../utils/index.js', () => ({
      logger: {
        info: vi.fn().mockResolvedValue(undefined),
        warn: localWarnSpy,
        error: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      boundOutput: realBoundOutput,
      MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
    }));
    const mod = await import('./container-backend.js');
    const backend = new mod.ContainerExecutionBackend();

    // Should not throw
    const result = await backend.execute('claude', ['--print', 'test'], makeOptions());

    expect(result.exitCode).toBe(0);
    expect(localWarnSpy).toHaveBeenCalledWith(
      EventName.CONTAINER_CREDENTIALS_MISSING,
      expect.objectContaining({
        expectedPath: '~/.claude/.credentials.json',
      }),
    );
  });

  // 6.7b: only .claude.json mount (no .claude/ dir mount) + no API key => warns CONTAINER_CREDENTIALS_MISSING
  // Verifies that the hasCredentialMount check correctly distinguishes the config-file-only mount
  // from a real credential mount — a .claude.json-only result must NOT suppress the warning.
  it('warns CONTAINER_CREDENTIALS_MISSING when only .claude.json mount is present and no API key', async () => {
    const mockRuntime = createMockRuntime();
    vi.resetModules();
    mockDetect = vi.fn().mockResolvedValue(mockRuntime);
    vi.doMock('./detect-runtime.js', () => ({
      detectContainerRuntime: mockDetect,
    }));
    vi.doMock('./credential-resolver.js', () => ({
      resolveContainerCredentials: vi.fn().mockResolvedValue({
        // Only .claude.json file mount — no .claude/ directory mount (no real credentials)
        mounts: [
          { source: '/home/testuser/.claude.json', target: '/root/.claude.json', readonly: false },
        ],
        env: { HOME: '/root' },
      }),
    }));
    vi.doMock('./binary-resolver.js', () => ({
      resolveBinaryMount: vi.fn().mockResolvedValue(null),
    }));
    const localWarnSpy = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../../../utils/index.js', () => ({
      logger: {
        info: vi.fn().mockResolvedValue(undefined),
        warn: localWarnSpy,
        error: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      boundOutput: realBoundOutput,
      MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
    }));
    const mod = await import('./container-backend.js');
    const backend = new mod.ContainerExecutionBackend();

    const result = await backend.execute('claude', ['--print', 'test'], makeOptions());

    expect(result.exitCode).toBe(0);
    expect(localWarnSpy).toHaveBeenCalledWith(
      EventName.CONTAINER_CREDENTIALS_MISSING,
      expect.objectContaining({
        expectedPath: '~/.claude/.credentials.json',
      }),
    );
  });

  // 6.8: CONTAINER_CREDENTIALS_RESOLVED is logged during execution
  it('logs CONTAINER_CREDENTIALS_RESOLVED during execution', async () => {
    const backend = new ContainerExecutionBackend();
    await backend.execute('claude', ['--print', 'test'], makeOptions());

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      EventName.CONTAINER_CREDENTIALS_RESOLVED,
      expect.objectContaining({
        credentialMountsAdded: expect.any(Number),
        homeSetByResolver: expect.any(Boolean),
      }),
    );
  });

  // --- Security hardening tests (Story 11.5, Task 5) ---
  describe('security hardening', () => {
    // 5.2: capDrop: ['ALL']
    it("passes capDrop: ['ALL'] in ContainerRunOptions to runtime.run()", async () => {
      const mockRuntime = createMockRuntime();
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      await backend.execute('claude', ['--print', 'test'], makeOptions());

      const runArgs = (mockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(runArgs.capDrop).toEqual(['ALL']);
    });

    // 5.3: memoryLimitMb: 512
    it('passes memoryLimitMb: 512 in ContainerRunOptions to runtime.run()', async () => {
      const mockRuntime = createMockRuntime();
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      await backend.execute('claude', ['--print', 'test'], makeOptions());

      const runArgs = (mockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(runArgs.memoryLimitMb).toBe(512);
    });

    // 5.4: cpuLimit: 1.0
    it('passes cpuLimit: 1.0 in ContainerRunOptions to runtime.run()', async () => {
      const mockRuntime = createMockRuntime();
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      await backend.execute('claude', ['--print', 'test'], makeOptions());

      const runArgs = (mockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(runArgs.cpuLimit).toBe(1.0);
    });

    // 5.5: tmpfsMounts: ['/tmp:nosuid,noexec']
    it("passes tmpfsMounts: ['/tmp:nosuid,noexec'] in ContainerRunOptions to runtime.run()", async () => {
      const mockRuntime = createMockRuntime();
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      await backend.execute('claude', ['--print', 'test'], makeOptions());

      const runArgs = (mockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(runArgs.tmpfsMounts).toEqual(['/tmp:nosuid,noexec']);
    });

    // 5.6: networkMode: 'bridge'
    it("passes networkMode: 'bridge' in ContainerRunOptions to runtime.run()", async () => {
      const mockRuntime = createMockRuntime();
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      await backend.execute('claude', ['--print', 'test'], makeOptions());

      const runArgs = (mockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(runArgs.networkMode).toBe('bridge');
    });

    // 5.7: securityOpts: ['no-new-privileges']
    it("passes securityOpts: ['no-new-privileges'] in ContainerRunOptions to runtime.run()", async () => {
      const mockRuntime = createMockRuntime();
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      await backend.execute('claude', ['--print', 'test'], makeOptions());

      const runArgs = (mockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(runArgs.securityOpts).toEqual(['no-new-privileges']);
    });

    // 5.8: all 6 security fields present in a single execute() call
    it('includes all 6 security fields in a single execute() call', async () => {
      const mockRuntime = createMockRuntime();
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      await backend.execute('claude', ['--print', 'test'], makeOptions());

      const runArgs = (mockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(runArgs).toEqual(
        expect.objectContaining({
          memoryLimitMb: 512,
          cpuLimit: 1.0,
          networkMode: 'bridge',
          capDrop: ['ALL'],
          securityOpts: ['no-new-privileges'],
          tmpfsMounts: ['/tmp:nosuid,noexec'],
        }),
      );
    });

    // 5.9: security fields coexist with existing fields
    it('sets security fields alongside existing fields (image, command, cwd, env, mounts, labels)', async () => {
      const mockRuntime = createMockRuntime();
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      await backend.execute(
        'claude',
        ['--print', 'Fix bug'],
        makeOptions({ cwd: '/my/repo', env: { MY_VAR: 'val' } }),
      );

      const runArgs = (mockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      // Existing fields still present
      expect(runArgs.image).toBe('node:lts-slim');
      expect(runArgs.command).toEqual(['claude', '--print', 'Fix bug']);
      expect(runArgs.cwd).toBe('/workspace');
      expect(runArgs.env).toEqual(
        expect.objectContaining({ MY_VAR: 'val', PATH: expect.any(String) }),
      );
      expect(runArgs.mounts[0]).toEqual({
        source: '/my/repo',
        target: '/workspace',
        readonly: false,
      });
      // Security fields also present
      expect(runArgs.memoryLimitMb).toBe(512);
      expect(runArgs.cpuLimit).toBe(1.0);
      expect(runArgs.networkMode).toBe('bridge');
      expect(runArgs.capDrop).toEqual(['ALL']);
      expect(runArgs.securityOpts).toEqual(['no-new-privileges']);
      expect(runArgs.tmpfsMounts).toEqual(['/tmp:nosuid,noexec']);
    });

    // 5.10: labels still contain sparecrow.managed when security fields are present
    it('preserves sparecrow.managed label when security fields are present', async () => {
      const mockRuntime = createMockRuntime();
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      await backend.execute('claude', ['--print', 'test'], makeOptions());

      const runArgs = (mockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(runArgs.labels).toEqual({ 'sparecrow.managed': 'true' });
      // Security fields also present alongside labels
      expect(runArgs.capDrop).toEqual(['ALL']);
      expect(runArgs.securityOpts).toEqual(['no-new-privileges']);
    });
  });

  // H3: security constant arrays are not mutated across consecutive execute() calls
  it('security constant arrays remain unchanged after a consumer mutates the capDrop array received from execute()', async () => {
    const mockRuntime = createMockRuntime();
    vi.resetModules();
    mockDetect = vi.fn().mockResolvedValue(mockRuntime);
    vi.doMock('./detect-runtime.js', () => ({
      detectContainerRuntime: mockDetect,
    }));
    vi.doMock('./credential-resolver.js', () => ({
      resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
    }));
    vi.doMock('./binary-resolver.js', () => ({
      resolveBinaryMount: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('../../../utils/index.js', () => ({
      logger: {
        info: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
      },
      boundOutput: realBoundOutput,
      MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
    }));
    const mod = await import('./container-backend.js');
    const backend = new mod.ContainerExecutionBackend();

    // First call — get the runOptions and mutate capDrop
    await backend.execute('claude', ['--print', 'first'], makeOptions());
    const firstRunArgs = (mockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    // Simulate a consumer mutating the array they received
    (firstRunArgs.capDrop as string[]).push('NET_ADMIN');

    // Second call — capDrop must still be ['ALL'], not ['ALL', 'NET_ADMIN']
    await backend.execute('claude', ['--print', 'second'], makeOptions());
    const secondRunArgs = (mockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[1]![0];
    expect(secondRunArgs.capDrop).toEqual(['ALL']);
    expect(secondRunArgs.securityOpts).toEqual(['no-new-privileges']);
    expect(secondRunArgs.tmpfsMounts).toEqual(['/tmp:nosuid,noexec']);
  });

  // --- OOM kill detection tests (Story 11.5, Task 6) ---
  describe('OOM kill detection', () => {
    // 6.2: OOM kill logs CONTAINER_OOM_KILLED at warn level
    it('logs CONTAINER_OOM_KILLED at warn level when runtime.wait() returns oomKilled: true', async () => {
      const mockRuntime = createMockRuntime({
        wait: vi.fn().mockResolvedValue({ exitCode: 137, oomKilled: true }),
        logs: vi.fn().mockResolvedValue({ stdout: 'oom output', stderr: 'killed' }),
      });
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      const localWarnSpy = vi.fn().mockResolvedValue(undefined);
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: localWarnSpy,
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      await backend.execute('claude', ['--print', 'test'], makeOptions());

      expect(localWarnSpy).toHaveBeenCalledWith(
        EventName.CONTAINER_OOM_KILLED,
        expect.objectContaining({
          containerId: 'test-container-123',
          memoryLimitMb: 512,
        }),
      );
    });

    // 6.3: OOM warning log includes containerId and memoryLimitMb from config (not hardcoded constant)
    // Uses a non-default memoryLimitMb (256) so the test distinguishes config wiring from the constant (512)
    it('includes containerId and config-wired memoryLimitMb in the OOM warning log', async () => {
      const mockRuntime = createMockRuntime({
        wait: vi.fn().mockResolvedValue({ exitCode: 137, oomKilled: true }),
        logs: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      });
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      const localWarnSpy = vi.fn().mockResolvedValue(undefined);
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: localWarnSpy,
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      // Use a non-default memoryLimitMb (256 ≠ 512 constant) to verify config value flows into OOM log
      const backend = new mod.ContainerExecutionBackend({
        memoryLimitMb: 256,
        runtime: 'auto',
        image: 'node:lts-slim',
        cpuLimit: 1.0,
        networkMode: 'bridge',
        mountClaudeConfig: true,
      });

      await backend.execute('claude', ['--print', 'test'], makeOptions());

      const oomCall = localWarnSpy.mock.calls.find(
        (call: unknown[]) => call[0] === EventName.CONTAINER_OOM_KILLED,
      );
      expect(oomCall).toBeDefined();
      expect(oomCall![1].containerId).toBe('test-container-123');
      expect(oomCall![1].memoryLimitMb).toBe(256);
      expect(oomCall![1].message).toContain('test-container-123');
      expect(oomCall![1].message).toContain('256');
    });

    // 6.4: OOM kill result has correct shape
    it('returns correct result shape when oomKilled is true (exitCode: 137, timedOut: false, aborted: false)', async () => {
      const mockRuntime = createMockRuntime({
        wait: vi.fn().mockResolvedValue({ exitCode: 137, oomKilled: true }),
        logs: vi.fn().mockResolvedValue({ stdout: 'partial out', stderr: 'oom err' }),
      });
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      const result = await backend.execute('claude', ['--print', 'test'], makeOptions());

      expect(result.exitCode).toBe(137);
      expect(result.stdout).toBe('partial out');
      expect(result.stderr).toBe('oom err');
      expect(result.timedOut).toBe(false);
      expect(result.aborted).toBe(false);
    });

    // 6.5: normal exit (exitCode: 0, oomKilled: false) does not log OOM warning
    it('does not log OOM warning when oomKilled is false and exitCode is 0', async () => {
      const mockRuntime = createMockRuntime({
        wait: vi.fn().mockResolvedValue({ exitCode: 0, oomKilled: false }),
      });
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      const localWarnSpy = vi.fn().mockResolvedValue(undefined);
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: localWarnSpy,
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      await backend.execute('claude', ['--print', 'test'], makeOptions());

      const oomCalls = localWarnSpy.mock.calls.filter(
        (call: unknown[]) => call[0] === EventName.CONTAINER_OOM_KILLED,
      );
      expect(oomCalls).toHaveLength(0);
    });

    // 6.6: non-zero exit (exitCode: 1, oomKilled: false) does not log OOM warning
    it('does not log OOM warning when oomKilled is false and exitCode is 1', async () => {
      const mockRuntime = createMockRuntime({
        wait: vi.fn().mockResolvedValue({ exitCode: 1, oomKilled: false }),
      });
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      const localWarnSpy = vi.fn().mockResolvedValue(undefined);
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: localWarnSpy,
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      await backend.execute('claude', ['--print', 'test'], makeOptions());

      const oomCalls = localWarnSpy.mock.calls.filter(
        (call: unknown[]) => call[0] === EventName.CONTAINER_OOM_KILLED,
      );
      expect(oomCalls).toHaveLength(0);
    });

    // 6.7: OOM kill still calls runtime.logs() for output capture
    it('calls runtime.logs() when oomKilled is true and populates stdout/stderr', async () => {
      const mockLogs = vi.fn().mockResolvedValue({ stdout: 'oom stdout', stderr: 'oom stderr' });
      const mockRuntime = createMockRuntime({
        wait: vi.fn().mockResolvedValue({ exitCode: 137, oomKilled: true }),
        logs: mockLogs,
      });
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      const result = await backend.execute('claude', ['--print', 'test'], makeOptions());

      expect(mockLogs).toHaveBeenCalledWith('test-container-123');
      expect(result.stdout).toBe('oom stdout');
      expect(result.stderr).toBe('oom stderr');
    });

    // 6.8: abort path skips OOM detection
    it('does not log CONTAINER_OOM_KILLED when execution is aborted even if oomKilled would be true', async () => {
      vi.useFakeTimers();
      try {
        const controller = new AbortController();
        const mockRuntime = createMockRuntime({
          wait: vi.fn().mockImplementation(
            () =>
              new Promise((resolve) => {
                // Simulate: abort fires at t=10, wait resolves at t=50 with oomKilled: true
                setTimeout(() => {
                  controller.abort();
                }, 10);
                setTimeout(() => {
                  resolve({ exitCode: 137, oomKilled: true });
                }, 50);
              }),
          ),
        });

        vi.resetModules();
        mockDetect = vi.fn().mockResolvedValue(mockRuntime);
        vi.doMock('./detect-runtime.js', () => ({
          detectContainerRuntime: mockDetect,
        }));
        vi.doMock('./credential-resolver.js', () => ({
          resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
        }));
        vi.doMock('./binary-resolver.js', () => ({
          resolveBinaryMount: vi.fn().mockResolvedValue(null),
        }));
        const localWarnSpy = vi.fn().mockResolvedValue(undefined);
        vi.doMock('../../../utils/index.js', () => ({
          logger: {
            info: vi.fn().mockResolvedValue(undefined),
            warn: localWarnSpy,
            error: vi.fn().mockResolvedValue(undefined),
            debug: vi.fn().mockResolvedValue(undefined),
          },
          boundOutput: realBoundOutput,
          MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
          MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
        }));
        const mod = await import('./container-backend.js');
        const backend = new mod.ContainerExecutionBackend();

        const executePromise = backend.execute(
          'claude',
          ['--print', 'test'],
          makeOptions({ signal: controller.signal, healthCheckIntervalMs: 0 }),
        );

        await vi.advanceTimersByTimeAsync(100);
        const result = await executePromise;

        expect(result.aborted).toBe(true);

        const oomCalls = localWarnSpy.mock.calls.filter(
          (call: unknown[]) => call[0] === EventName.CONTAINER_OOM_KILLED,
        );
        expect(oomCalls).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // --- Container health monitoring tests (Story 11.6, Task 7) ---
  describe('container health monitoring', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    // 7.2: when healthCheckIntervalMs > 0, runtime.stats() is called at least once
    it('calls runtime.stats() at least once when healthCheckIntervalMs > 0', async () => {
      vi.useFakeTimers();
      const mockRuntime = createMockRuntime({
        stats: vi
          .fn()
          .mockResolvedValue({ cpuPercent: 5.0, memoryUsageMb: 100, memoryLimitMb: 512 }),
        wait: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve({ exitCode: 0, oomKilled: false }), 200);
            }),
        ),
      });
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      const executePromise = backend.execute(
        'claude',
        ['--print', 'test'],
        makeOptions({ healthCheckIntervalMs: 100 }),
      );

      // Advance to fire at least one health check (at 100ms), then resolve wait at 200ms
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(100);
      await executePromise;

      expect(mockRuntime.stats).toHaveBeenCalled();
    });

    // 7.3: when healthCheckIntervalMs is 0, runtime.stats() is never called
    it('does not call runtime.stats() when healthCheckIntervalMs is 0', async () => {
      const mockRuntime = createMockRuntime({
        stats: vi
          .fn()
          .mockResolvedValue({ cpuPercent: 5.0, memoryUsageMb: 100, memoryLimitMb: 512 }),
      });
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      await backend.execute(
        'claude',
        ['--print', 'test'],
        makeOptions({ healthCheckIntervalMs: 0 }),
      );

      expect(mockRuntime.stats).not.toHaveBeenCalled();
    });

    // 7.4: when healthCheckIntervalMs is not provided, monitoring uses default 60000ms
    it('starts monitoring with default 60000ms interval when healthCheckIntervalMs is not provided', async () => {
      vi.useFakeTimers();
      const mockRuntime = createMockRuntime({
        stats: vi
          .fn()
          .mockResolvedValue({ cpuPercent: 5.0, memoryUsageMb: 100, memoryLimitMb: 512 }),
        wait: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve({ exitCode: 0, oomKilled: false }), 120_000);
            }),
        ),
      });
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      const executePromise = backend.execute(
        'claude',
        ['--print', 'test'],
        makeOptions(), // no healthCheckIntervalMs
      );

      // At t=59999 -- stats should not have been called yet
      await vi.advanceTimersByTimeAsync(59_999);
      expect(mockRuntime.stats).not.toHaveBeenCalled();

      // At t=60000 -- first health check fires
      await vi.advanceTimersByTimeAsync(1);
      expect(mockRuntime.stats).toHaveBeenCalledTimes(1);

      // Resolve wait
      await vi.advanceTimersByTimeAsync(60_000);
      await executePromise;
    });

    // 7.5: after 2 consecutive idle checks, CONTAINER_HEALTH_IDLE warning is logged
    it('logs CONTAINER_HEALTH_IDLE warning after 2 consecutive idle checks (cpuPercent: 0.0)', async () => {
      vi.useFakeTimers();
      const localWarnSpy = vi.fn().mockResolvedValue(undefined);
      const mockRuntime = createMockRuntime({
        stats: vi
          .fn()
          .mockResolvedValue({ cpuPercent: 0.0, memoryUsageMb: 200, memoryLimitMb: 512 }),
        wait: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve({ exitCode: 0, oomKilled: false }), 500);
            }),
        ),
      });
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: localWarnSpy,
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      const executePromise = backend.execute(
        'claude',
        ['--print', 'test'],
        makeOptions({ healthCheckIntervalMs: 100 }),
      );

      // First idle check at t=100
      await vi.advanceTimersByTimeAsync(100);
      // Second idle check at t=200 -- should trigger warning
      await vi.advanceTimersByTimeAsync(100);

      // Resolve wait
      await vi.advanceTimersByTimeAsync(300);
      await executePromise;

      const idleCalls = localWarnSpy.mock.calls.filter(
        (call: unknown[]) => call[0] === EventName.CONTAINER_HEALTH_IDLE,
      );
      expect(idleCalls).toHaveLength(1);
      expect(idleCalls[0]![1]).toMatchObject({
        containerId: 'test-container-123',
        consecutiveIdleChecks: 2,
        memoryUsageMb: 200,
        memoryLimitMb: 512,
      });
      expect(idleCalls[0]![1].idleDurationMs).toBeGreaterThan(0);
    });

    // 7.6: idle warning is emitted only once
    it('emits idle warning only once after threshold -- subsequent idle checks do not re-emit', async () => {
      vi.useFakeTimers();
      const localWarnSpy = vi.fn().mockResolvedValue(undefined);
      const mockRuntime = createMockRuntime({
        stats: vi
          .fn()
          .mockResolvedValue({ cpuPercent: 0.0, memoryUsageMb: 200, memoryLimitMb: 512 }),
        wait: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve({ exitCode: 0, oomKilled: false }), 600);
            }),
        ),
      });
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: localWarnSpy,
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      const executePromise = backend.execute(
        'claude',
        ['--print', 'test'],
        makeOptions({ healthCheckIntervalMs: 100 }),
      );

      // Fire 5 idle checks
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(100);
      }

      // Resolve wait
      await vi.advanceTimersByTimeAsync(100);
      await executePromise;

      const idleCalls = localWarnSpy.mock.calls.filter(
        (call: unknown[]) => call[0] === EventName.CONTAINER_HEALTH_IDLE,
      );
      expect(idleCalls).toHaveLength(1);
    });

    // 7.7: a non-idle check resets the idle counter
    it('resets idle counter after a non-idle check -- no warning after a single subsequent idle check', async () => {
      vi.useFakeTimers();
      const localWarnSpy = vi.fn().mockResolvedValue(undefined);
      let callCount = 0;
      const mockRuntime = createMockRuntime({
        stats: vi.fn().mockImplementation(() => {
          callCount++;
          // First check: idle, second check: active, third check: idle
          if (callCount === 1)
            return Promise.resolve({ cpuPercent: 0.0, memoryUsageMb: 200, memoryLimitMb: 512 });
          if (callCount === 2)
            return Promise.resolve({ cpuPercent: 5.0, memoryUsageMb: 200, memoryLimitMb: 512 });
          return Promise.resolve({ cpuPercent: 0.0, memoryUsageMb: 200, memoryLimitMb: 512 });
        }),
        wait: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              // Resolve right after the 3rd check to prevent additional checks
              setTimeout(() => resolve({ exitCode: 0, oomKilled: false }), 350);
            }),
        ),
      });
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: localWarnSpy,
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      const executePromise = backend.execute(
        'claude',
        ['--print', 'test'],
        makeOptions({ healthCheckIntervalMs: 100 }),
      );

      // Three checks: idle(t=100), active(t=200), idle(t=300) -- only 1 consecutive idle so no warning
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(100);

      // Resolve wait at t=350
      await vi.advanceTimersByTimeAsync(50);
      await executePromise;

      const idleCalls = localWarnSpy.mock.calls.filter(
        (call: unknown[]) => call[0] === EventName.CONTAINER_HEALTH_IDLE,
      );
      expect(idleCalls).toHaveLength(0);
    });

    // M3 fix: full cycle idle→idle(warning)→active→idle→idle verifies idleWarningEmitted resets
    it('emits second idle warning after active check resets idleWarningEmitted flag', async () => {
      vi.useFakeTimers();
      const localWarnSpy = vi.fn().mockResolvedValue(undefined);
      let callCount = 0;
      const mockRuntime = createMockRuntime({
        stats: vi.fn().mockImplementation(() => {
          callCount++;
          // checks 1,2: idle → warning fires, idleWarningEmitted=true
          // check 3: active → resets idleWarningEmitted=false
          // checks 4,5: idle → second warning must fire
          if (callCount <= 2)
            return Promise.resolve({ cpuPercent: 0.0, memoryUsageMb: 200, memoryLimitMb: 512 });
          if (callCount === 3)
            return Promise.resolve({ cpuPercent: 5.0, memoryUsageMb: 200, memoryLimitMb: 512 });
          return Promise.resolve({ cpuPercent: 0.0, memoryUsageMb: 200, memoryLimitMb: 512 });
        }),
        wait: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve({ exitCode: 0, oomKilled: false }), 550);
            }),
        ),
      });
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: localWarnSpy,
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      const executePromise = backend.execute(
        'claude',
        ['--print', 'test'],
        makeOptions({ healthCheckIntervalMs: 100 }),
      );

      // t=100: idle check 1 (consecutiveIdleChecks=1)
      await vi.advanceTimersByTimeAsync(100);
      // t=200: idle check 2 (consecutiveIdleChecks=2, warning fires, idleWarningEmitted=true)
      await vi.advanceTimersByTimeAsync(100);
      // t=300: active check (reset: consecutiveIdleChecks=0, idleWarningEmitted=false)
      await vi.advanceTimersByTimeAsync(100);
      // t=400: idle check 4 (consecutiveIdleChecks=1)
      await vi.advanceTimersByTimeAsync(100);
      // t=500: idle check 5 (consecutiveIdleChecks=2, second warning must fire)
      await vi.advanceTimersByTimeAsync(100);

      // Resolve wait at t=550
      await vi.advanceTimersByTimeAsync(50);
      await executePromise;

      const idleCalls = localWarnSpy.mock.calls.filter(
        (call: unknown[]) => call[0] === EventName.CONTAINER_HEALTH_IDLE,
      );
      // Two separate idle-warning events: first after checks 1+2, second after checks 4+5
      expect(idleCalls).toHaveLength(2);
    });

    // 7.8: health monitoring is stopped in the finally block
    it('stops health monitoring after execute() resolves -- runtime.stats() is not called further', async () => {
      vi.useFakeTimers();
      const mockRuntime = createMockRuntime({
        stats: vi
          .fn()
          .mockResolvedValue({ cpuPercent: 5.0, memoryUsageMb: 100, memoryLimitMb: 512 }),
        wait: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve({ exitCode: 0, oomKilled: false }), 150);
            }),
        ),
      });
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      const executePromise = backend.execute(
        'claude',
        ['--print', 'test'],
        makeOptions({ healthCheckIntervalMs: 100 }),
      );

      // One health check fires at t=100
      await vi.advanceTimersByTimeAsync(100);
      // Wait completes at t=150
      await vi.advanceTimersByTimeAsync(50);
      await executePromise;

      const callsAfterResolve = (mockRuntime.stats as ReturnType<typeof vi.fn>).mock.calls.length;

      // Advance timers well past another interval -- no additional stats calls should happen
      await vi.advanceTimersByTimeAsync(500);

      expect((mockRuntime.stats as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
        callsAfterResolve,
      );
    });

    // 7.9: when runtime.stats() returns null, the check treats it as idle (counts toward threshold)
    it('treats null stats return as idle (cpuPercent unavailable)', async () => {
      vi.useFakeTimers();
      const localWarnSpy = vi.fn().mockResolvedValue(undefined);
      const mockRuntime = createMockRuntime({
        stats: vi.fn().mockResolvedValue(null),
        wait: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              // Resolve before the 2nd health check to ensure only 1 idle check fires
              setTimeout(() => resolve({ exitCode: 0, oomKilled: false }), 150);
            }),
        ),
      });
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: localWarnSpy,
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      const executePromise = backend.execute(
        'claude',
        ['--print', 'test'],
        makeOptions({ healthCheckIntervalMs: 100 }),
      );

      // One null stats return at t=100 — counts as idle (consecutiveIdleChecks reaches 1)
      await vi.advanceTimersByTimeAsync(100);
      // Verify stats was called exactly once — proves null was processed, not ignored
      expect((mockRuntime.stats as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

      // Wait resolves at t=150 — only 1 idle check fired (below threshold of 2)
      await vi.advanceTimersByTimeAsync(50);
      await executePromise;

      // Exactly 1 null → consecutiveIdleChecks=1, which is below threshold (2), so no warning.
      // Proof that the null was counted as idle (not ignored): if it were ignored,
      // test 7.9b (which relies on 2 consecutive nulls triggering a warning) would also fail.
      const idleCalls = localWarnSpy.mock.calls.filter(
        (call: unknown[]) => call[0] === EventName.CONTAINER_HEALTH_IDLE,
      );
      expect(idleCalls).toHaveLength(0);
      // Exactly 1 stats call confirms the interval fired once before execute() resolved
      expect((mockRuntime.stats as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    });

    // 7.9b: two consecutive null returns trigger CONTAINER_HEALTH_IDLE warning
    it('triggers CONTAINER_HEALTH_IDLE warning after 2 consecutive null stats returns', async () => {
      vi.useFakeTimers();
      const localWarnSpy = vi.fn().mockResolvedValue(undefined);
      const mockRuntime = createMockRuntime({
        stats: vi.fn().mockResolvedValue(null),
        wait: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve({ exitCode: 0, oomKilled: false }), 500);
            }),
        ),
      });
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: localWarnSpy,
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      const executePromise = backend.execute(
        'claude',
        ['--print', 'test'],
        makeOptions({ healthCheckIntervalMs: 100 }),
      );

      // Two consecutive null returns — should trigger idle warning
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(100);

      // Resolve wait
      await vi.advanceTimersByTimeAsync(300);
      await executePromise;

      const idleCalls = localWarnSpy.mock.calls.filter(
        (call: unknown[]) => call[0] === EventName.CONTAINER_HEALTH_IDLE,
      );
      expect(idleCalls).toHaveLength(1);
      expect(idleCalls[0]![1]).toMatchObject({
        containerId: 'test-container-123',
        consecutiveIdleChecks: 2,
        memoryUsageMb: null,
        memoryLimitMb: null,
      });
    });
  });

  // --- Health monitoring stats failure tests (Story 11.6, Task 8) ---
  describe('health monitoring stats failure', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    // 8.2: when runtime.stats() throws, CONTAINER_HEALTH_STATS_FAILED is logged at debug
    it('logs CONTAINER_HEALTH_STATS_FAILED at debug level when runtime.stats() throws and stops monitoring', async () => {
      vi.useFakeTimers();
      const mockRuntime = createMockRuntime({
        stats: vi.fn().mockRejectedValue(new Error('stats error')),
        wait: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve({ exitCode: 0, oomKilled: false }), 500);
            }),
        ),
      });
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => {
        loggerDebugSpy = vi.fn().mockResolvedValue(undefined);
        return {
          logger: {
            info: vi.fn().mockResolvedValue(undefined),
            warn: vi.fn().mockResolvedValue(undefined),
            error: vi.fn().mockResolvedValue(undefined),
            debug: loggerDebugSpy,
          },
          boundOutput: realBoundOutput,
          MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
          MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
        };
      });
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      const executePromise = backend.execute(
        'claude',
        ['--print', 'test'],
        makeOptions({ healthCheckIntervalMs: 100 }),
      );

      // First health check fires and stats throws
      await vi.advanceTimersByTimeAsync(100);

      // Resolve wait
      await vi.advanceTimersByTimeAsync(400);
      await executePromise;

      const failCalls = loggerDebugSpy.mock.calls.filter(
        (call: unknown[]) => call[0] === EventName.CONTAINER_HEALTH_STATS_FAILED,
      );
      expect(failCalls).toHaveLength(1);
      expect(failCalls[0]![1]).toMatchObject({
        containerId: 'test-container-123',
        error: 'stats error',
      });
    });

    // 8.3: a stats failure does not cause execute() to reject
    it('does not cause execute() to reject when runtime.stats() throws', async () => {
      vi.useFakeTimers();
      const mockRuntime = createMockRuntime({
        stats: vi.fn().mockRejectedValue(new Error('runtime gone')),
        wait: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve({ exitCode: 0, oomKilled: false }), 300);
            }),
        ),
      });
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      const executePromise = backend.execute(
        'claude',
        ['--print', 'test'],
        makeOptions({ healthCheckIntervalMs: 100 }),
      );

      // Stats failure at t=100
      await vi.advanceTimersByTimeAsync(100);
      // Wait resolves at t=300
      await vi.advanceTimersByTimeAsync(200);

      const result = await executePromise;
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.aborted).toBe(false);
    });

    // 8.4: after stats failure stops monitoring, runtime.stats() is not called again
    it('stops calling runtime.stats() after a stats failure', async () => {
      vi.useFakeTimers();
      const mockRuntime = createMockRuntime({
        stats: vi.fn().mockRejectedValue(new Error('gone')),
        wait: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve({ exitCode: 0, oomKilled: false }), 500);
            }),
        ),
      });
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      const executePromise = backend.execute(
        'claude',
        ['--print', 'test'],
        makeOptions({ healthCheckIntervalMs: 100 }),
      );

      // First check fails at t=100
      await vi.advanceTimersByTimeAsync(100);
      const callsAfterFirstFail = (mockRuntime.stats as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(callsAfterFirstFail).toBe(1);

      // Advance multiple intervals — no more stats calls
      await vi.advanceTimersByTimeAsync(300);

      expect((mockRuntime.stats as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

      // Resolve wait
      await vi.advanceTimersByTimeAsync(100);
      await executePromise;
    });
  });

  // --- Output bounding tests (Story 11.6, Task 9) ---
  describe('output bounding', () => {
    // 9.2: on successful exit (exitCode 0), output bounded to 50KB
    it('bounds stdout and stderr to 50KB on successful exit (exitCode 0)', async () => {
      const largeOutput = 'x'.repeat(60 * 1024); // 60KB
      const mockRuntime = createMockRuntime({
        wait: vi.fn().mockResolvedValue({ exitCode: 0, oomKilled: false }),
        logs: vi.fn().mockResolvedValue({ stdout: largeOutput, stderr: largeOutput }),
      });
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      const result = await backend.execute('claude', ['--print', 'test'], makeOptions());

      expect(Buffer.byteLength(result.stdout, 'utf-8')).toBeLessThanOrEqual(50 * 1024);
      expect(Buffer.byteLength(result.stderr, 'utf-8')).toBeLessThanOrEqual(50 * 1024);
    });

    // 9.3: on failed exit (exitCode non-zero), output bounded to 10KB
    it('bounds stdout and stderr to 10KB on failed exit (exitCode non-zero)', async () => {
      const largeOutput = 'y'.repeat(15 * 1024); // 15KB
      const mockRuntime = createMockRuntime({
        wait: vi.fn().mockResolvedValue({ exitCode: 1, oomKilled: false }),
        logs: vi.fn().mockResolvedValue({ stdout: largeOutput, stderr: largeOutput }),
      });
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      const result = await backend.execute('claude', ['--print', 'test'], makeOptions());

      expect(Buffer.byteLength(result.stdout, 'utf-8')).toBeLessThanOrEqual(10 * 1024);
      expect(Buffer.byteLength(result.stderr, 'utf-8')).toBeLessThanOrEqual(10 * 1024);
    });

    // 9.4: on timeout path, partial output bounded to 10KB
    it('bounds partial output to 10KB on timeout path', async () => {
      vi.resetModules();
      const { ScrowError: FreshScrowError, ErrorCode: FreshErrorCode } =
        await import('../../../errors/index.js');
      const largeOutput = 'z'.repeat(15 * 1024); // 15KB
      const mockRuntime = createMockRuntime({
        wait: vi
          .fn()
          .mockRejectedValue(new FreshScrowError(FreshErrorCode.TASK_TIMEOUT, 'timed out')),
        logs: vi.fn().mockResolvedValue({ stdout: largeOutput, stderr: largeOutput }),
      });
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      const result = await backend.execute('claude', ['--print', 'test'], makeOptions());

      expect(result.timedOut).toBe(true);
      expect(Buffer.byteLength(result.stdout, 'utf-8')).toBeLessThanOrEqual(10 * 1024);
      expect(Buffer.byteLength(result.stderr, 'utf-8')).toBeLessThanOrEqual(10 * 1024);
    });

    // 9.5: output shorter than the limit is returned unchanged
    it('returns output unchanged when shorter than the bounding limit', async () => {
      const shortOutput = 'short output';
      const mockRuntime = createMockRuntime({
        wait: vi.fn().mockResolvedValue({ exitCode: 0, oomKilled: false }),
        logs: vi.fn().mockResolvedValue({ stdout: shortOutput, stderr: shortOutput }),
      });
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      const result = await backend.execute('claude', ['--print', 'test'], makeOptions());

      expect(result.stdout).toBe(shortOutput);
      expect(result.stderr).toBe(shortOutput);
    });

    // 9.6a: success path — 60KB stdout is truncated to exactly 50KB
    it('truncates 60KB stdout to exactly 50KB on exit code 0', async () => {
      const successOutput = 'a'.repeat(60 * 1024);
      const mockRuntime = createMockRuntime({
        wait: vi.fn().mockResolvedValue({ exitCode: 0, oomKilled: false }),
        logs: vi.fn().mockResolvedValue({ stdout: successOutput, stderr: '' }),
      });
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      const result = await backend.execute('claude', ['--print', 'test'], makeOptions());
      expect(Buffer.byteLength(result.stdout, 'utf-8')).toBe(50 * 1024);
    });

    // 9.6b: failure path — 15KB stdout is truncated to exactly 10KB
    it('truncates 15KB stdout to exactly 10KB on exit code 1', async () => {
      const failureOutput = 'b'.repeat(15 * 1024);
      const mockRuntime = createMockRuntime({
        wait: vi.fn().mockResolvedValue({ exitCode: 1, oomKilled: false }),
        logs: vi.fn().mockResolvedValue({ stdout: failureOutput, stderr: '' }),
      });
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      const result = await backend.execute('claude', ['--print', 'test'], makeOptions());
      expect(Buffer.byteLength(result.stdout, 'utf-8')).toBe(10 * 1024);
    });
  });

  // ─── Story 12.2: Container config wiring tests ───────────────────────────────

  describe('container config wiring (Story 12.2)', () => {
    // 8.1: ContainerExecutionBackend created with ContainerConfig uses config values
    it('uses config values for memoryLimitMb, cpuLimit, networkMode, image in runOptions', async () => {
      const mockRuntime = createMockRuntime();
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend({
        runtime: 'auto',
        image: 'ubuntu:22.04',
        memoryLimitMb: 1024,
        cpuLimit: 2.0,
        networkMode: 'none',
        mountClaudeConfig: true,
      });

      await backend.execute('claude', ['--print', 'test'], makeOptions());

      const runArgs = (mockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(runArgs.image).toBe('ubuntu:22.04');
      expect(runArgs.memoryLimitMb).toBe(1024);
      expect(runArgs.cpuLimit).toBe(2.0);
      expect(runArgs.networkMode).toBe('none');
    });

    // 8.1a: OOM log uses config value (not hardcoded constant)
    it('emits CONTAINER_OOM_KILLED with config memoryLimitMb value (not hardcoded default)', async () => {
      const mockRuntime = createMockRuntime({
        wait: vi.fn().mockResolvedValue({ exitCode: 137, oomKilled: true }),
      });
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      const localWarnSpy = vi.fn().mockResolvedValue(undefined);
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: localWarnSpy,
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend({
        runtime: 'auto',
        image: 'node:lts-slim',
        memoryLimitMb: 2048,
        cpuLimit: 1.0,
        networkMode: 'bridge',
        mountClaudeConfig: true,
      });

      await backend.execute('claude', ['--print', 'test'], makeOptions());

      expect(localWarnSpy).toHaveBeenCalledWith(
        EventName.CONTAINER_OOM_KILLED,
        expect.objectContaining({
          memoryLimitMb: 2048,
          message: expect.stringContaining('2048'),
        }),
      );
    });

    // 8.2: Backend created without ContainerConfig uses hardcoded defaults
    it('uses hardcoded defaults when no ContainerConfig is provided (backward compat)', async () => {
      const mockRuntime = createMockRuntime();
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      await backend.execute('claude', ['--print', 'test'], makeOptions());

      const runArgs = (mockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(runArgs.image).toBe('node:lts-slim');
      expect(runArgs.memoryLimitMb).toBe(512);
      expect(runArgs.cpuLimit).toBe(1.0);
      expect(runArgs.networkMode).toBe('bridge');
    });

    // 8.2a: mountClaudeConfig: false passes to resolveContainerCredentials
    it('passes mountClaudeConfig: false to resolveContainerCredentials and results in no credential mounts', async () => {
      const mockRuntime = createMockRuntime();
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      const localResolveCredentials = vi
        .fn()
        .mockResolvedValue({ mounts: [], env: { HOME: '/root' } });
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: localResolveCredentials,
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend({
        runtime: 'auto',
        image: 'node:lts-slim',
        memoryLimitMb: 512,
        cpuLimit: 1.0,
        networkMode: 'bridge',
        mountClaudeConfig: false,
      });

      await backend.execute('claude', ['--print', 'test'], makeOptions());

      // Verify resolveContainerCredentials was called with mountClaudeConfig: false
      expect(localResolveCredentials).toHaveBeenCalledWith(
        expect.objectContaining({ mountClaudeConfig: false }),
      );
      // Verify no credential mounts in runOptions (only workspace mount)
      const runArgs = (mockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(runArgs.mounts).toHaveLength(1); // only workspace mount
      expect(runArgs.mounts[0].target).toBe('/workspace');
    });

    // 8.2b: mountClaudeConfig: false with no ANTHROPIC_API_KEY emits warning
    it('emits CONTAINER_CREDENTIALS_MISSING when mountClaudeConfig: false and no ANTHROPIC_API_KEY', async () => {
      const mockRuntime = createMockRuntime();
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi
          .fn()
          .mockResolvedValue({ mounts: [], env: { HOME: '/root' } }),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      const localWarnSpy = vi.fn().mockResolvedValue(undefined);
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: localWarnSpy,
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend({
        runtime: 'auto',
        image: 'node:lts-slim',
        memoryLimitMb: 512,
        cpuLimit: 1.0,
        networkMode: 'bridge',
        mountClaudeConfig: false,
      });

      // Execute without ANTHROPIC_API_KEY in env
      await backend.execute('claude', ['--print', 'test'], makeOptions({ env: {} }));

      expect(localWarnSpy).toHaveBeenCalledWith(
        EventName.CONTAINER_CREDENTIALS_MISSING,
        expect.objectContaining({
          expectedPath: '~/.claude/.credentials.json',
        }),
      );
    });

    // 8.7: Backend with runtime: 'docker' calls detectContainerRuntime('docker') during available()
    it('calls detectContainerRuntime with "docker" preference during available() when config runtime is "docker"', async () => {
      vi.resetModules();
      const localDetect = vi.fn().mockResolvedValue(createMockRuntime());
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: localDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend({
        runtime: 'docker',
        image: 'node:lts-slim',
        memoryLimitMb: 512,
        cpuLimit: 1.0,
        networkMode: 'bridge',
        mountClaudeConfig: true,
      });

      await backend.available();

      expect(localDetect).toHaveBeenCalledWith('docker');
    });

    // 8.8: Backend with runtime: 'docker' calls detectContainerRuntime('docker') during execute()
    it('calls detectContainerRuntime with "docker" preference during execute() when cache is cold', async () => {
      vi.resetModules();
      const localDetect = vi.fn().mockResolvedValue(createMockRuntime());
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: localDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend({
        runtime: 'docker',
        image: 'node:lts-slim',
        memoryLimitMb: 512,
        cpuLimit: 1.0,
        networkMode: 'bridge',
        mountClaudeConfig: true,
      });

      // Call execute() directly without calling available() first (cache is cold)
      await backend.execute('claude', ['--print', 'test'], makeOptions());

      expect(localDetect).toHaveBeenCalledWith('docker');
      expect(localDetect).toHaveBeenCalledTimes(1);
    });
  });

  describe('resetAvailabilityCache', () => {
    it('causes next available() to re-probe the runtime', async () => {
      const runtime = createMockRuntime();
      mockDetect.mockResolvedValue(runtime);

      const backend = new ContainerExecutionBackend();
      // First call populates cache
      await backend.available();
      expect(mockDetect).toHaveBeenCalledTimes(1);

      // Reset cache and re-call
      backend.resetAvailabilityCache();
      await backend.available();
      expect(mockDetect).toHaveBeenCalledTimes(2);
    });

    it('after reset, if runtime was removed, available() returns false', async () => {
      const runtime = createMockRuntime();
      mockDetect.mockResolvedValue(runtime);

      const backend = new ContainerExecutionBackend();
      const firstResult = await backend.available();
      expect(firstResult).toBe(true);

      // Simulate runtime removal
      backend.resetAvailabilityCache();
      mockDetect.mockResolvedValue(null);
      const secondResult = await backend.available();
      expect(secondResult).toBe(false);
    });

    it('after reset, a previously-cached available runtime is re-detected', async () => {
      const runtime1 = createMockRuntime({ name: 'docker' });
      const runtime2 = createMockRuntime({ name: 'podman' });
      mockDetect.mockResolvedValue(runtime1);

      const backend = new ContainerExecutionBackend();
      await backend.available();

      backend.resetAvailabilityCache();
      mockDetect.mockResolvedValue(runtime2);
      await backend.available();

      // Verify that the second detection was called
      expect(mockDetect).toHaveBeenCalledTimes(2);
    });
  });

  describe('getRuntimeInfo', () => {
    it('returns null when _runtimeDetection is null (not yet called)', async () => {
      const backend = new ContainerExecutionBackend();
      const info = await backend.getRuntimeInfo();
      expect(info).toBeNull();
    });

    it('returns { name, version } when runtime is detected and info() succeeds', async () => {
      const runtime = createMockRuntime({
        name: 'docker',
        info: vi.fn().mockResolvedValue({ version: '27.1.0', rootless: true }),
      });
      mockDetect.mockResolvedValue(runtime);

      const backend = new ContainerExecutionBackend();
      await backend.available();
      const info = await backend.getRuntimeInfo();
      expect(info).toEqual({ name: 'docker', version: '27.1.0' });
    });

    it('returns { name, version: "" } when runtime is detected but info() throws', async () => {
      const runtime = createMockRuntime({
        name: 'podman',
        info: vi.fn().mockRejectedValue(new Error('info failed')),
      });
      mockDetect.mockResolvedValue(runtime);

      const backend = new ContainerExecutionBackend();
      await backend.available();
      const info = await backend.getRuntimeInfo();
      expect(info).toEqual({ name: 'podman', version: '' });
    });

    it('returns null when runtime detection resolved to null (no runtime found)', async () => {
      mockDetect.mockResolvedValue(null);

      const backend = new ContainerExecutionBackend();
      await backend.available();
      const info = await backend.getRuntimeInfo();
      expect(info).toBeNull();
    });
  });

  // ─── Story 10.5: Binary mount integration tests ─────────────────────────────

  describe('binary mount integration', () => {
    // 10.5 4.4: container backend includes binary mount in docker run args
    it('includes binary mount in runOptions.mounts when resolveBinaryMount returns a result', async () => {
      const mockRuntime = createMockRuntime();
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue({
          mount: {
            source: '/home/user/.local/share/claude/versions/2.1.63',
            target: '/opt/claude/2.1.63',
            readonly: true,
          },
          containerCommandPath: '/opt/claude/2.1.63/cli.js',
        }),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      await backend.execute('/home/user/.local/bin/claude', ['--print', 'test'], makeOptions());

      const runArgs = (mockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      // Workspace mount + binary mount
      expect(runArgs.mounts).toHaveLength(2);
      expect(runArgs.mounts[1]).toEqual({
        source: '/home/user/.local/share/claude/versions/2.1.63',
        target: '/opt/claude/2.1.63',
        readonly: true,
      });
    });

    // 10.5 4.5: command path rewritten to container-side path
    it('rewrites command to container-side path when binary mount succeeds', async () => {
      const mockRuntime = createMockRuntime();
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue({
          mount: {
            source: '/home/user/.local/share/claude/versions/2.1.63',
            target: '/opt/claude/2.1.63',
            readonly: true,
          },
          containerCommandPath: '/opt/claude/2.1.63/cli.js',
        }),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      await backend.execute('/home/user/.local/bin/claude', ['--print', 'test'], makeOptions());

      const runArgs = (mockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(runArgs.command).toEqual(['/opt/claude/2.1.63/cli.js', '--print', 'test']);
    });

    // 10.5: command uses original path when binary mount returns null (graceful degradation)
    it('uses original command path when resolveBinaryMount returns null', async () => {
      const mockRuntime = createMockRuntime();
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      await backend.execute('claude', ['--print', 'test'], makeOptions());

      const runArgs = (mockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(runArgs.command).toEqual(['claude', '--print', 'test']);
      // Only workspace mount, no binary mount
      expect(runArgs.mounts).toHaveLength(1);
    });

    // 10.5 4.6: claude_binary_path config override skips mount
    it('uses claudeBinaryPath from config and skips binary mount resolution', async () => {
      const localResolveBinaryMount = vi.fn().mockResolvedValue(null);
      const mockRuntime = createMockRuntime();
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: localResolveBinaryMount,
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend({
        runtime: 'auto',
        image: 'node:lts-slim',
        memoryLimitMb: 512,
        cpuLimit: 1.0,
        networkMode: 'bridge',
        mountClaudeConfig: true,

        claudeBinaryPath: '/usr/local/bin/claude-preinstalled',
      });

      await backend.execute('/home/user/.local/bin/claude', ['--print', 'test'], makeOptions());

      // resolveBinaryMount should NOT have been called
      expect(localResolveBinaryMount).not.toHaveBeenCalled();
      // Command should use the configured container-side path
      const runArgs = (mockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(runArgs.command).toEqual(['/usr/local/bin/claude-preinstalled', '--print', 'test']);
      // No binary mount added
      expect(runArgs.mounts).toHaveLength(1);
    });

    // 10.5: binary mount is read-only
    it('ensures binary mount is read-only in runOptions', async () => {
      const mockRuntime = createMockRuntime();
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue({
          mount: {
            source: '/opt/claude-install',
            target: '/opt/claude/claude-install',
            readonly: true,
          },
          containerCommandPath: '/opt/claude/claude-install/claude',
        }),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      await backend.execute('claude', ['--print', 'test'], makeOptions());

      const runArgs = (mockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      const binaryMount = runArgs.mounts.find(
        (m: { target: string }) => m.target === '/opt/claude/claude-install',
      );
      expect(binaryMount).toBeDefined();
      expect(binaryMount.readonly).toBe(true);
    });

    // Finding 8: mount ordering — workspace first, then credential mounts, then binary mount
    it('orders mounts as [workspace, ...credentialMounts, ...binaryMounts]', async () => {
      const credentialMounts = [
        {
          source: '/home/user/.claude/.credentials.json',
          target: '/root/.claude/.credentials.json',
          readonly: false,
        },
        {
          source: '/home/user/.claude/settings.json',
          target: '/root/.claude/settings.json',
          readonly: true,
        },
      ];
      const mockRuntime = createMockRuntime();
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue({
          mounts: credentialMounts,
          env: { HOME: '/root' },
        }),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue({
          mount: {
            source: '/home/user/.local/share/claude/versions/2.1.63',
            target: '/opt/claude/2.1.63',
            readonly: true,
          },
          containerCommandPath: '/opt/claude/2.1.63/cli.js',
        }),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      await backend.execute('/home/user/.local/bin/claude', ['--print', 'test'], makeOptions());

      const runArgs = (mockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      // Order: [workspace, credentialMount[0], credentialMount[1], binaryMount]
      expect(runArgs.mounts).toHaveLength(4);
      expect(runArgs.mounts[0].target).toBe('/workspace');
      expect(runArgs.mounts[1]).toEqual(credentialMounts[0]);
      expect(runArgs.mounts[2]).toEqual(credentialMounts[1]);
      expect(runArgs.mounts[3]).toEqual({
        source: '/home/user/.local/share/claude/versions/2.1.63',
        target: '/opt/claude/2.1.63',
        readonly: true,
      });
    });
  });

  // ─── Story 10.7: Custom container image support ─────────────────────────────

  describe('shouldMountBinary()', () => {
    // 10.7 4.1: custom image → shouldMountBinary() returns false
    it('returns false when a custom (non-default) image is configured', () => {
      const backend = new ContainerExecutionBackend({
        runtime: 'auto',
        image: 'ghcr.io/13rac1/openclaw-claude-code:latest',
        memoryLimitMb: 512,
        cpuLimit: 1.0,
        networkMode: 'bridge',
        mountClaudeConfig: true,
      });
      const result = backend.shouldMountBinary();
      expect(result.shouldMount).toBe(false);
      expect(result.reason).toBe('custom-image');
    });

    // 10.7 4.2: default image → shouldMountBinary() returns true
    it('returns true when using the default image (node:lts-slim)', () => {
      const backend = new ContainerExecutionBackend({
        runtime: 'auto',
        image: 'node:lts-slim',
        memoryLimitMb: 512,
        cpuLimit: 1.0,
        networkMode: 'bridge',
        mountClaudeConfig: true,
      });
      const result = backend.shouldMountBinary();
      expect(result.shouldMount).toBe(true);
      expect(result.reason).toBe('default-image');
    });

    // 10.7 4.2b: no config → shouldMountBinary() returns true (default image)
    it('returns true when no config is provided (defaults to node:lts-slim)', () => {
      const backend = new ContainerExecutionBackend();
      const result = backend.shouldMountBinary();
      expect(result.shouldMount).toBe(true);
      expect(result.reason).toBe('default-image');
    });

    // 10.7 4.3: mount_claude_binary: true with custom image → forces mount
    it('returns true when mountClaudeBinary is explicitly true even with custom image', () => {
      const backend = new ContainerExecutionBackend({
        runtime: 'auto',
        image: 'ghcr.io/13rac1/openclaw-claude-code:latest',
        memoryLimitMb: 512,
        cpuLimit: 1.0,
        networkMode: 'bridge',
        mountClaudeConfig: true,

        mountClaudeBinary: true,
      });
      const result = backend.shouldMountBinary();
      expect(result.shouldMount).toBe(true);
      expect(result.reason).toBe('config-override');
    });

    // 10.7 4.4: mount_claude_binary: false with default image → skips mount
    it('returns false when mountClaudeBinary is explicitly false even with default image', () => {
      const backend = new ContainerExecutionBackend({
        runtime: 'auto',
        image: 'node:lts-slim',
        memoryLimitMb: 512,
        cpuLimit: 1.0,
        networkMode: 'bridge',
        mountClaudeConfig: true,

        mountClaudeBinary: false,
      });
      const result = backend.shouldMountBinary();
      expect(result.shouldMount).toBe(false);
      expect(result.reason).toBe('config-override');
    });
  });

  describe('mountStrategy getter', () => {
    it('returns "host-binary" when shouldMountBinary is true', () => {
      const backend = new ContainerExecutionBackend();
      expect(backend.mountStrategy).toBe('host-binary');
    });

    it('returns "image-builtin" when shouldMountBinary is false', () => {
      const backend = new ContainerExecutionBackend({
        runtime: 'auto',
        image: 'my-custom:latest',
        memoryLimitMb: 512,
        cpuLimit: 1.0,
        networkMode: 'bridge',
        mountClaudeConfig: true,
      });
      expect(backend.mountStrategy).toBe('image-builtin');
    });
  });

  // 10.7 4.5: custom image → command is ['claude', ...args] not host path
  describe('custom image command rewriting', () => {
    it('uses bare "claude" command when custom image skips binary mount', async () => {
      const mockRuntime = createMockRuntime();
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      const localResolveBinaryMount = vi.fn().mockResolvedValue(null);
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: localResolveBinaryMount,
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend({
        runtime: 'auto',
        image: 'ghcr.io/13rac1/openclaw-claude-code:latest',
        memoryLimitMb: 512,
        cpuLimit: 1.0,
        networkMode: 'bridge',
        mountClaudeConfig: true,
      });

      await backend.execute(
        '/home/user/.local/bin/claude',
        ['--print', 'test prompt'],
        makeOptions(),
      );

      const runArgs = (mockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      // Command should be bare 'claude' not the host path
      expect(runArgs.command).toEqual(['claude', '--print', 'test prompt']);
      // resolveBinaryMount should NOT have been called (mount skipped)
      expect(localResolveBinaryMount).not.toHaveBeenCalled();
      // Only workspace mount, no binary mount
      expect(runArgs.mounts).toHaveLength(1);
      expect(runArgs.mounts[0].target).toBe('/workspace');
    });

    it('still mounts host binary when mountClaudeBinary: true overrides custom image', async () => {
      const mockRuntime = createMockRuntime();
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      const localResolveBinaryMount = vi.fn().mockResolvedValue({
        mount: {
          source: '/home/user/.local/share/claude/versions/2.1.63',
          target: '/opt/claude/2.1.63',
          readonly: true,
        },
        containerCommandPath: '/opt/claude/2.1.63/cli.js',
      });
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: localResolveBinaryMount,
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend({
        runtime: 'auto',
        image: 'ghcr.io/13rac1/openclaw-claude-code:latest',
        memoryLimitMb: 512,
        cpuLimit: 1.0,
        networkMode: 'bridge',
        mountClaudeConfig: true,

        mountClaudeBinary: true,
      });

      await backend.execute('/home/user/.local/bin/claude', ['--print', 'test'], makeOptions());

      const runArgs = (mockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      // Binary mount should be present since override forces it
      expect(localResolveBinaryMount).toHaveBeenCalledWith('/home/user/.local/bin/claude');
      expect(runArgs.command).toEqual(['/opt/claude/2.1.63/cli.js', '--print', 'test']);
      expect(runArgs.mounts).toHaveLength(2);
    });

    it('skips binary mount and uses bare "claude" when mountClaudeBinary: false overrides default image', async () => {
      const mockRuntime = createMockRuntime();
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      const localResolveBinaryMount = vi.fn().mockResolvedValue(null);
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: localResolveBinaryMount,
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend({
        runtime: 'auto',
        image: 'node:lts-slim',
        memoryLimitMb: 512,
        cpuLimit: 1.0,
        networkMode: 'bridge',
        mountClaudeConfig: true,

        mountClaudeBinary: false,
      });

      await backend.execute('/home/user/.local/bin/claude', ['--print', 'review'], makeOptions());

      const runArgs = (mockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(runArgs.command).toEqual(['claude', '--print', 'review']);
      expect(localResolveBinaryMount).not.toHaveBeenCalled();
      expect(runArgs.mounts).toHaveLength(1);
    });

    it('logs mount decision audit event with mountStrategy, image, and reason', async () => {
      const mockRuntime = createMockRuntime();
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      let localLoggerInfoSpy: ReturnType<typeof vi.fn>;
      vi.doMock('../../../utils/index.js', () => {
        localLoggerInfoSpy = vi.fn().mockResolvedValue(undefined);
        return {
          logger: {
            info: localLoggerInfoSpy,
            warn: vi.fn().mockResolvedValue(undefined),
            error: vi.fn().mockResolvedValue(undefined),
            debug: vi.fn().mockResolvedValue(undefined),
          },
          boundOutput: realBoundOutput,
          MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
          MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
        };
      });
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend({
        runtime: 'auto',
        image: 'my-custom:latest',
        memoryLimitMb: 512,
        cpuLimit: 1.0,
        networkMode: 'bridge',
        mountClaudeConfig: true,
      });

      await backend.execute('claude', ['--print', 'test'], makeOptions());

      // Find the mount decision log call
      const mountDecisionCall = localLoggerInfoSpy!.mock.calls.find(
        (call: unknown[]) => call[0] === EventName.CONTAINER_MOUNT_DECISION,
      );
      expect(mountDecisionCall).toBeDefined();
      expect(mountDecisionCall![1]).toEqual({
        mountStrategy: 'image-builtin',
        image: 'my-custom:latest',
        reason: 'custom-image',
      });
    });

    it('includes mountStrategy in CONTAINER_TASK_STARTED audit event', async () => {
      const mockRuntime = createMockRuntime();
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      let localLoggerInfoSpy: ReturnType<typeof vi.fn>;
      vi.doMock('../../../utils/index.js', () => {
        localLoggerInfoSpy = vi.fn().mockResolvedValue(undefined);
        return {
          logger: {
            info: localLoggerInfoSpy,
            warn: vi.fn().mockResolvedValue(undefined),
            error: vi.fn().mockResolvedValue(undefined),
            debug: vi.fn().mockResolvedValue(undefined),
          },
          boundOutput: realBoundOutput,
          MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
          MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
        };
      });
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      await backend.execute('claude', ['--print', 'test'], makeOptions());

      // Find the task started log call
      const taskStartedCall = localLoggerInfoSpy!.mock.calls.find(
        (call: unknown[]) => call[0] === EventName.CONTAINER_TASK_STARTED,
      );
      expect(taskStartedCall).toBeDefined();
      expect(taskStartedCall![1]).toHaveProperty('mountStrategy', 'host-binary');
    });

    // AI-Review finding 1: claudeBinaryPath branch must emit 'image-builtin' in audit log,
    // not the auto-detected mountStrategy value (which would incorrectly reflect the image name).
    it('emits "image-builtin" mountStrategy in audit log when claudeBinaryPath is configured', async () => {
      const mockRuntime = createMockRuntime();
      vi.resetModules();
      mockDetect = vi.fn().mockResolvedValue(mockRuntime);
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: mockDetect,
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      let localLoggerInfoSpy: ReturnType<typeof vi.fn>;
      vi.doMock('../../../utils/index.js', () => {
        localLoggerInfoSpy = vi.fn().mockResolvedValue(undefined);
        return {
          logger: {
            info: localLoggerInfoSpy,
            warn: vi.fn().mockResolvedValue(undefined),
            error: vi.fn().mockResolvedValue(undefined),
            debug: vi.fn().mockResolvedValue(undefined),
          },
          boundOutput: realBoundOutput,
          MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
          MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
        };
      });
      const mod = await import('./container-backend.js');
      // Use the default image — auto-detection would say 'host-binary' for node:lts-slim,
      // but claudeBinaryPath takes priority and must emit 'image-builtin'.
      const backend = new mod.ContainerExecutionBackend({
        runtime: 'auto',
        image: 'node:lts-slim',
        memoryLimitMb: 512,
        cpuLimit: 1.0,
        networkMode: 'bridge',
        mountClaudeConfig: true,

        claudeBinaryPath: '/usr/local/bin/claude-preinstalled',
      });

      await backend.execute('claude', ['--print', 'test'], makeOptions());

      // CONTAINER_MOUNT_DECISION must say 'image-builtin' because the binary is in the image
      const mountDecisionCall = localLoggerInfoSpy!.mock.calls.find(
        (call: unknown[]) => call[0] === EventName.CONTAINER_MOUNT_DECISION,
      );
      expect(mountDecisionCall).toBeDefined();
      expect(mountDecisionCall![1]).toHaveProperty('mountStrategy', 'image-builtin');

      // CONTAINER_TASK_STARTED must also say 'image-builtin' — consistent with mount decision
      const taskStartedCall = localLoggerInfoSpy!.mock.calls.find(
        (call: unknown[]) => call[0] === EventName.CONTAINER_TASK_STARTED,
      );
      expect(taskStartedCall).toBeDefined();
      expect(taskStartedCall![1]).toHaveProperty('mountStrategy', 'image-builtin');
    });
  });

  describe('container runs as host user (AC8–AC10)', () => {
    it('passes --user with host UID:GID in run args', async () => {
      const localMockRuntime = createMockRuntime();
      vi.resetModules();
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: vi.fn().mockResolvedValue(localMockRuntime),
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      await backend.execute('claude', ['--print', 'test'], makeOptions());

      const runArgs = (localMockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      const hostUid = process.getuid?.();
      const hostGid = process.getgid?.();
      if (hostUid !== undefined && hostGid !== undefined) {
        expect(runArgs.user).toBe(`${hostUid}:${hostGid}`);
      }
    });

    it('sets HOME to /home/node for non-root user on default image when caller does not provide HOME', async () => {
      const localMockRuntime = createMockRuntime();
      vi.resetModules();
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: vi.fn().mockResolvedValue(localMockRuntime),
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      await backend.execute('claude', ['--print', 'test'], makeOptions());

      const runArgs = (localMockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      const hostUid = process.getuid?.();
      if (hostUid !== undefined && hostUid !== 0) {
        expect(runArgs.env.HOME).toBe('/home/node');
      }
    });

    it('preserves caller-provided HOME even when running as non-root user', async () => {
      const localMockRuntime = createMockRuntime();
      vi.resetModules();
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: vi.fn().mockResolvedValue(localMockRuntime),
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));
      const mod = await import('./container-backend.js');
      const backend = new mod.ContainerExecutionBackend();

      await backend.execute(
        'claude',
        ['--print', 'test'],
        makeOptions({ env: { HOME: '/home/custom' } }),
      );

      const runArgs = (localMockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(runArgs.env.HOME).toBe('/home/custom');
    });

    it('omits --user flag when process.getuid is undefined (non-POSIX/Windows)', async () => {
      // AC8: on platforms without getuid/getgid (e.g., Windows), no --user flag is passed
      const localMockRuntime = createMockRuntime();
      vi.resetModules();
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: vi.fn().mockResolvedValue(localMockRuntime),
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));

      // Temporarily replace getuid/getgid on process to return undefined (simulate non-POSIX)
      // Cast via unknown first to satisfy TypeScript — NodeJS.Process has no index signature
      const proc = process as unknown as Record<string, unknown>;
      const origGetuid = proc['getuid'];
      const origGetgid = proc['getgid'];
      proc['getuid'] = undefined;
      proc['getgid'] = undefined;

      try {
        const mod = await import('./container-backend.js');
        const backend = new mod.ContainerExecutionBackend();
        await backend.execute('claude', ['--print', 'test'], makeOptions());

        const runArgs = (localMockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
        // No --user flag should be present on non-POSIX platforms
        expect(runArgs.user).toBeUndefined();
        // HOME must not be overridden to /home/node either (no userFlag means no HOME override)
        expect(runArgs.env.HOME).toBe('/root'); // defaultCredentials HOME
      } finally {
        // Restore original getuid/getgid
        proc['getuid'] = origGetuid;
        proc['getgid'] = origGetgid;
      }
    });

    it('preserves HOME as /root when running as root user (UID 0)', async () => {
      // AC5 guard: when running as root (UID 0), HOME should NOT be overridden to /home/node
      const localMockRuntime = createMockRuntime();
      vi.resetModules();
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: vi.fn().mockResolvedValue(localMockRuntime),
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));

      // Simulate root user: getuid() returns 0, getgid() returns 0
      const proc2 = process as unknown as Record<string, unknown>;
      const origGetuid2 = proc2['getuid'];
      const origGetgid2 = proc2['getgid'];
      proc2['getuid'] = () => 0;
      proc2['getgid'] = () => 0;

      try {
        const mod = await import('./container-backend.js');
        const backend = new mod.ContainerExecutionBackend();
        await backend.execute('claude', ['--print', 'test'], makeOptions());

        const runArgs = (localMockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
        // --user 0:0 is passed (root user gets the flag, but HOME stays as /root)
        expect(runArgs.user).toBe('0:0');
        // HOME must NOT be overridden to /home/node for root (UID === 0 prevents the HOME override)
        expect(runArgs.env.HOME).toBe('/root');
      } finally {
        proc2['getuid'] = origGetuid2;
        proc2['getgid'] = origGetgid2;
      }
    });

    it('passes --user with host UID:GID ensuring --dangerously-skip-permissions works (AC10)', async () => {
      // AC10: by running as a non-root UID, claude accepts --dangerously-skip-permissions
      // This test verifies the --user flag is present and non-root when the process is non-root
      const localMockRuntime = createMockRuntime();
      vi.resetModules();
      vi.doMock('./detect-runtime.js', () => ({
        detectContainerRuntime: vi.fn().mockResolvedValue(localMockRuntime),
      }));
      vi.doMock('./credential-resolver.js', () => ({
        resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
      }));
      vi.doMock('./binary-resolver.js', () => ({
        resolveBinaryMount: vi.fn().mockResolvedValue(null),
      }));
      vi.doMock('../../../utils/index.js', () => ({
        logger: {
          info: vi.fn().mockResolvedValue(undefined),
          warn: vi.fn().mockResolvedValue(undefined),
          error: vi.fn().mockResolvedValue(undefined),
          debug: vi.fn().mockResolvedValue(undefined),
        },
        boundOutput: realBoundOutput,
        MAX_OUTPUT_BYTES: REAL_MAX_OUTPUT_BYTES,
        MAX_OUTPUT_BYTES_SUCCESS: REAL_MAX_OUTPUT_BYTES_SUCCESS,
      }));

      // Simulate non-root user (UID 1000, GID 1000) — typical developer workstation
      const proc3 = process as unknown as Record<string, unknown>;
      const origGetuid3 = proc3['getuid'];
      const origGetgid3 = proc3['getgid'];
      proc3['getuid'] = () => 1000;
      proc3['getgid'] = () => 1000;

      try {
        const mod = await import('./container-backend.js');
        const backend = new mod.ContainerExecutionBackend();
        await backend.execute('claude', ['--print', 'test'], makeOptions());

        const runArgs = (localMockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
        // --user flag present with non-root UID:GID — enables --dangerously-skip-permissions (AC10)
        expect(runArgs.user).toBe('1000:1000');
        // File ownership also preserved: container runs as UID 1000 matching host (AC9)
        expect(runArgs.user).not.toBe('0:0');
        // HOME redirected to /home/node (non-root on default image node:lts-slim — node user home)
        expect(runArgs.env.HOME).toBe('/home/node');
      } finally {
        proc3['getuid'] = origGetuid3;
        proc3['getgid'] = origGetgid3;
      }
    });
  });

  // Story 18.1 AC1 — envStripPatterns filtering
  describe('envStripPatterns filtering (Story 18.1 AC1)', () => {
    it('removes env keys matching wildcard patterns before passing to runtime.run()', async () => {
      const localMockRuntime = createMockRuntime();
      mockDetect.mockResolvedValue(localMockRuntime);
      const backend = new ContainerExecutionBackend();
      await backend.available();

      const opts = makeOptions({
        env: {
          PATH: '/usr/bin',
          MY_SECRET_KEY: 'secret-value',
          MY_SECRET_TOKEN: 'token-value',
          AWS_ACCESS_KEY: 'aws-key',
          AWS_SECRET: 'aws-secret',
          SAFE_VAR: 'safe',
        },
        envStripPatterns: ['MY_SECRET_*', 'AWS_*'],
      });

      await backend.execute('claude', [], opts);

      const runArgs = (localMockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      // Matched keys must be absent
      expect(runArgs.env).not.toHaveProperty('MY_SECRET_KEY');
      expect(runArgs.env).not.toHaveProperty('MY_SECRET_TOKEN');
      expect(runArgs.env).not.toHaveProperty('AWS_ACCESS_KEY');
      expect(runArgs.env).not.toHaveProperty('AWS_SECRET');
      // Non-matching keys must be present
      expect(runArgs.env).toHaveProperty('SAFE_VAR', 'safe');
      expect(runArgs.env).toHaveProperty('PATH');
    });

    it('logs removed key names (not values) at debug level', async () => {
      const localMockRuntime = createMockRuntime();
      mockDetect.mockResolvedValue(localMockRuntime);
      const backend = new ContainerExecutionBackend();
      await backend.available();

      const opts = makeOptions({
        env: { SECRET_FOO: 'val1', SECRET_BAR: 'val2', KEEP_ME: 'val3' },
        envStripPatterns: ['SECRET_*'],
      });

      await backend.execute('claude', [], opts);

      expect(loggerDebugSpy).toHaveBeenCalledWith(
        'container.env-stripped',
        expect.objectContaining({
          removedKeys: expect.arrayContaining(['SECRET_FOO', 'SECRET_BAR']),
          patternCount: 1,
        }),
      );
    });

    it('does not strip anything when envStripPatterns is empty', async () => {
      const localMockRuntime = createMockRuntime();
      mockDetect.mockResolvedValue(localMockRuntime);
      const backend = new ContainerExecutionBackend();
      await backend.available();

      const opts = makeOptions({
        env: { MY_VAR: 'val' },
        envStripPatterns: [],
      });

      await backend.execute('claude', [], opts);

      const runArgs = (localMockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(runArgs.env).toHaveProperty('MY_VAR', 'val');
    });

    it('does not strip anything when envStripPatterns is undefined', async () => {
      const localMockRuntime = createMockRuntime();
      mockDetect.mockResolvedValue(localMockRuntime);
      const backend = new ContainerExecutionBackend();
      await backend.available();

      const opts = makeOptions({
        env: { MY_VAR: 'val' },
      });

      await backend.execute('claude', [], opts);

      const runArgs = (localMockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(runArgs.env).toHaveProperty('MY_VAR', 'val');
    });

    it('strips caller env BEFORE credential env is merged — credential keys are never stripped (merge-ordering invariant)', async () => {
      // This test protects the ordering invariant: envStripPatterns is applied to callerEnv
      // BEFORE credentials.env is merged in. If the order were swapped, credential keys injected
      // by the resolver could be silently stripped.
      const localMockRuntime = createMockRuntime();
      mockDetect.mockResolvedValue(localMockRuntime);

      // Credential resolver injects CLAUDE_HOME — same prefix as a stripped pattern
      const credentialsWithClaudeHome = {
        mounts: [],
        env: { HOME: '/home/node', CLAUDE_HOME: '/home/node/.claude' },
      };
      mockResolveCredentials.mockResolvedValue(credentialsWithClaudeHome);

      const backend = new ContainerExecutionBackend();
      await backend.available();

      const opts = makeOptions({
        env: {
          // Caller-supplied key matching the strip pattern — should be removed
          CLAUDE_SECRET: 'caller-secret',
          SAFE_VAR: 'keep',
        },
        envStripPatterns: ['CLAUDE_*'],
      });

      await backend.execute('claude', [], opts);

      const runArgs = (localMockRuntime.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      // Caller key matching the pattern must be stripped
      expect(runArgs.env).not.toHaveProperty('CLAUDE_SECRET');
      // Credential key injected AFTER stripping must be present
      expect(runArgs.env).toHaveProperty('CLAUDE_HOME', '/home/node/.claude');
      // Unrelated caller key must be preserved
      expect(runArgs.env).toHaveProperty('SAFE_VAR', 'keep');
    });
  });

  // Story 21.3 AC6: concurrent available() and execute() do not corrupt each other's state
  it('handles concurrent available() and execute() without state corruption', async () => {
    const mockRuntime = createMockRuntime();
    let resolveDetection: (value: ContainerRuntime) => void;
    const delayedDetection = new Promise<ContainerRuntime>((resolve) => {
      resolveDetection = resolve;
    });

    vi.resetModules();
    const concurrentDetect = vi.fn().mockReturnValue(delayedDetection);
    vi.doMock('./detect-runtime.js', () => ({
      detectContainerRuntime: concurrentDetect,
    }));
    vi.doMock('./credential-resolver.js', () => ({
      resolveContainerCredentials: vi.fn().mockResolvedValue(defaultCredentials),
    }));
    vi.doMock('./binary-resolver.js', () => ({
      resolveBinaryMount: vi.fn().mockResolvedValue(null),
    }));
    mockStandardUtilsModule();

    const mod = await import('./container-backend.js');
    const backend = new mod.ContainerExecutionBackend();

    // Fire available() and execute() concurrently — both need the runtime
    const availablePromise = backend.available();
    const executePromise = backend.execute('claude', ['--print', 'test'], makeOptions());

    // Resolve the detection after both calls are in-flight
    resolveDetection!(mockRuntime);

    const [availableResult, executeResult] = await Promise.all([availablePromise, executePromise]);

    // Both should succeed without corruption
    expect(availableResult).toBe(true);
    expect(executeResult.exitCode).toBe(0);
    // Runtime detection should only be called once (cached promise shared)
    expect(concurrentDetect).toHaveBeenCalledTimes(1);
  });
});
