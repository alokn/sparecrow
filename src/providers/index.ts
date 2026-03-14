/** Provider registry — resolves provider name from config to a Provider bundle. */
import type { Provider, ProviderConfig } from '../types/index.js';
import { ScrowError, ErrorCode } from '../errors/index.js';
import { logger } from '../utils/index.js';
import {
  createClaudeCodeProvider,
  validateClaudeCodeBackend,
  isClaudeCodeProviderOptions,
} from './claude-code/index.js';

/** Default ProviderConfig used when no config is supplied to the registry functions. */
const DEFAULT_PROVIDER_CONFIG: ProviderConfig = {
  name: 'claude-code',
  allowDangerouslySkipPermissions: false,
  executionBackend: 'container',
};

export async function createProvider(
  name: string,
  config?: ProviderConfig,
  options?: unknown,
): Promise<Provider> {
  switch (name) {
    case 'claude-code': {
      const narrowedOptions = isClaudeCodeProviderOptions(options) ? options : undefined;
      if (options !== null && options !== undefined && narrowedOptions === undefined) {
        logger.warn('provider.registry.options_discarded', {
          reason: 'options did not pass isClaudeCodeProviderOptions type guard',
          provider: name,
        });
      }
      return await createClaudeCodeProvider(config ?? DEFAULT_PROVIDER_CONFIG, narrowedOptions);
    }
    default:
      throw new ScrowError(
        ErrorCode.PROVIDER_NOT_FOUND,
        `Unknown provider: "${name}". Supported providers: claude-code`,
      );
  }
}

/**
 * Validates the execution backend availability for the given provider config
 * without constructing the full provider bundle.
 *
 * Use this for hot-reload config validation to avoid constructing the full
 * provider (auth manager, usage monitor, task executor) unnecessarily.
 * Throws `ScrowError(CONTAINER_RUNTIME_NOT_FOUND)` when the container backend is
 * unavailable; returns normally otherwise.
 */
export async function validateProviderBackend(
  name: string,
  config?: ProviderConfig,
): Promise<void> {
  switch (name) {
    case 'claude-code':
      await validateClaudeCodeBackend(config ?? DEFAULT_PROVIDER_CONFIG);
      return;
    default:
      throw new ScrowError(
        ErrorCode.PROVIDER_NOT_FOUND,
        `Unknown provider: "${name}". Supported providers: claude-code`,
      );
  }
}
