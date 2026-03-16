/** Zod schema for config.yaml — maps snake_case YAML keys to camelCase TypeScript. */
import { z } from 'zod';
import type { ScrowConfig, ContainerConfig, TelemetryConfig } from '../types/index.js';

export const ContainerConfigSchema: z.ZodType<ContainerConfig> = z
  .object({
    runtime: z.enum(['auto', 'docker', 'podman']).default('auto'),
    image: z.string().trim().min(1).default('node:lts-slim'),
    memory_limit_mb: z.number().int().min(64).max(65536).default(512),
    cpu_limit: z.number().min(0.1).max(128.0).default(1.0),
    network_mode: z.enum(['bridge', 'none', 'host']).default('bridge'),
    mount_claude_config: z.boolean().default(true),
    mount_claude_config_readonly: z.boolean().default(true),
    claude_binary_path: z.string().trim().min(1).optional(),
    mount_claude_binary: z.boolean().optional(),
  })
  .transform((v) => ({
    runtime: v.runtime,
    image: v.image,
    memoryLimitMb: v.memory_limit_mb,
    cpuLimit: v.cpu_limit,
    networkMode: v.network_mode,
    mountClaudeConfig: v.mount_claude_config,
    mountClaudeConfigReadonly: v.mount_claude_config_readonly,
    ...(v.claude_binary_path !== undefined ? { claudeBinaryPath: v.claude_binary_path } : {}),
    ...(v.mount_claude_binary !== undefined ? { mountClaudeBinary: v.mount_claude_binary } : {}),
  }));

const ProviderConfigSchema = z.object({
  name: z.string().default('claude-code'),
  claude_path: z.string().optional(),
  allow_dangerously_skip_permissions: z.boolean().default(false),
  execution_backend: z
    .string()
    .transform((val, ctx): 'container' => {
      if (val === 'direct') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "execution_backend 'direct' is no longer supported. Run 'sparecrow onboard' to reconfigure.",
        });
        return z.NEVER;
      }
      if (val !== 'container') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid execution_backend: '${val}'. Only 'container' is supported.`,
        });
        return z.NEVER;
      }
      return 'container';
    })
    .default('container'),
  container: ContainerConfigSchema.optional(),
  env_strip_patterns: z.array(z.string().min(1)).optional(),
});

/** HH:MM format regex for idle hours time validation. */
const HH_MM_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

const VALID_DAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

const IdleHoursEntrySchema = z.object({
  start: z
    .string()
    .trim()
    .refine((v) => HH_MM_REGEX.test(v), {
      message: 'start must be in HH:MM format (00:00-23:59)',
    }),
  end: z
    .string()
    .trim()
    .refine((v) => HH_MM_REGEX.test(v), {
      message: 'end must be in HH:MM format (00:00-23:59)',
    }),
  days: z
    .array(z.enum(VALID_DAYS))
    .min(1)
    .refine((arr) => new Set(arr).size === arr.length, {
      message: 'days must not contain duplicate values',
    })
    .optional(),
});

const TriggerConfigSchema = z.object({
  max_waste_percentage: z.number().min(0).max(100).default(50),
  weekly_reserve_percentage: z.number().min(0).max(100).default(30),
  idle_hours: z.array(IdleHoursEntrySchema).default([]),
});

const CustomTaskSchema = z.object({
  name: z.string().min(1),
  prompt: z.string().min(1),
  target_path: z.string().min(1),
});

const TelemetryConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    endpoint: z.string().url().default('https://telemetry.sparecrow.dev/v1/events'),
  })
  .default({ enabled: false, endpoint: 'https://telemetry.sparecrow.dev/v1/events' });

export const ScrowConfigSchema = z
  .object({
    polling_interval: z.number().int().min(60).max(3600).default(300),
    log_retention_days: z.number().int().min(1).max(365).default(30),
    task_timeout_minutes: z.number().int().min(0).default(60),
    last_summary_enabled: z.boolean().default(false),
    provider: ProviderConfigSchema.default({
      name: 'claude-code',
      allow_dangerously_skip_permissions: false,
      execution_backend: 'container' as const,
      container: undefined,
    }),
    trigger: TriggerConfigSchema.default({
      max_waste_percentage: 50,
      weekly_reserve_percentage: 30,
      idle_hours: [],
    }),
    tasks: z.array(CustomTaskSchema).default([]),
    telemetry: TelemetryConfigSchema,
    wsl_mount_prefix: z
      .string()
      .trim()
      .min(1)
      .refine((v) => v.endsWith('/'), { message: 'wsl_mount_prefix must end with /' })
      .refine((v) => v.length >= 2, {
        message: 'wsl_mount_prefix must be at least 2 characters (e.g. /mnt/)',
      })
      .default('/mnt/'),
  })
  .transform(
    (v): ScrowConfig => ({
      pollingInterval: v.polling_interval,
      logRetentionDays: v.log_retention_days,
      taskTimeoutMinutes: v.task_timeout_minutes,
      lastSummaryEnabled: v.last_summary_enabled,
      provider: {
        name: v.provider.name,
        allowDangerouslySkipPermissions: v.provider.allow_dangerously_skip_permissions,
        executionBackend: v.provider.execution_backend,
        ...(v.provider.claude_path !== undefined ? { claudePath: v.provider.claude_path } : {}),
        ...(v.provider.container !== undefined ? { container: v.provider.container } : {}),
        ...(v.provider.env_strip_patterns !== undefined
          ? { envStripPatterns: v.provider.env_strip_patterns }
          : {}),
      },
      trigger: {
        maxWastePercentage: v.trigger.max_waste_percentage,
        weeklyReservePercentage: v.trigger.weekly_reserve_percentage,
        idleHours: v.trigger.idle_hours.map((entry) => ({
          start: entry.start,
          end: entry.end,
          ...(entry.days !== undefined ? { days: [...entry.days] } : {}),
        })),
      },
      tasks: v.tasks.map((t) => ({
        name: t.name,
        prompt: t.prompt,
        targetPath: t.target_path,
      })),
      wslMountPrefix: v.wsl_mount_prefix,
      telemetry: {
        enabled: v.telemetry.enabled,
        endpoint: v.telemetry.endpoint,
      } satisfies TelemetryConfig,
    }),
  );

export type ScrowConfigInput = z.input<typeof ScrowConfigSchema>;
