/** Shared parser and types for claude auth status --json output. */
import { logger } from '../../utils/index.js';

/** Raw shape of `claude auth status --json` CLI output. */
export interface ClaudeAuthStatus {
  loggedIn: boolean;
  subscriptionType?: string;
  [key: string]: unknown;
}

/** Named return type for the auth status parser. */
export interface ParsedAuthStatus {
  authenticated: boolean;
  tier: string;
}

/** Parse `claude auth status --json` output safely. */
export function parseAuthStatusOutput(raw: string): ParsedAuthStatus {
  if (!raw.trim()) {
    return { authenticated: false, tier: 'unknown' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    void logger.warn('onboard.auth.status_malformed_json', { reason: 'parse_error' });
    return { authenticated: false, tier: 'unknown' };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { authenticated: false, tier: 'unknown' };
  }

  const obj = parsed as ClaudeAuthStatus;
  const rawLoggedIn = obj['loggedIn'];
  const authenticated = rawLoggedIn === true;
  if (!authenticated) {
    void logger.debug('onboard.auth.status_not_authenticated', {
      hasKey: 'loggedIn' in obj,
      value: typeof rawLoggedIn,
    });
  }

  const rawSubscriptionType = obj['subscriptionType'];
  const tier =
    typeof rawSubscriptionType === 'string' && rawSubscriptionType.length > 0
      ? rawSubscriptionType
      : 'unknown';

  return { authenticated, tier };
}
