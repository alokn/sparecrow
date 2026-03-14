/** Unit tests for capacity intelligence computation primitives. */
import { describe, expect, it } from 'vitest';
import type { CapacityWindow } from '../types/index.js';
import {
  calculateAggregateUtilization,
  calculateAvailableBudget,
  calculateEffectiveReserve,
  calculateWastePotential,
  hasRateHeadroom,
} from './capacity-math.js';

describe('calculateWastePotential', () => {
  it('returns 0 at week start with 0% utilization (just reset)', () => {
    // Full time remaining = 168h, utilization = 0
    // waste = (1 - 0) * (1 - 168/168) = 1 * 0 = 0
    expect(calculateWastePotential(0, 168, 168)).toBe(0);
  });

  it('returns ~2.9% with 95% utilization and 3 days left', () => {
    // timeRemaining = 72h, utilization = 0.95
    // waste = (1 - 0.95) * (1 - 72/168) = 0.05 * (1 - 0.4286) = 0.05 * 0.5714 ≈ 0.02857
    const result = calculateWastePotential(0.95, 72, 168);
    expect(result).toBeCloseTo(0.02857, 4);
  });

  it('returns ~67.5% with 30% utilization and 6 hours left', () => {
    // timeRemaining = 6h, utilization = 0.30
    // waste = (1 - 0.30) * (1 - 6/168) = 0.70 * (1 - 0.03571) = 0.70 * 0.96429 ≈ 0.675
    const result = calculateWastePotential(0.3, 6, 168);
    expect(result).toBeCloseTo(0.675, 2);
  });

  it('never exceeds unused fraction (50% utilization)', () => {
    // With 50% utilization, max waste = 50% (when timeRemaining = 0)
    // waste = (1 - 0.50) * (1 - 0/168) = 0.50 * 1 = 0.50
    expect(calculateWastePotential(0.5, 0, 168)).toBe(0.5);

    // At various time points, waste should always be <= 0.50
    expect(calculateWastePotential(0.5, 84, 168)).toBeLessThanOrEqual(0.5);
    expect(calculateWastePotential(0.5, 168, 168)).toBeLessThanOrEqual(0.5);
    expect(calculateWastePotential(0.5, 1, 168)).toBeLessThanOrEqual(0.5);
  });

  it('clamps to 0 when timeRemainingHours > windowDurationHours (clock skew)', () => {
    // timeRemaining = 200h > 168h — anomaly
    // raw = (1 - 0.30) * (1 - 200/168) = 0.70 * (-0.19) = -0.133 → clamped to 0
    expect(calculateWastePotential(0.3, 200, 168)).toBe(0);
  });

  it('clamps to max waste when timeRemainingHours < 0 (reset passed)', () => {
    // timeRemaining = -5h — reset already happened
    // raw = (1 - 0.30) * (1 - (-5)/168) = 0.70 * (1 + 0.02976) = 0.70 * 1.02976 ≈ 0.72
    // Clamped to 1.0 maximum, but in practice ≈ 0.72 which is < 1
    const result = calculateWastePotential(0.3, -5, 168);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(1);
  });

  it('returns 0 when utilization is 100% regardless of time', () => {
    // waste = (1 - 1.0) * anything = 0
    expect(calculateWastePotential(1.0, 0, 168)).toBe(0);
    expect(calculateWastePotential(1.0, 84, 168)).toBe(0);
    expect(calculateWastePotential(1.0, 168, 168)).toBe(0);
  });

  it('returns maximum waste when timeRemainingHours is 0 and utilization is 0', () => {
    // waste = (1 - 0) * (1 - 0/168) = 1 * 1 = 1
    expect(calculateWastePotential(0, 0, 168)).toBe(1);
  });

  it('handles 5-hour rate window duration', () => {
    // waste = (1 - 0.50) * (1 - 2/5) = 0.50 * 0.60 = 0.30
    expect(calculateWastePotential(0.5, 2, 5)).toBeCloseTo(0.3, 5);
  });

  it('returns 0 when windowDurationHours is 0 (division by zero guard)', () => {
    expect(calculateWastePotential(0.5, 0, 0)).toBe(0);
  });

  it('returns 0 when inputs are NaN or Infinity', () => {
    expect(calculateWastePotential(NaN, 100, 168)).toBe(0);
    expect(calculateWastePotential(0.5, Infinity, 168)).toBe(0);
    expect(calculateWastePotential(0.5, 100, -Infinity)).toBe(0);
  });

  it('returns value clamped between 0 and 1 for all edge inputs', () => {
    // Exhaustive boundary checks
    const inputs: [number, number, number][] = [
      [0, 0, 168],
      [1, 0, 168],
      [0, 168, 168],
      [1, 168, 168],
      [0.5, -10, 168],
      [0.5, 200, 168],
    ];
    for (const [util, time, dur] of inputs) {
      const result = calculateWastePotential(util, time, dur);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(1);
    }
  });
});

