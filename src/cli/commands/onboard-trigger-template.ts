/** Onboarding trigger, template selection, and permission consent stages (Story 5.2). */
import { text, multiselect, confirm, select, isCancel } from '@clack/prompts';
import { readFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { loadBuiltins } from '../../templates/index.js';
import { ScrowConfigSchema } from '../../config/index.js';
import { ScrowError, ErrorCode } from '../../errors/index.js';
import { atomicWrite, logger } from '../../utils/index.js';
import { getPaths } from '../../platform/index.js';
import { getConfigPath } from '../index.js';
import { renderErrorBlock } from '../../ui/index.js';
import type { IdleHoursEntry } from '../../types/index.js';

/** In-memory onboarding state collected across Story 5.2 stages. */
export interface OnboardingState {
  triggerMaxWastePercentage: number;
  triggerWeeklyReservePercentage: number;
  triggerIdleHours: IdleHoursEntry[];
  pollingInterval: number;
  selectedTemplates: string[];
  allowDangerouslySkipPermissions: boolean;
  containerRuntime?: 'docker' | 'podman' | undefined;
  containerRuntimeVersion?: string | undefined;
}

/**
 * Trigger field defaults exposed for testing.
 * NOTE: These values must stay in sync with the .default() values in
 * src/config/schema.ts (TriggerConfigSchema and ScrowConfigSchema.polling_interval).
 */
export const TRIGGER_DEFAULTS = {
  maxWastePercentage: 50,
  weeklyReservePercentage: 30,
  pollingInterval: 300,
} as const;

/** Preset aggressiveness profiles for trigger configuration. */
export const PRESET_PROFILES = {
  conservative: { maxWastePercentage: 70, weeklyReservePercentage: 40 },
  balanced: { maxWastePercentage: 50, weeklyReservePercentage: 30 },
  aggressive: { maxWastePercentage: 30, weeklyReservePercentage: 15 },
} as const;

/**
 * Regex for validating HH:MM time strings.
 * Shared by parseIdleHoursRange and the validate callback in the idle hours text() prompt.
 */
const HH_MM_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Parse an idle hours range string in HH:MM-HH:MM format.
 * Performs format-only validation. Overnight ranges (end < start) are valid and
 * handled by the trigger engine. No semantic check on start vs end ordering is performed.
 * Returns an IdleHoursEntry on success, null on any parse failure.
 */
export function parseIdleHoursRange(input: string): IdleHoursEntry | null {
  const trimmed = input.trim();
  // Minimum valid format is "HH:MM-HH:MM" = 11 characters.
  // length < 11 guard is sufficient: shorter strings cannot have a valid separator at index 5.
  if (trimmed.length < 11) return null;
  const start = trimmed.slice(0, 5);
  const sep = trimmed[5];
  // end = trimmed.slice(6) takes everything from position 6 to end of string.
  // If the string is longer than 11 chars (e.g. "22:00-06:00extra"), end = "06:00extra"
  // which fails HH_MM_REGEX — so the length minimum guard is sufficient and no upper-bound
  // check is needed. The regex is the definitive validator for both halves.
  const end = trimmed.slice(6);
  if (sep !== '-') return null;
  if (!HH_MM_REGEX.test(start) || !HH_MM_REGEX.test(end)) return null;
  return { start, end };
}

interface FieldBounds {
  min: number;
  max: number;
  label: string;
  unit: string;
}

type TriggerFieldName = 'maxWastePercentage' | 'weeklyReservePercentage' | 'pollingInterval';

const TRIGGER_FIELDS: Record<TriggerFieldName, FieldBounds> = {
  maxWastePercentage: { min: 0, max: 100, label: 'Max waste percentage', unit: '%' },
  weeklyReservePercentage: { min: 0, max: 100, label: 'Weekly reserve percentage', unit: '%' },
  pollingInterval: { min: 60, max: 3600, label: 'Polling interval', unit: 'seconds' },
};

/** Parse a string as a strict base-10 integer. Returns null for invalid inputs. */
export function parseStrictInt(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === '' || !/^\d+$/.test(trimmed)) return null;
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(value)) return null;
  return value;
}

/** Validate a number against field bounds. Returns error string or null when valid. */
export function validateBounded(value: number, fieldName: string): string | null {
  const field: FieldBounds | undefined = (
    TRIGGER_FIELDS as Record<string, FieldBounds | undefined>
  )[fieldName];
  if (!field) return `Unknown field: ${fieldName}`;
  if (value < field.min || value > field.max) {
    return `${field.label} must be between ${field.min} and ${field.max} ${field.unit}.`;
  }
  return null;
}

