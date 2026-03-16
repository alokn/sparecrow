/** Platform detection helpers. */
import { platform } from 'node:process';
import { normalize } from 'node:path';

/** Default WSL Windows filesystem mount prefix. */
const DEFAULT_WSL_MOUNT_PREFIX = '/mnt/';

/** Returns true when running on macOS. */
export function isMacOS(): boolean {
  return platform === 'darwin';
}

/** Returns true when running on Linux. */
export function isLinux(): boolean {
  return platform === 'linux';
}

/**
 * Returns true when the given path resides on a Windows-hosted mount point under WSL.
 * WSL2 has native ext4 filesystems (e.g., ~/,  /tmp/) where POSIX permissions work correctly.
 * Only Windows-hosted mounts (default: /mnt/) lack proper permission enforcement.
 * On non-Linux platforms, always returns false.
 *
 * @param filePath - Absolute path to check
 * @param mountPrefix - Windows mount prefix (default: /mnt/). Must end with /.
 */
export function isWslWindowsPath(filePath: string, mountPrefix?: string): boolean {
  if (platform !== 'linux') {
    return false;
  }
  const prefix = mountPrefix ?? DEFAULT_WSL_MOUNT_PREFIX;
  const normalised = normalize(filePath);
  return normalised.startsWith(prefix);
}
