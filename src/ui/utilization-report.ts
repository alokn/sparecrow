/** UtilizationReport UI component — renders compact or detailed subscription ROI summaries. */
import { getRenderContext } from './render-context.js';
import { color } from './colors.js';

/** Breakdown entry per task type for the detailed variant. */
export interface UtilizationBreakdownRow {
  /** Task type or template name. */
  taskType: string;
  /** Number of tasks of this type. */
  count: number;
  /** Dollar value recovered for this task type. */
  dollarValue: number;
}

/** Props for compact variant. */
interface UtilizationReportCompactProps {
  variant: 'compact';
  /** Dollar value recovered this week. null/NaN/negative = insufficient data. */
  dollarValueRecovered: number | null;
  /** Utilization percentage as a 0–1 fraction. null/NaN/out-of-range = insufficient data. */
  utilizationPercent: number | null;
}

/** Props for detailed variant. */
interface UtilizationReportDetailedProps {
  variant: 'detailed';
  /** Dollar value recovered this week. null/NaN/negative = insufficient data. */
  dollarValueRecovered: number | null;
  /** Utilization percentage as a 0–1 fraction. null/NaN/out-of-range = insufficient data. */
  utilizationPercent: number | null;
  /** Utilization before this period's dispatches (0–1 fraction). */
  beforeUtilization: number | null;
  /** Utilization after this period's dispatches (0–1 fraction). */
  afterUtilization: number | null;
  /** Total number of tasks dispatched. */
  taskCount: number | null;
  /** Per-task-type breakdown rows. Stable order preserved as-supplied. */
  breakdown: UtilizationBreakdownRow[] | null;
}

/** Props union for renderUtilizationReport. */
export type UtilizationReportProps = UtilizationReportCompactProps | UtilizationReportDetailedProps;

/** The exact deterministic fallback string emitted when data is insufficient (AC6). */
export const INSUFFICIENT_DATA_MESSAGE =
  'Insufficient data to calculate utilization and recovered value yet.';

/** Validates that a value is a finite, non-negative number. */
function isValidNonNegative(v: number | null | undefined): v is number {
  return v !== null && v !== undefined && Number.isFinite(v) && v >= 0;
}

/** Validates that a percent value is a finite number in [0, 1]. */
function isValidPercent(v: number | null | undefined): v is number {
  return v !== null && v !== undefined && Number.isFinite(v) && v >= 0 && v <= 1;
}

/** Formats a dollar value to two decimal places with $ prefix. */
function formatDollar(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** Formats a utilization fraction (0–1) as a rounded percentage string. */
function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * Renders a utilization report string — compact or detailed.
 * Returns the exact INSUFFICIENT_DATA_MESSAGE when inputs are invalid or incomplete.
 * Pure function; never writes to stdout.
 */
export function renderUtilizationReport(props: UtilizationReportProps): string {
  const ctx = getRenderContext();

  if (props.variant === 'compact') {
    if (
      !isValidNonNegative(props.dollarValueRecovered) ||
      !isValidPercent(props.utilizationPercent)
    ) {
      return INSUFFICIENT_DATA_MESSAGE;
    }
    const dollars = formatDollar(props.dollarValueRecovered);
    const pct = formatPercent(props.utilizationPercent);

    if (ctx.noColor) {
      return `Recovered: ${dollars} this week (${pct} utilization)`;
    }
    return `Recovered: ${color.green(dollars)} this week (${color.cyan(pct)} utilization)`;
  }

  // Detailed variant
  if (
    !isValidNonNegative(props.dollarValueRecovered) ||
    !isValidPercent(props.utilizationPercent)
  ) {
    return INSUFFICIENT_DATA_MESSAGE;
  }

  const dollars = formatDollar(props.dollarValueRecovered);
  const pct = formatPercent(props.utilizationPercent);

  const lines: string[] = [];

  // Header
  const headerText = ctx.noColor ? `Utilization Report` : color.boldWhite('Utilization Report');
  lines.push(headerText);

  // Current utilization
  lines.push(`  Utilization:   ${ctx.noColor ? pct : color.cyan(pct)}`);

  // Before/After utilization
  if (isValidPercent(props.beforeUtilization)) {
    lines.push(`  Before:        ${formatPercent(props.beforeUtilization)}`);
  }
  if (isValidPercent(props.afterUtilization)) {
    lines.push(`  After:         ${formatPercent(props.afterUtilization)}`);
  }

  // Delta (after - before)
  if (isValidPercent(props.beforeUtilization) && isValidPercent(props.afterUtilization)) {
    const delta = props.afterUtilization - props.beforeUtilization;
    const deltaStr = `${delta >= 0 ? '+' : ''}${Math.round(delta * 100)}%`;
    lines.push(`  Delta:         ${deltaStr}`);
  }

  // Recovered
  lines.push(`  Recovered:     ${ctx.noColor ? dollars : color.green(dollars)} this week`);

  // Task count — must be a finite, non-negative integer to render sensibly
  if (
    props.taskCount !== null &&
    Number.isFinite(props.taskCount) &&
    Number.isInteger(props.taskCount) &&
    props.taskCount >= 0
  ) {
    lines.push(`  Tasks:         ${props.taskCount}`);
  }

  // Per-task-type breakdown
  if (props.breakdown !== null && props.breakdown !== undefined && props.breakdown.length > 0) {
    lines.push(`  Breakdown:`);
    for (const row of props.breakdown) {
      const rowDollars = isValidNonNegative(row.dollarValue)
        ? formatDollar(row.dollarValue)
        : 'N/A';
      // Validate count: must be a finite, non-negative integer to avoid "NaN tasks" or "3.7 tasks"
      const countIsValid =
        Number.isFinite(row.count) && Number.isInteger(row.count) && row.count >= 0;
      const countStr = countIsValid ? String(row.count) : 'N/A';
      lines.push(`    ${row.taskType}: ${countStr} tasks, ${rowDollars}`);
    }
  }

  return lines.join('\n');
}
