/** Tests for crash-reporter module. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('crash-reporter', () => {
  let tempDir: string;
  let stateDir: string;
  let logsDir: string;
  let configDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), 'crash-reporter-test-'));
    stateDir = join(tempDir, 'state');
    logsDir = join(tempDir, 'logs');
    configDir = join(tempDir, 'config');
    await mkdir(stateDir, { recursive: true });
    await mkdir(logsDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('generateCrashReport', () => {
    it('generates report with ScrowError-like error', async () => {
      const { generateCrashReport } = await import('./crash-reporter.js');
      const err = Object.assign(new Error('something broke'), { code: 'CONFIG_INVALID' });
      const report = await generateCrashReport(err, logsDir, configDir);

      expect(report.errorCode).toBe('CONFIG_INVALID');
      expect(report.errorMessage).toBe('something broke');
      expect(report.osPlatform).toBeTruthy();
      expect(report.osArch).toBeTruthy();
      expect(report.nodeVersion).toBeTruthy();
      expect(report.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // Config summary should only contain the 3 safe keys
      expect(Object.keys(report.configSummary)).toEqual([
        'pollingInterval',
        'executionBackend',
        'triggerMaxWastePercentage',
      ]);
    });

    it('generates report with plain string error', async () => {
      const { generateCrashReport } = await import('./crash-reporter.js');
      const report = await generateCrashReport('oops', logsDir, configDir);
      expect(report.errorCode).toBe('UNKNOWN');
      expect(report.errorMessage).toBe('oops');
    });

    it('includes recent audit entries when log files exist', async () => {
      const entries = Array.from({ length: 8 }, (_, i) =>
        JSON.stringify({
          ts: `2026-03-01T0${String(i)}:00:00.000Z`,
          level: 'info',
          event: `event-${String(i)}`,
          data: {},
          provider: null,
          source: null,
          confidence: null,
          error: null,
        }),
      ).join('\n');

      await writeFile(join(logsDir, 'audit-2026-03-01.jsonl'), entries);

      const { generateCrashReport } = await import('./crash-reporter.js');
      const report = await generateCrashReport(new Error('test'), logsDir, configDir);

      expect(report.recentAuditEntries).toHaveLength(5);
      expect(report.recentAuditEntries[0]!.event).toBe('event-3');
      expect(report.recentAuditEntries[4]!.event).toBe('event-7');
    });

    it('returns empty audit entries when no log files exist', async () => {
      const { generateCrashReport } = await import('./crash-reporter.js');
      const report = await generateCrashReport(new Error('test'), logsDir, configDir);
      expect(report.recentAuditEntries).toEqual([]);
    });

    it('excludes sensitive data - no file paths, tokens, or env vars', async () => {
      const { generateCrashReport } = await import('./crash-reporter.js');
      const err = Object.assign(new Error('token xyz at /home/user/.config'), {
        code: 'AUTH_TOKEN_EXPIRED',
      });
      const report = await generateCrashReport(err, logsDir, configDir);
      const json = JSON.stringify(report);

      // Report should contain the error message (that's fine - it doesn't contain actual tokens)
      // But it should NOT contain env vars or process info beyond what's specified
      expect(report.configSummary).not.toHaveProperty('oauthToken');
      expect(Object.keys(report)).toEqual([
        'timestamp',
        'sparecrowVersion',
        'nodeVersion',
        'osPlatform',
        'osArch',
        'errorCode',
        'errorMessage',
        'recentAuditEntries',
        'configSummary',
      ]);
      expect(Object.keys(report.configSummary)).toEqual([
        'pollingInterval',
        'executionBackend',
        'triggerMaxWastePercentage',
      ]);
      // No stack trace in the report (check for typical stack frame pattern)
      expect(json).not.toMatch(/at \w+\.\w+ \(/);
      expect(report).not.toHaveProperty('stack');
    });

    it('sanitises audit entries - only includes ts, level, event, error', async () => {
      const entry = JSON.stringify({
        ts: '2026-03-01T00:00:00.000Z',
        level: 'info',
        event: 'task.dispatched',
        data: { repo: '/secret/path', prompt: 'secret prompt' },
        provider: 'claude-code',
        source: 'oauth',
        confidence: 'high',
        error: null,
      });
      await writeFile(join(logsDir, 'audit-2026-03-01.jsonl'), entry);

      const { generateCrashReport } = await import('./crash-reporter.js');
      const report = await generateCrashReport(new Error('test'), logsDir, configDir);

      expect(report.recentAuditEntries).toHaveLength(1);
      const auditEntry = report.recentAuditEntries[0]!;
      expect(Object.keys(auditEntry)).toEqual(['ts', 'level', 'event', 'error']);
      // No data, provider, source, confidence fields (which could contain sensitive info)
      expect(auditEntry).not.toHaveProperty('data');
      expect(auditEntry).not.toHaveProperty('provider');
    });
  });

  describe('writeCrashReport', () => {
    it('writes crash report file and returns path', async () => {
      const { writeCrashReport } = await import('./crash-reporter.js');
      const path = await writeCrashReport(new Error('boom'), stateDir, logsDir, configDir);

      expect(path).toContain('crash-');
      expect(path).toContain('.json');

      const content = await readFile(path, 'utf-8');
      const report = JSON.parse(content) as Record<string, unknown>;
      expect(report['errorMessage']).toBe('boom');
      expect(report['errorCode']).toBe('UNKNOWN');
    });

    it('returns empty string when write fails', async () => {
      const { writeCrashReport } = await import('./crash-reporter.js');
      // Pass a path that can't be written to
      const path = await writeCrashReport(
        new Error('test'),
        '/nonexistent/deeply/nested/path',
        logsDir,
        configDir,
      );
      // Should not throw, and must return empty string per contract
      expect(path).toBe('');
    });
  });

  describe('readRecentAuditEntries (via generateCrashReport)', () => {
    it('returns empty array when logsDir does not exist', async () => {
      const { generateCrashReport } = await import('./crash-reporter.js');
      // Use a non-existent logs dir — readdir throws ENOENT
      const report = await generateCrashReport(
        new Error('test'),
        join(tempDir, 'nonexistent-logs'),
        configDir,
      );
      expect(report.recentAuditEntries).toEqual([]);
    });

    it('skips malformed JSONL lines and includes valid ones', async () => {
      const lines = [
        'not valid json',
        JSON.stringify({
          ts: '2026-03-17T10:00:00.000Z',
          level: 'info',
          event: 'valid.event',
          error: null,
        }),
        '{broken',
      ].join('\n');
      await writeFile(join(logsDir, 'audit-2026-03-17.jsonl'), lines);

      const { generateCrashReport } = await import('./crash-reporter.js');
      const report = await generateCrashReport(new Error('test'), logsDir, configDir);
      expect(report.recentAuditEntries).toHaveLength(1);
      expect(report.recentAuditEntries[0]!.event).toBe('valid.event');
    });

    it('uses most recent audit file when multiple exist', async () => {
      await writeFile(
        join(logsDir, 'audit-2026-03-15.jsonl'),
        JSON.stringify({ ts: 't1', level: 'info', event: 'old.event', error: null }),
      );
      await writeFile(
        join(logsDir, 'audit-2026-03-17.jsonl'),
        JSON.stringify({ ts: 't2', level: 'info', event: 'recent.event', error: null }),
      );

      const { generateCrashReport } = await import('./crash-reporter.js');
      const report = await generateCrashReport(new Error('test'), logsDir, configDir);
      expect(report.recentAuditEntries).toHaveLength(1);
      expect(report.recentAuditEntries[0]!.event).toBe('recent.event');
    });
  });
});
