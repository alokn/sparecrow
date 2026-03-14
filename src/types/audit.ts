/** Audit logging contract types shared by logger writers and audit-log readers. */
import type { EventNameValue } from './events.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Fixed-schema JSONL audit record — all fields are always present. */
export interface AuditRecord {
  ts: string; // ISO 8601
  level: LogLevel;
  event: EventNameValue | string;
  data: Record<string, unknown>;
  provider: string | null;
  source: string | null;
  confidence: string | null;
  error: string | null;
}

/** Optional provider/source/confidence metadata for structured log writes. */
export interface AuditMeta {
  provider?: string | null;
  source?: string | null;
  confidence?: string | null;
  /** Optional error message to persist in the JSONL record's top-level error field. */
  error?: string | null;
}
