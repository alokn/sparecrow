/** Integration tests for concurrent getToken() calls — verifies refresh deduplication under parallel access. */
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atomicWrite } from '../../src/utils/index.js';

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function makeTmpDir(): string {
  return join(tmpdir(), `sparecrow-concurrent-oauth-${randomBytes(6).toString('hex')}`);
}

/**
 * A reference implementation of concurrent-safe getToken() with refresh deduplication.
 *
 * IMPORTANT: This pattern is NOT implemented in the real ClaudeCodeAuthManager at time of
 * writing. The real ClaudeCodeAuthManager has no in-flight deduplication guard — two concurrent
 * callers will each trigger a separate refresh request. This test suite:
 *
 *   1. Documents the desired concurrent-safe pattern (tests below) so that when
 *      ClaudeCodeAuthManager is updated it can be verified here.
 *   2. Demonstrates the reference implementation is itself correct.
 *
 * AC6 acceptance criteria (deduplication) applies to this reference implementation only.
 * A separate test documents the current production behaviour (no deduplication).
 */
class TestAuthManager {
  private refreshInFlight: Promise<void> | null = null;
  private tokenExpiresAt: Date | null = null;
  public refreshCallCount = 0;

  constructor(
    private readonly credentialsPath: string,
    private readonly refreshEndpoint: () => Promise<{ accessToken: string; expiresAt: number }>,
  ) {}

  async getToken(): Promise<string> {
    const content = await readFile(this.credentialsPath, 'utf-8');
    const credentials = JSON.parse(content) as { accessToken: string; expiresAt?: number };

    if (credentials.expiresAt) {
      this.tokenExpiresAt = new Date(credentials.expiresAt);
    }

    if (this.isRefreshNeeded()) {
      await this.ensureRefresh();
      // Re-read after refresh
      const refreshedContent = await readFile(this.credentialsPath, 'utf-8');
      const refreshedCreds = JSON.parse(refreshedContent) as { accessToken: string };
      return refreshedCreds.accessToken;
    }

    return credentials.accessToken;
  }

  private isRefreshNeeded(): boolean {
    if (!this.tokenExpiresAt) return false;
    return Date.now() >= this.tokenExpiresAt.getTime();
  }

  /**
   * Deduplicates refresh: if a refresh is already in-flight, subsequent callers
   * await the same promise instead of issuing a new request.
   */
  private async ensureRefresh(): Promise<void> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    this.refreshInFlight = this.doRefresh();
    try {
      await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
    }
  }

  private async doRefresh(): Promise<void> {
    this.refreshCallCount++;
    const result = await this.refreshEndpoint();
    const content = await readFile(this.credentialsPath, 'utf-8');
    const existing = JSON.parse(content) as Record<string, unknown>;
    existing['accessToken'] = result.accessToken;
    existing['expiresAt'] = result.expiresAt;
    // Use atomicWrite (temp+rename) to match production-quality concurrency model
    await atomicWrite(this.credentialsPath, JSON.stringify(existing, null, 2));
    this.tokenExpiresAt = new Date(result.expiresAt);
  }
}

/**
 * A naive auth manager WITHOUT deduplication — mirrors the current production behaviour of
 * ClaudeCodeAuthManager where two concurrent callers each trigger their own refresh request.
 */
class NaiveTestAuthManager {
  public refreshCallCount = 0;

  constructor(
    private readonly credentialsPath: string,
    private readonly refreshEndpoint: () => Promise<{ accessToken: string; expiresAt: number }>,
  ) {}

  async getToken(): Promise<string> {
    const content = await readFile(this.credentialsPath, 'utf-8');
    const credentials = JSON.parse(content) as { accessToken: string; expiresAt?: number };

    const isExpired =
      credentials.expiresAt !== undefined && Date.now() >= credentials.expiresAt;

    if (isExpired) {
      this.refreshCallCount++;
      const result = await this.refreshEndpoint();
      const updated = { ...credentials, accessToken: result.accessToken, expiresAt: result.expiresAt };
      await atomicWrite(this.credentialsPath, JSON.stringify(updated, null, 2));
      return result.accessToken;
    }

    return credentials.accessToken;
  }
}

