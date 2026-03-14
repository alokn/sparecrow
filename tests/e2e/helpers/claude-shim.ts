/** Creates an executable bash shim at homeDir/bin/claude for E2E tests. */
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const OK_OUTPUT = `{"type":"result","subtype":"success","result":"E2E mock response","is_error":false,"usage":{"input_tokens":10,"output_tokens":20}}`;

const SHIM_SCRIPTS: Record<'ok' | 'auth-fail' | 'slow', string> = {
  ok: `#!/usr/bin/env bash
# E2E mock claude shim — 'ok' mode
echo '${OK_OUTPUT}'
exit 0
`,
  'auth-fail': `#!/usr/bin/env bash
# E2E mock claude shim — 'auth-fail' mode
echo 'not logged in' >&2
exit 1
`,
  slow: `#!/usr/bin/env bash
# E2E mock claude shim — 'slow' mode
sleep 5
echo '${OK_OUTPUT}'
exit 0
`,
};

/**
 * Writes an executable bash shim at `homeDir/bin/claude`.
 *
 * Callers should prepend `homeDir/bin` to `PATH` via `envOverrides`
 * when invoking `runCli` — this helper does not modify PATH.
 *
 * @param homeDir - The isolated HOME directory for the test
 * @param mode - Shim behaviour: 'ok' (exit 0), 'auth-fail' (exit 1), or 'slow' (sleep 5s then exit 0)
 * @returns The absolute path to the created shim script
 */
export async function claudeShim(
  homeDir: string,
  mode: 'ok' | 'auth-fail' | 'slow',
): Promise<string> {
  const binDir = join(homeDir, 'bin');
  const shimPath = join(binDir, 'claude');

  await mkdir(binDir, { recursive: true });
  await writeFile(shimPath, SHIM_SCRIPTS[mode], 'utf8');
  await chmod(shimPath, 0o755);

  return shimPath;
}
