/** Telemetry pipeline factory — wires TelemetryCollector + TelemetrySender with real config. */
import type { ScrowConfig } from '../types/index.js';
import { TelemetryCollector } from './collector.js';
import { TelemetrySender } from './sender.js';
import type { TelemetryEventType } from './schema.js';

export interface TelemetryPipelineOptions {
  /** Resolved sparecrow package version (e.g. '1.2.3'). */
  version: string;
  /** Loaded daemon/CLI config — drives telemetry.enabled and telemetry.endpoint. */
  config: ScrowConfig;
  /** State directory path — used by TelemetryCollector for installation-ID persistence. */
  stateDir: string;
}

/**
 * Record a single telemetry event and immediately flush it to the remote endpoint.
 *
 * Fire-and-forget: all errors are silently logged and never propagate to the caller.
 * The call site should use `void recordTelemetryEvent(...)` and never await the result
 * in a critical path.
 *
 * @returns true if telemetry is enabled and the event was sent successfully, false otherwise.
 */
export async function recordTelemetryEvent(
  opts: TelemetryPipelineOptions,
  eventType: TelemetryEventType,
  commandName?: string,
  errorCode?: string,
): Promise<boolean> {
  if (!opts.config.telemetry.enabled) return false;

  try {
    const collector = new TelemetryCollector({
      version: opts.version,
      stateDir: opts.stateDir,
    });
    const sender = new TelemetrySender({
      endpoint: opts.config.telemetry.endpoint,
    });

    await collector.record(eventType, commandName, errorCode);
    const events = collector.drain();
    await collector.persistRecentEvents();
    return await sender.send(events);
  } catch {
    // Telemetry must never crash or block the caller
    return false;
  }
}
