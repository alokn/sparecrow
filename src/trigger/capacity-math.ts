/** Pure capacity intelligence computation primitives for waste potential, reserve, and budget. */
import type { CapacityWindow } from '../types/index.js';

/** Rate gate threshold — utilization must be strictly below this to allow dispatch. */
const RATE_HEADROOM_THRESHOLD = 0.8;

/**
 * Calculates how much capacity will be wasted (lost at reset) given current utilization
 * and time remaining. Returns a 0-1 fraction clamped to valid range.
 *
 * Formula: (1 - utilization) * (1 - timeRemainingHours / windowDurationHours)
 *
 * Edge cases:
 * - timeRemainingHours > windowDurationHours (clock skew): clamped to 0 (no waste yet)
 * - timeRemainingHours < 0 (reset passed): clamped to max waste = (1 - utilization)
 */
export function calculateWastePotential(
  utilization: number,
  timeRemainingHours: number,
  windowDurationHours: number,
): number {
  if (
    !Number.isFinite(utilization) ||
    !Number.isFinite(timeRemainingHours) ||
    !Number.isFinite(windowDurationHours) ||
    windowDurationHours === 0
  ) {
    return 0;
  }

  const unusedFraction = 1 - utilization;
  const elapsedFraction = 1 - timeRemainingHours / windowDurationHours;

  const raw = unusedFraction * elapsedFraction;

  // Clamp to 0-1 range
  return Math.max(0, Math.min(1, raw));
}

/**
 * Calculates effective reserve that decays linearly across the window.
 * At window start, reserve equals the full configured percentage.
 * At window end, reserve decays to 0.
 *
 * Formula: (reservePercentage / 100) * (timeRemainingHours / windowDurationHours)
 *
 * Returns a 0-1 fraction.
 */
export function calculateEffectiveReserve(
  reservePercentage: number,
  timeRemainingHours: number,
  windowDurationHours: number,
): number {
  if (
    !Number.isFinite(reservePercentage) ||
    !Number.isFinite(timeRemainingHours) ||
    !Number.isFinite(windowDurationHours) ||
    windowDurationHours === 0
  ) {
    return 0;
  }

  const raw = (reservePercentage / 100) * (timeRemainingHours / windowDurationHours);

  // Clamp to 0-1 range: clock skew (timeRemaining > windowDuration) could exceed configured max,
  // negative timeRemaining could go below 0
  return Math.max(0, Math.min(1, raw));
}

/**
 * Calculates available budget after subtracting effective reserve from remaining capacity.
 *
 * Formula: (1 - utilization) - effectiveReserve
 *
 * Result can be negative, indicating budget is below reserve threshold.
 * Callers use negative values to block dispatch.
 */
export function calculateAvailableBudget(utilization: number, effectiveReserve: number): number {
  if (!Number.isFinite(utilization) || !Number.isFinite(effectiveReserve)) {
    return 0;
  }
  return 1 - utilization - effectiveReserve;
}

/**
 * Checks whether a rate window has enough headroom to allow dispatch.
 * Uses a hardcoded 80% gate — utilization must be strictly less than 0.80.
 */
export function hasRateHeadroom(utilization: number): boolean {
  if (!Number.isFinite(utilization)) {
    return false;
  }
  return utilization < RATE_HEADROOM_THRESHOLD;
}

/**
 * Calculates aggregate utilization across multiple per-model budget windows.
 * Returns the maximum utilization (conservative — binding constraint)
 * and the earliest resetsAt across all windows.
 *
 * Returns null if the input array is empty.
 */
export function calculateAggregateUtilization(
  windows: ReadonlyArray<CapacityWindow>,
): { utilization: number; resetsAt: Date } | null {
  const budgetWindows = windows.filter((w) => w.kind === 'budget');

  if (budgetWindows.length === 0) {
    return null;
  }

  let maxUtilization = -Infinity;
  let earliestResetsAt = new Date(8640000000000000); // Max date

  for (const window of budgetWindows) {
    if (window.utilization > maxUtilization) {
      maxUtilization = window.utilization;
    }
    if (window.resetsAt.getTime() < earliestResetsAt.getTime()) {
      earliestResetsAt = window.resetsAt;
    }
  }

  return { utilization: maxUtilization, resetsAt: earliestResetsAt };
}
