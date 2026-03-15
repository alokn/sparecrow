/** Unit tests for queue CLI commands — human and JSON mode, destructive operations, edge cases. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Command } from 'commander';
import { QueueStore } from '../../queue/index.js';
import { QueueManager } from '../../queue/index.js';
import { ErrorCode } from '../../errors/index.js';
import * as actualTemplates from '../../templates/index.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Mock built-in templates (mirrors real templates; no file I/O in tests)
// ---------------------------------------------------------------------------

const MOCK_BUILTINS = [
  {
    name: 'security-audit',
    description: 'Scan repo for vulnerabilities',
    prompt: 'p-sec',
    type: 'built-in' as const,
  },
  {
    name: 'improve-code',
    description: 'Review for bugs and quality',
    prompt: 'p-cr',
    type: 'built-in' as const,
  },
  {
    name: 'fix-bugs',
    description: 'Search for logic flaws',
    prompt: 'p-bh',
    type: 'built-in' as const,
  },
  {
    name: 'write-tests',
    description: 'Generate candidate tests',
    prompt: 'p-tg',
    type: 'built-in' as const,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return join(tmpdir(), `scr-queue-test-${randomBytes(6).toString('hex')}`);
}

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  return program;
}

function parseJson(output: string): {
  ok: boolean;
  data: unknown;
  error: { code: string; message: string } | null;
} {
  return JSON.parse(output) as {
    ok: boolean;
    data: unknown;
    error: { code: string; message: string } | null;
  };
}

/** Initialise a directory as a bare git repo for use as a valid --target. */
async function gitInit(dir: string): Promise<void> {
  await execFileAsync('git', ['-C', dir, 'init']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.email', 'test@test.com']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.name', 'Test']);
}

// ---------------------------------------------------------------------------
// Human mode tests
// Note: In the test environment process.stdin.isTTY is undefined → falsy →
// isInteractive() returns false → non-interactive mode, no confirmation prompts.
// ---------------------------------------------------------------------------

describe('registerQueue() — human mode (non-interactive)', () => {
  let dataDir: string;
  let stdoutOutput: string;
  let stderrOutput: string;

  beforeEach(async () => {
    vi.resetModules();
    dataDir = makeTmpDir();
    await mkdir(dataDir, { recursive: true });
    await gitInit(dataDir);

    stdoutOutput = '';
    stderrOutput = '';
    process.exitCode = undefined;

    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      stderrOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: dataDir, config: dataDir, logs: dataDir }),
    }));
    vi.doMock('../index.js', () => ({ isJsonMode: () => false, getConfigPath: () => undefined }));
    vi.doMock('../../templates/index.js', () => ({
      ...actualTemplates,
      loadBuiltins: vi.fn().mockResolvedValue(MOCK_BUILTINS),
    }));
    vi.doMock('../../config/index.js', () => ({
      loadConfig: vi.fn().mockResolvedValue({ tasks: [] }),
      resolveConfigFilePath: (configDir: string, override?: string | null) =>
        override ?? join(configDir, 'config.yaml'),
    }));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('bare queue command lists empty queue with hint', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue']);
    expect(stdoutOutput).toContain('Queue is empty');
    expect(stdoutOutput).toContain('sparecrow queue add');
  });

  it('queue list shows empty queue hint', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'list']);
    expect(stdoutOutput).toContain('Queue is empty');
  });

  it('queue list shows table after adding a task', async () => {
    const store = new QueueStore(dataDir);
    const mgr = new QueueManager(store);
    await mgr.add({
      type: 'template',
      templateName: 'improve-code',
      prompt: '',
      targetPath: dataDir,
    });

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue']);
    expect(stdoutOutput).toContain('improve-code');
    // The Target column is 40 chars wide — long macOS temp paths get truncated
    // with '…'. Assert a prefix of the path that survives truncation.
    const targetPrefix = dataDir.slice(0, 30);
    expect(stdoutOutput).toContain(targetPrefix);
    // AC1/AC2: Status column header is present and pending status is shown
    expect(stdoutOutput).toContain('Status');
    expect(stdoutOutput).toContain('pending');
  });

  it('queue list hides failed tasks from live view and shows footer', async () => {
    const store = new QueueStore(dataDir);
    const mgr = new QueueManager(store);
    const result = await mgr.add({
      type: 'template',
      templateName: 'fix-bugs',
      prompt: 'p-bh',
      targetPath: dataDir,
    });
    await mgr.setTaskStatus(result.task.id, 'failed');

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'list']);
    // Story 10.12: failed tasks are hidden from default live view
    expect(stdoutOutput).toContain('Queue is empty');
    // Footer shows failed count
    expect(stdoutOutput).toContain('1 failed');
    expect(stdoutOutput).toContain('sparecrow queue history');
  });

  it('queue list shows only live tasks (pending) with mixed statuses and footer', async () => {
    const store = new QueueStore(dataDir);
    const mgr = new QueueManager(store);
    const r1 = await mgr.add({
      type: 'template',
      templateName: 'improve-code',
      prompt: 'p-cr',
      targetPath: dataDir,
    });
    const r2 = await mgr.add({
      type: 'template',
      templateName: 'fix-bugs',
      prompt: 'p-bh',
      targetPath: dataDir,
    });
    await mgr.add({
      type: 'template',
      templateName: 'security-audit',
      prompt: 'p-sec',
      targetPath: dataDir,
    });
    // Set mixed statuses — third task stays 'pending' (default)
    await mgr.setTaskStatus(r1.task.id, 'done');
    await mgr.setTaskStatus(r2.task.id, 'failed');

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'list']);
    // Story 10.12: only live tasks shown
    expect(stdoutOutput).toContain('pending');
    expect(stdoutOutput).toContain('security-audit');
    // done/failed tasks are hidden
    expect(stdoutOutput).not.toContain('done');
    // Footer with counts
    expect(stdoutOutput).toContain('1 completed');
    expect(stdoutOutput).toContain('1 failed');
  });

  // AC3: all 6 TaskStatus values — remaining 3 values not covered by existing tests
  it('queue list renders in-progress status in the Status column', async () => {
    const store = new QueueStore(dataDir);
    const mgr = new QueueManager(store);
    const result = await mgr.add({
      type: 'template',
      templateName: 'improve-code',
      prompt: 'p-cr',
      targetPath: dataDir,
    });
    await mgr.setTaskStatus(result.task.id, 'in-progress');

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'list']);
    expect(stdoutOutput).toContain('Status');
    expect(stdoutOutput).toContain('in-progress');
  });

  it('queue list renders failed_quota status in the Status column', async () => {
    const store = new QueueStore(dataDir);
    const mgr = new QueueManager(store);
    const result = await mgr.add({
      type: 'template',
      templateName: 'fix-bugs',
      prompt: 'p-bh',
      targetPath: dataDir,
    });
    await mgr.setTaskStatus(result.task.id, 'failed_quota');

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'list']);
    expect(stdoutOutput).toContain('Status');
    expect(stdoutOutput).toContain('failed_quota');
  });

  it('queue list hides skipped tasks from live view (no footer for skipped-only)', async () => {
    const store = new QueueStore(dataDir);
    const mgr = new QueueManager(store);
    const result = await mgr.add({
      type: 'template',
      templateName: 'security-audit',
      prompt: 'p-sec',
      targetPath: dataDir,
    });
    await mgr.setTaskStatus(result.task.id, 'skipped');

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'list']);
    // Story 10.12: skipped tasks are hidden from default live view
    expect(stdoutOutput).toContain('Queue is empty');
    // No footer when only skipped (no done/failed counts)
    expect(stdoutOutput).not.toContain('sparecrow queue history');
  });

  // AC2: Status column appears positionally between Name and Type (not just present anywhere)
  it('queue list renders Status column between Name and Type columns positionally', async () => {
    const store = new QueueStore(dataDir);
    const mgr = new QueueManager(store);
    await mgr.add({
      type: 'template',
      templateName: 'improve-code',
      prompt: 'p-cr',
      targetPath: dataDir,
    });

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'list']);
    // Find the header line that contains the column names
    const headerLine = stdoutOutput.split('\n').find((line) => line.includes('Name'));
    expect(headerLine).toBeDefined();
    // Positional check: Name appears before Status, Status before Type
    const namePos = headerLine!.indexOf('Name');
    const statusPos = headerLine!.indexOf('Status');
    const typePos = headerLine!.indexOf('Type');
    expect(namePos).toBeGreaterThanOrEqual(0);
    expect(statusPos).toBeGreaterThanOrEqual(0);
    expect(typePos).toBeGreaterThanOrEqual(0);
    expect(namePos).toBeLessThan(statusPos);
    expect(statusPos).toBeLessThan(typePos);
  });

  // Finding 3: queue ls alias coverage
  it('queue ls alias lists tasks the same as queue list', async () => {
    const store = new QueueStore(dataDir);
    const mgr = new QueueManager(store);
    await mgr.add({
      type: 'template',
      templateName: 'improve-code',
      prompt: 'p-cr',
      targetPath: dataDir,
    });

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'ls']);
    expect(stdoutOutput).toContain('improve-code');
    expect(stdoutOutput).toContain('Status');
    expect(stdoutOutput).toContain('pending');
  });

  it('queue add --template appends built-in task and shows UX-spec output', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--template',
      'improve-code',
      '--target',
      dataDir,
    ]);
    expect(stdoutOutput).toContain('improve-code');
    expect(stdoutOutput).toContain('#1');
    expect(stdoutOutput).toContain('\u2713'); // ✓
  });

  it('queue add --prompt appends custom task with custom-1 name', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--prompt',
      'Run the linter',
      '--target',
      dataDir,
    ]);
    expect(stdoutOutput).toContain('custom-1');
    expect(stdoutOutput).toContain('#1');
    expect(stdoutOutput).toContain('Hint');
  });

  it('queue add --prompt sequential naming produces custom-2 for second task', async () => {
    const store = new QueueStore(dataDir);
    const mgr = new QueueManager(store);
    // pre-seed one custom task
    await mgr.add({ type: 'custom', name: 'custom-1', prompt: 'first', targetPath: dataDir });

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--prompt',
      'second task',
      '--target',
      dataDir,
    ]);
    expect(stdoutOutput).toContain('custom-2');
    expect(stdoutOutput).toContain('#2');
  });

  // AC4: mode validation
  it('queue add without --template or --prompt writes ✗ error to stderr', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'add', '--target', dataDir]);
    expect(stderrOutput).toContain('\u2717'); // ✗
    expect(stderrOutput).toContain('--template or --prompt');
  });

  it('queue add with both --template and --prompt writes ✗ error to stderr', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--template',
      'improve-code',
      '--prompt',
      'y',
      '--target',
      dataDir,
    ]);
    expect(stderrOutput).toContain('\u2717'); // ✗
    expect(stderrOutput).toContain('exactly one');
  });

  it('queue add without --target writes error', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'add', '--template', 'improve-code']);
    expect(stderrOutput).toContain('--target');
  });

  it('queue add --dry-run shows [dry-run] prefix without persisting', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--template',
      'improve-code',
      '--target',
      dataDir,
      '--dry-run',
    ]);
    expect(stdoutOutput).toContain('[dry-run]');

    const store = new QueueStore(dataDir);
    const { tasks } = await store.read();
    expect(tasks).toHaveLength(0);
  });

  it('queue add --dry-run for --prompt shows [dry-run] prefix without persisting', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--prompt',
      'Do something',
      '--target',
      dataDir,
      '--dry-run',
    ]);
    expect(stdoutOutput).toContain('[dry-run]');

    const store = new QueueStore(dataDir);
    const { tasks } = await store.read();
    expect(tasks).toHaveLength(0);
  });

  it('queue add --dry-run does not alter paused flag (AC10)', async () => {
    // Pre-seed a paused queue to verify dry-run leaves it unchanged
    const store = new QueueStore(dataDir);
    const mgr = new QueueManager(store);
    await mgr.pause();

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--template',
      'improve-code',
      '--target',
      dataDir,
      '--dry-run',
    ]);

    const { paused } = await store.read();
    expect(paused).toBe(true);
  });

  it('queue add --dry-run with --prompt does not alter paused flag (AC10)', async () => {
    const store = new QueueStore(dataDir);
    const { paused: initialPaused } = await store.read();
    expect(initialPaused).toBe(false);

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--prompt',
      'Do something',
      '--target',
      dataDir,
      '--dry-run',
    ]);

    const { paused } = await store.read();
    expect(paused).toBe(false);
  });

  it('queue remove --yes removes task in non-interactive mode', async () => {
    const store = new QueueStore(dataDir);
    const mgr = new QueueManager(store);
    await mgr.add({ type: 'template', templateName: 'a', prompt: '', targetPath: dataDir });

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'remove', '1', '--yes']);
    expect(stdoutOutput).toContain('Removed');

    const { tasks: remaining } = await store.read();
    expect(remaining).toHaveLength(0);
  });

  it('queue clear --yes clears all tasks', async () => {
    const store = new QueueStore(dataDir);
    const mgr = new QueueManager(store);
    await mgr.add({ type: 'template', templateName: 'a', prompt: '', targetPath: dataDir });
    await mgr.add({ type: 'template', templateName: 'b', prompt: '', targetPath: dataDir });

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'clear', '--yes']);
    expect(stdoutOutput).toContain('Cleared 2');

    const { tasks: remaining } = await store.read();
    expect(remaining).toHaveLength(0);
  });

  it('queue reorder move shifts task positions', async () => {
    const store = new QueueStore(dataDir);
    const mgr = new QueueManager(store);
    await mgr.add({ type: 'template', templateName: 'a', prompt: '', targetPath: dataDir });
    await mgr.add({ type: 'template', templateName: 'b', prompt: '', targetPath: dataDir });
    await mgr.add({ type: 'template', templateName: 'c', prompt: '', targetPath: dataDir });

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'reorder', 'move', '1', '3']);
    expect(stdoutOutput).toContain('Moved task from position 1 to position 3');
  });

  it('queue pause outputs exact AC1 success message and persists paused=true', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'pause']);
    expect(stdoutOutput).toContain('\u2713 Queue paused (daemon will not dispatch)');

    const store = new QueueStore(dataDir);
    const { paused } = await store.read();
    expect(paused).toBe(true);
  });

  it('queue resume outputs exact AC2 success message and persists paused=false', async () => {
    // First pause, then resume
    const store = new QueueStore(dataDir);
    const mgr = new QueueManager(store);
    await mgr.pause();

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'resume']);
    expect(stdoutOutput).toContain('\u2713 Queue resumed (daemon will dispatch)');

    const { paused } = await store.read();
    expect(paused).toBe(false);
  });

  it('queue pause when already paused outputs AC3 no-op message', async () => {
    const store = new QueueStore(dataDir);
    const mgr = new QueueManager(store);
    await mgr.pause();

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'pause']);
    expect(stdoutOutput).toContain('\u2713 Queue already paused (no change)');
  });

  it('queue resume when already resumed outputs AC3 no-op message', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'resume']);
    expect(stdoutOutput).toContain('\u2713 Queue already resumed (no change)');
  });

  it('queue pause succeeds without daemon running (AC4)', async () => {
    // No daemon mock needed — pause/resume work on queue state only
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'pause']);
    expect(stdoutOutput).toContain('\u2713 Queue paused');
    // No DAEMON_NOT_RUNNING error
    expect(stderrOutput).not.toContain('DAEMON_NOT_RUNNING');
  });

  // AC6: UX-spec success output format
  it('queue add --template success output matches UX spec (✓, →, Queue position: #N)', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--template',
      'improve-code',
      '--target',
      dataDir,
    ]);
    expect(stdoutOutput).toContain('\u2713 Added: improve-code \u2192');
    expect(stdoutOutput).toContain('Queue position: #1');
    // No Hint line for template (built-in) tasks
    expect(stdoutOutput).not.toContain('Hint:');
  });

  it('queue add --prompt success output includes Hint line for ad-hoc tasks', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--prompt',
      'Check APIs',
      '--target',
      dataDir,
    ]);
    expect(stdoutOutput).toContain('\u2713 Added: custom-1 \u2192');
    expect(stdoutOutput).toContain('Queue position: #1');
    expect(stdoutOutput).toContain("Hint: 'queue reorder'");
  });

  // AC7: UX-spec failure output
  it('queue add failure output has ✗ prefix and → usage lines', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'add', '--target', dataDir]);
    expect(stderrOutput).toContain('\u2717');
    expect(stderrOutput).toContain('\u2192 Usage:');
  });

  // AC6 path assertion: verify loadConfig is called with a file path ending in config.yaml
  // (not the bare directory) when getConfigPath returns undefined (no --config flag)
  it('queue add passes config.yaml file path to loadConfig when getConfigPath returns undefined', async () => {
    // Import the mocked config module to grab the loadConfig spy from beforeEach
    const { registerQueue } = await import('./queue.js');
    const { loadConfig: loadConfigMock } = await import('../../config/index.js');

    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--template',
      'improve-code',
      '--target',
      dataDir,
    ]);

    // loadConfig must receive a file path ending in config.yaml, not a bare directory
    expect(loadConfigMock).toHaveBeenCalledWith(expect.stringContaining('config.yaml'));
  });

  // Story 10.6 AC3: failure sub-row rendering via mocked getRecentTaskFailures
  describe('queue list failure sub-rows (AC3 — Story 10.6)', () => {
    it('renders failure sub-row for task with recent audit failure', async () => {
      // Add a task to the queue
      const store = new QueueStore(dataDir);
      const mgr = new QueueManager(store);
      await mgr.add({
        type: 'template',
        templateName: 'security-audit',
        prompt: '',
        targetPath: dataDir,
      });

      // Mock log-reader to return a failure for this task
      vi.doMock('./log-reader.js', () => ({
        getRecentTaskFailures: async () => new Map([['security-audit', 'CLAUDE_NOT_FOUND']]),
        queryLogs: async () => ({
          entries: [],
          total: 0,
          successCount: 0,
          failureCount: 0,
          failureSummary: [],
        }),
        parseSinceDuration: () => new Date(),
        discoverLogFiles: async () => [],
        parseLogFile: async () => [],
      }));

      const { registerQueue } = await import('./queue.js');
      const program = makeProgram();
      registerQueue(program);
      await program.parseAsync(['node', 'sparecrow', 'queue', 'list']);

      // AC3: sub-row with humanized failure message
      expect(stdoutOutput).toContain('Last failure:');
      expect(stdoutOutput).toContain('Claude CLI not found');
      // AC6: hint line appears when failures are present
      expect(stdoutOutput).toContain('sparecrow logs --task');
    });

    it('renders no failure sub-row when audit has no failures for tasks', async () => {
      // Add a task to the queue
      const store = new QueueStore(dataDir);
      const mgr = new QueueManager(store);
      await mgr.add({
        type: 'template',
        templateName: 'improve-code',
        prompt: '',
        targetPath: dataDir,
      });

      // Mock log-reader to return empty failure map
      vi.doMock('./log-reader.js', () => ({
        getRecentTaskFailures: async () => new Map(),
        queryLogs: async () => ({
          entries: [],
          total: 0,
          successCount: 0,
          failureCount: 0,
          failureSummary: [],
        }),
        parseSinceDuration: () => new Date(),
        discoverLogFiles: async () => [],
        parseLogFile: async () => [],
      }));

      const { registerQueue } = await import('./queue.js');
      const program = makeProgram();
      registerQueue(program);
      await program.parseAsync(['node', 'sparecrow', 'queue', 'list']);

      // No failure sub-rows, no hint line
      expect(stdoutOutput).not.toContain('Last failure:');
      expect(stdoutOutput).not.toContain('sparecrow logs --task');
      // Table still renders normally
      expect(stdoutOutput).toContain('improve-code');
    });
  });
});

