/** Seeds a minimal valid config.yaml inside a HOME-isolated temp directory. */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stringify } from 'yaml';
import type { ScrowConfigInput } from '../../../src/config/schema.js';

/**
 * Resolves the config directory path for the given homeDir,
 * mirroring env-paths v4 behaviour for Linux and macOS.
 *
 * On Linux, always computes the path as `homeDir/.config/<appName>` to match
 * where `env-paths` resolves config when the spawned binary receives
 * `XDG_CONFIG_HOME=homeDir/.config` (as set by `baseEnv()`). Using the
 * test runner's inherited `XDG_CONFIG_HOME` would cause seed files to land
 * in the wrong location when CI sets `XDG_CONFIG_HOME` globally.
 * On macOS, uses `Library/Preferences`.
 */
function resolveConfigDir(homeDir: string): string {
  const appName = 'sparecrow';
  if (process.platform === 'darwin') {
    return join(homeDir, 'Library', 'Preferences', appName);
  }
  // Linux (and other POSIX): always use homeDir-relative path so the seed
  // file is co-located with where env-paths resolves paths for the spawned
  // binary (which only has HOME overridden, not XDG_CONFIG_HOME).
  return join(homeDir, '.config', appName);
}

/**
 * Deep-merges two plain objects, recursively merging nested objects.
 * Arrays and primitive values in `overrides` replace those in `base`.
 * This ensures that a partial override like `{ trigger: { max_waste_percentage: 40 } }`
 * merges with the trigger defaults rather than replacing the entire `trigger` object.
 */
function deepMerge<T extends Record<string, unknown>>(base: T, overrides: Partial<T>): T {
  const result = { ...base };
  for (const key of Object.keys(overrides) as Array<keyof T>) {
    const overrideVal = overrides[key];
    const baseVal = result[key];
    if (
      overrideVal !== null &&
      typeof overrideVal === 'object' &&
      !Array.isArray(overrideVal) &&
      baseVal !== null &&
      typeof baseVal === 'object' &&
      !Array.isArray(baseVal)
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>,
      ) as T[keyof T];
    } else if (overrideVal !== undefined) {
      result[key] = overrideVal as T[keyof T];
    }
  }
  return result;
}

/**
 * Writes a minimal valid `config.yaml` to the platform-correct path inside `homeDir`.
 *
 * @param homeDir - The isolated HOME directory for the test
 * @param partial - Optional snake_case overrides merged (deeply) into the default config.
 *   Keys must use snake_case to match the YAML schema (e.g. `polling_interval`, not `pollingInterval`).
 * @returns The absolute path of the written config file
 */
export async function seedConfig(
  homeDir: string,
  partial?: Partial<ScrowConfigInput>,
): Promise<string> {
  const configDir = resolveConfigDir(homeDir);
  const configPath = join(configDir, 'config.yaml');

  // Minimal valid config that satisfies ScrowConfigSchema defaults
  const defaults: ScrowConfigInput = {
    polling_interval: 300,
    log_retention_days: 30,
    last_summary_enabled: false,
    provider: {
      name: 'claude-code',
      allow_dangerously_skip_permissions: false,
    },
    trigger: {
      max_waste_percentage: 30,
      weekly_reserve_percentage: 20,
    },
    tasks: [],
  };

  // Use deep merge so nested objects like `trigger` and `provider` are merged
  // rather than replaced wholesale when `partial` specifies only some of their fields.
  const merged = partial
    ? deepMerge(defaults as unknown as Record<string, unknown>, partial as Record<string, unknown>)
    : defaults;
  const yamlContent = stringify(merged);

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, yamlContent, 'utf8');

  return configPath;
}
