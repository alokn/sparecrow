/** Shared usage payload parser for OAuth and CLI quota source adapters. */
import { ScrowError, ErrorCode } from '../../../errors/index.js';
import type { CapacitySnapshot, CapacityWindow, UsageSource } from '../../../types/index.js';
import { isRecord } from '../../../utils/index.js';

type SourceType = Extract<UsageSource, 'oauth' | 'cli-quota'>;

interface UsageBucket {
  utilization: number;
  resetsAt: Date;
  model?: string;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function toDate(value: unknown, field: string): Date {
  const text = asString(value);
  if (!text) {
    throw new ScrowError(
      ErrorCode.PROVIDER_UNREACHABLE,
      `Usage payload missing ${field} reset timestamp.`,
    );
  }

  const ms = Date.parse(text);
  if (Number.isNaN(ms)) {
    throw new ScrowError(
      ErrorCode.PROVIDER_UNREACHABLE,
      `Usage payload contains invalid ${field} reset timestamp.`,
    );
  }

  return new Date(ms);
}

function normalizeUtilization(value: unknown, field: string): number {
  const utilization = asNumber(value);
  if (utilization === null) {
    throw new ScrowError(
      ErrorCode.PROVIDER_UNREACHABLE,
      `Usage payload missing ${field} utilization value.`,
    );
  }

  // The OAuth usage endpoint returns utilization as a percentage (0–100), not a fraction.
  // Divide by 100 to normalise to [0, 1] before clamping.
  // NOTE: extra_usage.utilization in the same API response is already a fraction (0–1), not a
  // percentage — do NOT reuse this function for extra_usage parsing without adjusting the divisor.
  const fraction = utilization / 100;
  if (fraction < 0 || Object.is(fraction, -0)) {
    return 0;
  }
  if (fraction > 1) {
    return 1;
  }
  return fraction;
}

function parseBucket(value: unknown, key: string): UsageBucket {
  if (!isRecord(value)) {
    throw new ScrowError(
      ErrorCode.PROVIDER_UNREACHABLE,
      `Usage payload key "${key}" is not an object.`,
    );
  }

  const model = key.startsWith('seven_day_') ? key.replace('seven_day_', '') : undefined;

  const bucket: UsageBucket = {
    utilization: normalizeUtilization(value['utilization'], key),
    resetsAt: toDate(value['resets_at'], key),
  };
  if (model) {
    bucket.model = model;
  }
  return bucket;
}

/**
 * Parses all `seven_day` and `seven_day_*` keys from the payload into UsageBucket objects.
 *
 * Multi-model fallback: When the base `seven_day` key is null (common for Max 5x and other
 * multi-model subscription tiers), only per-model windows (e.g. `seven_day_opus`,
 * `seven_day_sonnet`) survive. In that case a synthetic aggregate bucket is computed with
 * `utilization = max(per-model utilization)` — the conservative binding constraint — and
 * inserted as the first element (no `.model` field) so that `buildUsageState()` can
 * preferentially select it over any individual per-model window.
 */
function parseWeeklyBuckets(payload: Record<string, unknown>): UsageBucket[] {
  const weeklyKeys = Object.keys(payload).filter(
    (key) => key === 'seven_day' || key.startsWith('seven_day_'),
  );
  const weeklyBuckets: UsageBucket[] = [];

  for (const key of weeklyKeys) {
    // Null/undefined buckets are per-model windows not applicable to this subscription tier — skip them.
    if (payload[key] == null) {
      continue;
    }
    weeklyBuckets.push(parseBucket(payload[key], key));
  }

  if (weeklyBuckets.length === 0) {
    throw new ScrowError(
      ErrorCode.PROVIDER_UNREACHABLE,
      'Usage payload missing seven-day usage windows.',
    );
  }

  // When all parsed buckets carry a `.model` field (meaning the base `seven_day` key was null),
  // synthesize an aggregate bucket with utilization = max across all per-model buckets.
  // This conservative estimate represents the binding constraint for the subscription and ensures
  // `buildUsageState()` can select a non-model aggregate window for status display.
  // The length > 0 invariant is already guaranteed by the throw at lines 109-114 above.
  const allPerModel = weeklyBuckets.every((b) => b.model !== undefined);
  if (allPerModel) {
    // Use reduce() to avoid spread-into-args stack overflow risk for large arrays.
    const maxUtilization = weeklyBuckets.reduce(
      (max, b) => (b.utilization > max ? b.utilization : max),
      weeklyBuckets[0]!.utilization,
    );
    // Use the earliest reset time across all per-model buckets for deterministic behaviour.
    // `Math.min()` returns the smallest timestamp (ms), so the aggregate shows when the
    // most-imminent per-model window resets — the earliest constraint the user will face.
    const earliestResetMs = weeklyBuckets.reduce(
      (min, b) => (b.resetsAt.getTime() < min ? b.resetsAt.getTime() : min),
      weeklyBuckets[0]!.resetsAt.getTime(),
    );
    const syntheticAggregate: UsageBucket = {
      utilization: maxUtilization,
      resetsAt: new Date(earliestResetMs),
    };
    weeklyBuckets.unshift(syntheticAggregate);
  }

  weeklyBuckets.sort((left, right) => {
    const leftModel = left.model ?? '';
    const rightModel = right.model ?? '';
    return leftModel.localeCompare(rightModel);
  });

  return weeklyBuckets;
}

/**
 * Builds CapacityWindow arrays from the raw API payload.
 * Returns { budgetWindows, rateWindows } where:
 *   - budgetWindows: 7-day weekly windows (kind: 'budget', windowDurationHours: 168)
 *   - rateWindows: 5-hour session window (kind: 'rate', windowDurationHours: 5)
 *     If the 5-hour window is null/absent, rateWindows is empty (AC5: no active session).
 */
function buildCapacityWindows(payload: Record<string, unknown>): {
  budgetWindows: CapacityWindow[];
  rateWindows: CapacityWindow[];
} {
  const rateWindows: CapacityWindow[] = [];

  // Handle absent or null 5-hour window (AC5: user hasn't used Claude recently)
  if (payload['five_hour'] != null) {
    const fiveHour = parseBucket(payload['five_hour'], 'five_hour');
    rateWindows.push({
      id: 'session',
      kind: 'rate',
      utilization: fiveHour.utilization,
      resetsAt: fiveHour.resetsAt,
      windowDurationHours: 5,
    });
  }

  const weeklyBuckets = parseWeeklyBuckets(payload);

  const budgetWindows: CapacityWindow[] = weeklyBuckets.map((bucket) => {
    const window: CapacityWindow = {
      id: bucket.model ? `weekly:${bucket.model}` : 'weekly',
      kind: 'budget',
      utilization: bucket.utilization,
      resetsAt: bucket.resetsAt,
      windowDurationHours: 168,
    };
    if (bucket.model) {
      window.model = bucket.model;
    }
    return window;
  });

  return { budgetWindows, rateWindows };
}

export function parseUsagePayload(payload: unknown, source: SourceType): CapacitySnapshot {
  if (!isRecord(payload)) {
    throw new ScrowError(
      ErrorCode.PROVIDER_UNREACHABLE,
      'Usage payload is not valid JSON object data.',
    );
  }

  const { budgetWindows, rateWindows } = buildCapacityWindows(payload);

  return {
    budgetWindows,
    rateWindows,
    provider: 'claude-code',
    fetchedAt: new Date(),
    source,
    confidence: 'high',
  };
}