/** Prompt for a single bounded integer with default. */
async function promptNumericField(
  fieldName: TriggerFieldName,
  defaultValue: number,
): Promise<number | symbol> {
  const field = TRIGGER_FIELDS[fieldName];
  const result = await text({
    message: `${field.label} (${field.min}–${field.max} ${field.unit}):`,
    defaultValue: String(defaultValue),
    validate(input = '') {
      if (input.trim() === '') return undefined; // empty = accept defaultValue
      const parsed = parseStrictInt(input);
      if (parsed === null) return `Enter a whole number between ${field.min} and ${field.max}.`;
      const err = validateBounded(parsed, fieldName);
      if (err) return err;
      return undefined;
    },
  });

  if (isCancel(result)) return result;
  return parseStrictInt(result as string)!;
}

/** Run trigger configuration: idle hours, weekend, preset or custom numeric entry. */
export async function runTriggerStage(): Promise<
  | {
      triggerMaxWastePercentage: number;
      triggerWeeklyReservePercentage: number;
      triggerIdleHours: IdleHoursEntry[];
      pollingInterval: number;
    }
  | symbol
> {
  // Step 1: Idle hours text() prompt
  // The validate callback must return a non-empty error string (not undefined) on bad input.
  const idleHoursInput = await text({
    message: 'When are you typically NOT using Claude? (e.g. 22:00-06:00, or press Enter to skip)',
    defaultValue: '',
    placeholder: 'HH:MM-HH:MM or Enter to skip',
    validate(input = '') {
      const t = input.trim();
      if (t === '') return undefined; // empty = skip, valid
      const parsed = parseIdleHoursRange(t);
      if (parsed === null) {
        return 'Invalid format. Enter a time range like 22:00-06:00, or press Enter to skip.';
      }
      return undefined;
    },
  });

  if (isCancel(idleHoursInput)) return idleHoursInput;

  const idleHours: IdleHoursEntry[] = [];
  const idleHoursStr = (idleHoursInput as string).trim();
  if (idleHoursStr !== '') {
    const entry = parseIdleHoursRange(idleHoursStr);
    if (entry !== null) {
      idleHours.push(entry);
    }
  }

  // Step 2: Weekend confirm() — only when idleHours.length > 0
  if (idleHours.length > 0) {
    const weekendIdle = await confirm({
      message: 'Are weekends fully idle? (adds Sat/Sun all-day to idle schedule) [y/N]',
      initialValue: false,
    });

    if (isCancel(weekendIdle)) return weekendIdle;

    if (weekendIdle === true) {
      idleHours.push({ start: '00:00', end: '23:59', days: ['saturday', 'sunday'] });
    }
  }

  // Step 3: Preset select()
  const presetChoice = await select({
    message: 'How aggressively should sparecrow use your spare capacity?',
    options: [
      {
        value: 'conservative',
        label: 'Conservative',
        hint: 'Keep more capacity for yourself (waste: 70%, reserve: 40%)',
      },
      {
        value: 'balanced',
        label: 'Balanced',
        hint: 'Good balance of usage and protection (waste: 50%, reserve: 30%)',
      },
      {
        value: 'aggressive',
        label: 'Aggressive',
        hint: 'Maximise task throughput (waste: 30%, reserve: 15%)',
      },
      { value: 'custom', label: 'Custom', hint: 'Enter custom values' },
    ],
    initialValue: 'balanced',
  });

  if (isCancel(presetChoice)) return presetChoice;

  let maxWastePercentage: number;
  let weeklyReservePercentage: number;

  // Step 4: If custom, prompt numeric fields; otherwise use preset values
  if ((presetChoice as string) === 'custom') {
    const maxWaste = await promptNumericField(
      'maxWastePercentage',
      TRIGGER_DEFAULTS.maxWastePercentage,
    );
    if (isCancel(maxWaste)) return maxWaste;

    const weeklyReserve = await promptNumericField(
      'weeklyReservePercentage',
      TRIGGER_DEFAULTS.weeklyReservePercentage,
    );
    if (isCancel(weeklyReserve)) return weeklyReserve;

    maxWastePercentage = maxWaste as number;
    weeklyReservePercentage = weeklyReserve as number;
  } else {
    // Runtime guard: PRESET_PROFILES only contains conservative/balanced/aggressive.
    // 'custom' is handled above, so presetChoice must be one of those three keys.
    const presetKey = presetChoice as string;
    const preset =
      PRESET_PROFILES[presetKey as keyof typeof PRESET_PROFILES] ?? PRESET_PROFILES.balanced;
    maxWastePercentage = preset.maxWastePercentage;
    weeklyReservePercentage = preset.weeklyReservePercentage;
  }

  // Step 5: Polling interval — always collected
  const polling = await promptNumericField('pollingInterval', TRIGGER_DEFAULTS.pollingInterval);
  if (isCancel(polling)) return polling;

  return {
    triggerMaxWastePercentage: maxWastePercentage,
    triggerWeeklyReservePercentage: weeklyReservePercentage,
    triggerIdleHours: idleHours,
    pollingInterval: polling as number,
  };
}

