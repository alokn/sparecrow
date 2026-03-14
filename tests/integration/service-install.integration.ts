/** Integration test stub for service installation — requires a live systemd/launchd environment.
 *  These tests are deferred and NOT run in CI. They require:
 *  - Linux: a running systemd user session (`systemctl --user status` must succeed)
 *  - macOS: a launchd user session (standard macOS desktop environment)
 *
 * To run manually: npx vitest run tests/integration/service-install.integration.ts
 */

// NOTE: These tests are intentionally skipped — they require a real systemd/launchd environment.
// AC4 (auto-start on system boot) is satisfied at unit test level by verifying that generated
// service files contain `WantedBy=default.target` (Linux) and `RunAtLoad` (macOS).

import { describe, it } from 'vitest';

describe('service installation integration (deferred)', () => {
  it.skip('Linux: sparecrow daemon install generates valid systemd unit file and enables auto-start', () => {
    // Requires: systemctl --user status to succeed
    // 1. Call installService({ force: true })
    // 2. Verify service file exists at ~/.config/systemd/user/sparecrow.service
    // 3. Run: systemctl --user is-enabled sparecrow → should output 'enabled'
    // 4. Call uninstallService() to clean up
  });

  it.skip('macOS: sparecrow daemon install generates valid plist and loads via launchctl', () => {
    // Requires: macOS with launchd available
    // 1. Call installService({ force: true })
    // 2. Verify plist file exists at ~/Library/LaunchAgents/com.sparecrow.daemon.plist
    // 3. Run: launchctl list com.sparecrow.daemon → should return the service
    // 4. Call uninstallService() to clean up
  });

  it.skip('Linux: sparecrow daemon uninstall removes service file and disables auto-start', () => {
    // Requires: systemctl --user status to succeed
    // 1. Install service first
    // 2. Call uninstallService()
    // 3. Verify service file is removed
    // 4. Run: systemctl --user is-enabled sparecrow → should fail (not enabled)
  });
});
