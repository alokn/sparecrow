/** Unit tests for BinaryResolver. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventName } from '../../../types/index.js';

let resolveBinaryMount: typeof import('./binary-resolver.js').resolveBinaryMount;
let mockAccess: ReturnType<typeof vi.fn>;
let mockRealpath: ReturnType<typeof vi.fn>;
let mockStat: ReturnType<typeof vi.fn>;
let loggerInfoSpy: ReturnType<typeof vi.fn>;
let loggerWarnSpy: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();

  mockAccess = vi.fn().mockResolvedValue(undefined);
  mockRealpath = vi.fn().mockImplementation((p: string) => Promise.resolve(p));
  mockStat = vi.fn().mockResolvedValue({ isDirectory: () => false });

  vi.doMock('node:fs/promises', () => ({
    access: mockAccess,
    realpath: mockRealpath,
    stat: mockStat,
    constants: { X_OK: 1, R_OK: 4 },
  }));

  loggerInfoSpy = vi.fn().mockResolvedValue(undefined);
  loggerWarnSpy = vi.fn().mockResolvedValue(undefined);

  vi.doMock('../../../utils/index.js', () => ({
    logger: {
      info: loggerInfoSpy,
      warn: loggerWarnSpy,
      error: vi.fn().mockResolvedValue(undefined),
      debug: vi.fn().mockResolvedValue(undefined),
    },
  }));

  const mod = await import('./binary-resolver.js');
  resolveBinaryMount = mod.resolveBinaryMount;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveBinaryMount', () => {
  // 4.1: resolves a real path (no symlink) to correct mount
  it('returns correct mount for a real path (no symlink)', async () => {
    mockRealpath.mockResolvedValue('/home/user/.local/share/claude/versions/2.1.63');
    mockStat.mockResolvedValue({ isDirectory: () => false });

    const result = await resolveBinaryMount('/home/user/.local/share/claude/versions/2.1.63');

    expect(result).not.toBeNull();
    expect(result!.mount.source).toBe('/home/user/.local/share/claude/versions');
    expect(result!.mount.target).toBe('/opt/claude/versions');
    expect(result!.mount.readonly).toBe(true);
    expect(result!.containerCommandPath).toBe('/opt/claude/versions/2.1.63');
  });

  // 4.2: follows symlink to real path
  it('follows symlink to real path and returns mount for resolved directory', async () => {
    // claudePath is a symlink, realpath resolves it
    mockRealpath.mockResolvedValue('/home/user/.local/share/claude/versions/2.1.63/cli.js');
    mockStat.mockResolvedValue({ isDirectory: () => false });

    const result = await resolveBinaryMount('/home/user/.local/bin/claude');

    expect(result).not.toBeNull();
    expect(result!.mount.source).toBe('/home/user/.local/share/claude/versions/2.1.63');
    expect(result!.mount.target).toBe('/opt/claude/2.1.63');
    expect(result!.mount.readonly).toBe(true);
    expect(result!.containerCommandPath).toBe('/opt/claude/2.1.63/cli.js');
  });

  // 4.3: graceful degradation with broken symlink
  it('returns null when symlink is broken (access fails)', async () => {
    mockAccess.mockRejectedValue(new Error('ENOENT: no such file or directory'));

    const result = await resolveBinaryMount('/home/user/.local/bin/claude');

    expect(result).toBeNull();
  });

  // 4.3b: graceful degradation when realpath fails (broken symlink after access check)
  it('returns null when realpath fails (broken symlink)', async () => {
    mockAccess.mockResolvedValue(undefined);
    mockRealpath.mockRejectedValue(new Error('ENOENT: broken symlink'));

    const result = await resolveBinaryMount('/home/user/.local/bin/claude');

    expect(result).toBeNull();
  });

  // 4.3c: graceful degradation when stat fails
  it('returns null when stat fails after realpath', async () => {
    mockRealpath.mockResolvedValue('/home/user/.local/share/claude/versions/2.1.63');
    mockStat.mockRejectedValue(new Error('EACCES: permission denied'));

    const result = await resolveBinaryMount('/home/user/.local/bin/claude');

    expect(result).toBeNull();
  });

  // Mount is read-only (AC3)
  it('always sets mount as read-only', async () => {
    mockRealpath.mockResolvedValue('/opt/claude-install/cli.js');
    mockStat.mockResolvedValue({ isDirectory: () => false });

    const result = await resolveBinaryMount('/usr/local/bin/claude');

    expect(result).not.toBeNull();
    expect(result!.mount.readonly).toBe(true);
  });

  // Handles directory as resolved path
  it('handles resolved path that is a directory (no entry point name)', async () => {
    mockRealpath.mockResolvedValue('/home/user/.local/share/claude');
    mockStat.mockResolvedValue({ isDirectory: () => true });

    const result = await resolveBinaryMount('/home/user/.local/bin/claude');

    expect(result).not.toBeNull();
    expect(result!.mount.source).toBe('/home/user/.local/share/claude');
    expect(result!.mount.target).toBe('/opt/claude/claude');
    expect(result!.containerCommandPath).toBe('/opt/claude/claude');
  });

  // Custom containerInstallDir option
  it('uses custom containerInstallDir when provided', async () => {
    mockRealpath.mockResolvedValue('/home/user/.local/share/claude/versions/2.1.63/cli.js');
    mockStat.mockResolvedValue({ isDirectory: () => false });

    const result = await resolveBinaryMount('/home/user/.local/bin/claude', {
      containerInstallDir: '/usr/share/claude',
    });

    expect(result).not.toBeNull();
    expect(result!.mount.target).toBe('/usr/share/claude/2.1.63');
    expect(result!.containerCommandPath).toBe('/usr/share/claude/2.1.63/cli.js');
  });

  // AC7: logs container.binary-mounted event on success
  it('logs CONTAINER_BINARY_MOUNTED event on success', async () => {
    mockRealpath.mockResolvedValue('/home/user/.local/share/claude/versions/2.1.63/cli.js');
    mockStat.mockResolvedValue({ isDirectory: () => false });

    await resolveBinaryMount('/home/user/.local/bin/claude');

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      EventName.CONTAINER_BINARY_MOUNTED,
      expect.objectContaining({
        hostSource: '/home/user/.local/share/claude/versions/2.1.63',
        containerTarget: '/opt/claude/2.1.63',
        containerCommandPath: '/opt/claude/2.1.63/cli.js',
        resolvedFrom: '/home/user/.local/bin/claude',
      }),
    );
  });

  // AC6: logs warning on failure
  it('logs CONTAINER_BINARY_MOUNT_FAILED warning on failure', async () => {
    mockAccess.mockRejectedValue(new Error('ENOENT'));

    await resolveBinaryMount('/nonexistent/path/claude');

    expect(loggerWarnSpy).toHaveBeenCalledWith(
      EventName.CONTAINER_BINARY_MOUNT_FAILED,
      expect.objectContaining({
        claudePath: '/nonexistent/path/claude',
        error: expect.any(String),
      }),
    );
  });

  // Permission error results in null (graceful degradation)
  it('returns null when access check fails with permission error', async () => {
    mockAccess.mockRejectedValue(new Error('EACCES: permission denied'));

    const result = await resolveBinaryMount('/home/user/.local/bin/claude');

    expect(result).toBeNull();
  });

  // Finding 6: String(err) branch — non-Error thrown in catch block
  it('logs warning with String(err) when a non-Error value is thrown', async () => {
    // Throw a plain string (not an Error instance) to exercise String(err) branch
    mockAccess.mockRejectedValue('access denied string error');

    const result = await resolveBinaryMount('/home/user/.local/bin/claude');

    expect(result).toBeNull();
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      EventName.CONTAINER_BINARY_MOUNT_FAILED,
      expect.objectContaining({
        claudePath: '/home/user/.local/bin/claude',
        error: 'access denied string error',
      }),
    );
  });

  // Finding 1: Root-path guard — dirname of a root-level file returns '/'
  it('returns null when resolved install directory is root (/)', async () => {
    // Simulate a degenerate path where the file is at the filesystem root
    mockRealpath.mockResolvedValue('/cli.js');
    mockStat.mockResolvedValue({ isDirectory: () => false });

    const result = await resolveBinaryMount('/cli.js');

    expect(result).toBeNull();
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      EventName.CONTAINER_BINARY_MOUNT_FAILED,
      expect.objectContaining({
        claudePath: '/cli.js',
        error: expect.stringContaining('/'),
      }),
    );
  });
});
