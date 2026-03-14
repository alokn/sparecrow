/** TaskDetailCard UI component — renders a bordered detail card for a single task execution. */
import { getRenderContext } from './render-context.js';
import { getTokens } from './tokens.js';
import { color } from './colors.js';
import { visibleWidth } from './ansi-utils.js';
import { truncateLine } from './dashboard-card.js';
import type { LogOutcome } from '../types/index.js';

/** A single structured finding attached to a completed task. */
export interface TaskDetailFinding {
  /** Short label or category for the finding. */
  label: string;
  /** Human-readable description of the finding. */
  detail: string;
}

/** Props for renderTaskDetailCard. */
export interface TaskDetailCardProps {
  /** ISO 8601 timestamp of when the task started. */
  timestamp: string;
  /** Typed outcome of the task execution. */
  outcome: LogOutcome;
  /** Human-readable task name. */
  taskName: string;
  /** Unique task identifier (nullable — renders N/A when absent). */
  taskId: string | null;
  /** Target repository or path the task ran against (nullable). */
  targetPath: string | null;
  /** Duration in milliseconds (nullable). */
  durationMs: number | null;
  /** Process exit code (nullable). */
  exitCode: number | null;
  /** Tokens consumed from the context (nullable). */
  tokensIn: number | null;
  /** Tokens produced in the response (nullable). */
  tokensOut: number | null;
  /** Provider identifier (nullable). */
  provider: string | null;
  /** Source identifier (nullable). */
  source: string | null;
  /** Error message when outcome is non-success (nullable). */
  error: string | null;
  /** Summary text; empty string renders as "none". */
  summary: string;
  /** Optional structured findings — rendered only for success outcomes and when non-empty. */
  findings?: TaskDetailFinding[];
  /** Card width in characters. Defaults to render context width. */
  width?: number;
}

const LABEL_WIDTH = 12; // fixed label column width for alignment
const MAX_ERROR_CHARS = 200; // sanitization limit for error field rendering
const MAX_FINDING_CHARS = 200; // sanitization limit for finding label/detail rendering

/** Formats a duration in milliseconds as "Xm Ys" or "N/A" when invalid/absent. */
export function formatDuration(ms: number | null): string {
  if (ms === null || ms < 0 || !Number.isFinite(ms)) return 'N/A';
  const totalSec = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** Returns the appropriate ellipsis string based on the current render context. */
function getEllipsis(): string {
  return getRenderContext().useUnicode ? '…' : '...';
}

/** Sanitizes an error string for safe rendering — truncates long content. */
function sanitizeError(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_ERROR_CHARS) return trimmed;
  const ellipsis = getEllipsis();
  return trimmed.slice(0, MAX_ERROR_CHARS - (ellipsis.length - 1)) + ellipsis;
}

/** Sanitizes a finding label or detail string — enforces single-line and truncates long content. */
function sanitizeFindingText(text: string): string {
  // Collapse multi-line content to single line to prevent card border alignment issues.
  const singleLine = text.replace(/[\r\n]+/g, ' ').trim();
  if (singleLine.length <= MAX_FINDING_CHARS) return singleLine;
  const ellipsis = getEllipsis();
  return singleLine.slice(0, MAX_FINDING_CHARS - (ellipsis.length - 1)) + ellipsis;
}

/** Renders a card content line wrapped in side borders at the given innerWidth. */
function renderContentLine(
  text: string,
  lBorder: string,
  rBorder: string,
  innerWidth: number,
  truncationEnabled: boolean,
): string {
  let rendered = text;
  if (truncationEnabled && visibleWidth(rendered) > innerWidth) {
    // Use ANSI-aware truncateLine to avoid slicing mid-escape-sequence.
    rendered = truncateLine(rendered, innerWidth);
  }
  const vis = visibleWidth(rendered);
  const padding = Math.max(0, innerWidth - vis);
  return `${lBorder} ${rendered}${' '.repeat(padding)} ${rBorder}`;
}

/** Builds a plain label:padded + value row string. */
function buildRow(label: string, value: string): string {
  const paddedLabel = `${label}:`.padEnd(LABEL_WIDTH);
  return `${paddedLabel}${value}`;
}

/**
 * Renders a bordered task detail card for a single task execution entry.
 * Returns a multi-line string; never writes directly to stdout.
 */
