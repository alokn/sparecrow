/** Unit tests for platform path resolution. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('getPaths()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns config path using XDG_CONFIG_HOME when set', async () => {
    const customConfig = join(tmpdir(), `sparecrow-test-cfg-${Date.now()}`);
    const customState = join(tmpdir(), `sparecrow-test-state-${Date.now()}`);

    vi.stubEnv('XDG_CONFIG_HOME', customConfig);
    vi.stubEnv('XDG_STATE_HOME', customState);

    // Mock env-paths to read XDG env vars — env-paths ignores them on macOS by
    // design, so we simulate the Linux behaviour by reading them from process.env.
    // This validates that getPaths() correctly wires up whatever env-paths returns.
    vi.doMock('env-paths', () => ({
      default: () => ({
        config: join(process.env['XDG_CONFIG_HOME'] ?? customConfig, 'sparecrow'),
        log: join(process.env['XDG_STATE_HOME'] ?? customState, 'sparecrow'),
        data: join(process.env['XDG_STATE_HOME'] ?? customState, 'sparecrow'),
        cache: join(process.env['XDG_STATE_HOME'] ?? customState, 'sparecrow'),
        temp: join(process.env['XDG_STATE_HOME'] ?? customState, 'sparecrow'),
      }),
    }));

    const { getPaths } = await import('./paths.js');
    const paths = getPaths();
    expect(paths.config).toBe(join(customConfig, 'sparecrow'));
  });

  it('returns data path using XDG_STATE_HOME when set', async () => {
    const customConfig = join(tmpdir(), `sparecrow-test-cfg-${Date.now()}`);
    const customState = join(tmpdir(), `sparecrow-test-state-${Date.now()}`);

    vi.stubEnv('XDG_CONFIG_HOME', customConfig);
    vi.stubEnv('XDG_STATE_HOME', customState);

    // Mock env-paths to read XDG env vars — env-paths ignores them on macOS by
    // design, so we simulate the Linux behaviour by reading them from process.env.
    // This validates that getPaths() correctly wires up whatever env-paths returns.
    vi.doMock('env-paths', () => ({
      default: () => ({
        config: join(process.env['XDG_CONFIG_HOME'] ?? customConfig, 'sparecrow'),
        log: join(process.env['XDG_STATE_HOME'] ?? customState, 'sparecrow'),
        data: join(process.env['XDG_STATE_HOME'] ?? customState, 'sparecrow'),
        cache: join(process.env['XDG_STATE_HOME'] ?? customState, 'sparecrow'),
        temp: join(process.env['XDG_STATE_HOME'] ?? customState, 'sparecrow'),
      }),
    }));

    const { getPaths } = await import('./paths.js');
    const paths = getPaths();
    expect(paths.data).toBe(join(customState, 'sparecrow'));
  });

  it('returns logs as subdirectory of data', async () => {
    const { getPaths } = await import('./paths.js');
    const paths = getPaths();
    expect(paths.logs).toBe(join(paths.data, 'logs'));
  });

  it('returns taskOutputs as subdirectory of data', async () => {
    const { getPaths } = await import('./paths.js');
    const paths = getPaths();
    expect(paths.taskOutputs).toBe(join(paths.data, 'task-outputs'));
  });

  it('includes all required path keys', async () => {
    const { getPaths } = await import('./paths.js');
    const paths = getPaths();
    expect(paths).toHaveProperty('config');
    expect(paths).toHaveProperty('data');
    expect(paths).toHaveProperty('logs');
    expect(paths).toHaveProperty('taskOutputs');
  });
});

describe('ensureDirectories()', () => {
  let testStateHome: string;
  let testConfigHome: string;

  beforeEach(async () => {
    testStateHome = join(tmpdir(), `sparecrow-test-state-${Date.now()}`);
    testConfigHome = join(tmpdir(), `sparecrow-test-cfg-${Date.now()}`);
    vi.resetModules();

    // Mock env-paths to return paths based on the custom dirs,
    // since env-paths ignores XDG vars on macOS by design.
    vi.doMock('env-paths', () => ({
      default: () => ({
        config: join(testConfigHome, 'sparecrow'),
        log: join(testStateHome, 'sparecrow'),
        data: join(testStateHome, 'sparecrow'),
        cache: join(testStateHome, 'sparecrow'),
        temp: join(testStateHome, 'sparecrow'),
      }),
    }));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(testStateHome, { recursive: true, force: true });
    await rm(testConfigHome, { recursive: true, force: true });
  });

  it('creates config, data, logs, and taskOutputs directories', async () => {
    const { getPaths, ensureDirectories } = await import('./paths.js');
    await ensureDirectories();
    const paths = getPaths();

    for (const dir of [paths.config, paths.data, paths.logs, paths.taskOutputs]) {
      const info = await stat(dir);
      expect(info.isDirectory()).toBe(true);
    }
  });

  it('sets directory permissions to 700', async () => {
    const { getPaths, ensureDirectories } = await import('./paths.js');
    await ensureDirectories();
    const paths = getPaths();

    const info = await stat(paths.data);
    // mode 700 = 0o40700; mask with 0o777 for permission bits only
    expect(info.mode & 0o777).toBe(0o700);
  });

  it('is idempotent — calling twice does not throw', async () => {
    const { ensureDirectories } = await import('./paths.js');
    await ensureDirectories();
    await expect(ensureDirectories()).resolves.toBeUndefined();
  });
});
