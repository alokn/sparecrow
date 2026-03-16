/** Tests for TelemetryCollector — event buffering, ring buffer, and installation ID persistence. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TelemetryCollector } from './collector.js';

describe('TelemetryCollector', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'scrow-telemetry-test-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('generates and persists an installation ID', async () => {
    const collector = new TelemetryCollector({ stateDir, version: '1.0.0' });
    const id = await collector.getInstallationId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    // Verify persistence
    const persisted = await readFile(join(stateDir, 'telemetry-id'), 'utf-8');
    expect(persisted.trim()).toBe(id);

    // Second call returns same ID
    const id2 = await collector.getInstallationId();
    expect(id2).toBe(id);
  });

  it('reuses persisted installation ID across instances', async () => {
    const c1 = new TelemetryCollector({ stateDir, version: '1.0.0' });
    const id1 = await c1.getInstallationId();

    const c2 = new TelemetryCollector({ stateDir, version: '1.0.0' });
    const id2 = await c2.getInstallationId();

    expect(id2).toBe(id1);
  });

  it('uses provided installation ID without generating', async () => {
    const fixedId = 'a0000000-0000-4000-8000-000000000001';
    const collector = new TelemetryCollector({
      stateDir,
      version: '1.0.0',
      installationId: fixedId,
    });
    const id = await collector.getInstallationId();
    expect(id).toBe(fixedId);
  });

  it('records events into buffer', async () => {
    const collector = new TelemetryCollector({
      stateDir,
      version: '1.0.0',
      installationId: 'a0000000-0000-4000-8000-000000000001',
    });
    await collector.record('command_run', 'status');
    await collector.record('error', undefined, 'CONFIG_INVALID');

    expect(collector.pendingCount).toBe(2);
  });

  it('drains buffer and populates ring buffer', async () => {
    const collector = new TelemetryCollector({
      stateDir,
      version: '1.0.0',
      installationId: 'a0000000-0000-4000-8000-000000000001',
    });
    await collector.record('command_run', 'status');
    await collector.record('daemon_start');

    const events = collector.drain();
    expect(events).toHaveLength(2);
    expect(collector.pendingCount).toBe(0);

    expect(events[0]!.eventType).toBe('command_run');
    expect(events[0]!.commandName).toBe('status');
    expect(events[1]!.eventType).toBe('daemon_start');
    expect(events[1]!.commandName).toBeNull();

    // Ring buffer populated
    const recent = collector.getRecentEvents();
    expect(recent).toHaveLength(2);
  });

  it('ring buffer caps at 10 events', async () => {
    const collector = new TelemetryCollector({
      stateDir,
      version: '1.0.0',
      installationId: 'a0000000-0000-4000-8000-000000000001',
    });

    for (let i = 0; i < 15; i++) {
      await collector.record('command_run', `cmd-${i}`);
    }
    collector.drain();

    const recent = collector.getRecentEvents();
    expect(recent).toHaveLength(10);
    expect(recent[0]!.commandName).toBe('cmd-5');
    expect(recent[9]!.commandName).toBe('cmd-14');
  });

  it('persists and loads recent events', async () => {
    const c1 = new TelemetryCollector({
      stateDir,
      version: '1.0.0',
      installationId: 'a0000000-0000-4000-8000-000000000001',
    });
    await c1.record('command_run', 'status');
    c1.drain();
    await c1.persistRecentEvents();

    const c2 = new TelemetryCollector({
      stateDir,
      version: '1.0.0',
      installationId: 'a0000000-0000-4000-8000-000000000001',
    });
    await c2.loadRecentEvents();
    const recent = c2.getRecentEvents();
    expect(recent).toHaveLength(1);
    expect(recent[0]!.commandName).toBe('status');
  });

  it('records correct event fields', async () => {
    const collector = new TelemetryCollector({
      stateDir,
      version: '2.0.0',
      installationId: 'a0000000-0000-4000-8000-000000000001',
    });
    await collector.record('error', 'daemon', 'DAEMON_POLL_FAILED');

    const events = collector.drain();
    const event = events[0]!;

    expect(event.installationId).toBe('a0000000-0000-4000-8000-000000000001');
    expect(event.eventType).toBe('error');
    expect(event.commandName).toBe('daemon');
    expect(event.errorCode).toBe('DAEMON_POLL_FAILED');
    expect(event.osPlatform).toBe(process.platform);
    expect(event.osArch).toBe(process.arch);
    expect(event.nodeMajorVersion).toBe(parseInt(process.versions.node.split('.')[0]!, 10));
    expect(event.sparecrowVersion).toBe('2.0.0');
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
