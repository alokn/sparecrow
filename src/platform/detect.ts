/** Platform detection helpers. */
import { platform } from 'node:process';

/** Returns true when running on macOS. */
export function isMacOS(): boolean {
  return platform === 'darwin';
}

/** Returns true when running on Linux. */
export function isLinux(): boolean {
  return platform === 'linux';
}
