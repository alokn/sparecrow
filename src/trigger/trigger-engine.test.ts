/** Unit tests for TriggerEngine capacity intelligence evaluation. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventName } from '../types/index.js';
import type {
  CapacitySnapshot,
  CapacityWindow,
  ConfidenceLevel,
  TriggerCondition,
} from '../types/index.js';
import { TriggerEngine } from './trigger-engine.js';

interface TriggerLoggerMock {
  info: (event: string, data: Record<string, unknown>, meta?: Record<string, unknown>) => void;
  warn: (event: string, data: Record<string, unknown>, meta?: Record<string, unknown>) => void;
  infoSpy: ReturnType<typeof vi.fn>;
  warnSpy: ReturnType<typeof vi.fn>;
}

function createLogger(): TriggerLoggerMock {
  const infoSpy = vi.fn(
    (_event: string, _data: Record<string, unknown>, _meta?: Record<string, unknown>) => undefined,
  );
  const warnSpy = vi.fn(
    (_event: string, _data: Record<string, unknown>, _meta?: Record<string, unknown>) => undefined,
  );
  return {
    info: (event: string, data: Record<string, unknown>, meta?: Record<string, unknown>) =>
      infoSpy(event, data, meta),
    warn: (event: string, data: Record<string, unknown>, meta?: Record<string, unknown>) =>
      warnSpy(event, data, meta),
    infoSpy,
    warnSpy,
  };
}

function createWindow(overrides?: Partial<CapacityWindow>): CapacityWindow {
  return {
    id: overrides?.id ?? 'session',
    kind: overrides?.kind ?? 'rate',
    utilization: overrides?.utilization ?? 0.5,
    resetsAt: overrides?.resetsAt ?? hoursFromNow(3),
    windowDurationHours: overrides?.windowDurationHours ?? 5,
    ...(overrides?.model ? { model: overrides.model } : {}),
  };
}

function createSnapshot(options?: {
  budgetWindows?: CapacityWindow[];
  rateWindows?: CapacityWindow[];
  confidence?: ConfidenceLevel;
  source?: CapacitySnapshot['source'];
}): CapacitySnapshot {
  return {
    budgetWindows: options?.budgetWindows ?? [
      createWindow({
        id: 'weekly',
        kind: 'budget',
        utilization: 0.35,
        resetsAt: hoursFromNow(100),
        windowDurationHours: 168,
      }),
    ],
    rateWindows: options?.rateWindows ?? [
      createWindow({ id: 'session', kind: 'rate', utilization: 0.4, windowDurationHours: 5 }),
    ],
    provider: 'claude-code',
    fetchedAt: new Date(),
    source: options?.source ?? 'oauth',
    confidence: options?.confidence ?? 'high',
  };
}

function hoursFromNow(hours: number): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

const DEFAULT_CONDITION: TriggerCondition = {
  idleHours: [],
  maxWastePercentage: 50,
  weeklyReservePercentage: 30,
};

describe('TriggerEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // AC1 — New TriggerCondition fields
  it('accepts new TriggerCondition fields (idleHours, maxWastePercentage, weeklyReservePercentage)', () => {
    const engine = new TriggerEngine({ logger: createLogger() });
    const condition: TriggerCondition = {
      idleHours: [{ start: '00:00', end: '06:00' }],
      maxWastePercentage: 50,
      weeklyReservePercentage: 30,
    };
    const result = engine.evaluate(createSnapshot(), condition);
    expect(result.evaluatedAt).toBeInstanceOf(Date);
  });

  // AC2 — Rate gate evaluation
  describe('rate gate', () => {
    it('blocks dispatch when ALL rate windows have utilization >= 0.80', () => {
      const engine = new TriggerEngine({ logger: createLogger() });
      const result = engine.evaluate(
        createSnapshot({
          rateWindows: [createWindow({ id: 'session', kind: 'rate', utilization: 0.85 })],
          budgetWindows: [
            createWindow({
              id: 'weekly',
              kind: 'budget',
              utilization: 0.3,
              resetsAt: hoursFromNow(10),
              windowDurationHours: 168,
            }),
          ],
        }),
        { ...DEFAULT_CONDITION, maxWastePercentage: 0 }, // would fire if rate gate passed
      );
      expect(result.shouldDispatch).toBe(false);
      expect(result.reason).toContain('rate limited');
      // isIdleHours is false (DEFAULT_CONDITION has no idle hours), rateHeadroom is false (all windows full)
      expect(result.isIdleHours).toBe(false);
      expect(result.rateHeadroom).toBe(false);
    });

    it('passes when ANY rate window has utilization < 0.80', () => {
      const engine = new TriggerEngine({ logger: createLogger() });
      const result = engine.evaluate(
        createSnapshot({
          rateWindows: [
            createWindow({ id: 'session-1', kind: 'rate', utilization: 0.85 }),
            createWindow({ id: 'session-2', kind: 'rate', utilization: 0.5 }),
          ],
          budgetWindows: [
            createWindow({
              id: 'weekly',
              kind: 'budget',
              utilization: 0.3,
              resetsAt: hoursFromNow(10),
              windowDurationHours: 168,
            }),
          ],
        }),
        { ...DEFAULT_CONDITION, maxWastePercentage: 0 },
      );
      // Should not be rate limited — gate passes
      expect(result.reason).not.toContain('rate limited');
    });

    it('passes when rateWindows is empty (no active session)', () => {
      const engine = new TriggerEngine({ logger: createLogger() });
      const result = engine.evaluate(
        createSnapshot({
          rateWindows: [],
          budgetWindows: [
            createWindow({
              id: 'weekly',
              kind: 'budget',
              utilization: 0.3,
              resetsAt: hoursFromNow(10),
              windowDurationHours: 168,
            }),
          ],
        }),
        { ...DEFAULT_CONDITION, maxWastePercentage: 0 },
      );
      expect(result.reason).not.toContain('rate limited');
    });

    it('blocks at exactly 0.80 utilization (boundary: >= 0.80 blocks)', () => {
      const engine = new TriggerEngine({ logger: createLogger() });
      const result = engine.evaluate(
        createSnapshot({
          rateWindows: [createWindow({ id: 'session', kind: 'rate', utilization: 0.8 })],
          budgetWindows: [
            createWindow({
              id: 'weekly',
              kind: 'budget',
              utilization: 0.3,
              resetsAt: hoursFromNow(10),
              windowDurationHours: 168,
            }),
          ],
        }),
        { ...DEFAULT_CONDITION, maxWastePercentage: 0 },
      );
      expect(result.shouldDispatch).toBe(false);
      expect(result.reason).toContain('rate limited');
      expect(result.isIdleHours).toBe(false);
      expect(result.rateHeadroom).toBe(false);
    });
  });

  // AC3 — Idle hours dispatch path
  describe('idle hours path', () => {
    it('dispatches during idle hours when available budget > 0', () => {
      const engine = new TriggerEngine({ logger: createLogger() });
      // Use a full 24-hour window so the test is deterministic regardless of local time or CI timezone
      const result = engine.evaluate(
        createSnapshot({
          rateWindows: [createWindow({ id: 'session', kind: 'rate', utilization: 0.3 })],
          budgetWindows: [
            createWindow({
              id: 'weekly',
              kind: 'budget',
              utilization: 0.35,
              resetsAt: hoursFromNow(100),
              windowDurationHours: 168,
            }),
          ],
        }),
        {
          idleHours: [{ start: '00:00', end: '23:59' }],
          maxWastePercentage: 50,
          weeklyReservePercentage: 30,
        },
      );

      expect(result.shouldDispatch).toBe(true);
      expect(result.reason).toContain('idle hours');
      // isIdleHours is true (00:00-23:59 covers all times), rateHeadroom is true (rate < 0.80)
      expect(result.isIdleHours).toBe(true);
      expect(result.rateHeadroom).toBe(true);
    });

    it('blocks during idle hours when available budget <= 0 (below reserve)', () => {
      const engine = new TriggerEngine({ logger: createLogger() });
      // Use a full 24-hour window so the test is deterministic regardless of local time or CI timezone
      const result = engine.evaluate(
        createSnapshot({
          rateWindows: [],
          budgetWindows: [
            createWindow({
              id: 'weekly',
              kind: 'budget',
              utilization: 0.85, // very high usage
              resetsAt: hoursFromNow(100), // lots of time left = high reserve
              windowDurationHours: 168,
            }),
          ],
        }),
        {
          idleHours: [{ start: '00:00', end: '23:59' }],
          maxWastePercentage: 50,
          weeklyReservePercentage: 30,
        },
      );

      expect(result.shouldDispatch).toBe(false);
      expect(result.reason).toContain('below reserve');
      // isIdleHours is true (00:00-23:59 covers all times), rateHeadroom is true (no rate windows)
      expect(result.isIdleHours).toBe(true);
      expect(result.rateHeadroom).toBe(true);
    });
  });

  // AC4 — Waste potential dispatch path
  describe('waste potential path', () => {
    it('dispatches when waste potential exceeds maxWastePercentage', () => {
      const engine = new TriggerEngine({ logger: createLogger() });
      // 30% utilization, 6 hours left out of 168 = high waste potential
      const result = engine.evaluate(
        createSnapshot({
          rateWindows: [],
          budgetWindows: [
            createWindow({
              id: 'weekly',
              kind: 'budget',
              utilization: 0.3,
              resetsAt: hoursFromNow(6),
              windowDurationHours: 168,
            }),
          ],
        }),
        {
          idleHours: [], // not in idle hours
          maxWastePercentage: 50,
          weeklyReservePercentage: 30,
        },
      );

      expect(result.shouldDispatch).toBe(true);
      expect(result.reason).toContain('waste potential');
      // isIdleHours is false (no idle hours configured), rateHeadroom is true (no rate windows)
      expect(result.isIdleHours).toBe(false);
      expect(result.rateHeadroom).toBe(true);
    });

    it('skips when waste potential is below maxWastePercentage', () => {
      const engine = new TriggerEngine({ logger: createLogger() });
      // 50% utilization, lots of time left = low waste potential
      const result = engine.evaluate(
        createSnapshot({
          rateWindows: [],
          budgetWindows: [
            createWindow({
              id: 'weekly',
              kind: 'budget',
              utilization: 0.5,
              resetsAt: hoursFromNow(100),
              windowDurationHours: 168,
            }),
          ],
        }),
        {
          idleHours: [],
          maxWastePercentage: 50,
          weeklyReservePercentage: 30,
        },
      );

      expect(result.shouldDispatch).toBe(false);
      expect(result.reason).toContain('waste potential');
      expect(result.reason).toContain('below threshold');
      // isIdleHours is false (no idle hours configured), rateHeadroom is true (no rate windows)
      expect(result.isIdleHours).toBe(false);
      expect(result.rateHeadroom).toBe(true);
    });
  });

  // AC5 — Multi-model aggregate for waste
  it('uses aggregate utilization (max across models) for waste calculation', () => {
    const engine = new TriggerEngine({ logger: createLogger() });
    const result = engine.evaluate(
      createSnapshot({
        rateWindows: [],
        budgetWindows: [
          createWindow({
            id: 'weekly:opus',
            kind: 'budget',
            utilization: 0.9, // high util for opus
            resetsAt: hoursFromNow(6),
            windowDurationHours: 168,
            model: 'opus',
          }),
          createWindow({
            id: 'weekly:sonnet',
            kind: 'budget',
            utilization: 0.1, // low util for sonnet
            resetsAt: hoursFromNow(6),
            windowDurationHours: 168,
            model: 'sonnet',
          }),
        ],
      }),
      {
        idleHours: [],
        maxWastePercentage: 50,
        weeklyReservePercentage: 0,
      },
    );

    // Aggregate utilization = max(0.9, 0.1) = 0.9
    // Waste potential = (1 - 0.9) * (1 - 6/168) = 0.1 * 0.964 = 0.0964 = ~9.6%
    // This is below 50% threshold, so should NOT dispatch
    expect(result.shouldDispatch).toBe(false);
    expect(result.wastePotential).not.toBeNull();
    if (result.wastePotential !== null) {
      expect(result.wastePotential).toBeCloseTo(0.0964, 2);
    }
  });

  // AC6 — Dispatch guard preserved
  it('suppresses re-dispatch while dispatch is already in progress', () => {
    const logger = createLogger();
    const engine = new TriggerEngine({ logger });
    // First call triggers dispatch
    const snapshot = createSnapshot({
      rateWindows: [],
      budgetWindows: [
        createWindow({
          id: 'weekly',
          kind: 'budget',
          utilization: 0.3,
          resetsAt: hoursFromNow(6),
          windowDurationHours: 168,
        }),
      ],
    });
    const condition: TriggerCondition = {
      idleHours: [],
      maxWastePercentage: 50,
      weeklyReservePercentage: 0,
    };

    const first = engine.evaluate(snapshot, condition);
    const second = engine.evaluate(snapshot, condition);
    const third = engine.evaluate(snapshot, condition);

    expect(first.shouldDispatch).toBe(true);
    expect(second.shouldDispatch).toBe(false);
    expect(second.reason).toContain('dispatch already in progress');
    // dispatch-in-progress early exit sets isIdleHours: false, rateHeadroom: true (engine.ts constants)
    expect(second.isIdleHours).toBe(false);
    expect(second.rateHeadroom).toBe(true);
    expect(third.shouldDispatch).toBe(false);
    expect(third.reason).toContain('dispatch already in progress');
  });

  it('fires again after daemon resets dispatch state and conditions still match', () => {
    const engine = new TriggerEngine({ logger: createLogger() });
    const snapshot = createSnapshot({
      rateWindows: [],
      budgetWindows: [
        createWindow({
          id: 'weekly',
          kind: 'budget',
          utilization: 0.3,
          resetsAt: hoursFromNow(6),
          windowDurationHours: 168,
        }),
      ],
    });
    const condition: TriggerCondition = {
      idleHours: [],
      maxWastePercentage: 50,
      weeklyReservePercentage: 0,
    };

    const first = engine.evaluate(snapshot, condition);
    engine.resetDispatchState();
    const second = engine.evaluate(snapshot, condition);

    expect(first.shouldDispatch).toBe(true);
    expect(second.shouldDispatch).toBe(true);
  });

  // AC7 — Audit logging
  it('logs structured capacity context on TRIGGER_FIRED', () => {
    const loggerMock = createLogger();
    const engine = new TriggerEngine({ logger: loggerMock });
    engine.evaluate(
      createSnapshot({
        rateWindows: [],
        budgetWindows: [
          createWindow({
            id: 'weekly',
            kind: 'budget',
            utilization: 0.3,
            resetsAt: hoursFromNow(6),
            windowDurationHours: 168,
          }),
        ],
      }),
      { idleHours: [], maxWastePercentage: 50, weeklyReservePercentage: 0 },
    );

    expect(loggerMock.infoSpy).toHaveBeenCalledWith(
      EventName.TRIGGER_FIRED,
      expect.objectContaining({
        shouldDispatch: true,
        wastePotential: expect.any(Number),
        effectiveReserve: expect.any(Number),
        availableBudget: expect.any(Number),
        isIdleHours: expect.any(Boolean),
        rateHeadroom: expect.any(Boolean),
        perModelWaste: expect.any(Array),
      }),
      expect.objectContaining({ provider: 'claude-code', source: 'oauth', confidence: 'high' }),
    );
  });

  it('logs structured capacity context on TRIGGER_SKIPPED', () => {
    const loggerMock = createLogger();
    const engine = new TriggerEngine({ logger: loggerMock });
    engine.evaluate(
      createSnapshot({
        rateWindows: [],
        budgetWindows: [
          createWindow({
            id: 'weekly',
            kind: 'budget',
            utilization: 0.5,
            resetsAt: hoursFromNow(100),
            windowDurationHours: 168,
          }),
        ],
      }),
      DEFAULT_CONDITION,
    );

    expect(loggerMock.infoSpy).toHaveBeenCalledWith(
      EventName.TRIGGER_SKIPPED,
      expect.objectContaining({
        shouldDispatch: false,
        maxWastePercentage: 50,
        weeklyReservePercentage: 30,
        wastePotential: expect.any(Number),
        effectiveReserve: expect.any(Number),
        availableBudget: expect.any(Number),
      }),
      expect.any(Object),
    );
  });

  it('logs per-model waste for multi-model tiers', () => {
    const loggerMock = createLogger();
    const engine = new TriggerEngine({ logger: loggerMock });
    engine.evaluate(
      createSnapshot({
        rateWindows: [],
        budgetWindows: [
          createWindow({
            id: 'weekly:opus',
            kind: 'budget',
            utilization: 0.5,
            resetsAt: hoursFromNow(50),
            windowDurationHours: 168,
            model: 'opus',
          }),
          createWindow({
            id: 'weekly:sonnet',
            kind: 'budget',
            utilization: 0.3,
            resetsAt: hoursFromNow(50),
            windowDurationHours: 168,
            model: 'sonnet',
          }),
        ],
      }),
      DEFAULT_CONDITION,
    );

    const logData = loggerMock.infoSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    const perModelWaste = logData['perModelWaste'] as Array<{ model: string; waste: number }>;
    expect(perModelWaste).toHaveLength(2);
    expect(perModelWaste[0]!.model).toBe('opus');
    expect(perModelWaste[1]!.model).toBe('sonnet');
  });

  // AC8 — TriggerResult includes capacity context
  it('returns wastePotential, effectiveReserve, availableBudget in TriggerResult', () => {
    const engine = new TriggerEngine({ logger: createLogger() });
    const result = engine.evaluate(
      createSnapshot({
        rateWindows: [],
        budgetWindows: [
          createWindow({
            id: 'weekly',
            kind: 'budget',
            utilization: 0.5,
            resetsAt: hoursFromNow(84), // half the week
            windowDurationHours: 168,
          }),
        ],
      }),
      DEFAULT_CONDITION,
    );

    expect(result.wastePotential).not.toBeNull();
    expect(result.effectiveReserve).not.toBeNull();
    expect(result.availableBudget).not.toBeNull();
    // At 50% utilization, 84h remaining out of 168h:
    // waste = 0.5 * 0.5 = 0.25
    // reserve = 0.3 * (84/168) = 0.15
    // available = (1 - 0.5) - 0.15 = 0.35
    expect(result.wastePotential).toBeCloseTo(0.25, 1);
    expect(result.effectiveReserve).toBeCloseTo(0.15, 1);
    expect(result.availableBudget).toBeCloseTo(0.35, 1);
  });

  // Snapshot validation
  it('returns safe non-dispatch result for malformed snapshots', () => {
    const logger = createLogger();
    const engine = new TriggerEngine({ logger });
    const malformed = {
      budgetWindows: [],
      rateWindows: [],
      provider: 'claude-code',
      fetchedAt: new Date(),
      source: 'oauth',
      confidence: 'high',
    } as CapacitySnapshot;

    const result = engine.evaluate(malformed, DEFAULT_CONDITION);
    expect(result.shouldDispatch).toBe(false);
    expect(result.reason).toContain('Invalid snapshot');
  });

  it('returns safe non-dispatch when a window element is null', () => {
    const engine = new TriggerEngine({ logger: createLogger() });
    const snapshot = {
      ...createSnapshot(),
      budgetWindows: [null as unknown as CapacityWindow],
    };
    const result = engine.evaluate(snapshot, DEFAULT_CONDITION);
    expect(result.shouldDispatch).toBe(false);
    expect(result.reason).toContain('Invalid snapshot');
  });

  it('returns safe non-dispatch when a window has an empty id', () => {
    const engine = new TriggerEngine({ logger: createLogger() });
    const snapshot = createSnapshot({
      rateWindows: [createWindow({ id: '' })],
      budgetWindows: [],
    });
    const result = engine.evaluate(snapshot, DEFAULT_CONDITION);
    expect(result.shouldDispatch).toBe(false);
    expect(result.reason).toContain('Invalid snapshot');
  });

  it('returns safe non-dispatch when a window has NaN utilization', () => {
    const engine = new TriggerEngine({ logger: createLogger() });
    const snapshot = createSnapshot({
      rateWindows: [createWindow({ utilization: NaN })],
      budgetWindows: [],
    });
    const result = engine.evaluate(snapshot, DEFAULT_CONDITION);
    expect(result.shouldDispatch).toBe(false);
    expect(result.reason).toContain('Invalid snapshot');
  });

  it('returns safe non-dispatch when a window has an invalid resetsAt Date', () => {
    const engine = new TriggerEngine({ logger: createLogger() });
    const snapshot = createSnapshot({
      rateWindows: [createWindow({ resetsAt: new Date('not-a-date') })],
      budgetWindows: [],
    });
    const result = engine.evaluate(snapshot, DEFAULT_CONDITION);
    expect(result.shouldDispatch).toBe(false);
    expect(result.reason).toContain('Invalid snapshot');
  });

  it('returns safe non-dispatch when a window has an invalid kind value', () => {
    const engine = new TriggerEngine({ logger: createLogger() });
    const snapshot = createSnapshot({
      rateWindows: [createWindow({ kind: 'invalid' as 'rate' })],
      budgetWindows: [],
    });
    const result = engine.evaluate(snapshot, DEFAULT_CONDITION);
    expect(result.shouldDispatch).toBe(false);
    expect(result.reason).toContain('Invalid snapshot');
  });

  it('returns safe non-dispatch when a window has NaN windowDurationHours', () => {
    const engine = new TriggerEngine({ logger: createLogger() });
    const snapshot = createSnapshot({
      rateWindows: [createWindow({ windowDurationHours: NaN })],
      budgetWindows: [],
    });
    const result = engine.evaluate(snapshot, DEFAULT_CONDITION);
    expect(result.shouldDispatch).toBe(false);
    expect(result.reason).toContain('Invalid snapshot');
  });

  it('returns safe non-dispatch when a window has zero windowDurationHours', () => {
    const engine = new TriggerEngine({ logger: createLogger() });
    const snapshot = createSnapshot({
      rateWindows: [createWindow({ windowDurationHours: 0 })],
      budgetWindows: [],
    });
    const result = engine.evaluate(snapshot, DEFAULT_CONDITION);
    expect(result.shouldDispatch).toBe(false);
    expect(result.reason).toContain('Invalid snapshot');
  });

  // Condition validation
  it('returns safe non-dispatch result for null conditions', () => {
    const engine = new TriggerEngine({ logger: createLogger() });
    const result = engine.evaluate(createSnapshot(), null as unknown as TriggerCondition);
    expect(result.shouldDispatch).toBe(false);
    expect(result.reason).toContain('Invalid trigger condition');
  });

  it('returns safe non-dispatch result for undefined conditions', () => {
    const engine = new TriggerEngine({ logger: createLogger() });
    const result = engine.evaluate(createSnapshot(), undefined as unknown as TriggerCondition);
    expect(result.shouldDispatch).toBe(false);
    expect(result.reason).toContain('Invalid trigger condition');
  });

  it('returns safe non-dispatch for maxWastePercentage out of range', () => {
    const engine = new TriggerEngine({ logger: createLogger() });
    const result = engine.evaluate(createSnapshot(), {
      idleHours: [],
      maxWastePercentage: 101,
      weeklyReservePercentage: 30,
    });
    expect(result.shouldDispatch).toBe(false);
    expect(result.reason).toContain('Invalid trigger condition');
    expect(result.reason).toContain('maxWastePercentage');
  });

  it('returns safe non-dispatch for weeklyReservePercentage out of range', () => {
    const engine = new TriggerEngine({ logger: createLogger() });
    const result = engine.evaluate(createSnapshot(), {
      idleHours: [],
      maxWastePercentage: 50,
      weeklyReservePercentage: -1,
    });
    expect(result.shouldDispatch).toBe(false);
    expect(result.reason).toContain('Invalid trigger condition');
    expect(result.reason).toContain('weeklyReservePercentage');
  });

  it('returns safe non-dispatch for NaN maxWastePercentage', () => {
    const engine = new TriggerEngine({ logger: createLogger() });
    const result = engine.evaluate(createSnapshot(), {
      idleHours: [],
      maxWastePercentage: NaN,
      weeklyReservePercentage: 30,
    });
    expect(result.shouldDispatch).toBe(false);
    expect(result.reason).toContain('Invalid trigger condition');
  });

  it('returns safe non-dispatch when idleHours is not an array', () => {
    const engine = new TriggerEngine({ logger: createLogger() });
    const result = engine.evaluate(createSnapshot(), {
      idleHours: 'invalid' as unknown as TriggerCondition['idleHours'],
      maxWastePercentage: 50,
      weeklyReservePercentage: 30,
    });
    expect(result.shouldDispatch).toBe(false);
    expect(result.reason).toContain('Invalid trigger condition');
    expect(result.reason).toContain('idleHours');
  });

  // No budget windows
  it('returns safe non-dispatch when no budget windows', () => {
    const engine = new TriggerEngine({ logger: createLogger() });
    const result = engine.evaluate(
      createSnapshot({
        rateWindows: [createWindow({ id: 'session', kind: 'rate', utilization: 0.3 })],
        budgetWindows: [],
      }),
      DEFAULT_CONDITION,
    );
    expect(result.shouldDispatch).toBe(false);
    expect(result.reason).toContain('no budget windows');
  });

  // Logger resilience
  it('keeps evaluate synchronous even if logger returns rejected promise', () => {
    const loggerFailing = {
      info: vi.fn(() => Promise.reject(new Error('logger-failure'))),
      warn: vi.fn(() => Promise.reject(new Error('logger-failure'))),
    };
    const engine = new TriggerEngine({ logger: loggerFailing });
    const result = engine.evaluate(
      createSnapshot({
        rateWindows: [],
        budgetWindows: [
          createWindow({
            id: 'weekly',
            kind: 'budget',
            utilization: 0.3,
            resetsAt: hoursFromNow(6),
            windowDurationHours: 168,
          }),
        ],
      }),
      { idleHours: [], maxWastePercentage: 50, weeklyReservePercentage: 0 },
    );
    expect(result.shouldDispatch).toBe(true);
  });

  // snapshotSource resolution
  it('resolves snapshotSource from snapshot.source', () => {
    const engine = new TriggerEngine({ logger: createLogger() });
    const result = engine.evaluate(createSnapshot({ source: 'cli-quota' }), DEFAULT_CONDITION);
    expect(result.snapshotSource).toBe('cli-quota');
  });

  it('resolves snapshotSource as unknown for null snapshot', () => {
    const engine = new TriggerEngine({ logger: createLogger() });
    const result = engine.evaluate(null as unknown as CapacitySnapshot, DEFAULT_CONDITION);
    expect(result.snapshotSource).toBe('unknown');
  });

  // Story 15.6 — isIdleHours and rateHeadroom fields in TriggerResult
  describe('isIdleHours and rateHeadroom in TriggerResult', () => {
    it('returns isIdleHours false and rateHeadroom true on dispatch-in-progress early exit', () => {
      const engine = new TriggerEngine({ logger: createLogger() });
      const snapshot = createSnapshot({
        rateWindows: [],
        budgetWindows: [
          createWindow({
            id: 'weekly',
            kind: 'budget',
            utilization: 0.3,
            resetsAt: hoursFromNow(6),
            windowDurationHours: 168,
          }),
        ],
      });
      const condition: TriggerCondition = {
        idleHours: [],
        maxWastePercentage: 0,
        weeklyReservePercentage: 0,
      };
      // Force dispatch-in-progress
      engine.evaluate(snapshot, condition); // fires
      const result = engine.evaluate(snapshot, condition); // blocked
      expect(result.shouldDispatch).toBe(false);
      expect(result.reason).toContain('dispatch already in progress');
      expect(result.isIdleHours).toBe(false);
      expect(result.rateHeadroom).toBe(true);
      expect(result.perModelWaste).toBeNull();
    });

    it('returns isIdleHours false and rateHeadroom true on snapshot validation error', () => {
      const engine = new TriggerEngine({ logger: createLogger() });
      const result = engine.evaluate(null as unknown as CapacitySnapshot, DEFAULT_CONDITION);
      expect(result.isIdleHours).toBe(false);
      expect(result.rateHeadroom).toBe(true);
    });

    it('returns isIdleHours false and rateHeadroom true on condition validation error', () => {
      const engine = new TriggerEngine({ logger: createLogger() });
      const result = engine.evaluate(createSnapshot(), null as unknown as TriggerCondition);
      expect(result.isIdleHours).toBe(false);
      expect(result.rateHeadroom).toBe(true);
    });

    it('returns rateHeadroom false when rate limited', () => {
      const engine = new TriggerEngine({ logger: createLogger() });
      const result = engine.evaluate(
        createSnapshot({
          rateWindows: [createWindow({ id: 'session', kind: 'rate', utilization: 0.9 })],
          budgetWindows: [
            createWindow({
              id: 'weekly',
              kind: 'budget',
              utilization: 0.3,
              resetsAt: hoursFromNow(6),
              windowDurationHours: 168,
            }),
          ],
        }),
        DEFAULT_CONDITION,
      );
      expect(result.shouldDispatch).toBe(false);
      expect(result.rateHeadroom).toBe(false);
    });

    it('returns rateHeadroom true when rateWindows is empty', () => {
      const engine = new TriggerEngine({ logger: createLogger() });
      const result = engine.evaluate(
        createSnapshot({
          rateWindows: [],
          budgetWindows: [
            createWindow({
              id: 'weekly',
              kind: 'budget',
              utilization: 0.3,
              resetsAt: hoursFromNow(6),
              windowDurationHours: 168,
            }),
          ],
        }),
        DEFAULT_CONDITION,
      );
      expect(result.rateHeadroom).toBe(true);
    });

    it('returns isIdleHours false and rateHeadroom true when no budget windows', () => {
      const engine = new TriggerEngine({ logger: createLogger() });
      const result = engine.evaluate(
        createSnapshot({
          rateWindows: [createWindow({ id: 'session', kind: 'rate', utilization: 0.3 })],
          budgetWindows: [],
        }),
        DEFAULT_CONDITION,
      );
      expect(result.reason).toContain('no budget windows');
      expect(result.isIdleHours).toBeDefined();
      expect(result.rateHeadroom).toBe(true);
    });

    it('returns isIdleHours true when in idle hours and dispatches', () => {
      const engine = new TriggerEngine({ logger: createLogger() });
      const result = engine.evaluate(
        createSnapshot({
          rateWindows: [],
          budgetWindows: [
            createWindow({
              id: 'weekly',
              kind: 'budget',
              utilization: 0.3,
              resetsAt: hoursFromNow(100),
              windowDurationHours: 168,
            }),
          ],
        }),
        {
          idleHours: [{ start: '00:00', end: '23:59' }],
          maxWastePercentage: 50,
          weeklyReservePercentage: 0,
        },
      );
      expect(result.isIdleHours).toBe(true);
      expect(result.shouldDispatch).toBe(true);
    });

    it('returns isIdleHours false on waste path (outside idle hours)', () => {
      const engine = new TriggerEngine({ logger: createLogger() });
      const result = engine.evaluate(
        createSnapshot({
          rateWindows: [],
          budgetWindows: [
            createWindow({
              id: 'weekly',
              kind: 'budget',
              utilization: 0.3,
              resetsAt: hoursFromNow(6),
              windowDurationHours: 168,
            }),
          ],
        }),
        { idleHours: [], maxWastePercentage: 50, weeklyReservePercentage: 0 },
      );
      expect(result.isIdleHours).toBe(false);
    });

    it('returns perModelWaste array with model waste for multi-model snapshots', () => {
      const engine = new TriggerEngine({ logger: createLogger() });
      const result = engine.evaluate(
        createSnapshot({
          rateWindows: [],
          budgetWindows: [
            createWindow({
              id: 'weekly:opus',
              kind: 'budget',
              utilization: 0.5,
              resetsAt: hoursFromNow(50),
              windowDurationHours: 168,
              model: 'opus',
            }),
            createWindow({
              id: 'weekly:sonnet',
              kind: 'budget',
              utilization: 0.3,
              resetsAt: hoursFromNow(50),
              windowDurationHours: 168,
              model: 'sonnet',
            }),
          ],
        }),
        DEFAULT_CONDITION,
      );
      expect(result.perModelWaste).not.toBeNull();
      expect(result.perModelWaste!.length).toBe(2);
      expect(result.perModelWaste!.some((e) => e.model === 'opus')).toBe(true);
    });

    it('returns perModelWaste as empty array when no budget windows have model field', () => {
      const engine = new TriggerEngine({ logger: createLogger() });
      const result = engine.evaluate(
        createSnapshot({
          rateWindows: [],
          budgetWindows: [
            createWindow({
              id: 'weekly',
              kind: 'budget',
              utilization: 0.3,
              resetsAt: hoursFromNow(6),
              windowDurationHours: 168,
            }),
          ],
        }),
        DEFAULT_CONDITION,
      );
      expect(result.perModelWaste).toEqual([]);
    });
  });
});
