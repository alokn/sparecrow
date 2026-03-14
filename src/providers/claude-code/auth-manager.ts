/** Claude Code AuthManager — reads, validates, and refreshes OAuth tokens from ~/.claude/ storage. */
import { access, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ScrowError, ErrorCode } from '../../errors/index.js';
import type { AuthManager } from '../../types/index.js';
import { atomicWrite, isRecord, logger, retryWithBackoff, VERSION } from '../../utils/index.js';

/** Subscription metadata read from the credentials file. */
export interface SubscriptionMetadata {
  subscriptionType: string | null;
  rateLimitTier: string | null;
}

const CLAUDE_DIR = join(homedir(), '.claude');
const CREDENTIALS_FILE = '.credentials.json';
const CREDENTIALS_PATH = join(CLAUDE_DIR, CREDENTIALS_FILE);
const TOKEN_TTL_MS = 28_800_000;
const PROACTIVE_REFRESH_RATIO = 0.75;
const TRANSIENT_RETRY_DELAY_MS = 100;
const REFRESH_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
const REFRESH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REFRESH_FAILURE_COOLDOWN_MS = 15 * 60 * 1000;
const USER_AGENT = `sparecrow/${VERSION}`;

interface ParsedCredentials {
  raw: Record<string, unknown>;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  shape: 'top-level' | 'claudeAiOauth';
}

interface RefreshedCredentials {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseExpiresAt(value: unknown): Date | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1_000_000_000_000 ? value : value * 1000;
    return new Date(ms);
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && value.trim() !== '') {
      const ms = numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
      return new Date(ms);
    }
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed);
    }
  }
  return null;
}

