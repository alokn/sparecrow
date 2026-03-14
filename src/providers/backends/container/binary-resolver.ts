/** BinaryResolver -- resolves host claude binary path to container mount configuration. */
import { realpath, access, stat, constants } from 'node:fs/promises';
import { dirname, basename } from 'node:path';
import type { Mount } from './runtime.js';
import { logger } from '../../../utils/index.js';
import { EventName } from '../../../types/index.js';

/** Container-side base directory for the mounted claude installation. */
const CONTAINER_INSTALL_DIR = '/opt/claude';

/** Return type for binary mount resolution. */
export interface BinaryMountResult {
  /** Mount for the installation directory (read-only). */
  mount: Mount;
  /** The command path to use inside the container. */
  containerCommandPath: string;
}

/** Options for overriding binary resolution (primarily for testability). */
export interface BinaryResolverOptions {
  /** Override the container-side install directory. */
  containerInstallDir?: string;
}

/**
 * Resolves the host claude binary path to a container mount configuration.
 *
 * Follows symlinks to find the real installation directory, then returns
 * a read-only mount mapping that directory into the container at /opt/claude/<dirname>.
 *
 * Returns null on failure (broken symlinks, permission errors, etc.) -- the caller
 * should proceed without the mount and let the container fail with a clear error.
 */
export async function resolveBinaryMount(
  claudePath: string,
  options?: BinaryResolverOptions,
): Promise<BinaryMountResult | null> {
  const containerInstallDir = options?.containerInstallDir ?? CONTAINER_INSTALL_DIR;

  try {
    // Verify the path exists and is executable (X_OK is correct for a binary)
    await access(claudePath, constants.X_OK);

    // Resolve symlinks to find the real path
    const resolvedPath = await realpath(claudePath);

    // Determine if the resolved path is a file or directory
    const pathStat = await stat(resolvedPath);

    let installDir: string;
    let entryPointName: string;

    if (pathStat.isDirectory()) {
      // The resolved path is a directory (e.g. the installation root itself)
      installDir = resolvedPath;
      entryPointName = '';
    } else {
      // The resolved path is a file — mount its parent directory
      // so sibling files (node_modules, lib/, etc.) are available
      installDir = dirname(resolvedPath);
      entryPointName = basename(resolvedPath);
    }

    // Guard: reject degenerate paths where dirname returns '/' — mounting the entire
    // host filesystem read-only into the container is a serious security boundary violation.
    if (installDir === '/' || installDir.split('/').filter(Boolean).length < 1) {
      void logger
        .warn(EventName.CONTAINER_BINARY_MOUNT_FAILED, {
          claudePath,
          error: `Resolved installation directory is '${installDir}' — refusing to mount root filesystem`,
          message:
            'Binary resolver rejected a degenerate install directory. The task will fail at execution time with a clear error from the container.',
        })
        .catch(() => {
          // Swallow logger rejection so disk-full cannot propagate here
        });
      return null;
    }

    // Container-side target: /opt/claude/<dir-name>
    const dirName = basename(installDir);
    const containerTarget = `${containerInstallDir}/${dirName}`;

    const mount: Mount = {
      source: installDir,
      target: containerTarget,
      readonly: true,
    };

    // Container-side command path
    const containerCommandPath = entryPointName
      ? `${containerTarget}/${entryPointName}`
      : containerTarget;

    void logger
      .info(EventName.CONTAINER_BINARY_MOUNTED, {
        hostSource: installDir,
        containerTarget,
        containerCommandPath,
        resolvedFrom: claudePath,
      })
      .catch(() => {
        // Swallow logger rejection so a full disk cannot break the mount resolution
      });

    return { mount, containerCommandPath };
  } catch (err: unknown) {
    // Graceful degradation (AC6): log warning and return null
    void logger
      .warn(EventName.CONTAINER_BINARY_MOUNT_FAILED, {
        claudePath,
        error: err instanceof Error ? err.message : String(err),
        message:
          'Failed to resolve claude binary for container mount. The task will fail at execution time with a clear error from the container.',
      })
      .catch(() => {
        // Swallow logger rejection so a full disk cannot suppress the original error path
      });

    return null;
  }
}
