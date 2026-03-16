/** Tests for telemetry event schema validation. */
import { describe, it, expect } from 'vitest';
import { TelemetryEventSchema, TelemetryPayloadSchema } from './schema.js';

describe('TelemetryEventSchema', () => {
  const validEvent = {
    timestamp: '2026-03-16T10:00:00.000Z',
    installationId: 'a0000000-0000-4000-8000-000000000001',
    eventType: 'command_run',
    commandName: 'status',
    errorCode: null,
    osPlatform: 'linux',
    osArch: 'x64',
    nodeMajorVersion: 22,
    sparecrowVersion: '1.0.0',
  };

  it('accepts a valid event', () => {
    const result = TelemetryEventSchema.safeParse(validEvent);
    expect(result.success).toBe(true);
  });

  it('accepts null commandName and errorCode', () => {
    const result = TelemetryEventSchema.safeParse({
      ...validEvent,
      commandName: null,
      errorCode: null,
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid eventType', () => {
    const result = TelemetryEventSchema.safeParse({
      ...validEvent,
      eventType: 'invalid_type',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid installationId (non-UUID)', () => {
    const result = TelemetryEventSchema.safeParse({
      ...validEvent,
      installationId: 'not-a-uuid',
    });
    expect(result.success).toBe(false);
  });
});

describe('TelemetryPayloadSchema', () => {
  it('accepts payload with events', () => {
    const result = TelemetryPayloadSchema.safeParse({
      events: [
        {
          timestamp: '2026-03-16T10:00:00.000Z',
          installationId: 'a0000000-0000-4000-8000-000000000001',
          eventType: 'command_run',
          commandName: 'status',
          errorCode: null,
          osPlatform: 'linux',
          osArch: 'x64',
          nodeMajorVersion: 22,
          sparecrowVersion: '1.0.0',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty events array', () => {
    const result = TelemetryPayloadSchema.safeParse({ events: [] });
    expect(result.success).toBe(false);
  });
});
