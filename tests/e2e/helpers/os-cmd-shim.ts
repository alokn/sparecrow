/** Creates executable systemctl/launchctl bash shims for E2E tests. */
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// [AI-Review][Low] Shims validate $1 (and $2 for --user flag) to surface wrong-subcommand regressions.
// systemctl is called with: --user daemon-reload | --user enable <name> | --user disable <name>
// launchctl is called with: load <path> | unload <path>
const SHIM_SCRIPTS: Record<'ok' | 'fail', Record<'systemctl' | 'launchctl', string>> = {
  ok: {
    systemctl: `#!/usr/bin/env bash
# E2E OS-command shim — systemctl ok mode (simulates systemctl success)
# Validates that the first argument is '--user' (all sparecrow systemctl calls use --user)
if [ "$1" != "--user" ]; then
  echo "shim: unexpected systemctl invocation: $*" >&2
  exit 2
fi
exit 0
`,
    launchctl: `#!/usr/bin/env bash
# E2E OS-command shim — launchctl ok mode (simulates launchctl success)
# Validates that the first argument is 'load' or 'unload'
if [ "$1" != "load" ] && [ "$1" != "unload" ]; then
  echo "shim: unexpected launchctl invocation: $*" >&2
  exit 2
fi
exit 0
`,
  },
  fail: {
    systemctl: `#!/usr/bin/env bash
# E2E OS-command shim — systemctl fail mode (simulates systemctl failure)
echo "mock systemctl failure" >&2
exit 1
`,
    launchctl: `#!/usr/bin/env bash
# E2E OS-command shim — launchctl fail mode (simulates launchctl failure)
echo "mock launchctl failure" >&2
exit 1
`,
  },
};

/**
 * Writes executable bash shims for `systemctl` and `launchctl` to
 * `homeDir/os-bin/`. Callers should prepend the returned directory
 * path to `PATH` via `envOverrides` when invoking `runCli`.
 *
 * @param homeDir - The isolated HOME directory for the test
 * @param mode - Shim behaviour: 'ok' (exit 0) or 'fail' (exit 1 with stderr)
 * @returns The absolute path to the shim directory (callers prepend to PATH)
 */
export async function osCmdShim(homeDir: string, mode: 'ok' | 'fail'): Promise<string> {
  const binDir = join(homeDir, 'os-bin');
  await mkdir(binDir, { recursive: true });

  const systemctlPath = join(binDir, 'systemctl');
  const launchctlPath = join(binDir, 'launchctl');

  await writeFile(systemctlPath, SHIM_SCRIPTS[mode].systemctl, 'utf8');
  await writeFile(launchctlPath, SHIM_SCRIPTS[mode].launchctl, 'utf8');

  await chmod(systemctlPath, 0o755);
  await chmod(launchctlPath, 0o755);

  return binDir;
}
