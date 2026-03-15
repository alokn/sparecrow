/** E2E tests for queue commands (suite 07). */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runCli, seedConfig, seedQueue } from '../helpers/index.js';
import type { PersistedTask } from '../helpers/index.js';

function baseEnv(homeDir: string): Record<string, string> {
  return {
    HOME: homeDir,
    XDG_CONFIG_HOME: join(homeDir, '.config'),
    XDG_STATE_HOME: join(homeDir, '.local', 'state'),
  };
}

/** Build a minimal PersistedTask for seeding the queue. */
function makeTask(name: string, targetPath: string, priority: number): PersistedTask {
  return {
    id: randomUUID(),
    name,
    type: 'template',
    templateName: name,
    prompt: '',
    status: 'pending',
    targetPath,
    priority,
    createdAt: '2026-01-01T00:00:00.000Z',
    timeoutMs: 60000,
    actions: [],
  };
}

describe('queue commands (suite 07)', () => {
  let homeDir: string;
  let repoPath: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'sparecrow-queue-'));
    await seedConfig(homeDir);
    repoPath = join(homeDir, 'repo');
    // [AI-Review][Low] pass encoding:'utf8' so stderr is a string, not a Buffer
    const gitInit = spawnSync('git', ['init', repoPath], { encoding: 'utf8' });
    if (gitInit.status !== 0) {
      throw new Error(`git init failed: ${gitInit.stderr ?? '(no output)'}`);
    }
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  // Task 3 (AC: 1)
  it('queue list exits 0 with empty message when queue is empty', () => {
    const result = runCli(['queue', 'list'], baseEnv(homeDir));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Queue is empty');
  });

  // Task 4 (AC: 2)
  it('queue add --template improve-code adds task and shows position', () => {
    const result = runCli(
      ['queue', 'add', '--template', 'improve-code', '--target', repoPath],
      baseEnv(homeDir),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Added: improve-code');
    expect(result.stdout).toContain('Queue position: #1');
  });

  // Task 5 (AC: 3)
  it('queue add --template nonexistent exits 1 with template-not-found error', () => {
    const result = runCli(
      ['queue', 'add', '--template', 'nonexistent', '--target', repoPath],
      baseEnv(homeDir),
    );

    expect(result.exitCode).toBe(1);
    // [AI-Review][Medium] assert error-identifying substring, not just the literal template name
    expect(result.stderr).toContain('nonexistent');
    expect(result.stderr.toLowerCase()).toMatch(/not found|template/);
  });

  // Task 6 (AC: 4)
  it('queue add --target /not/a/repo exits 1 with target-invalid error', () => {
    const result = runCli(
      ['queue', 'add', '--template', 'improve-code', '--target', '/not/a/git/repo'],
      baseEnv(homeDir),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Path does not exist');
  });

  // Task 7 (AC: 5)
  it('queue add without --template or --prompt exits 1 with mode error', () => {
    const result = runCli(['queue', 'add', '--target', repoPath], baseEnv(homeDir));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('exactly one of --template or --prompt');
  });

  // Task 8 (AC: 6)
  it('queue add with both --template and --prompt exits 1 with mode error', () => {
    const result = runCli(
      ['queue', 'add', '--template', 'improve-code', '--prompt', 'text', '--target', repoPath],
      baseEnv(homeDir),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('exactly one of --template or --prompt');
  });

  // Task 9 (AC: 7)
  it('queue add --prompt adds custom task with auto-name and hint', () => {
    const result = runCli(
      ['queue', 'add', '--prompt', 'review my code', '--target', repoPath],
      baseEnv(homeDir),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Added: custom-1');
    expect(result.stdout).toContain('Hint:');
  });

  // Task 10 (AC: 8)
  // [AI-Review][High] use seedQueue to pre-populate state instead of chaining runCli adds
  // [AI-Review][High/Low] add per-test timeout to accommodate multi-runCli calls
  it(
    'queue list shows all tasks with positions after multiple adds',
    { timeout: 60000 },
    async () => {
      await seedQueue(homeDir, [
        makeTask('improve-code', repoPath, 1),
        makeTask('improve-code', repoPath, 2),
        makeTask('custom-1', repoPath, 3),
      ]);

      const result = runCli(['queue', 'list'], baseEnv(homeDir));

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('improve-code');
      expect(result.stdout).toContain('custom-1');
      // [AI-Review][Medium] remove ambiguous digit-only assertions; verify task count via repoPath occurrences
      expect(result.stdout.split(repoPath).length - 1).toBeGreaterThanOrEqual(3);
    },
  );

  // Task 11 (AC: 9)
  // [AI-Review][High] use seedQueue to pre-populate state
  it('queue reorder move 2 1 moves task to position 1', { timeout: 60000 }, async () => {
    await seedQueue(homeDir, [
      makeTask('improve-code', repoPath, 1),
      makeTask('custom-1', repoPath, 2),
    ]);

    const result = runCli(['queue', 'reorder', 'move', '2', '1'], baseEnv(homeDir));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Moved task from position 2 to position 1');
  });

  // Task 12 (AC: 10)
  // [AI-Review][High] use seedQueue to pre-populate state
  it(
    'queue remove 1 --yes exits 0 and removes task, list becomes empty',
    { timeout: 60000 },
    async () => {
      await seedQueue(homeDir, [makeTask('improve-code', repoPath, 1)]);

      const removeResult = runCli(['queue', 'remove', '1', '--yes'], baseEnv(homeDir));

      expect(removeResult.exitCode).toBe(0);
      expect(removeResult.stdout).toContain('Removed task at position 1');

      const listResult = runCli(['queue', 'list'], baseEnv(homeDir));

      expect(listResult.exitCode).toBe(0);
      expect(listResult.stdout).toContain('Queue is empty');
    },
  );

  // Task 13 (AC: 11)
  it('queue remove without --yes exits 1 with QUEUE_CONFIRMATION_REQUIRED', async () => {
    await seedQueue(homeDir, [makeTask('improve-code', repoPath, 1)]);

    const result = runCli(['queue', 'remove', '1'], baseEnv(homeDir));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--yes');
  });

  // Task 14 (AC: 12)
  // [AI-Review][High] use seedQueue to pre-populate state
  it('queue clear --yes exits 0 with count of cleared tasks', { timeout: 60000 }, async () => {
    await seedQueue(homeDir, [
      makeTask('improve-code', repoPath, 1),
      makeTask('improve-code', repoPath, 2),
      makeTask('improve-code', repoPath, 3),
    ]);

    const result = runCli(['queue', 'clear', '--yes'], baseEnv(homeDir));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Cleared 3 task(s) from the queue');
  });

  // Task 15 (AC: 13) — split into focused tests
  // [AI-Review][Medium] split pause/resume idempotent test into two focused tests

  it('queue pause sets paused state and queue pause again reports already paused', () => {
    const pause1 = runCli(['queue', 'pause'], baseEnv(homeDir));
    expect(pause1.exitCode).toBe(0);
    expect(pause1.stdout).toContain('Queue paused');

    const pause2 = runCli(['queue', 'pause'], baseEnv(homeDir));
    expect(pause2.exitCode).toBe(0);
    expect(pause2.stdout).toContain('Queue already paused');
  });

  it('queue resume clears paused state and queue resume again reports already resumed', () => {
    // First pause so we can resume
    runCli(['queue', 'pause'], baseEnv(homeDir));

    const resume1 = runCli(['queue', 'resume'], baseEnv(homeDir));
    expect(resume1.exitCode).toBe(0);
    expect(resume1.stdout).toContain('Queue resumed');

    const resume2 = runCli(['queue', 'resume'], baseEnv(homeDir));
    expect(resume2.exitCode).toBe(0);
    expect(resume2.stdout).toContain('Queue already resumed');
  });

  // Task 16 (AC: 14)
  it(
    'queue remove with out-of-range position exits 1 with invalid position error',
    { timeout: 60000 },
    async () => {
      await seedQueue(homeDir, [makeTask('improve-code', repoPath, 1)]);

      const result = runCli(['queue', 'remove', '5', '--yes'], baseEnv(homeDir));

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Invalid queue position');
    },
  );

  // Task 17 (AC: 15)
  it('queue clear without --yes exits 1 with QUEUE_CONFIRMATION_REQUIRED', async () => {
    await seedQueue(homeDir, [makeTask('improve-code', repoPath, 1)]);

    const result = runCli(['queue', 'clear'], baseEnv(homeDir));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--yes');
  });

  // Task 18 (AC: 16)
  it('queue add --json exits 0 with { ok: true, data: { task, position } }', () => {
    const result = runCli(
      ['--json', 'queue', 'add', '--template', 'improve-code', '--target', repoPath],
      baseEnv(homeDir),
    );

    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout.trim());

    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeNull();
    // [AI-Review][High] assert data is not null before accessing nested fields
    expect(parsed.data).not.toBeNull();
    expect(parsed.data.position).toBe(1);
    expect(parsed.data.task.name).toBe('improve-code');
  });

  // Task 19 (AC: 17)
  it('queue add --dry-run shows preview and does not modify queue', () => {
    const result = runCli(
      ['queue', 'add', '--template', 'improve-code', '--target', repoPath, '--dry-run'],
      baseEnv(homeDir),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('[dry-run]');
    expect(result.stdout).toContain('improve-code');

    const listResult = runCli(['queue', 'list'], baseEnv(homeDir));

    expect(listResult.exitCode).toBe(0);
    expect(listResult.stdout).toContain('Queue is empty');
  });

  // Story 13.3 AC3/AC4 — backward-compatible alias resolution at CLI binary level
  it('queue add --template bug-hunter resolves via alias and adds task (backward compat)', () => {
    const result = runCli(
      ['queue', 'add', '--template', 'bug-hunter', '--target', repoPath],
      baseEnv(homeDir),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('fix-bugs');
  });

  it('queue add --template code-review resolves via alias and adds task (backward compat)', () => {
    const result = runCli(
      ['queue', 'add', '--template', 'code-review', '--target', repoPath],
      baseEnv(homeDir),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('improve-code');
  });

  it('queue add --template test-generation resolves via alias and adds task (backward compat)', () => {
    const result = runCli(
      ['queue', 'add', '--template', 'test-generation', '--target', repoPath],
      baseEnv(homeDir),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('write-tests');
  });

  it('queue add --template security-review resolves via alias and adds task (backward compat)', () => {
    const result = runCli(
      ['queue', 'add', '--template', 'security-review', '--target', repoPath],
      baseEnv(homeDir),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('security-audit');
  });

  // Story 20.1 AC1 — empty history returns hint
  it('queue history exits 0 with "No history." when no tasks have completed', () => {
    const result = runCli(['queue', 'history'], baseEnv(homeDir));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No history.');
  });

  // Story 20.1 AC5 — E2E round-trip: queue history shows completed/failed tasks
  it(
    'queue history shows done and failed tasks after seeding queue with historical statuses',
    { timeout: 60000 },
    async () => {
      const doneTask: PersistedTask = {
        ...makeTask('completed-task', repoPath, 1),
        status: 'done',
      };
      const failedTask: PersistedTask = {
        ...makeTask('broken-task', repoPath, 2),
        status: 'failed',
      };
      const skippedTask: PersistedTask = {
        ...makeTask('skipped-task', repoPath, 3),
        status: 'skipped',
      };
      // Seed excluded-status tasks to verify AC3 exclusion for all non-historical statuses
      const pendingTask = makeTask('pending-task', repoPath, 4);
      const inProgressTask: PersistedTask = {
        ...makeTask('in-progress-task', repoPath, 5),
        status: 'in-progress',
      };
      const failedQuotaTask: PersistedTask = {
        ...makeTask('failed-quota-task', repoPath, 6),
        status: 'failed_quota',
      };

      await seedQueue(homeDir, [
        doneTask,
        failedTask,
        skippedTask,
        pendingTask,
        inProgressTask,
        failedQuotaTask,
      ]);

      const result = runCli(['queue', 'history'], baseEnv(homeDir));

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('HISTORY');
      expect(result.stdout).toContain('completed-task');
      expect(result.stdout).toContain('broken-task');
      expect(result.stdout).toContain('skipped-task');
      // AC3: live-status tasks must not appear in history
      expect(result.stdout).not.toContain('pending-task');
      expect(result.stdout).not.toContain('in-progress-task');
      expect(result.stdout).not.toContain('failed-quota-task');
    },
  );

  // Story 20.1 AC4 — JSON mode returns valid envelope with most-recent-first ordering
  it(
    'queue history --json returns valid envelope with historical tasks sorted most-recent-first',
    { timeout: 60000 },
    async () => {
      // Use distinct createdAt timestamps so sort order is deterministic
      const doneTask: PersistedTask = {
        ...makeTask('json-done-task', repoPath, 1),
        status: 'done',
        createdAt: '2026-01-01T10:00:00.000Z',
      };
      const failedTask: PersistedTask = {
        ...makeTask('json-failed-task', repoPath, 2),
        status: 'failed',
        createdAt: '2026-01-01T11:00:00.000Z', // more recent → appears first
      };

      await seedQueue(homeDir, [doneTask, failedTask]);

      const result = runCli(['--json', 'queue', 'history'], baseEnv(homeDir));

      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.ok).toBe(true);
      expect(parsed.error).toBeNull();
      expect(parsed.data).not.toBeNull();
      expect(parsed.data.tasks).toHaveLength(2);

      const names = parsed.data.tasks.map((t: { name: string }) => t.name);
      expect(names).toContain('json-done-task');
      expect(names).toContain('json-failed-task');

      // Assert most-recent-first ordering (json-failed-task has later createdAt)
      expect(names[0]).toBe('json-failed-task');
      expect(names[1]).toBe('json-done-task');

      // Each task must have lastFailure field present (even if null)
      for (const task of parsed.data.tasks) {
        expect(task).toHaveProperty('lastFailure');
      }
    },
  );
});
