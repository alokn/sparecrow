/** Capacity window types normalized across all provider implementations. */

export type ConfidenceLevel = 'high' | 'medium' | 'low';
export type UsageSource = 'oauth' | 'cli-quota' | 'jsonl-estimate' | 'stale';

/**
 * A single capacity window reported by a provider.
 * Budget windows represent total budget (e.g. weekly); rate windows represent throughput limits (e.g. 5-hour session).
 */
export interface CapacityWindow {
  /** Window identifier, e.g. "weekly", "weekly:opus", "session". */
  id: string;
  /** Budget windows govern total spend; rate windows govern throughput. */
  kind: 'budget' | 'rate';
  /** Utilization fraction 0.0 - 1.0. */
  utilization: number;
  /** When this window resets. */
  resetsAt: Date;
  /** Total window duration in hours (e.g. 168 for weekly, 5 for session). */
  windowDurationHours: number;
  /** Optional model identifier for per-model windows (e.g. "opus", "sonnet"). */
  model?: string;
}

/**
 * Provider-agnostic capacity snapshot grouping windows by kind.
 * Replaces the previous flat UsageSnapshot.windows array.
 */
export interface CapacitySnapshot {
  /** Budget windows — govern total spend (e.g. 7-day weekly). */
  budgetWindows: CapacityWindow[];
  /** Rate windows — govern throughput (e.g. 5-hour session). */
  rateWindows: CapacityWindow[];
  /** Provider name, e.g. "claude-code". */
  provider: string;
  /** When this snapshot was fetched. */
  fetchedAt: Date;
  /** Data source used. */
  source: UsageSource;
  /** Confidence in the data quality. */
  confidence: ConfidenceLevel;
}
