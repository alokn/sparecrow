/** Unit tests for the ErrorBlock component. */
import { describe, it, expect, afterEach } from 'vitest';
import { setRenderContext, resetRenderContext } from './render-context.js';
import { renderErrorBlock } from './error-block.js';

describe('renderErrorBlock()', () => {
  afterEach(() => resetRenderContext());

  // AC4: color mode uses ✗ prefix for critical
  it('uses ✗ icon for critical severity in color mode (AC4)', () => {
    setRenderContext({ noColor: false, useUnicode: true, isTTY: true, width: 80 });
    const out = renderErrorBlock({ severity: 'critical', message: 'Token expired' });
    expect(out).toContain('✗');
    expect(out).toContain('Token expired');
  });

  // AC4 / F2: NO_COLOR mode uses [ERR] prefix for critical (via tokens.DOT_ERR)
  it('uses [ERR] prefix for critical severity in NO_COLOR mode (AC4/F2)', () => {
    setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
    const out = renderErrorBlock({ severity: 'critical', message: 'Token expired' });
    expect(out).toContain('[ERR]');
    expect(out).toContain('Token expired');
    expect(out).not.toContain('\x1b[');
  });

  it('uses [WARN] prefix for warning severity in NO_COLOR mode', () => {
    setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
    const out = renderErrorBlock({ severity: 'warning', message: 'Rate limit approaching' });
    expect(out).toContain('[WARN]');
  });

  it('uses [INFO] prefix for info severity in NO_COLOR mode', () => {
    setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
    const out = renderErrorBlock({ severity: 'info', message: 'Sync paused' });
    expect(out).toContain('[INFO]');
  });

  it('includes impact line when provided', () => {
    setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
    const out = renderErrorBlock({
      severity: 'critical',
      message: 'Token expired',
      impact: 'Tasks will not execute',
    });
    expect(out).toContain('Tasks will not execute');
  });

  it('includes recovery command line when provided (AC4)', () => {
    setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
    const out = renderErrorBlock({
      severity: 'critical',
      message: 'Token expired',
      recovery: 'sparecrow config --reconnect',
    });
    expect(out).toContain('Run: sparecrow config --reconnect');
  });

  it('omits impact line when not provided', () => {
    setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
    const out = renderErrorBlock({ severity: 'critical', message: 'Token expired' });
    const lines = out.split('\n');
    expect(lines).toHaveLength(1);
  });

  it('omits recovery line when not provided', () => {
    setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
    const out = renderErrorBlock({
      severity: 'critical',
      message: 'Token expired',
      impact: 'Affects all queued tasks',
    });
    expect(out).not.toContain('Run:');
  });

  it('renders all three lines when message, impact, and recovery all provided', () => {
    setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
    const out = renderErrorBlock({
      severity: 'critical',
      message: 'Token expired',
      impact: 'No tasks will run',
      recovery: 'sparecrow config --reconnect',
    });
    const lines = out.split('\n');
    expect(lines).toHaveLength(3);
  });

  // Four render paths
  it('renders in color+unicode path without [ERROR] text prefix', () => {
    setRenderContext({ noColor: false, useUnicode: true, isTTY: true, width: 80 });
    const out = renderErrorBlock({ severity: 'critical', message: 'Boom' });
    expect(out).not.toContain('[ERROR]');
  });

  it('renders in noColor+ascii path (piped output)', () => {
    setRenderContext({ noColor: true, useUnicode: false, isTTY: false, width: 80 });
    const out = renderErrorBlock({ severity: 'warning', message: 'Slow' });
    expect(out).toContain('[WARN]');
    expect(out).not.toContain('\x1b[');
  });
});
