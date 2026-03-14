/** Unit tests for the JSON output module. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { printJson } from './json-output.js';

describe('printJson()', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function captureStdout(): string[] {
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    return written;
  }

  it('writes valid JSON to stdout (AC8)', () => {
    const written = captureStdout();
    printJson({ ok: true, data: { count: 3 }, error: null });
    expect(written).toHaveLength(1);
    const parsed = JSON.parse(written[0] as string);
    expect(parsed).toEqual({ ok: true, data: { count: 3 }, error: null });
  });

  it('always includes ok, data, and error fields (AC8)', () => {
    const written = captureStdout();
    printJson({ ok: false, data: null, error: { code: 'E001', message: 'Fail' } });
    const parsed = JSON.parse(written[0] as string);
    expect(parsed).toHaveProperty('ok');
    expect(parsed).toHaveProperty('data');
    expect(parsed).toHaveProperty('error');
  });

  it('output contains no ANSI escape codes (AC8)', () => {
    const written = captureStdout();
    printJson({ ok: true, data: 'test value', error: null });
    expect(written[0]).not.toContain('\x1b[');
  });

  it('appends a newline after JSON', () => {
    const written = captureStdout();
    printJson({ ok: true, data: null, error: null });
    expect(written[0]).toMatch(/\n$/);
  });
});
