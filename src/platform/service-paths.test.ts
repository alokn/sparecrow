/** Unit tests for service-paths — covers path resolution for linux/darwin/unsupported and fileExists helper. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// getSystemdServicePath
// ---------------------------------------------------------------------------

describe('getSystemdServicePath', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('node:os', () => ({
      homedir: () => '/home/testuser',
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the systemd user unit path under homedir', async () => {
    const { getSystemdServicePath } = await import('./service-paths.js');
    expect(getSystemdServicePath()).toBe(
      join('/home/testuser', '.config', 'systemd', 'user', 'sparecrow.service'),
    );
  });
});

// ---------------------------------------------------------------------------
// getLaunchAgentPath
// ---------------------------------------------------------------------------

describe('getLaunchAgentPath', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('node:os', () => ({
      homedir: () => '/Users/testuser',
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the LaunchAgents plist path under homedir', async () => {
    const { getLaunchAgentPath } = await import('./service-paths.js');
    expect(getLaunchAgentPath()).toBe(
      join('/Users/testuser', 'Library', 'LaunchAgents', 'com.sparecrow.daemon.plist'),
    );
  });
});

// ---------------------------------------------------------------------------
// getPlatformServicePath
// ---------------------------------------------------------------------------

describe('getPlatformServicePath', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns systemd path on linux', async () => {
    vi.resetModules();
    vi.doMock('node:os', () => ({
      homedir: () => '/home/linuxuser',
    }));
    // Override process.platform via a property descriptor
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', writable: true });

    const { getPlatformServicePath, getSystemdServicePath } = await import('./service-paths.js');
    expect(getPlatformServicePath()).toBe(getSystemdServicePath());

    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
  });

  it('returns launch agent path on darwin', async () => {
    vi.resetModules();
    vi.doMock('node:os', () => ({
      homedir: () => '/Users/macuser',
    }));
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', writable: true });

    const { getPlatformServicePath, getLaunchAgentPath } = await import('./service-paths.js');
    expect(getPlatformServicePath()).toBe(getLaunchAgentPath());

    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
  });

  it('falls back to systemd path on unsupported platform', async () => {
    vi.resetModules();
    vi.doMock('node:os', () => ({
      homedir: () => '/home/fallback',
    }));
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', writable: true });

    const { getPlatformServicePath, getSystemdServicePath } = await import('./service-paths.js');
    expect(getPlatformServicePath()).toBe(getSystemdServicePath());

    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
  });
});

// ---------------------------------------------------------------------------
// fileExists
// ---------------------------------------------------------------------------

describe('fileExists', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = join(tmpdir(), 'service-paths-test-' + randomBytes(6).toString('hex'));
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns true when the file exists', async () => {
    const filePath = join(tmpDir, 'exists.txt');
    await writeFile(filePath, 'content');

    const { fileExists } = await import('./service-paths.js');
    await expect(fileExists(filePath)).resolves.toBe(true);
  });

  it('returns false when the file does not exist', async () => {
    const filePath = join(tmpDir, 'nonexistent.txt');

    const { fileExists } = await import('./service-paths.js');
    await expect(fileExists(filePath)).resolves.toBe(false);
  });

  it('returns false when access throws an error (e.g. permission denied)', async () => {
    vi.resetModules();
    vi.doMock('node:fs/promises', () => ({
      access: vi.fn().mockRejectedValue(new Error('EACCES: permission denied')),
    }));

    const { fileExists } = await import('./service-paths.js');
    await expect(fileExists('/some/restricted/path')).resolves.toBe(false);
  });
});
