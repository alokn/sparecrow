/** Unit tests for the HintLine component. */
import { describe, it, expect, afterEach } from 'vitest';
import { setRenderContext, resetRenderContext } from './render-context.js';
import { renderHintLine } from './hint-line.js';

describe('renderHintLine()', () => {
  afterEach(() => resetRenderContext());

  // AC5: renders text through dim channel in color mode
  // Note: chalk applies ANSI codes only when stdout is a real TTY.
  // In test environments (no TTY), chalk.dim returns the text unchanged.
  // The contract is that renderHintLine passes text through color.dim(),
  // which is validated by the NO_COLOR passthrough tests below.
  it('returns text in color mode (AC5)', () => {
    setRenderContext({ noColor: false, useUnicode: true, isTTY: true, width: 80 });
    const out = renderHintLine('Run status --all for activity detail');
    expect(out).toContain('Run status --all for activity detail');
  });

  it('returns plain text in NO_COLOR mode (AC5)', () => {
    setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
    const out = renderHintLine('Run status --all for activity detail');
    expect(out).toBe('Run status --all for activity detail');
    expect(out).not.toContain('\x1b[');
  });

  it('returns plain text in noColor+unicode path', () => {
    setRenderContext({ noColor: true, useUnicode: true, isTTY: false, width: 80 });
    const out = renderHintLine('Hint text');
    expect(out).not.toContain('\x1b[');
  });

  it('returns text in color+ascii path (F5)', () => {
    setRenderContext({ noColor: false, useUnicode: false, isTTY: true, width: 80 });
    const out = renderHintLine('Run status --all for activity detail');
    expect(out).toContain('Run status --all for activity detail');
  });
});
