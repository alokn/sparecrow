/** Creates container runtime shims (docker/podman) in homeDir/bin for E2E tests. */
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Docker shim that responds to all commands used by runContainerDetectionStage():
 * - docker info              → exit 0 (availability probe)
 * - docker version --format  → prints "24.0.5" (version string)
 * - docker info --format     → prints security options (rootless probe)
 * - docker run --detach ...  → prints fake container ID "e2eshim0000"
 * - docker wait <id>         → prints "0" (container exited with code 0)
 * - docker inspect --format  → prints "false" (OOM check)
 * - docker logs <id>         → prints "sparecrow-container-test" to stdout
 * - docker rm --force <id>   → exit 0
 */
const DOCKER_SHIM = `#!/usr/bin/env bash
# E2E docker shim for sparecrow container detection tests
case "$1" in
  info)
    if [ "$2" = "--format" ]; then
      echo "name=seccomp,profile=/etc/docker/seccomp.json"
    else
      echo "Server: Docker Engine (e2e-shim)"
    fi
    exit 0
    ;;
  version)
    echo "24.0.5"
    exit 0
    ;;
  run)
    echo "e2eshim0000"
    exit 0
    ;;
  wait)
    echo "0"
    exit 0
    ;;
  inspect)
    echo "false"
    exit 0
    ;;
  logs)
    echo "sparecrow-container-test"
    exit 0
    ;;
  rm)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`;

/**
 * Podman shim that always exits 1 on `podman info` so Podman is treated as unavailable.
 * This prevents the "Select container runtime:" prompt when only Docker is shimmed.
 */
const PODMAN_UNAVAILABLE_SHIM = `#!/usr/bin/env bash
# E2E podman shim -- simulates podman not available
exit 1
`;

/**
 * Creates docker and podman shims in a bin directory.
 *
 * - `docker` responds to all commands used by runContainerDetectionStage() and
 *   runContainerValidationTest(), returning success without launching real containers.
 * - `podman` exits 1 on all invocations so Podman is treated as unavailable, preventing
 *   the "Select container runtime:" selection prompt.
 *
 * Callers must ensure the bin directory is prepended to PATH (via ptyEnv/shimEnv).
 *
 * @param homeDir - The isolated HOME directory for the test
 * @param binDirOverride - Optional bin directory path; defaults to `homeDir/bin`.
 *   Pass the `shimBinPath` returned by `osCmdShim()` to co-locate container shims
 *   with OS service shims so a single PATH entry covers all shims.
 */
export async function containerShim(homeDir: string, binDirOverride?: string): Promise<void> {
  const binDir = binDirOverride ?? join(homeDir, 'bin');
  await mkdir(binDir, { recursive: true });

  const dockerPath = join(binDir, 'docker');
  await writeFile(dockerPath, DOCKER_SHIM, 'utf8');
  await chmod(dockerPath, 0o755);

  const podmanPath = join(binDir, 'podman');
  await writeFile(podmanPath, PODMAN_UNAVAILABLE_SHIM, 'utf8');
  await chmod(podmanPath, 0o755);
}
