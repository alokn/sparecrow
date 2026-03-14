/** Unit tests for onboard-container — container runtime detection, validation, and auto-selection. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const actualUtils =
  await vi.importActual<typeof import('../../utils/index.js')>('../../utils/index.js');

/** Creates a mock ContainerRuntime with the given name and optional behaviour overrides. */
function makeMockRuntime(
  name: string,
  overrides?: {
    infoThrows?: boolean;
    infoVersion?: string;
    runThrows?: boolean;
    waitExitCode?: number | null;
    logsStdout?: string;
    logsStderr?: string;
    removeThrows?: boolean;
  },
) {
  const opts = {
    infoThrows: false,
    infoVersion: '24.0.1',
    runThrows: false,
    waitExitCode: 0,
    logsStdout: 'sparecrow-container-test\n',
    logsStderr: '',
    removeThrows: false,
    ...overrides,
  };

  return {
    name,
    available: vi.fn().mockResolvedValue(true),
    info: opts.infoThrows
      ? vi.fn().mockRejectedValue(new Error('info failed'))
      : vi.fn().mockResolvedValue({ version: opts.infoVersion, rootless: false }),
    run: opts.runThrows
      ? vi.fn().mockRejectedValue(new Error('run failed'))
      : vi.fn().mockResolvedValue({ containerId: 'test-container-id' }),
    wait: vi.fn().mockResolvedValue({ exitCode: opts.waitExitCode, oomKilled: false }),
    logs: vi.fn().mockResolvedValue({ stdout: opts.logsStdout, stderr: opts.logsStderr }),
    remove: opts.removeThrows
      ? vi.fn().mockRejectedValue(new Error('remove failed'))
      : vi.fn().mockResolvedValue(undefined),
    stats: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
  };
}

