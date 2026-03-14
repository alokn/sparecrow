/** Onboarding helpers -- container runtime detection and execution backend selection. */
import { select, spinner as createSpinner, log, isCancel, outro } from '@clack/prompts';
import { logger } from '../../utils/index.js';
import { ScrowError, ErrorCode } from '../../errors/index.js';
import { detectContainerRuntime } from '../../providers/backends/container/index.js';
import type { ContainerRuntime } from '../../providers/backends/container/index.js';
import { EventName } from '../../types/index.js';

/** Result of the container detection stage. */
export interface ContainerDetectionResult {
  containerRuntime: 'docker' | 'podman';
  containerRuntimeVersion: string;
}

/** Safely derives the runtime name as a typed union from runtime.name. */
function getRuntimeName(runtime: ContainerRuntime): 'docker' | 'podman' | undefined {
  if (runtime.name === 'docker' || runtime.name === 'podman') return runtime.name;
  return undefined;
}

/**
 * Runs the container runtime detection stage.
 * Probes for Docker and Podman, displays availability, and selects the runtime.
 *
 * Fails with a clear error when no container runtime is detected.
 * Returns a ContainerDetectionResult or a cancel symbol.
 */
export async function runContainerDetectionStage(): Promise<ContainerDetectionResult | symbol> {
  const s = createSpinner();
  s.start('Detecting container runtimes...');

  let dockerRuntime: ContainerRuntime | null = null;
  let podmanRuntime: ContainerRuntime | null = null;

  // Detect both runtimes concurrently
  const [dockerSettled, podmanSettled] = await Promise.allSettled([
    detectContainerRuntime('docker'),
    detectContainerRuntime('podman'),
  ]);

  if (dockerSettled.status === 'fulfilled') {
    dockerRuntime = dockerSettled.value;
  } else {
    void logger.debug(EventName.CONTAINER_RUNTIME_UNAVAILABLE, {
      runtime: 'docker',
      error:
        dockerSettled.reason instanceof Error
          ? dockerSettled.reason.message
          : String(dockerSettled.reason),
    });
  }

  if (podmanSettled.status === 'fulfilled') {
    podmanRuntime = podmanSettled.value;
  } else {
    void logger.debug(EventName.CONTAINER_RUNTIME_UNAVAILABLE, {
      runtime: 'podman',
      error:
        podmanSettled.reason instanceof Error
          ? podmanSettled.reason.message
          : String(podmanSettled.reason),
    });
  }

  // Get version info for available runtimes
  let dockerVersion: string | undefined;
  let podmanVersion: string | undefined;

  if (dockerRuntime) {
    try {
      const info = await dockerRuntime.info();
      dockerVersion = info.version;
    } catch {
      dockerVersion = 'unknown';
    }
  }

  if (podmanRuntime) {
    try {
      const info = await podmanRuntime.info();
      podmanVersion = info.version;
    } catch {
      podmanVersion = 'unknown';
    }
  }

  s.stop('Container runtime detection complete');

  // Log detection results
  void logger.info('onboard.container.detection', {
    dockerAvailable: dockerRuntime !== null,
    dockerVersion: dockerVersion ?? null,
    podmanAvailable: podmanRuntime !== null,
    podmanVersion: podmanVersion ?? null,
  });

  // Display availability
  if (dockerRuntime) {
    log.info(`Docker: available (v${dockerVersion ?? 'unknown'})`);
  } else {
    log.info('Docker: not available');
  }

  if (podmanRuntime) {
    log.info(`Podman: available (v${podmanVersion ?? 'unknown'})`);
  } else {
    log.info('Podman: not available');
  }

  // If neither runtime is available, fail with a clear error and exit.
  // We call outro/process.exit directly here rather than returning a symbol, because
  // returning Symbol.for('cancel') would NOT be recognised by @clack/prompts isCancel()
  // (which uses its own private Symbol("clack:cancel")) and the wizard would continue.
  if (!dockerRuntime && !podmanRuntime) {
    log.error(
      'sparecrow requires Docker or Podman. Install a container runtime and run `sparecrow onboard` again.',
    );
    outro('Setup cancelled.');
    process.exit(1);
    return undefined as never; // process.exit is never in production; guard against test mocks
  }

  // Determine which runtime to use
  let selectedRuntime: ContainerRuntime;
  let selectedVersion: string | undefined;

  if (dockerRuntime && podmanRuntime) {
    // Both available -- let user choose
    const runtimeChoice = await select({
      message: 'Select container runtime:',
      options: [
        {
          value: 'docker',
          label: `Docker (v${dockerVersion ?? 'unknown'})`,
        },
        {
          value: 'podman',
          label: `Podman (v${podmanVersion ?? 'unknown'})`,
        },
      ],
    });

    if (isCancel(runtimeChoice)) {
      return runtimeChoice;
    }

    if (runtimeChoice === 'docker') {
      selectedRuntime = dockerRuntime;
      selectedVersion = dockerVersion;
    } else {
      selectedRuntime = podmanRuntime;
      selectedVersion = podmanVersion;
    }
  } else if (dockerRuntime) {
    selectedRuntime = dockerRuntime;
    selectedVersion = dockerVersion;
  } else {
    selectedRuntime = podmanRuntime!;
    selectedVersion = podmanVersion;
  }

  // Validate the container runtime with a test container
  const validationResult = await runContainerValidationTest(selectedRuntime);

  if (!validationResult.success) {
    // Validation failed -- cancel setup
    log.error(
      `Container validation failed: ${validationResult.error ?? 'unknown error'}. Fix the container runtime and run \`sparecrow onboard\` again.`,
    );
    outro('Setup cancelled.');
    process.exit(1);
  }

  const runtimeName = getRuntimeName(selectedRuntime);

  if (!runtimeName) {
    throw new ScrowError(
      ErrorCode.CONTAINER_RUNTIME_NOT_FOUND,
      `Unsupported container runtime name: '${selectedRuntime.name}'. Only 'docker' and 'podman' are supported.`,
    );
  }

  return {
    containerRuntime: runtimeName,
    containerRuntimeVersion: selectedVersion ?? 'unknown',
  };
}

