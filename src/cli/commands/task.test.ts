/** Unit tests for the task CLI command — tail subcommand, happy paths, and error paths. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Command } from 'commander';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return join(tmpdir(), `scr-task-test-${randomBytes(6).toString('hex')}`);
}

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  return program;
}

function parseJson(raw: string): {
  ok: boolean;
  data: unknown;
  error: { code: string; message: string } | null;
} {
  return JSON.parse(raw) as {
    ok: boolean;
    data: unknown;
    error: { code: string; message: string } | null;
  };
}

/** Minimal TaskDefinition for queue mock. */
function makeTask(
  overrides: Partial<{
    id: string;
    name: string;
    status: string;
  }> = {},
) {
  return {
    id: overrides.id ?? `aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
    name: overrides.name ?? 'test-task',
    status: overrides.status ?? 'in-progress',
    type: 'custom',
    prompt: 'do something',
    targetPath: '/some/repo',
    priority: 1,
    createdAt: new Date(),
    timeoutMs: 60000,
  };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tempDir: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  tempDir = makeTempDir();
  await mkdir(tempDir, { recursive: true });

  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
  // Reset exitCode
  process.exitCode = undefined;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerTask', () => {
  describe('task tail — no task running', () => {
    it('prints message when no in-progress task found (human mode)', async () => {
      vi.resetModules();
      vi.doMock('../../platform/index.js', () => ({
        getPaths: () => ({
          data: tempDir,
          taskOutputs: tempDir,
          logs: join(tempDir, 'logs'),
          config: tempDir,
        }),
      }));
      vi.doMock('../index.js', () => ({
        isJsonMode: () => false,
        getConfigPath: () => undefined,
      }));
      vi.doMock('../../queue/index.js', () => ({
        QueueStore: class {},
        QueueManager: class {
          async list() {
            return [];
          }
        },
      }));

      const { registerTask } = await import('./task.js');
      const program = makeProgram();
      registerTask(program);

      await program.parseAsync(['node', 'test', 'task', 'tail']);
      const combined = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
      expect(combined).toContain('No in-progress task found');
    });

    it('returns JSON error when no in-progress task found (JSON mode)', async () => {
      vi.resetModules();
      vi.doMock('../../platform/index.js', () => ({
        getPaths: () => ({
          data: tempDir,
          taskOutputs: tempDir,
          logs: join(tempDir, 'logs'),
          config: tempDir,
        }),
      }));
      vi.doMock('../index.js', () => ({
        isJsonMode: () => true,
        getConfigPath: () => undefined,
      }));
      vi.doMock('../../queue/index.js', () => ({
        QueueStore: class {},
        QueueManager: class {
          async list() {
            return [];
          }
        },
      }));
      vi.doMock('../../ui/index.js', () => ({
        printJson: (obj: unknown) => process.stdout.write(JSON.stringify(obj) + '\n'),
        color: { dim: (s: string) => s, green: (s: string) => s },
      }));

      const { registerTask } = await import('./task.js');
      const program = makeProgram();
      registerTask(program);

      await program.parseAsync(['node', 'test', 'task', 'tail']);
      const raw = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
      const result = parseJson(raw);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('TASK_PARTIAL_OUTPUT_NOT_FOUND');
    });
  });

  describe('task tail — invalid task ID', () => {
    it('rejects non-UUID task ID (human mode)', async () => {
      vi.resetModules();
      vi.doMock('../../platform/index.js', () => ({
        getPaths: () => ({
          data: tempDir,
          taskOutputs: tempDir,
          logs: join(tempDir, 'logs'),
          config: tempDir,
        }),
      }));
      vi.doMock('../index.js', () => ({
        isJsonMode: () => false,
        getConfigPath: () => undefined,
      }));
      vi.doMock('../../queue/index.js', () => ({
        QueueStore: class {},
        QueueManager: class {
          async list() {
            return [];
          }
        },
      }));

      const { registerTask } = await import('./task.js');
      const program = makeProgram();
      registerTask(program);

      await program.parseAsync(['node', 'test', 'task', 'tail', 'not-a-uuid']);
      const errOut = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
      expect(errOut).toContain('Invalid task ID format');
      expect(process.exitCode).toBe(1);
    });

    it('rejects non-UUID task ID (JSON mode)', async () => {
      vi.resetModules();
      vi.doMock('../../platform/index.js', () => ({
        getPaths: () => ({
          data: tempDir,
          taskOutputs: tempDir,
          logs: join(tempDir, 'logs'),
          config: tempDir,
        }),
      }));
      vi.doMock('../index.js', () => ({
        isJsonMode: () => true,
        getConfigPath: () => undefined,
      }));
      vi.doMock('../../queue/index.js', () => ({
        QueueStore: class {},
        QueueManager: class {
          async list() {
            return [];
          }
        },
      }));
      vi.doMock('../../ui/index.js', () => ({
        printJson: (obj: unknown) => process.stdout.write(JSON.stringify(obj) + '\n'),
        color: { dim: (s: string) => s, green: (s: string) => s },
      }));

      const { registerTask } = await import('./task.js');
      const program = makeProgram();
      registerTask(program);

      await program.parseAsync(['node', 'test', 'task', 'tail', 'bad-id']);
      const raw = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
      const result = parseJson(raw);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('INVALID_ARGUMENT');
    });
  });

  describe('task tail — task not in-progress', () => {
    it('prints status message when task is pending (human mode)', async () => {
      vi.resetModules();
      const partialPath = join(tempDir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.partial.txt');
      // No partial file exists

      vi.doMock('../../platform/index.js', () => ({
        getPaths: () => ({
          data: tempDir,
          taskOutputs: tempDir,
          logs: join(tempDir, 'logs'),
          config: tempDir,
        }),
      }));
      vi.doMock('../index.js', () => ({
        isJsonMode: () => false,
        getConfigPath: () => undefined,
      }));
      vi.doMock('../../queue/index.js', () => ({
        QueueStore: class {},
        QueueManager: class {
          async list() {
            return [makeTask({ status: 'pending' })];
          }
        },
      }));

      const { registerTask } = await import('./task.js');
      const program = makeProgram();
      registerTask(program);

      await program.parseAsync([
        'node',
        'test',
        'task',
        'tail',
        'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      ]);
      const combined = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
      expect(combined).toContain('pending');
      expect(combined).toContain('not in-progress');
    });
  });

  describe('task tail — partial file exists', () => {
    it('streams existing partial file content and completes when final file appears', async () => {
      vi.resetModules();
      const taskId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      const partialPath = join(tempDir, `${taskId}.partial.txt`);
      const finalPath = join(tempDir, `${taskId}.txt`);

      // Write the partial file with existing content
      await writeFile(partialPath, 'partial output line 1\n', 'utf-8');
      // Also create the final file so polling terminates immediately
      await writeFile(finalPath, 'final output', 'utf-8');

      vi.doMock('../../platform/index.js', () => ({
        getPaths: () => ({
          data: tempDir,
          taskOutputs: tempDir,
          logs: join(tempDir, 'logs'),
          config: tempDir,
        }),
      }));
      vi.doMock('../index.js', () => ({
        isJsonMode: () => false,
        getConfigPath: () => undefined,
      }));
      vi.doMock('../../queue/index.js', () => ({
        QueueStore: class {},
        QueueManager: class {
          async list() {
            return [makeTask({ id: taskId, status: 'in-progress' })];
          }
        },
      }));

      const { registerTask } = await import('./task.js');
      const program = makeProgram();
      registerTask(program);

      await program.parseAsync(['node', 'test', 'task', 'tail', taskId]);
      const combined = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
      expect(combined).toContain('partial output line 1');
    });

    it('emits JSON chunks in JSON mode', async () => {
      vi.resetModules();
      const taskId = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
      const partialPath = join(tempDir, `${taskId}.partial.txt`);
      const finalPath = join(tempDir, `${taskId}.txt`);

      // Write partial content and final file to terminate polling
      await writeFile(partialPath, 'live chunk data', 'utf-8');
      await writeFile(finalPath, 'done', 'utf-8');

      vi.doMock('../../platform/index.js', () => ({
        getPaths: () => ({
          data: tempDir,
          taskOutputs: tempDir,
          logs: join(tempDir, 'logs'),
          config: tempDir,
        }),
      }));
      vi.doMock('../index.js', () => ({
        isJsonMode: () => true,
        getConfigPath: () => undefined,
      }));
      vi.doMock('../../queue/index.js', () => ({
        QueueStore: class {},
        QueueManager: class {
          async list() {
            return [makeTask({ id: taskId, status: 'in-progress' })];
          }
        },
      }));
      vi.doMock('../../ui/index.js', () => ({
        printJson: (obj: unknown) => process.stdout.write(JSON.stringify(obj) + '\n'),
        color: { dim: (s: string) => s, green: (s: string) => s },
      }));

      const { registerTask } = await import('./task.js');
      const program = makeProgram();
      registerTask(program);

      await program.parseAsync(['node', 'test', 'task', 'tail', taskId]);
      const combined = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');

      // Should contain at least one JSON chunk with data field
      const lines = combined.split('\n').filter(Boolean);
      const chunkLines = lines.filter((line: string) => {
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          return 'data' in obj && 'stream' in obj;
        } catch {
          return false;
        }
      });
      expect(chunkLines.length).toBeGreaterThan(0);

      const chunk = JSON.parse(chunkLines[0]!) as { ts: string; stream: string; data: string };
      expect(chunk.stream).toBe('stdout');
      expect(chunk.data).toContain('live chunk data');
      expect(chunk.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('task tail — auto-detect active task', () => {
    it('auto-detects the single in-progress task when no ID given', async () => {
      vi.resetModules();
      const taskId = 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee';
      const partialPath = join(tempDir, `${taskId}.partial.txt`);
      const finalPath = join(tempDir, `${taskId}.txt`);

      await writeFile(partialPath, 'auto-detected output', 'utf-8');
      await writeFile(finalPath, 'done', 'utf-8');

      vi.doMock('../../platform/index.js', () => ({
        getPaths: () => ({
          data: tempDir,
          taskOutputs: tempDir,
          logs: join(tempDir, 'logs'),
          config: tempDir,
        }),
      }));
      vi.doMock('../index.js', () => ({
        isJsonMode: () => false,
        getConfigPath: () => undefined,
      }));
      vi.doMock('../../queue/index.js', () => ({
        QueueStore: class {},
        QueueManager: class {
          async list() {
            return [makeTask({ id: taskId, status: 'in-progress' })];
          }
        },
      }));

      const { registerTask } = await import('./task.js');
      const program = makeProgram();
      registerTask(program);

      // No task ID argument — should auto-detect
      await program.parseAsync(['node', 'test', 'task', 'tail']);
      const combined = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
      expect(combined).toContain('auto-detected output');
    });

    it('throws error when multiple tasks are in-progress', async () => {
      vi.resetModules();
      vi.doMock('../../platform/index.js', () => ({
        getPaths: () => ({
          data: tempDir,
          taskOutputs: tempDir,
          logs: join(tempDir, 'logs'),
          config: tempDir,
        }),
      }));
      vi.doMock('../index.js', () => ({
        isJsonMode: () => false,
        getConfigPath: () => undefined,
      }));
      vi.doMock('../../queue/index.js', () => ({
        QueueStore: class {},
        QueueManager: class {
          async list() {
            return [
              makeTask({ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', status: 'in-progress' }),
              makeTask({ id: 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee', status: 'in-progress' }),
            ];
          }
        },
      }));

      const { registerTask } = await import('./task.js');
      const program = makeProgram();
      registerTask(program);

      await program.parseAsync(['node', 'test', 'task', 'tail']);
      const errOut = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
      expect(errOut).toContain('Multiple tasks are in-progress');
      expect(process.exitCode).toBe(1);
    });
  });
});
