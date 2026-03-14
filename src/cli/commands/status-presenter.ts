/** Status presenter — composes dashboard cards from status data. */
import type {
  StatusSnapshot,
  StatusUsage,
  DaemonState,
  AuthState,
  DaemonBackendState,
} from '../../types/index.js';
import {
  renderDashboardCard,
  renderDashboardCardGrid,
  getCardWidthForGrid,
  renderStatusIndicator,
  renderErrorBlock,
  renderHintLine,
  getRenderContext,
  renderLogSummaryRow,
  renderUtilizationReport,
  humanizeErrorCode,
  getContextualHint,
  truncateLine,
  formatRelativeTime,
} from '../../ui/index.js';
import type { DashboardCardState, StatusState, DiagnosticIssue } from '../../ui/index.js';

export interface PresenterOptions {
  all: boolean;
  detail: boolean;
  explain: boolean;
}

export function renderStatusOutput(data: StatusSnapshot, options: PresenterOptions): string {
  const ctx = getRenderContext();
  const cardWidth = ctx.width >= 80 ? getCardWidthForGrid(ctx.width) : ctx.width;

  const healthCard = renderHealthCard(data, cardWidth);
  const usageCard = renderUsageCard(data, options, cardWidth);
  const queueCard = renderQueueCard(data, options, cardWidth);
  const activityCard = renderActivityCard(data, options, cardWidth);

  const grid = renderDashboardCardGrid([healthCard, usageCard, queueCard, activityCard]);

  const parts: string[] = [grid];

  if (options.explain) {
    parts.push(renderExplainBlock(data.usage));
  }

  const hint = getHintLine(data, options);
  if (hint) parts.push(hint);

  return parts.join('\n\n');
}

function renderHealthCard(data: StatusSnapshot, width: number): string {
  const { health } = data;
  const state = healthCardState(health.daemon, health.auth, data.backendState);

  const lines: string[] = [];
  const daemonRecovery = getDaemonRecovery(health.daemon);
  lines.push(
    renderStatusIndicator({
      state: daemonStatusState(health.daemon),
      label: 'Daemon',
      value: formatDaemonState(health.daemon),
      ...(daemonRecovery !== undefined ? { recovery: daemonRecovery } : {}),
    }),
  );
  const authRecovery = getAuthRecovery(health.auth);
  lines.push(
    renderStatusIndicator({
      state: authStatusState(health.auth),
      label: 'Auth',
      value: formatAuthState(health.auth),
      ...(authRecovery !== undefined ? { recovery: authRecovery } : {}),
    }),
  );

  // Backend state rendering (AC5)
  if (data.backendState !== null) {
    const bs = data.backendState;
    const backendIndicator = renderBackendStatusIndicator(bs);
    lines.push(backendIndicator);
  }

  // Story 10.6 AC1: Surface daemon lastErrorDetail in health card
  const errorDetail = data.health.lastErrorDetail;
  if (errorDetail !== null) {
    const errorBlockProps: { severity: 'critical'; message: string; recovery?: string } = {
      severity: 'critical',
      message: `Error: ${humanizeErrorCode(errorDetail.code)}`,
    };
    if (errorDetail.recoveryCommand !== null) {
      errorBlockProps.recovery = errorDetail.recoveryCommand;
    }
    lines.push(renderErrorBlock(errorBlockProps));
  }

  return renderDashboardCard({
    title: 'Health',
    lines,
    state,
    variant: 'compact',
    width,
  });
}

function renderBackendStatusIndicator(bs: DaemonBackendState): string {
  if (!bs.available) {
    return renderStatusIndicator({
      state: 'error',
      label: 'Backend',
      value: 'container (unavailable)',
      recovery: 'Restart Docker/Podman to restore container execution',
    });
  }
  // Available
  const runtimeLabel = bs.runtime ?? 'container';
  const versionSuffix = bs.version ? ` ${bs.version}` : '';
  return renderStatusIndicator({
    state: 'healthy',
    label: 'Backend',
    value: `container (${runtimeLabel}${versionSuffix})`,
  });
}

