/** Trigger engine condition and result types. */

import type { TriggerConfig } from './config.js';

/**
 * TriggerCondition is a type alias for TriggerConfig — both represent the same
 * shape (idleHours, maxWastePercentage, weeklyReservePercentage). Using a single
 * source of truth avoids maintenance risk where one gains a field and the other
 * silently falls out of sync.
 */
export type TriggerCondition = TriggerConfig;

export interface TriggerResult {
  shouldDispatch: boolean;
  reason: string;
  evaluatedAt: Date;
  snapshotSource: string;
  /** Waste potential fraction (0-1) from the aggregate budget window. null when no budget windows. */
  wastePotential: number | null;
  /** Effective reserve fraction (0-1) at the current point in the window. null when no budget windows. */
  effectiveReserve: number | null;
  /** Available budget fraction after subtracting reserve. Can be negative. null when no budget windows. */
  availableBudget: number | null;
  /** Whether current time is within configured idle_hours. false when idle_hours is empty or on early-exit paths. */
  isIdleHours: boolean;
  /** Whether any rate window is below 80% utilization. true when rateWindows is empty. */
  rateHeadroom: boolean;
  /** Per-model waste potential. null when no per-model data available. */
  perModelWaste: Array<{ model: string; waste: number }> | null;
}