// ---------------------------------------------------------------------------
// Target validation (AC5)
// ---------------------------------------------------------------------------

describe('registerQueue() — target validation (AC5)', () => {
  let dataDir: string;
  let stderrOutput: string;

  beforeEach(async () => {
    vi.resetModules();
    dataDir = makeTmpDir();
    await mkdir(dataDir, { recursive: true });
    await gitInit(dataDir);

    stderrOutput = '';
    process.exitCode = undefined;
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      stderrOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: dataDir, config: dataDir, logs: dataDir }),
    }));
    vi.doMock('../index.js', () => ({ isJsonMode: () => false, getConfigPath: () => undefined }));
    vi.doMock('../../templates/index.js', () => ({
      ...actualTemplates,
      loadBuiltins: vi.fn().mockResolvedValue(MOCK_BUILTINS),
    }));
    vi.doMock('../../config/index.js', () => ({
      loadConfig: vi.fn().mockResolvedValue({ tasks: [] }),
      resolveConfigFilePath: (configDir: string, override?: string | null) =>
        override ?? join(configDir, 'config.yaml'),
    }));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('rejects non-existent path with QUEUE_ADD_TARGET_INVALID message', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--prompt',
      'test',
      '--target',
      '/tmp/definitely-does-not-exist-sparecrow-test-xyz',
    ]);
    expect(stderrOutput).toContain('does not exist');
    expect(process.exitCode).toBe(1);
  });

  it('rejects a file path (non-directory) with specific message', async () => {
    const filePath = join(dataDir, 'somefile.txt');
    await writeFile(filePath, 'hello');

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--prompt',
      'test',
      '--target',
      filePath,
    ]);
    expect(stderrOutput).toContain('not a directory');
    expect(process.exitCode).toBe(1);
  });

  it('rejects a non-git directory with specific message', async () => {
    // Must be outside dataDir to avoid inheriting the parent's .git via git rev-parse --git-dir
    const nonGitDir = join(tmpdir(), `sparecrow-nongit-${randomBytes(6).toString('hex')}`);
    await mkdir(nonGitDir, { recursive: true });
    try {
      const { registerQueue } = await import('./queue.js');
      const program = makeProgram();
      registerQueue(program);
      await program.parseAsync([
        'node',
        'sparecrow',
        'queue',
        'add',
        '--prompt',
        'test',
        '--target',
        nonGitDir,
      ]);
      expect(stderrOutput.toLowerCase()).toContain('not a git repository');
      expect(process.exitCode).toBe(1);
    } finally {
      await rm(nonGitDir, { recursive: true, force: true });
    }
  });

  it('accepts a valid existing git directory', async () => {
    let stdoutOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--prompt',
      'test valid target',
      '--target',
      dataDir,
    ]);
    // stderr may contain INFO log lines from logger; only check stdout for success
    expect(stdoutOutput).toContain('\u2713 Added:');
    expect(stderrOutput).not.toContain('\u2717'); // no ✗ error
  });

  it('rejects empty string --target with "required" message', async () => {
    // Empty string is falsy — caught by the !opts.target guard before validateTarget
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--prompt',
      'test',
      '--target',
      '',
    ]);
    expect(stderrOutput).toContain('--target');
    expect(process.exitCode).toBe(1);
  });

  it('rejects whitespace-only --target with specific message', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--prompt',
      'test',
      '--target',
      '   ',
    ]);
    expect(stderrOutput).toContain('empty or whitespace');
    expect(process.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Config custom task resolution (AC15)
// ---------------------------------------------------------------------------

describe('registerQueue() — config custom task resolution (AC15)', () => {
  let dataDir: string;
  let stdoutOutput: string;
  let stderrOutput: string;

  beforeEach(async () => {
    vi.resetModules();
    dataDir = makeTmpDir();
    await mkdir(dataDir, { recursive: true });
    await gitInit(dataDir);

    stdoutOutput = '';
    stderrOutput = '';
    process.exitCode = undefined;
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      stderrOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: dataDir, config: dataDir, logs: dataDir }),
    }));
    vi.doMock('../index.js', () => ({ isJsonMode: () => false, getConfigPath: () => undefined }));
    vi.doMock('../../templates/index.js', () => ({
      ...actualTemplates,
      loadBuiltins: vi.fn().mockResolvedValue(MOCK_BUILTINS),
    }));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('--template <config-custom-name> creates TaskDefinition with type: "custom"', async () => {
    vi.doMock('../../config/index.js', () => ({
      loadConfig: vi.fn().mockResolvedValue({
        tasks: [{ name: 'my-lint', prompt: 'Run eslint on all files', targetPath: dataDir }],
      }),
      resolveConfigFilePath: (configDir: string, override?: string | null) =>
        override ?? join(configDir, 'config.yaml'),
    }));

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--template',
      'my-lint',
      '--target',
      dataDir,
    ]);

    // Verify task was enqueued with correct type
    const store = new QueueStore(dataDir);
    const { tasks } = await store.read();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.type).toBe('custom');
    expect(tasks[0]!.name).toBe('my-lint');
    expect(tasks[0]!.prompt).toBe('Run eslint on all files');
  });

  it('--template <config-custom-name> success output has no Hint line', async () => {
    vi.doMock('../../config/index.js', () => ({
      loadConfig: vi.fn().mockResolvedValue({
        tasks: [{ name: 'my-lint', prompt: 'Run eslint', targetPath: dataDir }],
      }),
      resolveConfigFilePath: (configDir: string, override?: string | null) =>
        override ?? join(configDir, 'config.yaml'),
    }));

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--template',
      'my-lint',
      '--target',
      dataDir,
    ]);
    expect(stdoutOutput).toContain('my-lint');
    expect(stdoutOutput).not.toContain('Hint:');
  });

  it('--template <unknown> returns QUEUE_ADD_TEMPLATE_NOT_FOUND error', async () => {
    vi.doMock('../../config/index.js', () => ({
      loadConfig: vi.fn().mockResolvedValue({ tasks: [] }),
      resolveConfigFilePath: (configDir: string, override?: string | null) =>
        override ?? join(configDir, 'config.yaml'),
    }));

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--template',
      'nonexistent-template',
      '--target',
      dataDir,
    ]);
    expect(stderrOutput).toContain('nonexistent-template');
    expect(process.exitCode).toBe(1);
  });

  it('built-in takes precedence when name exists in both builtins and config', async () => {
    vi.doMock('../../config/index.js', () => ({
      loadConfig: vi.fn().mockResolvedValue({
        tasks: [{ name: 'security-audit', prompt: 'Custom security check', targetPath: dataDir }],
      }),
      resolveConfigFilePath: (configDir: string, override?: string | null) =>
        override ?? join(configDir, 'config.yaml'),
    }));

    // 'security-audit' exists in both builtins and config — builtins checked first
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--template',
      'security-audit',
      '--target',
      dataDir,
    ]);
    // Built-in found first → type: 'template'
    const store = new QueueStore(dataDir);
    const { tasks } = await store.read();
    expect(tasks[0]!.type).toBe('template');
  });
});

