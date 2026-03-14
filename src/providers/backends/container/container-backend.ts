/** ContainerExecutionBackend -- executes CLI commands inside rootless containers for process isolation. */
import type {
  ExecutionBackend,
  BackendExecutionOptions,
  BackendExecutionResult,
  ContainerConfig,
} from '../../../types/index.js';
import { EventName } from '../../../types/index.js';
import { detectContainerRuntime } from './detect-runtime.js';
import { resolveContainerCredentials } from './credential-resolver.js';
import { resolveBinaryMount } from './binary-resolver.js';
import type { ContainerRuntime, ContainerRunOptions, Mount } from './runtime.js';
import { ScrowError, ErrorCode } from '../../../errors/index.js';
import {
  logger,
  boundOutput,
  MAX_OUTPUT_BYTES,
  MAX_OUTPUT_BYTES_SUCCESS,
} from '../../../utils/index.js';
/**
 * Pre-compiles an array of glob patterns into RegExp objects.
 * Supports simple wildcard patterns: `*` matches any sequence of characters.
 * Called once before iterating env keys to avoid recompiling per-key per-pattern.
 */
function compileEnvPatterns(
  patterns: string[],
): Array<{ exact: string | null; regex: RegExp | null }> {
  return patterns.map((pattern) => {
    if (!pattern.includes('*')) {
      // No wildcards — use exact string match (no regex needed)
      return { exact: pattern, regex: null };
    }
    // Convert glob to regex: escape special regex chars, replace * with .*
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return { exact: null, regex: new RegExp(`^${escaped}$`) };
  });
}

/**
 * Tests whether `key` matches any of the pre-compiled patterns.
 * Patterns are compiled once via compileEnvPatterns() before iterating keys.
 */
function matchesEnvPattern(
  key: string,
  compiled: Array<{ exact: string | null; regex: RegExp | null }>,
): boolean {
  for (const { exact, regex } of compiled) {
    if (exact !== null) {
      if (exact === key) return true;
    } else if (regex !== null) {
      if (regex.test(key)) return true;
    }
  }
  return false;
}

/** Fixed mount target inside the container where the target repository is mounted. */
const WORKSPACE_PATH = '/workspace';

/** Default container image — Claude Code requires Node.js at runtime. */
const DEFAULT_IMAGE = 'node:lts-slim';

/**
 * Home directory of the non-root user in the default image (node:lts-slim).
 * The `node` user (uid=1000) has home /home/node, which is writable by uid=1000.
 * This avoids the root-owned directory problem when Docker creates bind-mount parent dirs.
 * For custom images, callers must configure HOME via options.env if the default is wrong.
 */
const DEFAULT_IMAGE_NON_ROOT_HOME = '/home/node';

/**
 * Standard Linux PATH value for the container's PATH env var.
 * Named DEFAULT_PATH_ENV_VALUE (not DEFAULT_CONTAINER_PATH) to avoid
 * confusion with WORKSPACE_PATH which is a filesystem path.
 */
const DEFAULT_PATH_ENV_VALUE = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** Label prefix for sparecrow-managed containers. */
const CONTAINER_LABEL_PREFIX = 'sparecrow.';

/** Fallback memory limit used when no container config is provided. When ContainerConfig is present, config.memoryLimitMb overrides this. */
const DEFAULT_MEMORY_LIMIT_MB = 512;
/** Fallback CPU limit used when no container config is provided. When ContainerConfig is present, config.cpuLimit overrides this. */
const DEFAULT_CPU_LIMIT = 1.0;
/** Fallback network mode used when no container config is provided. When ContainerConfig is present, config.networkMode overrides this. */
const DEFAULT_NETWORK_MODE: NonNullable<ContainerRunOptions['networkMode']> = 'bridge';
const DEFAULT_CAP_DROP: readonly string[] = ['ALL'];
const DEFAULT_SECURITY_OPTS: readonly string[] = ['no-new-privileges'];
/** Ephemeral /tmp with nosuid+noexec: prevents setuid binaries and direct execution of attacker-written files. */
const DEFAULT_TMPFS_MOUNTS: readonly string[] = ['/tmp:nosuid,noexec'];

