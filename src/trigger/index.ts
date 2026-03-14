/** Trigger module barrel exports for engine and capacity intelligence primitives. */
export { TriggerEngine } from './trigger-engine.js';
export {
  calculateWastePotential,
  calculateEffectiveReserve,
  calculateAvailableBudget,
  hasRateHeadroom,
  calculateAggregateUtilization,
} from './capacity-math.js';
export { isIdleTime, parseTimeToMinutes, isInTimeRange } from './idle-hours.js';
