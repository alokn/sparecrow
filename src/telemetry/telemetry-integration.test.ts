/** QA integration tests for story 24.1 — opt-in anonymous usage telemetry. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { TelemetryCollector } from './collector.js';
import { TelemetrySender, DEFAULT_TELEMETRY_ENDPOINT } from './sender.js';
import { TelemetryEventSchema, TelemetryPayloadSchema, TELEMETRY_EVENT_TYPES } from './schema.js';

// ─── Schema: all valid event types ────────────────────────────────────────────

describe('TelemetryEventSchema — all event types', () => {
  const base = {
    timestamp: '2026-03-16T10:00:00.000Z',
    installationId: 'b1111111-1111-4111-8111-111111111111',
    commandName: null,
    errorCode: null,
    osPlatform: 'linux',
    osArch: 'x64',
    nodeMajorVersion: 22,
    sparecrowVersion: '1.0.0',
  };

  for (const eventType of TELEMETRY_EVENT_TYPES) {
    it(`accepts eventType '${eventType}'`, () => {
      const result = TelemetryEventSchema.safeParse({ ...base, eventType });
      expect(result.success).toBe(true);
    });
  }

  it('rejects missing required field (timestamp)', () => {
    const { timestamp: _omit, ...rest } = base;
    const result = TelemetryEventSchema.safeParse({ ...rest, eventType: 'command_run' });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer nodeMajorVersion', () => {
    const result = TelemetryEventSchema.safeParse({
      ...base,
      eventType: 'command_run',
      nodeMajorVersion: 22.5,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing installationId', () => {
    const result = TelemetryEventSchema.safeParse({
      timestamp: '2026-03-16T10:00:00.000Z',
      eventType: 'command_run',
      commandName: null,
      errorCode: null,
      osPlatform: 'linux',
      osArch: 'x64',
      nodeMajorVersion: 22,
      sparecrowVersion: '1.0.0',
    });
    expect(result.success).toBe(false);
  });

  it('accepts errorCode as non-null string', () => {
    const result = TelemetryEventSchema.safeParse({
      ...base,
      eventType: 'error',
      errorCode: 'CONFIG_NOT_FOUND',
    });
    expect(result.success).toBe(true);
  });
});

describe('TelemetryPayloadSchema — edge cases', () => {
  const validEvent = {
    timestamp: '2026-03-16T10:00:00.000Z',
    installationId: 'a0000000-0000-4000-8000-000000000001',
    eventType: 'daemon_start' as const,
    commandName: null,
    errorCode: null,
    osPlatform: 'darwin',
    osArch: 'arm64',
    nodeMajorVersion: 20,
    sparecrowVersion: '2.0.0',
  };

  it('accepts payload with multiple events', () => {
    const result = TelemetryPayloadSchema.safeParse({
      events: [validEvent, { ...validEvent, eventType: 'daemon_stop' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects payload missing events field', () => {
    const result = TelemetryPayloadSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects payload with invalid event inside array', () => {
    const result = TelemetryPayloadSchema.safeParse({
      events: [{ ...validEvent, eventType: 'not_valid' }],
    });
    expect(result.success).toBe(false);
  });
});

// ─── TelemetryCollector edge cases ────────────────────────────────────────────

describe('TelemetryCollector — edge cases', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(
      join(tmpdir(), 'scrow-telemetry-qa-' + randomBytes(4).toString('hex') + '-'),
    );
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('handles loadRecentEvents gracefully when file does not exist', async () => {
    const collector = new TelemetryCollector({ stateDir, version: '1.0.0', installationId: 'id1' });
    // Should not throw
    await expect(collector.loadRecentEvents()).resolves.toBeUndefined();
    expect(collector.getRecentEvents()).toHaveLength(0);
  });

  it('handles loadRecentEvents gracefully when file contains invalid JSON', async () => {
    const recentPath = join(stateDir, 'telemetry-recent.json');
    await mkdir(stateDir, { recursive: true });
    await writeFile(recentPath, 'not-valid-json', 'utf-8');

    const collector = new TelemetryCollector({ stateDir, version: '1.0.0', installationId: 'id1' });
    await expect(collector.loadRecentEvents()).resolves.toBeUndefined();
    expect(collector.getRecentEvents()).toHaveLength(0);
  });

  it('handles loadRecentEvents when file contains non-array JSON', async () => {
    const recentPath = join(stateDir, 'telemetry-recent.json');
    await mkdir(stateDir, { recursive: true });
    await writeFile(recentPath, JSON.stringify({ events: [] }), 'utf-8');

    const collector = new TelemetryCollector({ stateDir, version: '1.0.0', installationId: 'id1' });
    await collector.loadRecentEvents();
    // Non-array is ignored — ring buffer stays empty
    expect(collector.getRecentEvents()).toHaveLength(0);
  });

  it('drain returns empty array when buffer is empty', async () => {
    const collector = new TelemetryCollector({ stateDir, version: '1.0.0', installationId: 'id1' });
    const events = collector.drain();
    expect(events).toHaveLength(0);
    expect(collector.pendingCount).toBe(0);
  });

  it('generates ID even when stateDir does not yet exist', async () => {
    const nestedDir = join(stateDir, 'nested', 'path');
    const collector = new TelemetryCollector({ stateDir: nestedDir, version: '1.0.0' });
    const id = await collector.getInstallationId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // Verify it was persisted
    const persisted = await readFile(join(nestedDir, 'telemetry-id'), 'utf-8');
    expect(persisted.trim()).toBe(id);
  });

  it('records all four event types without error', async () => {
    const collector = new TelemetryCollector({
      stateDir,
      version: '1.0.0',
      installationId: 'qa-id',
    });
    await collector.record('command_run', 'status');
    await collector.record('error', 'run', 'SOME_ERROR');
    await collector.record('daemon_start');
    await collector.record('daemon_stop');
    expect(collector.pendingCount).toBe(4);

    const drained = collector.drain();
    expect(drained.map((e) => e.eventType)).toEqual([
      'command_run',
      'error',
      'daemon_start',
      'daemon_stop',
    ]);
  });

  it('pendingCount reflects buffer size accurately across multiple records and drains', async () => {
    const collector = new TelemetryCollector({
      stateDir,
      version: '1.0.0',
      installationId: 'qa-id',
    });
    expect(collector.pendingCount).toBe(0);

    await collector.record('command_run', 'status');
    await collector.record('daemon_start');
    expect(collector.pendingCount).toBe(2);

    collector.drain();
    expect(collector.pendingCount).toBe(0);

    await collector.record('error', undefined, 'E_FAILED');
    expect(collector.pendingCount).toBe(1);

    collector.drain();
    expect(collector.pendingCount).toBe(0);
  });

  it('persistRecentEvents writes JSON that can be loaded back', async () => {
    const persistId = 'a0000000-0000-4000-8000-000000000010';
    const c1 = new TelemetryCollector({ stateDir, version: '3.0.0', installationId: persistId });
    await c1.record('daemon_start');
    await c1.record('daemon_stop');
    c1.drain();
    await c1.persistRecentEvents();

    const c2 = new TelemetryCollector({ stateDir, version: '3.0.0', installationId: persistId });
    await c2.loadRecentEvents();
    const events = c2.getRecentEvents();
    expect(events).toHaveLength(2);
    expect(events[0]!.eventType).toBe('daemon_start');
    expect(events[1]!.eventType).toBe('daemon_stop');
  });

  it('ring buffer trims to last 10 when loading more than 10 events from disk', async () => {
    const qaId = 'a0000000-0000-4000-8000-000000000020';
    // Write 15 events directly to the recent events file
    const events = Array.from({ length: 15 }, (_, i) => ({
      timestamp: '2026-03-16T10:00:00.000Z',
      installationId: qaId,
      eventType: 'command_run',
      commandName: `cmd-${i}`,
      errorCode: null,
      osPlatform: 'linux',
      osArch: 'x64',
      nodeMajorVersion: 22,
      sparecrowVersion: '1.0.0',
    }));
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'telemetry-recent.json'), JSON.stringify(events), 'utf-8');

    const collector = new TelemetryCollector({
      stateDir,
      version: '1.0.0',
      installationId: qaId,
    });
    await collector.loadRecentEvents();
    const recent = collector.getRecentEvents();
    // slice(-10) keeps last 10
    expect(recent).toHaveLength(10);
    expect(recent[0]!.commandName).toBe('cmd-5');
    expect(recent[9]!.commandName).toBe('cmd-14');
  });
});

// ─── TelemetrySender edge cases ────────────────────────────────────────────────

describe('TelemetrySender — edge cases', () => {
  const makeEvent = () => ({
    timestamp: '2026-03-16T10:00:00.000Z',
    installationId: 'a0000000-0000-4000-8000-000000000002',
    eventType: 'command_run' as const,
    commandName: 'run',
    errorCode: null,
    osPlatform: 'linux',
    osArch: 'x64',
    nodeMajorVersion: 22,
    sparecrowVersion: '1.0.0',
  });

  it('DEFAULT_TELEMETRY_ENDPOINT is the expected sparecrow URL', () => {
    expect(DEFAULT_TELEMETRY_ENDPOINT).toBe('https://telemetry.sparecrow.dev/v1/events');
  });

  it('sends Content-Type application/json header', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const sender = new TelemetrySender({
      endpoint: 'https://test.example.com/events',
      fetchFn: mockFetch as typeof globalThis.fetch,
    });
    await sender.send([makeEvent()]);
    const [, opts] = mockFetch.mock.calls[0]! as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(opts.headers['Content-Type']).toBe('application/json');
  });

  it('uses POST method', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const sender = new TelemetrySender({ fetchFn: mockFetch as typeof globalThis.fetch });
    await sender.send([makeEvent()]);
    const [, opts] = mockFetch.mock.calls[0]! as [string, RequestInit];
    expect(opts.method).toBe('POST');
  });

  it('includes AbortSignal in request options (timeout support)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const sender = new TelemetrySender({ fetchFn: mockFetch as typeof globalThis.fetch });
    await sender.send([makeEvent()]);
    const [, opts] = mockFetch.mock.calls[0]! as [string, RequestInit];
    expect(opts.signal).toBeDefined();
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends multiple events in a single request', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const sender = new TelemetrySender({ fetchFn: mockFetch as typeof globalThis.fetch });
    await sender.send([makeEvent(), makeEvent(), makeEvent()]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, opts] = mockFetch.mock.calls[0]! as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as { events: unknown[] };
    expect(body.events).toHaveLength(3);
  });

  it('returns false on 4xx HTTP error', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 400 });
    const sender = new TelemetrySender({ fetchFn: mockFetch as typeof globalThis.fetch });
    const result = await sender.send([makeEvent()]);
    expect(result).toBe(false);
  });

  it('returns false when fetch throws AbortError (timeout)', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    const mockFetch = vi.fn().mockRejectedValue(abortError);
    const sender = new TelemetrySender({ fetchFn: mockFetch as typeof globalThis.fetch });
    const result = await sender.send([makeEvent()]);
    expect(result).toBe(false);
  });
});

// ─── Config schema: telemetry field ───────────────────────────────────────────

describe('ScrowConfigSchema — telemetry field', () => {
  it('parses config with telemetry enabled', async () => {
    const { ScrowConfigSchema } = await import('../config/schema.js');
    const input = {
      telemetry: { enabled: true, endpoint: 'https://custom.endpoint.example.com/events' },
    };
    const result = ScrowConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.telemetry.enabled).toBe(true);
      expect(result.data.telemetry.endpoint).toBe('https://custom.endpoint.example.com/events');
    }
  });

  it('defaults telemetry.enabled to false when telemetry omitted', async () => {
    const { ScrowConfigSchema } = await import('../config/schema.js');
    const result = ScrowConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.telemetry.enabled).toBe(false);
    }
  });

  it('defaults telemetry.endpoint to the sparecrow endpoint when omitted', async () => {
    const { ScrowConfigSchema } = await import('../config/schema.js');
    const result = ScrowConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.telemetry.endpoint).toBe('https://telemetry.sparecrow.dev/v1/events');
    }
  });

  it('rejects invalid telemetry endpoint URL', async () => {
    const { ScrowConfigSchema } = await import('../config/schema.js');
    const result = ScrowConfigSchema.safeParse({
      telemetry: { enabled: false, endpoint: 'not-a-url' },
    });
    expect(result.success).toBe(false);
  });
});