describe('calculateEffectiveReserve', () => {
  it('returns full configured value at week start', () => {
    // reservePercentage = 30, timeRemaining = 168h (just reset)
    // reserve = (30/100) * (168/168) = 0.30
    expect(calculateEffectiveReserve(30, 168, 168)).toBe(0.3);
  });

  it('returns approximately 0 at week end', () => {
    // reservePercentage = 30, timeRemaining = 0
    // reserve = (30/100) * (0/168) = 0
    expect(calculateEffectiveReserve(30, 0, 168)).toBe(0);
  });

  it('returns half at midweek', () => {
    // reservePercentage = 30, timeRemaining = 84h (midweek)
    // reserve = (30/100) * (84/168) = 0.30 * 0.50 = 0.15
    expect(calculateEffectiveReserve(30, 84, 168)).toBe(0.15);
  });

  it('handles 0% reserve percentage', () => {
    expect(calculateEffectiveReserve(0, 168, 168)).toBe(0);
    expect(calculateEffectiveReserve(0, 84, 168)).toBe(0);
  });

  it('handles 100% reserve percentage', () => {
    // reserve = (100/100) * (168/168) = 1.0
    expect(calculateEffectiveReserve(100, 168, 168)).toBe(1.0);
    // reserve = (100/100) * (84/168) = 0.5
    expect(calculateEffectiveReserve(100, 84, 168)).toBe(0.5);
  });

  it('decays linearly across the window', () => {
    const reserve30 = calculateEffectiveReserve(30, 168, 168);
    const reserve30mid = calculateEffectiveReserve(30, 84, 168);
    const reserve30end = calculateEffectiveReserve(30, 0, 168);

    expect(reserve30).toBeCloseTo(0.3, 5);
    expect(reserve30mid).toBeCloseTo(0.15, 5);
    expect(reserve30end).toBeCloseTo(0, 5);

    // Linear: midpoint should be exactly half of start
    expect(reserve30mid).toBeCloseTo(reserve30 / 2, 10);
  });

  it('handles 5-hour rate window duration', () => {
    // reserve = (30/100) * (2.5/5) = 0.30 * 0.50 = 0.15
    expect(calculateEffectiveReserve(30, 2.5, 5)).toBe(0.15);
  });

  it('returns 0 when windowDurationHours is 0 (division by zero guard)', () => {
    expect(calculateEffectiveReserve(30, 0, 0)).toBe(0);
  });

  it('returns 0 when inputs are NaN or Infinity', () => {
    expect(calculateEffectiveReserve(NaN, 168, 168)).toBe(0);
    expect(calculateEffectiveReserve(30, Infinity, 168)).toBe(0);
    expect(calculateEffectiveReserve(30, 168, -Infinity)).toBe(0);
  });

  it('clamps to 0-1 range when timeRemainingHours > windowDurationHours (clock skew)', () => {
    // raw = (30/100) * (200/168) = 0.30 * 1.19 ≈ 0.357 → within 0-1, returned as-is
    const result = calculateEffectiveReserve(30, 200, 168);
    expect(result).toBeGreaterThan(0.3);
    expect(result).toBeLessThanOrEqual(1);
    // With 100% reserve and clock skew, raw = (100/100) * (200/168) = 1.19 → clamped to 1.0
    expect(calculateEffectiveReserve(100, 200, 168)).toBe(1);
  });

  it('clamps to 0 when timeRemainingHours < 0', () => {
    // raw = (30/100) * (-5/168) = negative → clamped to 0
    expect(calculateEffectiveReserve(30, -5, 168)).toBe(0);
  });
});

