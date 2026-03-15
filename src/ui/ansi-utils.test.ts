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

// Note: ansi-utils.ts exports stripAnsi and visibleWidth only.
// The truncate helper lives in dashboard-card.ts and is not tested here.
describe('multi-byte unicode handling', () => {
  it('stripAnsi preserves CJK characters after stripping ANSI codes', () => {
    const colored = '\u001b[31m\u4F60\u597D\u001b[0m'; // 你好 (Chinese)
    expect(stripAnsi(colored)).toBe('\u4F60\u597D');
  });

  it('stripAnsi preserves emoji after stripping ANSI codes', () => {
    const colored = '\u001b[33m\uD83D\uDE80 Launch\u001b[0m'; // 🚀 Launch
    expect(stripAnsi(colored)).toBe('\uD83D\uDE80 Launch');
  });

  it('visibleWidth counts CJK characters by string length (not terminal width)', () => {
    // Note: visibleWidth uses .length which counts UTF-16 code units, not terminal columns.
    // CJK characters are single code units so .length === 2 for two CJK characters.
    const cjk = '\u4F60\u597D'; // 你好
    expect(visibleWidth(cjk)).toBe(2);
  });

  it('visibleWidth counts emoji by string length (UTF-16 code units)', () => {
    // 🚀 is a surrogate pair (2 UTF-16 code units), so .length === 2
    const emoji = '\uD83D\uDE80';
    expect(visibleWidth(emoji)).toBe(2);
  });

  it('visibleWidth counts ZWJ-sequence emoji by UTF-16 code units, not grapheme clusters', () => {
    // 👨‍👩‍👧 is a ZWJ sequence: 👨 (2) + ZWJ (1) + 👩 (2) + ZWJ (1) + 👧 (2) = 8 UTF-16 code units.
    // visibleWidth uses string .length (UTF-16 code units), NOT grapheme cluster count (1).
    // This test documents this known limitation — the implementation does not use Intl.Segmenter.
    const family = '\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67';
    expect(visibleWidth(family)).toBe(8);
  });

  it('visibleWidth counts mixed ASCII and CJK after stripping ANSI', () => {
    const mixed = '\u001b[32mHello \u4E16\u754C\u001b[0m'; // Hello 世界
    expect(visibleWidth(mixed)).toBe(8); // 'Hello 世界'.length === 8
  });

  it('stripAnsi handles Korean characters with ANSI codes', () => {
    const colored = '\u001b[36m\uD55C\uAD6D\uC5B4\u001b[0m'; // 한국어
    expect(stripAnsi(colored)).toBe('\uD55C\uAD6D\uC5B4');
  });

  it('stripAnsi handles Japanese katakana with ANSI codes', () => {
    const colored = '\u001b[35m\u30C6\u30B9\u30C8\u001b[0m'; // テスト
    expect(stripAnsi(colored)).toBe('\u30C6\u30B9\u30C8');
  });
});
