/** Claude Code usage monitor with ordered fallback chain: OAuth -> CLI quota -> stale snapshot. */
import { ScrowError, ErrorCode } from '../../errors/index.js';
import type {
  AuthManager,
  CapacitySnapshot,
  CapacityWindow,
  ConfidenceLevel,
  UsageMonitor,
  UsageSource,
} from '../../types/index.js';
import type { AuditMeta } from '../../utils/index.js';
import { logger } from '../../utils/index.js';
import { ClaudeCodeAuthManager } from './auth-manager.js';
import { OAuthUsageSource } from './fallback-sources/oauth-source.js';

const SOURCE_PRIORITY: Record<UsageSource, number> = {
  oauth: 0,
  // 'cli-quota' and 'jsonl-estimate' are retained for exhaustive Record<UsageSource, ...> typing only.
  // The CLI quota source was removed (claude quota --json does not exist in the Claude CLI).
  // The JSONL estimate source was removed in story 15.9.
  // These values are kept for backward compatibility with persisted daemon-status.json and
  // audit log files that may still carry these source values.
  'cli-quota': 1,
  'jsonl-estimate': 2,
  stale: 3,
};

const SOURCE_CONFIDENCE: Record<UsageSource, ConfidenceLevel> = {
  oauth: 'high',
  'cli-quota': 'high',
  // 'jsonl-estimate' retained for exhaustive typing only — see SOURCE_PRIORITY note above.
  'jsonl-estimate': 'medium',
  stale: 'low',
};

interface UsageSourceAdapter {
  poll(): Promise<CapacitySnapshot>;
}

interface UsageLogger {
  info(event: string, data: Record<string, unknown>, meta?: AuditMeta): Promise<void> | void;
  warn(event: string, data: Record<string, unknown>, meta?: AuditMeta): Promise<void> | void;
}

interface MonitorOptions {
  authManager?: AuthManager;
  oauthSource?: UsageSourceAdapter;
  logger?: UsageLogger;
}

function cloneWindows(windows: CapacityWindow[]): CapacityWindow[] {
  return windows.map((window) => {
    const clone: CapacityWindow = {
      id: window.id,
      kind: window.kind,
      utilization: window.utilization,
      resetsAt: new Date(window.resetsAt),
      windowDurationHours: window.windowDurationHours,
    };
    if (window.model) {
      clone.model = window.model;
    }
    return clone;
  });
}

function ensureDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new ScrowError(ErrorCode.PROVIDER_UNREACHABLE, `Invalid Date for ${field}.`);
  }
  return value;
}

function normalizeWindowId(id: string): string {
  const lowered = id.toLowerCase();
  if (
    lowered.includes('5-hour') ||
    lowered.includes('five_hour') ||
    lowered.includes('five hour') ||
    lowered === 'session'
  ) {
    return 'session';
  }
  if (lowered.includes('7-day') || lowered.includes('seven_day') || lowered.includes('seven day')) {
    // Preserve model suffix if present (colon format: "seven_day:opus" or "7-day:opus")
    if (lowered.includes(':')) {
      const colonIndex = lowered.indexOf(':');
      const modelSuffix = lowered.slice(colonIndex + 1);
      return modelSuffix.length > 0 ? `weekly:${modelSuffix}` : 'weekly';
    }
    // Underscore format: "seven_day_opus" — extract model after the known prefix
    for (const prefix of ['seven_day_', '7-day_', 'seven day ']) {
      const prefixIndex = lowered.indexOf(prefix);
      if (prefixIndex !== -1) {
        const modelSuffix = lowered.slice(prefixIndex + prefix.length);
        if (modelSuffix.length > 0) {
          return `weekly:${modelSuffix}`;
        }
      }
    }
    return 'weekly';
  }
  return lowered;
}

