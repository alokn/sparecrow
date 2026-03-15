/** Tests for getRecentTaskFailures — bounded audit scan for queue failure context. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { getRecentTaskFailures } from './log-reader.js';

describe('getRecentTaskFailures', () => {
  let logsDir: string;

  beforeEach(async () => {
    logsDir = await mkdtemp(
      join(tmpdir(), `log-reader-failures-${randomBytes(6).toString('hex')}-`),
    );
  });

  afterEach(async () => {
    await rm(logsDir, { recursive: true, force: true });
  });

  function auditLine(taskName: string, event: string, error: string | null = null): string {
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level: 'info',
      event,
      data: { taskName, error },
      provider: null,
      source: null,
      confidence: null,
      error: null,
    };
    return JSON.stringify(record);
  }

  it('returns empty map when no audit file exists', async () => {
    const result = await getRecentTaskFailures(logsDir, ['security-audit']);
    expect(result.size).toBe(0);
  });

  it('returns empty map for empty task names list', async () => {
    const result = await getRecentTaskFailures(logsDir, []);
    expect(result.size).toBe(0);
  });

  it('finds most recent TASK_FAILED event for a task', async () => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const lines = [
      auditLine('security-audit', 'task.failed', 'CLAUDE_NOT_FOUND'),
      auditLine('security-audit', 'task.failed', 'TASK_EXECUTION_FAILED'),
    ];
    await writeFile(join(logsDir, `audit-${today}.jsonl`), lines.join('\n') + '\n');

    const result = await getRecentTaskFailures(logsDir, ['security-audit'], now);
    expect(result.size).toBe(1);
    // Returns the most recent (last line, scanning backward)
    expect(result.get('security-audit')).toBe('TASK_EXECUTION_FAILED');
  });

  it('returns results for multiple task names', async () => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const lines = [
      auditLine('improve-code', 'task.failed', 'AUTH_TOKEN_EXPIRED'),
      auditLine('security-audit', 'task.failed', 'CLAUDE_NOT_FOUND'),
    ];
    await writeFile(join(logsDir, `audit-${today}.jsonl`), lines.join('\n') + '\n');

    const result = await getRecentTaskFailures(logsDir, ['security-audit', 'improve-code'], now);
    expect(result.size).toBe(2);
    expect(result.get('security-audit')).toBe('CLAUDE_NOT_FOUND');
    expect(result.get('improve-code')).toBe('AUTH_TOKEN_EXPIRED');
  });

  it('returns empty map for tasks not in audit log', async () => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const lines = [auditLine('other-task', 'task.failed', 'CLAUDE_NOT_FOUND')];
    await writeFile(join(logsDir, `audit-${today}.jsonl`), lines.join('\n') + '\n');

    const result = await getRecentTaskFailures(logsDir, ['security-audit'], now);
    expect(result.size).toBe(0);
  });

  it('ignores non-TASK_FAILED events', async () => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const lines = [
      auditLine('security-audit', 'task.completed', null),
      auditLine('security-audit', 'task.requeued', null),
    ];
    await writeFile(join(logsDir, `audit-${today}.jsonl`), lines.join('\n') + '\n');

    const result = await getRecentTaskFailures(logsDir, ['security-audit'], now);
    expect(result.size).toBe(0);
  });

  it('stops scanning after 200 lines', async () => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    // Write 250 non-matching lines followed by one matching line at the top
    const lines: string[] = [];
    lines.push(auditLine('security-audit', 'task.failed', 'OLD_ERROR'));
    for (let i = 0; i < 250; i++) {
      lines.push(auditLine('other-task', 'task.completed', null));
    }
    await writeFile(join(logsDir, `audit-${today}.jsonl`), lines.join('\n') + '\n');

    const result = await getRecentTaskFailures(logsDir, ['security-audit'], now);
    // The matching line is beyond 200 lines from the end, so it should not be found
    expect(result.size).toBe(0);
  });

  it('returns UNKNOWN when error field is missing', async () => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const record = {
      ts: new Date().toISOString(),
      level: 'info',
      event: 'task.failed',
      data: { taskName: 'security-audit' },
      provider: null,
      source: null,
      confidence: null,
      error: null,
    };
    await writeFile(join(logsDir, `audit-${today}.jsonl`), JSON.stringify(record) + '\n');

    const result = await getRecentTaskFailures(logsDir, ['security-audit'], now);
    expect(result.size).toBe(1);
    expect(result.get('security-audit')).toBe('UNKNOWN');
  });

  it('handles malformed JSONL lines gracefully', async () => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const lines = [
      'not valid json',
      auditLine('security-audit', 'task.failed', 'CLAUDE_NOT_FOUND'),
      '{incomplete',
    ];
    await writeFile(join(logsDir, `audit-${today}.jsonl`), lines.join('\n') + '\n');

    const result = await getRecentTaskFailures(logsDir, ['security-audit'], now);
    expect(result.size).toBe(1);
    expect(result.get('security-audit')).toBe('CLAUDE_NOT_FOUND');
  });

  it('returns empty map on I/O error (graceful degradation)', async () => {
    const result = await getRecentTaskFailures('/nonexistent/path', ['security-audit']);
    expect(result.size).toBe(0);
  });

  it('applies last-seen error to a name when two tasks share the same name (name-collision behaviour)', async () => {
    // Two historical tasks can share the same name; getRecentTaskFailures is keyed by name,
    // so the most-recent (last-scanned-backward = first in file order) failure wins.
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    // Older failure first, then a newer failure for the same name
    const lines = [
      auditLine('shared-name', 'task.failed', 'OLDER_ERROR'),
      auditLine('shared-name', 'task.failed', 'NEWER_ERROR'),
    ];
    await writeFile(join(logsDir, `audit-${today}.jsonl`), lines.join('\n') + '\n');

    const result = await getRecentTaskFailures(logsDir, ['shared-name'], now);
    // Scans backward: NEWER_ERROR is at end of file → found first → wins
    expect(result.size).toBe(1);
    expect(result.get('shared-name')).toBe('NEWER_ERROR');
  });
});