/** Result of a container validation test. */
interface ValidationTestResult {
  success: boolean;
  error: string | null;
}

/**
 * Runs a minimal test container to validate the runtime works.
 * Uses try/finally to guarantee container cleanup.
 *
 * Returns a validation result.
 */
export async function runContainerValidationTest(
  runtime: ContainerRuntime,
): Promise<ValidationTestResult> {
  const s = createSpinner();
  s.start(
    'Testing container runtime (this may take a minute on first run if the image is not cached)...',
  );

  let containerId: string | null = null;
  try {
    const handle = await runtime.run({
      image: 'node:lts-slim',
      command: ['echo', 'sparecrow-container-test'],
      cwd: '/workspace',
      env: {},
      mounts: [],
    });
    containerId = handle.containerId;

    const exitResult = await runtime.wait(containerId, 30_000);
    const logs = await runtime.logs(containerId);

    if (exitResult.exitCode === 0 && logs.stdout.includes('sparecrow-container-test')) {
      s.stop('Container test passed');
      void logger.info('onboard.container.validation.success', {
        runtime: runtime.name,
      });
      return { success: true, error: null };
    }

    s.stop('Container test failed');
    const errorDetail = `Exit code: ${String(exitResult.exitCode ?? 'null')}, stdout: ${logs.stdout.trim()}, stderr: ${logs.stderr.trim()}`;
    void logger.info('onboard.container.validation.failed', {
      runtime: runtime.name,
      error: errorDetail,
    });
    return { success: false, error: errorDetail };
  } catch (err) {
    s.stop('Container test failed');
    const errorMsg = err instanceof Error ? err.message : String(err);
    void logger.info('onboard.container.validation.error', {
      runtime: runtime.name,
      error: errorMsg,
    });
    return { success: false, error: errorMsg };
  } finally {
    if (containerId) {
      await runtime.remove(containerId).catch(() => {});
    }
  }
}

/**
 * Auto-selects execution backend without prompting (for --yes mode).
 * When a runtime is available, auto-selects container and runs validation.
 * Throws ScrowError(CONTAINER_RUNTIME_NOT_FOUND) when no runtime is available.
 */
export async function autoSelectExecutionBackend(
  runtime: ContainerRuntime | null,
): Promise<ContainerDetectionResult> {
  if (!runtime) {
    throw new ScrowError(
      ErrorCode.CONTAINER_RUNTIME_NOT_FOUND,
      'No container runtime available. Install Docker or Podman before using sparecrow.',
    );
  }

  const runtimeName = getRuntimeName(runtime);

  if (!runtimeName) {
    throw new ScrowError(
      ErrorCode.CONTAINER_RUNTIME_NOT_FOUND,
      `Unsupported container runtime name: '${runtime.name}'. Only 'docker' and 'podman' are supported.`,
    );
  }

  let version: string | undefined;
  try {
    const info = await runtime.info();
    version = info.version;
  } catch {
    version = 'unknown';
  }

  // Run validation test
  const validationResult = await runContainerValidationTest(runtime);

  if (validationResult.success) {
    void logger.info('onboard.container.auto_select', {
      decision: 'container',
      runtime: runtimeName,
      reason: 'validation_passed',
    });
    return {
      containerRuntime: runtimeName,
      containerRuntimeVersion: version ?? 'unknown',
    };
  }

  // Validation failed -- throw since container is the only option
  throw new ScrowError(
    ErrorCode.CONTAINER_RUNTIME_NOT_FOUND,
    `Container validation failed for ${runtimeName ?? 'unknown'}: ${validationResult.error ?? 'unknown error'}. Fix the container runtime and try again.`,
  );
}
