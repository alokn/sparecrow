/** UI module barrel — re-exports all public UI rendering functions and types. */

export { getRenderContext, setRenderContext, resetRenderContext } from './render-context.js';
export type { RenderContext } from './render-context.js';

export { getTokens, MIN_WIDTH, CARD_WIDTH, CARD_GAP, INDENT } from './tokens.js';

export { color } from './colors.js';

export { renderStatusIndicator } from './status-indicator.js';
export type { StatusState, StatusIndicatorProps } from './status-indicator.js';

export { renderErrorBlock } from './error-block.js';
export type { ErrorSeverity, ErrorBlockProps } from './error-block.js';

export { renderHintLine } from './hint-line.js';

export { renderSectionDivider } from './section-divider.js';

export { printJson } from './json-output.js';

export { createSpinner } from './spinner.js';
export type { Spinner } from './spinner.js';

export {
  renderDashboardCard,
  renderDashboardCardGrid,
  getCardWidthForGrid,
  truncateLine,
} from './dashboard-card.js';
export type { DashboardCardState, DashboardCardProps } from './dashboard-card.js';

export { visibleWidth, stripAnsi } from './ansi-utils.js';

export { renderLogSummaryRow } from './log-summary-row.js';
export type {
  LogSummaryRowOutcome,
  LogSummaryRowVariant,
  LogSummaryRowProps,
} from './log-summary-row.js';

export { renderTaskDetailCard, formatDuration as formatTaskDuration } from './task-detail-card.js';
export type { TaskDetailCardProps, TaskDetailFinding } from './task-detail-card.js';

export { renderUtilizationReport, INSUFFICIENT_DATA_MESSAGE } from './utilization-report.js';
export type { UtilizationReportProps, UtilizationBreakdownRow } from './utilization-report.js';

export { humanizeErrorCode } from './error-messages.js';
export type { HumanizeContext } from './error-messages.js';

export { getContextualHint } from './diagnostic-hint.js';
export type { DiagnosticIssue } from './diagnostic-hint.js';

export { formatRelativeTime } from './relative-time.js';
