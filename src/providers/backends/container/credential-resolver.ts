/** CredentialResolver -- detects host credentials and produces container mount/env configuration. */
import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Mount } from './runtime.js';
import { logger } from '../../../utils/index.js';
import { EventName } from '../../../types/index.js';

/** The Claude config directory name. */
const CLAUDE_DIR_NAME = '.claude';

/** The credentials filename — used to probe whether the .claude/ directory is accessible. */
const CREDENTIALS_FILE = '.credentials.json';

/** The Claude Code config file in the home directory root (separate from ~/.claude/ directory). */
const CLAUDE_JSON_FILE = '.claude.json';

/**
 * Default home directory in container images.
 * Assumes the container process runs as root (standard for node:lts-slim, ubuntu, debian).
 * If Story 11.5 introduces a non-root container user (e.g. `node` in hardened images),
 * callers must supply `containerHome` via `CredentialResolverOptions` to override this default.
 */
const CONTAINER_HOME = '/root';

/** Options for overriding credential resolution paths (primarily for testability). */
export interface CredentialResolverOptions {
  hostHomedir?: string;
  containerHome?: string;
  /** When false, skip ~/.claude/ credential mounts entirely (Story 12.2). Default: true. */
  mountClaudeConfig?: boolean;
  /**
   * When true (default), mount `~/.claude/` read-only to prevent container processes from
   * modifying or tampering with OAuth credentials (Story 22.1).
   * When false, mount read-write (reverts to pre-v1.1 behaviour); a `warn`-level log is
   * emitted unconditionally whenever this is set to false, regardless of whether credentials
   * currently exist on disk. Set via `mount_claude_config_readonly: false` in config.
   */
  mountClaudeConfigReadonly?: boolean;
}

/** Return type describing mounts and env vars to add to the container. */
export interface ContainerCredentials {
  mounts: Mount[];
  env: Record<string, string>;
}

/**
 * Detects available credentials on the host and produces mount/env configuration
 * for the container backend. Never throws -- missing files result in empty mounts
 * with a debug-level log.
 */
export async function resolveContainerCredentials(
  options?: CredentialResolverOptions,
): Promise<ContainerCredentials> {
  const containerHome = options?.containerHome ?? CONTAINER_HOME;
  const mountClaudeConfig = options?.mountClaudeConfig ?? true;
  const mountReadonly = options?.mountClaudeConfigReadonly ?? true;

  // When mountClaudeConfig is false, skip all credential/settings file probes (Story 12.2 AC5/6.3)
  if (!mountClaudeConfig) {
    return {
      mounts: [],
      env: { HOME: containerHome },
    };
  }

  // Emit the security warning unconditionally when the readonly override is disabled —
  // regardless of whether credentials currently exist on disk. If the user has set
  // mount_claude_config_readonly: false, the security implication applies whether or not
  // the .credentials.json file is currently present (it may appear later or be probed).
  if (!mountReadonly) {
    logger
      .warn(EventName.CONTAINER_CREDENTIALS_RW_OVERRIDE, {
        message:
          'Credential mount is read-write (mount_claude_config_readonly: false). A compromised container process could modify OAuth credentials.',
      })
      .catch(() => {
        // Ignore logger errors (e.g. full disk) — security warning is best-effort
      });
  }

  try {
    const mounts: Mount[] = [];

    // Resolve host home directory once — used for both .claude/ dir and .claude.json file paths.
    const hostHomedir = options?.hostHomedir ?? homedir();

    // Resolve host paths
    const hostClaudeDir = join(hostHomedir, CLAUDE_DIR_NAME);
    const hostCredentialsPath = join(hostClaudeDir, CREDENTIALS_FILE);

    // Resolve container path (directory, not individual files)
    const containerClaudeDir = join(containerHome, CLAUDE_DIR_NAME);

    // Check if credentials file is readable — used as a proxy for the whole .claude/ dir
    // (R_OK matches project convention from doctor-runner.ts, repo-validation.ts)
    const credentialsFileExists = await access(hostCredentialsPath, constants.R_OK)
      .then(() => true)
      .catch(() => false);

    if (credentialsFileExists) {
      // Mount the entire .claude/ directory (not individual files) so the bind-mount
      // target inherits host uid ownership. File-level mounts cause Docker to create
      // the parent directory as root-owned, blocking non-root Claude from writing to
      // $HOME/.claude/plugins/ and similar subdirs during initialisation.
      mounts.push({
        source: hostClaudeDir,
        target: containerClaudeDir,
        readonly: mountReadonly,
      });
    } else {
      // Debug-level log -- the user-facing warn is emitted by ContainerExecutionBackend.execute()
      void logger.debug(EventName.CONTAINER_CREDENTIALS_MISSING, {
        expectedPath: hostCredentialsPath,
      });
    }

    // Probe for ~/.claude.json — a separate file in the home directory root containing
    // startup metadata, cached feature gates, etc. Without it Claude Code emits
    // "configuration file not found" warnings to stderr on every task execution.
    const hostClaudeJsonPath = join(hostHomedir, CLAUDE_JSON_FILE);
    const claudeJsonExists = await access(hostClaudeJsonPath, constants.R_OK)
      .then(() => true)
      .catch(() => false);

    if (claudeJsonExists) {
      // File-level mount is safe: target parent ($HOME) already exists in container images.
      // Mount as read-write because Claude Code may update numStartups, cached gates, etc.
      mounts.push({
        source: hostClaudeJsonPath,
        target: join(containerHome, CLAUDE_JSON_FILE),
        readonly: false,
      });
    } else {
      // Use CONTAINER_CONFIG_FILE_MISSING (not CONTAINER_CREDENTIALS_MISSING) — this file
      // is startup metadata/feature flags, not authentication credentials.
      void logger.debug(EventName.CONTAINER_CONFIG_FILE_MISSING, {
        expectedPath: hostClaudeJsonPath,
      });
    }

    // Build env: always include HOME so Claude Code resolves ~/.claude/ correctly (AC6)
    const env: Record<string, string> = {
      HOME: containerHome,
    };

    return { mounts, env };
  } catch (err: unknown) {
    // Top-level guard: never throw even on unforeseen errors (AC7)
    // Use CONTAINER_CREDENTIALS_ERROR (not CONTAINER_CREDENTIALS_MISSING) -- this is an
    // infrastructure failure (e.g. homedir() threw), not a missing-credentials scenario.
    void logger.warn(EventName.CONTAINER_CREDENTIALS_ERROR, {
      error: err instanceof Error ? err.message : String(err),
      message: 'Unexpected error during credential resolution, returning empty mounts',
    });

    return {
      mounts: [],
      env: { HOME: containerHome },
    };
  }
}
