/** Unit tests for ClaudeCodeAuthManager token reading, validation, and refresh behavior. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../errors/index.js';
import { ClaudeCodeAuthManager } from './auth-manager.js';

const fsMock = vi.hoisted(() => ({
  access: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
}));

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const retryWithBackoffMock = vi.hoisted(() => vi.fn());
const atomicWriteMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', () => fsMock);
vi.mock('node:os', () => ({ homedir: () => '/home/test' }));
vi.mock('../../utils/index.js', () => ({
  logger: loggerMock,
  retryWithBackoff: retryWithBackoffMock,
  atomicWrite: atomicWriteMock,
  isRecord: (value: unknown) =>
    typeof value === 'object' && value !== null && !Array.isArray(value),
  VERSION: 'test',
}));

function createCredentialsJson(options?: {
  accessToken?: string;
  refreshToken?: string | null;
  expiresAt?: number | string;
}): string {
  const accessToken = options?.accessToken ?? 'access-token';
  const refreshToken = options?.refreshToken === undefined ? 'refresh-token' : options.refreshToken;
  const expiresAt = options?.expiresAt ?? Date.now() + 7 * 60 * 60 * 1000;

  return JSON.stringify({
    claudeAiOauth: {
      accessToken,
      refreshToken,
      expiresAt,
      scopes: ['org:read'],
    },
    mcpOAuth: {},
  });
}

function createTopLevelCredentialsJson(options?: {
  accessToken?: string;
  refreshToken?: string | null;
  expiresAt?: number | string;
}): string {
  const accessToken = options?.accessToken ?? 'access-token';
  const refreshToken = options?.refreshToken === undefined ? 'refresh-token' : options.refreshToken;
  const expiresAt = options?.expiresAt ?? Date.now() + 7 * 60 * 60 * 1000;

  return JSON.stringify({
    accessToken,
    refreshToken,
    expiresAt,
    profile: { activeOrg: 'org_123' },
  });
}

function createFsError(code: 'ENOENT' | 'EACCES'): NodeJS.ErrnoException {
  const error = new Error('Filesystem failure') as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function collectLoggerOutput(): string {
  const calls = [
    ...loggerMock.debug.mock.calls,
    ...loggerMock.info.mock.calls,
    ...loggerMock.warn.mock.calls,
    ...loggerMock.error.mock.calls,
  ];

  return calls
    .map((call) =>
      call.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' '),
    )
    .join('\n');
}

describe('ClaudeCodeAuthManager', () => {
  let authManager: ClaudeCodeAuthManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    authManager = new ClaudeCodeAuthManager();

    fsMock.access.mockResolvedValue(undefined);
    fsMock.stat.mockResolvedValue({ mode: 0o100600 });
    fsMock.readFile.mockResolvedValue(createCredentialsJson());
    retryWithBackoffMock.mockImplementation(async (fn: () => Promise<unknown>) => fn());
    atomicWriteMock.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('returns token when valid credential file exists', async () => {
    await expect(authManager.getToken()).resolves.toBe('access-token');
  });

  it('returns token when credential file uses top-level token shape', async () => {
    fsMock.readFile.mockResolvedValue(
      createTopLevelCredentialsJson({
        accessToken: 'top-level-token',
      }),
    );

    await expect(authManager.getToken()).resolves.toBe('top-level-token');
  });

  it('throws AUTH_TOKEN_MISSING when credential file does not exist', async () => {
    fsMock.access.mockRejectedValue(createFsError('ENOENT'));

    await expect(authManager.getToken()).rejects.toMatchObject({
      code: ErrorCode.AUTH_TOKEN_MISSING,
    });
  });

  it('throws AUTH_TOKEN_MISSING when non-error access failures occur', async () => {
    fsMock.access.mockRejectedValue('permission-denied');

    await expect(authManager.getToken()).rejects.toMatchObject({
      code: ErrorCode.AUTH_TOKEN_MISSING,
    });
  });

  it('throws AUTH_TOKEN_FORMAT_CHANGED when credential file has invalid JSON', async () => {
    fsMock.readFile.mockResolvedValue('{"invalidJson":');

    await expect(authManager.getToken()).rejects.toMatchObject({
      code: ErrorCode.AUTH_TOKEN_FORMAT_CHANGED,
    });
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'AUTH_TOKEN_FORMAT_DISCREPANCY',
      expect.objectContaining({ reason: 'invalid_json' }),
    );
  });

  it('throws AUTH_TOKEN_FORMAT_CHANGED when expected token field is missing', async () => {
    fsMock.readFile.mockResolvedValue(
      JSON.stringify({
        claudeAiOauth: { refreshToken: 'missing-access-token' },
      }),
    );

    await expect(authManager.getToken()).rejects.toMatchObject({
      code: ErrorCode.AUTH_TOKEN_FORMAT_CHANGED,
    });
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'AUTH_TOKEN_FORMAT_DISCREPANCY',
      expect.objectContaining({ reason: 'missing_access_token' }),
    );
  });

  it('throws AUTH_TOKEN_FORMAT_CHANGED when credential JSON is not an object', async () => {
    fsMock.readFile.mockResolvedValue(JSON.stringify('string-value'));

    await expect(authManager.getToken()).rejects.toMatchObject({
      code: ErrorCode.AUTH_TOKEN_FORMAT_CHANGED,
    });
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'AUTH_TOKEN_FORMAT_DISCREPANCY',
      expect.objectContaining({ reason: 'non_object_json' }),
    );
  });

  it('retries credential file reads after transient filesystem errors', async () => {
    fsMock.readFile
      .mockRejectedValueOnce(createFsError('ENOENT'))
      .mockResolvedValueOnce(createCredentialsJson({ accessToken: 'retry-token' }));

    await expect(authManager.getToken()).resolves.toBe('retry-token');
    expect(fsMock.readFile).toHaveBeenCalledTimes(2);
  });

  it('throws AUTH_TOKEN_MISSING when transient credential file read errors persist', async () => {
    fsMock.readFile
      .mockRejectedValueOnce(createFsError('EACCES'))
      .mockRejectedValueOnce(createFsError('EACCES'));

    await expect(authManager.getToken()).rejects.toMatchObject({
      code: ErrorCode.AUTH_TOKEN_MISSING,
    });
    expect(fsMock.readFile).toHaveBeenCalledTimes(2);
  });

  it('retries parsing after transient invalid JSON and then returns token', async () => {
    fsMock.readFile
      .mockResolvedValueOnce('{"incomplete":')
      .mockResolvedValueOnce(createCredentialsJson({ accessToken: 'recovered-token' }));

    await expect(authManager.getToken()).resolves.toBe('recovered-token');
    expect(fsMock.readFile).toHaveBeenCalledTimes(2);
  });

  it('logs warning when credential file permissions are not 0600', async () => {
    fsMock.stat.mockResolvedValue({ mode: 0o100644 });

    await authManager.getToken();

    expect(loggerMock.warn).toHaveBeenCalledWith(
      'AUTH_CREDENTIALS_PERMISSIONS_OPEN',
      expect.objectContaining({ actualMode: '0644' }),
    );
  });

  it('does not log token values while reading credentials', async () => {
    const sensitiveToken = 'sensitive-access-token';
    fsMock.readFile.mockResolvedValue(createCredentialsJson({ accessToken: sensitiveToken }));

    await authManager.getToken();

    expect(collectLoggerOutput()).not.toContain(sensitiveToken);
  });

  it('returns true from validate when credential file structure is valid', async () => {
    await expect(authManager.validate()).resolves.toBe(true);
  });

  it('returns false from validate when credential file does not exist', async () => {
    fsMock.access.mockRejectedValue(createFsError('ENOENT'));

    await expect(authManager.validate()).resolves.toBe(false);
  });

  it('returns false from validate when credential file format is invalid', async () => {
    fsMock.readFile.mockResolvedValue('not-json');

    await expect(authManager.validate()).resolves.toBe(false);
  });

  it('avoids network calls during validate format check', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await authManager.validate();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes token and writes updated credentials on successful refresh call', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: vi.fn().mockResolvedValue({
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await authManager.refresh();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://platform.claude.com/v1/oauth/token',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'User-Agent': expect.stringMatching(/^sparecrow\/.+$/),
          'anthropic-beta': 'oauth-2025-04-20',
        }),
      }),
    );
    expect(atomicWriteMock).toHaveBeenCalledWith(
      '/home/test/.claude/.credentials.json',
      expect.stringContaining('new-access-token'),
    );
    expect(loggerMock.info).toHaveBeenCalledWith(
      'AUTH_TOKEN_REFRESHED',
      expect.objectContaining({ source: 'oauth_refresh' }),
    );
  });

  it('includes client_id in refresh request body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: vi.fn().mockResolvedValue({
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await authManager.refresh();

    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(requestInit.body as string) as Record<string, unknown>;
    expect(body['client_id']).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
    expect(body['grant_type']).toBe('refresh_token');
    expect(body['refresh_token']).toBe('refresh-token');
  });

  it('logs error on refresh failure without throwing', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(authManager.refresh()).resolves.toBeUndefined();

    expect(loggerMock.error).toHaveBeenCalledWith(
      'AUTH_REFRESH_FAILED',
      expect.objectContaining({ status: 401 }),
    );
    expect(atomicWriteMock).not.toHaveBeenCalled();
  });

  it('logs refresh format error when refresh payload is null', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: vi.fn().mockResolvedValue(null),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(authManager.refresh()).resolves.toBeUndefined();

    expect(loggerMock.error).toHaveBeenCalledWith(
      'AUTH_REFRESH_FORMAT',
      expect.objectContaining({ reason: 'unexpected_response_format' }),
    );
    expect(atomicWriteMock).not.toHaveBeenCalled();
  });

  it('logs refresh format error when refresh payload is missing access token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: vi.fn().mockResolvedValue({ refresh_token: 'only-refresh' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(authManager.refresh()).resolves.toBeUndefined();

    expect(loggerMock.error).toHaveBeenCalledWith(
      'AUTH_REFRESH_FORMAT',
      expect.objectContaining({ reason: 'unexpected_response_format' }),
    );
    expect(atomicWriteMock).not.toHaveBeenCalled();
  });

  it('logs refresh format error when refresh payload is not an object', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: vi.fn().mockResolvedValue('not-an-object'),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(authManager.refresh()).resolves.toBeUndefined();

    expect(loggerMock.error).toHaveBeenCalledWith(
      'AUTH_REFRESH_FORMAT',
      expect.objectContaining({ reason: 'unexpected_response_format' }),
    );
    expect(atomicWriteMock).not.toHaveBeenCalled();
  });

  it('refreshes top-level credential shape and writes top-level access token', async () => {
    fsMock.readFile.mockResolvedValue(
      createTopLevelCredentialsJson({
        accessToken: 'old-top-level-access',
        refreshToken: 'old-top-level-refresh',
      }),
    );
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: vi.fn().mockResolvedValue({
        accessToken: 'new-top-level-access',
        refreshToken: 'new-top-level-refresh',
        expiresAt: '2030-01-01T00:00:00.000Z',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await authManager.refresh();

    const writtenValue = atomicWriteMock.mock.calls[0]?.[1];
    expect(typeof writtenValue).toBe('string');
    const persisted = JSON.parse(writtenValue as string) as Record<string, unknown>;

    expect(persisted['accessToken']).toBe('new-top-level-access');
    expect(persisted['refreshToken']).toBe('new-top-level-refresh');
    expect(persisted['expiresAt']).toBe('2030-01-01T00:00:00.000Z');
    expect(persisted['claudeAiOauth']).toBeUndefined();
  });

  it('parses camelCase refresh responses and writes refreshed token values', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: vi.fn().mockResolvedValue({
        accessToken: 'camel-access-token',
        refreshToken: 'camel-refresh-token',
        expiresAt: String(Math.floor(Date.now() / 1000) + 1800),
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await authManager.refresh();

    expect(atomicWriteMock).toHaveBeenCalledWith(
      '/home/test/.claude/.credentials.json',
      expect.stringContaining('camel-access-token'),
    );
  });

  it('logs refresh errors with original error details', async () => {
    const refreshFailure = new Error('token endpoint unreachable');
    retryWithBackoffMock.mockRejectedValueOnce(refreshFailure);

    await expect(authManager.refresh()).resolves.toBeUndefined();

    expect(loggerMock.error).toHaveBeenCalledWith(
      'AUTH_REFRESH_ERROR',
      expect.objectContaining({ reason: 'refresh_failed' }),
      refreshFailure,
    );
  });

  it('avoids throwing when refresh token is missing', async () => {
    fsMock.readFile.mockResolvedValue(createCredentialsJson({ refreshToken: null }));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(authManager.refresh()).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'AUTH_REFRESH_UNAVAILABLE',
      expect.objectContaining({ reason: 'refresh_token_missing' }),
    );
  });

  it('does not set cooldown when refresh token is missing (config error, not transient)', async () => {
    fsMock.readFile.mockResolvedValue(createCredentialsJson({ refreshToken: null }));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await authManager.refresh();

    expect(loggerMock.warn).not.toHaveBeenCalledWith('AUTH_REFRESH_COOLDOWN', expect.anything());
    const state = authManager as unknown as { lastRefreshFailedAt: Date | null };
    expect(state.lastRefreshFailedAt).toBeNull();
  });

  it('does not log refresh token value during refresh failures', async () => {
    const sensitiveRefreshToken = 'sensitive-refresh-token';
    fsMock.readFile.mockResolvedValue(
      createCredentialsJson({ refreshToken: sensitiveRefreshToken }),
    );
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Server Error',
    });
    vi.stubGlobal('fetch', fetchMock);

    await authManager.refresh();

    expect(collectLoggerOutput()).not.toContain(sensitiveRefreshToken);
  });

  it('triggers proactive refresh when token age exceeds 75% of ttl', async () => {
    const now = Date.now();
    fsMock.readFile
      .mockResolvedValueOnce(
        createCredentialsJson({
          accessToken: 'stale-token',
          refreshToken: 'refresh-token',
          expiresAt: now + 60 * 60 * 1000,
        }),
      )
      .mockResolvedValueOnce(
        createCredentialsJson({
          accessToken: 'stale-token',
          refreshToken: 'refresh-token',
          expiresAt: now + 60 * 60 * 1000,
        }),
      )
      .mockResolvedValueOnce(
        createCredentialsJson({
          accessToken: 'fresh-token',
          refreshToken: 'refresh-token',
          expiresAt: now + 8 * 60 * 60 * 1000,
        }),
      );

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: vi.fn().mockResolvedValue({
        access_token: 'fresh-token',
        refresh_token: 'refresh-token',
        expires_in: 28_800,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(authManager.getToken()).resolves.toBe('fresh-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes token when current token expiry is already in the past', async () => {
    const now = Date.now();
    fsMock.readFile
      .mockResolvedValueOnce(
        createCredentialsJson({
          accessToken: 'expired-token',
          refreshToken: 'refresh-token',
          expiresAt: now - 60_000,
        }),
      )
      .mockResolvedValueOnce(
        createCredentialsJson({
          accessToken: 'expired-token',
          refreshToken: 'refresh-token',
          expiresAt: now - 60_000,
        }),
      )
      .mockResolvedValueOnce(
        createCredentialsJson({
          accessToken: 'new-token',
          refreshToken: 'refresh-token',
          expiresAt: now + 8 * 60 * 60 * 1000,
        }),
      );
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: vi.fn().mockResolvedValue({
        access_token: 'new-token',
        refresh_token: 'refresh-token',
        expires_in: 28_800,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(authManager.getToken()).resolves.toBe('new-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips proactive refresh when credential expiry is unavailable', async () => {
    fsMock.readFile.mockResolvedValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'no-expiry-token',
          refreshToken: 'refresh-token',
        },
      }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(authManager.getToken()).resolves.toBe('no-expiry-token');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parses string-encoded numeric expiresAt values from credentials', async () => {
    const expiresAtEpochSeconds = Math.floor(Date.now() / 1000) + 3600;
    fsMock.readFile.mockResolvedValue(
      createCredentialsJson({ expiresAt: String(expiresAtEpochSeconds) }),
    );

    await expect(authManager.getToken()).resolves.toBe('access-token');

    const internalState = authManager as unknown as { tokenExpiresAt: Date | null };
    expect(internalState.tokenExpiresAt).not.toBeNull();
    expect(internalState.tokenExpiresAt?.getTime()).toBe(expiresAtEpochSeconds * 1000);
  });

  it('keeps refresh state isolated between manager instances', () => {
    const first = new ClaudeCodeAuthManager();
    const second = new ClaudeCodeAuthManager();

    const firstState = first as unknown as { lastRefreshAt: Date | null };
    const secondState = second as unknown as { lastRefreshAt: Date | null };
    firstState.lastRefreshAt = new Date(0);

    expect(secondState.lastRefreshAt).toBeNull();
  });

  it('does not call refresh during cooldown period for proactive refresh path', async () => {
    const baseTime = Date.now();
    // Token expires in 2h — proactive window (75% of 8h TTL = 6h elapsed) is not yet reached
    // But we set expiresAt such that 7h have elapsed since TTL start → proactive window triggered
    // expiresAt = baseTime + 1h (so 7h of 8h TTL have elapsed)
    const expiresAt = baseTime + 1 * 60 * 60 * 1000;

    fsMock.readFile.mockResolvedValue(createCredentialsJson({ accessToken: 'token', expiresAt }));

    // Simulate a failed refresh that sets the cooldown
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Server Error',
    });
    vi.stubGlobal('fetch', fetchMock);

    // First getToken call triggers proactive refresh (7h elapsed > 75% of 8h = 6h)
    await authManager.getToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Cooldown is now active. Second getToken call should NOT trigger refresh.
    fetchMock.mockClear();
    await authManager.getToken();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls refresh during cooldown when token is genuinely expired', async () => {
    const baseTime = Date.now();
    // Token already expired
    const expiredAt = baseTime - 60_000;

    fsMock.readFile.mockResolvedValue(
      createCredentialsJson({ accessToken: 'expired-token', expiresAt: expiredAt }),
    );

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Server Error',
    });
    vi.stubGlobal('fetch', fetchMock);

    // First getToken — token expired, refresh attempted, fails, cooldown set
    await authManager.getToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second getToken — token still expired, MUST attempt refresh despite cooldown
    fetchMock.mockClear();

    // Keep expiresAt expired on reads
    fsMock.readFile.mockResolvedValue(
      createCredentialsJson({ accessToken: 'expired-token', expiresAt: expiredAt }),
    );

    await authManager.getToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('calls refresh again after cooldown expires', async () => {
    const baseTime = Date.now();
    // Token expires 1h from baseTime. TOKEN_TTL_MS = 8h, so the anchor (tokenExpiresAt - TTL)
    // is 7h before baseTime. Elapsed since anchor = 7h > 75% of 8h (6h) → proactive refresh fires.
    const expiresAt = baseTime + 1 * 60 * 60 * 1000;

    fsMock.readFile.mockResolvedValue(createCredentialsJson({ accessToken: 'token', expiresAt }));

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Server Error',
    });
    vi.stubGlobal('fetch', fetchMock);

    // First call — proactive refresh triggered (7h of 8h TTL elapsed), fails, cooldown set
    await authManager.getToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Simulate cooldown expiry: advance Date.now by 16 minutes past baseTime (cooldown = 15min)
    const COOLDOWN_MS = 15 * 60 * 1000;
    const advancedTime = baseTime + COOLDOWN_MS + 60_000;
    const originalDateNow = Date.now;
    Date.now = vi.fn().mockReturnValue(advancedTime);

    // Re-mock readFile so the second getToken sees the same expiresAt regardless of call order
    fsMock.readFile.mockResolvedValue(createCredentialsJson({ accessToken: 'token', expiresAt }));

    try {
      fetchMock.mockClear();
      await authManager.getToken();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('clears cooldown after successful refresh', async () => {
    const baseTime = Date.now();
    const expiresAt = baseTime + 1 * 60 * 60 * 1000;

    fsMock.readFile.mockResolvedValue(createCredentialsJson({ accessToken: 'token', expiresAt }));

    // First refresh fails — cooldown set
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Server Error',
    });
    vi.stubGlobal('fetch', fetchMock);

    await authManager.getToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // During cooldown, call refresh() directly with a successful response
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: vi.fn().mockResolvedValue({
        access_token: 'new-token',
        refresh_token: 'new-refresh',
        expires_in: 28_800,
      }),
    });

    await authManager.refresh();

    // Now lastRefreshFailedAt should be null — verify via internal state
    const state = authManager as unknown as { lastRefreshFailedAt: Date | null };
    expect(state.lastRefreshFailedAt).toBeNull();
  });

  it('consecutive failures each reset the cooldown timer instead of stacking', async () => {
    const baseTime = Date.now();
    const expiresAt = baseTime + 1 * 60 * 60 * 1000;

    fsMock.readFile.mockResolvedValue(createCredentialsJson({ accessToken: 'token', expiresAt }));

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Server Error',
    });
    vi.stubGlobal('fetch', fetchMock);

    // First failure sets cooldown with timestamp T1
    await authManager.refresh();
    const state = authManager as unknown as { lastRefreshFailedAt: Date | null };
    const firstFailedAt = state.lastRefreshFailedAt?.getTime() ?? 0;

    // Small delay to ensure time difference
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Second failure resets cooldown to T2 (not stacked beyond T1)
    await authManager.refresh();
    const secondFailedAt = state.lastRefreshFailedAt?.getTime() ?? 0;

    // Each failure resets the single timer — second timestamp should be >= first
    expect(secondFailedAt).toBeGreaterThanOrEqual(firstFailedAt);
    // Non-stacking: the second timestamp must be less than COOLDOWN_MS ahead of the first,
    // confirming the timer was reset (not accumulated/stacked beyond one cooldown period).
    const COOLDOWN_MS = 15 * 60 * 1000;
    expect(secondFailedAt - firstFailedAt).toBeLessThan(COOLDOWN_MS);
    expect(state.lastRefreshFailedAt).not.toBeNull();
  });

  it('emits AUTH_REFRESH_COOLDOWN warning with cooldownMinutes and nextRetryAt on failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });
    vi.stubGlobal('fetch', fetchMock);

    await authManager.refresh();

    expect(loggerMock.warn).toHaveBeenCalledWith(
      'AUTH_REFRESH_COOLDOWN',
      expect.objectContaining({
        cooldownMinutes: 15,
        nextRetryAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      }),
    );
  });

  it('emits AUTH_REFRESH_COOLDOWN warning when a network error (catch path) occurs during refresh', async () => {
    const networkError = new Error('Network timeout');
    const fetchMock = vi.fn().mockRejectedValue(networkError);
    vi.stubGlobal('fetch', fetchMock);

    await authManager.refresh();

    expect(loggerMock.warn).toHaveBeenCalledWith(
      'AUTH_REFRESH_COOLDOWN',
      expect.objectContaining({
        cooldownMinutes: 15,
        nextRetryAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      }),
    );
  });

  it('skips permission check on WSL-mounted credential paths', async () => {
    vi.resetModules();

    const fsWslMock = {
      access: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockResolvedValue({ mode: 0o100644 }),
      readFile: vi.fn().mockResolvedValue(createCredentialsJson()),
    };
    const loggerWslMock = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    // Mock the platform barrel so that isWslWindowsPath is fully controlled here,
    // avoiding an ESM module-evaluation race where process.platform patch and platform
    // module re-import could resolve in an unpredictable order.
    vi.doMock('../../platform/index.js', () => ({
      isWslWindowsPath: (_path: string) => true,
      isMacOS: () => false,
      isLinux: () => true,
      getPaths: vi.fn(),
      ensureDirectories: vi.fn(),
    }));
    vi.doMock('node:fs/promises', () => fsWslMock);
    vi.doMock('node:os', () => ({ homedir: () => '/mnt/c/Users/test' }));
    vi.doMock('../../utils/index.js', () => ({
      logger: loggerWslMock,
      retryWithBackoff: vi.fn(async (fn: () => Promise<unknown>) => fn()),
      atomicWrite: vi.fn(),
      isRecord: (value: unknown) =>
        typeof value === 'object' && value !== null && !Array.isArray(value),
      VERSION: 'test',
    }));

    try {
      const { ClaudeCodeAuthManager: WslAuthManager } = await import('./auth-manager.js');
      const wslAuthManager = new WslAuthManager();

      await wslAuthManager.getToken();

      expect(fsWslMock.stat).not.toHaveBeenCalled();
      expect(loggerWslMock.warn).not.toHaveBeenCalledWith(
        'AUTH_CREDENTIALS_PERMISSIONS_OPEN',
        expect.anything(),
      );
    } finally {
      vi.resetModules();
    }
  });

  it('enforces permission check on POSIX-native paths within WSL', async () => {
    vi.resetModules();

    const fsWslNativeMock = {
      access: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockResolvedValue({ mode: 0o100644 }),
      readFile: vi.fn().mockResolvedValue(createCredentialsJson()),
    };
    const loggerWslNativeMock = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    // Mock the platform barrel so isWslWindowsPath returns false for POSIX-native paths,
    // ensuring the permission check is enforced deterministically regardless of CI platform.
    vi.doMock('../../platform/index.js', () => ({
      isWslWindowsPath: (_path: string) => false,
      isMacOS: () => false,
      isLinux: () => true,
      getPaths: vi.fn(),
      ensureDirectories: vi.fn(),
    }));
    vi.doMock('node:fs/promises', () => fsWslNativeMock);
    vi.doMock('node:os', () => ({ homedir: () => '/home/wsluser' }));
    vi.doMock('../../utils/index.js', () => ({
      logger: loggerWslNativeMock,
      retryWithBackoff: vi.fn(async (fn: () => Promise<unknown>) => fn()),
      atomicWrite: vi.fn(),
      isRecord: (value: unknown) =>
        typeof value === 'object' && value !== null && !Array.isArray(value),
      VERSION: 'test',
    }));

    try {
      const { ClaudeCodeAuthManager: NativeAuthManager } = await import('./auth-manager.js');
      const authMgr = new NativeAuthManager();

      await authMgr.getToken();

      // Permission check SHOULD run for POSIX-native paths (stat is called)
      expect(fsWslNativeMock.stat).toHaveBeenCalled();
      // Warn about insecure permissions (mode 0644 != 0600)
      expect(loggerWslNativeMock.warn).toHaveBeenCalledWith(
        'AUTH_CREDENTIALS_PERMISSIONS_OPEN',
        expect.objectContaining({
          expectedMode: '0600',
        }),
      );
    } finally {
      vi.resetModules();
    }
  });
});

describe('ClaudeCodeAuthManager.readSubscriptionTier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMock.access.mockResolvedValue(undefined);
    fsMock.stat.mockResolvedValue({ mode: 0o100600 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('reads rateLimitTier and subscriptionType from claudeAiOauth shape', async () => {
    fsMock.readFile.mockResolvedValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'tok',
          subscriptionType: 'team',
          rateLimitTier: 'default_claude_max_5x',
        },
      }),
    );
    const manager = new ClaudeCodeAuthManager();
    const result = await manager.readSubscriptionTier();
    expect(result.subscriptionType).toBe('team');
    expect(result.rateLimitTier).toBe('default_claude_max_5x');
  });

  it('reads rateLimitTier from top-level shape when claudeAiOauth is absent', async () => {
    fsMock.readFile.mockResolvedValue(
      JSON.stringify({
        accessToken: 'tok',
        subscriptionType: 'pro',
        rateLimitTier: 'default_claude_pro',
      }),
    );
    const manager = new ClaudeCodeAuthManager();
    const result = await manager.readSubscriptionTier();
    expect(result.subscriptionType).toBe('pro');
    expect(result.rateLimitTier).toBe('default_claude_pro');
  });

  it('returns null for both fields when credentials file is missing', async () => {
    fsMock.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const manager = new ClaudeCodeAuthManager();
    const result = await manager.readSubscriptionTier();
    expect(result.subscriptionType).toBeNull();
    expect(result.rateLimitTier).toBeNull();
  });

  it('returns null fields when rateLimitTier is absent from credentials', async () => {
    fsMock.readFile.mockResolvedValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'tok',
          subscriptionType: 'team',
          // rateLimitTier is intentionally absent
        },
      }),
    );
    const manager = new ClaudeCodeAuthManager();
    const result = await manager.readSubscriptionTier();
    expect(result.subscriptionType).toBe('team');
    expect(result.rateLimitTier).toBeNull();
  });

  it('returns null fields when credentials contain invalid JSON', async () => {
    fsMock.readFile.mockResolvedValue('not valid json {{{');
    const manager = new ClaudeCodeAuthManager();
    const result = await manager.readSubscriptionTier();
    expect(result.subscriptionType).toBeNull();
    expect(result.rateLimitTier).toBeNull();
  });

  it('returns null fields when credentials is a non-object JSON value', async () => {
    fsMock.readFile.mockResolvedValue(JSON.stringify([1, 2, 3]));
    const manager = new ClaudeCodeAuthManager();
    const result = await manager.readSubscriptionTier();
    expect(result.subscriptionType).toBeNull();
    expect(result.rateLimitTier).toBeNull();
  });

  it('does not throw when credentials file is unreadable', async () => {
    fsMock.readFile.mockRejectedValue(new Error('EACCES: permission denied'));
    const manager = new ClaudeCodeAuthManager();
    await expect(manager.readSubscriptionTier()).resolves.toEqual({
      subscriptionType: null,
      rateLimitTier: null,
    });
  });

  it('falls back to top-level rateLimitTier when claudeAiOauth exists but lacks rateLimitTier', async () => {
    fsMock.readFile.mockResolvedValue(
      JSON.stringify({
        rateLimitTier: 'default_claude_max_5x',
        subscriptionType: 'team',
        claudeAiOauth: {
          accessToken: 'tok',
          // rateLimitTier intentionally absent from nested shape
        },
      }),
    );
    const manager = new ClaudeCodeAuthManager();
    const result = await manager.readSubscriptionTier();
    expect(result.rateLimitTier).toBe('default_claude_max_5x');
    expect(result.subscriptionType).toBe('team');
  });

  it('prefers claudeAiOauth rateLimitTier when both nested and top-level have it', async () => {
    fsMock.readFile.mockResolvedValue(
      JSON.stringify({
        rateLimitTier: 'default_claude_pro',
        claudeAiOauth: {
          accessToken: 'tok',
          rateLimitTier: 'default_claude_max_5x',
          subscriptionType: 'team',
        },
      }),
    );
    const manager = new ClaudeCodeAuthManager();
    const result = await manager.readSubscriptionTier();
    expect(result.rateLimitTier).toBe('default_claude_max_5x');
  });
});
