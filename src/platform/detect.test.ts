/** Unit tests for platform detection. */
import { describe, it, expect, vi, afterEach } from 'vitest';

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
