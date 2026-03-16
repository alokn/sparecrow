/** Utilities for sanitizing command arguments in error messages. */

/** Maximum character length for the joined args string before truncation. */
const MAX_ARGS_LENGTH = 200;

/** Truncation suffix appended when args exceed MAX_ARGS_LENGTH. */
const TRUNCATION_SUFFIX = '...[truncated]';

/** Redaction placeholder for sensitive argument values. */
const REDACTED = '[REDACTED]';

/**
 * Argument name prefixes whose *following* value should be redacted.
 * Matches both `--token VALUE` (two-element) and `--token=VALUE` (single-element) forms.
 */
const SENSITIVE_FLAG_PREFIXES: readonly string[] = [
  '--token',
  '--password',
  '--secret',
  '--auth',
  '--credential',
  '--api-key',
  '--apikey',
];

/**
 * Substrings that, when found anywhere in a single argument, cause redaction.
 * Case-insensitive matching is applied.
 */
const SENSITIVE_VALUE_PATTERNS: readonly string[] = ['bearer'];

/**
 * Returns true if the argument value itself matches a sensitive pattern.
 */
function containsSensitiveValue(arg: string): boolean {
  const lower = arg.toLowerCase();
  return SENSITIVE_VALUE_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Sanitizes an array of command-line arguments for safe inclusion in error messages.
 *
 * - Redacts values of known sensitive flags (e.g., `--token`, `--password`).
 * - Redacts arguments containing sensitive value patterns (e.g., `Bearer`).
 * - Handles both `--flag=value` and `--flag value` (two-element) forms.
 *
 * The returned array has the same length as the input.
 */
export function sanitizeArgs(args: readonly string[]): string[] {
  const result: string[] = [];
  let redactNext = false;

  for (const arg of args) {
    if (redactNext) {
      result.push(REDACTED);
      redactNext = false;
      continue;
    }

    const lower = arg.toLowerCase();

    // Check for --flag=value form first (preserves flag name even if value matches a bearer pattern)
    let handled = false;
    for (const prefix of SENSITIVE_FLAG_PREFIXES) {
      if (lower.startsWith(`${prefix}=`)) {
        result.push(`${arg.slice(0, arg.indexOf('=') + 1)}${REDACTED}`);
        handled = true;
        break;
      }
    }
    if (handled) continue;

    // Check sensitive value patterns (e.g., Bearer tokens not tied to a known flag)
    if (containsSensitiveValue(arg)) {
      result.push(REDACTED);
      continue;
    }

    // Check for --flag value (two-element) form — flag without '=' means next arg is the value
    let isSensFlag = false;
    for (const prefix of SENSITIVE_FLAG_PREFIXES) {
      if (lower === prefix) {
        isSensFlag = true;
        break;
      }
    }

    if (isSensFlag) {
      result.push(arg);
      redactNext = true;
      continue;
    }

    result.push(arg);
  }

  return result;
}

/**
 * Formats command arguments for an error message, applying sanitization and truncation.
 *
 * 1. Redacts sensitive argument values.
 * 2. Joins with spaces.
 * 3. Truncates to MAX_ARGS_LENGTH if needed.
 */
export function formatArgsForError(args: readonly string[]): string {
  const sanitized = sanitizeArgs(args);
  const joined = sanitized.join(' ');

  if (joined.length <= MAX_ARGS_LENGTH) {
    return joined;
  }

  return joined.slice(0, MAX_ARGS_LENGTH) + TRUNCATION_SUFFIX;
}