export function renderTaskDetailCard(props: TaskDetailCardProps): string {
  const ctx = getRenderContext();
  const tokens = getTokens();
  const { BOX_TL, BOX_TR, BOX_BL, BOX_BR, BOX_H, BOX_V } = tokens;

  const width = props.width ?? ctx.width;
  const innerWidth = Math.max(0, width - 4); // │ + space on each side

  // Build top border with title
  const titleText = 'Task Detail';
  const maxTitleLen = Math.max(1, width - 6);
  const titleEllipsis = ctx.useUnicode ? '…' : '...';
  const displayTitle =
    titleText.length > maxTitleLen
      ? titleText.slice(0, maxTitleLen - titleEllipsis.length) + titleEllipsis
      : titleText;

  const fillCount = Math.max(1, width - 5 - displayTitle.length);
  const fill = BOX_H.repeat(fillCount);

  const topBorder = ctx.noColor
    ? `${BOX_TL}${BOX_H} ${displayTitle} ${fill}${BOX_TR}`
    : `${BOX_TL}${BOX_H} ${color.boldWhite(displayTitle)} ${fill}${BOX_TR}`;

  const bottomBorder = `${BOX_BL}${BOX_H.repeat(width - 2)}${BOX_BR}`;

  const lBorder = BOX_V;
  const rBorder = BOX_V;

  const lines: string[] = [];

  /** Push a labeled row into the card. */
  const addRow = (label: string, value: string): void => {
    const rowText = buildRow(label, value);
    lines.push(renderContentLine(rowText, lBorder, rBorder, innerWidth, ctx.truncationEnabled));
  };

  // Status — color-coded for outcome
  let statusValue: string;
  if (ctx.noColor) {
    statusValue = props.outcome;
  } else if (props.outcome === 'success') {
    statusValue = color.green(props.outcome);
  } else if (props.outcome === 'failed' || props.outcome === 'unknown') {
    statusValue = color.red(props.outcome);
  } else {
    // quota, retrying
    statusValue = color.yellow(props.outcome);
  }
  addRow('Status', statusValue);

  addRow('Task', props.taskName);
  addRow('Task ID', props.taskId ?? 'N/A');
  addRow('Target', props.targetPath ?? 'N/A');
  addRow('Started', props.timestamp);
  addRow('Duration', formatDuration(props.durationMs));
  addRow('Exit Code', props.exitCode !== null ? String(props.exitCode) : 'N/A');
  addRow('Tokens In', props.tokensIn !== null ? String(props.tokensIn) : 'N/A');
  addRow('Tokens Out', props.tokensOut !== null ? String(props.tokensOut) : 'N/A');
  addRow('Provider', props.provider ?? 'N/A');
  addRow('Source', props.source ?? 'N/A');

  // Error — sanitized; null renders as "none"
  addRow('Error', props.error !== null ? sanitizeError(props.error) : 'none');

  // Summary — empty string renders as "none"
  addRow('Summary', props.summary || 'none');

  // Findings section — only for success outcome with explicitly supplied non-empty findings
  const showFindings =
    props.outcome === 'success' && props.findings !== undefined && props.findings.length > 0;

  if (showFindings && props.findings !== undefined) {
    const divider = BOX_H.repeat(innerWidth);
    lines.push(renderContentLine(divider, lBorder, rBorder, innerWidth, ctx.truncationEnabled));

    const findingsHeader = ctx.noColor ? 'Findings:' : color.boldWhite('Findings:');
    lines.push(
      renderContentLine(findingsHeader, lBorder, rBorder, innerWidth, ctx.truncationEnabled),
    );

    for (const finding of props.findings) {
      const safeLabel = sanitizeFindingText(finding.label);
      const safeDetail = sanitizeFindingText(finding.detail);
      const findingText = `  ${safeLabel}: ${safeDetail}`;
      lines.push(
        renderContentLine(findingText, lBorder, rBorder, innerWidth, ctx.truncationEnabled),
      );
    }
  }

  // Full log footer row — always present
  const idOrName = props.taskId ?? props.taskName;
  const fullLogCmd = `sparecrow logs --task ${idOrName} --full`;
  const fullLogValue = ctx.noColor ? fullLogCmd : color.dim(fullLogCmd);
  const fullLogRow = `${'Full log:'.padEnd(LABEL_WIDTH)}${fullLogValue}`;
  lines.push(renderContentLine(fullLogRow, lBorder, rBorder, innerWidth, ctx.truncationEnabled));

  return [topBorder, ...lines, bottomBorder].join('\n');
}
