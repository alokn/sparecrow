/** TelemetrySender — fire-and-forget HTTPS POST to the telemetry endpoint. */
import { logger } from '../utils/index.js';
import type { TelemetryEvent } from './schema.js';

/** Default telemetry endpoint. Configurable via telemetry.endpoint in config. */
export const DEFAULT_TELEMETRY_ENDPOINT = 'https://telemetry.sparecrow.dev/v1/events';

/** Timeout for telemetry requests in milliseconds. */
const SEND_TIMEOUT_MS = 5000;

export interface TelemetrySenderOptions {
  /** Override the endpoint URL (for testing). */
  endpoint?: string;
  /** Override the fetch implementation (for testing). */
  fetchFn?: typeof globalThis.fetch;
}

export class TelemetrySender {
  private readonly endpoint: string;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(opts?: TelemetrySenderOptions) {
    this.endpoint = opts?.endpoint ?? DEFAULT_TELEMETRY_ENDPOINT;
    this.fetchFn = opts?.fetchFn ?? globalThis.fetch;
  }

  /** Send events to the telemetry endpoint. Fire-and-forget: errors are silently logged. */
  async send(events: TelemetryEvent[]): Promise<boolean> {
    if (events.length === 0) return true;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

      try {
        const response = await this.fetchFn(this.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ events }),
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (!response.ok) {
          void logger.debug('telemetry.send.http_error', {
            status: response.status,
          });
          return false;
        }

        return true;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      // Silently drop — telemetry must never block or crash the application
      void logger.debug('telemetry.send.failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
}