describe('calculateAvailableBudget', () => {
  it('returns positive when utilization is low and reserve is small', () => {
    // available = (1 - 0.35) - 0.114 = 0.65 - 0.114 = 0.536
    expect(calculateAvailableBudget(0.35, 0.114)).toBeCloseTo(0.536, 3);
  });

  it('returns 0 when remaining equals reserve', () => {
    // available = (1 - 0.70) - 0.30 = 0.30 - 0.30 = 0
    expect(calculateAvailableBudget(0.7, 0.3)).toBeCloseTo(0, 10);
  });

  it('returns negative when utilization exceeds (1 - reserve)', () => {
    // available = (1 - 0.80) - 0.30 = 0.20 - 0.30 = -0.10
    expect(calculateAvailableBudget(0.8, 0.3)).toBeCloseTo(-0.1, 10);
  });

  it('returns full budget when reserve is 0 and utilization is 0', () => {
    // available = (1 - 0) - 0 = 1.0
    expect(calculateAvailableBudget(0, 0)).toBe(1);
  });

  it('returns 0 when fully utilized with no reserve', () => {
    // available = (1 - 1.0) - 0 = 0
    expect(calculateAvailableBudget(1.0, 0)).toBe(0);
  });

  it('returns negative when fully utilized with reserve', () => {
    // available = (1 - 1.0) - 0.30 = -0.30
    expect(calculateAvailableBudget(1.0, 0.3)).toBeCloseTo(-0.3, 10);
  });

  it('returns 0 when utilization is NaN', () => {
    expect(calculateAvailableBudget(NaN, 0.3)).toBe(0);
  });

  it('returns 0 when effectiveReserve is NaN', () => {
    expect(calculateAvailableBudget(0.5, NaN)).toBe(0);
  });

  it('returns 0 when utilization is Infinity', () => {
    expect(calculateAvailableBudget(Infinity, 0.3)).toBe(0);
  });

  it('returns 0 when effectiveReserve is -Infinity', () => {
    expect(calculateAvailableBudget(0.5, -Infinity)).toBe(0);
  });
});

describe('hasRateHeadroom', () => {
  it('returns true when utilization is below 0.80', () => {
    expect(hasRateHeadroom(0)).toBe(true);
    expect(hasRateHeadroom(0.5)).toBe(true);
    expect(hasRateHeadroom(0.79)).toBe(true);
    expect(hasRateHeadroom(0.799999)).toBe(true);
  });

  it('returns false when utilization is exactly 0.80 (boundary)', () => {
    expect(hasRateHeadroom(0.8)).toBe(false);
  });

  it('returns false when utilization is above 0.80', () => {
    expect(hasRateHeadroom(0.81)).toBe(false);
    expect(hasRateHeadroom(0.95)).toBe(false);
    expect(hasRateHeadroom(1.0)).toBe(false);
  });

  it('returns false for NaN input', () => {
    expect(hasRateHeadroom(NaN)).toBe(false);
  });

  it('returns false for -Infinity input', () => {
    expect(hasRateHeadroom(-Infinity)).toBe(false);
  });

  it('returns false for Infinity input', () => {
    expect(hasRateHeadroom(Infinity)).toBe(false);
  });
});

