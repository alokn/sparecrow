/** Unit tests for interactive TTY confirmation prompts on queue remove/clear. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { QueueStore, QueueManager } from '../../queue/index.js';
import { ErrorCode } from '../../errors/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return join(tmpdir(), `scr-queue-int-${randomBytes(6).toString('hex')}`);
}

function makeProgram() {
  // Dynamically import Command to avoid stale module references
  const { Command } = require('commander');
  const program = new Command();
  program.exitOverride();
  return program;
}

// ---------------------------------------------------------------------------
// Interactive TTY confirmation tests
// ---------------------------------------------------------------------------

describe('registerQueue() — interactive TTY confirmation', () => {
  let dataDir: string;
  let stdoutOutput: string;
  let stderrOutput: string;
  let originalStdinIsTTY: boolean | undefined;
  let originalStdoutIsTTY: boolean | undefined;

  beforeEach(async () => {
    vi.resetModules();
    dataDir = makeTmpDir();
    await mkdir(dataDir, { recursive: true });

    stdoutOutput = '';
    stderrOutput = '';
    process.exitCode = undefined;

    // Save originals so we can restore in afterEach
    originalStdinIsTTY = process.stdin.isTTY;
    originalStdoutIsTTY = process.stdout.isTTY;

    // Set TTY flags to simulate interactive environment
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: dataDir, config: dataDir, logs: dataDir }),
    }));
    vi.doMock('../index.js', () => ({ isJsonMode: () => false, getConfigPath: () => null }));
    vi.doMock('../../templates/index.js', () => ({
      loadBuiltins: vi.fn().mockResolvedValue([]),
      resolveTemplate: vi.fn(),
      resolveTemplateOrCustom: vi.fn(),
    }));
    vi.doMock('../../config/index.js', () => ({
      loadConfig: vi.fn().mockResolvedValue({
        pollingInterval: 300,
        logRetentionDays: 30,
        taskTimeoutMinutes: 60,
        lastSummaryEnabled: false,
        provider: {
          name: 'claude-code',
          allowDangerouslySkipPermissions: false,
          executionBackend: 'container',
        },
        trigger: {
          maxWastePercentage: 50,
          weeklyReservePercentage: 30,
          idleHours: [],
        },
        tasks: [],
      }),
      resolveConfigFilePath: (configDir: string, override?: string | null) =>
        override ?? join(configDir, 'config.yaml'),
    }));
  });

  afterEach(async () => {
    // Restore TTY flags
    if (originalStdinIsTTY === undefined) {
      Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    } else {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: originalStdinIsTTY,
        configurable: true,
      });
    }
    if (originalStdoutIsTTY === undefined) {
      Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
    } else {
      Object.defineProperty(process.stdout, 'isTTY', {
        value: originalStdoutIsTTY,
        configurable: true,
      });
    }

    await rm(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** Mock node:readline so the confirm() helper calls our callback immediately. */
  function mockReadline(answer: string): void {
    vi.doMock('node:readline', () => ({
      createInterface: () => ({
        question: (_prompt: string, cb: (answer: string) => void) => {
          cb(answer);
        },
        close: vi.fn(),
      }),
    }));
  }

  // ── AC1: queue remove shows confirmation prompt ──────────────────────────

  it('queue remove without --yes shows confirmation prompt in interactive mode', async () => {
    let promptText = '';
    vi.doMock('node:readline', () => ({
      createInterface: () => ({
        question: (prompt: string, cb: (answer: string) => void) => {
          promptText = prompt;
          cb('n');
        },
        close: vi.fn(),
      }),
    }));

    const store = new QueueStore(dataDir);
    const mgr = new QueueManager(store);
    await mgr.add({ type: 'template', templateName: 'a', prompt: '', targetPath: dataDir });

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);

    // Install output spies after dynamic import
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      stderrOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    await program.parseAsync(['node', 'sparecrow', 'queue', 'remove', '1']);
    expect(promptText).toContain('Remove task at position 1');
    expect(promptText).toContain('[y/N]');
  });

  // ── AC2: user declining leaves queue unchanged ───────────────────────────

  it('queue remove declining confirmation preserves queue', async () => {
    mockReadline('n');

    const store = new QueueStore(dataDir);
    const mgr = new QueueManager(store);
    await mgr.add({ type: 'template', templateName: 'task-a', prompt: '', targetPath: dataDir });
    await mgr.add({ type: 'template', templateName: 'task-b', prompt: '', targetPath: dataDir });
    await mgr.add({ type: 'template', templateName: 'task-c', prompt: '', targetPath: dataDir });

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);

    // Install output spies after dynamic import
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      stderrOutput += String(data);
      return true;
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    await program.parseAsync(['node', 'sparecrow', 'queue', 'remove', '2']);
    expect(stdoutOutput).toContain('Cancelled');
    expect(exitSpy).not.toHaveBeenCalled();

    // Queue should still have all 3 tasks
    const { tasks } = await store.read();
    expect(tasks).toHaveLength(3);
  });

  // ── AC1 supplement: user confirming remove actually removes task ──────────

  it('queue remove confirming removes the task', async () => {
    mockReadline('y');

    const store = new QueueStore(dataDir);
    const mgr = new QueueManager(store);
    await mgr.add({ type: 'template', templateName: 'task-a', prompt: '', targetPath: dataDir });
    await mgr.add({ type: 'template', templateName: 'task-b', prompt: '', targetPath: dataDir });

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);

    // Install output spies after dynamic import
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      stderrOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    await program.parseAsync(['node', 'sparecrow', 'queue', 'remove', '1']);
    expect(stdoutOutput).toContain('Removed');

    const { tasks } = await store.read();
    expect(tasks).toHaveLength(1);
  });

  // ── AC3: queue clear shows count and confirmation ────────────────────────

  it('queue clear without --yes shows count in confirmation prompt', async () => {
    let promptText = '';
    vi.doMock('node:readline', () => ({
      createInterface: () => ({
        question: (prompt: string, cb: (answer: string) => void) => {
          promptText = prompt;
          cb('n');
        },
        close: vi.fn(),
      }),
    }));

    const store = new QueueStore(dataDir);
    const mgr = new QueueManager(store);
    await mgr.add({ type: 'template', templateName: 'a', prompt: '', targetPath: dataDir });
    await mgr.add({ type: 'template', templateName: 'b', prompt: '', targetPath: dataDir });
    await mgr.add({ type: 'template', templateName: 'c', prompt: '', targetPath: dataDir });
    await mgr.add({ type: 'template', templateName: 'd', prompt: '', targetPath: dataDir });
    await mgr.add({ type: 'template', templateName: 'e', prompt: '', targetPath: dataDir });

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);

    // Install output spies after dynamic import
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      stderrOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    await program.parseAsync(['node', 'sparecrow', 'queue', 'clear']);
    expect(promptText).toContain('5 task(s)');
    expect(promptText).toContain('[y/N]');
  });

  // ── AC4: user confirming clear empties queue ─────────────────────────────

  it('queue clear confirming empties the queue', async () => {
    mockReadline('y');

    const store = new QueueStore(dataDir);
    const mgr = new QueueManager(store);
    await mgr.add({ type: 'template', templateName: 'a', prompt: '', targetPath: dataDir });
    await mgr.add({ type: 'template', templateName: 'b', prompt: '', targetPath: dataDir });
    await mgr.add({ type: 'template', templateName: 'c', prompt: '', targetPath: dataDir });
    await mgr.add({ type: 'template', templateName: 'd', prompt: '', targetPath: dataDir });
    await mgr.add({ type: 'template', templateName: 'e', prompt: '', targetPath: dataDir });

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);

    // Install output spies after dynamic import
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      stderrOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    await program.parseAsync(['node', 'sparecrow', 'queue', 'clear']);
    expect(stdoutOutput).toContain('Cleared 5');

    const { tasks } = await store.read();
    expect(tasks).toHaveLength(0);
  });

  // ── AC3 supplement: user declining clear preserves queue ──────────────────

  it('queue clear declining confirmation preserves queue', async () => {
    mockReadline('n');

    const store = new QueueStore(dataDir);
    const mgr = new QueueManager(store);
    await mgr.add({ type: 'template', templateName: 'a', prompt: '', targetPath: dataDir });
    await mgr.add({ type: 'template', templateName: 'b', prompt: '', targetPath: dataDir });
    await mgr.add({ type: 'template', templateName: 'c', prompt: '', targetPath: dataDir });

    const { registerQueue } = await import('./queue.js');
    const program = makeProgram();
    registerQueue(program);

    // Install output spies after dynamic import
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      stderrOutput += String(data);
      return true;
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    await program.parseAsync(['node', 'sparecrow', 'queue', 'clear']);
    expect(stdoutOutput).toContain('Cancelled');
    expect(exitSpy).not.toHaveBeenCalled();

    const { tasks } = await store.read();
    expect(tasks).toHaveLength(3);
  });

  // ── Negative path: non-TTY without --yes throws QUEUE_CONFIRMATION_REQUIRED

  it('queue remove without --yes throws QUEUE_CONFIRMATION_REQUIRED in non-interactive mode', async () => {
    // Override TTY flags to simulate non-interactive environment
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

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
});
