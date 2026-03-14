/** Shared CLI audit parsing helpers for narrowing unknown JSON values into typed records. */
import { isRecord } from '../../utils/index.js';
import type { AuditRecord, LogLevel } from '../../types/index.js';

/** Extracts a non-empty string from an unknown value or returns null. */
export function asString(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  return null;
}

/** Extracts a finite number from an unknown value or returns null. */
export function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

/** Narrows unknown JSON values into the fixed-schema audit record contract. */
export function asAuditRecord(value: unknown): AuditRecord | null {
  if (!isRecord(value)) return null;

  const ts = asString(value['ts']) ?? new Date().toISOString();
  const rawLevel = asString(value['level']) ?? 'info';
  const level: LogLevel = isLogLevel(rawLevel) ? rawLevel : 'info';
  const event = asString(value['event']) ?? '';
  const data = isRecord(value['data']) ? value['data'] : {};

  return {
    ts,
    level,
    event,
    data,
    provider: asString(value['provider']),
    source: asString(value['source']),
    confidence: asString(value['confidence']),
    error: asString(value['error']),
  };
}

function isLogLevel(value: string): value is LogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error';
}
