/** Service installer — generates and registers systemd/launchd service files for the daemon. */
import { mkdir, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { ScrowError } from '../errors/index.js';
import { ErrorCode } from '../errors/index.js';
import { atomicWrite, logger } from '../utils/index.js';
import { getPaths } from './paths.js';
import { isLinux, isMacOS } from './detect.js';
import { getSystemdServicePath, getLaunchAgentPath, fileExists } from './service-paths.js';
import { generateSystemdUnit } from './templates/systemd.js';
import { generateLaunchdPlist } from './templates/launchd.js';
import type {
  ServiceInstallOptions,
  ServiceInstallResult,
  ServiceUninstallResult,
  ServiceTemplateOpts,
} from '../types/index.js';

const execFileAsync = promisify(execFile);

/**
 * Installs the daemon as a system service (systemd on Linux, launchd on macOS).
 * Registers auto-start but does NOT start the daemon immediately.
 * Returns a ServiceInstallResult with started always false.
 */
export async function installService(
  options?: ServiceInstallOptions,
): Promise<ServiceInstallResult> {
  const force = options?.force ?? false;
  const daemonRunnerFlag = options?.daemonRunnerFlag ?? '--daemon-runner';

  if (isLinux()) {
    return installLinuxService(force, daemonRunnerFlag);
  }

  if (isMacOS()) {
    return installMacOSService(force, daemonRunnerFlag);
  }

  throw new ScrowError(
    ErrorCode.SERVICE_INSTALL_UNSUPPORTED_PLATFORM,
    "Service installation is only supported on Linux (systemd) and macOS (launchd). On other platforms, start the daemon manually with 'sparecrow daemon start'.",
  );
}

/** Installs the daemon as a systemd user service on Linux. */
async function installLinuxService(
  force: boolean,
  daemonRunnerFlag: string,
): Promise<ServiceInstallResult> {
  const serviceFilePath = getSystemdServicePath();
  const alreadyExists = await fileExists(serviceFilePath);
  const overwritten = alreadyExists && force;

  if (alreadyExists && !force) {
    // Caller must handle overwrite prompt — return early without writing
    // The CLI layer checks for existing file before calling installService.
    // But if force is false and file exists, we just return with overwritten: false
    // so the CLI can detect this and handle the confirmation prompt.
    // Note: The actual prompting logic is in the CLI layer (daemon.ts).
    // This path is reached when force=false is passed explicitly by non-CLI callers.
    // For CLI callers that don't pass force and don't pre-check, return gracefully.
    return {
      platform: 'linux',
      serviceFilePath,
      method: 'systemd',
      overwritten: false,
      started: false,
    };
  }

  const paths = getPaths();
  const configPath = join(paths.config, 'config.yaml');
  const dataPath = paths.data;

  const templateOpts: ServiceTemplateOpts = {
    nodePath: process.execPath,
    entrypoint: process.argv[1] ?? process.execPath,
    configPath,
    dataPath,
    daemonRunnerFlag,
  };

  const unitContent = generateSystemdUnit(templateOpts);

  // Ensure parent directory exists
  await mkdir(dirname(serviceFilePath), { recursive: true });

  // Atomic write with 0o600 permissions
  await atomicWrite(serviceFilePath, unitContent);

  // Register with systemd
  try {
    await execFileAsync('systemctl', ['--user', 'daemon-reload']);
  } catch (err) {
    throw new ScrowError(
      ErrorCode.SERVICE_ENABLE_FAILED,
      `systemctl --user daemon-reload failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    await execFileAsync('systemctl', ['--user', 'enable', 'sparecrow']);
  } catch (err) {
    throw new ScrowError(
      ErrorCode.SERVICE_ENABLE_FAILED,
      `systemctl --user enable sparecrow failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    platform: 'linux',
    serviceFilePath,
    method: 'systemd',
    overwritten: overwritten,
    started: false,
  };
}

/** Installs the daemon as a launchd LaunchAgent on macOS. */
async function installMacOSService(
  force: boolean,
  daemonRunnerFlag: string,
): Promise<ServiceInstallResult> {
  const serviceFilePath = getLaunchAgentPath();
  const alreadyExists = await fileExists(serviceFilePath);
  const overwritten = alreadyExists && force;

  if (alreadyExists && !force) {
    return {
      platform: 'darwin',
      serviceFilePath,
      method: 'launchd',
      overwritten: false,
      started: false,
    };
  }

  const paths = getPaths();
  const configPath = join(paths.config, 'config.yaml');
  const dataPath = paths.data;

  const templateOpts: ServiceTemplateOpts = {
    nodePath: process.execPath,
    entrypoint: process.argv[1] ?? process.execPath,
    configPath,
    dataPath,
    daemonRunnerFlag,
  };

  const plistContent = generateLaunchdPlist(templateOpts);

  // Ensure parent directory exists
  await mkdir(dirname(serviceFilePath), { recursive: true });

  // Atomic write with 0o600 permissions
  await atomicWrite(serviceFilePath, plistContent);

  // Load service with launchctl — always use absolute path (never tilde-prefixed)
  try {
    await execFileAsync('launchctl', ['load', serviceFilePath]);
  } catch (err) {
    throw new ScrowError(
      ErrorCode.SERVICE_ENABLE_FAILED,
      `launchctl load failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    platform: 'darwin',
    serviceFilePath,
    method: 'launchd',
    overwritten: overwritten,
    started: false,
  };
}

/**
 * Uninstalls the daemon service (disables auto-start and removes service file).
 * Does NOT call stopDaemon — the CLI layer is responsible for stopping the daemon first.
 * The `stopped` field is always false here; the CLI layer sets the actual value.
 */
export async function uninstallService(): Promise<ServiceUninstallResult> {
  if (isLinux()) {
    return uninstallLinuxService();
  }

  if (isMacOS()) {
    return uninstallMacOSService();
  }

  throw new ScrowError(
    ErrorCode.SERVICE_INSTALL_UNSUPPORTED_PLATFORM,
    "Service uninstallation is only supported on Linux (systemd) and macOS (launchd). On other platforms, start the daemon manually with 'sparecrow daemon start'.",
  );
}

/** Uninstalls systemd user service on Linux. */
async function uninstallLinuxService(): Promise<ServiceUninstallResult> {
  const serviceFilePath = getSystemdServicePath();
  const exists = await fileExists(serviceFilePath);

  if (!exists) {
    return {
      platform: 'linux',
      serviceFilePath,
      stopped: false,
      removed: false,
    };
  }

  // Disable auto-start (noop if not enabled — systemctl exits 0)
  try {
    await execFileAsync('systemctl', ['--user', 'disable', 'sparecrow']);
  } catch (err) {
    void logger.debug('service-installer.uninstall_linux.disable_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    await execFileAsync('systemctl', ['--user', 'daemon-reload']);
  } catch (err) {
    void logger.debug('service-installer.uninstall_linux.daemon_reload_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Remove the service file
  try {
    await unlink(serviceFilePath);
  } catch (err) {
    throw new ScrowError(
      ErrorCode.SERVICE_UNINSTALL_FAILED,
      `Failed to remove service file at ${serviceFilePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    platform: 'linux',
    serviceFilePath,
    stopped: false,
    removed: true,
  };
}

/** Uninstalls launchd LaunchAgent on macOS. */
async function uninstallMacOSService(): Promise<ServiceUninstallResult> {
  const serviceFilePath = getLaunchAgentPath();
  const exists = await fileExists(serviceFilePath);

  if (!exists) {
    return {
      platform: 'darwin',
      serviceFilePath,
      stopped: false,
      removed: false,
    };
  }

  // Unload service — if file doesn't exist or not loaded, log warning but don't throw
  try {
    await execFileAsync('launchctl', ['unload', serviceFilePath]);
  } catch (err) {
    void logger.debug('service-installer.uninstall_macos.unload_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Remove the service file
  try {
    await unlink(serviceFilePath);
  } catch (err) {
    throw new ScrowError(
      ErrorCode.SERVICE_UNINSTALL_FAILED,
      `Failed to remove service file at ${serviceFilePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    platform: 'darwin',
    serviceFilePath,
    stopped: false,
    removed: true,
  };
}
