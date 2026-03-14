/** Shared helpers for daemon service E2E test suites. */
import { join } from 'node:path';

/**
 * Returns env overrides that isolate the spawned binary inside homeDir with OS-command shims on
 * PATH. Overrides all XDG base dirs so env-paths always resolves inside homeDir, even on CI where
 * XDG_DATA_HOME / XDG_CACHE_HOME may be set globally.
 */
export function shimEnv(homeDir: string, shimBinPath: string): Record<string, string> {
  return {
    HOME: homeDir,
    PATH: shimBinPath + ':' + (process.env.PATH ?? ''),
    XDG_CONFIG_HOME: join(homeDir, '.config'),
    XDG_STATE_HOME: join(homeDir, '.local', 'state'),
    XDG_DATA_HOME: join(homeDir, '.local', 'share'),
    XDG_CACHE_HOME: join(homeDir, '.cache'),
  };
}

/**
 * Returns the expected service file path inside homeDir for the current platform.
 * Throws on unsupported platforms so tests fail explicitly rather than silently skipping.
 */
export function platformServicePath(homeDir: string): string {
  if (process.platform === 'darwin') {
    return join(homeDir, 'Library', 'LaunchAgents', 'com.sparecrow.daemon.plist');
  }
  if (process.platform === 'linux') {
    return join(homeDir, '.config', 'systemd', 'user', 'sparecrow.service');
  }
  throw new Error(
    `platformServicePath: unsupported platform '${process.platform}' — tests cannot run on this OS`,
  );
}
