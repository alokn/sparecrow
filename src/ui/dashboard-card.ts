/** Dashboard card component for rendering bordered, state-styled status cards. */
import { getRenderContext } from './render-context.js';
import { getTokens, CARD_GAP } from './tokens.js';
import { color } from './colors.js';
import { visibleWidth } from './ansi-utils.js';

export type DashboardCardState = 'healthy' | 'warning' | 'error';

export interface DashboardCardProps {
  title: string;
  lines: string[];
  footerLine?: string;
  state: DashboardCardState;
  variant: 'compact' | 'expanded';
  width?: number;
}

const COMPACT_MAX = 4;
const WIDE_GRID_MIN_WIDTH = 120;
const GRID_BREAKPOINT = 80;
const COMPACT_BREAKPOINT = 60;

/**
 * Truncates a string to maxWidth visible characters (ANSI-aware).
 * Appends an ellipsis character if truncated; uses Unicode ellipsis when useUnicode is true,
 * ASCII '...' otherwise. Closes any open ANSI sequences.
 */
export function truncateLine(line: string, maxWidth: number, useUnicode?: boolean): string {
  if (maxWidth <= 0) return '';
  if (visibleWidth(line) <= maxWidth) return line;

  // Determine ellipsis based on unicode support; default to context value when not specified
  const unicode = useUnicode !== undefined ? useUnicode : getRenderContext().useUnicode;
  const ellipsis = unicode ? '…' : '...';
  const ellipsisWidth = unicode ? 1 : 3;

  const budget = maxWidth - ellipsisWidth;
  if (budget <= 0) return ellipsis.slice(0, maxWidth);

  let visible = 0;
  let result = '';
  let i = 0;
  let hasAnsi = false;

  while (i < line.length) {
    if (line[i] === '\x1B' && i + 1 < line.length && line[i + 1] === '[') {
      hasAnsi = true;
      let j = i + 2;
      while (j < line.length && !/[A-Za-z]/.test(line[j]!)) j++;
      j++;
      result += line.slice(i, j);
      i = j;
    } else {
      if (visible >= budget) break;
      result += line[i];
      visible++;
      i++;
    }
  }

  const reset = hasAnsi ? '\x1B[0m' : '';
  return result + reset + ellipsis;
}

/**
 * Returns body lines for the given variant.
 * Height alignment (padding to COMPACT_MAX) only applies to compact mode — all compact cards
 * are padded to exactly COMPACT_MAX lines so grid rows have uniform height.
 * Expanded mode returns lines as-is; heights vary by content and are NOT aligned across grid
 * columns. This is intentional: expanded cards show all detail rows by design.
 */
function getBodyLines(props: DashboardCardProps): string[] {
  const { lines, variant } = props;
  if (variant === 'compact') {
    const out = lines.slice(0, COMPACT_MAX);
    while (out.length < COMPACT_MAX) out.push('');
    return out;
  }
  return [...lines];
}

/**
 * Renders a bordered DashboardCard with state-appropriate styling.
 * Returns a multi-line string; does not write to stdout.
 */
