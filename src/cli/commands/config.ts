/** Configuration management command: view, get, set, validate, path. */
import type { Command } from 'commander';
import { stringify as yamlStringify, parse as yamlParse } from 'yaml';
import Table from 'cli-table3';
import { readFile } from 'node:fs/promises';

import { loadConfig, resolveConfigFilePath, ScrowConfigSchema } from '../../config/index.js';
import { getPaths, ensureDirectories } from '../../platform/index.js';
import { atomicWrite } from '../../utils/index.js';
import { renderErrorBlock, printJson } from '../../ui/index.js';
import { jsonOk, jsonError } from '../../types/index.js';
import { isJsonMode, EXIT, getConfigPath } from '../index.js';
import { ScrowError, getErrorMessage } from '../../errors/index.js';
import type { ScrowConfig } from '../../types/index.js';

interface ValidationErrorDetail {
  field: string;
  message: string;
}

const SETTABLE_CONFIG_KEYS = new Set([
  'polling_interval',
  'log_retention_days',
  'task_timeout_minutes',
  'last_summary_enabled',
  'provider.name',
  'provider.claude_path',
  'provider.container.memory_limit_mb',
  'trigger.max_waste_percentage',
  'trigger.weekly_reserve_percentage',
  'telemetry.enabled',
  'telemetry.endpoint',
]);

export function registerConfig(program: Command): void {
  const config = program
    .command('config')
    .description('view and edit configuration')
    .option('--reconnect', 're-authenticate with Claude Code')
    .action(async (opts: { reconnect?: boolean }) => {
      if (opts['reconnect']) {
        const { handleReconnect } = await import('./config-reconnect.js');
        try {
          await handleReconnect();
        } catch (err) {
          if (err instanceof ScrowError && !isJsonMode()) {
            const { userMessage, suggestion } = getErrorMessage(err.code);
            process.stderr.write(
              renderErrorBlock({
                severity: 'critical',
                message: userMessage,
                recovery: suggestion,
              }) + '\n',
            );
            process.exit(EXIT.AUTH_OR_CONFIG);
            return;
          }
          throw err;
        }
        return;
      }
      await cmdConfigShow();
    });

  config
    .command('get <key>')
    .description('get a configuration value')
    .action(async (key: string) => {
      await cmdConfigGet(key);
    });

  config
    .command('set <key> <value>')
    .description('set a configuration value')
    .action(async (key: string, value: string) => {
      await cmdConfigSet(key, value);
    });

  config
    .command('validate')
    .description('validate the current configuration file')
    .action(async () => {
      await cmdConfigValidate();
    });

  config
    .command('path')
    .description('show configuration and state directory paths')
    .action(async () => {
      await cmdConfigPath();
    });
}

async function cmdConfigShow(): Promise<void> {
  await ensureDirectories();
  const paths = getPaths();
  const configPath = resolveConfigFilePath(paths.config, getConfigPath());
  const cfg = await loadConfig(configPath);

  if (isJsonMode()) {
    printJson(jsonOk({ config: redact(cfg) }));
    return;
  }

  const table = new Table({
    head: ['Key', 'Value'],
    style: { head: ['cyan'] },
  });

  const rows = flattenConfig(redact(cfg));
  for (const [key, val] of rows) {
    table.push([key, String(val)]);
  }

  process.stdout.write(table.toString() + '\n');
}

/** Redact sensitive fields per NFR7. */
function redact(cfg: ScrowConfig): Record<string, unknown> {
  return {
    polling_interval: cfg.pollingInterval,
    log_retention_days: cfg.logRetentionDays,
    task_timeout_minutes: cfg.taskTimeoutMinutes,
    last_summary_enabled: cfg.lastSummaryEnabled,
    provider: {
      name: cfg.provider.name,
      claude_path: cfg.provider.claudePath ? '[set]' : '[not set]',
      container: { memory_limit_mb: cfg.provider.container?.memoryLimitMb ?? 512 },
    },
    trigger: {
      max_waste_percentage: cfg.trigger.maxWastePercentage,
      weekly_reserve_percentage: cfg.trigger.weeklyReservePercentage,
      idle_hours: cfg.trigger.idleHours,
    },
    tasks: cfg.tasks.map((task) => ({
      name: task.name,
      prompt: task.prompt,
      target_path: task.targetPath,
    })),
    telemetry: {
      enabled: cfg.telemetry.enabled,
      endpoint: cfg.telemetry.endpoint,
    },
  };
}

function flattenConfig(obj: Record<string, unknown>): Array<[string, unknown]> {
  const rows: Array<[string, unknown]> = [];
  appendFlattenedRows(rows, '', obj);
  return rows;
}