function renderUsageCard(data: StatusSnapshot, options: PresenterOptions, width: number): string {
  const { usage } = data;
  const hasData = usage.sessionUtilization !== null || usage.weeklyUtilization !== null;
  const ctx = getRenderContext();
  const innerWidth = Math.max(0, width - 4);

  if (!hasData) {
    return renderDashboardCard({
      title: 'Usage',
      lines: ['No data yet'],
      state: 'healthy',
      variant: 'compact',
      width,
    });
  }

  const isExpanded = options.all || options.detail;

  if (isExpanded) {
    // Full capacity dashboard in --detail or --all mode
    const lines: string[] = [];

    // Weekly bar + available
    if (usage.weeklyUtilization !== null) {
      const bar = renderProgressBar(usage.weeklyUtilization, 10, ctx.useUnicode);
      let line = `Weekly:   ${bar}  ${formatPercent(usage.weeklyUtilization)} used`;
      if (usage.availableBudget !== null) {
        line += `  |  Available: ${formatPercentSigned(usage.availableBudget)}`;
      }
      if (usage.weeklyResetsAt) {
        line += `  |  Resets in ${formatTimeUntil(usage.weeklyResetsAt)}`;
      }
      lines.push(line);
    }

    // Reserve bar
    if (usage.effectiveReserve !== null) {
      const bar = renderProgressBar(usage.effectiveReserve, 10, ctx.useUnicode);
      lines.push(`Reserve:  ${bar}  ${formatPercent(usage.effectiveReserve)}`);
    } else if (usage.wastePotential === null) {
      lines.push(`Reserve:  No capacity data yet`);
    }

    // Waste bar
    if (usage.wastePotential !== null) {
      const bar = renderProgressBar(usage.wastePotential, 10, ctx.useUnicode);
      lines.push(`Waste:    ${bar}  ${formatPercent(usage.wastePotential)} risk`);
    } else {
      lines.push(`Waste:    No capacity data yet`);
    }

    // 5h Rate bar (session)
    if (usage.sessionUtilization !== null) {
      const bar = renderProgressBar(usage.sessionUtilization, 10, ctx.useUnicode);
      let line = `5h Rate:  ${bar}  ${formatPercent(usage.sessionUtilization)}`;
      if (usage.sessionResetsAt) {
        line += `  |  Resets in ${formatTimeUntil(usage.sessionResetsAt)}`;
      }
      if (usage.rateHeadroom !== null) {
        line += usage.rateHeadroom ? `  [ok]` : `  [full]`;
      }
      lines.push(line);
    }

    // Dispatch reason line
    const dispatchLabel = buildDispatchLabel(usage);
    lines.push(`Dispatch: ${dispatchLabel}`);

    if (options.all) {
      // Show source/confidence in --all view
      if (usage.source) {
        lines.push(`Source:   ${usage.source}${usage.confidence ? ` (${usage.confidence})` : ''}`);
      }
      if (usage.subscriptionTier) {
        lines.push(`Tier:     ${usage.subscriptionTier}`);
      }
      if (usage.weeklyResetsAt) {
        lines.push(`Weekly resets: ${formatTimeUntil(usage.weeklyResetsAt)}`);
      }
      if (usage.degradedReason) {
        lines.push(`Note: ${usage.degradedReason}`);
      }
      // Idle hours schedule
      if (usage.idleHoursSchedule !== null) {
        const idleStatus = usage.isIdleHours === true ? 'active' : 'inactive';
        lines.push(`Idle hours: ${usage.idleHoursSchedule} | currently ${idleStatus}`);
      } else {
        lines.push(`Idle hours: none configured`);
      }
      // Per-model waste
      if (usage.perModelWaste && usage.perModelWaste.length > 0) {
        for (const { model, waste } of usage.perModelWaste) {
          lines.push(`  ${model}: ${formatPercent(waste)} waste risk`);
        }
      }
      // Dispatch reason untruncated
      if (usage.dispatchReason) {
        lines.push(`Reason:   ${usage.dispatchReason}`);
      }
    }

    const state = usageCardState(
      usage.sessionUtilization,
      usage.weeklyUtilization,
      usage.wastePotential,
    );

    return renderDashboardCard({
      title: 'Usage',
      lines,
      state,
      variant: 'expanded',
      width,
    });
  }

  // Compact mode (no --detail/--all): 5-line layout truncated to COMPACT_MAX=4.
  // Lines 0–3 are freshness, session, weekly, and waste risk.
  // Line 4 (dispatch) is intentionally pushed but silently dropped by COMPACT_MAX=4;
  // use --detail or --all to see the dispatch indicator.
  const lines: string[] = [];

  // Line 0: Data freshness
  lines.push(buildFreshnessLine(usage, hasData));

  // Line 1: Session utilization
  if (usage.sessionUtilization !== null) {
    lines.push(`Session: ${formatPercent(usage.sessionUtilization)}`);
  }

  // Line 2: Weekly utilization (with available budget inline if space allows)
  if (usage.weeklyUtilization !== null) {
    let weeklyLine = `Weekly:  ${formatPercent(usage.weeklyUtilization)}`;
    if (usage.availableBudget !== null) {
      weeklyLine += ` | available: ${formatPercentSigned(usage.availableBudget)}`;
    }
    lines.push(weeklyLine);
  }

  // Line 3: Waste risk (or placeholder)
  if (usage.wastePotential !== null) {
    lines.push(`Waste:   ${formatPercent(usage.wastePotential)} risk`);
  } else if (hasData) {
    lines.push(`Waste:   No capacity data yet`);
  }

  // Line 4: Dispatch reason (truncated)
  const dispatchLabel = buildDispatchLabel(usage);
  const dispatchLine = `Dispatch: ${dispatchLabel}`;
  lines.push(truncateLine(dispatchLine, innerWidth));

  const state = usageCardState(
    usage.sessionUtilization,
    usage.weeklyUtilization,
    usage.wastePotential,
  );

  return renderDashboardCard({
    title: 'Usage',
    lines,
    state,
    variant: 'compact',
    width,
  });
}

