/** Telemetry module barrel — re-exports collector, sender, schema, and pipeline. */

export { TelemetryCollector } from './collector.js';
export type { TelemetryCollectorOptions } from './collector.js';

export { TelemetrySender, DEFAULT_TELEMETRY_ENDPOINT } from './sender.js';
export type { TelemetrySenderOptions } from './sender.js';

export { TelemetryEventSchema, TelemetryPayloadSchema, TELEMETRY_EVENT_TYPES } from './schema.js';
export type { TelemetryEvent, TelemetryEventType, TelemetryPayload } from './schema.js';

export { recordTelemetryEvent } from './pipeline.js';
export type { TelemetryPipelineOptions } from './pipeline.js';
