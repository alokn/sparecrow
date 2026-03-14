/** OAuth usage source adapter calling the Claude OAuth usage endpoint and normalizing response data. */
import { ScrowError, ErrorCode } from '../../../errors/index.js';
import type { AuthManager, CapacitySnapshot } from '../../../types/index.js';
import { retryWithBackoff, VERSION } from '../../../utils/index.js';
import { parseUsagePayload } from './usage-payload.js';

const OAUTH_USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
const REQUEST_TIMEOUT_MS = 5000;

type FetchFn = typeof fetch;

function isRetryableNetworkError(error: Error): boolean {
  if (error instanceof ScrowError) {
    return false;
  }

  if (error.name === 'AbortError' || error instanceof TypeError) {
    return true;
  }

  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'RETRYABLE_HTTP'
  );
}

async function fetchWithTimeout(
  fetchFn: FetchFn,
  token: string,
  userAgent: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchFn(OAUTH_USAGE_ENDPOINT, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': userAgent,
        'anthropic-beta': OAUTH_BETA_HEADER,
        'Accept-Encoding': 'gzip',
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export interface OAuthUsageSourceOptions {
  authManager: AuthManager;
  fetchFn?: FetchFn;
  userAgent?: string;
}

export class OAuthUsageSource {
  private readonly authManager: AuthManager;
  private readonly fetchFn: FetchFn;
  private readonly userAgent: string;

  constructor(options: OAuthUsageSourceOptions) {
    this.authManager = options.authManager;
    this.fetchFn = options.fetchFn ?? fetch;
    this.userAgent = options.userAgent ?? `sparecrow/${VERSION}`;
  }

  async poll(): Promise<CapacitySnapshot> {
    const token = await this.authManager.getToken();

    const response = await retryWithBackoff(
      () =>
        fetchWithTimeout(this.fetchFn, token, this.userAgent, REQUEST_TIMEOUT_MS).then((result) =>
          this.validateResponse(result),
        ),
      {
        maxRetries: 2,
        baseDelayMs: 200,
        maxDelayMs: 2000,
        retryOn: isRetryableNetworkError,
      },
    );

    let payload: unknown;
    try {
      payload = (await response.json()) as unknown;
    } catch (error: unknown) {
      throw new ScrowError(
        ErrorCode.PROVIDER_UNREACHABLE,
        'OAuth usage endpoint returned invalid JSON payload.',
        error instanceof Error ? error : undefined,
      );
    }

    return parseUsagePayload(payload, 'oauth');
  }

  private validateResponse(response: Response): Response {
    if (response.status === 401) {
      throw new ScrowError(
        ErrorCode.AUTH_TOKEN_EXPIRED,
        'OAuth token expired while polling usage.',
      );
    }

    if (response.status === 429) {
      throw new ScrowError(
        ErrorCode.PROVIDER_UNREACHABLE,
        'OAuth usage endpoint is rate limited. Will retry on next poll cycle.',
      );
    }

    if (response.status >= 500) {
      const error = new Error(`retryable_oauth_status_${response.status}`) as NodeJS.ErrnoException;
      error.code = 'RETRYABLE_HTTP';
      throw error;
    }

    if (!response.ok) {
      throw new ScrowError(
        ErrorCode.PROVIDER_UNREACHABLE,
        `OAuth usage endpoint returned status ${response.status}.`,
      );
    }

    return response;
  }
}
