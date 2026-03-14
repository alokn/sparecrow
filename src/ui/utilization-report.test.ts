/** Tests for renderUtilizationReport — compact, detailed, and insufficient-data scenarios. */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import chalk from 'chalk';
import { setRenderContext, resetRenderContext } from './render-context.js';
import { renderUtilizationReport, INSUFFICIENT_DATA_MESSAGE } from './utilization-report.js';
import type { UtilizationReportProps } from './utilization-report.js';
import { stripAnsi } from './ansi-utils.js';

// Force chalk to emit ANSI codes in the test environment.
let previousChalkLevel: typeof chalk.level;
beforeAll(() => {
  previousChalkLevel = chalk.level;
  chalk.level = 3;
});
afterAll(() => {
  chalk.level = previousChalkLevel;
});

function makeCompactProps(
  overrides: Partial<{
    dollarValueRecovered: number | null;
    utilizationPercent: number | null;
  }> = {},
): UtilizationReportProps {
  return {
    variant: 'compact',
    dollarValueRecovered: 25.0,
    utilizationPercent: 0.62,
    ...overrides,
  };
}

describe('renderUtilizationReport', () => {
  afterEach(() => {
    resetRenderContext();
  });

  // ── Compact variant (AC4) ─────────────────────────────────────────────────

  describe('compact variant (AC4)', () => {
    beforeEach(() => {
      setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
    });

    it('returns exactly one line for compact variant', () => {
      const result = renderUtilizationReport(makeCompactProps());
      expect(result.split('\n')).toHaveLength(1);
    });

    it('matches exact format: "Recovered: $XX this week (XX% utilization)"', () => {
      const result = renderUtilizationReport(
        makeCompactProps({ dollarValueRecovered: 25.0, utilizationPercent: 0.62 }),
      );
      expect(result).toBe('Recovered: $25.00 this week (62% utilization)');
    });

    it('rounds utilization percentage deterministically', () => {
      const result = renderUtilizationReport(
        makeCompactProps({ dollarValueRecovered: 10.0, utilizationPercent: 0.455 }),
      );
      expect(result).toContain('46% utilization');
    });

    it('formats dollar value to 2 decimal places', () => {
      const result = renderUtilizationReport(
        makeCompactProps({ dollarValueRecovered: 7.5, utilizationPercent: 0.5 }),
      );
      expect(result).toContain('$7.50');
    });

    it('formats zero dollar value as $0.00', () => {
      const result = renderUtilizationReport(
        makeCompactProps({ dollarValueRecovered: 0, utilizationPercent: 0.1 }),
      );
      expect(result).toContain('$0.00');
    });

    it('formats zero utilization as 0%', () => {
      const result = renderUtilizationReport(
        makeCompactProps({ dollarValueRecovered: 5.0, utilizationPercent: 0 }),
      );
      expect(result).toContain('(0% utilization)');
    });
  });

  describe('compact variant color + unicode mode', () => {
    beforeEach(() => {
      setRenderContext({ noColor: false, useUnicode: true, isTTY: true, width: 80 });
    });

    it('emits ANSI codes in color mode', () => {
      const result = renderUtilizationReport(
        makeCompactProps({ dollarValueRecovered: 10.0, utilizationPercent: 0.5 }),
      );
      // eslint-disable-next-line no-control-regex
      expect(/\x1B\[[0-9;]*m/.test(result)).toBe(true);
    });

    it('plain text content matches expected format ignoring ANSI', () => {
      const result = renderUtilizationReport(
        makeCompactProps({ dollarValueRecovered: 10.0, utilizationPercent: 0.5 }),
      );
      const plain = stripAnsi(result);
      expect(plain).toBe('Recovered: $10.00 this week (50% utilization)');
    });
  });

  describe('compact variant noColor mode', () => {
    beforeEach(() => {
      setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
    });

    it('produces no ANSI codes in noColor mode', () => {
      const result = renderUtilizationReport(
        makeCompactProps({ dollarValueRecovered: 20.0, utilizationPercent: 0.8 }),
      );
      // eslint-disable-next-line no-control-regex
      expect(/\x1B\[[0-9;]*m/.test(result)).toBe(false);
    });

    it('output matches stripAnsi(output) in noColor mode', () => {
      const result = renderUtilizationReport(
        makeCompactProps({ dollarValueRecovered: 15.0, utilizationPercent: 0.75 }),
      );
      expect(result).toBe(stripAnsi(result));
    });
  });

  // ── Insufficient-data fallback (AC6) ─────────────────────────────────────

  describe('insufficient-data fallback (AC6) — compact variant', () => {
    beforeEach(() => {
      setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
    });

    it('returns exact fallback string when dollarValueRecovered is null', () => {
      const result = renderUtilizationReport(
        makeCompactProps({ dollarValueRecovered: null, utilizationPercent: 0.5 }),
      );
      expect(result).toBe(INSUFFICIENT_DATA_MESSAGE);
    });

    it('returns exact fallback string when utilizationPercent is null', () => {
      const result = renderUtilizationReport(
        makeCompactProps({ dollarValueRecovered: 10.0, utilizationPercent: null }),
      );
      expect(result).toBe(INSUFFICIENT_DATA_MESSAGE);
    });

    it('returns fallback string when dollarValueRecovered is NaN', () => {
      const result = renderUtilizationReport(
        makeCompactProps({ dollarValueRecovered: NaN, utilizationPercent: 0.5 }),
      );
      expect(result).toBe(INSUFFICIENT_DATA_MESSAGE);
    });

    it('returns fallback string when utilizationPercent is NaN', () => {
      const result = renderUtilizationReport(
        makeCompactProps({ dollarValueRecovered: 10.0, utilizationPercent: NaN }),
      );
      expect(result).toBe(INSUFFICIENT_DATA_MESSAGE);
    });

    it('returns fallback string when dollarValueRecovered is negative', () => {
      const result = renderUtilizationReport(
        makeCompactProps({ dollarValueRecovered: -5.0, utilizationPercent: 0.5 }),
      );
      expect(result).toBe(INSUFFICIENT_DATA_MESSAGE);
    });

    it('returns fallback string when utilizationPercent is negative', () => {
      const result = renderUtilizationReport(
        makeCompactProps({ dollarValueRecovered: 10.0, utilizationPercent: -0.1 }),
      );
      expect(result).toBe(INSUFFICIENT_DATA_MESSAGE);
    });

    it('returns fallback string when utilizationPercent exceeds 1 (out-of-range)', () => {
      const result = renderUtilizationReport(
        makeCompactProps({ dollarValueRecovered: 10.0, utilizationPercent: 1.5 }),
      );
      expect(result).toBe(INSUFFICIENT_DATA_MESSAGE);
    });

    it('does not fabricate a dollar amount in fallback output', () => {
      const result = renderUtilizationReport(
        makeCompactProps({ dollarValueRecovered: null, utilizationPercent: null }),
      );
      expect(result).not.toContain('$');
      expect(result).not.toContain('this week');
    });
  });

  // ── Detailed variant (AC5) ────────────────────────────────────────────────

  describe('detailed variant (AC5)', () => {
    beforeEach(() => {
      setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
    });

    it('returns multi-line output for detailed variant', () => {
      const result = renderUtilizationReport({
        variant: 'detailed',
        dollarValueRecovered: 30.0,
        utilizationPercent: 0.72,
        beforeUtilization: 0.5,
        afterUtilization: 0.72,
        taskCount: 10,
        breakdown: null,
      });
      expect(result.split('\n').length).toBeGreaterThan(1);
    });

    it('includes Utilization Report header', () => {
      const result = renderUtilizationReport({
        variant: 'detailed',
        dollarValueRecovered: 30.0,
        utilizationPercent: 0.72,
        beforeUtilization: 0.5,
        afterUtilization: 0.72,
        taskCount: 10,
        breakdown: null,
      });
      expect(result).toContain('Utilization Report');
    });

    it('includes utilization percentage', () => {
      const result = renderUtilizationReport({
        variant: 'detailed',
        dollarValueRecovered: 30.0,
        utilizationPercent: 0.72,
        beforeUtilization: null,
        afterUtilization: null,
        taskCount: null,
        breakdown: null,
      });
      expect(result).toContain('72%');
    });

    it('includes recovered dollar value', () => {
      const result = renderUtilizationReport({
        variant: 'detailed',
        dollarValueRecovered: 30.0,
        utilizationPercent: 0.72,
        beforeUtilization: null,
        afterUtilization: null,
        taskCount: null,
        breakdown: null,
      });
      expect(result).toContain('$30.00');
      expect(result).toContain('this week');
    });

    it('includes before and after utilization when provided', () => {
      const result = renderUtilizationReport({
        variant: 'detailed',
        dollarValueRecovered: 30.0,
        utilizationPercent: 0.72,
        beforeUtilization: 0.5,
        afterUtilization: 0.72,
        taskCount: null,
        breakdown: null,
      });
      expect(result).toContain('50%');
      expect(result).toContain('72%');
    });

    it('includes delta when before and after are both provided', () => {
      const result = renderUtilizationReport({
        variant: 'detailed',
        dollarValueRecovered: 30.0,
        utilizationPercent: 0.72,
        beforeUtilization: 0.5,
        afterUtilization: 0.72,
        taskCount: null,
        breakdown: null,
      });
      expect(result).toContain('Delta:');
      expect(result).toContain('+22%');
    });

    it('includes task count when provided', () => {
      const result = renderUtilizationReport({
        variant: 'detailed',
        dollarValueRecovered: 30.0,
        utilizationPercent: 0.72,
        beforeUtilization: null,
        afterUtilization: null,
        taskCount: 8,
        breakdown: null,
      });
      expect(result).toContain('Tasks:');
      expect(result).toContain('8');
    });

    it('includes breakdown rows when provided', () => {
      const result = renderUtilizationReport({
        variant: 'detailed',
        dollarValueRecovered: 30.0,
        utilizationPercent: 0.72,
        beforeUtilization: null,
        afterUtilization: null,
        taskCount: 4,
        breakdown: [
          { taskType: 'security-audit', count: 2, dollarValue: 20.0 },
          { taskType: 'improve-code', count: 2, dollarValue: 10.0 },
        ],
      });
      expect(result).toContain('Breakdown:');
      expect(result).toContain('security-audit');
      expect(result).toContain('improve-code');
      expect(result).toContain('$20.00');
      expect(result).toContain('$10.00');
    });

    it('preserves breakdown row order as-supplied', () => {
      const result = renderUtilizationReport({
        variant: 'detailed',
        dollarValueRecovered: 30.0,
        utilizationPercent: 0.72,
        beforeUtilization: null,
        afterUtilization: null,
        taskCount: 4,
        breakdown: [
          { taskType: 'alpha', count: 1, dollarValue: 5.0 },
          { taskType: 'beta', count: 3, dollarValue: 25.0 },
        ],
      });
      const alphaIdx = result.indexOf('alpha');
      const betaIdx = result.indexOf('beta');
      expect(alphaIdx).toBeLessThan(betaIdx);
    });
  });

  describe('insufficient-data fallback (AC6) — detailed variant', () => {
    beforeEach(() => {
      setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
    });

    it('returns exact fallback string when dollarValueRecovered is null', () => {
      const result = renderUtilizationReport({
        variant: 'detailed',
        dollarValueRecovered: null,
        utilizationPercent: 0.5,
        beforeUtilization: null,
        afterUtilization: null,
        taskCount: null,
        breakdown: null,
      });
      expect(result).toBe(INSUFFICIENT_DATA_MESSAGE);
    });

    it('returns exact fallback string when utilizationPercent is null', () => {
      const result = renderUtilizationReport({
        variant: 'detailed',
        dollarValueRecovered: 10.0,
        utilizationPercent: null,
        beforeUtilization: null,
        afterUtilization: null,
        taskCount: null,
        breakdown: null,
      });
      expect(result).toBe(INSUFFICIENT_DATA_MESSAGE);
    });

    it('returns fallback when dollarValueRecovered is negative', () => {
      const result = renderUtilizationReport({
        variant: 'detailed',
        dollarValueRecovered: -1.0,
        utilizationPercent: 0.5,
        beforeUtilization: null,
        afterUtilization: null,
        taskCount: null,
        breakdown: null,
      });
      expect(result).toBe(INSUFFICIENT_DATA_MESSAGE);
    });
  });

  // ── Infinity edge cases (AC6, AC10) ─────────────────────────────────────
  // These verify that isValidNonNegative/isValidPercent correctly reject Infinity
  // via Number.isFinite, producing the AC6 fallback rather than nonsensical output.

  describe('Infinity inputs — compact variant (AC6)', () => {
    beforeEach(() => {
      setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
    });

    it('returns fallback when dollarValueRecovered is Infinity', () => {
      const result = renderUtilizationReport(
        makeCompactProps({ dollarValueRecovered: Infinity, utilizationPercent: 0.5 }),
      );
      expect(result).toBe(INSUFFICIENT_DATA_MESSAGE);
    });

    it('returns fallback when utilizationPercent is Infinity', () => {
      const result = renderUtilizationReport(
        makeCompactProps({ dollarValueRecovered: 10.0, utilizationPercent: Infinity }),
      );
      expect(result).toBe(INSUFFICIENT_DATA_MESSAGE);
    });

    it('returns fallback when dollarValueRecovered is -Infinity', () => {
      const result = renderUtilizationReport(
        makeCompactProps({ dollarValueRecovered: -Infinity, utilizationPercent: 0.5 }),
      );
      expect(result).toBe(INSUFFICIENT_DATA_MESSAGE);
    });
  });

  describe('Infinity inputs — detailed variant (AC6)', () => {
    beforeEach(() => {
      setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
    });

    it('returns fallback when dollarValueRecovered is Infinity in detailed variant', () => {
      const result = renderUtilizationReport({
        variant: 'detailed',
        dollarValueRecovered: Infinity,
        utilizationPercent: 0.5,
        beforeUtilization: null,
        afterUtilization: null,
        taskCount: null,
        breakdown: null,
      });
      expect(result).toBe(INSUFFICIENT_DATA_MESSAGE);
    });

    it('returns fallback when utilizationPercent is Infinity in detailed variant', () => {
      const result = renderUtilizationReport({
        variant: 'detailed',
        dollarValueRecovered: 10.0,
        utilizationPercent: Infinity,
        beforeUtilization: null,
        afterUtilization: null,
        taskCount: null,
        breakdown: null,
      });
      expect(result).toBe(INSUFFICIENT_DATA_MESSAGE);
    });
  });

  // ── taskCount edge cases in detailed variant (AC10) ───────────────────────
  // Verifies integer guard: NaN, negative, and Infinity taskCount values are
  // silently omitted from output rather than rendered as nonsensical text.

  describe('taskCount edge cases — detailed variant (AC10)', () => {
    beforeEach(() => {
      setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
    });

    it('omits Tasks row when taskCount is NaN', () => {
      const result = renderUtilizationReport({
        variant: 'detailed',
        dollarValueRecovered: 10.0,
        utilizationPercent: 0.5,
        beforeUtilization: null,
        afterUtilization: null,
        taskCount: NaN,
        breakdown: null,
      });
      expect(result).not.toContain('Tasks:');
    });

    it('omits Tasks row when taskCount is negative', () => {
      const result = renderUtilizationReport({
        variant: 'detailed',
        dollarValueRecovered: 10.0,
        utilizationPercent: 0.5,
        beforeUtilization: null,
        afterUtilization: null,
        taskCount: -1,
        breakdown: null,
      });
      expect(result).not.toContain('Tasks:');
    });

    it('omits Tasks row when taskCount is Infinity', () => {
      const result = renderUtilizationReport({
        variant: 'detailed',
        dollarValueRecovered: 10.0,
        utilizationPercent: 0.5,
        beforeUtilization: null,
        afterUtilization: null,
        taskCount: Infinity,
        breakdown: null,
      });
      expect(result).not.toContain('Tasks:');
    });

    it('omits Tasks row when taskCount is a non-integer (fractional value)', () => {
      const result = renderUtilizationReport({
        variant: 'detailed',
        dollarValueRecovered: 10.0,
        utilizationPercent: 0.5,
        beforeUtilization: null,
        afterUtilization: null,
        taskCount: 2.5,
        breakdown: null,
      });
      expect(result).not.toContain('Tasks:');
    });

    it('renders Tasks row correctly when taskCount is a valid non-negative integer', () => {
      const result = renderUtilizationReport({
        variant: 'detailed',
        dollarValueRecovered: 10.0,
        utilizationPercent: 0.5,
        beforeUtilization: null,
        afterUtilization: null,
        taskCount: 5,
        breakdown: null,
      });
      expect(result).toContain('Tasks:');
      expect(result).toContain('5');
    });
  });

  // ── UtilizationBreakdownRow.count edge cases (AC10) ───────────────────────
  // Verifies that invalid count values in breakdown rows render as "N/A tasks"
  // rather than "NaN tasks", "3.7 tasks", or "-1 tasks".

  describe('breakdown row count edge cases (AC10)', () => {
    beforeEach(() => {
      setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
    });

    it('renders N/A for breakdown row count when NaN', () => {
      const result = renderUtilizationReport({
        variant: 'detailed',
        dollarValueRecovered: 10.0,
        utilizationPercent: 0.5,
        beforeUtilization: null,
        afterUtilization: null,
        taskCount: null,
        breakdown: [{ taskType: 'improve-code', count: NaN, dollarValue: 5.0 }],
      });
      expect(result).toContain('N/A tasks');
      expect(result).not.toContain('NaN tasks');
    });

    it('renders N/A for breakdown row count when negative', () => {
      const result = renderUtilizationReport({
        variant: 'detailed',
        dollarValueRecovered: 10.0,
        utilizationPercent: 0.5,
        beforeUtilization: null,
        afterUtilization: null,
        taskCount: null,
        breakdown: [{ taskType: 'improve-code', count: -1, dollarValue: 5.0 }],
      });
      expect(result).toContain('N/A tasks');
    });

    it('renders N/A for breakdown row count when Infinity', () => {
      const result = renderUtilizationReport({
        variant: 'detailed',
        dollarValueRecovered: 10.0,
        utilizationPercent: 0.5,
        beforeUtilization: null,
        afterUtilization: null,
        taskCount: null,
        breakdown: [{ taskType: 'improve-code', count: Infinity, dollarValue: 5.0 }],
      });
      expect(result).toContain('N/A tasks');
    });

    it('renders N/A for breakdown row count when fractional', () => {
      const result = renderUtilizationReport({
        variant: 'detailed',
        dollarValueRecovered: 10.0,
        utilizationPercent: 0.5,
        beforeUtilization: null,
        afterUtilization: null,
        taskCount: null,
        breakdown: [{ taskType: 'improve-code', count: 3.7, dollarValue: 5.0 }],
      });
      expect(result).toContain('N/A tasks');
      expect(result).not.toContain('3.7 tasks');
    });
  });

  describe('INSUFFICIENT_DATA_MESSAGE constant', () => {
    it('is the exact expected string', () => {
      expect(INSUFFICIENT_DATA_MESSAGE).toBe(
        'Insufficient data to calculate utilization and recovered value yet.',
      );
    });
  });
});