/** Builds the data freshness line for the Usage Card compact view.
 *
 * Shows "Updated Xm ago" when lastPolledAt is non-null.
 * Appends degradation info when source is not "oauth" or confidence is not "high".
 * Returns "No data yet" when there is genuinely no data (hasData=false and lastPolledAt=null).
 * Returns "Data age unknown" when utilization data exists but lastPolledAt is null (mixed state). */
function buildFreshnessLine(usage: StatusUsage, hasData: boolean): string {
  if (usage.lastPolledAt === null) {
    // If utilization data exists but we have no poll timestamp, say "Data age unknown"
    // to avoid the contradiction of "No data yet" appearing above real percentages.
    return hasData ? 'Data age unknown' : 'No data yet';
  }
  const relTime = formatRelativeTime(usage.lastPolledAt);
  const base = `Updated ${relTime}`;

  // Append source/confidence annotation when not in healthy state.
  // null source is treated as degraded (unknown provider), not healthy.
  // null confidence is treated as non-degraded (absence of explicit low confidence).
  const isHealthySource = usage.source === 'oauth';
  const isHighConfidence = usage.confidence === 'high' || usage.confidence === null;
  if (!isHealthySource || !isHighConfidence) {
    const srcLabel = usage.source ?? 'unknown';
    const confLabel = usage.confidence ?? 'unknown';
    return `${base} · ${srcLabel} (${confLabel} confidence)`;
  }

  return base;
}

/** Builds the dispatch label showing [active]/[paused]/-- state.
 *
 * Uses structured fields (wastePotential, isIdleHours, availableBudget) to produce
 * a short, human-readable summary. The raw `dispatchReason` string from TriggerEngine
 * is designed for audit logs — it is NOT used as the compact label here. */
