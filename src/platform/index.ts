/** Platform module barrel — re-exports path helpers, detection utilities, and service installer. */

export { getPaths, ensureDirectories, CONFIG_FILENAME } from './paths.js';
export type { AppPaths } from './paths.js';
export { isMacOS, isLinux } from './detect.js';
export { installService, uninstallService } from './service-installer.js';
export { getPlatformServicePath, fileExists as serviceFileExists } from './service-paths.js';
