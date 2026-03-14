/** Accessibility hardening tests — Story 6.6. Covers capability matrix, non-TTY, width modes, truncation gating. */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import chalk from 'chalk';
import { getRenderContext, setRenderContext, resetRenderContext } from './render-context.js';
import {
  renderDashboardCard,
  renderDashboardCardGrid,
  getCardWidthForGrid,
} from './dashboard-card.js';
import { renderStatusIndicator } from './status-indicator.js';
import { renderLogSummaryRow } from './log-summary-row.js';
import { renderTaskDetailCard } from './task-detail-card.js';
import { renderErrorBlock } from './error-block.js';
import { renderHintLine } from './hint-line.js';
import { renderUtilizationReport } from './utilization-report.js';
import { renderSectionDivider } from './section-divider.js';
import { createSpinner } from './spinner.js';
import { stripAnsi } from './ansi-utils.js';
import type { DashboardCardProps } from './dashboard-card.js';
import type { TaskDetailCardProps } from './task-detail-card.js';

// Force chalk to emit ANSI codes in tests (chalk auto-disables in non-TTY)
let previousChalkLevel: typeof chalk.level;
beforeAll(() => {
  previousChalkLevel = chalk.level;
  chalk.level = 3;
});
afterAll(() => {
  chalk.level = previousChalkLevel;
});

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[/;
// Non-ASCII unicode range (above U+007F)
// eslint-disable-next-line no-control-regex
const NON_ASCII_RE = /[^\x00-\x7F]/;

function hasCursorControl(s: string): boolean {
  // Matches cursor move/erase sequences e.g. \x1b[A, \x1b[2J, \r (carriage return for line overwrite)
  // eslint-disable-next-line no-control-regex
  return /\x1b\[[0-9;]*[ABCDEFGHJKST]/.test(s) || /\r[^\n]/.test(s);
}

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeCard(overrides: Partial<DashboardCardProps> = {}): DashboardCardProps {
  return {
    title: 'Health',
    lines: ['line one', 'line two'],
    state: 'healthy',
    variant: 'compact',
    width: 80,
    ...overrides,
  };
}

function makeTaskCardProps(overrides: Partial<TaskDetailCardProps> = {}): TaskDetailCardProps {
  return {
    timestamp: '2026-02-25T10:30:00.000Z',
    outcome: 'success',
    taskName: 'security-audit',
    taskId: 'abc-123',
    targetPath: '/home/user/very-long-path/that/keeps/going',
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

// ── Task 5.1: Per-component capability matrix tests ──────────────────────────

describe('capability matrix: all 8 components', () => {
  afterEach(() => resetRenderContext());

  const capabilityConfigs = [
    { label: 'color+unicode', noColor: false, useUnicode: true },
    { label: 'noColor+unicode', noColor: true, useUnicode: true },
    { label: 'color+ascii', noColor: false, useUnicode: false },
    { label: 'noColor+ascii', noColor: true, useUnicode: false },
  ] as const;

  for (const cap of capabilityConfigs) {
    describe(`${cap.label}`, () => {
      beforeEach(() => {
        setRenderContext({
          noColor: cap.noColor,
          useUnicode: cap.useUnicode,
          isTTY: true,
          width: 80,
        });
      });

      it('dashboard-card: no ANSI when noColor', () => {
        const result = renderDashboardCard(makeCard({ state: 'error' }));
        if (cap.noColor) {
          expect(result).not.toMatch(ANSI_RE);
        }
      });

      it('dashboard-card: text labels present when noColor', () => {
        const errResult = renderDashboardCard(makeCard({ state: 'error', title: 'Status' }));
        const warnResult = renderDashboardCard(makeCard({ state: 'warning', title: 'Status' }));
        if (cap.noColor) {
          expect(errResult).toContain('[ERR]');
          expect(warnResult).toContain('[WARN]');
        }
      });

      it('dashboard-card: no unicode box chars when !useUnicode', () => {
        const result = renderDashboardCard(makeCard());
        if (!cap.useUnicode) {
          expect(stripAnsi(result)).not.toContain('┌');
          expect(stripAnsi(result)).not.toContain('│');
        }
      });

      it('status-indicator: no ANSI when noColor', () => {
        const result = renderStatusIndicator({
          state: 'healthy',
          label: 'Daemon',
          value: 'running',
        });
        if (cap.noColor) {
          expect(result).not.toMatch(ANSI_RE);
          expect(result).toContain('[OK]');
        }
      });

      it('status-indicator: text labels present for all states', () => {
        if (cap.noColor) {
          expect(renderStatusIndicator({ state: 'error', label: 'X', value: 'v' })).toContain(
            '[ERR]',
          );
          expect(renderStatusIndicator({ state: 'warning', label: 'X', value: 'v' })).toContain(
            '[WARN]',
          );
          expect(renderStatusIndicator({ state: 'info', label: 'X', value: 'v' })).toContain(
            '[INFO]',
          );
        }
      });

      it('log-summary-row: no ANSI when noColor', () => {
        const result = renderLogSummaryRow({
          outcome: 'success',
          taskName: 'task',
          relativeTime: '5m ago',
          duration: '30s',
          targetPath: '/repo',
        });
        if (cap.noColor) {
          expect(result).not.toMatch(ANSI_RE);
          expect(result).toContain('[PASS]');
        }
      });

      it('log-summary-row: no unicode outside ASCII when !useUnicode', () => {
        const result = renderLogSummaryRow({
          outcome: 'success',
          taskName: 'task',
          relativeTime: '5m ago',
          duration: '30s',
          targetPath: '/repo',
        });
        if (!cap.useUnicode) {
          expect(stripAnsi(result)).not.toMatch(NON_ASCII_RE);
        }
      });

      it('task-detail-card: no ANSI when noColor', () => {
        const result = renderTaskDetailCard(makeTaskCardProps());
        if (cap.noColor) {
          expect(result).not.toMatch(ANSI_RE);
        }
      });

      it('error-block: no ANSI when noColor', () => {
        const result = renderErrorBlock({ severity: 'critical', message: 'Something failed' });
        if (cap.noColor) {
          expect(result).not.toMatch(ANSI_RE);
          expect(result).toContain('[ERR]');
        }
      });

      it('error-block: warning label present when noColor', () => {
        const result = renderErrorBlock({ severity: 'warning', message: 'Check config' });
        if (cap.noColor) {
          expect(result).toContain('[WARN]');
        }
      });

      it('hint-line: no ANSI when noColor', () => {
        const result = renderHintLine('Run: sparecrow doctor');
        if (cap.noColor) {
          expect(result).not.toMatch(ANSI_RE);
        }
      });

      it('utilization-report: no ANSI when noColor', () => {
        const result = renderUtilizationReport({
          variant: 'compact',
          dollarValueRecovered: 10.0,
          utilizationPercent: 0.5,
        });
        if (cap.noColor) {
          expect(result).not.toMatch(ANSI_RE);
        }
      });

      it('section-divider: no ANSI when noColor, no unicode when !useUnicode', () => {
        const result = renderSectionDivider(40);
        if (cap.noColor) {
          expect(result).not.toMatch(ANSI_RE);
        }
        if (!cap.useUnicode) {
          expect(result).not.toMatch(NON_ASCII_RE);
          expect(result).toContain('-');
        }
      });
    });
  }
});

// ── Task 5.2: Width boundary tests ───────────────────────────────────────────

describe('width boundary mode selection', () => {
  afterEach(() => resetRenderContext());

  const boundaries = [
    { width: 40, expected: 'compact' },
    { width: 59, expected: 'compact' },
    { width: 60, expected: 'standard' },
    { width: 79, expected: 'standard' },
    { width: 80, expected: 'full' },
    { width: 119, expected: 'full' },
    { width: 120, expected: 'wide' },
    { width: 200, expected: 'wide' },
  ] as const;

  for (const { width, expected } of boundaries) {
    it(`width ${width} produces widthMode '${expected}'`, () => {
      setRenderContext({ width, isTTY: true, noColor: true, useUnicode: false });
      expect(getRenderContext().widthMode).toBe(expected);
    });
  }

  it('dashboard-card adapts to wide mode at width=200 (no upper clamp)', () => {
    setRenderContext({ width: 200, isTTY: true, noColor: true, useUnicode: false });
    const cardWidth = getCardWidthForGrid(200);
    expect(cardWidth).toBeGreaterThan(getCardWidthForGrid(120));
  });

  it('dashboard-card grid uses 2-column at width=120 (wide)', () => {
    setRenderContext({ width: 120, isTTY: true, noColor: true, useUnicode: false });
    const cw = getCardWidthForGrid(120);
    const c1 = renderDashboardCard(makeCard({ title: 'A', width: cw }));
    const c2 = renderDashboardCard(makeCard({ title: 'B', width: cw }));
    const grid = renderDashboardCardGrid([c1, c2], 120);
    expect(grid).toContain('A');
    expect(grid).toContain('B');
    // Both titles on same line
    const firstLine = stripAnsi(grid.split('\n')[0]!);
    expect(firstLine).toContain('A');
    expect(firstLine).toContain('B');
  });

  it('utilization-report renders at width=200 without error', () => {
    setRenderContext({ width: 200, isTTY: true, noColor: false, useUnicode: true });
    expect(() =>
      renderUtilizationReport({
        variant: 'detailed',
        dollarValueRecovered: 10.0,
        utilizationPercent: 0.5,
        beforeUtilization: 0.3,
        afterUtilization: 0.5,
        taskCount: 5,
        breakdown: [{ taskType: 'improve-code', count: 5, dollarValue: 10 }],
      }),
    ).not.toThrow();
  });
});

// ── Task 5.3: Non-TTY tests ───────────────────────────────────────────────────

describe('non-TTY mode', () => {
  beforeEach(() => {
    setRenderContext({ isTTY: false, noColor: true, useUnicode: false, width: 80 });
  });
  afterEach(() => resetRenderContext());

  it('dashboard-card: no ANSI escape sequences', () => {
    const result = renderDashboardCard(makeCard({ state: 'error' }));
    expect(result).not.toMatch(ANSI_RE);
  });

  it('dashboard-card: no non-ASCII unicode characters', () => {
    const result = renderDashboardCard(makeCard());
    expect(stripAnsi(result)).not.toMatch(NON_ASCII_RE);
  });

  it('dashboard-card: long lines are not truncated (truncationEnabled=false)', () => {
    const longLine = 'x'.repeat(200);
    const result = renderDashboardCard(
      makeCard({ lines: [longLine], variant: 'expanded', width: 80 }),
    );
    expect(result).toContain(longLine);
    expect(result).not.toContain('…');
  });

  it('task-detail-card: long token values emitted untruncated', () => {
    const longPath = '/home/user/' + 'a'.repeat(200);
    const result = renderTaskDetailCard(makeTaskCardProps({ targetPath: longPath, width: 80 }));
    expect(result).toContain(longPath);
  });

  it('log-summary-row: task name and path untruncated', () => {
    const longName = 'a'.repeat(60);
    const longPath = '/repo/' + 'b'.repeat(60);
    const result = renderLogSummaryRow({
      outcome: 'success',
      taskName: longName,
      relativeTime: '5m ago',
      duration: '30s',
      targetPath: longPath,
    });
    expect(result).toContain(longName);
    expect(result).toContain(longPath);
  });

  it('createSpinner: returns noop spinner with no-op methods', async () => {
    const spinner = await createSpinner('loading');
    expect(() => spinner.start()).not.toThrow();
    expect(() => spinner.stop()).not.toThrow();
    expect(() => spinner.succeed()).not.toThrow();
    expect(() => spinner.fail()).not.toThrow();
    // noop methods return undefined
    expect(spinner.start()).toBeUndefined();
    expect(spinner.stop()).toBeUndefined();
  });

  it('all components: no ANSI escape sequences', () => {
    const dashCard = renderDashboardCard(makeCard({ state: 'warning' }));
    const statusInd = renderStatusIndicator({ state: 'error', label: 'Auth', value: 'expired' });
    const logRow = renderLogSummaryRow({
      outcome: 'failed',
      taskName: 'security-audit',
      relativeTime: '10m ago',
      duration: '45s',
      targetPath: '/repo',
    });
    const taskCard = renderTaskDetailCard(
      makeTaskCardProps({ outcome: 'failed', error: 'timeout' }),
    );
    const errBlock = renderErrorBlock({
      severity: 'critical',
      message: 'Daemon down',
      impact: 'No tasks will run',
      recovery: 'sparecrow daemon start',
    });
    const hint = renderHintLine('Run: sparecrow doctor');
    const utilReport = renderUtilizationReport({
      variant: 'compact',
      dollarValueRecovered: 5,
      utilizationPercent: 0.4,
    });
    const divider = renderSectionDivider(40);

    for (const [name, output] of [
      ['dashboard-card', dashCard],
      ['status-indicator', statusInd],
      ['log-summary-row', logRow],
      ['task-detail-card', taskCard],
      ['error-block', errBlock],
      ['hint-line', hint],
      ['utilization-report', utilReport],
      ['section-divider', divider],
    ] as const) {
      expect(output, `${name} should have no ANSI in non-TTY`).not.toMatch(ANSI_RE);
    }
  });

  it('all components: no cursor control sequences (screen-reader safe)', () => {
    const outputs = [
      renderDashboardCard(makeCard()),
      renderStatusIndicator({ state: 'healthy', label: 'X', value: 'ok' }),
      renderLogSummaryRow({
        outcome: 'success',
        taskName: 'task',
        relativeTime: '1m ago',
        duration: '5s',
        targetPath: '/r',
      }),
      renderTaskDetailCard(makeTaskCardProps()),
      renderErrorBlock({ severity: 'info', message: 'Info' }),
      renderHintLine('hint'),
      renderUtilizationReport({
        variant: 'compact',
        dollarValueRecovered: 0,
        utilizationPercent: 0,
      }),
      renderSectionDivider(40),
    ];
    for (const output of outputs) {
      expect(hasCursorControl(output)).toBe(false);
    }
  });
});

// ── Spinner behavior ──────────────────────────────────────────────────────────

describe('spinner: noop in non-interactive contexts', () => {
  afterEach(() => resetRenderContext());

  it('returns noop when isTTY=false', async () => {
    setRenderContext({ isTTY: false, noColor: true, useUnicode: false, width: 80 });
    const spinner = await createSpinner('loading');
    expect(spinner.start()).toBeUndefined();
    expect(spinner.stop()).toBeUndefined();
    expect(spinner.succeed()).toBeUndefined();
    expect(spinner.fail()).toBeUndefined();
  });

  it('returns noop when noColor=true (even with isTTY=true)', async () => {
    setRenderContext({ isTTY: true, noColor: true, useUnicode: false, width: 80 });
    const spinner = await createSpinner('loading');
    expect(spinner.start()).toBeUndefined();
  });
});
