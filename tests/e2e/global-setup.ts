/** Global setup for E2E tests: builds the project and verifies the binary. */
import { execSync, spawnSync } from 'node:child_process';
import { chmodSync, constants } from 'node:fs';
import { access, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');
const DIST_INDEX = resolve(PROJECT_ROOT, 'dist', 'index.js');

export async function setup(): Promise<void> {
  // 2.2 — Run npm run build (with a 120-second timeout to avoid indefinite CI hangs)
  execSync('npm run build', { stdio: 'inherit', cwd: PROJECT_ROOT, timeout: 120000 });

  // 2.3 — Verify dist/index.js exists (async)
  try {
    await stat(DIST_INDEX);
  } catch {
    throw new Error(
      `E2E global setup failed: dist/index.js not found at ${DIST_INDEX}. Did the build succeed?`,
    );
  }

  // 2.4 — Verify dist/index.js is executable; apply chmod if not (access() is async)
  try {
    await access(DIST_INDEX, constants.X_OK);
  } catch {
    chmodSync(DIST_INDEX, 0o755);
  }

  // Create a fresh isolated temp HOME for the smoke gates so they do not read
  // or write to the real developer/CI home directory.
  const smokeHomeDir = await mkdtemp(join(tmpdir(), 'sparecrow-global-setup-'));
  // Ensure the directory exists (mkdtemp guarantees this, but make it explicit)
  await mkdir(smokeHomeDir, { recursive: true });

  // Env overrides for smoke gates: suppress ANSI codes for deterministic output,
  // consistent with runCli() helper defaults used by all E2E test suites.
  // Strip XDG_* vars so env-paths resolves paths under smokeHomeDir, not the
  // real CI home, and set HOME to the temp dir for full isolation.
  const {
    XDG_CONFIG_HOME: _xdgConfigHome,
    XDG_STATE_HOME: _xdgStateHome,
    XDG_DATA_HOME: _xdgDataHome,
    XDG_CACHE_HOME: _xdgCacheHome,
    ...cleanEnv
  } = process.env;

  const smokeEnv = { ...cleanEnv, NO_COLOR: '1', TERM: 'dumb', HOME: smokeHomeDir };

  try {
    // 2.5 — Smoke-gate: sparecrow --version
    const versionResult = spawnSync('node', [DIST_INDEX, '--version'], {
      encoding: 'utf8',
      cwd: PROJECT_ROOT,
      env: smokeEnv,
      timeout: 15000,
    });
    if (versionResult.status !== 0) {
      throw new Error(
        `E2E smoke-gate failed: sparecrow --version exited with code ${String(versionResult.status)}:\n${versionResult.stderr ?? ''}`,
      );
    }
    const semverPattern = /\d+\.\d+\.\d+/;
    if (!semverPattern.test(versionResult.stdout)) {
      throw new Error(
        `E2E smoke-gate failed: sparecrow --version output does not contain a semver string. Got: ${versionResult.stdout}`,
      );
    }

    // 2.6 — Smoke-gate: sparecrow --help
    const helpResult = spawnSync('node', [DIST_INDEX, '--help'], {
      encoding: 'utf8',
      cwd: PROJECT_ROOT,
      env: smokeEnv,
      timeout: 15000,
    });
    if (helpResult.status !== 0) {
      throw new Error(
        `E2E smoke-gate failed: sparecrow --help exited with code ${String(helpResult.status)}:\n${helpResult.stderr ?? ''}`,
      );
    }
  } finally {
    // Clean up the isolated smoke-gate temp directory
    await rm(smokeHomeDir, { recursive: true, force: true });
  }
}
