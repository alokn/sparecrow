/** Unit tests for the shared usage payload parser edge cases and normalization. */
import { describe, it, expect } from 'vitest';
import { ScrowError, ErrorCode } from '../../../errors/index.js';
import { parseUsagePayload } from './usage-payload.js';

function expectProviderUnreachable(fn: () => void): void {
  try {
    fn();
    throw new Error('Expected parseUsagePayload to throw ScrowError');
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ScrowError);
    if (error instanceof ScrowError) {
      expect(error.code).toBe(ErrorCode.PROVIDER_UNREACHABLE);
    }
  }
}

describe('parseUsagePayload()', () => {
  it('parses valid payload and normalizes provider metadata', () => {
    const snapshot = parseUsagePayload(
      {
        five_hour: { utilization: 25.0, resets_at: '2026-02-24T10:00:00.000Z' },
        seven_day: { utilization: 45.0, resets_at: '2026-02-25T00:00:00.000Z' },
      },
      'oauth',
    );

    expect(snapshot.provider).toBe('claude-code');
    expect(snapshot.source).toBe('oauth');
    expect(snapshot.confidence).toBe('high');
    expect(snapshot.fetchedAt).toBeInstanceOf(Date);
    expect(snapshot.rateWindows).toHaveLength(1);
    expect(snapshot.budgetWindows).toHaveLength(1);
    expect(snapshot.rateWindows[0]).toMatchObject({
      id: 'session',
      kind: 'rate',
      utilization: 0.25,
      windowDurationHours: 5,
    });
    expect(snapshot.budgetWindows[0]).toMatchObject({
      id: 'weekly',
      kind: 'budget',
      utilization: 0.45,
      windowDurationHours: 168,
    });
  });

  it('clamps utilization values above 100% to 1 and below 0% to 0', () => {
    const snapshot = parseUsagePayload(
      {
        five_hour: { utilization: 150.0, resets_at: '2026-02-24T10:00:00.000Z' },
        seven_day: { utilization: -10.0, resets_at: '2026-02-25T00:00:00.000Z' },
      },
      'cli-quota',
    );

    expect(snapshot.rateWindows).toHaveLength(1);
    expect(snapshot.budgetWindows).toHaveLength(1);
    expect(snapshot.rateWindows[0]).toMatchObject({ id: 'session', utilization: 1 });
    expect(snapshot.budgetWindows[0]).toMatchObject({ id: 'weekly', utilization: 0 });
  });

  it('synthesizes aggregate for per-model-only payload and sorts weekly model buckets alphabetically', () => {
    const snapshot = parseUsagePayload(
      {
        five_hour: { utilization: 50.0, resets_at: '2026-02-24T10:00:00.000Z' },
        seven_day_sonnet: { utilization: -30.0, resets_at: '2026-02-25T00:00:00.000Z' },
        seven_day_opus: { utilization: 140.0, resets_at: '2026-02-25T00:00:00.000Z' },
      },
      'cli-quota',
    );

    // 1 rate + 3 budget (1 synthetic aggregate + 2 per-model)
    expect(snapshot.rateWindows).toHaveLength(1);
    expect(snapshot.budgetWindows).toHaveLength(3);
    expect(snapshot.rateWindows[0]).toMatchObject({ id: 'session', utilization: 0.5 });
    // budget[0]: synthetic aggregate (max utilization = clamped opus = 1), no model field
    expect(snapshot.budgetWindows[0]).toMatchObject({ id: 'weekly', utilization: 1 });
    expect(snapshot.budgetWindows[0]?.model).toBeUndefined();
    // budget[1]: opus (sorted first alphabetically among per-model)
    expect(snapshot.budgetWindows[1]).toMatchObject({ model: 'opus', utilization: 1 });
    // budget[2]: sonnet
    expect(snapshot.budgetWindows[2]).toMatchObject({ model: 'sonnet', utilization: 0 });
  });

  it('throws PROVIDER_UNREACHABLE when payload is not a JSON object', () => {
    expectProviderUnreachable(() => parseUsagePayload('not-an-object', 'oauth'));
  });

  it('throws PROVIDER_UNREACHABLE when utilization field is missing from a bucket', () => {
    expectProviderUnreachable(() =>
      parseUsagePayload(
        {
          five_hour: { resets_at: '2026-02-24T10:00:00.000Z' },
          seven_day: { utilization: 20.0, resets_at: '2026-02-25T00:00:00.000Z' },
        },
        'oauth',
      ),
    );
  });

  it('throws PROVIDER_UNREACHABLE when five_hour timestamp is missing', () => {
    expectProviderUnreachable(() =>
      parseUsagePayload(
        {
          five_hour: { utilization: 50.0 },
          seven_day: { utilization: 10.0, resets_at: '2026-02-25T00:00:00.000Z' },
        },
        'oauth',
      ),
    );
  });

  it('throws PROVIDER_UNREACHABLE when reset timestamp is invalid', () => {
    expectProviderUnreachable(() =>
      parseUsagePayload(
        {
          five_hour: { utilization: 50.0, resets_at: 'not-a-date' },
          seven_day: { utilization: 10.0, resets_at: '2026-02-25T00:00:00.000Z' },
        },
        'oauth',
      ),
    );
  });

  it('throws PROVIDER_UNREACHABLE when seven-day usage windows are absent', () => {
    expectProviderUnreachable(() =>
      parseUsagePayload(
        {
          five_hour: { utilization: 50.0, resets_at: '2026-02-24T10:00:00.000Z' },
        },
        'oauth',
      ),
    );
  });

  it('throws PROVIDER_UNREACHABLE when all weekly buckets are null', () => {
    expectProviderUnreachable(() =>
      parseUsagePayload(
        {
          five_hour: { utilization: 50.0, resets_at: '2026-02-24T10:00:00.000Z' },
          seven_day: null,
          seven_day_opus: null,
        },
        'oauth',
      ),
    );
  });

  it('skips null per-model weekly buckets returned by the API', () => {
    const snapshot = parseUsagePayload(
      {
        five_hour: { utilization: 38.0, resets_at: '2026-02-27T06:00:00.000Z' },
        seven_day: { utilization: 20.0, resets_at: '2026-03-05T03:00:00.000Z' },
        seven_day_oauth_apps: null,
        seven_day_opus: null,
        seven_day_sonnet: { utilization: 23.0, resets_at: '2026-03-04T22:00:00.000Z' },
        seven_day_cowork: null,
      },
      'oauth',
    );

    expect(snapshot.rateWindows).toHaveLength(1);
    expect(snapshot.budgetWindows).toHaveLength(2);
    expect(snapshot.rateWindows[0]).toMatchObject({ id: 'session', utilization: 0.38 });
    expect(snapshot.budgetWindows[0]).toMatchObject({ id: 'weekly', utilization: 0.2 });
    expect(snapshot.budgetWindows[1]).toMatchObject({
      id: 'weekly:sonnet',
      model: 'sonnet',
      utilization: 0.23,
    });
  });

  // AC-5 multi-model subscription scenarios

  it('AC-5a: preserves base seven_day aggregate when present — no synthetic window added', () => {
    const snapshot = parseUsagePayload(
      {
        five_hour: { utilization: 10.0, resets_at: '2026-02-24T10:00:00.000Z' },
        seven_day: { utilization: 9.0, resets_at: '2026-02-28T00:00:00.000Z' },
        seven_day_opus: { utilization: 21.0, resets_at: '2026-02-28T00:00:00.000Z' },
        seven_day_sonnet: { utilization: 5.0, resets_at: '2026-02-28T00:00:00.000Z' },
      },
      'oauth',
    );

    // 1 rate + 3 budget (1 aggregate + 2 per-model)
    expect(snapshot.rateWindows).toHaveLength(1);
    expect(snapshot.budgetWindows).toHaveLength(3);
    // Aggregate window (sorted first: empty model string sorts before 'opus'/'sonnet')
    expect(snapshot.budgetWindows[0]).toMatchObject({ id: 'weekly', utilization: 0.09 });
    expect(snapshot.budgetWindows[0]?.model).toBeUndefined();
    // Per-model windows include their model tag
    expect(snapshot.budgetWindows[1]).toMatchObject({
      id: 'weekly:opus',
      model: 'opus',
      utilization: 0.21,
    });
    expect(snapshot.budgetWindows[2]).toMatchObject({
      id: 'weekly:sonnet',
      model: 'sonnet',
      utilization: 0.05,
    });
  });

  it('AC-5b: synthesizes aggregate as max-utilization when seven_day is null and multiple per-model windows exist', () => {
    const opusResetsAt = '2026-02-28T00:00:00.000Z';
    const sonnetResetsAt = '2026-02-28T06:00:00.000Z';
    const snapshot = parseUsagePayload(
      {
        five_hour: { utilization: 3.0, resets_at: '2026-02-24T10:00:00.000Z' },
        seven_day: null,
        seven_day_opus: { utilization: 21.0, resets_at: opusResetsAt },
        seven_day_sonnet: { utilization: 5.0, resets_at: sonnetResetsAt },
      },
      'oauth',
    );

    // 1 rate + 3 budget (1 synthetic aggregate + 2 per-model)
    expect(snapshot.rateWindows).toHaveLength(1);
    expect(snapshot.budgetWindows).toHaveLength(3);
    // Synthetic aggregate: no model field, utilization = max(0.21, 0.05) = 0.21
    expect(snapshot.budgetWindows[0]).toMatchObject({ id: 'weekly', utilization: 0.21 });
    expect(snapshot.budgetWindows[0]?.model).toBeUndefined();
    // resetsAt must equal the earliest reset timestamp
    expect(snapshot.budgetWindows[0]?.resetsAt).toBeInstanceOf(Date);
    expect(snapshot.budgetWindows[0]?.resetsAt?.toISOString()).toBe(opusResetsAt);
    // Per-model windows retain their model tags
    expect(snapshot.budgetWindows[1]).toMatchObject({ model: 'opus', utilization: 0.21 });
    expect(snapshot.budgetWindows[2]).toMatchObject({ model: 'sonnet', utilization: 0.05 });
  });

  it('AC-5c: synthesizes aggregate when only one per-model weekly window is present', () => {
    const snapshot = parseUsagePayload(
      {
        five_hour: { utilization: 15.0, resets_at: '2026-02-24T10:00:00.000Z' },
        seven_day_opus: { utilization: 42.0, resets_at: '2026-02-28T00:00:00.000Z' },
      },
      'oauth',
    );

    // 1 rate + 2 budget (1 synthetic aggregate + 1 per-model)
    expect(snapshot.rateWindows).toHaveLength(1);
    expect(snapshot.budgetWindows).toHaveLength(2);
    // Synthetic aggregate
    expect(snapshot.budgetWindows[0]).toMatchObject({ id: 'weekly', utilization: 0.42 });
    expect(snapshot.budgetWindows[0]?.model).toBeUndefined();
    // Per-model
    expect(snapshot.budgetWindows[1]).toMatchObject({ model: 'opus', utilization: 0.42 });
  });

  it('AC5: emits empty rateWindows when five_hour is null (no active session)', () => {
    const snapshot = parseUsagePayload(
      {
        five_hour: null,
        seven_day: { utilization: 20.0, resets_at: '2026-02-25T00:00:00.000Z' },
      },
      'oauth',
    );

    expect(snapshot.rateWindows).toHaveLength(0);
    expect(snapshot.budgetWindows).toHaveLength(1);
    expect(snapshot.budgetWindows[0]).toMatchObject({
      id: 'weekly',
      kind: 'budget',
      utilization: 0.2,
    });
  });

  it('AC5: emits empty rateWindows when five_hour is absent', () => {
    const snapshot = parseUsagePayload(
      {
        seven_day: { utilization: 30.0, resets_at: '2026-02-25T00:00:00.000Z' },
      },
      'oauth',
    );

    expect(snapshot.rateWindows).toHaveLength(0);
    expect(snapshot.budgetWindows).toHaveLength(1);
  });
});
