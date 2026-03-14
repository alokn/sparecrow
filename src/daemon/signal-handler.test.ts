/** Unit tests for signal-handler — SIGTERM/SIGINT/SIGHUP flows and idempotent shutdown. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../utils/index.js', () => ({
  logger: {
    debug: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
    info: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('./pid-manager.js', () => ({
  removePid: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./state-writer.js', () => ({
  writeStoppingStatus: vi.fn().mockResolvedValue(undefined),
  writeStoppedStatus: vi.fn().mockResolvedValue(undefined),
}));

describe('signal-handler', () => {
  let removePid: ReturnType<typeof vi.fn>;
  let writeStoppingStatus: ReturnType<typeof vi.fn>;
  let writeStoppedStatus: ReturnType<typeof vi.fn>;
  let registerSignalHandlers: (typeof import('./signal-handler.js'))['registerSignalHandlers'];
  let unregisterSignalHandlers: (typeof import('./signal-handler.js'))['unregisterSignalHandlers'];

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    vi.doMock('../utils/index.js', () => ({
      logger: {
        debug: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
        info: vi.fn().mockResolvedValue(undefined),
      },
    }));

    vi.doMock('./pid-manager.js', () => ({
      removePid: vi.fn().mockResolvedValue(undefined),
    }));

    vi.doMock('./state-writer.js', () => ({
      writeStoppingStatus: vi.fn().mockResolvedValue(undefined),
      writeStoppedStatus: vi.fn().mockResolvedValue(undefined),
    }));

    const signalHandlerModule = await import('./signal-handler.js');
    registerSignalHandlers = signalHandlerModule.registerSignalHandlers;
    unregisterSignalHandlers = signalHandlerModule.unregisterSignalHandlers;

    const pidManager = await import('./pid-manager.js');
    removePid = vi.mocked(pidManager.removePid);

    const stateWriter = await import('./state-writer.js');
    writeStoppingStatus = vi.mocked(stateWriter.writeStoppingStatus);
    writeStoppedStatus = vi.mocked(stateWriter.writeStoppedStatus);
  });

  afterEach(() => {
    try {
      unregisterSignalHandlers();
    } catch {
      // May already be unregistered
    }
  });

  const makePollingLoop = () => ({
    stop: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn(),
  });

  it('registers SIGTERM handler that triggers graceful shutdown', async () => {
    const shutdownComplete = vi.fn();
    const loop = makePollingLoop();
    registerSignalHandlers({
      dataDir: '/tmp/test-data',
      startedAt: '2026-02-25T12:00:00.000Z',
      pollingLoop: loop as never,
      onReload: vi.fn().mockResolvedValue(undefined),
      onShutdownComplete: shutdownComplete,
    });

    // Simulate SIGTERM
    process.emit('SIGTERM', 'SIGTERM');

    // Wait for async shutdown
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(writeStoppingStatus).toHaveBeenCalled();
    expect(loop.stop).toHaveBeenCalled();
    expect(writeStoppedStatus).toHaveBeenCalled();
    expect(removePid).toHaveBeenCalledWith('/tmp/test-data');
    expect(shutdownComplete).toHaveBeenCalled();
  });

  it('registers SIGINT handler that triggers graceful shutdown', async () => {
    const shutdownComplete = vi.fn();
    const loop = makePollingLoop();
    registerSignalHandlers({
      dataDir: '/tmp/test-data',
      startedAt: '2026-02-25T12:00:00.000Z',
      pollingLoop: loop as never,
      onReload: vi.fn().mockResolvedValue(undefined),
      onShutdownComplete: shutdownComplete,
    });

    process.emit('SIGINT', 'SIGINT');
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(shutdownComplete).toHaveBeenCalled();
    expect(loop.stop).toHaveBeenCalled();
  });

  it('SIGTERM idempotent — second signal does not run cleanup twice', async () => {
    const shutdownComplete = vi.fn();
    const loop = makePollingLoop();
    registerSignalHandlers({
      dataDir: '/tmp/test-data',
      startedAt: '2026-02-25T12:00:00.000Z',
      pollingLoop: loop as never,
      onReload: vi.fn().mockResolvedValue(undefined),
      onShutdownComplete: shutdownComplete,
    });

    process.emit('SIGTERM', 'SIGTERM');
    process.emit('SIGTERM', 'SIGTERM');
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    // onShutdownComplete called exactly once
    expect(shutdownComplete).toHaveBeenCalledTimes(1);
    expect(removePid).toHaveBeenCalledTimes(1);
  });

  it('SIGHUP calls onReload callback', async () => {
    const onReload = vi.fn().mockResolvedValue(undefined);
    const loop = makePollingLoop();
    registerSignalHandlers({
      dataDir: '/tmp/test-data',
      startedAt: '2026-02-25T12:00:00.000Z',
      pollingLoop: loop as never,
      onReload,
      onShutdownComplete: vi.fn(),
    });

    process.emit('SIGHUP', 'SIGHUP');
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('SIGHUP during shutdown does not trigger reload', async () => {
    const onReload = vi.fn().mockResolvedValue(undefined);
    const shutdownComplete = vi.fn();
    const loop = makePollingLoop();
    registerSignalHandlers({
      dataDir: '/tmp/test-data',
      startedAt: '2026-02-25T12:00:00.000Z',
      pollingLoop: loop as never,
      onReload,
      onShutdownComplete: shutdownComplete,
    });

    // Start shutdown first
    process.emit('SIGTERM', 'SIGTERM');
    // Then SIGHUP during shutdown
    process.emit('SIGHUP', 'SIGHUP');

    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    // onReload should not have been called since we were shutting down
    expect(onReload).not.toHaveBeenCalled();
  });

  it('SIGTERM during active dispatch triggers loop stop (cancellation signal propagation)', async () => {
    const shutdownComplete = vi.fn();
    // Simulate a long-running dispatch that respects the signal
    const loop = {
      stop: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      reload: vi.fn(),
    };

    registerSignalHandlers({
      dataDir: '/tmp/test-data',
      startedAt: '2026-02-25T12:00:00.000Z',
      pollingLoop: loop as never,
      onReload: vi.fn().mockResolvedValue(undefined),
      onShutdownComplete: shutdownComplete,
    });

    process.emit('SIGTERM', 'SIGTERM');
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    // loop.stop() was called — this propagates AbortSignal to in-flight dispatch
    expect(loop.stop).toHaveBeenCalled();
    expect(shutdownComplete).toHaveBeenCalled();
  });

  it('unregisterSignalHandlers cleans up listeners', async () => {
    const onReload = vi.fn().mockResolvedValue(undefined);
    const loop = makePollingLoop();
    registerSignalHandlers({
      dataDir: '/tmp/test-data',
      startedAt: '2026-02-25T12:00:00.000Z',
      pollingLoop: loop as never,
      onReload,
      onShutdownComplete: vi.fn(),
    });

    unregisterSignalHandlers();

    // After unregister, signals should not call the handlers
    process.emit('SIGHUP', 'SIGHUP');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(onReload).not.toHaveBeenCalled();
  });

  it('unregisterSignalHandlers handles null state gracefully', () => {
    // Ensure _state is null by calling unregister without prior register
    unregisterSignalHandlers();
    // No throw — this is the null guard branch on line 74
    unregisterSignalHandlers();
  });

  it('re-registration updates deps without adding duplicate handlers', async () => {
    const onReload1 = vi.fn().mockResolvedValue(undefined);
    const onReload2 = vi.fn().mockResolvedValue(undefined);
    const loop1 = makePollingLoop();
    const loop2 = makePollingLoop();
    const shutdownComplete = vi.fn();

    registerSignalHandlers({
      dataDir: '/tmp/test-data',
      startedAt: '2026-02-25T12:00:00.000Z',
      pollingLoop: loop1 as never,
      onReload: onReload1,
      onShutdownComplete: shutdownComplete,
    });

    // Second call updates deps (idempotent re-register branch)
    registerSignalHandlers({
      dataDir: '/tmp/test-data',
      startedAt: '2026-02-25T13:00:00.000Z',
      pollingLoop: loop2 as never,
      onReload: onReload2,
      onShutdownComplete: shutdownComplete,
    });

    // SIGHUP should call updated onReload2, not onReload1
    process.emit('SIGHUP', 'SIGHUP');
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(onReload1).not.toHaveBeenCalled();
    expect(onReload2).toHaveBeenCalledTimes(1);

    // SIGTERM should use updated loop2
    process.emit('SIGTERM', 'SIGTERM');
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(loop2.stop).toHaveBeenCalled();
    expect(loop1.stop).not.toHaveBeenCalled();
  });

  it('calls process.exit(0) when onShutdownComplete is not provided', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const loop = makePollingLoop();

    registerSignalHandlers({
      dataDir: '/tmp/test-data',
      startedAt: '2026-02-25T12:00:00.000Z',
      pollingLoop: loop as never,
      onReload: vi.fn().mockResolvedValue(undefined),
      // No onShutdownComplete — triggers process.exit(0) branch
    });

    process.emit('SIGTERM', 'SIGTERM');
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });

  it('handles writeStoppingStatus throwing an Error instance', async () => {
    writeStoppingStatus.mockRejectedValueOnce(new Error('stopping-write-error'));
    const shutdownComplete = vi.fn();
    const loop = makePollingLoop();

    registerSignalHandlers({
      dataDir: '/tmp/test-data',
      startedAt: '2026-02-25T12:00:00.000Z',
      pollingLoop: loop as never,
      onReload: vi.fn().mockResolvedValue(undefined),
      onShutdownComplete: shutdownComplete,
    });

    process.emit('SIGTERM', 'SIGTERM');
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    // Shutdown completes despite writeStoppingStatus failure
    expect(shutdownComplete).toHaveBeenCalled();
    expect(removePid).toHaveBeenCalled();
  });

  it('handles writeStoppingStatus throwing a non-Error value (String coercion)', async () => {
    writeStoppingStatus.mockRejectedValueOnce('string-error-stopping');
    const shutdownComplete = vi.fn();
    const loop = makePollingLoop();

    registerSignalHandlers({
      dataDir: '/tmp/test-data',
      startedAt: '2026-02-25T12:00:00.000Z',
      pollingLoop: loop as never,
      onReload: vi.fn().mockResolvedValue(undefined),
      onShutdownComplete: shutdownComplete,
    });

    process.emit('SIGTERM', 'SIGTERM');
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(shutdownComplete).toHaveBeenCalled();
  });

  it('handles writeStoppedStatus throwing an Error instance', async () => {
    writeStoppedStatus.mockRejectedValueOnce(new Error('stopped-write-error'));
    const shutdownComplete = vi.fn();
    const loop = makePollingLoop();

    registerSignalHandlers({
      dataDir: '/tmp/test-data',
      startedAt: '2026-02-25T12:00:00.000Z',
      pollingLoop: loop as never,
      onReload: vi.fn().mockResolvedValue(undefined),
      onShutdownComplete: shutdownComplete,
    });

    process.emit('SIGTERM', 'SIGTERM');
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(shutdownComplete).toHaveBeenCalled();
    expect(removePid).toHaveBeenCalled();
  });

  it('handles writeStoppedStatus throwing a non-Error value (String coercion)', async () => {
    writeStoppedStatus.mockRejectedValueOnce(42);
    const shutdownComplete = vi.fn();
    const loop = makePollingLoop();

    registerSignalHandlers({
      dataDir: '/tmp/test-data',
      startedAt: '2026-02-25T12:00:00.000Z',
      pollingLoop: loop as never,
      onReload: vi.fn().mockResolvedValue(undefined),
      onShutdownComplete: shutdownComplete,
    });

    process.emit('SIGTERM', 'SIGTERM');
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(shutdownComplete).toHaveBeenCalled();
  });

  it('handles removePid throwing an Error instance', async () => {
    removePid.mockRejectedValueOnce(new Error('pid-remove-error'));
    const shutdownComplete = vi.fn();
    const loop = makePollingLoop();

    registerSignalHandlers({
      dataDir: '/tmp/test-data',
      startedAt: '2026-02-25T12:00:00.000Z',
      pollingLoop: loop as never,
      onReload: vi.fn().mockResolvedValue(undefined),
      onShutdownComplete: shutdownComplete,
    });

    process.emit('SIGTERM', 'SIGTERM');
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(shutdownComplete).toHaveBeenCalled();
  });

  it('handles removePid throwing a non-Error value (String coercion)', async () => {
    removePid.mockRejectedValueOnce({ code: 'EACCES' });
    const shutdownComplete = vi.fn();
    const loop = makePollingLoop();

    registerSignalHandlers({
      dataDir: '/tmp/test-data',
      startedAt: '2026-02-25T12:00:00.000Z',
      pollingLoop: loop as never,
      onReload: vi.fn().mockResolvedValue(undefined),
      onShutdownComplete: shutdownComplete,
    });

    process.emit('SIGTERM', 'SIGTERM');
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(shutdownComplete).toHaveBeenCalled();
  });

  it('handles SIGHUP onReload throwing an Error instance', async () => {
    const onReload = vi.fn().mockRejectedValueOnce(new Error('reload-failed'));
    const loop = makePollingLoop();

    registerSignalHandlers({
      dataDir: '/tmp/test-data',
      startedAt: '2026-02-25T12:00:00.000Z',
      pollingLoop: loop as never,
      onReload,
      onShutdownComplete: vi.fn(),
    });

    process.emit('SIGHUP', 'SIGHUP');
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    // onReload was called; error was caught and logged, no crash
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('handles SIGHUP onReload throwing a non-Error value (String coercion)', async () => {
    const onReload = vi.fn().mockRejectedValueOnce('string-reload-error');
    const loop = makePollingLoop();

    registerSignalHandlers({
      dataDir: '/tmp/test-data',
      startedAt: '2026-02-25T12:00:00.000Z',
      pollingLoop: loop as never,
      onReload,
      onShutdownComplete: vi.fn(),
    });

    process.emit('SIGHUP', 'SIGHUP');
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('fires graceful shutdown timeout when pollingLoop.stop hangs', async () => {
    const shutdownComplete = vi.fn();
    // stop() never resolves — simulates a hung dispatch
    const loop = {
      stop: vi.fn().mockReturnValue(new Promise<void>(() => {})),
      start: vi.fn().mockResolvedValue(undefined),
      reload: vi.fn(),
    };

    // Use fake timers to control the timeout
    vi.useFakeTimers();

    registerSignalHandlers({
      dataDir: '/tmp/test-data',
      startedAt: '2026-02-25T12:00:00.000Z',
      pollingLoop: loop as never,
      onReload: vi.fn().mockResolvedValue(undefined),
      onShutdownComplete: shutdownComplete,
    });

    process.emit('SIGTERM', 'SIGTERM');

    // Let microtasks run so handleShutdown progresses to Promise.race
    await vi.advanceTimersByTimeAsync(10_000);

    // Let remaining microtasks flush
    await vi.advanceTimersByTimeAsync(100);

    expect(loop.stop).toHaveBeenCalled();
    expect(shutdownComplete).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('handles shutdown when _state is null (signal after unregister)', async () => {
    const shutdownComplete = vi.fn();
    const loop = makePollingLoop();

    registerSignalHandlers({
      dataDir: '/tmp/test-data',
      startedAt: '2026-02-25T12:00:00.000Z',
      pollingLoop: loop as never,
      onReload: vi.fn().mockResolvedValue(undefined),
      onShutdownComplete: shutdownComplete,
    });

    // Capture the handler before unregistering
    const sigTermListeners = process.listeners('SIGTERM');
    const handler = sigTermListeners[sigTermListeners.length - 1] as () => void;

    unregisterSignalHandlers();

    // Manually invoke the captured handler after state is null
    handler();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    // Should not crash, shutdown should not complete
    expect(shutdownComplete).not.toHaveBeenCalled();
  });

  it('handles SIGHUP when _state is null (signal after unregister)', async () => {
    const onReload = vi.fn().mockResolvedValue(undefined);
    const loop = makePollingLoop();

    registerSignalHandlers({
      dataDir: '/tmp/test-data',
      startedAt: '2026-02-25T12:00:00.000Z',
      pollingLoop: loop as never,
      onReload,
      onShutdownComplete: vi.fn(),
    });

    // Capture the handler before unregistering
    const sigHupListeners = process.listeners('SIGHUP');
    const handler = sigHupListeners[sigHupListeners.length - 1] as () => void;

    unregisterSignalHandlers();

    // Manually invoke the captured handler after state is null
    handler();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(onReload).not.toHaveBeenCalled();
  });

  it('re-registration without onShutdownComplete sets it to null', async () => {
    const loop = makePollingLoop();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    // First register with onShutdownComplete
    registerSignalHandlers({
      dataDir: '/tmp/test-data',
      startedAt: '2026-02-25T12:00:00.000Z',
      pollingLoop: loop as never,
      onReload: vi.fn().mockResolvedValue(undefined),
      onShutdownComplete: vi.fn(),
    });

    // Re-register without onShutdownComplete — triggers ?? null fallback
    registerSignalHandlers({
      dataDir: '/tmp/test-data',
      startedAt: '2026-02-25T13:00:00.000Z',
      pollingLoop: loop as never,
      onReload: vi.fn().mockResolvedValue(undefined),
    });

    process.emit('SIGTERM', 'SIGTERM');
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    // Should fall through to process.exit(0) since onShutdownComplete is now null
    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });
});
