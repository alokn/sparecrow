/** Diagnostic check runner — orchestrates sequential health checks and collects findings. */
import { access, constants, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type {
  DoctorCheckKey,
  DoctorFinding,
  DoctorResult,
  DoctorSummary,
} from '../../types/index.js';
import { DOCTOR_CHECK_ORDER, DOCTOR_CHECK_NAMES, CONTAINER_CHECK_KEYS } from '../../types/index.js';
import { getPaths, isLinux, isMacOS } from '../../platform/index.js';
import { spawnWithGuardrails, validateRepository } from '../../utils/index.js';
import { loadConfig, resolveConfigFilePath } from '../../config/index.js';
import { QueuePayloadSchema } from '../../queue/index.js';
import { getConfigPath } from '../index.js';
import { detectContainerRuntime } from '../../providers/backends/container/index.js';
import type { ContainerRuntime } from '../../providers/backends/container/index.js';

/** Timeout in ms for the claude --version probe. */
const CLAUDE_PROBE_TIMEOUT_MS = 5000;

/** Timeout in ms for the usage endpoint connectivity check. */
const USAGE_PROBE_TIMEOUT_MS = 8000;

/** Token redaction pattern — replaces anything that looks like a token/secret. */
const TOKEN_PATTERN = /(?:sk-ant-|eyJ|Bearer\s+)\S+/gi;

/** Generic secret-like pattern — long base64-ish strings (32+ chars). */
const SECRET_PATTERN = /[A-Za-z0-9+/=_-]{32,}/g;

/** Redacts sensitive values from a string. */
export function redactSecrets(input: string): string {
  let result = input.replace(TOKEN_PATTERN, '[REDACTED]');
  result = result.replace(SECRET_PATTERN, (match) => {
    // Only redact if it looks like a credential (contains mixed chars and is long enough).
    // Exclude pure hex strings — container IDs are 64-char lowercase hex and must not be
    // redacted, as they appear in error messages and verbose output (not secrets).
    if (/^[0-9a-f]+$/i.test(match)) {
      return match;
    }
    if (match.length >= 40 && /[A-Z]/.test(match) && /[a-z0-9]/.test(match)) {
      return '[REDACTED]';
    }
    return match;
  });
  return result;
}

/** Diagnostic check function type. */
type CheckFn = (verbose: boolean) => Promise<DoctorFinding>;

/** Creates a finding with all fields always present. */
function makeFinding(
  checkKey: DoctorCheckKey,
  severity: DoctorFinding['severity'],
  status: DoctorFinding['status'],
  message: string,
  durationMs: number,
  fixCommand: string | null,
  details: string | null,
): DoctorFinding {
  return {
    checkKey,
    checkName: DOCTOR_CHECK_NAMES[checkKey],
    severity,
    status,
    message,
    fixCommand,
    durationMs,
    details,
  };
}

// ---------------------------------------------------------------------------
// Individual diagnostic checks
// ---------------------------------------------------------------------------

async function checkAuthTokenValidity(verbose: boolean): Promise<DoctorFinding> {
  const key: DoctorCheckKey = 'auth-token-validity';
  const start = Date.now();

  try {
    const claudeDir = join(homedir(), '.claude');
    const credPath = join(claudeDir, '.credentials.json');

    try {
      await access(credPath, constants.R_OK);
    } catch {
      return makeFinding(
        key,
        'critical',
        'fail',
        'No Claude Code credentials found. Run: claude auth login, then sparecrow config --reconnect',
        Date.now() - start,
        'claude auth login',
        verbose
          ? 'Credentials file not found or not readable at ~/.claude/.credentials.json'
          : null,
      );
    }

    const raw = await readFile(credPath, 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return makeFinding(
        key,
        'critical',
        'fail',
        'Credentials file contains invalid JSON.',
        Date.now() - start,
        'claude auth login',
        verbose ? 'Failed to parse credentials file as JSON' : null,
      );
    }

    if (typeof parsed !== 'object' || parsed === null) {
      return makeFinding(
        key,
        'critical',
        'fail',
        'Credentials file has unexpected format.',
        Date.now() - start,
        'claude auth login',
        verbose ? 'Credentials file is not a JSON object' : null,
      );
    }

    const record = parsed as Record<string, unknown>;

    // Check for accessToken at top level or nested in claudeAiOauth
    let accessToken: string | null = null;
    let expiresAt: unknown = null;

    if (typeof record['accessToken'] === 'string' && record['accessToken'].length > 0) {
      accessToken = record['accessToken'];
      expiresAt = record['expiresAt'];
    } else if (typeof record['claudeAiOauth'] === 'object' && record['claudeAiOauth'] !== null) {
      const nested = record['claudeAiOauth'] as Record<string, unknown>;
      if (typeof nested['accessToken'] === 'string' && nested['accessToken'].length > 0) {
        accessToken = nested['accessToken'];
        expiresAt = nested['expiresAt'];
      }
    }

    if (!accessToken) {
      return makeFinding(
        key,
        'critical',
        'fail',
        'Credentials file missing accessToken field.',
        Date.now() - start,
        'claude auth login',
        verbose ? 'No accessToken found at top level or claudeAiOauth nested object' : null,
      );
    }

    // Check expiry if present
    if (expiresAt !== null && expiresAt !== undefined) {
      let expiryMs: number | null = null;
      if (typeof expiresAt === 'number' && Number.isFinite(expiresAt)) {
        expiryMs = expiresAt > 1_000_000_000_000 ? expiresAt : expiresAt * 1000;
      } else if (typeof expiresAt === 'string') {
        const expiryParsed = Date.parse(expiresAt);
        if (!Number.isNaN(expiryParsed)) {
          expiryMs = expiryParsed;
        }
      }

      if (expiryMs !== null && expiryMs < Date.now()) {
        return makeFinding(
          key,
          'critical',
          'fail',
          'Your Claude Code session has expired. Run: sparecrow config --reconnect',
          Date.now() - start,
          'sparecrow config --reconnect',
          verbose ? `Token expired at ${new Date(expiryMs).toISOString()}` : null,
        );
      }
    }

    return makeFinding(key, 'ok', 'pass', 'Auth token is valid.', Date.now() - start, null, null);
  } catch {
    return makeFinding(
      key,
      'critical',
      'fail',
      'Failed to validate auth token.',
      Date.now() - start,
      'claude auth login',
      verbose ? 'Unexpected error during auth validation' : null,
    );
  }
}

async function checkClaudeInstallation(verbose: boolean): Promise<DoctorFinding> {
  const key: DoctorCheckKey = 'claude-installation';
  const start = Date.now();

  try {
    // Try to load config to get configured claude path
    let claudePath = 'claude';
    try {
      const configPath = resolveConfigFilePath(getPaths().config, getConfigPath());
      const config = await loadConfig(configPath);
      if (config.provider.claudePath) {
        claudePath = config.provider.claudePath;
      }
    } catch {
      // Config not found or invalid — fall back to PATH probe
    }

    const result = await spawnWithGuardrails(claudePath, ['--version'], {
      timeoutMs: CLAUDE_PROBE_TIMEOUT_MS,
    });

    if (result.enoent) {
      // Try bare 'claude' if we tried a configured path
      if (claudePath !== 'claude') {
        const fallback = await spawnWithGuardrails('claude', ['--version'], {
          timeoutMs: CLAUDE_PROBE_TIMEOUT_MS,
        });

        if (!fallback.enoent && fallback.exitCode === 0) {
          return makeFinding(
            key,
            'warning',
            'warn',
            `Configured claude path '${claudePath}' not found, but 'claude' found in PATH.`,
            Date.now() - start,
            'sparecrow config validate',
            verbose ? `PATH probe output: ${redactSecrets(fallback.stdout.trim())}` : null,
          );
        }
      }

      return makeFinding(
        key,
        'critical',
        'fail',
        `Claude Code binary not found at '${claudePath}'. Install Claude Code from https://claude.ai/download or set provider.claude_path in your config.`,
        Date.now() - start,
        'Install Claude Code: https://claude.ai/download',
        verbose
          ? `Checked: ${claudePath}${claudePath !== 'claude' ? ' and claude (PATH)' : ''}`
          : null,
      );
    }

    if (result.timedOut) {
      return makeFinding(
        key,
        'warning',
        'warn',
        'Claude Code CLI probe timed out.',
        Date.now() - start,
        'Check system resources and retry',
        verbose ? `Timeout after ${CLAUDE_PROBE_TIMEOUT_MS}ms` : null,
      );
    }

    if (result.exitCode !== 0) {
      return makeFinding(
        key,
        'warning',
        'warn',
        'Claude Code CLI returned non-zero exit code.',
        Date.now() - start,
        'Reinstall Claude Code: https://claude.ai/download',
        verbose
          ? `Exit code: ${result.exitCode}, stderr: ${redactSecrets(result.stderr.trim())}`
          : null,
      );
    }

    const version = result.stdout.trim();
    return makeFinding(
      key,
      'ok',
      'pass',
      `Claude Code CLI found (${version}).`,
      Date.now() - start,
      null,
      null,
    );
  } catch {
    return makeFinding(
      key,
      'critical',
      'fail',
      'Failed to check Claude Code installation.',
      Date.now() - start,
      'Install Claude Code: https://claude.ai/download',
      verbose ? 'Unexpected error during Claude CLI probe' : null,
    );
  }
}

async function checkUsageEndpointConnectivity(verbose: boolean): Promise<DoctorFinding> {
  const key: DoctorCheckKey = 'usage-endpoint-connectivity';
  const start = Date.now();

  try {
    const claudeDir = join(homedir(), '.claude');
    const credPath = join(claudeDir, '.credentials.json');

    let token: string | null = null;
    try {
      const raw = await readFile(credPath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed['accessToken'] === 'string') {
        token = parsed['accessToken'];
      } else if (typeof parsed['claudeAiOauth'] === 'object' && parsed['claudeAiOauth'] !== null) {
        const nested = parsed['claudeAiOauth'] as Record<string, unknown>;
        if (typeof nested['accessToken'] === 'string') {
          token = nested['accessToken'];
        }
      }
    } catch {
      return makeFinding(
        key,
        'warning',
        'warn',
        'Cannot test usage endpoint — auth token unavailable.',
        Date.now() - start,
        'claude auth login',
        verbose ? 'Failed to read credentials for connectivity test' : null,
      );
    }

    if (!token) {
      return makeFinding(
        key,
        'warning',
        'warn',
        'Cannot test usage endpoint — no access token found.',
        Date.now() - start,
        'claude auth login',
        verbose ? 'No access token in credentials file' : null,
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), USAGE_PROBE_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch('https://api.anthropic.com/api/oauth/usage', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
        },
        signal: controller.signal,
      });
    } catch (error: unknown) {
      const isAbort = error instanceof Error && error.name === 'AbortError';
      if (isAbort) {
        return makeFinding(
          key,
          'warning',
          'warn',
          'Usage endpoint request timed out.',
          Date.now() - start,
          'Check network connectivity and retry',
          verbose ? `Timeout after ${USAGE_PROBE_TIMEOUT_MS}ms` : null,
        );
      }

      return makeFinding(
        key,
        'warning',
        'warn',
        'Cannot reach usage endpoint.',
        Date.now() - start,
        'Check network connectivity',
        verbose ? `Network error: ${redactSecrets((error as Error).message)}` : null,
      );
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 401) {
      return makeFinding(
        key,
        'critical',
        'fail',
        'Your Claude Code session has expired. Run: sparecrow config --reconnect',
        Date.now() - start,
        'sparecrow config --reconnect',
        verbose ? 'Usage endpoint returned 401 — token may be expired or revoked' : null,
      );
    }

    if (response.status === 429) {
      return makeFinding(
        key,
        'warning',
        'warn',
        'Usage endpoint returned 429 (rate limited).',
        Date.now() - start,
        'Wait for rate limit reset, then retry',
        verbose ? 'Rate limit or acceleration limit hit — API is reachable but throttled' : null,
      );
    }

    if (response.status >= 500) {
      return makeFinding(
        key,
        'warning',
        'warn',
        `Usage endpoint returned ${response.status} (server error).`,
        Date.now() - start,
        'Retry later — API server may be experiencing issues',
        verbose ? `Server error status: ${response.status}` : null,
      );
    }

    if (!response.ok) {
      return makeFinding(
        key,
        'warning',
        'warn',
        `Usage endpoint returned unexpected status ${response.status}.`,
        Date.now() - start,
        'Check API status at status.anthropic.com',
        verbose ? `Unexpected HTTP status: ${response.status}` : null,
      );
    }

    return makeFinding(
      key,
      'ok',
      'pass',
      'Usage endpoint is reachable and responding.',
      Date.now() - start,
      null,
      null,
    );
  } catch {
    return makeFinding(
      key,
      'warning',
      'warn',
      'Failed to check usage endpoint connectivity.',
      Date.now() - start,
      'Check network connectivity',
      verbose ? 'Unexpected error during connectivity check' : null,
    );
  }
}

