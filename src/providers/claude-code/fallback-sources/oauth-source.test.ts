/** Unit tests for OAuthUsageSource endpoint behavior and payload normalization. */
import { describe, expect, it, vi } from 'vitest';
import { ScrowError, ErrorCode } from '../../../errors/index.js';
import type { AuthManager } from '../../../types/index.js';
import { OAuthUsageSource } from './oauth-source.js';

function createAuthManager(token = 'test-token'): AuthManager {
  return {
    getToken: vi.fn(async () => token),
    refresh: vi.fn(async () => undefined),
    validate: vi.fn(async () => true),
  };
}

function createResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => payload),
  } as unknown as Response;
}

const VALID_PAYLOAD = {
  five_hour: { utilization: 20.0, resets_at: '2026-02-24T10:00:00.000Z' },
  seven_day: { utilization: 30.0, resets_at: '2026-02-25T00:00:00.000Z' },
};

describe('OAuthUsageSource', () => {
  it('calls usage endpoint with expected headers and returns normalized snapshot', async () => {
    const fetchMock = vi.fn(async () =>
      createResponse(200, {
        ...VALID_PAYLOAD,
        seven_day_opus: { utilization: 40.0, resets_at: '2026-02-25T00:00:00.000Z' },
      }),
    );

    const source = new OAuthUsageSource({
      authManager: createAuthManager(),
      fetchFn: fetchMock as typeof fetch,
    });

    const snapshot = await source.poll();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/api/oauth/usage',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          'anthropic-beta': 'oauth-2025-04-20',
        }),
      }),
    );
    expect(snapshot.source).toBe('oauth');
    expect(snapshot.confidence).toBe('high');
    expect(snapshot.rateWindows[0]?.id).toBe('session');
    expect(snapshot.budgetWindows[0]?.id).toBe('weekly');
  });

  it('uses injected userAgent in request headers', async () => {
    const fetchMock = vi.fn(async () => createResponse(200, VALID_PAYLOAD));

    const source = new OAuthUsageSource({
      authManager: createAuthManager(),
      fetchFn: fetchMock as typeof fetch,
      userAgent: 'sparecrow/1.2.3',
    });

    await source.poll();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ 'User-Agent': 'sparecrow/1.2.3' }),
      }),
    );
  });

  it('falls back to sparecrow/unknown userAgent when version unavailable', async () => {
    const fetchMock = vi.fn(async () => createResponse(200, VALID_PAYLOAD));
    const savedVersion = process.env['npm_package_version'];
    delete process.env['npm_package_version'];

    try {
      const source = new OAuthUsageSource({
        authManager: createAuthManager(),
        fetchFn: fetchMock as typeof fetch,
      });

      await source.poll();

      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'User-Agent': expect.stringContaining('sparecrow/'),
          }),
        }),
      );
    } finally {
      if (savedVersion !== undefined) {
        process.env['npm_package_version'] = savedVersion;
      }
    }
  });

  it('throws AUTH_TOKEN_EXPIRED for 401 responses', async () => {
    const source = new OAuthUsageSource({
      authManager: createAuthManager(),
      fetchFn: vi.fn(async () => createResponse(401, {})) as typeof fetch,
    });

    await expect(source.poll()).rejects.toMatchObject({ code: ErrorCode.AUTH_TOKEN_EXPIRED });
  });

  it('throws PROVIDER_UNREACHABLE immediately on 429 without retrying', async () => {
    const fetchMock = vi.fn(async () => createResponse(429, {}));

    const source = new OAuthUsageSource({
      authManager: createAuthManager(),
      fetchFn: fetchMock as typeof fetch,
    });

    await expect(source.poll()).rejects.toMatchObject({ code: ErrorCode.PROVIDER_UNREACHABLE });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries on 5xx server error and rejects after exhausting retries', async () => {
    const fetchMock = vi.fn(async () => createResponse(503, {}));

    const source = new OAuthUsageSource({
      authManager: createAuthManager(),
      fetchFn: fetchMock as typeof fetch,
    });

    await expect(source.poll()).rejects.toBeInstanceOf(Error);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('throws PROVIDER_UNREACHABLE for non-ok non-retryable status (403)', async () => {
    const source = new OAuthUsageSource({
      authManager: createAuthManager(),
      fetchFn: vi.fn(async () => createResponse(403, {})) as typeof fetch,
    });

    await expect(source.poll()).rejects.toMatchObject({ code: ErrorCode.PROVIDER_UNREACHABLE });
  });

  it('retries on network-level TypeError (fetch abort/network failure)', async () => {
    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount += 1;
      if (callCount < 3) {
        throw new TypeError('Failed to fetch');
      }
      return createResponse(200, VALID_PAYLOAD);
    });

    const source = new OAuthUsageSource({
      authManager: createAuthManager(),
      fetchFn: fetchMock as typeof fetch,
    });

    const snapshot = await source.poll();

    expect(snapshot.source).toBe('oauth');
    expect(callCount).toBe(3);
  });

  it('retries and rejects on AbortError from fetchWithTimeout', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';

    const fetchMock = vi.fn(async () => {
      throw abortError;
    });

    const source = new OAuthUsageSource({
      authManager: createAuthManager(),
      fetchFn: fetchMock as typeof fetch,
    });

    await expect(source.poll()).rejects.toBeInstanceOf(Error);
    // AbortError is retryable — should be called more than once
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('throws PROVIDER_UNREACHABLE on malformed JSON payload', async () => {
    const malformedResponse = {
      ok: true,
      status: 200,
      json: vi.fn(async () => ({ five_hour: 'invalid-shape' })),
    } as unknown as Response;

    const source = new OAuthUsageSource({
      authManager: createAuthManager(),
      fetchFn: vi.fn(async () => malformedResponse) as typeof fetch,
    });

    const rejection = source.poll();
    await expect(rejection).rejects.toBeInstanceOf(ScrowError);
    await expect(rejection).rejects.toMatchObject({ code: ErrorCode.PROVIDER_UNREACHABLE });
  });

  it('throws PROVIDER_UNREACHABLE when response.json() rejects', async () => {
    const badJsonResponse = {
      ok: true,
      status: 200,
      json: vi.fn(async () => {
        throw new SyntaxError('Unexpected token');
      }),
    } as unknown as Response;

    const source = new OAuthUsageSource({
      authManager: createAuthManager(),
      fetchFn: vi.fn(async () => badJsonResponse) as typeof fetch,
    });

    await expect(source.poll()).rejects.toMatchObject({ code: ErrorCode.PROVIDER_UNREACHABLE });
  });
});
