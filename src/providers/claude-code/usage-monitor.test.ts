/** Unit tests for ClaudeCodeUsageMonitor fallback order, recovery behavior, and normalization. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ScrowError, ErrorCode } from '../../errors/index.js';
import type {
  AuthManager,
  CapacitySnapshot,
  CapacityWindow,
  ConfidenceLevel,
  UsageSource,
} from '../../types/index.js';
import { ClaudeCodeUsageMonitor } from './usage-monitor.js';

function createWindow(
  id: string,
  kind: 'budget' | 'rate',
  utilization: number,
  resetsAt: Date | string,
  windowDurationHours: number,
  model?: string,
): CapacityWindow {
  const window: CapacityWindow = {
    id,
    kind,
    utilization,
    resetsAt: new Date(resetsAt),
    windowDurationHours,
  };
  if (model) {
    window.model = model;
  }
  return window;
}

function createSnapshot(
  source: UsageSource,
  confidence: ConfidenceLevel,
  fetchedAt: Date,
  options?: {
    budgetWindows?: CapacityWindow[];
    rateWindows?: CapacityWindow[];
  },
): CapacitySnapshot {
  return {
    budgetWindows: options?.budgetWindows ?? [
      createWindow('weekly', 'budget', 0.4, '2026-02-25T00:00:00.000Z', 168),
    ],
    rateWindows: options?.rateWindows ?? [
      createWindow('session', 'rate', 0.25, '2026-02-24T10:00:00.000Z', 5),
    ],
    provider: 'claude-code',
    fetchedAt,
    source,
    confidence,
  };
}

function createMonitorFixture(options?: { oauthImpl?: () => Promise<CapacitySnapshot> }) {
  const authManager: AuthManager = {
    getToken: vi.fn(async () => 'token'),
    refresh: vi.fn(async () => undefined),
    validate: vi.fn(async () => true),
  };

  const oauthPoll = vi.fn(options?.oauthImpl);
  const infoLog = vi.fn(
    async (_event: string, _data: Record<string, unknown>, _meta?: Record<string, unknown>) =>
      undefined,
  );
  const warnLog = vi.fn(
    async (_event: string, _data: Record<string, unknown>, _meta?: Record<string, unknown>) =>
      undefined,
  );

  const oauthSource = { poll: async (): Promise<CapacitySnapshot> => oauthPoll() };
  const logger = {
    info: async (
      event: string,
      data: Record<string, unknown>,
      meta?: Record<string, unknown>,
    ): Promise<void> => infoLog(event, data, meta),
    warn: async (
      event: string,
      data: Record<string, unknown>,
      meta?: Record<string, unknown>,
    ): Promise<void> => warnLog(event, data, meta),
  };

  const monitor = new ClaudeCodeUsageMonitor({
    authManager,
    oauthSource,
    logger,
  });

  return {
    monitor,
    authManager,
    oauthSource,
    oauthPoll,
    infoLog,
    warnLog,
  };
}

describe('ClaudeCodeUsageMonitor', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('returns oauth snapshot when oauth succeeds', async () => {
    const oauthSnapshot = createSnapshot('oauth', 'high', new Date('2026-02-24T01:00:00.000Z'));
    const fixture = createMonitorFixture({
      oauthImpl: async () => oauthSnapshot,
    });

    const result = await fixture.monitor.poll();

    expect(result.source).toBe('oauth');
    expect(fixture.oauthPoll).toHaveBeenCalledTimes(1);
  });

  it('throws PROVIDER_UNREACHABLE when oauth fails with no prior snapshot', async () => {
    const fixture = createMonitorFixture({
      oauthImpl: async () => {
        throw new ScrowError(ErrorCode.PROVIDER_UNREACHABLE, 'oauth_down');
      },
    });

    await expect(fixture.monitor.poll()).rejects.toMatchObject({
      code: ErrorCode.PROVIDER_UNREACHABLE,
    });
  });

  it('returns stale snapshot preserving fetchedAt when oauth fails after a prior success', async () => {
    const firstSnapshot = createSnapshot('oauth', 'high', new Date('2026-02-24T04:00:00.000Z'));
    const fixture = createMonitorFixture({
      oauthImpl: async () => firstSnapshot,
    });

    await fixture.monitor.poll();
    fixture.oauthPoll.mockImplementation(async () => {
      throw new ScrowError(ErrorCode.PROVIDER_UNREACHABLE, 'oauth_now_down');
    });

    const stale = await fixture.monitor.poll();

    expect(stale.source).toBe('stale');
    expect(stale.confidence).toBe('low');
    expect(stale.fetchedAt.toISOString()).toBe('2026-02-24T04:00:00.000Z');
  });

  it('refreshes auth token and retries oauth exactly once on AUTH_TOKEN_EXPIRED', async () => {
    const fixture = createMonitorFixture({
      oauthImpl: async () => createSnapshot('oauth', 'high', new Date('2026-02-24T05:00:00.000Z')),
    });

    fixture.oauthPoll
      .mockRejectedValueOnce(new ScrowError(ErrorCode.AUTH_TOKEN_EXPIRED, 'expired'))
      .mockResolvedValueOnce(createSnapshot('oauth', 'high', new Date('2026-02-24T05:01:00.000Z')));

    const result = await fixture.monitor.poll();

    expect(result.source).toBe('oauth');
    expect(fixture.authManager.refresh).toHaveBeenCalledTimes(1);
    expect(fixture.oauthPoll).toHaveBeenCalledTimes(2);
  });

  it('throws PROVIDER_UNREACHABLE when oauth retry after refresh still fails with no prior snapshot', async () => {
    const fixture = createMonitorFixture({
      oauthImpl: async () => createSnapshot('oauth', 'high', new Date()),
    });

    fixture.oauthPoll
      .mockRejectedValueOnce(new ScrowError(ErrorCode.AUTH_TOKEN_EXPIRED, 'expired'))
      .mockRejectedValueOnce(new ScrowError(ErrorCode.PROVIDER_UNREACHABLE, 'still_down'));

    await expect(fixture.monitor.poll()).rejects.toMatchObject({
      code: ErrorCode.PROVIDER_UNREACHABLE,
    });
    expect(fixture.authManager.refresh).toHaveBeenCalledTimes(1);
    expect(fixture.oauthPoll).toHaveBeenCalledTimes(2);
  });

  it('returns stale when oauth retry after refresh fails and prior snapshot exists', async () => {
    const firstSnapshot = createSnapshot('oauth', 'high', new Date('2026-02-24T06:00:00.000Z'));
    const fixture = createMonitorFixture({
      oauthImpl: async () => firstSnapshot,
    });

    await fixture.monitor.poll();
    fixture.oauthPoll
      .mockRejectedValueOnce(new ScrowError(ErrorCode.AUTH_TOKEN_EXPIRED, 'expired'))
      .mockRejectedValueOnce(new ScrowError(ErrorCode.PROVIDER_UNREACHABLE, 'still_down'));

    const result = await fixture.monitor.poll();

    expect(result.source).toBe('stale');
    expect(fixture.authManager.refresh).toHaveBeenCalledTimes(1);
  });

  it('logs source recovery when oauth becomes healthy again after stale', async () => {
    const fixture = createMonitorFixture({
      oauthImpl: async () => createSnapshot('oauth', 'high', new Date('2026-02-24T07:00:00.000Z')),
    });

    // First poll succeeds, second fails (goes stale), third recovers
    await fixture.monitor.poll();
    fixture.oauthPoll.mockRejectedValueOnce(
      new ScrowError(ErrorCode.PROVIDER_UNREACHABLE, 'oauth_down'),
    );
    await fixture.monitor.poll();
    fixture.infoLog.mockClear();
    fixture.oauthPoll.mockResolvedValueOnce(
      createSnapshot('oauth', 'high', new Date('2026-02-24T07:10:00.000Z')),
    );

    await fixture.monitor.poll();

    expect(fixture.infoLog).toHaveBeenCalledWith(
      'usage.source.recovered',
      expect.objectContaining({
        previousSource: 'stale',
        newSource: 'oauth',
        reason: expect.any(String),
      }),
      expect.objectContaining({
        provider: 'claude-code',
        source: 'oauth',
        confidence: 'high',
      }),
    );
  });

  it('logs usage.oauth.failed warning when oauth fails', async () => {
    const fixture = createMonitorFixture({
      oauthImpl: async () => {
        throw new ScrowError(ErrorCode.PROVIDER_UNREACHABLE, 'oauth_down');
      },
    });

    await expect(fixture.monitor.poll()).rejects.toMatchObject({
      code: ErrorCode.PROVIDER_UNREACHABLE,
    });
    expect(fixture.warnLog).toHaveBeenCalledWith(
      'usage.oauth.failed',
      expect.objectContaining({ afterRefresh: false }),
      undefined,
    );
  });

  it('normalizes window order and date fields deterministically', async () => {
    const fixture = createMonitorFixture({
      oauthImpl: async () =>
        createSnapshot('oauth', 'high', new Date('2026-02-24T08:00:00.000Z'), {
          budgetWindows: [
            createWindow('weekly:opus', 'budget', 0.3, '2026-02-25T00:00:00.000Z', 168, 'opus'),
            createWindow('weekly:haiku', 'budget', 0.1, '2026-02-25T00:00:00.000Z', 168, 'haiku'),
          ],
          rateWindows: [createWindow('session', 'rate', 0.2, '2026-02-24T10:00:00.000Z', 5)],
        }),
    });

    const snapshot = await fixture.monitor.poll();

    expect(snapshot.fetchedAt).toBeInstanceOf(Date);
    expect(snapshot.rateWindows[0]?.id).toBe('session');
    // Budget windows sorted by model (haiku before opus alphabetically)
    expect(snapshot.budgetWindows[0]?.model).toBe('haiku');
    expect(snapshot.budgetWindows[1]?.model).toBe('opus');
    expect(snapshot.budgetWindows.every((w: CapacityWindow) => w.resetsAt instanceof Date)).toBe(
      true,
    );
  });

  it('normalizes legacy underscore-format ID preserving model suffix', async () => {
    const fixture = createMonitorFixture({
      oauthImpl: async () =>
        createSnapshot('oauth', 'high', new Date('2026-02-24T08:00:00.000Z'), {
          budgetWindows: [
            createWindow('seven_day_opus', 'budget', 0.3, '2026-02-25T00:00:00.000Z', 168, 'opus'),
          ],
          rateWindows: [createWindow('five_hour', 'rate', 0.2, '2026-02-24T10:00:00.000Z', 5)],
        }),
    });

    const snapshot = await fixture.monitor.poll();

    // Legacy "seven_day_opus" must become "weekly:opus", not lose the model suffix
    expect(snapshot.budgetWindows[0]?.id).toBe('weekly:opus');
    expect(snapshot.rateWindows[0]?.id).toBe('session');
  });

  it('normalizes model field to lowercase for consistency with lowercased id', async () => {
    const fixture = createMonitorFixture({
      oauthImpl: async () =>
        createSnapshot('oauth', 'high', new Date('2026-02-24T08:00:00.000Z'), {
          budgetWindows: [
            createWindow('weekly:Opus', 'budget', 0.3, '2026-02-25T00:00:00.000Z', 168, 'Opus'),
          ],
          rateWindows: [createWindow('session', 'rate', 0.2, '2026-02-24T10:00:00.000Z', 5)],
        }),
    });

    const snapshot = await fixture.monitor.poll();

    // id is lowercased by normalizeWindowId; model must also be lowercased
    expect(snapshot.budgetWindows[0]?.id).toBe('weekly:opus');
    expect(snapshot.budgetWindows[0]?.model).toBe('opus');
  });

  it('remaps legacy jsonl-estimate source to stale when received in a snapshot', async () => {
    // AC6 backward-compat regression guard: a CapacitySnapshot deserialized from a legacy
    // daemon-status.json with source='jsonl-estimate' must not be stored as-is into lastSnapshot.
    // normalizeSource() maps 'jsonl-estimate' -> 'stale' to prevent storing a dead-source snapshot.
    const legacySnapshot = createSnapshot(
      'jsonl-estimate' as UsageSource,
      'medium',
      new Date('2026-02-24T11:00:00.000Z'),
    );
    const fixture = createMonitorFixture({
      oauthImpl: async () => legacySnapshot,
    });

    const result = await fixture.monitor.poll();

    // 'jsonl-estimate' must be normalized to 'stale' (not stored as the removed source)
    expect(result.source).toBe('stale');
  });
});
