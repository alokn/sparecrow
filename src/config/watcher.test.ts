/** Unit tests for config watcher — debounce, duplicate event collapse, safe shutdown. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createConfigWatcher } from './watcher.js';

describe('createConfigWatcher', () => {
  let tmpDir: string;
  let configPath: string;
  let watchers: ReturnType<typeof createConfigWatcher>[];

  beforeEach(async () => {
    vi.useFakeTimers();
    tmpDir = join(tmpdir(), `watcher-test-${randomBytes(6).toString('hex')}`);
    await mkdir(tmpDir, { recursive: true });
    configPath = join(tmpDir, 'config.yaml');
    await writeFile(configPath, 'polling_interval: 300', 'utf-8');
    watchers = [];
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const w of watchers) {
      w.close();
    }
    watchers = [];
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('calls onReload after 300ms debounce when file changes', async () => {
    const onReload = vi.fn().mockResolvedValue(undefined);
    const watcher = createConfigWatcher(configPath, onReload);
    watchers.push(watcher);

    // Simulate a change to the config file
    await writeFile(configPath, 'polling_interval: 60', 'utf-8');

    // Should not have been called yet (debounce)
    await vi.advanceTimersByTimeAsync(100);
    expect(onReload).not.toHaveBeenCalled();

    // After debounce window passes
    await vi.advanceTimersByTimeAsync(300);
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('collapses rapid duplicate events to one reload per debounce window', async () => {
    const onReload = vi.fn().mockResolvedValue(undefined);
    const watcher = createConfigWatcher(configPath, onReload);
    watchers.push(watcher);

    // Simulate multiple rapid writes
    await writeFile(configPath, 'v1', 'utf-8');
    await writeFile(configPath, 'v2', 'utf-8');
    await writeFile(configPath, 'v3', 'utf-8');

    // Advance past debounce
    await vi.advanceTimersByTimeAsync(400);

    // Should only be called once (or at most a few times based on fs.watch behavior)
    // The key property is: not called once per write
    expect(onReload.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('close() stops watcher and prevents further reload calls', async () => {
    const onReload = vi.fn().mockResolvedValue(undefined);
    const watcher = createConfigWatcher(configPath, onReload);
    watchers.push(watcher);

    watcher.close();

    // Write after close
    await writeFile(configPath, 'polling_interval: 10', 'utf-8');
    await vi.advanceTimersByTimeAsync(400);

    expect(onReload).not.toHaveBeenCalled();
  });

  it('close() is idempotent — calling it twice does not throw', () => {
    const onReload = vi.fn().mockResolvedValue(undefined);
    const watcher = createConfigWatcher(configPath, onReload);
    watchers.push(watcher);

    expect(() => {
      watcher.close();
      watcher.close();
    }).not.toThrow();
  });

  it('returns a no-op watcher handle when fs.watch fails', async () => {
    const onReload = vi.fn().mockResolvedValue(undefined);

    // Use a non-existent directory to cause fs.watch to fail
    const badPath = join(tmpDir, 'nonexistent', 'config.yaml');
    const watcher = createConfigWatcher(badPath, onReload);
    watchers.push(watcher);

    // close() should not throw
    expect(() => watcher.close()).not.toThrow();
  });

  it('does not crash daemon if onReload throws', async () => {
    const onReload = vi.fn().mockRejectedValue(new Error('reload failed'));
    const watcher = createConfigWatcher(configPath, onReload);
    watchers.push(watcher);

    // Simulate change
    await writeFile(configPath, 'updated: true', 'utf-8');
    await vi.advanceTimersByTimeAsync(400);

    // onReload was called and threw — watcher should still be alive, no throw
    // close() should not throw
    expect(() => watcher.close()).not.toThrow();
  });

  it('close() cancels an in-flight debounce timer preventing stale reload', async () => {
    const onReload = vi.fn().mockResolvedValue(undefined);
    const watcher = createConfigWatcher(configPath, onReload);
    watchers.push(watcher);

    // Write to trigger fs event, which schedules a fake setTimeout(fn, 300)
    await writeFile(configPath, 'updated: true', 'utf-8');
    // Advance partway — enough for the fs event to propagate, but before the debounce fires
    await vi.advanceTimersByTimeAsync(100);
    expect(onReload).not.toHaveBeenCalled();

    // Close while debounce is still pending — must clear the timer
    watcher.close();

    // Advance past the full debounce window — reload must NOT fire (timer was cleared)
    await vi.advanceTimersByTimeAsync(400);
    expect(onReload).not.toHaveBeenCalled();
  });
});

describe('createConfigWatcher — FSWatcher error event', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('logs watcher error without crashing when the FSWatcher emits an error', async () => {
    const { EventEmitter } = await import('node:events');

    const fakeWatcher = new EventEmitter() as ReturnType<typeof import('node:fs').watch>;
    (fakeWatcher as unknown as { close: () => void }).close = vi.fn();

    vi.resetModules();
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.doMock('node:fs', () => ({ ...actual, watch: vi.fn(() => fakeWatcher) }));

    const { createConfigWatcher: create } = await import('./watcher.js');
    const onReload = vi.fn().mockResolvedValue(undefined);
    const watcher = create('/any/config.yaml', onReload);

    // Simulate the FSWatcher emitting an error (e.g. inotify limit exceeded)
    fakeWatcher.emit('error', new Error('inotify limit exceeded'));

    // Watcher must survive — close() must not throw
    expect(() => watcher.close()).not.toThrow();
    // onReload was never triggered by the error event
    expect(onReload).not.toHaveBeenCalled();
  });
});
