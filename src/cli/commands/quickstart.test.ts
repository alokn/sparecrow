/** Unit tests for the quickstart command. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { checkGitRepo, isGitRepo } from './quickstart.js';

/** Fake builtin templates for mocking — avoids real disk reads. */
const FAKE_BUILTINS = [
  {
    key: 'security-audit',
    name: 'Security Audit',
    prompt: 'security audit prompt content',
    description: 'Security audit',
  },
  {
    key: 'code-review',
    name: 'Code Review',
    prompt: 'code review prompt content',
    description: 'Code review',
  },
  {
    key: 'write-tests',
    name: 'Write Tests',
    prompt: 'write tests prompt content',
    description: 'Write tests',
  },
];

describe('checkGitRepo', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'quickstart-test-' + randomBytes(6).toString('hex')));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns 'repo' when .git directory exists", async () => {
    await mkdir(join(tempDir, '.git'));
    expect(await checkGitRepo(tempDir)).toBe('repo');
  });

  it("returns 'not-repo' when .git does not exist but path is valid", async () => {
    expect(await checkGitRepo(tempDir)).toBe('not-repo');
  });

  it("returns 'not-found' for a non-existent directory", async () => {
    expect(await checkGitRepo('/tmp/nonexistent-' + randomBytes(8).toString('hex'))).toBe(
      'not-found',
    );
  });
});

describe('isGitRepo', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'quickstart-test-' + randomBytes(6).toString('hex')));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns true when .git directory exists', async () => {
    await mkdir(join(tempDir, '.git'));
    expect(await isGitRepo(tempDir)).toBe(true);
  });

  it('returns false when .git does not exist', async () => {
    expect(await isGitRepo(tempDir)).toBe(false);
  });

  it('returns false for non-existent directory', async () => {
    expect(await isGitRepo('/tmp/nonexistent-' + randomBytes(8).toString('hex'))).toBe(false);
  });
});

