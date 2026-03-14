/** Unit tests for detectContainerRuntime -- auto-detection logic, preference order, and logging. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventName } from '../../../types/events.js';

describe('detectContainerRuntime', () => {
  let loggerInfoSpy: ReturnType<typeof vi.fn>;
  let loggerDebugSpy: ReturnType<typeof vi.fn>;
  let podmanAvailableMock: ReturnType<typeof vi.fn>;
  let dockerAvailableMock: ReturnType<typeof vi.fn>;
  let podmanInfoMock: ReturnType<typeof vi.fn>;
  let dockerInfoMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();

    loggerInfoSpy = vi.fn().mockResolvedValue(undefined);
    loggerDebugSpy = vi.fn().mockResolvedValue(undefined);

    vi.doMock('../../../utils/index.js', () => ({
      logger: {
        info: loggerInfoSpy,
        debug: loggerDebugSpy,
        warn: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
      },
    }));

    podmanAvailableMock = vi.fn();
    podmanInfoMock = vi.fn();
    dockerAvailableMock = vi.fn();
    dockerInfoMock = vi.fn();

    // Use class-based mocks so `new PodmanRuntime()` works
    vi.doMock('./podman-runtime.js', () => {
      return {
        PodmanRuntime: class MockPodmanRuntime {
          name = 'podman';
          available = podmanAvailableMock;
          info = podmanInfoMock;
        },
      };
    });

    vi.doMock('./docker-runtime.js', () => {
      return {
        DockerRuntime: class MockDockerRuntime {
          name = 'docker';
          available = dockerAvailableMock;
          info = dockerInfoMock;
        },
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function loadDetect() {
    const mod = await import('./detect-runtime.js');
    return mod.detectContainerRuntime;
  }

  it('returns PodmanRuntime when both Podman and Docker are available (Podman preferred)', async () => {
    podmanAvailableMock.mockResolvedValue(true);
    podmanInfoMock.mockResolvedValue({ version: '4.9.0', rootless: true });
    dockerAvailableMock.mockResolvedValue(true);

    const detectContainerRuntime = await loadDetect();
    const result = await detectContainerRuntime();

    expect(result).not.toBeNull();
    expect(result!.name).toBe('podman');
    // Docker should not even have been checked
    expect(dockerAvailableMock).not.toHaveBeenCalled();
  });

  it('returns DockerRuntime when only Docker is available', async () => {
    podmanAvailableMock.mockResolvedValue(false);
    dockerAvailableMock.mockResolvedValue(true);
    dockerInfoMock.mockResolvedValue({ version: '24.0.7', rootless: false });

    const detectContainerRuntime = await loadDetect();
    const result = await detectContainerRuntime();

    expect(result).not.toBeNull();
    expect(result!.name).toBe('docker');
  });

  it('returns PodmanRuntime when only Podman is available', async () => {
    podmanAvailableMock.mockResolvedValue(true);
    podmanInfoMock.mockResolvedValue({ version: '5.0.0', rootless: true });

    const detectContainerRuntime = await loadDetect();
    const result = await detectContainerRuntime();

    expect(result).not.toBeNull();
    expect(result!.name).toBe('podman');
  });

  it('returns null when neither is available', async () => {
    podmanAvailableMock.mockResolvedValue(false);
    dockerAvailableMock.mockResolvedValue(false);

    const detectContainerRuntime = await loadDetect();
    const result = await detectContainerRuntime();

    expect(result).toBeNull();
  });

  it('logs at info level when runtime is selected', async () => {
    podmanAvailableMock.mockResolvedValue(true);
    podmanInfoMock.mockResolvedValue({ version: '4.9.0', rootless: true });

    const detectContainerRuntime = await loadDetect();
    await detectContainerRuntime();

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      EventName.CONTAINER_RUNTIME_DETECTED,
      expect.objectContaining({
        runtime: 'podman',
        message: expect.stringContaining('podman'),
      }),
    );
  });

  it('logs at debug level when runtime is unavailable', async () => {
    podmanAvailableMock.mockResolvedValue(false);
    dockerAvailableMock.mockResolvedValue(true);
    dockerInfoMock.mockResolvedValue({ version: '24.0.7', rootless: false });

    const detectContainerRuntime = await loadDetect();
    await detectContainerRuntime();

    expect(loggerDebugSpy).toHaveBeenCalledWith(
      EventName.CONTAINER_RUNTIME_UNAVAILABLE,
      expect.objectContaining({
        runtime: 'podman',
        message: expect.stringContaining('not available'),
      }),
    );
  });

  it('logs at debug level when no runtime found', async () => {
    podmanAvailableMock.mockResolvedValue(false);
    dockerAvailableMock.mockResolvedValue(false);

    const detectContainerRuntime = await loadDetect();
    await detectContainerRuntime();

    expect(loggerDebugSpy).toHaveBeenCalledWith(
      EventName.CONTAINER_RUNTIME_NOT_FOUND,
      expect.objectContaining({
        message: expect.stringContaining('No container runtime detected'),
      }),
    );
  });

  it('still returns runtime if info() call fails', async () => {
    podmanAvailableMock.mockResolvedValue(true);
    podmanInfoMock.mockRejectedValue(new Error('info failed'));

    const detectContainerRuntime = await loadDetect();
    const result = await detectContainerRuntime();

    expect(result).not.toBeNull();
    expect(result!.name).toBe('podman');
  });

  // ─── Story 12.2: runtime preference parameter tests ──────────────────────

  // 8.3: detectContainerRuntime('docker') only probes Docker, skips Podman
  it('only probes Docker when preference is "docker" (skips Podman)', async () => {
    dockerAvailableMock.mockResolvedValue(true);
    dockerInfoMock.mockResolvedValue({ version: '24.0.7', rootless: false });

    const detectContainerRuntime = await loadDetect();
    const result = await detectContainerRuntime('docker');

    expect(result).not.toBeNull();
    expect(result!.name).toBe('docker');
    expect(podmanAvailableMock).not.toHaveBeenCalled();
  });

  // 8.4: detectContainerRuntime('podman') only probes Podman, skips Docker
  it('only probes Podman when preference is "podman" (skips Docker)', async () => {
    podmanAvailableMock.mockResolvedValue(true);
    podmanInfoMock.mockResolvedValue({ version: '4.9.0', rootless: true });

    const detectContainerRuntime = await loadDetect();
    const result = await detectContainerRuntime('podman');

    expect(result).not.toBeNull();
    expect(result!.name).toBe('podman');
    expect(dockerAvailableMock).not.toHaveBeenCalled();
  });

  // 8.5: detectContainerRuntime('auto') probes Podman first, then Docker
  it('probes Podman first then Docker when preference is "auto"', async () => {
    podmanAvailableMock.mockResolvedValue(false);
    dockerAvailableMock.mockResolvedValue(true);
    dockerInfoMock.mockResolvedValue({ version: '24.0.7', rootless: false });

    const detectContainerRuntime = await loadDetect();
    const result = await detectContainerRuntime('auto');

    expect(result).not.toBeNull();
    expect(result!.name).toBe('docker');
    expect(podmanAvailableMock).toHaveBeenCalled();
    expect(dockerAvailableMock).toHaveBeenCalled();
  });

  // 8.6: detectContainerRuntime() with no argument preserves existing behavior
  it('preserves existing behavior (Podman first) when called with no argument', async () => {
    podmanAvailableMock.mockResolvedValue(false);
    dockerAvailableMock.mockResolvedValue(true);
    dockerInfoMock.mockResolvedValue({ version: '24.0.7', rootless: false });

    const detectContainerRuntime = await loadDetect();
    const result = await detectContainerRuntime();

    expect(result).not.toBeNull();
    expect(result!.name).toBe('docker');
    expect(podmanAvailableMock).toHaveBeenCalled();
  });

  it('returns null when preference is "docker" and Docker is not available', async () => {
    dockerAvailableMock.mockResolvedValue(false);

    const detectContainerRuntime = await loadDetect();
    const result = await detectContainerRuntime('docker');

    expect(result).toBeNull();
    expect(podmanAvailableMock).not.toHaveBeenCalled();
  });

  it('returns null when preference is "podman" and Podman is not available', async () => {
    podmanAvailableMock.mockResolvedValue(false);

    const detectContainerRuntime = await loadDetect();
    const result = await detectContainerRuntime('podman');

    expect(result).toBeNull();
    expect(dockerAvailableMock).not.toHaveBeenCalled();
  });
});
