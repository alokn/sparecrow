/** Stateful trigger evaluation engine with capacity intelligence dispatch logic. */
import {
  EventName,
  type CapacitySnapshot,
  type CapacityWindow,
  type TriggerCondition,
  type TriggerResult,
} from '../types/index.js';
import { logger, type AuditMeta } from '../utils/index.js';
import {
  calculateWastePotential,
  calculateEffectiveReserve,
  calculateAvailableBudget,
  hasRateHeadroom,
  calculateAggregateUtilization,
} from './capacity-math.js';
import { isIdleTime } from './idle-hours.js';

interface TriggerLogger {
  info(event: string, data: Record<string, unknown>, meta?: AuditMeta): Promise<void> | void;
  warn(event: string, data: Record<string, unknown>, meta?: AuditMeta): Promise<void> | void;
}

interface TriggerEngineOptions {
  logger?: TriggerLogger;
}

export class TriggerEngine {
  private readonly logger: TriggerLogger;
  private _isDispatching = false;

  constructor(options?: TriggerEngineOptions) {
    this.logger = options?.logger ?? logger;
  }

  evaluate(snapshot: CapacitySnapshot, conditions: TriggerCondition): TriggerResult {
    const evaluatedAt = new Date();

    if (this._isDispatching) {
      const result: TriggerResult = {
        shouldDispatch: false,
        reason: 'dispatch already in progress',
        evaluatedAt,
        snapshotSource: this.resolveSnapshotSource(snapshot),
        wastePotential: null,
        effectiveReserve: null,
        availableBudget: null,
        isIdleHours: false,
        rateHeadroom: true,
        perModelWaste: null,
      };
      this.logDecision(EventName.TRIGGER_SKIPPED, snapshot, conditions, result);
      return result;
    }

    const snapshotValidationError = this.validateSnapshot(snapshot);
    const snapshotSource = this.resolveSnapshotSource(snapshot);
    if (snapshotValidationError) {
      const result: TriggerResult = {
        shouldDispatch: false,
        reason: `Invalid snapshot: ${snapshotValidationError}`,
        evaluatedAt,
        snapshotSource,
        wastePotential: null,
        effectiveReserve: null,
        availableBudget: null,
        isIdleHours: false,
        rateHeadroom: true,
        perModelWaste: null,
      };
      this.logDecision(EventName.TRIGGER_SKIPPED, snapshot, conditions, result);
      return result;
    }

    const conditionValidationError = this.validateConditions(conditions);
    if (conditionValidationError) {
      const result: TriggerResult = {
        shouldDispatch: false,
        reason: `Invalid trigger condition: ${conditionValidationError}`,
        evaluatedAt,
        snapshotSource,
        wastePotential: null,
        effectiveReserve: null,
        availableBudget: null,
        isIdleHours: false,
        rateHeadroom: true,
        perModelWaste: null,
      };
      this.logDecision(EventName.TRIGGER_SKIPPED, snapshot, conditions, result);
      return result;
    }

    // Warn about anomalous but non-fatal snapshot values (AC5: inconsistent data)
    this.warnIfInconsistentSnapshot(snapshot);

    // Step 1: Rate gate — check if ANY rate window has headroom
    const rateGateResult = this.evaluateRateGate(snapshot.rateWindows);
    const rateHeadroom =
      snapshot.rateWindows.length === 0 ||
      snapshot.rateWindows.some((w) => hasRateHeadroom(w.utilization));
    if (!rateGateResult.pass) {
      const result: TriggerResult = {
        shouldDispatch: false,
        reason: `rate limited: ${rateGateResult.reason}`,
        evaluatedAt,
        snapshotSource,
        wastePotential: null,
        effectiveReserve: null,
        availableBudget: null,
        isIdleHours: isIdleTimeSafe(conditions.idleHours, evaluatedAt),
        rateHeadroom,
        perModelWaste: null,
      };
      this.logDecision(EventName.TRIGGER_SKIPPED, snapshot, conditions, result);
      return result;
    }

    // Step 2: Calculate capacity metrics from budget windows
    const aggregate = calculateAggregateUtilization(snapshot.budgetWindows);
    if (aggregate === null) {
      const result: TriggerResult = {
        shouldDispatch: false,
        reason: 'no budget windows available',
        evaluatedAt,
        snapshotSource,
        wastePotential: null,
        effectiveReserve: null,
        availableBudget: null,
        isIdleHours: isIdleTimeSafe(conditions.idleHours, evaluatedAt),
        rateHeadroom,
        perModelWaste: null,
      };
      this.logDecision(EventName.TRIGGER_SKIPPED, snapshot, conditions, result);
      return result;
    }

    // Use the aggregate (max) utilization and earliest resetsAt
    const timeRemainingHours =
      (aggregate.resetsAt.getTime() - evaluatedAt.getTime()) / (1000 * 60 * 60);
    // Use the maximum windowDurationHours across all budget windows.
    // All standard weekly windows share 168h, but taking the max is defensive against
    // mixed-duration providers that may report windows with different durations.
    const windowDurationHours = Math.max(
      ...snapshot.budgetWindows.map((w) => w.windowDurationHours),
    );

    const wastePotential = calculateWastePotential(
      aggregate.utilization,
      timeRemainingHours,
      windowDurationHours,
    );
    const effectiveReserve = calculateEffectiveReserve(
      conditions.weeklyReservePercentage,
      timeRemainingHours,
      windowDurationHours,
    );
    const availBudget = calculateAvailableBudget(aggregate.utilization, effectiveReserve);

    // Calculate per-model waste for audit logging
    const perModelWaste = this.calculatePerModelWaste(snapshot.budgetWindows, evaluatedAt);

    // Step 3: Idle hours path
    const idleHoursActive = isIdleTimeSafe(conditions.idleHours, evaluatedAt);
    const isIdleHoursActive = conditions.idleHours.length > 0 && idleHoursActive;

    if (isIdleHoursActive) {
      if (availBudget > 0) {
        this._isDispatching = true;
        const result: TriggerResult = {
          shouldDispatch: true,
          reason: `idle hours: available budget ${(availBudget * 100).toFixed(1)}%`,
          evaluatedAt,
          snapshotSource,
          wastePotential,
          effectiveReserve,
          availableBudget: availBudget,
          isIdleHours: true,
          rateHeadroom,
          perModelWaste,
        };
        this.logDecision(EventName.TRIGGER_FIRED, snapshot, conditions, result, perModelWaste);
        return result;
      }

      const result: TriggerResult = {
        shouldDispatch: false,
        reason: `idle hours but below reserve: available budget ${(availBudget * 100).toFixed(1)}%`,
        evaluatedAt,
        snapshotSource,
        wastePotential,
        effectiveReserve,
        availableBudget: availBudget,
        isIdleHours: true,
        rateHeadroom,
        perModelWaste,
      };
      this.logDecision(EventName.TRIGGER_SKIPPED, snapshot, conditions, result, perModelWaste);
      return result;
    }

    // Step 4: Waste potential path (outside idle hours)
    const wasteThreshold = conditions.maxWastePercentage / 100;
    if (wastePotential > wasteThreshold) {
      this._isDispatching = true;
      const result: TriggerResult = {
        shouldDispatch: true,
        reason: `waste potential ${(wastePotential * 100).toFixed(1)}% exceeds threshold ${conditions.maxWastePercentage}%`,
        evaluatedAt,
        snapshotSource,
        wastePotential,
        effectiveReserve,
        availableBudget: availBudget,
        isIdleHours: false,
        rateHeadroom,
        perModelWaste,
      };
      this.logDecision(EventName.TRIGGER_FIRED, snapshot, conditions, result, perModelWaste);
      return result;
    }

    const result: TriggerResult = {
      shouldDispatch: false,
      reason: `waste potential ${(wastePotential * 100).toFixed(1)}% below threshold ${conditions.maxWastePercentage}%`,
      evaluatedAt,
      snapshotSource,
      wastePotential,
      effectiveReserve,
      availableBudget: availBudget,
      isIdleHours: false,
      rateHeadroom,
      perModelWaste,
    };
    this.logDecision(EventName.TRIGGER_SKIPPED, snapshot, conditions, result, perModelWaste);
    return result;
  }

