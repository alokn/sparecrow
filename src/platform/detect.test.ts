/** Unit tests for platform detection. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('isMacOS()', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('returns true when platform is darwin', async () => {
    vi.doMock('node:process', () => ({ platform: 'darwin' }));
    const { isMacOS } = await import('./detect.js');
    expect(isMacOS()).toBe(true);
  });

  it('returns false when platform is linux', async () => {
    vi.doMock('node:process', () => ({ platform: 'linux' }));
    const { isMacOS } = await import('./detect.js');
    expect(isMacOS()).toBe(false);
  });
});

describe('isLinux()', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('returns true when platform is linux', async () => {
    vi.doMock('node:process', () => ({ platform: 'linux' }));
    const { isLinux } = await import('./detect.js');
    expect(isLinux()).toBe(true);
  });

  it('returns false when platform is darwin', async () => {
    vi.doMock('node:process', () => ({ platform: 'darwin' }));
    const { isLinux } = await import('./detect.js');
    expect(isLinux()).toBe(false);
  });
});

describe('isWslWindowsPath()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns true for /mnt/c path on Linux', async () => {
    vi.doMock('node:process', () => ({ platform: 'linux' }));
    const { isWslWindowsPath } = await import('./detect.js');
    expect(isWslWindowsPath('/mnt/c/Users/test/.claude')).toBe(true);
  });

  it('returns true for /mnt/d path on Linux', async () => {
    vi.doMock('node:process', () => ({ platform: 'linux' }));
    const { isWslWindowsPath } = await import('./detect.js');
    expect(isWslWindowsPath('/mnt/d/projects/repo')).toBe(true);
  });

  it('returns false for home directory on Linux (POSIX-native path)', async () => {
    vi.doMock('node:process', () => ({ platform: 'linux' }));
    const { isWslWindowsPath } = await import('./detect.js');
    expect(isWslWindowsPath('/home/user/.claude')).toBe(false);
  });

  it('returns false for /tmp on Linux (POSIX-native path)', async () => {
    vi.doMock('node:process', () => ({ platform: 'linux' }));
    const { isWslWindowsPath } = await import('./detect.js');
    expect(isWslWindowsPath('/tmp/sparecrow/test')).toBe(false);
  });

  it('returns false for /var path on Linux (POSIX-native path)', async () => {
    vi.doMock('node:process', () => ({ platform: 'linux' }));
    const { isWslWindowsPath } = await import('./detect.js');
    expect(isWslWindowsPath('/var/log/sparecrow')).toBe(false);
  });

  it('returns false on macOS regardless of path', async () => {
    vi.doMock('node:process', () => ({ platform: 'darwin' }));
    const { isWslWindowsPath } = await import('./detect.js');
    expect(isWslWindowsPath('/mnt/c/Users/test')).toBe(false);
  });

  it('returns false on win32 regardless of path', async () => {
    vi.doMock('node:process', () => ({ platform: 'win32' }));
    const { isWslWindowsPath } = await import('./detect.js');
    expect(isWslWindowsPath('/mnt/c/Users/test')).toBe(false);
  });

  it('uses custom mount prefix when provided', async () => {
    vi.doMock('node:process', () => ({ platform: 'linux' }));
    const { isWslWindowsPath } = await import('./detect.js');
    expect(isWslWindowsPath('/media/c/Users/test', '/media/')).toBe(true);
    expect(isWslWindowsPath('/mnt/c/Users/test', '/media/')).toBe(false);
  });

  it('uses default /mnt/ prefix when mountPrefix is undefined', async () => {
    vi.doMock('node:process', () => ({ platform: 'linux' }));
    const { isWslWindowsPath } = await import('./detect.js');
    expect(isWslWindowsPath('/mnt/c/Users/test', undefined)).toBe(true);
  });

  it('normalises double-slash prefix before matching (e.g. //mnt/c/... is treated as /mnt/c/...)', async () => {
    vi.doMock('node:process', () => ({ platform: 'linux' }));
    const { isWslWindowsPath } = await import('./detect.js');
    expect(isWslWindowsPath('//mnt/c/Users/test')).toBe(true);
  });
});