function normalizeUtilization(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

export class ClaudeCodeUsageMonitor implements UsageMonitor {
  private readonly authManager: AuthManager;
  private readonly oauthSource: UsageSourceAdapter;
  private readonly logger: UsageLogger;

  private lastSnapshot: CapacitySnapshot | null = null;
  private activeSource: UsageSource | null = null;

  constructor(options?: MonitorOptions) {
    this.authManager = options?.authManager ?? new ClaudeCodeAuthManager();
    this.oauthSource =
      options?.oauthSource ?? new OAuthUsageSource({ authManager: this.authManager });
    this.logger = options?.logger ?? logger;
  }

  async poll(): Promise<CapacitySnapshot> {
    const failures: string[] = [];

    const oauthSnapshot = await this.tryOAuthPoll(failures);
    if (oauthSnapshot) {
      return this.onSourceSuccess(oauthSnapshot, 'oauth_poll_success');
    }

    if (this.lastSnapshot) {
      await this.setActiveSource('stale', failures.join('|'));
      return {
        budgetWindows: cloneWindows(this.lastSnapshot.budgetWindows),
        rateWindows: cloneWindows(this.lastSnapshot.rateWindows),
        provider: this.lastSnapshot.provider,
        fetchedAt: new Date(this.lastSnapshot.fetchedAt),
        source: 'stale',
        confidence: 'low',
      };
    }

    throw new ScrowError(
      ErrorCode.PROVIDER_UNREACHABLE,
      `All usage sources failed: ${failures.join('|') || 'unknown_failure'}`,
    );
  }

  private async tryOAuthPoll(failures: string[]): Promise<CapacitySnapshot | null> {
    try {
      return await this.oauthSource.poll();
    } catch (error: unknown) {
      if (error instanceof ScrowError && error.code === ErrorCode.AUTH_TOKEN_EXPIRED) {
        failures.push('oauth_auth_token_expired');
        await this.authManager.refresh();
        try {
          return await this.oauthSource.poll();
        } catch (retryError: unknown) {
          const reason = this.formatFailureReason('oauth_retry', retryError);
          failures.push(reason);
          await this.logger.warn('usage.oauth.failed', { reason, afterRefresh: true });
          return null;
        }
      }

      const reason = this.formatFailureReason('oauth', error);
      failures.push(reason);
      await this.logger.warn('usage.oauth.failed', { reason, afterRefresh: false });
      return null;
    }
  }

  private async onSourceSuccess(
    snapshot: CapacitySnapshot,
    reason: string,
    failures?: string[],
  ): Promise<CapacitySnapshot> {
    const normalized = this.normalizeSnapshot(snapshot);
    await this.setActiveSource(normalized.source, reason, failures);
    if (normalized.source !== 'stale') {
      this.lastSnapshot = {
        budgetWindows: cloneWindows(normalized.budgetWindows),
        rateWindows: cloneWindows(normalized.rateWindows),
        provider: normalized.provider,
        fetchedAt: new Date(normalized.fetchedAt),
        source: normalized.source,
        confidence: normalized.confidence,
      };
    }
    return normalized;
  }

  private normalizeSnapshot(snapshot: CapacitySnapshot): CapacitySnapshot {
    const source = this.normalizeSource(snapshot.source);
    const confidence = this.normalizeConfidence(snapshot.confidence);
    const fetchedAt = ensureDate(new Date(snapshot.fetchedAt), 'fetchedAt');

    const normalizeWindowList = (windows: CapacityWindow[]): CapacityWindow[] =>
      windows.map((window) => {
        const normalizedModel = window.model ? window.model.toLowerCase() : undefined;
        const normalizedWindow: CapacityWindow = {
          id: normalizeWindowId(window.id),
          kind: window.kind,
          utilization: normalizeUtilization(window.utilization),
          resetsAt: ensureDate(new Date(window.resetsAt), 'resetsAt'),
          windowDurationHours: window.windowDurationHours,
        };
        if (normalizedModel) {
          normalizedWindow.model = normalizedModel;
        }
        return normalizedWindow;
      });

    const budgetWindows = normalizeWindowList(snapshot.budgetWindows);
    const rateWindows = normalizeWindowList(snapshot.rateWindows);

    // Sort budget windows: aggregate (no model) first, then by model name
    budgetWindows.sort((left, right) => {
      const modelLeft = left.model ?? '';
      const modelRight = right.model ?? '';
      return modelLeft.localeCompare(modelRight);
    });

    return {
      budgetWindows,
      rateWindows,
      provider: 'claude-code',
      fetchedAt,
      source,
      confidence,
    };
  }

  private normalizeSource(source: UsageSource): UsageSource {
    if (source === 'oauth' || source === 'cli-quota' || source === 'stale') {
      return source;
    }
    if (source === 'jsonl-estimate') {
      // The JSONL estimate source was removed from the fallback chain in story 15.9.
      // Legacy persisted state (daemon-status.json, audit logs) may still contain this value.
      // Remap to 'stale' to prevent storing a removed-source snapshot into lastSnapshot,
      // which would cause a subsequent stale fallback to emit a dead-source snapshot.
      return 'stale';
    }
    throw new ScrowError(ErrorCode.PROVIDER_UNREACHABLE, 'Usage source value is invalid.');
  }

  private normalizeConfidence(confidence: ConfidenceLevel): ConfidenceLevel {
    if (confidence === 'high' || confidence === 'medium' || confidence === 'low') {
      return confidence;
    }
    throw new ScrowError(ErrorCode.PROVIDER_UNREACHABLE, 'Usage confidence value is invalid.');
  }

  private async setActiveSource(
    newSource: UsageSource,
    reason: string,
    failures?: string[],
  ): Promise<void> {
    const previousSource = this.activeSource;
    if (previousSource && previousSource !== newSource) {
      const event =
        SOURCE_PRIORITY[newSource] < SOURCE_PRIORITY[previousSource]
          ? 'usage.source.recovered'
          : 'usage.source.changed';

      const data: Record<string, unknown> = { previousSource, newSource, reason };
      if (failures && failures.length > 0) {
        data['failureReasons'] = failures;
      }

      await this.logger.info(event, data, {
        provider: 'claude-code',
        source: newSource,
        confidence: SOURCE_CONFIDENCE[newSource],
      });
    }
    this.activeSource = newSource;
  }

  private formatFailureReason(prefix: string, error: unknown): string {
    if (error instanceof ScrowError) {
      return `${prefix}:${error.code}`;
    }
    if (error instanceof Error) {
      return `${prefix}:${error.name}`;
    }
    return `${prefix}:unknown_error`;
  }
}