  resetDispatchState(): void {
    this._isDispatching = false;
  }

  private evaluateRateGate(rateWindows: CapacityWindow[]): { pass: boolean; reason: string } {
    // Empty rateWindows = no active session = gate passes
    if (rateWindows.length === 0) {
      return { pass: true, reason: 'no rate windows active' };
    }

    // Pass if ANY rate window has headroom
    for (const window of rateWindows) {
      if (hasRateHeadroom(window.utilization)) {
        return {
          pass: true,
          reason: `${window.id} utilization ${(window.utilization * 100).toFixed(1)}% has headroom`,
        };
      }
    }

    return {
      pass: false,
      reason: `all rate windows at or above 80% utilization`,
    };
  }

  private calculatePerModelWaste(
    budgetWindows: CapacityWindow[],
    now: Date,
  ): Array<{ model: string; waste: number }> {
    const perModel: Array<{ model: string; waste: number }> = [];
    for (const window of budgetWindows) {
      if (window.model) {
        const timeRemaining = (window.resetsAt.getTime() - now.getTime()) / (1000 * 60 * 60);
        const waste = calculateWastePotential(
          window.utilization,
          timeRemaining,
          window.windowDurationHours,
        );
        perModel.push({ model: window.model, waste });
      }
    }
    return perModel;
  }