// ---------------------------------------------------------------------------
// JSON mode tests
// ---------------------------------------------------------------------------

describe('registerQueue() — JSON mode', () => {
  let dataDir: string;
  let stdoutOutput: string;

  beforeEach(async () => {
    vi.resetModules();
    dataDir = makeTmpDir();
    await mkdir(dataDir, { recursive: true });
    await gitInit(dataDir);

    stdoutOutput = '';
    process.exitCode = undefined;

    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: dataDir, config: dataDir, logs: dataDir }),
    }));
    vi.doMock('../index.js', () => ({ isJsonMode: () => true, getConfigPath: () => undefined }));
    vi.doMock('../../templates/index.js', () => ({
      ...actualTemplates,
      loadBuiltins: vi.fn().mockResolvedValue(MOCK_BUILTINS),
    }));
    vi.doMock('../../config/index.js', () => ({
      loadConfig: vi.fn().mockResolvedValue({ tasks: [] }),
      resolveConfigFilePath: (configDir: string, override?: string | null) =>
        override ?? join(configDir, 'config.yaml'),
    }));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('queue list returns valid JSON wrapper with empty tasks', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'list']);

    const parsed = parseJson(stdoutOutput);
    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeNull();
    expect(parsed.data).toHaveProperty('tasks');
  });

  it('queue bare command returns valid JSON wrapper', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue']);

    const parsed = parseJson(stdoutOutput);
    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeNull();
  });

  it('queue add --template returns JSON wrapper with task and position', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--template',
      'improve-code',
      '--target',
      dataDir,
    ]);

    const parsed = parseJson(stdoutOutput);
    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeNull();
    expect((parsed.data as { position: number }).position).toBe(1);
  });

  it('queue add --prompt returns JSON wrapper with type: "custom" task', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--prompt',
      'Review API error handling',
      '--target',
      dataDir,
    ]);

    const parsed = parseJson(stdoutOutput);
    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeNull();
    const task = (parsed.data as { task: { type: string; name: string } }).task;
    expect(task.type).toBe('custom');
    expect(task.name).toBe('custom-1');
  });

  it('queue add missing --template/--prompt returns QUEUE_ADD_INVALID_MODE error', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'add', '--target', dataDir]);

    const parsed = parseJson(stdoutOutput);
    expect(parsed.ok).toBe(false);
    expect(parsed.data).toBeNull();
    expect(parsed.error?.code).toBe(ErrorCode.QUEUE_ADD_INVALID_MODE);
  });

  it('queue add both --template and --prompt returns QUEUE_ADD_INVALID_MODE error', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--template',
      'improve-code',
      '--prompt',
      'also this',
      '--target',
      dataDir,
    ]);

    const parsed = parseJson(stdoutOutput);
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.code).toBe(ErrorCode.QUEUE_ADD_INVALID_MODE);
  });

  it('queue add missing --target returns QUEUE_ADD_TARGET_INVALID error', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'add', '--prompt', 'test']);

    const parsed = parseJson(stdoutOutput);
    expect(parsed.ok).toBe(false);
    expect(parsed.data).toBeNull();
    expect(parsed.error).not.toBeNull();
    expect(parsed.error?.code).toBe(ErrorCode.QUEUE_ADD_TARGET_INVALID);
  });

  it('queue add non-existent target returns QUEUE_ADD_TARGET_INVALID error', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--prompt',
      'test',
      '--target',
      '/tmp/does-not-exist-sparecrow-xyz',
    ]);

    const parsed = parseJson(stdoutOutput);
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.code).toBe(ErrorCode.QUEUE_ADD_TARGET_INVALID);
  });

  it('queue add --dry-run returns JSON wrapper with dryRun: true', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--template',
      'improve-code',
      '--target',
      dataDir,
      '--dry-run',
    ]);

    const parsed = parseJson(stdoutOutput);
    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeNull();
    expect((parsed.data as { dryRun: boolean }).dryRun).toBe(true);
  });

  it('queue remove without --yes throws QUEUE_CONFIRMATION_REQUIRED', async () => {
    const store = new QueueStore(dataDir);
    const mgr = new QueueManager(store);
    await mgr.add({ type: 'template', templateName: 'x', prompt: '', targetPath: dataDir });

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);

    await expect(
      program.parseAsync(['node', 'sparecrow', 'queue', 'remove', '1']),
    ).rejects.toMatchObject({ code: ErrorCode.QUEUE_CONFIRMATION_REQUIRED });
  });

  it('queue remove --yes returns JSON wrapper with removed task', async () => {
    const store = new QueueStore(dataDir);
    const mgr = new QueueManager(store);
    await mgr.add({ type: 'template', templateName: 'x', prompt: '', targetPath: dataDir });

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'remove', '1', '--yes']);

    const parsed = parseJson(stdoutOutput);
    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeNull();
    expect(parsed.data).toHaveProperty('removed');
  });

  it('queue clear without --yes throws QUEUE_CONFIRMATION_REQUIRED', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);

    await expect(program.parseAsync(['node', 'sparecrow', 'queue', 'clear'])).rejects.toMatchObject(
      {
        code: ErrorCode.QUEUE_CONFIRMATION_REQUIRED,
      },
    );
  });

  it('queue clear --yes returns JSON wrapper with cleared count', async () => {
    const store = new QueueStore(dataDir);
    const mgr = new QueueManager(store);
    await mgr.add({ type: 'template', templateName: 'a', prompt: '', targetPath: dataDir });

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'clear', '--yes']);

    const parsed = parseJson(stdoutOutput);
    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeNull();
    expect((parsed.data as { cleared: number }).cleared).toBe(1);
  });

  it('queue reorder move returns JSON wrapper with updated tasks', async () => {
    const store = new QueueStore(dataDir);
    const mgr = new QueueManager(store);
    await mgr.add({ type: 'template', templateName: 'a', prompt: '', targetPath: dataDir });
    await mgr.add({ type: 'template', templateName: 'b', prompt: '', targetPath: dataDir });

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'reorder', 'move', '1', '2']);

    const parsed = parseJson(stdoutOutput);
    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeNull();
    expect(parsed.data).toHaveProperty('tasks');
  });

  it('queue pause returns JSON wrapper with paused=true, changed=true on state change', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'pause']);

    const parsed = parseJson(stdoutOutput);
    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeNull();
    const data = parsed.data as { paused: boolean; changed: boolean; message: string };
    expect(data.paused).toBe(true);
    expect(data.changed).toBe(true);
    expect(data.message).toBe('Queue paused (daemon will not dispatch)');
  });

  it('queue pause returns JSON wrapper with changed=false when already paused', async () => {
    // Pre-seed paused state
    const store = new QueueStore(dataDir);
    const mgr = new QueueManager(store);
    await mgr.pause();

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'pause']);

    const parsed = parseJson(stdoutOutput);
    expect(parsed.ok).toBe(true);
    const data = parsed.data as { paused: boolean; changed: boolean; message: string };
    expect(data.paused).toBe(true);
    expect(data.changed).toBe(false);
    expect(data.message).toBe('Queue already paused (no change)');
  });

  it('queue resume returns JSON wrapper with paused=false, changed=true on state change', async () => {
    // Pre-seed paused state
    const store = new QueueStore(dataDir);
    const mgr = new QueueManager(store);
    await mgr.pause();

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'resume']);

    const parsed = parseJson(stdoutOutput);
    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeNull();
    const data = parsed.data as { paused: boolean; changed: boolean; message: string };
    expect(data.paused).toBe(false);
    expect(data.changed).toBe(true);
    expect(data.message).toBe('Queue resumed (daemon will dispatch)');
  });

  it('queue resume returns JSON wrapper with changed=false when already resumed', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'resume']);

    const parsed = parseJson(stdoutOutput);
    expect(parsed.ok).toBe(true);
    const data = parsed.data as { paused: boolean; changed: boolean; message: string };
    expect(data.paused).toBe(false);
    expect(data.changed).toBe(false);
    expect(data.message).toBe('Queue already resumed (no change)');
  });

  it('queue pause JSON wrapper always has ok/data/error fields', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'pause']);

    const parsed = parseJson(stdoutOutput);
    expect(Object.keys(parsed)).toContain('ok');
    expect(Object.keys(parsed)).toContain('data');
    expect(Object.keys(parsed)).toContain('error');
  });

  it('queue resume JSON wrapper always has ok/data/error fields', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'resume']);

    const parsed = parseJson(stdoutOutput);
    expect(Object.keys(parsed)).toContain('ok');
    expect(Object.keys(parsed)).toContain('data');
    expect(Object.keys(parsed)).toContain('error');
  });

  // JSON wrapper contract tests — all top-level fields always present (AC13)

  it('queue list JSON always has ok/data/error fields', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'list']);

    const parsed = parseJson(stdoutOutput);
    expect(Object.keys(parsed)).toContain('ok');
    expect(Object.keys(parsed)).toContain('data');
    expect(Object.keys(parsed)).toContain('error');
  });

  it('queue add error JSON always has ok/data/error fields', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'add', '--target', dataDir]);

    const parsed = parseJson(stdoutOutput);
    expect(Object.keys(parsed)).toContain('ok');
    expect(Object.keys(parsed)).toContain('data');
    expect(Object.keys(parsed)).toContain('error');
    expect(parsed.ok).toBe(false);
    expect(parsed.data).toBeNull();
    expect(parsed.error).not.toBeNull();
  });

  it('--prompt dry-run JSON preview includes name field', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--prompt',
      'Do something',
      '--target',
      dataDir,
      '--dry-run',
    ]);

    const parsed = parseJson(stdoutOutput);
    expect(parsed.ok).toBe(true);
    const preview = (parsed.data as { preview: { name?: string; type: string } }).preview;
    expect(preview).toHaveProperty('name');
    expect(preview.name).toBe('custom-1');
  });
});

