/** Generates launchd LaunchAgent plist content for the sparecrow daemon. */
import type { ServiceTemplateOpts } from '../../types/index.js';

/** Escapes XML special characters for safe interpolation into plist string values. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Generates a macOS launchd LaunchAgent plist string for the daemon service. */
export function generateLaunchdPlist(opts: ServiceTemplateOpts): string {
  const { nodePath, entrypoint, configPath, dataPath, daemonRunnerFlag } = opts;
  const stdoutLog = `${dataPath}/logs/daemon.log`;
  const stderrLog = `${dataPath}/logs/daemon-error.log`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.sparecrow.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(entrypoint)}</string>
    <string>${escapeXml(daemonRunnerFlag)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SPARECROW_CONFIG_PATH</key>
    <string>${escapeXml(configPath)}</string>
    <key>SPARECROW_DATA_PATH</key>
    <string>${escapeXml(dataPath)}</string>
  </dict>
  <key>ExitTimeOut</key>
  <integer>15</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutLog)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrLog)}</string>
</dict>
</plist>
`;
}