async function checkConfigValidity(verbose: boolean): Promise<DoctorFinding> {
  const key: DoctorCheckKey = 'config-validity';
  const start = Date.now();

  try {
    const configPath = resolveConfigFilePath(getPaths().config, getConfigPath());

    try {
      await access(configPath, constants.R_OK);
    } catch {
      // Config file not found — defaults apply, so this is OK but worth noting
      return makeFinding(
        key,
        'ok',
        'pass',
        'No config file found — using defaults.',
        Date.now() - start,
        null,
        verbose ? `Checked: ${configPath}` : null,
      );
    }

    try {
      await loadConfig(configPath);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return makeFinding(
        key,
        'critical',
        'fail',
        'Configuration file is invalid.',
        Date.now() - start,
        'sparecrow config validate',
        verbose ? `Validation error: ${redactSecrets(message)}` : null,
      );
    }

    return makeFinding(
      key,
      'ok',
      'pass',
      'Configuration is valid.',
      Date.now() - start,
      null,
      verbose ? `Config file: ${configPath}` : null,
    );
  } catch {
    return makeFinding(
      key,
      'critical',
      'fail',
      'Failed to validate configuration.',
      Date.now() - start,
      'sparecrow config validate',
      verbose ? 'Unexpected error during config validation' : null,
    );
  }
}