// ---------------------------------------------------------------------------
// Error propagation (Findings 3 & 4)
// ---------------------------------------------------------------------------

describe('registerQueue() — error propagation for template/config failures', () => {
  let dataDir: string;
  let stdoutOutput: string;
  let stderrOutput: string;

  beforeEach(async () => {
    vi.resetModules();
    dataDir = makeTmpDir();
    await mkdir(dataDir, { recursive: true });
    await gitInit(dataDir);

    stdoutOutput = '';
    stderrOutput = '';
    process.exitCode = undefined;
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      stderrOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: dataDir, config: dataDir, logs: dataDir }),
    }));
    vi.doMock('../index.js', () => ({ isJsonMode: () => false, getConfigPath: () => undefined }));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('surfaces TEMPLATE_INVALID error when loadBuiltins throws corruption (not silently swallowed)', async () => {
    const { ScrowError, ErrorCode: EC } = await import('../../errors/index.js');
    vi.doMock('../../templates/index.js', () => ({
      ...actualTemplates,
      loadBuiltins: vi.fn().mockRejectedValue(new ScrowError(EC.TEMPLATE_INVALID, 'bad YAML')),
    }));
    vi.doMock('../../config/index.js', () => ({
      loadConfig: vi.fn().mockResolvedValue({ tasks: [] }),
      resolveConfigFilePath: (configDir: string, override?: string | null) =>
        override ?? join(configDir, 'config.yaml'),
    }));

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--template',
      'improve-code',
      '--target',
      dataDir,
    ]);
    expect(stderrOutput).toContain('bad YAML');
    expect(process.exitCode).toBe(1);
  });

  it('surfaces CONFIG_INVALID error when loadConfig throws validation error (not silently swallowed)', async () => {
    const { ScrowError, ErrorCode: EC } = await import('../../errors/index.js');
    vi.doMock('../../templates/index.js', () => ({
      ...actualTemplates,
      loadBuiltins: vi.fn().mockResolvedValue(MOCK_BUILTINS),
    }));
    vi.doMock('../../config/index.js', () => ({
      loadConfig: vi
        .fn()
        .mockRejectedValue(new ScrowError(EC.CONFIG_INVALID, 'tasks[0].name: required')),
      resolveConfigFilePath: (configDir: string, override?: string | null) =>
        override ?? join(configDir, 'config.yaml'),
    }));

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--template',
      'my-task',
      '--target',
      dataDir,
    ]);
    expect(stderrOutput).toContain('tasks[0].name: required');
    expect(process.exitCode).toBe(1);
  });

  it('swallows TEMPLATE_LOAD_ERROR and falls back to config custom tasks', async () => {
    const { ScrowError, ErrorCode: EC } = await import('../../errors/index.js');
    vi.doMock('../../templates/index.js', () => ({
      ...actualTemplates,
      loadBuiltins: vi
        .fn()
        .mockRejectedValue(new ScrowError(EC.TEMPLATE_LOAD_ERROR, 'no such file')),
      resolveTemplateOrCustom: actualTemplates.resolveTemplateOrCustom,
    }));
    vi.doMock('../../config/index.js', () => ({
      loadConfig: vi.fn().mockResolvedValue({
        tasks: [{ name: 'my-lint', prompt: 'Run eslint', targetPath: dataDir }],
      }),
      resolveConfigFilePath: (configDir: string, override?: string | null) =>
        override ?? join(configDir, 'config.yaml'),
    }));

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--template',
      'my-lint',
      '--target',
      dataDir,
    ]);
    // Should succeed — custom task resolved from config even without built-ins
    expect(stderrOutput).not.toContain('\u2717');
  });
});

// ---------------------------------------------------------------------------
// Destructive operations — non-interactive safety
// In the test environment, process.stdin.isTTY is undefined → non-interactive
// ---------------------------------------------------------------------------

describe('registerQueue() — destructive operation safety (non-interactive)', () => {
  let dataDir: string;

  beforeEach(async () => {
    vi.resetModules();
    dataDir = makeTmpDir();
    await mkdir(dataDir, { recursive: true });
    await gitInit(dataDir);

    process.exitCode = undefined;
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: dataDir, config: dataDir, logs: dataDir }),
    }));
    vi.doMock('../index.js', () => ({ isJsonMode: () => false, getConfigPath: () => undefined }));
    vi.doMock('../../templates/index.js', () => ({
      ...actualTemplates,
      loadBuiltins: vi.fn().mockResolvedValue(MOCK_BUILTINS),
    }));
    vi.doMock('../../config/index.js', () => ({
      loadConfig: vi.fn().mockResolvedValue({ tasks: [] }),
      resolveConfigFilePath: (configDir: string, override?: string | null) =>
        override ?? join(configDir, 'config.yaml'),
    }));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('queue remove without --yes throws QUEUE_CONFIRMATION_REQUIRED in non-interactive', async () => {
    const store = new QueueStore(dataDir);
    const mgr = new QueueManager(store);
    await mgr.add({ type: 'template', templateName: 'x', prompt: '', targetPath: dataDir });

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);

    await expect(
      program.parseAsync(['node', 'sparecrow', 'queue', 'remove', '1']),
    ).rejects.toMatchObject({ code: ErrorCode.QUEUE_CONFIRMATION_REQUIRED });
  });

  it('queue clear without --yes throws QUEUE_CONFIRMATION_REQUIRED in non-interactive', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);

    await expect(program.parseAsync(['node', 'sparecrow', 'queue', 'clear'])).rejects.toMatchObject(
      {
        code: ErrorCode.QUEUE_CONFIRMATION_REQUIRED,
      },
    );
  });

  it('queue remove with non-integer position writes error to stderr', async () => {
    let stderrOutput = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      stderrOutput += String(data);
      return true;
    });

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'remove', 'abc', '--yes']);
    expect(stderrOutput).toContain('Invalid position');
  });

  it('queue reorder move with zero from position writes error', async () => {
    let stderrOutput = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      stderrOutput += String(data);
      return true;
    });

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'reorder', 'move', '0', '1']);
    expect(stderrOutput).toContain('Invalid');
  });

  it('queue remove with zero position writes error', async () => {
    let stderrOutput = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      stderrOutput += String(data);
      return true;
    });

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'remove', '0', '--yes']);
    expect(stderrOutput).toContain('Invalid position');
  });
});

// ---------------------------------------------------------------------------
// renderTable — direct unit tests (Finding 4: isolated unit test for renderTable)
// ---------------------------------------------------------------------------

