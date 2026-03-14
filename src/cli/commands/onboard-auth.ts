/** Onboarding auth helpers — Claude binary detection and auth validation. */
import { access, readFile, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { ScrowError, ErrorCode } from '../../errors/index.js';
import { spawnWithGuardrails, atomicWrite, logger } from '../../utils/index.js';
import { getPaths } from '../../platform/index.js';
import { ClaudeCodeAuthManager, parseAuthStatusOutput } from '../../providers/claude-code/index.js';
import { ScrowConfigSchema } from '../../config/index.js';
import { getConfigPath } from '../index.js';
import { renderErrorBlock, renderStatusIndicator } from '../../ui/index.js';
import type { AuthValidationResult } from '../../types/index.js';
export type { AuthValidationResult };

/** Result of Claude binary detection. */
export interface ClaudeDetectionResult {
  found: boolean;
  absolutePath: string | null;
  error: string | null;
}

/** Detects the Claude binary on PATH using `which`. Returns normalized absolute path. */
export async function detectClaudeBinary(): Promise<ClaudeDetectionResult> {
  // Try `which claude` first
  const result = await spawnWithGuardrails('which', ['claude'], { timeoutMs: 5000 });

  if (result.enoent) {
    // `which` binary itself was not found — treat as Claude not found
    void logger.warn('onboard.binary_detection.which_not_found', {
      reason: 'which_enoent',
    });
    return { found: false, absolutePath: null, error: 'which command not found' };
  }

  if (result.timedOut) {
    void logger.warn('onboard.binary_detection.timeout', { command: 'which claude' });
    return { found: false, absolutePath: null, error: 'binary detection timed out' };
  }

  if (result.exitCode !== 0) {
    void logger.debug('onboard.binary_detection.not_on_path', { stdout: result.stdout.trim() });
    return { found: false, absolutePath: null, error: 'claude not found on PATH' };
  }

  const rawPath = result.stdout.trim();
  if (!rawPath) {
    return { found: false, absolutePath: null, error: 'empty path returned by which' };
  }

  const absolutePath = resolve(rawPath);

  // Verify the resolved path is executable
  try {
    await access(absolutePath, constants.X_OK);
  } catch {
    void logger.warn('onboard.binary_detection.not_executable', { path: absolutePath });
    return {
      found: false,
      absolutePath: null,
      error: `claude found at ${absolutePath} but not executable`,
    };
  }

  void logger.debug('onboard.binary_detection.found', { path: absolutePath });
  return { found: true, absolutePath, error: null };
}

/** Renders the missing Claude CLI error block and returns a formatted string. */
export function renderClaudeNotFoundError(): string {
  return renderErrorBlock({
    severity: 'critical',
    message: 'Claude Code CLI not found.',
    recovery: 'Install from https://claude.ai/download',
  });
}

/** Validates auth using ClaudeCodeAuthManager and claude auth status --json for tier. */
export async function validateAuth(claudePath: string): Promise<AuthValidationResult> {
  // Quick credential check via ClaudeCodeAuthManager
  const authManager = new ClaudeCodeAuthManager();
  const credentialsValid = await authManager.validate();

  if (!credentialsValid) {
    return { valid: false, tier: 'unknown' };
  }

  // Tier detection via `claude auth status --json`
  const statusResult = await spawnWithGuardrails(claudePath, ['auth', 'status', '--json'], {
    timeoutMs: 10000,
  });

  if (statusResult.timedOut || statusResult.enoent || statusResult.exitCode !== 0) {
    // Auth status check failed — network or subprocess failure; treat as invalid to trigger remediation
    void logger.warn('onboard.auth.status_check_failed', {
      timedOut: statusResult.timedOut,
      enoent: statusResult.enoent,
      exitCode: statusResult.exitCode,
    });
    return { valid: false, tier: 'unknown' };
  }

  const parsed = parseAuthStatusOutput(statusResult.stdout);
  if (!parsed.authenticated) {
    return { valid: false, tier: parsed.tier };
  }

  return { valid: true, tier: parsed.tier };
}

/** Renders the auth success status indicator. */
export function renderAuthSuccess(tier: string): string {
  return renderStatusIndicator({
    state: 'healthy',
    label: 'Auth',
    value: tier,
  });
}

/** Renders the config save failure error block with recovery guidance. */
export function renderConfigSaveError(reason: string): string {
  return renderErrorBlock({
    severity: 'critical',
    message: `Failed to save configuration: ${reason}`,
    recovery: 'Run: sparecrow doctor to diagnose configuration issues',
  });
}

/** Renders the auth failure error block. */
export function renderAuthFailedError(): string {
  return renderErrorBlock({
    severity: 'critical',
    message: 'Authentication failed after retry.',
    recovery: 'claude auth login',
  });
}

/** Spawns `claude auth login` with a 2-minute timeout. Returns true on success. */
export async function runAuthLogin(claudePath: string): Promise<boolean> {
  const result = await spawnWithGuardrails(claudePath, ['auth', 'login'], {
    timeoutMs: 120000,
  });

  if (result.timedOut) {
    void logger.warn('onboard.auth.login_timeout', {});
    return false;
  }

  if (result.enoent || result.exitCode !== 0) {
    void logger.warn('onboard.auth.login_failed', {
      enoent: result.enoent,
      exitCode: result.exitCode,
    });
    return false;
  }

  return true;
}

/** Persists claude_path into config YAML using read-merge-validate-atomicWrite semantics. */
export async function persistClaudePath(claudePath: string): Promise<void> {
  const configPath = getConfigPath() ?? join(getPaths().config, 'config.yaml');

  // Read existing config (handle ENOENT as empty)
  let raw: Record<string, unknown> = {};
  try {
    const content = await readFile(configPath, 'utf-8');
    const parsed = parseYaml(content) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      raw = parsed as Record<string, unknown>;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw new ScrowError(
        ErrorCode.CONFIG_INVALID,
        'Config file exists but could not be read or parsed',
        err instanceof Error ? err : undefined,
      );
    }
    // ENOENT: start from empty config
  }

  // Idempotency check
  const provider = (raw['provider'] as Record<string, unknown> | undefined) ?? {};
  if (provider['claude_path'] === claudePath) {
    void logger.debug('onboard.config.persist_skipped', {
      reason: 'already_set',
      path: claudePath,
    });
    return;
  }

  // Merge only the target key
  const updatedProvider = { ...provider, claude_path: claudePath };
  raw['provider'] = updatedProvider;

  // Validate merged config through schema
  const validation = ScrowConfigSchema.safeParse(raw);
  if (!validation.success) {
    throw new ScrowError(ErrorCode.CONFIG_INVALID, 'Merged config failed schema validation');
  }

  // Ensure config directory exists
  await mkdir(dirname(configPath), { recursive: true });

  // Write atomically
  await atomicWrite(configPath, stringifyYaml(raw));

  void logger.info('onboard.config.persisted', { event: 'claude_path_saved' });
}
