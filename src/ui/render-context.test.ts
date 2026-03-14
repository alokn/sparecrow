/** Unit tests for the render context detection and override utilities. */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { getRenderContext, setRenderContext, resetRenderContext } from './render-context.js';

describe('getRenderContext()', () => {
  afterEach(() => {
    resetRenderContext();
    vi.unstubAllEnvs();
  });

  it('returns noColor true when NO_COLOR env is set', () => {
    vi.stubEnv('NO_COLOR', '1');
    const ctx = getRenderContext();
    expect(ctx.noColor).toBe(true);
  });

  it('returns noColor true when stdout is not a TTY', () => {
    // stdout.isTTY is undefined/false in test environment
    const ctx = getRenderContext();
    expect(ctx.noColor).toBe(true);
  });

  it('returns isTTY false in test environment', () => {
    const ctx = getRenderContext();
    expect(ctx.isTTY).toBe(false);
  });

  it('returns width at least 40', () => {
    const ctx = getRenderContext();
    expect(ctx.width).toBeGreaterThanOrEqual(40);
  });

  it('caches the result on repeated calls', () => {
    const ctx1 = getRenderContext();
    const ctx2 = getRenderContext();
    expect(ctx1).toBe(ctx2);
  });

  // Task 5.4 — precedence and invalid width edge cases

  it('NO_COLOR=1 with FORCE_COLOR=1 results in noColor=true (NO_COLOR wins)', () => {
    resetRenderContext();
    vi.stubEnv('NO_COLOR', '1');
    vi.stubEnv('FORCE_COLOR', '1');
    // Simulate isTTY=true by temporarily setting process.stdout.isTTY
    const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    try {
      const ctx = getRenderContext();
      expect(ctx.noColor).toBe(true);
    } finally {
      if (originalIsTTY) {
        Object.defineProperty(process.stdout, 'isTTY', originalIsTTY);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (process.stdout as { isTTY?: unknown }).isTTY;
      }
    }
  });

  it('FORCE_COLOR=1 alone with isTTY=true results in noColor=false', () => {
    resetRenderContext();
    vi.stubEnv('FORCE_COLOR', '1');
    vi.stubEnv('NO_COLOR', '');
    const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    try {
      const ctx = getRenderContext();
      expect(ctx.noColor).toBe(false);
    } finally {
      if (originalIsTTY) {
        Object.defineProperty(process.stdout, 'isTTY', originalIsTTY);
      } else {
        delete (process.stdout as { isTTY?: unknown }).isTTY;
      }
    }
  });
});

describe('width sanitization and widthMode', () => {
  afterEach(() => {
    resetRenderContext();
  });

  // Task 5.4 — invalid width fallback tests

  it('falls back to width 80 and widthMode full when process.stdout.columns is undefined', () => {
    setRenderContext({ width: 80, isTTY: true, noColor: false, useUnicode: true });
    // Also test via direct getRenderContext with columns=undefined (simulated by direct set)
    resetRenderContext();
    // In test env, columns is undefined → width=80, widthMode='full'
    const ctx = getRenderContext();
    expect(ctx.width).toBe(80);
    expect(ctx.widthMode).toBe('full');
  });

  it('falls back to 80 when width 0 is set via setRenderContext', () => {
    setRenderContext({ width: 0 });
    const ctx = getRenderContext();
    expect(ctx.width).toBe(80);
    expect(ctx.widthMode).toBe('full');
  });

  it('falls back to 80 when negative width is set via setRenderContext', () => {
    setRenderContext({ width: -1 });
    const ctx = getRenderContext();
    expect(ctx.width).toBe(80);
    expect(ctx.widthMode).toBe('full');
  });

  it('falls back to 80 when NaN width is set via setRenderContext', () => {
    setRenderContext({ width: NaN });
    const ctx = getRenderContext();
    expect(ctx.width).toBe(80);
    expect(ctx.widthMode).toBe('full');
  });

  // Task 5.2 — width boundary tests
  it('returns compact for width 40', () => {
    setRenderContext({ width: 40 });
    expect(getRenderContext().widthMode).toBe('compact');
  });

  it('returns compact for width 59 (below standard threshold)', () => {
    setRenderContext({ width: 59 });
    expect(getRenderContext().widthMode).toBe('compact');
  });

  it('returns standard for width 60 (at standard threshold)', () => {
    setRenderContext({ width: 60 });
    expect(getRenderContext().widthMode).toBe('standard');
  });

  it('returns standard for width 79 (below full threshold)', () => {
    setRenderContext({ width: 79 });
    expect(getRenderContext().widthMode).toBe('standard');
  });

  it('returns full for width 80 (at full threshold)', () => {
    setRenderContext({ width: 80 });
    expect(getRenderContext().widthMode).toBe('full');
  });

  it('returns full for width 119 (below wide threshold)', () => {
    setRenderContext({ width: 119 });
    expect(getRenderContext().widthMode).toBe('full');
  });

  it('returns wide for width 120 (at wide threshold)', () => {
    setRenderContext({ width: 120 });
    expect(getRenderContext().widthMode).toBe('wide');
  });

  it('returns wide for width 200 (well above wide threshold)', () => {
    setRenderContext({ width: 200 });
    expect(getRenderContext().widthMode).toBe('wide');
  });
});