async function checkServiceInstallationState(verbose: boolean): Promise<DoctorFinding> {
  const key: DoctorCheckKey = 'service-installation-state';
  const start = Date.now();

  try {
    let servicePath: string;
    let platform: string;

    if (isLinux()) {
      servicePath = join(homedir(), '.config', 'systemd', 'user', 'sparecrow.service');
      platform = 'linux';
    } else if (isMacOS()) {
      servicePath = join(homedir(), 'Library', 'LaunchAgents', 'com.sparecrow.daemon.plist');
      platform = 'macos';
    } else {
      return makeFinding(
        key,
        'warning',
        'warn',
        'Service auto-start not supported on this platform.',
        Date.now() - start,
        'sparecrow daemon start',
        verbose ? `Platform: ${process.platform}` : null,
      );
    }

    try {
      await access(servicePath, constants.R_OK);
    } catch {
      return makeFinding(
        key,
        'warning',
        'warn',
        `Daemon service file not installed (${platform}).`,
        Date.now() - start,
        'sparecrow daemon install',
        verbose ? `Expected file: ${servicePath}` : null,
      );
    }

    return makeFinding(
      key,
      'ok',
      'pass',
      `Daemon service file installed (${platform}).`,
      Date.now() - start,
      null,
      verbose ? `Service file: ${servicePath}` : null,
    );
  } catch {
    return makeFinding(
      key,
      'warning',
      'warn',
      'Failed to check service installation state.',
      Date.now() - start,
      'sparecrow daemon install',
      verbose ? 'Unexpected error during service state check' : null,
    );
  }
}

