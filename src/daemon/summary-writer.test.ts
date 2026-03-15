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
// AC5: last-summary.txt is human-readable text format (not JSON)
// ---------------------------------------------------------------------------
describe('writeSummaryFile text format (AC5)', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = makeTempDir();
    await mkdir(dataDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('writes plain text that is NOT valid JSON (AC5)', async () => {
    await writeSummaryFile(dataDir, 7);
    const content = await readFile(join(dataDir, 'last-summary.txt'), 'utf-8');
    // Must not be parseable as JSON — it's human-readable text, not JSON
    expect(() => JSON.parse(content)).toThrow();
    // Must be a single line starting with 'sparecrow:'
    expect(content.startsWith('sparecrow:')).toBe(true);
    // Must not contain JSON structural characters at the start
    expect(content).not.toMatch(/^\s*[{[]/);
  });

  it('contains human-readable task count and actionable hint (AC5)', async () => {
    await writeSummaryFile(dataDir, 12);
    const content = await readFile(join(dataDir, 'last-summary.txt'), 'utf-8');
    // Human-readable: includes the count and a guidance message
    expect(content).toContain('12 tasks completed');
    expect(content).toContain('Run sparecrow logs for details');
  });

  it('writes single-line format with no trailing newline (AC5)', async () => {
    await writeSummaryFile(dataDir, 1);
    const content = await readFile(join(dataDir, 'last-summary.txt'), 'utf-8');
    // Single line — explicitly assert no embedded newlines
    expect(content.includes('\n')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Stale-file behavior: disabled mode must not mutate existing last-summary.txt (AC10)
// ---------------------------------------------------------------------------
// Polling-loop gating is now tested via the real PollingLoop class in
// src/daemon/polling-loop.test.ts ('PollingLoop — writeSummaryFile gating (Story 21.2)').
// Those tests spy on writeSummaryFile through the actual production gating branch:
//   if (config.lastSummaryEnabled && cycleResult !== null) { await writeSummaryFile(...) }
// This avoids false confidence from inline simulations that hardcode the same condition.

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
