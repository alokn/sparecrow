/** Unit tests for ANSI helpers that strip escape codes and measure visible width. */
import { describe, it, expect } from 'vitest';
import { stripAnsi, visibleWidth } from './ansi-utils.js';

describe('stripAnsi()', () => {
  it('returns the original string when no ANSI codes are present', () => {
    expect(stripAnsi('plain text')).toBe('plain text');
  });

  it('removes ANSI color and reset sequences', () => {
    const colored = '\u001b[31merror\u001b[0m details';
    expect(stripAnsi(colored)).toBe('error details');
  });
});

describe('visibleWidth()', () => {
  it('counts visible characters only for ANSI-colored content', () => {
    const colored = '\u001b[32mOK\u001b[0m';
    expect(visibleWidth(colored)).toBe(2);
  });

  it('returns zero for an empty string', () => {
    expect(visibleWidth('')).toBe(0);
  });
});
