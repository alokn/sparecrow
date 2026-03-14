/** Renders a single-line status indicator with optional recovery hint. */
import { color } from './colors.js';
import { getTokens, INDENT } from './tokens.js';
import { getRenderContext } from './render-context.js';

export type StatusState = 'healthy' | 'warning' | 'error' | 'info' | 'unknown';

export interface StatusIndicatorProps {
  state: StatusState;
  label: string;
  value: string;
  recovery?: string; // e.g. "config --reconnect" — will be prefixed with "Run: sparecrow "
}

export function renderStatusIndicator(props: StatusIndicatorProps): string {
  const { state, label, value, recovery } = props;
  const tokens = getTokens();
  const { noColor } = getRenderContext();

  let dot: string;
  if (noColor) {
    dot =
      state === 'healthy'
        ? tokens.DOT_OK
        : state === 'warning'
          ? tokens.DOT_WARN
          : state === 'error'
            ? tokens.DOT_ERR
            : state === 'unknown'
              ? '[??] '
              : tokens.DOT_INFO;
  } else {
    const rawDot =
      state === 'healthy'
        ? tokens.DOT_OK
        : state === 'warning'
          ? tokens.DOT_WARN
          : state === 'error'
            ? tokens.DOT_ERR
            : state === 'unknown'
              ? tokens.DOT_INFO
              : tokens.DOT_INFO;
    dot =
      state === 'healthy'
        ? color.green(rawDot)
        : state === 'warning'
          ? color.yellow(rawDot)
          : state === 'error'
            ? color.red(rawDot)
            : state === 'unknown'
              ? color.dim(rawDot)
              : color.cyan(rawDot);
    dot += ' ';
  }

  const labelStr = noColor ? `${label}:` : color.bold(`${label}:`);
  let line = `${dot}${labelStr} ${value}`;

  if (recovery) {
    line += `\n${INDENT}${tokens.ARROW} Run: sparecrow ${recovery}`;
  }

  return line;
}
