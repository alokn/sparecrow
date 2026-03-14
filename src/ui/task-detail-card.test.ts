/** Tests for renderTaskDetailCard — all outcomes, render contexts, and edge cases. */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import chalk from 'chalk';
import { setRenderContext, resetRenderContext } from './render-context.js';
import { renderTaskDetailCard, formatDuration } from './task-detail-card.js';
import type { TaskDetailCardProps } from './task-detail-card.js';
import { stripAnsi } from './ansi-utils.js';

// Force chalk to emit ANSI codes in the test environment (chalk auto-disables in non-TTY).
let previousChalkLevel: typeof chalk.level;
beforeAll(() => {
  previousChalkLevel = chalk.level;
  chalk.level = 3;
});
afterAll(() => {
  chalk.level = previousChalkLevel;
});

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-9;]*m/g;

function hasAnsi(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /\x1B\[[0-9;]*m/.test(s);
}

function makeProps(overrides: Partial<TaskDetailCardProps> = {}): TaskDetailCardProps {
  return {
    timestamp: '2026-02-25T10:30:00.000Z',
    outcome: 'success',
    taskName: 'security-audit',
    taskId: 'abc-123',
    targetPath: '/home/user/repo',
    durationMs: 45000,
    exitCode: 0,
    tokensIn: 1000,
    tokensOut: 500,
    provider: 'claude-code',
    source: 'executor',
    error: null,
    summary: 'Found 2 issues',
    width: 80,
    ...overrides,
  };
}

describe('renderTaskDetailCard', () => {
  afterEach(() => {
    resetRenderContext();
  });

  // ── Render context matrix ────────────────────────────────────────────────

  describe('color + unicode mode', () => {
    beforeEach(() => {
      setRenderContext({ noColor: false, useUnicode: true, isTTY: true, width: 80 });
    });

    it('renders unicode box-drawing characters in top border', () => {
      const result = renderTaskDetailCard(makeProps());
      const firstLine = stripAnsi(result.split('\n')[0]!);
      expect(firstLine).toMatch(/^┌/);
      expect(firstLine).toMatch(/┐$/);
    });

    it('emits ANSI codes in color mode', () => {
      const result = renderTaskDetailCard(makeProps());
      expect(hasAnsi(result)).toBe(true);
    });

    it('applies green color to success status', () => {
      const result = renderTaskDetailCard(makeProps({ outcome: 'success' }));
      // The status row contains ANSI codes in color mode
      expect(hasAnsi(result)).toBe(true);
    });

    it('applies red color to failed status', () => {
      const result = renderTaskDetailCard(makeProps({ outcome: 'failed' }));
      expect(hasAnsi(result)).toBe(true);
    });

    it('renders Task Detail title in top border', () => {
      const result = renderTaskDetailCard(makeProps());
      expect(stripAnsi(result.split('\n')[0]!)).toContain('Task Detail');
    });
  });

  describe('color + ascii mode', () => {
    beforeEach(() => {
      setRenderContext({ noColor: false, useUnicode: false, isTTY: true, width: 80 });
    });

    it('renders ASCII box characters when unicode is disabled', () => {
      const result = renderTaskDetailCard(makeProps());
      const stripped = stripAnsi(result);
      expect(stripped).toContain('+');
      expect(stripped).toContain('-');
      expect(stripped).toContain('|');
    });

    it('does not emit unicode box chars in ascii mode', () => {
      const result = renderTaskDetailCard(makeProps());
      expect(stripAnsi(result)).not.toContain('┌');
    });
  });

  describe('noColor + unicode mode', () => {
    beforeEach(() => {
      setRenderContext({ noColor: true, useUnicode: true, isTTY: true, width: 80 });
    });

    it('emits no ANSI codes in noColor mode', () => {
      const result = renderTaskDetailCard(makeProps());
      expect(result).not.toMatch(ANSI_RE);
    });

    it('renders unicode borders without color', () => {
      const result = renderTaskDetailCard(makeProps());
      expect(result).toContain('┌');
      expect(result).toContain('┘');
    });
  });

  describe('noColor + ascii mode (non-TTY)', () => {
    beforeEach(() => {
      setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
    });

    it('emits no ANSI codes', () => {
      const result = renderTaskDetailCard(makeProps());
      expect(result).not.toMatch(ANSI_RE);
    });

    it('uses ASCII borders', () => {
      const result = renderTaskDetailCard(makeProps());
      expect(result).toContain('+');
      expect(result).not.toContain('┌');
    });
  });

  // ── Completed task rendering (AC1) ───────────────────────────────────────

  describe('completed task rendering (AC1)', () => {
    beforeEach(() => {
      setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
    });

    it('includes Status row', () => {
      const result = renderTaskDetailCard(makeProps({ outcome: 'success' }));
      expect(result).toContain('Status:');
      expect(result).toContain('success');
    });

    it('includes Task row with task name', () => {
      const result = renderTaskDetailCard(makeProps({ taskName: 'my-task' }));
      expect(result).toContain('Task:');
      expect(result).toContain('my-task');
    });

    it('includes Task ID row', () => {
      const result = renderTaskDetailCard(makeProps({ taskId: 'tid-999' }));
      expect(result).toContain('Task ID:');
      expect(result).toContain('tid-999');
    });

    it('includes Target row', () => {
      const result = renderTaskDetailCard(makeProps({ targetPath: '/home/user/repo' }));
      expect(result).toContain('Target:');
      expect(result).toContain('/home/user/repo');
    });

    it('includes Started row with timestamp', () => {
      const result = renderTaskDetailCard(makeProps({ timestamp: '2026-02-25T10:30:00.000Z' }));
      expect(result).toContain('Started:');
      expect(result).toContain('2026-02-25T10:30:00.000Z');
    });

    it('includes Duration row', () => {
      const result = renderTaskDetailCard(makeProps({ durationMs: 90000 }));
      expect(result).toContain('Duration:');
      expect(result).toContain('1m 30s');
    });

    it('includes Exit Code row', () => {
      const result = renderTaskDetailCard(makeProps({ exitCode: 0 }));
      expect(result).toContain('Exit Code:');
      expect(result).toContain('0');
    });

    it('includes Tokens In row', () => {
      const result = renderTaskDetailCard(makeProps({ tokensIn: 1234 }));
      expect(result).toContain('Tokens In:');
      expect(result).toContain('1234');
    });

    it('includes Tokens Out row', () => {
      const result = renderTaskDetailCard(makeProps({ tokensOut: 567 }));
      expect(result).toContain('Tokens Out:');
      expect(result).toContain('567');
    });

    it('includes Provider row', () => {
      const result = renderTaskDetailCard(makeProps({ provider: 'claude-code' }));
      expect(result).toContain('Provider:');
      expect(result).toContain('claude-code');
    });

    it('includes Source row', () => {
      const result = renderTaskDetailCard(makeProps({ source: 'executor' }));
      expect(result).toContain('Source:');
      expect(result).toContain('executor');
    });

    it('includes Error row showing "none" when error is null', () => {
      const result = renderTaskDetailCard(makeProps({ error: null }));
      expect(result).toContain('Error:');
      expect(result).toContain('none');
    });

    it('includes Summary row', () => {
      const result = renderTaskDetailCard(makeProps({ summary: 'All checks passed' }));
      expect(result).toContain('Summary:');
      expect(result).toContain('All checks passed');
    });

    it('includes Full log footer row always', () => {
      const result = renderTaskDetailCard(makeProps({ taskId: 'abc-123' }));
      expect(result).toContain('Full log:');
      expect(result).toContain('sparecrow logs --task');
      expect(result).toContain('--full');
    });
  });

  // ── N/A placeholder for null optional fields ────────────────────────────

  describe('null field rendering — deterministic N/A (AC1)', () => {
    beforeEach(() => {
      setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
    });

    it('renders N/A for null taskId', () => {
      const result = renderTaskDetailCard(makeProps({ taskId: null }));
      expect(result).toContain('Task ID:');
      const lines = result.split('\n');
      const taskIdLine = lines.find((l) => l.includes('Task ID:'));
      expect(taskIdLine).toContain('N/A');
    });

    it('renders N/A for null targetPath', () => {
      const result = renderTaskDetailCard(makeProps({ targetPath: null }));
      const lines = result.split('\n');
      const targetLine = lines.find((l) => l.includes('Target:'));
      expect(targetLine).toContain('N/A');
    });

    it('renders N/A for null durationMs', () => {
      const result = renderTaskDetailCard(makeProps({ durationMs: null }));
      const lines = result.split('\n');
      const durationLine = lines.find((l) => l.includes('Duration:'));
      expect(durationLine).toContain('N/A');
    });

    it('renders N/A for null exitCode', () => {
      const result = renderTaskDetailCard(makeProps({ exitCode: null }));
      const lines = result.split('\n');
      const exitCodeLine = lines.find((l) => l.includes('Exit Code:'));
      expect(exitCodeLine).toContain('N/A');
    });

    it('renders N/A for null tokensIn', () => {
      const result = renderTaskDetailCard(makeProps({ tokensIn: null }));
      const lines = result.split('\n');
      const tokenLine = lines.find((l) => l.includes('Tokens In:'));
      expect(tokenLine).toContain('N/A');
    });

    it('renders N/A for null tokensOut', () => {
      const result = renderTaskDetailCard(makeProps({ tokensOut: null }));
      const lines = result.split('\n');
      const tokenLine = lines.find((l) => l.includes('Tokens Out:'));
      expect(tokenLine).toContain('N/A');
    });

    it('renders N/A for null provider', () => {
      const result = renderTaskDetailCard(makeProps({ provider: null }));
      const lines = result.split('\n');
      const providerLine = lines.find((l) => l.includes('Provider:'));
      expect(providerLine).toContain('N/A');
    });

    it('renders N/A for null source', () => {
      const result = renderTaskDetailCard(makeProps({ source: null }));
      const lines = result.split('\n');
      const sourceLine = lines.find((l) => l.includes('Source:'));
      expect(sourceLine).toContain('N/A');
    });

    it('renders "none" for empty summary string', () => {
      const result = renderTaskDetailCard(makeProps({ summary: '' }));
      const lines = result.split('\n');
      const summaryLine = lines.find((l) => l.includes('Summary:'));
      expect(summaryLine).toContain('none');
    });

    it('renders all-null optional fields deterministically without blank labels', () => {
      const result = renderTaskDetailCard(
        makeProps({
          taskId: null,
          targetPath: null,
          durationMs: null,
          exitCode: null,
          tokensIn: null,
          tokensOut: null,
          provider: null,
          source: null,
          error: null,
          summary: '',
        }),
      );
      // Should not have any empty/undefined label values
      expect(result).not.toContain('undefined');
      expect(result).not.toContain('null');
      // All N/A placeholders present
      expect(result).toContain('N/A');
    });
  });

  // ── Non-success task behavior (AC2) ─────────────────────────────────────

  describe('non-success task behavior (AC2)', () => {
    beforeEach(() => {
      setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
    });

    it('omits findings section for failed outcome', () => {
      const result = renderTaskDetailCard(
        makeProps({
          outcome: 'failed',
          findings: [{ label: 'Issue', detail: 'Critical bug found' }],
        }),
      );
      expect(result).not.toContain('Findings:');
      expect(result).not.toContain('Critical bug found');
    });

    it('omits findings section for quota outcome', () => {
      const result = renderTaskDetailCard(
        makeProps({
          outcome: 'quota',
          findings: [{ label: 'Issue', detail: 'Some finding' }],
        }),
      );
      expect(result).not.toContain('Findings:');
    });

    it('omits findings section for retrying outcome', () => {
      const result = renderTaskDetailCard(
        makeProps({
          outcome: 'retrying',
          findings: [{ label: 'Issue', detail: 'Some finding' }],
        }),
      );
      expect(result).not.toContain('Findings:');
    });

    it('omits findings section for unknown outcome', () => {
      const result = renderTaskDetailCard(
        makeProps({
          outcome: 'unknown',
          findings: [{ label: 'Issue', detail: 'Some finding' }],
        }),
      );
      expect(result).not.toContain('Findings:');
    });

    it('shows sanitized error detail for failed outcome', () => {
      const result = renderTaskDetailCard(
        makeProps({
          outcome: 'failed',
          error: 'Process exited with code 1',
        }),
      );
      expect(result).toContain('Error:');
      expect(result).toContain('Process exited with code 1');
    });

    it('truncates very long error strings to prevent raw blob rendering', () => {
      const longError = 'E'.repeat(500);
      const result = renderTaskDetailCard(makeProps({ outcome: 'failed', error: longError }));
      // Should be truncated — the rendered error text should be at most MAX_ERROR_CHARS (200)
      expect(result).toContain('Error:');
      // The full 500-char error string should not appear verbatim
      expect(result).not.toContain(longError);
      // The truncation indicator should appear — Unicode or ASCII ellipsis depending on context
      const hasEllipsis = result.includes('…') || result.includes('...');
      expect(hasEllipsis).toBe(true);
    });

    it('shows Full log footer row for non-success outcomes', () => {
      const result = renderTaskDetailCard(makeProps({ outcome: 'failed', taskId: 'def-456' }));
      expect(result).toContain('sparecrow logs --task');
      expect(result).toContain('--full');
    });

    it('renders failed status text', () => {
      const result = renderTaskDetailCard(makeProps({ outcome: 'failed' }));
      expect(result).toContain('failed');
    });

    it('renders quota status text', () => {
      const result = renderTaskDetailCard(makeProps({ outcome: 'quota' }));
      expect(result).toContain('quota');
    });

    it('renders retrying status text', () => {
      const result = renderTaskDetailCard(makeProps({ outcome: 'retrying' }));
      expect(result).toContain('retrying');
    });
  });

  // ── Findings section (AC1) ────────────────────────────────────────────────

  describe('findings section for success (AC1)', () => {
    beforeEach(() => {
      setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
    });

    it('renders Findings section when findings supplied for success outcome', () => {
      const result = renderTaskDetailCard(
        makeProps({
          outcome: 'success',
          findings: [
            { label: 'XSS', detail: 'Found in login form' },
            { label: 'SQLi', detail: 'Possible injection at /api/users' },
          ],
        }),
      );
      expect(result).toContain('Findings:');
      expect(result).toContain('XSS: Found in login form');
      expect(result).toContain('SQLi: Possible injection at /api/users');
    });

    it('omits Findings section when findings is empty array for success', () => {
      const result = renderTaskDetailCard(makeProps({ outcome: 'success', findings: [] }));
      expect(result).not.toContain('Findings:');
    });

    it('omits Findings section when findings prop is absent', () => {
      const result = renderTaskDetailCard(makeProps({ outcome: 'success' }));
      expect(result).not.toContain('Findings:');
    });
  });

  // ── Width-constrained rendering (AC3, AC10) ───────────────────────────────

  describe('width-constrained rendering', () => {
    it('renders at minimum width of 40 without throwing', () => {
      setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 40 });
      const result = renderTaskDetailCard(makeProps({ width: 40 }));
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('renders bordered output at width 40 with semantic labels visible', () => {
      setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 40 });
      const result = renderTaskDetailCard(makeProps({ width: 40 }));
      expect(result).toContain('Status:');
      expect(result).toContain('Task:');
    });

    it('produces output with top and bottom border lines', () => {
      setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
      const result = renderTaskDetailCard(makeProps({ width: 80 }));
      const lines = result.split('\n');
      expect(lines[0]).toMatch(/^[+┌]/);
      expect(lines[lines.length - 1]).toMatch(/^[+└]/);
    });
  });

  // ── Pure function contract ────────────────────────────────────────────────

  describe('pure function contract', () => {
    it('returns a string', () => {
      setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
      const result = renderTaskDetailCard(makeProps());
      expect(typeof result).toBe('string');
    });

    it('returns a multi-line string', () => {
      setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
      const result = renderTaskDetailCard(makeProps());
      expect(result.split('\n').length).toBeGreaterThan(5);
    });
  });
});

// ── formatDuration tests ─────────────────────────────────────────────────────

describe('formatDuration', () => {
  it('returns N/A for null', () => {
    expect(formatDuration(null)).toBe('N/A');
  });

  it('returns N/A for negative values', () => {
    expect(formatDuration(-1000)).toBe('N/A');
  });

  it('returns N/A for NaN', () => {
    expect(formatDuration(NaN)).toBe('N/A');
  });

  it('returns seconds for sub-minute durations', () => {
    expect(formatDuration(45000)).toBe('45s');
  });

  it('returns minutes and seconds for minute-level durations', () => {
    expect(formatDuration(90000)).toBe('1m 30s');
  });

  it('returns 0s for zero milliseconds', () => {
    expect(formatDuration(0)).toBe('0s');
  });

  it('formats 3 minutes 5 seconds correctly', () => {
    expect(formatDuration(185000)).toBe('3m 5s');
  });

  it('returns N/A for Infinity', () => {
    expect(formatDuration(Infinity)).toBe('N/A');
  });

  it('returns N/A for -Infinity', () => {
    expect(formatDuration(-Infinity)).toBe('N/A');
  });
});
