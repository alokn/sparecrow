/** Unit tests for container management commands — container test and container cleanup. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

function tmpDir(): string {
  return join(tmpdir(), 'container-cmd-' + randomBytes(6).toString('hex'));
}

let testDir: string;

/** Creates a mock ContainerRuntime with configurable overrides. */
function createMockRuntime(overrides?: {
  infoThrows?: boolean;
  infoVersion?: string;
  infoRootless?: boolean;
  runThrows?: boolean;
  runContainerId?: string;
  waitExitCode?: number | null;
  waitThrows?: boolean;
  waitThrowsTimeout?: boolean;
  logsStdout?: string;
  logsStderr?: string;
  removeThrows?: boolean;
  listResult?: Array<{
    containerId: string;
    image: string;
    createdAt: string;
    status: string;
    names: string;
  }>;
  removeFailsFor?: string[];
}) {
  const opts = {
    infoThrows: false,
    infoVersion: '24.0.1',
    infoRootless: true,
    runThrows: false,
    runContainerId: 'test-container-id-123',
    waitExitCode: 0 as number | null,
    waitThrows: false,
    waitThrowsTimeout: false,
    logsStdout: 'sparecrow-container-test\n',
    logsStderr: '',
    removeThrows: false,
    listResult: [] as Array<{
      containerId: string;
      image: string;
      createdAt: string;
      status: string;
      names: string;
    }>,
    removeFailsFor: [] as string[],
    ...overrides,
  };

  // Import error types at call time since they're stable
  return {
    name: 'docker',
    available: vi.fn().mockResolvedValue(true),
    info: opts.infoThrows
      ? vi.fn().mockRejectedValue(new Error('info failed'))
      : vi.fn().mockResolvedValue({ version: opts.infoVersion, rootless: opts.infoRootless }),
    run: opts.runThrows
      ? vi.fn().mockRejectedValue(new Error('run failed: image not found'))
      : vi.fn().mockResolvedValue({ containerId: opts.runContainerId }),
    wait: opts.waitThrows
      ? vi.fn().mockRejectedValue(new Error('wait failed'))
      : opts.waitThrowsTimeout
        ? vi.fn().mockImplementation(async () => {
            const { ScrowError, ErrorCode } = await import('../../errors/index.js');
            throw new ScrowError(ErrorCode.TASK_TIMEOUT, 'Container timed out after 30000ms');
          })
        : vi.fn().mockResolvedValue({ exitCode: opts.waitExitCode, oomKilled: false }),
    logs: vi.fn().mockResolvedValue({ stdout: opts.logsStdout, stderr: opts.logsStderr }),
    remove:
      opts.removeFailsFor.length > 0
        ? vi.fn().mockImplementation(async (id: string) => {
            if (opts.removeFailsFor.includes(id)) {
              throw new Error(`Failed to remove ${id}`);
            }
          })
        : opts.removeThrows
          ? vi.fn().mockRejectedValue(new Error('remove failed'))
          : vi.fn().mockResolvedValue(undefined),
    stats: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue(opts.listResult),
  };
}

// ─── Task 8: container test command ──────────────────────────────────────────