/** Number of consecutive idle health checks before emitting a warning — matches spawnWithGuardrails threshold. */
const IDLE_CHECK_THRESHOLD = 2;

/** Default health check interval in ms — matches spawnWithGuardrails default. */
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 60_000;

export class ContainerExecutionBackend implements ExecutionBackend {
  readonly name = 'container';

  private readonly _image: string;

  /** Optional container configuration from user's config.yaml. */
  private readonly _config: ContainerConfig | undefined;

  /** Runtime preference from config — 'auto' probes Podman-first-then-Docker (default). */
  private readonly _runtimePreference: 'auto' | 'docker' | 'podman';

  /**
   * Concurrency-safe detection cache: stores the in-flight Promise itself,
   * not the resolved value. This ensures detectContainerRuntime() is called
   * at most once even under concurrent available() calls.
   */
  private _runtimeDetection: Promise<ContainerRuntime | null> | null = null;

  constructor(config?: ContainerConfig) {
    this._config = config;
    this._image = config?.image ?? DEFAULT_IMAGE;
    this._runtimePreference = config?.runtime ?? 'auto';
  }

  /** Invalidate the cached runtime detection so the next available() call re-probes. */
  resetAvailabilityCache(): void {
    this._runtimeDetection = null;
  }

  /**
   * Determines whether to mount the host claude binary into the container.
   *
   * Decision priority:
   * 1. Explicit config override `mountClaudeBinary` (true/false) — always wins
   * 2. Auto-detect: if image === DEFAULT_IMAGE → mount; if custom image → skip
   *
   * Returns `{ shouldMount, reason }` for audit logging.
   */
  shouldMountBinary(): {
    shouldMount: boolean;
    reason: 'config-override' | 'default-image' | 'custom-image';
  } {
    // Priority 1: explicit config override
    if (this._config?.mountClaudeBinary !== undefined) {
      return { shouldMount: this._config.mountClaudeBinary, reason: 'config-override' };
    }

    // Priority 2: auto-detect based on image name
    if (this._image === DEFAULT_IMAGE) {
      return { shouldMount: true, reason: 'default-image' };
    }

    return { shouldMount: false, reason: 'custom-image' };
  }

  /** Returns the mount strategy label for JSON output and audit logging. */
  get mountStrategy(): 'host-binary' | 'image-builtin' {
    return this.shouldMountBinary().shouldMount ? 'host-binary' : 'image-builtin';
  }

  /** Returns cached runtime name and version info, or null if not yet detected or runtime unavailable. */
  async getRuntimeInfo(): Promise<{ name: string; version: string } | null> {
    if (!this._runtimeDetection) return null;
    const runtime = await this._runtimeDetection;
    if (!runtime) return null;
    try {
      const info = await runtime.info();
      return { name: runtime.name, version: info.version };
    } catch {
      // info() failed — return name only with empty version
      return { name: runtime.name, version: '' };
    }
  }

  /**
   * Runtime availability check — detects container runtime on first call,
   * caches the Promise for subsequent calls (including concurrent ones).
   */
  async available(): Promise<boolean> {
    if (!this._runtimeDetection) {
      this._runtimeDetection = detectContainerRuntime(this._runtimePreference);
    }
    const runtime = await this._runtimeDetection;
    return runtime !== null;
  }