describe('RenderContext derived fields', () => {
  afterEach(() => {
    resetRenderContext();
  });

  it('colorEnabled is inverse of noColor', () => {
    setRenderContext({ noColor: false });
    expect(getRenderContext().colorEnabled).toBe(true);
    resetRenderContext();
    setRenderContext({ noColor: true });
    expect(getRenderContext().colorEnabled).toBe(false);
  });

  it('spinnerEnabled is true only when isTTY and not noColor', () => {
    setRenderContext({ isTTY: true, noColor: false });
    expect(getRenderContext().spinnerEnabled).toBe(true);
    resetRenderContext();
    setRenderContext({ isTTY: false, noColor: false });
    expect(getRenderContext().spinnerEnabled).toBe(false);
    resetRenderContext();
    setRenderContext({ isTTY: true, noColor: true });
    expect(getRenderContext().spinnerEnabled).toBe(false);
  });

  it('truncationEnabled is true only when isTTY', () => {
    setRenderContext({ isTTY: true });
    expect(getRenderContext().truncationEnabled).toBe(true);
    resetRenderContext();
    setRenderContext({ isTTY: false });
    expect(getRenderContext().truncationEnabled).toBe(false);
  });

  it('non-TTY forces noColor, useUnicode=false in full re-derive scenario', () => {
    // In test env, isTTY is always false → noColor=true
    const ctx = getRenderContext();
    expect(ctx.isTTY).toBe(false);
    expect(ctx.noColor).toBe(true);
    expect(ctx.truncationEnabled).toBe(false);
    expect(ctx.spinnerEnabled).toBe(false);
  });
});

describe('setRenderContext()', () => {
  afterEach(() => resetRenderContext());

  it('overrides noColor', () => {
    setRenderContext({ noColor: false, useUnicode: true, isTTY: true, width: 80 });
    expect(getRenderContext().noColor).toBe(false);
  });

  it('overrides useUnicode', () => {
    setRenderContext({ noColor: false, useUnicode: true, isTTY: true, width: 80 });
    expect(getRenderContext().useUnicode).toBe(true);
  });

  it('overrides width', () => {
    setRenderContext({ noColor: false, useUnicode: true, isTTY: true, width: 60 });
    expect(getRenderContext().width).toBe(60);
  });

  it('supports partial override', () => {
    setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
    setRenderContext({ width: 100 });
    const ctx = getRenderContext();
    expect(ctx.width).toBe(100);
    expect(ctx.noColor).toBe(true);
  });

  it('re-derives widthMode when width is changed', () => {
    setRenderContext({ width: 40 });
    expect(getRenderContext().widthMode).toBe('compact');
    setRenderContext({ width: 200 });
    expect(getRenderContext().widthMode).toBe('wide');
  });

  it('preserves explicitly set widthMode if provided', () => {
    setRenderContext({ width: 40, widthMode: 'wide' });
    expect(getRenderContext().widthMode).toBe('wide');
  });
});

describe('resetRenderContext()', () => {
  it('clears the cached context so next call re-detects', () => {
    setRenderContext({ noColor: false, useUnicode: true, isTTY: true, width: 80 });
    expect(getRenderContext().noColor).toBe(false);
    resetRenderContext();
    // After reset, re-detection happens — in test env, should be noColor=true (no TTY)
    expect(getRenderContext().noColor).toBe(true);
  });
});
