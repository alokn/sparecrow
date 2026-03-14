/** Unit tests for DockerRuntime -- name, info parsing, and stats parsing. */
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
    emitStderr: (_data: string) => child.stderr.push(Buffer.from(_data, 'utf-8')),
  };
}

describe('DockerRuntime', () => {
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

  async function loadDockerRuntime() {
    const mod = await import('./docker-runtime.js');
    return new mod.DockerRuntime();
  }

  it('returns "docker" as the runtime name', async () => {
    const runtime = await loadDockerRuntime();
    expect(runtime.name).toBe('docker');
  });

  describe('info()', () => {
    it('parses version from docker version output', async () => {
      let callCount = 0;
      spawnMock.mockImplementation(() => {
        const { child, emitClose, emitStdout } = createMockChild();
        callCount++;
        process.nextTick(() => {
          if (callCount === 1) {
            // docker version --format
            emitStdout('24.0.7\n');
            emitClose(0);
          } else {
            // docker info --format
            emitStdout('[name=rootless]\n');
            emitClose(0);
          }
        });
        return child;
      });

      const runtime = await loadDockerRuntime();
      const info = await runtime.info();

      expect(info.version).toBe('24.0.7');
      expect(info.rootless).toBe(true);
    });

    it('detects rootless from docker info output containing "rootless"', async () => {
      let callCount = 0;
      spawnMock.mockImplementation(() => {
        const { child, emitClose, emitStdout } = createMockChild();
        callCount++;
        process.nextTick(() => {
          if (callCount === 1) {
            emitStdout('25.0.0\n');
            emitClose(0);
          } else {
            emitStdout('[name=seccomp,name=rootless,name=apparmor]\n');
            emitClose(0);
          }
        });
        return child;
      });

      const runtime = await loadDockerRuntime();
      const info = await runtime.info();
      expect(info.rootless).toBe(true);
    });

    it('detects non-rootless when "rootless" is absent from security options', async () => {
      let callCount = 0;
      spawnMock.mockImplementation(() => {
        const { child, emitClose, emitStdout } = createMockChild();
        callCount++;
        process.nextTick(() => {
          if (callCount === 1) {
            emitStdout('24.0.7\n');
            emitClose(0);
          } else {
            emitStdout('[name=seccomp,name=apparmor]\n');
            emitClose(0);
          }
        });
        return child;
      });

      const runtime = await loadDockerRuntime();
      const info = await runtime.info();
      expect(info.rootless).toBe(false);
    });
  });

  describe('parseStats()', () => {
    it('parses Docker JSON stats format correctly', async () => {
      const runtime = await loadDockerRuntime();
      const stats = runtime.parseStats(
        JSON.stringify({
          CPUPerc: '0.50%',
          MemUsage: '1.5MiB / 512MiB',
          MemPerc: '0.29%',
        }),
      );

      expect(stats).not.toBeNull();
      expect(stats!.cpuPercent).toBeCloseTo(0.5);
      expect(stats!.memoryUsageMb).toBeCloseTo(1.5);
      expect(stats!.memoryLimitMb).toBeCloseTo(512);
    });

    it('parses GiB memory values', async () => {
      const runtime = await loadDockerRuntime();
      const stats = runtime.parseStats(
        JSON.stringify({
          CPUPerc: '5.00%',
          MemUsage: '2GiB / 8GiB',
        }),
      );

      expect(stats).not.toBeNull();
      expect(stats!.memoryUsageMb).toBeCloseTo(2048);
      expect(stats!.memoryLimitMb).toBeCloseTo(8192);
    });

    it('returns null for malformed JSON input', async () => {
      const runtime = await loadDockerRuntime();
      const stats = runtime.parseStats('not valid json {{{');
      expect(stats).toBeNull();
    });

    it('returns null for empty JSON input', async () => {
      const runtime = await loadDockerRuntime();
      const stats = runtime.parseStats('');
      expect(stats).toBeNull();
    });

    it('returns null when CPUPerc is missing', async () => {
      const runtime = await loadDockerRuntime();
      const stats = runtime.parseStats(JSON.stringify({ MemUsage: '1MiB / 512MiB' }));
      expect(stats).toBeNull();
    });

    it('returns null when MemUsage has unexpected format', async () => {
      const runtime = await loadDockerRuntime();
      const stats = runtime.parseStats(JSON.stringify({ CPUPerc: '0.50%', MemUsage: 'invalid' }));
      expect(stats).toBeNull();
    });

    it('returns null for non-object JSON input', async () => {
      const runtime = await loadDockerRuntime();
      expect(runtime.parseStats('"string"')).toBeNull();
      expect(runtime.parseStats('42')).toBeNull();
      expect(runtime.parseStats('null')).toBeNull();
    });
  });
});