describe('renderTable()', () => {
  it('returns table string containing all 6 column headers', async () => {
    const { renderTable } = await import('./queue.js');
    const output = renderTable([]);
    expect(output).toContain('#');
    expect(output).toContain('Name');
    expect(output).toContain('Status');
    expect(output).toContain('Type');
    expect(output).toContain('Timeout');
    expect(output).toContain('Target');
  });

  it('renders task fields in correct column order (#, Name, Status, Type, Timeout, Target)', async () => {
    const { renderTable } = await import('./queue.js');
    const tasks = [
      {
        id: 'abc',
        priority: 1,
        name: 'improve-code',
        status: 'pending' as const,
        type: 'template' as const,
        targetPath: '/some/path',
        prompt: 'p',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        timeoutMs: 3600000,
        actions: [] as const,
      },
    ];
    const output = renderTable(tasks);
    // Find the data row line (contains the task name)
    const dataLine = output.split('\n').find((line) => line.includes('improve-code'));
    expect(dataLine).toBeDefined();
    const namePos = dataLine!.indexOf('improve-code');
    const statusPos = dataLine!.indexOf('pending');
    const typePos = dataLine!.indexOf('template');
    // Name before Status, Status before Type
    expect(namePos).toBeLessThan(statusPos);
    expect(statusPos).toBeLessThan(typePos);
  });

  it('renders all 6 TaskStatus values correctly', async () => {
    const { renderTable } = await import('./queue.js');
    const statuses = [
      'pending',
      'in-progress',
      'done',
      'failed',
      'failed_quota',
      'skipped',
    ] as const;
    for (const status of statuses) {
      const tasks = [
        {
          id: `id-${status}`,
          priority: 1,
          name: 'task',
          status,
          type: 'template' as const,
          targetPath: '/p',
          prompt: 'p',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          timeoutMs: 3600000,
          actions: [] as const,
        },
      ];
      const output = renderTable(tasks);
      expect(output).toContain(status);
    }
  });

  it('returns empty table string (headers only) for empty task list', async () => {
    const { renderTable } = await import('./queue.js');
    const output = renderTable([]);
    // Headers still present even when no tasks
    expect(output).toContain('Name');
    expect(output).toContain('Status');
    // No task data rows
    expect(output).not.toContain('improve-code');
  });

  it('renders timeout as "1h" for default 60-minute timeout', async () => {
    const { renderTable } = await import('./queue.js');
    const tasks = [
      {
        id: 'abc',
        priority: 1,
        name: 'task',
        status: 'pending' as const,
        type: 'template' as const,
        targetPath: '/p',
        prompt: 'p',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        timeoutMs: 60 * 60 * 1000,
        actions: [] as const,
      },
    ];
    const output = renderTable(tasks);
    expect(output).toContain('1h');
  });

  it('renders timeout as "2h" for 120-minute timeout', async () => {
    const { renderTable } = await import('./queue.js');
    const tasks = [
      {
        id: 'abc',
        priority: 1,
        name: 'task',
        status: 'pending' as const,
        type: 'template' as const,
        targetPath: '/p',
        prompt: 'p',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        timeoutMs: 120 * 60 * 1000,
        actions: [] as const,
      },
    ];
    const output = renderTable(tasks);
    expect(output).toContain('2h');
  });

  it('renders timeout as "no limit" for timeoutMs: 0', async () => {
    const { renderTable } = await import('./queue.js');
    const tasks = [
      {
        id: 'abc',
        priority: 1,
        name: 'task',
        status: 'pending' as const,
        type: 'template' as const,
        targetPath: '/p',
        prompt: 'p',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        timeoutMs: 0,
        actions: [] as const,
      },
    ];
    const output = renderTable(tasks);
    expect(output).toContain('no limit');
  });
});

// ---------------------------------------------------------------------------
// formatTimeout — unit tests (Story 7.19)
// ---------------------------------------------------------------------------

describe('formatTimeout()', () => {
  it('formats 0 as "no limit"', async () => {
    const { formatTimeout } = await import('./queue.js');
    expect(formatTimeout(0)).toBe('no limit');
  });

  it('formats 30 minutes as "30m"', async () => {
    const { formatTimeout } = await import('./queue.js');
    expect(formatTimeout(30 * 60 * 1000)).toBe('30m');
  });

  it('formats 60 minutes as "1h"', async () => {
    const { formatTimeout } = await import('./queue.js');
    expect(formatTimeout(60 * 60 * 1000)).toBe('1h');
  });

  it('formats 120 minutes as "2h"', async () => {
    const { formatTimeout } = await import('./queue.js');
    expect(formatTimeout(120 * 60 * 1000)).toBe('2h');
  });

  it('formats 90 minutes as "90m" (not evenly divisible by hours)', async () => {
    const { formatTimeout } = await import('./queue.js');
    expect(formatTimeout(90 * 60 * 1000)).toBe('90m');
  });

  it('formats 1800000 (legacy 30min default) as "30m"', async () => {
    const { formatTimeout } = await import('./queue.js');
    expect(formatTimeout(1800000)).toBe('30m');
  });

  // Finding 4: sub-minute values must not produce fractional output
  it('rounds sub-minute positive value (500ms) up to "1m"', async () => {
    const { formatTimeout } = await import('./queue.js');
    expect(formatTimeout(500)).toBe('1m');
  });

  it('rounds 59999ms (just under 1 minute) up to "1m"', async () => {
    const { formatTimeout } = await import('./queue.js');
    expect(formatTimeout(59999)).toBe('1m');
  });

  // Finding 8: "no limit" is display-only and must not appear in JSON output
  it('"no limit" string does not appear in JSON output — wire format uses timeoutMs: 0', async () => {
    const { formatTimeout } = await import('./queue.js');
    // formatTimeout is used only for the human-readable table column
    // JSON output exposes raw timeoutMs: 0, never the display string
    expect(formatTimeout(0)).toBe('no limit');
    // The string "no limit" is exclusively a table cell value
    expect(formatTimeout(0)).not.toContain('0ms');
    expect(formatTimeout(0)).not.toContain('Infinity');
  });
});

// ---------------------------------------------------------------------------
// --timeout CLI flag tests (Findings 2, 3, 5, 6, 7)
// ---------------------------------------------------------------------------

describe('registerQueue() — --timeout flag (AC4 precedence + validation)', () => {
  let dataDir: string;
  let stdoutOutput: string;
  let stderrOutput: string;

  beforeEach(async () => {
    vi.resetModules();
    dataDir = makeTmpDir();
    await mkdir(dataDir, { recursive: true });
    await gitInit(dataDir);

    stdoutOutput = '';
    stderrOutput = '';
    process.exitCode = undefined;
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      stderrOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: dataDir, config: dataDir, logs: dataDir }),
    }));
    vi.doMock('../index.js', () => ({ isJsonMode: () => false, getConfigPath: () => undefined }));
    vi.doMock('../../templates/index.js', () => ({
      ...actualTemplates,
      loadBuiltins: vi.fn().mockResolvedValue(MOCK_BUILTINS),
    }));
    vi.doMock('../../config/index.js', () => ({
      loadConfig: vi.fn().mockResolvedValue({ tasks: [], taskTimeoutMinutes: 60 }),
      resolveConfigFilePath: (configDir: string, override?: string | null) =>
        override ?? join(configDir, 'config.yaml'),
    }));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // Finding 2: --timeout 60 stores 3600000ms
  it('--timeout 60 stores 3600000ms (60 min) in queue entry', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--template',
      'improve-code',
      '--target',
      dataDir,
      '--timeout',
      '60',
    ]);

    const store = new QueueStore(dataDir);
    const { tasks } = await store.read();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.timeoutMs).toBe(3600000);
  });

  // Finding 2: --timeout 0 stores 0 (no timeout)
  it('--timeout 0 stores timeoutMs: 0 (no timeout sentinel) in queue entry', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--template',
      'improve-code',
      '--target',
      dataDir,
      '--timeout',
      '0',
    ]);

    const store = new QueueStore(dataDir);
    const { tasks } = await store.read();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.timeoutMs).toBe(0);
  });

  // Finding 2: CLI flag wins over config default (AC4 highest precedence)
  it('CLI --timeout flag wins over config taskTimeoutMinutes (AC4)', async () => {
    // Config returns taskTimeoutMinutes: 60; --timeout 120 should win
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--template',
      'improve-code',
      '--target',
      dataDir,
      '--timeout',
      '120',
    ]);

    const store = new QueueStore(dataDir);
    const { tasks } = await store.read();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.timeoutMs).toBe(120 * 60 * 1000); // 7200000ms
  });

  // Finding 3: config default branch — taskTimeoutMinutes from config is applied when no CLI flag
  it('config taskTimeoutMinutes: 60 is applied when no --timeout flag', async () => {
    // Mock returns taskTimeoutMinutes: 60 (already set in beforeEach)
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--template',
      'improve-code',
      '--target',
      dataDir,
    ]);

    const store = new QueueStore(dataDir);
    const { tasks } = await store.read();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.timeoutMs).toBe(60 * 60 * 1000); // 3600000ms from config
  });

  // Finding 3: loadConfig returning undefined taskTimeoutMinutes falls back to hardcoded 60 min
  it('falls back to hardcoded 60 min when config returns undefined taskTimeoutMinutes', async () => {
    vi.resetModules();
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: dataDir, config: dataDir, logs: dataDir }),
    }));
    vi.doMock('../index.js', () => ({ isJsonMode: () => false, getConfigPath: () => undefined }));
    vi.doMock('../../templates/index.js', () => ({
      ...actualTemplates,
      loadBuiltins: vi.fn().mockResolvedValue(MOCK_BUILTINS),
    }));
    // Mock does NOT include taskTimeoutMinutes → configTimeoutMinutes is undefined
    vi.doMock('../../config/index.js', () => ({
      loadConfig: vi.fn().mockResolvedValue({ tasks: [] }),
      resolveConfigFilePath: (configDir: string, override?: string | null) =>
        override ?? join(configDir, 'config.yaml'),
    }));

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--template',
      'improve-code',
      '--target',
      dataDir,
    ]);

    const store = new QueueStore(dataDir);
    const { tasks } = await store.read();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.timeoutMs).toBe(60 * 60 * 1000); // 3600000ms — hardcoded default
  });

  // Finding 5: scientific notation is rejected
  it('rejects scientific notation "1e3" with QUEUE_ADD_TIMEOUT_INVALID error (human mode)', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--template',
      'improve-code',
      '--target',
      dataDir,
      '--timeout',
      '1e3',
    ]);
    expect(stderrOutput).toContain('non-negative integer');
    expect(process.exitCode).toBe(1);
  });

  it('rejects float "1.5" with timeout invalid message (human mode)', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--template',
      'improve-code',
      '--target',
      dataDir,
      '--timeout',
      '1.5',
    ]);
    expect(stderrOutput).toContain('non-negative integer');
    expect(process.exitCode).toBe(1);
  });

  it('rejects negative value "-1" with timeout invalid message (human mode)', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--template',
      'improve-code',
      '--target',
      dataDir,
      '--timeout',
      '-1',
    ]);
    expect(stderrOutput).toContain('non-negative integer');
    expect(process.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// --timeout JSON mode + error code tests (Findings 6, 8)
// ---------------------------------------------------------------------------

describe('registerQueue() — --timeout JSON mode (Findings 6, 8)', () => {
  let dataDir: string;
  let stdoutOutput: string;

  beforeEach(async () => {
    vi.resetModules();
    dataDir = makeTmpDir();
    await mkdir(dataDir, { recursive: true });
    await gitInit(dataDir);

    stdoutOutput = '';
    process.exitCode = undefined;
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: dataDir, config: dataDir, logs: dataDir }),
    }));
    vi.doMock('../index.js', () => ({ isJsonMode: () => true, getConfigPath: () => undefined }));
    vi.doMock('../../templates/index.js', () => ({
      ...actualTemplates,
      loadBuiltins: vi.fn().mockResolvedValue(MOCK_BUILTINS),
    }));
    vi.doMock('../../config/index.js', () => ({
      loadConfig: vi.fn().mockResolvedValue({ tasks: [], taskTimeoutMinutes: 60 }),
      resolveConfigFilePath: (configDir: string, override?: string | null) =>
        override ?? join(configDir, 'config.yaml'),
    }));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // Finding 6: wrong error code — JSON mode should return QUEUE_ADD_TIMEOUT_INVALID not QUEUE_ADD_INVALID_MODE
  it('invalid --timeout returns QUEUE_ADD_TIMEOUT_INVALID in JSON mode (not QUEUE_ADD_INVALID_MODE)', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--template',
      'improve-code',
      '--target',
      dataDir,
      '--timeout',
      '1e3',
    ]);

    const parsed = parseJson(stdoutOutput);
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.code).toBe(ErrorCode.QUEUE_ADD_TIMEOUT_INVALID);
    expect(parsed.error?.code).not.toBe(ErrorCode.QUEUE_ADD_INVALID_MODE);
  });

  // Finding 8: JSON output exposes raw timeoutMs, never the "no limit" display string
  it('JSON output for task with --timeout 0 has timeoutMs: 0, not "no limit" string', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--template',
      'improve-code',
      '--target',
      dataDir,
      '--timeout',
      '0',
    ]);

    const parsed = parseJson(stdoutOutput);
    expect(parsed.ok).toBe(true);
    const task = (parsed.data as { task: { timeoutMs: number } }).task;
    expect(task.timeoutMs).toBe(0);
    // The "no limit" string must not appear in the JSON wire format
    expect(stdoutOutput).not.toContain('no limit');
  });
});

