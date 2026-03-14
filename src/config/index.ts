/** Config module barrel — re-exports loader, schema, defaults, and watcher. */

export { loadConfig, resolveConfigFilePath } from './loader.js';
export { ScrowConfigSchema, ContainerConfigSchema } from './schema.js';
export type { ScrowConfigInput } from './schema.js';
export { CONFIG_DEFAULTS, CONFIG_FALLBACK } from './defaults.js';
export { createConfigWatcher } from './watcher.js';
export type { ConfigWatcher } from './watcher.js';
