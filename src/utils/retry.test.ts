/** Unit tests for the retryWithBackoff utility. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { retryWithBackoff } from './retry.js';
import { ScrowError, ErrorCode } from '../errors/index.js';

describe('retryWithBackoff()', () => {
  it('returns result immediately on success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await retryWithBackoff(fn, { baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries up to maxRetries on retryable error', async () => {
    const networkErr = Object.assign(new Error('network'), { code: 'ECONNREFUSED' });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(networkErr)
      .mockRejectedValueOnce(networkErr)
      .mockResolvedValue('recovered');
    const result = await retryWithBackoff(fn, { baseDelayMs: 1, retryOn: () => true });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry ScrowError by default', async () => {
    const auoErr = new ScrowError(ErrorCode.CONFIG_INVALID, 'bad');
    const fn = vi.fn().mockRejectedValue(auoErr);
    await expect(retryWithBackoff(fn, { baseDelayMs: 1 })).rejects.toThrow(auoErr);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws after exhausting maxRetries', async () => {
    const err = new Error('persistent');
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      retryWithBackoff(fn, { maxRetries: 2, baseDelayMs: 1, retryOn: () => true }),
    ).rejects.toThrow('persistent');
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('does not retry when retryOn returns false', async () => {
    const err = new Error('not retryable');
    const fn = vi.fn().mockRejectedValue(err);
    await expect(retryWithBackoff(fn, { baseDelayMs: 1, retryOn: () => false })).rejects.toThrow(
      'not retryable',
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on ETIMEDOUT network error by default', async () => {
    const networkErr = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
    const fn = vi.fn().mockRejectedValueOnce(networkErr).mockResolvedValue('ok');
    const result = await retryWithBackoff(fn, { baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on ENOTFOUND network error by default', async () => {
    const networkErr = Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    const fn = vi.fn().mockRejectedValueOnce(networkErr).mockResolvedValue('ok');
    const result = await retryWithBackoff(fn, { baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on fetch TypeError by default', async () => {
    const fetchErr = new TypeError('fetch failed');
    const fn = vi.fn().mockRejectedValueOnce(fetchErr).mockResolvedValue('ok');
    const result = await retryWithBackoff(fn, { baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('applies jitter so retry delays are not deterministic', async () => {
    // Collect actual delays by spying on setTimeout
    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((cb: () => void, ms?: number) => {
      if (ms !== undefined && ms > 0) {
        delays.push(ms);
      }
      return originalSetTimeout(cb, 0);
    }) as typeof globalThis.setTimeout);

    const err = Object.assign(new Error('net'), { code: 'ECONNREFUSED' });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockResolvedValue('ok');

    await retryWithBackoff(fn, { maxRetries: 3, baseDelayMs: 1000, retryOn: () => true });

    // With 3 retries, we should have 3 delays
    expect(delays.length).toBe(3);

    // The jitter function applies ±25% (0.75 to 1.25 multiplier).
    // Base delays are 1000, 2000, 4000 (exponential backoff).
    // With jitter, delay 1 should be in [750, 1250], delay 2 in [1500, 2500], etc.
    expect(delays[0]).toBeGreaterThanOrEqual(750);
    expect(delays[0]).toBeLessThanOrEqual(1250);
    expect(delays[1]).toBeGreaterThanOrEqual(1500);
    expect(delays[1]).toBeLessThanOrEqual(2500);
    expect(delays[2]).toBeGreaterThanOrEqual(3000);
    expect(delays[2]).toBeLessThanOrEqual(5000);

    // Two distinct delays from different retries must differ (non-deterministic jitter).
    // A deterministic implementation returning ms*1.0 would produce 1000, 2000, 4000 exactly.
    // True jitter makes it statistically impossible for all 3 delays to hit exact multiples.
    expect(delays).not.toEqual([1000, 2000, 4000]);

    vi.restoreAllMocks();
  });

  it('respects maxDelayMs cap', async () => {
    vi.useFakeTimers();
    // Safety net: ensure fake timers are always restored even if the test throws.
    afterEach(() => vi.useRealTimers());

    const err = Object.assign(new Error('net'), { code: 'ECONNREFUSED' });
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');

    const promise = retryWithBackoff(fn, {
      baseDelayMs: 100000,
      maxDelayMs: 100,
      retryOn: () => true,
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe('ok');
    vi.useRealTimers();
  });
});