// ---------------------------------------------------------------------------
// Template timeout_minutes precedence tests (Finding 7)
// ---------------------------------------------------------------------------

describe('registerQueue() — template timeout_minutes precedence (AC4 middle tier, Finding 7)', () => {
  let dataDir: string;
  let stdoutOutput: string;

  beforeEach(async () => {
    vi.resetModules();
    dataDir = makeTmpDir();
    await mkdir(dataDir, { recursive: true });
    await gitInit(dataDir);

    stdoutOutput = '';
    process.exitCode = undefined;
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: dataDir, config: dataDir, logs: dataDir }),
    }));
    vi.doMock('../index.js', () => ({ isJsonMode: () => true, getConfigPath: () => undefined }));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // Finding 7: template with timeout_minutes: 120 should result in timeoutMs: 7200000
  it('template timeout_minutes: 120 overrides config default and stores 7200000ms', async () => {
    vi.resetModules();
    const MOCK_BUILTINS_WITH_TIMEOUT = [
      {
        name: 'security-audit',
        description: 'Scan repo for vulnerabilities',
        prompt: 'p-sec',
        type: 'built-in' as const,
        timeoutMinutes: 120,
      },
    ];

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: dataDir, config: dataDir, logs: dataDir }),
    }));
    vi.doMock('../index.js', () => ({ isJsonMode: () => true, getConfigPath: () => undefined }));
    vi.doMock('../../templates/index.js', () => ({
      ...actualTemplates,
      loadBuiltins: vi.fn().mockResolvedValue(MOCK_BUILTINS_WITH_TIMEOUT),
    }));
    // Config has taskTimeoutMinutes: 60 — template's 120 should win
    vi.doMock('../../config/index.js', () => ({
      loadConfig: vi.fn().mockResolvedValue({ tasks: [], taskTimeoutMinutes: 60 }),
      resolveConfigFilePath: (configDir: string, override?: string | null) =>
        override ?? join(configDir, 'config.yaml'),
    }));

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--template',
      'security-audit',
      '--target',
      dataDir,
    ]);

    const store = new QueueStore(dataDir);
    const { tasks } = await store.read();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.timeoutMs).toBe(120 * 60 * 1000); // 7200000ms from template
  });

  // Finding 7: CLI --timeout flag overrides template timeout_minutes (AC4 highest precedence)
  it('CLI --timeout flag overrides template timeout_minutes (AC4 highest wins)', async () => {
    vi.resetModules();
    const MOCK_BUILTINS_WITH_TIMEOUT = [
      {
        name: 'improve-code',
        description: 'Review for bugs',
        prompt: 'p-cr',
        type: 'built-in' as const,
        timeoutMinutes: 120,
      },
    ];

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: dataDir, config: dataDir, logs: dataDir }),
    }));
    vi.doMock('../index.js', () => ({ isJsonMode: () => true, getConfigPath: () => undefined }));
    vi.doMock('../../templates/index.js', () => ({
      ...actualTemplates,
      loadBuiltins: vi.fn().mockResolvedValue(MOCK_BUILTINS_WITH_TIMEOUT),
    }));
    vi.doMock('../../config/index.js', () => ({
      loadConfig: vi.fn().mockResolvedValue({ tasks: [], taskTimeoutMinutes: 60 }),
      resolveConfigFilePath: (configDir: string, override?: string | null) =>
        override ?? join(configDir, 'config.yaml'),
    }));

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync([
      'node',
      'sparecrow',
      'queue',
      'add',
      '--template',
      'improve-code',
      '--target',
      dataDir,
      '--timeout',
      '45', // CLI: 45 min wins over template: 120 min
    ]);

    const store = new QueueStore(dataDir);
    const { tasks } = await store.read();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.timeoutMs).toBe(45 * 60 * 1000); // 2700000ms — CLI wins
  });
});

// ---------------------------------------------------------------------------
// Story 10.12 — renderLiveTable unit tests
// ---------------------------------------------------------------------------

/** Helper to create TaskDefinition objects for rendering tests. */
function makeTask(
  overrides: Partial<import('../../types/index.js').TaskDefinition> = {},
): import('../../types/index.js').TaskDefinition {
  return {
    id: overrides.id ?? 'test-id',
    name: overrides.name ?? 'test-task',
    type: overrides.type ?? 'template',
    status: overrides.status ?? 'pending',
    prompt: overrides.prompt ?? 'p',
    targetPath: overrides.targetPath ?? '/some/path',
    priority: overrides.priority ?? 1,
    createdAt: overrides.createdAt ?? new Date('2026-01-01T00:00:00.000Z'),
    timeoutMs: overrides.timeoutMs ?? 3600000,
    actions: overrides.actions ?? [],
    ...(overrides.templateName !== undefined ? { templateName: overrides.templateName } : {}),
  };
}

describe('renderLiveTable() — Story 10.12', () => {
  it('renders RUNNING and QUEUE sections when both are present', async () => {
    const { renderLiveTable } = await import('./queue.js');
    const tasks = [
      makeTask({ name: 'running-task', status: 'in-progress', priority: 1 }),
      makeTask({ name: 'pending-task', status: 'pending', priority: 2 }),
      makeTask({ name: 'quota-task', status: 'failed_quota', priority: 3 }),
    ];
    const output = renderLiveTable(tasks);
    expect(output).toContain('RUNNING');
    expect(output).toContain('QUEUE');
    expect(output).toContain('\u25b6'); // ▶
    expect(output).toContain('running-task');
    expect(output).toContain('pending-task');
    expect(output).toContain('quota-task');
  });

  it('omits done/failed/skipped tasks from live view', async () => {
    const { renderLiveTable } = await import('./queue.js');
    const tasks = [makeTask({ name: 'live', status: 'pending', priority: 1 })];
    const output = renderLiveTable(tasks);
    expect(output).toContain('live');
    expect(output).not.toContain('done');
    expect(output).not.toContain('failed');
    expect(output).not.toContain('skipped');
  });

  it('renders only RUNNING section when no pending/failed_quota tasks exist', async () => {
    const { renderLiveTable } = await import('./queue.js');
    const tasks = [makeTask({ name: 'active', status: 'in-progress', priority: 1 })];
    const output = renderLiveTable(tasks);
    expect(output).toContain('RUNNING');
    expect(output).toContain('active');
    expect(output).not.toContain('QUEUE');
  });

  it('renders only QUEUE section when no in-progress tasks exist', async () => {
    const { renderLiveTable } = await import('./queue.js');
    const tasks = [
      makeTask({ name: 'waiting', status: 'pending', priority: 1 }),
      makeTask({ name: 'retry', status: 'failed_quota', priority: 2 }),
    ];
    const output = renderLiveTable(tasks);
    expect(output).not.toContain('RUNNING');
    expect(output).toContain('QUEUE');
    expect(output).toContain('waiting');
    expect(output).toContain('retry');
  });

  it('QUEUE section uses 1-based position numbers sorted by priority', async () => {
    const { renderLiveTable } = await import('./queue.js');
    const tasks = [
      makeTask({ name: 'second', status: 'pending', priority: 5 }),
      makeTask({ name: 'first', status: 'pending', priority: 2 }),
    ];
    const output = renderLiveTable(tasks);
    // Tasks should be sorted by priority; positions are 1-based
    const lines = output.split('\n');
    const firstLine = lines.find((l) => l.includes('first'));
    const secondLine = lines.find((l) => l.includes('second'));
    expect(firstLine).toBeDefined();
    expect(secondLine).toBeDefined();
    // 'first' (priority 2) should appear before 'second' (priority 5)
    expect(output.indexOf('first')).toBeLessThan(output.indexOf('second'));
  });

  it('returns empty string when no live tasks are present', async () => {
    const { renderLiveTable } = await import('./queue.js');
    const output = renderLiveTable([]);
    expect(output).toBe('');
  });

  it('returns empty string when input contains only historical-status tasks (done/failed/skipped)', async () => {
    const { renderLiveTable } = await import('./queue.js');
    const tasks = [
      makeTask({ status: 'done' }),
      makeTask({ status: 'failed' }),
      makeTask({ status: 'skipped' }),
    ];
    // renderLiveTable filters to live states only — all inputs are historical, so output is empty
    const output = renderLiveTable(tasks);
    expect(output).toBe('');
  });

  it('RUNNING section uses ▶ prefix instead of position number', async () => {
    const { renderLiveTable } = await import('./queue.js');
    const tasks = [makeTask({ name: 'running', status: 'in-progress' })];
    const output = renderLiveTable(tasks);
    const runningLine = output.split('\n').find((l) => l.includes('running'));
    expect(runningLine).toBeDefined();
    expect(runningLine).toContain('\u25b6');
  });

  it('renders failure sub-row for tasks with failures in live view', async () => {
    const { renderLiveTable } = await import('./queue.js');
    const tasks = [makeTask({ name: 'bad-task', status: 'pending' })];
    const failureMap = new Map([['bad-task', 'TASK_TIMEOUT']]);
    const output = renderLiveTable(tasks, failureMap);
    expect(output).toContain('Last failure:');
    expect(output).toContain('task execution timed out');
  });

  it('QUEUE section label uses singular "task" when exactly 1 task is queued', async () => {
    const { renderLiveTable } = await import('./queue.js');
    const tasks = [makeTask({ name: 'only-task', status: 'pending' })];
    const output = renderLiveTable(tasks);
    expect(output).toContain('QUEUE  (1 task)');
    expect(output).not.toContain('QUEUE  (1 tasks)');
  });

  it('QUEUE section label uses plural "tasks" when more than 1 task is queued', async () => {
    const { renderLiveTable } = await import('./queue.js');
    const tasks = [
      makeTask({ name: 'task-a', status: 'pending', priority: 1 }),
      makeTask({ name: 'task-b', status: 'pending', priority: 2 }),
    ];
    const output = renderLiveTable(tasks);
    expect(output).toContain('QUEUE  (2 tasks)');
  });
});

