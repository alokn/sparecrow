/** Renders a structured error block with severity, message, and recovery command. */
import { color } from './colors.js';
import { getTokens, INDENT } from './tokens.js';
import { getRenderContext } from './render-context.js';

export type ErrorSeverity = 'critical' | 'warning' | 'info';

export interface ErrorBlockProps {
  severity: ErrorSeverity;
  message: string;
  impact?: string;
  recovery?: string; // full command, e.g. "sparecrow config --reconnect"
}

export function renderErrorBlock(props: ErrorBlockProps): string {
  const { severity, message, impact, recovery } = props;
  const tokens = getTokens();
  const { noColor } = getRenderContext();

  let prefix: string;
  if (noColor) {
    prefix =
      severity === 'critical'
        ? tokens.DOT_ERR
        : severity === 'warning'
          ? tokens.DOT_WARN
          : tokens.DOT_INFO;
  } else {
    const icon = tokens.CHECK_FAIL; // ✗
    const infoIcon = tokens.INFO_MARK;
    prefix =
      severity === 'critical'
        ? color.red(icon)
        : severity === 'warning'
          ? color.yellow(icon)
          : color.cyan(infoIcon);
  }

  const lines: string[] = [`${prefix} ${message}`];
  if (impact) lines.push(`${INDENT}${color.dim(impact)}`);
  if (recovery) lines.push(`${INDENT}${tokens.ARROW} Run: ${color.cyan(recovery)}`);

  return lines.join('\n');
}
