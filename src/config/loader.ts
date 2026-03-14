/** Loads, validates, and merges config.yaml with defaults. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml, stringify as yamlStringify } from 'yaml';
import { ScrowConfigSchema } from './schema.js';
import { ScrowError, ErrorCode } from '../errors/index.js';
import { atomicWrite, isRecord, logger } from '../utils/index.js';
import type { ScrowConfig } from '../types/index.js';

/** Filename of the YAML configuration file that lives inside the config directory. */
const CONFIG_FILENAME = 'config.yaml';

/** Old trigger field names that were present before the capacity intelligence model. */
const OLD_TRIGGER_FIELDS = [
  'threshold_percentage',
  'time_before_reset_minutes',
  'require_reset_window',
] as const;

/**
 * Returns true if the raw config object contains any of the old trigger field names.
 * Used to detect configs that need migration to the capacity intelligence model.
 */
export function hasOldTriggerFields(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  const trigger = raw['trigger'];
  if (!isRecord(trigger)) return false;
  return OLD_TRIGGER_FIELDS.some((field) => field in trigger);
}

/**
 * Resolves the effective config file path.
 * If an explicit override path is provided (e.g. from the --config CLI flag), it is used as-is.
 * Otherwise the standard `config.yaml` filename is appended to the config directory.
 */
export function resolveConfigFilePath(configDir: string, override?: string | null): string {
  return override ?? join(configDir, CONFIG_FILENAME);
}

export async function loadConfig(configPath: string): Promise<ScrowConfig> {
  let raw: unknown = {};
  let fileExists = false;

  try {
    const content = await readFile(configPath, 'utf-8');
    raw = parseYaml(content);
    fileExists = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // No config file — fall back to all defaults (NFR13)
      raw = {};
    } else {
      throw new ScrowError(
        ErrorCode.CONFIG_INVALID,
        `Failed to read config file at ${configPath}: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  // Migration: detect old trigger fields and strip them before schema validation (AC3, AC4)
  if (hasOldTriggerFields(raw)) {
    const trigger = (raw as Record<string, unknown>)['trigger'] as Record<string, unknown>;
    for (const field of OLD_TRIGGER_FIELDS) {
      delete trigger[field];
    }
    // Fire-and-forget: logger.warn is async (disk write) but we do not await it here because
    // a config load path should not block on log I/O. If the logger throws an unhandled
    // rejection (e.g. log directory missing), it is silently discarded — this is intentional
    // and consistent with other fire-and-forget warn call sites in the codebase.
    void logger.warn('config.migration', {
      message:
        "Trigger config migrated to capacity intelligence model. Run 'sparecrow config' to review.",
    });
    // Non-fatal rewrite: persist the sanitised config back to disk (AC4).
    // Note: the rewritten file serializes `raw` (the pre-zod object). If the user had only old
    // trigger fields and no new ones, raw.trigger will be an empty object `{}` after stripping,
    // so the file will contain `trigger: {}` rather than omitting the trigger section entirely.
    // This is intentional: it signals to the user that a trigger section exists and the new
    // capacity-intelligence defaults are in effect. Zod's defaults fill in the values on load.
    if (fileExists) {
      try {
        await atomicWrite(configPath, yamlStringify(raw));
      } catch (writeErr) {
        void logger.warn('config.migration.rewrite_failed', {
          reason: (writeErr as Error).message,
        });
      }
    }
  }

  const result = ScrowConfigSchema.safeParse(raw ?? {});
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new ScrowError(
      ErrorCode.CONFIG_INVALID,
      `Invalid configuration:\n${issues}\n\nRun: sparecrow config edit  to fix the config file.`,
    );
  }

  return result.data;
}
