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

export interface TriggerConfig {
  maxWastePercentage: number; // 0-100; default 50
  weeklyReservePercentage: number; // 0-100; default 30
  idleHours: IdleHoursEntry[]; // idle time ranges; default []
}

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

export interface ProviderConfig {
  name: string; // e.g. "claude-code"
  claudePath?: string; // absolute path to claude binary (set during onboarding)
  allowDangerouslySkipPermissions: boolean; // default false; mapped from allow_dangerously_skip_permissions
  executionBackend: 'container'; // default 'container'; mapped from execution_backend
  container?: ContainerConfig; // container execution settings (Story 12.2)
  envStripPatterns?: string[]; // additional env variable name patterns to strip from child process env (Story 12.6)
}

export interface ScrowConfig {
  pollingInterval: number; // seconds; 60-3600; default 300
  logRetentionDays: number; // default 30
  taskTimeoutMinutes: number; // 0 = no timeout; default 60; min 0
  provider: ProviderConfig;
  trigger: TriggerConfig;
  tasks: CustomTaskConfig[]; // custom prompts (Story 3.4)
  lastSummaryEnabled: boolean; // write last-summary.txt after dispatch (last-summary.json unchanged); default false
  wslMountPrefix: string; // WSL Windows-hosted mount prefix for permission-check bypass; default '/mnt/'
}
