/** Generates structured crash report files for unhandled exceptions. */
import { writeFile, readFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { platform, arch } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { VERSION } from './version.js';
import { AUDIT_LOG_FILENAME_REGEX } from './fs.js';
import { logger } from './logger.js';

/** Shape of a structured crash report. */
export interface CrashReport {
  /** ISO 8601 timestamp of crash. */
  timestamp: string;
  /** sparecrow version. */
  sparecrowVersion: string;
  /** Node.js version string. */
  nodeVersion: string;
  /** OS platform. */
  osPlatform: string;
  /** CPU architecture. */
  osArch: string;
  /** Error code if ScrowError, else 'UNKNOWN'. */
  errorCode: string;
  /** Error message (no stack). */
  errorMessage: string;
  /** Last N audit log entries (sanitised). */
  recentAuditEntries: SanitisedAuditEntry[];
  /** Non-sensitive config summary. */
  configSummary: ConfigSummary;
}

export interface SanitisedAuditEntry {
  ts: string;
  level: string;
  event: string;
  error: string | null;
}

export interface ConfigSummary {
  pollingInterval: number | null;
  executionBackend: string | null;
  triggerMaxWastePercentage: number | null;
}

const MAX_RECENT_ENTRIES = 5;

/** Extract error code from a caught error. */
function extractErrorCode(err: unknown): string {
  if (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    typeof (err as Record<string, unknown>)['code'] === 'string'
  ) {
    return (err as Record<string, unknown>)['code'] as string;
  }
  return 'UNKNOWN';
}

/** Extract error message from a caught error. */
function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Read last N audit entries from the most recent audit log file. */
async function readRecentAuditEntries(logsDir: string): Promise<SanitisedAuditEntry[]> {
  try {
    const files = await readdir(logsDir);
    const auditFiles = files.filter((f) => AUDIT_LOG_FILENAME_REGEX.test(f)).sort();
    if (auditFiles.length === 0) return [];

    const latestFile = auditFiles[auditFiles.length - 1]!;
    const content = await readFile(join(logsDir, latestFile), 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const lastLines = lines.slice(-MAX_RECENT_ENTRIES);

    const entries: SanitisedAuditEntry[] = [];
    for (const line of lastLines) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed !== null && typeof parsed === 'object') {
          const rec = parsed as Record<string, unknown>;
          entries.push({
            ts: typeof rec['ts'] === 'string' ? rec['ts'] : '',
            level: typeof rec['level'] === 'string' ? rec['level'] : 'info',
            event: typeof rec['event'] === 'string' ? rec['event'] : '',
            error: typeof rec['error'] === 'string' ? rec['error'] : null,
          });
        }
      } catch {
        // Skip unparseable lines
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/** Load non-sensitive config values by parsing YAML directly (no config module import). */
async function loadConfigSummary(configDir: string): Promise<ConfigSummary> {
  const defaultSummary: ConfigSummary = {
    pollingInterval: null,
    executionBackend: null,
    triggerMaxWastePercentage: null,
  };

  try {
    const configPath = join(configDir, 'config.yaml');
    const raw = parseYaml(await readFile(configPath, 'utf-8')) as Record<string, unknown>;

    const pollingInterval =
      typeof raw['polling_interval'] === 'number' ? raw['polling_interval'] : null;
    const provider =
      raw['provider'] !== null && typeof raw['provider'] === 'object'
        ? (raw['provider'] as Record<string, unknown>)
        : {};
    const trigger =
      raw['trigger'] !== null && typeof raw['trigger'] === 'object'
        ? (raw['trigger'] as Record<string, unknown>)
        : {};
    const executionBackend =
      typeof provider['execution_backend'] === 'string' ? provider['execution_backend'] : null;
    const triggerMaxWastePercentage =
      typeof trigger['max_waste_percentage'] === 'number' ? trigger['max_waste_percentage'] : null;

    return { pollingInterval, executionBackend, triggerMaxWastePercentage };
  } catch {
    return defaultSummary;
  }
}

/** Generate a crash report object. */
export async function generateCrashReport(
  err: unknown,
  logsDir: string,
  configDir: string,
): Promise<CrashReport> {
  const [recentAuditEntries, configSummary] = await Promise.all([
    readRecentAuditEntries(logsDir),
    loadConfigSummary(configDir),
  ]);

  return {
    timestamp: new Date().toISOString(),
    sparecrowVersion: VERSION,
    nodeVersion: process.versions.node,
    osPlatform: platform(),
    osArch: arch(),
    errorCode: extractErrorCode(err),
    errorMessage: extractErrorMessage(err),
    recentAuditEntries,
    configSummary,
  };
}

/** Write crash report to state dir. Returns the file path. */
export async function writeCrashReport(
  err: unknown,
  stateDir: string,
  logsDir: string,
  configDir: string,
): Promise<string> {
  try {
    const report = await generateCrashReport(err, logsDir, configDir);
    const ts = report.timestamp.replace(/[:.]/g, '-');
    const filename = `crash-${ts}.json`;
    const filePath = join(stateDir, filename);
    await mkdir(stateDir, { recursive: true });
    await writeFile(filePath, JSON.stringify(report, null, 2) + '\n', {
      encoding: 'utf-8',
      mode: 0o600,
    });
    return filePath;
  } catch (writeErr) {
    void logger.warn('crash-report.write-failed', {
      reason: writeErr instanceof Error ? writeErr.message : String(writeErr),
    });
    return '';
  }
}
