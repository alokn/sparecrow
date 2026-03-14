/** Unit tests for the SectionDivider component. */
import { describe, it, expect, afterEach } from 'vitest';
import { setRenderContext, resetRenderContext } from './render-context.js';
import { renderSectionDivider } from './section-divider.js';

describe('renderSectionDivider()', () => {
  afterEach(() => resetRenderContext());

  // AC6: Unicode renders ─ characters
  it('renders ─ characters in unicode mode (AC6)', () => {
    setRenderContext({ noColor: false, useUnicode: true, isTTY: true, width: 80 });
    const out = renderSectionDivider();
    expect(out).toMatch(/^─+$/);
  });

  // AC6: ASCII fallback renders - characters
  it('renders - characters in non-unicode mode (AC6)', () => {
    setRenderContext({ noColor: false, useUnicode: false, isTTY: true, width: 80 });
    const out = renderSectionDivider();
    expect(out).toMatch(/^-+$/);
  });

  // AC6: spans configured width (max 80)
  it('spans the configured width up to 80 columns', () => {
    setRenderContext({ noColor: false, useUnicode: true, isTTY: true, width: 80 });
    const out = renderSectionDivider();
    expect(out.length).toBe(80);
  });

  it('adapts to full terminal width in wide mode (no 80-column cap)', () => {
    setRenderContext({ noColor: false, useUnicode: true, isTTY: true, width: 120 });
    const out = renderSectionDivider();
    expect(out.length).toBe(120);
  });

  it('uses custom width when provided', () => {
    setRenderContext({ noColor: false, useUnicode: true, isTTY: true, width: 80 });
    const out = renderSectionDivider(40);
    expect(out.length).toBe(40);
  });

  it('uses custom width above 80 without capping', () => {
    setRenderContext({ noColor: false, useUnicode: true, isTTY: true, width: 80 });
    const out = renderSectionDivider(100);
    expect(out.length).toBe(100);
  });

  it('uses context width when narrower than 80', () => {
    setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 60 });
    const out = renderSectionDivider();
    expect(out.length).toBe(60);
  });

  it('returns at least 1 character when custom width is 0 (F7)', () => {
    setRenderContext({ noColor: false, useUnicode: true, isTTY: true, width: 80 });
    const out = renderSectionDivider(0);
    expect(out.length).toBeGreaterThanOrEqual(1);
  });
});
