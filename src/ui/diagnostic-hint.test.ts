/** Tests for diagnostic-hint.ts — priority-based contextual hint engine. */
import { describe, it, expect } from 'vitest';
import { getContextualHint } from './diagnostic-hint.js';
import type { DiagnosticIssue } from './diagnostic-hint.js';

describe('getContextualHint', () => {
  it('returns null for empty issues array', () => {
    expect(getContextualHint([])).toBeNull();
  });

  it('returns auth_failure hint when only auth issue present', () => {
    expect(getContextualHint(['auth_failure'])).toBe(
      "Run 'sparecrow config --reconnect' to re-authenticate",
    );
  });

  it('returns daemon_error hint when only daemon issue present', () => {
    expect(getContextualHint(['daemon_error'])).toBe("Run 'sparecrow doctor' to diagnose");
  });

  it('returns task_failures hint when only task failures present', () => {
    expect(getContextualHint(['task_failures'])).toBe(
      "Run 'sparecrow logs --failures' for details",
    );
  });

  it('returns degraded_polling hint when only polling issue present', () => {
    expect(getContextualHint(['degraded_polling'])).toBe(
      "Run 'sparecrow doctor' to check system health",
    );
  });

  it('returns auth_failure hint when auth and task failures both present (priority)', () => {
    const issues: DiagnosticIssue[] = ['task_failures', 'auth_failure'];
    expect(getContextualHint(issues)).toBe("Run 'sparecrow config --reconnect' to re-authenticate");
  });

  it('returns daemon_error hint over task_failures when both present', () => {
    const issues: DiagnosticIssue[] = ['task_failures', 'daemon_error'];
    expect(getContextualHint(issues)).toBe("Run 'sparecrow doctor' to diagnose");
  });

  it('returns auth_failure over all others when all present', () => {
    const issues: DiagnosticIssue[] = [
      'degraded_polling',
      'task_failures',
      'daemon_error',
      'auth_failure',
    ];
    expect(getContextualHint(issues)).toBe("Run 'sparecrow config --reconnect' to re-authenticate");
  });

  it('returns task_failures over degraded_polling', () => {
    const issues: DiagnosticIssue[] = ['degraded_polling', 'task_failures'];
    expect(getContextualHint(issues)).toBe("Run 'sparecrow logs --failures' for details");
  });

  it('handles duplicate issues gracefully', () => {
    const issues: DiagnosticIssue[] = ['task_failures', 'task_failures'];
    expect(getContextualHint(issues)).toBe("Run 'sparecrow logs --failures' for details");
  });
});