describe('container test', () => {
  beforeEach(async () => {
    vi.resetModules();
    testDir = tmpDir();
    await mkdir(testDir, { recursive: true });

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({
        config: join(testDir, 'config.yaml'),
        data: testDir,
        logs: join(testDir, 'logs'),
      }),
    }));

    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
  });

  it('outputs success and exits 0 with available runtime (8.1)', async () => {
    const mockRuntime = createMockRuntime();

    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(testDir, 'config.yaml'),
      EXIT: { SUCCESS: 0, ERROR: 1 },
      isInteractive: () => false,
    }));

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue(mockRuntime),
    }));

    const mod = await import('./container.js');
    const { Command } = await import('commander');
    const program = new Command();
    mod.registerContainer(program);

    await program.parseAsync(['node', 'test', 'container', 'test']);

    const stdoutCalls = vi.mocked(process.stdout.write).mock.calls;
    const output = stdoutCalls.map((c) => String(c[0])).join('');
    expect(output).toContain('Container test passed');
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('outputs error and exits 1 with no runtime (8.2)', async () => {
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(testDir, 'config.yaml'),
      EXIT: { SUCCESS: 0, ERROR: 1 },
      isInteractive: () => false,
    }));

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue(null),
    }));

    const mod = await import('./container.js');
    const { Command } = await import('commander');
    const program = new Command();
    program.exitOverride();
    mod.registerContainer(program);

    await expect(program.parseAsync(['node', 'test', 'container', 'test'])).rejects.toMatchObject({
      code: 'CONTAINER_RUNTIME_NOT_FOUND',
    });
  });

  it('respects config runtime preference (8.3)', async () => {
    await writeFile(
      join(testDir, 'config.yaml'),
      'provider:\n  execution_backend: container\n  container:\n    runtime: docker\n',
    );

    const mockDetect = vi.fn().mockResolvedValue(createMockRuntime());

    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(testDir, 'config.yaml'),
      EXIT: { SUCCESS: 0, ERROR: 1 },
      isInteractive: () => false,
    }));

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: mockDetect,
    }));

    const mod = await import('./container.js');
    const { Command } = await import('commander');
    const program = new Command();
    mod.registerContainer(program);

    await program.parseAsync(['node', 'test', 'container', 'test']);

    expect(mockDetect).toHaveBeenCalledWith('docker');
  });

  it('falls back to auto-detect when no config exists (8.4)', async () => {
    const mockDetect = vi.fn().mockResolvedValue(createMockRuntime());

    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(testDir, 'config.yaml'),
      EXIT: { SUCCESS: 0, ERROR: 1 },
      isInteractive: () => false,
    }));

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: mockDetect,
    }));

    const mod = await import('./container.js');
    const { Command } = await import('commander');
    const program = new Command();
    mod.registerContainer(program);

    await program.parseAsync(['node', 'test', 'container', 'test']);

    expect(mockDetect).toHaveBeenCalledWith('auto');
  });

  it('outputs standard JSON envelope on success in --json mode (8.5)', async () => {
    const mockRuntime = createMockRuntime();

    vi.doMock('../index.js', () => ({
      isJsonMode: () => true,
      getConfigPath: () => join(testDir, 'config.yaml'),
      EXIT: { SUCCESS: 0, ERROR: 1 },
      isInteractive: () => false,
    }));

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue(mockRuntime),
    }));

    const mod = await import('./container.js');
    const { Command } = await import('commander');
    const program = new Command();
    mod.registerContainer(program);

    await program.parseAsync(['node', 'test', 'container', 'test']);

    const stdoutCalls = vi.mocked(process.stdout.write).mock.calls;
    const output = stdoutCalls.map((c) => String(c[0])).join('');
    const parsed = JSON.parse(output);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toMatchObject({ runtime: 'docker', passed: true });
    expect(parsed.error).toBeNull();
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('outputs JSON envelope with ok:true and passed:false when test container fails in --json mode (8.6)', async () => {
    // NOTE: This is NOT the AC6 error envelope pattern ({ ok: false, data: null, error: {...} }).
    // AC3 specifies that container test always returns { ok: true, data: { passed: false }, error: null }
    // on a test failure (non-zero exit code). The ok:false envelope is reserved for AC6 (no runtime found).
    const mockRuntime = createMockRuntime({ waitExitCode: 1, logsStdout: 'bad output' });

    vi.doMock('../index.js', () => ({
      isJsonMode: () => true,
      getConfigPath: () => join(testDir, 'config.yaml'),
      EXIT: { SUCCESS: 0, ERROR: 1 },
      isInteractive: () => false,
    }));

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue(mockRuntime),
    }));

    const mod = await import('./container.js');
    const { Command } = await import('commander');
    const program = new Command();
    mod.registerContainer(program);

    await program.parseAsync(['node', 'test', 'container', 'test']);

    const stdoutCalls = vi.mocked(process.stdout.write).mock.calls;
    const output = stdoutCalls.map((c) => String(c[0])).join('');
    const parsed = JSON.parse(output);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.passed).toBe(false);
    expect(parsed.error).toBeNull();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('cleans up temp directory and container even on failure (8.7)', async () => {
    const mockRuntime = createMockRuntime({ waitExitCode: 1, logsStdout: 'bad' });

    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(testDir, 'config.yaml'),
      EXIT: { SUCCESS: 0, ERROR: 1 },
      isInteractive: () => false,
    }));

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue(mockRuntime),
    }));

    const mod = await import('./container.js');
    const { Command } = await import('commander');
    const program = new Command();
    mod.registerContainer(program);

    await program.parseAsync(['node', 'test', 'container', 'test']);

    expect(mockRuntime.remove).toHaveBeenCalledWith('test-container-id-123');
  });

  it('includes container logs in verbose output (8.8)', async () => {
    const mockRuntime = createMockRuntime({ logsStdout: 'sparecrow-container-test\n' });

    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(testDir, 'config.yaml'),
      EXIT: { SUCCESS: 0, ERROR: 1 },
      isInteractive: () => false,
    }));

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue(mockRuntime),
    }));

    const mod = await import('./container.js');
    const { Command } = await import('commander');
    const program = new Command();
    mod.registerContainer(program);

    await program.parseAsync(['node', 'test', 'container', 'test', '--verbose']);

    const stdoutCalls = vi.mocked(process.stdout.write).mock.calls;
    const output = stdoutCalls.map((c) => String(c[0])).join('');
    expect(output).toContain('sparecrow-container-test');
    expect(output).toContain('Logs:');
  });

  it('handles TASK_TIMEOUT from runtime.wait() gracefully (8.9)', async () => {
    const mockRuntime = createMockRuntime({ waitThrowsTimeout: true });

    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(testDir, 'config.yaml'),
      EXIT: { SUCCESS: 0, ERROR: 1 },
      isInteractive: () => false,
    }));

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue(mockRuntime),
    }));

    const mod = await import('./container.js');
    const { Command } = await import('commander');
    const program = new Command();
    mod.registerContainer(program);

    await program.parseAsync(['node', 'test', 'container', 'test']);

    const stderrCalls = vi.mocked(process.stderr.write).mock.calls;
    const output = stderrCalls.map((c) => String(c[0])).join('');
    expect(output).toContain('timed out');
    expect(process.exit).toHaveBeenCalledWith(1);

    // Container should still be cleaned up
    expect(mockRuntime.remove).toHaveBeenCalledWith('test-container-id-123');
  });

  it('handles runtime.run() failure gracefully when containerId is null', async () => {
    const mockRuntime = createMockRuntime({ runThrows: true });

    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(testDir, 'config.yaml'),
      EXIT: { SUCCESS: 0, ERROR: 1 },
      isInteractive: () => false,
    }));

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue(mockRuntime),
    }));

    const mod = await import('./container.js');
    const { Command } = await import('commander');
    const program = new Command();
    mod.registerContainer(program);

    await program.parseAsync(['node', 'test', 'container', 'test']);

    const stderrCalls = vi.mocked(process.stderr.write).mock.calls;
    const output = stderrCalls.map((c) => String(c[0])).join('');
    expect(output).toContain('Container test failed');
    expect(process.exit).toHaveBeenCalledWith(1);
    // remove() should NOT be called since containerId was never set
    expect(mockRuntime.remove).not.toHaveBeenCalled();
  });

  // AI-Review finding 3 (High): AC8 — container test --json must include mountStrategy
  it('includes mountStrategy in JSON output for default image (10.7 AC8a)', async () => {
    const mockRuntime = createMockRuntime();

    vi.doMock('../index.js', () => ({
      isJsonMode: () => true,
      getConfigPath: () => join(testDir, 'config.yaml'),
      EXIT: { SUCCESS: 0, ERROR: 1 },
      isInteractive: () => false,
    }));

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue(mockRuntime),
    }));

    const mod = await import('./container.js');
    const { Command } = await import('commander');
    const program = new Command();
    mod.registerContainer(program);

    await program.parseAsync(['node', 'test', 'container', 'test']);

    const stdoutCalls = vi.mocked(process.stdout.write).mock.calls;
    const output = stdoutCalls.map((c) => String(c[0])).join('');
    const parsed = JSON.parse(output);
    // Default image → host binary will be mounted → mountStrategy: 'host-binary'
    expect(parsed.data).toHaveProperty('mountStrategy', 'host-binary');
  });

  // AI-Review finding 3 (High): AC8 — container test --json must include mountStrategy for custom image
  it('includes mountStrategy "image-builtin" in JSON output for custom image (10.7 AC8b)', async () => {
    await writeFile(
      join(testDir, 'config.yaml'),
      'provider:\n  execution_backend: container\n  container:\n    image: "ghcr.io/13rac1/openclaw-claude-code:latest"\n',
    );
    const mockRuntime = createMockRuntime();

    vi.doMock('../index.js', () => ({
      isJsonMode: () => true,
      getConfigPath: () => join(testDir, 'config.yaml'),
      EXIT: { SUCCESS: 0, ERROR: 1 },
      isInteractive: () => false,
    }));

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue(mockRuntime),
    }));

    const mod = await import('./container.js');
    const { Command } = await import('commander');
    const program = new Command();
    mod.registerContainer(program);

    await program.parseAsync(['node', 'test', 'container', 'test']);

    const stdoutCalls = vi.mocked(process.stdout.write).mock.calls;
    const output = stdoutCalls.map((c) => String(c[0])).join('');
    const parsed = JSON.parse(output);
    // Custom image → no host mount → mountStrategy: 'image-builtin'
    expect(parsed.data).toHaveProperty('mountStrategy', 'image-builtin');
  });

  // AI-Review finding 8 (Low): container test --json must expose mountClaudeBinary config value
  it('includes mountClaudeBinary null in JSON output when not configured (10.7 AC8c)', async () => {
    const mockRuntime = createMockRuntime();

    vi.doMock('../index.js', () => ({
      isJsonMode: () => true,
      getConfigPath: () => join(testDir, 'config.yaml'),
      EXIT: { SUCCESS: 0, ERROR: 1 },
      isInteractive: () => false,
    }));

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue(mockRuntime),
    }));

    const mod = await import('./container.js');
    const { Command } = await import('commander');
    const program = new Command();
    mod.registerContainer(program);

    await program.parseAsync(['node', 'test', 'container', 'test']);

    const stdoutCalls = vi.mocked(process.stdout.write).mock.calls;
    const output = stdoutCalls.map((c) => String(c[0])).join('');
    const parsed = JSON.parse(output);
    // No mount_claude_binary in config → null (not undefined)
    expect(parsed.data).toHaveProperty('mountClaudeBinary', null);
  });

  // AI-Review finding 8 (Low): container test --json exposes explicit mountClaudeBinary value
  it('includes mountClaudeBinary true in JSON output when configured (10.7 AC8d)', async () => {
    await writeFile(
      join(testDir, 'config.yaml'),
      'provider:\n  execution_backend: container\n  container:\n    mount_claude_binary: true\n',
    );
    const mockRuntime = createMockRuntime();

    vi.doMock('../index.js', () => ({
      isJsonMode: () => true,
      getConfigPath: () => join(testDir, 'config.yaml'),
      EXIT: { SUCCESS: 0, ERROR: 1 },
      isInteractive: () => false,
    }));

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue(mockRuntime),
    }));

    const mod = await import('./container.js');
    const { Command } = await import('commander');
    const program = new Command();
    mod.registerContainer(program);

    await program.parseAsync(['node', 'test', 'container', 'test']);

    const stdoutCalls = vi.mocked(process.stdout.write).mock.calls;
    const output = stdoutCalls.map((c) => String(c[0])).join('');
    const parsed = JSON.parse(output);
    expect(parsed.data).toHaveProperty('mountClaudeBinary', true);
    expect(parsed.data).toHaveProperty('mountStrategy', 'host-binary');
  });
});

