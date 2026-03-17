/** Configuration types for ScrowConfig and sub-schemas. */

/** Valid day-of-week names for idle hours scheduling. */
export type DayOfWeek =
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday'
  | 'sunday';

/** A time range during which the user is typically idle (not using Claude). */
export interface IdleHoursEntry {
  /** Start time in HH:MM format (24-hour). */
  start: string;
  /** End time in HH:MM format (24-hour). */
  end: string;
  /** Optional day-of-week filter. When present, this entry only applies on the listed days. */
  days?: DayOfWeek[];
}

/**
 * Capacity trigger thresholds and idle-hours schedule.
 *
 * Controls when the daemon considers spare capacity available to dispatch
 * queued tasks. All percentage fields are in the range 0–100.
 */
export interface TriggerConfig {
  maxWastePercentage: number; // 0-100; default 50
  weeklyReservePercentage: number; // 0-100; default 30
  idleHours: IdleHoursEntry[]; // idle time ranges; default []
}

/**
 * A user-defined custom task that sparecrow can dispatch against a repository.
 *
 * Custom tasks supplement built-in templates when the user needs a bespoke
 * prompt. Each task must have a unique `name` used to identify it in the queue.
 */
export interface CustomTaskConfig {
  name: string;
  prompt: string;
  targetPath: string;
}

/** Container execution configuration — all fields have defaults so the minimal config is just execution_backend: container. */
export type ContainerConfig = {
  runtime: 'auto' | 'docker' | 'podman';
  image: string;
  memoryLimitMb: number;
  cpuLimit: number;
  networkMode: 'bridge' | 'none' | 'host';
  mountClaudeConfig: boolean;
  /** When true, mount ~/.claude/ read-only to prevent container writes to OAuth credentials (Story 22.1). Default: true. */
  mountClaudeConfigReadonly: boolean;
  /** Container-side path to a pre-installed claude binary. When set, skips auto-mounting from host. */
  claudeBinaryPath?: string;
  /** Explicit override for host binary mounting. true = force mount, false = skip mount, undefined = auto-detect based on image. */
  mountClaudeBinary?: boolean;
};

/**
 * Provider and execution backend configuration for sparecrow.
 *
 * Specifies which Claude Code provider to use and how tasks are executed
 * (currently `'container'` is the only supported `executionBackend`).
 */
export interface ProviderConfig {
  name: string; // e.g. "claude-code"
  claudePath?: string; // absolute path to claude binary (set during onboarding)
  allowDangerouslySkipPermissions: boolean; // default false; mapped from allow_dangerously_skip_permissions
  executionBackend: 'container'; // default 'container'; mapped from execution_backend
  container?: ContainerConfig; // container execution settings (Story 12.2)
  envStripPatterns?: string[]; // additional env variable name patterns to strip from child process env (Story 12.6)
}

/** Telemetry configuration — opt-in anonymous usage data collection. */
export interface TelemetryConfig {
  enabled: boolean; // default false (opt-in)
  endpoint: string; // HTTPS endpoint for telemetry events
}

/**
 * Root configuration object for sparecrow, loaded from `config.yaml`.
 *
 * YAML keys use `snake_case` and are transformed to `camelCase` by the
 * Zod schema in `src/config/schema.ts`. All fields have sensible defaults
 * so the minimal valid config is an empty YAML file.
 *
 * @see {@link TriggerConfig} for capacity trigger settings.
 * @see {@link ProviderConfig} for provider and execution backend settings.
 */
export interface ScrowConfig {
  /** Daemon polling interval in seconds (60-3600). Default: 300. */
  pollingInterval: number;
  /** Number of days to retain audit log files. Default: 30. */
  logRetentionDays: number;
  /** Maximum task execution time in minutes. 0 disables the timeout. Default: 60. */
  taskTimeoutMinutes: number;
  /** Provider and execution backend configuration. */
  provider: ProviderConfig;
  /** Capacity trigger thresholds and idle hours schedule. */
  trigger: TriggerConfig;
  /** User-defined custom task prompts. */
  tasks: CustomTaskConfig[];
  /** When true, write human-readable last-summary.txt after dispatch. Default: false. */
  lastSummaryEnabled: boolean;
  /** WSL Windows-hosted mount prefix for permission-check bypass. Default: '/mnt/'. */
  wslMountPrefix: string;
  /** Opt-in anonymous telemetry configuration. */
  telemetry: TelemetryConfig;
}
