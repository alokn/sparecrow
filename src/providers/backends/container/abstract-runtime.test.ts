/** Unit tests for AbstractContainerRuntime -- exec, execOrThrow, and all container operations. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

/** Creates a mock child process with stdout/stderr PassThrough streams. */
function createMockChild(): {
  child: EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    pid: number;
    kill: ReturnType<typeof vi.fn>;
  };
  emitClose: (code: number | null) => void;
  emitStdout: (data: string) => void;
  emitStderr: (data: string) => void;
  emitError: (err: NodeJS.ErrnoException) => void;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    pid: number;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 12345;
  child.kill = vi.fn(() => true);

  return {
    child,
    emitClose: (code: number | null) => child.emit('close', code),
    emitStdout: (data: string) => child.stdout.push(Buffer.from(data, 'utf-8')),
    emitStderr: (data: string) => child.stderr.push(Buffer.from(data, 'utf-8')),
    emitError: (err: NodeJS.ErrnoException) => child.emit('error', err),
  };
}

describe('AbstractContainerRuntime', () => {
  let spawnMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    spawnMock = vi.fn();
    vi.doMock('node:child_process', () => ({
      spawn: spawnMock,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Creates a concrete test implementation that extends AbstractContainerRuntime. */
  async function createTestRuntime() {
    const mod = await import('./abstract-runtime.js');
    const { AbstractContainerRuntime } = mod;

    class TestRuntime extends AbstractContainerRuntime {
      readonly name = 'test';
      get binary(): string {
        return 'test-binary';
      }
      buildInfoArgs() {
        return ['info', '--format', 'json'];
      }
      buildVersionArgs() {
        return ['version', '--format', 'json'];
      }
      parseStats(json: string) {
        try {
          const parsed: unknown = JSON.parse(json);
          if (typeof parsed !== 'object' || parsed === null) return null;
          return { cpuPercent: 0, memoryUsageMb: 0, memoryLimitMb: 0 };
        } catch {
          return null;
        }
      }
      async info() {
        const result = await this.execOrThrow(this.binary, this.buildVersionArgs());
        return { version: result.stdout.trim(), rootless: false };
      }

      // Expose protected methods for testing
      testExec(binary: string, args: string[], timeoutMs?: number) {
        return this.exec(binary, args, timeoutMs);
      }
      testExecOrThrow(binary: string, args: string[], timeoutMs?: number) {
        return this.execOrThrow(binary, args, timeoutMs);
      }
    }

    return new TestRuntime();
  }

  /** Helper to set up spawn mock that immediately resolves with stdout/stderr/exitCode. */
  function mockSpawnResult(opts: {
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
    enoent?: boolean;
  }) {
    const { child, emitClose, emitStdout, emitStderr, emitError } = createMockChild();
    spawnMock.mockImplementation(() => {
      process.nextTick(() => {
        if (opts.enoent) {
          const err = new Error('spawn ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          emitError(err);
          return;
        }
        if (opts.stdout) emitStdout(opts.stdout);
        if (opts.stderr) emitStderr(opts.stderr);
        emitClose(opts.exitCode ?? 0);
      });
      return child;
    });
    return { child };
  }

  // --- exec() tests ---

  describe('exec()', () => {
    it('captures stdout, stderr, and exitCode correctly', async () => {
      mockSpawnResult({ stdout: 'hello world\n', stderr: 'warning\n', exitCode: 0 });
      const runtime = await createTestRuntime();
      const result = await runtime.testExec('test-binary', ['arg1']);

      expect(result.stdout).toBe('hello world\n');
      expect(result.stderr).toBe('warning\n');
      expect(result.exitCode).toBe(0);
      expect(result.enoent).toBe(false);
    });

    it('resolves with enoent: true when spawn emits error with code ENOENT', async () => {
      mockSpawnResult({ enoent: true });
      const runtime = await createTestRuntime();
      const result = await runtime.testExec('nonexistent', ['info']);

      expect(result.enoent).toBe(true);
      expect(result.exitCode).toBeNull();
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    });

    it('resolves with non-zero exit code on command failure', async () => {
      mockSpawnResult({ stderr: 'something failed', exitCode: 1 });
      const runtime = await createTestRuntime();
      const result = await runtime.testExec('test-binary', ['bad-arg']);

      expect(result.exitCode).toBe(1);
      expect(result.enoent).toBe(false);
      expect(result.stderr).toBe('something failed');
    });

    it('resolves with exitCode: null and enoent: false when management command exceeds timeout', async () => {
      // Spawn a child that never emits close -- simulates a hanging command
      spawnMock.mockImplementation(() => {
        const { child } = createMockChild();
        // Never emit close -- the timeout fires instead
        return child;
      });
      const runtime = await createTestRuntime();
      // Pass a very short timeout (50ms) to trigger the internal timeout path
      const result = await runtime.testExec('test-binary', ['hang'], 50);

      expect(result.exitCode).toBeNull();
      expect(result.enoent).toBe(false);
    }, 5000);
  });

  // --- execOrThrow() tests ---

  describe('execOrThrow()', () => {
    it('throws ScrowError(CONTAINER_RUNTIME_ERROR) on non-zero exit code', async () => {
      mockSpawnResult({ stderr: 'container fail', exitCode: 1 });
      const runtime = await createTestRuntime();

      await expect(runtime.testExecOrThrow('test-binary', ['fail'])).rejects.toMatchObject({
        code: 'CONTAINER_RUNTIME_ERROR',
      });
    });

    it('throws ScrowError(CONTAINER_RUNTIME_ERROR) when enoent is true (binary not found)', async () => {
      mockSpawnResult({ enoent: true });
      const runtime = await createTestRuntime();

      await expect(runtime.testExecOrThrow('nonexistent', ['info'])).rejects.toMatchObject({
        code: 'CONTAINER_RUNTIME_ERROR',
      });
    });

    it('returns stdout and stderr on success', async () => {
      mockSpawnResult({ stdout: 'output\n', stderr: '', exitCode: 0 });
      const runtime = await createTestRuntime();

      const result = await runtime.testExecOrThrow('test-binary', ['arg']);
      expect(result.stdout).toBe('output\n');
      expect(result.stderr).toBe('');
    });

    it('throws ScrowError(TASK_TIMEOUT) when management command exceeds timeout (exitCode null, not enoent)', async () => {
      // Spawn a child that never emits close -- simulates timeout path in exec()
      spawnMock.mockImplementation(() => {
        const { child } = createMockChild();
        // Never emit close -- timeout fires and resolves with exitCode: null, enoent: false
        return child;
      });
      const runtime = await createTestRuntime();

      await expect(runtime.testExecOrThrow('test-binary', ['hang'], 50)).rejects.toMatchObject({
        code: 'TASK_TIMEOUT',
      });
    }, 5000);
  });

  // --- available() tests ---

  describe('available()', () => {
    it('returns true when binary info exits 0', async () => {
      mockSpawnResult({ stdout: '', exitCode: 0 });
      const runtime = await createTestRuntime();

      const result = await runtime.available();
      expect(result).toBe(true);
      expect(spawnMock).toHaveBeenCalledWith('test-binary', ['info'], expect.anything());
    });

    it('returns false when binary info exits non-zero', async () => {
      mockSpawnResult({ stderr: 'daemon not running', exitCode: 1 });
      const runtime = await createTestRuntime();

      const result = await runtime.available();
      expect(result).toBe(false);
    });

    it('returns false (does NOT throw) when binary is not on PATH (ENOENT)', async () => {
      mockSpawnResult({ enoent: true });
      const runtime = await createTestRuntime();

      const result = await runtime.available();
      expect(result).toBe(false);
    });
  });

  // --- run() tests ---

  describe('run()', () => {
    it('builds correct --detach args from ContainerRunOptions', async () => {
      mockSpawnResult({ stdout: 'abc123def456\n', exitCode: 0 });
      const runtime = await createTestRuntime();

      const result = await runtime.run({
        image: 'ubuntu:22.04',
        command: ['bash', '-c', 'echo hello'],
        cwd: '/workspace',
        env: { FOO: 'bar', BAZ: 'qux' },
        mounts: [
          { source: '/host/src', target: '/container/src', readonly: true },
          { source: '/host/data', target: '/container/data', readonly: false },
        ],
        memoryLimitMb: 512,
        cpuLimit: 2,
        networkMode: 'none',
        capDrop: ['ALL'],
        securityOpts: ['no-new-privileges'],
        tmpfsMounts: ['/tmp'],
        labels: { app: 'sparecrow', task: 'test' },
      });

      expect(result.containerId).toBe('abc123def456');

      const callArgs = spawnMock.mock.calls[0]!;
      const args = callArgs[1] as string[];

      expect(args[0]).toBe('run');
      expect(args[1]).toBe('--detach');
      expect(args).toContain('--workdir');
      expect(args[args.indexOf('--workdir') + 1]).toBe('/workspace');
      expect(args).toContain('--env');
      // Check env mappings exist
      expect(args).toContain('FOO=bar');
      expect(args).toContain('BAZ=qux');
      // Check mounts
      expect(args).toContain('/host/src:/container/src:ro');
      expect(args).toContain('/host/data:/container/data');
      // Check limits
      expect(args).toContain('--memory');
      expect(args).toContain('512m');
      expect(args).toContain('--cpus');
      expect(args).toContain('2');
      // Check network
      expect(args).toContain('--network');
      expect(args).toContain('none');
      // Check cap-drop
      expect(args).toContain('--cap-drop');
      expect(args).toContain('ALL');
      // Check security-opt
      expect(args).toContain('--security-opt');
      expect(args).toContain('no-new-privileges');
      // Check tmpfs
      expect(args).toContain('--tmpfs');
      expect(args).toContain('/tmp');
      // Check labels
      expect(args).toContain('--label');
      expect(args).toContain('app=sparecrow');
      expect(args).toContain('task=test');
      // Image and command at the end -- image must appear before first command arg
      expect(args).toContain('ubuntu:22.04');
      expect(args).toContain('bash');
      expect(args).toContain('-c');
      expect(args).toContain('echo hello');
      // Verify ordering: image immediately precedes command args
      expect(args.indexOf('ubuntu:22.04')).toBeLessThan(args.indexOf('bash'));
    });

    it('includes --user flag when user option is provided (AC8)', async () => {
      mockSpawnResult({ stdout: 'abc123\n', exitCode: 0 });
      const runtime = await createTestRuntime();

      await runtime.run({
        image: 'node:lts-slim',
        command: ['claude', '--print', 'test'],
        cwd: '/workspace',
        env: {},
        mounts: [],
        user: '1000:1000',
      });

      const callArgs = spawnMock.mock.calls[0]!;
      const args = callArgs[1] as string[];

      expect(args).toContain('--user');
      const userIdx = args.indexOf('--user');
      expect(args[userIdx + 1]).toBe('1000:1000');
      // --user must appear before the image name
      expect(userIdx).toBeLessThan(args.indexOf('node:lts-slim'));
    });

    it('omits optional flags when their ContainerRunOptions fields are undefined', async () => {
      mockSpawnResult({ stdout: 'container123\n', exitCode: 0 });
      const runtime = await createTestRuntime();

      await runtime.run({
        image: 'alpine:latest',
        command: ['sh'],
        cwd: '/work',
        env: {},
        mounts: [],
      });

      const callArgs = spawnMock.mock.calls[0]!;
      const args = callArgs[1] as string[];

      expect(args).not.toContain('--memory');
      expect(args).not.toContain('--cpus');
      expect(args).not.toContain('--network');
      expect(args).not.toContain('--cap-drop');
      expect(args).not.toContain('--security-opt');
      expect(args).not.toContain('--tmpfs');
      expect(args).not.toContain('--label');
      expect(args).not.toContain('--user');
    });

    it('extracts container ID from stdout (trims surrounding whitespace/newlines)', async () => {
      mockSpawnResult({ stdout: '  abc123def456  \n', exitCode: 0 });
      const runtime = await createTestRuntime();

      const result = await runtime.run({
        image: 'ubuntu:22.04',
        command: ['bash'],
        cwd: '/work',
        env: {},
        mounts: [],
      });

      expect(result.containerId).toBe('abc123def456');
    });

    it('throws ScrowError(CONTAINER_RUNTIME_ERROR) when run exits non-zero', async () => {
      mockSpawnResult({ stderr: 'invalid image name', exitCode: 125 });
      const runtime = await createTestRuntime();

      await expect(
        runtime.run({
          image: 'invalid!!!',
          command: ['bash'],
          cwd: '/work',
          env: {},
          mounts: [],
        }),
      ).rejects.toMatchObject({ code: 'CONTAINER_RUNTIME_ERROR' });
    });
  });

  // --- wait() tests ---

  describe('wait()', () => {
    it('returns exit code and OOM status when container exits normally', async () => {
      // First call: docker wait -> exit code in stdout
      // Second call: docker inspect -> OOM status
      let callCount = 0;
      spawnMock.mockImplementation(() => {
        const { child, emitClose, emitStdout } = createMockChild();
        callCount++;
        process.nextTick(() => {
          if (callCount === 1) {
            // docker wait
            emitStdout('0\n');
            emitClose(0);
          } else {
            // docker inspect --format '{{.State.OOMKilled}}'
            emitStdout('false\n');
            emitClose(0);
          }
        });
        return child;
      });

      const runtime = await createTestRuntime();
      const result = await runtime.wait('container123', 30000);

      expect(result.exitCode).toBe(0);
      expect(result.oomKilled).toBe(false);
    });

    it('returns oomKilled: true when inspect reports OOM', async () => {
      let callCount = 0;
      spawnMock.mockImplementation(() => {
        const { child, emitClose, emitStdout } = createMockChild();
        callCount++;
        process.nextTick(() => {
          if (callCount === 1) {
            emitStdout('137\n');
            emitClose(0);
          } else {
            emitStdout('true\n');
            emitClose(0);
          }
        });
        return child;
      });

      const runtime = await createTestRuntime();
      const result = await runtime.wait('container123', 30000);

      expect(result.exitCode).toBe(137);
      expect(result.oomKilled).toBe(true);
    });

    it('returns oomKilled: false when inspect call fails (container already removed)', async () => {
      let callCount = 0;
      spawnMock.mockImplementation(() => {
        const { child, emitClose, emitStdout, emitStderr } = createMockChild();
        callCount++;
        process.nextTick(() => {
          if (callCount === 1) {
            emitStdout('1\n');
            emitClose(0);
          } else {
            // Inspect fails because container was already removed
            emitStderr('no such container');
            emitClose(1);
          }
        });
        return child;
      });

      const runtime = await createTestRuntime();
      const result = await runtime.wait('container123', 30000);

      expect(result.exitCode).toBe(1);
      expect(result.oomKilled).toBe(false);
    });

    it('enforces timeout -- kills wait subprocess and throws ScrowError(TASK_TIMEOUT)', async () => {
      // The wait subprocess never exits, so it should be killed by timeout
      spawnMock.mockImplementation(() => {
        const { child } = createMockChild();
        // Never emit close -- simulates a long-running wait
        return child;
      });

      const runtime = await createTestRuntime();

      await expect(runtime.wait('container123', 100)).rejects.toMatchObject({
        code: 'TASK_TIMEOUT',
      });
    }, 10000);

    it('treats timeoutMs: 0 as no timeout (container exits naturally)', async () => {
      let callCount = 0;
      spawnMock.mockImplementation(() => {
        const { child, emitClose, emitStdout } = createMockChild();
        callCount++;
        // Delay to simulate real container exit
        setTimeout(() => {
          if (callCount === 1) {
            emitStdout('0\n');
            emitClose(0);
          } else {
            emitStdout('false\n');
            emitClose(0);
          }
        }, 50);
        return child;
      });

      const runtime = await createTestRuntime();
      const result = await runtime.wait('container123', 0);

      expect(result.exitCode).toBe(0);
      expect(result.oomKilled).toBe(false);
    });
  });

  // --- logs() tests ---

  describe('logs()', () => {
    it('returns separated stdout and stderr', async () => {
      const { child, emitClose, emitStdout, emitStderr } = createMockChild();
      spawnMock.mockImplementation(() => {
        process.nextTick(() => {
          emitStdout('log output\n');
          emitStderr('log error\n');
          emitClose(0);
        });
        return child;
      });

      const runtime = await createTestRuntime();
      const result = await runtime.logs('container123');

      expect(result.stdout).toBe('log output\n');
      expect(result.stderr).toBe('log error\n');
    });
  });

  // --- remove() tests ---

  describe('remove()', () => {
    it('calls rm --force on the container', async () => {
      mockSpawnResult({ stdout: '', exitCode: 0 });
      const runtime = await createTestRuntime();

      await runtime.remove('container123');

      const callArgs = spawnMock.mock.calls[0]!;
      expect(callArgs[1]).toEqual(['rm', '--force', 'container123']);
    });

    it('swallows "no such container" errors (case-insensitive)', async () => {
      mockSpawnResult({
        stderr: 'Error: No Such Container: container123',
        exitCode: 1,
      });
      const runtime = await createTestRuntime();

      // Should not throw
      await expect(runtime.remove('container123')).resolves.toBeUndefined();
    });

    it('throws ScrowError(CONTAINER_RUNTIME_ERROR) on other exec failures', async () => {
      mockSpawnResult({
        stderr: 'permission denied',
        exitCode: 1,
      });
      const runtime = await createTestRuntime();

      await expect(runtime.remove('container123')).rejects.toMatchObject({
        code: 'CONTAINER_RUNTIME_ERROR',
      });
    });
  });

  // --- stats() tests ---

  describe('stats()', () => {
    it('parses stats JSON and returns via parseStats()', async () => {
      mockSpawnResult({ stdout: '{"valid": true}\n', exitCode: 0 });
      const runtime = await createTestRuntime();

      const result = await runtime.stats('container123');

      expect(result).toEqual({ cpuPercent: 0, memoryUsageMb: 0, memoryLimitMb: 0 });
    });

    it('returns null when container is not running (non-zero exit code from stats)', async () => {
      mockSpawnResult({ stderr: 'container not running', exitCode: 1 });
      const runtime = await createTestRuntime();

      const result = await runtime.stats('container123');
      expect(result).toBeNull();
    });

    it('returns null when stats output is empty (container exited between call and response)', async () => {
      mockSpawnResult({ stdout: '', exitCode: 0 });
      const runtime = await createTestRuntime();

      const result = await runtime.stats('container123');
      expect(result).toBeNull();
    });

    it('returns null when stats output contains only whitespace', async () => {
      mockSpawnResult({ stdout: '  \n  \n', exitCode: 0 });
      const runtime = await createTestRuntime();

      const result = await runtime.stats('container123');
      expect(result).toBeNull();
    });
  });

  // --- list() tests (Task 10) ---

  describe('list()', () => {
    it('returns all containers with Docker JSON field names (10.1)', async () => {
      const dockerLine1 = JSON.stringify({
        ID: 'abc123def456',
        Image: 'node:lts-slim',
        CreatedAt: '2026-03-01 10:00:00',
        Status: 'Exited (0) 5 minutes ago',
        Names: 'sparecrow-task-1',
      });
      const dockerLine2 = JSON.stringify({
        ID: 'xyz789ghi012',
        Image: 'node:lts-slim',
        CreatedAt: '2026-03-01 11:00:00',
        Status: 'Running',
        Names: 'sparecrow-task-2',
      });
      mockSpawnResult({ stdout: `${dockerLine1}\n${dockerLine2}\n`, exitCode: 0 });
      const runtime = await createTestRuntime();

      const result = await runtime.list({ all: true });
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        containerId: 'abc123def456',
        image: 'node:lts-slim',
        createdAt: '2026-03-01 10:00:00',
        status: 'Exited (0) 5 minutes ago',
        names: 'sparecrow-task-1',
      });
      expect(result[1]).toEqual({
        containerId: 'xyz789ghi012',
        image: 'node:lts-slim',
        createdAt: '2026-03-01 11:00:00',
        status: 'Running',
        names: 'sparecrow-task-2',
      });
    });

    it('passes label filter to ps command args (10.2)', async () => {
      mockSpawnResult({ stdout: '', exitCode: 0 });
      const runtime = await createTestRuntime();

      await runtime.list({ label: 'sparecrow.managed=true' });

      expect(spawnMock).toHaveBeenCalledWith(
        'test-binary',
        ['ps', '--all', '--format', '{{json .}}', '--filter', 'label=sparecrow.managed=true'],
        expect.objectContaining({ shell: false }),
      );
    });

    it('parses Podman JSON output with field name differences (10.3)', async () => {
      const podmanLine = JSON.stringify({
        Id: 'pod123abc456',
        Image: 'node:lts-slim',
        Created: '2026-03-01 12:00:00',
        Status: 'exited',
        Names: 'sparecrow-task-3',
      });
      mockSpawnResult({ stdout: `${podmanLine}\n`, exitCode: 0 });
      const runtime = await createTestRuntime();

      const result = await runtime.list({ all: true });
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        containerId: 'pod123abc456',
        image: 'node:lts-slim',
        createdAt: '2026-03-01 12:00:00',
        status: 'exited',
        names: 'sparecrow-task-3',
      });
    });

    it('returns empty array when binary not found (ENOENT) (10.4)', async () => {
      mockSpawnResult({ enoent: true });
      const runtime = await createTestRuntime();

      const result = await runtime.list({ all: true });
      expect(result).toEqual([]);
    });

    it('returns empty array on parse failure (malformed JSON) (10.5)', async () => {
      mockSpawnResult({ stdout: '{ not valid json\n', exitCode: 0 });
      const runtime = await createTestRuntime();

      const result = await runtime.list({ all: true });
      expect(result).toEqual([]);
    });

    it('returns empty array when no containers match filter (10.6)', async () => {
      mockSpawnResult({ stdout: '', exitCode: 0 });
      const runtime = await createTestRuntime();

      const result = await runtime.list({ label: 'sparecrow.managed=true' });
      expect(result).toEqual([]);
    });

    it('omits --all flag when filter.all is false', async () => {
      mockSpawnResult({ stdout: '', exitCode: 0 });
      const runtime = await createTestRuntime();

      await runtime.list({ all: false });

      expect(spawnMock).toHaveBeenCalledWith(
        'test-binary',
        ['ps', '--format', '{{json .}}'],
        expect.objectContaining({ shell: false }),
      );
    });

    it('returns empty array when command returns non-zero exit code', async () => {
      mockSpawnResult({ stdout: '', stderr: 'error', exitCode: 1 });
      const runtime = await createTestRuntime();

      const result = await runtime.list({ all: true });
      expect(result).toEqual([]);
    });

    it('skips empty lines and partial JSON gracefully', async () => {
      const validLine = JSON.stringify({
        ID: 'abc123',
        Image: 'node:lts-slim',
        CreatedAt: '2026-03-01',
        Status: 'Running',
        Names: 'test',
      });
      mockSpawnResult({ stdout: `\n${validLine}\n{ broken \n\n`, exitCode: 0 });
      const runtime = await createTestRuntime();

      const result = await runtime.list({ all: true });
      expect(result).toHaveLength(1);
      expect(result[0]!.containerId).toBe('abc123');
    });
  });
});