  private validateSnapshot(snapshot: CapacitySnapshot): string | null {
    if (!snapshot || typeof snapshot !== 'object') {
      return 'snapshot must be an object';
    }
    if (!Array.isArray(snapshot.budgetWindows)) {
      return 'budgetWindows must be an array';
    }
    if (!Array.isArray(snapshot.rateWindows)) {
      return 'rateWindows must be an array';
    }
    const allWindows = [...snapshot.budgetWindows, ...snapshot.rateWindows];
    if (allWindows.length === 0) {
      return 'snapshot must contain at least one window';
    }
    if (typeof snapshot.provider !== 'string' || snapshot.provider.length === 0) {
      return 'provider must be a non-empty string';
    }
    if (!this.isValidDate(snapshot.fetchedAt)) {
      return 'fetchedAt must be a valid Date';
    }
    if (typeof snapshot.source !== 'string' || snapshot.source.length === 0) {
      return 'source must be a non-empty string';
    }
    if (
      snapshot.confidence !== 'high' &&
      snapshot.confidence !== 'medium' &&
      snapshot.confidence !== 'low'
    ) {
      return 'confidence must be one of high|medium|low';
    }

    for (let index = 0; index < allWindows.length; index += 1) {
      const window = allWindows[index];
      if (!window || typeof window !== 'object') {
        return `window[${index}] must be an object`;
      }
      if (typeof window.id !== 'string' || window.id.length === 0) {
        return `window[${index}].id must be a non-empty string`;
      }
      if (window.kind !== 'budget' && window.kind !== 'rate') {
        return `window[${index}].kind must be one of budget|rate`;
      }
      if (!Number.isFinite(window.utilization)) {
        return `window[${index}].utilization must be a finite number`;
      }
      if (!this.isValidDate(window.resetsAt)) {
        return `window[${index}].resetsAt must be a valid Date`;
      }
      if (!Number.isFinite(window.windowDurationHours) || window.windowDurationHours <= 0) {
        return `window[${index}].windowDurationHours must be a positive finite number`;
      }
    }

    return null;
  }

  private validateConditions(conditions: TriggerCondition): string | null {
    if (!conditions || typeof conditions !== 'object') {
      return 'conditions must be an object';
    }
    if (!Array.isArray(conditions.idleHours)) {
      return 'idleHours must be an array';
    }
    if (
      !Number.isFinite(conditions.maxWastePercentage) ||
      conditions.maxWastePercentage < 0 ||
      conditions.maxWastePercentage > 100
    ) {
      return 'maxWastePercentage must be within 0..100';
    }
    if (
      !Number.isFinite(conditions.weeklyReservePercentage) ||
      conditions.weeklyReservePercentage < 0 ||
      conditions.weeklyReservePercentage > 100
    ) {
      return 'weeklyReservePercentage must be within 0..100';
    }
    return null;
  }

