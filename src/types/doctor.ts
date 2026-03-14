/** Type definitions for the doctor diagnostic command. */

/** Severity level for a diagnostic finding. */
export type DoctorSeverity = 'critical' | 'warning' | 'ok';

/** Status of a diagnostic check execution. */
export type DoctorStatus = 'pass' | 'fail' | 'warn';

/** Deterministic check key — defines the canonical ordering for diagnostics. */
export type DoctorCheckKey =
  | 'auth-token-validity'
  | 'claude-installation'
  | 'usage-endpoint-connectivity'
  | 'config-validity'
  | 'service-installation-state'
  | 'target-repo-accessibility'
  | 'queue-file-integrity'
  | 'log-directory-permissions'
  | 'container-runtime-detection'
  | 'container-rootless-mode'
  | 'container-test-run'
  | 'container-credential-mount'
  | 'container-custom-image-claude';

/** Canonical ordering of check keys — determines deterministic execution and display order. */
export const DOCTOR_CHECK_ORDER: readonly DoctorCheckKey[] = [
  'auth-token-validity',
  'claude-installation',
  'usage-endpoint-connectivity',
  'config-validity',
  'service-installation-state',
  'target-repo-accessibility',
  'queue-file-integrity',
  'log-directory-permissions',
  'container-runtime-detection',
  'container-rootless-mode',
  'container-test-run',
  'container-credential-mount',
  'container-custom-image-claude',
] as const;

/** Container check keys — used to conditionally skip container diagnostics. */
export const CONTAINER_CHECK_KEYS: ReadonlySet<DoctorCheckKey> = new Set<DoctorCheckKey>([
  'container-runtime-detection',
  'container-rootless-mode',
  'container-test-run',
  'container-credential-mount',
  'container-custom-image-claude',
]);

/** A single diagnostic finding — all fields always present (null when not applicable). */
export interface DoctorFinding {
  checkKey: DoctorCheckKey;
  checkName: string;
  severity: DoctorSeverity;
  status: DoctorStatus;
  message: string;
  fixCommand: string | null;
  durationMs: number;
  details: string | null;
}

/** Summary counts for doctor output. */
export interface DoctorSummary {
  criticalCount: number;
  warningCount: number;
  okCount: number;
  totalChecks: number;
}

/** Full doctor result payload for JSON mode data field. */
export interface DoctorResult {
  findings: DoctorFinding[];
  summary: DoctorSummary;
}

/** Human-readable check name mapping. */
export const DOCTOR_CHECK_NAMES: Record<DoctorCheckKey, string> = {
  'auth-token-validity': 'Auth Token Validity',
  'claude-installation': 'Claude Code Installation',
  'usage-endpoint-connectivity': 'Usage Endpoint Connectivity',
  'config-validity': 'Configuration Validity',
  'service-installation-state': 'Service Installation State',
  'target-repo-accessibility': 'Target Repository Accessibility',
  'queue-file-integrity': 'Queue File Integrity',
  'log-directory-permissions': 'Log Directory Permissions',
  'container-runtime-detection': 'Container Runtime Detection',
  'container-rootless-mode': 'Container Rootless Mode',
  'container-test-run': 'Container Test Run',
  'container-credential-mount': 'Container Credential Mount',
  'container-custom-image-claude': 'Container Custom Image Claude Availability',
};
