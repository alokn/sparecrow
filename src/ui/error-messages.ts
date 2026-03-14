/** Maps error codes to human-readable conversational messages for CLI display. */

/**
 * Human-readable error messages keyed by error code string.
 * Used for user-facing output where codes should be hidden behind friendly language.
 * Codes not in this map fall back to lowercase-with-spaces formatting.
 */
const HUMAN_MESSAGES: Record<string, string> = {
  AUTH_TOKEN_EXPIRED: 'authentication token expired',
  AUTH_TOKEN_MISSING: 'authentication not configured',
  AUTH_TOKEN_FORMAT_CHANGED: 'authentication token format changed',
  CLAUDE_NOT_FOUND: 'Claude CLI not found',
  TASK_EXECUTION_FAILED: 'task execution failed',
  TASK_TIMEOUT: 'task execution timed out',
  DAEMON_AUTH_FAILED: 'daemon authentication failed',
  PROVIDER_UNREACHABLE: 'usage provider unreachable',
  PROVIDER_NOT_FOUND: 'unknown provider configured',
  CONFIG_INVALID: 'configuration error',
  CONFIG_NOT_FOUND: 'configuration file not found',
  CONFIG_RELOAD_PRESERVED: 'config reload failed',
  DAEMON_SPAWN_FAILED: 'daemon failed to start',
  DAEMON_POLL_FAILED: 'usage polling failed',
  DAEMON_RELOAD_FAILED: 'daemon reload failed',
  DAEMON_DEGRADED: 'daemon operating in degraded mode',
  DAEMON_LOOP_EXITED: 'daemon loop exited unexpectedly',
  QUOTA_EXHAUSTED: 'quota or rate limit reached',
  BACKEND_NOT_AVAILABLE: 'execution backend unavailable',
  CONTAINER_RUNTIME_ERROR: 'container runtime error',
  CONTAINER_RUNTIME_NOT_FOUND: 'container runtime not found',
  CONTAINER_RUNTIME_UNAVAILABLE: 'container runtime unavailable',
};

/** Optional context passed to humanizeErrorCode for codes that need runtime values. */
export interface HumanizeContext {
  /** Actual configured container memory limit in MB. Used for TASK_OOM_KILLED message. */
  memoryLimitMb?: number;
}

/**
 * Converts an error code to a human-readable message.
 * Returns the mapped message if one exists, otherwise converts the code
 * to lowercase with underscores replaced by spaces.
 *
 * For TASK_OOM_KILLED, pass `context.memoryLimitMb` to display the actual
 * configured limit instead of the schema default (512 MB).
 */
export function humanizeErrorCode(code: string, context?: HumanizeContext): string {
  if (code === 'TASK_OOM_KILLED') {
    const limitMb = context?.memoryLimitMb ?? 512;
    return `container ran out of memory (${limitMb} MB limit) — increase: \`scrow config set provider.container.memory_limit_mb ${limitMb * 2}\``;
  }

  const mapped = HUMAN_MESSAGES[code];
  if (mapped !== undefined) {
    return mapped;
  }
  // Fallback: lowercase, replace underscores with spaces
  return code.toLowerCase().replace(/_/g, ' ');
}
