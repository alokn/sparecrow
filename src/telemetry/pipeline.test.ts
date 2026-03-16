/** Tests for recordTelemetryEvent — wiring of collector + sender with config-driven enabling. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recordTelemetryEvent } from './pipeline.js';
import type { ScrowConfig } from '../types/index.js';

const DEFAULT_ENDPOINT = 'https://telemetry.sparecrow.dev/v1/events';

const makeConfig = (telemetryEnabled: boolean, endpoint?: string): ScrowConfig => ({
  pollingInterval: 10,
  logRetentionDays: 30,
  taskTimeoutMinutes: 60,
  provider: {
    name: 'claude-code',
    allowDangerouslySkipPermissions: false,
    executionBackend: 'container',
  },
  trigger: {
    maxWastePercentage: 50,
    weeklyReservePercentage: 30,
    idleHours: [],
  },
  tasks: [],
  lastSummaryEnabled: false,
  wslMountPrefix: '/mnt/',
  telemetry: {
    enabled: telemetryEnabled,
    endpoint: endpoint ?? DEFAULT_ENDPOINT,
  },
});

describe('recordTelemetryEvent', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'scrow-pipeline-test-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('returns false and skips network when telemetry is disabled', async () => {
    const result = await recordTelemetryEvent(
      { version: '1.0.0', config: makeConfig(false), stateDir },
      'command_run',
      'status',
    );
    expect(result).toBe(false);
  });

  it('sends event with real version and config endpoint when enabled', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    // Temporarily replace globalThis.fetch for this test
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as typeof globalThis.fetch;

    try {
      const customEndpoint = 'https://custom.example.com/events';
      const result = await recordTelemetryEvent(
        { version: '2.3.4', config: makeConfig(true, customEndpoint), stateDir },
        'command_run',
        'status',
      );
      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0]!;
      expect(url).toBe(customEndpoint);
      const body = JSON.parse(opts.body as string) as {
        events: Array<{ sparecrowVersion: string }>;
      };
      expect(body.events[0]!.sparecrowVersion).toBe('2.3.4');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('returns false silently when network fails', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as typeof globalThis.fetch;

    try {
      const result = await recordTelemetryEvent(
        { version: '1.0.0', config: makeConfig(true), stateDir },
        'daemon_start',
      );
      expect(result).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
