/** Generates systemd user unit file content for the sparecrow daemon. */
import type { ServiceTemplateOpts } from '../../types/index.js';

/**
 * Quotes a value for use in a systemd unit ExecStart or Environment directive.
 * Systemd uses C-style quoting: wrap in double-quotes and escape backslash, double-quote.
 * Additionally, `%` is doubled to `%%` because systemd expands `%X` sequences (e.g., `%h`, `%u`)
 * as unit specifiers — a literal `%` in a path would otherwise be silently expanded.
 * This ensures values with spaces, quotes, and percent signs are safe in unit files.
 * Exported for direct unit testing of edge cases.
 */
export function quoteForSystemd(value: string): string {
  // 1. Escape backslashes first (must be before other replacements to avoid double-escaping)
  // 2. Escape double-quotes
  // 3. Double percent signs to prevent systemd specifier expansion
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');
  return `"${escaped}"`;
}

/** Generates a systemd user unit file string for the daemon service. */
export function generateSystemdUnit(opts: ServiceTemplateOpts): string {
  const { nodePath, entrypoint, configPath, dataPath, daemonRunnerFlag } = opts;

  return `[Unit]
Description=sparecrow daemon
After=network.target

[Service]
Type=simple
ExecStart=${quoteForSystemd(nodePath)} ${quoteForSystemd(entrypoint)} ${quoteForSystemd(daemonRunnerFlag)}
Restart=on-failure
RestartSec=10
KillMode=control-group
TimeoutStopSec=15
Environment=NODE_ENV=production
Environment=SPARECROW_CONFIG_PATH=${quoteForSystemd(configPath)}
Environment=SPARECROW_DATA_PATH=${quoteForSystemd(dataPath)}

[Install]
WantedBy=default.target
`;
}
