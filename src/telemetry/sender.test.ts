/** Tests for TelemetrySender — fire-and-forget HTTPS POST with mocked fetch. */
import { describe, it, expect, vi } from 'vitest';
import { TelemetrySender, DEFAULT_TELEMETRY_ENDPOINT } from './sender.js';
import type { TelemetryEvent } from './schema.js';

const makeEvent = (overrides: Partial<TelemetryEvent> = {}): TelemetryEvent => ({
  timestamp: '2026-03-16T10:00:00.000Z',
  installationId: 'a0000000-0000-4000-8000-000000000001',
  eventType: 'command_run',
  commandName: 'status',
  errorCode: null,
  osPlatform: 'linux',
  osArch: 'x64',
  nodeMajorVersion: 22,
  sparecrowVersion: '1.0.0',
  ...overrides,
});

describe('TelemetrySender', () => {
  it('sends events via POST and returns true on success', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const sender = new TelemetrySender({
      endpoint: 'https://test.example.com/events',
      fetchFn: mockFetch as typeof globalThis.fetch,
    });

    const result = await sender.send([makeEvent()]);
    expect(result).toBe(true);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://test.example.com/events');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(opts.body as string) as { events: TelemetryEvent[] };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]!.commandName).toBe('status');
  });

  it('returns false on HTTP error', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const sender = new TelemetrySender({
      fetchFn: mockFetch as typeof globalThis.fetch,
    });

    const result = await sender.send([makeEvent()]);
    expect(result).toBe(false);
  });

  it('returns false on network error (silently dropped)', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network unreachable'));
    const sender = new TelemetrySender({
      fetchFn: mockFetch as typeof globalThis.fetch,
    });

    const result = await sender.send([makeEvent()]);
    expect(result).toBe(false);
  });

  it('returns true for empty events array', async () => {
    const mockFetch = vi.fn();
    const sender = new TelemetrySender({
      fetchFn: mockFetch as typeof globalThis.fetch,
    });

    const result = await sender.send([]);
    expect(result).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('uses default endpoint when none specified', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const sender = new TelemetrySender({
      fetchFn: mockFetch as typeof globalThis.fetch,
    });

    await sender.send([makeEvent()]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe(DEFAULT_TELEMETRY_ENDPOINT);
  });
});
