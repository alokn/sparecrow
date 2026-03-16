/** Tests for report-crash command. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('report-crash', () => {
  let tempDir: string;
  let reportPath: string;

  const validReport = {
    timestamp: '2026-03-17T10:00:00.000Z',
    sparecrowVersion: '1.0.0',
    nodeVersion: '22.0.0',
    osPlatform: 'linux',
    osArch: 'x64',
    errorCode: 'CONFIG_INVALID',
    errorMessage: 'Bad config',
    recentAuditEntries: [
      {
        ts: '2026-03-17T09:00:00.000Z',
        level: 'error',
        event: 'config.load',
        error: 'parse failed',
      },
    ],
    configSummary: {
      pollingInterval: 300,
      executionBackend: 'container',
      triggerMaxWastePercentage: 20,
    },
  };

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), 'report-crash-test-'));
    reportPath = join(tempDir, 'crash-test.json');
    await writeFile(reportPath, JSON.stringify(validReport));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('displays report contents in non-interactive mode', async () => {
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      isInteractive: () => false,
    }));
    vi.doMock('../../ui/index.js', () => ({
      printJson: vi.fn(),
    }));

    const { registerReportCrash } = await import('./report-crash.js');
    const { Command } = await import('commander');

    const program = new Command();
    registerReportCrash(program);

    const writes: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      writes.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      await program.parseAsync(['node', 'test', 'report-crash', reportPath]);
    } finally {
      process.stdout.write = origWrite;
    }

    const output = writes.join('');
    expect(output).toContain('CONFIG_INVALID');
    expect(output).toContain('Bad config');
    expect(output).toContain('issues/new');
  });

  it('outputs JSON envelope with report and issueUrl in --json mode', async () => {
    let captured: unknown = null;
    vi.doMock('../index.js', () => ({
      isJsonMode: () => true,
      isInteractive: () => false,
    }));
    vi.doMock('../../ui/index.js', () => ({
      printJson: (val: unknown) => {
        captured = val;
      },
    }));

    const { registerReportCrash } = await import('./report-crash.js');
    const { Command } = await import('commander');

    const program = new Command();
    registerReportCrash(program);

    await program.parseAsync(['node', 'test', 'report-crash', reportPath]);

    expect(captured).not.toBeNull();
    const result = captured as { ok: boolean; data: { report: unknown; issueUrl: string } };
    expect(result.ok).toBe(true);
    expect(result.data.issueUrl).toContain('issues/new');
    expect(result.data.issueUrl).toContain('CONFIG_INVALID');
  });

  it('throws CRASH_REPORT_NOT_FOUND for missing file', async () => {
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      isInteractive: () => false,
    }));
    vi.doMock('../../ui/index.js', () => ({
      printJson: vi.fn(),
    }));

    const { registerReportCrash } = await import('./report-crash.js');
    const { Command } = await import('commander');

    const program = new Command();
    program.exitOverride();
    registerReportCrash(program);

    await expect(
      program.parseAsync(['node', 'test', 'report-crash', '/nonexistent/file.json']),
    ).rejects.toMatchObject({ code: 'CRASH_REPORT_NOT_FOUND' });
  });

  it('throws CRASH_REPORT_INVALID for invalid JSON', async () => {
    const badPath = join(tempDir, 'bad.json');
    await writeFile(badPath, 'not json');

    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      isInteractive: () => false,
    }));
    vi.doMock('../../ui/index.js', () => ({
      printJson: vi.fn(),
    }));

    const { registerReportCrash } = await import('./report-crash.js');
    const { Command } = await import('commander');

    const program = new Command();
    program.exitOverride();
    registerReportCrash(program);

    await expect(
      program.parseAsync(['node', 'test', 'report-crash', badPath]),
    ).rejects.toMatchObject({ code: 'CRASH_REPORT_INVALID' });
  });

  it('outputs JSON error envelope in --json mode for missing file', async () => {
    let captured: unknown = null;
    vi.doMock('../index.js', () => ({
      isJsonMode: () => true,
      isInteractive: () => false,
    }));
    vi.doMock('../../ui/index.js', () => ({
      printJson: (val: unknown) => {
        captured = val;
      },
    }));

    const { registerReportCrash } = await import('./report-crash.js');
    const { Command } = await import('commander');

    const program = new Command();
    registerReportCrash(program);

    await program.parseAsync(['node', 'test', 'report-crash', '/nonexistent/crash.json']);

    expect(captured).not.toBeNull();
    const result = captured as { ok: boolean; error: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('CRASH_REPORT_NOT_FOUND');
  });

  it('outputs JSON error envelope in --json mode for invalid JSON', async () => {
    const badPath = join(tempDir, 'bad2.json');
    await writeFile(badPath, 'not json content');

    let captured: unknown = null;
    vi.doMock('../index.js', () => ({
      isJsonMode: () => true,
      isInteractive: () => false,
    }));
    vi.doMock('../../ui/index.js', () => ({
      printJson: (val: unknown) => {
        captured = val;
      },
    }));

    const { registerReportCrash } = await import('./report-crash.js');
    const { Command } = await import('commander');

    const program = new Command();
    registerReportCrash(program);

    await program.parseAsync(['node', 'test', 'report-crash', badPath]);

    expect(captured).not.toBeNull();
    const result = captured as { ok: boolean; error: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('CRASH_REPORT_INVALID');
  });

  it('throws CRASH_REPORT_INVALID for JSON missing required fields', async () => {
    const incompletePath = join(tempDir, 'incomplete.json');
    await writeFile(incompletePath, JSON.stringify({ foo: 'bar' }));

    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      isInteractive: () => false,
    }));
    vi.doMock('../../ui/index.js', () => ({
      printJson: vi.fn(),
    }));

    const { registerReportCrash } = await import('./report-crash.js');
    const { Command } = await import('commander');

    const program = new Command();
    program.exitOverride();
    registerReportCrash(program);

    await expect(
      program.parseAsync(['node', 'test', 'report-crash', incompletePath]),
    ).rejects.toMatchObject({ code: 'CRASH_REPORT_INVALID' });
  });
});
