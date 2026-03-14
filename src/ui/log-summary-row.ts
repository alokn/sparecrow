/** Renders a scannable single-row (or two-line) summary of a task execution result. */
import { getRenderContext } from './render-context.js';
import { color } from './colors.js';
import { visibleWidth, stripAnsi } from './ansi-utils.js';

/** Outcome state for a LogSummaryRow. */
export type LogSummaryRowOutcome = 'success' | 'failed' | 'retrying';

/** Display variant for a LogSummaryRow. */
export type LogSummaryRowVariant = 'summary' | 'compact';

/** Props for renderLogSummaryRow. */
export interface LogSummaryRowProps {
  /** Outcome of the task execution. */
  outcome: LogSummaryRowOutcome;
  /** Human-readable task name. */
  taskName: string;
  /** Pre-formatted relative time string, e.g. "10m ago". */
  relativeTime: string;
  /** Pre-formatted duration string, e.g. "45s". Only shown in summary variant. */
  duration: string;
  /** Target path the task ran against. Only shown in summary variant. */
  targetPath: string;
  /**
   * Optional one-line findings summary for successful outcomes.
   * Rendered as an indented second line in summary variant.
   */
  summary?: string;
  /**
   * Optional failure reason for failed/retrying outcomes.
   * Rendered as an indented second line in summary variant.
   */
  failureReason?: string;
  /** Rendering variant. Defaults to 'summary' when omitted. */
  variant?: LogSummaryRowVariant;
}

/**
 * Returns the outcome marker for the given outcome and render context.
 *
 * Component-owned mapping (AC4):
 *   noColor (regardless of unicode) => [PASS] / [FAIL] / [RETRY]
 *   color + unicode                 => ✓ / ✗ (with semantic color)
 *   color + ascii                   => [PASS] / [FAIL] (no unicode glyphs)
 */
function outcomeMarker(outcome: LogSummaryRowOutcome): string {
  const { noColor, useUnicode } = getRenderContext();

  if (noColor) {
    // In noColor mode always use text labels — unicode must not produce ANSI-colored glyphs.
    if (outcome === 'success') return '[PASS]';
    if (outcome === 'retrying') return '[RETRY]';
    return '[FAIL]';
  }

  // Color mode — use unicode glyphs when available, ASCII labels otherwise.
  if (useUnicode) {
    if (outcome === 'success') return color.green('✓');
    if (outcome === 'retrying') return color.yellow('✗');
    return color.red('✗');
  }

  // Color + ASCII: styled text labels.
  if (outcome === 'success') return color.green('[PASS]');
  if (outcome === 'retrying') return color.yellow('[RETRY]');
  return color.red('[FAIL]');
}

/**
 * Returns the styled task name.
 * In noColor mode returns plain text; in color mode applies bold+magenta.
 */
function styledTaskName(name: string): string {
  const { noColor } = getRenderContext();
  if (noColor) return name;
  return color.bold(color.magenta(name));
}

/**
 * Returns the styled relative time.
 * In noColor mode returns plain text; in color mode applies cyan.
 */
function styledTime(relativeTime: string): string {
  const { noColor } = getRenderContext();
  if (noColor) return relativeTime;
  return color.cyan(relativeTime);
}

/** Maximum visible characters for a targetPath on the summary line. */
const MAX_TARGET_VISIBLE = 40;

/** Maximum visible characters for a taskName on any line. */
const MAX_TASK_VISIBLE = 30;

/**
 * Truncates a string to at most `maxVisible` visible characters, appending an ellipsis if cut.
 * Uses Unicode ellipsis '…' when useUnicode is true, ASCII '...' otherwise.
 * Preserves ANSI codes in the prefix by operating on the stripped representation.
 */
function truncateVisible(s: string, maxVisible: number): string {
  if (visibleWidth(s) <= maxVisible) return s;
  // Truncate the plain text version and re-apply (for plain strings this is straightforward).
  const plain = stripAnsi(s);
  if (plain.length <= maxVisible) return s;
  const { useUnicode } = getRenderContext();
  const ellipsis = useUnicode ? '…' : '...';
  return plain.slice(0, maxVisible - ellipsis.length) + ellipsis;
}

/**
 * Renders a LogSummaryRow as one or two lines.
 *
 * Summary variant (used for status --all and logs default):
 *   Line 1: <marker> <taskName>  <relativeTime>  <duration>  <targetPath>
 *   Line 2 (optional): "  <summary or failureReason>"
 *
 * Compact variant (reserved for future constrained-width surfaces):
 *   Line 1: <marker> <taskName>  <relativeTime>
 */
export function renderLogSummaryRow(props: LogSummaryRowProps): string {
  const {
    outcome,
    taskName,
    relativeTime,
    duration,
    targetPath,
    summary,
    failureReason,
    variant = 'summary',
  } = props;

  const { truncationEnabled } = getRenderContext();
  const marker = outcomeMarker(outcome);
  const rawName = truncationEnabled ? truncateVisible(taskName, MAX_TASK_VISIBLE) : taskName;
  const name = styledTaskName(rawName);
  const time = styledTime(relativeTime);

  if (variant === 'compact') {
    return `${marker} ${name}  ${time}`;
  }

  // Summary variant: include duration and targetPath on line 1.
  const truncatedTarget = truncationEnabled
    ? truncateVisible(targetPath, MAX_TARGET_VISIBLE)
    : targetPath;
  const line1 = `${marker} ${name}  ${time}  ${duration}  ${truncatedTarget}`;

  // Optional second line: findings (success) or failure reason (failed/retrying).
  let secondLine: string | null = null;
  if (outcome === 'success' && summary && summary !== '-') {
    secondLine = `  ${summary}`;
  } else if (
    (outcome === 'failed' || outcome === 'retrying') &&
    failureReason &&
    failureReason !== '-'
  ) {
    secondLine = `  ${failureReason}`;
  } else if (outcome === 'retrying') {
    secondLine = `  (queued for retry)`;
  }

  if (secondLine !== null) {
    return `${line1}\n${secondLine}`;
  }

  return line1;
}