function parseExpiresIn(value: unknown): Date | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return new Date(Date.now() + value * 1000);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class ClaudeCodeAuthManager implements AuthManager {
  private lastRefreshAt: Date | null = null;
  private lastRefreshFailedAt: Date | null = null;
  private tokenExpiresAt: Date | null = null;

  async getToken(): Promise<string> {
    await this.ensureCredentialFileExists(CREDENTIALS_PATH);
    await this.checkPermissions(CREDENTIALS_PATH);
    let credentials = await this.readCredentials(CREDENTIALS_PATH);

    if (this.isRefreshNeeded()) {
      await this.refresh();
      credentials = await this.readCredentials(CREDENTIALS_PATH);
    }

    return credentials.accessToken;
  }

  async refresh(): Promise<void> {
    try {
      await this.ensureCredentialFileExists(CREDENTIALS_PATH);
      const credentials = await this.readCredentials(CREDENTIALS_PATH);

      if (!credentials.refreshToken) {
        await logger.warn('AUTH_REFRESH_UNAVAILABLE', {
          reason: 'refresh_token_missing',
        });
        return;
      }

      // `retryWithBackoff` uses `maxRetries`, so maxRetries=1 => 2 total attempts.
      const response = await retryWithBackoff(
        () =>
          fetch(REFRESH_ENDPOINT, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': USER_AGENT,
              'anthropic-beta': 'oauth-2025-04-20',
            },
            body: JSON.stringify({
              grant_type: 'refresh_token',
              // refreshToken is guaranteed non-null by the guard above (line 99)
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              refresh_token: credentials.refreshToken!,
              client_id: REFRESH_CLIENT_ID,
            }),
          }),
        { maxRetries: 1 },
      );

      if (!response.ok) {
        await logger.error('AUTH_REFRESH_FAILED', {
          status: response.status,
          statusText: response.statusText,
        });
        await this.setRefreshCooldown();
        return;
      }

      const responseBody: unknown = await response.json();
      const refreshed = this.parseRefreshResponse(responseBody);
      if (!refreshed) {
        await logger.error('AUTH_REFRESH_FORMAT', { reason: 'unexpected_response_format' });
        await this.setRefreshCooldown();
        return;
      }

      const updated = this.mergeRefreshedCredentials(credentials, refreshed);
      await atomicWrite(CREDENTIALS_PATH, `${JSON.stringify(updated, null, 2)}\n`);

      this.lastRefreshAt = new Date();
      this.lastRefreshFailedAt = null;
      this.tokenExpiresAt = refreshed.expiresAt ?? this.tokenExpiresAt;
      await logger.info('AUTH_TOKEN_REFRESHED', { source: 'oauth_refresh' });
    } catch (error: unknown) {
      await logger.error(
        'AUTH_REFRESH_ERROR',
        { reason: 'refresh_failed' },
        error instanceof Error ? error : undefined,
      );
      await this.setRefreshCooldown();
    }
  }

  async validate(): Promise<boolean> {
    try {
      await this.ensureCredentialFileExists(CREDENTIALS_PATH);
      await this.readCredentials(CREDENTIALS_PATH);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Reads subscription metadata (subscriptionType, rateLimitTier) from the credentials file.
   * Returns null for each field if the file is missing, unreadable, or the field is absent.
   * Never throws — always returns a SubscriptionMetadata object (with nulls on failure).
   */
  async readSubscriptionTier(): Promise<SubscriptionMetadata> {
    const fallback: SubscriptionMetadata = { subscriptionType: null, rateLimitTier: null };
    try {
      const content = await readFile(CREDENTIALS_PATH, 'utf-8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        await logger.debug('auth.read_subscription_tier.parse_failed', {
          reason: 'invalid_json',
        });
        return fallback;
      }

      if (!isRecord(parsed)) {
        await logger.debug('auth.read_subscription_tier.parse_failed', {
          reason: 'non_object_json',
        });
        return fallback;
      }

      // Support both claudeAiOauth nested shape and top-level shape.
      // If claudeAiOauth exists and contains rateLimitTier, use it.
      // If claudeAiOauth exists but lacks rateLimitTier, fall back to the top-level fields
      // so mixed-shape credentials (nested object present but tier at top level) still work.
      const claudeAiOauth = parsed['claudeAiOauth'];
      let subscriptionType: string | null = null;
      let rateLimitTier: string | null = null;

      if (isRecord(claudeAiOauth)) {
        subscriptionType = asString(claudeAiOauth['subscriptionType']);
        rateLimitTier = asString(claudeAiOauth['rateLimitTier']);
      }

      // Fall back to top-level fields when the nested shape doesn't have them
      if (subscriptionType == null) {
        subscriptionType = asString(parsed['subscriptionType']);
      }
      if (rateLimitTier == null) {
        rateLimitTier = asString(parsed['rateLimitTier']);
      }

      if (rateLimitTier == null) {
        await logger.debug('auth.read_subscription_tier.missing_field', {
          reason: 'rateLimitTier_absent',
        });
      }

      return { subscriptionType, rateLimitTier };
    } catch {
      await logger.debug('auth.read_subscription_tier.file_read_failed', {
        reason: 'credentials_file_unreadable',
      });
      return fallback;
    }
  }

  private async ensureCredentialFileExists(filePath: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await access(filePath);
        return;
      } catch (error: unknown) {
        if (this.isRetryableFsError(error) && attempt === 0) {
          await delay(TRANSIENT_RETRY_DELAY_MS);
          continue;
        }
        throw new ScrowError(
          ErrorCode.AUTH_TOKEN_MISSING,
          'No Claude Code credentials found. Run "claude auth login" first.',
          error instanceof Error ? error : undefined,
        );
      }
    }
  }

  private async checkPermissions(filePath: string): Promise<void> {
    if (this.shouldSkipPermissionCheck(filePath)) {
      await logger.debug('AUTH_PERMISSION_CHECK_SKIPPED', {
        path: filePath,
        platform: process.platform,
      });
      return;
    }

    try {
      const fileStats = await stat(filePath);
      const mode = fileStats.mode & 0o777;
      if (mode !== 0o600) {
        await logger.warn('AUTH_CREDENTIALS_PERMISSIONS_OPEN', {
          path: filePath,
          expectedMode: '0600',
          actualMode: mode.toString(8).padStart(4, '0'),
        });
      }
    } catch {
      await logger.warn('AUTH_CREDENTIALS_PERMISSION_CHECK_FAILED', {
        path: filePath,
      });
    }
  }

  private shouldSkipPermissionCheck(filePath: string): boolean {
    if (process.platform === 'win32') {
      return true;
    }
    return process.platform === 'linux' && filePath.startsWith('/mnt/');
  }

  private async readCredentials(filePath: string): Promise<ParsedCredentials> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const fileContent = await this.readCredentialFileContent(filePath);
      try {
        const parsed = this.parseCredentialContent(fileContent, filePath);
        this.tokenExpiresAt = parsed.expiresAt;
        return parsed;
      } catch (error: unknown) {
        if (this.isTransientFormatError(error) && attempt === 0) {
          await delay(TRANSIENT_RETRY_DELAY_MS);
          continue;
        }
        throw error;
      }
    }

    throw new ScrowError(
      ErrorCode.AUTH_TOKEN_FORMAT_CHANGED,
      'Claude Code credential format has changed. Expected JSON with accessToken field.',
    );
  }

  private async readCredentialFileContent(filePath: string): Promise<string> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await readFile(filePath, 'utf-8');
      } catch (error: unknown) {
        if (this.isRetryableFsError(error) && attempt === 0) {
          await delay(TRANSIENT_RETRY_DELAY_MS);
          continue;
        }
        if (this.isRetryableFsError(error)) {
          throw new ScrowError(
            ErrorCode.AUTH_TOKEN_MISSING,
            'No Claude Code credentials found. Run "claude auth login" first.',
            error instanceof Error ? error : undefined,
          );
        }
        throw error;
      }
    }

    throw new ScrowError(
      ErrorCode.AUTH_TOKEN_MISSING,
      'No Claude Code credentials found. Run "claude auth login" first.',
    );
  }

  private parseCredentialContent(content: string, filePath: string): ParsedCredentials {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error: unknown) {
      // This parser stays synchronous; logging is intentionally fire-and-forget.
      void logger.warn('AUTH_TOKEN_FORMAT_DISCREPANCY', {
        path: filePath,
        reason: 'invalid_json',
      });
      throw new ScrowError(
        ErrorCode.AUTH_TOKEN_FORMAT_CHANGED,
        'Claude Code credential format has changed. Expected JSON with accessToken field.',
        error instanceof Error ? error : undefined,
      );
    }

    if (!isRecord(parsed)) {
      void logger.warn('AUTH_TOKEN_FORMAT_DISCREPANCY', {
        path: filePath,
        reason: 'non_object_json',
      });
      throw new ScrowError(
        ErrorCode.AUTH_TOKEN_FORMAT_CHANGED,
        'Claude Code credential format has changed. Expected JSON with accessToken field.',
      );
    }

    const topLevelToken = asString(parsed['accessToken']);
    if (topLevelToken) {
      return {
        raw: parsed,
        accessToken: topLevelToken,
        refreshToken: asString(parsed['refreshToken']),
        expiresAt: parseExpiresAt(parsed['expiresAt']),
        shape: 'top-level',
      };
    }

    const claudeAiOauth = parsed['claudeAiOauth'];
    if (isRecord(claudeAiOauth)) {
      const nestedToken = asString(claudeAiOauth['accessToken']);
      if (nestedToken) {
        return {
          raw: parsed,
          accessToken: nestedToken,
          refreshToken: asString(claudeAiOauth['refreshToken']),
          expiresAt: parseExpiresAt(claudeAiOauth['expiresAt']),
          shape: 'claudeAiOauth',
        };
      }
    }

    void logger.warn('AUTH_TOKEN_FORMAT_DISCREPANCY', {
      path: filePath,
      reason: 'missing_access_token',
      topLevelKeys: Object.keys(parsed).sort(),
    });
    throw new ScrowError(
      ErrorCode.AUTH_TOKEN_FORMAT_CHANGED,
      'Claude Code credential format has changed. Expected JSON with accessToken field.',
    );
  }

  private parseRefreshResponse(payload: unknown): RefreshedCredentials | null {
    if (!isRecord(payload)) {
      return null;
    }

    const accessToken = asString(payload['accessToken']) ?? asString(payload['access_token']);
    if (!accessToken) {
      return null;
    }

    const refreshToken = asString(payload['refreshToken']) ?? asString(payload['refresh_token']);
    const expiresAt =
      parseExpiresAt(payload['expiresAt']) ??
      parseExpiresAt(payload['expires_at']) ??
      parseExpiresIn(payload['expires_in']);

    return {
      accessToken,
      refreshToken,
      expiresAt,
    };
  }

  private mergeRefreshedCredentials(
    existing: ParsedCredentials,
    refreshed: RefreshedCredentials,
  ): Record<string, unknown> {
    const refreshToken = refreshed.refreshToken ?? existing.refreshToken;

    if (existing.shape === 'claudeAiOauth') {
      const claudeAiOauth = isRecord(existing.raw['claudeAiOauth'])
        ? { ...existing.raw['claudeAiOauth'] }
        : {};
      claudeAiOauth['accessToken'] = refreshed.accessToken;
      if (refreshToken) {
        claudeAiOauth['refreshToken'] = refreshToken;
      }
      if (refreshed.expiresAt) {
        claudeAiOauth['expiresAt'] = refreshed.expiresAt.getTime();
      }

      return {
        ...existing.raw,
        claudeAiOauth,
      };
    }

    const updated: Record<string, unknown> = {
      ...existing.raw,
      accessToken: refreshed.accessToken,
    };
    if (refreshToken) {
      updated['refreshToken'] = refreshToken;
    }
    if (refreshed.expiresAt) {
      updated['expiresAt'] = refreshed.expiresAt.toISOString();
    }
    return updated;
  }

  private isRefreshNeeded(): boolean {
    if (!this.tokenExpiresAt) {
      return false;
    }

    const now = Date.now();
    if (now >= this.tokenExpiresAt.getTime()) {
      return true;
    }

    const refreshAnchor =
      this.lastRefreshAt ?? new Date(this.tokenExpiresAt.getTime() - TOKEN_TTL_MS);
    const elapsedSinceAnchor = now - refreshAnchor.getTime();
    if (elapsedSinceAnchor < TOKEN_TTL_MS * PROACTIVE_REFRESH_RATIO) {
      return false;
    }

    if (
      this.lastRefreshFailedAt !== null &&
      now - this.lastRefreshFailedAt.getTime() < REFRESH_FAILURE_COOLDOWN_MS
    ) {
      return false;
    }

    return true;
  }

  private async setRefreshCooldown(): Promise<void> {
    const now = Date.now();
    this.lastRefreshFailedAt = new Date(now);
    const nextRetryAt = new Date(now + REFRESH_FAILURE_COOLDOWN_MS).toISOString();
    await logger.warn('AUTH_REFRESH_COOLDOWN', {
      cooldownMinutes: Math.round(REFRESH_FAILURE_COOLDOWN_MS / 60_000),
      nextRetryAt,
    });
  }

  private isRetryableFsError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'EACCES';
  }

  private isTransientFormatError(error: unknown): boolean {
    return (
      error instanceof ScrowError &&
      error.code === ErrorCode.AUTH_TOKEN_FORMAT_CHANGED &&
      error.cause instanceof SyntaxError
    );
  }
}
