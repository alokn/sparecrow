/** Unit tests for renderDashboardCard and renderDashboardCardGrid. */

import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach } from 'vitest';
import chalk from 'chalk';
import { resetRenderContext, setRenderContext } from './render-context.js';
import {
  renderDashboardCard,
  renderDashboardCardGrid,
  getCardWidthForGrid,
  truncateLine,
  type DashboardCardProps,
} from './dashboard-card.js';
import { stripAnsi, visibleWidth } from './ansi-utils.js';
import { CARD_GAP } from './tokens.js';

// Force chalk to produce ANSI codes in the test environment
let previousChalkLevel = chalk.level;
beforeAll(() => {
  previousChalkLevel = chalk.level;
  chalk.level = 3;
});

afterAll(() => {
  chalk.level = previousChalkLevel;
});

const ELLIPSIS = '…';

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-9;]*m/g;

function makeCard(overrides: Partial<DashboardCardProps> = {}): DashboardCardProps {
  return {
    title: 'Health',
    lines: ['line one', 'line two'],
    state: 'healthy',
    variant: 'compact',
    width: 40,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// describe('renderDashboardCard')
// ─────────────────────────────────────────────────────────────────────────────

describe('renderDashboardCard', () => {
  afterEach(() => {
    resetRenderContext();
  });

  // ── 4 render paths ───────────────────────────────────────────────────────

  describe('render path: color + unicode', () => {
    beforeEach(() => {
      setRenderContext({ isTTY: true, noColor: false, useUnicode: true, width: 40 });
    });

    it('renders unicode box-drawing characters in top border', () => {
      const result = renderDashboardCard(makeCard());
      const firstLine = stripAnsi(result.split('\n')[0]!);
      expect(firstLine).toMatch(/^┌/);
      expect(firstLine).toMatch(/┐$/);
      expect(firstLine).toContain('─');
    });

    it('renders unicode side border characters', () => {
      const result = renderDashboardCard(makeCard({ variant: 'compact' }));
      const contentLines = result.split('\n').slice(1, -1);
      for (const line of contentLines) {
        expect(stripAnsi(line)).toMatch(/^│/);
        expect(stripAnsi(line)).toMatch(/│$/);
      }
    });

    it('renders unicode bottom border', () => {
      const result = renderDashboardCard(makeCard());
      const lastLine = stripAnsi(result.split('\n').at(-1)!);
      expect(lastLine).toMatch(/^└/);
      expect(lastLine).toMatch(/┘$/);
    });

    it('embeds title in top border', () => {
      const result = renderDashboardCard(makeCard({ title: 'MyTitle' }));
      expect(stripAnsi(result.split('\n')[0]!)).toContain('MyTitle');
    });

    it('applies ANSI codes to healthy title', () => {
      const result = renderDashboardCard(makeCard({ state: 'healthy' }));
      expect(result.split('\n')[0]).toMatch(ANSI_RE);
    });

    it('does not add state prefix in healthy color mode', () => {
      const result = renderDashboardCard(makeCard({ state: 'healthy', title: 'Health' }));
      const firstLine = stripAnsi(result.split('\n')[0]!);
      expect(firstLine).not.toContain('[ERR]');
      expect(firstLine).not.toContain('[WARN]');
    });

    it('produces every line at the specified card width', () => {
      const result = renderDashboardCard(makeCard({ width: 40 }));
      for (const line of result.split('\n')) {
        expect(visibleWidth(line)).toBe(40);
      }
    });
  });

  describe('render path: color + ascii', () => {
    beforeEach(() => {
      setRenderContext({ isTTY: true, noColor: false, useUnicode: false, width: 40 });
    });

    it('renders ASCII box characters when unicode is disabled', () => {
      const result = renderDashboardCard(makeCard());
      const stripped = stripAnsi(result);
      expect(stripped).toContain('+');
      expect(stripped).toContain('-');
      expect(stripped).toContain('|');
    });

    it('does not emit unicode box chars in ascii mode', () => {
      const result = renderDashboardCard(makeCard());
      expect(stripAnsi(result)).not.toContain('┌');
      expect(stripAnsi(result)).not.toContain('│');
    });

    it('produces every line at the specified card width', () => {
      const result = renderDashboardCard(makeCard({ width: 40 }));
      for (const line of result.split('\n')) {
        expect(visibleWidth(line)).toBe(40);
      }
    });
  });

  describe('render path: noColor + unicode', () => {
    beforeEach(() => {
      setRenderContext({ isTTY: true, noColor: true, useUnicode: true, width: 40 });
    });

    it('emits no ANSI codes in noColor mode', () => {
      const result = renderDashboardCard(makeCard({ state: 'error' }));
      expect(result).not.toMatch(ANSI_RE);
    });

    it('renders unicode borders without color', () => {
      const result = renderDashboardCard(makeCard());
      expect(result).toContain('┌');
      expect(result).toContain('┘');
    });
  });

  describe('render path: noColor + ascii (non-TTY)', () => {
    beforeEach(() => {
      setRenderContext({ isTTY: false, noColor: true, useUnicode: false, width: 40 });
    });

    it('emits no ANSI codes in non-TTY mode', () => {
      const result = renderDashboardCard(makeCard({ state: 'warning' }));
      expect(result).not.toMatch(ANSI_RE);
    });

    it('uses ASCII borders in non-TTY mode', () => {
      const result = renderDashboardCard(makeCard());
      expect(result).toContain('+');
      expect(result).not.toContain('┌');
    });
  });

  // ── AC1: Base card rendering ─────────────────────────────────────────────

  describe('AC1: base card rendering', () => {
    beforeEach(() => {
      setRenderContext({ isTTY: true, noColor: false, useUnicode: true, width: 40 });
    });

    it('renders title embedded in top border using pattern ┌─ title ──┐', () => {
      const result = renderDashboardCard(makeCard({ title: 'Status' }));
      const topBorder = stripAnsi(result.split('\n')[0]!);
      expect(topBorder).toMatch(/^┌─ Status /);
    });

    it('does not add prefix in healthy NO_COLOR mode', () => {
      setRenderContext({ isTTY: false, noColor: true, useUnicode: false, width: 40 });
      const result = renderDashboardCard(makeCard({ state: 'healthy', title: 'Health' }));
      expect(result).not.toContain('[ERR]');
      expect(result).not.toContain('[WARN]');
    });

    it('truncates long titles to fit the top border width', () => {
      const result = renderDashboardCard(
        makeCard({
          title: 'This title is intentionally too long to fit',
          width: 18,
          variant: 'expanded',
          lines: ['x'],
        }),
      );
      const top = stripAnsi(result.split('\n')[0]!);
      expect(top).toContain(ELLIPSIS);
      expect(top).toContain('This title ');
      expect(top).not.toContain('intentionally');
      expect(visibleWidth(top)).toBe(18);
    });
  });

  // ── AC2: Error state ─────────────────────────────────────────────────────

  describe('AC2: error state rendering', () => {
    it('adds [ERR] prefix to title in NO_COLOR mode', () => {
      setRenderContext({ isTTY: false, noColor: true, useUnicode: false, width: 40 });
      const result = renderDashboardCard(makeCard({ state: 'error', title: 'Health' }));
      expect(result.split('\n')[0]).toContain('Health [ERR]');
    });

    it('does not add [ERR] prefix in color mode', () => {
      setRenderContext({ isTTY: true, noColor: false, useUnicode: true, width: 40 });
      const result = renderDashboardCard(makeCard({ state: 'error', title: 'Health' }));
      expect(stripAnsi(result.split('\n')[0]!)).not.toContain('[ERR]');
    });

    it('applies ANSI coloring to top border in color error mode', () => {
      setRenderContext({ isTTY: true, noColor: false, useUnicode: true, width: 40 });
      const result = renderDashboardCard(makeCard({ state: 'error' }));
      expect(result.split('\n')[0]).toMatch(ANSI_RE);
    });

    it('applies ANSI coloring to bottom border in color error mode', () => {
      setRenderContext({ isTTY: true, noColor: false, useUnicode: true, width: 40 });
      const result = renderDashboardCard(makeCard({ state: 'error' }));
      const bottomBorder = result.split('\n').at(-1)!;
      expect(bottomBorder).toMatch(ANSI_RE);
    });

    it('applies ANSI coloring to side borders in color error mode', () => {
      setRenderContext({ isTTY: true, noColor: false, useUnicode: true, width: 40 });
      const result = renderDashboardCard(makeCard({ state: 'error', variant: 'compact' }));
      const contentLine = result.split('\n')[1]!;
      expect(contentLine).toMatch(ANSI_RE);
    });

    it('produces correct width even with [ERR] prefix in NO_COLOR mode', () => {
      setRenderContext({ isTTY: false, noColor: true, useUnicode: false, width: 40 });
      const result = renderDashboardCard(makeCard({ state: 'error', title: 'Hi', width: 40 }));
      for (const line of result.split('\n')) {
        expect(visibleWidth(line)).toBe(40);
      }
    });
  });

  // ── AC3: Warning state ───────────────────────────────────────────────────

  describe('AC3: warning state rendering', () => {
    it('adds [WARN] prefix to title in NO_COLOR mode', () => {
      setRenderContext({ isTTY: false, noColor: true, useUnicode: false, width: 40 });
      const result = renderDashboardCard(makeCard({ state: 'warning', title: 'Health' }));
      expect(result.split('\n')[0]).toContain('Health [WARN]');
    });

    it('does not add [WARN] prefix in color mode', () => {
      setRenderContext({ isTTY: true, noColor: false, useUnicode: true, width: 40 });
      const result = renderDashboardCard(makeCard({ state: 'warning', title: 'Health' }));
      expect(stripAnsi(result.split('\n')[0]!)).not.toContain('[WARN]');
    });

    it('applies ANSI coloring to title in color warning mode', () => {
      setRenderContext({ isTTY: true, noColor: false, useUnicode: true, width: 40 });
      const result = renderDashboardCard(makeCard({ state: 'warning' }));
      expect(result.split('\n')[0]).toMatch(ANSI_RE);
    });

    it('does not color side borders in color warning mode', () => {
      setRenderContext({ isTTY: true, noColor: false, useUnicode: true, width: 40 });
      const errResult = renderDashboardCard(makeCard({ state: 'error', variant: 'compact' }));
      const warnResult = renderDashboardCard(makeCard({ state: 'warning', variant: 'compact' }));
      const errContentLine = errResult.split('\n')[1]!;
      const warnContentLine = warnResult.split('\n')[1]!;
      // Error mode colors side borders; warning mode does not
      expect(errContentLine).toMatch(ANSI_RE);
      // Warning: side border chars are not ANSI-wrapped — line starts with plain │
      expect(stripAnsi(warnContentLine)[0]).toBe('│');
      expect(warnContentLine[0]).toBe('│');
    });
  });

  // ── AC4: Compact variant ─────────────────────────────────────────────────

  describe('AC4: compact variant', () => {
    beforeEach(() => {
      setRenderContext({ isTTY: true, noColor: false, useUnicode: true, width: 40 });
    });

    it('clamps to maximum 4 content lines', () => {
      const result = renderDashboardCard(
        makeCard({ variant: 'compact', lines: ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'] }),
      );
      const contentLines = result.split('\n').slice(1, -1);
      expect(contentLines.length).toBe(4);
    });

    it('pads to minimum 4 content lines (COMPACT_MAX) when fewer than 4 lines supplied', () => {
      const result = renderDashboardCard(makeCard({ variant: 'compact', lines: ['only one'] }));
      const contentLines = result.split('\n').slice(1, -1);
      expect(contentLines.length).toBe(4);
    });

    it('renders 0 input lines padded to 4 (COMPACT_MAX)', () => {
      const result = renderDashboardCard(makeCard({ variant: 'compact', lines: [] }));
      const contentLines = result.split('\n').slice(1, -1);
      expect(contentLines.length).toBe(4);
    });

    it('renders 3 lines padded to 4 (COMPACT_MAX)', () => {
      const result = renderDashboardCard(makeCard({ variant: 'compact', lines: ['a', 'b', 'c'] }));
      const contentLines = result.split('\n').slice(1, -1);
      expect(contentLines.length).toBe(4);
    });
  });

  // ── AC5: Expanded variant ────────────────────────────────────────────────

  describe('AC5: expanded variant', () => {
    beforeEach(() => {
      setRenderContext({ isTTY: true, noColor: false, useUnicode: true, width: 40 });
    });

    it('renders all supplied lines without clamping', () => {
      const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
      const result = renderDashboardCard(makeCard({ variant: 'expanded', lines }));
      const contentLines = result.split('\n').slice(1, -1);
      expect(contentLines.length).toBe(10);
    });

    it('renders a single line without padding', () => {
      const result = renderDashboardCard(makeCard({ variant: 'expanded', lines: ['only'] }));
      const contentLines = result.split('\n').slice(1, -1);
      expect(contentLines.length).toBe(1);
    });

    it('renders zero lines with empty card body', () => {
      const result = renderDashboardCard(makeCard({ variant: 'expanded', lines: [] }));
      const contentLines = result.split('\n').slice(1, -1);
      expect(contentLines.length).toBe(0);
    });
  });

  // ── AC8: Non-TTY and unicode fallback ─────────────────────────────────────

  describe('AC8: non-TTY and unicode fallback', () => {
    beforeEach(() => {
      setRenderContext({ isTTY: false, noColor: true, useUnicode: false, width: 40 });
    });

    it('emits no ANSI escape sequences', () => {
      const result = renderDashboardCard(
        makeCard({ state: 'error', lines: ['an error message'], variant: 'expanded' }),
      );
      expect(result).not.toMatch(ANSI_RE);
    });

    it('uses ASCII borders', () => {
      const result = renderDashboardCard(makeCard());
      const firstLine = result.split('\n')[0]!;
      expect(firstLine).toMatch(/^\+/);
      expect(firstLine).not.toContain('┌');
    });

    it('does not truncate long lines', () => {
      const longLine = 'x'.repeat(80);
      const result = renderDashboardCard(
        makeCard({ lines: [longLine], variant: 'expanded', width: 40 }),
      );
      expect(result).toContain(longLine);
      expect(result).not.toContain(ELLIPSIS);
    });

    it('renders all content without width-based truncation', () => {
      const lines = ['a'.repeat(60), 'b'.repeat(60)];
      const result = renderDashboardCard(makeCard({ lines, variant: 'expanded', width: 40 }));
      for (const l of lines) {
        expect(result).toContain(l);
      }
    });
  });

  // ── AC9: ANSI-safe truncation in TTY ─────────────────────────────────────

  describe('AC9: ANSI-safe truncation in TTY', () => {
    beforeEach(() => {
      setRenderContext({ isTTY: true, noColor: false, useUnicode: true, width: 40 });
    });

    it('truncates lines exceeding inner width and appends ellipsis', () => {
      const result = renderDashboardCard(
        makeCard({ lines: ['a'.repeat(50)], variant: 'expanded', width: 40 }),
      );
      const contentLine = result.split('\n')[1]!;
      expect(stripAnsi(contentLine)).toContain(ELLIPSIS);
    });

    it('preserves exact card width for all lines after truncation', () => {
      const result = renderDashboardCard(
        makeCard({ lines: ['z'.repeat(100)], variant: 'expanded', width: 40 }),
      );
      for (const line of result.split('\n')) {
        expect(visibleWidth(line)).toBe(40);
      }
    });

    it('handles ANSI-colored content without breaking border alignment', () => {
      const coloredLine = `\x1B[31m${'c'.repeat(50)}\x1B[0m`;
      const result = renderDashboardCard(
        makeCard({ lines: [coloredLine], variant: 'expanded', width: 40 }),
      );
      for (const line of result.split('\n')) {
        expect(visibleWidth(line)).toBe(40);
      }
    });

    it('does not truncate lines that fit within inner width', () => {
      const shortLine = 'hello';
      const result = renderDashboardCard(
        makeCard({ lines: [shortLine], variant: 'expanded', width: 40 }),
      );
      const contentLine = result.split('\n')[1]!;
      expect(contentLine).toContain(shortLine);
      expect(stripAnsi(contentLine)).not.toContain(ELLIPSIS);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// describe('truncateLine')
// ─────────────────────────────────────────────────────────────────────────────

describe('truncateLine', () => {
  afterEach(() => {
    resetRenderContext();
  });

  it('returns empty string when maxWidth is zero', () => {
    expect(truncateLine('hello', 0)).toBe('');
  });

  it('returns string unchanged when within maxWidth', () => {
    expect(truncateLine('hello', 10)).toBe('hello');
  });

  it('truncates plain string to maxWidth visible chars with Unicode ellipsis when useUnicode=true', () => {
    setRenderContext({ isTTY: true, noColor: false, useUnicode: true, width: 80 });
    const result = truncateLine('a'.repeat(20), 10);
    expect(visibleWidth(result)).toBe(10);
    expect(result.endsWith(ELLIPSIS)).toBe(true);
  });

  it('truncates plain string and uses ASCII ellipsis when useUnicode=false', () => {
    setRenderContext({ isTTY: false, noColor: true, useUnicode: false, width: 80 });
    const result = truncateLine('a'.repeat(20), 10);
    expect(visibleWidth(result)).toBe(10);
    expect(result.endsWith('...')).toBe(true);
  });

  it('truncates ANSI-colored string without counting escape codes in width', () => {
    setRenderContext({ isTTY: true, noColor: false, useUnicode: true, width: 80 });
    const colored = `\x1B[31m${'a'.repeat(20)}\x1B[0m`;
    const result = truncateLine(colored, 10);
    expect(visibleWidth(result)).toBe(10);
    expect(result).toContain(ELLIPSIS);
  });

  it('appends ANSI reset before ellipsis when ANSI codes are present', () => {
    setRenderContext({ isTTY: true, noColor: false, useUnicode: true, width: 80 });
    const colored = `\x1B[31m${'a'.repeat(20)}\x1B[0m`;
    const result = truncateLine(colored, 10);
    // reset sequence should appear before ellipsis
    const resetIdx = result.indexOf('\x1B[0m');
    const ellipsisIdx = result.lastIndexOf(ELLIPSIS);
    expect(resetIdx).toBeGreaterThan(-1);
    expect(resetIdx).toBeLessThan(ellipsisIdx);
  });

  it('returns exact maxWidth visible chars when truncating (unicode)', () => {
    setRenderContext({ isTTY: true, noColor: false, useUnicode: true, width: 80 });
    const result = truncateLine('b'.repeat(50), 15);
    expect(visibleWidth(result)).toBe(15);
  });

  it('returns exact maxWidth visible chars when truncating (ascii)', () => {
    setRenderContext({ isTTY: false, noColor: true, useUnicode: false, width: 80 });
    const result = truncateLine('b'.repeat(50), 15);
    expect(visibleWidth(result)).toBe(15);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// describe('renderDashboardCardGrid')
// ─────────────────────────────────────────────────────────────────────────────

describe('renderDashboardCardGrid', () => {
  afterEach(() => {
    resetRenderContext();
  });

  // ── AC6: Two-column grid ─────────────────────────────────────────────────

  describe('AC6: two-column grid (width >= 80)', () => {
    beforeEach(() => {
      setRenderContext({ isTTY: true, noColor: true, useUnicode: true, width: 80 });
    });

    it('places two cards side by side when width >= 80', () => {
      const cw = getCardWidthForGrid(80);
      const card1 = renderDashboardCard(makeCard({ title: 'Card1', width: cw }));
      const card2 = renderDashboardCard(makeCard({ title: 'Card2', width: cw }));
      const grid = renderDashboardCardGrid([card1, card2], 80);
      const firstGridLine = stripAnsi(grid.split('\n')[0]!);
      // Both card titles should appear on the same grid line
      expect(firstGridLine).toContain('Card1');
      expect(firstGridLine).toContain('Card2');
    });

    it('renders a single card alone when count is odd', () => {
      const cw = getCardWidthForGrid(80);
      const card1 = renderDashboardCard(makeCard({ title: 'Solo', width: cw }));
      const grid = renderDashboardCardGrid([card1], 80);
      expect(grid).toBe(card1);
    });

    it('computes card width from layout tier helper', () => {
      expect(getCardWidthForGrid(80)).toBe(39);
      expect(getCardWidthForGrid(120)).toBe(58);
      expect(getCardWidthForGrid(0)).toBe(0);
    });

    it('separates card pairs with CARD_GAP spaces', () => {
      const cw = getCardWidthForGrid(80);
      const card1 = renderDashboardCard(makeCard({ title: 'A', width: cw, lines: ['x'] }));
      const card2 = renderDashboardCard(makeCard({ title: 'B', width: cw, lines: ['y'] }));
      const grid = renderDashboardCardGrid([card1, card2], 80);
      const firstLine = stripAnsi(grid.split('\n')[0]!);
      // Line should be at least cw + CARD_GAP + cw chars wide
      expect(firstLine.length).toBeGreaterThanOrEqual(cw + CARD_GAP + cw);
    });

    it('renders four cards in two rows', () => {
      const cw = getCardWidthForGrid(80);
      const cards = ['A', 'B', 'C', 'D'].map((t) =>
        renderDashboardCard(makeCard({ title: t, width: cw })),
      );
      const grid = renderDashboardCardGrid(cards, 80);
      const stripped = stripAnsi(grid);
      expect(stripped).toContain('A');
      expect(stripped).toContain('B');
      expect(stripped).toContain('C');
      expect(stripped).toContain('D');
    });

    it('returns empty string for empty cards array at width >= 80', () => {
      const grid = renderDashboardCardGrid([], 80);
      expect(grid).toBe('');
    });
  });

  // ── AC7: Stacked layout ──────────────────────────────────────────────────

  describe('AC7: stacked layout (width < 80)', () => {
    it('stacks cards vertically when width < 80', () => {
      setRenderContext({ isTTY: true, noColor: true, useUnicode: true, width: 60 });
      const card1 = renderDashboardCard(makeCard({ title: 'C1', width: 60 }));
      const card2 = renderDashboardCard(makeCard({ title: 'C2', width: 60 }));
      const grid = renderDashboardCardGrid([card1, card2], 60);
      expect(grid).toBe(`${card1}\n\n${card2}`);
    });

    it('stacks cards when width < 60', () => {
      setRenderContext({ isTTY: true, noColor: true, useUnicode: true, width: 40 });
      const card1 = renderDashboardCard(makeCard({ title: 'A', width: 40 }));
      const card2 = renderDashboardCard(makeCard({ title: 'B', width: 40 }));
      const grid = renderDashboardCardGrid([card1, card2], 40);
      expect(grid).toBe(`${card1}\n${card2}`);
    });

    it('returns empty string for empty cards array', () => {
      setRenderContext({ isTTY: true, noColor: true, useUnicode: true, width: 60 });
      const grid = renderDashboardCardGrid([], 60);
      expect(grid).toBe('');
    });

    it('renders single card unchanged in stacked layout', () => {
      setRenderContext({ isTTY: true, noColor: true, useUnicode: true, width: 60 });
      const card = renderDashboardCard(makeCard({ title: 'Lone', width: 60 }));
      const grid = renderDashboardCardGrid([card], 60);
      expect(grid).toBe(card);
    });
  });

  // ── Width tier behavior ──────────────────────────────────────────────────

  describe('width tier behavior', () => {
    it('uses stacked layout at width 79 (below 80 threshold)', () => {
      setRenderContext({ isTTY: true, noColor: true, useUnicode: true, width: 79 });
      const card1 = renderDashboardCard(makeCard({ title: 'X', width: 79 }));
      const card2 = renderDashboardCard(makeCard({ title: 'Y', width: 79 }));
      const grid = renderDashboardCardGrid([card1, card2], 79);
      expect(grid).toBe(`${card1}\n\n${card2}`);
    });

    it('uses 2-column layout at width 80', () => {
      setRenderContext({ isTTY: true, noColor: true, useUnicode: true, width: 80 });
      const cw = getCardWidthForGrid(80);
      const card1 = renderDashboardCard(makeCard({ title: 'P', width: cw }));
      const card2 = renderDashboardCard(makeCard({ title: 'Q', width: cw }));
      const grid = renderDashboardCardGrid([card1, card2], 80);
      const firstLine = stripAnsi(grid.split('\n')[0]!);
      // Both titles appear on first line → 2-column
      expect(firstLine).toContain('P');
      expect(firstLine).toContain('Q');
    });

    it('uses 2-column layout at width 120 (wide tier)', () => {
      setRenderContext({ isTTY: true, noColor: true, useUnicode: true, width: 120 });
      const cw = getCardWidthForGrid(120);
      const card1 = renderDashboardCard(makeCard({ title: 'M', width: cw }));
      const card2 = renderDashboardCard(makeCard({ title: 'N', width: cw }));
      const grid = renderDashboardCardGrid([card1, card2], 120);
      const firstLine = stripAnsi(grid.split('\n')[0]!);
      expect(firstLine).toContain('M');
      expect(firstLine).toContain('N');
    });

    it('uses wider gap at width 120', () => {
      setRenderContext({ isTTY: true, noColor: true, useUnicode: true, width: 120 });
      const cw = getCardWidthForGrid(120);
      const card1 = renderDashboardCard(makeCard({ title: 'Wide1', width: cw }));
      const card2 = renderDashboardCard(makeCard({ title: 'Wide2', width: cw }));
      const grid = renderDashboardCardGrid([card1, card2], 120);
      const firstLine = stripAnsi(grid.split('\n')[0]!);
      expect(firstLine.length).toBeGreaterThanOrEqual(cw + CARD_GAP * 2 + cw);
    });
  });
});
