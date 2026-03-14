/** Unit tests for PodmanRuntime -- name, info parsing, and stats parsing. */
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

describe('PodmanRuntime', () => {
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

  async function loadPodmanRuntime() {
    const mod = await import('./podman-runtime.js');
    return new mod.PodmanRuntime();
  }

  it('returns "podman" as the runtime name', async () => {
    const runtime = await loadPodmanRuntime();
    expect(runtime.name).toBe('podman');
  });

  describe('info()', () => {
    it('parses version from podman version output', async () => {
      let callCount = 0;
      spawnMock.mockImplementation(() => {
        const { child, emitClose, emitStdout } = createMockChild();
        callCount++;
        process.nextTick(() => {
          if (callCount === 1) {
            // podman version --format
            emitStdout('4.9.0\n');
            emitClose(0);
          } else {
            // podman info --format
            emitStdout('true\n');
            emitClose(0);
          }
        });
        return child;
      });

      const runtime = await loadPodmanRuntime();
      const info = await runtime.info();

      expect(info.version).toBe('4.9.0');
      expect(info.rootless).toBe(true);
    });

    it('detects rootless when podman info returns "true"', async () => {
      let callCount = 0;
      spawnMock.mockImplementation(() => {
        const { child, emitClose, emitStdout } = createMockChild();
        callCount++;
        process.nextTick(() => {
          if (callCount === 1) {
            emitStdout('5.0.0\n');
            emitClose(0);
          } else {
            emitStdout('true\n');
            emitClose(0);
          }
        });
        return child;
      });

      const runtime = await loadPodmanRuntime();
      const info = await runtime.info();
      expect(info.rootless).toBe(true);
    });

    it('detects non-rootless when podman info returns "false"', async () => {
      let callCount = 0;
      spawnMock.mockImplementation(() => {
        const { child, emitClose, emitStdout } = createMockChild();
        callCount++;
        process.nextTick(() => {
          if (callCount === 1) {
            emitStdout('4.9.0\n');
            emitClose(0);
          } else {
            emitStdout('false\n');
            emitClose(0);
          }
        });
        return child;
      });

      const runtime = await loadPodmanRuntime();
      const info = await runtime.info();
      expect(info.rootless).toBe(false);
    });
  });

  describe('parseStats()', () => {
    it('parses Podman JSON stats format correctly (numeric byte fields)', async () => {
      const runtime = await loadPodmanRuntime();
      const stats = runtime.parseStats(
        JSON.stringify({
          cpu_percent: 2.5,
          mem_usage: 1_572_864, // 1.5 MiB in bytes
          mem_limit: 536_870_912, // 512 MiB in bytes
        }),
      );

      expect(stats).not.toBeNull();
      expect(stats!.cpuPercent).toBeCloseTo(2.5);
      expect(stats!.memoryUsageMb).toBeCloseTo(1.5);
      expect(stats!.memoryLimitMb).toBeCloseTo(512);
    });

    it('handles zero values', async () => {
      const runtime = await loadPodmanRuntime();
      const stats = runtime.parseStats(
        JSON.stringify({
          cpu_percent: 0,
          mem_usage: 0,
          mem_limit: 536_870_912,
        }),
      );

      expect(stats).not.toBeNull();
      expect(stats!.cpuPercent).toBe(0);
      expect(stats!.memoryUsageMb).toBe(0);
    });

    it('returns null for malformed JSON input', async () => {
      const runtime = await loadPodmanRuntime();
      const stats = runtime.parseStats('not valid json {{{');
      expect(stats).toBeNull();
    });

    it('returns null for empty JSON input', async () => {
      const runtime = await loadPodmanRuntime();
      const stats = runtime.parseStats('');
      expect(stats).toBeNull();
    });

    it('returns null when cpu_percent is missing', async () => {
      const runtime = await loadPodmanRuntime();
      const stats = runtime.parseStats(JSON.stringify({ mem_usage: 1000, mem_limit: 2000 }));
      expect(stats).toBeNull();
    });

    it('returns null when mem_usage is not a number', async () => {
      const runtime = await loadPodmanRuntime();
      const stats = runtime.parseStats(
        JSON.stringify({ cpu_percent: 1.0, mem_usage: 'invalid', mem_limit: 2000 }),
      );
      expect(stats).toBeNull();
    });

    it('returns null for non-object JSON input', async () => {
      const runtime = await loadPodmanRuntime();
      expect(runtime.parseStats('"string"')).toBeNull();
      expect(runtime.parseStats('42')).toBeNull();
      expect(runtime.parseStats('null')).toBeNull();
    });
  });
});
