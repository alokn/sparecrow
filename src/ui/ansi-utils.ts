/** ANSI utility helpers for stripping escape codes and measuring visible width. */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;

/** Strips ANSI escape sequences from a string. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/** Returns visible character count (ignoring ANSI codes). */
export function visibleWidth(s: string): number {
  return stripAnsi(s).length;
}
