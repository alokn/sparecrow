/** Telemetry event schema — defines the minimal, anonymous payload sent when telemetry is enabled. */
import { z } from 'zod';

/** Valid telemetry event types. */
export const TELEMETRY_EVENT_TYPES = [
  'command_run',
  'error',
  'daemon_start',
  'daemon_stop',
] as const;

export type TelemetryEventType = (typeof TELEMETRY_EVENT_TYPES)[number];

/** Schema for a single telemetry event. */
export const TelemetryEventSchema = z.object({
  /** ISO 8601 timestamp of when the event occurred. */
  timestamp: z.string().datetime(),
  /** Random installation UUID — not tied to any user identity. */
  installationId: z.string().uuid(),
  /** Event type. */
  eventType: z.enum(TELEMETRY_EVENT_TYPES),
  /** Command name (no arguments or flags). Null for non-command events. */
  commandName: z.string().nullable(),
  /** ScrowError code only — no message or stack. Null when no error. */
  errorCode: z.string().nullable(),
  /** OS platform (e.g. 'linux', 'darwin', 'win32'). */
  osPlatform: z.string(),
  /** OS architecture (e.g. 'x64', 'arm64'). */
  osArch: z.string(),
  /** Node.js major version (e.g. 22). */
  nodeMajorVersion: z.number().int(),
  /** sparecrow version string. */
  sparecrowVersion: z.string(),
});

export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;

/** Schema for the batch payload sent to the telemetry endpoint. */
export const TelemetryPayloadSchema = z.object({
  events: z.array(TelemetryEventSchema).min(1),
});

export type TelemetryPayload = z.infer<typeof TelemetryPayloadSchema>;
