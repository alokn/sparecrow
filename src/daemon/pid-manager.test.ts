/** Unit tests for PID manager — read, write, remove, existence checks, and stale detection. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdir,
  rm,
  readFile as realReadFile,
  readdir as realReaddir,
  unlink as realUnlink,
  writeFile as realWriteFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

describe('pid-manager', () => {
  let dataDir: string;

  beforeEach(async () => {
    vi.resetModules();
    dataDir = join(tmpdir(), 'pid-manager-test-' + randomBytes(6).toString('hex'));
    await mkdir(dataDir, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dataDir, { recursive: true, force: true });
  });

  describe('readPid()', () => {
    it('returns null when PID file does not exist', async () => {
      const { readPid } = await import('./pid-manager.js');
      const result = await readPid(dataDir);
      expect(result).toBeNull();
    });

    it('returns parsed PID when file exists and contains valid number', async () => {
      const { readPid, writePid } = await import('./pid-manager.js');
      await writePid(dataDir, 12345);
      const result = await readPid(dataDir);
      expect(result).toBe(12345);
    });

    it('returns null when PID file contains invalid content', async () => {
      const { writeFile } = await import('node:fs/promises');
      const { readPid } = await import('./pid-manager.js');
      await writeFile(join(dataDir, 'daemon.pid'), 'not-a-number\n', 'utf-8');
      const result = await readPid(dataDir);
      expect(result).toBeNull();
    });

    it('returns null when PID file contains zero', async () => {
      const { writeFile } = await import('node:fs/promises');
      const { readPid } = await import('./pid-manager.js');
      await writeFile(join(dataDir, 'daemon.pid'), '0\n', 'utf-8');
      const result = await readPid(dataDir);
      expect(result).toBeNull();
    });

    it('returns null when PID file contains negative number', async () => {
      const { writeFile } = await import('node:fs/promises');
      const { readPid } = await import('./pid-manager.js');
      await writeFile(join(dataDir, 'daemon.pid'), '-1\n', 'utf-8');
      const result = await readPid(dataDir);
      expect(result).toBeNull();
    });
  });

  describe('writePid()', () => {
    it('writes PID atomically and can be read back', async () => {
      const { writePid, readPid } = await import('./pid-manager.js');
      await writePid(dataDir, 99999);
      const result = await readPid(dataDir);
      expect(result).toBe(99999);
    });
  });

  describe('removePid()', () => {
    it('removes PID file successfully', async () => {
      const { writePid, removePid, readPid } = await import('./pid-manager.js');
      await writePid(dataDir, 12345);
      await removePid(dataDir);
      const result = await readPid(dataDir);
      expect(result).toBeNull();
    });

    it('silently succeeds when PID file does not exist', async () => {
      const { removePid } = await import('./pid-manager.js');
      await expect(removePid(dataDir)).resolves.toBeUndefined();
    });
  });

  describe('processExists()', () => {
    it('returns true for the current process PID', async () => {
      const { processExists } = await import('./pid-manager.js');
      expect(processExists(process.pid)).toBe(true);
    });

    it('returns false for a PID that does not exist', async () => {
      const { processExists } = await import('./pid-manager.js');
      // Use a very high PID unlikely to exist
      expect(processExists(9999999)).toBe(false);
    });
  });

  describe('checkPidStatus()', () => {
    it('returns none when no PID file exists', async () => {
      const { checkPidStatus } = await import('./pid-manager.js');
      const result = await checkPidStatus(dataDir);
      expect(result.status).toBe('none');
      expect(result.pid).toBeNull();
    });

    it('returns stale when PID file exists but process is dead', async () => {
      const { writePid, checkPidStatus } = await import('./pid-manager.js');
      // PID 9999999 is very unlikely to exist
      await writePid(dataDir, 9999999);
      const result = await checkPidStatus(dataDir);
      expect(result.status).toBe('stale');
      expect(result.pid).toBe(9999999);
    });

    it('returns alive when PID file exists, process alive, and is scrow daemon', async () => {
      // Reset and mock platform dependencies before importing the module
      vi.resetModules();
      // Mock isLinux/isMacOS so isScrowDaemonProcess takes the ps branch and we can control output
      vi.doMock('../platform/index.js', () => ({
        isLinux: () => false,
        isMacOS: () => true,
        getPaths: () => ({ data: dataDir, config: dataDir, logs: dataDir }),
        ensureDirectories: async () => {},
        AppPaths: undefined,
      }));
      // Mock execFile so ps returns a command line containing --daemon-runner
      vi.doMock('node:child_process', () => ({
        execFile: (
          _cmd: string,
          _args: string[],
          cb: (err: Error | null, result: { stdout: string }) => void,
        ) => {
          cb(null, { stdout: '--daemon-runner' });
        },
      }));
      const { writePid, checkPidStatus } = await import('./pid-manager.js');
      await writePid(dataDir, process.pid); // process.pid is guaranteed alive
      const result = await checkPidStatus(dataDir);
      expect(result.status).toBe('alive');
      expect(result.pid).toBe(process.pid);
    });

    it('returns stale when PID exists but belongs to non-AUO process', async () => {
      vi.resetModules();
      vi.doMock('../platform/index.js', () => ({
        isLinux: () => false,
        isMacOS: () => true,
        getPaths: () => ({ data: dataDir, config: dataDir, logs: dataDir }),
        ensureDirectories: async () => {},
        AppPaths: undefined,
      }));
      // Mock execFile so ps returns a command line that does NOT contain --daemon-runner
      vi.doMock('node:child_process', () => ({
        execFile: (
          _cmd: string,
          _args: string[],
          cb: (err: Error | null, result: { stdout: string }) => void,
        ) => {
          cb(null, { stdout: 'node some-other-process' });
        },
      }));
      const { writePid, checkPidStatus } = await import('./pid-manager.js');
      await writePid(dataDir, process.pid); // process.pid is alive but not an scrow daemon
      const result = await checkPidStatus(dataDir);
      expect(result.status).toBe('stale');
    });
  });

  describe('isScrowDaemonProcess()', () => {
    it('returns false for a non-existent PID', async () => {
      const { isScrowDaemonProcess } = await import('./pid-manager.js');
      const result = await isScrowDaemonProcess(9999999);
      expect(result).toBe(false);
    });

    it('returns false for the test process (not spawned with --daemon-runner)', async () => {
      const { isScrowDaemonProcess } = await import('./pid-manager.js');
      // The test process does not have --daemon-runner in its cmdline
      const result = await isScrowDaemonProcess(process.pid);
      expect(result).toBe(false);
    });
  });

  describe('killOrphanDaemons()', () => {
    it('skips own PID even when isScrowDaemonProcess returns true', async () => {
      vi.resetModules();
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((() => {}) as never);
      // Mock isLinux to return true and readdir to return our own PID
      vi.doMock('../platform/index.js', () => ({
        isLinux: () => true,
        isMacOS: () => false,
        getPaths: () => ({ data: dataDir, config: dataDir, logs: dataDir }),
        ensureDirectories: async () => {},
        AppPaths: undefined,
      }));
      vi.doMock('node:fs/promises', () => ({
        readdir: async (path: string) => {
          if (path === '/proc') return [String(process.pid)];
          return realReaddir(path);
        },
        readFile: async (path: string, encoding?: string) => {
          if (path === `/proc/${process.pid}/cmdline`) {
            return 'node\0sparecrow\0--daemon-runner\0';
          }
          return realReadFile(path, encoding as BufferEncoding);
        },
        unlink: realUnlink,
        writeFile: realWriteFile,
        mkdir,
        rm,
      }));
      const { killOrphanDaemons } = await import('./pid-manager.js');
      await killOrphanDaemons(process.pid);
      // Should NOT have called process.kill since it's our own PID
      expect(killSpy).not.toHaveBeenCalled();
    });

    it('kills process identified as daemon with SIGKILL', async () => {
      vi.resetModules();
      const killCalls: Array<[number, string | number]> = [];
      vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig: string | number) => {
        killCalls.push([pid, sig]);
      }) as never);
      vi.doMock('../platform/index.js', () => ({
        isLinux: () => true,
        isMacOS: () => false,
        getPaths: () => ({ data: dataDir, config: dataDir, logs: dataDir }),
        ensureDirectories: async () => {},
        AppPaths: undefined,
      }));
      const fakePid = 99887;
      vi.doMock('node:fs/promises', () => ({
        readdir: async (path: string) => {
          if (path === '/proc') return [String(fakePid)];
          return realReaddir(path);
        },
        readFile: async (path: string, encoding?: string) => {
          if (path === `/proc/${fakePid}/cmdline`) {
            return 'node\0sparecrow\0--daemon-runner\0';
          }
          return realReadFile(path, encoding as BufferEncoding);
        },
        unlink: realUnlink,
        writeFile: realWriteFile,
        mkdir,
        rm,
      }));
      const { killOrphanDaemons } = await import('./pid-manager.js');
      await killOrphanDaemons(process.pid);
      expect(killCalls).toEqual([[fakePid, 'SIGKILL']]);
    });

    it('continues on EPERM error when killing orphan process', async () => {
      vi.resetModules();
      vi.spyOn(process, 'kill').mockImplementation((() => {
        const err = new Error('Operation not permitted') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }) as never);
      vi.doMock('../platform/index.js', () => ({
        isLinux: () => true,
        isMacOS: () => false,
        getPaths: () => ({ data: dataDir, config: dataDir, logs: dataDir }),
        ensureDirectories: async () => {},
        AppPaths: undefined,
      }));
      const fakePid = 99886;
      vi.doMock('node:fs/promises', () => ({
        readdir: async (path: string) => {
          if (path === '/proc') return [String(fakePid)];
          return realReaddir(path);
        },
        readFile: async (path: string, encoding?: string) => {
          if (path === `/proc/${fakePid}/cmdline`) {
            return 'node\0sparecrow\0--daemon-runner\0';
          }
          return realReadFile(path, encoding as BufferEncoding);
        },
        unlink: realUnlink,
        writeFile: realWriteFile,
        mkdir,
        rm,
      }));
      const { killOrphanDaemons } = await import('./pid-manager.js');
      // Should not throw — EPERM is swallowed (AC2)
      await expect(killOrphanDaemons(process.pid)).resolves.toBeUndefined();
    });

    it('continues on ESRCH error when killing orphan process', async () => {
      vi.resetModules();
      vi.spyOn(process, 'kill').mockImplementation((() => {
        const err = new Error('No such process') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }) as never);
      vi.doMock('../platform/index.js', () => ({
        isLinux: () => true,
        isMacOS: () => false,
        getPaths: () => ({ data: dataDir, config: dataDir, logs: dataDir }),
        ensureDirectories: async () => {},
        AppPaths: undefined,
      }));
      const fakePid = 99885;
      vi.doMock('node:fs/promises', () => ({
        readdir: async (path: string) => {
          if (path === '/proc') return [String(fakePid)];
          return realReaddir(path);
        },
        readFile: async (path: string, encoding?: string) => {
          if (path === `/proc/${fakePid}/cmdline`) {
            return 'node\0sparecrow\0--daemon-runner\0';
          }
          return realReadFile(path, encoding as BufferEncoding);
        },
        unlink: realUnlink,
        writeFile: realWriteFile,
        mkdir,
        rm,
      }));
      const { killOrphanDaemons } = await import('./pid-manager.js');
      // Should not throw — ESRCH is swallowed (AC2)
      await expect(killOrphanDaemons(process.pid)).resolves.toBeUndefined();
    });

    it('handles /proc read failure gracefully', async () => {
      vi.resetModules();
      vi.doMock('../platform/index.js', () => ({
        isLinux: () => true,
        isMacOS: () => false,
        getPaths: () => ({ data: dataDir, config: dataDir, logs: dataDir }),
        ensureDirectories: async () => {},
        AppPaths: undefined,
      }));
      vi.doMock('node:fs/promises', () => ({
        readdir: async (path: string) => {
          if (path === '/proc') throw new Error('permission denied');
          return realReaddir(path);
        },
        readFile: realReadFile,
        unlink: realUnlink,
        writeFile: realWriteFile,
        mkdir,
        rm,
      }));
      const { killOrphanDaemons } = await import('./pid-manager.js');
      // Should not throw — entire scan failure is non-fatal (AC2)
      await expect(killOrphanDaemons(process.pid)).resolves.toBeUndefined();
    });

    it('exercises macOS findCandidatesFromPs() code path and kills orphan (AC2 non-fatal guaranteed)', async () => {
      vi.resetModules();
      const fakePid = 99884;
      const killCalls: Array<[number, string | number]> = [];
      vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig: string | number) => {
        killCalls.push([pid, sig]);
      }) as never);
      // Simulate macOS: isLinux=false, isMacOS=true — routes through findCandidatesFromPs()
      vi.doMock('../platform/index.js', () => ({
        isLinux: () => false,
        isMacOS: () => true,
        getPaths: () => ({ data: dataDir, config: dataDir, logs: dataDir }),
        ensureDirectories: async () => {},
        AppPaths: undefined,
      }));
      // Mock execFile so `ps ax -o pid=,command=` returns a line with --daemon-runner and our fakePid
      vi.doMock('node:child_process', () => ({
        execFile: (
          _cmd: string,
          _args: string[],
          cb: (err: Error | null, result: { stdout: string }) => void,
        ) => {
          // Output format: <pid> <command>
          cb(null, { stdout: `  ${fakePid} node sparecrow --daemon-runner\n` });
        },
      }));
      const { killOrphanDaemons } = await import('./pid-manager.js');
      await killOrphanDaemons(process.pid);
      // The orphan at fakePid should have been SIGKILLed
      expect(killCalls).toEqual([[fakePid, 'SIGKILL']]);
    });

    it('is non-fatal when macOS ps fails (AC2 guarantee for macOS path)', async () => {
      vi.resetModules();
      vi.doMock('../platform/index.js', () => ({
        isLinux: () => false,
        isMacOS: () => true,
        getPaths: () => ({ data: dataDir, config: dataDir, logs: dataDir }),
        ensureDirectories: async () => {},
        AppPaths: undefined,
      }));
      // Mock execFile so ps throws — findCandidatesFromPs() should return [] silently
      vi.doMock('node:child_process', () => ({
        execFile: (
          _cmd: string,
          _args: string[],
          cb: (err: Error | null, result: { stdout: string } | null) => void,
        ) => {
          cb(new Error('ps command not found'), null);
        },
      }));
      const { killOrphanDaemons } = await import('./pid-manager.js');
      // Should not throw — ps failure is swallowed inside findCandidatesFromPs()
      await expect(killOrphanDaemons(process.pid)).resolves.toBeUndefined();
    });
  });
});
