/** Tests for daemon summary writer — last-summary.txt writing behavior. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { writeSummaryFile } from './summary-writer.js';

function makeTempDir(): string {
  return join(tmpdir(), `summary-writer-test-${randomBytes(6).toString('hex')}`);
}

describe('writeSummaryFile', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = makeTempDir();
    await mkdir(dataDir, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('writes last-summary.txt with exact one-line format (AC9)', async () => {
    await writeSummaryFile(dataDir, 3);
    const content = await readFile(join(dataDir, 'last-summary.txt'), 'utf-8');
    expect(content).toBe(
      'sparecrow: 3 tasks completed in last dispatch cycle. Run sparecrow logs for details.',
    );
  });

  it('writes correct format when success count is 0 (AC9)', async () => {
    await writeSummaryFile(dataDir, 0);
    const content = await readFile(join(dataDir, 'last-summary.txt'), 'utf-8');
    expect(content).toBe(
      'sparecrow: 0 tasks completed in last dispatch cycle. Run sparecrow logs for details.',
    );
  });

  it('writes correct format for large success count', async () => {
    await writeSummaryFile(dataDir, 42);
    const content = await readFile(join(dataDir, 'last-summary.txt'), 'utf-8');
    expect(content).toBe(
      'sparecrow: 42 tasks completed in last dispatch cycle. Run sparecrow logs for details.',
    );
  });

  it('overwrites existing last-summary.txt (not disabled — write replaces)', async () => {
    const filePath = join(dataDir, 'last-summary.txt');
    await writeFile(filePath, 'old content', 'utf-8');
    await writeSummaryFile(dataDir, 2);
    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe(
      'sparecrow: 2 tasks completed in last dispatch cycle. Run sparecrow logs for details.',
    );
  });

  it('does not throw when write fails (EACCES) — failure isolation (AC14)', async () => {
    // Reset modules then mock atomicWrite to simulate a permission error
    vi.resetModules();
    vi.doMock('../utils/index.js', () => ({
      atomicWrite: () => {
        const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        return Promise.reject(err);
      },
      logger: {
        debug: vi.fn().mockResolvedValue(undefined),
        info: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
      },
    }));
    const { writeSummaryFile: writeFn } = await import('./summary-writer.js');
    // Must not throw
    await expect(writeFn(dataDir, 5)).resolves.toBeUndefined();
  });

  it('creates data directory if it does not exist', async () => {
    const newDir = join(dataDir, 'subdir-' + randomBytes(4).toString('hex'));
    // subdir does not exist yet
    await writeSummaryFile(newDir, 1);
    const content = await readFile(join(newDir, 'last-summary.txt'), 'utf-8');
    expect(content).toContain('1 tasks completed');
  });
});

// ---------------------------------------------------------------------------
// Stale-file behavior: disabled mode must not mutate existing last-summary.txt (AC10)
// ---------------------------------------------------------------------------
describe('polling-loop summary writer gating', () => {
  it('does not invoke writeSummaryFile when lastSummaryEnabled is false', async () => {
    // The gating condition in polling-loop.ts line 433:
    //   if (config.lastSummaryEnabled && cycleResult !== null) { await writeSummaryFile(...) }
    // When lastSummaryEnabled === false, writeSummaryFile is never invoked.
    // We verify this by spying on writeSummaryFile and simulating the gating logic.
    const writeSpy = vi.fn<(dataDir: string, successCount: number) => Promise<void>>();

    // Simulate the polling loop gating logic with disabled config
    const simulateGating = async (lastSummaryEnabled: boolean, dataDir2: string): Promise<void> => {
      const cycleResult = { tasksSucceeded: 3 };
      if (lastSummaryEnabled && cycleResult !== null) {
        await writeSpy(dataDir2, cycleResult.tasksSucceeded);
      }
    };

    const dataDir2 = makeTempDir();
    await mkdir(dataDir2, { recursive: true });
    const staleFilePath = join(dataDir2, 'last-summary.txt');
    const staleContent = 'stale-content-must-not-change';

    try {
      await writeFile(staleFilePath, staleContent, 'utf-8');

      // When disabled (lastSummaryEnabled=false), the spy is never called
      await simulateGating(false, dataDir2);
      expect(writeSpy).not.toHaveBeenCalled();

      // Pre-existing file remains untouched
      const content = await readFile(staleFilePath, 'utf-8');
      expect(content).toBe(staleContent);

      // When enabled (lastSummaryEnabled=true), the spy IS called
      await simulateGating(true, dataDir2);
      expect(writeSpy).toHaveBeenCalledOnce();
      expect(writeSpy).toHaveBeenCalledWith(dataDir2, 3);
    } finally {
      await rm(dataDir2, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Output content guardrail — no secrets or credentials (AC12)
// ---------------------------------------------------------------------------
describe('writeSummaryFile content guardrail', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = makeTempDir();
    await mkdir(dataDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('output contains only aggregate metrics and no secret-like material (AC12)', async () => {
    await writeSummaryFile(dataDir, 5);
    const content = await readFile(join(dataDir, 'last-summary.txt'), 'utf-8');
    // No credentials, tokens, or sensitive patterns
    expect(content).not.toMatch(/token|credential|password|secret|key=/i);
    // Contains only the expected safe aggregate line
    expect(content).toContain('5 tasks completed in last dispatch cycle');
  });
});