export function renderDashboardCard(props: DashboardCardProps): string {
  const ctx = getRenderContext();
  const { noColor, truncationEnabled } = ctx;
  const tokens = getTokens();
  const { BOX_TL, BOX_TR, BOX_BL, BOX_BR, BOX_H, BOX_V } = tokens;

  const width = props.width ?? ctx.width;
  const innerWidth = Math.max(0, width - 4); // │ + space on each side

  // Compute display title, adding NO_COLOR state prefix when applicable
  let displayTitle = props.title;
  if (noColor) {
    if (props.state === 'error') displayTitle = `${props.title} [ERR]`;
    else if (props.state === 'warning') displayTitle = `${props.title} [WARN]`;
  }

  // Ensure title fits; truncate when card is too narrow for the title
  const maxTitleLen = Math.max(1, width - 6); // width - (TL+H+sp+sp+fill+TR) min
  const titleEllipsis = ctx.useUnicode ? '…' : '...';
  if (displayTitle.length > maxTitleLen) {
    displayTitle = displayTitle.slice(0, maxTitleLen - titleEllipsis.length) + titleEllipsis;
  }

  const titleLen = displayTitle.length;
  const fillCount = Math.max(1, width - 5 - titleLen);
  const fill = BOX_H.repeat(fillCount);

  // Build top border with state-appropriate title coloring
  let topBorder: string;
  if (noColor) {
    topBorder = `${BOX_TL}${BOX_H} ${displayTitle} ${fill}${BOX_TR}`;
  } else if (props.state === 'error') {
    // Entire top border (title + border chars) is red
    topBorder = color.red(`${BOX_TL}${BOX_H} ${displayTitle} ${fill}${BOX_TR}`);
  } else if (props.state === 'warning') {
    topBorder = `${BOX_TL}${BOX_H} ${color.yellow(displayTitle)} ${fill}${BOX_TR}`;
  } else {
    topBorder = `${BOX_TL}${BOX_H} ${color.boldWhite(displayTitle)} ${fill}${BOX_TR}`;
  }

  // Build bottom border, red-tinted for error state
  const bottomRaw = `${BOX_BL}${BOX_H.repeat(width - 2)}${BOX_BR}`;
  const bottomBorder = !noColor && props.state === 'error' ? color.red(bottomRaw) : bottomRaw;

  // Side border chars, red-tinted for error state
  const lBorder = !noColor && props.state === 'error' ? color.red(BOX_V) : BOX_V;
  const rBorder = !noColor && props.state === 'error' ? color.red(BOX_V) : BOX_V;

  // Build content lines
  const bodyLines = getBodyLines(props);
  const contentLines = bodyLines.map((line) => {
    let rendered = line;
    if (truncationEnabled) {
      rendered = truncateLine(rendered, innerWidth);
    }
    const vis = visibleWidth(rendered);
    const padding = Math.max(0, innerWidth - vis);
    return `${lBorder} ${rendered}${' '.repeat(padding)} ${rBorder}`;
  });

  return [topBorder, ...contentLines, bottomBorder].join('\n');
}

/**
 * Arranges pre-rendered card strings into a responsive grid layout.
 * Width >= 80: 2-column with CARD_GAP spacing.
 * Width < 80: single-column stacked.
 */
export function getCardWidthForGrid(width: number): number {
  if (width <= 0) return 0;
  const gap = width >= WIDE_GRID_MIN_WIDTH ? CARD_GAP * 2 : CARD_GAP;
  return Math.max(0, Math.floor((width - gap) / 2));
}

/**
 * Renders an array of pre-rendered card strings in a 2-column grid.
 * Height alignment between paired cards only works when both cards are in compact mode
 * (all compact cards are padded to COMPACT_MAX lines by getBodyLines). In expanded mode
 * (--all flag), cards have variable heights by design and the grid does NOT align row heights.
 */
export function renderDashboardCardGrid(cards: string[], width?: number): string {
  const ctx = getRenderContext();
  const w = width ?? ctx.width;

  if (w < GRID_BREAKPOINT) {
    const separator = w < COMPACT_BREAKPOINT ? '\n' : '\n\n';
    return cards.join(separator);
  }

  // 2-column layout
  const gapSize = w >= WIDE_GRID_MIN_WIDTH ? CARD_GAP * 2 : CARD_GAP;
  const gap = ' '.repeat(gapSize);
  const cardWidth = getCardWidthForGrid(w);
  const rows: string[] = [];

  for (let i = 0; i < cards.length; i += 2) {
    const left = cards[i]!;
    const right = i + 1 < cards.length ? cards[i + 1]! : null;

    if (right === null) {
      rows.push(left);
      continue;
    }

    const leftLines = left.split('\n');
    const rightLines = right.split('\n');
    const maxLen = Math.max(leftLines.length, rightLines.length);

    const rowLines: string[] = [];
    for (let j = 0; j < maxLen; j++) {
      const lLine = leftLines[j] ?? '';
      const rLine = rightLines[j] ?? '';
      const lVis = visibleWidth(lLine);
      const lPad = Math.max(0, cardWidth - lVis);
      rowLines.push(`${lLine}${' '.repeat(lPad)}${gap}${rLine}`);
    }
    rows.push(rowLines.join('\n'));
  }

  return rows.join('\n\n');
}