async function checkTargetRepoAccessibility(verbose: boolean): Promise<DoctorFinding> {
  const key: DoctorCheckKey = 'target-repo-accessibility';
  const start = Date.now();

  try {
    // Load config to find target paths
    let targets: string[] = [];
    try {
      const configPath = resolveConfigFilePath(getPaths().config, getConfigPath());
      const config = await loadConfig(configPath);
      targets = config.tasks.map((t) => t.targetPath);
    } catch {
      // Config not found or invalid — no targets to check
    }

    // Also check queue for target paths
    const queuePath = join(getPaths().data, 'queue.json');
    try {
      const raw = await readFile(queuePath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (Array.isArray(parsed['tasks'])) {
        for (const task of parsed['tasks']) {
          if (
            typeof task === 'object' &&
            task !== null &&
            typeof (task as Record<string, unknown>)['targetPath'] === 'string'
          ) {
            const tp = (task as Record<string, unknown>)['targetPath'] as string;
            if (!targets.includes(tp)) {
              targets.push(tp);
            }
          }
        }
      }
    } catch {
      // Queue file not found or invalid — skip
    }

    if (targets.length === 0) {
      return makeFinding(
        key,
        'warning',
        'warn',
        'No target repositories configured.',
        Date.now() - start,
        'sparecrow queue add --template improve-code --target <path>',
        null,
      );
    }

    const failures: string[] = [];
    for (const target of targets) {
      const result = await validateRepository(target);
      if (!result.valid) {
        failures.push(`${target}: ${result.error}`);
      }
    }

    if (failures.length > 0) {
      return makeFinding(
        key,
        'warning',
        'warn',
        `${failures.length} of ${targets.length} target repo(s) have issues.`,
        Date.now() - start,
        'Check target paths and ensure they are valid git repositories',
        verbose ? failures.map((f) => redactSecrets(f)).join('; ') : null,
      );
    }

    return makeFinding(
      key,
      'ok',
      'pass',
      `All ${targets.length} target repo(s) accessible.`,
      Date.now() - start,
      null,
      null,
    );
  } catch {
    return makeFinding(
      key,
      'warning',
      'warn',
      'Failed to check target repository accessibility.',
      Date.now() - start,
      'sparecrow queue add --template improve-code --target <path>',
      verbose ? 'Unexpected error during repo accessibility check' : null,
    );
  }
}

async function checkQueueFileIntegrity(verbose: boolean): Promise<DoctorFinding> {
  const key: DoctorCheckKey = 'queue-file-integrity';
  const start = Date.now();

  try {
    const queuePath = join(getPaths().data, 'queue.json');

    let raw: string;
    try {
      raw = await readFile(queuePath, 'utf-8');
    } catch (error: unknown) {
      const isNotFound = (error as NodeJS.ErrnoException).code === 'ENOENT';
      if (isNotFound) {
        return makeFinding(
          key,
          'ok',
          'pass',
          'Queue file not present (empty queue).',
          Date.now() - start,
          null,
          null,
        );
      }
      return makeFinding(
        key,
        'critical',
        'fail',
        'Cannot read queue file.',
        Date.now() - start,
        `Check file permissions: ls -la ${queuePath}`,
        verbose ? `Read error: ${(error as Error).message}` : null,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return makeFinding(
        key,
        'critical',
        'fail',
        'Queue file contains invalid JSON.',
        Date.now() - start,
        'sparecrow queue clear --yes',
        verbose ? 'Failed to parse queue.json as JSON' : null,
      );
    }

    const result = QueuePayloadSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return makeFinding(
        key,
        'critical',
        'fail',
        'Queue file schema validation failed.',
        Date.now() - start,
        'sparecrow queue clear --yes',
        verbose ? `Schema errors: ${redactSecrets(issues)}` : null,
      );
    }

    const taskCount = result.data.tasks.length;
    return makeFinding(
      key,
      'ok',
      'pass',
      `Queue file is valid (${taskCount} task${taskCount === 1 ? '' : 's'}).`,
      Date.now() - start,
      null,
      null,
    );
  } catch {
    return makeFinding(
      key,
      'critical',
      'fail',
      'Failed to check queue file integrity.',
      Date.now() - start,
      'sparecrow queue clear --yes',
      verbose ? 'Unexpected error during queue integrity check' : null,
    );
  }
}

async function checkLogDirectoryPermissions(verbose: boolean): Promise<DoctorFinding> {
  const key: DoctorCheckKey = 'log-directory-permissions';
  const start = Date.now();

  try {
    const logsDir = getPaths().logs;

    try {
      await access(logsDir, constants.R_OK | constants.W_OK);
    } catch (error: unknown) {
      const isNotFound = (error as NodeJS.ErrnoException).code === 'ENOENT';
      if (isNotFound) {
        return makeFinding(
          key,
          'warning',
          'warn',
          'Log directory does not exist.',
          Date.now() - start,
          `mkdir -p ${logsDir} && chmod 700 ${logsDir}`,
          verbose ? `Expected directory: ${logsDir}` : null,
        );
      }
      return makeFinding(
        key,
        'warning',
        'warn',
        'Log directory is not readable/writable.',
        Date.now() - start,
        `chmod 700 ${logsDir}`,
        verbose ? `Permission check failed for: ${logsDir}` : null,
      );
    }

    return makeFinding(
      key,
      'ok',
      'pass',
      'Log directory is accessible.',
      Date.now() - start,
      null,
      verbose ? `Log directory: ${logsDir}` : null,
    );
  } catch {
    return makeFinding(
      key,
      'warning',
      'warn',
      'Failed to check log directory permissions.',
      Date.now() - start,
      null,
      verbose ? 'Unexpected error during log directory check' : null,
    );
  }
}

// ---------------------------------------------------------------------------
// Container diagnostic checks
// ---------------------------------------------------------------------------

/** Returns true when the loaded config has execution_backend === 'container'. */
export async function isContainerBackendConfigured(): Promise<boolean> {
  try {
    const configPath = resolveConfigFilePath(getPaths().config, getConfigPath());
    const config = await loadConfig(configPath);
    return config.provider.executionBackend === 'container';
  } catch {
    return false;
  }
}

/** Creates closure-bound container check functions that share a single runtime detection result.
 *  @param runtime           - The detected container runtime, or null if none was found.
 *  @param image             - The container image to use for the test run check (from config, defaults to 'node:lts-slim').
 *  @param mountClaudeBinary - Explicit mount override from config (mount_claude_binary). When true, host binary is mounted
 *                             and the custom-image claude probe should be skipped (host binary makes it unnecessary).
 */
function createContainerChecks(
  runtime: ContainerRuntime | null,
  image: string,
  mountClaudeBinary?: boolean,
): CheckFn[] {
  const checkRuntimeDetection: CheckFn = async (verbose) => {
    const key: DoctorCheckKey = 'container-runtime-detection';
    const start = Date.now();

    if (!runtime) {
      const platformHint =
        process.platform === 'darwin'
          ? 'Install Docker (brew install docker) or Podman (brew install podman).'
          : 'Install Docker (sudo apt install docker.io) or Podman (sudo apt install podman).';
      return makeFinding(
        key,
        'critical',
        'fail',
        `No container runtime detected. Checked: Docker, Podman. ${platformHint} Alternatively, set execution_backend: direct in your config.`,
        Date.now() - start,
        process.platform === 'darwin' ? 'brew install docker' : 'sudo apt install docker.io',
        verbose ? 'Neither Docker nor Podman found on PATH' : null,
      );
    }

    try {
      const runtimeInfo = await runtime.info();
      return makeFinding(
        key,
        'ok',
        'pass',
        `Container runtime detected: ${runtime.name} v${runtimeInfo.version}.`,
        Date.now() - start,
        null,
        verbose ? `Runtime: ${runtime.name}, version: ${runtimeInfo.version}` : null,
      );
    } catch {
      return makeFinding(
        key,
        'ok',
        'pass',
        `Container runtime detected: ${runtime.name} (version unknown).`,
        Date.now() - start,
        null,
        verbose ? `Runtime: ${runtime.name}, version: unknown (info() failed)` : null,
      );
    }
  };

  const checkRootlessMode: CheckFn = async (verbose) => {
    const key: DoctorCheckKey = 'container-rootless-mode';
    const start = Date.now();

    if (!runtime) {
      return makeFinding(
        key,
        'warning',
        'warn',
        'Cannot check rootless mode — no runtime detected.',
        Date.now() - start,
        'Install Docker or Podman, then run: sparecrow doctor',
        verbose ? 'Rootless check skipped due to missing container runtime' : null,
      );
    }

    try {
      const runtimeInfo = await runtime.info();
      if (runtimeInfo.rootless) {
        return makeFinding(
          key,
          'ok',
          'pass',
          'Container runtime is rootless (recommended).',
          Date.now() - start,
          null,
          verbose ? `${runtime.name} rootless: true` : null,
        );
      }
      return makeFinding(
        key,
        'warning',
        'warn',
        'Container runtime is running as root. Rootless mode is recommended for security.',
        Date.now() - start,
        `${runtime.name === 'docker' ? 'sudo usermod -aG docker $USER' : 'podman system migrate'} — then restart the runtime`,
        verbose ? `${runtime.name} rootless: false` : null,
      );
    } catch {
      return makeFinding(
        key,
        'warning',
        'warn',
        'Unable to determine rootless mode.',
        Date.now() - start,
        'Check container runtime status manually',
        verbose ? `${runtime.name} info() failed` : null,
      );
    }
  };

  const checkTestRun: CheckFn = async (verbose) => {
    const key: DoctorCheckKey = 'container-test-run';
    const start = Date.now();

    if (!runtime) {
      return makeFinding(
        key,
        'warning',
        'warn',
        'Cannot run test container — no runtime detected.',
        Date.now() - start,
        'Install Docker or Podman, then run: sparecrow doctor',
        verbose ? 'Test container skipped due to missing container runtime' : null,
      );
    }

    let containerId: string | null = null;
    try {
      const handle = await runtime.run({
        image,
        command: ['echo', 'sparecrow-container-test'],
        cwd: '/workspace',
        env: {},
        mounts: [],
      });
      containerId = handle.containerId;

      const exitResult = await runtime.wait(containerId, 30_000);
      const logResult = await runtime.logs(containerId);

      if (exitResult.exitCode === 0 && logResult.stdout.includes('sparecrow-container-test')) {
        return makeFinding(
          key,
          'ok',
          'pass',
          `Test container ran successfully (${Date.now() - start}ms).`,
          Date.now() - start,
          null,
          verbose ? `Exit code: 0, stdout: ${logResult.stdout.trim()}` : null,
        );
      }

      return makeFinding(
        key,
        'critical',
        'fail',
        'Test container failed.',
        Date.now() - start,
        'Check container runtime configuration and image availability',
        verbose ? `Exit code: ${exitResult.exitCode}, stderr: ${logResult.stderr.trim()}` : null,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return makeFinding(
        key,
        'critical',
        'fail',
        'Test container failed.',
        Date.now() - start,
        'Check container runtime configuration and image availability',
        verbose ? `Error: ${redactSecrets(message)}` : null,
      );
    } finally {
      if (containerId) {
        try {
          await runtime.remove(containerId);
        } catch {
          // Swallow cleanup errors — container may already be gone
        }
      }
    }
  };

  const checkCredentialMount: CheckFn = async (verbose) => {
    const key: DoctorCheckKey = 'container-credential-mount';
    const start = Date.now();

    try {
      const credPath = join(homedir(), '.claude', '.credentials.json');
      await access(credPath, constants.R_OK);
      return makeFinding(
        key,
        'ok',
        'pass',
        'Claude credentials file found and readable for container mount.',
        Date.now() - start,
        null,
        verbose ? `Credentials file: ${credPath}` : null,
      );
    } catch {
      return makeFinding(
        key,
        'warning',
        'warn',
        'Claude credentials file not found — container execution will lack OAuth credentials.',
        Date.now() - start,
        'claude auth login',
        verbose ? `Expected: ${join(homedir(), '.claude', '.credentials.json')}` : null,
      );
    }
  };

  const checkCustomImageClaude: CheckFn = async (verbose) => {
    const key: DoctorCheckKey = 'container-custom-image-claude';
    const start = Date.now();

    // Only relevant for non-default images
    if (image === 'node:lts-slim') {
      return makeFinding(
        key,
        'ok',
        'pass',
        'Default image — host binary mount will provide claude.',
        Date.now() - start,
        null,
        verbose ? `Image: ${image} (default, skipping custom image check)` : null,
      );
    }

    // When mount_claude_binary: true is explicitly set, the host binary will be mounted
    // into the container regardless of the image. The probe is unnecessary — and emitting a
    // warning here would be a false positive because claude will be available via the mount.
    if (mountClaudeBinary === true) {
      return makeFinding(
        key,
        'ok',
        'pass',
        'Host binary mount forced — claude will be provided via host mount.',
        Date.now() - start,
        null,
        verbose ? `Image: ${image} (custom), mount_claude_binary: true — probe skipped` : null,
      );
    }

    if (!runtime) {
      return makeFinding(
        key,
        'warning',
        'warn',
        'Cannot verify custom image claude availability — no runtime detected.',
        Date.now() - start,
        'Install Docker or Podman, then run: sparecrow doctor',
        verbose ? 'Custom image check skipped due to missing container runtime' : null,
      );
    }

    let containerId: string | null = null;
    try {
      // Provide a minimal HOME env for the probe — some binaries require $HOME.
      // This is more representative than a bare empty env, but still avoids
      // passing credential mounts or real PATH overrides (probe is lightweight on purpose).
      const handle = await runtime.run({
        image,
        command: ['claude', '--version'],
        cwd: '/workspace',
        env: { HOME: '/root' },
        mounts: [],
      });
      containerId = handle.containerId;

      const exitResult = await runtime.wait(containerId, 30_000);

      if (exitResult.exitCode === 0) {
        const logResult = await runtime.logs(containerId);
        return makeFinding(
          key,
          'ok',
          'pass',
          `Custom image has claude available (${logResult.stdout.trim()}).`,
          Date.now() - start,
          null,
          verbose ? `Image: ${image}, claude --version output: ${logResult.stdout.trim()}` : null,
        );
      }

      return makeFinding(
        key,
        'warning',
        'warn',
        "Custom image does not have 'claude' in PATH. Ensure claude is installed in the image or set mount_claude_binary: true.",
        Date.now() - start,
        'mount_claude_binary: true',
        verbose ? `Image: ${image}, exit code: ${exitResult.exitCode}` : null,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return makeFinding(
        key,
        'warning',
        'warn',
        "Custom image does not have 'claude' in PATH. Ensure claude is installed in the image or set mount_claude_binary: true.",
        Date.now() - start,
        'mount_claude_binary: true',
        verbose ? `Image: ${image}, error: ${redactSecrets(message)}` : null,
      );
    } finally {
      if (containerId) {
        try {
          await runtime.remove(containerId);
        } catch {
          // Swallow cleanup errors — container may already be gone
        }
      }
    }
  };

  return [
    checkRuntimeDetection,
    checkRootlessMode,
    checkTestRun,
    checkCredentialMount,
    checkCustomImageClaude,
  ];
}

// ---------------------------------------------------------------------------
// Check registry — deterministic order (non-container checks only)
// ---------------------------------------------------------------------------

/** Base check registry for non-container checks. Container checks are generated dynamically via createContainerChecks(). */
const BASE_CHECK_REGISTRY: Partial<Record<DoctorCheckKey, CheckFn>> = {
  'auth-token-validity': checkAuthTokenValidity,
  'claude-installation': checkClaudeInstallation,
  'usage-endpoint-connectivity': checkUsageEndpointConnectivity,
  'config-validity': checkConfigValidity,
  'service-installation-state': checkServiceInstallationState,
  'target-repo-accessibility': checkTargetRepoAccessibility,
  'queue-file-integrity': checkQueueFileIntegrity,
  'log-directory-permissions': checkLogDirectoryPermissions,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Runs all diagnostic checks in deterministic order and returns the full result. */
export async function runDiagnostics(verbose: boolean): Promise<DoctorResult> {
  const findings: DoctorFinding[] = [];

  // Determine if container checks should run
  const containerConfigured = await isContainerBackendConfigured();

  // Build container check registry if configured
  let containerCheckMap: Map<DoctorCheckKey, CheckFn> | null = null;
  if (containerConfigured) {
    // Detect runtime once and bind into closures for all four container checks.
    // Known performance tradeoff: loadConfig() is called here in addition to the
    // isContainerBackendConfigured() call above and the checkConfigValidity call below.
    // This is three disk reads of the same file. Changing the function signature to
    // accept a pre-loaded config is out of scope; document it here for future maintainers.
    let preference: 'auto' | 'docker' | 'podman' = 'auto';
    let image = 'node:lts-slim';
    let mountClaudeBinary: boolean | undefined;
    try {
      const configPath = resolveConfigFilePath(getPaths().config, getConfigPath());
      const config = await loadConfig(configPath);
      preference = config.provider.container?.runtime ?? 'auto';
      // Use configured image so doctor tests the same image as `sparecrow container test`
      image = config.provider.container?.image ?? 'node:lts-slim';
      mountClaudeBinary = config.provider.container?.mountClaudeBinary;
    } catch {
      // Fall back to auto-detect and default image
    }
    const runtime = await detectContainerRuntime(preference);
    const containerChecks = createContainerChecks(runtime, image, mountClaudeBinary);
    const containerKeys: DoctorCheckKey[] = [
      'container-runtime-detection',
      'container-rootless-mode',
      'container-test-run',
      'container-credential-mount',
      'container-custom-image-claude',
    ];
    containerCheckMap = new Map<DoctorCheckKey, CheckFn>();
    for (let i = 0; i < containerKeys.length; i++) {
      containerCheckMap.set(containerKeys[i]!, containerChecks[i]!);
    }
  }

  for (const checkKey of DOCTOR_CHECK_ORDER) {
    // Skip container checks when not configured
    if (CONTAINER_CHECK_KEYS.has(checkKey) && !containerConfigured) {
      continue;
    }

    // Look up check function from base registry or container map
    const checkFn = CONTAINER_CHECK_KEYS.has(checkKey)
      ? containerCheckMap?.get(checkKey)
      : BASE_CHECK_REGISTRY[checkKey];

    if (!checkFn) continue;

    const finding = await checkFn(verbose);
    // Strip details if not verbose
    if (!verbose) {
      finding.details = null;
    }
    findings.push(finding);
  }

  const summary = computeSummary(findings);
  return { findings, summary };
}

/** Computes summary counts from findings. */
export function computeSummary(findings: DoctorFinding[]): DoctorSummary {
  let criticalCount = 0;
  let warningCount = 0;
  let okCount = 0;

  for (const f of findings) {
    if (f.severity === 'critical') criticalCount++;
    else if (f.severity === 'warning') warningCount++;
    else okCount++;
  }

  return {
    criticalCount,
    warningCount,
    okCount,
    totalChecks: findings.length,
  };
}