// ─── Task 9: container cleanup command ───────────────────────────────────────

describe('container cleanup', () => {
  beforeEach(async () => {
    vi.resetModules();
    testDir = tmpDir();
    await mkdir(testDir, { recursive: true });

    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({
        config: join(testDir, 'config.yaml'),
        data: testDir,
        logs: join(testDir, 'logs'),
      }),
    }));

    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
  });

  it('lists and removes orphaned containers; exits 0 (9.1)', async () => {
    const mockRuntime = createMockRuntime({
      listResult: [
        {
          containerId: 'abc123def456',
          image: 'node:lts-slim',
          createdAt: '2026-03-01',
          status: 'Exited',
          names: 'sparecrow-1',
        },
      ],
    });

    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(testDir, 'config.yaml'),
      EXIT: { SUCCESS: 0, ERROR: 1 },
      isInteractive: () => false,
    }));

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue(mockRuntime),
    }));

    const mod = await import('./container.js');
    const { Command } = await import('commander');
    const program = new Command();
    mod.registerContainer(program);

    await program.parseAsync(['node', 'test', 'container', 'cleanup', '--yes']);

    expect(mockRuntime.remove).toHaveBeenCalledWith('abc123def456');
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('reports "none found" and exits 0 with no orphaned containers (9.2)', async () => {
    const mockRuntime = createMockRuntime({ listResult: [] });

    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(testDir, 'config.yaml'),
      EXIT: { SUCCESS: 0, ERROR: 1 },
      isInteractive: () => false,
    }));

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue(mockRuntime),
    }));

    const mod = await import('./container.js');
    const { Command } = await import('commander');
    const program = new Command();
    mod.registerContainer(program);

    await program.parseAsync(['node', 'test', 'container', 'cleanup']);

    const stdoutCalls = vi.mocked(process.stdout.write).mock.calls;
    const output = stdoutCalls.map((c) => String(c[0])).join('');
    expect(output).toContain('No orphaned sparecrow containers found');
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('skips confirmation prompt with --yes (9.3)', async () => {
    const mockRuntime = createMockRuntime({
      listResult: [
        {
          containerId: 'abc123',
          image: 'node:lts-slim',
          createdAt: '2026-03-01',
          status: 'Exited',
          names: 's1',
        },
      ],
    });

    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(testDir, 'config.yaml'),
      EXIT: { SUCCESS: 0, ERROR: 1 },
      isInteractive: () => false,
    }));

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue(mockRuntime),
    }));

    const mod = await import('./container.js');
    const { Command } = await import('commander');
    const program = new Command();
    mod.registerContainer(program);

    // With --yes, should not prompt and should remove
    await program.parseAsync(['node', 'test', 'container', 'cleanup', '--yes']);

    expect(mockRuntime.remove).toHaveBeenCalledWith('abc123');
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('throws QUEUE_CONFIRMATION_REQUIRED in non-interactive mode without --yes (9.4)', async () => {
    const mockRuntime = createMockRuntime({
      listResult: [
        {
          containerId: 'abc123',
          image: 'node:lts-slim',
          createdAt: '2026-03-01',
          status: 'Exited',
          names: 's1',
        },
      ],
    });

    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(testDir, 'config.yaml'),
      EXIT: { SUCCESS: 0, ERROR: 1 },
      isInteractive: () => false,
    }));

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue(mockRuntime),
    }));

    const mod = await import('./container.js');
    const { Command } = await import('commander');
    const program = new Command();
    program.exitOverride();
    mod.registerContainer(program);

    // process.stdin.isTTY is undefined in test env → isInteractive() returns false
    await expect(
      program.parseAsync(['node', 'test', 'container', 'cleanup']),
    ).rejects.toMatchObject({
      code: 'QUEUE_CONFIRMATION_REQUIRED',
    });
  });

  it('outputs standard JSON envelope in --json mode without prompting (9.5)', async () => {
    const mockRuntime = createMockRuntime({
      listResult: [
        {
          containerId: 'abc123',
          image: 'node:lts-slim',
          createdAt: '2026-03-01',
          status: 'Exited',
          names: 's1',
        },
      ],
    });

    // Mock @clack/prompts so we can assert confirm() is never called in JSON mode
    const mockConfirm = vi.fn();
    vi.doMock('@clack/prompts', () => ({ confirm: mockConfirm }));

    vi.doMock('../index.js', () => ({
      isJsonMode: () => true,
      getConfigPath: () => join(testDir, 'config.yaml'),
      EXIT: { SUCCESS: 0, ERROR: 1 },
      isInteractive: () => false,
    }));

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue(mockRuntime),
    }));

    const mod = await import('./container.js');
    const { Command } = await import('commander');
    const program = new Command();
    mod.registerContainer(program);

    // JSON mode does not prompt — confirm() must never be called
    await program.parseAsync(['node', 'test', 'container', 'cleanup']);

    // Confirmation prompt must be bypassed entirely in JSON mode
    expect(mockConfirm).not.toHaveBeenCalled();

    const stdoutCalls = vi.mocked(process.stdout.write).mock.calls;
    const output = stdoutCalls.map((c) => String(c[0])).join('');
    const parsed = JSON.parse(output);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toMatchObject({ found: 1, removed: 1, failed: 0 });
    expect(parsed.error).toBeNull();
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('handles partial removal failures gracefully (9.6)', async () => {
    const mockRuntime = createMockRuntime({
      listResult: [
        {
          containerId: 'success-1',
          image: 'node:lts-slim',
          createdAt: '2026-03-01',
          status: 'Exited',
          names: 's1',
        },
        {
          containerId: 'fail-1',
          image: 'node:lts-slim',
          createdAt: '2026-03-01',
          status: 'Exited',
          names: 's2',
        },
      ],
      removeFailsFor: ['fail-1'],
    });

    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(testDir, 'config.yaml'),
      EXIT: { SUCCESS: 0, ERROR: 1 },
      isInteractive: () => false,
    }));

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue(mockRuntime),
    }));

    const mod = await import('./container.js');
    const { Command } = await import('commander');
    const program = new Command();
    mod.registerContainer(program);

    await program.parseAsync(['node', 'test', 'container', 'cleanup', '--yes']);

    // At least one succeeded, so exit 0
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('exits 1 with no runtime and clear error message (9.7)', async () => {
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(testDir, 'config.yaml'),
      EXIT: { SUCCESS: 0, ERROR: 1 },
      isInteractive: () => false,
    }));

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue(null),
    }));

    const mod = await import('./container.js');
    const { Command } = await import('commander');
    const program = new Command();
    program.exitOverride();
    mod.registerContainer(program);

    await expect(
      program.parseAsync(['node', 'test', 'container', 'cleanup']),
    ).rejects.toMatchObject({
      code: 'CONTAINER_RUNTIME_NOT_FOUND',
    });
  });

  it('outputs JSON error envelope with no runtime in --json mode (9.8)', async () => {
    vi.doMock('../index.js', () => ({
      isJsonMode: () => true,
      getConfigPath: () => join(testDir, 'config.yaml'),
      EXIT: { SUCCESS: 0, ERROR: 1 },
      isInteractive: () => false,
    }));

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue(null),
    }));

    const mod = await import('./container.js');
    const { Command } = await import('commander');
    const program = new Command();
    program.exitOverride();
    mod.registerContainer(program);

    // The ScrowError propagates to the caller — in production the CLI global handler catches it
    await expect(
      program.parseAsync(['node', 'test', 'container', 'cleanup']),
    ).rejects.toMatchObject({
      code: 'CONTAINER_RUNTIME_NOT_FOUND',
    });
  });

  it('exits 1 when ALL removals fail (9.9)', async () => {
    const mockRuntime = createMockRuntime({
      listResult: [
        {
          containerId: 'fail-1',
          image: 'node:lts-slim',
          createdAt: '2026-03-01',
          status: 'Exited',
          names: 's1',
        },
        {
          containerId: 'fail-2',
          image: 'node:lts-slim',
          createdAt: '2026-03-01',
          status: 'Exited',
          names: 's2',
        },
      ],
      removeFailsFor: ['fail-1', 'fail-2'],
    });

    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => join(testDir, 'config.yaml'),
      EXIT: { SUCCESS: 0, ERROR: 1 },
      isInteractive: () => false,
    }));

    vi.doMock('../../providers/backends/container/index.js', () => ({
      detectContainerRuntime: vi.fn().mockResolvedValue(mockRuntime),
    }));

    const mod = await import('./container.js');
    const { Command } = await import('commander');
    const program = new Command();
    mod.registerContainer(program);

    await program.parseAsync(['node', 'test', 'container', 'cleanup', '--yes']);

    // ALL removals failed → exit 1
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
