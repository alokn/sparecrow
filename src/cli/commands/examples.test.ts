/** Unit tests for the examples command. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EXAMPLE_CATEGORIES, getCategoryKeys, findCategory } from './examples.js';
import { Command } from 'commander';

describe('EXAMPLE_CATEGORIES', () => {
  it('contains four categories', () => {
    expect(EXAMPLE_CATEGORIES).toHaveLength(4);
  });

  it('has unique category keys', () => {
    const keys = EXAMPLE_CATEGORIES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every example has title, command, and description', () => {
    for (const category of EXAMPLE_CATEGORIES) {
      for (const example of category.examples) {
        expect(example.title).toBeTruthy();
        expect(example.command).toBeTruthy();
        expect(example.description).toBeTruthy();
      }
    }
  });
});

describe('getCategoryKeys', () => {
  it('returns all category keys', () => {
    const keys = getCategoryKeys();
    expect(keys).toEqual(['getting-started', 'queue', 'config', 'monitoring']);
  });
});

describe('findCategory', () => {
  it('finds category by exact key', () => {
    const result = findCategory('queue');
    expect(result).toBeDefined();
    expect(result!.key).toBe('queue');
  });

  it('finds category by label (case-insensitive)', () => {
    const result = findCategory('Queue Management');
    expect(result).toBeDefined();
    expect(result!.key).toBe('queue');
  });

  it('returns undefined for unknown category', () => {
    expect(findCategory('nonexistent')).toBeUndefined();
  });
});

describe('registerExamples', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    vi.restoreAllMocks();
  });

  async function runExamples(...args: string[]): Promise<void> {
    vi.resetModules();
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
      isInteractive: () => false,
    }));
    vi.doMock('../../ui/index.js', () => ({
      printJson: (obj: unknown) => {
        stdoutSpy(JSON.stringify(obj));
      },
      getTokens: () => ({ DIVIDER_H: '-' }),
    }));

    const { registerExamples: reg } = await import('./examples.js');
    const program = new Command();
    program.exitOverride();
    reg(program);
    await program.parseAsync(['node', 'test', 'examples', ...args]);
  }

  async function runExamplesJson(...args: string[]): Promise<string> {
    vi.resetModules();
    vi.doMock('../index.js', () => ({
      isJsonMode: () => true,
      getConfigPath: () => undefined,
      isInteractive: () => false,
    }));
    vi.doMock('../../ui/index.js', () => ({
      printJson: (obj: unknown) => {
        stdoutSpy(JSON.stringify(obj));
      },
      getTokens: () => ({ DIVIDER_H: '-' }),
    }));

    const { registerExamples: reg } = await import('./examples.js');
    const program = new Command();
    program.exitOverride();
    reg(program);
    await program.parseAsync(['node', 'test', 'examples', ...args]);

    const call = stdoutSpy.mock.calls[0];
    return call ? String(call[0]) : '';
  }

  it('displays all categories without arguments', async () => {
    await runExamples();
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('Getting Started');
    expect(output).toContain('Queue Management');
    expect(output).toContain('Configuration');
    expect(output).toContain('Monitoring');
  });

  it('filters by category argument', async () => {
    await runExamples('queue');
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('Queue Management');
    expect(output).not.toContain('Getting Started');
  });

  it('shows error for invalid category', async () => {
    await runExamples('invalid');
    const errOutput = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(errOutput).toContain("Unknown category 'invalid'");
    expect(errOutput).toContain('Available categories');
  });

  it('sets process.exitCode to 1 for invalid category (text mode)', async () => {
    process.exitCode = 0;
    await runExamples('invalid');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('returns JSON envelope with all categories', async () => {
    const raw = await runExamplesJson();
    const parsed = JSON.parse(raw);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.categories).toHaveLength(4);
  });

  it('returns JSON envelope filtered by category', async () => {
    const raw = await runExamplesJson('monitoring');
    const parsed = JSON.parse(raw);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.categories).toHaveLength(1);
    expect(parsed.data.categories[0].key).toBe('monitoring');
  });

  it('returns JSON error for invalid category', async () => {
    const raw = await runExamplesJson('bogus');
    const parsed = JSON.parse(raw);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe('INVALID_CATEGORY');
  });
});