describe('calculateAggregateUtilization', () => {
  function createBudgetWindow(overrides?: Partial<CapacityWindow>): CapacityWindow {
    return {
      id: overrides?.id ?? 'weekly',
      kind: 'budget',
      utilization: overrides?.utilization ?? 0.5,
      resetsAt: overrides?.resetsAt ?? new Date('2026-03-10T00:00:00.000Z'),
      windowDurationHours: overrides?.windowDurationHours ?? 168,
      ...(overrides?.model ? { model: overrides.model } : {}),
    };
  }

  it('returns null for empty array', () => {
    expect(calculateAggregateUtilization([])).toBeNull();
  });

  it('returns the single window values when only one window', () => {
    const resetsAt = new Date('2026-03-10T00:00:00.000Z');
    const result = calculateAggregateUtilization([
      createBudgetWindow({ utilization: 0.4, resetsAt }),
    ]);
    expect(result).toEqual({ utilization: 0.4, resetsAt });
  });

  it('returns max utilization across multiple models (conservative)', () => {
    const resetsAt = new Date('2026-03-10T00:00:00.000Z');
    const result = calculateAggregateUtilization([
      createBudgetWindow({ id: 'weekly:opus', model: 'opus', utilization: 0.7, resetsAt }),
      createBudgetWindow({ id: 'weekly:sonnet', model: 'sonnet', utilization: 0.3, resetsAt }),
    ]);
    expect(result?.utilization).toBe(0.7);
  });

  it('returns earliest resetsAt across windows', () => {
    const early = new Date('2026-03-09T12:00:00.000Z');
    const late = new Date('2026-03-10T00:00:00.000Z');
    const result = calculateAggregateUtilization([
      createBudgetWindow({ id: 'weekly:opus', model: 'opus', utilization: 0.3, resetsAt: early }),
      createBudgetWindow({
        id: 'weekly:sonnet',
        model: 'sonnet',
        utilization: 0.5,
        resetsAt: late,
      }),
    ]);
    expect(result?.resetsAt).toEqual(early);
    expect(result?.utilization).toBe(0.5);
  });

  it('handles windows with equal utilization', () => {
    const resetsAt = new Date('2026-03-10T00:00:00.000Z');
    const result = calculateAggregateUtilization([
      createBudgetWindow({ utilization: 0.6, resetsAt }),
      createBudgetWindow({ utilization: 0.6, resetsAt }),
    ]);
    expect(result?.utilization).toBe(0.6);
  });

  it('handles three or more model windows', () => {
    const resetsAt = new Date('2026-03-10T00:00:00.000Z');
    const result = calculateAggregateUtilization([
      createBudgetWindow({ id: 'weekly:opus', model: 'opus', utilization: 0.4, resetsAt }),
      createBudgetWindow({ id: 'weekly:sonnet', model: 'sonnet', utilization: 0.8, resetsAt }),
      createBudgetWindow({ id: 'weekly:haiku', model: 'haiku', utilization: 0.2, resetsAt }),
    ]);
    expect(result?.utilization).toBe(0.8);
  });

  it('filters out rate windows and only aggregates budget windows', () => {
    const resetsAt = new Date('2026-03-10T00:00:00.000Z');
    const rateWindow: CapacityWindow = {
      id: 'session',
      kind: 'rate',
      utilization: 0.95,
      resetsAt,
      windowDurationHours: 5,
    };
    const budgetWindow = createBudgetWindow({ utilization: 0.4, resetsAt });
    const result = calculateAggregateUtilization([rateWindow, budgetWindow]);
    // Rate window with 0.95 must be ignored; only budget window's 0.4 counts
    expect(result?.utilization).toBe(0.4);
  });

  it('returns null when all windows are rate windows', () => {
    const rateWindow: CapacityWindow = {
      id: 'session',
      kind: 'rate',
      utilization: 0.5,
      resetsAt: new Date('2026-03-10T00:00:00.000Z'),
      windowDurationHours: 5,
    };
    expect(calculateAggregateUtilization([rateWindow])).toBeNull();
  });
});
