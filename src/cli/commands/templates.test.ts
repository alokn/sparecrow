/** Unit tests for the templates CLI command — human and JSON output modes. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Command } from 'commander';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  return program;
}

function parseJson(output: string): {
  ok: boolean;
  data: unknown;
  error: { code: string; message: string } | null;
} {
  return JSON.parse(output) as {
    ok: boolean;
    data: unknown;
    error: { code: string; message: string } | null;
  };
}

const MOCK_BUILTINS = [
  {
    name: 'security-audit',
    description: 'Scan repo for vulnerabilities and hardcoded secrets',
    prompt: 'p1',
    type: 'built-in' as const,
  },
  {
    name: 'improve-code',
    description: 'Review for bugs, error-handling gaps, and code quality',
    prompt: 'p2',
    type: 'built-in' as const,
  },
  {
    name: 'fix-bugs',
    description: 'Search for edge cases, logic flaws, and likely defects',
    prompt: 'p3',
    type: 'built-in' as const,
  },
  {
    name: 'write-tests',
    description: 'Identify untested paths and generate candidate tests',
    prompt: 'p4',
    type: 'built-in' as const,
  },
];

// ---------------------------------------------------------------------------
// Null-fallback coverage (getConfigPath returns null — no --config flag)
// ---------------------------------------------------------------------------

describe('registerTemplates() — null-fallback when getConfigPath returns null', () => {
  let stdoutOutput: string;
  // Use a platform-agnostic temp-based path to avoid hardcoded home directory assumptions
  const platformConfigDir = join(tmpdir(), 'templates-test-' + randomBytes(6).toString('hex'));

  beforeEach(async () => {
    vi.resetModules();
    stdoutOutput = '';

    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    vi.doMock('../../templates/index.js', () => ({
      loadBuiltins: vi.fn().mockResolvedValue(MOCK_BUILTINS),
      resolveTemplate: vi.fn(),
      CANONICAL_KEYS: ['security-audit', 'improve-code', 'fix-bugs', 'write-tests'],
    }));
    // Mock utils to prevent logger from writing to stderr or making filesystem calls
    const actualUtils =
      await vi.importActual<typeof import('../../utils/index.js')>('../../utils/index.js');
    vi.doMock('../../utils/index.js', () => ({
      ...actualUtils,
      logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves config from platform path when --config flag is not set (getConfigPath returns null)', async () => {
    // Simulate the common production case: no --config flag passed, getConfigPath() returns null.
    // The ?? fallback must resolve to join(getPaths().config, 'config.yaml') — a file path,
    // not the bare directory getPaths().config which would cause EISDIR.
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => null,
    }));
    const loadConfigMock = vi.fn().mockRejectedValue(new Error('config not found'));
    vi.doMock('../../config/index.js', () => ({
      loadConfig: loadConfigMock,
      resolveConfigFilePath: (configDir: string, override?: string | null) =>
        override ?? join(configDir, 'config.yaml'),
    }));
    vi.doMock('../../platform/index.js', () => ({
      getPaths: () => ({ config: platformConfigDir, data: tmpdir() }),
    }));

    const { registerTemplates } = await import('./templates.js');
    const program = new Command();
    program.exitOverride();
    registerTemplates(program);
    await program.parseAsync(['node', 'sparecrow', 'templates']);

    // Verify loadConfig was called with the correct file path (not the bare directory)
    expect(loadConfigMock).toHaveBeenCalledWith(join(platformConfigDir, 'config.yaml'));
    // Built-ins still render even when config load fails
    expect(stdoutOutput).toContain('security-audit');
  });
});

// ---------------------------------------------------------------------------
// Human mode — no custom tasks
// ---------------------------------------------------------------------------

describe('registerTemplates() — human mode, no custom tasks', () => {
  let stdoutOutput: string;
  let stderrOutput: string;

  beforeEach(() => {
    vi.resetModules();
    stdoutOutput = '';
    stderrOutput = '';

    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      stderrOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => '/fake/config.yaml',
    }));
    vi.doMock('../../templates/index.js', () => ({
      loadBuiltins: vi.fn().mockResolvedValue(MOCK_BUILTINS),
      resolveTemplate: vi.fn(),
      CANONICAL_KEYS: ['security-audit', 'improve-code', 'fix-bugs', 'write-tests'],
    }));
    vi.doMock('../../config/index.js', () => ({
      loadConfig: vi.fn().mockRejectedValue(new Error('no config')),
      resolveConfigFilePath: (configDir: string, override?: string | null) =>
        override ?? join(configDir, 'config.yaml'),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a table with Template, Type, Description columns', async () => {
    const { registerTemplates } = await import('./templates.js');
    const program = makeProgram();
    registerTemplates(program);
    await program.parseAsync(['node', 'sparecrow', 'templates']);
    expect(stdoutOutput).toContain('Template');
    expect(stdoutOutput).toContain('Type');
    expect(stdoutOutput).toContain('Description');
  });

  it('includes all four built-in template names', async () => {
    const { registerTemplates } = await import('./templates.js');
    const program = makeProgram();
    registerTemplates(program);
    await program.parseAsync(['node', 'sparecrow', 'templates']);
    expect(stdoutOutput).toContain('security-audit');
    expect(stdoutOutput).toContain('improve-code');
    expect(stdoutOutput).toContain('fix-bugs');
    expect(stdoutOutput).toContain('write-tests');
  });

  it('shows built-in type label for all four templates', async () => {
    const { registerTemplates } = await import('./templates.js');
    const program = makeProgram();
    registerTemplates(program);
    await program.parseAsync(['node', 'sparecrow', 'templates']);
    expect(stdoutOutput).toContain('built-in');
  });

  it('shows hint when no custom prompts exist', async () => {
    const { registerTemplates } = await import('./templates.js');
    const program = makeProgram();
    registerTemplates(program);
    await program.parseAsync(['node', 'sparecrow', 'templates']);
    expect(stdoutOutput).toContain('sparecrow queue add');
  });

  it('shows template descriptions', async () => {
    const { registerTemplates } = await import('./templates.js');
    const program = makeProgram();
    registerTemplates(program);
    await program.parseAsync(['node', 'sparecrow', 'templates']);
    expect(stdoutOutput).toContain('vulnerabilities');
  });
});

// ---------------------------------------------------------------------------
// Human mode — error paths
// ---------------------------------------------------------------------------

describe('registerTemplates() — human mode, builtin load failure', () => {
  let stderrOutput: string;

  beforeEach(async () => {
    vi.resetModules();
    stderrOutput = '';

    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      stderrOutput += String(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => '/fake/config.yaml',
    }));
    const { ScrowError, ErrorCode } = await import('../../errors/index.js');
    vi.doMock('../../templates/index.js', () => ({
      loadBuiltins: vi
        .fn()
        .mockRejectedValue(
          new ScrowError(ErrorCode.TEMPLATE_LOAD_ERROR, 'Could not read template file'),
        ),
      resolveTemplate: vi.fn(),
      CANONICAL_KEYS: [],
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes error to stderr when builtin loading fails in human mode', async () => {
    const { registerTemplates } = await import('./templates.js');
    const program = makeProgram();
    registerTemplates(program);
    await program.parseAsync(['node', 'sparecrow', 'templates']);
    expect(stderrOutput).toContain('error:');
    expect(stderrOutput).toContain('Could not read template file');
  });

  it('sets exitCode to 1 when builtin loading fails in human mode', async () => {
    const { registerTemplates } = await import('./templates.js');
    const program = makeProgram();
    registerTemplates(program);
    const originalExitCode = process.exitCode;
    await program.parseAsync(['node', 'sparecrow', 'templates']);
    expect(process.exitCode).toBe(1);
    process.exitCode = originalExitCode;
  });
});

// ---------------------------------------------------------------------------
// Human mode — with custom tasks
// ---------------------------------------------------------------------------

describe('registerTemplates() — human mode, with custom tasks', () => {
  let stdoutOutput: string;

  beforeEach(() => {
    vi.resetModules();
    stdoutOutput = '';

    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => '/fake/config.yaml',
    }));
    vi.doMock('../../templates/index.js', () => ({
      loadBuiltins: vi.fn().mockResolvedValue(MOCK_BUILTINS),
      resolveTemplate: vi.fn(),
      CANONICAL_KEYS: ['security-audit', 'improve-code', 'fix-bugs', 'write-tests'],
    }));
    vi.doMock('../../config/index.js', () => ({
      loadConfig: vi.fn().mockResolvedValue({
        tasks: [{ name: 'my-custom', prompt: 'Do my custom thing here.', targetPath: '/repo' }],
      }),
      resolveConfigFilePath: (configDir: string, override?: string | null) =>
        override ?? join(configDir, 'config.yaml'),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes custom task in output with type custom', async () => {
    const { registerTemplates } = await import('./templates.js');
    const program = makeProgram();
    registerTemplates(program);
    await program.parseAsync(['node', 'sparecrow', 'templates']);
    expect(stdoutOutput).toContain('my-custom');
    expect(stdoutOutput).toContain('custom');
  });

  it('does not show hint when custom tasks exist', async () => {
    const { registerTemplates } = await import('./templates.js');
    const program = makeProgram();
    registerTemplates(program);
    await program.parseAsync(['node', 'sparecrow', 'templates']);
    expect(stdoutOutput).not.toContain('Hint:');
  });
});

// ---------------------------------------------------------------------------
// Human mode — custom task prompt truncation
// ---------------------------------------------------------------------------

describe('registerTemplates() — custom task prompt truncation', () => {
  let stdoutOutput: string;

  beforeEach(() => {
    vi.resetModules();
    stdoutOutput = '';

    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => '/fake/config.yaml',
    }));
    vi.doMock('../../templates/index.js', () => ({
      loadBuiltins: vi.fn().mockResolvedValue(MOCK_BUILTINS),
      resolveTemplate: vi.fn(),
      CANONICAL_KEYS: ['security-audit', 'improve-code', 'fix-bugs', 'write-tests'],
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('truncates custom prompt longer than 60 chars and appends Unicode ellipsis', async () => {
    vi.doMock('../../config/index.js', () => ({
      loadConfig: vi.fn().mockResolvedValue({
        tasks: [{ name: 'long-task', prompt: 'A'.repeat(70), targetPath: '/repo' }],
      }),
      resolveConfigFilePath: (configDir: string, override?: string | null) =>
        override ?? join(configDir, 'config.yaml'),
    }));
    const { registerTemplates } = await import('./templates.js');
    const program = makeProgram();
    registerTemplates(program);
    await program.parseAsync(['node', 'sparecrow', 'templates']);
    expect(stdoutOutput).toContain('A'.repeat(60) + '…');
    expect(stdoutOutput).not.toContain('A'.repeat(61));
  });

  it('does not truncate or append ellipsis for prompt of exactly 60 chars', async () => {
    vi.doMock('../../config/index.js', () => ({
      loadConfig: vi.fn().mockResolvedValue({
        tasks: [{ name: 'exact-task', prompt: 'B'.repeat(60), targetPath: '/repo' }],
      }),
      resolveConfigFilePath: (configDir: string, override?: string | null) =>
        override ?? join(configDir, 'config.yaml'),
    }));
    const { registerTemplates } = await import('./templates.js');
    const program = makeProgram();
    registerTemplates(program);
    await program.parseAsync(['node', 'sparecrow', 'templates']);
    expect(stdoutOutput).toContain('B'.repeat(60));
    expect(stdoutOutput).not.toContain('…');
  });
});

// ---------------------------------------------------------------------------
// JSON mode
// ---------------------------------------------------------------------------

describe('registerTemplates() — JSON mode', () => {
  let stdoutOutput: string;

  beforeEach(() => {
    vi.resetModules();
    stdoutOutput = '';

    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdoutOutput += String(data);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    vi.doMock('../index.js', () => ({
      isJsonMode: () => true,
      getConfigPath: () => '/fake/config.yaml',
    }));
    vi.doMock('../../templates/index.js', () => ({
      loadBuiltins: vi.fn().mockResolvedValue(MOCK_BUILTINS),
      resolveTemplate: vi.fn(),
      CANONICAL_KEYS: ['security-audit', 'improve-code', 'fix-bugs', 'write-tests'],
    }));
    vi.doMock('../../config/index.js', () => ({
      loadConfig: vi.fn().mockRejectedValue(new Error('no config')),
      resolveConfigFilePath: (configDir: string, override?: string | null) =>
        override ?? join(configDir, 'config.yaml'),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('outputs valid JSON with ok, data, error fields always present', async () => {
    const { registerTemplates } = await import('./templates.js');
    const program = makeProgram();
    registerTemplates(program);
    await program.parseAsync(['node', 'sparecrow', 'templates']);
    const parsed = parseJson(stdoutOutput);
    expect(parsed).toHaveProperty('ok');
    expect(parsed).toHaveProperty('data');
    expect(parsed).toHaveProperty('error');
  });

  it('returns ok: true with templates array', async () => {
    const { registerTemplates } = await import('./templates.js');
    const program = makeProgram();
    registerTemplates(program);
    await program.parseAsync(['node', 'sparecrow', 'templates']);
    const parsed = parseJson(stdoutOutput);
    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeNull();
    const data = parsed.data as { templates: unknown[]; customCount: number };
    expect(Array.isArray(data.templates)).toBe(true);
  });

  it('includes all four built-in templates in data.templates', async () => {
    const { registerTemplates } = await import('./templates.js');
    const program = makeProgram();
    registerTemplates(program);
    await program.parseAsync(['node', 'sparecrow', 'templates']);
    const parsed = parseJson(stdoutOutput);
    const data = parsed.data as {
      templates: Array<{ name: string; type: string; description: string }>;
      customCount: number;
    };
    expect(data.templates).toHaveLength(4);
    const names = data.templates.map((t) => t.name);
    expect(names).toContain('security-audit');
    expect(names).toContain('improve-code');
    expect(names).toContain('fix-bugs');
    expect(names).toContain('write-tests');
  });

  it('includes customCount field', async () => {
    const { registerTemplates } = await import('./templates.js');
    const program = makeProgram();
    registerTemplates(program);
    await program.parseAsync(['node', 'sparecrow', 'templates']);
    const parsed = parseJson(stdoutOutput);
    const data = parsed.data as { templates: unknown[]; customCount: number };
    expect(typeof data.customCount).toBe('number');
    expect(data.customCount).toBe(0);
  });

  it('each template entry has name, type, description fields', async () => {
    const { registerTemplates } = await import('./templates.js');
    const program = makeProgram();
    registerTemplates(program);
    await program.parseAsync(['node', 'sparecrow', 'templates']);
    const parsed = parseJson(stdoutOutput);
    const data = parsed.data as {
      templates: Array<{ name: string; type: string; description: string }>;
    };
    for (const t of data.templates) {
      expect(typeof t.name).toBe('string');
      expect(typeof t.type).toBe('string');
      expect(typeof t.description).toBe('string');
    }
  });

  it('returns error JSON when builtin loading fails', async () => {
    vi.resetModules();
    stdoutOutput = '';
    vi.doMock('../index.js', () => ({
      isJsonMode: () => true,
      getConfigPath: () => '/fake/config.yaml',
    }));
    const { ScrowError, ErrorCode } = await import('../../errors/index.js');
    vi.doMock('../../templates/index.js', () => ({
      loadBuiltins: vi
        .fn()
        .mockRejectedValue(
          new ScrowError(ErrorCode.TEMPLATE_LOAD_ERROR, 'Could not load templates'),
        ),
      resolveTemplate: vi.fn(),
      CANONICAL_KEYS: [],
    }));

    const { registerTemplates } = await import('./templates.js');
    const program = makeProgram();
    registerTemplates(program);
    await program.parseAsync(['node', 'sparecrow', 'templates']);
    const parsed = parseJson(stdoutOutput);
    expect(parsed.ok).toBe(false);
    expect(parsed.data).toBeNull();
    expect(parsed.error).not.toBeNull();
  });
});
