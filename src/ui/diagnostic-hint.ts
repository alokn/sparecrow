/** Priority-based contextual hint engine — returns a single highest-priority hint for CLI output. */

/**
 * Diagnostic issue types detected from CLI data.
 * Priority order (highest first): auth_failure > daemon_error > task_failures > degraded_polling.
 */
export type DiagnosticIssue =
  | 'auth_failure'
  | 'daemon_error'
  | 'task_failures'
  | 'degraded_polling';

/** Priority order — lower index = higher priority. */
const PRIORITY_ORDER: DiagnosticIssue[] = [
  'auth_failure',
  'daemon_error',
  'task_failures',
  'degraded_polling',
];

/** Hint text for each issue type. */
const HINT_MAP: Record<DiagnosticIssue, string> = {
  auth_failure: "Run 'sparecrow config --reconnect' to re-authenticate",
  daemon_error: "Run 'sparecrow doctor' to diagnose",
  task_failures: "Run 'sparecrow logs --failures' for details",
  degraded_polling: "Run 'sparecrow doctor' to check system health",
};

/**
 * Accepts a list of detected diagnostic issues and returns the single
 * highest-priority hint string, or null if no issues are present.
 *
 * Only one hint is ever returned (D2 — no stacking).
 */
export function getContextualHint(issues: DiagnosticIssue[]): string | null {
  if (issues.length === 0) return null;

  const issueSet = new Set(issues);
  // PRIORITY_ORDER is exhaustive over all DiagnosticIssue variants — a match is always found
  // when issueSet is non-empty, so find() always returns a defined value here.
  const match = PRIORITY_ORDER.find((issue) => issueSet.has(issue));
  return match !== undefined ? HINT_MAP[match] : null;
}
