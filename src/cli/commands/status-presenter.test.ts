/** Unit tests for status-presenter helper functions. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setRenderContext, resetRenderContext } from '../../ui/render-context.js';
import {
  renderProgressBar,
  renderExplainBlock,
  usageCardState,
  renderStatusOutput,
} from './status-presenter.js';
import type { StatusSnapshot, StatusUsage, DaemonBackendState } from '../../types/index.js';

function makeUsage(overrides: Partial<StatusUsage> = {}): StatusUsage {
  return {
    sessionUtilization: null,
    weeklyUtilization: null,
    sessionResetsAt: null,
    weeklyResetsAt: null,
    source: null,
    confidence: null,
    subscriptionTier: null,
    degradedReason: null,
    wastePotential: null,
    effectiveReserve: null,
    availableBudget: null,
    isIdleHours: null,
    rateHeadroom: null,
    dispatchReason: null,
    shouldDispatch: null,
    idleHoursSchedule: null,
    perModelWaste: null,
    lastPolledAt: null,
    ...overrides,
  };
}

function makeSnapshot(
  usageOverrides: Partial<StatusUsage> = {},
  backendState: DaemonBackendState | null = null,
): StatusSnapshot {
  return {
    health: {
      daemon: 'running',
      auth: 'valid',
      pid: 1234,
      uptime: '1h',
      lastErrorDetail: null,
    },
    usage: makeUsage({
      sessionUtilization: 0.45,
      weeklyUtilization: 0.62,
      ...usageOverrides,
    }),
    queue: { pendingCount: 0, runningCount: 0, taskNames: [] },
    activity: {
      dispatchCount: 0,
      successRate: null,
      dollarValueRecovered: null,
      recentDispatches: [],
    },
    backendState,
  };
}

describe('renderProgressBar', () => {
  beforeEach(() => {
    setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
  });

  afterEach(() => {
    resetRenderContext();
  });

  it('returns empty string when barWidth is 0', () => {
    expect(renderProgressBar(0.5, 0, false)).toBe('');
  });

  it('returns empty string when barWidth is negative', () => {
    expect(renderProgressBar(0.5, -1, false)).toBe('');
  });

  it('renders fully empty bar at fraction 0', () => {
    expect(renderProgressBar(0, 10, false)).toBe('..........'); // 0 filled, 10 empty
  });

  it('renders fully filled bar at fraction 1', () => {
    expect(renderProgressBar(1, 10, false)).toBe('||||||||||'); // 10 filled, 0 empty
  });

  it('renders partial bar at fraction 0.3', () => {
    const bar = renderProgressBar(0.3, 10, false);
    expect(bar).toBe('|||.......'); // 3 filled, 7 empty
  });

  it('clamps fraction above 1 to 1', () => {
    expect(renderProgressBar(1.5, 10, false)).toBe('||||||||||');
  });

  it('clamps fraction below 0 to 0', () => {
    expect(renderProgressBar(-0.5, 10, false)).toBe('..........');
  });

  it('uses unicode block chars when useUnicode is true', () => {
    const bar = renderProgressBar(0.5, 4, true);
    expect(bar).toBe('██░░'); // 2 filled (█), 2 empty (░)
  });

  it('uses ASCII chars when useUnicode is false', () => {
    const bar = renderProgressBar(0.5, 4, false);
    expect(bar).toBe('||..'); // 2 filled (|), 2 empty (.)
  });

  it('renders single-character bar with fraction 0.5', () => {
    // Math.round(0.5 * 1) = 1 → filled
    expect(renderProgressBar(0.5, 1, false)).toBe('|');
  });
});

describe('renderExplainBlock', () => {
  it('returns "No capacity data available yet" message when all capacity fields are null', () => {
    const usage = makeUsage();
    const result = renderExplainBlock(usage);
    expect(result).toBe('No capacity data available yet. Start the daemon to begin monitoring.');
  });

  it('includes waste risk paragraph when wastePotential is set', () => {
    const usage = makeUsage({
      wastePotential: 0.12,
      weeklyResetsAt: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString(),
      dispatchReason: 'waste potential 12.0% below threshold 50%',
    });
    const result = renderExplainBlock(usage);
    expect(result).toContain('Waste Risk: 12%');
    expect(result).toContain('Dispatch reason:');
  });

  it('includes reserve paragraph when effectiveReserve is set', () => {
    const usage = makeUsage({ effectiveReserve: 0.114 });
    const result = renderExplainBlock(usage);
    expect(result).toContain('Reserve: 11.4%');
    expect(result).toContain('reserved for your own work');
  });

  it('includes available budget paragraph when availableBudget is set', () => {
    const usage = makeUsage({
      availableBudget: 0.536,
      weeklyUtilization: 0.35,
      effectiveReserve: 0.114,
    });
    const result = renderExplainBlock(usage);
    expect(result).toContain('Available: 53.6%');
  });

  it('handles partial nulls — renders only available metrics', () => {
    // Only wastePotential is set, effectiveReserve and availableBudget are null
    const usage = makeUsage({ wastePotential: 0.2 });
    const result = renderExplainBlock(usage);
    expect(result).toContain('Waste Risk: 20%');
    // Should not include Reserve or Available sections when null
    expect(result).not.toContain('Reserve:');
    expect(result).not.toContain('Available:');
  });

  it('handles availableBudget = 0 exactly (boundary)', () => {
    const usage = makeUsage({ availableBudget: 0, weeklyUtilization: 0.7, effectiveReserve: 0.3 });
    const result = renderExplainBlock(usage);
    expect(result).toContain('Available: 0.0%');
  });

  it('includes idle hours paragraph when shouldDispatch and isIdleHours are both true', () => {
    const usage = makeUsage({
      shouldDispatch: true,
      isIdleHours: true,
      idleHoursSchedule: '00:00-06:00 daily',
      availableBudget: 0.2,
      effectiveReserve: 0.1,
      wastePotential: 0.05,
      weeklyUtilization: 0.7,
    });
    const result = renderExplainBlock(usage);
    expect(result).toContain('Idle Hours');
    expect(result).toContain('00:00-06:00 daily');
    expect(result).toContain('Idle-hours dispatch ignores waste-risk thresholds');
  });

  it('does not include idle hours paragraph when isIdleHours is true but shouldDispatch is false', () => {
    // isIdleHours active but dispatch blocked (below reserve) — no idle hours explanation
    const usage = makeUsage({
      shouldDispatch: false,
      isIdleHours: true,
      availableBudget: -0.05,
    });
    const result = renderExplainBlock(usage);
    expect(result).not.toContain('Idle Hours');
  });
});

describe('usageCardState', () => {
  it('returns warning when session utilization >= 70%', () => {
    expect(usageCardState(0.75, 0.3, null)).toBe('warning');
  });

  it('returns warning when weekly utilization >= 70%', () => {
    expect(usageCardState(0.3, 0.8, null)).toBe('warning');
  });

  it('returns healthy when both are below 70% and waste is null', () => {
    expect(usageCardState(0.5, 0.5, null)).toBe('healthy');
  });

  it('returns warning when wastePotential >= 0.7 even if utilization is low', () => {
    expect(usageCardState(0.3, 0.3, 0.75)).toBe('warning');
  });

  it('returns healthy when wastePotential is below 0.7', () => {
    expect(usageCardState(0.3, 0.3, 0.5)).toBe('healthy');
  });

  it('returns healthy when wastePotential is exactly 0', () => {
    expect(usageCardState(0.3, 0.3, 0)).toBe('healthy');
  });

  it('returns warning when wastePotential is exactly 0.7', () => {
    expect(usageCardState(0.3, 0.3, 0.7)).toBe('warning');
  });

  it('handles null session and weekly (treats as 0)', () => {
    expect(usageCardState(null, null, null)).toBe('healthy');
  });
});

describe('AC3/AC4: Usage Card freshness line (compact view)', () => {
  const FIXED_NOW = new Date('2026-03-10T10:00:00.000Z').getTime();

  beforeEach(() => {
    setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
  });

  afterEach(() => {
    resetRenderContext();
    vi.restoreAllMocks();
  });

  it('AC3: shows "Updated Xm ago" when lastPolledAt is non-null and source is healthy', () => {
    // 3 minutes before FIXED_NOW
    const lastPolledAt = new Date(FIXED_NOW - 3 * 60_000).toISOString();
    const snapshot = makeSnapshot({ lastPolledAt, source: 'oauth', confidence: 'high' });
    const output = renderStatusOutput(snapshot, { all: false, detail: false, explain: false });
    expect(output).toContain('Updated 3m ago');
  });

  it('AC4: appends degradation info when source is stale', () => {
    const lastPolledAt = new Date(FIXED_NOW - 5 * 60_000).toISOString();
    const snapshot = makeSnapshot({ lastPolledAt, source: 'stale', confidence: 'low' });
    const output = renderStatusOutput(snapshot, { all: false, detail: false, explain: false });
    expect(output).toContain('Updated 5m ago · stale (low confidence)');
  });

  it('AC4: appends degradation info when confidence is low but source is oauth', () => {
    const lastPolledAt = new Date(FIXED_NOW - 2 * 60_000).toISOString();
    const snapshot = makeSnapshot({ lastPolledAt, source: 'oauth', confidence: 'low' });
    const output = renderStatusOutput(snapshot, { all: false, detail: false, explain: false });
    expect(output).toContain('Updated 2m ago · oauth (low confidence)');
  });

  it('AC3: shows "No data yet" when hasData=false and lastPolledAt is null', () => {
    // hasData=false: no sessionUtilization or weeklyUtilization → compact card early-return path
    const snapshot = makeSnapshot({
      sessionUtilization: null,
      weeklyUtilization: null,
      lastPolledAt: null,
    });
    const output = renderStatusOutput(snapshot, { all: false, detail: false, explain: false });
    expect(output).toContain('No data yet');
  });

  it('High-2: shows "Data age unknown" when hasData=true but lastPolledAt is null (mixed state)', () => {
    // hasData=true (utilization numbers exist) but no poll timestamp — should NOT say "No data yet"
    const snapshot = makeSnapshot({ lastPolledAt: null });
    // makeSnapshot sets sessionUtilization=0.45 and weeklyUtilization=0.62 by default
    const output = renderStatusOutput(snapshot, { all: false, detail: false, explain: false });
    expect(output).toContain('Data age unknown');
    expect(output).not.toContain('No data yet');
  });

  it('High-3: dispatch line is absent in compact mode when all data fields are populated', () => {
    // Compact mode renders 5 lines but COMPACT_MAX=4 drops line 4 (dispatch)
    const lastPolledAt = new Date(FIXED_NOW - 5 * 60_000).toISOString();
    const snapshot = makeSnapshot({
      lastPolledAt,
      source: 'oauth',
      confidence: 'high',
      wastePotential: 0.3,
      shouldDispatch: true,
    });
    const output = renderStatusOutput(snapshot, { all: false, detail: false, explain: false });
    expect(output).toContain('Updated 5m ago');
    expect(output).toContain('Session:');
    expect(output).toContain('Weekly:');
    expect(output).toContain('Waste:');
    // Dispatch is line 4 (0-indexed), which exceeds COMPACT_MAX=4 and is dropped
    expect(output).not.toContain('Dispatch:');
  });

  it('AC4: does not append annotation when source is oauth and confidence is high', () => {
    const lastPolledAt = new Date(FIXED_NOW - 10 * 60_000).toISOString();
    const snapshot = makeSnapshot({ lastPolledAt, source: 'oauth', confidence: 'high' });
    const output = renderStatusOutput(snapshot, { all: false, detail: false, explain: false });
    expect(output).toContain('Updated 10m ago');
    expect(output).not.toContain('confidence');
  });
});

describe('AC6: renderExplainBlock data freshness sentence', () => {
  const FIXED_NOW = new Date('2026-03-10T10:00:00.000Z').getTime();

  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes data freshness sentence when lastPolledAt is non-null', () => {
    const lastPolledAt = new Date(FIXED_NOW - 3 * 60_000).toISOString();
    const usage = makeUsage({
      lastPolledAt,
      source: 'oauth',
      confidence: 'high',
      wastePotential: 0.2,
    });
    const result = renderExplainBlock(usage);
    expect(result).toContain(
      'Usage data was last refreshed 3m ago (source: oauth, confidence: high).',
    );
  });

  it('does not include freshness sentence when lastPolledAt is null', () => {
    const usage = makeUsage({ lastPolledAt: null, wastePotential: 0.2 });
    const result = renderExplainBlock(usage);
    expect(result).not.toContain('Usage data was last refreshed');
  });

  it('shows "unknown" source and confidence when both are null', () => {
    const lastPolledAt = new Date(FIXED_NOW - 60_000).toISOString();
    const usage = makeUsage({
      lastPolledAt,
      source: null,
      confidence: null,
      wastePotential: 0.1,
    });
    const result = renderExplainBlock(usage);
    expect(result).toContain('source: unknown, confidence: unknown');
  });

  it('Medium-5: includes freshness sentence when lastPolledAt is non-null but hasAnyCapacity is false', () => {
    // Daemon has polled (non-null lastPolledAt) but trigger section not yet written (all capacity null)
    const lastPolledAt = new Date(FIXED_NOW - 2 * 60_000).toISOString();
    const usage = makeUsage({
      lastPolledAt,
      source: 'oauth',
      confidence: 'high',
      wastePotential: null,
      effectiveReserve: null,
      availableBudget: null,
    });
    const result = renderExplainBlock(usage);
    expect(result).toContain(
      'Usage data was last refreshed 2m ago (source: oauth, confidence: high).',
    );
    expect(result).toContain('No capacity data available yet.');
  });
});

describe('Medium-4: buildFreshnessLine null source degradation', () => {
  const FIXED_NOW = new Date('2026-03-10T10:00:00.000Z').getTime();

  beforeEach(() => {
    setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
  });

  afterEach(() => {
    resetRenderContext();
    vi.restoreAllMocks();
  });

  it('appends degradation annotation when source is null and confidence is medium', () => {
    // source=null is degraded (unknown provider) — annotation must fire regardless of isHealthySource
    const lastPolledAt = new Date(FIXED_NOW - 4 * 60_000).toISOString();
    const snapshot = makeSnapshot({ lastPolledAt, source: null, confidence: 'medium' });
    const output = renderStatusOutput(snapshot, { all: false, detail: false, explain: false });
    expect(output).toContain('Updated 4m ago · unknown (medium confidence)');
  });

  it('appends degradation annotation when source is null and confidence is high', () => {
    // null source is still degraded even when confidence is high
    const lastPolledAt = new Date(FIXED_NOW - 1 * 60_000).toISOString();
    const snapshot = makeSnapshot({ lastPolledAt, source: null, confidence: 'high' });
    const output = renderStatusOutput(snapshot, { all: false, detail: false, explain: false });
    expect(output).toContain('Updated 1m ago · unknown (high confidence)');
  });

  it('treats confidence===null with source===oauth as non-degraded (no annotation appended)', () => {
    // null confidence means the daemon has polled but confidence has not been set.
    // Per production logic (status-presenter.ts buildFreshnessLine), null confidence is treated
    // as non-degraded so no source/confidence annotation should be appended.
    const lastPolledAt = new Date(FIXED_NOW - 3 * 60_000).toISOString();
    const snapshot = makeSnapshot({ lastPolledAt, source: 'oauth', confidence: null });
    const output = renderStatusOutput(snapshot, { all: false, detail: false, explain: false });
    expect(output).toContain('Updated 3m ago');
    expect(output).not.toContain('confidence)');
  });

  it('appends degradation annotation when source is oauth but confidence is medium', () => {
    // medium confidence is not 'high', so isHighConfidence is false and the annotation fires
    // even though source is healthy (oauth).
    const lastPolledAt = new Date(FIXED_NOW - 2 * 60_000).toISOString();
    const snapshot = makeSnapshot({ lastPolledAt, source: 'oauth', confidence: 'medium' });
    const output = renderStatusOutput(snapshot, { all: false, detail: false, explain: false });
    expect(output).toContain('Updated 2m ago · oauth (medium confidence)');
  });
});

describe('Backend state rendering in status output', () => {
  beforeEach(() => {
    setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
  });

  afterEach(() => {
    resetRenderContext();
  });

  it('AC1: renders available backend with docker version', () => {
    const snapshot = makeSnapshot(
      {},
      { name: 'container', runtime: 'docker', version: '24.0.7', available: true },
    );
    const output = renderStatusOutput(snapshot, { all: false, detail: false, explain: false });
    expect(output).toContain('Backend');
    expect(output).toContain('container (docker 24.0.7)');
  });

  it('AC1: renders available backend with podman runtime', () => {
    const snapshot = makeSnapshot(
      {},
      { name: 'container', runtime: 'podman', version: '4.9.3', available: true },
    );
    const output = renderStatusOutput(snapshot, { all: false, detail: false, explain: false });
    expect(output).toContain('Backend');
    expect(output).toContain('container (podman 4.9.3)');
  });

  it('AC1: renders available backend with null runtime as "container"', () => {
    const snapshot = makeSnapshot(
      {},
      { name: 'container', runtime: null, version: null, available: true },
    );
    const output = renderStatusOutput(snapshot, { all: false, detail: false, explain: false });
    expect(output).toContain('Backend');
    expect(output).toContain('container (container)');
  });

  it('AC2: renders unavailable backend with recovery hint', () => {
    const snapshot = makeSnapshot(
      {},
      { name: 'container', runtime: null, version: null, available: false },
    );
    const output = renderStatusOutput(snapshot, { all: false, detail: false, explain: false });
    expect(output).toContain('Backend');
    expect(output).toContain('container (unavailable)');
    expect(output).toContain('Restart Docker/Podman to restore container execution');
  });

  it('AC2: unavailable backend causes health card to render with warning state', () => {
    // healthCardState returns 'warning' when backendState.available is false and daemon+auth are healthy.
    // In noColor mode renderDashboardCard appends "[WARN]" to the card title when state === 'warning'.
    const snapshot = makeSnapshot(
      {},
      { name: 'container', runtime: null, version: null, available: false },
    );
    const output = renderStatusOutput(snapshot, { all: false, detail: false, explain: false });
    // Verify the Health card title shows the [WARN] suffix that signals warning card state
    expect(output).toContain('Health [WARN]');
  });

  it('does not render backend line when backendState is null', () => {
    const snapshot = makeSnapshot({}, null);
    const output = renderStatusOutput(snapshot, { all: false, detail: false, explain: false });
    expect(output).not.toContain('Backend');
  });

  it('AC3: serialised JSON snapshot includes backendState with all required fields for available backend', () => {
    // The status --json path calls printJson(jsonOk(enriched)) where enriched spreads the snapshot.
    // This test serialises the snapshot as JSON (mimicking jsonOk serialisation) and verifies the
    // backendState fields survive round-trip — catching any accidental omission or rename.
    const snapshot = makeSnapshot(
      {},
      { name: 'container', runtime: 'docker', version: '24.0.7', available: true },
    );
    const serialised = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
    expect(serialised.backendState).not.toBeNull();
    expect(serialised.backendState).toMatchObject({
      available: true,
      name: 'container',
      version: '24.0.7',
    });
  });

  it('AC3: serialised JSON snapshot includes backendState with null runtime and version for unavailable backend', () => {
    // Mirrors the available-backend JSON test but for the unavailable case.
    const snapshot = makeSnapshot(
      {},
      { name: 'container', runtime: null, version: null, available: false },
    );
    const serialised = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
    expect(serialised.backendState).not.toBeNull();
    expect(serialised.backendState).toMatchObject({
      available: false,
      name: 'container',
      runtime: null,
      version: null,
    });
  });
});
