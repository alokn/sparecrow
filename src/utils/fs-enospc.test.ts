/** ENOSPC and EACCES filesystem error tests for atomicWrite (AC6 — no orphaned tmp files). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('atomicWrite ENOSPC cleanup (AC6)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('cleans up tmp file and rethrows when writeFile fails with ENOSPC', async () => {
    const enospcError = Object.assign(new Error('ENOSPC: no space left on device'), {
      code: 'ENOSPC',
    });

    const unlinkSpy = vi.fn().mockResolvedValue(undefined);
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

    vi.doMock('node:fs/promises', () => ({
      ...actualFs,
      mkdir: actualFs.mkdir,
      writeFile: vi.fn().mockRejectedValue(enospcError),
      rename: vi.fn().mockResolvedValue(undefined),
      unlink: unlinkSpy,
    }));

    const { atomicWrite } = await import('./fs.js');

    await expect(atomicWrite('/tmp/sparecrow-enospc-test/out.json', '{}')).rejects.toThrow(
      'ENOSPC',
    );

    // AC6: unlink was called to remove orphaned tmp file
    expect(unlinkSpy).toHaveBeenCalledTimes(1);
    const unlinkPath = unlinkSpy.mock.calls[0]![0] as string;
    expect(unlinkPath).toContain('.tmp-');
  });

  it('cleans up tmp file and rethrows when rename fails with ENOSPC', async () => {
    const enospcError = Object.assign(new Error('ENOSPC: no space left on device'), {
      code: 'ENOSPC',
    });

    const unlinkSpy = vi.fn().mockResolvedValue(undefined);
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

    vi.doMock('node:fs/promises', () => ({
      ...actualFs,
      mkdir: actualFs.mkdir,
      writeFile: actualFs.writeFile,
      rename: vi.fn().mockRejectedValue(enospcError),
      unlink: unlinkSpy,
    }));

    const { atomicWrite } = await import('./fs.js');

    await expect(atomicWrite('/tmp/sparecrow-enospc-test/out.json', '{}')).rejects.toThrow(
      'ENOSPC',
    );

    // AC6: tmp file cleanup attempted
    expect(unlinkSpy).toHaveBeenCalledTimes(1);
  });

  it('still rethrows ENOSPC even when unlink cleanup also fails', async () => {
    const enospcError = Object.assign(new Error('ENOSPC: no space left on device'), {
      code: 'ENOSPC',
    });

    const unlinkSpy = vi.fn().mockRejectedValue(new Error('unlink also failed'));
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

    vi.doMock('node:fs/promises', () => ({
      ...actualFs,
      mkdir: actualFs.mkdir,
      writeFile: vi.fn().mockRejectedValue(enospcError),
      rename: vi.fn().mockResolvedValue(undefined),
      unlink: unlinkSpy,
    }));

    const { atomicWrite } = await import('./fs.js');

    // Even when cleanup fails, the original ENOSPC error propagates
    await expect(atomicWrite('/tmp/sparecrow-enospc-test/out.json', '{}')).rejects.toThrow(
      'ENOSPC',
    );

    expect(unlinkSpy).toHaveBeenCalledTimes(1);
  });

  it('cleans up tmp file when writeFile fails with EACCES', async () => {
    const eaccesError = Object.assign(new Error('EACCES: permission denied'), {
      code: 'EACCES',
    });

    const unlinkSpy = vi.fn().mockResolvedValue(undefined);
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

    vi.doMock('node:fs/promises', () => ({
      ...actualFs,
      mkdir: actualFs.mkdir,
      writeFile: vi.fn().mockRejectedValue(eaccesError),
      rename: vi.fn().mockResolvedValue(undefined),
      unlink: unlinkSpy,
    }));

    const { atomicWrite } = await import('./fs.js');

    await expect(atomicWrite('/tmp/sparecrow-enospc-test/out.json', '{}')).rejects.toThrow(
      'EACCES',
    );

    expect(unlinkSpy).toHaveBeenCalledTimes(1);
  });
});
