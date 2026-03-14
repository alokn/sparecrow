/** Unit tests for auth-status parser. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('parseAuthStatusOutput()', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('../../utils/index.js', () => ({
      logger: {
        debug: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
      },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns authenticated=true with tier from valid JSON', async () => {
    const { parseAuthStatusOutput } = await import('./auth-status.js');
    const result = parseAuthStatusOutput(
      JSON.stringify({ loggedIn: true, subscriptionType: 'max5' }),
    );
    expect(result).toEqual({ authenticated: true, tier: 'max5' });
  });

  it('returns authenticated=true with unknown tier when subscriptionType absent', async () => {
    const { parseAuthStatusOutput } = await import('./auth-status.js');
    const result = parseAuthStatusOutput(JSON.stringify({ loggedIn: true }));
    expect(result).toEqual({ authenticated: true, tier: 'unknown' });
  });

  it('returns authenticated=false when loggedIn is false', async () => {
    const { parseAuthStatusOutput } = await import('./auth-status.js');
    const result = parseAuthStatusOutput(JSON.stringify({ loggedIn: false }));
    expect(result).toEqual({ authenticated: false, tier: 'unknown' });
  });

  it('returns authenticated=false when loggedIn key is absent', async () => {
    const { parseAuthStatusOutput } = await import('./auth-status.js');
    const result = parseAuthStatusOutput(JSON.stringify({}));
    expect(result).toEqual({ authenticated: false, tier: 'unknown' });
  });

  it('returns authenticated=false for empty string input', async () => {
    const { parseAuthStatusOutput } = await import('./auth-status.js');
    const result = parseAuthStatusOutput('');
    expect(result).toEqual({ authenticated: false, tier: 'unknown' });
  });

  it('returns authenticated=false for malformed JSON', async () => {
    const { parseAuthStatusOutput } = await import('./auth-status.js');
    const result = parseAuthStatusOutput('not-json{{{');
    expect(result).toEqual({ authenticated: false, tier: 'unknown' });
  });

  it('returns authenticated=false for non-object JSON primitive input', async () => {
    const { parseAuthStatusOutput } = await import('./auth-status.js');
    const result = parseAuthStatusOutput('"hello"');
    expect(result).toEqual({ authenticated: false, tier: 'unknown' });
  });

  it('returns authenticated=false for legacy authenticated/account.plan shape', async () => {
    const { parseAuthStatusOutput } = await import('./auth-status.js');
    const result = parseAuthStatusOutput(
      JSON.stringify({ authenticated: true, account: { plan: 'max5' } }),
    );
    expect(result).toEqual({ authenticated: false, tier: 'unknown' });
  });
});
