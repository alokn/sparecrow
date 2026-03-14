/** Unit tests for the StatusIndicator component. */
import { describe, it, expect, afterEach } from 'vitest';
import { setRenderContext, resetRenderContext } from './render-context.js';
import { renderStatusIndicator } from './status-indicator.js';

describe('renderStatusIndicator()', () => {
  afterEach(() => resetRenderContext());

  // Four render paths
  it('renders healthy state with unicode and color (path: color+unicode)', () => {
    setRenderContext({ noColor: false, useUnicode: true, isTTY: true, width: 80 });
    const out = renderStatusIndicator({ state: 'healthy', label: 'Daemon', value: 'running' });
    expect(out).toContain('Daemon:');
    expect(out).toContain('running');
    expect(out).toContain('●');
  });

  it('renders healthy state with color but no unicode (path: color+ascii)', () => {
    setRenderContext({ noColor: false, useUnicode: false, isTTY: true, width: 80 });
    const out = renderStatusIndicator({ state: 'healthy', label: 'Daemon', value: 'running' });
    expect(out).toContain('Daemon:');
    expect(out).toContain('running');
  });

  it('renders NO_COLOR mode with text prefix (path: noColor+unicode)', () => {
    setRenderContext({ noColor: true, useUnicode: true, isTTY: false, width: 80 });
    const out = renderStatusIndicator({ state: 'healthy', label: 'Daemon', value: 'running' });
    expect(out).toContain('[OK]');
    expect(out).toContain('Daemon:');
    expect(out).not.toContain('\x1b['); // no ANSI codes
  });

  it('renders NO_COLOR + ASCII mode (path: noColor+ascii)', () => {
    setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
    const out = renderStatusIndicator({ state: 'healthy', label: 'Daemon', value: 'running' });
    expect(out).toContain('[OK]');
    expect(out).not.toContain('\x1b[');
  });

  // AC2: healthy state NO_COLOR
  it('outputs [OK] prefix in NO_COLOR mode for healthy state (AC2)', () => {
    setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
    const out = renderStatusIndicator({ state: 'healthy', label: 'Daemon', value: 'running' });
    expect(out).toMatch(/\[OK\].*Daemon:.*running/);
  });

  // AC3: error state with recovery
  it('renders recovery hint on next line (AC3)', () => {
    setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
    const out = renderStatusIndicator({
      state: 'error',
      label: 'Auth',
      value: 'expired 2h ago',
      recovery: 'config --reconnect',
    });
    expect(out).toContain('[ERR]');
    expect(out).toContain('Auth:');
    expect(out).toContain('expired 2h ago');
    expect(out).toContain('Run: sparecrow config --reconnect');
  });

  it('does not include recovery line when recovery is absent', () => {
    setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
    const out = renderStatusIndicator({ state: 'healthy', label: 'Daemon', value: 'running' });
    expect(out).not.toContain('Run:');
  });

  // State variants
  it('uses [WARN] prefix for warning state in NO_COLOR mode', () => {
    setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
    const out = renderStatusIndicator({ state: 'warning', label: 'Queue', value: 'degraded' });
    expect(out).toContain('[WARN]');
  });

  it('uses [INFO] prefix for info state in NO_COLOR mode', () => {
    setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
    const out = renderStatusIndicator({ state: 'info', label: 'Sync', value: 'idle' });
    expect(out).toContain('[INFO]');
  });

  it('uses [??] prefix for unknown state in NO_COLOR mode (F6)', () => {
    setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
    const out = renderStatusIndicator({ state: 'unknown', label: 'Auth', value: 'pending' });
    expect(out).toContain('[??]');
    expect(out).not.toContain('[INFO]');
  });

  it.each([
    { state: 'warning' as const, label: 'Queue', value: 'degraded' },
    { state: 'error' as const, label: 'Auth', value: 'expired' },
    { state: 'unknown' as const, label: 'Auth', value: 'pending' },
    { state: 'info' as const, label: 'Sync', value: 'idle' },
  ])('renders %s state when color mode is enabled', ({ state, label, value }) => {
    setRenderContext({ noColor: false, useUnicode: true, isTTY: true, width: 80 });
    const out = renderStatusIndicator({ state, label, value });
    expect(out).toContain('●');
    expect(out).toContain(`${label}:`);
    expect(out).toContain(value);
    expect(out).not.toContain('[WARN]');
    expect(out).not.toContain('[ERR]');
    expect(out).not.toContain('[??]');
    expect(out).not.toContain('[INFO]');
  });
});