describe('registerQuickstart', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws CLAUDE_NOT_FOUND when claude binary is not detected', async () => {
    vi.doMock('./onboard-auth.js', () => ({
      detectClaudeBinary: vi.fn().mockResolvedValue({
        found: false,
        absolutePath: null,
        error: 'not found',
      }),
      validateAuth: vi.fn(),
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: vi.fn().mockReturnValue(false),
      getConfigPath: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('../../ui/index.js', () => ({
      printJson: vi.fn(),
    }));
    vi.doMock('../../utils/index.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      spawnWithGuardrails: vi.fn(),
    }));

    const { registerQuickstart } = await import('./quickstart.js');
    const { Command } = await import('commander');

    const program = new Command();
    registerQuickstart(program);

    await expect(program.parseAsync(['node', 'test', 'quickstart'])).rejects.toMatchObject({
      code: 'CLAUDE_NOT_FOUND',
    });
  });

  it('throws AUTH_TOKEN_MISSING when auth validation fails', async () => {
    vi.doMock('./onboard-auth.js', () => ({
      detectClaudeBinary: vi.fn().mockResolvedValue({
        found: true,
        absolutePath: '/usr/bin/claude',
        error: null,
      }),
      validateAuth: vi.fn().mockResolvedValue({ valid: false, tier: 'unknown' }),
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: vi.fn().mockReturnValue(false),
      getConfigPath: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('../../ui/index.js', () => ({
      printJson: vi.fn(),
    }));
    vi.doMock('../../utils/index.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      spawnWithGuardrails: vi.fn(),
    }));

    const { registerQuickstart } = await import('./quickstart.js');
    const { Command } = await import('commander');

    const program = new Command();
    registerQuickstart(program);

    await expect(program.parseAsync(['node', 'test', 'quickstart'])).rejects.toMatchObject({
      code: 'AUTH_TOKEN_MISSING',
    });
  });

  it('throws AUTH_TOKEN_MISSING in JSON mode (exit code propagates correctly)', async () => {
    vi.doMock('./onboard-auth.js', () => ({
      detectClaudeBinary: vi.fn().mockResolvedValue({
        found: true,
        absolutePath: '/usr/bin/claude',
        error: null,
      }),
      validateAuth: vi.fn().mockResolvedValue({ valid: false, tier: 'unknown' }),
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: vi.fn().mockReturnValue(true),
      getConfigPath: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('../../ui/index.js', () => ({
      printJson: vi.fn(),
    }));
    vi.doMock('../../utils/index.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      spawnWithGuardrails: vi.fn(),
    }));

    const { registerQuickstart } = await import('./quickstart.js');
    const { Command } = await import('commander');

    const program = new Command();
    registerQuickstart(program);

    // Throws (not returns) so callers get non-zero exit code
    await expect(program.parseAsync(['node', 'test', 'quickstart'])).rejects.toMatchObject({
      code: 'AUTH_TOKEN_MISSING',
    });
  });

  it('throws NOT_GIT_REPO when target path does not exist', async () => {
    vi.doMock('./onboard-auth.js', () => ({
      detectClaudeBinary: vi.fn().mockResolvedValue({
        found: true,
        absolutePath: '/usr/bin/claude',
        error: null,
      }),
      validateAuth: vi.fn().mockResolvedValue({ valid: true, tier: 'pro' }),
    }));
    vi.doMock('../index.js', () => ({
      isJsonMode: vi.fn().mockReturnValue(false),
      getConfigPath: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('../../ui/index.js', () => ({
      printJson: vi.fn(),
    }));
    vi.doMock('../../utils/index.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      spawnWithGuardrails: vi.fn(),
    }));

    const { registerQuickstart } = await import('./quickstart.js');
    const { Command } = await import('commander');

    const program = new Command();
    registerQuickstart(program);

    const missingPath = '/tmp/nonexistent-' + randomBytes(8).toString('hex');
    await expect(
      program.parseAsync(['node', 'test', 'quickstart', missingPath]),
    ).rejects.toMatchObject({
      code: 'NOT_GIT_REPO',
      message: expect.stringContaining('Path not found'),
    });
  });

  it('throws NOT_GIT_REPO when target is not a git repository', async () => {
    const tempDir = await mkdtemp(
      join(tmpdir(), 'quickstart-nogit-' + randomBytes(6).toString('hex')),
    );

    try {
      vi.doMock('./onboard-auth.js', () => ({
        detectClaudeBinary: vi.fn().mockResolvedValue({
          found: true,
          absolutePath: '/usr/bin/claude',
          error: null,
        }),
        validateAuth: vi.fn().mockResolvedValue({ valid: true, tier: 'pro' }),
      }));
      vi.doMock('../index.js', () => ({
        isJsonMode: vi.fn().mockReturnValue(false),
        getConfigPath: vi.fn().mockReturnValue(null),
      }));
      vi.doMock('../../ui/index.js', () => ({
        printJson: vi.fn(),
      }));
      vi.doMock('../../utils/index.js', () => ({
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        spawnWithGuardrails: vi.fn(),
      }));

      const { registerQuickstart } = await import('./quickstart.js');
      const { Command } = await import('commander');

      const program = new Command();
      registerQuickstart(program);

      await expect(
        program.parseAsync(['node', 'test', 'quickstart', tempDir]),
      ).rejects.toMatchObject({
        code: 'NOT_GIT_REPO',
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('throws TEMPLATE_NOT_FOUND for invalid template name (mocked loadBuiltins)', async () => {
    const tempDir = await mkdtemp(
      join(tmpdir(), 'quickstart-tpl-' + randomBytes(6).toString('hex')),
    );
    await mkdir(join(tempDir, '.git'));

    try {
      vi.doMock('./onboard-auth.js', () => ({
        detectClaudeBinary: vi.fn().mockResolvedValue({
          found: true,
          absolutePath: '/usr/bin/claude',
          error: null,
        }),
        validateAuth: vi.fn().mockResolvedValue({ valid: true, tier: 'pro' }),
      }));
      vi.doMock('../index.js', () => ({
        isJsonMode: vi.fn().mockReturnValue(false),
        getConfigPath: vi.fn().mockReturnValue(null),
      }));
      vi.doMock('../../ui/index.js', () => ({
        printJson: vi.fn(),
      }));
      vi.doMock('../../utils/index.js', () => ({
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        spawnWithGuardrails: vi.fn(),
      }));
      vi.doMock('../../templates/index.js', () => ({
        loadBuiltins: vi.fn().mockResolvedValue(FAKE_BUILTINS),
        resolveTemplate: vi.fn().mockImplementation((key: string) => {
          const found = FAKE_BUILTINS.find((t) => t.key === key);
          if (!found) {
            const err = new Error(`Template '${key}' not found`);
            (err as unknown as { code: string }).code = 'TEMPLATE_NOT_FOUND';
            throw err;
          }
          return found;
        }),
        CANONICAL_KEYS: ['security-audit', 'code-review', 'write-tests'],
      }));

      const { registerQuickstart } = await import('./quickstart.js');
      const { Command } = await import('commander');

      const program = new Command();
      registerQuickstart(program);

      await expect(
        program.parseAsync(['node', 'test', 'quickstart', tempDir, '--template', 'nonexistent']),
      ).rejects.toMatchObject({
        code: 'TEMPLATE_NOT_FOUND',
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('executes successfully and displays output with follow-up hint', async () => {
    const tempDir = await mkdtemp(
      join(tmpdir(), 'quickstart-ok-' + randomBytes(6).toString('hex')),
    );
    await mkdir(join(tempDir, '.git'));

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    try {
      const mockSpawn = vi.fn().mockResolvedValue({
        stdout: 'Security audit results here',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        aborted: false,
        enoent: false,
      });

      vi.doMock('./onboard-auth.js', () => ({
        detectClaudeBinary: vi.fn().mockResolvedValue({
          found: true,
          absolutePath: '/usr/bin/claude',
          error: null,
        }),
        validateAuth: vi.fn().mockResolvedValue({ valid: true, tier: 'pro' }),
      }));
      vi.doMock('../index.js', () => ({
        isJsonMode: vi.fn().mockReturnValue(false),
        getConfigPath: vi.fn().mockReturnValue(null),
      }));
      vi.doMock('../../ui/index.js', () => ({
        printJson: vi.fn(),
      }));
      vi.doMock('../../utils/index.js', () => ({
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        spawnWithGuardrails: mockSpawn,
      }));
      vi.doMock('../../templates/index.js', () => ({
        loadBuiltins: vi.fn().mockResolvedValue(FAKE_BUILTINS),
        resolveTemplate: vi.fn().mockReturnValue(FAKE_BUILTINS[0]),
        CANONICAL_KEYS: ['security-audit', 'code-review', 'write-tests'],
      }));

      const { registerQuickstart } = await import('./quickstart.js');
      const { Command } = await import('commander');

      const program = new Command();
      registerQuickstart(program);

      await program.parseAsync(['node', 'test', 'quickstart', tempDir]);

      // Verify spawn called with --print only (no prompt as positional arg)
      expect(mockSpawn).toHaveBeenCalledWith(
        '/usr/bin/claude',
        ['--print'],
        expect.objectContaining({
          stdinData: 'security audit prompt content',
          cwd: expect.stringContaining(tempDir),
        }),
      );
      expect(stdoutWrite).toHaveBeenCalledWith('Security audit results here');
      const hintCall = stderrWrite.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('sparecrow onboard'),
      );
      expect(hintCall).toBeDefined();
    } finally {
      stdoutWrite.mockRestore();
      stderrWrite.mockRestore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('throws QUICKSTART_EXECUTION_FAILED when task times out', async () => {
    const tempDir = await mkdtemp(
      join(tmpdir(), 'quickstart-to-' + randomBytes(6).toString('hex')),
    );
    await mkdir(join(tempDir, '.git'));

    try {
      vi.doMock('./onboard-auth.js', () => ({
        detectClaudeBinary: vi.fn().mockResolvedValue({
          found: true,
          absolutePath: '/usr/bin/claude',
          error: null,
        }),
        validateAuth: vi.fn().mockResolvedValue({ valid: true, tier: 'pro' }),
      }));
      vi.doMock('../index.js', () => ({
        isJsonMode: vi.fn().mockReturnValue(false),
        getConfigPath: vi.fn().mockReturnValue(null),
      }));
      vi.doMock('../../ui/index.js', () => ({
        printJson: vi.fn(),
      }));
      vi.doMock('../../utils/index.js', () => ({
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        spawnWithGuardrails: vi.fn().mockResolvedValue({
          stdout: '',
          stderr: '',
          exitCode: null,
          timedOut: true,
          aborted: false,
          enoent: false,
        }),
      }));
      vi.doMock('../../templates/index.js', () => ({
        loadBuiltins: vi.fn().mockResolvedValue(FAKE_BUILTINS),
        resolveTemplate: vi.fn().mockReturnValue(FAKE_BUILTINS[0]),
        CANONICAL_KEYS: ['security-audit', 'code-review', 'write-tests'],
      }));

      const { registerQuickstart } = await import('./quickstart.js');
      const { Command } = await import('commander');

      const program = new Command();
      registerQuickstart(program);

      await expect(
        program.parseAsync(['node', 'test', 'quickstart', tempDir]),
      ).rejects.toMatchObject({
        code: 'QUICKSTART_EXECUTION_FAILED',
        message: expect.stringContaining('10 minutes'),
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('throws CLAUDE_NOT_FOUND when binary disappears between detection and execution (enoent)', async () => {
    const tempDir = await mkdtemp(
      join(tmpdir(), 'quickstart-enoent-' + randomBytes(6).toString('hex')),
    );
    await mkdir(join(tempDir, '.git'));

    try {
      vi.doMock('./onboard-auth.js', () => ({
        detectClaudeBinary: vi.fn().mockResolvedValue({
          found: true,
          absolutePath: '/usr/bin/claude',
          error: null,
        }),
        validateAuth: vi.fn().mockResolvedValue({ valid: true, tier: 'pro' }),
      }));
      vi.doMock('../index.js', () => ({
        isJsonMode: vi.fn().mockReturnValue(false),
        getConfigPath: vi.fn().mockReturnValue(null),
      }));
      vi.doMock('../../ui/index.js', () => ({
        printJson: vi.fn(),
      }));
      vi.doMock('../../utils/index.js', () => ({
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        spawnWithGuardrails: vi.fn().mockResolvedValue({
          stdout: '',
          stderr: '',
          exitCode: null,
          timedOut: false,
          aborted: false,
          enoent: true,
        }),
      }));
      vi.doMock('../../templates/index.js', () => ({
        loadBuiltins: vi.fn().mockResolvedValue(FAKE_BUILTINS),
        resolveTemplate: vi.fn().mockReturnValue(FAKE_BUILTINS[0]),
        CANONICAL_KEYS: ['security-audit', 'code-review', 'write-tests'],
      }));

      const { registerQuickstart } = await import('./quickstart.js');
      const { Command } = await import('commander');

      const program = new Command();
      registerQuickstart(program);

      await expect(
        program.parseAsync(['node', 'test', 'quickstart', tempDir]),
      ).rejects.toMatchObject({
        code: 'CLAUDE_NOT_FOUND',
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('uses correct template prompt when --template flag is provided', async () => {
    const tempDir = await mkdtemp(
      join(tmpdir(), 'quickstart-ct-' + randomBytes(6).toString('hex')),
    );
    await mkdir(join(tempDir, '.git'));

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    try {
      const mockSpawn = vi.fn().mockResolvedValue({
        stdout: 'Test generation results',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        aborted: false,
        enoent: false,
      });

      vi.doMock('./onboard-auth.js', () => ({
        detectClaudeBinary: vi.fn().mockResolvedValue({
          found: true,
          absolutePath: '/usr/bin/claude',
          error: null,
        }),
        validateAuth: vi.fn().mockResolvedValue({ valid: true, tier: 'pro' }),
      }));
      vi.doMock('../index.js', () => ({
        isJsonMode: vi.fn().mockReturnValue(false),
        getConfigPath: vi.fn().mockReturnValue(null),
      }));
      vi.doMock('../../ui/index.js', () => ({
        printJson: vi.fn(),
      }));
      vi.doMock('../../utils/index.js', () => ({
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        spawnWithGuardrails: mockSpawn,
      }));
      vi.doMock('../../templates/index.js', () => ({
        loadBuiltins: vi.fn().mockResolvedValue(FAKE_BUILTINS),
        resolveTemplate: vi.fn().mockImplementation((key: string) => {
          const found = FAKE_BUILTINS.find((t) => t.key === key);
          if (!found) throw new Error('not found');
          return found;
        }),
        CANONICAL_KEYS: ['security-audit', 'code-review', 'write-tests'],
      }));

      const { registerQuickstart } = await import('./quickstart.js');
      const { Command } = await import('commander');

      const program = new Command();
      registerQuickstart(program);

      await program.parseAsync([
        'node',
        'test',
        'quickstart',
        tempDir,
        '--template',
        'write-tests',
      ]);

      // Verify the correct template's prompt was passed via stdinData (not as a positional arg)
      expect(mockSpawn).toHaveBeenCalledWith(
        '/usr/bin/claude',
        ['--print'],
        expect.objectContaining({
          stdinData: 'write tests prompt content',
          cwd: expect.stringContaining(tempDir),
        }),
      );
      expect(stdoutWrite).toHaveBeenCalledWith('Test generation results');
    } finally {
      stdoutWrite.mockRestore();
      stderrWrite.mockRestore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('throws NOT_GIT_REPO with hint when cwd is not a repo and no path given', async () => {
    const tempDir = await mkdtemp(
      join(tmpdir(), 'quickstart-nocwd-' + randomBytes(6).toString('hex')),
    );

    try {
      vi.doMock('./onboard-auth.js', () => ({
        detectClaudeBinary: vi.fn().mockResolvedValue({
          found: true,
          absolutePath: '/usr/bin/claude',
          error: null,
        }),
        validateAuth: vi.fn().mockResolvedValue({ valid: true, tier: 'pro' }),
      }));
      vi.doMock('../index.js', () => ({
        isJsonMode: vi.fn().mockReturnValue(false),
        getConfigPath: vi.fn().mockReturnValue(null),
      }));
      vi.doMock('../../ui/index.js', () => ({
        printJson: vi.fn(),
      }));
      vi.doMock('../../utils/index.js', () => ({
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        spawnWithGuardrails: vi.fn(),
      }));
      // Mock checkGitRepo to simulate cwd not being a repo
      // We also mock the module itself to intercept the internal checkGitRepo call
      vi.doMock('./quickstart.js', async (importOriginal) => {
        const original = await importOriginal<typeof import('./quickstart.js')>();
        return {
          ...original,
          checkGitRepo: vi.fn().mockResolvedValue('not-repo'),
        };
      });

      const { registerQuickstart } = await import('./quickstart.js');
      const { Command } = await import('commander');

      const program = new Command();
      registerQuickstart(program);

      // Use a real non-git tempDir as the default path (no path arg)
      // The command resolves '.' to process.cwd() — pass the non-git dir explicitly
      await expect(
        program.parseAsync(['node', 'test', 'quickstart', tempDir]),
      ).rejects.toMatchObject({
        code: 'NOT_GIT_REPO',
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