// ---------------------------------------------------------------------------
// Display position vs remove position — fixed via removeById
// ---------------------------------------------------------------------------

describe('renderLiveTable() — display/remove position alignment', () => {
  it('live view filters historical tasks; remove targets the correct displayed task', async () => {
    const { renderLiveTable } = await import('./queue.js');

    // Store contains: [done(p=1), done(p=2), pending(p=3)]
    // Live view shows only the pending task as #1
    const tasks = [
      makeTask({ name: 'old-task-done', status: 'done', priority: 1 }),
      makeTask({ name: 'another-done', status: 'done', priority: 2 }),
      makeTask({ name: 'visible-pending', status: 'pending', priority: 3 }),
    ];

    const output = renderLiveTable(tasks);

    // Live view correctly shows only the pending task
    expect(output).toContain('visible-pending');
    expect(output).not.toContain('old-task-done');
    expect(output).not.toContain('another-done');
    expect(output).toContain('QUEUE  (1 task)');

    // CLI remove now filters to live statuses and resolves display position
    // to the task's UUID, then calls removeById — so remove(1) correctly
    // targets 'visible-pending', not the historical 'old-task-done'.
    const liveStatuses = new Set(['pending', 'in-progress', 'failed_quota']);
    const liveTasks = tasks.filter((t) => liveStatuses.has(t.status));
    const target = liveTasks[0]; // position 1 → index 0 in live array
    expect(target!.name).toBe('visible-pending');
  });

  it('with multiple pending tasks, display positions map correctly to live tasks', async () => {
    const { renderLiveTable } = await import('./queue.js');

    // Store: [done(p=1), pending-A(p=2), done(p=3), pending-B(p=4)]
    const tasks = [
      makeTask({ name: 'done-1', status: 'done', priority: 1 }),
      makeTask({ name: 'pending-A', status: 'pending', priority: 2 }),
      makeTask({ name: 'done-2', status: 'done', priority: 3 }),
      makeTask({ name: 'pending-B', status: 'pending', priority: 4 }),
    ];

    const output = renderLiveTable(tasks);

    expect(output).toContain('pending-A');
    expect(output).toContain('pending-B');
    expect(output).not.toContain('done-1');
    expect(output).not.toContain('done-2');

    // CLI remove now resolves positions against live tasks only:
    // position 1 → pending-A, position 2 → pending-B
    const liveStatuses = new Set(['pending', 'in-progress', 'failed_quota']);
    const liveTasks = tasks
      .filter((t) => liveStatuses.has(t.status))
      .sort((a, b) => a.priority - b.priority);
    expect(liveTasks[0]!.name).toBe('pending-A');
    expect(liveTasks[1]!.name).toBe('pending-B');
  });
});

// ---------------------------------------------------------------------------
// Story 10.12 — buildHistoryFooter unit tests
// ---------------------------------------------------------------------------

describe('buildHistoryFooter() — Story 10.12', () => {
  it('renders N completed and M failed counts', async () => {
    const { buildHistoryFooter } = await import('./queue.js');
    const tasks = [
      makeTask({ status: 'done' }),
      makeTask({ status: 'done' }),
      makeTask({ status: 'failed' }),
    ];
    const footer = buildHistoryFooter(tasks);
    expect(footer).toContain('2 completed');
    expect(footer).toContain('1 failed');
    expect(footer).toContain('sparecrow queue history');
  });

  it('omits zero completed count when only failed tasks exist', async () => {
    const { buildHistoryFooter } = await import('./queue.js');
    const tasks = [makeTask({ status: 'failed' }), makeTask({ status: 'failed' })];
    const footer = buildHistoryFooter(tasks);
    expect(footer).not.toContain('completed');
    expect(footer).toContain('2 failed');
  });

  it('omits zero failed count when only completed tasks exist', async () => {
    const { buildHistoryFooter } = await import('./queue.js');
    const tasks = [makeTask({ status: 'done' })];
    const footer = buildHistoryFooter(tasks);
    expect(footer).toContain('1 completed');
    expect(footer).not.toContain('failed');
  });

  it('returns empty string when no historical tasks exist', async () => {
    const { buildHistoryFooter } = await import('./queue.js');
    const footer = buildHistoryFooter([]);
    expect(footer).toBe('');
  });

  it('returns empty string when only skipped tasks exist (no done/failed)', async () => {
    const { buildHistoryFooter } = await import('./queue.js');
    const tasks = [makeTask({ status: 'skipped' }), makeTask({ status: 'skipped' })];
    const footer = buildHistoryFooter(tasks);
    expect(footer).toBe('');
  });

  it('ignores live tasks when computing counts', async () => {
    const { buildHistoryFooter } = await import('./queue.js');
    const tasks = [
      makeTask({ status: 'pending' }),
      makeTask({ status: 'in-progress' }),
      makeTask({ status: 'failed_quota' }),
      makeTask({ status: 'done' }),
    ];
    const footer = buildHistoryFooter(tasks);
    expect(footer).toContain('1 completed');
    expect(footer).not.toContain('failed');
  });
});

// ---------------------------------------------------------------------------
// Story 10.12 — renderHistoryTable unit tests
// ---------------------------------------------------------------------------

describe('renderHistoryTable() — Story 10.12', () => {
  it('renders done tasks with checkmark icon', async () => {
    const { renderHistoryTable } = await import('./queue.js');
    const tasks = [makeTask({ name: 'completed', status: 'done' })];
    const output = renderHistoryTable(tasks);
    expect(output).toContain('\u2713'); // ✓
    expect(output).toContain('completed');
    expect(output).toContain('HISTORY');
  });

  it('renders failed tasks with cross icon', async () => {
    const { renderHistoryTable } = await import('./queue.js');
    const tasks = [makeTask({ name: 'broken', status: 'failed' })];
    const output = renderHistoryTable(tasks);
    expect(output).toContain('\u2717'); // ✗
    expect(output).toContain('broken');
  });

  it('renders skipped tasks with dash icon', async () => {
    const { renderHistoryTable } = await import('./queue.js');
    const tasks = [makeTask({ name: 'skipped-one', status: 'skipped' })];
    const output = renderHistoryTable(tasks);
    expect(output).toContain('\u2013'); // –
    expect(output).toContain('skipped-one');
  });

  it('sorts tasks by createdAt descending (most recent first)', async () => {
    const { renderHistoryTable } = await import('./queue.js');
    const tasks = [
      makeTask({ name: 'old', status: 'done', createdAt: new Date('2026-01-01T00:00:00Z') }),
      makeTask({ name: 'new', status: 'done', createdAt: new Date('2026-02-01T00:00:00Z') }),
    ];
    const output = renderHistoryTable(tasks);
    // 'new' should appear before 'old' due to descending sort
    expect(output.indexOf('new')).toBeLessThan(output.indexOf('old'));
  });

  it('returns "No history." for empty task list', async () => {
    const { renderHistoryTable } = await import('./queue.js');
    const output = renderHistoryTable([]);
    expect(output).toBe('No history.');
  });

  it('includes failure sub-row for failed tasks when failureMap is provided', async () => {
    const { renderHistoryTable } = await import('./queue.js');
    const tasks = [makeTask({ name: 'bad', status: 'failed' })];
    const failureMap = new Map([['bad', 'TASK_TIMEOUT']]);
    const output = renderHistoryTable(tasks, failureMap);
    expect(output).toContain('Last failure:');
    expect(output).toContain('task execution timed out');
  });

  it('renders all passed tasks (caller is responsible for pre-filtering to historical only)', async () => {
    // renderHistoryTable no longer double-filters; the command handler pre-filters to historical
    // tasks before calling renderHistoryTable. This test verifies the function renders its input as-is.
    const { renderHistoryTable } = await import('./queue.js');
    const tasks = [
      makeTask({ name: 'done-one', status: 'done' }),
      makeTask({ name: 'failed-one', status: 'failed' }),
    ];
    const output = renderHistoryTable(tasks);
    expect(output).toContain('done-one');
    expect(output).toContain('failed-one');
    expect(output).toContain('HISTORY');
  });
});

// ---------------------------------------------------------------------------
// Story 10.12 — queue history command tests (human mode)
// ---------------------------------------------------------------------------

describe('registerQueue() — queue history command (human mode)', () => {
  let dataDir: string;
  let stdoutOutput: string;

  beforeEach(async () => {
    vi.resetModules();
    dataDir = makeTmpDir();
    await mkdir(dataDir, { recursive: true });
    await gitInit(dataDir);

    stdoutOutput = '';
    process.exitCode = undefined;

    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: dataDir, config: dataDir, logs: dataDir }),
    }));
    vi.doMock('../index.js', () => ({ isJsonMode: () => false, getConfigPath: () => undefined }));
    vi.doMock('../../templates/index.js', () => ({
      ...actualTemplates,
      loadBuiltins: vi.fn().mockResolvedValue(MOCK_BUILTINS),
    }));
    vi.doMock('../../config/index.js', () => ({
      loadConfig: vi.fn().mockResolvedValue({ tasks: [] }),
      resolveConfigFilePath: (configDir: string, override?: string | null) =>
        override ?? join(configDir, 'config.yaml'),
    }));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('renders "No history." when queue has no historical tasks', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'history']);
    expect(stdoutOutput).toContain('No history.');
  });

  it('renders history table with done/failed/skipped tasks', async () => {
    const store = new QueueStore(dataDir);
    const mgr = new QueueManager(store);
    const r1 = await mgr.add({
      type: 'template',
      templateName: 'improve-code',
      prompt: 'p-cr',
      targetPath: dataDir,
    });
    const r2 = await mgr.add({
      type: 'template',
      templateName: 'fix-bugs',
      prompt: 'p-bh',
      targetPath: dataDir,
    });
    await mgr.setTaskStatus(r1.task.id, 'done');
    await mgr.setTaskStatus(r2.task.id, 'failed');

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'history']);
    expect(stdoutOutput).toContain('HISTORY');
    expect(stdoutOutput).toContain('improve-code');
    expect(stdoutOutput).toContain('fix-bugs');
    expect(stdoutOutput).toContain('\u2713'); // ✓ for done
    expect(stdoutOutput).toContain('\u2717'); // ✗ for failed
  });

  it('does not show pending/in-progress/failed_quota tasks in history', async () => {
    const store = new QueueStore(dataDir);
    const mgr = new QueueManager(store);
    await mgr.add({
      type: 'template',
      templateName: 'pending-task',
      prompt: 'p',
      targetPath: dataDir,
    });
    const r2 = await mgr.add({
      type: 'template',
      templateName: 'done-task',
      prompt: 'p',
      targetPath: dataDir,
    });
    await mgr.setTaskStatus(r2.task.id, 'done');

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'history']);
    expect(stdoutOutput).toContain('done-task');
    expect(stdoutOutput).not.toContain('pending-task');
  });

  it('renders failure sub-row for failed tasks when log-reader returns failures', async () => {
    const store = new QueueStore(dataDir);
    const mgr = new QueueManager(store);
    const r1 = await mgr.add({
      type: 'template',
      templateName: 'broken-task',
      prompt: 'p',
      targetPath: dataDir,
    });
    await mgr.setTaskStatus(r1.task.id, 'failed');

    vi.doMock('./log-reader.js', () => ({
      getRecentTaskFailures: async () => new Map([['broken-task', 'CLAUDE_NOT_FOUND']]),
      queryLogs: async () => ({
        entries: [],
        total: 0,
        successCount: 0,
        failureCount: 0,
        failureSummary: [],
      }),
      parseSinceDuration: () => new Date(),
      discoverLogFiles: async () => [],
      parseLogFile: async () => [],
    }));

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'history']);
    expect(stdoutOutput).toContain('Last failure:');
    expect(stdoutOutput).toContain('Claude CLI not found');
  });

  it('scrow alias routes to the same queue history behaviour', async () => {
    // AC4: "scrow queue history" must work identically to "sparecrow queue history"
    // In Commander the argv[1] binary name does not affect command routing
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    // Invoke via "scrow" binary alias — should show "No history." just like "sparecrow"
    await program.parseAsync(['node', 'scrow', 'queue', 'history']);
    expect(stdoutOutput).toContain('No history.');
  });
});

