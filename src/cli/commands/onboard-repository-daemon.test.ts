/** Unit tests for onboard-repository-daemon — repo targeting, queue seeding, config persistence, daemon install. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

describe('seedQueue()', () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = join(tmpdir(), 'seed-queue-' + randomBytes(6).toString('hex'));
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('seeds templates into queue via QueueManager', async () => {
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: tempDir, config: tempDir }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
    }));
    vi.doMock('../../templates/index.js', () => ({
      loadBuiltins: vi.fn().mockResolvedValue([
        {
          name: 'improve-code',
          description: 'Review code',
          prompt: 'Review this code',
          type: 'built-in',
        },
        {
          name: 'security-audit',
          description: 'Security review',
          prompt: 'Check security',
          type: 'built-in',
        },
      ]),
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(tempDir, 'config.yaml'),
    }));

    const { seedQueue } = await import('./onboard-repository-daemon.js');
    const result = await seedQueue(['improve-code', 'security-audit'], '/tmp/repo');

    expect(result.seeded).toBe(2);
    expect(result.skipped).toBe(0);

    // Verify queue file was created
    const queueContent = await readFile(join(tempDir, 'queue.json'), 'utf-8');
    const parsed = JSON.parse(queueContent) as { tasks: Array<{ templateName: string }> };
    expect(parsed.tasks).toHaveLength(2);
    expect(parsed.tasks[0]!.templateName).toBe('improve-code');
    expect(parsed.tasks[1]!.templateName).toBe('security-audit');
  });

  it('skips duplicate pending tasks with same template+target', async () => {
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: tempDir, config: tempDir }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
    }));
    vi.doMock('../../templates/index.js', () => ({
      loadBuiltins: vi.fn().mockResolvedValue([
        {
          name: 'improve-code',
          description: 'Review code',
          prompt: 'Review this code',
          type: 'built-in',
        },
      ]),
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(tempDir, 'config.yaml'),
    }));

    const { seedQueue } = await import('./onboard-repository-daemon.js');

    // First seed
    const result1 = await seedQueue(['improve-code'], '/tmp/repo');
    expect(result1.seeded).toBe(1);

    // Second seed — should skip
    const result2 = await seedQueue(['improve-code'], '/tmp/repo');
    expect(result2.seeded).toBe(0);
    expect(result2.skipped).toBe(1);
  });

  it('returns 0/0 for empty template list', async () => {
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: tempDir, config: tempDir }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(tempDir, 'config.yaml'),
    }));

    const { seedQueue } = await import('./onboard-repository-daemon.js');
    const result = await seedQueue([], '/tmp/repo');
    expect(result.seeded).toBe(0);
    expect(result.skipped).toBe(0);
  });
});

describe('persistFullConfig()', () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = join(tmpdir(), 'persist-cfg-' + randomBytes(6).toString('hex'));
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('writes config.yaml with merged trigger and provider settings', async () => {
    const configPath = join(tempDir, 'config.yaml');
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: tempDir, config: tempDir }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => configPath,
    }));

    const { persistFullConfig } = await import('./onboard-repository-daemon.js');
    await persistFullConfig(
      {
        triggerMaxWastePercentage: 60,
        triggerWeeklyReservePercentage: 30,
        triggerIdleHours: [],
        pollingInterval: 120,
        selectedTemplates: ['improve-code'],
        allowDangerouslySkipPermissions: true,
        containerRuntime: 'docker' as const,
        containerRuntimeVersion: '24.0.1',
      },
      '/tmp/repo',
    );

    const content = await readFile(configPath, 'utf-8');
    expect(content).toContain('max_waste_percentage: 60');
    expect(content).toContain('weekly_reserve_percentage: 30');
    expect(content).toContain('polling_interval: 120');
    expect(content).toContain('allow_dangerously_skip_permissions: true');
  });

  it('preserves existing unrelated config keys', async () => {
    const configPath = join(tempDir, 'config.yaml');
    await writeFile(configPath, 'log_retention_days: 7\npolling_interval: 300\n');
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: tempDir, config: tempDir }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => configPath,
    }));

    const { persistFullConfig } = await import('./onboard-repository-daemon.js');
    await persistFullConfig(
      {
        triggerMaxWastePercentage: 50,
        triggerWeeklyReservePercentage: 30,
        triggerIdleHours: [],
        pollingInterval: 300,
        selectedTemplates: [],
        allowDangerouslySkipPermissions: false,
        containerRuntime: 'docker' as const,
        containerRuntimeVersion: '24.0.1',
      },
      '/tmp/repo',
    );

    const content = await readFile(configPath, 'utf-8');
    expect(content).toContain('log_retention_days: 7');
  });

  it('resolves config from platform path when --config flag is not set (getConfigPath returns null)', async () => {
    // Simulate the common production case: no --config flag, getConfigPath() returns null.
    // The ?? fallback must use join(getPaths().config, 'config.yaml') — a file path.
    const platformConfigDir = tempDir;
    const expectedConfigPath = join(platformConfigDir, 'config.yaml');

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: platformConfigDir, config: platformConfigDir }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => null,
    }));
    // Mock logger to prevent filesystem side effects; preserve atomicWrite for real I/O assertion
    const actualUtils =
      await vi.importActual<typeof import('../../utils/index.js')>('../../utils/index.js');
    vi.doMock('../../utils/index.js', () => ({
      ...actualUtils,
      logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    }));

    const { persistFullConfig } = await import('./onboard-repository-daemon.js');
    await persistFullConfig(
      {
        triggerMaxWastePercentage: 55,
        triggerWeeklyReservePercentage: 25,
        triggerIdleHours: [],
        pollingInterval: 180,
        selectedTemplates: [],
        allowDangerouslySkipPermissions: false,
        containerRuntime: 'docker' as const,
        containerRuntimeVersion: '24.0.1',
      },
      '/tmp/repo',
    );

    // Config must have been written to the file path (not the directory)
    const content = await readFile(expectedConfigPath, 'utf-8');
    expect(content).toContain('max_waste_percentage: 55');
    expect(content).toContain('weekly_reserve_percentage: 25');
  });

  it('writes idle_hours to config when triggerIdleHours is non-empty', async () => {
    const configPath = join(tempDir, 'config.yaml');
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: tempDir, config: tempDir }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => configPath,
    }));

    const { persistFullConfig } = await import('./onboard-repository-daemon.js');
    await persistFullConfig(
      {
        triggerMaxWastePercentage: 50,
        triggerWeeklyReservePercentage: 30,
        triggerIdleHours: [{ start: '22:00', end: '06:00' }],
        pollingInterval: 300,
        selectedTemplates: [],
        allowDangerouslySkipPermissions: false,
        containerRuntime: 'docker' as const,
        containerRuntimeVersion: '24.0.1',
      },
      '/tmp/repo',
    );

    const content = await readFile(configPath, 'utf-8');
    expect(content).toContain('idle_hours');
    expect(content).toContain('22:00');
    expect(content).toContain('06:00');
  });

  it('writes idle_hours with days when weekend entry is present', async () => {
    const configPath = join(tempDir, 'config.yaml');
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: tempDir, config: tempDir }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => configPath,
    }));

    const { persistFullConfig } = await import('./onboard-repository-daemon.js');
    await persistFullConfig(
      {
        triggerMaxWastePercentage: 50,
        triggerWeeklyReservePercentage: 30,
        triggerIdleHours: [
          { start: '22:00', end: '06:00' },
          { start: '00:00', end: '23:59', days: ['saturday', 'sunday'] as const },
        ],
        pollingInterval: 300,
        selectedTemplates: [],
        allowDangerouslySkipPermissions: false,
        containerRuntime: 'docker' as const,
        containerRuntimeVersion: '24.0.1',
      },
      '/tmp/repo',
    );

    const content = await readFile(configPath, 'utf-8');
    expect(content).toContain('idle_hours');
    expect(content).toContain('saturday');
    expect(content).toContain('sunday');
  });
});

describe('captureSnapshots() and rollbackSnapshots()', () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = join(tmpdir(), 'snapshots-' + randomBytes(6).toString('hex'));
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('captures null snapshots when files do not exist', async () => {
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: tempDir, config: tempDir }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(tempDir, 'config.yaml'),
    }));

    const { captureSnapshots } = await import('./onboard-repository-daemon.js');
    const snaps = await captureSnapshots();
    expect(snaps.configSnapshot).toBeNull();
    expect(snaps.queueSnapshot).toBeNull();
  });

  it('captures file content when files exist', async () => {
    const configPath = join(tempDir, 'config.yaml');
    const queuePath = join(tempDir, 'queue.json');
    await writeFile(configPath, 'original-config');
    await writeFile(queuePath, 'original-queue');

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: tempDir, config: tempDir }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => configPath,
    }));

    const { captureSnapshots } = await import('./onboard-repository-daemon.js');
    const snaps = await captureSnapshots();
    expect(snaps.configSnapshot).toBe('original-config');
    expect(snaps.queueSnapshot).toBe('original-queue');
  });

  it('rollback restores prior config content', async () => {
    const configPath = join(tempDir, 'config.yaml');
    const queuePath = join(tempDir, 'queue.json');
    await writeFile(configPath, 'modified-config');

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: tempDir, config: tempDir }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => configPath,
    }));

    const { rollbackSnapshots } = await import('./onboard-repository-daemon.js');
    const ok = await rollbackSnapshots(configPath, 'original-config', queuePath, null);
    expect(ok).toBe(true);

    const content = await readFile(configPath, 'utf-8');
    expect(content).toBe('original-config');
  });

  it('resolves config from platform path when --config flag is not set (captureSnapshots null-fallback)', async () => {
    // Exercises the getConfigPath() ?? join(getPaths().config, 'config.yaml') branch
    // in captureSnapshots() at onboard-repository-daemon.ts:340.
    const platformConfigDir = tempDir;
    const platformConfigFile = join(platformConfigDir, 'config.yaml');
    await writeFile(platformConfigFile, 'original-config-content');

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: platformConfigDir, config: platformConfigDir }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => null,
    }));

    const { captureSnapshots } = await import('./onboard-repository-daemon.js');
    const snaps = await captureSnapshots();

    // The configPath returned must be the file path, not the bare directory
    expect(snaps.configPath).toBe(platformConfigFile);
    // The snapshot content must match what was written to the file
    expect(snaps.configSnapshot).toBe('original-config-content');
  });

  it('rollback restores prior queue content when queueSnapshot is non-null (M3 line 405)', async () => {
    const configPath = join(tempDir, 'config.yaml');
    const queuePath = join(tempDir, 'queue.json');
    await writeFile(configPath, 'modified-config');
    await writeFile(queuePath, '{"tasks":[]}');

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: tempDir, config: tempDir }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => configPath,
    }));

    const { rollbackSnapshots } = await import('./onboard-repository-daemon.js');
    const originalQueueContent = '{"tasks":[{"id":"original"}]}';
    const ok = await rollbackSnapshots(
      configPath,
      'original-config',
      queuePath,
      originalQueueContent,
    );
    expect(ok).toBe(true);

    const queueContent = await readFile(queuePath, 'utf-8');
    expect(queueContent).toBe(originalQueueContent);
  });

  it('rollback returns false when queue restore fails (M3 lines 409-412)', async () => {
    const configPath = join(tempDir, 'config.yaml');
    const queuePath = join(tempDir, 'queue.json');
    await writeFile(configPath, 'modified-config');

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: tempDir, config: tempDir }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => configPath,
    }));
    // Mock atomicWrite to succeed for config but fail for queue
    let atomicWriteCallCount = 0;
    const actual =
      await vi.importActual<typeof import('../../utils/index.js')>('../../utils/index.js');
    vi.doMock('../../utils/index.js', () => ({
      ...actual,
      atomicWrite: vi.fn().mockImplementation(async () => {
        atomicWriteCallCount++;
        if (atomicWriteCallCount > 1) {
          throw new Error('queue write failed');
        }
      }),
      logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    }));

    const { rollbackSnapshots } = await import('./onboard-repository-daemon.js');
    const ok = await rollbackSnapshots(configPath, 'original-config', queuePath, '{"tasks":[]}');
    expect(ok).toBe(false);
  });
});

describe('renderFirstDispatchMessage()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns monitoring message with template/repo details when tasks seeded', async () => {
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: '/tmp', config: '/tmp' }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
      getPlatformServicePath: () => '/tmp/service',
      serviceFileExists: vi.fn().mockResolvedValue(false),
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => '/tmp/config.yaml',
    }));
    const { renderFirstDispatchMessage } = await import('./onboard-repository-daemon.js');
    const msg = renderFirstDispatchMessage(
      true,
      2,
      ['improve-code', 'security-audit'],
      '/home/user/repo',
    );
    expect(msg).toContain('surplus detected');
    expect(msg).toContain('improve-code');
    expect(msg).toContain('security-audit');
    expect(msg).toContain('/home/user/repo');
  });

  it('returns failure message when daemon is not healthy', async () => {
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: '/tmp', config: '/tmp' }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
      getPlatformServicePath: () => '/tmp/service',
      serviceFileExists: vi.fn().mockResolvedValue(false),
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => '/tmp/config.yaml',
    }));
    const { renderFirstDispatchMessage } = await import('./onboard-repository-daemon.js');
    const msg = renderFirstDispatchMessage(false, 2, ['improve-code'], '/tmp/repo');
    expect(msg).toContain('health verification failed');
  });

  it('returns no-tasks message when no tasks seeded', async () => {
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: '/tmp', config: '/tmp' }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
      getPlatformServicePath: () => '/tmp/service',
      serviceFileExists: vi.fn().mockResolvedValue(false),
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => '/tmp/config.yaml',
    }));
    const { renderFirstDispatchMessage } = await import('./onboard-repository-daemon.js');
    const msg = renderFirstDispatchMessage(true, 0, [], '/tmp/repo');
    expect(msg).toContain('No tasks were queued');
  });
});

describe('installAndStartDaemon()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws PLATFORM_UNSUPPORTED on unsupported platforms', async () => {
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: '/tmp', config: '/tmp' }),
      installService: vi.fn(),
      isLinux: () => false,
      isMacOS: () => false,
    }));
    vi.doMock('../../daemon/index.js', () => ({
      startDaemon: vi.fn(),
      getDaemonStatus: vi.fn(),
      DAEMON_RUNNER_FLAG: '--daemon-runner',
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => '/tmp/config.yaml',
    }));

    const { installAndStartDaemon } = await import('./onboard-repository-daemon.js');
    await expect(installAndStartDaemon()).rejects.toMatchObject({
      code: 'PLATFORM_UNSUPPORTED',
    });
  });

  it('calls installService and startDaemon on Linux', async () => {
    const installMock = vi.fn().mockResolvedValue({
      platform: 'linux',
      serviceFilePath: '/tmp/service',
      method: 'systemd',
      overwritten: false,
      started: false,
    });
    const startMock = vi.fn().mockResolvedValue({ pid: 42, dataDir: '/tmp' });
    const statusMock = vi
      .fn()
      .mockResolvedValue({ state: 'running', pid: 42, uptime: null, startedAt: null });

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: '/tmp', config: '/tmp' }),
      installService: installMock,
      isLinux: () => true,
      isMacOS: () => false,
    }));
    vi.doMock('../../daemon/index.js', () => ({
      startDaemon: startMock,
      getDaemonStatus: statusMock,
      DAEMON_RUNNER_FLAG: '--daemon-runner',
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => '/tmp/config.yaml',
    }));

    const { installAndStartDaemon } = await import('./onboard-repository-daemon.js');
    const result = await installAndStartDaemon();

    expect(installMock).toHaveBeenCalledWith({
      force: true,
      daemonRunnerFlag: '--daemon-runner',
    });
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(result.healthy).toBe(true);
    expect(result.pid).toBe(42);
  });

  it('handles DAEMON_ALREADY_RUNNING gracefully', async () => {
    const { ScrowError } = await import('../../errors/index.js');
    const { ErrorCode } = await import('../../errors/index.js');
    const installMock = vi.fn().mockResolvedValue({
      platform: 'linux',
      serviceFilePath: '/tmp/service',
      method: 'systemd',
      overwritten: false,
      started: false,
    });
    const startMock = vi
      .fn()
      .mockRejectedValue(
        new ScrowError(ErrorCode.DAEMON_ALREADY_RUNNING, 'Already running PID 99'),
      );
    const statusMock = vi.fn().mockResolvedValue({
      state: 'running',
      pid: 99,
      uptime: null,
      startedAt: null,
    });

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: '/tmp', config: '/tmp' }),
      installService: installMock,
      isLinux: () => true,
      isMacOS: () => false,
    }));
    vi.doMock('../../daemon/index.js', () => ({
      startDaemon: startMock,
      getDaemonStatus: statusMock,
      DAEMON_RUNNER_FLAG: '--daemon-runner',
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => '/tmp/config.yaml',
    }));

    const { installAndStartDaemon } = await import('./onboard-repository-daemon.js');
    const result = await installAndStartDaemon();
    expect(result.healthy).toBe(true);
    expect(result.pid).toBe(99);
  });
});

describe('detectExistingConfig()', () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = join(tmpdir(), 'detect-cfg-' + randomBytes(6).toString('hex'));
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns false when config does not exist', async () => {
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: tempDir, config: tempDir }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(tempDir, 'config.yaml'),
    }));

    const { detectExistingConfig } = await import('./onboard-repository-daemon.js');
    const result = await detectExistingConfig();
    expect(result).toBe(false);
  });

  it('returns true when config has trigger key', async () => {
    const configPath = join(tempDir, 'config.yaml');
    await writeFile(configPath, 'trigger:\n  max_waste_percentage: 50\n');
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: tempDir, config: tempDir }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => configPath,
    }));

    const { detectExistingConfig } = await import('./onboard-repository-daemon.js');
    const result = await detectExistingConfig();
    expect(result).toBe(true);
  });

  it('resolves config from platform path when --config flag is not set (getConfigPath returns null)', async () => {
    // Simulate the common production case: no --config flag, getConfigPath() returns null.
    // The ?? fallback must use join(getPaths().config, 'config.yaml') — a file path.
    const platformConfigDir = tempDir;
    const platformConfigFile = join(platformConfigDir, 'config.yaml');
    await writeFile(platformConfigFile, 'provider:\n  name: claude-code\n');

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: platformConfigDir, config: platformConfigDir }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => null,
    }));
    // Mock logger for consistency with onboard-auth.test.ts mocking convention
    const actual =
      await vi.importActual<typeof import('../../utils/index.js')>('../../utils/index.js');
    vi.doMock('../../utils/index.js', () => ({
      ...actual,
      logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    }));

    const { detectExistingConfig } = await import('./onboard-repository-daemon.js');
    // Config has 'provider' key — should be detected as existing
    const result = await detectExistingConfig();
    expect(result).toBe(true);
  });

  it('returns false when config YAML parses but has no trigger or provider keys (M3 line 452)', async () => {
    const configPath = join(tempDir, 'config.yaml');
    // Valid YAML that parses to an object but lacks trigger/provider keys
    await writeFile(configPath, 'polling_interval: 300\n');

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: tempDir, config: tempDir }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => configPath,
    }));

    const { detectExistingConfig } = await import('./onboard-repository-daemon.js');
    const result = await detectExistingConfig();
    expect(result).toBe(false);
  });
});

describe('runRepoStage()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns cancel symbol when user cancels', async () => {
    const cancelSymbol = Symbol('cancel');
    vi.doMock('@clack/prompts', () => ({
      text: vi.fn().mockResolvedValue(cancelSymbol),
      select: vi.fn(),
      confirm: vi.fn(),
      isCancel: vi.fn((v: unknown) => v === cancelSymbol),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    const actual =
      await vi.importActual<typeof import('../../utils/index.js')>('../../utils/index.js');
    vi.doMock('../../utils/index.js', () => ({
      ...actual,
      validateRepository: vi
        .fn()
        .mockResolvedValue({ valid: false, absolutePath: '/tmp', error: 'Not a git repository' }),
    }));
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: '/tmp', config: '/tmp' }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
      getPlatformServicePath: () => '/tmp/service',
      serviceFileExists: vi.fn().mockResolvedValue(false),
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => '/tmp/config.yaml',
    }));

    const { runRepoStage } = await import('./onboard-repository-daemon.js');
    const result = await runRepoStage();
    expect(typeof result).toBe('symbol');
  });

  it('returns targetPath on valid repository input', async () => {
    vi.doMock('@clack/prompts', () => ({
      text: vi.fn().mockResolvedValue('/tmp/valid-repo'),
      select: vi.fn(),
      confirm: vi.fn(),
      isCancel: vi.fn().mockReturnValue(false),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    const actual =
      await vi.importActual<typeof import('../../utils/index.js')>('../../utils/index.js');
    vi.doMock('../../utils/index.js', () => ({
      ...actual,
      validateRepository: vi
        .fn()
        .mockResolvedValue({ valid: true, absolutePath: '/tmp/valid-repo', error: null }),
    }));
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: '/tmp', config: '/tmp' }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
      getPlatformServicePath: () => '/tmp/service',
      serviceFileExists: vi.fn().mockResolvedValue(false),
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => '/tmp/config.yaml',
    }));

    const { runRepoStage } = await import('./onboard-repository-daemon.js');
    const result = await runRepoStage();
    expect(result).toEqual({ targetPath: '/tmp/valid-repo' });
  });
});

describe('runSummaryStage()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns confirm when user presses Enter', async () => {
    vi.doMock('@clack/prompts', () => ({
      text: vi.fn().mockResolvedValue(''),
      select: vi.fn(),
      confirm: vi.fn(),
      isCancel: vi.fn().mockReturnValue(false),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: '/tmp', config: '/tmp' }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
      getPlatformServicePath: () => '/tmp/service',
      serviceFileExists: vi.fn().mockResolvedValue(false),
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => '/tmp/config.yaml',
    }));

    const { runSummaryStage } = await import('./onboard-repository-daemon.js');
    const result = await runSummaryStage(
      {
        triggerMaxWastePercentage: 50,
        triggerWeeklyReservePercentage: 30,
        triggerIdleHours: [],
        pollingInterval: 300,
        selectedTemplates: ['improve-code'],
        allowDangerouslySkipPermissions: false,
        containerRuntime: 'docker' as const,
        containerRuntimeVersion: '24.0.1',
      },
      '/tmp/repo',
      false,
    );
    expect(result).toBe('confirm');
  });

  it('returns edit when user types e', async () => {
    vi.doMock('@clack/prompts', () => ({
      text: vi.fn().mockResolvedValue('e'),
      select: vi.fn(),
      confirm: vi.fn(),
      isCancel: vi.fn().mockReturnValue(false),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: '/tmp', config: '/tmp' }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
      getPlatformServicePath: () => '/tmp/service',
      serviceFileExists: vi.fn().mockResolvedValue(false),
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => '/tmp/config.yaml',
    }));

    const { runSummaryStage } = await import('./onboard-repository-daemon.js');
    const result = await runSummaryStage(
      {
        triggerMaxWastePercentage: 50,
        triggerWeeklyReservePercentage: 30,
        triggerIdleHours: [],
        pollingInterval: 300,
        selectedTemplates: [],
        allowDangerouslySkipPermissions: false,
        containerRuntime: 'docker' as const,
        containerRuntimeVersion: '24.0.1',
      },
      '/tmp/repo',
      true,
    );
    expect(result).toBe('edit');
  });
});

describe('runEditStageSelector()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns selected stage name', async () => {
    vi.doMock('@clack/prompts', () => ({
      text: vi.fn(),
      select: vi.fn().mockResolvedValue('repo'),
      confirm: vi.fn(),
      isCancel: vi.fn().mockReturnValue(false),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: '/tmp', config: '/tmp' }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
      getPlatformServicePath: () => '/tmp/service',
      serviceFileExists: vi.fn().mockResolvedValue(false),
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => '/tmp/config.yaml',
    }));

    const { runEditStageSelector } = await import('./onboard-repository-daemon.js');
    const result = await runEditStageSelector();
    expect(result).toBe('repo');
  });

  it('returns cancel symbol when user cancels', async () => {
    const cancelSymbol = Symbol('cancel');
    vi.doMock('@clack/prompts', () => ({
      text: vi.fn(),
      select: vi.fn().mockResolvedValue(cancelSymbol),
      confirm: vi.fn(),
      isCancel: vi.fn((v: unknown) => v === cancelSymbol),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: '/tmp', config: '/tmp' }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
      getPlatformServicePath: () => '/tmp/service',
      serviceFileExists: vi.fn().mockResolvedValue(false),
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => '/tmp/config.yaml',
    }));

    const { runEditStageSelector } = await import('./onboard-repository-daemon.js');
    const result = await runEditStageSelector();
    expect(typeof result).toBe('symbol');
  });
});

describe('promptInstallDaemon()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true when user confirms', async () => {
    vi.doMock('@clack/prompts', () => ({
      text: vi.fn(),
      select: vi.fn(),
      confirm: vi.fn().mockResolvedValue(true),
      isCancel: vi.fn().mockReturnValue(false),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: '/tmp', config: '/tmp' }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
      getPlatformServicePath: () => '/tmp/service',
      serviceFileExists: vi.fn().mockResolvedValue(false),
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => '/tmp/config.yaml',
    }));

    const { promptInstallDaemon } = await import('./onboard-repository-daemon.js');
    const result = await promptInstallDaemon();
    expect(result).toBe(true);
  });

  it('returns false when user declines', async () => {
    vi.doMock('@clack/prompts', () => ({
      text: vi.fn(),
      select: vi.fn(),
      confirm: vi.fn().mockResolvedValue(false),
      isCancel: vi.fn().mockReturnValue(false),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: '/tmp', config: '/tmp' }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
      getPlatformServicePath: () => '/tmp/service',
      serviceFileExists: vi.fn().mockResolvedValue(false),
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => '/tmp/config.yaml',
    }));

    const { promptInstallDaemon } = await import('./onboard-repository-daemon.js');
    const result = await promptInstallDaemon();
    expect(result).toBe(false);
  });
});

describe('promptReconfigure()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns reconfigure when user selects it', async () => {
    vi.doMock('@clack/prompts', () => ({
      text: vi.fn(),
      select: vi.fn().mockResolvedValue('reconfigure'),
      confirm: vi.fn(),
      isCancel: vi.fn().mockReturnValue(false),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: '/tmp', config: '/tmp' }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
      getPlatformServicePath: () => '/tmp/service',
      serviceFileExists: vi.fn().mockResolvedValue(false),
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => '/tmp/config.yaml',
    }));

    const { promptReconfigure } = await import('./onboard-repository-daemon.js');
    const result = await promptReconfigure();
    expect(result).toBe('reconfigure');
  });

  it('returns exit when user selects it', async () => {
    vi.doMock('@clack/prompts', () => ({
      text: vi.fn(),
      select: vi.fn().mockResolvedValue('exit'),
      confirm: vi.fn(),
      isCancel: vi.fn().mockReturnValue(false),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: '/tmp', config: '/tmp' }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
      getPlatformServicePath: () => '/tmp/service',
      serviceFileExists: vi.fn().mockResolvedValue(false),
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => '/tmp/config.yaml',
    }));

    const { promptReconfigure } = await import('./onboard-repository-daemon.js');
    const result = await promptReconfigure();
    expect(result).toBe('exit');
  });
});

describe('cleanupServiceArtifacts()', () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = join(tmpdir(), 'cleanup-svc-' + randomBytes(6).toString('hex'));
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('removes service file when it exists', async () => {
    const servicePath = join(tempDir, 'sparecrow.service');
    await writeFile(servicePath, 'service content');

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: tempDir, config: tempDir }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
      getPlatformServicePath: () => servicePath,
      serviceFileExists: vi.fn().mockResolvedValue(true),
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(tempDir, 'config.yaml'),
    }));

    const { cleanupServiceArtifacts } = await import('./onboard-repository-daemon.js');
    await cleanupServiceArtifacts();

    // Verify file was removed
    let exists = true;
    try {
      await readFile(servicePath, 'utf-8');
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it('does not throw when service file does not exist', async () => {
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: tempDir, config: tempDir }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
      getPlatformServicePath: () => join(tempDir, 'nonexistent.service'),
      serviceFileExists: vi.fn().mockResolvedValue(false),
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(tempDir, 'config.yaml'),
    }));

    const { cleanupServiceArtifacts } = await import('./onboard-repository-daemon.js');
    await expect(cleanupServiceArtifacts()).resolves.toBeUndefined();
  });

  it('logs error and does not throw when getPlatformServicePath throws (M3 line 432)', async () => {
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: tempDir, config: tempDir }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
      getPlatformServicePath: () => {
        throw new Error('platform not supported');
      },
      serviceFileExists: vi.fn().mockResolvedValue(false),
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(tempDir, 'config.yaml'),
    }));

    const { cleanupServiceArtifacts } = await import('./onboard-repository-daemon.js');
    // Should not throw — errors are caught and logged
    await expect(cleanupServiceArtifacts()).resolves.toBeUndefined();
  });
});

describe('persistFullConfig() — container settings (Story 12.3)', () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = join(tmpdir(), 'persist-container-' + randomBytes(6).toString('hex'));
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('writes execution_backend and container.runtime when executionBackend is container (9.1)', async () => {
    const configPath = join(tempDir, 'config.yaml');
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: tempDir, config: tempDir }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => configPath,
    }));

    const { persistFullConfig } = await import('./onboard-repository-daemon.js');
    await persistFullConfig(
      {
        triggerMaxWastePercentage: 50,
        triggerWeeklyReservePercentage: 30,
        triggerIdleHours: [],
        pollingInterval: 300,
        selectedTemplates: [],
        allowDangerouslySkipPermissions: false,
        containerRuntime: 'podman' as const,
      },
      '/tmp/repo',
    );

    const content = await readFile(configPath, 'utf-8');
    expect(content).toContain('execution_backend: container');
    expect(content).toContain('runtime: podman');
  });

  it('always writes execution_backend: container (9.2)', async () => {
    const configPath = join(tempDir, 'config.yaml');
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: tempDir, config: tempDir }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => configPath,
    }));

    const { persistFullConfig } = await import('./onboard-repository-daemon.js');
    await persistFullConfig(
      {
        triggerMaxWastePercentage: 50,
        triggerWeeklyReservePercentage: 30,
        triggerIdleHours: [],
        pollingInterval: 300,
        selectedTemplates: [],
        allowDangerouslySkipPermissions: false,
        containerRuntime: 'docker' as const,
        containerRuntimeVersion: '24.0.1',
      },
      '/tmp/repo',
    );

    const content = await readFile(configPath, 'utf-8');
    expect(content).toContain('execution_backend: container');
  });

  it('preserves existing container settings like memory_limit_mb (9.3)', async () => {
    const configPath = join(tempDir, 'config.yaml');
    await writeFile(
      configPath,
      [
        'provider:',
        '  name: claude-code',
        '  allow_dangerously_skip_permissions: false',
        '  execution_backend: container',
        '  container:',
        '    runtime: docker',
        '    memory_limit_mb: 1024',
        '    cpu_limit: 2',
        '',
      ].join('\n'),
    );

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: tempDir, config: tempDir }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => configPath,
    }));

    const { persistFullConfig } = await import('./onboard-repository-daemon.js');
    await persistFullConfig(
      {
        triggerMaxWastePercentage: 50,
        triggerWeeklyReservePercentage: 30,
        triggerIdleHours: [],
        pollingInterval: 300,
        selectedTemplates: [],
        allowDangerouslySkipPermissions: false,
        containerRuntime: 'podman' as const,
      },
      '/tmp/repo',
    );

    const content = await readFile(configPath, 'utf-8');
    const { parse: parseYaml } = await import('yaml');
    const parsed = parseYaml(content) as Record<string, Record<string, Record<string, unknown>>>;
    expect(parsed['provider']!['container']!['memory_limit_mb']).toBe(1024);
    expect(parsed['provider']!['container']!['cpu_limit']).toBe(2);
    expect(parsed['provider']!['container']!['runtime']).toBe('podman');
    expect(parsed['provider']!['execution_backend']).toBe('container');
  });

  it('updates runtime when switching from docker to podman in existing container config (9.4)', async () => {
    const configPath = join(tempDir, 'config.yaml');
    await writeFile(
      configPath,
      [
        'provider:',
        '  name: claude-code',
        '  allow_dangerously_skip_permissions: false',
        '  execution_backend: container',
        '  container:',
        '    runtime: docker',
        '    memory_limit_mb: 1024',
        '',
      ].join('\n'),
    );

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: tempDir, config: tempDir }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => configPath,
    }));

    const { persistFullConfig } = await import('./onboard-repository-daemon.js');
    await persistFullConfig(
      {
        triggerMaxWastePercentage: 50,
        triggerWeeklyReservePercentage: 30,
        triggerIdleHours: [],
        pollingInterval: 300,
        selectedTemplates: [],
        allowDangerouslySkipPermissions: false,
        containerRuntime: 'podman' as const,
        containerRuntimeVersion: '5.2.0',
      },
      '/tmp/repo',
    );

    const content = await readFile(configPath, 'utf-8');
    expect(content).toContain('execution_backend: container');
    expect(content).toContain('runtime: podman');
    expect(content).toContain('memory_limit_mb: 1024');
  });

  it('succeeds when executionBackend is container but containerRuntime is undefined (9.5)', async () => {
    const configPath = join(tempDir, 'config.yaml');
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: tempDir, config: tempDir }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => configPath,
    }));

    const { persistFullConfig } = await import('./onboard-repository-daemon.js');
    // containerRuntime is undefined -- runtime defaults to 'auto' in schema
    await expect(
      persistFullConfig(
        {
          triggerMaxWastePercentage: 50,
          triggerWeeklyReservePercentage: 30,
          triggerIdleHours: [],
          pollingInterval: 300,
          selectedTemplates: [],
          allowDangerouslySkipPermissions: false,
        },
        '/tmp/repo',
      ),
    ).resolves.toBeUndefined();
  });
});

describe('runSummaryStage() — execution backend display (Story 12.3)', () => {
  let stdoutOutput: string;

  beforeEach(() => {
    vi.resetModules();
    stdoutOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('displays container backend with runtime and version (9.6)', async () => {
    vi.doMock('@clack/prompts', () => ({
      text: vi.fn().mockResolvedValue(''),
      select: vi.fn(),
      confirm: vi.fn(),
      isCancel: vi.fn().mockReturnValue(false),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: '/tmp', config: '/tmp' }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
      getPlatformServicePath: () => '/tmp/service',
      serviceFileExists: vi.fn().mockResolvedValue(false),
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => '/tmp/config.yaml',
    }));

    const { runSummaryStage } = await import('./onboard-repository-daemon.js');
    await runSummaryStage(
      {
        triggerMaxWastePercentage: 50,
        triggerWeeklyReservePercentage: 30,
        triggerIdleHours: [],
        pollingInterval: 300,
        selectedTemplates: [],
        allowDangerouslySkipPermissions: false,
        containerRuntime: 'podman' as const,
        containerRuntimeVersion: '5.2.0',
      },
      '/tmp/repo',
      false,
    );
    expect(stdoutOutput).toContain('Execution backend:     container (podman, v5.2.0)');
  });

  it('displays container backend with auto runtime when containerRuntime is not set (9.7)', async () => {
    vi.doMock('@clack/prompts', () => ({
      text: vi.fn().mockResolvedValue(''),
      select: vi.fn(),
      confirm: vi.fn(),
      isCancel: vi.fn().mockReturnValue(false),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: '/tmp', config: '/tmp' }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
      getPlatformServicePath: () => '/tmp/service',
      serviceFileExists: vi.fn().mockResolvedValue(false),
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => '/tmp/config.yaml',
    }));

    const { runSummaryStage } = await import('./onboard-repository-daemon.js');
    await runSummaryStage(
      {
        triggerMaxWastePercentage: 50,
        triggerWeeklyReservePercentage: 30,
        triggerIdleHours: [],
        pollingInterval: 300,
        selectedTemplates: [],
        allowDangerouslySkipPermissions: false,
      },
      '/tmp/repo',
      false,
    );
    expect(stdoutOutput).toContain('Execution backend:     container (auto, version unknown)');
  });

  it('displays version unknown format correctly when containerRuntimeVersion is unknown (H3)', async () => {
    vi.doMock('@clack/prompts', () => ({
      text: vi.fn().mockResolvedValue(''),
      select: vi.fn(),
      confirm: vi.fn(),
      isCancel: vi.fn().mockReturnValue(false),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: '/tmp', config: '/tmp' }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
      getPlatformServicePath: () => '/tmp/service',
      serviceFileExists: vi.fn().mockResolvedValue(false),
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => '/tmp/config.yaml',
    }));

    const { runSummaryStage } = await import('./onboard-repository-daemon.js');
    await runSummaryStage(
      {
        triggerMaxWastePercentage: 50,
        triggerWeeklyReservePercentage: 30,
        triggerIdleHours: [],
        pollingInterval: 300,
        selectedTemplates: [],
        allowDangerouslySkipPermissions: false,
        containerRuntime: 'podman' as const,
        containerRuntimeVersion: 'unknown',
      },
      '/tmp/repo',
      false,
    );
    // Must render "version unknown" not "vunknown"
    expect(stdoutOutput).toContain('container (podman, version unknown)');
    expect(stdoutOutput).not.toContain('vunknown');
  });

  it('displays version unknown when containerRuntimeVersion is undefined (H3-undefined)', async () => {
    vi.doMock('@clack/prompts', () => ({
      text: vi.fn().mockResolvedValue(''),
      select: vi.fn(),
      confirm: vi.fn(),
      isCancel: vi.fn().mockReturnValue(false),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: '/tmp', config: '/tmp' }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
      getPlatformServicePath: () => '/tmp/service',
      serviceFileExists: vi.fn().mockResolvedValue(false),
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => '/tmp/config.yaml',
    }));

    const { runSummaryStage } = await import('./onboard-repository-daemon.js');
    await runSummaryStage(
      {
        triggerMaxWastePercentage: 50,
        triggerWeeklyReservePercentage: 30,
        triggerIdleHours: [],
        pollingInterval: 300,
        selectedTemplates: [],
        allowDangerouslySkipPermissions: false,
        containerRuntime: 'docker' as const,
        containerRuntimeVersion: undefined,
      },
      '/tmp/repo',
      false,
    );
    expect(stdoutOutput).toContain('container (docker, version unknown)');
  });
});

describe('runEditStageSelector() — no backend option (Story 10-13)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not include backend option in edit selector', async () => {
    const selectMock = vi.fn().mockResolvedValue('repo');
    vi.doMock('@clack/prompts', () => ({
      text: vi.fn(),
      select: selectMock,
      confirm: vi.fn(),
      isCancel: vi.fn().mockReturnValue(false),
      spinner: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    }));
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ data: '/tmp', config: '/tmp' }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
      getPlatformServicePath: () => '/tmp/service',
      serviceFileExists: vi.fn().mockResolvedValue(false),
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => '/tmp/config.yaml',
    }));

    const { runEditStageSelector } = await import('./onboard-repository-daemon.js');
    await runEditStageSelector();

    // Verify the select was called with options that do NOT include 'backend'
    const options = selectMock.mock.calls[0]![0] as {
      options: Array<{ value: string; label: string }>;
    };
    const backendOption = options.options.find((o: { value: string }) => o.value === 'backend');
    expect(backendOption).toBeUndefined();
  });
});
