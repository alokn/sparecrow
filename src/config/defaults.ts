/** Default configuration values — referenced by schema and for documentation. */
import type { ScrowConfig, ProviderConfig } from '../types/index.js';

/** Required provider defaults (claudePath intentionally absent — set during onboarding). */
export const DEFAULT_PROVIDER: Omit<ProviderConfig, 'claudePath'> = {
  name: 'claude-code',
  allowDangerouslySkipPermissions: false,
  executionBackend: 'container',
};

export const CONFIG_DEFAULTS: Partial<ScrowConfig> = {
  pollingInterval: 300,
  logRetentionDays: 30,
  taskTimeoutMinutes: 60,
  lastSummaryEnabled: false,
  provider: DEFAULT_PROVIDER,
  trigger: {
    maxWastePercentage: 50,
    weeklyReservePercentage: 30,
    idleHours: [],
  },
  tasks: [],
};

/**
 * A fully-typed `ScrowConfig` fallback used when all config-load retries are exhausted.
 * Unlike `CONFIG_DEFAULTS` (which is `Partial<ScrowConfig>` for schema documentation purposes),
 * this constant satisfies the full `ScrowConfig` type without any type assertion.
 * `claudePath` is intentionally absent — it is optional in `ProviderConfig`.
 */
export const CONFIG_FALLBACK: ScrowConfig = {
  pollingInterval: 300,
  logRetentionDays: 30,
  taskTimeoutMinutes: 60,
  lastSummaryEnabled: false,
  provider: {
    name: 'claude-code',
    allowDangerouslySkipPermissions: false,
    executionBackend: 'container',
  },
  trigger: {
    maxWastePercentage: 50,
    weeklyReservePercentage: 30,
    idleHours: [],
  },
  tasks: [],
};
