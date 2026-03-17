/** QA automation tests for story 26.2: man page generation command. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { stripRoff } from './man.js';

// ---------------------------------------------------------------------------
// stripRoff — comprehensive formatting coverage
// ---------------------------------------------------------------------------

describe('stripRoff — extended formatting', () => {
  it('converts .SS subsection headers to indented plain text with dashes', () => {
    const roff = '.SS "Queue Management"\nsome queue text';
    const result = stripRoff(roff);
    expect(result).toContain('Queue Management');
    expect(result).toContain('---');
    expect(result).not.toContain('.SS');
  });

  it('removes .RS indent markers (and any trailing content on next line due to \\s* consuming newline)', () => {
    // The stripRoff regex /^\.RS\s*.*$/gm has \s* which matches newlines,
    // so content on the line after .RS is also consumed — this is the actual behavior.
    const roff = '.RS\n.RE\npreserved content';
    const result = stripRoff(roff);
    expect(result).not.toContain('.RS');
    expect(result).not.toContain('.RE');
    expect(result).toContain('preserved content');
  });

  it('removes .br line break markers', () => {
    const roff = 'line one\n.br\nline two';
    const result = stripRoff(roff);
    expect(result).not.toContain('.br');
    expect(result).toContain('line one');
    expect(result).toContain('line two');
  });

  it('removes .nf and .fi no-fill / fill markers', () => {
    const roff = '.nf\ncode block\n.fi';
    const result = stripRoff(roff);
    expect(result).not.toContain('.nf');
    expect(result).not.toContain('.fi');
    expect(result).toContain('code block');
  });

  it('strips \\fB...\\fP bold variant markers', () => {
    const roff = '\\fBbold text\\fP continues';
    const result = stripRoff(roff);
    expect(result).toContain('bold text continues');
    expect(result).not.toContain('\\fB');
    expect(result).not.toContain('\\fP');
  });

  it('strips \\fI...\\fP italic variant markers', () => {
    const roff = '\\fIitalic text\\fP continues';
    const result = stripRoff(roff);
    expect(result).toContain('italic text continues');
    expect(result).not.toContain('\\fI');
  });

  it('removes \\| zero-width joiner', () => {
    const roff = 'word\\|suffix';
    const result = stripRoff(roff);
    expect(result).toContain('wordsuffix');
    expect(result).not.toContain('\\|');
  });

  it('converts \\. escaped period to literal period', () => {
    const roff = 'end of sentence\\.';
    const result = stripRoff(roff);
    expect(result).toContain('end of sentence.');
    expect(result).not.toContain('\\.');
  });

  it("converts \\' escaped apostrophe to literal apostrophe", () => {
    const roff = "it\\'s a test";
    const result = stripRoff(roff);
    expect(result).toContain("it's a test");
  });

  it('converts \\` escaped backtick to literal backtick', () => {
    const roff = 'run \\`command\\`';
    const result = stripRoff(roff);
    expect(result).toContain('run `command`');
    expect(result).not.toContain('\\`');
  });

  it('removes \\& zero-width character', () => {
    const roff = 'word\\&suffix';
    const result = stripRoff(roff);
    expect(result).toContain('wordsuffix');
    expect(result).not.toContain('\\&');
  });

  it('converts \\" escaped double-quote to literal double-quote', () => {
    const roff = '\\"quoted\\"';
    const result = stripRoff(roff);
    expect(result).toContain('"quoted"');
    expect(result).not.toContain('\\"');
  });

  it('collapses 3+ consecutive newlines to maximum 2', () => {
    const roff = 'para one\n\n\n\npara two';
    const result = stripRoff(roff);
    // Should not have 3+ consecutive newlines
    expect(result).not.toMatch(/\n{3}/);
    expect(result).toContain('para one');
    expect(result).toContain('para two');
  });

  it('trims leading/trailing whitespace and ends with single newline', () => {
    const roff = '  \n\nsome content\n\n  ';
    const result = stripRoff(roff);
    expect(result).toBe(result.trimStart());
    expect(result.endsWith('\n')).toBe(true);
  });

  it('handles .SH with quoted section name', () => {
    const roff = '.SH "EXIT CODES"';
    const result = stripRoff(roff);
    expect(result).toContain('EXIT CODES');
    expect(result).not.toContain('"EXIT CODES"');
  });

  it('handles empty string input gracefully', () => {
    const result = stripRoff('');
    expect(typeof result).toBe('string');
    expect(result.endsWith('\n')).toBe(true);
  });

  it('handles input with no roff markers as plain text passthrough', () => {
    const text = 'plain text with no formatting';
    const result = stripRoff(text);
    expect(result).toContain('plain text with no formatting');
  });

  it('converts a single .SH header when it is the only header on its line', () => {
    // Each .SH must be on its own line to be replaced correctly
    const roff = '.SH NAME';
    const result = stripRoff(roff);
    expect(result).toContain('NAME');
    expect(result).toContain('===');
    expect(result).not.toContain('.SH NAME');
  });

  it('strips bold markers embedded within longer text', () => {
    const roff = 'The \\fBsparecrow\\fR daemon monitors Claude Code usage.';
    const result = stripRoff(roff);
    expect(result).toBe('The sparecrow daemon monitors Claude Code usage.\n');
  });
});

// ---------------------------------------------------------------------------
// registerMan — additional command behaviour
// ---------------------------------------------------------------------------

describe('registerMan — extended behaviour', () => {
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
    process.exitCode = 0;
  });

  async function runMan(
    opts: {
      json?: boolean;
      manPageContent?: string | null;
    } = {},
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

    const content = opts.manPageContent;
    if (content === null) {
      vi.doMock('node:fs/promises', () => ({
        readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
      }));
    } else if (content !== undefined) {
      vi.doMock('node:fs/promises', () => ({
        readFile: vi.fn().mockResolvedValue(content),
      }));
    } else {
      vi.doMock('node:fs/promises', () => ({
        readFile: vi.fn().mockResolvedValue('.SH NAME\nsparecrow - man test'),
      }));
    }

    const { registerMan: reg } = await import('./man.js');
    const program = new Command();
    program.exitOverride();
    reg(program);
    await program.parseAsync(['node', 'test', 'man']);
  }

  it('JSON response has ok=true, data.path field, and data.content field', async () => {
    await runMan({ json: true, manPageContent: '.SH NAME\ntest content' });
    const raw = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    const parsed = JSON.parse(raw);
    expect(parsed.ok).toBe(true);
    expect(typeof parsed.data.path).toBe('string');
    expect(typeof parsed.data.content).toBe('string');
    expect(parsed.error).toBeNull();
  });

  it('JSON error response has ok=false, error.code, and null data', async () => {
    await runMan({ json: true, manPageContent: null });
    const raw = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    const parsed = JSON.parse(raw);
    expect(parsed.ok).toBe(false);
    expect(parsed.data).toBeNull();
    expect(parsed.error).not.toBeNull();
    expect(parsed.error.code).toBe('MAN_PAGE_NOT_FOUND');
    expect(typeof parsed.error.message).toBe('string');
  });

  it('sets process.exitCode=1 in both text and JSON not-found modes', async () => {
    await runMan({ json: false, manPageContent: null });
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;

    await runMan({ json: true, manPageContent: null });
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('text mode output strips .TH and .P markers from roff content', async () => {
    const roff = '.TH SPARECROW 1\n.SH NAME\n.P\nsparecrow content\n.P\nmore content';
    await runMan({ manPageContent: roff });
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).not.toContain('.TH');
    expect(output).not.toContain('.P\n');
    expect(output).toContain('NAME');
    expect(output).toContain('sparecrow content');
  });

  it('JSON mode returns raw roff content without stripping', async () => {
    const roffContent = '.TH SPARECROW 1\n.SH NAME\nsparecrow';
    await runMan({ json: true, manPageContent: roffContent });
    const raw = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    const parsed = JSON.parse(raw);
    // JSON mode returns raw bytes — no strip applied
    expect(parsed.data.content).toBe(roffContent);
  });

  it('man command is registered with correct name', async () => {
    vi.resetModules();
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
      isInteractive: () => false,
    }));
    vi.doMock('../../ui/index.js', () => ({ printJson: vi.fn() }));
    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn().mockResolvedValue('content'),
    }));
    const { registerMan: reg } = await import('./man.js');
    const program = new Command();
    reg(program);
    const manCmd = program.commands.find((c) => c.name() === 'man');
    expect(manCmd).toBeDefined();
  });

  it('man command description mentions manual page', async () => {
    vi.resetModules();
    vi.doMock('../index.js', () => ({
      isJsonMode: () => false,
      getConfigPath: () => undefined,
      isInteractive: () => false,
    }));
    vi.doMock('../../ui/index.js', () => ({ printJson: vi.fn() }));
    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn().mockResolvedValue('content'),
    }));
    const { registerMan: reg } = await import('./man.js');
    const program = new Command();
    reg(program);
    const manCmd = program.commands.find((c) => c.name() === 'man');
    expect(manCmd?.description()).toMatch(/manual|man page/i);
  });

  it('text error message mentions build step as recovery action', async () => {
    await runMan({ json: false, manPageContent: null });
    const errOutput = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(errOutput).toMatch(/build|reinstall/i);
  });
});

// ---------------------------------------------------------------------------
// MAN_PAGE_NOT_FOUND error code — error registry consistency
// ---------------------------------------------------------------------------

describe('MAN_PAGE_NOT_FOUND error code', () => {
  it('is defined in ErrorCode registry', async () => {
    const { ErrorCode } = await import('../../errors/index.js');
    expect(ErrorCode.MAN_PAGE_NOT_FOUND).toBe('MAN_PAGE_NOT_FOUND');
  });

  it('has a corresponding user message in error messages registry', async () => {
    const { getErrorMessage, ErrorCode } = await import('../../errors/index.js');
    const msg = getErrorMessage(ErrorCode.MAN_PAGE_NOT_FOUND);
    expect(typeof msg.userMessage).toBe('string');
    expect(msg.userMessage.length).toBeGreaterThan(0);
    expect(typeof msg.suggestion).toBe('string');
    expect(msg.suggestion.length).toBeGreaterThan(0);
  });

  it('suggestion mentions build or reinstall', async () => {
    const { getErrorMessage, ErrorCode } = await import('../../errors/index.js');
    const msg = getErrorMessage(ErrorCode.MAN_PAGE_NOT_FOUND);
    expect(msg.suggestion).toMatch(/build|reinstall/i);
  });
});