describe('runContainerDetectionStage()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls process.exit(1) and logs error when no runtime is available', async () => {
    const mockOutro = vi.fn();
    const mockLogError = vi.fn();
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    vi.doMock('@clack/prompts', () => ({
      select: vi.fn(),
      confirm: vi.fn(),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
      log: { info: vi.fn(), error: mockLogError },
      isCancel: vi.fn().mockReturnValue(false),
      outro: mockOutro,
    }));
    vi.doMock('../../utils/index.js', () => ({
      ...actualUtils,
      logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    }));
    vi.doMock('../../providers/backends/container/detect-runtime.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue(null),
    }));

    const { runContainerDetectionStage } = await import('./onboard-container.js');
    await runContainerDetectionStage();
    expect(mockLogError).toHaveBeenCalledWith(
      'sparecrow requires Docker or Podman. Install a container runtime and run `sparecrow onboard` again.',
    );
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('displays both runtimes and allows choice when both are available', async () => {
    const dockerRuntime = makeMockRuntime('docker', { infoVersion: '24.0.1' });
    const podmanRuntime = makeMockRuntime('podman', { infoVersion: '5.2.0' });

    // User selects 'podman' runtime
    const selectMock = vi.fn().mockResolvedValueOnce('podman');

    vi.doMock('@clack/prompts', () => ({
      select: selectMock,
      confirm: vi.fn(),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
      log: { info: vi.fn(), error: vi.fn() },
      isCancel: vi.fn().mockReturnValue(false),
      outro: vi.fn(),
    }));
    vi.doMock('../../utils/index.js', () => ({
      ...actualUtils,
      logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    }));
    vi.doMock('../../providers/backends/container/detect-runtime.js', () => ({
      detectContainerRuntime: vi
        .fn()
        .mockImplementation((pref: string) =>
          pref === 'docker' ? Promise.resolve(dockerRuntime) : Promise.resolve(podmanRuntime),
        ),
    }));

    const { runContainerDetectionStage } = await import('./onboard-container.js');
    const result = await runContainerDetectionStage();
    expect(result).toEqual({
      containerRuntime: 'podman',
      containerRuntimeVersion: '5.2.0',
    });
  });

  it('auto-selects Docker when only Docker is available', async () => {
    const dockerRuntime = makeMockRuntime('docker', { infoVersion: '24.0.1' });

    vi.doMock('@clack/prompts', () => ({
      select: vi.fn(),
      confirm: vi.fn(),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
      log: { info: vi.fn(), error: vi.fn() },
      isCancel: vi.fn().mockReturnValue(false),
      outro: vi.fn(),
    }));
    vi.doMock('../../utils/index.js', () => ({
      ...actualUtils,
      logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    }));
    vi.doMock('../../providers/backends/container/detect-runtime.js', () => ({
      detectContainerRuntime: vi
        .fn()
        .mockImplementation((pref: string) =>
          pref === 'docker' ? Promise.resolve(dockerRuntime) : Promise.resolve(null),
        ),
    }));

    const { runContainerDetectionStage } = await import('./onboard-container.js');
    const result = await runContainerDetectionStage();
    expect(result).toEqual({
      containerRuntime: 'docker',
      containerRuntimeVersion: '24.0.1',
    });
  });

  it('returns cancel symbol when user cancels runtime choice', async () => {
    const dockerRuntime = makeMockRuntime('docker');
    const podmanRuntime = makeMockRuntime('podman');
    const cancelSymbol = Symbol('cancel');

    vi.doMock('@clack/prompts', () => ({
      select: vi.fn().mockResolvedValue(cancelSymbol),
      confirm: vi.fn(),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
      log: { info: vi.fn(), error: vi.fn() },
      isCancel: vi.fn((v: unknown) => v === cancelSymbol),
      outro: vi.fn(),
    }));
    vi.doMock('../../utils/index.js', () => ({
      ...actualUtils,
      logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    }));
    vi.doMock('../../providers/backends/container/detect-runtime.js', () => ({
      detectContainerRuntime: vi
        .fn()
        .mockImplementation((pref: string) =>
          pref === 'docker' ? Promise.resolve(dockerRuntime) : Promise.resolve(podmanRuntime),
        ),
    }));

    const { runContainerDetectionStage } = await import('./onboard-container.js');
    const result = await runContainerDetectionStage();
    expect(typeof result).toBe('symbol');
  });

  it('handles runtime.info() failure gracefully -- shows version as unknown', async () => {
    const dockerRuntime = makeMockRuntime('docker', { infoThrows: true });

    vi.doMock('@clack/prompts', () => ({
      select: vi.fn(),
      confirm: vi.fn(),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
      log: { info: vi.fn(), error: vi.fn() },
      isCancel: vi.fn().mockReturnValue(false),
      outro: vi.fn(),
    }));
    vi.doMock('../../utils/index.js', () => ({
      ...actualUtils,
      logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    }));
    vi.doMock('../../providers/backends/container/detect-runtime.js', () => ({
      detectContainerRuntime: vi
        .fn()
        .mockImplementation((pref: string) =>
          pref === 'docker' ? Promise.resolve(dockerRuntime) : Promise.resolve(null),
        ),
    }));

    const { runContainerDetectionStage } = await import('./onboard-container.js');
    const result = await runContainerDetectionStage();
    expect(result).toEqual({
      containerRuntime: 'docker',
      containerRuntimeVersion: 'unknown',
    });
  });

  it('calls process.exit(1) when detectContainerRuntime() throws unexpectedly', async () => {
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    vi.doMock('@clack/prompts', () => ({
      select: vi.fn(),
      confirm: vi.fn(),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
      log: { info: vi.fn(), error: vi.fn() },
      isCancel: vi.fn().mockReturnValue(false),
      outro: vi.fn(),
    }));
    vi.doMock('../../utils/index.js', () => ({
      ...actualUtils,
      logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    }));
    vi.doMock('../../providers/backends/container/detect-runtime.js', () => ({
      detectContainerRuntime: vi.fn().mockRejectedValue(new Error('socket closed')),
    }));

    const { runContainerDetectionStage } = await import('./onboard-container.js');
    // Both detections throw, treated as "no runtime available" — calls process.exit(1)
    await runContainerDetectionStage();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('returns docker when both available and user selects Docker', async () => {
    const dockerRuntime = makeMockRuntime('docker', { infoVersion: '24.0.1' });
    const podmanRuntime = makeMockRuntime('podman', { infoVersion: '5.2.0' });

    // User selects 'docker' runtime
    const selectMock = vi.fn().mockResolvedValueOnce('docker');

    vi.doMock('@clack/prompts', () => ({
      select: selectMock,
      confirm: vi.fn(),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
      log: { info: vi.fn(), error: vi.fn() },
      isCancel: vi.fn().mockReturnValue(false),
      outro: vi.fn(),
    }));
    vi.doMock('../../utils/index.js', () => ({
      ...actualUtils,
      logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    }));
    vi.doMock('../../providers/backends/container/detect-runtime.js', () => ({
      detectContainerRuntime: vi
        .fn()
        .mockImplementation((pref: string) =>
          pref === 'docker' ? Promise.resolve(dockerRuntime) : Promise.resolve(podmanRuntime),
        ),
    }));

    const { runContainerDetectionStage } = await import('./onboard-container.js');
    const result = await runContainerDetectionStage();
    expect(result).toEqual({
      containerRuntime: 'docker',
      containerRuntimeVersion: '24.0.1',
    });
  });
});