async function cmdConfigGet(key: string): Promise<void> {
  const paths = getPaths();
  const configPath = resolveConfigFilePath(paths.config, getConfigPath());
  const cfg = await loadConfig(configPath);

  // AC5: `sparecrow config get telemetry` shows full transparency view
  if (key === 'telemetry') {
    const { TelemetryCollector } = await import('../../telemetry/index.js');
    const collector = new TelemetryCollector({
      version: '0.0.0', // version not needed for display
      stateDir: paths.data,
    });
    const installationId = await collector.getInstallationId();
    await collector.loadRecentEvents();
    const recentEvents = collector.getRecentEvents();

    if (isJsonMode()) {
      printJson(
        jsonOk({
          enabled: cfg.telemetry.enabled,
          installationId,
          endpoint: cfg.telemetry.endpoint,
          recentEvents,
        }),
      );
      return;
    }

    process.stdout.write(`Telemetry enabled:  ${cfg.telemetry.enabled}\n`);
    process.stdout.write(`Installation ID:    ${installationId}\n`);
    process.stdout.write(`Endpoint:           ${cfg.telemetry.endpoint}\n`);
    process.stdout.write(`Recent events (last ${recentEvents.length}):\n`);
    if (recentEvents.length === 0) {
      process.stdout.write('  (none)\n');
    } else {
      for (const event of recentEvents) {
        process.stdout.write(
          `  ${event.timestamp} ${event.eventType}${event.commandName ? ` (${event.commandName})` : ''}${event.errorCode ? ` [${event.errorCode}]` : ''}\n`,
        );
      }
    }
    return;
  }

  // Support both snake_case and camelCase key lookup
  const keyMap: Record<string, unknown> = {
    polling_interval: cfg.pollingInterval,
    pollingInterval: cfg.pollingInterval,
    log_retention_days: cfg.logRetentionDays,
    logRetentionDays: cfg.logRetentionDays,
    task_timeout_minutes: cfg.taskTimeoutMinutes,
    taskTimeoutMinutes: cfg.taskTimeoutMinutes,
    last_summary_enabled: cfg.lastSummaryEnabled,
    lastSummaryEnabled: cfg.lastSummaryEnabled,
    'provider.name': cfg.provider.name,
    'provider.claude_path': cfg.provider.claudePath ?? null,
    'provider.claudePath': cfg.provider.claudePath ?? null,
    'provider.container.memory_limit_mb': cfg.provider.container?.memoryLimitMb ?? 512,
    'provider.container.memoryLimitMb': cfg.provider.container?.memoryLimitMb ?? 512,
    'trigger.max_waste_percentage': cfg.trigger.maxWastePercentage,
    'trigger.maxWastePercentage': cfg.trigger.maxWastePercentage,
    'trigger.weekly_reserve_percentage': cfg.trigger.weeklyReservePercentage,
    'trigger.weeklyReservePercentage': cfg.trigger.weeklyReservePercentage,
    'telemetry.enabled': cfg.telemetry.enabled,
    'telemetry.endpoint': cfg.telemetry.endpoint,
  };

  if (!(key in keyMap)) {
    if (isJsonMode()) {
      printJson(jsonError('CONFIG_INVALID', `Unknown config key: '${key}'`));
    } else {
      process.stderr.write(
        renderErrorBlock({ severity: 'critical', message: `Unknown config key: '${key}'` }) + '\n',
      );
    }
    process.exit(EXIT.ERROR);
    return;
  }

  const value = keyMap[key];
  if (isJsonMode()) {
    printJson(jsonOk({ key, value }));
    return;
  }
  process.stdout.write(`${String(value)}\n`);
}