function buildDispatchLabel(usage: StatusUsage): string {
  if (usage.shouldDispatch === null) {
    return '--';
  }
  if (usage.shouldDispatch) {
    if (usage.isIdleHours) {
      const schedule = usage.idleHoursSchedule ? ` (${usage.idleHoursSchedule})` : '';
      return `[active] Idle hours${schedule}`;
    }
    // Waste potential dispatch path — use a short structured label
    if (usage.wastePotential !== null) {
      return `[active] Waste risk ${formatPercent(usage.wastePotential)}`;
    }
    return `[active] dispatching`;
  }
  // paused
  if (usage.availableBudget !== null && usage.availableBudget < 0) {
    return `[paused] Below reserve (budget: ${formatPercentSigned(usage.availableBudget)})`;
  }
  if (usage.wastePotential !== null) {
    return `[paused] Waste risk too low (${formatPercent(usage.wastePotential)})`;
  }
  return `[paused] not dispatching`;
}

/** Renders a plain-English explanation block for the dispatch decision. */
export function renderExplainBlock(
  usage: StatusUsage,
  _config?: { maxWastePercentage?: number },
): string {
  const hasAnyCapacity =
    usage.wastePotential !== null ||
    usage.effectiveReserve !== null ||
    usage.availableBudget !== null;

  // Data freshness sentence (AC6) — shown whenever lastPolledAt is non-null,
  // independent of whether capacity data has arrived yet (Medium-5 fix).
  const freshnessLines: string[] = [];
  if (usage.lastPolledAt !== null) {
    const relTime = formatRelativeTime(usage.lastPolledAt);
    const src = usage.source ?? 'unknown';
    const conf = usage.confidence ?? 'unknown';
    freshnessLines.push(
      `Usage data was last refreshed ${relTime} (source: ${src}, confidence: ${conf}).`,
    );
    freshnessLines.push('');
  }

  if (!hasAnyCapacity) {
    const noCapMsg = 'No capacity data available yet. Start the daemon to begin monitoring.';
    if (freshnessLines.length > 0) {
      return [...freshnessLines, noCapMsg].join('\n').trimEnd();
    }
    return noCapMsg;
  }

  const parts: string[] = [...freshnessLines];

  // Idle hours dispatch path explanation — shown when dispatch is active via idle hours
  if (usage.isIdleHours && usage.shouldDispatch) {
    const schedule = usage.idleHoursSchedule ? ` (${usage.idleHoursSchedule})` : '';
    parts.push(
      `Idle Hours${schedule}: dispatch is active because the current time falls within a configured idle window.`,
    );
    parts.push(
      `Idle-hours dispatch ignores waste-risk thresholds — it runs whenever available budget > 0.`,
    );
    parts.push('');
  }

  if (usage.wastePotential !== null) {
    parts.push(
      `Waste Risk: ${formatPercent(usage.wastePotential)} -- ${formatPercent(usage.wastePotential)} of your weekly capacity will expire when the window resets${usage.weeklyResetsAt ? ` in ${formatTimeUntil(usage.weeklyResetsAt)}` : ''}.`,
    );
    if (usage.dispatchReason) {
      parts.push(`Dispatch reason: ${usage.dispatchReason}`);
    }
    parts.push('');
  }

  if (usage.effectiveReserve !== null) {
    parts.push(
      `Reserve: ${formatPercentSigned(usage.effectiveReserve)} -- ${formatPercentSigned(usage.effectiveReserve)} of your weekly budget is reserved for your own work.`,
    );
    parts.push('This reserve decays to 0% as the weekly reset approaches.');
    parts.push('');
  }

  if (usage.availableBudget !== null) {
    const reserveStr =
      usage.effectiveReserve !== null ? formatPercentSigned(usage.effectiveReserve) : '--';
    const remainingStr =
      usage.weeklyUtilization !== null ? formatPercentSigned(1 - usage.weeklyUtilization) : '--';
    parts.push(
      `Available: ${formatPercentSigned(usage.availableBudget)} -- After subtracting the reserve (${reserveStr}) from remaining budget (${remainingStr}),`,
    );
    parts.push(
      `${formatPercentSigned(usage.availableBudget)} is available for automated dispatch.`,
    );
  }

  return parts.join('\n').trimEnd();
}

/** Renders a fixed-width progress bar. */
export function renderProgressBar(fraction: number, barWidth: number, useUnicode: boolean): string {
  if (barWidth <= 0) return '';
  const clamped = Math.min(1, Math.max(0, fraction));
  const filled = Math.round(clamped * barWidth);
  const empty = barWidth - filled;
  const filledChar = useUnicode ? '█' : '|';
  const emptyChar = useUnicode ? '░' : '.';
  return filledChar.repeat(filled) + emptyChar.repeat(empty);
}

