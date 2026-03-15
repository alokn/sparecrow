/** Integration test for Story 5.1 onboarding auth flow — validates end-to-end scope with mocked subprocess boundaries. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { mkdir, rm, readFile } from 'node:fs/promises';
import * as realFsPromises from 'node:fs/promises';
import * as realUtils from '../../src/utils/index.js';

describe('onboarding auth flow — Story 5.1 end-to-end', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = join(tmpdir(), 'onboard-int-' + randomBytes(6).toString('hex'));
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('completes detect → auth → persist flow and writes config', async () => {
    const configPath = join(tmpDir, 'config.yaml');

    // Mock all subprocess calls via spawnWithGuardrails using the barrel import
    vi.doMock('../../src/utils/index.js', () => ({
      ...realUtils,
      spawnWithGuardrails: vi
        .fn()
        .mockResolvedValueOnce({
          stdout: '/usr/local/bin/claude\n',
          stderr: '',
          exitCode: 0,
          timedOut: false,
          aborted: false,
          enoent: false,
        })
        .mockResolvedValueOnce({
          stdout: JSON.stringify({ loggedIn: true, subscriptionType: 'pro' }),
          stderr: '',
          exitCode: 0,
          timedOut: false,
          aborted: false,
          enoent: false,
        }),
    }));

    // Mock auth manager to say credentials are valid (must mock the barrel, not the internal file)
    vi.doMock('../../src/providers/claude-code/index.js', () => ({
      ClaudeCodeAuthManager: class { validate = vi.fn().mockResolvedValue(true); },
      parseAuthStatusOutput: (raw: string) => {
        try {
          const obj = JSON.parse(raw) as Record<string, unknown>;
          return {
            authenticated: obj['loggedIn'] === true,
            tier: typeof obj['subscriptionType'] === 'string' ? obj['subscriptionType'] : 'unknown',
          };
        } catch { return { authenticated: false, tier: 'unknown' }; }
      },
    }));

    // Mock fs access check for executable
    vi.doMock('node:fs/promises', () => ({
      ...realFsPromises,
      access: vi.fn().mockResolvedValue(undefined),
    }));

    // Mock platform paths to use tmpDir
    vi.doMock('../../src/platform/index.js', () => ({
      getPaths: () => ({ config: tmpDir, data: tmpDir, logs: tmpDir }),
    }));

    // Mock CLI index for config path
    vi.doMock('../../src/cli/index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => configPath,
    }));

    const { detectClaudeBinary, validateAuth, persistClaudePath } = await import(
      '../../src/cli/commands/onboard-auth.js'
    );

    // Detect
    const detection = await detectClaudeBinary();
    expect(detection.found).toBe(true);
    expect(detection.absolutePath).toBeTruthy();

    // Validate auth
    const authResult = await validateAuth(detection.absolutePath!);
    expect(authResult.valid).toBe(true);
    expect(authResult.tier).toBe('pro');

    // Persist
    await persistClaudePath(detection.absolutePath!);
    const content = await readFile(configPath, 'utf-8');
    expect(content).toContain('claude_path');
    expect(content).toContain(detection.absolutePath);
  });

  it('does not write config when Claude is not found', async () => {
    const configPath = join(tmpDir, 'config.yaml');

    vi.doMock('../../src/utils/index.js', () => ({
      ...realUtils,
      spawnWithGuardrails: vi.fn().mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: null,
        timedOut: false,
        aborted: false,
        enoent: true, // which itself not found
      }),
    }));

    vi.doMock('../../src/cli/index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => configPath,
    }));

    vi.doMock('../../src/platform/index.js', () => ({
      getPaths: () => ({ config: tmpDir, data: tmpDir, logs: tmpDir }),
    }));

    const { detectClaudeBinary } = await import('../../src/cli/commands/onboard-auth.js');
    const detection = await detectClaudeBinary();
    expect(detection.found).toBe(false);

    // Config file should NOT exist since we never called persistClaudePath
    let configExists = false;
    try {
      await readFile(configPath, 'utf-8');
      configExists = true;
    } catch {
      configExists = false;
    }
    expect(configExists).toBe(false);
  });

  it('does not write config when auth fails', async () => {
    const configPath = join(tmpDir, 'config.yaml');

    vi.doMock('../../src/utils/index.js', () => ({
      ...realUtils,
      spawnWithGuardrails: vi
        .fn()
        .mockResolvedValueOnce({
          stdout: '/usr/local/bin/claude\n',
          stderr: '',
          exitCode: 0,
          timedOut: false,
          aborted: false,
          enoent: false,
        })
        .mockResolvedValueOnce({
          stdout: JSON.stringify({ loggedIn: false }),
          stderr: '',
          exitCode: 0,
          timedOut: false,
          aborted: false,
          enoent: false,
        }),
    }));

    vi.doMock('../../src/providers/claude-code/index.js', () => ({
      ClaudeCodeAuthManager: class { validate = vi.fn().mockResolvedValue(false); },
      parseAuthStatusOutput: (raw: string) => {
        try {
          const obj = JSON.parse(raw) as Record<string, unknown>;
          return {
            authenticated: obj['loggedIn'] === true,
            tier: typeof obj['subscriptionType'] === 'string' ? obj['subscriptionType'] : 'unknown',
          };
        } catch { return { authenticated: false, tier: 'unknown' }; }
      },
    }));

    vi.doMock('node:fs/promises', () => ({
      ...realFsPromises,
      access: vi.fn().mockResolvedValue(undefined),
    }));

    vi.doMock('../../src/cli/index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => configPath,
    }));

    vi.doMock('../../src/platform/index.js', () => ({
      getPaths: () => ({ config: tmpDir, data: tmpDir, logs: tmpDir }),
    }));

    const { detectClaudeBinary, validateAuth } = await import(
      '../../src/cli/commands/onboard-auth.js'
    );

    const detection = await detectClaudeBinary();
    expect(detection.found).toBe(true);

    const authResult = await validateAuth(detection.absolutePath!);
    expect(authResult.valid).toBe(false);

    // Config should not be written since auth failed (we never call persistClaudePath in failure path)
    let configExists = false;
    try {
      await readFile(configPath, 'utf-8');
      configExists = true;
    } catch {
      configExists = false;
    }
    expect(configExists).toBe(false);
  });

  it('output does not contain credential material', async () => {
    vi.doMock('../../src/utils/index.js', () => ({
      ...realUtils,
      spawnWithGuardrails: vi.fn().mockResolvedValue({
        stdout: '/usr/local/bin/claude\n',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        aborted: false,
        enoent: false,
      }),
    }));

    vi.doMock('node:fs/promises', () => ({
      ...realFsPromises,
      access: vi.fn().mockResolvedValue(undefined),
    }));

    const { renderClaudeNotFoundError, renderAuthSuccess, renderAuthFailedError } = await import(
      '../../src/cli/commands/onboard-auth.js'
    );

    const outputs = [
      renderClaudeNotFoundError(),
      renderAuthSuccess('pro'),
      renderAuthSuccess('unknown'),
      renderAuthFailedError(),
    ];

    for (const output of outputs) {
      expect(output).not.toMatch(/accessToken|refreshToken|Bearer/i);
    }
  });
});
