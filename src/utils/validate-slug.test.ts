/** Unit tests for validateSlug validation utility. */
import { describe, it, expect } from 'vitest';
import { validateSlug } from './validate-slug.js';

describe('validateSlug', () => {
  // ── Valid slugs pass through unchanged ──────────────────────────────────

  it('returns valid alphanumeric slug unchanged', () => {
    expect(validateSlug('my-template')).toBe('my-template');
  });

  it('returns valid slug with underscores unchanged', () => {
    expect(validateSlug('code_review')).toBe('code_review');
  });

  it('returns valid slug with hyphens and numbers unchanged', () => {
    expect(validateSlug('bug-hunter-v2')).toBe('bug-hunter-v2');
  });

  it('returns single character slug unchanged', () => {
    expect(validateSlug('a')).toBe('a');
  });

  it('returns slug with mixed case unchanged', () => {
    expect(validateSlug('MyTemplate')).toBe('MyTemplate');
  });

  // ── Forward slash rejection ─────────────────────────────────────────────

  it('rejects slug containing forward slash', () => {
    expect(() => validateSlug('path/traversal')).toThrow();
    expect(() => validateSlug('path/traversal')).toThrow(
      expect.objectContaining({ code: 'INVALID_SLUG' }),
    );
  });

  it('rejects slug starting with forward slash', () => {
    expect(() => validateSlug('/etc/passwd')).toThrow(
      expect.objectContaining({ code: 'INVALID_SLUG' }),
    );
  });

  // ── Backslash rejection ─────────────────────────────────────────────────

  it('rejects slug containing backslash', () => {
    expect(() => validateSlug('path\\traversal')).toThrow(
      expect.objectContaining({ code: 'INVALID_SLUG' }),
    );
  });

  // ── Double-dot rejection ────────────────────────────────────────────────

  it('rejects slug containing double dots (path traversal)', () => {
    expect(() => validateSlug('..secret')).toThrow(
      expect.objectContaining({ code: 'INVALID_SLUG' }),
    );
  });

  it('rejects slug with embedded double dots', () => {
    expect(() => validateSlug('foo..bar')).toThrow(
      expect.objectContaining({ code: 'INVALID_SLUG' }),
    );
  });

  it('rejects bare double dots', () => {
    expect(() => validateSlug('..')).toThrow(expect.objectContaining({ code: 'INVALID_SLUG' }));
  });

  // ── Control character rejection ─────────────────────────────────────────

  it('rejects slug containing null byte', () => {
    expect(() => validateSlug('my\x00slug')).toThrow(
      expect.objectContaining({ code: 'INVALID_SLUG' }),
    );
  });

  it('rejects slug containing newline', () => {
    expect(() => validateSlug('my\nslug')).toThrow(
      expect.objectContaining({ code: 'INVALID_SLUG' }),
    );
  });

  it('rejects slug containing tab', () => {
    expect(() => validateSlug('my\tslug')).toThrow(
      expect.objectContaining({ code: 'INVALID_SLUG' }),
    );
  });

  it('rejects slug containing carriage return', () => {
    expect(() => validateSlug('my\rslug')).toThrow(
      expect.objectContaining({ code: 'INVALID_SLUG' }),
    );
  });

  it('rejects slug containing escape character (U+001B)', () => {
    expect(() => validateSlug('my\x1bslug')).toThrow(
      expect.objectContaining({ code: 'INVALID_SLUG' }),
    );
  });

  it('rejects slug containing DEL character (U+007F)', () => {
    expect(() => validateSlug('my\x7fslug')).toThrow(
      expect.objectContaining({ code: 'INVALID_SLUG' }),
    );
  });

  // ── Leading dot rejection ───────────────────────────────────────────────

  it('rejects slug starting with a dot', () => {
    expect(() => validateSlug('.hidden')).toThrow(
      expect.objectContaining({ code: 'INVALID_SLUG' }),
    );
  });

  it('rejects slug that is just a dot', () => {
    expect(() => validateSlug('.')).toThrow(expect.objectContaining({ code: 'INVALID_SLUG' }));
  });

  // ── Dots in other positions are fine ────────────────────────────────────

  it('allows single dot in middle of slug', () => {
    expect(validateSlug('my.template')).toBe('my.template');
  });
});
