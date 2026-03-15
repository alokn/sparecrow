/** Unit tests for spawnWithGuardrails — timeout, cancellation, and output capture. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

/**
 * Create a mock child process EventEmitter with stdout, stderr, pid, and kill.
 * Uses PassThrough streams so data events work correctly regardless of listener
 * registration order — avoids fragility from flowing-mode timing.
 */
function createMockChild(opts?: { killBehavior?: 'success' | 'throw-all' | 'throw-sigterm' }): {
  child: EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    pid: number;
    kill: ReturnType<typeof vi.fn>;
  };
  emitExit: (code: number | null) => void;
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
  // PassThrough streams buffer data until consumed — safe with any listener order
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 99999;

  const behavior = opts?.killBehavior ?? 'success';
  let sigtermCalled = false;

  child.kill = vi.fn((signal: string) => {
    if (behavior === 'throw-all') {
      const err = new Error('Operation not permitted') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    }
    if (behavior === 'throw-sigterm' && signal === 'SIGTERM' && !sigtermCalled) {
      sigtermCalled = true;
      const err = new Error('Operation not permitted') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    }
    return true;
  });

  return {
    child,
    emitExit: (code: number | null) => child.emit('exit', code),
    emitClose: (code: number | null) => child.emit('close', code),
    emitStdout: (data: string) => child.stdout.push(Buffer.from(data, 'utf-8')),
    emitStderr: (data: string) => child.stderr.push(Buffer.from(data, 'utf-8')),
  };
}