function renderQueueCard(data: StatusSnapshot, options: PresenterOptions, width: number): string {
  const { queue } = data;
  const lines: string[] = [];

  // Story 10.9 AC4: Three-variant display based on runningCount and pendingCount
  if (queue.runningCount > 0 && queue.pendingCount > 0) {
    lines.push(`${queue.runningCount} running, ${queue.pendingCount} pending`);
  } else if (queue.runningCount > 0 && queue.pendingCount === 0) {
    lines.push(`${queue.runningCount} running`);
  } else {
    lines.push(`${queue.pendingCount} pending`);
  }

  if (options.all && queue.taskNames.length > 0) {
    for (const name of queue.taskNames) {
      lines.push(`  ${name}`);
    }
  }

  return renderDashboardCard({
    title: 'Queue',
    lines,
    state: 'healthy',
    variant: options.all || options.detail ? 'expanded' : 'compact',
    width,
  });
}

function renderActivityCard(
  data: StatusSnapshot,
  options: PresenterOptions,
  width: number,
): string {
  const { activity } = data;

  if (activity.dispatchCount === 0) {
    return renderDashboardCard({
      title: 'Activity',
      lines: ['No dispatches yet'],
      state: 'healthy',
      variant: 'compact',
      width,
    });
  }

  const lines: string[] = [];
  lines.push(`Dispatches: ${activity.dispatchCount}`);
  if (activity.successRate !== null) {
    lines.push(`Success:    ${formatPercent(activity.successRate)}`);
  }
  lines.push(
    `ROI:        ${renderUtilizationReport({
      variant: 'compact',
      dollarValueRecovered: activity.dollarValueRecovered,
      utilizationPercent: data.usage.weeklyUtilization,
    })}`,
  );

  // Story 10.6 AC2: Show failure breakdown grouped by humanized error reason
  const failureBreakdown = buildFailureBreakdown(activity.recentDispatches);
  if (failureBreakdown.length > 0) {
    const verbose = options.all;
    const parts = failureBreakdown.map((fb) => {
      const humanMsg = humanizeErrorCode(fb.code);
      return verbose ? `${fb.count} ${humanMsg} (${fb.code})` : `${fb.count} ${humanMsg}`;
    });
    lines.push(`Recent failures: ${parts.join(', ')}`);
  }

  if (options.all && activity.recentDispatches.length > 0) {
    lines.push('');
    for (const row of activity.recentDispatches) {
      // Story 10.6 AC2: For failed rows, use humanized error as failureReason instead of raw summary
      const failureReason =
        row.outcome !== 'success' && row.errorCode ? humanizeErrorCode(row.errorCode) : row.summary;
      const rowLines = renderLogSummaryRow({
        outcome: row.outcome,
        taskName: row.task,
        relativeTime: row.relativeTime,
        duration: row.duration,
        targetPath: row.targetPath,
        ...(row.outcome === 'success' ? { summary: row.summary } : { failureReason }),
        variant: 'summary',
      });
      // renderLogSummaryRow may return one or two lines; push each as a separate line.
      for (const l of rowLines.split('\n')) {
        lines.push(l);
      }
    }
  }

  const state: DashboardCardState =
    activity.successRate !== null && activity.successRate < 0.5 ? 'warning' : 'healthy';

  return renderDashboardCard({
    title: 'Activity',
    lines,
    state,
    variant: options.all || options.detail ? 'expanded' : 'compact',
    width,
  });
}

