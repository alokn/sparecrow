/** Unit tests for the spinner wrapper noop and TTY/ora lifecycle paths. */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { setRenderContext, resetRenderContext } from './render-context.js';
import { createSpinner } from './spinner.js';

const oraMocks = vi.hoisted(() => {
  const spinner = {
    start: vi.fn(),
    stop: vi.fn(),
    succeed: vi.fn(),
    fail: vi.fn(),
  };
  const factory = vi.fn(() => spinner);
  return { spinner, factory };
});

vi.mock('ora', () => ({
  default: oraMocks.factory,
}));

describe('createSpinner()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => resetRenderContext());

  it('returns noopSpinner when not a TTY (F3)', async () => {
    setRenderContext({ isTTY: false, noColor: true, useUnicode: false, width: 80 });
    const spinner = await createSpinner('loading');
    expect(() => spinner.start()).not.toThrow();
    expect(() => spinner.stop()).not.toThrow();
    expect(() => spinner.succeed()).not.toThrow();
    expect(() => spinner.fail()).not.toThrow();
  });

  it('returns noopSpinner when noColor is true (F3)', async () => {
    setRenderContext({ isTTY: true, noColor: true, useUnicode: false, width: 80 });
    const spinner = await createSpinner('loading');
    expect(() => spinner.start('text')).not.toThrow();
    expect(() => spinner.stop()).not.toThrow();
    expect(() => spinner.succeed('done')).not.toThrow();
    expect(() => spinner.fail('error')).not.toThrow();
  });

  it('noopSpinner methods return void (F3)', async () => {
    setRenderContext({ isTTY: false, noColor: true, useUnicode: false, width: 80 });
    const spinner = await createSpinner('loading');
    expect(spinner.start()).toBeUndefined();
    expect(spinner.stop()).toBeUndefined();
    expect(spinner.succeed()).toBeUndefined();
    expect(spinner.fail()).toBeUndefined();
  });

  it('creates ora spinner in TTY mode and forwards lifecycle calls', async () => {
    setRenderContext({ isTTY: true, noColor: false, useUnicode: true, width: 80 });
    const spinner = await createSpinner('loading');

    expect(oraMocks.factory).toHaveBeenCalledWith('loading');

    spinner.start();
    spinner.start('custom-start');
    spinner.stop();
    spinner.succeed('done');
    spinner.fail('failed');

    expect(oraMocks.spinner.start).toHaveBeenCalledWith('loading');
    expect(oraMocks.spinner.start).toHaveBeenCalledWith('custom-start');
    expect(oraMocks.spinner.stop).toHaveBeenCalledTimes(1);
    expect(oraMocks.spinner.succeed).toHaveBeenCalledWith('done');
    expect(oraMocks.spinner.fail).toHaveBeenCalledWith('failed');
  });
});