  /**
   * Start periodic health monitoring for a running container.
   * Calls runtime.stats() at the given interval to detect idle containers.
   * Returns a handle with a stop() method to clear the interval.
   */
  private startHealthMonitoring(
    runtime: ContainerRuntime,
    containerId: string,
    intervalMs: number,
  ): { stop: () => void } {
    // Precondition: intervalMs must be > 0. Callers must guard before calling.
    // setInterval(fn, 0) would fire every ~1 ms, hammering the container runtime.
    if (intervalMs <= 0) {
      throw new ScrowError(
        ErrorCode.TASK_EXECUTION_FAILED,
        `startHealthMonitoring called with invalid intervalMs: ${intervalMs}. Must be > 0.`,
      );
    }
    let consecutiveIdleChecks = 0;
    let idleWarningEmitted = false;
    let idleStartedAt: number | null = null;
    let healthCheckInProgress = false;
    let lastMemoryUsageMb: number | null = null;
    let lastMemoryLimitMb: number | null = null;

    /**
     * Shared idle-check handler for both null stats (container may have exited)
     * and cpuPercent===0.0 (CPU idle). Extracts duplicated threshold/warning/
     * idleStartedAt logic into a single place to avoid drift between branches.
     */
    function handleIdleCheck(memUsage: number | null, memLimit: number | null): void {
      consecutiveIdleChecks++;
      lastMemoryUsageMb = memUsage;
      lastMemoryLimitMb = memLimit;
      if (idleStartedAt === null) {
        idleStartedAt = Date.now() - intervalMs;
      }
      if (consecutiveIdleChecks >= IDLE_CHECK_THRESHOLD && !idleWarningEmitted) {
        idleWarningEmitted = true;
        const idleDurationMs = Date.now() - idleStartedAt;
        void logger
          .warn(EventName.CONTAINER_HEALTH_IDLE, {
            containerId,
            idleDurationMs,
            consecutiveIdleChecks,
            memoryUsageMb: lastMemoryUsageMb,
            memoryLimitMb: lastMemoryLimitMb,
          })
          .catch(() => {
            // Swallow logger rejection so a full disk cannot break the monitoring loop
          });
      }
    }

    const timer = setInterval(() => {
      if (healthCheckInProgress) return;
      healthCheckInProgress = true;

      void (async () => {
        try {
          const stats = await runtime.stats(containerId);

          if (stats === null) {
            // null = container may have exited or stats unavailable — treat as idle
            handleIdleCheck(lastMemoryUsageMb, lastMemoryLimitMb);
          } else if (stats.cpuPercent === 0.0) {
            // CPU idle
            handleIdleCheck(stats.memoryUsageMb, stats.memoryLimitMb);
          } else {
            // Active — reset idle tracking
            consecutiveIdleChecks = 0;
            idleWarningEmitted = false;
            idleStartedAt = null;
            lastMemoryUsageMb = stats.memoryUsageMb;
            lastMemoryLimitMb = stats.memoryLimitMb;
          }
        } catch (err: unknown) {
          // Stats failure — log at debug and stop monitoring entirely
          void logger
            .debug(EventName.CONTAINER_HEALTH_STATS_FAILED, {
              containerId,
              error: err instanceof Error ? err.message : String(err),
            })
            .catch(() => {
              // Swallow logger rejection so the error path remains clean
            });
          stop();
        } finally {
          healthCheckInProgress = false;
        }
      })();
    }, intervalMs);

    // NOTE: healthCheckInProgress is only meaningful while the interval is active.
    // clearInterval prevents new firings; any in-flight async IIFE will still complete
    // and reset healthCheckInProgress=false, but the interval is already gone.
    function stop(): void {
      clearInterval(timer);
    }

    return { stop };
  }