/** Builds failure breakdown from recent dispatch rows, grouped by error code. */
function buildFailureBreakdown(
  dispatches: StatusSnapshot['activity']['recentDispatches'],
): Array<{ code: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of dispatches) {
    if (row.outcome !== 'success' && row.errorCode) {
      counts.set(row.errorCode, (counts.get(row.errorCode) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries()).map(([code, count]) => ({ code, count }));
}

function getHintLine(data: StatusSnapshot, options: PresenterOptions): string {
  // Story 10.6 AC6: Hints suppressed in non-TTY output (piped mode)
  const ctx = getRenderContext();
  if (!ctx.isTTY) return '';

  if (data.health.daemon === 'not-started') {
    return renderHintLine('Run sparecrow onboard to get started');
  }

  // Story 10.6 AC6: Surface diagnostic hints when problems detected
  const issues = detectDiagnosticIssues(data);
  const contextualHint = getContextualHint(issues);
  if (contextualHint !== null) {
    return renderHintLine(contextualHint);
  }

  if (!options.all && !options.detail) {
    return renderHintLine('Run sparecrow status --all for activity detail');
  }
  return renderHintLine('Run sparecrow logs --task <name> for full task details');
}

/** Detects active diagnostic issues from a status snapshot for hint prioritization. */
function detectDiagnosticIssues(data: StatusSnapshot): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];
  if (data.health.auth === 'expired' || data.health.auth === 'missing') {
    issues.push('auth_failure');
  }
  if (data.health.lastErrorDetail !== null) {
    // Don't double-count auth-related errors as daemon_error
    const code = data.health.lastErrorDetail.code;
    if (
      code !== 'AUTH_TOKEN_EXPIRED' &&
      code !== 'AUTH_TOKEN_MISSING' &&
      code !== 'DAEMON_AUTH_FAILED'
    ) {
      issues.push('daemon_error');
    }
  }
  const hasFailures = data.activity.recentDispatches.some((d) => d.outcome !== 'success');
  if (hasFailures) {
    issues.push('task_failures');
  }
  if (data.usage.degradedReason !== null) {
    issues.push('degraded_polling');
  }
  return issues;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatPercentSigned(value: number): string {
  const pct = (value * 100).toFixed(1);
  return `${pct}%`;
}

function formatTimeUntil(isoStr: string): string {
  const target = new Date(isoStr);
  if (Number.isNaN(target.getTime())) return 'unknown';
  const diff = target.getTime() - Date.now();
  if (diff <= 0) return 'now';
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function formatDaemonState(state: DaemonState): string {
  switch (state) {
    case 'running':
      return 'running';
    case 'stopped':
      return 'stopped';
    case 'not-started':
      return 'not started';
    case 'unknown':
      return 'unknown';
  }
}

function formatAuthState(state: AuthState): string {
  switch (state) {
    case 'valid':
      return 'valid';
    case 'expired':
      return 'expired';
    case 'missing':
      return 'missing';
    case 'unknown':
      return 'unknown';
  }
}

function daemonStatusState(state: DaemonState): StatusState {
  switch (state) {
    case 'running':
      return 'healthy';
    case 'stopped':
      return 'error';
    case 'not-started':
      return 'info';
    case 'unknown':
      return 'unknown';
  }
}

function authStatusState(state: AuthState): StatusState {
  switch (state) {
    case 'valid':
      return 'healthy';
    case 'expired':
      return 'error';
    case 'missing':
      return 'error';
    case 'unknown':
      return 'unknown';
  }
}

function healthCardState(
  daemon: DaemonState,
  auth: AuthState,
  backendState?: DaemonBackendState | null,
): DashboardCardState {
  if (auth === 'expired' || auth === 'missing' || daemon === 'stopped') return 'error';
  if (backendState && !backendState.available) return 'warning';
  if (daemon === 'running' && auth === 'valid') return 'healthy';
  return 'warning';
}

export function usageCardState(
  session: number | null,
  weekly: number | null,
  wastePotential?: number | null,
): DashboardCardState {
  const max = Math.max(session ?? 0, weekly ?? 0);
  if (max >= 0.7) return 'warning';
  // AC8.7: High waste risk triggers warning state
  if (wastePotential !== null && wastePotential !== undefined && wastePotential >= 0.7)
    return 'warning';
  return 'healthy';
}

function getDaemonRecovery(state: DaemonState): string | undefined {
  if (state === 'stopped') return 'daemon start';
  return undefined;
}

function getAuthRecovery(state: AuthState): string | undefined {
  if (state === 'expired' || state === 'missing') return 'config --reconnect';
  return undefined;
}