describe('runContainerValidationTest()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns success when test container passes', async () => {
    vi.doMock('@clack/prompts', () => ({
      select: vi.fn(),
      confirm: vi.fn(),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
      log: { info: vi.fn(), error: vi.fn() },
      isCancel: vi.fn().mockReturnValue(false),
      outro: vi.fn(),
    }));
    vi.doMock('../../utils/index.js', () => ({
      ...actualUtils,
      logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    }));
    vi.doMock('../../providers/backends/container/detect-runtime.js', () => ({
      detectContainerRuntime: vi.fn(),
    }));

    const { runContainerValidationTest } = await import('./onboard-container.js');
    const runtime = makeMockRuntime('docker');
    const result = await runContainerValidationTest(runtime as never);
    expect(result).toEqual({ success: true, error: null });
    expect(runtime.remove).toHaveBeenCalledWith('test-container-id');
  });

  it('returns failure when test container has non-zero exit code', async () => {
    vi.doMock('@clack/prompts', () => ({
      select: vi.fn(),
      confirm: vi.fn(),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
      log: { info: vi.fn(), error: vi.fn() },
      isCancel: vi.fn().mockReturnValue(false),
      outro: vi.fn(),
    }));
    vi.doMock('../../utils/index.js', () => ({
      ...actualUtils,
      logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    }));
    vi.doMock('../../providers/backends/container/detect-runtime.js', () => ({
      detectContainerRuntime: vi.fn(),
    }));

    const { runContainerValidationTest } = await import('./onboard-container.js');
    const runtime = makeMockRuntime('docker', { waitExitCode: 1, logsStdout: 'error output' });
    const result = await runContainerValidationTest(runtime as never);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(runtime.remove).toHaveBeenCalledWith('test-container-id');
  });

  it('returns failure when runtime.run() throws', async () => {
    vi.doMock('@clack/prompts', () => ({
      select: vi.fn(),
      confirm: vi.fn(),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
      log: { info: vi.fn(), error: vi.fn() },
      isCancel: vi.fn().mockReturnValue(false),
      outro: vi.fn(),
    }));
    vi.doMock('../../utils/index.js', () => ({
      ...actualUtils,
      logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    }));
    vi.doMock('../../providers/backends/container/detect-runtime.js', () => ({
      detectContainerRuntime: vi.fn(),
    }));

    const { runContainerValidationTest } = await import('./onboard-container.js');
    const runtime = makeMockRuntime('docker', { runThrows: true });
    const result = await runContainerValidationTest(runtime as never);
    expect(result.success).toBe(false);
    expect(result.error).toContain('run failed');
    // remove should not be called since run() threw before containerId was set
    expect(runtime.remove).not.toHaveBeenCalled();
  });

  it('swallows runtime.remove() error during cleanup', async () => {
    vi.doMock('@clack/prompts', () => ({
      select: vi.fn(),
      confirm: vi.fn(),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
      log: { info: vi.fn(), error: vi.fn() },
      isCancel: vi.fn().mockReturnValue(false),
      outro: vi.fn(),
    }));
    vi.doMock('../../utils/index.js', () => ({
      ...actualUtils,
      logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    }));
    vi.doMock('../../providers/backends/container/detect-runtime.js', () => ({
      detectContainerRuntime: vi.fn(),
    }));

    const { runContainerValidationTest } = await import('./onboard-container.js');
    const runtime = makeMockRuntime('docker', { removeThrows: true });
    // Should not throw even though remove() fails
    const result = await runContainerValidationTest(runtime as never);
    expect(result).toEqual({ success: true, error: null });
    expect(runtime.remove).toHaveBeenCalledWith('test-container-id');
  });
});