async function cmdConfigSet(key: string, rawValue: string): Promise<void> {
  const paths = getPaths();
  const configPath = resolveConfigFilePath(paths.config, getConfigPath());
  await ensureDirectories();

  const snakeKey = toSnakeCase(key);
  if (!SETTABLE_CONFIG_KEYS.has(snakeKey)) {
    const message = `Unknown config key: '${key}'`;
    if (isJsonMode()) {
      printJson(jsonError('CONFIG_INVALID', message));
    } else {
      process.stderr.write(renderErrorBlock({ severity: 'critical', message }) + '\n');
    }
    process.exit(EXIT.ERROR);
    return;
  }

  // Load existing raw YAML to preserve comments/structure as much as possible
  let rawYaml: Record<string, unknown> = {};
  try {
    const content = await readFile(configPath, 'utf-8');
    const parsed = yamlParse(content) as unknown;
    if (parsed === null || parsed === undefined) {
      rawYaml = {};
    } else if (isRecord(parsed)) {
      rawYaml = parsed;
    } else {
      const message = 'Cannot update config: top-level YAML value must be an object';
      if (isJsonMode()) {
        printJson(jsonError('CONFIG_INVALID', message));
      } else {
        process.stderr.write(renderErrorBlock({ severity: 'critical', message }) + '\n');
      }
      process.exit(EXIT.AUTH_OR_CONFIG);
      return;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // File not found — start from empty (defaults will fill in)
      rawYaml = {};
    } else {
      const message = `Cannot read config file: ${(err as Error).message}`;
      if (isJsonMode()) {
        printJson(jsonError('CONFIG_INVALID', message));
      } else {
        process.stderr.write(renderErrorBlock({ severity: 'critical', message }) + '\n');
      }
      process.exit(EXIT.AUTH_OR_CONFIG);
      return;
    }
  }

  // Apply the new key-value to the raw YAML object (snake_case)
  applyNestedKey(rawYaml, snakeKey, coerceValue(rawValue));

  // Validate the updated config
  const result = ScrowConfigSchema.safeParse(rawYaml);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    const message = `Invalid value for '${key}': ${issues}`;
    if (isJsonMode()) {
      printJson(jsonError('CONFIG_INVALID', message));
    } else {
      process.stderr.write(
        renderErrorBlock({
          severity: 'critical',
          message,
          recovery: `sparecrow config validate`,
        }) + '\n',
      );
    }
    process.exit(EXIT.AUTH_OR_CONFIG);
    return;
  }

  // Atomic write
  await atomicWrite(configPath, yamlStringify(rawYaml));

  if (isJsonMode()) {
    printJson(jsonOk({ key, value: coerceValue(rawValue) }));
    return;
  }
  process.stdout.write(`✓ Set ${key} to ${rawValue}\n`);
}

async function cmdConfigValidate(): Promise<void> {
  const paths = getPaths();
  const configPath = resolveConfigFilePath(paths.config, getConfigPath());

  let rawYaml: unknown = {};
  try {
    const content = await readFile(configPath, 'utf-8');
    rawYaml = (yamlParse(content) as unknown) ?? {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      const message = `Cannot read config file: ${(err as Error).message}`;
      if (isJsonMode()) {
        printJson(jsonError('CONFIG_INVALID', message));
      } else {
        process.stderr.write(renderErrorBlock({ severity: 'critical', message }) + '\n');
      }
      process.exit(EXIT.AUTH_OR_CONFIG);
      return;
    }
    // ENOENT — missing file is valid (defaults apply)
  }

  const result = ScrowConfigSchema.safeParse(rawYaml);

  if (result.success) {
    if (isJsonMode()) {
      printJson(jsonOk({ valid: true, errors: [] }));
    } else {
      process.stdout.write('✓ Configuration is valid\n');
    }
    process.exit(EXIT.SUCCESS);
  } else {
    const errors = result.error.issues.map(
      (i): ValidationErrorDetail => ({
        field: i.path.join('.'),
        message: i.message,
      }),
    );

    if (isJsonMode()) {
      printJson({
        ok: false,
        data: { valid: false, errors },
        error: { code: 'CONFIG_INVALID', message: `${errors.length} validation error(s)` },
      });
    } else {
      for (const e of errors) {
        process.stderr.write(
          renderErrorBlock({ severity: 'critical', message: `${e.field}: ${e.message}` }) + '\n',
        );
      }
    }
    process.exit(EXIT.AUTH_OR_CONFIG);
  }
}

async function cmdConfigPath(): Promise<void> {
  const paths = getPaths();
  const configPath = resolveConfigFilePath(paths.config, getConfigPath());

  if (isJsonMode()) {
    printJson(
      jsonOk({
        configPath,
        dataPath: paths.data,
        logsPath: paths.logs,
      }),
    );
    return;
  }

  process.stdout.write(`Config file:     ${configPath}\n`);
  process.stdout.write(`State directory: ${paths.data}\n`);
  process.stdout.write(`Logs directory:  ${paths.logs}\n`);
}

function toSnakeCase(key: string): string {
  return key.replace(/([A-Z])/g, '_$1').toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function coerceValue(raw: string): string | number | boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const n = Number(raw);
  if (!isNaN(n) && raw.trim() !== '') return n;
  return raw;
}

function applyNestedKey(obj: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (typeof cur[part] !== 'object' || cur[part] === null) cur[part] = {};
    cur = cur[part] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

function appendFlattenedRows(
  rows: Array<[string, unknown]>,
  currentKey: string,
  value: unknown,
): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      rows.push([currentKey, '[]']);
      return;
    }
    for (let i = 0; i < value.length; i++) {
      const childKey = `${currentKey}[${i}]`;
      appendFlattenedRows(rows, childKey, value[i]);
    }
    return;
  }

  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      rows.push([currentKey, '{}']);
      return;
    }
    for (const [key, child] of entries) {
      const childKey = currentKey === '' ? key : `${currentKey}.${key}`;
      appendFlattenedRows(rows, childKey, child);
    }
    return;
  }

  rows.push([currentKey, value]);
}
