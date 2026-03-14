/** Unit tests for the retryWithBackoff utility. */
import { describe, it, expect, vi } from 'vitest';
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

  it('respects maxDelayMs cap', async () => {
    vi.useFakeTimers();
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
