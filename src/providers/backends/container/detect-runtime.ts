/** Container runtime auto-detection -- probes host for Podman then Docker availability. */
import { logger } from '../../../utils/index.js';
import { EventName } from '../../../types/index.js';
import type { ContainerRuntime } from './runtime.js';
import { PodmanRuntime } from './podman-runtime.js';
import { DockerRuntime } from './docker-runtime.js';

/**
 * Detects the first available container runtime on the host.
 *
 * @param preference - Runtime preference: 'auto' (default) checks Podman first then Docker,
 *   'docker' only probes Docker, 'podman' only probes Podman.
 * @returns The detected runtime, or null if none is found.
 */
export async function detectContainerRuntime(
  preference: 'auto' | 'docker' | 'podman' = 'auto',
): Promise<ContainerRuntime | null> {
  const probePodman = preference === 'auto' || preference === 'podman';
  const probeDocker = preference === 'auto' || preference === 'docker';

  if (probePodman) {
    const podman = new PodmanRuntime();
    const podmanAvailable = await podman.available();

    if (podmanAvailable) {
      let detail = '';
      try {
        const runtimeInfo = await podman.info();
        detail = ` v${runtimeInfo.version} (rootless: ${String(runtimeInfo.rootless)})`;
      } catch {
        // info() failed -- still use the runtime, just without version detail
      }
      void logger.info(EventName.CONTAINER_RUNTIME_DETECTED, {
        runtime: 'podman',
        message: `Container runtime detected: podman${detail}`,
      });
      return podman;
    }

    void logger.debug(EventName.CONTAINER_RUNTIME_UNAVAILABLE, {
      runtime: 'podman',
      message: probeDocker ? 'Podman not available, checking Docker...' : 'Podman not available.',
    });
  }

  if (probeDocker) {
    const docker = new DockerRuntime();
    const dockerAvailable = await docker.available();

    if (dockerAvailable) {
      let detail = '';
      try {
        const runtimeInfo = await docker.info();
        detail = ` v${runtimeInfo.version} (rootless: ${String(runtimeInfo.rootless)})`;
      } catch {
        // info() failed -- still use the runtime, just without version detail
      }
      void logger.info(EventName.CONTAINER_RUNTIME_DETECTED, {
        runtime: 'docker',
        message: `Container runtime detected: docker${detail}`,
      });
      return docker;
    }

    void logger.debug(EventName.CONTAINER_RUNTIME_UNAVAILABLE, {
      runtime: 'docker',
      message: 'Docker not available.',
    });
  }

  const checked = probePodman && probeDocker ? 'podman, docker' : probePodman ? 'podman' : 'docker';
  void logger.debug(EventName.CONTAINER_RUNTIME_NOT_FOUND, {
    message: `No container runtime detected (checked: ${checked})`,
  });

  return null;
}