  /**
   * Execute a CLI command inside a rootless container.
   * Creates a container per execution, mounts the target repository,
   * captures output, and cleans up in all code paths.
   */
  async execute(
    command: string,
    args: string[],
    options: BackendExecutionOptions,
  ): Promise<BackendExecutionResult> {
    // Pre-abort guard: if signal is already aborted, return immediately without creating a container
    if (options.signal?.aborted) {
      return {
        stdout: '',
        stderr: '',
        exitCode: null,
        timedOut: false,
        aborted: true,
        oomKilled: false,
      };
    }

    // Ensure runtime is available
    if (!this._runtimeDetection) {
      this._runtimeDetection = detectContainerRuntime(this._runtimePreference);
    }
    const runtime = await this._runtimeDetection;
    if (!runtime) {
      throw new ScrowError(
        ErrorCode.BACKEND_NOT_AVAILABLE,
        `Container execution backend is not available — no container runtime detected.`,
      );
    }

    // Build clean environment: never inherit process.env
    const callerEnv: Record<string, string> = options.env ? { ...options.env } : {};
    if (!('PATH' in callerEnv)) {
      callerEnv['PATH'] = DEFAULT_PATH_ENV_VALUE;
    }

    // Run as host user to avoid root-rejection of --dangerously-skip-permissions (AC8–AC10).
    // Compute UID/GID first so containerHome can be derived before resolving credentials —
    // this ensures credential mount targets and HOME env are always consistent.
    const hostUid = process.getuid?.();
    const hostGid = process.getgid?.();
    const userFlag =
      hostUid !== undefined && hostGid !== undefined ? `${hostUid}:${hostGid}` : undefined;

    // When running as a non-root user, HOME must point to a writable directory inside
    // the container. Caller-provided HOME (via options.env) always takes precedence.
    // For the default image (node:lts-slim), /home/node is owned by uid=1000 and writable.
    // For custom images, fall back to /root — the container's root home is always present,
    // though it may not be writable by non-root uid (custom image users should set HOME via env).
    const effectiveContainerHome =
      'HOME' in callerEnv && callerEnv['HOME'] !== ''
        ? callerEnv['HOME']
        : userFlag !== undefined && hostUid !== 0 && this._image === DEFAULT_IMAGE
          ? DEFAULT_IMAGE_NON_ROOT_HOME
          : '/root';

    // Resolve container credentials (mounts + env defaults like HOME).
    // Pass effectiveContainerHome so credential mount targets match the HOME env var —
    // mismatching them causes "Not logged in" because Claude looks in $HOME/.claude/.
    const credentials = await resolveContainerCredentials({
      mountClaudeConfig: this._config?.mountClaudeConfig ?? true,
      containerHome: effectiveContainerHome,
    });

    // Apply envStripPatterns: remove matching keys from callerEnv BEFORE merge (AC1 — Story 18.1).
    // Pre-compile patterns once outside the key loop to avoid per-key RegExp construction.
    if (options.envStripPatterns && options.envStripPatterns.length > 0) {
      const compiledPatterns = compileEnvPatterns(options.envStripPatterns);
      const removedKeys: string[] = [];
      for (const key of Object.keys(callerEnv)) {
        if (matchesEnvPattern(key, compiledPatterns)) {
          removedKeys.push(key);
          delete callerEnv[key];
        }
      }
      if (removedKeys.length > 0) {
        void logger.debug(EventName.CONTAINER_ENV_STRIPPED, {
          removedKeys,
          patternCount: options.envStripPatterns.length,
        });
      }
    }

    // Merge: resolver defaults first, then caller overrides win (AC3, AC6)
    const env: Record<string, string> = { ...credentials.env, ...callerEnv };

    // Ensure HOME matches effectiveContainerHome so it stays consistent with credential mount
    // targets. The resolver sets HOME to containerHome but inline test mocks may return /root;
    // this explicit override is the source of truth for both production and test paths.
    if (!('HOME' in callerEnv) || callerEnv['HOME'] === '') {
      env['HOME'] = effectiveContainerHome;
    }

    // Determine mount strategy: explicit config override → auto-detect based on image.
    // Compute once and reuse for both CONTAINER_MOUNT_DECISION and CONTAINER_TASK_STARTED
    // audit events so they are consistent (fixes redundant shouldMountBinary() calls).
    const mountDecision = this.shouldMountBinary();
    let containerCommand = [command, ...args];
    const binaryMounts: Mount[] = [];
    let resolvedMountStrategy: 'host-binary' | 'image-builtin';

    if (this._config?.claudeBinaryPath) {
      // claudeBinaryPath: user-installed binary already present inside the container image.
      // Use it as the command directly — no host binary mount needed.
      // Audit strategy: 'image-builtin' because the binary comes from the image (not a host mount).
      containerCommand = [this._config.claudeBinaryPath, ...args];
      resolvedMountStrategy = 'image-builtin';
    } else if (mountDecision.shouldMount) {
      // Mount host binary: resolve the host binary and create a read-only mount
      const binaryResult = await resolveBinaryMount(command);
      if (binaryResult) {
        binaryMounts.push(binaryResult.mount);
        containerCommand = [binaryResult.containerCommandPath, ...args];
      }
      // If binaryResult is null, fall through with original command (graceful degradation)
      resolvedMountStrategy = 'host-binary';
    } else {
      // Custom image or explicit skip: use bare 'claude' command (resolved via PATH in image)
      containerCommand = ['claude', ...args];
      resolvedMountStrategy = 'image-builtin';
    }

    // Audit log: record the mount decision (AC6). Use resolvedMountStrategy (computed above)
    // so that the claudeBinaryPath branch is correctly reflected as 'image-builtin'.
    void logger.info(EventName.CONTAINER_MOUNT_DECISION, {
      mountStrategy: resolvedMountStrategy,
      image: this._image,
      reason: mountDecision.reason,
    });

    // Build container run options
    const workspaceMount = {
      source: options.cwd ?? process.cwd(),
      target: WORKSPACE_PATH,
      readonly: false,
    };

    const runOptions: ContainerRunOptions = {
      image: this._image,
      command: containerCommand,
      cwd: WORKSPACE_PATH,
      env,
      mounts: [workspaceMount, ...credentials.mounts, ...binaryMounts],
      labels: { [`${CONTAINER_LABEL_PREFIX}managed`]: 'true' },
      // Security hardening (Story 11.5) -- config values override defaults (Story 12.2)
      memoryLimitMb: this._config?.memoryLimitMb ?? DEFAULT_MEMORY_LIMIT_MB,
      cpuLimit: this._config?.cpuLimit ?? DEFAULT_CPU_LIMIT,
      networkMode: this._config?.networkMode ?? DEFAULT_NETWORK_MODE,
      capDrop: [...DEFAULT_CAP_DROP],
      securityOpts: [...DEFAULT_SECURITY_OPTS],
      tmpfsMounts: [...DEFAULT_TMPFS_MOUNTS],
      // Spread user conditionally to satisfy exactOptionalPropertyTypes
      ...(userFlag !== undefined ? { user: userFlag } : {}),
    };

    // Security audit: warn when host network mode is active (removes container network isolation)
    if (runOptions.networkMode === 'host') {
      void logger.warn(EventName.CONTAINER_HOST_NETWORK_MODE, {
        message:
          'Container is running with host network mode — all container network isolation is disabled. Ensure this is intentional.',
      });
    }

    // Log credential resolution info (Task 3.5)
    void logger.info(EventName.CONTAINER_CREDENTIALS_RESOLVED, {
      credentialMountsAdded: credentials.mounts.length,
      homeSetByResolver: !('HOME' in callerEnv),
    });

    // Warn if no credentials available: no credential mount AND no API key in env (AC4)
    // After the directory-mount switch (a29d953), the credential mount target is $HOME/.claude/
    // (a directory). Distinguish from the .claude.json config-file-only mount by checking for
    // the /.claude directory mount explicitly; a .claude.json-only mount does NOT imply auth.
    const hasCredentialMount = credentials.mounts.some((m) => m.target.endsWith('/.claude'));
    const hasApiKey = 'ANTHROPIC_API_KEY' in env;
    if (!hasCredentialMount && !hasApiKey) {
      void logger.warn(EventName.CONTAINER_CREDENTIALS_MISSING, {
        expectedPath: '~/.claude/.credentials.json',
        message:
          'No credentials found for container execution. Ensure ~/.claude/.credentials.json exists or provide ANTHROPIC_API_KEY.',
      });
    }

    // Create and start the container
    const { containerId } = await runtime.run(runOptions);

    const startTime = Date.now();

    void logger.info(EventName.CONTAINER_TASK_STARTED, {
      containerId,
      image: this._image,
      mountStrategy: resolvedMountStrategy,
      cwd: options.cwd ?? process.cwd(),
    });

    // Start health monitoring if enabled
    const healthCheckIntervalMs = options.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS;
    const monitoring =
      healthCheckIntervalMs > 0
        ? this.startHealthMonitoring(runtime, containerId, healthCheckIntervalMs)
        : null;

    // Set up abort listener
    let aborted = false;
    let abortHandler: (() => void) | null = null;
    if (options.signal) {
      abortHandler = () => {
        aborted = true;
        void runtime.remove(containerId).catch(() => {
          // Swallow — container may already be gone
        });
      };
      options.signal.addEventListener('abort', abortHandler);
    }

    try {
      // Wait for container to exit (timeout enforcement is handled by runtime.wait)
      const exitResult = await runtime.wait(containerId, options.timeoutMs);

      const durationMs = Date.now() - startTime;

      // If aborted during wait, skip logs (container may already be removed by abort handler)
      if (aborted) {
        void logger.info(EventName.CONTAINER_TASK_COMPLETED, {
          containerId,
          exitCode: null,
          timedOut: false,
          aborted: true,
          oomKilled: false,
          durationMs,
          error: null,
        });
        return {
          stdout: '',
          stderr: '',
          exitCode: null,
          timedOut: false,
          aborted: true,
          oomKilled: false,
        };
      }

      // OOM kill detection (Story 11.5 AC7) — use config value when available (Story 12.2)
      if (exitResult.oomKilled) {
        const effectiveMemoryLimitMb = this._config?.memoryLimitMb ?? DEFAULT_MEMORY_LIMIT_MB;
        void logger.warn(EventName.CONTAINER_OOM_KILLED, {
          containerId,
          memoryLimitMb: effectiveMemoryLimitMb,
          message: `Container ${containerId} was OOM-killed (memory limit: ${effectiveMemoryLimitMb} MB).`,
        });
      }

      // Capture output only when not aborted -- guarded so logs() errors don't bypass CONTAINER_TASK_COMPLETED
      const logs = await runtime.logs(containerId).catch(() => ({ stdout: '', stderr: '' }));

      void logger.info(EventName.CONTAINER_TASK_COMPLETED, {
        containerId,
        exitCode: exitResult.exitCode,
        timedOut: false,
        aborted: false,
        oomKilled: exitResult.oomKilled,
        durationMs,
        error: null,
      });

      // Bound output: 50KB on success, 10KB on failure
      const maxBytes = exitResult.exitCode === 0 ? MAX_OUTPUT_BYTES_SUCCESS : MAX_OUTPUT_BYTES;
      return {
        stdout: boundOutput(logs.stdout, maxBytes),
        stderr: boundOutput(logs.stderr, maxBytes),
        exitCode: exitResult.exitCode,
        timedOut: false,
        aborted: false,
        oomKilled: exitResult.oomKilled,
      };
    } catch (err: unknown) {
      // Timeout path: capture partial logs and return timedOut result
      if (err instanceof ScrowError && err.code === ErrorCode.TASK_TIMEOUT) {
        const partialLogs = await runtime
          .logs(containerId)
          .catch(() => ({ stdout: '', stderr: '' }));

        const durationMs = Date.now() - startTime;

        void logger.info(EventName.CONTAINER_TASK_COMPLETED, {
          containerId,
          exitCode: null,
          timedOut: true,
          aborted: false,
          oomKilled: false,
          durationMs,
          error: null,
        });

        // Bound partial output to 10KB (failure path)
        return {
          stdout: boundOutput(partialLogs.stdout, MAX_OUTPUT_BYTES),
          stderr: boundOutput(partialLogs.stderr, MAX_OUTPUT_BYTES),
          exitCode: null,
          timedOut: true,
          aborted: false,
          oomKilled: false,
        };
      }

      // Non-timeout errors: emit completion event then re-throw
      const durationMsOnError = Date.now() - startTime;
      void logger.info(EventName.CONTAINER_TASK_COMPLETED, {
        containerId,
        exitCode: null,
        timedOut: false,
        aborted: false,
        oomKilled: false,
        durationMs: durationMsOnError,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      // Stop health monitoring FIRST — prevents interval from firing on an already-removed container
      monitoring?.stop();

      // Always clean up: remove container and abort listener
      await runtime.remove(containerId).catch((e: unknown) => {
        void logger.warn(EventName.CONTAINER_REMOVE_FAILED, {
          containerId,
          error: e instanceof Error ? e.message : String(e),
        });
      });

      if (abortHandler && options.signal) {
        options.signal.removeEventListener('abort', abortHandler);
      }
    }
  }
}