describe('spawnWithGuardrails', () => {
  // --- Integration tests (real child processes) ---

  it('captures stdout on successful exit', async () => {
    const { spawnWithGuardrails } = await import('./process.js');
    const result = await spawnWithGuardrails('node', ['-e', 'process.stdout.write("hello")'], {
      timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello');
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
  });

  it('captures stderr on successful exit', async () => {
    const { spawnWithGuardrails } = await import('./process.js');
    const result = await spawnWithGuardrails('node', ['-e', 'process.stderr.write("err")'], {
      timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('err');
  });

  it('calls onChunk for stdout data', async () => {
    const { spawnWithGuardrails } = await import('./process.js');
    const chunks: Array<{ chunk: string; stream: 'stdout' | 'stderr' }> = [];
    const result = await spawnWithGuardrails('node', ['-e', 'process.stdout.write("chunk1")'], {
      timeoutMs: 5000,
      onChunk: (chunk, stream) => {
        chunks.push({ chunk, stream });
      },
    });
    expect(result.exitCode).toBe(0);
    expect(chunks.some((c) => c.stream === 'stdout' && c.chunk.includes('chunk1'))).toBe(true);
  });

  it('calls onChunk for stderr data', async () => {
    const { spawnWithGuardrails } = await import('./process.js');
    const chunks: Array<{ chunk: string; stream: 'stdout' | 'stderr' }> = [];
    await spawnWithGuardrails('node', ['-e', 'process.stderr.write("err-chunk")'], {
      timeoutMs: 5000,
      onChunk: (chunk, stream) => {
        chunks.push({ chunk, stream });
      },
    });
    expect(chunks.some((c) => c.stream === 'stderr' && c.chunk.includes('err-chunk'))).toBe(true);
  });

  it('swallows errors thrown by onChunk without breaking execution', async () => {
    const { spawnWithGuardrails } = await import('./process.js');
    // onChunk that always throws — should NOT break execution
    const result = await spawnWithGuardrails(
      'node',
      ['-e', 'process.stdout.write("output"); process.exit(0)'],
      {
        timeoutMs: 5000,
        onChunk: () => {
          throw new Error('onChunk error');
        },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('output');
  });

  it('returns non-zero exitCode on failure', async () => {
    const { spawnWithGuardrails } = await import('./process.js');
    const result = await spawnWithGuardrails('node', ['-e', 'process.exit(1)'], {
      timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
  });

  it('sets timedOut and terminates child when timeout expires', async () => {
    const { spawnWithGuardrails } = await import('./process.js');
    const result = await spawnWithGuardrails('node', ['-e', 'setInterval(()=>{},1000)'], {
      timeoutMs: 200,
    });
    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
  }, 10000);

  it('sets aborted and terminates child when external AbortSignal fires', async () => {
    const { spawnWithGuardrails } = await import('./process.js');
    const controller = new AbortController();
    const promise = spawnWithGuardrails('node', ['-e', 'setInterval(()=>{},1000)'], {
      timeoutMs: 10000,
      signal: controller.signal,
    });
    // Abort after a brief delay to let the child start
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();
    const result = await promise;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
  }, 10000);

  it('resolves with aborted=true when signal is already aborted before spawn', async () => {
    const { spawnWithGuardrails } = await import('./process.js');
    const controller = new AbortController();
    controller.abort();
    const result = await spawnWithGuardrails('node', ['-e', 'setInterval(()=>{},1000)'], {
      timeoutMs: 10000,
      signal: controller.signal,
    });
    expect(result.aborted).toBe(true);
  }, 10000);

  it('bounds stdout/stderr to last 10 KB on failure', async () => {
    const { spawnWithGuardrails } = await import('./process.js');
    // Write more than 10 KB to stdout then exit non-zero
    const script = `
      const chunk = 'x'.repeat(1024);
      for (let i = 0; i < 12; i++) process.stdout.write(chunk);
      process.exit(1);
    `;
    const result = await spawnWithGuardrails('node', ['-e', script], { timeoutMs: 5000 });
    expect(result.exitCode).toBe(1);
    // Bounded to 10 KB (10 * 1024 bytes)
    expect(Buffer.byteLength(result.stdout, 'utf-8')).toBeLessThanOrEqual(10 * 1024);
  });

  it('preserves stdout on success up to 50 KB cap', async () => {
    const { spawnWithGuardrails } = await import('./process.js');
    // Write exactly 5 KB (under the 50 KB success cap)
    const script = `process.stdout.write('a'.repeat(5120)); process.exit(0);`;
    const result = await spawnWithGuardrails('node', ['-e', script], { timeoutMs: 5000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBe(5120);
  });

  it('bounds stdout to 50 KB on success with very large output', async () => {
    const { spawnWithGuardrails } = await import('./process.js');
    // Write 60 KB to stdout then exit zero — should be capped at 50 KB
    const script = `process.stdout.write('b'.repeat(60 * 1024)); process.exit(0);`;
    const result = await spawnWithGuardrails('node', ['-e', script], { timeoutMs: 10000 });
    expect(result.exitCode).toBe(0);
    expect(Buffer.byteLength(result.stdout, 'utf-8')).toBeLessThanOrEqual(50 * 1024);
  }, 15000);

  it('passes cwd to child process', async () => {
    const { realpathSync } = await import('node:fs');
    const resolvedTmp = realpathSync('/tmp');
    const { spawnWithGuardrails } = await import('./process.js');
    const result = await spawnWithGuardrails(
      'node',
      ['-e', 'process.stdout.write(process.cwd())'],
      {
        cwd: resolvedTmp,
        timeoutMs: 5000,
      },
    );
    expect(result.stdout).toBe(resolvedTmp);
  });

  it('sets enoent=true and resolves when binary does not exist', async () => {
    const { spawnWithGuardrails } = await import('./process.js');
    const result = await spawnWithGuardrails('/nonexistent/binary/that/does/not/exist', [], {
      timeoutMs: 5000,
    });
    expect(result.enoent).toBe(true);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
  });

  it('sets enoent=false on successful exit', async () => {
    const { spawnWithGuardrails } = await import('./process.js');
    const result = await spawnWithGuardrails('node', ['-e', 'process.exit(0)'], {
      timeoutMs: 5000,
    });
    expect(result.enoent).toBe(false);
  });

  it('does not time out when timeoutMs is 0 (no timeout enforcement)', async () => {
    const { spawnWithGuardrails } = await import('./process.js');
    // Child sleeps 200ms then exits — with timeoutMs=0 it should NOT be killed
    const result = await spawnWithGuardrails(
      'node',
      ['-e', 'setTimeout(() => { process.stdout.write("done"); process.exit(0); }, 200)'],
      { timeoutMs: 0 },
    );
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('done');
  }, 10000);

  it('still supports abort signal when timeoutMs is 0', async () => {
    const { spawnWithGuardrails } = await import('./process.js');
    const controller = new AbortController();
    const promise = spawnWithGuardrails('node', ['-e', 'setInterval(()=>{},1000)'], {
      timeoutMs: 0,
      signal: controller.signal,
    });
    // Abort after a brief delay
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();
    const result = await promise;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
  }, 10000);
});

describe('spawnWithGuardrails kill-path resilience', () => {
  let loggerWarnCalls: Array<{ event: string; data: Record<string, unknown> }>;
  let loggerInfoCalls: Array<{ event: string; data: Record<string, unknown> }>;
  let loggerErrorCalls: Array<{
    event: string;
    data: Record<string, unknown>;
    err?: Error | undefined;
  }>;

  beforeEach(() => {
    vi.useFakeTimers();
    loggerWarnCalls = [];
    loggerInfoCalls = [];
    loggerErrorCalls = [];

    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function importWithMocks(
    mockChild: ReturnType<typeof createMockChild>['child'],
  ): Promise<{ spawnWithGuardrails: typeof import('./process.js').spawnWithGuardrails }> {
    vi.doMock('node:child_process', () => ({
      spawn: () => mockChild,
    }));

    vi.doMock('./logger.js', () => ({
      logger: {
        debug: vi.fn(async (_event: string, _data: Record<string, unknown>) => {
          /* noop */
        }),
        info: vi.fn(async (event: string, data: Record<string, unknown>) => {
          loggerInfoCalls.push({ event, data });
        }),
        warn: vi.fn(async (event: string, data: Record<string, unknown>) => {
          loggerWarnCalls.push({ event, data });
        }),
        error: vi.fn(async (event: string, data: Record<string, unknown>, err?: Error) => {
          loggerErrorCalls.push({ event, data, err });
        }),
      },
    }));

    // Mock /proc reads to return null (avoid real FS calls)
    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn(async () => {
        throw new Error('ENOENT');
      }),
    }));

    return import('./process.js');
  }

  it('schedules SIGKILL when SIGTERM throws', async () => {
    const { child, emitClose } = createMockChild({ killBehavior: 'throw-sigterm' });
    const { spawnWithGuardrails } = await importWithMocks(child);

    const promise = spawnWithGuardrails('test-cmd', [], { timeoutMs: 100 });

    // Advance past the timeout
    await vi.advanceTimersByTimeAsync(100);

    // SIGTERM was attempted (and threw)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    // Logger should have logged SIGTERM failure
    expect(loggerErrorCalls.some((c) => c.event === 'process.sigterm-failed')).toBe(true);

    // Advance past the SIGKILL grace period
    await vi.advanceTimersByTimeAsync(5000);

    // SIGKILL was still scheduled and sent
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(loggerInfoCalls.some((c) => c.event === 'process.sigkill-sent')).toBe(true);

    // Now emit close to resolve
    emitClose(null);

    const result = await promise;
    expect(result.timedOut).toBe(true);
  }, 30000);

  it('resolves with timedOut when both SIGTERM and SIGKILL throw', async () => {
    const { child } = createMockChild({ killBehavior: 'throw-all' });
    const { spawnWithGuardrails } = await importWithMocks(child);

    const promise = spawnWithGuardrails('test-cmd', [], { timeoutMs: 100 });

    // Advance past the timeout
    await vi.advanceTimersByTimeAsync(100);

    // SIGTERM was attempted and threw
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(loggerErrorCalls.some((c) => c.event === 'process.sigterm-failed')).toBe(true);

    // Advance past the SIGKILL grace period
    await vi.advanceTimersByTimeAsync(5000);

    // SIGKILL was attempted and also threw
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(loggerErrorCalls.some((c) => c.event === 'process.sigkill-failed')).toBe(true);

    // Advance past the final deadline
    await vi.advanceTimersByTimeAsync(10000);

    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  }, 30000);

  it('resolves after exit event when close does not fire', async () => {
    const { child, emitExit } = createMockChild();
    const { spawnWithGuardrails } = await importWithMocks(child);

    const promise = spawnWithGuardrails('test-cmd', [], { timeoutMs: 100 });

    // Advance past timeout to trigger kill
    await vi.advanceTimersByTimeAsync(100);

    // Simulate exit event without close
    emitExit(137);

    // Advance past the exit-close grace period (5 seconds)
    await vi.advanceTimersByTimeAsync(5000);

    const result = await promise;
    expect(result.exitCode).toBe(137);
    expect(result.timedOut).toBe(true);
  }, 30000);

  it('resolves normally via close event (normal timeout path)', async () => {
    const { child, emitExit, emitClose } = createMockChild();
    const { spawnWithGuardrails } = await importWithMocks(child);

    const promise = spawnWithGuardrails('test-cmd', [], { timeoutMs: 100 });

    // Advance past the timeout
    await vi.advanceTimersByTimeAsync(100);

    // SIGTERM sent
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    // Normal close sequence
    emitExit(null);
    emitClose(null);

    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  }, 30000);

  it('includes lastOutputAgoMs in timeout log entry', async () => {
    const { child, emitClose, emitStdout } = createMockChild();
    const { spawnWithGuardrails } = await importWithMocks(child);

    const promise = spawnWithGuardrails('test-cmd', [], { timeoutMs: 200 });

    // Emit some stdout data at t=50ms
    await vi.advanceTimersByTimeAsync(50);
    emitStdout('some output');

    // Advance to timeout at t=200ms (150ms after last output)
    await vi.advanceTimersByTimeAsync(150);

    // Allow the async diagnostics collection (mocked to reject) to settle
    await vi.runAllTimersAsync();

    // Check that the timeout log entry includes lastOutputAgoMs
    const timeoutLog = loggerWarnCalls.find((c) => c.event === 'process.timeout-fired');
    expect(timeoutLog).toBeDefined();
    expect(timeoutLog!.data.lastOutputAgoMs).toBeTypeOf('number');
    expect(timeoutLog!.data.lastOutputAgoMs).toBeGreaterThanOrEqual(100);

    // Clean up by emitting close
    emitClose(null);
    await promise;
  }, 30000);

  it('logs process.sigterm-sent on successful SIGTERM', async () => {
    const { child, emitClose } = createMockChild({ killBehavior: 'success' });
    const { spawnWithGuardrails } = await importWithMocks(child);

    const promise = spawnWithGuardrails('test-cmd', [], { timeoutMs: 100 });

    // Advance past the timeout
    await vi.advanceTimersByTimeAsync(100);

    expect(loggerInfoCalls.some((c) => c.event === 'process.sigterm-sent')).toBe(true);

    emitClose(null);
    await promise;
  }, 30000);

  it('logs process.timeout-fired with pid, command and aborted=false on timeout', async () => {
    const { child, emitClose } = createMockChild();
    const { spawnWithGuardrails } = await importWithMocks(child);

    const promise = spawnWithGuardrails('my-command', ['--flag'], { timeoutMs: 100 });

    // Advance past the timeout
    await vi.advanceTimersByTimeAsync(100);

    // Allow the async diagnostics collection to settle
    await vi.runAllTimersAsync();

    const timeoutLog = loggerWarnCalls.find((c) => c.event === 'process.timeout-fired');
    expect(timeoutLog).toBeDefined();
    expect(timeoutLog!.data.pid).toBe(99999);
    expect(timeoutLog!.data.command).toBe('my-command');
    expect(timeoutLog!.data.timeoutMs).toBe(100);
    expect(timeoutLog!.data.timedOut).toBe(true);
    expect(timeoutLog!.data.aborted).toBe(false);

    emitClose(null);
    await promise;
  }, 30000);

  it('logs process.child-exited on timedOut kill path', async () => {
    const { child, emitClose } = createMockChild();
    const { spawnWithGuardrails } = await importWithMocks(child);

    const promise = spawnWithGuardrails('test-cmd', [], { timeoutMs: 100 });

    await vi.advanceTimersByTimeAsync(100);
    emitClose(null);

    await promise;
    expect(
      loggerInfoCalls.some((c) => c.event === 'process.child-exited' && c.data.timedOut === true),
    ).toBe(true);
  }, 30000);

  // [Medium-3] AC3: meaningful assertion that spawn is called without stdio:'inherit' and without detached:true
  it('calls spawn without stdio set to "inherit" and without detached=true (AC3, Story 12.6)', async () => {
    let capturedSpawnOptions: Record<string, unknown> | undefined;
    const { child, emitClose } = createMockChild();

    vi.resetModules();
    vi.doMock('node:child_process', () => ({
      spawn: (_cmd: string, _args: string[], opts: Record<string, unknown>) => {
        capturedSpawnOptions = opts;
        return child;
      },
    }));
    vi.doMock('./logger.js', () => ({
      logger: {
        debug: vi.fn(async () => {
          /* noop */
        }),
        info: vi.fn(async () => {
          /* noop */
        }),
        warn: vi.fn(async () => {
          /* noop */
        }),
        error: vi.fn(async () => {
          /* noop */
        }),
      },
    }));
    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn(async () => {
        throw new Error('ENOENT');
      }),
    }));

    const { spawnWithGuardrails } = await import('./process.js');
    const promise = spawnWithGuardrails('test-cmd', [], { timeoutMs: 5000 });

    emitClose(0);
    await promise;

    // The spawn call must not set stdio to 'inherit' (would leak FDs)
    expect(capturedSpawnOptions).toBeDefined();
    expect(capturedSpawnOptions!['stdio']).not.toBe('inherit');
    // The spawn call must not set detached to true (parent must manage child lifecycle)
    expect(capturedSpawnOptions!['detached']).not.toBe(true);
  }, 30000);

  it('logs process.timeout-fired with aborted=true when triggered via AbortSignal', async () => {
    const { child, emitClose } = createMockChild({ killBehavior: 'success' });
    const { spawnWithGuardrails } = await importWithMocks(child);

    const controller = new AbortController();
    const promise = spawnWithGuardrails('abort-cmd', ['--x'], {
      timeoutMs: 10000,
      signal: controller.signal,
    });

    // Abort after a short delay
    await vi.advanceTimersByTimeAsync(50);
    controller.abort();

    // Allow async diagnostics to settle
    await vi.runAllTimersAsync();

    // Verify SIGTERM was sent on the abort path
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(loggerInfoCalls.some((c) => c.event === 'process.sigterm-sent')).toBe(true);

    // Verify timeout-fired log entry was emitted with aborted=true
    const abortLog = loggerWarnCalls.find((c) => c.event === 'process.timeout-fired');
    expect(abortLog).toBeDefined();
    expect(abortLog!.data.aborted).toBe(true);
    expect(abortLog!.data.timedOut).toBe(false);
    expect(abortLog!.data.command).toBe('abort-cmd');

    emitClose(null);
    await promise;
  }, 30000);
});

/**
 * Flush the microtask queue to allow pending async operations
 * (like health check's readProcStat → readFile) to complete
 * when using fake timers.
 */
async function flushMicrotasks(): Promise<void> {
  // Multiple rounds to flush chained awaits within performHealthCheck
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe('spawnWithGuardrails health check monitoring', () => {
  let loggerWarnCalls: Array<{ event: string; data: Record<string, unknown> }>;
  let loggerDebugCalls: Array<{ event: string; data: Record<string, unknown> }>;
  let loggerInfoCalls: Array<{ event: string; data: Record<string, unknown> }>;
  let loggerErrorCalls: Array<{
    event: string;
    data: Record<string, unknown>;
    err?: Error | undefined;
  }>;

  beforeEach(() => {
    vi.useFakeTimers();
    loggerWarnCalls = [];
    loggerDebugCalls = [];
    loggerInfoCalls = [];
    loggerErrorCalls = [];
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * Import with mocks that support configurable /proc/<pid>/stat responses.
   * readFileFn controls what readFile returns for health check CPU sampling.
   */
  async function importWithHealthMocks(
    mockChild: ReturnType<typeof createMockChild>['child'],
    readFileFn?: (path: string) => Promise<string>,
  ): Promise<{ spawnWithGuardrails: typeof import('./process.js').spawnWithGuardrails }> {
    vi.doMock('node:child_process', () => ({
      spawn: () => mockChild,
    }));

    vi.doMock('./logger.js', () => ({
      logger: {
        debug: vi.fn(async (event: string, data: Record<string, unknown>) => {
          loggerDebugCalls.push({ event, data });
        }),
        info: vi.fn(async (event: string, data: Record<string, unknown>) => {
          loggerInfoCalls.push({ event, data });
        }),
        warn: vi.fn(async (event: string, data: Record<string, unknown>) => {
          loggerWarnCalls.push({ event, data });
        }),
        error: vi.fn(async (event: string, data: Record<string, unknown>, err?: Error) => {
          loggerErrorCalls.push({ event, data, err });
        }),
      },
    }));

    const defaultReadFile = async (): Promise<string> => {
      throw new Error('ENOENT');
    };

    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn(readFileFn ?? defaultReadFile),
    }));

    return import('./process.js');
  }

  /** Build a mock /proc/<pid>/stat line with specified utime, stime, and rss. */
  function makeProcStat(utime: number, stime: number, rss: number): string {
    // Format: pid (comm) state ppid pgrp session tty_nr tpgid flags minflt cminflt majflt cmajflt utime stime ...
    // fields[11]=utime, fields[12]=stime after the close-paren + state
    // We need: state + 10 filler fields before utime, then utime, stime, then 8 filler fields before rss
    const filler10 = '0 0 0 0 0 0 0 0 0 0'; // fields[1]..fields[10]
    const filler8 = '0 0 0 0 0 0 0 0'; // fields[13]..fields[20]
    return `99999 (test-cmd) S ${filler10} ${utime} ${stime} ${filler8} ${rss}`;
  }

  it('emits child-idle warning after 2 consecutive idle checks with no output and no CPU delta', async () => {
    const procStatLine = makeProcStat(100, 50, 4096);
    const { child, emitClose } = createMockChild();
    const { spawnWithGuardrails } = await importWithHealthMocks(child, async () => procStatLine);

    const promise = spawnWithGuardrails('test-cmd', [], {
      timeoutMs: 0,
      healthCheckIntervalMs: 1000,
    });

    // First health check at t=1000 — establishes CPU baseline, cannot detect idle yet
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    expect(loggerWarnCalls.filter((c) => c.event === 'task.executor.child-idle')).toHaveLength(0);

    // Second health check at t=2000 — CPU unchanged, no output → first consecutive idle
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    expect(loggerWarnCalls.filter((c) => c.event === 'task.executor.child-idle')).toHaveLength(0);

    // Third health check at t=3000 — CPU still unchanged, no output → 2nd consecutive idle → warning
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    const idleWarnings = loggerWarnCalls.filter((c) => c.event === 'task.executor.child-idle');
    expect(idleWarnings).toHaveLength(1);
    expect(idleWarnings[0]!.data.pid).toBe(99999);
    expect(idleWarnings[0]!.data.consecutiveIdleChecks).toBe(2);
    expect(idleWarnings[0]!.data.idleDurationMs).toBeTypeOf('number');
    expect(idleWarnings[0]!.data.rssPages).toBe(4096);

    // Clean up
    emitClose(0);
    await promise;
  }, 30000);

  it('does not emit child-idle warning when child produces output between checks', async () => {
    const procStatLine = makeProcStat(100, 50, 4096);
    const { child, emitClose, emitStdout } = createMockChild();
    const { spawnWithGuardrails } = await importWithHealthMocks(child, async () => procStatLine);

    const promise = spawnWithGuardrails('test-cmd', [], {
      timeoutMs: 0,
      healthCheckIntervalMs: 1000,
    });

    // First health check at t=1000 — baseline
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    // Second check at t=2000 — first idle (CPU unchanged, no output)
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    expect(loggerWarnCalls.filter((c) => c.event === 'task.executor.child-idle')).toHaveLength(0);

    // Child produces output between checks — resets idle counter
    emitStdout('some output');

    // Third health check at t=3000 — output was received since last check, NOT idle, counter reset
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    expect(loggerWarnCalls.filter((c) => c.event === 'task.executor.child-idle')).toHaveLength(0);

    // Fourth check at t=4000 — first idle after reset
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    expect(loggerWarnCalls.filter((c) => c.event === 'task.executor.child-idle')).toHaveLength(0);

    // Fifth check at t=5000 — second consecutive idle → warning
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    expect(loggerWarnCalls.filter((c) => c.event === 'task.executor.child-idle')).toHaveLength(1);

    emitClose(0);
    await promise;
  }, 30000);

  it('does not emit child-idle warning when CPU time increases between checks', async () => {
    let cpuTicks = 100;
    const { child, emitClose } = createMockChild();
    const { spawnWithGuardrails } = await importWithHealthMocks(child, async () => {
      cpuTicks += 10; // CPU advances each time /proc is read
      return makeProcStat(cpuTicks, 50, 4096);
    });

    const promise = spawnWithGuardrails('test-cmd', [], {
      timeoutMs: 0,
      healthCheckIntervalMs: 1000,
    });

    // Run 5 health checks — CPU always advancing, no output
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      await flushMicrotasks();
    }

    // No idle warning because CPU changed every check
    expect(loggerWarnCalls.filter((c) => c.event === 'task.executor.child-idle')).toHaveLength(0);

    emitClose(0);
    await promise;
  }, 30000);

  it('cleans up health check interval on child exit (no leaked timers)', async () => {
    const procStatLine = makeProcStat(100, 50, 4096);
    const { child, emitClose } = createMockChild();
    const { spawnWithGuardrails } = await importWithHealthMocks(child, async () => procStatLine);

    const promise = spawnWithGuardrails('test-cmd', [], {
      timeoutMs: 0,
      healthCheckIntervalMs: 1000,
    });

    // First health check fires
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    // Child exits normally
    emitClose(0);
    const result = await promise;
    expect(result.exitCode).toBe(0);

    // Clear any pending logger calls
    loggerWarnCalls.length = 0;
    loggerDebugCalls.length = 0;

    // Advance time well past when another health check would fire
    await vi.advanceTimersByTimeAsync(5000);
    await flushMicrotasks();

    // No additional health check warnings should have been emitted after cleanup
    expect(loggerWarnCalls.filter((c) => c.event === 'task.executor.child-idle')).toHaveLength(0);
  }, 30000);

  it('degrades gracefully when /proc read fails (non-Linux)', async () => {
    const { child, emitClose } = createMockChild();
    // Default readFile mock throws ENOENT — simulates non-Linux environment
    const { spawnWithGuardrails } = await importWithHealthMocks(child);

    const promise = spawnWithGuardrails('test-cmd', [], {
      timeoutMs: 0,
      healthCheckIntervalMs: 1000,
    });

    // First health check — /proc unavailable, sets baseline sentinel
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    // Debug log should indicate /proc unavailability using the dedicated event name
    expect(
      loggerDebugCalls.some(
        (c) =>
          c.event === 'task.executor.proc-unavailable' &&
          (c.data.message as string).includes('/proc stat unavailable'),
      ),
    ).toBe(true);

    // The proc-unavailable debug log fires only once (not on every check)
    const procUnavailableLogs = loggerDebugCalls.filter(
      (c) => c.event === 'task.executor.proc-unavailable',
    );

    // No crash, no warning yet (only 1 check — baseline)
    expect(loggerWarnCalls.filter((c) => c.event === 'task.executor.child-idle')).toHaveLength(0);

    // Second check — first consecutive idle (no output, /proc still unavailable)
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    expect(loggerWarnCalls.filter((c) => c.event === 'task.executor.child-idle')).toHaveLength(0);

    // Third check — second consecutive idle → warning
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    // The proc-unavailable log should still only have fired once (not on 2nd/3rd checks)
    expect(
      loggerDebugCalls.filter((c) => c.event === 'task.executor.proc-unavailable'),
    ).toHaveLength(procUnavailableLogs.length);

    // Should still emit idle warning even without /proc (based on output-only check)
    const idleWarnings = loggerWarnCalls.filter((c) => c.event === 'task.executor.child-idle');
    expect(idleWarnings).toHaveLength(1);
    expect(idleWarnings[0]!.data.pid).toBe(99999);
    // rssPages is always present — null when /proc is unavailable
    expect(idleWarnings[0]!.data.rssPages).toBeNull();

    emitClose(0);
    await promise;
  }, 30000);

  it('only warns once per sustained idle period (no spam)', async () => {
    const procStatLine = makeProcStat(100, 50, 4096);
    const { child, emitClose } = createMockChild();
    const { spawnWithGuardrails } = await importWithHealthMocks(child, async () => procStatLine);

    const promise = spawnWithGuardrails('test-cmd', [], {
      timeoutMs: 0,
      healthCheckIntervalMs: 1000,
    });

    // Run 6 health checks — first is baseline, then 5 idle checks
    // Warning fires at check 3 (2nd consecutive idle), then suppressed for checks 4-6
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      await flushMicrotasks();
    }

    // Only 1 warning total despite sustained idle
    const idleWarnings = loggerWarnCalls.filter((c) => c.event === 'task.executor.child-idle');
    expect(idleWarnings).toHaveLength(1);

    emitClose(0);
    await promise;
  }, 30000);

  it('resets idle counter when output resumes and warns again on next sustained idle', async () => {
    const procStatLine = makeProcStat(100, 50, 4096);
    const { child, emitClose, emitStdout } = createMockChild();
    const { spawnWithGuardrails } = await importWithHealthMocks(child, async () => procStatLine);

    const promise = spawnWithGuardrails('test-cmd', [], {
      timeoutMs: 0,
      healthCheckIntervalMs: 1000,
    });

    // 3 checks needed for first warning (check 1 = baseline, check 2 = 1st idle, check 3 = 2nd idle → warning)
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    expect(loggerWarnCalls.filter((c) => c.event === 'task.executor.child-idle')).toHaveLength(1);

    // Output resumes — resets counter. Next check sees output so not idle.
    emitStdout('output');
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    // After reset, need 2 more consecutive idle checks for second warning
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    expect(loggerWarnCalls.filter((c) => c.event === 'task.executor.child-idle')).toHaveLength(2);

    emitClose(0);
    await promise;
  }, 30000);

  it('does not start health check when healthCheckIntervalMs is 0', async () => {
    const procStatLine = makeProcStat(100, 50, 4096);
    const { child, emitClose } = createMockChild();
    const { spawnWithGuardrails } = await importWithHealthMocks(child, async () => procStatLine);

    const promise = spawnWithGuardrails('test-cmd', [], {
      timeoutMs: 0,
      healthCheckIntervalMs: 0,
    });

    // Advance well past default interval
    await vi.advanceTimersByTimeAsync(120_000);
    await flushMicrotasks();

    // No health check logs at all
    expect(loggerWarnCalls.filter((c) => c.event === 'task.executor.child-idle')).toHaveLength(0);
    expect(loggerDebugCalls.filter((c) => c.event === 'task.executor.child-idle')).toHaveLength(0);

    emitClose(0);
    await promise;
  }, 30000);

  it('includes lastOutputAt in idle warning when output was previously received', async () => {
    const procStatLine = makeProcStat(100, 50, 4096);
    const { child, emitClose, emitStdout } = createMockChild();
    const { spawnWithGuardrails } = await importWithHealthMocks(child, async () => procStatLine);

    const promise = spawnWithGuardrails('test-cmd', [], {
      timeoutMs: 0,
      healthCheckIntervalMs: 1000,
    });

    // Emit output at t=500ms
    await vi.advanceTimersByTimeAsync(500);
    emitStdout('initial output');

    // First health check at t=1000 — output was received so not idle; establishes CPU baseline
    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks();

    // No output after first check. Second check at t=2000 — first consecutive idle
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    // Third check at t=3000 — second consecutive idle → warning
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    const idleWarnings = loggerWarnCalls.filter((c) => c.event === 'task.executor.child-idle');
    expect(idleWarnings).toHaveLength(1);
    expect(idleWarnings[0]!.data.lastOutputAt).toBeTypeOf('string');
    // Should be an ISO 8601 timestamp
    expect(() => new Date(idleWarnings[0]!.data.lastOutputAt as string)).not.toThrow();

    emitClose(0);
    await promise;
  }, 30000);

  it('sets lastOutputAt to null in idle warning when child never produced any output', async () => {
    const procStatLine = makeProcStat(100, 50, 4096);
    const { child, emitClose } = createMockChild();
    const { spawnWithGuardrails } = await importWithHealthMocks(child, async () => procStatLine);

    // No output emitted at any point — lastDataReceivedAt remains null throughout
    const promise = spawnWithGuardrails('test-cmd', [], {
      timeoutMs: 0,
      healthCheckIntervalMs: 1000,
    });

    // First check at t=1000 — establishes CPU baseline
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    // Second check at t=2000 — first consecutive idle
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    // Third check at t=3000 — second consecutive idle → warning
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    const idleWarnings = loggerWarnCalls.filter((c) => c.event === 'task.executor.child-idle');
    expect(idleWarnings).toHaveLength(1);
    // lastOutputAt must be null (not undefined) when no output was ever received
    expect(idleWarnings[0]!.data.lastOutputAt).toBeNull();

    emitClose(0);
    await promise;
  }, 30000);
});