/** Run template multiselect with empty-selection confirmation loop. */
export async function runTemplateStage(): Promise<string[] | symbol> {
  const templates = await loadBuiltins();

  if (templates.length === 0) {
    throw new ScrowError(
      ErrorCode.TEMPLATE_LOAD_ERROR,
      'No built-in templates found. Cannot render template selection.',
    );
  }

  const keys = templates.map((t) => t.name);

  while (true) {
    const selected = await multiselect({
      message: 'Select task templates to seed your queue:',
      options: templates.map((t) => ({
        value: t.name,
        label: t.name,
        hint: t.description,
      })),
      initialValues: keys,
      required: false,
    });

    if (isCancel(selected)) return selected;

    const selectedArr = selected as string[];

    if (selectedArr.length === 0) {
      const proceed = await confirm({
        message:
          'No templates selected. Queue seeding will not be available until templates are selected later. Continue without templates?',
        initialValue: false,
      });

      if (isCancel(proceed)) return proceed;
      if (proceed) return [];
      continue;
    }

    return selectedArr;
  }
}

/** Run dangerous-permissions consent confirmation. */
export async function runPermissionConsentStage(): Promise<boolean | symbol> {
  const consent = await confirm({
    message:
      'Allow autonomous Claude execution without permission prompts?\n' +
      '  This passes --dangerously-skip-permissions to Claude, allowing it to\n' +
      '  run tools without asking for confirmation. Only enable if you trust\n' +
      '  the templates and target repositories.',
    initialValue: false,
  });

  if (isCancel(consent)) return consent;
  return consent as boolean;
}

/** Persist Story 5.2 config fields atomically via read-merge-validate-write. */
export async function persistOnboardingConfig(state: OnboardingState): Promise<void> {
  // NOTE: state.selectedTemplates is intentionally not persisted here.
  // Template selection is kept in run-state only; config write is deferred to Story 5.3.
  const configPath = getConfigPath() ?? join(getPaths().config, 'config.yaml');

  let raw: Record<string, unknown> = {};
  try {
    const content = await readFile(configPath, 'utf-8');
    const parsed = parseYaml(content) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      raw = parsed as Record<string, unknown>;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw new ScrowError(
        ErrorCode.CONFIG_INVALID,
        `Config file exists but could not be read or parsed: ${configPath}`,
        err instanceof Error ? err : undefined,
      );
    }
  }

  const trigger = (raw['trigger'] as Record<string, unknown> | undefined) ?? {};
  const provider = (raw['provider'] as Record<string, unknown> | undefined) ?? {};

  // Map triggerIdleHours to YAML snake_case shape (omit days when undefined)
  const idleHoursYaml = state.triggerIdleHours.map((e) => ({
    start: e.start,
    end: e.end,
    ...(e.days !== undefined ? { days: [...e.days] } : {}),
  }));

  // Change-detection: ?? [] guard is load-bearing — existing config may not have idle_hours key
  const existingIdleHoursJson = JSON.stringify(trigger['idle_hours'] ?? []);
  const newIdleHoursJson = JSON.stringify(idleHoursYaml);

  if (
    trigger['max_waste_percentage'] === state.triggerMaxWastePercentage &&
    trigger['weekly_reserve_percentage'] === state.triggerWeeklyReservePercentage &&
    existingIdleHoursJson === newIdleHoursJson &&
    raw['polling_interval'] === state.pollingInterval &&
    provider['allow_dangerously_skip_permissions'] === state.allowDangerouslySkipPermissions
  ) {
    void logger.debug('onboard.config.persist_skipped', { reason: 'all_values_unchanged' });
    return;
  }

  // Set raw['trigger'] (including idle_hours) BEFORE safeParse so validation sees the new data
  raw['trigger'] = {
    ...trigger,
    max_waste_percentage: state.triggerMaxWastePercentage,
    weekly_reserve_percentage: state.triggerWeeklyReservePercentage,
    idle_hours: idleHoursYaml,
  };
  raw['provider'] = {
    ...provider,
    allow_dangerously_skip_permissions: state.allowDangerouslySkipPermissions,
  };
  raw['polling_interval'] = state.pollingInterval;

  const validation = ScrowConfigSchema.safeParse(raw);
  if (!validation.success) {
    const issues = validation.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new ScrowError(
      ErrorCode.CONFIG_INVALID,
      `Merged configuration failed validation:\n${issues}`,
    );
  }

  await mkdir(dirname(configPath), { recursive: true });
  await atomicWrite(configPath, stringifyYaml(raw));

  void logger.info('onboard.config.persisted', { event: 'config_saved' });
}

/** Render template loading failure. */
export function renderTemplateLoadError(reason: string): string {
  return renderErrorBlock({
    severity: 'critical',
    message: `Template loading failed: ${reason}`,
    recovery: 'Verify built-in template files exist. Run: sparecrow doctor',
  });
}

/** Render config persistence failure. */
export function renderConfigPersistError(reason: string): string {
  return renderErrorBlock({
    severity: 'critical',
    message: `Failed to save configuration: ${reason}`,
    recovery: 'Check file permissions and disk space. Run: sparecrow doctor',
  });
}