  private logDecision(
    event: string,
    snapshot: CapacitySnapshot,
    conditions: TriggerCondition,
    result: TriggerResult,
    perModelWaste?: Array<{ model: string; waste: number }>,
  ): void {
    const budgetWindows = snapshot?.budgetWindows ?? [];
    const rateWindows = snapshot?.rateWindows ?? [];
    const allWindows = [...budgetWindows, ...rateWindows];
    const data: Record<string, unknown> = {
      shouldDispatch: result.shouldDispatch,
      reason: result.reason,
      evaluatedAt: result.evaluatedAt.toISOString(),
      maxWastePercentage: conditions?.maxWastePercentage ?? null,
      weeklyReservePercentage: conditions?.weeklyReservePercentage ?? null,
      idleHoursCount: conditions?.idleHours?.length ?? 0,
      windowCount: allWindows.length,
      budgetWindowCount: budgetWindows.length,
      rateWindowCount: rateWindows.length,
      isDispatching: this._isDispatching,
      wastePotential: result.wastePotential,
      effectiveReserve: result.effectiveReserve,
      availableBudget: result.availableBudget,
      isIdleHours: result.isIdleHours,
      rateHeadroom: result.rateHeadroom,
      perModelWaste: result.perModelWaste ?? perModelWaste ?? [],
    };

    const meta: AuditMeta = {
      provider: typeof snapshot?.provider === 'string' ? snapshot.provider : null,
      source: typeof snapshot?.source === 'string' ? snapshot.source : null,
      confidence:
        snapshot?.confidence === 'high' ||
        snapshot?.confidence === 'medium' ||
        snapshot?.confidence === 'low'
          ? snapshot.confidence
          : null,
    };

    this.safeLog(event, data, meta);
  }

  private safeLog(event: string, data: Record<string, unknown>, meta: AuditMeta): void {
    try {
      const pending = this.logger.info(event, data, meta);
      if (pending && typeof pending === 'object' && 'catch' in pending) {
        void pending.catch(() => undefined);
      }
    } catch {
      // Logging must never break trigger evaluation.
    }
  }

  private safeWarn(event: string, data: Record<string, unknown>, meta: AuditMeta): void {
    try {
      const pending = this.logger.warn(event, data, meta);
      if (pending && typeof pending === 'object' && 'catch' in pending) {
        void pending.catch(() => undefined);
      }
    } catch {
      // Logging must never break trigger evaluation.
    }
  }

  private warnIfInconsistentSnapshot(snapshot: CapacitySnapshot): void {
    const allWindows = [...(snapshot.budgetWindows ?? []), ...(snapshot.rateWindows ?? [])];
    const meta: AuditMeta = {
      provider: typeof snapshot?.provider === 'string' ? snapshot.provider : null,
      source: typeof snapshot?.source === 'string' ? snapshot.source : null,
      confidence:
        snapshot?.confidence === 'high' ||
        snapshot?.confidence === 'medium' ||
        snapshot?.confidence === 'low'
          ? snapshot.confidence
          : null,
    };

    for (const window of allWindows) {
      if (window.utilization > 1.0) {
        this.safeWarn(
          EventName.TRIGGER_SKIPPED,
          {
            reason: 'inconsistent snapshot: utilization > 1.0',
            windowId: window.id,
            utilization: window.utilization,
          },
          meta,
        );
      }
    }
  }

  private resolveSnapshotSource(snapshot: CapacitySnapshot): string {
    if (!snapshot || typeof snapshot !== 'object') return 'unknown';
    return typeof snapshot.source === 'string' && snapshot.source.length > 0
      ? snapshot.source
      : 'unknown';
  }

  private isValidDate(value: unknown): value is Date {
    return value instanceof Date && !Number.isNaN(value.getTime());
  }
}

/** Safe isIdleTime wrapper for logging — never throws. */
function isIdleTimeSafe(idleHours: TriggerCondition['idleHours'], now: Date): boolean {
  try {
    return isIdleTime(idleHours, now);
  } catch {
    return false;
  }
}
