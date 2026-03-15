/** Integration test for Story 5.3 onboarding repo/queue/daemon flow — validates end-to-end with mocked external boundaries. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';

describe('onboarding repo + queue seeding flow — Story 5.3 end-to-end', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = join(tmpdir(), 'onboard-5-3-int-' + randomBytes(6).toString('hex'));
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('validates repository, seeds queue, and persists config in correct order', async () => {
    const configPath = join(tmpDir, 'config.yaml');

    // Mock platform paths
    vi.doMock('../../src/platform/index.js', () => ({
      getPaths: () => ({ config: tmpDir, data: tmpDir, logs: tmpDir }),
      installService: vi.fn().mockResolvedValue({
        platform: 'linux',
        serviceFilePath: '/tmp/service',
        method: 'systemd',
        overwritten: false,
        started: false,
      }),
      isLinux: () => true,
      isMacOS: () => false,
      getPlatformServicePath: () => join(tmpDir, 'service-file'),
      serviceFileExists: vi.fn().mockResolvedValue(false),
    }));

    vi.doMock('../../src/cli/index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => configPath,
    }));

    // Mock templates
    vi.doMock('../../src/templates/index.js', () => ({
      loadBuiltins: vi.fn().mockResolvedValue([
        { name: 'improve-code', description: 'Review code', prompt: 'Review this code', type: 'built-in' },
        { name: 'security-audit', description: 'Security review', prompt: 'Check security', type: 'built-in' },
      ]),
    }));

    // Step 1: Validate repository (use cwd — it's a real git repo in test env)
    const { validateRepository } = await import('../../src/utils/index.js');
    const repoResult = await validateRepository(process.cwd());
    expect(repoResult.valid).toBe(true);
    expect(repoResult.absolutePath).toBeTruthy();

    // Step 2: Persist config
    const { persistFullConfig } = await import(
      '../../src/cli/commands/onboard-repository-daemon.js'
    );
    await persistFullConfig(
      {
        triggerMaxWastePercentage: 50,
        triggerWeeklyReservePercentage: 30,
        triggerIdleHours: [],
        pollingInterval: 300,
        selectedTemplates: ['improve-code', 'security-audit'],
        allowDangerouslySkipPermissions: false,
      },
      repoResult.absolutePath,
    );
    const configContent = await readFile(configPath, 'utf-8');
    expect(configContent).toContain('max_waste_percentage: 50');
    expect(configContent).toContain('polling_interval: 300');

    // Step 3: Seed queue
    const { seedQueue } = await import('../../src/cli/commands/onboard-repository-daemon.js');
    const seedResult = await seedQueue(
      ['improve-code', 'security-audit'],
      repoResult.absolutePath,
    );
    expect(seedResult.seeded).toBe(2);
    expect(seedResult.skipped).toBe(0);
    expect(seedResult.seededTemplates).toEqual(['improve-code', 'security-audit']);

    // Verify queue file
    const queueContent = await readFile(join(tmpDir, 'queue.json'), 'utf-8');
    const queue = JSON.parse(queueContent) as { tasks: Array<{ templateName: string; targetPath: string }> };
    expect(queue.tasks).toHaveLength(2);
    expect(queue.tasks[0]!.targetPath).toBe(repoResult.absolutePath);

    // Step 4: Verify duplicate skip on re-seed
    const seedResult2 = await seedQueue(
      ['improve-code', 'security-audit'],
      repoResult.absolutePath,
    );
    expect(seedResult2.seeded).toBe(0);
    expect(seedResult2.skipped).toBe(2);
  });

  it('captures and restores snapshots on rollback', async () => {
    const configPath = join(tmpDir, 'config.yaml');
    const queuePath = join(tmpDir, 'queue.json');

    await writeFile(configPath, 'original_config: true\n');
    await writeFile(queuePath, '{"tasks":[]}');

    vi.doMock('../../src/platform/index.js', () => ({
      getPaths: () => ({ config: tmpDir, data: tmpDir, logs: tmpDir }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
      getPlatformServicePath: () => join(tmpDir, 'service-file'),
      serviceFileExists: vi.fn().mockResolvedValue(false),
    }));

    vi.doMock('../../src/cli/index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => configPath,
    }));

    const { captureSnapshots, rollbackSnapshots } = await import(
      '../../src/cli/commands/onboard-repository-daemon.js'
    );

    // Capture snapshots
    const snaps = await captureSnapshots();
    expect(snaps.configSnapshot).toBe('original_config: true\n');
    expect(snaps.queueSnapshot).toBe('{"tasks":[]}');

    // Simulate mutation
    await writeFile(configPath, 'mutated_config: true\n');
    await writeFile(queuePath, '{"tasks":[{"id":"1"}]}');

    // Rollback
    const ok = await rollbackSnapshots(configPath, snaps.configSnapshot, queuePath, snaps.queueSnapshot);
    expect(ok).toBe(true);

    // Verify restored
    const restoredConfig = await readFile(configPath, 'utf-8');
    expect(restoredConfig).toBe('original_config: true\n');
    const restoredQueue = await readFile(queuePath, 'utf-8');
    expect(restoredQueue).toBe('{"tasks":[]}');
  });

  it('renderFirstDispatchMessage includes template and repo names when tasks seeded', async () => {
    vi.doMock('../../src/platform/index.js', () => ({
      getPaths: () => ({ config: tmpDir, data: tmpDir }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
      getPlatformServicePath: () => join(tmpDir, 'service-file'),
      serviceFileExists: vi.fn().mockResolvedValue(false),
    }));
    vi.doMock('../../src/cli/index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(tmpDir, 'config.yaml'),
    }));

    const { renderFirstDispatchMessage } = await import(
      '../../src/cli/commands/onboard-repository-daemon.js'
    );

    const msg = renderFirstDispatchMessage(true, 2, ['improve-code', 'security-audit'], '/home/user/repo');
    expect(msg).toContain('improve-code');
    expect(msg).toContain('security-audit');
    expect(msg).toContain('/home/user/repo');
    expect(msg).toContain('surplus detected');
  });

  it('output does not contain credential material', async () => {
    vi.doMock('../../src/platform/index.js', () => ({
      getPaths: () => ({ config: tmpDir, data: tmpDir }),
      installService: vi.fn(),
      isLinux: () => true,
      isMacOS: () => false,
      getPlatformServicePath: () => join(tmpDir, 'service-file'),
      serviceFileExists: vi.fn().mockResolvedValue(false),
    }));
    vi.doMock('../../src/cli/index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(tmpDir, 'config.yaml'),
    }));

    const { renderFirstDispatchMessage } = await import(
      '../../src/cli/commands/onboard-repository-daemon.js'
    );

    const outputs = [
      renderFirstDispatchMessage(true, 2, ['improve-code'], '/tmp/repo'),
      renderFirstDispatchMessage(false, 0, [], '/tmp/repo'),
      renderFirstDispatchMessage(true, 0, [], '/tmp/repo'),
    ];
    for (const output of outputs) {
      expect(output).not.toMatch(/accessToken|refreshToken|Bearer/i);
    }
  });
});
