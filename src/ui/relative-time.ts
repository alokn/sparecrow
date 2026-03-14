/** Relative time formatter for human-readable timestamps. */

/** Formats an ISO 8601 timestamp as a human-readable relative time string.
 *
 * Returns "just now" for very recent timestamps, "Xm ago", "Xh ago", "Xd ago",
 * or "unknown" for invalid date strings. */
export function formatRelativeTime(isoStr: string): string {
  const ts = new Date(isoStr);
  if (Number.isNaN(ts.getTime())) return 'unknown';
  const diff = Date.now() - ts.getTime();
  if (diff < 0) return 'just now';
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
