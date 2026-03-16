/** TelemetryCollector — buffers events and maintains a ring buffer of recently sent events. */
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getPaths } from '../platform/index.js';
import { logger } from '../utils/index.js';
import { TelemetryEventSchema } from './schema.js';
import type { TelemetryEvent, TelemetryEventType } from './schema.js';

/** Maximum number of recently-sent events kept in the ring buffer for transparency (AC5). */
const RING_BUFFER_SIZE = 10;

/** Filename for the persisted installation ID. */
const INSTALLATION_ID_FILE = 'telemetry-id';

/** Filename for the recent events ring buffer. */
const RECENT_EVENTS_FILE = 'telemetry-recent.json';

export interface TelemetryCollectorOptions {
  /** Override installation ID (for testing). */
  installationId?: string;
  /** Override sparecrow version (for testing). */
  version?: string;
  /** Override state directory (for testing). */
  stateDir?: string;
}

export class TelemetryCollector {
  private buffer: TelemetryEvent[] = [];
  private recentEvents: TelemetryEvent[] = [];
  private installationId: string | null = null;
  private readonly version: string;
  private readonly stateDir: string;

  constructor(opts?: TelemetryCollectorOptions) {
    this.version = opts?.version ?? '0.0.0';
    this.stateDir = opts?.stateDir ?? getPaths().data;
    if (opts?.installationId) {
      this.installationId = opts.installationId;
    }
  }

  /** Get or create the installation ID. Persisted to state directory. */
  async getInstallationId(): Promise<string> {
    if (this.installationId) return this.installationId;

    const idPath = join(this.stateDir, INSTALLATION_ID_FILE);
    try {
      const existing = await readFile(idPath, 'utf-8');
      const trimmed = existing.trim();
      if (trimmed.length > 0) {
        this.installationId = trimmed;
        return trimmed;
      }
    } catch {
      // File doesn't exist — generate new ID
    }

    const newId = randomUUID();
    try {
      await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
      await writeFile(idPath, newId, { mode: 0o600 });
    } catch (err) {
      void logger.warn('telemetry.id.persist_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.installationId = newId;
    return newId;
  }

  /** Record a telemetry event into the buffer. */
  async record(
    eventType: TelemetryEventType,
    commandName?: string,
    errorCode?: string,
  ): Promise<void> {
    const id = await this.getInstallationId();
    const event: TelemetryEvent = {
      timestamp: new Date().toISOString(),
      installationId: id,
      eventType,
      commandName: commandName ?? null,
      errorCode: errorCode ?? null,
      osPlatform: process.platform,
      osArch: process.arch,
      nodeMajorVersion: parseInt(process.versions.node.split('.')[0]!, 10),
      sparecrowVersion: this.version,
    };
    this.buffer.push(event);
  }

  /** Drain all buffered events and return them. Moves drained events to the ring buffer. */
  drain(): TelemetryEvent[] {
    const events = [...this.buffer];
    this.buffer = [];

    // Add to ring buffer (most recent events kept)
    for (const event of events) {
      this.recentEvents.push(event);
      if (this.recentEvents.length > RING_BUFFER_SIZE) {
        this.recentEvents.shift();
      }
    }

    return events;
  }

  /** Get the current buffer size (pending events). */
  get pendingCount(): number {
    return this.buffer.length;
  }

  /** Get the ring buffer of recently sent events (for AC5 transparency). */
  getRecentEvents(): TelemetryEvent[] {
    return [...this.recentEvents];
  }

  /** Persist the recent events ring buffer to disk. */
  async persistRecentEvents(): Promise<void> {
    const recentPath = join(this.stateDir, RECENT_EVENTS_FILE);
    try {
      await writeFile(recentPath, JSON.stringify(this.recentEvents, null, 2), { mode: 0o600 });
    } catch (err) {
      void logger.warn('telemetry.recent.persist_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Load the recent events ring buffer from disk. */
  async loadRecentEvents(): Promise<void> {
    const recentPath = join(this.stateDir, RECENT_EVENTS_FILE);
    try {
      const content = await readFile(recentPath, 'utf-8');
      const parsed = JSON.parse(content) as unknown;
      if (Array.isArray(parsed)) {
        const validated: TelemetryEvent[] = [];
        for (const item of parsed) {
          const result = TelemetryEventSchema.safeParse(item);
          if (result.success) {
            validated.push(result.data);
          } else {
            void logger.warn('telemetry.recent.invalid_event', {
              error: result.error.message,
            });
          }
        }
        this.recentEvents = validated.slice(-RING_BUFFER_SIZE);
      }
    } catch {
      // No recent events file — start fresh
    }
  }
}
