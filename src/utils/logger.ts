/** Structured JSONL logger writing to audit log files. debug/info/warn/error levels. */
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ScrowError, ErrorCode } from '../errors/index.js';
import type { AuditMeta, AuditRecord, LogLevel } from '../types/index.js';

let _logLevel: LogLevel = 'info';
let _logToFile = false;
let _logDir: string | null = null;

export function setLogLevel(level: LogLevel): void {
  _logLevel = level;
}

/**
 * Sets the directory where audit log files are written.
 * Must be called before enableFileLogging() — typically during daemon/CLI bootstrap.
 * Calling setLogDir() again after it has already been set emits a warning to stderr.
 */
export function setLogDir(dir: string): void {
  if (_logDir !== null && _logDir !== dir) {
    process.stderr.write(
      `[WARN ] logger.setLogDir: overwriting log directory (was: ${_logDir}, now: ${dir})\n`,
    );
  }
  _logDir = dir;
}

/**
 * Resets logger singleton state (log directory and file-logging toggle).
 * For use in tests only — allows teardown without vi.resetModules().
 */
export function resetLoggerState(): void {
  _logDir = null;
  _logToFile = false;
}

/**
 * Activates file-based audit logging.
 * Throws ScrowError(CONFIG_INVALID) if setLogDir() has not been called first.
 */
export function enableFileLogging(): void {
  if (_logDir === null) {
    throw new ScrowError(
      ErrorCode.CONFIG_INVALID,
      'Log directory not initialised — call setLogDir(dir) before enableFileLogging()',
    );
  }
  _logToFile = true;
}

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function todayFile(): string {
  const d = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  // _logDir is guaranteed non-null here because enableFileLogging() guards on it
  return join(_logDir as string, `audit-${d}.jsonl`);
}

async function writeRecord(record: AuditRecord): Promise<void> {
  // NEVER log credentials — enforced by callers not passing them in `data`
  const line = JSON.stringify(record) + '\n';
  if (_logToFile) {
    await appendFile(todayFile(), line, { encoding: 'utf-8', mode: 0o600 }).catch(() => {
      // File logging failure must not crash the caller
    });
  }
  // Console output for development / daemon stderr
  if (LEVELS[record.level] >= LEVELS[_logLevel]) {
    const prefix = record.level.toUpperCase().padEnd(5);
    process.stderr.write(`[${prefix}] ${record.event}: ${JSON.stringify(record.data)}\n`);
  }
}

export const logger = {
  debug: (event: string, data: Record<string, unknown> = {}, meta?: AuditMeta) =>
    writeRecord({
      ts: new Date().toISOString(),
      level: 'debug',
      event,
      data,
      provider: meta?.provider ?? null,
      source: meta?.source ?? null,
      confidence: meta?.confidence ?? null,
      error: meta?.error ?? null,
    }),
  info: (event: string, data: Record<string, unknown> = {}, meta?: AuditMeta) =>
    writeRecord({
      ts: new Date().toISOString(),
      level: 'info',
      event,
      data,
      provider: meta?.provider ?? null,
      source: meta?.source ?? null,
      confidence: meta?.confidence ?? null,
      error: meta?.error ?? null,
    }),
  warn: (event: string, data: Record<string, unknown> = {}, meta?: AuditMeta) =>
    writeRecord({
      ts: new Date().toISOString(),
      level: 'warn',
      event,
      data,
      provider: meta?.provider ?? null,
      source: meta?.source ?? null,
      confidence: meta?.confidence ?? null,
      error: meta?.error ?? null,
    }),
  error: (event: string, data: Record<string, unknown> = {}, err?: Error) =>
    writeRecord({
      ts: new Date().toISOString(),
      level: 'error',
      event,
      data,
      provider: null,
      source: null,
      confidence: null,
      error: err?.message ?? null,
    }),
};