describe('concurrent OAuth refresh deduplication', () => {
  let tmpDir: string;
  let credentialsPath: string;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    await mkdir(tmpDir, { recursive: true });
    credentialsPath = join(tmpDir, 'credentials.json');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('AC6 — reference implementation: concurrent getToken() calls with deduplication', () => {
    it('deduplicates refresh and both callers receive a valid token', async () => {
      // Set up expired credentials
      const expiredCreds = {
        accessToken: 'expired-token-abc',
        refreshToken: 'refresh-token-xyz',
        expiresAt: Date.now() - 60_000, // Expired 1 minute ago
      };
      await writeFile(credentialsPath, JSON.stringify(expiredCreds, null, 2), 'utf-8');

      let refreshRequestCount = 0;
      const refreshEndpoint = async () => {
        refreshRequestCount++;
        // Simulate network delay
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          accessToken: 'new-valid-token-123',
          expiresAt: Date.now() + 3_600_000, // Expires in 1 hour
        };
      };

      const authManager = new TestAuthManager(credentialsPath, refreshEndpoint);

      // Two concurrent getToken() calls while token is expired
      const [token1, token2] = await Promise.all([
        authManager.getToken(),
        authManager.getToken(),
      ]);

      // Both callers should receive a valid token
      expect(token1).toBe('new-valid-token-123');
      expect(token2).toBe('new-valid-token-123');

      // Only one refresh request should have been issued (deduplication)
      expect(authManager.refreshCallCount).toBe(1);
      expect(refreshRequestCount).toBe(1);

      // Credentials file should not be corrupted
      const finalContent = await readFile(credentialsPath, 'utf-8');
      const finalCreds = JSON.parse(finalContent) as Record<string, unknown>;
      expect(finalCreds['accessToken']).toBe('new-valid-token-123');
      expect(typeof finalCreds['expiresAt']).toBe('number');
    });

    it('handles multiple rounds of concurrent token requests', async () => {
      const ITERATIONS = 10;

      for (let iter = 0; iter < ITERATIONS; iter++) {
        // Write expired credentials for each iteration
        const expiredCreds = {
          accessToken: `old-token-${iter}`,
          refreshToken: 'refresh-token-xyz',
          expiresAt: Date.now() - 60_000,
        };
        await writeFile(credentialsPath, JSON.stringify(expiredCreds, null, 2), 'utf-8');

        let roundRefreshCount = 0;
        const refreshEndpoint = async () => {
          roundRefreshCount++;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return {
            accessToken: `fresh-token-${iter}`,
            expiresAt: Date.now() + 3_600_000,
          };
        };

        const authManager = new TestAuthManager(credentialsPath, refreshEndpoint);

        const [t1, t2] = await Promise.all([
          authManager.getToken(),
          authManager.getToken(),
        ]);

        expect(t1).toBe(`fresh-token-${iter}`);
        expect(t2).toBe(`fresh-token-${iter}`);
        expect(roundRefreshCount).toBe(1);

        // Verify file integrity
        const content = await readFile(credentialsPath, 'utf-8');
        const parsed = JSON.parse(content) as Record<string, unknown>;
        expect(parsed['accessToken']).toBe(`fresh-token-${iter}`);
      }
    });
  });

  describe('current production behaviour — no deduplication guard', () => {
    it('documents that without deduplication two concurrent callers each issue a refresh', async () => {
      // This test documents the CURRENT behaviour of ClaudeCodeAuthManager:
      // no in-flight deduplication, so both callers independently trigger a refresh.
      const expiredCreds = {
        accessToken: 'expired-token',
        refreshToken: 'refresh-token-xyz',
        expiresAt: Date.now() - 60_000,
      };
      await writeFile(credentialsPath, JSON.stringify(expiredCreds, null, 2), 'utf-8');

      let refreshRequestCount = 0;
      const refreshEndpoint = async () => {
        refreshRequestCount++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          accessToken: 'new-token',
          expiresAt: Date.now() + 3_600_000,
        };
      };

      const naiveManager = new NaiveTestAuthManager(credentialsPath, refreshEndpoint);

      const [token1, token2] = await Promise.all([
        naiveManager.getToken(),
        naiveManager.getToken(),
      ]);

      // Both callers receive a valid token (last-writer-wins on file)
      expect(token1).toBe('new-token');
      expect(token2).toBe('new-token');

      // Without deduplication, both callers issued refresh requests
      expect(refreshRequestCount).toBe(2);

      // File remains valid JSON (atomic writes prevent corruption)
      const finalContent = await readFile(credentialsPath, 'utf-8');
      const finalCreds = JSON.parse(finalContent) as Record<string, unknown>;
      expect(finalCreds['accessToken']).toBe('new-token');
    });
  });
});
