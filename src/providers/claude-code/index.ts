/** Claude Code provider bundle — composes AuthManager, UsageMonitor, and TaskExecutor implementations. */
import type { Provider, ProviderConfig } from '../../types/index.js';
import { ScrowError, ErrorCode } from '../../errors/index.js';
import { ClaudeCodeAuthManager } from './auth-manager.js';
import { ClaudeCodeUsageMonitor } from './usage-monitor.js';
import { ClaudeCodeTaskExecutor } from './task-executor.js';
import { ContainerBackendWrapper } from '../backends/index.js';
import { ContainerExecutionBackend } from '../backends/container/index.js';

export { ClaudeCodeAuthManager } from './auth-manager.js';
export { parseAuthStatusOutput } from './auth-status.js';
export type { ParsedAuthStatus, ClaudeAuthStatus } from './auth-status.js';

/** Optional runtime options for creating a Claude Code provider. */
export interface ClaudeCodeProviderOptions {
  /** Pre-created auth manager instance to reuse (avoids duplicate instantiation). */
  authManager?: ClaudeCodeAuthManager;
}

/**
 * Type guard: narrows a generic options object to `ClaudeCodeProviderOptions`.
 * Used by the provider registry to accept provider-neutral options and internally narrow
 * to the Claude Code-specific shape without leaking provider types into the registry barrel.
 */
export function isClaudeCodeProviderOptions(value: unknown): value is ClaudeCodeProviderOptions {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  const v = value as Record<string, unknown>;
  const { authManager } = v;
  if (authManager !== undefined && !(authManager instanceof ClaudeCodeAuthManager)) return false;
  return true;
}

/**
 * Validates the execution backend availability for a Claude Code provider config.
 *
 * Instantiates the container backend and calls `available()`. Throws
 * `ScrowError(CONTAINER_RUNTIME_NOT_FOUND)` if the runtime is not found.
 * Does NOT construct the full provider bundle.
 *
 * Use this for hot-reload validation to avoid the side-effect-laden full-provider construction.
 */
export async function validateClaudeCodeBackend(config: ProviderConfig): Promise<void> {
  const backend = new ContainerExecutionBackend(config.container);
  const isAvailable = await backend.available();
  if (!isAvailable) {
    throw new ScrowError(
      ErrorCode.CONTAINER_RUNTIME_NOT_FOUND,
      "Container runtime not found. The 'container' execution backend requires Docker or Podman.",
    );
  }
}

/**
 * Creates a Claude Code provider bundle (authManager, usageMonitor, taskExecutor).
 *
 * Always constructs a ContainerBackendWrapper around a ContainerExecutionBackend.
 * Validates container runtime availability at startup via `backend.available()`.
 * If the runtime is not found, throws `ScrowError(CONTAINER_RUNTIME_NOT_FOUND)`.
 */
export async function createClaudeCodeProvider(
  config: ProviderConfig,
  options?: ClaudeCodeProviderOptions,
): Promise<Provider> {
  const primary = new ContainerExecutionBackend(config.container);

  // Startup validation: container runtime must be available at startup.
  const isAvailable = await primary.available();
  if (!isAvailable) {
    throw new ScrowError(
      ErrorCode.CONTAINER_RUNTIME_NOT_FOUND,
      "Container runtime not found. The 'container' execution backend requires Docker or Podman.",
    );
  }

  const backend = new ContainerBackendWrapper(primary);

  const authManager = options?.authManager ?? new ClaudeCodeAuthManager();

  return {
    authManager,
    usageMonitor: new ClaudeCodeUsageMonitor({ authManager }),
    taskExecutor: new ClaudeCodeTaskExecutor(config, backend),
    backend,
  };
}
