/** Spawns the built sparecrow binary and returns stdout, stderr, and exitCode. */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..', '..');
const DIST_INDEX = resolve(PROJECT_ROOT, 'dist', 'index.js');

export interface RunCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Spawns the built `sparecrow` binary with the given arguments.
 *
 * Always sets `NO_COLOR=1` and `TERM=dumb` to suppress ANSI codes
 * and ensure deterministic, color-free output. Callers can override
 * any env var via `envOverrides`.
 *
 * @param args - CLI arguments (e.g. `['status', '--json']`)
 * @param envOverrides - Additional environment variables merged on top of defaults
 * @param timeoutMs - Subprocess timeout in milliseconds (default 15000). Commands that probe
 *   container runtimes (e.g. `doctor`) may need 90s+ in CI where Docker/Podman are installed
 *   but slow to respond.
 */
export function runCli(
  args: string[],
  envOverrides?: Record<string, string>,
  timeoutMs = 15000,
): RunCliResult {
  // Strip XDG_* vars from the inherited environment so that the HOME override
  // in envOverrides fully controls where env-paths resolves config/state paths.
  // On CI machines XDG_CONFIG_HOME / XDG_STATE_HOME may be set globally and
  // would shadow the temp HOME, defeating per-test isolation.
  const {
    XDG_CONFIG_HOME: _xdgConfigHome,
    XDG_STATE_HOME: _xdgStateHome,
    XDG_DATA_HOME: _xdgDataHome,
    XDG_CACHE_HOME: _xdgCacheHome,
    ...cleanEnv
  } = process.env;

  const result = spawnSync('node', [DIST_INDEX, ...args], {
    encoding: 'utf8',
    env: {
      ...cleanEnv,
      NO_COLOR: '1',
      TERM: 'dumb',
      ...envOverrides,
    },
    cwd: PROJECT_ROOT,
    timeout: timeoutMs,
  });

  // 3.6 — If spawn itself failed (e.g. ENOENT), throw immediately
  if (result.error) {
    throw result.error;
  }

  // 3.7 — If the child was killed by a signal (e.g. SIGTERM on timeout), surface a clear error
  // rather than silently falling back to exitCode=1 and producing a confusing assertion failure.
  if (result.signal !== null && result.signal !== undefined) {
    throw new Error(
      `sparecrow process was killed by signal ${result.signal} (args: ${JSON.stringify(args)})`,
    );
  }

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}
