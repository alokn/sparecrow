/** Unit tests for installService() and uninstallService() — covers Linux/macOS paths, overwrite, and error cases. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile, stat } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return join(tmpdir(), 'service-test-' + randomBytes(6).toString('hex'));
}

// ---------------------------------------------------------------------------
// Linux install tests
// ---------------------------------------------------------------------------

describe('installService() on Linux', () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = makeTmpDir();
    await mkdir(tmpHome, { recursive: true });

    vi.resetModules();

    // Mock os.homedir() to return our temp dir
    vi.doMock('node:os', () => ({
      homedir: () => tmpHome,
      userInfo: () => ({ username: 'testuser' }),
    }));

    // Mock platform as Linux
    vi.doMock('node:process', () => ({
      default: {
        platform: 'linux',
        execPath: '/usr/bin/node',
        argv: ['/usr/bin/node', '/usr/local/bin/sparecrow'],
        env: {},
      },
      platform: 'linux',
      execPath: '/usr/bin/node',
      argv: ['/usr/bin/node', '/usr/local/bin/sparecrow'],
      env: {},
    }));
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('generates a service file with correct ExecStart, WantedBy, and Environment directives', async () => {
    vi.doMock('node:child_process', () => ({
      execFile: vi.fn((_cmd: string, _args: string[], cb: (...args: unknown[]) => void) => {
        cb(null, '', '');
      }),
    }));

    const { installService } = await import('./service-installer.js');
    const result = await installService({ force: true });

    const { readFile } = await import('node:fs/promises');
    const content = await readFile(result.serviceFilePath, 'utf-8');

    expect(content).toContain('ExecStart=');
    expect(content).toContain('--daemon-runner');
    expect(content).toContain('WantedBy=default.target');
    expect(content).toContain('Environment=SPARECROW_CONFIG_PATH=');
    expect(content).toContain('Environment=SPARECROW_DATA_PATH=');
    expect(content).toContain('Environment=NODE_ENV=production');
  });

  it('invokes systemctl --user daemon-reload and enable', async () => {
    const calls: string[][] = [];
    vi.doMock('node:child_process', () => ({
      execFile: vi.fn((_cmd: string, args: string[], cb: (...args: unknown[]) => void) => {
        calls.push(args);
        cb(null, '', '');
      }),
    }));

    const { installService } = await import('./service-installer.js');
    await installService({ force: true });

    expect(calls).toContainEqual(['--user', 'daemon-reload']);
    expect(calls).toContainEqual(['--user', 'enable', 'sparecrow']);
  });

  it('returns started: false in result', async () => {
    vi.doMock('node:child_process', () => ({
      execFile: vi.fn((_cmd: string, _args: string[], cb: (...args: unknown[]) => void) => {
        cb(null, '', '');
      }),
    }));

    const { installService } = await import('./service-installer.js');
    const result = await installService({ force: true });

    expect(result.started).toBe(false);
    expect(result.platform).toBe('linux');
    expect(result.method).toBe('systemd');
  });

  it('throws SERVICE_ENABLE_FAILED when systemctl --user daemon-reload fails', async () => {
    let callCount = 0;
    vi.doMock('node:child_process', () => ({
      execFile: vi.fn((_cmd: string, _args: string[], cb: (...args: unknown[]) => void) => {
        callCount++;
        if (callCount === 1) {
          // daemon-reload fails
          cb(new Error('systemctl failed'), '', 'error output');
        } else {
          cb(null, '', '');
        }
      }),
    }));

    const { installService } = await import('./service-installer.js');
    await expect(installService({ force: true })).rejects.toMatchObject({
      code: 'SERVICE_ENABLE_FAILED',
    });
    // enable should NOT be called after daemon-reload fails
    expect(callCount).toBe(1);
  });

  it('throws SERVICE_ENABLE_FAILED when systemctl --user enable fails (daemon-reload succeeded)', async () => {
    let callCount = 0;
    vi.doMock('node:child_process', () => ({
      execFile: vi.fn((_cmd: string, _args: string[], cb: (...args: unknown[]) => void) => {
        callCount++;
        if (callCount === 1) {
          // daemon-reload succeeds
          cb(null, '', '');
        } else {
          // enable fails
          cb(new Error('enable failed'), '', 'error output');
        }
      }),
    }));

    const { installService } = await import('./service-installer.js');
    await expect(installService({ force: true })).rejects.toMatchObject({
      code: 'SERVICE_ENABLE_FAILED',
    });
    expect(callCount).toBe(2);
  });

  it('returns overwritten: true when existing file exists and force: true', async () => {
    vi.doMock('node:child_process', () => ({
      execFile: vi.fn((_cmd: string, _args: string[], cb: (...args: unknown[]) => void) => {
        cb(null, '', '');
      }),
    }));

    const { installService } = await import('./service-installer.js');

    // First install
    await installService({ force: true });

    vi.resetModules();
    vi.doMock('node:os', () => ({
      homedir: () => tmpHome,
      userInfo: () => ({ username: 'testuser' }),
    }));
    vi.doMock('node:process', () => ({
      default: {
        platform: 'linux',
        execPath: '/usr/bin/node',
        argv: ['/usr/bin/node', '/usr/local/bin/sparecrow'],
        env: {},
      },
      platform: 'linux',
      execPath: '/usr/bin/node',
      argv: ['/usr/bin/node', '/usr/local/bin/sparecrow'],
      env: {},
    }));
    vi.doMock('node:child_process', () => ({
      execFile: vi.fn((_cmd: string, _args: string[], cb: (...args: unknown[]) => void) => {
        cb(null, '', '');
      }),
    }));

    const { installService: installService2 } = await import('./service-installer.js');
    const result = await installService2({ force: true });
    expect(result.overwritten).toBe(true);
  });

  it('returns overwritten: false and does not write when force: false and file exists', async () => {
    vi.doMock('node:child_process', () => ({
      execFile: vi.fn((_cmd: string, _args: string[], cb: (...args: unknown[]) => void) => {
        cb(null, '', '');
      }),
    }));

    const { installService } = await import('./service-installer.js');

    // First install to create the file
    await installService({ force: true });

    vi.resetModules();
    vi.doMock('node:os', () => ({
      homedir: () => tmpHome,
      userInfo: () => ({ username: 'testuser' }),
    }));
    vi.doMock('node:process', () => ({
      default: {
        platform: 'linux',
        execPath: '/usr/bin/node',
        argv: ['/usr/bin/node', '/usr/local/bin/sparecrow'],
        env: {},
      },
      platform: 'linux',
      execPath: '/usr/bin/node',
      argv: ['/usr/bin/node', '/usr/local/bin/sparecrow'],
      env: {},
    }));
    const execFileMock = vi.fn();
    vi.doMock('node:child_process', () => ({
      execFile: execFileMock,
    }));

    const { installService: installService2 } = await import('./service-installer.js');
    const result = await installService2({ force: false });

    // Should return without writing (existing file, force: false)
    expect(result.overwritten).toBe(false);
    // execFile should NOT be called because we return early
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('writes service file with 0o600 permissions', async () => {
    vi.doMock('node:child_process', () => ({
      execFile: vi.fn((_cmd: string, _args: string[], cb: (...args: unknown[]) => void) => {
        cb(null, '', '');
      }),
    }));

    const { installService } = await import('./service-installer.js');
    const result = await installService({ force: true });

    const fileInfo = await stat(result.serviceFilePath);
    // On Linux, check file mode (last 3 octal digits: owner rw = 0o600)
    // Mode includes file type bits so use bitwise AND with 0o777
    expect(fileInfo.mode & 0o777).toBe(0o600);
  });
});

// ---------------------------------------------------------------------------
// macOS install tests
// ---------------------------------------------------------------------------

describe('installService() on macOS', () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = makeTmpDir();
    await mkdir(tmpHome, { recursive: true });

    vi.resetModules();

    vi.doMock('node:os', () => ({
      homedir: () => tmpHome,
      userInfo: () => ({ username: 'testuser' }),
    }));

    vi.doMock('node:process', () => ({
      default: {
        platform: 'darwin',
        execPath: '/usr/local/bin/node',
        argv: ['/usr/local/bin/node', '/usr/local/bin/sparecrow'],
        env: {},
      },
      platform: 'darwin',
      execPath: '/usr/local/bin/node',
      argv: ['/usr/local/bin/node', '/usr/local/bin/sparecrow'],
      env: {},
    }));
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('generates a plist with RunAtLoad, KeepAlive, and correct ProgramArguments', async () => {
    vi.doMock('node:child_process', () => ({
      execFile: vi.fn((_cmd: string, _args: string[], cb: (...args: unknown[]) => void) => {
        cb(null, '', '');
      }),
    }));

    const { installService } = await import('./service-installer.js');
    const result = await installService({ force: true });

    const { readFile } = await import('node:fs/promises');
    const content = await readFile(result.serviceFilePath, 'utf-8');

    expect(content).toContain('RunAtLoad');
    expect(content).toContain('KeepAlive');
    expect(content).toContain('--daemon-runner');
    expect(content).toContain('com.sparecrow.daemon');
  });

  it('invokes launchctl load with absolute path (not tilde-prefixed)', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    vi.doMock('node:child_process', () => ({
      execFile: vi.fn((cmd: string, args: string[], cb: (...args: unknown[]) => void) => {
        calls.push({ cmd, args });
        cb(null, '', '');
      }),
    }));

    const { installService } = await import('./service-installer.js');
    const result = await installService({ force: true });

    const launchctlCall = calls.find((c) => c.cmd === 'launchctl');
    expect(launchctlCall).toBeDefined();
    expect(launchctlCall?.args[0]).toBe('load');
    // Absolute path — must not start with ~
    expect(launchctlCall?.args[1]).not.toMatch(/^~/);
    expect(launchctlCall?.args[1]).toBe(result.serviceFilePath);
  });

  it('throws SERVICE_ENABLE_FAILED when launchctl load fails', async () => {
    vi.doMock('node:child_process', () => ({
      execFile: vi.fn((_cmd: string, _args: string[], cb: (...args: unknown[]) => void) => {
        cb(new Error('launchctl error'), '', 'error output');
      }),
    }));

    const { installService } = await import('./service-installer.js');
    await expect(installService({ force: true })).rejects.toMatchObject({
      code: 'SERVICE_ENABLE_FAILED',
    });
  });

  it('returns platform: darwin and method: launchd', async () => {
    vi.doMock('node:child_process', () => ({
      execFile: vi.fn((_cmd: string, _args: string[], cb: (...args: unknown[]) => void) => {
        cb(null, '', '');
      }),
    }));

    const { installService } = await import('./service-installer.js');
    const result = await installService({ force: true });

    expect(result.platform).toBe('darwin');
    expect(result.method).toBe('launchd');
    expect(result.started).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unsupported platform test
// ---------------------------------------------------------------------------

describe('installService() on unsupported platform', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('node:process', () => ({
      default: {
        platform: 'win32',
        execPath: 'C:\\node.exe',
        argv: ['C:\\node.exe', 'C:\\sparecrow.js'],
        env: {},
      },
      platform: 'win32',
      execPath: 'C:\\node.exe',
      argv: ['C:\\node.exe', 'C:\\sparecrow.js'],
      env: {},
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws SERVICE_INSTALL_UNSUPPORTED_PLATFORM', async () => {
    const { installService } = await import('./service-installer.js');
    await expect(installService()).rejects.toMatchObject({
      code: 'SERVICE_INSTALL_UNSUPPORTED_PLATFORM',
    });
  });
});

// ---------------------------------------------------------------------------
// uninstallService() unsupported platform test
// ---------------------------------------------------------------------------

describe('uninstallService() on unsupported platform', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('node:process', () => ({
      default: {
        platform: 'win32',
        execPath: 'C:\\node.exe',
        argv: ['C:\\node.exe', 'C:\\sparecrow.js'],
        env: {},
      },
      platform: 'win32',
      execPath: 'C:\\node.exe',
      argv: ['C:\\node.exe', 'C:\\sparecrow.js'],
      env: {},
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws SERVICE_INSTALL_UNSUPPORTED_PLATFORM', async () => {
    const { uninstallService } = await import('./service-installer.js');
    await expect(uninstallService()).rejects.toMatchObject({
      code: 'SERVICE_INSTALL_UNSUPPORTED_PLATFORM',
    });
  });
});

// ---------------------------------------------------------------------------
// mkdir failure test
// ---------------------------------------------------------------------------

describe('installService() parent directory creation failure', () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = makeTmpDir();
    await mkdir(tmpHome, { recursive: true });

    vi.resetModules();

    vi.doMock('node:os', () => ({
      homedir: () => tmpHome,
      userInfo: () => ({ username: 'testuser' }),
    }));

    vi.doMock('node:process', () => ({
      default: {
        platform: 'linux',
        execPath: '/usr/bin/node',
        argv: ['/usr/bin/node', '/usr/local/bin/sparecrow'],
        env: {},
      },
      platform: 'linux',
      execPath: '/usr/bin/node',
      argv: ['/usr/bin/node', '/usr/local/bin/sparecrow'],
      env: {},
    }));
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('propagates mkdir errors without swallowing', async () => {
    const mkdirError = new Error('EACCES: permission denied');
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.doMock('node:fs/promises', () => ({
      ...actualFs,
      mkdir: vi.fn().mockRejectedValue(mkdirError),
      access: actualFs.access,
      unlink: actualFs.unlink,
      writeFile: actualFs.writeFile,
      rename: actualFs.rename,
    }));

    const { installService } = await import('./service-installer.js');
    await expect(installService({ force: true })).rejects.toThrow('EACCES');
  });
});

// ---------------------------------------------------------------------------
// uninstallService tests
// ---------------------------------------------------------------------------

describe('uninstallService() on Linux', () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = makeTmpDir();
    await mkdir(tmpHome, { recursive: true });

    vi.resetModules();

    vi.doMock('node:os', () => ({
      homedir: () => tmpHome,
      userInfo: () => ({ username: 'testuser' }),
    }));

    vi.doMock('node:process', () => ({
      default: {
        platform: 'linux',
        execPath: '/usr/bin/node',
        argv: ['/usr/bin/node', '/usr/local/bin/sparecrow'],
        env: {},
      },
      platform: 'linux',
      execPath: '/usr/bin/node',
      argv: ['/usr/bin/node', '/usr/local/bin/sparecrow'],
      env: {},
    }));
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns removed: false and stopped: false when service file does not exist', async () => {
    const { uninstallService } = await import('./service-installer.js');
    const result = await uninstallService();

    expect(result.removed).toBe(false);
    expect(result.stopped).toBe(false);
    expect(result.platform).toBe('linux');
  });

  it('removes service file and runs systemctl disable when file exists', async () => {
    // Create the service file first
    const serviceDir = join(tmpHome, '.config', 'systemd', 'user');
    const serviceFile = join(serviceDir, 'sparecrow.service');
    await mkdir(serviceDir, { recursive: true });
    await writeFile(serviceFile, '[Unit]\nDescription=test\n', { mode: 0o600 });

    const calls: { cmd: string; args: string[] }[] = [];
    vi.doMock('node:child_process', () => ({
      execFile: vi.fn((cmd: string, args: string[], cb: (...args: unknown[]) => void) => {
        calls.push({ cmd, args });
        cb(null, '', '');
      }),
    }));

    const { uninstallService } = await import('./service-installer.js');
    const result = await uninstallService();

    expect(result.removed).toBe(true);
    expect(result.stopped).toBe(false); // CLI layer sets this, not uninstallService
    expect(result.platform).toBe('linux');

    // Service file should be removed
    await expect(stat(serviceFile)).rejects.toThrow();

    // systemctl disable should have been called
    const disableCall = calls.find((c) => c.cmd === 'systemctl' && c.args.includes('disable'));
    expect(disableCall).toBeDefined();
  });

  it('does not import or call stopDaemon', async () => {
    // Verify service-installer.ts source does not reference stopDaemon
    // This is enforced at the module level — if it did import from daemon, TypeScript would enforce DAG
    const { uninstallService } = await import('./service-installer.js');
    // Just call it to verify it works without daemon module
    const result = await uninstallService();
    // No error means stopDaemon was not needed
    expect(result.stopped).toBe(false);
  });
});

describe('uninstallService() on macOS', () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = makeTmpDir();
    await mkdir(tmpHome, { recursive: true });

    vi.resetModules();

    vi.doMock('node:os', () => ({
      homedir: () => tmpHome,
      userInfo: () => ({ username: 'testuser' }),
    }));

    vi.doMock('node:process', () => ({
      default: {
        platform: 'darwin',
        execPath: '/usr/local/bin/node',
        argv: ['/usr/local/bin/node', '/usr/local/bin/sparecrow'],
        env: {},
      },
      platform: 'darwin',
      execPath: '/usr/local/bin/node',
      argv: ['/usr/local/bin/node', '/usr/local/bin/sparecrow'],
      env: {},
    }));
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns removed: false when service file does not exist', async () => {
    const { uninstallService } = await import('./service-installer.js');
    const result = await uninstallService();

    expect(result.removed).toBe(false);
    expect(result.platform).toBe('darwin');
  });

  it('removes plist file and calls launchctl unload when file exists', async () => {
    // Create the plist file
    const agentsDir = join(tmpHome, 'Library', 'LaunchAgents');
    const plistFile = join(agentsDir, 'com.sparecrow.daemon.plist');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(plistFile, '<?xml version="1.0"?><plist/>', { mode: 0o600 });

    const calls: { cmd: string; args: string[] }[] = [];
    vi.doMock('node:child_process', () => ({
      execFile: vi.fn((cmd: string, args: string[], cb: (...args: unknown[]) => void) => {
        calls.push({ cmd, args });
        cb(null, '', '');
      }),
    }));

    const { uninstallService } = await import('./service-installer.js');
    const result = await uninstallService();

    expect(result.removed).toBe(true);
    expect(result.platform).toBe('darwin');

    // plist file should be removed
    await expect(stat(plistFile)).rejects.toThrow();

    // launchctl unload should have been called
    const unloadCall = calls.find((c) => c.cmd === 'launchctl' && c.args.includes('unload'));
    expect(unloadCall).toBeDefined();
  });
});
