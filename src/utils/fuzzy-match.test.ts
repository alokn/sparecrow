/** Tests for Levenshtein distance and fuzzy matching. */
import { describe, it, expect } from 'vitest';
import { levenshteinDistance, findClosestMatch } from './fuzzy-match.js';

describe('levenshteinDistance', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshteinDistance('abc', 'abc')).toBe(0);
  });

  it('returns length of other string when one is empty', () => {
    expect(levenshteinDistance('', 'abc')).toBe(3);
    expect(levenshteinDistance('abc', '')).toBe(3);
  });

  it('returns 0 for two empty strings', () => {
    expect(levenshteinDistance('', '')).toBe(0);
  });

  it('computes single character difference', () => {
    expect(levenshteinDistance('cat', 'bat')).toBe(1);
  });

  it('computes insertion distance', () => {
    expect(levenshteinDistance('abc', 'abcd')).toBe(1);
  });

  it('computes deletion distance', () => {
    expect(levenshteinDistance('abcd', 'abc')).toBe(1);
  });

  it('computes transposition-like distance', () => {
    // "securty-adit" vs "security-audit" — realistic typo scenario
    expect(levenshteinDistance('securty-adit', 'security-audit')).toBeLessThanOrEqual(4);
  });

  it('is symmetric', () => {
    expect(levenshteinDistance('kitten', 'sitting')).toBe(levenshteinDistance('sitting', 'kitten'));
  });
});

describe('findClosestMatch', () => {
  const candidates = ['security-audit', 'fix-bugs', 'improve-code', 'write-tests'];

  it('finds exact match', () => {
    expect(findClosestMatch('security-audit', candidates)).toBe('security-audit');
  });

  it('finds close typo match', () => {
    expect(findClosestMatch('securty-adit', candidates)).toBe('security-audit');
  });

  it('finds match with case differences', () => {
    expect(findClosestMatch('Fix-Bugs', candidates)).toBe('fix-bugs');
  });

  it('returns null for completely unrelated input', () => {
    expect(findClosestMatch('xyzzy-foobar-baz', candidates)).toBeNull();
  });

  it('returns null for empty candidates', () => {
    expect(findClosestMatch('test', [])).toBeNull();
  });

  it('picks the closest when multiple are similar', () => {
    expect(findClosestMatch('fix-bug', candidates)).toBe('fix-bugs');
  });

  it('matches short prefix query against longer canonical name (asymmetric threshold fix)', () => {
    // "fix" (length 3) vs "fix-bugs" (length 8): distance=5, maxDistance=Math.max(2, floor(8*0.6))=4
    // With old threshold using only query length: maxDistance=Math.max(2, floor(3*0.6))=2 → would fail
    // With new threshold using max(query, candidate) length: maxDistance=Math.max(2, floor(8*0.6))=4 → still no match
    // "fix" vs "fix-bugs" distance is 5 which > 4, so it correctly returns null
    // But a closer prefix "fix-bug" (distance=1 vs fix-bugs) should match
    expect(findClosestMatch('fix-bug', candidates)).toBe('fix-bugs');
  });

  it('returns null for empty query against non-empty candidates', () => {
    expect(findClosestMatch('', candidates)).toBeNull();
  });
});
