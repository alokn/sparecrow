/** Unit tests for the man command. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { EventEmitter } from 'node:events';
import { stripRoff, displayPaged } from './man.js';

describe('stripRoff', () => {
  it('converts .SH headers to plain text with separator', () => {
    const roff = '.SH NAME\nsparecrow';
    const result = stripRoff(roff);
    expect(result).toContain('NAME');
    expect(result).toContain('===');
  });

  it('strips bold formatting markers', () => {
    const roff = '\\fBsparecrow\\fR is a tool';
    const result = stripRoff(roff);
    expect(result).toContain('sparecrow is a tool');
    expect(result).not.toContain('\\fB');
  });

  it('strips italic formatting markers', () => {
    const roff = '\\fIpath\\fR to config';
    const result = stripRoff(roff);
    expect(result).toContain('path to config');
  });

  it('converts escaped hyphens to plain hyphens', () => {
    const roff = '\\-\\-json';
    const result = stripRoff(roff);
    expect(result).toContain('--json');
  });

  it('removes .TH title header', () => {
    const roff = '.TH "SPARECROW" "1" "March 2026"\n.SH NAME';
    const result = stripRoff(roff);
    expect(result).not.toContain('.TH');
  });

  it('removes .P paragraph markers', () => {
    const roff = '.P\nsome text\n.P\nmore text';
    const result = stripRoff(roff);
    expect(result).not.toContain('.P');
    expect(result).toContain('some text');
  });

  it('converts .IP to bullet points', () => {
    const roff = '.IP \\(bu 2\nitem one';
    const result = stripRoff(roff);
    expect(result).toContain('*');
    expect(result).toContain('item one');
  });
});

describe('registerMan', () => {
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

  async function runMan(
    opts: { json?: boolean; manPageContent?: string | null } = {},
  ): Promise<void> {
    vi.resetModules();
    vi.doMock('../index.js', () => ({
      isJsonMode: () => opts.json ?? false,
      getConfigPath: () => undefined,
      isInteractive: () => false,
    }));
    vi.doMock('../../ui/index.js', () => ({
      printJson: (obj: unknown) => {
        stdoutSpy(JSON.stringify(obj));
      },
    }));

    // Mock findManPage at the module level by mocking fs/promises
    const content = opts.manPageContent;
    if (content === null) {
      // Simulate man page not found
      vi.doMock('node:fs/promises', () => ({
        readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
      }));
    } else if (content !== undefined) {
      vi.doMock('node:fs/promises', () => ({
        readFile: vi.fn().mockResolvedValue(content),
      }));
    } else {
      vi.doMock('node:fs/promises', () => ({
        readFile: vi.fn().mockResolvedValue('.SH NAME\nsparecrow - test man page'),
      }));
    }

    const { registerMan: reg } = await import('./man.js');
    const program = new Command();
    program.exitOverride();
    reg(program);
    await program.parseAsync(['node', 'test', 'man']);
  }

  it('displays man page content in text mode', async () => {
    await runMan({ manPageContent: '.SH NAME\nsparecrow - test content' });
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('NAME');
    expect(output).toContain('sparecrow');
  });

  it('returns JSON envelope with man page content', async () => {
    await runMan({ json: true, manPageContent: '.SH NAME\nsparecrow - json test' });
    const raw = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    const parsed = JSON.parse(raw);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.content).toContain('sparecrow');
  });

  it('shows error when man page not found (text mode)', async () => {
    await runMan({ manPageContent: null });
    const errOutput = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(errOutput).toContain('Man page file not found');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('returns JSON error when man page not found', async () => {
    await runMan({ json: true, manPageContent: null });
    const raw = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    const parsed = JSON.parse(raw);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe('MAN_PAGE_NOT_FOUND');
    process.exitCode = 0;
  });

  it('displays markdown content directly when source is .md file', async () => {
    // When findManPage returns a .md path, content is displayed as-is
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
    }));

    // Mock readFile to fail for .1 paths and succeed for .md path
    let callCount = 0;
    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn().mockImplementation((path: string) => {
        callCount++;
        if (path.endsWith('.1')) {
          return Promise.reject(new Error('ENOENT'));
        }
        if (path.endsWith('.md')) {
          return Promise.resolve('# sparecrow manual\n\nThis is the man page.');
        }
        return Promise.reject(new Error('ENOENT'));
      }),
    }));

    const { registerMan: reg } = await import('./man.js');
    const program = new Command();
    program.exitOverride();
    reg(program);
    await program.parseAsync(['node', 'test', 'man']);

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('sparecrow manual');
    expect(callCount).toBeGreaterThan(0);
  });
});

describe('displayPaged — TTY branch via spawn mock', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  const originalIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    vi.restoreAllMocks();
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
  });

  it('writes content directly when stdout is not a TTY', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    await displayPaged('test content');
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('test content');
  });

  it('falls back to stdout when less errors and double-resolve guard prevents duplicate write', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    vi.resetModules();
    const fakeProcess = new EventEmitter() as EventEmitter & {
      stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> } | null;
    };
    fakeProcess.stdin = { write: vi.fn(), end: vi.fn() };

    vi.doMock('node:child_process', () => ({
      spawn: vi.fn().mockReturnValue(fakeProcess),
      execFile: vi.fn(),
    }));

    const { displayPaged: dp } = await import('./man.js');
    const displayPromise = dp('paged content');
    // Simulate less not found: Node fires error then close in sequence
    fakeProcess.emit('error', new Error('spawn less ENOENT'));
    fakeProcess.emit('close', 1);
    await displayPromise;

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('paged content');
    // Ensure content written exactly once despite two events (double-resolve guard)
    const writeCount = stdoutSpy.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('paged content'),
    ).length;
    expect(writeCount).toBe(1);
  });

  it('resolves without stdout write when less closes normally', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    vi.resetModules();
    const fakeProcess = new EventEmitter() as EventEmitter & {
      stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> } | null;
    };
    fakeProcess.stdin = { write: vi.fn(), end: vi.fn() };

    vi.doMock('node:child_process', () => ({
      spawn: vi.fn().mockReturnValue(fakeProcess),
      execFile: vi.fn(),
    }));

    const { displayPaged: dp } = await import('./man.js');
    const displayPromise = dp('should not appear');
    fakeProcess.emit('close', 0);
    await displayPromise;

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).not.toContain('should not appear');
  });

  it('handles null stdin on spawned pager without throwing', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    vi.resetModules();
    const fakeProcess = new EventEmitter() as EventEmitter & { stdin: null };
    fakeProcess.stdin = null;

    vi.doMock('node:child_process', () => ({
      spawn: vi.fn().mockReturnValue(fakeProcess),
      execFile: vi.fn(),
    }));

    const { displayPaged: dp } = await import('./man.js');
    const displayPromise = dp('null stdin content');
    fakeProcess.emit('close', 0);
    // Should resolve without throwing even with null stdin
    await expect(displayPromise).resolves.toBeUndefined();
  });
});
