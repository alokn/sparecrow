/** Shared helpers for resolving platform-specific daemon service file paths and checking existence. */
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Returns the canonical systemd user unit file path (Linux). */
export function getSystemdServicePath(): string {
  return join(homedir(), '.config', 'systemd', 'user', 'sparecrow.service');
}

/** Returns the canonical launchd LaunchAgent plist path (macOS). */
export function getLaunchAgentPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', 'com.sparecrow.daemon.plist');
}

/** Returns the service file path for the current platform. Falls back to systemd path for
 *  unsupported platforms (installService/uninstallService will throw UNSUPPORTED_PLATFORM). */
export function getPlatformServicePath(): string {
  const { platform } = process;
  if (platform === 'linux') return getSystemdServicePath();
  if (platform === 'darwin') return getLaunchAgentPath();
  return getSystemdServicePath();
}

/** Checks whether a file exists at the given path. */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