describe('runContainerDetectionStage() — validation flow', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls process.exit(1) when validation fails', async () => {
    const dockerRuntime = makeMockRuntime('docker', {
      waitExitCode: 1,
      logsStdout: 'error',
    });

    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    vi.doMock('@clack/prompts', () => ({
      select: vi.fn(),
      confirm: vi.fn(),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
      log: { info: vi.fn(), error: vi.fn() },
      isCancel: vi.fn().mockReturnValue(false),
      outro: vi.fn(),
    }));
    vi.doMock('../../utils/index.js', () => ({
      ...actualUtils,
      logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    }));
    vi.doMock('../../providers/backends/container/detect-runtime.js', () => ({
      detectContainerRuntime: vi
        .fn()
        .mockImplementation((pref: string) =>
          pref === 'docker' ? Promise.resolve(dockerRuntime) : Promise.resolve(null),
        ),
    }));

    const { runContainerDetectionStage } = await import('./onboard-container.js');
    await runContainerDetectionStage();
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});

describe('autoSelectExecutionBackend()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('selects container when runtime available and validation passes', async () => {
    vi.doMock('@clack/prompts', () => ({
      select: vi.fn(),
      confirm: vi.fn(),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
      log: { info: vi.fn(), error: vi.fn() },
      isCancel: vi.fn().mockReturnValue(false),
      outro: vi.fn(),
    }));
    vi.doMock('../../utils/index.js', () => ({
      ...actualUtils,
      logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    }));
    vi.doMock('../../providers/backends/container/detect-runtime.js', () => ({
      detectContainerRuntime: vi.fn(),
    }));

    const { autoSelectExecutionBackend } = await import('./onboard-container.js');
    const runtime = makeMockRuntime('docker', { infoVersion: '24.0.1' });
    const result = await autoSelectExecutionBackend(runtime as never);
    expect(result).toEqual({
      containerRuntime: 'docker',
      containerRuntimeVersion: '24.0.1',
    });
  });

  it('throws CONTAINER_RUNTIME_NOT_FOUND when validation fails', async () => {
    vi.doMock('@clack/prompts', () => ({
      select: vi.fn(),
      confirm: vi.fn(),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
      log: { info: vi.fn(), error: vi.fn() },
      isCancel: vi.fn().mockReturnValue(false),
      outro: vi.fn(),
    }));
    vi.doMock('../../utils/index.js', () => ({
      ...actualUtils,
      logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    }));
    vi.doMock('../../providers/backends/container/detect-runtime.js', () => ({
      detectContainerRuntime: vi.fn(),
    }));

    const { autoSelectExecutionBackend } = await import('./onboard-container.js');
    const runtime = makeMockRuntime('docker', { runThrows: true });
    await expect(autoSelectExecutionBackend(runtime as never)).rejects.toMatchObject({
      code: 'CONTAINER_RUNTIME_NOT_FOUND',
    });
  });

  it('throws CONTAINER_RUNTIME_NOT_FOUND when no runtime available', async () => {
    vi.doMock('@clack/prompts', () => ({
      select: vi.fn(),
      confirm: vi.fn(),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
      log: { info: vi.fn(), error: vi.fn() },
      isCancel: vi.fn().mockReturnValue(false),
      outro: vi.fn(),
    }));
    vi.doMock('../../utils/index.js', () => ({
      ...actualUtils,
      logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    }));
    vi.doMock('../../providers/backends/container/detect-runtime.js', () => ({
      detectContainerRuntime: vi.fn(),
    }));

    const { autoSelectExecutionBackend } = await import('./onboard-container.js');
    await expect(autoSelectExecutionBackend(null)).rejects.toMatchObject({
      code: 'CONTAINER_RUNTIME_NOT_FOUND',
    });
  });

  it('derives containerRuntime from runtime.name using type guard', async () => {
    vi.doMock('@clack/prompts', () => ({
      select: vi.fn(),
      confirm: vi.fn(),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
      log: { info: vi.fn(), error: vi.fn() },
      isCancel: vi.fn().mockReturnValue(false),
      outro: vi.fn(),
    }));
    vi.doMock('../../utils/index.js', () => ({
      ...actualUtils,
      logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    }));
    vi.doMock('../../providers/backends/container/detect-runtime.js', () => ({
      detectContainerRuntime: vi.fn(),
    }));

    const { autoSelectExecutionBackend } = await import('./onboard-container.js');

    // Test with docker name
    const dockerRuntime = makeMockRuntime('docker');
    const dockerResult = await autoSelectExecutionBackend(dockerRuntime as never);
    expect(dockerResult.containerRuntime).toBe('docker');
  });
});