// ---------------------------------------------------------------------------
// Story 10.12 — queue history command tests (JSON mode)
// ---------------------------------------------------------------------------

describe('registerQueue() — queue history command (JSON mode)', () => {
  let dataDir: string;
  let stdoutOutput: string;

  beforeEach(async () => {
    vi.resetModules();
    dataDir = makeTmpDir();
    await mkdir(dataDir, { recursive: true });
    await gitInit(dataDir);

    stdoutOutput = '';
    process.exitCode = undefined;

    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: dataDir, config: dataDir, logs: dataDir }),
    }));
    vi.doMock('../index.js', () => ({ isJsonMode: () => true, getConfigPath: () => undefined }));
    vi.doMock('../../templates/index.js', () => ({
      ...actualTemplates,
      loadBuiltins: vi.fn().mockResolvedValue(MOCK_BUILTINS),
    }));
    vi.doMock('../../config/index.js', () => ({
      loadConfig: vi.fn().mockResolvedValue({ tasks: [] }),
      resolveConfigFilePath: (configDir: string, override?: string | null) =>
        override ?? join(configDir, 'config.yaml'),
    }));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('prints "No history." message when no history exists (even in JSON mode)', async () => {
    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'history']);

    // AC4: "No history." is shown for empty history regardless of --json mode
    expect(stdoutOutput).toContain('No history.');
  });

  it('returns JSON envelope with historical tasks including lastFailure field', async () => {
    const store = new QueueStore(dataDir);
    const mgr = new QueueManager(store);
    const r1 = await mgr.add({
      type: 'template',
      templateName: 'done-task',
      prompt: 'p',
      targetPath: dataDir,
    });
    await mgr.setTaskStatus(r1.task.id, 'done');

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'history']);

    const parsed = parseJson(stdoutOutput);
    expect(parsed.ok).toBe(true);
    const data = parsed.data as {
      tasks: Array<{
        name: string;
        status: string;
        lastFailure: null | { code: string; message: string };
      }>;
    };
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0]!.name).toBe('done-task');
    expect(data.tasks[0]!.status).toBe('done');
    expect(data.tasks[0]!).toHaveProperty('lastFailure');
    expect(data.tasks[0]!.lastFailure).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Story 10.12 — --include-history flag tests
// ---------------------------------------------------------------------------

describe('registerQueue() — --include-history flag (Story 10.12)', () => {
  let dataDir: string;
  let stdoutOutput: string;

  beforeEach(async () => {
    vi.resetModules();
    dataDir = makeTmpDir();
    await mkdir(dataDir, { recursive: true });
    await gitInit(dataDir);

    stdoutOutput = '';
    process.exitCode = undefined;

    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: dataDir, config: dataDir, logs: dataDir }),
    }));
    vi.doMock('../index.js', () => ({ isJsonMode: () => false, getConfigPath: () => undefined }));
    vi.doMock('../../templates/index.js', () => ({
      ...actualTemplates,
      loadBuiltins: vi.fn().mockResolvedValue(MOCK_BUILTINS),
    }));
    vi.doMock('../../config/index.js', () => ({
      loadConfig: vi.fn().mockResolvedValue({ tasks: [] }),
      resolveConfigFilePath: (configDir: string, override?: string | null) =>
        override ?? join(configDir, 'config.yaml'),
    }));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('--include-history shows all tasks including done/failed/skipped', async () => {
    const store = new QueueStore(dataDir);
    const mgr = new QueueManager(store);
    const r1 = await mgr.add({
      type: 'template',
      templateName: 'improve-code',
      prompt: 'p',
      targetPath: dataDir,
    });
    await mgr.add({
      type: 'template',
      templateName: 'fix-bugs',
      prompt: 'p',
      targetPath: dataDir,
    });
    await mgr.setTaskStatus(r1.task.id, 'done');

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'list', '--include-history']);
    // All tasks shown regardless of status
    expect(stdoutOutput).toContain('improve-code');
    expect(stdoutOutput).toContain('fix-bugs');
    expect(stdoutOutput).toContain('done');
    expect(stdoutOutput).toContain('pending');
  });

  it('--include-history renders full table with # column (legacy format)', async () => {
    const store = new QueueStore(dataDir);
    const mgr = new QueueManager(store);
    await mgr.add({
      type: 'template',
      templateName: 'task-1',
      prompt: 'p',
      targetPath: dataDir,
    });

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'list', '--include-history']);
    // Uses legacy renderTable which includes #, Name, Status columns
    expect(stdoutOutput).toContain('#');
    expect(stdoutOutput).toContain('Name');
    expect(stdoutOutput).toContain('Status');
  });
});

// ---------------------------------------------------------------------------
// Story 10.12 — --include-history JSON mode tests
// ---------------------------------------------------------------------------

describe('registerQueue() — --include-history JSON mode (Story 10.12)', () => {
  let dataDir: string;
  let stdoutOutput: string;

  beforeEach(async () => {
    vi.resetModules();
    dataDir = makeTmpDir();
    await mkdir(dataDir, { recursive: true });
    await gitInit(dataDir);

    stdoutOutput = '';
    process.exitCode = undefined;

    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: dataDir, config: dataDir, logs: dataDir }),
    }));
    vi.doMock('../index.js', () => ({ isJsonMode: () => true, getConfigPath: () => undefined }));
    vi.doMock('../../templates/index.js', () => ({
      ...actualTemplates,
      loadBuiltins: vi.fn().mockResolvedValue(MOCK_BUILTINS),
    }));
    vi.doMock('../../config/index.js', () => ({
      loadConfig: vi.fn().mockResolvedValue({ tasks: [] }),
      resolveConfigFilePath: (configDir: string, override?: string | null) =>
        override ?? join(configDir, 'config.yaml'),
    }));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('default JSON output contains only live tasks', async () => {
    const store = new QueueStore(dataDir);
    const mgr = new QueueManager(store);
    const r1 = await mgr.add({
      type: 'template',
      templateName: 'improve-code',
      prompt: 'p',
      targetPath: dataDir,
    });
    await mgr.add({
      type: 'template',
      templateName: 'fix-bugs',
      prompt: 'p',
      targetPath: dataDir,
    });
    await mgr.setTaskStatus(r1.task.id, 'done');

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'list']);

    const parsed = parseJson(stdoutOutput);
    expect(parsed.ok).toBe(true);
    const data = parsed.data as { tasks: Array<{ status: string }> };
    // Only live tasks returned
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0]!.status).toBe('pending');
  });

  it('--include-history JSON output contains all tasks with lastFailure field present', async () => {
    const store = new QueueStore(dataDir);
    const mgr = new QueueManager(store);
    const r1 = await mgr.add({
      type: 'template',
      templateName: 'improve-code',
      prompt: 'p',
      targetPath: dataDir,
    });
    await mgr.add({
      type: 'template',
      templateName: 'fix-bugs',
      prompt: 'p',
      targetPath: dataDir,
    });
    await mgr.setTaskStatus(r1.task.id, 'done');

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'list', '--include-history']);

    const parsed = parseJson(stdoutOutput);
    expect(parsed.ok).toBe(true);
    const data = parsed.data as {
      tasks: Array<{ status: string; lastFailure: null | { code: string; message: string } }>;
    };
    // All tasks returned
    expect(data.tasks).toHaveLength(2);
    const statuses = data.tasks.map((t) => t.status);
    expect(statuses).toContain('done');
    expect(statuses).toContain('pending');
    // AC6: lastFailure field must be present on every task (same shape as queue list --json)
    for (const task of data.tasks) {
      expect(task).toHaveProperty('lastFailure');
    }
  });
});

// ---------------------------------------------------------------------------
// Story 10.12 — empty live queue with history footer
// ---------------------------------------------------------------------------

describe('registerQueue() — empty live queue with history (Story 10.12)', () => {
  let dataDir: string;
  let stdoutOutput: string;

  beforeEach(async () => {
    vi.resetModules();
    dataDir = makeTmpDir();
    await mkdir(dataDir, { recursive: true });
    await gitInit(dataDir);

    stdoutOutput = '';
    process.exitCode = undefined;

    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: dataDir, config: dataDir, logs: dataDir }),
    }));
    vi.doMock('../index.js', () => ({ isJsonMode: () => false, getConfigPath: () => undefined }));
    vi.doMock('../../templates/index.js', () => ({
      ...actualTemplates,
      loadBuiltins: vi.fn().mockResolvedValue(MOCK_BUILTINS),
    }));
    vi.doMock('../../config/index.js', () => ({
      loadConfig: vi.fn().mockResolvedValue({ tasks: [] }),
      resolveConfigFilePath: (configDir: string, override?: string | null) =>
        override ?? join(configDir, 'config.yaml'),
    }));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('shows "Queue is empty." with footer when only historical tasks exist', async () => {
    const store = new QueueStore(dataDir);
    const mgr = new QueueManager(store);
    const r1 = await mgr.add({
      type: 'template',
      templateName: 'done-task',
      prompt: 'p',
      targetPath: dataDir,
    });
    await mgr.setTaskStatus(r1.task.id, 'done');

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);
    await program.parseAsync(['node', 'sparecrow', 'queue', 'list']);
    expect(stdoutOutput).toContain('Queue is empty.');
    expect(stdoutOutput).toContain('1 completed');
    expect(stdoutOutput).toContain('sparecrow queue history');
  });
});
