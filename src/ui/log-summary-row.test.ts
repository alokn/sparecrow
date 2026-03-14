/** Tests for renderLogSummaryRow — all outcomes, variants, and render paths. */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import chalk from 'chalk';
import { setRenderContext, resetRenderContext } from './render-context.js';
import { renderLogSummaryRow } from './log-summary-row.js';
import type { LogSummaryRowProps } from './log-summary-row.js';

// Force chalk to emit ANSI codes in the test environment (chalk auto-disables in non-TTY).
let previousChalkLevel: typeof chalk.level;
beforeAll(() => {
  previousChalkLevel = chalk.level;
  chalk.level = 3;
});
afterAll(() => {
  chalk.level = previousChalkLevel;
});

// Helper to build a default props object with the given overrides.
function makeProps(overrides: Partial<LogSummaryRowProps> = {}): LogSummaryRowProps {
  return {
    outcome: 'success',
    taskName: 'security-audit',
    relativeTime: '10m ago',
    duration: '45s',
    targetPath: '/home/user/repo',
    variant: 'summary',
    ...overrides,
  };
}

// ANSI regex for stripping escape codes from output.
// eslint-disable-next-line no-control-regex
const ANSI_STRIP_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;

// Non-global ANSI regex for testing presence of escape codes.
// eslint-disable-next-line no-control-regex
const ANSI_TEST_RE = /\x1B\[[0-?]*[ -/]*[@-~]/;

function stripAnsi(s: string): string {
  return s.replace(ANSI_STRIP_RE, '');
}

function hasAnsi(s: string): boolean {
  return ANSI_TEST_RE.test(s);
}

describe('renderLogSummaryRow', () => {
  afterEach(() => {
    resetRenderContext();
  });

  // ---- outcome marker mapping ----

  describe('color + unicode mode', () => {
    beforeEach(() => {
      setRenderContext({ noColor: false, useUnicode: true, isTTY: true, width: 80 });
    });

    it('renders ✓ marker for success outcome and emits ANSI codes', () => {
      const result = renderLogSummaryRow(makeProps({ outcome: 'success' }));
      expect(result).toContain('✓');
      // In color mode, ANSI escape codes must be present (chalk wraps the marker in color).
      expect(hasAnsi(result)).toBe(true);
    });

    it('renders ✗ marker for failed outcome and emits ANSI codes', () => {
      const result = renderLogSummaryRow(makeProps({ outcome: 'failed' }));
      expect(result).toContain('✗');
      expect(hasAnsi(result)).toBe(true);
    });

    it('renders ✗ marker for retrying outcome and emits ANSI codes', () => {
      const result = renderLogSummaryRow(makeProps({ outcome: 'retrying' }));
      expect(result).toContain('✗');
      expect(hasAnsi(result)).toBe(true);
    });

    it('renders task name, relative time, duration, and target path in summary variant', () => {
      const result = renderLogSummaryRow(makeProps());
      const plain = stripAnsi(result);
      expect(plain).toContain('security-audit');
      expect(plain).toContain('10m ago');
      expect(plain).toContain('45s');
      expect(plain).toContain('/home/user/repo');
    });
  });

  describe('color + ascii mode', () => {
    beforeEach(() => {
      setRenderContext({ noColor: false, useUnicode: false, isTTY: true, width: 80 });
    });

    it('renders [PASS] styled label for success outcome and emits ANSI codes', () => {
      const result = renderLogSummaryRow(makeProps({ outcome: 'success' }));
      const plain = stripAnsi(result);
      expect(plain).toContain('[PASS]');
      // In color+ascii mode, ANSI escape codes must be present (chalk wraps labels in color).
      expect(hasAnsi(result)).toBe(true);
    });

    it('renders [FAIL] styled label for failed outcome and emits ANSI codes', () => {
      const result = renderLogSummaryRow(makeProps({ outcome: 'failed' }));
      const plain = stripAnsi(result);
      expect(plain).toContain('[FAIL]');
      expect(hasAnsi(result)).toBe(true);
    });

    it('renders [RETRY] styled label for retrying outcome and emits ANSI codes', () => {
      const result = renderLogSummaryRow(makeProps({ outcome: 'retrying' }));
      const plain = stripAnsi(result);
      expect(plain).toContain('[RETRY]');
      expect(hasAnsi(result)).toBe(true);
    });

    it('renders [PASS] label in ascii mode without unicode glyph', () => {
      const result = renderLogSummaryRow(makeProps({ outcome: 'success' }));
      // In color+ascii mode the component uses styled text labels — [PASS] must be present.
      expect(result).toContain('[PASS]');
      // The unicode glyph must NOT be used in ascii mode.
      expect(result).not.toContain('✓');
    });
  });

  describe('noColor + unicode mode (AC4)', () => {
    beforeEach(() => {
      // This is the key AC4 scenario: noColor=true but unicode-capable locale.
      // The component MUST render [PASS]/[FAIL] labels, NOT ✓/✗ glyphs.
      setRenderContext({ noColor: true, useUnicode: true, isTTY: true, width: 80 });
    });

    it('renders [PASS] for success outcome even when unicode is available', () => {
      const result = renderLogSummaryRow(makeProps({ outcome: 'success' }));
      expect(result).toContain('[PASS]');
      expect(result).not.toContain('✓');
    });

    it('renders [FAIL] for failed outcome even when unicode is available', () => {
      const result = renderLogSummaryRow(makeProps({ outcome: 'failed' }));
      expect(result).toContain('[FAIL]');
      expect(result).not.toContain('✗');
    });

    it('renders [RETRY] for retrying outcome even when unicode is available', () => {
      const result = renderLogSummaryRow(makeProps({ outcome: 'retrying' }));
      expect(result).toContain('[RETRY]');
    });

    it('produces no ANSI escape codes', () => {
      const result = renderLogSummaryRow(makeProps({ outcome: 'success' }));
      expect(hasAnsi(result)).toBe(false);
    });
  });

  describe('noColor + ascii mode', () => {
    beforeEach(() => {
      setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
    });

    it('renders [PASS] for success outcome', () => {
      const result = renderLogSummaryRow(makeProps({ outcome: 'success' }));
      expect(result).toContain('[PASS]');
    });

    it('renders [FAIL] for failed outcome', () => {
      const result = renderLogSummaryRow(makeProps({ outcome: 'failed' }));
      expect(result).toContain('[FAIL]');
    });

    it('produces no ANSI escape codes', () => {
      const result = renderLogSummaryRow(makeProps({ outcome: 'success' }));
      expect(hasAnsi(result)).toBe(false);
    });

    it('preserves full information content: task name, time, duration, target', () => {
      const result = renderLogSummaryRow(makeProps());
      expect(result).toContain('security-audit');
      expect(result).toContain('10m ago');
      expect(result).toContain('45s');
      expect(result).toContain('/home/user/repo');
    });
  });

  // ---- variant behavior ----

  describe('summary variant', () => {
    beforeEach(() => {
      setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
    });

    it('includes duration and targetPath on first line', () => {
      const result = renderLogSummaryRow(makeProps({ variant: 'summary' }));
      expect(result).toContain('45s');
      expect(result).toContain('/home/user/repo');
    });

    it('renders optional second line with summary for success', () => {
      const result = renderLogSummaryRow(
        makeProps({ outcome: 'success', summary: 'All checks passed', variant: 'summary' }),
      );
      const lines = result.split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('All checks passed');
      expect(lines[1]).toMatch(/^\s{2}/); // indented
    });

    it('renders optional second line with failureReason for failed', () => {
      const result = renderLogSummaryRow(
        makeProps({
          outcome: 'failed',
          failureReason: 'Coverage below threshold',
          variant: 'summary',
        }),
      );
      const lines = result.split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('Coverage below threshold');
    });

    it('renders (queued for retry) second line for retrying when no failureReason', () => {
      const result = renderLogSummaryRow(makeProps({ outcome: 'retrying', variant: 'summary' }));
      const lines = result.split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('(queued for retry)');
    });

    it('renders failureReason second line for retrying when failureReason is present', () => {
      const result = renderLogSummaryRow(
        makeProps({
          outcome: 'retrying',
          failureReason: 'Transient error, will retry',
          variant: 'summary',
        }),
      );
      const lines = result.split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('Transient error, will retry');
    });

    it('renders single line for success with no summary prop', () => {
      const result = renderLogSummaryRow(makeProps({ outcome: 'success', variant: 'summary' }));
      expect(result.split('\n')).toHaveLength(1);
    });

    it('renders single line when summary is the default dash placeholder', () => {
      const result = renderLogSummaryRow(
        makeProps({ outcome: 'success', summary: '-', variant: 'summary' }),
      );
      expect(result.split('\n')).toHaveLength(1);
    });

    it('renders single line for failed with no failureReason prop', () => {
      const result = renderLogSummaryRow(makeProps({ outcome: 'failed', variant: 'summary' }));
      expect(result.split('\n')).toHaveLength(1);
    });
  });

  describe('compact variant', () => {
    beforeEach(() => {
      setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
    });

    it('renders only outcome, task name, and relative time', () => {
      const result = renderLogSummaryRow(makeProps({ variant: 'compact' }));
      expect(result).toContain('security-audit');
      expect(result).toContain('10m ago');
    });

    it('does not include duration in compact variant', () => {
      const result = renderLogSummaryRow(makeProps({ variant: 'compact' }));
      expect(result).not.toContain('45s');
    });

    it('does not include targetPath in compact variant', () => {
      const result = renderLogSummaryRow(makeProps({ variant: 'compact' }));
      expect(result).not.toContain('/home/user/repo');
    });

    it('renders a single line regardless of summary prop', () => {
      const result = renderLogSummaryRow(
        makeProps({ variant: 'compact', summary: 'Some findings' }),
      );
      expect(result.split('\n')).toHaveLength(1);
    });
  });

  // ---- edge cases ----

  describe('edge cases', () => {
    beforeEach(() => {
      setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
    });

    it('handles missing duration gracefully with dash placeholder', () => {
      const result = renderLogSummaryRow(makeProps({ duration: '-' }));
      expect(result).toContain('-');
    });

    it('handles missing targetPath gracefully with dash placeholder', () => {
      const result = renderLogSummaryRow(makeProps({ targetPath: '-' }));
      expect(result).toContain('-');
    });

    it('handles empty taskName without throwing', () => {
      const result = renderLogSummaryRow(makeProps({ taskName: '' }));
      expect(typeof result).toBe('string');
    });
  });
});
